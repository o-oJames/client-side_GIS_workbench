import OLMap from 'ol/Map.js';

/**
 * Composite every rendered layer canvas of an OpenLayers map into a single
 * offscreen canvas at the map's current CSS-pixel size.
 *
 * `excludeLayer` optionally keeps layers out of the composite (draw overlays,
 * marker layers…) so they don't contaminate the result. The layers are only
 * hidden for the duration of one synchronous hide → render → composite →
 * restore step that runs after the map reports a complete render, so the
 * browser never paints a frame without them. (Hiding them up front, while
 * still waiting for the new view's tiles to load, made unsaved drawn
 * features disappear for seconds after every pan/zoom.)
 *
 * OpenLayers draws each layer to its own `<canvas>` (stacked inside the map
 * viewport) and positions/scales it with a CSS `transform`. To produce a flat
 * image we replay each layer canvas onto the export canvas using that same
 * transform, honouring per-layer opacity and background colour. This mirrors
 * the official OpenLayers "export-map" example.
 *
 * The returned promise rejects if the map has no size or, most commonly, when
 * a layer's tiles were loaded without CORS and the canvas is therefore
 * "tainted" (a `SecurityError` is thrown by `toBlob`/`drawImage`).
 */
export function captureMapCanvas(
  map: OLMap,
  excludeLayer?: (layer: any) => boolean,
): Promise<HTMLCanvasElement> {
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    /** Composite the layer canvases currently present in the viewport. */
    const composite = (): HTMLCanvasElement => {
      const size = map.getSize();
      if (!size || size[0] === 0 || size[1] === 0) {
        throw new Error('Map has no rendered size');
      }

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = size[0];
      exportCanvas.height = size[1];
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Could not create a 2D canvas context');
      }

      const layerCanvases = map
        .getViewport()
        .querySelectorAll<HTMLCanvasElement>('.ol-layer canvas, canvas.ol-layer');

      Array.prototype.forEach.call(layerCanvases, (canvas: HTMLCanvasElement) => {
        if (canvas.width === 0) return;

        const parent = canvas.parentNode as HTMLElement | null;
        const opacity = (parent && parent.style.opacity) || canvas.style.opacity;
        ctx.globalAlpha = opacity === '' ? 1 : Number(opacity);

        // Recover the scale/translate the compositor applied to this layer.
        let matrix: number[];
        const transform = canvas.style.transform;
        if (transform) {
          const match = transform.match(/^matrix\(([^(]*)\)$/);
          matrix = match ? match[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
        } else {
          matrix = [
            parseFloat(canvas.style.width) / canvas.width || 1,
            0,
            0,
            parseFloat(canvas.style.height) / canvas.height || 1,
            0,
            0,
          ];
        }
        ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

        const backgroundColor = parent && parent.style.backgroundColor;
        if (backgroundColor) {
          ctx.fillStyle = backgroundColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // Honour the layer's CSS colour filter (brightness/saturation/
        // contrast from patchLayerRenderer). CSS filters only affect what is
        // displayed — without this the captured pixels would not match the
        // adjusted image the user sees on screen (and edge detection would
        // miss edges the adjustment made obvious). Browsers without
        // ctx.filter support ignore the assignment.
        const cssFilter = (parent && parent.style.filter) || canvas.style.filter || '';
        try {
          ctx.filter = cssFilter || 'none';
        } catch {
          /* ctx.filter unsupported — capture unadjusted pixels */
        }

        ctx.drawImage(canvas, 0, 0);
        try {
          ctx.filter = 'none';
        } catch {
          /* ignore */
        }
      });

      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return exportCanvas;
    };

    /**
     * Runs once the map reports a complete render (all tiles of the current
     * view loaded). Only now are excluded layers hidden — immediately
     * followed by a synchronous re-render, the composite, and the restore.
     * Because hide and restore happen inside one synchronous task, no frame
     * is ever painted without the excluded layers: drawn features stay on
     * screen while tiles load and while the caller analyses the capture.
     */
    const captureNow = () => {
      const hiddenLayers: any[] = [];
      if (excludeLayer) {
        map.getLayers().getArray().forEach((layer: any) => {
          if (excludeLayer(layer) && layer.getVisible && layer.getVisible()) {
            layer.setVisible(false);
            hiddenLayers.push(layer);
          }
        });
      }
      try {
        // With layers hidden, force a synchronous frame so their canvases
        // leave the viewport before we collect it.
        if (hiddenLayers.length > 0) map.renderSync();
        resolve(composite());
      } catch (err) {
        reject(err);
      } finally {
        if (hiddenLayers.length > 0) {
          hiddenLayers.forEach((layer) => layer.setVisible(true));
          map.render();
        }
      }
    };

    // Wait for the map to finish rendering the current view (tiles loaded)
    // with every layer still visible, then capture in one synchronous step.
    map.once('rendercomplete', captureNow);
    // Force a render so `rendercomplete` fires as soon as the map is ready —
    // immediately when everything is loaded, or right after the remaining
    // tiles of a fresh view arrive.
    map.renderSync();
  });
}

/**
 * Encode a canvas as a PNG `Blob`. Rejects when the canvas is tainted
 * (cross-origin tiles loaded without CORS) or encoding otherwise fails.
 */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Could not encode the map image'));
        }
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

/** True when a capture/encode failure was caused by a tainted (non-CORS) canvas. */
export function isTaintedCanvasError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name === 'SecurityError') return true;
  return /tainted|cross-?origin|not.*clean/i.test(String(e.message || ''));
}
