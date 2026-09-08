/**
 * useScissorsTool — the scissors (split) tool.
 *
 * When active, the user clicks to place vertices of a dashed cut line on the
 * map. Pressing Enter or double-clicking finishes the cut line. The tool then
 * finds all features in the active editing source (draw batch or re-edit
 * layer) that intersect the cut line and splits them along it.
 *
 * - LineString features are split into two or more LineStrings at the
 *   intersection points.
 * - Polygon features are split into two Polygons along the cut line.
 *
 * The tool pushes an undo snapshot before performing the split so the
 * operation can be undone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import { Style, Stroke, Fill, Circle as CircleStyle } from 'ol/style.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import { DrawToolId } from '../types';
import { generateId } from '../constants';
import { splitFeatureWithLine } from '../utils/scissorsSplit';
import { applyDrawFeatureStyle } from '../utils/drawHelpers';
import { getLayerRawSource } from '../utils/vectorStyleHelpers';
import { UnitsSystem } from '../types';

export interface ScissorsToolDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  /** The map's DoubleClickZoom interaction — disabled while scissors is active. */
  doubleClickZoomRef: React.MutableRefObject<any>;
  /** Currently active tool (render-state copy for reactive effects). */
  activeDrawTool: DrawToolId;
  /** Mirror of activeDrawTool for OL event callbacks. */
  activeDrawToolRef: React.MutableRefObject<DrawToolId>;
  /** The draw session's source (for drawn features). */
  drawSourceRef: React.MutableRefObject<VectorSource | null>;
  /** The draw session's style ref (for styling new split features). */
  drawStyleRef: React.MutableRefObject<any>;
  /** Whether we're in a saved-layer re-edit session. */
  editingVectorLayerIdRef: React.MutableRefObject<string | null>;
  /** Vector layers registry (for re-edit mode). */
  vectorLayersRef: React.MutableRefObject<Map<string, any>>;
  /** Units system for measurement labels. */
  unitsRef: React.MutableRefObject<UnitsSystem>;
  /** Push an undo snapshot before the split. */
  pushHistorySnapshot: (extraFeature?: any) => void;
  /** Update the drawn-features list after a split. */
  setDrawnFeatures: React.Dispatch<React.SetStateAction<any[]>>;
  /** Bump the measure tick to refresh measurement labels. */
  bumpMeasureTick: () => void;
  /** Show a toast message. */
  showToast: (message: string, kind?: 'success' | 'error') => void;
}

// --- Styles for the cut-line preview --------------------------------------

const cutLineStyle = new Style({
  stroke: new Stroke({
    color: 'rgba(231, 76, 60, 0.9)',
    width: 2.5,
    lineDash: [8, 6],
  }),
});

const cutVertexStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: new Fill({ color: 'rgba(231, 76, 60, 1)' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
});

