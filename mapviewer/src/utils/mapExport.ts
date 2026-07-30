import OLMap from 'ol/Map.js';

/**
 * Composite every rendered layer canvas of an OpenLayers map into a single
 * offscreen canvas at the map's current CSS-pixel size.
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
export function captureMapCanvas(map: OLMap): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    map.once('rendercomplete', () => {
      try {
        const size = map.getSize();
        if (!size || size[0] === 0 || size[1] === 0) {
          reject(new Error('Map has no rendered size'));
          return;
        }

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = size[0];
        exportCanvas.height = size[1];
        const ctx = exportCanvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not create a 2D canvas context'));
          return;
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

          ctx.drawImage(canvas, 0, 0);
        });

        ctx.globalAlpha = 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        resolve(exportCanvas);
      } catch (err) {
        reject(err);
      }
    });
    // Force a synchronous render so `rendercomplete` fires immediately.
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
