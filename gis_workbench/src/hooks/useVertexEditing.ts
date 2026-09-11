/**
 * useVertexEditing — the click-to-pick-up vertex editing state machine and
 * the Modify/Translate interaction pairs behind it, shared by the draw
 * toolbar's edit tool and saved-layer re-edit sessions.
 *
 * Extracted verbatim in behavior from MapPage.tsx. Every function here is
 * registered once against OL (or called from handlers that were), so all
 * state access goes through refs — never through captured render state.
 */
import { transform } from 'ol/proj.js';
import { useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import Modify from 'ol/interaction/Modify.js';
import Translate from 'ol/interaction/Translate.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { primaryAction } from 'ol/events/condition.js';
import { DrawToolId, LabelDialogState, VertexHit } from '../types';
import {
  buildModifyVertexStyle,
  buildEditMarkerStyles,
  findNearestVertex,
  findNearestSegment,
  insertVertexInGeom,
  removeVertexFromGeom,
  setVertexCoordinate,
} from '../utils/drawHelpers';
import {
  CIRCLE_DRAW_SEGMENTS,
  geometricCircleRing,
  geodesicCircleRing,
  geodesicCircleRingFromRadius,
} from '../utils/circleDraw';
import { greatCircleDistance } from '../utils/geodesic';
import { getLayerRawSource } from '../utils/vectorStyleHelpers';

export interface VertexEditingDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  drawSourceRef: React.MutableRefObject<VectorSource | null>;
  drawLayerRef: React.MutableRefObject<VectorLayer<any> | null>;
  vectorLayersRef: React.MutableRefObject<Map<string, any>>;
  activeDrawToolRef: React.MutableRefObject<DrawToolId>;
  editingVectorLayerIdRef: React.MutableRefObject<string | null>;
  /** Accent colour for vertex handles / the picked-up marker. */
  editAccentRef: React.MutableRefObject<string>;
  /** Draw style (handles of the draw-toolbar edit tool follow its line colour live). */
  drawStyleRef: React.MutableRefObject<import('../types').DrawStyle>;
  pushHistorySnapshot: (extraFeature?: any) => void;
  bumpMeasureTick: () => void;
  openLabelDialog: (state: LabelDialogState) => void;
  /** Drop a deleted label feature from the drawn-features list (draw edit). */
  onDiscardDrawnFeature: (feature: any) => void;
}

