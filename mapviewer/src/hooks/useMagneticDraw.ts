// ---------------------------------------------------------------------------
// useMagneticDraw — magnetic edge snapping for the line/polygon draw tools.
//
// Classical "intelligent scissors" / livewire front end, model-free:
// right-clicking the line/polygon toolbar button arms magnetic mode. The
// hook captures the current map view, runs a classical edge detector
// (Sobel → non-max suppression → hysteresis chain tracing, see
// utils/livewire.ts) and shows the detected edges as a faint dashed guide.
// While drawing, holding Shift adds an OL Snap interaction fed by those
// edge polylines, so vertices snap to what is visible on the map image
// (rooftops, roads, boundaries…) — the same gesture as the old SAM-based
// smart snap, minus the model and the Alt+click capture step. Panning or
// zooming re-extracts edges for the new view.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import Snap from 'ol/interaction/Snap.js';
import { Style, Stroke, Fill, Circle as CircleStyle } from 'ol/style.js';
import { DrawToolId } from '../types';
import { extractEdgePolylines, nearestPointOnPolylines } from '../utils/livewire';
import { pixelRingToMapCoords, Pt } from '../utils/contourExtract';
import { captureMapCanvas, isTaintedCanvasError } from '../utils/mapExport';

export type MagneticStatus = 'idle' | 'extracting' | 'ready' | 'error';

export interface MagneticDrawDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  activeDrawToolRef: React.MutableRefObject<DrawToolId>;
  /** Currently active tool (render-state copy for reactive effects). */
  activeDrawTool: DrawToolId;
  showDrawToolbar: boolean;
  showToast: (message: string, kind?: 'success' | 'error') => void;
}

/** Re-extraction debounce after the view settles (ms). */
const REFRESH_DEBOUNCE_MS = 300;
/** Pixel tolerance for Shift-snapping to the extracted edges. */
const SNAP_TOLERANCE_PX = 22;

const guideStyle = new Style({
  stroke: new Stroke({ color: 'rgba(74, 144, 226, 0.35)', width: 1, lineDash: [2, 3] }),
});
const snapMarkerStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: 'rgba(255, 255, 255, 0.95)' }),
    stroke: new Stroke({ color: '#4a90e2', width: 2.5 }),
  }),
});

