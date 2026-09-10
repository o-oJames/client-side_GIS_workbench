// ---------------------------------------------------------------------------
// useTileContours — contour lines for XYZ/WMTS/WMS tile layers that encode
// terrain in their RGB channels (e.g. AWS terrarium tiles).
//
// Mirrors useCogContours: one companion vector overlay per tile layer in
// contour mode, re-traced when the view settles, symbol-only edits restyle in
// place without re-reading tiles. The raster layer is hidden while contours
// are on screen (like QGIS), and put back if tracing fails.
//
// The elevation grid comes from utils/tileElevation.ts, which fetches the
// tiles covering the view, decodes their RGB pixels into elevations, and
// composites them into a single grid — then the same marching-squares tracer
// (utils/contourExtract.ts) builds the line features.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef } from 'react';
import type OLMap from 'ol/Map.js';
import { buffer as bufferExtent, containsExtent } from 'ol/extent.js';
import type { RasterLayer, VectorLayerConfig, TileRenderConfig } from '../types';
import { reorderLayers } from '../utils/layerHelpers';
import {
  CONTOUR_LAYER_PROPERTY,
  CONTOUR_PARENT_PROPERTY,
  CONTOUR_LEVEL_PROPERTY,
  CONTOUR_INDEX_PROPERTY,
  contourStyleFunction,
  createContourLayer,
  planContourLevels,
  gridRange,
  buildContourFeatures,
  type ContourCap,
} from '../utils/cogContours';
import { readTileElevationGridForView } from '../utils/tileElevation';
import { DEFAULT_CONTOUR, sanitiseCogContour } from '../utils/cogBands';

/** Let the view settle before re-tracing. */
const REFRESH_DEBOUNCE_MS = 500; // Increased to reduce CPU usage during panning
/** Read this fraction of the view size extra on every side. */
const BUFFER_RATIO = 0.1; // Reduced to trigger re-trace when zooming in
/** Re-trace when the display resolution moves by more than this fraction. */
const RESOLUTION_TOLERANCE = 0.15; // Stricter tolerance to trigger re-trace on zoom changes

/** One tile layer's contour overlay and the trace it currently shows. */
interface TileContourOverlay {
  parent: any;
  layer: any;
  source: any;
  covered: number[] | null;
  key: string;
  symbolKey: string;
  resolution: number;
  generation: number;
  failed: boolean;
  abortController: AbortController | null;
}

export interface UseTileContoursDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  rasterLayers: RasterLayer[];
  vectorLayers: VectorLayerConfig[];
  onNotice?: (message: string, kind?: 'error') => void;
}

/** Parameters that change *which* lines exist. */
function geometryKey(render: TileRenderConfig): string {
  const contour = sanitiseCogContour(render.contour);
  return [render.encoding, render.grayscaleRange?.min, render.grayscaleRange?.max,
    contour.interval, contour.indexInterval, contour.inputDownscale, contour.inputOversampling].join('|');
}

/** Parameters that only change how the lines look. */
function symbolKey(render: TileRenderConfig): string {
  const contour = sanitiseCogContour(render.contour);
  return [
    contour.color, contour.indexColor,
    contour.lineWidth, contour.lineStyle,
    contour.indexLineWidth, contour.indexLineStyle,
    contour.showLabel ? 1 : 0,
  ].join('|');
}

