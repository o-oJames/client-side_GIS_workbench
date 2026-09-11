// ---------------------------------------------------------------------------
// useCogContours — the companion vector overlay behind the COG "Contours"
// renderer.
//
// Contour lines cannot live in the WebGL tile shader: a fragment can work out
// that it sits on an isoline, but it has no distance along that line (so no
// dash patterns), no line width in map units, no room for a label, and no
// notion of QGIS' "Input Downscaling". utils/cogContours.ts therefore traces
// real LineStrings from the file's own elevations, and this hook keeps one
// overlay per COG layer in step with the map:
//
//   * created when a layer switches to the Contours renderer, removed when it
//     switches away, is deleted, or the workspace changes;
//   * the raster layer is hidden underneath — QGIS draws the lines on their
//     own — and put straight back if a trace fails, so a layer never goes
//     blank because of this feature;
//   * re-traced once the view settles, over a buffered extent, so small pans
//     cost nothing and only leaving the buffer re-reads the file;
//   * symbol-only edits (colour, width, brush style, labels) restyle in place
//     without reading a single byte.
//
// The overlay carries `_isCogContourLayer` plus a pointer to its parent, which
// is what `reorderLayers` uses to keep it immediately above the raster layer
// it was traced from.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef } from 'react';
import type OLMap from 'ol/Map.js';
import { buffer as bufferExtent, containsExtent } from 'ol/extent.js';
import type { RasterLayer, VectorLayerConfig } from '../types';
import { reorderLayers } from '../utils/layerHelpers';
import {
  applyCogRender,
  describeCogBands,
  sanitiseCogContour,
  suggestedCogRender,
} from '../utils/cogBands';
import {
  contourCapMessage,
  contourFailureMessage,
  contourStyleFunction,
  createContourLayer,
  traceCogContoursDetailed,
} from '../utils/cogContours';

/** Let the view settle before re-tracing (a pan fires a moveend per frame). */
const REFRESH_DEBOUNCE_MS = 250;
/** Read this fraction of the view size extra on every side. */
const BUFFER_RATIO = 0.5;
/** Re-trace when the display resolution moves by more than this fraction. */
const RESOLUTION_TOLERANCE = 0.5;
/** A source that has not parsed its metadata yet gets a few more chances. */
const NOT_READY_RETRIES = 3;
const NOT_READY_RETRY_MS = 600;

/** One COG layer's contour overlay and the trace it currently shows. */
interface ContourOverlay {
  /** The raster OL layer the lines were traced from (a rebuild replaces it). */
  parent: any;
  layer: any;
  source: any;
  /** Area the current lines cover, EPSG:3857. */
  covered: number[] | null;
  /** Geometry-affecting parameters the current lines were traced with. */
  key: string;
  /** Symbol-affecting parameters already applied to the layer's style. */
  symbolKey: string;
  /** Display resolution the current lines were traced at. */
  resolution: number;
  /** Bumped to abandon an in-flight trace. */
  generation: number;
  /** Set while tracing fails, so the raster stays visible instead of a blank map. */
  failed: boolean;
  /** Attempts left while the source is still parsing its metadata. */
  retries: number;
}

export interface UseCogContoursDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  rasterLayers: RasterLayer[];
  vectorLayers: VectorLayerConfig[];
  /** Surface a tracing problem or a "coarsened" note (MapPage passes its toast). */
  onNotice?: (message: string, kind?: 'error') => void;
}

/** The parameters that change *which* lines exist. */
function geometryKey(band: number, contour: ReturnType<typeof sanitiseCogContour>): string {
  return [band, contour.interval, contour.indexInterval, contour.inputDownscale, contour.inputOversampling].join('|');
}

/** The parameters that only change how the lines look. */
function symbolKey(contour: ReturnType<typeof sanitiseCogContour>): string {
  return [
    contour.color, contour.indexColor,
    contour.lineWidth, contour.lineStyle,
    contour.indexLineWidth, contour.indexLineStyle,
    contour.showLabel ? 1 : 0,
  ].join('|');
}

