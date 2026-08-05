// ---------------------------------------------------------------------------
// useSamTools — SAM 2.1 powered drawing assistance: the magic wand.
//
// Magic wand ("snap to object"): the wand tool captures the current map
// view, encodes it once with SAM's image encoder, then every click is a
// point prompt — the decoder returns the object mask, marching squares
// turns it into a polygon preview (further clicks refine it, Shift+click
// excludes), and Enter/double-click commits it as a drawn polygon.
//
// Edge snapping for the line/polygon tools used to live here as well
// (SAM-captured contours); it now uses the classical model-free livewire
// pipeline instead — see hooks/useMagneticDraw.ts.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import { Style, Stroke, Fill, Circle as CircleStyle } from 'ol/style.js';
import { DrawToolId } from '../types';
import { SamEngine, SamEmbedding } from '../utils/samEngine';
import { SamPromptPoint, SAM_INPUT_SIZE } from '../utils/samModels';
import {
  extractMaskPolygon,
  pixelRingToMapCoords,
  MaskPolygon,
  Pt,
} from '../utils/contourExtract';
import { captureMapCanvas, isTaintedCanvasError } from '../utils/mapExport';
import { SAM_STATUS_IDLE, SamStatus } from '../utils/samModels';

export interface SamToolsDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  activeDrawToolRef: React.MutableRefObject<DrawToolId>;
  /** Currently active tool (render-state copy for reactive effects). */
  activeDrawTool: DrawToolId;
  showDrawToolbar: boolean;
  /** Commits a traced polygon into the draw batch (useDrawSession).
   * Returns the created OL feature (or null). `opts.snapOriginal.meterPerPx`
   * stashes the as-traced outline in IndexedDB for the clean-up slider. */
  addExternalPolygon: (geometry: Polygon, opts?: { snapOriginal?: { meterPerPx: number } }) => any;
  showToast: (message: string, kind?: 'success' | 'error') => void;
}

interface WandSession {
  /** Prompt points in snapshot viewport pixels. */
  points: SamPromptPoint[];
  /** Latest traced polygon (1024-space) and its map-coordinate rings. */
  polygon: MaskPolygon | null;
  mapRings: number[][][] | null;
}

interface SnapshotRec {
  imageData: ImageData;
  extent: [number, number, number, number];
  width: number;
  height: number;
  viewKey: string;
}

// --- Layer styles ----------------------------------------------------------

const previewPolygonStyle = new Style({
  stroke: new Stroke({ color: 'rgba(74, 144, 226, 1)', width: 2, lineDash: [6, 4] }),
  fill: new Fill({ color: 'rgba(74, 144, 226, 0.15)' }),
});
const promptPositiveStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: 'rgba(74, 144, 226, 1)' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
});
const promptNegativeStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: 'rgba(231, 76, 60, 1)' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
});

