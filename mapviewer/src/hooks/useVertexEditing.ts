/**
 * useVertexEditing — the click-to-pick-up vertex editing state machine and
 * the Modify/Translate interaction pairs behind it, shared by the draw
 * toolbar's edit tool and saved-layer re-edit sessions.
 *
 * Extracted verbatim in behavior from MapPage.tsx. Every function here is
 * registered once against OL (or called from handlers that were), so all
 * state access goes through refs — never through captured render state.
 */
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
  const createEditInteractions = (source: VectorSource, layers: any[], getAccent: () => string) => {
    const map = mapRef.current;
    const modifyInteraction = new Modify({
      source: source,
      pixelTolerance: 12,
      insertVertexCondition: () => false,
      style: () => buildModifyVertexStyle(getAccent()),
    });

    // Refresh panel readouts once each edit settles and record the edit as a
    // history step.
    modifyInteraction.on('modifyend', () => {
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
    translateInteraction.on('translateend', () => {
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
