/**
 * useDrawSession — the draw-toolbar session: tools, drawn features, styles,
 * the label dialog, undo/redo history, session persistence and the
 * saved-layer re-edit mode. Composes useVertexEditing for the vertex-editing
 * state machine shared by the edit tool and re-edit sessions.
 *
 * Extracted verbatim in behavior from MapPage.tsx. Functions registered once
 * against OL read state through refs; functions wired to React JSX read
 * render state directly, exactly as they did in the component.
 */
import { useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import { never, noModifierKeys, shiftKeyOnly } from 'ol/events/condition.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import { Style } from 'ol/style.js';
import Feature from 'ol/Feature.js';
import {
  DrawStyle, DrawToolId, DrawnFeatureItem, LabelDialogState, RasterLayer,
  SessionSnapshot, UnitsSystem, VectorLayerConfig, DEFAULT_DRAW_STYLE,
} from '../types';
import { HISTORY_LIMIT, generateId } from '../constants';
import {
  applyDrawFeatureStyle, buildDrawFeatureStyle, captureDrawSnapshot,
  saveDrawSession, snapshotKey,
} from '../utils/drawHelpers';
import { buildMeasurementStyles } from '../utils/measurement';
import { getRandomVectorColors } from '../utils/colorHelpers';
import { buildVectorStyle, getLayerRawSource } from '../utils/vectorStyleHelpers';
import { reorderLayers } from '../utils/layerHelpers';
import { exportFeaturesToFile, VectorExportFormat } from '../utils/vectorExport';
import { useVertexEditing } from './useVertexEditing';

/**
 * Click condition for the line/polygon tools: plain clicks place vertices
 * as usual, and Shift+clicks must also be accepted so magnetic edge
 * snapping (useMagneticDraw adds a Snap interaction while Shift is held)
 * can place a vertex on the snapped position. The default `noModifierKeys`
 * would swallow Shift+clicks entirely, making it impossible to add
 * vertices while holding Shift to snap.
 */
const magneticClickCondition = (event: any) => noModifierKeys(event) || shiftKeyOnly(event);

export interface DrawSessionDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  /** The map's DoubleClickZoom interaction (assigned by the map init). */
  doubleClickZoomRef: React.MutableRefObject<any>;
  workspaceId: string;
  unitsRef: React.MutableRefObject<UnitsSystem>;
  vectorLayersRef: React.MutableRefObject<Map<string, any>>;
  vectorLayers: VectorLayerConfig[];
  rasterLayers: RasterLayer[];
  setVectorLayers: React.Dispatch<React.SetStateAction<VectorLayerConfig[]>>;
  showDrawToolbar: boolean;
}

