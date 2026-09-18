// ---------------------------------------------------------------------------
// useElevationProfile — the map side of the "Elevation Profile" window.
//
// Owns everything that lives on the map for a profile session: the vector
// layer the pen-drawn lines are dropped into (dashed, like the scissors' cut
// line), the OL Draw interaction behind the window's Pen button, the sampling
// run that turns each finished line into chart data (utils/elevationProfile),
// the record list, and the hover marker that ties the chart's crosshair to a
// position on the ground.
//
// The window component owns no OL objects at all — it renders records and
// calls the callbacks returned here, which keeps MapPage an orchestrator and
// the window testable without a real map (pass `map: null`).
//
// Coordinates: a drawn line arrives in the view projection (OL never
// reprojects vector layers), so each record keeps both — `coords` for the map
// feature and `mercator` for sampling, distances and the saved layer, which
// are all defined in EPSG:3857.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Draw from 'ol/interaction/Draw.js';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom.js';
import { Style, Stroke, Fill, Circle as CircleStyle } from 'ol/style.js';
import { never } from 'ol/events/condition.js';
import { transform } from 'ol/proj.js';
import type { RasterLayer } from '../types';
import { generateId } from '../constants';
import type { Pt2 } from '../utils/geodesic';
import {
  PROFILE_ACTIVE_PROPERTY,
  PROFILE_DEFAULT_SAMPLES,
  PROFILE_HOVER_PROPERTY,
  PROFILE_ID_PROPERTY,
  PROFILE_LAYER_PROPERTY,
  coordinateAtDistance,
  profileFailureMessage,
  sampleElevationProfile,
  terrainRendererOf,
  type ProfileGrid,
  type ProfilePoint,
  type ProfileSampleResult,
  type ProfileStats,
} from '../utils/elevationProfile';

/** One pen-drawn line and the profile sampled from it. */
export interface ProfileRecord {
  id: string;
  name: string;
  /** Line vertices in the view projection — what the map feature carries. */
  coords: number[][];
  /** The same line in EPSG:3857 — what sampling, distances and saving use. */
  mercator: Pt2[];
  points: ProfilePoint[];
  stats: ProfileStats | null;
  status: 'sampling' | 'ready' | 'error';
  /** Plain-language reason when `status` is 'error'. */
  error: string | null;
  /** The grid the elevations came from (cell size + provenance). */
  grid: ProfileGrid | null;
  /** Ground size of one grid cell, metres — the readout's resolution line. */
  cellSize: number | null;
  feature: Feature;
  /** Vector layer id this profile was saved to, once it has been. */
  savedLayerId: string | null;
}

export interface UseElevationProfileDeps {
  /** The OL map; null keeps the session inert (window-only rendering). */
  map: any;
  /** The terrain-rendered raster layer being profiled. */
  layer: RasterLayer;
  /** Requested sample count per line. */
  samples?: number;
}

/** Above every data layer, below the app's own chrome (menus are 100000+). */
const PROFILE_Z_INDEX = 9000;

// --- styles ----------------------------------------------------------------