export function useTileContours(deps: UseTileContoursDeps) {
  const { mapRef, rasterLayers, vectorLayers } = deps;
  const noticeRef = useRef(deps.onNotice);
  noticeRef.current = deps.onNotice;

  const attachedMapRef = useRef<OLMap | null>(null);
  const moveendHandlerRef = useRef<((...args: any[]) => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const overlaysRef = useRef(new Map<string, TileContourOverlay>());
  const refreshRef = useRef<((layer: RasterLayer, overlay: TileContourOverlay, force: boolean) => void) | null>(null);
  const lastNoticeRef = useRef<string | null>(null);
  const rasterLayersRef = useRef(rasterLayers);
  const vectorLayersRef = useRef(vectorLayers);
  rasterLayersRef.current = rasterLayers;
  vectorLayersRef.current = vectorLayers;

  const notice = useCallback((message: string | null, kind?: 'error') => {
    if (!message) { lastNoticeRef.current = null; return; }
    if (lastNoticeRef.current === message) return;
    lastNoticeRef.current = message;
    noticeRef.current?.(message, kind);
  }, []);

  const applyRasterVisibility = useCallback((layer: RasterLayer, contourActive: boolean, failing: boolean) => {
    const olLayer = layer.olLayer;
    if (!olLayer || typeof olLayer.setVisible !== 'function') return;
    olLayer.setVisible(layer.visible !== false && (!contourActive || failing));
  }, []);

  const showFallbackRaster = useCallback(async (layer: RasterLayer) => {
    const olLayer = layer.olLayer;
    if (!olLayer || typeof olLayer.setVisible !== 'function') return;
    applyRasterVisibility(layer, true, true);
  }, [applyRasterVisibility]);

  /** Re-read the terrain tiles and replace one overlay's lines. */
  const refreshOverlay = useCallback(async (
    layer: RasterLayer,
    overlay: TileContourOverlay,
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

    // Cancel any in-flight request for this overlay
    if (overlay.abortController) {
      overlay.abortController.abort();
    }
    overlay.abortController = new AbortController();

    const render = layer.tileRender!;
    const contour = sanitiseCogContour(render.contour);
    const key = geometryKey(render);
    const viewExtent = view.calculateExtent(size);
    const stillCovers = !!overlay.covered && containsExtent(overlay.covered, viewExtent);
    const sameScale = Math.abs(resolution - overlay.resolution) <= overlay.resolution * RESOLUTION_TOLERANCE;
    if (!force && overlay.key === key && stillCovers && sameScale) return;

    const generation = ++overlay.generation;
    const margin = Math.max(
      viewExtent[2] - viewExtent[0],
      viewExtent[3] - viewExtent[1],
    ) * BUFFER_RATIO;
    const bufferedExtent = bufferExtent(viewExtent, margin);

    try {
      const grid = await readTileElevationGridForView(
        source,
        bufferedExtent,
        viewProjection,
        { width: size[0], height: size[1] },
        render.encoding,
        {
          downscale: 1, // Use full resolution for tile layers to avoid jagged contours
          grayscaleRange: render.grayscaleRange,
          zoom: view.getZoom(),
          signal: overlay.abortController?.signal,
        },
      );

      // Check if aborted
      if (overlay.abortController?.signal.aborted) return;

      if (generation !== overlay.generation || overlaysRef.current.get(layer.id) !== overlay) return;

      if (!grid) {
        overlay.key = '';
        overlay.covered = null;
        overlay.source.clear();
        overlay.failed = true;
        await showFallbackRaster(layer);
        notice(`Contours: could not read elevation tiles for "${layer.name}".`, 'error');
        return;
      }

      const range = gridRange(grid.field);
      if (!range) {
        overlay.key = '';
        overlay.covered = null;
        overlay.source.clear();
        overlay.failed = true;
        await showFallbackRaster(layer);
        notice(`Contours: no elevation data in view for "${layer.name}".`, 'error');
        return;
      }

      const interval = contour.interval ?? DEFAULT_CONTOUR.interval;
      const indexInterval = contour.indexInterval ?? DEFAULT_CONTOUR.indexInterval;
      const planned = planContourLevels(range.min, range.max, interval, indexInterval);

      if (planned.levels.length === 0) {
        overlay.key = '';
        overlay.covered = null;
        overlay.source.clear();
        overlay.failed = true;
        await showFallbackRaster(layer);
        notice(`Contours: no lines in this view of "${layer.name}" — the interval may be larger than its elevation range.`);
        return;
      }

      // Build contour features from the tile elevation grid
      const [fx0, fy0, fx1, fy1] = grid.extent;
      const cellW = (fx1 - fx0) / Math.max(1, grid.width - 1);
      const cellH = (fy1 - fy0) / Math.max(1, grid.height - 1);

      const built = buildContourFeatures(
        { ...grid, fileExtent: grid.extent, projection: null, caps: [] },
        planned.levels,
        { simplify: 1.5 }, // Increased for smoother contour lines
      );

      if (generation !== overlay.generation || overlaysRef.current.get(layer.id) !== overlay) return;

      overlay.source.clear();
      overlay.key = key;
      overlay.symbolKey = symbolKey(render);
      overlay.covered = grid.extent;
      overlay.resolution = resolution;
      overlay.failed = false;

      if (built.features.length > 0) {
        overlay.source.addFeatures(built.features);
      }
      overlay.layer.setStyle(contourStyleFunction(contour));
      applyRasterVisibility(layer, true, false);
    } catch (error) {
      if (generation !== overlay.generation) return;
      console.warn('[tileContours] Trace failed:', error);
      overlay.failed = true;
      overlay.source.clear();
      await showFallbackRaster(layer);
      notice(`Contours: tracing failed for "${layer.name}".`, 'error');
    }
  }, [applyRasterVisibility, notice, showFallbackRaster]);

  refreshRef.current = refreshOverlay;

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

  /** Sync overlays with the layer list. */
  const sync = useCallback(() => {
    const map = attachedMapRef.current;
    if (!map) return;

    const wanted = new Map<string, RasterLayer>();
    for (const layer of rasterLayersRef.current) {
      const contourActive = layer.type !== 'cog'
        && layer.tileRender?.mode === 'contour'
        && !!layer.olLayer;
      if (layer.type !== 'cog' && typeof layer.olLayer?.setVisible === 'function') {
        const failing = overlaysRef.current.get(layer.id)?.failed === true;
        applyRasterVisibility(layer, contourActive, failing);
      }
      if (contourActive) wanted.set(layer.id, layer);
    }

    let stackChanged = false;
    for (const [id, overlay] of Array.from(overlaysRef.current.entries())) {
      if (wanted.has(id)) continue;
      overlay.generation++;
      map.removeLayer(overlay.layer);
      overlaysRef.current.delete(id);
      stackChanged = true;
    }

    let needsRefresh = false;
    for (const [id, layer] of wanted) {
      let overlay = overlaysRef.current.get(id);
      if (!overlay || overlay.parent !== layer.olLayer) {
        if (overlay) {
          overlay.generation++;
          map.removeLayer(overlay.layer);
        }
        const created = createContourLayer(layer.olLayer, layer.tileRender?.contour);
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
          abortController: null,
        };
        overlaysRef.current.set(id, overlay);
        map.addLayer(created);
        stackChanged = true;
      }
      overlay.layer.setVisible(layer.visible !== false);
      overlay.layer.setOpacity((layer.opacity ?? 100) / 100);
      const render = layer.tileRender!;
      const symbols = symbolKey(render);
      if (overlay.symbolKey !== symbols) {
        overlay.symbolKey = symbols;
        overlay.layer.setStyle(contourStyleFunction(sanitiseCogContour(render.contour)));
      }
      needsRefresh = true;
    }

    if (stackChanged) reorderLayers(map, rasterLayersRef.current, vectorLayersRef.current);
    if (needsRefresh) scheduleRefresh();
  }, [applyRasterVisibility, scheduleRefresh]);

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
        if (overlay.abortController) {
          overlay.abortController.abort();
          overlay.abortController = null;
        }
        map.removeLayer(overlay.layer);
      }
    }
    moveendHandlerRef.current = null;
    attachedMapRef.current = null;
    overlaysRef.current.clear();
    lastNoticeRef.current = null;
  }, []);

  useEffect(() => { sync(); }, [sync, rasterLayers]);
  useEffect(() => dispose, [dispose]);

  return { attach, dispose, refresh: refreshAll };
}