export function useSamTools(deps: SamToolsDeps) {
  const { mapRef, activeDrawToolRef, activeDrawTool, showDrawToolbar } = deps;

  // Callback props kept in refs so the OL-facing handlers stay stable.
  const addExternalPolygonRef = useRef(deps.addExternalPolygon);
  const showToastRef = useRef(deps.showToast);
  useEffect(() => {
    addExternalPolygonRef.current = deps.addExternalPolygon;
    showToastRef.current = deps.showToast;
  });

  // --- State ----------------------------------------------------------------
  const [samStatus, setSamStatus] = useState<SamStatus>(SAM_STATUS_IDLE);

  // --- Refs -------------------------------------------------------------------
  const engineRef = useRef<SamEngine | null>(null);
  const engineLoadingRef = useRef<Promise<SamEngine | null> | null>(null);
  const snapshotRef = useRef<SnapshotRec | null>(null);
  const embeddingRef = useRef<SamEmbedding | null>(null);
  const wandSessionRef = useRef<WandSession | null>(null);
  const wandBusyRef = useRef(false);
  const queuedPointRef = useRef<SamPromptPoint | null>(null);
  /** Set when a prompt point is removed while a decode is in flight:
   * re-trace with the reduced prompt set once the decode settles. */
  const rerunAfterBusyRef = useRef(false);

  // OL layers owned by this hook (flagged `_isSamLayer` so the snapshot
  // capture and layer reordering know to skip them).
  const previewSourceRef = useRef<VectorSource | null>(null);
  const previewLayerRef = useRef<VectorLayer<any> | null>(null);
  const encodingPromiseRef = useRef<Promise<SamEmbedding | null> | null>(null);
  const attachedMapRef = useRef<OLMap | null>(null);
  const moveendHandlerRef = useRef<((...args: any[]) => void) | null>(null);

  const patchStatus = useCallback((patch: Partial<SamStatus>) => {
    setSamStatus((prev) => ({ ...prev, ...patch }));
  }, []);

  // --- Layer attachment --------------------------------------------------------

  /** Create the overlay layers once; called from the map init effect. */
  const attachSamLayers = useCallback((map: OLMap) => {
    if (attachedMapRef.current) return; // idempotent per mount
    attachedMapRef.current = map;

    const previewSource = new VectorSource();
    const previewLayer = new VectorLayer({
      source: previewSource,
      style: (feature: any) => {
        const kind = feature.get('_samKind');
        if (kind === 'prompt-neg') return promptNegativeStyle;
        if (kind === 'prompt-pos') return promptPositiveStyle;
        return previewPolygonStyle;
      },
    });
    previewLayer.setZIndex(10000);
    previewLayer.set('_isSamLayer', true);

    map.addLayer(previewLayer);
    previewSourceRef.current = previewSource;
    previewLayerRef.current = previewLayer;

    // Panning/zooming invalidates the SAM snapshot (the embedding is tied to
    // the exact pixels that were encoded).
    const onMoveEnd = () => {
      const mapNow = attachedMapRef.current;
      if (!mapNow) return;
      const snapshot = snapshotRef.current;
      if (snapshot && snapshot.viewKey !== viewKeyOf(mapNow)) {
        snapshotRef.current = null;
        embeddingRef.current = null;
        if (wandSessionRef.current && wandSessionRef.current.points.length > 0) {
          clearWandSession();
          showToastRef.current('View changed — click the object again to re-trace');
        }
      }
    };
    map.on('moveend', onMoveEnd);
    moveendHandlerRef.current = onMoveEnd;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Remove everything this hook added to the map (unmount / workspace switch). */
  const disposeSamTools = useCallback(() => {
    const map = attachedMapRef.current;
    if (!map) return;
    if (previewLayerRef.current) map.removeLayer(previewLayerRef.current);
    if (moveendHandlerRef.current) {
      map.un('moveend', moveendHandlerRef.current as any);
      moveendHandlerRef.current = null;
    }
    previewSourceRef.current = null;
    previewLayerRef.current = null;
    attachedMapRef.current = null;
    snapshotRef.current = null;
    embeddingRef.current = null;
    wandSessionRef.current = null;
  }, []);

  // --- Engine lifecycle ----------------------------------------------------------

  /** Lazily download + compile SAM 2.1 Tiny; resolves the ready engine or null. */
  const ensureEngine = useCallback((): Promise<SamEngine | null> => {
    const existing = engineRef.current;
    if (existing && existing.isReady) return Promise.resolve(existing);
    if (engineLoadingRef.current) return engineLoadingRef.current;

    const engine = existing || new SamEngine();
    engineRef.current = engine;
    const promise = engine
      .init((update) => patchStatus(update))
      .then(() => {
        patchStatus({ state: 'ready', progress: 1, message: 'AI ready', backend: engine.backend ?? undefined });
        return engine;
      })
      .catch((err: any) => {
        console.error('[SamTools] SAM init failed:', err);
        engineRef.current = null;
        const message = err && err.message ? err.message : String(err);
        patchStatus({ state: 'error', progress: 0, message });
        showToastRef.current(`SAM 2.1 model failed to load — ${message}`, 'error');
        return null;
      })
      .finally(() => {
        engineLoadingRef.current = null;
      });
    engineLoadingRef.current = promise;
    return promise;
  }, [patchStatus]);

  /** Kick off the model download early (wand tool selected). */
  const prefetch = useCallback(() => {
    void ensureEngine();
  }, [ensureEngine]);

  // --- Snapshot + embedding ---------------------------------------------------------

  const viewKeyOf = (map: OLMap): string => {
    const size = map.getSize();
    if (!size) return 'no-size';
    const extent = map.getView().calculateExtent(size);
    return `${extent.join(',')}@${size.join('x')}`;
  };

  /** Composite the visible map layers (minus drawing overlays) to pixels. */
  const captureSnapshot = useCallback(async (map: OLMap): Promise<SnapshotRec | null> => {
    try {
      const canvas = await captureMapCanvas(map, (layer: any) =>
        Boolean(
          layer.get('_isDrawLayer') ||
            layer.get('_isEditMarkerLayer') ||
            layer.get('_isSamLayer') ||
            layer.get('_isMagneticLayer'),
        ),
      );
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('No 2D canvas context available');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const size = map.getSize();
      const extent = (map.getView().calculateExtent(size) as number[]).slice(0, 4) as [number, number, number, number];
      const rec: SnapshotRec = { imageData, extent, width: canvas.width, height: canvas.height, viewKey: viewKeyOf(map) };
      snapshotRef.current = rec;
      embeddingRef.current = null;
      return rec;
    } catch (err) {
      if (isTaintedCanvasError(err)) {
        showToastRef.current('AI tracing needs readable tiles — a layer blocks cross-origin pixel access', 'error');
      } else {
        console.error('[SamTools] snapshot capture failed:', err);
        showToastRef.current('Could not capture the map image for AI tracing', 'error');
      }
      return null;
    }
  }, []);

  /** Encode the current view (cached until the view changes). Concurrent
   * callers share one encoding run instead of racing the GPU. */
  const ensureEncoded = useCallback(async (map: OLMap): Promise<SamEmbedding | null> => {
    let snapshot = snapshotRef.current;
    if (!snapshot || snapshot.viewKey !== viewKeyOf(map)) {
      snapshot = await captureSnapshot(map);
      if (!snapshot) return null;
    }
    if (embeddingRef.current) return embeddingRef.current;
    if (encodingPromiseRef.current) return encodingPromiseRef.current;

    const run = (async (): Promise<SamEmbedding | null> => {
      const engine = await ensureEngine();
      if (!engine) return null;
      patchStatus({ state: 'encoding', message: 'Analyzing map image…' });
      try {
        const embedding = await engine.encode(snapshot!.imageData);
        embeddingRef.current = embedding;
        return embedding;
      } finally {
        patchStatus({ state: 'ready', message: 'AI ready' });
      }
    })();
    encodingPromiseRef.current = run;
    run.finally(() => {
      encodingPromiseRef.current = null;
    });
    return run;
  }, [captureSnapshot, ensureEngine, patchStatus]);

  // --- Magic wand ---------------------------------------------------------------------

  const clearWandSession = useCallback(() => {
    wandSessionRef.current = null;
    queuedPointRef.current = null;
    rerunAfterBusyRef.current = false;
    previewSourceRef.current?.clear();
  }, []);

  /** Convert prompt points (viewport px) to the 1024 encoder space. */
  const toEncoderPoint = (p: SamPromptPoint, snapshot: SnapshotRec): Pt => ({
    x: (p.x / snapshot.width) * 1024,
    y: (p.y / snapshot.height) * 1024,
  });

  /** Decode the current prompt points into a polygon preview. */
  const runWandDecode = useCallback(async (session: WandSession): Promise<void> => {
    const engine = engineRef.current;
    const snapshot = snapshotRef.current;
    const embedding = embeddingRef.current;
    if (!engine || !snapshot || !embedding) return;

    const result = await engine.predict(embedding, session.points);
    // The session may have been cancelled (view change / Escape) mid-decode —
    // don't repaint a stale preview in that case.
    if (wandSessionRef.current !== session) return;
    // Seed selection prefers the ring under the most recent positive click.
    const lastPositive = [...session.points].reverse().find((p) => p.label === 1);
    const seed = lastPositive ? toEncoderPoint(lastPositive, snapshot) : undefined;
    const polygon = extractMaskPolygon({
      logits: result.logits,
      width: result.width,
      height: result.height,
      seed,
    });
    session.polygon = polygon;
    if (!polygon) {
      session.mapRings = null;
      previewSourceRef.current?.clear();
      return;
    }
    session.mapRings = [
      pixelRingToMapCoords(polygon.outer, result.width, result.height, snapshot.extent),
      ...polygon.holes.map((hole) => pixelRingToMapCoords(hole, result.width, result.height, snapshot.extent)),
    ];

    const source = previewSourceRef.current;
    if (source) {
      source.clear();
      const feature = new Feature(new Polygon(session.mapRings as any));
      feature.set('_samKind', 'polygon');
      source.addFeature(feature);
      // Prompt markers show where the user has clicked (blue = include,
      // red = exclude) so refinement stays legible.
      session.points.forEach((p) => {
        const coord = pixelToMapCoord(p.x, p.y, snapshot);
        const marker = new Feature(new Point(coord));
        marker.set('_samKind', p.label === 1 ? 'prompt-pos' : 'prompt-neg');
        source.addFeature(marker);
      });
    }
  }, []);

  /** Viewport pixel → map coordinate within the captured snapshot extent. */
  const pixelToMapCoord = (px: number, py: number, snapshot: SnapshotRec): number[] => {
    const [minX, minY, maxX, maxY] = snapshot.extent;
    return [
      minX + (px / snapshot.width) * (maxX - minX),
      maxY - (py / snapshot.height) * (maxY - minY),
    ];
  };

  /** Drain clicks queued during a decode, then honour any pending re-trace
   * request (a prompt point removed while a decode was in flight). */
  const drainQueuedAndRerun = useCallback(async (): Promise<void> => {
    while (queuedPointRef.current) {
      const queued = queuedPointRef.current;
      queuedPointRef.current = null;
      const current = wandSessionRef.current;
      if (!current) break; // session cancelled — drop the stale click
      current.points.push(queued);
      await runWandDecode(current);
    }
    if (rerunAfterBusyRef.current) {
      rerunAfterBusyRef.current = false;
      const current = wandSessionRef.current;
      if (current && current.points.length > 0) await runWandDecode(current);
    }
  }, [runWandDecode]);

  /** Map click while the wand tool is active — add a prompt, re-trace. */
  const handleWandClick = useCallback(async (evt: any) => {
    const map = mapRef.current;
    if (!map) return;
    const pixel = evt.pixel as [number, number];
    const label: 0 | 1 = evt.originalEvent && evt.originalEvent.shiftKey ? 0 : 1;

    // A decode in flight: queue this point instead of racing the GPU.
    if (wandBusyRef.current) {
      queuedPointRef.current = { x: pixel[0], y: pixel[1], label };
      return;
    }

    wandBusyRef.current = true;
    try {
      const embedding = await ensureEncoded(map);
      if (!embedding) return;
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      if (!wandSessionRef.current) {
        wandSessionRef.current = { points: [], polygon: null, mapRings: null };
      }
      const session = wandSessionRef.current;
      session.points.push({ x: pixel[0], y: pixel[1], label });
      await runWandDecode(session);
      await drainQueuedAndRerun();
    } catch (err) {
      console.error('[SamTools] wand decode failed:', err);
      showToastRef.current('AI tracing failed — try clicking again', 'error');
    } finally {
      wandBusyRef.current = false;
    }
  }, [drainQueuedAndRerun, ensureEncoded, mapRef, runWandDecode]);

  /**
   * Remove a prompt point (blue include / red exclude) from the in-progress
   * trace and re-decode the mask. `index` -1 removes the most recent point.
   * Returns true when a point was removed.
   */
  const removeWandPoint = useCallback((index: number): boolean => {
    const session = wandSessionRef.current;
    if (!session || session.points.length === 0) return false;
    const idx = index < 0 ? session.points.length - 1 : index;
    if (idx < 0 || idx >= session.points.length) return false;

    session.points.splice(idx, 1);
    // Any click queued mid-decode referred to the old prompt set — drop it.
    queuedPointRef.current = null;

    if (session.points.length === 0) {
      // No prompts left: clear the preview but keep the (empty) session
      // armed so the next click starts straight away.
      session.polygon = null;
      session.mapRings = null;
      previewSourceRef.current?.clear();
      return true;
    }

    if (wandBusyRef.current) {
      // Decode in flight — re-trace with the reduced prompt set once it
      // settles (see drainQueuedAndRerun).
      rerunAfterBusyRef.current = true;
      return true;
    }

    wandBusyRef.current = true;
    runWandDecode(session)
      .then(() => drainQueuedAndRerun())
      .catch((err) => {
        console.error('[SamTools] wand decode failed:', err);
        showToastRef.current('AI tracing failed — try clicking again', 'error');
      })
      .finally(() => {
        wandBusyRef.current = false;
      });
    return true;
  }, [drainQueuedAndRerun, runWandDecode]);

  /** Remove the prompt point nearest a map pixel (right-click removal).
   * Session points live in snapshot viewport pixels, which equal the
   * current map pixels — any view change clears the session. */
  const removeWandPointAtPixel = useCallback((pixel: number[], tolerancePx = 12): boolean => {
    const session = wandSessionRef.current;
    if (!session || session.points.length === 0) return false;
    let bestIndex = -1;
    let bestDist = tolerancePx;
    session.points.forEach((p, i) => {
      const d = Math.hypot(p.x - pixel[0], p.y - pixel[1]);
      if (d <= bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    });
    if (bestIndex === -1) return false;
    return removeWandPoint(bestIndex);
  }, [removeWandPoint]);

  /** Commit the traced polygon into the draw batch. The as-traced outline is
   * stashed alongside it (meterPerPx scales the clean-up slider tolerance)
   * so the drawn-features editor can re-simplify it at any time. */
  const confirmWand = useCallback(() => {
    const session = wandSessionRef.current;
    if (!session || !session.mapRings) return;
    const rings = session.mapRings;
    const snapshot = snapshotRef.current;
    const meterPerPx = snapshot
      ? (snapshot.extent[2] - snapshot.extent[0]) / SAM_INPUT_SIZE
      : undefined;
    addExternalPolygonRef.current(
      new Polygon(rings as any),
      meterPerPx !== undefined ? { snapOriginal: { meterPerPx } } : undefined,
    );
    clearWandSession();
    showToastRef.current('Object traced — polygon added to drawings');
  }, [clearWandSession]);

  /** Discard the in-progress trace (Escape). */
  const cancelWand = useCallback(() => {
    if (wandSessionRef.current) clearWandSession();
  }, [clearWandSession]);

  // --- Effects -----------------------------------------------------------------------------

  // Keyboard: Enter/Escape/Backspace control the wand preview.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeDrawToolRef.current !== 'wand') return;
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmWand();
      } else if (e.key === 'Escape') {
        // Escape discards the in-progress trace and keeps the wand armed;
        // preventDefault stops the draw session's Escape handler from
        // exiting the tool. With no trace in progress the event passes
        // through and the tool exits as usual.
        if (wandSessionRef.current) {
          e.preventDefault();
          cancelWand();
        }
      } else if (e.key === 'Backspace') {
        // Backspace removes the most recent refine/exclude point.
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        if (wandSessionRef.current && wandSessionRef.current.points.length > 0) {
          e.preventDefault();
          removeWandPoint(-1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeDrawToolRef, confirmWand, cancelWand, removeWandPoint]);

  // Leaving the wand tool discards any in-progress trace.
  useEffect(() => {
    if (activeDrawTool !== 'wand' && wandSessionRef.current) {
      clearWandSession();
    }
  }, [activeDrawTool, clearWandSession]);

  // Hiding the toolbar tears the whole subsystem down.
  useEffect(() => {
    if (!showDrawToolbar) {
      clearWandSession();
    }
  }, [showDrawToolbar, clearWandSession]);

  // Unmount cleanup.
  useEffect(() => () => disposeSamTools(), [disposeSamTools]);

  return {
    samStatus,
    attachSamLayers,
    disposeSamTools,
    prefetch,
    handleWandClick,
    removeWandPoint,
    removeWandPointAtPixel,
    confirmWand,
    cancelWand,
  };
}