export function useVertexEditing(deps: VertexEditingDeps) {
  const {
    mapRef, drawSourceRef, drawLayerRef, vectorLayersRef,
    activeDrawToolRef, editingVectorLayerIdRef, editAccentRef, drawStyleRef,
    pushHistorySnapshot, bumpMeasureTick, openLabelDialog, onDiscardDrawnFeature,
  } = deps;

  const [stickyVertex, setStickyVertex] = useState<VertexHit | null>(null);
  const stickyVertexRef = useRef<VertexHit | null>(null);
  const modifyInteractionRef = useRef<Modify | null>(null);
  const drawTranslateRef = useRef<Translate | null>(null);
  const layerModifyInteractionRef = useRef<Modify | null>(null);
  const layerTranslateRef = useRef<Translate | null>(null);
  const editMarkerSourceRef = useRef<VectorSource | null>(null);
  const editMarkerFeatureRef = useRef<any>(null);

  const setEditInteractionsActive = (active: boolean) => {
    [modifyInteractionRef.current, drawTranslateRef.current, layerModifyInteractionRef.current, layerTranslateRef.current].forEach((interaction) => {
      if (interaction) interaction.setActive(active);
    });
  };

  const exitStickyVertex = () => {
    stickyVertexRef.current = null;
    setStickyVertex(null);
    editMarkerFeatureRef.current = null;
    if (editMarkerSourceRef.current) editMarkerSourceRef.current.clear();
    setEditInteractionsActive(true);
    if (mapRef.current) {
      (mapRef.current.getTargetElement() as HTMLElement).style.cursor = '';
    }
  };

  const enterStickyVertex = (hit: VertexHit) => {
    const sticky: VertexHit = { feature: hit.feature, geom: hit.geom, indexPath: hit.indexPath.slice(), coord: hit.coord.slice() };
    stickyVertexRef.current = sticky;
    setStickyVertex(sticky);
    // Modify/Translate stand aside while a vertex is airborne so the
    // placement click is not mistaken for a new drag.
    setEditInteractionsActive(false);

    if (editMarkerSourceRef.current) {
      const marker = new Feature(new Point(hit.coord.slice()));
      marker.setStyle(buildEditMarkerStyles(editAccentRef.current));
      editMarkerSourceRef.current.clear();
      editMarkerSourceRef.current.addFeature(marker);
      editMarkerFeatureRef.current = marker;
    }
    if (mapRef.current) {
      (mapRef.current.getTargetElement() as HTMLElement).style.cursor = 'grabbing';
    }
  };

  // The next click drops the vertex where the pointer already is.
  const commitStickyVertex = () => {
    const sticky = stickyVertexRef.current;
    if (sticky && sticky.feature._circleMode) {
      // For circles, rebuild the entire ring from center to the new vertex
      // position instead of just moving one vertex.
      const feature = sticky.feature;
      const geom = sticky.geom;
      if (geom.getType() === 'Polygon') {
        const isDrawEdit = activeDrawToolRef.current === 'modify';
        const reeditId = editingVectorLayerIdRef.current;
        const source = isDrawEdit
          ? drawSourceRef.current
          : (reeditId !== null ? getLayerRawSource(vectorLayersRef.current, reeditId) : null);
        
        if (source) {
          const circleId = feature._drawFeatureId;
          const all = source.getFeatures() as any[];
          const centerFeature = all.find((p: any) => p._circleCenterOf === circleId);
          
          if (centerFeature) {
            const centerGeom = centerFeature.getGeometry();
            if (centerGeom && centerGeom.getType() === 'Point') {
              const center = centerGeom.getCoordinates();
              // The vertex was just placed at sticky.coord by the click handler
              const newVertex = sticky.coord;
              
              // Rebuild the circle with the new radius
              const newRing = feature._circleMode === 'geodesic'
                ? geodesicCircleRing(center, newVertex, 'EPSG:3857', CIRCLE_DRAW_SEGMENTS)
                : geometricCircleRing(center, newVertex, CIRCLE_DRAW_SEGMENTS);
              
              geom.setCoordinates([newRing]);
            }
          }
        }
      }
    }
    
    exitStickyVertex();
    pushHistorySnapshot(); // routes to the active session; dedupe skips no-ops
    bumpMeasureTick();
  };

  // Escape puts the vertex back where it was picked up.
  const cancelStickyVertex = () => {
    const sticky = stickyVertexRef.current;
    if (!sticky) return;
    setVertexCoordinate(sticky.geom, sticky.indexPath, sticky.coord);
    exitStickyVertex();
    pushHistorySnapshot(); // routes to the active session; dedupe skips no-ops
    bumpMeasureTick();
  };

  // Delete removes the picked-up vertex — or the whole feature when the
  // vertex *is* the feature (labels).
  const deleteStickyTarget = () => {
    const sticky = stickyVertexRef.current;
    if (!sticky) return;
    const { feature, geom, indexPath } = sticky;

    if (geom.getType && geom.getType() === 'Point') {
      const isDrawEdit = activeDrawToolRef.current === 'modify';
      const reeditId = editingVectorLayerIdRef.current;
      const source = isDrawEdit
        ? drawSourceRef.current
        : (reeditId !== null ? getLayerRawSource(vectorLayersRef.current, reeditId) : null);
      if (source) source.removeFeature(feature);
      if (isDrawEdit) {
        onDiscardDrawnFeature(feature);
      }
      exitStickyVertex();
      pushHistorySnapshot();
      bumpMeasureTick();
      return;
    }

    if (removeVertexFromGeom(geom, indexPath)) {
      exitStickyVertex();
      pushHistorySnapshot();
      bumpMeasureTick();
    }
    // At the minimum vertex count the vertex simply stays picked up.
  };

  const handleEditClick = (evt: any) => {
    const map = mapRef.current;
    if (!map) return;
    const activeTool = activeDrawToolRef.current;
    // Drawing tools own their clicks, even during a re-edit session.
    if (activeTool !== null && activeTool !== 'modify') return;
    const isDrawEdit = activeTool === 'modify';
    const reeditId = editingVectorLayerIdRef.current;
    if (!isDrawEdit && reeditId === null) return;

    // A picked-up vertex is placed by the next click.
    if (stickyVertexRef.current) {
      commitStickyVertex();
      return;
    }

    // Alt+click stays owned by the Modify interaction (vertex removal).
    if (evt.originalEvent && evt.originalEvent.altKey) return;

    const source = isDrawEdit
      ? drawSourceRef.current
      : getLayerRawSource(vectorLayersRef.current, reeditId as string);
    if (!source) return;

    const vertex = findNearestVertex(map, source, evt.pixel as number[], 12);
    if (vertex) {
      enterStickyVertex(vertex);
      return;
    }

    const segment = findNearestSegment(map, source, evt.pixel as number[], 10);
    if (segment) {
      insertVertexInGeom(segment);
      // Pick the fresh vertex up immediately — the next click places it.
      const indexPath = segment.ringIndex === -1 ? [segment.index + 1] : [segment.ringIndex, segment.index + 1];
      enterStickyVertex({ feature: segment.feature, geom: segment.geom, indexPath, coord: segment.coord.slice() });
      bumpMeasureTick();
    }
  };

  // Double-clicking a label while editing reopens the text dialog with the
  // current text. The two vertex-clicks that precede the double click pick
  // the point up and put it straight back down, so the label stays exactly
  // where it was.
  const handleEditDoubleClick = (evt: any) => {
    const map = mapRef.current;
    if (!map) return;
    const activeTool = activeDrawToolRef.current;
    // Drawing tools own their clicks, even during a re-edit session.
    if (activeTool !== null && activeTool !== 'modify') return;
    const isDrawEdit = activeTool === 'modify';
    const reeditId = editingVectorLayerIdRef.current;
    if (!isDrawEdit && reeditId === null) return;

    const source = isDrawEdit
      ? drawSourceRef.current
      : getLayerRawSource(vectorLayersRef.current, reeditId as string);
    if (!source) return;

    // The label's point vertex and its rendered text (which floats above
    // the point) both count as "the label".
    let labelFeature: any = null;
    const vertex = findNearestVertex(map, source, evt.pixel as number[], 12);
    if (vertex && vertex.geom.getType() === 'Point' && vertex.feature.get('labelText') !== undefined) {
      labelFeature = vertex.feature;
    } else {
      const editLayer = isDrawEdit ? drawLayerRef.current : vectorLayersRef.current.get(reeditId as string);
      map.forEachFeatureAtPixel(evt.pixel, (f: any, layer: any) => {
        if (!labelFeature && layer === editLayer && f.get && f.get('labelText') !== undefined) {
          labelFeature = f;
        }
      }, { hitTolerance: 6 });
    }
    if (!labelFeature) return;

    openLabelDialog({
      pixel: map.getPixelFromCoordinate(labelFeature.getGeometry().getCoordinates()) as [number, number],
      feature: labelFeature,
      featureId: '',
      existingText: String(labelFeature.get('labelText') ?? ''),
    });
  };

  // Suspend/resume the saved-layer Modify+Translate pair while a drawing
  // tool owns the gestures during a re-edit session.
  const setLayerInteractionsActive = (active: boolean) => {
    if (layerModifyInteractionRef.current) layerModifyInteractionRef.current.setActive(active);
    if (layerTranslateRef.current) layerTranslateRef.current.setActive(active);
  };

  /**
   * Shared Modify+Translate builder. Vertices drag to new positions; drags
   * elsewhere move the whole feature. Segment clicks stay owned by
   * handleEditClick (insert + pick up). Handles follow the accent colour.
   */
  // OL's Modify re-queries and sorts every vertex node inside the pixel
  // tolerance box on each pointermove. Zoomed out on a large imported layer
  // that box spans tens of kilometres and the hover handling alone stalls
  // the pointer (~70ms/move on the 16k-polygon sample). Cap the *hover* box
  // in map units — vertex handles are indistinguishable at such zooms anyway
  // — while pointerdown keeps the full pixel tolerance for grabbing.
  const MAX_HOVER_BOX_MAP_UNITS = 250;
  const capModifyHoverBox = (modifyInteraction: Modify) => {
    const self = modifyInteraction as any;
    const originalMove = self.handlePointerMove_.bind(self);
    self.handlePointerMove_ = (evt: any) => {
      const res = evt.map && evt.map.getView ? evt.map.getView().getResolution() : 0;
      if (res > 0 && self.pixelTolerance_ * res > MAX_HOVER_BOX_MAP_UNITS) {
        const full = self.pixelTolerance_;
        self.pixelTolerance_ = MAX_HOVER_BOX_MAP_UNITS / res;
        try {
          originalMove(evt);
        } finally {
          self.pixelTolerance_ = full;
        }
        return;
      }
      originalMove(evt);
    };
  };

  const createEditInteractions = (source: VectorSource, layers: any[], getAccent: () => string) => {
    const map = mapRef.current;
    const modifyInteraction = new Modify({
      source: source,
      pixelTolerance: 12,
      insertVertexCondition: () => false,
      style: () => buildModifyVertexStyle(getAccent()),
    });
    capModifyHoverBox(modifyInteraction);

    // Refresh panel readouts once each edit settles and record the edit as a
    // history step. For circles, rebuild the entire ring from the center to
    // the moved vertex so the circle resizes instead of deforming.
    modifyInteraction.on('modifyend', (evt) => {
      const features = evt.features ? evt.features.getArray() : [];
      features.forEach((f: any) => {
        if (!f._circleMode) return;
        const geom = f.getGeometry();
        if (!geom || geom.getType() !== 'Polygon') return;
        
        // Find the paired center point
        const circleId = f._drawFeatureId;
        const all = source.getFeatures() as any[];
        const centerFeature = all.find((p: any) => p._circleCenterOf === circleId);
        if (!centerFeature) return;
        
        const centerGeom = centerFeature.getGeometry();
        if (!centerGeom || centerGeom.getType() !== 'Point') return;
        
        const center = centerGeom.getCoordinates();
        const ring = geom.getCoordinates()[0];
        
        // Find the vertex that was moved: the one whose distance from the center
        // differs most from the median distance (the moved vertex is the outlier).
        // Exclude the closing duplicate (last vertex = first vertex).
        const uniqueRing = ring.slice(0, -1);
        const distances = uniqueRing.map((v: number[]) => 
          Math.hypot(v[0] - center[0], v[1] - center[1])
        );
        const sorted = [...distances].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        
        // Find the vertex with the largest deviation from the median
        let maxDeviation = 0;
        let movedVertex = uniqueRing[0];
        distances.forEach((d: number, i: number) => {
          const deviation = Math.abs(d - median);
          if (deviation > maxDeviation) {
            maxDeviation = deviation;
            movedVertex = uniqueRing[i];
          }
        });
        
        // Rebuild the circle with the new radius (from center to the moved vertex)
        const newRing = f._circleMode === 'geodesic'
          ? geodesicCircleRing(center, movedVertex, 'EPSG:3857', CIRCLE_DRAW_SEGMENTS)
          : geometricCircleRing(center, movedVertex, CIRCLE_DRAW_SEGMENTS);
        
        geom.setCoordinates([newRing]);
      });
      
      pushHistorySnapshot();
      bumpMeasureTick();
    });

    const translateInteraction = new Translate({
      layers: layers,
      hitTolerance: 6,
      condition: (evt) =>
        primaryAction(evt) &&
        !stickyVertexRef.current &&
        !findNearestVertex(map as OLMap, source, evt.pixel as number[], 12),
    });
    translateInteraction.on('translatestart', (evt) => {
      // For geodesic circles, capture the ground radius and starting center position
      // before translation starts. The radius stays constant during the drag, but the
      // projected shape changes with latitude because Web Mercator distorts distances.
      const translated = evt.features ? evt.features.getArray() : [];
      translated.forEach((f: any) => {
        if (f._circleMode !== 'geodesic') return;
        const geom = f.getGeometry();
        if (!geom || geom.getType() !== 'Polygon') return;
        const ring = geom.getCoordinates()[0];
        if (!ring || ring.length < 2) return;
        // Compute ground radius from center to first vertex
        const circleId = f._drawFeatureId;
        const all = source.getFeatures() as any[];
        const centerFeature = all.find((p: any) => p._circleCenterOf === circleId);
        if (!centerFeature) return;
        const centerGeom = centerFeature.getGeometry();
        if (!centerGeom || centerGeom.getType() !== 'Point') return;
        const center = centerGeom.getCoordinates();
        const vertex = ring[0];
        const center4326 = transform(center, 'EPSG:3857', 'EPSG:4326');
        const vertex4326 = transform(vertex, 'EPSG:3857', 'EPSG:4326');
        const radius = greatCircleDistance(center4326 as [number, number], vertex4326 as [number, number]);
        // Store the radius and starting center position for use during translation
        f._geodesicRadius = radius;
        f._geodesicStartCenter = center.slice();
      });
    });

    translateInteraction.on('translating', (evt) => {
      // For geodesic circles, rebuild the ring at the current center position
      // with the stored ground radius. This provides live visual feedback during
      // the drag, showing how the shape changes with latitude.
      const delta = [
        evt.coordinate[0] - evt.startCoordinate[0],
        evt.coordinate[1] - evt.startCoordinate[1],
      ];
      const translated = evt.features ? evt.features.getArray() : [];
      const seen = new Set<any>();
      translated.forEach((f: any) => {
        if (seen.has(f)) return;
        seen.add(f);
        if (f._circleMode !== 'geodesic') return;
        const geom = f.getGeometry();
        if (!geom || geom.getType() !== 'Polygon') return;
        const radius = f._geodesicRadius;
        const startCenter = f._geodesicStartCenter;
        if (!radius || !startCenter) return;
        // Compute the current center position by applying the drag delta
        const currentCenter = [startCenter[0] + delta[0], startCenter[1] + delta[1]];
        // Rebuild the ring at the current center with the stored ground radius
        const newRing = geodesicCircleRingFromRadius(currentCenter, radius, 'EPSG:3857', CIRCLE_DRAW_SEGMENTS);
        geom.setCoordinates([newRing]);
      });
    });

    translateInteraction.on('translateend', (evt) => {
      // A circle and its centre point move together: when one is dragged,
      // the other follows by the same delta. The delta is the drag vector
      // (coordinate - startCoordinate), which OL has already applied to the
      // translated features — we just mirror it onto the pair.
      const delta = [
        evt.coordinate[0] - evt.startCoordinate[0],
        evt.coordinate[1] - evt.startCoordinate[1],
      ];
      if (Math.abs(delta[0]) > 1e-9 || Math.abs(delta[1]) > 1e-9) {
        const translated = evt.features ? evt.features.getArray() : [];
        const seen = new Set<any>();
        translated.forEach((f: any) => {
          if (seen.has(f)) return;
          seen.add(f);
          const circleId = f._drawFeatureId;
          const circleCenterOf = f._circleCenterOf;
          // Find the pair in the source.
          const all = source.getFeatures() as any[];
          let pair: any = null;
          if (f._circleMode) {
            // f is a circle — find its centre point.
            pair = all.find((p: any) => p._circleCenterOf === circleId);
          } else if (circleCenterOf) {
            // f is a centre point — find its circle.
            pair = all.find((p: any) => p._drawFeatureId === circleCenterOf);
          }
          if (pair) {
            const geom = pair.getGeometry();
            if (geom && geom.getType) {
              const type = geom.getType();
              if (type === 'Point') {
                const coords = geom.getCoordinates();
                geom.setCoordinates([coords[0] + delta[0], coords[1] + delta[1]]);
              } else if (type === 'Polygon') {
                // For geodesic circles, the ring was already rebuilt by the
                // translating handler. Just move it by the delta.
                if (pair._circleMode === 'geodesic') {
                  const rings = geom.getCoordinates();
                  const moved = rings.map((ring: number[][]) =>
                    ring.map((c: number[]) => [c[0] + delta[0], c[1] + delta[1]])
                  );
                  geom.setCoordinates(moved);
                } else {
                  const rings = geom.getCoordinates();
                  const moved = rings.map((ring: number[][]) =>
                    ring.map((c: number[]) => [c[0] + delta[0], c[1] + delta[1]])
                  );
                  geom.setCoordinates(moved);
                }
              } else if (type === 'LineString') {
                const coords = geom.getCoordinates();
                geom.setCoordinates(coords.map((c: number[]) => [c[0] + delta[0], c[1] + delta[1]]));
              }
            }
          }
        });
      }
      // For geodesic circles, rebuild the ring at the final center position
      // to ensure it's correct (in case the translating handler didn't fire)
      const translated = evt.features ? evt.features.getArray() : [];
      translated.forEach((f: any) => {
        if (f._circleMode !== 'geodesic') return;
        const geom = f.getGeometry();
        if (!geom || geom.getType() !== 'Polygon') return;
        const circleId = f._drawFeatureId;
        const all = source.getFeatures() as any[];
        const centerFeature = all.find((p: any) => p._circleCenterOf === circleId);
        if (!centerFeature) return;
        const centerGeom = centerFeature.getGeometry();
        if (!centerGeom || centerGeom.getType() !== 'Point') return;
        const newCenter = centerGeom.getCoordinates();
        const radius = f._geodesicRadius;
        if (radius) {
          const newRing = geodesicCircleRingFromRadius(newCenter, radius, 'EPSG:3857', CIRCLE_DRAW_SEGMENTS);
          geom.setCoordinates([newRing]);
          // Clean up the stored radius and start center
          delete f._geodesicRadius;
          delete f._geodesicStartCenter;
        }
      });
      pushHistorySnapshot();
      bumpMeasureTick();
    });


    if (map) {
      map.addInteraction(modifyInteraction);
      map.addInteraction(translateInteraction);
    }
    return { modifyInteraction, translateInteraction };
  };

  /** Draw-toolbar edit tool: reshape features in the draw source. */
  const attachDrawEditInteractions = () => {
    if (!mapRef.current || !drawSourceRef.current) return;
    const drawLayer = drawLayerRef.current;
    const { modifyInteraction, translateInteraction } = createEditInteractions(
      drawSourceRef.current,
      drawLayer ? [drawLayer as any] : [],
      // Handles follow the current draw line colour (live).
      () => drawStyleRef.current.lineColor,
    );
    modifyInteractionRef.current = modifyInteraction;
    drawTranslateRef.current = translateInteraction;
  };

  const disposeDrawEditInteractions = () => {
    if (!mapRef.current) return;
    if (modifyInteractionRef.current) {
      mapRef.current.removeInteraction(modifyInteractionRef.current);
      modifyInteractionRef.current = null;
    }
    if (drawTranslateRef.current) {
      mapRef.current.removeInteraction(drawTranslateRef.current);
      drawTranslateRef.current = null;
    }
  };

  /** Saved-layer re-edit: reshape features of the layer being edited. */
  const attachLayerEditInteractions = (olLayer: any, source: VectorSource) => {
    const { modifyInteraction, translateInteraction } = createEditInteractions(
      source,
      [olLayer],
      // Reads the ref so a restyle via Apply recolours the handles live.
      () => editAccentRef.current,
    );
    layerModifyInteractionRef.current = modifyInteraction;
    layerTranslateRef.current = translateInteraction;
  };

  const disposeLayerEditInteractions = () => {
    if (!mapRef.current) return;
    if (layerModifyInteractionRef.current) {
      mapRef.current.removeInteraction(layerModifyInteractionRef.current);
      layerModifyInteractionRef.current = null;
    }
    if (layerTranslateRef.current) {
      mapRef.current.removeInteraction(layerTranslateRef.current);
      layerTranslateRef.current = null;
    }
  };

  return {
    stickyVertex,
    stickyVertexRef,
    editMarkerSourceRef,
    editMarkerFeatureRef,
    modifyInteractionRef,
    drawTranslateRef,
    layerModifyInteractionRef,
    layerTranslateRef,
    enterStickyVertex,
    exitStickyVertex,
    commitStickyVertex,
    cancelStickyVertex,
    deleteStickyTarget,
    handleEditClick,
    handleEditDoubleClick,
    setEditInteractionsActive,
    setLayerInteractionsActive,
    attachDrawEditInteractions,
    disposeDrawEditInteractions,
    attachLayerEditInteractions,
    disposeLayerEditInteractions,
  };
}