export function useScissorsTool(deps: ScissorsToolDeps) {
  const {
    mapRef, doubleClickZoomRef, activeDrawTool, activeDrawToolRef,
    drawSourceRef, drawStyleRef, editingVectorLayerIdRef, vectorLayersRef,
    unitsRef, pushHistorySnapshot, setDrawnFeatures, bumpMeasureTick, showToast,
  } = deps;

  const isActive = activeDrawTool === 'scissors';
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Cut-line state: vertices placed so far (map coordinates).
  const cutCoordsRef = useRef<[number, number][]>([]);
  const [cutVertexCount, setCutVertexCount] = useState(0);

  // Preview layer for the cut line.
  const previewSourceRef = useRef<VectorSource | null>(null);
  const previewLayerRef = useRef<VectorLayer<any> | null>(null);

  // --- Preview layer setup --------------------------------------------------

  const ensurePreviewLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (previewLayerRef.current) return;

    const source = new VectorSource();
    const layer = new VectorLayer({
      source,
      style: (feature: any) => {
        const geom = feature.getGeometry();
        if (!geom) return [cutLineStyle];
        const type = geom.getType();
        if (type === 'Point') return [cutVertexStyle];
        return [cutLineStyle];
      },
      zIndex: 9999,
    });
    (layer as any)._scissorsPreview = true;
    map.addLayer(layer);
    previewSourceRef.current = source;
    previewLayerRef.current = layer;
  }, [mapRef]);

  const removePreviewLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (previewLayerRef.current) {
      map.removeLayer(previewLayerRef.current);
      previewLayerRef.current = null;
      previewSourceRef.current = null;
    }
  }, [mapRef]);

  const clearCutLine = useCallback(() => {
    cutCoordsRef.current = [];
    setCutVertexCount(0);
    if (previewSourceRef.current) {
      previewSourceRef.current.clear();
    }
  }, []);

  // --- Update the preview ---------------------------------------------------

  const updatePreview = useCallback(() => {
    const source = previewSourceRef.current;
    if (!source) return;
    source.clear();

    const coords = cutCoordsRef.current;
    if (coords.length === 0) return;

    // Draw the cut line.
    if (coords.length >= 2) {
      const line = new LineString(coords);
      const feat = new Feature(line);
      source.addFeature(feat);
    }

    // Draw vertices as points.
    for (const c of coords) {
      const ptFeat = new Feature(new Point(c));
      source.addFeature(ptFeat);
    }
  }, []);

  // --- Activate / deactivate ------------------------------------------------

  useEffect(() => {
    if (!isActive) {
      removePreviewLayer();
      clearCutLine();
      // Re-enable double-click zoom.
      const dcZoom = doubleClickZoomRef.current;
      if (dcZoom && !dcZoom.getActive()) {
        dcZoom.setActive(true);
      }
      return;
    }

    ensurePreviewLayer();
    clearCutLine();

    // Disable double-click zoom so double-click finishes the cut instead of zooming.
    const dcZoom = doubleClickZoomRef.current;
    if (dcZoom) {
      dcZoom.setActive(false);
    }

    return () => {
      removePreviewLayer();
      clearCutLine();
      if (dcZoom) dcZoom.setActive(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // --- Map click handler ----------------------------------------------------

  useEffect(() => {
    if (!isActive) return;
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (evt: any) => {
      if (!isActiveRef.current) return;
      const coord = map.getCoordinateFromPixel(evt.pixel) as [number, number];
      if (!coord) return;

      cutCoordsRef.current.push(coord);
      setCutVertexCount(cutCoordsRef.current.length);
      updatePreview();
    };

    const clickKey = map.on('click', handleClick);

    return () => {
      if (clickKey && typeof (clickKey as any).unref === 'function') {
        (clickKey as any).unref();
      }
    };
  }, [isActive, mapRef, updatePreview]);

  // --- Pointer move: live preview of the next segment -----------------------

  useEffect(() => {
    if (!isActive) return;
    const map = mapRef.current;
    if (!map) return;

    let liveFeature: Feature | null = null;

    const handleMove = (evt: any) => {
      if (!isActiveRef.current) return;
      const source = previewSourceRef.current;
      if (!source) return;

      const coords = cutCoordsRef.current;
      if (coords.length === 0) return;

      const coord = map.getCoordinateFromPixel(evt.pixel) as [number, number];
      if (!coord) return;

      // Remove old live preview.
      if (liveFeature) {
        source.removeFeature(liveFeature);
        liveFeature = null;
      }

      // Draw a dashed line from the last vertex to the cursor.
      const lastPt = coords[coords.length - 1];
      const line = new LineString([lastPt, coord]);
      liveFeature = new Feature(line);
      source.addFeature(liveFeature);
    };

    const key = map.on('pointermove', handleMove);

    return () => {
      if (liveFeature && previewSourceRef.current) {
        previewSourceRef.current.removeFeature(liveFeature);
      }
      if (key && typeof (key as any).unref === 'function') {
        (key as any).unref();
      }
    };
  }, [isActive, mapRef]);

  // --- Finish the cut (Enter or double-click) -------------------------------

  const finishCut = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const coords = cutCoordsRef.current;
    if (coords.length < 2) {
      // Not enough vertices — just clear and stay active.
      clearCutLine();
      return;
    }

    // Get the active editing source.
    const inReedit = editingVectorLayerIdRef.current !== null;
    const targetSource = inReedit
      ? (getLayerRawSource(vectorLayersRef.current, editingVectorLayerIdRef.current as string) || drawSourceRef.current)
      : drawSourceRef.current;
    if (!targetSource) {
      clearCutLine();
      return;
    }

    // Find all features that intersect the cut line.
    const features = targetSource.getFeatures() as any[];
    const cutLine = new LineString(coords);
    const cutExtent = cutLine.getExtent();

    let splitCount = 0;
    const featuresToRemove: any[] = [];
    const featuresToAdd: Array<{ geom: any; original: any }> = [];

    for (const feat of features) {
      const geom = feat.getGeometry();
      if (!geom) continue;
      const type = geom.getType();
      if (type !== 'LineString' && type !== 'Polygon') continue;

      // Quick extent check.
      const featExtent = geom.getExtent();
      if (featExtent[0] > cutExtent[2] || featExtent[2] < cutExtent[0] ||
          featExtent[1] > cutExtent[3] || featExtent[3] < cutExtent[1]) {
        continue;
      }

      // Try to split.
      const result = splitFeatureWithLine(geom, coords);
      if (result.kind !== 'none' && result.geometries.length >= 2) {
        featuresToRemove.push(feat);
        for (const newGeom of result.geometries) {
          featuresToAdd.push({ geom: newGeom, original: feat });
        }
        splitCount++;
      }
    }

    if (splitCount === 0) {
      showToast('No features intersect the cut line', 'error');
      clearCutLine();
      return;
    }

    // Push history snapshot before modifying.
    pushHistorySnapshot();

    // Perform the split: remove originals, add new parts.
    for (const feat of featuresToRemove) {
      targetSource.removeFeature(feat);
    }

    for (const { geom, original } of featuresToAdd) {
      const newFeat = new Feature(geom);
      // Copy attributes from the original.
      const props = original.getProperties();
      for (const key of Object.keys(props)) {
        if (key === 'geometry') continue;
        newFeat.set(key, props[key]);
      }
      // Assign a new feature ID.
      const newId = generateId(6);
      (newFeat as any)._drawFeatureId = newId;
      // Apply the current draw style.
      applyDrawFeatureStyle(newFeat, drawStyleRef.current, () => unitsRef.current);
      // Generate a name.
      const type = geom.getType();
      const existingCount = targetSource.getFeatures().filter((f: any) => {
        const g = f.getGeometry();
        return g && g.getType() === type;
      }).length;
      const name = type === 'LineString' ? `Line ${existingCount + 1}` : `Polygon ${existingCount + 1}`;
      (newFeat as any)._drawName = name;

      targetSource.addFeature(newFeat);

      // Update the drawn-features list if not in re-edit mode.
      if (!inReedit) {
        const origId = (original as any)._drawFeatureId;
        setDrawnFeatures(prev => {
          // Remove the original entry.
          const filtered = prev.filter(item => item.id !== origId);
          // Add the new parts.
          return [...filtered, {
            id: newId,
            type: type === 'Polygon' ? 'Polygon' : 'LineString',
            name,
            feature: newFeat,
            style: { ...drawStyleRef.current },
            customized: false,
          }];
        });
      }
    }

    bumpMeasureTick();
    showToast(`Split ${splitCount} feature${splitCount > 1 ? 's' : ''} into ${featuresToAdd.length} parts`, 'success');
    clearCutLine();
  }, [
    mapRef, drawSourceRef, drawStyleRef, editingVectorLayerIdRef, vectorLayersRef,
    unitsRef, pushHistorySnapshot, setDrawnFeatures, bumpMeasureTick, showToast, clearCutLine,
  ]);

  // --- Keyboard handler (Enter to finish, Escape to cancel) -----------------

  useEffect(() => {
    if (!isActive) return;

    const handleKey = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        finishCut();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearCutLine();
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isActive, finishCut, clearCutLine]);

  // --- Double-click handler (finish the cut) --------------------------------

  useEffect(() => {
    if (!isActive) return;
    const map = mapRef.current;
    if (!map) return;

    const handleDblClick = (evt: any) => {
      if (!isActiveRef.current) return;
      evt.preventDefault();
      evt.stopPropagation();
      finishCut();
    };

    const key = map.on('dblclick', handleDblClick);

    return () => {
      if (key && typeof (key as any).unref === 'function') {
        (key as any).unref();
      }
    };
  }, [isActive, mapRef, finishCut]);

  return {
    isActive,
    cutVertexCount,
    finishCut,
    cancelCut: clearCutLine,
  };
}
