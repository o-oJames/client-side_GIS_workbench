// ---------------------------------------------------------------------------
// useTileContours — contour lines for XYZ/WMTS/WMS tile layers that encode
// terrain in their RGB channels (e.g. AWS terrarium tiles).
//
// Mirrors useCogContours: one companion vector overlay per tile layer in
// contour mode, re-traced when the view settles, symbol-only edits restyle in
// place without re-reading tiles. The raster layer is hidden while contours
// are on screen (like QGIS), and put back if tracing fails.
//
// Heavy computation (PNG decode → elevation grid → marching squares × N levels
// → Douglas-Peucker → Chaikin smoothing → coordinate mapping) runs in a
// dedicated Web Worker (workers/tileContoursWorker.ts). The worker processes
// tiles incrementally and posts partial results after each tile, so contours
// appear progressively rather than waiting for all tiles to finish.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef } from 'react';
import type OLMap from 'ol/Map.js';
import { buffer as bufferExtent, containsExtent } from 'ol/extent.js';
import { Feature } from 'ol';
import { LineString } from 'ol/geom';
import type { RasterLayer, VectorLayerConfig, TileRenderConfig } from '../types';
import { reorderLayers } from '../utils/layerHelpers';
import {
  CONTOUR_LAYER_PROPERTY,
  CONTOUR_LEVEL_PROPERTY,
  CONTOUR_INDEX_PROPERTY,
  contourStyleFunction,
  createContourLayer,
  planContourLevels,
} from '../utils/cogContours';
import { buildTileUrl } from '../utils/tileElevation';
import { DEFAULT_CONTOUR, sanitiseCogContour } from '../utils/cogBands';
import type {
  JobRequest,
  JobResult,
  TileJob,
} from '../utils/tileContoursWorkerApi';

/** Let the view settle before re-tracing. */
const REFRESH_DEBOUNCE_MS = 500;
/** Read this fraction of the view size extra on every side. */
const BUFFER_RATIO = 0.1;
/** Re-trace when the display resolution moves by more than this fraction. */
const RESOLUTION_TOLERANCE = 0.15;

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
  /** The jobId currently in-flight for this overlay (null if idle). */
  pendingJobId: string | null;
  /** Stashed while a job is in-flight, applied when the result arrives. */
  pendingKey?: string;
  pendingExtent?: number[];
  pendingResolution?: number;
  pendingGeneration?: number;
  /** The layer id this overlay belongs to (set when created). */
  layerId: string;
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
    contour.interval, contour.indexInterval, contour.inputDownscale, contour.inputOversampling,
    contour.dynamicIntervals ? 1 : 0].join('|');
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

/** Generate a unique job ID. */
let jobCounter = 0;
function nextJobId(): string {
  return `tc-${Date.now()}-${++jobCounter}`;
}

/**
 * Build the list of tile URLs covering the buffered extent, expanded by 1 tile
 * in each direction (gutter) for seamless contour lines at tile boundaries.
 */
function buildTileJobs(
  source: any,
  tileGrid: any,
  bufferedExtent: number[],
  z: number,
): TileJob[] {
  const origin = tileGrid.getOrigin?.(z) ?? tileGrid.getOrigin?.(0);
  if (!origin) return [];
  const originX = origin[0];
  const originY = origin[1];
  const tileResolution = tileGrid.getResolution(z);
  const tileSize = tileGrid.getTileSize(z);
  const tilePixelSize = typeof tileSize === 'number' ? tileSize : (tileSize?.[0] ?? 256);
  const tileGroundSize = tileResolution * tilePixelSize;

  const tileMinX = Math.floor((bufferedExtent[0] - originX) / tileGroundSize);
  const tileMaxX = Math.floor((bufferedExtent[2] - originX) / tileGroundSize);
  const tileMinY = Math.floor((originY - bufferedExtent[3]) / tileGroundSize);
  const tileMaxY = Math.floor((originY - bufferedExtent[1]) / tileGroundSize);

  const jobs: TileJob[] = [];
  for (let tx = tileMinX; tx <= tileMaxX; tx++) {
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      const url = buildTileUrl(source, z, tx, ty);
      if (url) jobs.push({ url, tx, ty });
    }
  }
  return jobs;
}

/**
 * Determine the tile Z to use: the finest level whose resolution is close to
 * (or finer than) the output grid's cell size.
 */
function pickTileZoom(
  tileGrid: any,
  viewResolution: number,
  explicitZoom?: number,
): number {
  const maxZ = tileGrid.getMaxZoom();
  const minZ = tileGrid.getMinZoom();
  if (explicitZoom !== undefined) {
    return Math.max(minZ, Math.min(maxZ, Math.round(explicitZoom)));
  }
  let bestZ = minZ;
  for (let candidateZ = minZ; candidateZ <= maxZ; candidateZ++) {
    const res = tileGrid.getResolution(candidateZ);
    if (res <= viewResolution * 2) {
      bestZ = candidateZ;
    } else {
      break;
    }
  }
  return bestZ;
}