export function useDrawSession(deps: DrawSessionDeps) {
  const {
    mapRef, doubleClickZoomRef, workspaceId, unitsRef, vectorLayersRef,
    vectorLayers, rasterLayers, setVectorLayers, showDrawToolbar,
  } = deps;

  // ----- Session state -----------------------------------------------------
  const [activeDrawTool, setActiveDrawTool] = useState<DrawToolId>(null);
  // Mirror of activeDrawTool for OL event callbacks, which are registered
  // once and can't read fresh state directly.
  const activeDrawToolRef = useRef<DrawToolId>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  // Whether the active Draw interaction has an unfinished sketch (at least
  // one vertex placed). Escape discards that sketch first and exits the
  // tool only when nothing is in progress.
  const sketchInProgressRef = useRef(false);
  const drawSourceRef = useRef<VectorSource | null>(null);
  const drawLayerRef = useRef<VectorLayer<any> | null>(null);
  const [drawStyle, setDrawStyle] = useState<DrawStyle>(DEFAULT_DRAW_STYLE);
  const drawStyleRef = useRef<DrawStyle>(DEFAULT_DRAW_STYLE);
  // Style seed for features drawn into a layer during a re-edit session.
  const reeditStyleSeedRef = useRef<DrawStyle>({ ...DEFAULT_DRAW_STYLE });
  // Accent colour for the picked-up vertex marker.
  const editAccentRef = useRef<string>(DEFAULT_DRAW_STYLE.lineColor);
  const [drawnFeatures, setDrawnFeatures] = useState<DrawnFeatureItem[]>([]);
  // Mirror of drawnFeatures for OL event callbacks, which are registered
  // once and can't read fresh state directly.
  const drawnFeaturesRef = useRef<DrawnFeatureItem[]>([]);
  const [showDrawnPanel, setShowDrawnPanel] = useState(false);
  const [labelDialogState, setLabelDialogState] = useState<LabelDialogState | null>(null);

  // ----- Undo/redo history (separate stacks for the draw batch and the
  // saved-layer re-edit session) ---------------------------------------------
  const historyRef = useRef<{ stack: Array<{ snap: SessionSnapshot; key: string }>; index: number }>({ stack: [], index: -1 });
  const layerHistoryRef = useRef<{ stack: Array<{ snap: SessionSnapshot; key: string }>; index: number }>({ stack: [], index: -1 });
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  // Bumped after every vertex edit so the drawn-features panel and layer
  // readouts refresh.
  const [measureTick, setMeasureTick] = useState(0);
  const bumpMeasureTick = () => setMeasureTick(tick => tick + 1);

  // ----- Saved-layer re-edit session ----------------------------------------
  const [editingVectorLayerId, setEditingVectorLayerId] = useState<string | null>(null);
  const editingVectorLayerIdRef = useRef<string | null>(null);

  // ----- History helpers ----------------------------------------------------

  // Which source/history the edit gestures currently belong to: the layer
  // being re-edited when a session is live, otherwise the drawing batch.
  const getActiveEditContext = () => {
    const reeditId = editingVectorLayerIdRef.current;
    if (reeditId !== null) {
      const olLayer = vectorLayersRef.current.get(reeditId);
      const source = olLayer && olLayer.getSource ? olLayer.getSource() : null;
      return { kind: 'layer' as const, source, history: layerHistoryRef };
    }
    return { kind: 'draw' as const, source: drawSourceRef.current, history: historyRef };
  };

  const syncHistoryDepth = () => {
    const h = getActiveEditContext().history.current;
    setUndoDepth(h.index + 1);
    setRedoDepth(h.stack.length - 1 - h.index);
  };

  const resetHistory = () => {
    historyRef.current = { stack: [], index: -1 };
    syncHistoryDepth();
  };

  // Record the active session's current state as the latest history step.
  // Steps identical to the one on top are skipped, and a new step drops the
  // redo tail — the usual linear-undo semantics.
  // `extraFeature` covers a stroke OpenLayers reported in drawend but hasn't
  // added to the source yet (it dispatches the event first, then inserts).
  const pushHistorySnapshot = (extraFeature?: any) => {
    const ctx = getActiveEditContext();
    if (!ctx.source) return;
    const snap = captureDrawSnapshot(ctx.source, extraFeature ? [extraFeature] : undefined);
    const key = snapshotKey(snap);
    const h = ctx.history.current;
    if (h.index >= 0 && h.stack[h.index].key === key) return;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push({ snap, key });
    if (h.stack.length > HISTORY_LIMIT) h.stack.shift();
    h.index = h.stack.length - 1;
    syncHistoryDepth();
  };

  const vertexEdit = useVertexEditing({
    mapRef, drawSourceRef, drawLayerRef, vectorLayersRef,
    activeDrawToolRef, editingVectorLayerIdRef, editAccentRef, drawStyleRef,
    pushHistorySnapshot, bumpMeasureTick,
    openLabelDialog: (state) => setLabelDialogState(state),
    onDiscardDrawnFeature: (feature) => setDrawnFeatures(prev => prev.filter(item => item.feature !== feature)),
  });
  const { stickyVertex, stickyVertexRef } = vertexEdit;

  const restoreSnapshot = (snap: SessionSnapshot) => {
    const ctx = getActiveEditContext();
    const source = ctx.source;
    if (!source) return;
    if (stickyVertexRef.current) vertexEdit.exitStickyVertex();
    // A label dialog mid-flight belongs to the timeline being left behind.
    setLabelDialogState(null);

    source.clear();
    const items = snap.items.map((si) => {
      const feature = new Feature(si.geometry.clone());
      (feature as any)._drawFeatureId = si.id;
      (feature as any)._drawName = si.name;
      (feature as any)._drawCustomized = si.customized;
      if (si.labelText !== undefined) feature.set('labelText', si.labelText);
      applyDrawFeatureStyle(feature, { ...si.style }, () => unitsRef.current);
      source.addFeature(feature);
      return {
        id: si.id,
        type: si.type,
        name: si.name,
        feature: feature,
        style: { ...si.style },
        customized: si.customized,
      };
    });
    // The drawing batch mirrors its source in state; a layer's edit menu
    // reads its source live and just needs a re-render nudge.
    if (ctx.kind === 'draw') setDrawnFeatures(items);
    bumpMeasureTick();
  };

  const handleUndo = () => {
    const h = getActiveEditContext().history.current;
    if (h.index <= 0) return;
    h.index -= 1;
    restoreSnapshot(h.stack[h.index].snap);
    syncHistoryDepth();
  };

  const handleRedo = () => {
    const h = getActiveEditContext().history.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    restoreSnapshot(h.stack[h.index].snap);
    syncHistoryDepth();
  };

  // ----- Draw tool switching -------------------------------------------------

  const handleDrawTool = (tool: DrawToolId) => {
    if (!mapRef.current || !drawSourceRef.current) return;
    const inReedit = editingVectorLayerId !== null;

    // Remove existing draw/modify interactions
    if (drawInteractionRef.current) {
      mapRef.current.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    vertexEdit.disposeDrawEditInteractions();
    // A picked-up vertex never survives a tool switch.
    if (stickyVertexRef.current) {
      vertexEdit.exitStickyVertex();
    }

    // Drop any hover cursor left behind by an edit session; the pointermove
    // handler re-applies it on the next move while editing stays active.
    (mapRef.current.getTargetElement() as HTMLElement).style.cursor = '';

    // If same tool clicked, toggle off
    if (tool === activeDrawTool) {
      setActiveDrawTool(null);
      // Back to the layer's own vertex editing, if a session is live.
      if (inReedit) vertexEdit.setLayerInteractionsActive(true);
      return;
    }

    setActiveDrawTool(tool);

    if (!tool) {
      if (inReedit) vertexEdit.setLayerInteractionsActive(true);
      return;
    }

    // During a re-edit session the edit tool *is* the layer's own vertex
    // editing — resume it rather than starting a second Modify.
    if (inReedit && tool === 'modify') {
      setActiveDrawTool(null);
      vertexEdit.setLayerInteractionsActive(true);
      return;
    }

    // While a drawing tool owns the gestures, the layer's Modify/Translate
    // stand aside (the re-edit session itself stays alive).
    if (inReedit) vertexEdit.setLayerInteractionsActive(false);

    // Edit tool — reshape features that are already drawn instead of adding
    // new ones. Vertices drag to new positions, clicking a segment inserts a
    // vertex and Alt+clicking a vertex removes it (OpenLayers Modify
    // defaults). The on-map measurement chips stay in sync automatically
    // because each feature's style function re-runs on every geometry change.
    if (tool === 'modify') {
      editAccentRef.current = drawStyleRef.current.lineColor;
      vertexEdit.attachDrawEditInteractions();
      return;
    }

    // Give each fresh drawing batch a random color, just like adding a vector
    // layer. Only re-roll when the batch is empty so in-progress work (and any
    // manually chosen style) keeps its color across tool switches.
    if (!inReedit && drawnFeatures.length === 0) {
      const { lineColor, fillColor } = getRandomVectorColors();
      handleDrawStyleChange({ ...drawStyleRef.current, lineColor, fillColor });
    }

    // AI magic wand (SAM 2.1 "snap to object"): no OL Draw interaction is
    // created — MapPage routes map clicks to useSamTools, which traces the
    // clicked object and commits the polygon via addExternalPolygon().
    if (tool === 'wand') {
      return;
    }

    let drawType: any;
    let geometryFunction: any = undefined;

    if (tool === 'line') {
      drawType = 'LineString';
    } else if (tool === 'polygon') {
      drawType = 'Polygon';
    } else if (tool === 'rectangle') {
      drawType = 'Circle';
      geometryFunction = createBox();
    } else if (tool === 'label') {
      drawType = 'Point';
    }

    // During a re-edit session, new features are drawn straight into the
    // layer being edited.
    const targetSource = inReedit
      ? (getLayerRawSource(vectorLayersRef.current, editingVectorLayerId as string) || drawSourceRef.current)
      : drawSourceRef.current;

    // `freehandCondition: never` keeps Shift free for magnetic edge
    // snapping (useMagneticDraw adds a Snap interaction while Shift is
    // held) — OL's default would start freehand drawing instead, and
    // Shift+clicks would abort the sketch. Line/polygon also accept
    // Shift+clicks as vertex placements (magneticClickCondition) so
    // vertices can be added while snapping.
    const isMagneticTool = tool === 'line' || tool === 'polygon';
    const drawInteraction = new Draw({
      source: targetSource,
      type: drawType,
      geometryFunction: geometryFunction,
      freehandCondition: never,
      ...(isMagneticTool ? { condition: magneticClickCondition } : {}),
    });

    // Style the in-progress sketch with the current draw style and live
    // measurement labels (segment lengths for lines, area for polygons and
    // rectangles). The style function re-runs on every geometry change, so
    // the readouts update as the user moves the pointer.
    drawInteraction.on('drawstart', (evt) => {
      sketchInProgressRef.current = true;
      // History baseline: the session state before this stroke lands (the
      // dedupe inside skips it when it matches the step already on top).
      pushHistorySnapshot();

      const sketch = evt.feature as any;
      sketch.setStyle(() => {
        const ds = inReedit ? reeditStyleSeedRef.current : drawStyleRef.current;
        const styles: Style[] = [buildDrawFeatureStyle(ds)];
        const geom = sketch.getGeometry ? sketch.getGeometry() : null;
        if (geom) styles.push(...buildMeasurementStyles(geom, ds, unitsRef.current));
        return styles;
      });
    });

    // Track features as they are drawn
    drawInteraction.on('drawend', (evt) => {
      sketchInProgressRef.current = false;
      const feature = evt.feature;
      const featureId = generateId(6);
      const geomType = feature.getGeometry()?.getType() || 'Unknown';

      // Each feature carries its own style — seeded from the current draw
      // style, or from the layer's own colours during a re-edit session.
      const initStyle = inReedit ? { ...reeditStyleSeedRef.current } : { ...drawStyleRef.current };
      applyDrawFeatureStyle(feature, initStyle, () => unitsRef.current);

      if (tool === 'label') {
        // Get the pixel position of the drawn point for dialog placement
        const pointCoords = (feature.getGeometry() as any).getCoordinates();
        const pixel = mapRef.current!.getPixelFromCoordinate(pointCoords);
        (feature as any)._drawFeatureId = featureId;

        // Show the in-app label dialog instead of browser prompt
        setLabelDialogState({
          pixel: pixel as [number, number],
          feature: feature,
          featureId: featureId,
          targetSource: targetSource,
          toLayer: inReedit,
        });
      } else {
        (feature as any)._drawFeatureId = featureId;
        let displayName = '';
        if (inReedit) {
          // Name from the layer's existing contents — the new feature isn't
          // in the source yet at drawend time.
          const layerFeats = targetSource.getFeatures() as any[];
          const featType = (f: any) => (f.getGeometry && f.getGeometry() ? f.getGeometry().getType() : '');
          const featName = (f: any) => f._drawName || '';
          if (tool === 'line') displayName = 'Line ' + (layerFeats.filter(f => featType(f) === 'LineString').length + 1);
          else if (tool === 'polygon') displayName = 'Polygon ' + (layerFeats.filter(f => featType(f) === 'Polygon' && !featName(f).startsWith('Rectangle')).length + 1);
          else if (tool === 'rectangle') displayName = 'Rectangle ' + (layerFeats.filter(f => featName(f).startsWith('Rectangle')).length + 1);
        } else {
          // Name from the current batch contents.
          if (tool === 'line') displayName = 'Line ' + (drawnFeaturesRef.current.filter(f => f.type === 'LineString').length + 1);
          else if (tool === 'polygon') displayName = 'Polygon ' + (drawnFeaturesRef.current.filter(f => f.type === 'Polygon' && !f.name.startsWith('Rectangle')).length + 1);
          else if (tool === 'rectangle') displayName = 'Rectangle ' + (drawnFeaturesRef.current.filter(f => f.name.startsWith('Rectangle')).length + 1);
        }
        (feature as any)._drawName = displayName;

        // History step for the completed stroke — the feature is passed in
        // explicitly because it isn't in the source yet at drawend time.
        pushHistorySnapshot(feature);

        if (inReedit) {
          // The feature lives in the layer now; refresh its feature list.
          bumpMeasureTick();
        } else {
          setDrawnFeatures(prev => [...prev, {
            id: featureId,
            type: tool === 'rectangle' ? 'Polygon' : (geomType as any),
            name: displayName,
            feature: feature,
            style: initStyle,
            customized: false,
          }]);
        }
      }
    });

    // Keep the flag in sync for every other way a sketch can end: Escape
    // below (abortDrawing), a tool switch or the toolbar hiding (removing
    // the interaction aborts any active sketch internally).
    drawInteraction.on('drawabort', () => {
      sketchInProgressRef.current = false;
    });

    mapRef.current.addInteraction(drawInteraction);
    drawInteractionRef.current = drawInteraction;
  };

  // ----- Label dialog ---------------------------------------------------------

  const handleLabelDialogApply = (text: string) => {
    if (!labelDialogState) return;
    const { feature, featureId, existingText } = labelDialogState;

    // Re-edit: swap the text in place. The feature's own style function
    // reads labelText live, so its style (and any customisation) survives.
    if (existingText !== undefined) {
      feature.set('labelText', text);
      (feature as any)._drawName = 'Label: ' + text;
      setDrawnFeatures(prev => prev.map(item =>
        item.feature === feature ? { ...item, name: 'Label: ' + text } : item
      ));
      pushHistorySnapshot();
      setLabelDialogState(null);
      bumpMeasureTick(); // refresh saved-layer name readouts
      return;
    }

    feature.set('labelText', text);
    const initStyle = labelDialogState.toLayer ? { ...reeditStyleSeedRef.current } : { ...drawStyleRef.current };
    applyDrawFeatureStyle(feature, initStyle, () => unitsRef.current);
    (feature as any)._drawName = 'Label: ' + text;
    pushHistorySnapshot();
    if (labelDialogState.toLayer) {
      // The label lives in the layer; refresh its feature list.
      bumpMeasureTick();
    } else {
      setDrawnFeatures(prev => [...prev, {
        id: featureId,
        type: 'Point',
        name: 'Label: ' + text,
        feature: feature,
        style: initStyle,
        customized: false,
      }]);
    }
    setLabelDialogState(null);
  };

  const handleLabelDialogCancel = () => {
    if (!labelDialogState) return;
    const { feature, existingText, targetSource } = labelDialogState;

    // Only a brand-new label is discarded — a re-edited one keeps its text.
    if (existingText === undefined && targetSource) {
      targetSource.removeFeature(feature);
    }
    setLabelDialogState(null);
  };

  // Reopen the label dialog from the drawn-features panel, anchored at the
  // label's current map position.
  const handleEditLabelText = (feature: any) => {
    const map = mapRef.current;
    const geom = feature && feature.getGeometry ? feature.getGeometry() : null;
    if (!map || !geom) return;
    setLabelDialogState({
      pixel: map.getPixelFromCoordinate(geom.getCoordinates()) as [number, number],
      feature: feature,
      featureId: '',
      existingText: String(feature.get('labelText') ?? ''),
    });
  };

  // ----- Drawn-features panel operations --------------------------------------

  const handleRemoveDrawnFeature = (id: string) => {
    const featureToRemove = drawnFeatures.find(f => f.id === id);
    if (featureToRemove && drawSourceRef.current) {
      drawSourceRef.current.removeFeature(featureToRemove.feature);
    }
    setDrawnFeatures(prev => prev.filter(f => f.id !== id));
    pushHistorySnapshot();
  };

  // Live-update the global draw style. Acts as the template for new features and
  // re-styles every feature that hasn't been individually customized.
  const handleDrawStyleChange = (newStyle: DrawStyle) => {
    setDrawStyle(newStyle);
    drawStyleRef.current = newStyle;
    const layer = drawLayerRef.current;
    if (layer) layer.setOpacity(newStyle.opacity / 100);
    setDrawnFeatures(prev => prev.map(item => {
      if (item.customized) return item;
      applyDrawFeatureStyle(item.feature, newStyle, () => unitsRef.current);
      return { ...item, style: newStyle };
    }));
  };

  // Edit the style of a single drawn feature. Marks it as customized so the
  // global style no longer overrides it.
  const handleFeatureStyleChange = (id: string, newStyle: DrawStyle) => {
    setDrawnFeatures(prev => prev.map(item => {
      if (item.id !== id) return item;
      applyDrawFeatureStyle(item.feature, newStyle, () => unitsRef.current);
      (item.feature as any)._drawCustomized = true;
      return { ...item, style: newStyle, customized: true };
    }));
  };

  const handleSaveDrawnToLayers = (layerName: string) => {
    if (drawnFeatures.length === 0 || !mapRef.current || !drawSourceRef.current) return;

    // Nothing may be mid-air while the batch changes hands.
    if (stickyVertexRef.current) vertexEdit.exitStickyVertex();

    // Clone features from draw source
    const features = drawSourceRef.current.getFeatures().slice();
    if (features.length === 0) return;

    // Carry the currently edited draw style over to the saved layer.
    const ds = drawStyleRef.current;

    // Create a new vector layer with these features
    const source = new VectorSource({ features: features });
    const olLayer = new VectorLayer({
      source: source,
      style: buildVectorStyle({ lineColor: ds.lineColor, fillColor: ds.fillColor, lineWidth: ds.lineWidth, fontColor: ds.fontColor, fontSize: ds.fontSize }),
    });
    olLayer.setOpacity(ds.opacity / 100);

    mapRef.current.addLayer(olLayer);

    const layerConfig: VectorLayerConfig = {
      id: generateId(),
      name: layerName || ('Drawn Features ' + (vectorLayers.length + 1)),
      type: 'geojson',
      visible: true,
      olLayer: olLayer,
      isDrawnInApp: true,
      opacity: ds.opacity,
      lineColor: ds.lineColor,
      lineWidth: ds.lineWidth,
      fillColor: ds.fillColor,
      fontColor: ds.fontColor,
      fontSize: ds.fontSize,
    };

    vectorLayersRef.current.set(layerConfig.id, olLayer);
    setVectorLayers(prev => [...prev, layerConfig]);
    reorderLayers(mapRef.current, rasterLayers, [...vectorLayers, layerConfig]);

    // Clear drawn features from the draw layer — a fresh batch starts a
    // fresh history.
    drawSourceRef.current.clear();
    setDrawnFeatures([]);
    resetHistory();
  };

  const handleExportDrawnFeatures = async (format: VectorExportFormat) => {
    if (drawnFeatures.length === 0 || !drawSourceRef.current) return;

    const features = drawSourceRef.current.getFeatures().slice();
    if (features.length === 0) return;

    try {
      await exportFeaturesToFile(features, 'drawn-features', format);
    } catch (err) {
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // ----- AI-traced features (SAM magic wand) ----------------------------------

  /**
   * Commit a polygon traced outside the OL Draw interaction (the SAM magic
   * wand) to the active batch — or straight into the layer being re-edited
   * when a re-edit session is live. Mirrors the drawend bookkeeping: style,
   * name, history step, panel entry.
   */
  const addExternalPolygon = (geometry: any) => {
    const map = mapRef.current;
    if (!map) return;
    const inReedit = editingVectorLayerIdRef.current !== null;
    const targetSource = inReedit
      ? (getLayerRawSource(vectorLayersRef.current, editingVectorLayerIdRef.current as string) || drawSourceRef.current)
      : drawSourceRef.current;
    if (!targetSource) return;

    const feature = new Feature(geometry);
    const featureId = generateId(6);
    const initStyle = inReedit ? { ...reeditStyleSeedRef.current } : { ...drawStyleRef.current };
    applyDrawFeatureStyle(feature, initStyle, () => unitsRef.current);
    (feature as any)._drawFeatureId = featureId;

    const isSnapName = (f: any) => typeof f._drawName === 'string' && f._drawName.startsWith('Snap ');
    const displayName = 'Snap ' + (inReedit
      ? (targetSource.getFeatures() as any[]).filter(f => f.getGeometry && f.getGeometry() && f.getGeometry().getType() === 'Polygon' && isSnapName(f)).length + 1
      : drawnFeaturesRef.current.filter(f => f.type === 'Polygon' && f.name.startsWith('Snap ')).length + 1);
    (feature as any)._drawName = displayName;

    // History step first (the feature isn't in the source yet), then insert.
    pushHistorySnapshot(feature);
    targetSource.addFeature(feature);

    if (inReedit) {
      bumpMeasureTick();
    } else {
      setDrawnFeatures(prev => [...prev, {
        id: featureId,
        type: 'Polygon',
        name: displayName,
        feature: feature,
        style: initStyle,
        customized: false,
      }]);
    }
  };

  // ----- Saved-layer re-edit session --------------------------------------------

  const handleReeditVectorLayer = (layerId: string) => {
    const map = mapRef.current;
    if (!map) return;

    // Clicking again on the layer being edited finishes the session.
    if (editingVectorLayerId === layerId) {
      editingVectorLayerIdRef.current = null;
      if (stickyVertexRef.current) vertexEdit.exitStickyVertex();
      vertexEdit.disposeLayerEditInteractions();
      setEditingVectorLayerId(null);
      layerHistoryRef.current = { stack: [], index: -1 };
      syncHistoryDepth(); // button depths now mirror the drawing batch again
      (map.getTargetElement() as HTMLElement).style.cursor = '';
      return;
    }

    // Geometry editing is exclusive — leave any active draw tool first.
    if (drawInteractionRef.current) {
      map.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    vertexEdit.disposeDrawEditInteractions();
    if (activeDrawTool !== null) {
      setActiveDrawTool(null);
    }

    // Move an ongoing re-edit session to the newly chosen layer — each
    // layer gets a fresh undo history.
    if (stickyVertexRef.current) vertexEdit.exitStickyVertex();
    layerHistoryRef.current = { stack: [], index: -1 };
    vertexEdit.disposeLayerEditInteractions();

    const olLayer = vectorLayersRef.current.get(layerId);
    const source = olLayer && olLayer.getSource ? olLayer.getSource() : null;
    if (!source) return;

    // Handles pick up the layer's own line colour so they read as part of it.
    const layerConfig = vectorLayers.find(l => l.id === layerId);
    const accent = layerConfig?.lineColor || drawStyleRef.current.lineColor;
    editAccentRef.current = accent;

    // Features drawn during the session take on the layer's own colours.
    reeditStyleSeedRef.current = {
      opacity: layerConfig?.opacity ?? 100,
      lineColor: layerConfig?.lineColor || DEFAULT_DRAW_STYLE.lineColor,
      lineWidth: layerConfig?.lineWidth ?? 2,
      fillColor: layerConfig?.fillColor || DEFAULT_DRAW_STYLE.fillColor,
      fontColor: layerConfig?.fontColor || DEFAULT_DRAW_STYLE.fontColor,
      fontSize: layerConfig?.fontSize ?? 14,
    };

    vertexEdit.attachLayerEditInteractions(olLayer, source);

    // Switch the session over, then open the layer's undo history with its
    // current state as the baseline step.
    editingVectorLayerIdRef.current = layerId;
    setEditingVectorLayerId(layerId);
    layerHistoryRef.current = { stack: [], index: -1 };
    pushHistorySnapshot();
  };

  /** Tear down a re-edit session because its layer is being removed. */
  const endReeditSession = (layerId: string) => {
    if (editingVectorLayerId !== layerId) return;
    editingVectorLayerIdRef.current = null;
    if (stickyVertexRef.current) vertexEdit.exitStickyVertex();
    vertexEdit.disposeLayerEditInteractions();
    setEditingVectorLayerId(null);
    layerHistoryRef.current = { stack: [], index: -1 };
    syncHistoryDepth();
  };

  // ----- Effects ----------------------------------------------------------------

  // Persist the active draw session whenever it changes so a full reload (not
  // just a workspace switch) restores in-progress drawing as well. The session
  // is read from the live source, which always reflects the latest geometry.
  // Skipped until the map init has created the source: this hook's effects are
  // registered before MapPage's init effect, and an early run here would wipe
  // a persisted session before the init effect restores it.
  useEffect(() => {
    if (drawSourceRef.current) saveDrawSession(drawSourceRef.current, workspaceId);
  }, [drawnFeatures, measureTick, workspaceId]);

  // Keep the draw-mode ref in sync so the map click handler always sees the
  // current tool (the handler is registered once and can't read state directly).
  useEffect(() => {
    activeDrawToolRef.current = activeDrawTool;
  }, [activeDrawTool]);

  // Escape discards an in-progress sketch first (a line/polygon/rectangle
  // with at least one vertex placed) and keeps the tool armed; only when
  // nothing is being drawn does it exit the active drawing tool. The
  // handler stands aside when a more specific Escape owner is in front:
  // text entry (the label dialog input), an Escape already consumed
  // elsewhere (focused menus, MapPage's sticky-vertex handler and the SAM
  // wand trace call preventDefault), so a picked-up vertex gets the first
  // Escape (puts it back) and the tool gets the next one.
  useEffect(() => {
    if (activeDrawTool === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (stickyVertexRef.current) return;
      // Discard the unfinished sketch, keep the tool armed.
      const draw = drawInteractionRef.current;
      if (draw && sketchInProgressRef.current) {
        draw.abortDrawing();
        e.preventDefault();
        return;
      }
      handleDrawTool(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawTool, editingVectorLayerId]);

  // Same mirror for the saved-layer re-edit session.
  useEffect(() => {
    editingVectorLayerIdRef.current = editingVectorLayerId;
  }, [editingVectorLayerId]);

  useEffect(() => {
    drawnFeaturesRef.current = drawnFeatures;
  }, [drawnFeatures]);

  // Double-click zoom steps aside for the duration of any edit session so a
  // quick second click places the picked-up vertex instead of zooming.
  useEffect(() => {
    const editSession = activeDrawTool === 'modify' || activeDrawTool === 'wand' || editingVectorLayerId !== null;
    if (doubleClickZoomRef.current) {
      doubleClickZoomRef.current.setActive(!editSession);
    }
  }, [activeDrawTool, editingVectorLayerId, doubleClickZoomRef]);

  // Auto-open panel when entering draw mode
  useEffect(() => {
    if (activeDrawTool !== null) {
      setShowDrawnPanel(true);
    }
  }, [activeDrawTool]);

  // Clear drawing interaction and unsaved geometry when toolbar is hidden
  useEffect(() => {
    if (!showDrawToolbar) {
      // Remove active draw interaction
      if (activeDrawTool !== null) {
        if (drawInteractionRef.current && mapRef.current) {
          mapRef.current.removeInteraction(drawInteractionRef.current);
          drawInteractionRef.current = null;
        }
        vertexEdit.disposeDrawEditInteractions();
        if (stickyVertexRef.current) {
          vertexEdit.exitStickyVertex();
        }
        setActiveDrawTool(null);
      }
      // Clear unsaved drawn features from the map
      if (drawSourceRef.current) {
        drawSourceRef.current.clear();
      }
      setDrawnFeatures([]);
      resetHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrawToolbar]);

  return {
    // State for JSX
    activeDrawTool,
    drawnFeatures,
    drawStyle,
    showDrawnPanel,
    labelDialogState,
    undoDepth,
    redoDepth,
    measureTick,
    editingVectorLayerId,
    stickyVertex,
    // Refs assigned/read by the map init and OL callbacks
    drawSourceRef,
    drawLayerRef,
    drawStyleRef,
    activeDrawToolRef,
    editingVectorLayerIdRef,
    drawnFeaturesRef,
    editAccentRef,
    reeditStyleSeedRef,
    editMarkerSourceRef: vertexEdit.editMarkerSourceRef,
    editMarkerFeatureRef: vertexEdit.editMarkerFeatureRef,
    stickyVertexRef,
    // Setters used by the map init and sibling handlers
    setDrawnFeatures,
    setShowDrawnPanel,
    setLabelDialogState,
    // Handlers wired into JSX
    handleDrawTool,
    handleUndo,
    handleRedo,
    handleLabelDialogApply,
    handleLabelDialogCancel,
    handleDrawStyleChange,
    handleFeatureStyleChange,
    handleRemoveDrawnFeature,
    handleSaveDrawnToLayers,
    addExternalPolygon,
    handleExportDrawnFeatures,
    handleEditLabelText,
    handleReeditVectorLayer,
    endReeditSession,
    // For map event registration in the init effect
    handleEditClick: vertexEdit.handleEditClick,
    handleEditDoubleClick: vertexEdit.handleEditDoubleClick,
    cancelStickyVertex: vertexEdit.cancelStickyVertex,
    deleteStickyTarget: vertexEdit.deleteStickyTarget,
    exitStickyVertex: vertexEdit.exitStickyVertex,
  };
}