export function useCogContours(deps: UseCogContoursDeps) {
  const { mapRef, rasterLayers, vectorLayers } = deps;
  const noticeRef = useRef(deps.onNotice);
  noticeRef.current = deps.onNotice;

  const attachedMapRef = useRef<OLMap | null>(null);
  const moveendHandlerRef = useRef<((...args: any[]) => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const overlaysRef = useRef(new Map<string, ContourOverlay>());
  /** Latest `refreshOverlay`, for the retry that outlives its own callback. */
  const refreshRef = useRef<((layer: RasterLayer, overlay: ContourOverlay, force: boolean) => void) | null>(null);
  const lastNoticeRef = useRef<string | null>(null);
  // Mirrors of the props so the (stable) callbacks always see the latest layers.
  const rasterLayersRef = useRef(rasterLayers);
  const vectorLayersRef = useRef(vectorLayers);
  rasterLayersRef.current = rasterLayers;
  vectorLayersRef.current = vectorLayers;

  /** Report something once — a note that repeats on every pan is noise. */
  const notice = useCallback((message: string | null, kind?: 'error') => {
    if (!message) {
      lastNoticeRef.current = null;
      return;
    }
    if (lastNoticeRef.current === message) return;
    lastNoticeRef.current = message;
    noticeRef.current?.(message, kind);
  }, []);

  /**
   * QGIS draws contour lines on their own, so the raster hides under its own
   * overlay — and comes straight back the moment the renderer changes or a
   * trace fails, because a failed trace must never leave a blank map behind.
   * Both `sync` and a finished trace go through here so the two can never
   * disagree about which of the pair is on screen.
   */
  const applyRasterVisibility = useCallback((layer: RasterLayer, contourActive: boolean, failing: boolean) => {
    const olLayer = layer.olLayer;
    if (layer.type !== 'cog' || !olLayer || typeof olLayer.setVisible !== 'function') return;
    olLayer.setVisible(layer.visible !== false && (!contourActive || failing));
  }, []);

  /**
   * A trace can fail (unreadable band, no overlap with the view). The raster
   * then comes back with a displayable style — the suggested renderer, which
   * stretches a floating-point DEM to its stored statistics — instead of the
   * Contours mode's shader-less default mapping, which reads all-black on a
   * float file.
   */
  const showFallbackRaster = useCallback(async (layer: RasterLayer) => {
    const olLayer = layer.olLayer;
    if (!olLayer || typeof olLayer.setVisible !== 'function') return;
    applyRasterVisibility(layer, true, true);
    try {
      const info = await describeCogBands(olLayer.getSource?.());
      const fallback = suggestedCogRender(info);
      if (fallback.mode !== 'single') return; // paletted / RGB files display fine as-is
      applyCogRender(olLayer, fallback, info, {
        brightness: layer.brightness,
        saturation: layer.saturation,
        contrast: layer.contrast,
      });
    } catch (error) {
      console.warn('[COG contours] Could not apply a fallback display:', error);
    }
  }, [applyRasterVisibility]);

  /** Re-read the terrain and replace one overlay's lines. */
  const refreshOverlay = useCallback(async (
    layer: RasterLayer,
    overlay: ContourOverlay,
    force: boolean,
  ) => {
    const map = attachedMapRef.current;
    const source = layer.olLayer?.getSource?.();
    if (!map || !source) return;
    const view = map.getView();
    const size = map.getSize();
    const resolution = view?.getResolution?.();
    const viewProjection = view?.getProjection?.()?.getCode?.() ?? 'EPSG:3857';
    if (!view || !size || !resolution) return;

    const contour = sanitiseCogContour(layer.cogRender?.contour);
    const band = Math.max(1, Math.round(Number(layer.cogRender?.band) || 1));
    const key = geometryKey(band, contour);
    const viewExtent = view.calculateExtent(size);
    const stillCovers = !!overlay.covered && containsExtent(overlay.covered, viewExtent);
    const sameScale = Math.abs(resolution - overlay.resolution) <= overlay.resolution * RESOLUTION_TOLERANCE;
    if (!force && overlay.key === key && stillCovers && sameScale) return;

    const generation = ++overlay.generation;
    // Read a margin around the view so small pans reuse the same lines.
    const margin = Math.max(
      viewExtent[2] - viewExtent[0],
      viewExtent[3] - viewExtent[1],
    ) * BUFFER_RATIO;
    try {
      const attempt = await traceCogContoursDetailed({
        source,
        viewExtent: bufferExtent(viewExtent, margin),
        viewProjection,
        viewport: { width: size[0], height: size[1] },
        band,
        contour,
      });
      // Abandoned (a newer trace started, or the overlay was replaced).
      if (generation !== overlay.generation || overlaysRef.current.get(layer.id) !== overlay) return;
      const traced = attempt.trace;
      if (!traced) {
        overlay.key = '';
        overlay.covered = null;
        // Stale lines next to a raster that just became visible again would
        // show the same terrain twice, so the overlay empties with the failure.
        overlay.source.clear();
        if (attempt.failure === 'source-not-ready') {
          // The file's metadata is still being parsed (a rebuild after a
          // stretch edit, a restored workspace): worth another try shortly
          // rather than a permanent silent failure. Bounded, so a source that
          // never becomes ready cannot keep this hook polling — and the last
          // attempt says so instead of giving up quietly.
          if (overlay.retries < NOT_READY_RETRIES) {
            overlay.failed = false;
            overlay.retries += 1;
            window.setTimeout(() => {
              if (generation !== overlay.generation) return;
              if (overlaysRef.current.get(layer.id) !== overlay) return;
              // Trace the layer as it is *now*: an edit may have landed while
              // this retry was waiting.
              const current = rasterLayersRef.current.find((l) => l.id === layer.id);
              if (current) void refreshRef.current?.(current, overlay, true);
            }, NOT_READY_RETRY_MS);
            return;
          }
          overlay.failed = true;
          await showFallbackRaster(layer);
          notice(`Contours: "${layer.name}" is still loading — its lines appear once the file is ready.`);
          return;
        }
        overlay.failed = true;
        overlay.retries = 0;
        // Nothing readable: put the raster back with a displayable style
        // rather than leave a blank (or all-black) map under the toast.
        await showFallbackRaster(layer);
        const message = contourFailureMessage(attempt.failure, layer.name, attempt.detail);
        if (message) console.warn('[COG contours]', attempt.failure, message);
        // A view that is simply off the file is not an error: the lines go,
        // the raster comes back, and nothing is reported.
        notice(message, message ? 'error' : undefined);
        return;
      }
      overlay.retries = 0;
      overlay.source.clear();
      overlay.key = key;
      overlay.symbolKey = symbolKey(contour);
      overlay.covered = traced.grid.extent;
      overlay.resolution = resolution;
      if (traced.features.length === 0) {
        // Readable terrain, no line in it: a flat view, or an interval larger
        // than the elevation range. A blank map would just look broken, so the
        // raster stays up and the reason is said out loud.
        overlay.failed = true;
        await showFallbackRaster(layer);
        notice(`Contours: no lines in this view of "${layer.name}" — the interval may be larger than its elevation range.`);
        return;
      }
      overlay.failed = false;
      overlay.source.addFeatures(traced.features);
      overlay.layer.setStyle(contourStyleFunction(contour));
      // The lines are on screen, so the raster underneath goes back to hidden —
      // a previous failure (or a rebuild) may have made it visible again.
      applyRasterVisibility(layer, true, false);
      notice(contourCapMessage(traced.caps));
    } catch (error) {
      if (generation !== overlay.generation) return;
      console.warn('[COG contours] Trace failed:', error);
      overlay.failed = true;
      overlay.source.clear();
      await showFallbackRaster(layer);
      notice(`Contours: tracing failed for "${layer.name}".`, 'error');
    }
  }, [applyRasterVisibility, notice, showFallbackRaster]);

  // A self-reference for the bounded "source not ready yet" retry, which
  // cannot close over `refreshOverlay` while it is still being defined.
  refreshRef.current = refreshOverlay;

  /** Refresh every overlay whose lines are stale for the current view. */
  const refreshAll = useCallback((force = false) => {
    for (const layer of rasterLayersRef.current) {
      const overlay = overlaysRef.current.get(layer.id);
      if (overlay) void refreshOverlay(layer, overlay, force);
    }
  }, [refreshOverlay]);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      refreshAll(false);
    }, REFRESH_DEBOUNCE_MS);
  }, [refreshAll]);

  /**
   * Bring the overlays in line with the layer list: create what is missing,
   * drop what is gone, restyle symbol-only edits, hide the raster underneath.
   */
  const sync = useCallback(() => {
    const map = attachedMapRef.current;
    if (!map) return;

    const wanted = new Map<string, RasterLayer>();
    for (const layer of rasterLayersRef.current) {
      const contourActive = layer.type === 'cog'
        && layer.cogRender?.mode === 'contour'
        && !!layer.olLayer;
      if (layer.type === 'cog' && typeof layer.olLayer?.setVisible === 'function') {
        const failing = overlaysRef.current.get(layer.id)?.failed === true;
        applyRasterVisibility(layer, contourActive, failing);
      }
      if (contourActive) wanted.set(layer.id, layer);
    }

    let stackChanged = false;
    for (const [id, overlay] of Array.from(overlaysRef.current.entries())) {
      if (wanted.has(id)) continue;
      overlay.generation++; // abandon an in-flight trace
      map.removeLayer(overlay.layer);
      overlaysRef.current.delete(id);
      stackChanged = true;
    }

    let needsRefresh = false;
    for (const [id, layer] of wanted) {
      let overlay = overlaysRef.current.get(id);
      // A rebuilt layer (a stretch re-bakes the source) gets a fresh overlay.
      if (!overlay || overlay.parent !== layer.olLayer) {
        if (overlay) {
          overlay.generation++;
          map.removeLayer(overlay.layer);
        }
        const created = createContourLayer(layer.olLayer, layer.cogRender?.contour);
        overlay = {
          parent: layer.olLayer,
          layer: created,
          source: created.getSource(),
          covered: null,
          key: '',
          symbolKey: '',
          resolution: 0,
          generation: 0,
          failed: false,
          retries: 0,
        };
        overlaysRef.current.set(id, overlay);
        map.addLayer(created);
        stackChanged = true;
      }
      overlay.layer.setVisible(layer.visible !== false);
      overlay.layer.setOpacity((layer.opacity ?? 100) / 100);
      const contour = sanitiseCogContour(layer.cogRender?.contour);
      const symbols = symbolKey(contour);
      if (overlay.symbolKey !== symbols) {
        // Colour / width / brush style / labels need no new geometry.
        overlay.symbolKey = symbols;
        overlay.layer.setStyle(contourStyleFunction(contour));
      }
      // refreshOverlay decides whether the view or the intervals went stale.
      needsRefresh = true;
    }

    if (stackChanged) reorderLayers(map, rasterLayersRef.current, vectorLayersRef.current);
    if (needsRefresh) scheduleRefresh();
  }, [applyRasterVisibility, scheduleRefresh]);

  /** Called from MapPage's map-init effect, like the other map-bound hooks. */
  const attach = useCallback((map: OLMap) => {
    if (attachedMapRef.current !== map) {
      const previous = attachedMapRef.current;
      if (previous && moveendHandlerRef.current) {
        previous.un('moveend', moveendHandlerRef.current as any);
      }
      attachedMapRef.current = map;
      const onMoveEnd = () => scheduleRefresh();
      map.on('moveend', onMoveEnd);
      moveendHandlerRef.current = onMoveEnd;
    }
    sync();
  }, [scheduleRefresh, sync]);

  /** Remove everything this hook put on the map (unmount / workspace switch). */
  const dispose = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const map = attachedMapRef.current;
    if (map) {
      if (moveendHandlerRef.current) map.un('moveend', moveendHandlerRef.current as any);
      for (const overlay of overlaysRef.current.values()) {
        overlay.generation++;
        map.removeLayer(overlay.layer);
      }
    }
    moveendHandlerRef.current = null;
    attachedMapRef.current = null;
    overlaysRef.current.clear();
    lastNoticeRef.current = null;
  }, []);

  // Layer list changes: added, edited, rebuilt, toggled, reordered, restored.
  useEffect(() => { sync(); }, [sync, rasterLayers]);
  // Safety net for unmount — MapPage also calls dispose() from its teardown.
  useEffect(() => dispose, [dispose]);

  return { attach, dispose, refresh: refreshAll };
}