export function useMagneticDraw(deps: MagneticDrawDeps) {
  const { mapRef, activeDrawToolRef, activeDrawTool, showDrawToolbar } = deps;
  const showToastRef = useRef(deps.showToast);
  useEffect(() => {
    showToastRef.current = deps.showToast;
  });

  // --- State ----------------------------------------------------------------
  const [magneticArmed, setMagneticArmed] = useState<{ line: boolean; polygon: boolean }>({
    line: false,
    polygon: false,
  });
  const [magneticStatus, setMagneticStatus] = useState<MagneticStatus>('idle');

  // --- Refs -------------------------------------------------------------------
  const armedRef = useRef<{ line: boolean; polygon: boolean }>({ line: false, polygon: false });
  // Edge polylines as LineString features — snap targets for the OL Snap
  // interaction and contents of the visible guide layer.
  const edgeSourceRef = useRef<VectorSource | null>(null);
  if (!edgeSourceRef.current) edgeSourceRef.current = new VectorSource();
  /** Last extracted chains in map coordinates (for the snap marker pass). */
  const edgeChainsRef = useRef<number[][][] | null>(null);
  const guideSourceRef = useRef<VectorSource | null>(null);
  const guideLayerRef = useRef<VectorLayer<any> | null>(null);
  const markerSourceRef = useRef<VectorSource | null>(null);
  const markerLayerRef = useRef<VectorLayer<any> | null>(null);
  const snapInteractionRef = useRef<Snap | null>(null);
  const snapMoveHandlerRef = useRef<((evt: any) => void) | null>(null);
  /** Pixel-space chains cached per view for the pointermove marker pass. */
  const pixelChainsCacheRef = useRef<{ viewKey: string; chainsPx: Pt[][] } | null>(null);
  const attachedMapRef = useRef<OLMap | null>(null);
  const moveendHandlerRef = useRef<((...args: any[]) => void) | null>(null);
  const captureSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  /** ViewKey of the snapshot the current edge features were derived from. */
  const extractedViewKeyRef = useRef<string | null>(null);

  const viewKeyOf = (map: OLMap): string => {
    const size = map.getSize();
    if (!size) return 'no-size';
    const extent = map.getView().calculateExtent(size);
    return `${extent.join(',')}@${size.join('x')}`;
  };

  // --- Layer attachment --------------------------------------------------------

  /** Create the guide + marker layers once; called from the map init effect. */
  const attachLayers = useCallback((map: OLMap) => {
    if (attachedMapRef.current) return; // idempotent per mount
    attachedMapRef.current = map;

    const guideSource = new VectorSource();
    const guideLayer = new VectorLayer({ source: guideSource, style: guideStyle });
    guideLayer.setZIndex(9997);
    guideLayer.set('_isMagneticLayer', true);

    const markerSource = new VectorSource();
    const markerLayer = new VectorLayer({ source: markerSource, style: snapMarkerStyle });
    markerLayer.setZIndex(10002);
    markerLayer.set('_isMagneticLayer', true);

    map.addLayer(guideLayer);
    map.addLayer(markerLayer);
    guideSourceRef.current = guideSource;
    guideLayerRef.current = guideLayer;
    markerSourceRef.current = markerSource;
    markerLayerRef.current = markerLayer;

    // Panning/zooming invalidates the extracted edges (they are tied to the
    // exact pixels of the captured view) — re-extract once the view settles.
    // This also retries automatically after a failed capture.
    const onMoveEnd = () => {
      const mapNow = attachedMapRef.current;
      if (!mapNow) return;
      if (extractedViewKeyRef.current === viewKeyOf(mapNow)) return;
      extractedViewKeyRef.current = null;
      edgeSourceRef.current?.clear();
      guideSourceRef.current?.clear();
      edgeChainsRef.current = null;
      pixelChainsCacheRef.current = null;
      if (armedRef.current.line || armedRef.current.polygon) {
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = null;
          void refreshEdges();
        }, REFRESH_DEBOUNCE_MS);
      } else {
        setMagneticStatus('idle');
      }
    };
    map.on('moveend', onMoveEnd);
    moveendHandlerRef.current = onMoveEnd;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Remove everything this hook added to the map (unmount / workspace switch). */
  const dispose = useCallback(() => {
    const map = attachedMapRef.current;
    if (!map) return;
    disarmSnap();
    if (moveendHandlerRef.current) {
      map.un('moveend', moveendHandlerRef.current as any);
      moveendHandlerRef.current = null;
    }
    if (guideLayerRef.current) map.removeLayer(guideLayerRef.current);
    if (markerLayerRef.current) map.removeLayer(markerLayerRef.current);
    guideSourceRef.current = null;
    guideLayerRef.current = null;
    markerSourceRef.current = null;
    markerLayerRef.current = null;
    edgeSourceRef.current?.clear();
    edgeChainsRef.current = null;
    pixelChainsCacheRef.current = null;
    attachedMapRef.current = null;
    extractedViewKeyRef.current = null;
    captureSeqRef.current++;
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Shift-gated Snap interaction ----------------------------------------------

  /** Add the Snap interaction while Shift is held (if edges exist). */
  const maybeArmSnap = useCallback(() => {
    const map = mapRef.current;
    const tool = activeDrawToolRef.current;
    if (!map || snapInteractionRef.current) return;
    if (tool !== 'line' && tool !== 'polygon') return;
    if (!armedRef.current[tool]) return;
    const source = edgeSourceRef.current;
    if (!source || source.isEmpty()) return;

    const snap = new Snap({ source, pixelTolerance: SNAP_TOLERANCE_PX });
    map.addInteraction(snap); // added last → runs before Draw in the event chain
    snapInteractionRef.current = snap;

    // OL's Snap only reports a hit when snapping occurs (no "unsnap"), so
    // the visible marker is driven by our own nearest-point pass over the
    // extracted edge polylines.
    const onMove = (evt: any) => {
      const chains = edgeChainsRef.current;
      const markerSource = markerSourceRef.current;
      if (!chains || chains.length === 0 || !markerSource) return;
      let cache = pixelChainsCacheRef.current;
      const key = viewKeyOf(map);
      if (!cache || cache.viewKey !== key) {
        cache = {
          viewKey: key,
          chainsPx: chains.map((chain) =>
            chain.map((coord) => {
              const px = map.getPixelFromCoordinate(coord as any) as [number, number];
              return { x: px[0], y: px[1] };
            }),
          ),
        };
        pixelChainsCacheRef.current = cache;
      }
      const pixel = evt.pixel as [number, number];
      const hit = nearestPointOnPolylines({ x: pixel[0], y: pixel[1] }, cache.chainsPx, SNAP_TOLERANCE_PX);
      markerSource.clear();
      if (hit) {
        const coord = map.getCoordinateFromPixel([hit.point.x, hit.point.y]);
        markerSource.addFeature(new Feature(new Point(coord)));
      }
    };
    map.on('pointermove', onMove);
    snapMoveHandlerRef.current = onMove;
  }, [activeDrawToolRef, mapRef]);

  /** Remove the Snap interaction (Shift released / tool changed / disarm). */
  const disarmSnap = useCallback(() => {
    const map = mapRef.current;
    if (snapInteractionRef.current) {
      if (map) map.removeInteraction(snapInteractionRef.current);
      snapInteractionRef.current = null;
    }
    if (map && snapMoveHandlerRef.current) {
      map.un('pointermove', snapMoveHandlerRef.current);
    }
    snapMoveHandlerRef.current = null;
    markerSourceRef.current?.clear();
  }, [mapRef]);

  // Keyboard: Shift gates snapping (mirrors the old SAM smart-snap gesture).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !e.repeat) maybeArmSnap();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') disarmSnap();
    };
    const onBlur = () => disarmSnap();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [maybeArmSnap, disarmSnap]);

  // Leaving line/polygon releases the snap interaction.
  useEffect(() => {
    if (activeDrawTool !== 'line' && activeDrawTool !== 'polygon') {
      disarmSnap();
    }
  }, [activeDrawTool, disarmSnap]);

  // --- Edge extraction -----------------------------------------------------------

  /** Capture the current view and rebuild the edge features from its pixels. */
  const refreshEdges = useCallback(async (): Promise<void> => {
    const map = mapRef.current;
    if (!map) return;
    const seq = ++captureSeqRef.current;
    setMagneticStatus('extracting');
    try {
      const canvas = await captureMapCanvas(map, (layer: any) =>
        Boolean(
          layer.get('_isDrawLayer') ||
            layer.get('_isEditMarkerLayer') ||
            layer.get('_isSamLayer') ||
            layer.get('_isMagneticLayer'),
        ),
      );
      // Stale capture (a newer refresh started, or mode disarmed meanwhile).
      if (seq !== captureSeqRef.current || (!armedRef.current.line && !armedRef.current.polygon)) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('No 2D canvas context available');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { chains, width, height } = extractEdgePolylines(imageData);
      if (seq !== captureSeqRef.current) return;

      const size = map.getSize();
      const extent = (map.getView().calculateExtent(size) as number[]).slice(0, 4) as [
        number, number, number, number,
      ];
      const mapChains = chains.map((chain) => pixelRingToMapCoords(chain, width, height, extent));
      const features = mapChains.map(
        (chain) => new Feature(new LineString(chain as any)),
      );
      const edgeSource = edgeSourceRef.current;
      const guideSource = guideSourceRef.current;
      edgeSource?.clear();
      guideSource?.clear();
      if (features.length > 0) {
        edgeSource?.addFeatures(features);
        guideSource?.addFeatures(features);
      }
      edgeChainsRef.current = mapChains;
      pixelChainsCacheRef.current = null;
      extractedViewKeyRef.current = viewKeyOf(map);
      setMagneticStatus('ready');
      if (features.length === 0) {
        showToastRef.current('No strong edges found in this view — zoom in or pan to a sharper area');
      }
    } catch (err) {
      if (seq !== captureSeqRef.current) return;
      if (isTaintedCanvasError(err)) {
        showToastRef.current('Magnetic edges need readable tiles — a layer blocks cross-origin pixel access', 'error');
      } else {
        console.error('[MagneticDraw] edge extraction failed:', err);
        showToastRef.current('Could not capture the map image for edge detection', 'error');
      }
      setMagneticStatus('error');
    }
  }, [mapRef]);

  // --- Public API -------------------------------------------------------------------

  /** Right-click on the line/polygon toolbar button toggles magnetic mode. */
  const toggleMagnetic = useCallback(
    (tool: 'line' | 'polygon') => {
      const turningOn = !armedRef.current[tool];
      const next = { ...armedRef.current, [tool]: turningOn };
      armedRef.current = next;
      setMagneticArmed(next);
      if (turningOn) {
        showToastRef.current(
          `Magnetic edges on (${tool}) — hold Shift while drawing to snap vertices to the map's edges`,
        );
        void refreshEdges();
      } else {
        disarmSnap();
        if (!next.line && !next.polygon) {
          captureSeqRef.current++;
          edgeSourceRef.current?.clear();
          guideSourceRef.current?.clear();
          edgeChainsRef.current = null;
          pixelChainsCacheRef.current = null;
          extractedViewKeyRef.current = null;
          setMagneticStatus('idle');
          showToastRef.current('Magnetic edges off');
        } else {
          showToastRef.current(`Magnetic edges off (${tool})`);
        }
      }
    },
    [disarmSnap, refreshEdges],
  );

  /** Read-only check for the pointer handlers in MapPage. */
  const isMagneticArmed = useCallback((tool: DrawToolId): boolean => {
    return (tool === 'line' || tool === 'polygon') && armedRef.current[tool];
  }, []);

  // --- Effects ---------------------------------------------------------------------------

  // Hiding the toolbar disarms the whole subsystem.
  useEffect(() => {
    if (!showDrawToolbar) {
      disarmSnap();
      armedRef.current = { line: false, polygon: false };
      setMagneticArmed({ line: false, polygon: false });
      captureSeqRef.current++;
      edgeSourceRef.current?.clear();
      guideSourceRef.current?.clear();
      edgeChainsRef.current = null;
      pixelChainsCacheRef.current = null;
      extractedViewKeyRef.current = null;
      setMagneticStatus('idle');
    }
  }, [showDrawToolbar, disarmSnap]);

  // Unmount cleanup.
  useEffect(() => () => dispose(), [dispose]);

  return {
    magneticArmed,
    magneticStatus,
    attachLayers,
    dispose,
    toggleMagnetic,
    isMagneticArmed,
  };
}