const ACTIVE_LINE = new Style({
  stroke: new Stroke({ color: 'rgba(74,144,226,0.95)', width: 2.5, lineDash: [10, 7], lineCap: 'round' }),
});
/** The active line's drawn vertices, without extra features in the source. */
const ACTIVE_VERTICES = new Style({
  geometry: (feature: any) => {
    const geom = feature?.getGeometry?.();
    return geom && geom.getType() === 'LineString' ? new MultiPoint(geom.getCoordinates()) : undefined;
  },
  image: new CircleStyle({
    radius: 3.5,
    fill: new Fill({ color: '#4a90e2' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
});
const INACTIVE_LINE = new Style({
  stroke: new Stroke({ color: 'rgba(92,114,145,0.75)', width: 2, lineDash: [6, 6], lineCap: 'round' }),
});
const SKETCH_LINE = new Style({
  stroke: new Stroke({ color: 'rgba(74,144,226,0.9)', width: 2, lineDash: [8, 6] }),
});
const SKETCH_VERTEX_IMAGE = new CircleStyle({
  radius: 4,
  fill: new Fill({ color: 'rgba(74,144,226,1)' }),
  stroke: new Stroke({ color: '#fff', width: 1.5 }),
});
const HOVER_MARKER = new Style({
  image: new CircleStyle({
    radius: 5.5,
    fill: new Fill({ color: 'rgba(231,76,60,0.95)' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
  zIndex: 2,
});

function profileLayerStyle(feature: any): Style[] {
  if (feature.get(PROFILE_HOVER_PROPERTY)) return [HOVER_MARKER];
  const geom = feature.getGeometry?.();
  if (geom && geom.getType() === 'Point') return [];
  return feature.get(PROFILE_ACTIVE_PROPERTY)
    ? [ACTIVE_LINE, ACTIVE_VERTICES]
    : [INACTIVE_LINE];
}

/** Parameters whose change makes an existing profile stale. */
function terrainKey(layer: RasterLayer): string {
  const info = terrainRendererOf(layer);
  if (!info) return 'none';
  if (info.kind === 'cog') {
    // The display stretch is irrelevant here: a profile reads the file's raw
    // band values, not the normalised pixels the shader shows. Which BAND is
    // read is not.
    return ['cog', info.mode, layer.cogRender?.band].join('|');
  }
  const r = layer.tileRender;
  return ['tile', info.mode, r?.encoding, r?.grayscaleRange?.min, r?.grayscaleRange?.max].join('|');
}

export function useElevationProfile({ map, layer, samples }: UseElevationProfileDeps) {
  const sampleCount = Number.isFinite(samples) && (samples as number) > 0
    ? (samples as number)
    : PROFILE_DEFAULT_SAMPLES;

  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [penArmed, setPenArmed] = useState(false);
  const [hoverDistance, setHoverDistance] = useState<number | null>(null);

  const profilesRef = useRef<ProfileRecord[]>(profiles);
  profilesRef.current = profiles;
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  const penArmedRef = useRef(penArmed);
  penArmedRef.current = penArmed;
  const samplesRef = useRef(sampleCount);
  samplesRef.current = sampleCount;

  // The live layer config: its `olLayer` is replaced whenever the renderer is
  // re-applied, so a sampling run must read the newest one, never a captured copy.
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const mapRef = useRef<any>(map);
  mapRef.current = map;

  const sourceRef = useRef<VectorSource | null>(null);
  const layerOlRef = useRef<VectorLayer<any> | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const hoverFeatureRef = useRef<Feature | null>(null);
  const sketchingRef = useRef(false);
  const abortersRef = useRef(new Map<string, AbortController>());
  const counterRef = useRef(0);

  const activeProfile = useMemo(
    () => profiles.find(p => p.id === activeId) ?? null,
    [profiles, activeId],
  );

  // --- the profile line layer ----------------------------------------------

  useEffect(() => {
    if (!map || typeof map.addLayer !== 'function') return;
    const source = new VectorSource({ wrapX: false });
    const olLayer = new VectorLayer({
      source,
      style: profileLayerStyle,
      zIndex: PROFILE_Z_INDEX,
      // Allow re-rendering during the Draw interaction so finished lines
      // appear immediately rather than waiting for the next pan/zoom.
      updateWhileAnimating: true,
      updateWhileInteracting: true,
      properties: { [PROFILE_LAYER_PROPERTY]: true },
    });
    map.addLayer(olLayer);
    sourceRef.current = source;
    layerOlRef.current = olLayer;
    return () => {
      // A profile session never outlives its window: drop the lines and abort
      // any read still in flight.
      abortersRef.current.forEach(controller => controller.abort());
      abortersRef.current.clear();
      if (mapRef.current && typeof mapRef.current.removeLayer === 'function') {
        mapRef.current.removeLayer(olLayer);
      }
      sourceRef.current = null;
      layerOlRef.current = null;
      hoverFeatureRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // --- sampling -------------------------------------------------------------

  const patchProfile = useCallback((id: string, patch: Partial<ProfileRecord>) => {
    setProfiles(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  /** The map's view projection code, or null when there is no usable view. */
  const viewProjection = useCallback((): string | null => {
    try {
      const view = mapRef.current?.getView?.();
      const code = view?.getProjection?.()?.getCode?.();
      return typeof code === 'string' ? code : null;
    } catch {
      return null;
    }
  }, []);

  const currentZoom = useCallback((): number | undefined => {
    try {
      const zoom = mapRef.current?.getView?.()?.getZoom?.();
      return typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : undefined;
    } catch {
      return undefined;
    }
  }, []);

  /** Line vertices as EPSG:3857 (the space sampling and saving are defined in). */
  const toMercator = useCallback((coords: number[][]): Pt2[] => {
    const code = viewProjection();
    if (!code || code === 'EPSG:3857') return coords.map(c => [c[0], c[1]] as Pt2);
    return coords.map(c => {
      try {
        const out = transform([c[0], c[1]], code, 'EPSG:3857');
        return [out[0], out[1]] as Pt2;
      } catch {
        return [c[0], c[1]] as Pt2;
      }
    });
  }, [viewProjection]);

  const runSampling = useCallback(async (record: ProfileRecord) => {
    const controller = new AbortController();
    abortersRef.current.get(record.id)?.abort();
    abortersRef.current.set(record.id, controller);
    const layerConfig = layerRef.current;
    let result: ProfileSampleResult;
    try {
      result = await sampleElevationProfile({
        layer: layerConfig,
        coords: record.mercator,
        samples: samplesRef.current,
        zoom: currentZoom(),
        signal: controller.signal,
      });
    } catch (err) {
      console.error('[ElevationProfile] Sampling failed:', err);
      abortersRef.current.delete(record.id);
      patchProfile(record.id, {
        status: 'error',
        error: (err as any)?.message || 'Could not read the terrain under this line.',
        points: [],
        stats: null,
        grid: null,
      });
      return;
    }
    if (controller.signal.aborted) return; // superseded by a newer read
    abortersRef.current.delete(record.id);

    if (result.failure && result.failure !== 'cancelled') {
      patchProfile(record.id, {
        status: 'error',
        error: profileFailureMessage(result.failure, layerConfig.name, result.detail),
        points: result.points,
        stats: result.stats,
        grid: result.grid,
        cellSize: result.grid?.cellSize ?? null,
      });
      return;
    }
    patchProfile(record.id, {
      status: 'ready',
      error: null,
      points: result.points,
      stats: result.stats,
      grid: result.grid,
      cellSize: result.grid?.cellSize ?? null,
    });
  }, [currentZoom, patchProfile]);

  const runSamplingRef = useRef(runSampling);
  runSamplingRef.current = runSampling;

  // --- pen (draw) interaction ------------------------------------------------

  /**
   * Turn a finished sketch into a record. The Draw interaction inserts the
   * feature into the profile source itself (after `drawend`), so the record
   * only has to carry the same object and tag it for the style function.
   */
  const addProfileFromLine = useCallback((coords: number[][], feature: Feature): ProfileRecord | null => {
    const clean = coords.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if (clean.length < 2) return null;
    const id = generateId(6);
    counterRef.current += 1;
    return {
      id,
      name: `Elevation Profile ${counterRef.current}`,
      coords: clean.map(c => [c[0], c[1]]),
      mercator: toMercator(clean),
      points: [],
      stats: null,
      status: 'sampling',
      error: null,
      grid: null,
      cellSize: null,
      feature,
      savedLayerId: null,
    };
  }, [toMercator]);

  useEffect(() => {
    if (!map || !penArmed || typeof map.addInteraction !== 'function') return;
    const source = sourceRef.current;
    if (!source) return;

    const draw = new Draw({
      source,
      type: 'LineString',
      // Shift stays free (OL's default would start freehand drawing instead).
      freehandCondition: never,
      // The map's own click handler must not open a feature popup mid-draw.
      stopClick: true,
      style: (feature: any) => {
        const geom = feature?.getGeometry?.();
        const styles: Style[] = [SKETCH_LINE];
        if (geom && geom.getType() === 'LineString') {
          styles.push(...(geom as LineString).getCoordinates().map(c => new Style({
            geometry: new Point(c),
            image: SKETCH_VERTEX_IMAGE,
          })));
        }
        return styles;
      },
    });

    draw.on('drawstart', () => { sketchingRef.current = true; });
    draw.on('drawend', (evt: any) => {
      sketchingRef.current = false;
      const feature = evt.feature as Feature;
      const geom = feature.getGeometry() as LineString | null;
      const coords = geom && typeof geom.getCoordinates === 'function'
        ? (geom.getCoordinates() as number[][])
        : [];
      // OL dispatches drawend *before* the sketch reaches the source, so the
      // bookkeeping that reads the source runs a microtask later.
      const record = addProfileFromLine(coords, feature);
      if (!record) return;
      feature.set(PROFILE_ID_PROPERTY, record.id, true);
      feature.set(PROFILE_ACTIVE_PROPERTY, true, true);
      Promise.resolve().then(() => {
        setActiveId(record.id);
        setHoverDistance(null);
        setProfiles(prev => [...prev, record]);
        void runSamplingRef.current(record);
        // OL adds the feature to the source after drawend returns; force a
        // re-render so the line is visible even while the Draw interaction
        // is still active (updateWhileInteracting may defer it otherwise).
        layerOlRef.current?.changed?.();
      });
    });

    // Double-click finishes the line, so it must not also zoom the map.
    let doubleClickZoom: DoubleClickZoom | null = null;
    try {
      const interactions = map.getInteractions?.();
      const all = interactions ? interactions.getArray() : [];
      doubleClickZoom = all.find((i: any) => i instanceof DoubleClickZoom) ?? null;
      if (doubleClickZoom && typeof doubleClickZoom.getActive === 'function' && doubleClickZoom.getActive()) {
        doubleClickZoom.setActive(false);
      } else {
        doubleClickZoom = null;
      }
    } catch {
      doubleClickZoom = null;
    }

    map.addInteraction(draw);
    drawRef.current = draw;
    return () => {
      if (mapRef.current && typeof mapRef.current.removeInteraction === 'function') {
        mapRef.current.removeInteraction(draw);
      }
      drawRef.current = null;
      sketchingRef.current = false;
      if (doubleClickZoom && typeof doubleClickZoom.setActive === 'function') doubleClickZoom.setActive(true);
    };
  }, [map, penArmed, addProfileFromLine]);

  const togglePen = useCallback(() => setPenArmed(armed => !armed), []);
  const disarmPen = useCallback(() => setPenArmed(false), []);

  // Keyboard, while the pen is down: Enter finishes the line (OL's Draw only
  // offers double-click), Escape abandons the sketch in progress — or puts the
  // pen down when there is nothing in progress. The same gesture model the
  // scissors tool uses.
  useEffect(() => {
    if (!penArmed) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (!sketchingRef.current) return;
        try { drawRef.current?.finishDrawing?.(); } catch { /* already finished */ }
        return;
      }
      if (sketchingRef.current) {
        try { drawRef.current?.abortDrawing?.(); } catch { /* already finished */ }
        sketchingRef.current = false;
        return;
      }
      setPenArmed(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [penArmed]);

  // --- record bookkeeping ---------------------------------------------------

  const selectProfile = useCallback((id: string) => {
    setActiveId(current => (current === id ? current : id));
    setHoverDistance(null);
  }, []);

  const removeProfile = useCallback((id: string) => {
    abortersRef.current.get(id)?.abort();
    abortersRef.current.delete(id);
    const record = profilesRef.current.find(p => p.id === id);
    if (record?.feature && sourceRef.current?.hasFeature(record.feature)) {
      sourceRef.current.removeFeature(record.feature);
    }
    const next = profilesRef.current.filter(p => p.id !== id);
    setProfiles(next);
    if (activeIdRef.current === id) setActiveId(next[next.length - 1]?.id ?? null);
    setHoverDistance(null);
  }, []);

  const clearProfiles = useCallback(() => {
    abortersRef.current.forEach(controller => controller.abort());
    abortersRef.current.clear();
    sourceRef.current?.clear();
    hoverFeatureRef.current = null;
    counterRef.current = 0;
    setProfiles([]);
    setActiveId(null);
    setHoverDistance(null);
  }, []);

  const resampleAll = useCallback(() => {
    const records = profilesRef.current;
    if (records.length === 0) return;
    records.forEach(record => {
      patchProfile(record.id, { status: 'sampling', error: null });
      void runSamplingRef.current(record);
    });
  }, [patchProfile]);

  // Changing the sample count re-reads every line at the new resolution.
  const mountedSamplesRef = useRef(sampleCount);
  useEffect(() => {
    if (mountedSamplesRef.current === sampleCount) return;
    mountedSamplesRef.current = sampleCount;
    resampleAll();
  }, [sampleCount, resampleAll]);

  // Re-apply the terrain renderer (or point it at another band/encoding) and
  // the profiles on screen are stale: re-read them.
  const key = terrainKey(layer);
  const mountedKeyRef = useRef(key);
  useEffect(() => {
    if (mountedKeyRef.current === key) return;
    mountedKeyRef.current = key;
    if (terrainRendererOf(layerRef.current)) resampleAll();
  }, [key, resampleAll]);

  /** Mark a record as saved, so the window can offer "View attributes". */
  const markSaved = useCallback((id: string, savedLayerId: string | null) => {
    patchProfile(id, { savedLayerId });
  }, [patchProfile]);

  // --- active-line styling + hover marker -----------------------------------

  useEffect(() => {
    profilesRef.current.forEach(record => {
      if (record.feature?.set) {
        record.feature.set(PROFILE_ACTIVE_PROPERTY, record.id === activeId, true);
      }
    });
    const olLayer = layerOlRef.current;
    if (olLayer?.changed) olLayer.changed();
  }, [activeId, profiles]);

  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    const record = profilesRef.current.find(p => p.id === activeId) ?? null;
    if (hoverDistance === null || !record || !record.stats) {
      if (hoverFeatureRef.current) {
        source.removeFeature(hoverFeatureRef.current);
        hoverFeatureRef.current = null;
      }
      return;
    }
    const at = coordinateAtDistance(record.coords, hoverDistance);
    if (!at) return;
    if (!hoverFeatureRef.current) {
      const feature = new Feature({ geometry: new Point(at) });
      feature.set(PROFILE_HOVER_PROPERTY, true, true);
      source.addFeature(feature);
      hoverFeatureRef.current = feature;
      return;
    }
    (hoverFeatureRef.current.getGeometry() as Point)?.setCoordinates(at);
  }, [hoverDistance, activeId, profiles]);

  return {
    profiles,
    activeId,
    activeProfile,
    penArmed,
    togglePen,
    disarmPen,
    selectProfile,
    removeProfile,
    clearProfiles,
    resampleAll,
    markSaved,
    hoverDistance,
    setHoverDistance,
  };
}