export function useTileContours(deps: UseTileContoursDeps) {
  const { mapRef, rasterLayers, vectorLayers } = deps;
  const noticeRef = useRef(deps.onNotice);
  noticeRef.current = deps.onNotice;

  const attachedMapRef = useRef<OLMap | null>(null);
  const moveendHandlerRef = useRef<((...args: any[]) => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const overlaysRef = useRef(new Map<string, TileContourOverlay>());
  const lastNoticeRef = useRef<string | null>(null);
  const rasterLayersRef = useRef(rasterLayers);
  const vectorLayersRef = useRef(vectorLayers);
  rasterLayersRef.current = rasterLayers;
  vectorLayersRef.current = vectorLayers;

  // Worker instance — created lazily on first use, shared across all overlays.
  const workerRef = useRef<Worker | null>(null);
  /** Map from jobId → overlay that owns it, so we can route results. */
  const jobOverlayMap = useRef(new Map<string, TileContourOverlay>());

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

  /** Find the RasterLayer by id. */
  const findLayerById = useCallback((id: string): RasterLayer | null => {
    return rasterLayersRef.current.find(l => l.id === id) ?? null;
  }, []);

  /** Apply a worker result (partial or final) to an overlay. */
  const applyWorkerResult = useCallback((overlay: TileContourOverlay, msg: JobResult) => {
    const layer = findLayerById(overlay.layerId);
    if (!layer) return;
    const render = layer.tileRender!;
    const contour = sanitiseCogContour(render.contour);
    const generation = overlay.pendingGeneration;

    // Stale result check
    if (generation !== undefined && generation !== overlay.generation) return;

    if (msg.error && msg.error !== 'cancelled') {
      overlay.key = '';
      overlay.covered = null;
      overlay.source.clear();
      overlay.failed = true;
      void showFallbackRaster(layer);
      notice(`Contours: ${msg.error} for "${layer.name}".`, 'error');
      return;
    }

    // Build OL Features from the plain coordinate arrays
    const features: Feature[] = [];
    for (const path of msg.paths) {
      const geom = new LineString(path.coords);
      const feat = new Feature({ geometry: geom });
      feat.set(CONTOUR_LEVEL_PROPERTY, path.level);
      feat.set(CONTOUR_INDEX_PROPERTY, path.index);
      features.push(feat);
    }

    // Replace all features with the current set (progressive update)
    overlay.source.clear();
    if (features.length > 0) {
      overlay.source.addFeatures(features);
    }

    // Apply pending state (only on first result or final)
    overlay.key = overlay.pendingKey ?? '';
    overlay.symbolKey = symbolKey(render);
    overlay.covered = overlay.pendingExtent ?? null;
    overlay.resolution = overlay.pendingResolution ?? 0;
    overlay.failed = false;
    overlay.layer.setStyle(contourStyleFunction(contour));
    applyRasterVisibility(layer, true, false);

    // Clean up job mapping only on final result
    if (msg.complete) {
      jobOverlayMap.current.delete(msg.jobId);
      if (overlay.pendingJobId === msg.jobId) {
        overlay.pendingJobId = null;
      }
    }
  }, [applyRasterVisibility, findLayerById, notice, showFallbackRaster]);

  // Use a ref for the result handler so the worker's onmessage always calls
  // the latest version (avoids stale closure issues).
  const applyWorkerResultRef = useRef(applyWorkerResult);
  applyWorkerResultRef.current = applyWorkerResult;

  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../workers/tileContoursWorker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current.onmessage = (e: MessageEvent<JobResult>) => {
        const msg = e.data;
        if (msg.type !== 'result') return;
        const overlay = jobOverlayMap.current.get(msg.jobId);
        if (!overlay) return; // stale or cancelled
        applyWorkerResultRef.current(overlay, msg);
      };
    }
    return workerRef.current;
  }, []);

  /** Re-read the terrain tiles and replace one overlay's lines via the worker. */
  const refreshOverlay = useCallback((
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
    if (!view || !size || !resolution) return;

    // Cancel any in-flight job for this overlay
    if (overlay.pendingJobId) {
      const worker = getWorker();
      worker.postMessage({ type: 'cancel', jobId: overlay.pendingJobId });
      jobOverlayMap.current.delete(overlay.pendingJobId);
      overlay.pendingJobId = null;
    }

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

    const tileGrid = source.getTileGrid?.();
    if (!tileGrid) {
      overlay.failed = true;
      overlay.source.clear();
      void showFallbackRaster(layer);
      notice(`Contours: no tile grid for "${layer.name}".`, 'error');
      return;
    }

    const viewRes = resolution;
    const z = pickTileZoom(tileGrid, viewRes, view.getZoom());

    const tiles = buildTileJobs(source, tileGrid, bufferedExtent, z);
    if (tiles.length === 0) {
      overlay.key = '';
      overlay.covered = null;
      overlay.source.clear();
      overlay.failed = true;
      void showFallbackRaster(layer);
      notice(`Contours: no tiles in view for "${layer.name}".`, 'error');
      return;
    }

    const factor = Math.max(1, contour.inputDownscale ?? DEFAULT_CONTOUR.inputDownscale);
    const outW = Math.max(2, Math.round(size[0] / factor));
    const outH = Math.max(2, Math.round(size[1] / factor));

    // Apply resolution-based dynamic intervals
    let interval = contour.interval ?? DEFAULT_CONTOUR.interval;
    let indexInterval = contour.indexInterval ?? DEFAULT_CONTOUR.indexInterval;
    if (contour.dynamicIntervals !== false) {
      if (viewRes >= 250) {
        interval = Math.max(interval, 500);
        indexInterval = Math.max(indexInterval, 2500);
      } else if (viewRes >= 50) {
        interval = Math.max(interval, 100);
        indexInterval = Math.max(indexInterval, 500);
      } else if (viewRes >= 25) {
        interval = Math.max(interval, 50);
        indexInterval = Math.max(indexInterval, 250);
      } else if (viewRes >= 5) {
        interval = Math.max(interval, 10);
        indexInterval = Math.max(indexInterval, 50);
      }
    }

    // Plan levels over a generous global range — the worker only traces paths
    // for levels that actually exist in the elevation grid.
    const planned = planContourLevels(-500, 9000, interval, indexInterval);
    if (planned.levels.length === 0) {
      overlay.key = '';
      overlay.covered = null;
      overlay.source.clear();
      overlay.failed = true;
      void showFallbackRaster(layer);
      notice(`Contours: no lines in this view of "${layer.name}" — the interval may be larger than its elevation range.`);
      return;
    }

    // Compute the expanded extent (matching the worker's logic)
    const origin = tileGrid.getOrigin?.(z) ?? tileGrid.getOrigin?.(0);
    const originX = origin[0];
    const originY = origin[1];
    const tileResolution = tileGrid.getResolution(z);
    const tileSize = tileGrid.getTileSize(z);
    const tilePixelSize = typeof tileSize === 'number' ? tileSize : (tileSize?.[0] ?? 256);
    const tileGroundSize = tileResolution * tilePixelSize;
    let tMinX = Infinity, tMaxX = -Infinity, tMinY = Infinity, tMaxY = -Infinity;
    for (const t of tiles) {
      if (t.tx < tMinX) tMinX = t.tx;
      if (t.tx > tMaxX) tMaxX = t.tx;
      if (t.ty < tMinY) tMinY = t.ty;
      if (t.ty > tMaxY) tMaxY = t.ty;
    }
    const expandedExtent = [
      originX + tMinX * tileGroundSize,
      originY - (tMaxY + 1) * tileGroundSize,
      originX + (tMaxX + 1) * tileGroundSize,
      originY - tMinY * tileGroundSize,
    ];

    const jobId = nextJobId();
    const jobReq: JobRequest = {
      type: 'job',
      jobId,
      tiles,
      tileGrid: {
        origin: [originX, originY],
        resolution: tileResolution,
        tileSize: tilePixelSize,
        zoom: z,
      },
      viewExtent: [bufferedExtent[0], bufferedExtent[1], bufferedExtent[2], bufferedExtent[3]],
      outputGrid: { width: outW, height: outH },
      encoding: render.encoding,
      grayscaleRange: render.grayscaleRange,
      levels: planned.levels.map(l => ({ level: l.level, index: l.index })),
      simplify: 1.5,
    };

    // Store pending state on the overlay
    overlay.pendingKey = key;
    overlay.pendingExtent = expandedExtent;
    overlay.pendingResolution = resolution;
    overlay.pendingGeneration = generation;
    overlay.pendingJobId = jobId;
    jobOverlayMap.current.set(jobId, overlay);

    const worker = getWorker();
    worker.postMessage(jobReq);
  }, [getWorker, notice, showFallbackRaster]);

  const refreshAll = useCallback((force = false) => {
    for (const layer of rasterLayersRef.current) {
      const overlay = overlaysRef.current.get(layer.id);
      if (overlay) refreshOverlay(layer, overlay, force);
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
      if (overlay.pendingJobId) {
        const worker = workerRef.current;
        if (worker) worker.postMessage({ type: 'cancel', jobId: overlay.pendingJobId });
        jobOverlayMap.current.delete(overlay.pendingJobId);
        overlay.pendingJobId = null;
      }
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
          if (overlay.pendingJobId) {
            const worker = workerRef.current;
            if (worker) worker.postMessage({ type: 'cancel', jobId: overlay.pendingJobId });
            jobOverlayMap.current.delete(overlay.pendingJobId);
            overlay.pendingJobId = null;
          }
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
          pendingJobId: null,
          layerId: id,
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
        if (overlay.pendingJobId) {
          const worker = workerRef.current;
          if (worker) worker.postMessage({ type: 'cancel', jobId: overlay.pendingJobId });
          jobOverlayMap.current.delete(overlay.pendingJobId);
          overlay.pendingJobId = null;
        }
        map.removeLayer(overlay.layer);
      }
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    jobOverlayMap.current.clear();
    moveendHandlerRef.current = null;
    attachedMapRef.current = null;
    overlaysRef.current.clear();
    lastNoticeRef.current = null;
  }, []);

  useEffect(() => { sync(); }, [sync, rasterLayers]);
  useEffect(() => dispose, [dispose]);

  return { attach, dispose, refresh: refreshAll };
}
