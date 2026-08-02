import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import OLMap from 'ol/Map.js';
import OSM from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import ImageLayer from 'ol/layer/Image.js';
import TileDebug from 'ol/source/TileDebug.js';
import XYZ from 'ol/source/XYZ.js';
import WMTS from 'ol/source/WMTS.js';
import { optionsFromCapabilities } from 'ol/source/WMTS.js';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import ImageWMS from 'ol/source/ImageWMS.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import GeoTIFFSource from 'ol/source/GeoTIFF.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import ScaleLine from 'ol/control/ScaleLine.js';
import Attribution from 'ol/control/Attribution.js';
import Overlay from 'ol/Overlay.js';
import { defaults as defaultControls } from 'ol/control.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Cluster from 'ol/source/Cluster.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { Style, Fill, Stroke, Circle as CircleStyle, RegularShape, Text } from 'ol/style.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import Translate from 'ol/interaction/Translate.js';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom.js';
import { primaryAction } from 'ol/events/condition.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { getArea, getLength } from 'ol/sphere.js';
import JSZip from 'jszip';
import Projection from 'ol/proj/Projection.js';
import { fromLonLat, toLonLat, transformExtent, get as getOlProjection } from 'ol/proj.js';
import { parseShapefile } from '../utils/shapefileParser';
import { exportFeaturesToFile, VectorExportFormat } from '../utils/vectorExport';
import { captureMapCanvas, canvasToPngBlob, isTaintedCanvasError } from '../utils/mapExport';
import { registerProjectionFromWKT, registerProjectionFromEPSGCode } from '../utils/projectionHelper';
import {
  KnownSource,
  RasterLayer,
  VectorLayerConfig,
  LayerGroup,
  DrawStyle,
  DrawToolId,
  StoredSettings,
  UnitsSystem,
  WorkspaceMeta,
  VertexHit,
  SegmentHit,
  SessionSnapshot,
  DEFAULT_DRAW_STYLE,
  DRAW_STYLE_KEYS,
  FILE_VECTOR_TYPES,
} from '../types';
import { DEFAULT_BASEMAP_URL, HISTORY_LIMIT } from '../constants';
import { loadKnownSources, saveKnownSources } from '../utils/knownSources';
import {
  createXYZSource,
  createWmtsSource,
  createBasemapSource,
  basemapSourceKey,
  extractWmtsExtent,
  extractWmsExtent,
  extractBaseUrl,
} from '../utils/tileHelpers';
import {
  patchLayerRenderer,
  applyColorAdjustments,
  createCogTileStyle,
  buildWfsUrl,
  fetchAllStacItems,
  escapeHtml,
  popupFeatureLabel,
  fetchWmsFeatureInfo,
  applyVectorLayerZoomRange,
  applyVectorFeatureFilter,
  reorderLayers,
} from '../utils/layerHelpers';
import { parseColor, rgbaToString, normalizeOlColor, getRandomVectorColors } from '../utils/colorHelpers';
import { buildMeasurementStyles, getFeatureMeasurementText } from '../utils/measurement';
import {
  buildDrawFeatureStyle,
  applyDrawFeatureStyle,
  saveDrawSession,
  loadDrawSession,
  buildModifyVertexStyle,
  findNearestVertex,
  findNearestSegment,
  setVertexCoordinate,
  removeVertexFromGeom,
  insertVertexInGeom,
  buildEditMarkerStyles,
  captureDrawSnapshot,
  snapshotKey,
} from '../utils/drawHelpers';
import { hasLockedVault } from '../utils/appLock';
import {
  loadSettings,
  saveSettings,
  getInitialView,
  updateUrlParams,
} from '../utils/workspaceStorage';
import { idbGetWithRetry, idbDelete } from '../utils/idb';
import { validateCogBuffer, resolveS3CogUrl, buildS3HttpsUrl, hasS3Credentials, presignS3Url, MAX_NON_COG_TIFF_SIZE } from '../utils/cogHelpers';
import type { S3Config } from '../utils/cogHelpers';
import { SettingsDialog } from './SettingsDialog';
import { AdvancedSettingsDialog } from './AdvancedSettingsDialog';
import { GoToBar } from './GoToBar';
import { DrawToolbar, LabelInputDialog, DrawStyleEditor, VectorFeatureStyleItem } from './DrawToolbar';
import { DrawnFeaturesPanel } from './DrawnFeaturesPanel';
import { MouseCoordinateDisplay } from './MouseCoordinateDisplay';
import { MapContextMenu } from './MapContextMenu';
import { GearIcon } from './Icons';
import {
  anchorEmptiedGroups,
  toggleGroupLayerVisibility,
  flatIndexForGroupSlot,
  moveLayerToGroup,
} from './LayerPanel';
import type { WmsFeatureInfoResult } from '../types';

interface MapPageProps {
  workspaceId: string;
  workspaces: WorkspaceMeta[];
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDuplicateWorkspace: (id: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onLockApp: () => void;
  hasLockPassword: boolean;
  onSetPassword: () => void;
  onResetPassword: () => void;
  getLockPassword: () => string | null;
}

export function MapPage({
  workspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDuplicateWorkspace,
  onDeleteWorkspace,
  onLockApp,
  hasLockPassword,
  onSetPassword,
  onResetPassword,
  getLockPassword,
}: MapPageProps) {
  const zoomRef = useRef<HTMLDivElement>(null);
  const attributionRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const gridLayerRef = useRef<TileLayer<any> | null>(null);
  const basemapLayerRef = useRef<TileLayer<any> | null>(null);
  const rasterLayersRef = useRef<Map<string, any>>(new Map());
  const vectorLayersRef = useRef<Map<string, any>>(new Map());
  // Maps an OL vector layer object to its display name so the once-registered
  // map click handler can label popup sections with the current layer names.
  const vectorLayerNamesRef = useRef<Map<any, string>>(new Map());
  // The component is remounted (via key) whenever the active workspace
  // changes, so this loads the incoming workspace's persisted setup.
  const storedSettings = useRef(loadSettings(workspaceId));
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPinned, setSettingsPinned] = useState(storedSettings.current.settingsPinned);
  const settingsWrapperRef = useRef<HTMLDivElement>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [knownSources, setKnownSources] = useState<KnownSource[]>(() => loadKnownSources());

  const handleUpdateKnownSources = (sources: KnownSource[]) => {
    setKnownSources(sources);
    saveKnownSources(sources);
  };
  const [showGrid, setShowGrid] = useState(storedSettings.current.showGrid);
  const [showDrawToolbar, setShowDrawToolbar] = useState(storedSettings.current.showDrawToolbar);
  const [showCoordinates, setShowCoordinates] = useState(storedSettings.current.showCoordinates);
  const [showBasemap, setShowBasemap] = useState(storedSettings.current.showBasemap);
  const [basemapUrl, setBasemapUrl] = useState<string>(storedSettings.current.basemapUrl);
  const [basemapMinZoom, setBasemapMinZoom] = useState<number | undefined>(storedSettings.current.basemapMinZoom);
  const [basemapMaxZoom, setBasemapMaxZoom] = useState<number | undefined>(storedSettings.current.basemapMaxZoom);
  const [units, setUnits] = useState<UnitsSystem>(storedSettings.current.units);
  const unitsRef = useRef<UnitsSystem>(units);
  const scaleLineRef = useRef<ScaleLine | null>(null);
  const appliedBasemapKeyRef = useRef<string>(
    basemapSourceKey(storedSettings.current.basemapUrl, storedSettings.current.basemapMinZoom, storedSettings.current.basemapMaxZoom)
  );
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>(storedSettings.current.rasterLayers);
  const [vectorLayers, setVectorLayers] = useState<VectorLayerConfig[]>([]);
  const [rasterGroups, setRasterGroups] = useState<LayerGroup[]>(storedSettings.current.rasterGroups);
  const [vectorGroups, setVectorGroups] = useState<LayerGroup[]>(storedSettings.current.vectorGroups);
  const [isRestoringLayers, setIsRestoringLayers] = useState(storedSettings.current.rasterLayers.length > 0 || storedSettings.current.vectorLayers.length > 0);
  // IDs of vector layers currently fetching data (STAC/WFS initial load, MVT tiles).
  const [loadingVectorIds, setLoadingVectorIds] = useState<Set<string>>(new Set());
  const markVectorLoading = useCallback((layerId: string, loading: boolean) => {
    setLoadingVectorIds(prev => {
      if (prev.has(layerId) === loading) return prev; // no-op, avoid re-render
      const next = new Set(prev);
      if (loading) next.add(layerId); else next.delete(layerId);
      return next;
    });
  }, []);
  // MVT tiles load incrementally: track a per-layer pending-tile counter.
  const wireVectorTileLoading = useCallback((source: any, layerId: string) => {
    let pending = 0;
    source.on('tileloadstart', () => {
      pending += 1;
      if (pending === 1) markVectorLoading(layerId, true);
    });
    const tileDone = () => {
      pending = Math.max(0, pending - 1);
      if (pending === 0) markVectorLoading(layerId, false);
    };
    source.on('tileloadend', tileDone);
    source.on('tileloaderror', tileDone);
  }, [markVectorLoading]);
  const [isDragging, setIsDragging] = useState(false);
  const [popupContent, setPopupContent] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<[number, number] | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const popupOverlayRef = useRef<Overlay | null>(null);
  // WMS layers whose GetFeatureInfo toggle is on. Mirrors rasterLayers for the
  // once-registered map click handler (its closure only sees initial state).
  const wmsFeatureInfoRef = useRef<Array<{ id: string; name: string; olLayer: any }>>([]);
  // Monotonic counter so stale async GetFeatureInfo responses never overwrite
  // the popup belonging to a newer click.
  const popupClickSeqRef = useRef(0);
  const [activeDrawTool, setActiveDrawTool] = useState<DrawToolId>(null);
  // Mirrors activeDrawTool for the once-registered map click handler (its closure
  // only ever sees the initial state value).
  const activeDrawToolRef = useRef<DrawToolId>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const modifyInteractionRef = useRef<Modify | null>(null);
  // Bumped after every vertex edit so the drawn-features panel and layer
  // edit menus re-render and their length/area readouts pick up the edited
  // geometry.
  const [measureTick, setMeasureTick] = useState(0);
  // Id of the saved drawn-in-app layer currently being re-edited in place
  // (null while none is). Geometry edits run through a Modify interaction
  // bound to that layer's own source.
  const [editingVectorLayerId, setEditingVectorLayerId] = useState<string | null>(null);
  const editingVectorLayerIdRef = useRef<string | null>(null);
  const layerModifyInteractionRef = useRef<Modify | null>(null);
  // Whole-feature drag-to-move companions for the two Modify interactions.
  const drawTranslateRef = useRef<Translate | null>(null);
  const layerTranslateRef = useRef<Translate | null>(null);
  // Overlay source holding the single "picked up vertex" marker.
  const editMarkerSourceRef = useRef<VectorSource | null>(null);
  const editMarkerFeatureRef = useRef<any>(null);
  // Accent colour (vertex handles + marker) for the current edit session.
  const editAccentRef = useRef<string>(DEFAULT_DRAW_STYLE.lineColor);
  const doubleClickZoomRef = useRef<any>(null);
  // Vertex picked up with a click: follows the pointer until the next click
  // places it; Delete removes it, Escape puts it back.
  const [stickyVertex, setStickyVertex] = useState<VertexHit | null>(null);
  const stickyVertexRef = useRef<VertexHit | null>(null);
  // Undo/redo history for the draw session — stepped from the toolbar
  // buttons or Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
  const historyRef = useRef<{ stack: Array<{ snap: SessionSnapshot; key: string }>; index: number }>({ stack: [], index: -1 });
  // Separate stack for saved-layer re-edit sessions, so the drawing batch's
  // history and a layer's history never tangle.
  const layerHistoryRef = useRef<{ stack: Array<{ snap: SessionSnapshot; key: string }>; index: number }>({ stack: [], index: -1 });
  // Style seed for features drawn into a layer during its re-edit session —
  // the layer's own colours, kept live by the style preview.
  const reeditStyleSeedRef = useRef<DrawStyle>({ ...DEFAULT_DRAW_STYLE });
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const drawSourceRef = useRef<VectorSource | null>(null);
  const drawLayerRef = useRef<VectorLayer<any> | null>(null);
  const [drawStyle, setDrawStyle] = useState<DrawStyle>(DEFAULT_DRAW_STYLE);
  const drawStyleRef = useRef<DrawStyle>(DEFAULT_DRAW_STYLE);
  const [drawnFeatures, setDrawnFeatures] = useState<Array<{
    id: string;
    type: 'LineString' | 'Polygon' | 'Point';
    name: string;
    feature: any;
    style: DrawStyle;
    customized: boolean;
  }>>([]);
  // Mirror of drawnFeatures for OL event callbacks, which are registered
  // once and can't read fresh state directly.
  const drawnFeaturesRef = useRef<typeof drawnFeatures>([]);
  const [showDrawnPanel, setShowDrawnPanel] = useState(false);
  const [labelDialogState, setLabelDialogState] = useState<{
    pixel: [number, number];
    feature: any;
    featureId: string;
    existingText?: string; // present → re-editing an existing label's text
    targetSource?: any; // source the label's feature lives in
    toLayer?: boolean; // label belongs to a saved layer being re-edited
  } | null>(null);
  const [mouseCoord, setMouseCoord] = useState<[number, number] | null>(null);
  const [coordProjection, setCoordProjection] = useState<string>('EPSG:4326');
  const [coordDecimals, setCoordDecimals] = useState<number>(6);
  // In-app right-click menu: where it opened (px relative to the map
  // container) plus the map coordinate that was under the cursor.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; coordinate: [number, number] } | null>(null);
  // Transient toast for action feedback (copied coordinates / image, errors).
  const [toast, setToast] = useState<{ id: number; message: string; kind: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // Persistent, dismissible banner for layer-loading errors (COG / raster).
  // Unlike the transient toast, these carry actionable detail (e.g. the S3
  // CORS config to apply) so they stay until the user closes them.
  const [layerError, setLayerError] = useState<{ id: number; title: string; detail: string } | null>(null);




  useEffect(() => {
    if (!zoomRef.current || !attributionRef.current) {
      return;
    }

    const zoomControl = new Zoom({ target: zoomRef.current });
    const attributionControl = new Attribution({
      target: attributionRef.current,
      collapsible: false,
    });
    const scaleLineControl = new ScaleLine({
      units: storedSettings.current.units === 'imperial' ? 'imperial' : 'metric',
    });
    scaleLineRef.current = scaleLineControl;

    const { center, zoom } = getInitialView(workspaceId);

    const mapview = new View({
      center: center,
      zoom: zoom,
      minZoom: 2,
      maxZoom: 25,
    });

    const map = new OLMap({
      target: 'map',
      controls: defaultControls({ zoom: false, attribution: false }).extend([
        zoomControl,
        attributionControl,
        scaleLineControl,
      ]),
      layers: [
        new TileLayer({
          source: createBasemapSource(
            storedSettings.current.basemapUrl,
            storedSettings.current.basemapMinZoom,
            storedSettings.current.basemapMaxZoom,
          ),
        }),
      ],
      view: mapview,
    });

    // Store reference to the basemap layer for toggle
    basemapLayerRef.current = map.getLayers().getArray()[0] as TileLayer<any>;

    mapRef.current = map;

    // Patch all layers to prevent filter bleeding
    // This ensures layers with colour filters don't affect other layers
    map.getLayers().getArray().forEach((layer: any) => {
      // Patch immediately if renderer is ready
      if (layer.getRenderer()) {
        patchLayerRenderer(layer);
      }
    });

    // Automatically patch any new layers as they're added
    map.getLayers().on('add', (event: any) => {
      const layer = event.element;
      // Patch when renderer is ready (may be async)
      const patchWhenReady = () => {
        if (layer.getRenderer()) {
          patchLayerRenderer(layer);
        } else {
          // Retry after a short delay
          setTimeout(patchWhenReady, 100);
        }
      };
      patchWhenReady();
    });

    // Track mouse coordinates on the map
    map.on('pointermove', (evt) => {
      // A picked-up vertex follows the pointer until it is placed — even
      // while a mouse button happens to be held down.
      const sticky = stickyVertexRef.current;
      if (sticky) {
        setVertexCoordinate(sticky.geom, sticky.indexPath, evt.coordinate as number[]);
        if (editMarkerFeatureRef.current) {
          editMarkerFeatureRef.current.getGeometry().setCoordinates(evt.coordinate);
        }
        (map.getTargetElement() as HTMLElement).style.cursor = 'grabbing';
        if (!evt.dragging) setMouseCoord(evt.coordinate as [number, number]);
        return;
      }

      if (evt.dragging) return;
      setMouseCoord(evt.coordinate as [number, number]);

      // While geometry is being edited — the draw toolbar's edit tool or a
      // saved layer's re-edit session — the cursor says what a press will
      // do: grab over a vertex, move over the feature body.
      const reeditLayerId = editingVectorLayerIdRef.current;
      const activeToolNow = activeDrawToolRef.current;
      const editCursorMode = activeToolNow === 'modify' || (reeditLayerId !== null && activeToolNow === null);
      if (editCursorMode) {
        const editSource = reeditLayerId !== null
          ? getLayerRawSource(reeditLayerId)
          : drawSourceRef.current;
        let cursor = '';
        if (editSource && findNearestVertex(map, editSource, evt.pixel as number[], 12)) {
          cursor = 'grab';
        } else {
          const reeditLayer = reeditLayerId !== null ? vectorLayersRef.current.get(reeditLayerId) : null;
          const overEditable = map.hasFeatureAtPixel(evt.pixel, {
            hitTolerance: 6,
            layerFilter: (candidate: any) =>
              reeditLayerId !== null ? candidate === reeditLayer : candidate === drawLayerRef.current,
          });
          cursor = overEditable ? 'move' : '';
        }
        (map.getTargetElement() as HTMLElement).style.cursor = cursor;
      }
    });

    // Setup drawing layer with style function
    const drawSource = new VectorSource();
    
    const drawLayerStyle = (feature: any) => {
      const ds = drawStyleRef.current;
      const styles: Style[] = [buildDrawFeatureStyle(ds, feature.get('labelText'))];
      const geom = feature.getGeometry();
      if (geom) {
        styles.push(...buildMeasurementStyles(geom, ds, unitsRef.current));
      }
      return styles;
    };
    
    const drawLayer = new VectorLayer({
      source: drawSource,
      style: drawLayerStyle,
    });
    drawLayer.setZIndex(9999);
    drawLayer.set('_isDrawLayer', true);
    map.addLayer(drawLayer);
    drawSourceRef.current = drawSource;
    drawLayerRef.current = drawLayer;

    // Restore any unsaved drawn features persisted for this workspace so a
    // workspace switch (which remounts the map) doesn't lose in-progress work.
    const restoredDrawItems = loadDrawSession(drawSource, workspaceId, () => unitsRef.current);
    if (restoredDrawItems.length > 0) {
      setDrawnFeatures(restoredDrawItems);
    }

    // Overlay for the "picked up" vertex marker — reorderLayers knows to
    // keep it above every other layer.
    const editMarkerSource = new VectorSource();
    const editMarkerLayer = new VectorLayer({ source: editMarkerSource, zIndex: 10001 });
    editMarkerLayer.set('_isEditMarkerLayer', true);
    map.addLayer(editMarkerLayer);
    editMarkerSourceRef.current = editMarkerSource;

    // Edit sessions suspend double-click zoom so a quick second click places
    // the picked-up vertex instead of zooming the map.
    doubleClickZoomRef.current =
      map.getInteractions().getArray().find((interaction: any) => interaction instanceof DoubleClickZoom) || null;


    // Setup popup overlay - create element in JS to avoid React/OL DOM conflicts
    const popupEl = document.createElement('div');
    popupEl.className = 'map-popup';
    popupEl.style.display = 'none';
    
    const closerBtn = document.createElement('button');
    closerBtn.className = 'popup-closer';
    closerBtn.innerHTML = '&times;';
    closerBtn.onclick = () => {
      setPopupContent(null);
      setPopupPosition(null);
    };
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'popup-content';

    // Footer with master collapse/expand controls — only shown when the
    // popup contains more than one feature (toggled in the content effect).
    const footerEl = document.createElement('div');
    footerEl.className = 'popup-footer';
    footerEl.style.display = 'none';
    footerEl.innerHTML =
      '<button type="button" class="popup-footer-btn" data-popup-action="collapse-all">Collapse all</button>' +
      '<button type="button" class="popup-footer-btn popup-footer-btn-solid" data-popup-action="show-all">Show all</button>';

    popupEl.appendChild(closerBtn);
    popupEl.appendChild(contentDiv);
    popupEl.appendChild(footerEl);

    // Delegated click handling for the collapsible feature blocks and the
    // footer buttons (content is swapped via innerHTML, so listeners must
    // live on the persistent popup element).
    popupEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const actionEl = target.closest('[data-popup-action]') as HTMLElement | null;
      if (actionEl) {
        const collapse = actionEl.getAttribute('data-popup-action') === 'collapse-all';
        popupEl.querySelectorAll('.popup-feature').forEach(f => f.classList.toggle('collapsed', collapse));
        return;
      }
      const headerEl = target.closest('.popup-feature-header') as HTMLElement | null;
      if (headerEl) {
        const featureEl = headerEl.closest('.popup-feature');
        if (featureEl) featureEl.classList.toggle('collapsed');
      }
    });

    // Add popup element to the map container
    
    const popupOverlay = new Overlay({
      element: popupEl,
      autoPan: true,
      positioning: 'bottom-center',
      offset: [0, -12],
    });
    map.addOverlay(popupOverlay);
    popupOverlayRef.current = popupOverlay;
    popupRef.current = popupEl;

    // Double-clicking a label while editing reopens its text dialog (the
    // map's double-click zoom is suspended during edit sessions, so the
    // gesture is free to use).
    map.on('dblclick', (evt) => {
      handleEditDoubleClick(evt);
    });

    // Click handler for feature info — shows attributes for *every* vector
    // feature under the clicked point (grouped by layer, topmost first) and,
    // for WMS layers with GetFeatureInfo enabled, queries the server for the
    // raster attributes at that position.
    map.on('click', (evt) => {
      // While a draw tool is active clicks place vertices, and while a saved
      // layer is being re-edited clicks grab vertices — suppress the
      // feature-info popup in both cases so editing isn't interrupted by it.
      if (activeDrawToolRef.current !== null || editingVectorLayerIdRef.current !== null) {
        // Edit modes own clicks: pick up / place vertices, insert on segments.
        handleEditClick(evt);
        return;
      }

      // Bump the click sequence first so any GetFeatureInfo responses still in
      // flight from an earlier click are discarded the moment a new click lands.
      const clickSeq = ++popupClickSeqRef.current;
      const coordinate = evt.coordinate as [number, number];

      // Clicking a cluster bubble zooms in to expand it rather than inspecting
      // the aggregate - the standard clustering interaction.
      let clickedCluster = false;
      map.forEachFeatureAtPixel(evt.pixel, (feature: any) => {
        const members = feature && feature.get ? feature.get('features') : undefined;
        if (Array.isArray(members) && members.length > 1) {
          clickedCluster = true;
          return true; // stop hit-testing
        }
      });
      if (clickedCluster) {
        const view = map.getView();
        view.animate({ zoom: (view.getZoom() ?? 0) + 2, center: coordinate, duration: 300 });
        setPopupContent(null);
        setPopupPosition(null);
        return;
      }

      // Collect all vector features at the pixel, grouped by layer in
      // topmost-first order. A single feature can be reported more than once
      // (one per style part, e.g. stroke + fill), so dedupe by feature identity.
      const hitsByLayer = new Map<any, Array<{ feature: any; metadata: Record<string, any> }>>();
      const seenFeatures = new Set<any>();

      map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
        if (!layer || seenFeatures.has(feature)) return;
        seenFeatures.add(feature);

        // A lone point in a clustered layer is wrapped in a single-member
        // cluster feature - unwrap it so the popup shows the real attributes.
        let target: any = feature;
        const clusterMembers = feature && feature.get ? feature.get('features') : undefined;
        if (Array.isArray(clusterMembers) && clusterMembers.length === 1) {
          target = clusterMembers[0];
        }

        const properties = target.getProperties();
        const metadata: Record<string, any> = {};
        Object.keys(properties).forEach(key => {
          const value = properties[key];
          if (key === 'geometry') return;
          if (typeof value === 'object' && value !== null && value.getType) return;
          metadata[key] = value;
        });
        if (Object.keys(metadata).length === 0) return;

        if (!hitsByLayer.has(layer)) hitsByLayer.set(layer, []);
        hitsByLayer.get(layer)!.push({ feature: target, metadata });
      });

      // WMS layers with GetFeatureInfo toggled on that are currently visible.
      const wmsInfoLayers = wmsFeatureInfoRef.current.filter(entry => {
        const ol = entry.olLayer;
        return ol && ol.getVisible?.() !== false && ol.getSource?.();
      });

      if (hitsByLayer.size === 0 && wmsInfoLayers.length === 0) {
        setPopupContent(null);
        setPopupPosition(null);
        return;
      }

      const vectorFeatureCount = Array.from(hitsByLayer.values())
        .reduce((count, entries) => count + entries.length, 0);

      const renderRows = (metadata: Record<string, any>) =>
        Object.entries(metadata)
          .map(([key, value]) =>
            '<div class="popup-row"><strong>' + escapeHtml(key) + ':</strong> ' + escapeHtml(String(value)) + '</div>')
          .join('');

      const renderFeatureBlock = (title: string, metadata: Record<string, any>) =>
        '<div class="popup-feature">' +
          '<button type="button" class="popup-feature-header">' +
            '<span class="popup-feature-title-text">' + escapeHtml(title) + '</span>' +
          '</button>' +
          '<div class="popup-feature-body">' + renderRows(metadata) + '</div>' +
        '</div>';

      // Build the popup sections for the vector features under the pointer.
      // `collapsible` switches between a flat layout (single hit overall) and
      // per-feature collapsible blocks (multiple hits).
      const buildVectorSections = (collapsible: boolean): string[] => {
        const sections: string[] = [];
        hitsByLayer.forEach((entries, layer) => {
          const layerName =
            vectorLayerNamesRef.current.get(layer) ||
            (layer.get && layer.get('_isDrawLayer') ? 'Drawing' : 'Layer');

          if (!collapsible) {
            // Single feature overall — plain, non-collapsible section.
            sections.push(
              '<div class="popup-section">' +
                '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
                renderRows(entries[0].metadata) +
              '</div>'
            );
            return;
          }

          if (entries.length === 1) {
            // One feature from this layer — the layer name heads its block.
            sections.push(
              '<div class="popup-section">' + renderFeatureBlock(layerName, entries[0].metadata) + '</div>'
            );
            return;
          }

          // Several features from the same layer — static group title plus one
          // collapsible block per feature.
          const blocks = entries.map(({ feature, metadata }, index) =>
            renderFeatureBlock(popupFeatureLabel(feature, index), metadata)
          );
          sections.push(
            '<div class="popup-section">' +
              '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
              blocks.join('') +
            '</div>'
          );
        });
        return sections;
      };

      // Build the popup sections for resolved GetFeatureInfo results.
      const buildWmsSections = (
        results: Array<{ name: string; result: WmsFeatureInfoResult | null }>,
        collapsible: boolean
      ): string[] => {
        const sections: string[] = [];
        results.forEach(({ name, result }) => {
          if (!result) {
            sections.push(
              '<div class="popup-section">' +
                '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                '<div class="popup-row popup-row-muted">No feature info available</div>' +
              '</div>'
            );
            return;
          }

          if ('features' in result) {
            if (result.features.length === 0) {
              sections.push(
                '<div class="popup-section">' +
                  '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                  '<div class="popup-row popup-row-muted">No attributes at this location</div>' +
                '</div>'
              );
              return;
            }

            if (result.features.length === 1) {
              if (!collapsible) {
                sections.push(
                  '<div class="popup-section">' +
                    '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                    renderRows(result.features[0]) +
                  '</div>'
                );
              } else {
                sections.push(
                  '<div class="popup-section">' + renderFeatureBlock(name, result.features[0]) + '</div>'
                );
              }
              return;
            }

            // Several attributes sets from the same layer — one collapsible
            // block per feature.
            const blocks = result.features.map((props, index) =>
              renderFeatureBlock(name + ' \u2014 ' + (index + 1), props)
            );
            sections.push(
              '<div class="popup-section">' +
                '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                blocks.join('') +
              '</div>'
            );
            return;
          }

          // Raw (non-JSON) payload — show it verbatim.
          sections.push(
            '<div class="popup-section">' +
              '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
              '<pre class="popup-pre">' + escapeHtml(result.text) + '</pre>' +
            '</div>'
          );
        });
        return sections;
      };

      // Assemble the full popup HTML from vector hits + resolved WMS results,
      // choosing the collapsible layout based on the combined hit count.
      const buildPopup = (
        wmsResults: Array<{ name: string; result: WmsFeatureInfoResult | null }>
      ): string => {
        const wmsFeatureCount = wmsResults.reduce((count, r) => {
          const res = r.result;
          return res && 'features' in res ? count + res.features.length : count;
        }, 0);
        const collapsible = vectorFeatureCount + wmsFeatureCount > 1;
        return [...buildVectorSections(collapsible), ...buildWmsSections(wmsResults, collapsible)].join('');
      };

      // No WMS layers to query — render synchronously (original behaviour).
      if (wmsInfoLayers.length === 0) {
        setPopupContent(buildPopup([]));
        setPopupPosition(coordinate);
        return;
      }

      // WMS present — show what we already know (vector hits) plus a loading
      // indicator per WMS layer, then fill in results as they arrive.
      const loadingSections = wmsInfoLayers.map(({ name }) =>
        '<div class="popup-section">' +
          '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
          '<div class="popup-row popup-loading"><span class="popup-loading-spinner"></span>Querying feature info\u2026</div>' +
        '</div>'
      );
      setPopupContent([...buildVectorSections(vectorFeatureCount > 1), ...loadingSections].join(''));
      setPopupPosition(coordinate);

      Promise.all(
        wmsInfoLayers.map(async ({ name, olLayer }) => ({
          name,
          result: await fetchWmsFeatureInfo(olLayer, coordinate, map),
        }))
      ).then(wmsResults => {
        // A newer click has already taken over the popup — drop stale results.
        if (popupClickSeqRef.current !== clickSeq) return;
        setPopupContent(buildPopup(wmsResults));
        setPopupPosition(coordinate);
      }).catch(() => {
        // Defensive: never leave the popup stuck on the loading indicator.
        if (popupClickSeqRef.current !== clickSeq) return;
        setPopupContent(buildPopup([]));
        setPopupPosition(coordinate);
      });
    });

    map.on('moveend', () => updateUrlParams(mapview, workspaceId));

    // Restore layers from localStorage
    (async () => {
    const restoredRasterLayers: RasterLayer[] = [];
    for (const layerConfig of storedSettings.current.rasterLayers) {
      try {
        let olLayer: any;
        let extent: number[] | null = null;

        if (layerConfig.type === 'wmts') {
          const response = await fetch(layerConfig.wmtsCapabilitiesUrl || layerConfig.url);
          const text = await response.text();
          const parser = new WMTSCapabilities();
          const capabilities = parser.read(text);
          
          const wmtsOptions = optionsFromCapabilities(capabilities, {
            layer: layerConfig.wmtsLayer || '',
          });
          
          if (!wmtsOptions) {
            throw new Error('Failed to create WMTS options from capabilities');
          }
          
          extent = extractWmtsExtent(capabilities, layerConfig.wmtsLayer || '');
          olLayer = new TileLayer({
            source: createWmtsSource(wmtsOptions, layerConfig.minZoom, layerConfig.maxZoom),
          });
        } else if (layerConfig.type === 'wms') {
          // Fetch capabilities to extract extent
          try {
            const response = await fetch(layerConfig.wmsCapabilitiesUrl || layerConfig.url);
            const text = await response.text();
            const parser = new WMSCapabilities();
            const capabilities = parser.read(text);
            extent = extractWmsExtent(capabilities, layerConfig.wmsLayer || '');
          } catch (capError) {
            console.warn('Failed to fetch WMS capabilities for extent during restore:', capError);
          }

          olLayer = new ImageLayer({
            source: new ImageWMS({
              url: extractBaseUrl(layerConfig.wmsCapabilitiesUrl || layerConfig.url),
              params: { LAYERS: layerConfig.wmsLayer || '' },
              ratio: 1,
              serverType: 'geoserver',
            }),
          });
        } else if (layerConfig.type === 'cog') {
          const cogUrl = await resolveCogUrl(layerConfig);
          const cogResult = await createCogLayer(cogUrl);
          olLayer = cogResult.olLayer;
          extent = cogResult.extent;
        } else {
          olLayer = new TileLayer({
            source: createXYZSource(layerConfig.url, layerConfig.minZoom, layerConfig.maxZoom),
          });
        }

        olLayer.setVisible(layerConfig.visible !== false);
        map.addLayer(olLayer);
        rasterLayersRef.current.set(layerConfig.id, olLayer);
        // Apply saved color adjustments for restored layers
        if (layerConfig.brightness !== undefined || layerConfig.saturation !== undefined ||
            layerConfig.contrast !== undefined || layerConfig.opacity !== undefined) {
          const adjLayer = olLayer;
          map.once('rendercomplete', () => {
            applyColorAdjustments(adjLayer, {
              brightness: layerConfig.brightness,
              saturation: layerConfig.saturation,
              contrast: layerConfig.contrast,
              opacity: layerConfig.opacity,
            });
          });
        }
        restoredRasterLayers.push({ ...layerConfig, olLayer, ...(extent ? { extent } : {}) });
      } catch (error) {
        console.error('Failed to restore raster layer:', error);
      }
    }

    // Restore MVT vector layers from localStorage
    const restoredMvtLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'mvt')
      .forEach((layerConfig) => {
        try {
          const source = new VectorTileSource({
            format: new MVT(),
            url: layerConfig.url || '',
          });

          const olLayer = new VectorTileLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          wireVectorTileLoading(source, layerConfig.id);

          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          
          // Re-apply any persisted tile zoom range
          applyVectorLayerZoomRange(olLayer, 'mvt', layerConfig.minZoom, layerConfig.maxZoom);
          // Add to restored layers with OL layer reference
          restoredMvtLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore MVT layer:', error);
        }
      });
    // Restore WFS vector layers from localStorage
    const restoredWfsLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'wfs')
      .forEach((layerConfig) => {
        try {
          const wfsUrl = buildWfsUrl(layerConfig.url || '', layerConfig.wfsTypeName || '');
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: (extent: any, resolution: any, projection: any) => {
              markVectorLoading(layerConfig.id, true);
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(layerConfig.id, false);
                })
                .catch(e => {
                  console.error('WFS restore error:', e);
                  markVectorLoading(layerConfig.id, false);
                });
            },
          });
          const olLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          applyVectorLayerZoomRange(olLayer, 'wfs', layerConfig.minZoom, layerConfig.maxZoom);
          // Re-apply any persisted point clustering
          if (layerConfig.clusterPoints) {
            applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
          }
          // Re-apply any persisted attribute filter
          if (layerConfig.filterEnabled && layerConfig.filterExpression) {
            try { applyVectorFeatureFilter(olLayer, layerConfig.filterExpression); }
            catch (e) { console.warn('Failed to re-apply vector filter:', e); }
          }
          restoredWfsLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore WFS layer:', error);
        }
      });

    // Restore STAC vector layers from localStorage
    const restoredStacLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'stac')
      .forEach((layerConfig) => {
        try {
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: () => {
              markVectorLoading(layerConfig.id, true);
              fetchAllStacItems(layerConfig.url || '', layerConfig.stacCollection || '', layerConfig.stacLimit)
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(layerConfig.id, false);
                })
                .catch(e => {
                  console.error('STAC restore error:', e);
                  markVectorLoading(layerConfig.id, false);
                });
            },
          });
          const olLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          applyVectorLayerZoomRange(olLayer, 'stac', layerConfig.minZoom, layerConfig.maxZoom);
          // Re-apply any persisted point clustering
          if (layerConfig.clusterPoints) {
            applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
          }
          // Re-apply any persisted attribute filter
          if (layerConfig.filterEnabled && layerConfig.filterExpression) {
            try { applyVectorFeatureFilter(olLayer, layerConfig.filterExpression); }
            catch (e) { console.warn('Failed to re-apply vector filter:', e); }
          }
          restoredStacLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore STAC layer:', error);
        }
      });

    
    // Restore drawn-in-app vector layers from localStorage
    const restoredDrawnLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.isDrawnInApp && layer.drawnGeoJson)
      .forEach((layerConfig) => {
        try {
          const geojsonFormat = new GeoJSON();
          const features = geojsonFormat.readFeatures(layerConfig.drawnGeoJson, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
          });
          // Re-attach per-feature style/name and apply each feature's own style
          features.forEach((f: any, i: number) => {
            const meta = layerConfig.drawnFeatureMeta?.[i];
            if (meta) {
              f._drawStyle = meta.style;
              f._drawName = meta.name;
            }
            const ds = f._drawStyle || DEFAULT_DRAW_STYLE;
            applyDrawFeatureStyle(f, ds, () => unitsRef.current);
          });
          const source = new VectorSource({ features });
          const olLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          // Re-apply any persisted visibility zoom range
          applyVectorLayerZoomRange(olLayer, layerConfig.type, layerConfig.minZoom, layerConfig.maxZoom);
          // Re-apply any persisted point clustering
          if (layerConfig.clusterPoints) {
            applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
          }
          // Re-apply any persisted attribute filter
          if (layerConfig.filterEnabled && layerConfig.filterExpression) {
            try { applyVectorFeatureFilter(olLayer, layerConfig.filterExpression); }
            catch (e) { console.warn('Failed to re-apply vector filter:', e); }
          }
          restoredDrawnLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore drawn layer:', error);
        }
      });

    // Restore uploaded file vector layers (geojson/kml/kmz/shapefile) that were
    // serialized to inline GeoJSON, so they survive a workspace switch / reload.
    // They use the layer-level colours via buildVectorStyle (per-feature KML
    // styling is not round-tripped, but geometry and layer colours are).
    const restoredFileLayers: VectorLayerConfig[] = [];
    const fileLayersToRestore = storedSettings.current.vectorLayers
      .filter(layer => !layer.isDrawnInApp && FILE_VECTOR_TYPES.includes(layer.type) && (layer.geometryIdbKey || layer.drawnGeoJson));
    for (const layerConfig of fileLayersToRestore) {
      try {
        // Bulky geometry lives in IndexedDB; legacy/small layers may carry inline
        // drawnGeoJson. Awaited sequentially so the layers exist before setState.
        const geojson: string | undefined = layerConfig.geometryIdbKey
          ? await idbGetWithRetry(layerConfig.geometryIdbKey)
          : layerConfig.drawnGeoJson;
        if (!geojson) {
          console.warn('No persisted geometry found for file layer:', layerConfig.name);
          continue;
        }
        const features = new GeoJSON().readFeatures(geojson, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
        const source = new VectorSource({ features });
        const olLayer = new VectorLayer({
          source: source,
          style: buildVectorStyle(layerConfig),
          visible: layerConfig.visible !== false,
        });
        olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
        map.addLayer(olLayer);
        vectorLayersRef.current.set(layerConfig.id, olLayer);
        applyVectorLayerZoomRange(olLayer, layerConfig.type, layerConfig.minZoom, layerConfig.maxZoom);
        if (layerConfig.clusterPoints) {
          applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
        }
        // Re-apply any persisted attribute filter
        if (layerConfig.filterEnabled && layerConfig.filterExpression) {
          try { applyVectorFeatureFilter(olLayer, layerConfig.filterExpression); }
          catch (e) { console.warn('Failed to re-apply vector filter:', e); }
        }
        restoredFileLayers.push({ ...layerConfig, olLayer });
      } catch (error) {
        console.error('Failed to restore file layer:', error);
      }
    }

    // Set state with all restored layers
    const restoredVectorLayers = [...restoredMvtLayers, ...restoredWfsLayers, ...restoredStacLayers, ...restoredDrawnLayers, ...restoredFileLayers];
    setRasterLayers(restoredRasterLayers);
    setVectorLayers(restoredVectorLayers);
    if (restoredRasterLayers.length > 0 || restoredVectorLayers.length > 0) {
      reorderLayers(map, restoredRasterLayers, restoredVectorLayers);
    }
    setIsRestoringLayers(false);
    })();

    // Session-wide undo/redo shortcuts — Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and
    // Ctrl/Cmd+Y — ignored while typing in a field.
    const handleHistoryKeys = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (k === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };

    // Delete removes the picked-up vertex (or its whole label feature);
    // Escape puts it back where it was picked up.
    const handleEditKeys = (e: KeyboardEvent) => {
      if (!stickyVertexRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteStickyTarget();
      } else if (e.key === 'Escape') {
        cancelStickyVertex();
      }
    };
    window.addEventListener('keydown', handleEditKeys);
    window.addEventListener('keydown', handleHistoryKeys);

    return () => {
      window.removeEventListener('keydown', handleEditKeys);
      window.removeEventListener('keydown', handleHistoryKeys);
      if (zoomRef.current) {
        zoomRef.current.innerHTML = '';
      }
      if (attributionRef.current) {
        attributionRef.current.innerHTML = '';
      }
      if (popupOverlayRef.current) {
        map.removeOverlay(popupOverlayRef.current);
        popupOverlayRef.current = null;
      }
      map.setTarget(undefined);
    };
  }, []);

  // Latest serializable snapshot, kept in a ref so the unmount-only flush
  // below always persists the final state without re-running on every change.
  const latestSettingsRef = useRef<StoredSettings | null>(null);
  useEffect(() => {
    const snapshot = { settingsPinned, showBasemap, basemapUrl, basemapMinZoom, basemapMaxZoom, units, showGrid, showDrawToolbar, showCoordinates, rasterLayers, rasterGroups, vectorLayers, vectorGroups };
    latestSettingsRef.current = snapshot;
    saveSettings(snapshot, workspaceId);
  }, [settingsPinned, showBasemap, basemapUrl, basemapMinZoom, basemapMaxZoom, units, showGrid, showDrawToolbar, showCoordinates, rasterLayers, rasterGroups, vectorLayers, vectorGroups, workspaceId]);

  // Flush once more on unmount (i.e. when switching workspaces) so the
  // outgoing workspace's storage always reflects its last committed state.
  // workspaceId is stable for the lifetime of this mount (remount via key).
  useEffect(() => {
    return () => {
      // Skip persisting when the app is locking: the vault already contains
      // the encrypted snapshot and plaintext keys must stay cleared.
      if (hasLockedVault()) return;
      if (latestSettingsRef.current) {
        saveSettings(latestSettingsRef.current, workspaceId);
      }
      // Flush the active draw session too so switching workspaces preserves it.
      saveDrawSession(drawSourceRef.current, workspaceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active draw session whenever it changes so a full reload (not
  // just a workspace switch) restores in-progress drawing as well. The session
  // is read from the live source, which always reflects the latest geometry.
  useEffect(() => {
    saveDrawSession(drawSourceRef.current, workspaceId);
  }, [drawnFeatures, measureTick, workspaceId]);

  // Warn before leaving the page when session-only file COG layers are loaded.
  const hasFileCogLayers = rasterLayers.some(l => l.type === 'cog' && l.cogSource === 'file');
  useEffect(() => {
    if (!hasFileCogLayers) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasFileCogLayers]);

  // Keep the GetFeatureInfo-enabled WMS layer list in sync with rasterLayers so
  // the once-registered map click handler always sees the current toggle state.
  useEffect(() => {
    wmsFeatureInfoRef.current = rasterLayers
      .filter(l => l.type === 'wms' && l.wmsFeatureInfoEnabled && l.olLayer)
      .map(l => ({ id: l.id, name: l.name, olLayer: l.olLayer }));
  }, [rasterLayers]);

  // Close the Settings panel when the user clicks anywhere outside of it,
  // unless it has been pinned open with the pin button in its header.
  useEffect(() => {
    if (!showSettings || settingsPinned) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // Clicks inside the wrapper (dialog + gear button) have their own handlers
      if (settingsWrapperRef.current && settingsWrapperRef.current.contains(target)) return;
      // Keep Settings open while the Advanced Settings overlay (opened from it) is in use
      if (target.closest('.advanced-settings-overlay')) return;
      // CustomSelect dropdowns render their menus in a portal on document.body,
      // so the menu lives outside the wrapper even when the select itself is
      // inside the Settings dialog — don't treat clicks on it as outside clicks.
      if (target.closest('.custom-select-menu-portal')) return;
      // The lock icon's right-click password menu is likewise portaled to body.
      if (target.closest('.lock-context-menu')) return;
      // As is the vector layer's grouped Download format menu.
      if (target.closest('.settings-export-menu')) return;
      // The Set/Reset-password dialogs render as full-window overlays outside
      // the wrapper (opened from the Settings footer) - keep Settings open while
      // the user interacts with them. The lock overlay is excluded for symmetry.
      if (target.closest('.setpw-overlay') || target.closest('.lock-overlay')) return;
      setShowSettings(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [showSettings, settingsPinned]);

  // Update popup position and content
  useEffect(() => {
    if (popupOverlayRef.current && popupPosition && popupContent) {
      popupOverlayRef.current.setPosition(popupPosition);
      if (popupRef.current) {
        // Must be 'flex' (not 'block'): the popup is a flex column so the
        // content scrolls while the Collapse/Show-all footer stays pinned to
        // the bottom. An inline 'block' would override the stylesheet and let
        // a tall content area push the footer out of the clipped popup.
        popupRef.current.style.display = 'flex';
        const contentDiv = popupRef.current.querySelector('.popup-content');
        if (contentDiv) {
          contentDiv.innerHTML = popupContent;
        }
        // Collapse/Show-all footer only applies to multi-feature popups.
        const footer = popupRef.current.querySelector('.popup-footer') as HTMLElement | null;
        if (footer) {
          const isMulti = !!(contentDiv && contentDiv.querySelector('.popup-feature'));
          footer.style.display = isMulti ? 'flex' : 'none';
        }
      }
    } else if (popupOverlayRef.current) {
      popupOverlayRef.current.setPosition(undefined);
      if (popupRef.current) {
        popupRef.current.style.display = 'none';
      }
    }
  }, [popupPosition, popupContent]);

  useEffect(() => {
    if (!mapRef.current) return;

    if (showGrid) {
      const gridLayer = new TileLayer({
        source: new TileDebug(),
      });
      mapRef.current.addLayer(gridLayer);
      gridLayerRef.current = gridLayer;
      reorderLayers(mapRef.current, rasterLayers, vectorLayers);
    } else {
      if (gridLayerRef.current) {
        mapRef.current.removeLayer(gridLayerRef.current);
        gridLayerRef.current = null;
      }
    }
  }, [showGrid]);

  useEffect(() => {
    if (basemapLayerRef.current) {
      basemapLayerRef.current.setVisible(showBasemap);
    }
  }, [showBasemap]);

  // Swap the basemap tile source live when the user edits the basemap URL
  useEffect(() => {
    if (!basemapLayerRef.current) return;
    const key = basemapSourceKey(basemapUrl, basemapMinZoom, basemapMaxZoom);
    if (appliedBasemapKeyRef.current === key) return;
    appliedBasemapKeyRef.current = key;
    basemapLayerRef.current.setSource(createBasemapSource(basemapUrl, basemapMinZoom, basemapMaxZoom));
  }, [basemapUrl, basemapMinZoom, basemapMaxZoom]);

  // Keep the draw-mode ref in sync so the map click handler always sees the
  // current tool (the handler is registered once and can't read state directly).
  useEffect(() => {
    activeDrawToolRef.current = activeDrawTool;
  }, [activeDrawTool]);

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
    const editSession = activeDrawTool === 'modify' || editingVectorLayerId !== null;
    if (doubleClickZoomRef.current) {
      doubleClickZoomRef.current.setActive(!editSession);
    }
  }, [activeDrawTool, editingVectorLayerId]);

  // Keep the OL-layer → display-name map in sync so popup sections can be
  // labelled with the current vector layer names.
  useEffect(() => {
    const names = new Map<any, string>();
    vectorLayers.forEach(cfg => {
      if (cfg.olLayer) names.set(cfg.olLayer, cfg.name);
    });
    vectorLayerNamesRef.current = names;
  }, [vectorLayers]);

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
        if (modifyInteractionRef.current && mapRef.current) {
          mapRef.current.removeInteraction(modifyInteractionRef.current);
          modifyInteractionRef.current = null;
        }
        if (drawTranslateRef.current && mapRef.current) {
          mapRef.current.removeInteraction(drawTranslateRef.current);
          drawTranslateRef.current = null;
        }
        if (stickyVertexRef.current) {
          exitStickyVertex();
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

  /** Apply a new tile zoom range live (XYZ: swap source; WMTS: clamp the matrix grid). */
  const handleApplyTileZoomRange = (layerId: string, minZoom?: number, maxZoom?: number) => {
    const layer = rasterLayers.find(l => l.id === layerId);
    const olLayer = rasterLayersRef.current.get(layerId);
    if (!layer || !olLayer) return;
    if (layer.type === 'xyz') {
      olLayer.setSource(createXYZSource(layer.url, minZoom, maxZoom));
    } else if (layer.type === 'wmts') {
      const grid: any = olLayer.getSource()?.getTileGrid?.();
      if (!grid) return;
      // Remember the native matrix range so clearing the fields restores it
      if (!olLayer._nativeTileZoomRange) {
        olLayer._nativeTileZoomRange = { min: grid.getMinZoom(), max: grid.getMaxZoom() };
      }
      const native = olLayer._nativeTileZoomRange;
      grid.minZoom = minZoom !== undefined ? Math.max(native.min, Math.min(minZoom, native.max)) : native.min;
      grid.maxZoom = maxZoom !== undefined ? Math.min(native.max, Math.max(maxZoom, grid.minZoom)) : native.max;
      if (grid.minZoom > grid.maxZoom) grid.minZoom = grid.maxZoom;
      olLayer.changed();
    } else {
      return;
    }
    setRasterLayers(prev => prev.map(l => (l.id === layerId ? { ...l, minZoom, maxZoom } : l)));
  };


  /**
   * Create an OpenLayers WebGLTile layer from a COG URL.
   * The GeoTIFF source streams only the tiles/overviews needed for the
   * current view, making it efficient for very large rasters.
   *
   * Returns the layer and, once the source metadata has loaded, the extent
   * transformed to EPSG:3857. If the GeoTIFF uses a projection that proj4
   * does not yet know about, it is fetched from epsg.io and registered
   * automatically so the raster is reprojected correctly on the map.
   */
  const createCogLayer = async (url: string): Promise<{ olLayer: any; extent: number[] | null }> => {
    const source = new GeoTIFFSource({
      sources: [{ url }],
    });
    // The style exposes exposure/contrast/saturation as GPU variables so the
    // colour sliders work on WebGL-rendered COGs (CSS filters cannot affect
    // them). See createCogTileStyle/applyColorAdjustments in layerHelpers.
    const olLayer = new WebGLTileLayer({ source, style: createCogTileStyle() });

    // Wait for the source to finish loading its metadata (projection, extent,
    // tile grid). The source transitions from 'loading' to 'ready' (or 'error').
    await new Promise<void>((resolve, reject) => {
      const wrapError = (raw: any) => {
        const msg = raw?.message || String(raw);
        // Detect likely CORS or network failures from the geotiff fetch
        if (/failed to fetch|networkerror|load failed|cors|access-control/i.test(msg)) {
          return new Error(
            'Could not load the GeoTIFF — the server blocked the cross-origin request (CORS).\n\n' +
            'For S3 buckets, add this CORS configuration in the bucket Permissions tab:\n\n' +
            '  [ { "AllowedHeaders": ["*"], "AllowedMethods": ["GET", "HEAD"],\n' +
            '      "AllowedOrigins": ["*"],\n' +
            '      "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"] } ]\n\n' +
            'For other object storage (MinIO, R2, etc.), enable equivalent CORS rules.\n' +
            'Original error: ' + msg
          );





        }
        return raw instanceof Error ? raw : new Error(msg);
      };
      if (source.getState() === 'ready') { resolve(); return; }
      if (source.getState() === 'error') { reject(wrapError(source.getError())); return; }
      const onChange = () => {
        const state = source.getState();
        if (state === 'ready') { resolve(); }
        else if (state === 'error') { reject(wrapError(source.getError())); }
      };
      source.on('change', onChange);
    });











    // --- Register the source projection if it is not already known ---
    const srcProj = source.getProjection();
    let extent3857: number[] | null = null;

    if (srcProj) {
      const code: string = srcProj.getCode ? srcProj.getCode() : String(srcProj);
      const epsgMatch = code.match(/EPSG:(\d+)/i);

      if (epsgMatch) {
        const epsgNum = epsgMatch[1];
        // Ensure proj4 knows this projection so OL can transform coordinates
        if (!getOlProjection(code)) {
          try {
            await registerProjectionFromEPSGCode(epsgNum);
          } catch (e) {
            console.warn(`[COG] Could not register projection ${code}:`, e);
          }
        }
      }

      // --- Extract the extent and transform to EPSG:3857 ---
      try {
        const tileGrid = source.getTileGrid?.();
        const rawExtent: number[] | undefined = tileGrid?.getExtent?.();
        if (rawExtent && rawExtent.length === 4 && rawExtent.every(isFinite)) {
          const resolvedProj = getOlProjection(code) || srcProj;
          if (code === 'EPSG:3857') {
            extent3857 = rawExtent.slice();
          } else {
            try {
              extent3857 = transformExtent(rawExtent, resolvedProj, 'EPSG:3857');
            } catch (e) {
              console.warn('[COG] Failed to transform extent to EPSG:3857:', e);
            }
          }
        }
      } catch (e) {
        console.warn('[COG] Failed to read extent from GeoTIFF source:', e);
      }
    }

    return { olLayer, extent: extent3857 };
  };

  /**
   * Resolve the effective URL for a COG layer config:
   * - file: recreate blob URL from IndexedDB bytes
   * - s3: pre-sign (with credentials) or build public HTTPS URL
   * - http: use the URL as-is
   */
  const resolveCogUrl = async (layerConfig: RasterLayer): Promise<string> => {
    if (layerConfig.cogSource === 'file') {
      // File-sourced COGs are session-only (not persisted to avoid huge IndexedDB usage).
      throw new Error('File-based COG layers are not persisted. Please re-add the file.');
    }
    if (layerConfig.cogSource === 's3') {
      const s3: S3Config = {
        bucket: layerConfig.cogBucket || '',
        objectKey: layerConfig.cogObjectKey || '',
        region: layerConfig.cogRegion,
        endpoint: layerConfig.cogEndpoint,
        accessKeyId: layerConfig.cogAccessKeyId,
        secretAccessKey: layerConfig.cogSecretAccessKey,
        sessionToken: layerConfig.cogSessionToken,
      };
      const url = await resolveS3CogUrl(s3);
      return url;
    }
    return layerConfig.url;



  };

  const handleEditRasterLayer = async (updated: RasterLayer) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      mapRef.current.removeLayer(olLayer);
      let newOlLayer: any;
      let extent: number[] | null = null;

      if (updated.type === 'wmts') {
        const response = await fetch(updated.wmtsCapabilitiesUrl || updated.url);
        const text = await response.text();
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        
        const wmtsOptions = optionsFromCapabilities(capabilities, {
          layer: updated.wmtsLayer || '',
        });
        
        if (!wmtsOptions) {
          throw new Error('Failed to create WMTS options from capabilities');
        }
        
        extent = extractWmtsExtent(capabilities, updated.wmtsLayer || '');
        newOlLayer = new TileLayer({
          source: createWmtsSource(wmtsOptions, updated.minZoom, updated.maxZoom),
        });
      } else if (updated.type === 'wms') {
        // Fetch capabilities to extract extent
        try {
          const response = await fetch(updated.wmsCapabilitiesUrl || updated.url);
          const text = await response.text();
          const parser = new WMSCapabilities();
          const capabilities = parser.read(text);
          extent = extractWmsExtent(capabilities, updated.wmsLayer || '');
        } catch (capError) {
          console.warn('Failed to fetch WMS capabilities for extent:', capError);
        }

        newOlLayer = new ImageLayer({
          source: new ImageWMS({
            url: extractBaseUrl(updated.wmsCapabilitiesUrl || updated.url),
            params: { LAYERS: updated.wmsLayer || '' },
            ratio: 1,
            serverType: 'geoserver',
          }),
        });
      } else if (updated.type === 'cog') {
        const cogUrl = await resolveCogUrl(updated);
        const cogResult = await createCogLayer(cogUrl);
        newOlLayer = cogResult.olLayer;
        extent = cogResult.extent;
      } else {
        newOlLayer = new TileLayer({
          source: createXYZSource(updated.url, updated.minZoom, updated.maxZoom),
        });
      }

      // Preserve the layer's current visibility: recreating the OL layer resets
      // it to visible, which would make a toggled-off layer reappear on apply.
      newOlLayer.setVisible(updated.visible !== false);

      mapRef.current.addLayer(newOlLayer);
      rasterLayersRef.current.set(updated.id, newOlLayer);
      const updatedWithRef = { ...updated, olLayer: newOlLayer, ...(extent ? { extent } : {}) };
      const newRasterLayers = rasterLayers.map(l => l.id === updated.id ? updatedWithRef : l);
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);

      // Re-apply color adjustments after layer recreation
      if (updated.brightness !== undefined || updated.saturation !== undefined ||
          updated.contrast !== undefined || updated.opacity !== undefined) {
        mapRef.current.once('rendercomplete', () => {
          applyColorAdjustments(newOlLayer, {
            brightness: updated.brightness,
            saturation: updated.saturation,
            contrast: updated.contrast,
            opacity: updated.opacity,
          });
        });
      }
    } catch (error) {
      console.error('Failed to edit raster layer:', error);
    }
  };

  const handleAddVectorLayer = async (file: File, layerName?: string) => {
    if (!mapRef.current) return;

    const fileName = file.name;
    const extension = fileName.split('.').pop()?.toLowerCase();
    
    if (!extension) {
      alert('Invalid file format');
      return;
    }

    let layerType: VectorLayerConfig['type'];
    let features: any[] = [];

    try {
      if (extension === 'geojson' || extension === 'json') {
        layerType = 'geojson';
        const text = await file.text();
        const geojsonData = JSON.parse(text);
        const format = new GeoJSON();
        
        // Check for CRS property in GeoJSON and register projection
        let dataProjection: string | Projection = 'EPSG:4326';
        if (geojsonData.crs) {
          const crsName = geojsonData.crs.properties?.name;
          if (crsName) {
            // Extract EPSG code from CRS name like "urn:ogc:def:crs:EPSG::4326"
            const epsgMatch = crsName.match(/EPSG::?(\d+)/);
            if (epsgMatch) {
              const epsgCode = epsgMatch[1];
              if (epsgCode !== '4326') {
                const registeredId = await registerProjectionFromEPSGCode(epsgCode);
                if (registeredId) {
                  dataProjection = registeredId;
                }
              }
            }
          }
        }
        
        features = format.readFeatures(text, {
          dataProjection: dataProjection,
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'kml') {
        layerType = 'kml';
        const text = await file.text();
        const format = new KML({
          extractStyles: true,
        });
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'kmz') {
        layerType = 'kmz';
        const zip = await JSZip.loadAsync(file);
        const kmlFile = Object.keys(zip.files).find(f => f.endsWith('.kml'));
        if (!kmlFile) {
          alert('No KML file found in KMZ archive');
          return;
        }
        const text = await zip.files[kmlFile].async('text');
        const format = new KML({
          extractStyles: true,
        });
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'zip') {
        layerType = 'shapefile';
        const shapefileResult = await parseShapefile(file);
        if (shapefileResult.features.length === 0) {
          alert('No features found in the shapefile');
          return;
        }

        // Register projection from .prj file if present
        let dataProjection: string | Projection = 'EPSG:4326';
        if (shapefileResult.projectionWKT) {
          const registeredId = await registerProjectionFromWKT(shapefileResult.projectionWKT);
          if (registeredId) {
            dataProjection = registeredId;
          }
        }

        // Debug: Log WKT projection
        console.log('=== SHAPEFILE DEBUG ===');
        console.log('[1] WKT from .prj file:', shapefileResult.projectionWKT);
        console.log('[2] Feature count:', shapefileResult.features.length);

        // Debug: Log source coordinates before transformation
        if (shapefileResult.features.length > 0) {
          const firstFeature = shapefileResult.features[0];
          const firstGeom = firstFeature.geometry;
          console.log('[3] First feature geometry type:', firstGeom.type);
          
          // Get coordinates based on geometry type
          let sourceCoords: any = null;
          if (firstGeom.type === 'Polygon') {
            sourceCoords = firstGeom.coordinates[0].slice(0, 5); // First 5 points of outer ring
          } else if (firstGeom.type === 'MultiPolygon') {
            sourceCoords = firstGeom.coordinates[0][0].slice(0, 5);
          } else if (firstGeom.type === 'LineString') {
            sourceCoords = firstGeom.coordinates.slice(0, 5);
          } else if (firstGeom.type === 'MultiLineString') {
            sourceCoords = firstGeom.coordinates[0].slice(0, 5);
          } else if (firstGeom.type === 'Point') {
            sourceCoords = firstGeom.coordinates;
          } else if (firstGeom.type === 'MultiPoint') {
            sourceCoords = firstGeom.coordinates.slice(0, 5);
          }
          console.log('[4] Source coordinates (from shapefile):', sourceCoords);
        }

        console.log('[5] dataProjection before readFeatures:', dataProjection);

        const geojsonFormat = new GeoJSON();
        features = geojsonFormat.readFeatures({
          type: 'FeatureCollection',
          features: shapefileResult.features
        }, {
          dataProjection: dataProjection,
          featureProjection: 'EPSG:3857',
        });

        // Debug: Log transformed coordinates
        if (features.length > 0) {
          const firstFeature = features[0];
          const geom = firstFeature.getGeometry();
          if (geom) {
            console.log('[6] OL geometry type:', geom.getType());
            const coords = geom.getCoordinates();
            
            // Get coordinates based on geometry type
            let transformedCoords: any = null;
            if (geom.getType() === 'Polygon') {
              transformedCoords = coords[0].slice(0, 5); // First 5 points of outer ring
            } else if (geom.getType() === 'MultiPolygon') {
              transformedCoords = coords[0][0].slice(0, 5);
            } else if (geom.getType() === 'LineString') {
              transformedCoords = coords.slice(0, 5);
            } else if (geom.getType() === 'MultiLineString') {
              transformedCoords = coords[0].slice(0, 5);
            } else if (geom.getType() === 'Point') {
              transformedCoords = coords;
            } else if (geom.getType() === 'MultiPoint') {
              transformedCoords = coords.slice(0, 5);
            }
            console.log('[7] Transformed coordinates (EPSG:3857):', transformedCoords);
            
            // Get extent
            const extent = geom.getExtent();
            console.log('[8] Feature extent (EPSG:3857):', extent);
          }
        }
        console.log('=== END SHAPEFILE DEBUG ===');
      } else {
        alert(`Unsupported file format: .${extension}`);
        return;
      }

      if (features.length === 0) {
        alert('No features found in the file');
        return;
      }

      const source = new VectorSource({
        features: features,
      });


      // Check if features have their own styles (KML/KMZ with extractStyles)
      const hasOwnStyles = features.some(f => f.getStyle && f.getStyle() !== null);

      // Start from a random color, then prefer the file's own style colors so the
      // color editor reflects the layer's actual appearance on the map.
      const randomColors = getRandomVectorColors();
      let lineColor = randomColors.lineColor;
      let fillColor = randomColors.fillColor;
      let lineWidth = 2;
      if (hasOwnStyles) {
        const styled = features.find(f => f.getStyle && f.getStyle());
        let st: any = styled && styled.getStyle();
        if (Array.isArray(st)) st = st[0];
        if (st && typeof st.getStroke === 'function') {
          const stroke = st.getStroke();
          const fill = st.getFill();
          if (stroke && stroke.getColor() != null) {
            lineColor = normalizeOlColor(stroke.getColor(), 1);
            if (stroke.getWidth() != null) lineWidth = stroke.getWidth();
          }
          if (fill && fill.getColor() != null) {
            fillColor = normalizeOlColor(fill.getColor(), 0.3);
          }
        }
      }

      const olLayer = new VectorLayer({
        source: source,
        style: hasOwnStyles ? undefined : buildVectorStyle({ lineColor, fillColor, lineWidth }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: layerName && layerName.trim() ? layerName.trim() : fileName.replace(/\.(geojson|json|kml|kmz|zip)$/i, ''),
        type: layerType!,
        visible: true,
        opacity: 100,
        lineColor,
        lineWidth,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer };
      setVectorLayers(prev => [...prev, layerConfigWithRef]);

      // Fit map to features extent
      const extent = source.getExtent();
      if (extent && extent.every(v => isFinite(v))) {
        mapRef.current.getView().fit(extent, {
          padding: [50, 50, 50, 50],
          maxZoom: 18,
        });
      }
    } catch (error) {
      console.error('Failed to load vector layer:', error);
      alert(`Failed to load "${fileName}". The file may be corrupted or in an unsupported format.`);
    }
  };

  const handleAddMVTLayer = async (url: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const layerId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      const source = new VectorTileSource({
        format: new MVT(),
        url: url,
      });

      const { lineColor, fillColor } = getRandomVectorColors();

      const olLayer = new VectorTileLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });
      wireVectorTileLoading(source, layerId);

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: layerId,
        name: name,
        type: 'mvt',
        visible: true,
        olLayer: olLayer,
        url: url,
        opacity: 100,
        lineColor,
        lineWidth: 2,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);

      // Reorder layers
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load MVT layer:', error);
      alert(`Failed to load MVT layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleAddWFSLayer = async (url: string, typeName: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const layerId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      const wfsUrl = buildWfsUrl(url, typeName);
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: (extent: any, resolution: any, projection: any) => {
          markVectorLoading(layerId, true);
          fetch(wfsUrl)
            .then(r => {
              if (!r.ok) throw new Error('WFS request failed: ' + r.status);
              return r.json();
            })
            .then(data => {
              const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
              source.addFeatures(features);
              markVectorLoading(layerId, false);
            })
            .catch(e => {
              console.error('WFS load error:', e);
              markVectorLoading(layerId, false);
              alert('Failed to load WFS features. Check the URL and type name.');
            });
        },
      });

      const olLayer = new VectorLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: layerId,
        name: name,
        type: 'wfs',
        visible: true,
        olLayer: olLayer,
        url: url,
        wfsTypeName: typeName,
        opacity: 100,
        lineColor,
        lineWidth: 2,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load WFS layer:', error);
      alert(`Failed to load WFS layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleAddSTACLayer = async (url: string, collection: string, name: string, limit?: number) => {
    if (!mapRef.current) return;

    try {
      const layerId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: () => {
          markVectorLoading(layerId, true);
          fetchAllStacItems(url, collection, limit)
            .then(data => {
              const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
              source.addFeatures(features);
              markVectorLoading(layerId, false);
            })
            .catch(e => {
              console.error('STAC load error:', e);
              markVectorLoading(layerId, false);
              alert('Failed to load STAC data. Check the URL' + (collection ? ' and collection ID.' : '.'));
            });
        },
      });

      const olLayer = new VectorLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: layerId,
        name: name,
        type: 'stac',
        visible: true,
        olLayer: olLayer,
        url: url,
        stacCollection: collection,
        stacLimit: limit,
        opacity: 100,
        lineColor,
        lineWidth: 2,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load STAC layer:', error);
      alert(`Failed to load STAC layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleToggleVectorLayer = (id: string) => {
    const olLayer = vectorLayersRef.current.get(id);
    if (!olLayer) return;

    setVectorLayers(prev =>
      prev.map(l => {
        if (l.id === id) {
          const newVisible = !l.visible;
          olLayer.setVisible(newVisible);
          return { ...l, visible: newVisible };
        }
        return l;
      })
    );
  };

  // Re-edit the geometry of a saved drawn-in-app layer in place: a Modify
  // interaction on the layer's own source gives the same affordances as the
  // draw toolbar's edit tool — drag vertices, click a segment to insert one,
  // Alt+click a vertex to remove it. Because persistence serialises the live
  // source, edits are reflected in the next session automatically. Clicking
  // the button again (or removing the layer) ends the session.
  const handleReeditVectorLayer = (layerId: string) => {
    const map = mapRef.current;
    if (!map) return;

    // Clicking again on the layer being edited finishes the session.
    if (editingVectorLayerId === layerId) {
      editingVectorLayerIdRef.current = null;
      if (stickyVertexRef.current) exitStickyVertex();
      if (layerModifyInteractionRef.current) {
        map.removeInteraction(layerModifyInteractionRef.current);
        layerModifyInteractionRef.current = null;
      }
      if (layerTranslateRef.current) {
        map.removeInteraction(layerTranslateRef.current);
        layerTranslateRef.current = null;
      }
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
    if (modifyInteractionRef.current) {
      map.removeInteraction(modifyInteractionRef.current);
      modifyInteractionRef.current = null;
    }
    if (drawTranslateRef.current) {
      map.removeInteraction(drawTranslateRef.current);
      drawTranslateRef.current = null;
    }
    if (activeDrawTool !== null) {
      setActiveDrawTool(null);
    }

    // Move an ongoing re-edit session to the newly chosen layer — each
    // layer gets a fresh undo history.
    if (stickyVertexRef.current) exitStickyVertex();
    layerHistoryRef.current = { stack: [], index: -1 };
    if (layerModifyInteractionRef.current) {
      map.removeInteraction(layerModifyInteractionRef.current);
      layerModifyInteractionRef.current = null;
    }
    if (layerTranslateRef.current) {
      map.removeInteraction(layerTranslateRef.current);
      layerTranslateRef.current = null;
    }

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

    const modifyInteraction = new Modify({
      source: source,
      pixelTolerance: 12,
      // Segment clicks are owned by handleEditClick (insert + pick up);
      // drags elsewhere fall through to the whole-feature Translate below.
      insertVertexCondition: () => false,
      // Reads the ref so a restyle via Apply recolours the handles live.
      style: () => buildModifyVertexStyle(editAccentRef.current),
    });

    // Refresh the per-feature length/area readouts in the layer's edit menu
    // once each edit settles (on-map chips already update live via each
    // feature's style function) — and record the edit as a history step.
    modifyInteraction.on('modifyend', () => {
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
    });

    // Drag anywhere on a feature that is not a vertex moves the whole thing.
    const translateInteraction = new Translate({
      layers: [olLayer as any],
      hitTolerance: 6,
      condition: (evt) =>
        primaryAction(evt) &&
        !stickyVertexRef.current &&
        !findNearestVertex(map, source, evt.pixel as number[], 12),
    });
    translateInteraction.on('translateend', () => {
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
    });

    map.addInteraction(modifyInteraction);
    map.addInteraction(translateInteraction);
    layerModifyInteractionRef.current = modifyInteraction;
    layerTranslateRef.current = translateInteraction;
    // Switch the session over, then open the layer's undo history with its
    // current state as the baseline step.
    editingVectorLayerIdRef.current = layerId;
    setEditingVectorLayerId(layerId);
    layerHistoryRef.current = { stack: [], index: -1 };
    pushHistorySnapshot();
  };

  const handleRemoveVectorLayer = (id: string) => {
    if (!mapRef.current) return;

    // Removing a layer ends its re-edit session, if any.
    if (editingVectorLayerId === id) {
      editingVectorLayerIdRef.current = null;
      if (stickyVertexRef.current) exitStickyVertex();
      if (layerModifyInteractionRef.current) {
        mapRef.current.removeInteraction(layerModifyInteractionRef.current);
        layerModifyInteractionRef.current = null;
      }
      if (layerTranslateRef.current) {
        mapRef.current.removeInteraction(layerTranslateRef.current);
        layerTranslateRef.current = null;
      }
      setEditingVectorLayerId(null);
      layerHistoryRef.current = { stack: [], index: -1 };
      syncHistoryDepth();
    }

    const olLayer = vectorLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      vectorLayersRef.current.delete(id);
    }


    // Remove the bulky geometry blob from IndexedDB (file-uploaded layers).
    const removed = vectorLayers.find(l => l.id === id);
    if (removed?.geometryIdbKey) void idbDelete(removed.geometryIdbKey);

    const newLayers = vectorLayers.filter(l => l.id !== id);
    setVectorLayers(newLayers);
    // Anchor any group that just lost its last member so the empty folder
    // stays at its current panel position.
    const ga = anchorEmptiedGroups(vectorLayers, newLayers, vectorGroups);
    if (ga) setVectorGroups(ga);
  };

  const buildVectorStyle = (styleConfig: { lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number; clusterPoints?: boolean }) => {
    const lineWidth = styleConfig.lineWidth ?? 2;
    // Colors are stored as rgba strings; parseColor also accepts legacy hex.
    const line = rgbaToString(parseColor(styleConfig.lineColor, 1));
    const fill = rgbaToString(parseColor(styleConfig.fillColor, 0.3));
    const fontColor = rgbaToString(parseColor(styleConfig.fontColor, 1));
    const fontSize = styleConfig.fontSize ?? 14;
    const clustered = styleConfig.clusterPoints === true;

    // Return a per-feature style function so features carrying a label
    // (e.g. drawn features saved to a layer) render their text too.
    return (feature: any) => {
      // Clustered layers render aggregate bubbles for groups of points. The
      // Cluster source tags each generated feature with a `features` array of
      // the original points it swallowed.
      if (clustered && feature && feature.get) {
        const members = feature.get('features');
        if (Array.isArray(members) && members.length > 1) {
          const count = members.length;
          // Bubble grows with the cluster size, capped so huge clusters stay readable.
          const radius = 9 + Math.min(14, Math.round(Math.sqrt(count) * 1.6));
          return new Style({
            image: new CircleStyle({
              radius,
              fill: new Fill({ color: line }),
              stroke: new Stroke({ color: '#fff', width: 2.5 }),
            }),
            text: new Text({
              text: count > 999 ? (count / 1000).toFixed(1) + 'k' : String(count),
              font: 'bold ' + Math.max(11, Math.min(14, radius - 2)) + 'px Arial',
              fill: new Fill({ color: '#fff' }),
            }),
          });
        }
      }
      const labelText = feature && feature.get ? feature.get('labelText') : undefined;
      const base = {
        fill: new Fill({ color: fill }),
        stroke: new Stroke({ color: line, width: lineWidth }),
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: line }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
        }),
      };
      if (labelText) {
        return new Style({
          ...base,
          text: new Text({
            text: labelText,
            font: fontSize + 'px Arial',
            fill: new Fill({ color: fontColor }),
            stroke: new Stroke({ color: '#fff', width: 3 }),
            offsetY: -15,
          }),
        });
      }
      return new Style(base);
    };
  };

  // Apply a style to a vector layer. KML/KMZ features carry their own styles which
  // take precedence over the layer style in OpenLayers, so we clear those per-feature
  // styles (once) to let the chosen layer style take effect.
  const applyVectorStyleToLayer = (olLayer: any, styleConfig: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    if (styleConfig.opacity !== undefined) {
      olLayer.setOpacity(styleConfig.opacity / 100);
    }
    // If the layer is currently clustered, the style must render cluster
    // bubbles - detect it from the live source so the style always matches.
    const currentSource = olLayer.getSource && olLayer.getSource();
    const isClustered = currentSource instanceof Cluster;
    olLayer.setStyle(buildVectorStyle({ ...styleConfig, clusterPoints: isClustered }));

    // Per-feature style overrides live on the *raw* source, not the cluster
    // wrapper, so look through the Cluster source when present.
    const source = isClustered && currentSource.getSource ? currentSource.getSource() : currentSource;
    if (source && typeof source.getFeatures === 'function') {
      // Only defined DrawStyle fields override the stored per-feature style.
      const defined: Partial<DrawStyle> = {};
      DRAW_STYLE_KEYS.forEach(k => {
        if (styleConfig[k] !== undefined) defined[k] = styleConfig[k] as any;
      });
      for (const f of source.getFeatures()) {
        if (f._drawStyle) {
          // Drawn-in-app feature: keep its own style function — it renders
          // the measurement chips — and fold the new values into it.
          f._drawStyle = { ...f._drawStyle, ...defined };
          applyDrawFeatureStyle(f, f._drawStyle, () => unitsRef.current);
        } else {
          const fs = f.getStyle && f.getStyle();
          if (fs !== undefined && fs !== null) {
            f.setStyle(undefined); // fall back to the layer style
          }
        }
      }
    }
  };

  /**
   * Turn point clustering on or off for a vector layer.
   *
   * Enabling wraps the layer's real (raw) source in an ol/source/Cluster so
   * nearby points collapse into count bubbles; disabling swaps the raw source
   * back in. The raw source is stashed on the layer the first time clustering
   * is enabled so it can always be recovered - this also keeps feature
   * serialisation, extent calculation and vertex editing pointed at the real
   * features rather than the generated clusters.
   */
  const applyVectorClusteringToLayer = (
    olLayer: any,
    clusterPoints: boolean,
    clusterDistance: number | undefined,
    styleConfig: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number },
  ) => {
    if (!olLayer) return;
    const currentSource = olLayer.getSource && olLayer.getSource();

    if (clusterPoints) {
      // Stash the underlying source once; if we're already clustered keep the
      // existing raw source rather than wrapping the cluster wrapper.
      const rawSource = olLayer._rawSource || currentSource;
      olLayer._rawSource = rawSource;
      const clusterSource = new Cluster({
        source: rawSource,
        distance: clusterDistance ?? 40,
        // Only Point geometries take part in clustering. Returning null for
        // anything else (instead of the default's hard assertion) keeps mixed
        // datasets from throwing - non-point features simply sit out clustering.
        geometryFunction: (feature: any) => {
          const geometry = feature.getGeometry && feature.getGeometry();
          return geometry && geometry.getType() === 'Point' ? geometry : null;
        },
      });
      olLayer.setSource(clusterSource);
    } else if (olLayer._rawSource) {
      olLayer.setSource(olLayer._rawSource);
      olLayer._rawSource = undefined;
    }

    // Re-apply the style - it reads the live source to decide whether to draw
    // cluster bubbles, so it always matches the new (un)clustered state.
    applyVectorStyleToLayer(olLayer, styleConfig);
    if (olLayer.changed) olLayer.changed();
  };

  // The editable/serialisable source of a vector layer: the raw feature source
  // when clustering is active (the Cluster wrapper only holds generated
  // bubbles), otherwise the layer's own source.
  const getLayerRawSource = (layerId: string) => {
    const l = vectorLayersRef.current.get(layerId);
    if (!l) return null;
    return l._rawSource || (l.getSource && l.getSource());
  };

  const handleApplyVectorStyle = (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    // Apply opacity + style (also overrides KML per-feature styles)
    applyVectorStyleToLayer(olLayer, style);

    // While a re-edit session is live, its vertex handles follow the colour
    // being previewed, and features drawn into the layer take on the
    // previewed style.
    if (layerId === editingVectorLayerId) {
      if (style.lineColor) editAccentRef.current = style.lineColor;
      const patch: Partial<DrawStyle> = {};
      DRAW_STYLE_KEYS.forEach(k => {
        if (style[k] !== undefined) (patch as any)[k] = style[k];
      });
      reeditStyleSeedRef.current = { ...reeditStyleSeedRef.current, ...patch };
    }

    // Update config in state (live preview)
    setVectorLayers(prev =>
      prev.map(l => {
        if (l.id === layerId) {
          return {
            ...l,
            opacity: style.opacity ?? l.opacity,
            lineColor: style.lineColor ?? l.lineColor,
            lineWidth: style.lineWidth ?? l.lineWidth,
            fillColor: style.fillColor ?? l.fillColor,
            fontColor: style.fontColor ?? l.fontColor,
            fontSize: style.fontSize ?? l.fontSize,
          };
        }
        return l;
      })
    );
  };

  // Live-update a vector layer's zoom range. MVT layers clamp tile requests;
  // other vector types use it as a visibility range.
  const handleApplyVectorZoomRange = (layerId: string, minZoom?: number, maxZoom?: number) => {
    const layer = vectorLayers.find(l => l.id === layerId);
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!layer || !olLayer) return;
    applyVectorLayerZoomRange(olLayer, layer.type, minZoom, maxZoom);
    setVectorLayers(prev => prev.map(l => (l.id === layerId ? { ...l, minZoom, maxZoom } : l)));
  };

  // Live-preview point clustering for a vector layer (called from the edit
  // menu checkbox / distance slider). Swaps the layer's source in or out of a
  // Cluster wrapper and records the choice in the layer config so it persists.
  const handleApplyVectorCluster = (layerId: string, clusterPoints: boolean, clusterDistance: number) => {
    const layer = vectorLayers.find(l => l.id === layerId);
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!layer || !olLayer) return;
    // MVT layers are tiled - there is no feature source to cluster.
    if (layer.type === 'mvt') return;
    applyVectorClusteringToLayer(olLayer, clusterPoints, clusterDistance, {
      opacity: layer.opacity ?? 100,
      lineColor: layer.lineColor,
      lineWidth: layer.lineWidth,
      fillColor: layer.fillColor,
      fontColor: layer.fontColor,
      fontSize: layer.fontSize,
    });
    setVectorLayers(prev => prev.map(l => (l.id === layerId ? { ...l, clusterPoints, clusterDistance } : l)));
  };

  // Apply or clear the attribute filter of a vector layer (called from the
  // Filter toggle in the edit menu). Non-matching features leave the map
  // entirely; the full dataset is stashed on the OL layer so clearing the
  // filter restores everything and persistence never loses features. Returns
  // false when the expression does not compile - the layer is left untouched.
  const handleApplyVectorFilter = (layerId: string, enabled: boolean, expression: string): boolean => {
    const layer = vectorLayers.find(l => l.id === layerId);
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!layer || !olLayer) return false;
    // MVT layers are tiled - there is no feature source to filter.
    if (layer.type === 'mvt') return false;
    const expr = enabled ? (expression || '').trim() : '';
    try {
      applyVectorFeatureFilter(olLayer, expr || null);
    } catch (e) {
      console.warn('Invalid filter expression:', e);
      return false;
    }
    setVectorLayers(prev => prev.map(l => (l.id === layerId ? { ...l, filterEnabled: !!expr, filterExpression: expr } : l)));
    return true;
  };

  // Apply a style to a single feature of a drawn-in-app vector layer.
  const handleApplyVectorFeatureStyle = (layerId: string, feature: any, style: DrawStyle) => {
    if (!feature) return;
    applyDrawFeatureStyle(feature, style, () => unitsRef.current);
  };

  const handleEditVectorLayer = async (updated: VectorLayerConfig) => {
    if (!mapRef.current) return;

    const olLayer = vectorLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      // MVT, WFS, and STAC layers support URL changes; file-based layers just update name
      if ((updated.type === 'mvt' || updated.type === 'wfs' || updated.type === 'stac') && updated.url) {
        mapRef.current.removeLayer(olLayer);

        let newOlLayer: any;
        if (updated.type === 'mvt') {
          const source = new VectorTileSource({
            format: new MVT(),
            url: updated.url,
          });
          wireVectorTileLoading(source, updated.id);
          newOlLayer = new VectorTileLayer({
            source: source,
            style: buildVectorStyle(updated),
            visible: updated.visible !== false,
          });
        } else if (updated.type === 'wfs') {
          const wfsUrl = buildWfsUrl(updated.url, updated.wfsTypeName || '');
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: (extent: any, resolution: any, projection: any) => {
              markVectorLoading(updated.id, true);
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(updated.id, false);
                })
                .catch(e => {
                  console.error('WFS load error:', e);
                  markVectorLoading(updated.id, false);
                });
            },
          });
          newOlLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(updated),
            visible: updated.visible !== false,
          });
        } else {
          // STAC
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: () => {
              markVectorLoading(updated.id, true);
              fetchAllStacItems(updated.url || '', updated.stacCollection || '', updated.stacLimit)
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(updated.id, false);
                })
                .catch(e => {
                  console.error('STAC load error:', e);
                  markVectorLoading(updated.id, false);
                });
            },
          });
          newOlLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(updated),
            visible: updated.visible !== false,
          });
        }
        newOlLayer.setOpacity((updated.opacity ?? 100) / 100);
        applyVectorLayerZoomRange(newOlLayer, updated.type, updated.minZoom, updated.maxZoom);
        // WFS/STAC point layers can be clustered (MVT is tiled, so it cannot).
        if (updated.type !== 'mvt' && updated.clusterPoints) {
          applyVectorClusteringToLayer(newOlLayer, true, updated.clusterDistance, { ...updated, opacity: updated.opacity ?? 100 });
        }
        // Re-apply any persisted attribute filter to the fresh source. For
        // loader-backed sources the filter listeners evaluate each feature as
        // it arrives.
        if (updated.type !== 'mvt' && updated.filterEnabled && updated.filterExpression) {
          try { applyVectorFeatureFilter(newOlLayer, updated.filterExpression); }
          catch (e) { console.warn('Failed to re-apply vector filter:', e); }
        }
        mapRef.current.addLayer(newOlLayer);
        vectorLayersRef.current.set(updated.id, newOlLayer);

        const updatedWithRef = { ...updated, olLayer: newOlLayer };
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updatedWithRef : l);
        setVectorLayers(newVectorLayers);
        reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
      } else {
        // File-based layer: update name, apply style (overrides KML per-feature
        // styles) and sync the clustering state. applyVectorClusteringToLayer
        // wraps/unwraps the Cluster source as needed and re-applies the style.
        applyVectorClusteringToLayer(olLayer, updated.clusterPoints === true, updated.clusterDistance, { ...updated, opacity: updated.opacity ?? 100 });
        applyVectorLayerZoomRange(olLayer, updated.type, updated.minZoom, updated.maxZoom);
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updated : l);
        setVectorLayers(newVectorLayers);
      }
    } catch (error) {
      console.error('Failed to edit vector layer:', error);
    }
  };

  const handleReorderRasterLayers = (newLayers: RasterLayer[]) => {
    setRasterLayers(newLayers);
    if (mapRef.current) {
      reorderLayers(mapRef.current, newLayers, vectorLayers);
    }
  };

  const handleReorderVectorLayers = (newLayers: VectorLayerConfig[]) => {
    setVectorLayers(newLayers);
    if (mapRef.current) {
      reorderLayers(mapRef.current, rasterLayers, newLayers);
    }
  };

  const handleRemoveRasterLayer = (id: string) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      rasterLayersRef.current.delete(id);
    }
    const newLayers = rasterLayers.filter(l => l.id !== id);
    setRasterLayers(newLayers);
    // Anchor any group that just lost its last member so the empty folder
    // stays at its current panel position.

    const ga = anchorEmptiedGroups(rasterLayers, newLayers, rasterGroups);
    if (ga) setRasterGroups(ga);
    reorderLayers(mapRef.current, newLayers, vectorLayers);
  };

  const handleToggleRasterLayer = (id: string) => {
    const olLayer = rasterLayersRef.current.get(id);
    if (!olLayer) return;

    setRasterLayers(prev =>
      prev.map(l => {
        if (l.id === id) {
          const newVisible = l.visible === false ? true : false;
          olLayer.setVisible(newVisible);
          return { ...l, visible: newVisible };
        }
        return l;
      })
    );
  };

  // ----- Layer groups (folders) ---------------------------------------------
  // Groups are a panel-side organisation of the flat layer arrays: they
  // cluster rows in the settings list, and a group's eye toggle flips every
  // member at once. Map stacking order still comes from the flat arrays.

  // Group metadata (name/expanded/anchors) - panel order itself lives in
  // the flat layer arrays plus each empty group's afterId anchor.
  const handleUpdateRasterGroups = (groups: LayerGroup[]) => setRasterGroups(groups);
  const handleUpdateVectorGroups = (groups: LayerGroup[]) => setVectorGroups(groups);

  /** Toggle a group: hide every member (remembering each layer's own
   * visibility) unless all members are already hidden, in which case each
   * layer's remembered visibility is restored. */
  const handleToggleRasterGroup = (groupId: string) => {
    const next = toggleGroupLayerVisibility(rasterLayers, groupId);
    if (next === rasterLayers) return;
    next.forEach(l => {
      if (l.groupId === groupId) {
        const ol = rasterLayersRef.current.get(l.id);
        if (ol) ol.setVisible(l.visible !== false);
      }
    });
    setRasterLayers(next);
  };

  const handleToggleVectorGroup = (groupId: string) => {
    const next = toggleGroupLayerVisibility(vectorLayers, groupId);
    if (next === vectorLayers) return;
    next.forEach(l => {
      if (l.groupId === groupId) {
        const ol = vectorLayersRef.current.get(l.id);
        if (ol) ol.setVisible(l.visible === true);
      }
    });
    setVectorLayers(next);
  };

  const handleMoveRasterLayerToGroup = (layerId: string, groupId: string | undefined) => {
    const layer = rasterLayers.find(l => l.id === layerId);
    if (!layer || layer.groupId === groupId) return;
    let next: RasterLayer[];
    if (groupId && !rasterLayers.some(l => l.groupId === groupId)) {
      // Joining an EMPTY group: land at the group's anchored panel slot so
      // the group materialises where it was sitting.
      const at = flatIndexForGroupSlot(rasterLayers, rasterGroups, groupId);
      const moved = { ...layer, groupId };
      next = rasterLayers.filter(l => l.id !== layerId);
      next.splice(Math.min(at, next.length), 0, moved);
    } else {
      next = moveLayerToGroup(rasterLayers, layerId, groupId);
    }
    setRasterLayers(next);
    // Reveal the moved layer: the receiving group expands automatically.
    if (groupId) {
      setRasterGroups(prev => prev.map(g => (g.id === groupId && !g.expanded ? { ...g, expanded: true } : g)));
    }
    if (mapRef.current) reorderLayers(mapRef.current, next, vectorLayers);
  };

  const handleMoveVectorLayerToGroup = (layerId: string, groupId: string | undefined) => {
    const layer = vectorLayers.find(l => l.id === layerId);
    if (!layer || layer.groupId === groupId) return;
    let next: VectorLayerConfig[];
    if (groupId && !vectorLayers.some(l => l.groupId === groupId)) {
      // Joining an EMPTY group: land at the group's anchored panel slot so
      // the group materialises where it was sitting.
      const at = flatIndexForGroupSlot(vectorLayers, vectorGroups, groupId);
      const moved = { ...layer, groupId };
      next = vectorLayers.filter(l => l.id !== layerId);
      next.splice(Math.min(at, next.length), 0, moved);
    } else {
      next = moveLayerToGroup(vectorLayers, layerId, groupId);
    }
    setVectorLayers(next);
    // Reveal the moved layer: the receiving group expands automatically.
    if (groupId) {
      setVectorGroups(prev => prev.map(g => (g.id === groupId && !g.expanded ? { ...g, expanded: true } : g)));
    }
    if (mapRef.current) reorderLayers(mapRef.current, rasterLayers, next);
  };


  // ---------------------------------------------------------------------------
  // Click-to-pick-up vertex editing, shared by the draw toolbar's edit tool
  // and saved-layer re-edit. Clicking a vertex picks it up — it then follows
  // the pointer (see the pointermove handler) until the next click places it.
  // Delete removes it, Escape restores it, and clicking a segment inserts a
  // fresh vertex that is picked up immediately.
  // ---------------------------------------------------------------------------

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
    setMeasureTick(tick => tick + 1);
  };

  // Escape puts the vertex back where it was picked up.
  const cancelStickyVertex = () => {
    const sticky = stickyVertexRef.current;
    if (!sticky) return;
    setVertexCoordinate(sticky.geom, sticky.indexPath, sticky.coord);
    exitStickyVertex();
    pushHistorySnapshot(); // routes to the active session; dedupe skips no-ops
    setMeasureTick(tick => tick + 1);
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
        : (reeditId !== null ? getLayerRawSource(reeditId) : null);
      if (source) source.removeFeature(feature);
      if (isDrawEdit) {
        setDrawnFeatures(prev => prev.filter(item => item.feature !== feature));
      }
      exitStickyVertex();
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
      return;
    }

    if (removeVertexFromGeom(geom, indexPath)) {
      exitStickyVertex();
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
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
      : getLayerRawSource(reeditId as string);
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
      setMeasureTick(tick => tick + 1);
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
      : getLayerRawSource(reeditId as string);
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

    setLabelDialogState({
      pixel: map.getPixelFromCoordinate(labelFeature.getGeometry().getCoordinates()) as [number, number],
      feature: labelFeature,
      featureId: '',
      existingText: String(labelFeature.get('labelText') ?? ''),
    });
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

  // ---------------------------------------------------------------------------
  // Undo / redo for the draw session
  // ---------------------------------------------------------------------------

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

  const restoreSnapshot = (snap: SessionSnapshot) => {
    const ctx = getActiveEditContext();
    const source = ctx.source;
    if (!source) return;
    if (stickyVertexRef.current) exitStickyVertex();
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
    setMeasureTick(tick => tick + 1);
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

  // Suspend/resume the saved-layer Modify+Translate pair while a drawing
  // tool owns the gestures during a re-edit session.
  const setLayerInteractionsActive = (active: boolean) => {
    if (layerModifyInteractionRef.current) layerModifyInteractionRef.current.setActive(active);
    if (layerTranslateRef.current) layerTranslateRef.current.setActive(active);
  };

  const handleDrawTool = (tool: DrawToolId) => {
    if (!mapRef.current || !drawSourceRef.current) return;
    const inReedit = editingVectorLayerId !== null;

    // Remove existing draw/modify interactions
    if (drawInteractionRef.current) {
      mapRef.current.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    if (modifyInteractionRef.current) {
      mapRef.current.removeInteraction(modifyInteractionRef.current);
      modifyInteractionRef.current = null;
    }
    if (drawTranslateRef.current) {
      mapRef.current.removeInteraction(drawTranslateRef.current);
      drawTranslateRef.current = null;
    }
    // A picked-up vertex never survives a tool switch.
    if (stickyVertexRef.current) {
      exitStickyVertex();
    }

    // Drop any hover cursor left behind by an edit session; the pointermove
    // handler re-applies it on the next move while editing stays active.
    (mapRef.current.getTargetElement() as HTMLElement).style.cursor = '';

    // If same tool clicked, toggle off
    if (tool === activeDrawTool) {
      setActiveDrawTool(null);
      // Back to the layer's own vertex editing, if a session is live.
      if (inReedit) setLayerInteractionsActive(true);
      return;
    }

    setActiveDrawTool(tool);

    if (!tool) {
      if (inReedit) setLayerInteractionsActive(true);
      return;
    }

    // During a re-edit session the edit tool *is* the layer's own vertex
    // editing — resume it rather than starting a second Modify.
    if (inReedit && tool === 'modify') {
      setActiveDrawTool(null);
      setLayerInteractionsActive(true);
      return;
    }

    // While a drawing tool owns the gestures, the layer's Modify/Translate
    // stand aside (the re-edit session itself stays alive).
    if (inReedit) setLayerInteractionsActive(false);

    // Edit tool — reshape features that are already drawn instead of adding
    // new ones. Vertices drag to new positions, clicking a segment inserts a
    // vertex and Alt+clicking a vertex removes it (OpenLayers Modify
    // defaults). The on-map measurement chips stay in sync automatically
    // because each feature's style function re-runs on every geometry change.
    if (tool === 'modify') {
      editAccentRef.current = drawStyleRef.current.lineColor;
      const modifyInteraction = new Modify({
        source: drawSourceRef.current,
        pixelTolerance: 12,
        // Segment clicks are owned by handleEditClick (insert + pick up), so
        // Modify stays vertex-only and presses elsewhere fall through to the
        // whole-feature Translate interaction below.
        insertVertexCondition: () => false,
        // Handles follow the current draw line colour.
        style: () => buildModifyVertexStyle(drawStyleRef.current.lineColor),
      });

      // Refresh the drawn-features panel once each edit settles so its
      // length/area readouts match the new geometry — and record the edit
      // as a history step.
      modifyInteraction.on('modifyend', () => {
        pushHistorySnapshot();
        setMeasureTick(tick => tick + 1);
      });

      // Drag anywhere on a feature that is not a vertex moves the whole
      // feature. Added after Modify, so it is offered events first and can
      // stand aside whenever a vertex is within grabbing distance.
      const drawLayer = drawLayerRef.current;
      const translateInteraction = new Translate({
        layers: drawLayer ? [drawLayer as any] : [],
        hitTolerance: 6,
        condition: (evt) =>
          primaryAction(evt) &&
          !stickyVertexRef.current &&
          !findNearestVertex(mapRef.current as OLMap, drawSourceRef.current, evt.pixel as number[], 12),
      });
      translateInteraction.on('translateend', () => {
        pushHistorySnapshot();
        setMeasureTick(tick => tick + 1);
      });

      mapRef.current.addInteraction(modifyInteraction);
      mapRef.current.addInteraction(translateInteraction);
      modifyInteractionRef.current = modifyInteraction;
      drawTranslateRef.current = translateInteraction;
      return;
    }

    // Give each fresh drawing batch a random color, just like adding a vector
    // layer. Only re-roll when the batch is empty so in-progress work (and any
    // manually chosen style) keeps its color across tool switches.
    if (!inReedit && drawnFeatures.length === 0) {
      const { lineColor, fillColor } = getRandomVectorColors();
      handleDrawStyleChange({ ...drawStyleRef.current, lineColor, fillColor });
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
      ? (getLayerRawSource(editingVectorLayerId as string) || drawSourceRef.current)
      : drawSourceRef.current;

    const drawInteraction = new Draw({
      source: targetSource,
      type: drawType,
      geometryFunction: geometryFunction,
    });

    // Style the in-progress sketch with the current draw style and live
    // measurement labels (segment lengths for lines, area for polygons and
    // rectangles). The style function re-runs on every geometry change, so
    // the readouts update as the user moves the pointer.
    drawInteraction.on('drawstart', (evt) => {
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
      const feature = evt.feature;
      const featureId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6);
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
          setMeasureTick(tick => tick + 1);
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

    mapRef.current.addInteraction(drawInteraction);
    drawInteractionRef.current = drawInteraction;
  };

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
      setMeasureTick(tick => tick + 1); // refresh saved-layer name readouts
      return;
    }

    feature.set('labelText', text);
    const initStyle = labelDialogState.toLayer ? { ...reeditStyleSeedRef.current } : { ...drawStyleRef.current };
    applyDrawFeatureStyle(feature, initStyle, () => unitsRef.current);
    (feature as any)._drawName = 'Label: ' + text;
    pushHistorySnapshot();
    if (labelDialogState.toLayer) {
      // The label lives in the layer; refresh its feature list.
      setMeasureTick(tick => tick + 1);
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

  const handleExportVectorLayer = async (layerId: string, format: VectorExportFormat) => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    // Use the raw source when clustered so the export contains the real
    // features rather than the generated cluster bubbles.
    const source = olLayer._rawSource || olLayer.getSource();
    if (!source) return;

    const features = source.getFeatures().slice();
    if (features.length === 0) {
      alert('No features to export.');
      return;
    }

    const layerConfig = vectorLayers.find(l => l.id === layerId);
    const baseName = layerConfig?.name || 'export';

    try {
      await exportFeaturesToFile(features, baseName, format);
    } catch (err) {
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleGoToRasterLayerExtent = (layerId: string) => {
    if (!mapRef.current) return;
    const layerConfig = rasterLayers.find(l => l.id === layerId);
    if (!layerConfig) return;

    let extent = layerConfig.extent;

    // Fallback for COG layers: read the extent directly from the GeoTIFF
    // source's tile grid and transform it to EPSG:3857 on the fly.
    if ((!extent || extent.length !== 4) && layerConfig.type === 'cog') {
      const olLayer = rasterLayersRef.current.get(layerId);
      const source = olLayer?.getSource?.();
      if (source) {
        const tileGrid = source.getTileGrid?.();
        const rawExtent: number[] | undefined = tileGrid?.getExtent?.();
        if (rawExtent && rawExtent.length === 4 && rawExtent.every(isFinite)) {
          const srcProj = source.getProjection?.();
          const code: string = srcProj?.getCode ? srcProj.getCode() : 'EPSG:3857';
          if (code === 'EPSG:3857') {
            extent = rawExtent.slice();
          } else {
            try {
              const resolvedProj = getOlProjection(code) || srcProj;
              extent = transformExtent(rawExtent, resolvedProj, 'EPSG:3857');
            } catch (e) {
              console.warn('[COG] zoom-to-extent: failed to transform extent:', e);
            }
          }
        }
      }
    }

    if (extent && extent.length === 4 && extent.every((v: number) => isFinite(v))) {
      mapRef.current.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 18,
        duration: 500,
      });
    }
  };

  const handleGoToVectorLayerExtent = (layerId: string) => {
    if (!mapRef.current) return;
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;
    // Use the raw source when clustered so the extent covers every real
    // feature rather than just the currently generated cluster bubbles.
    const source = olLayer._rawSource || olLayer.getSource();
    if (!source) return;
    const extent = source.getExtent();
    if (extent && extent.every((v: number) => isFinite(v))) {
      mapRef.current.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 18,
        duration: 500,
      });
    }
  };

  // Switch between metric and imperial measurements. Updates the scale line
  // and forces every layer to re-render so all measurement labels on the map
  // (drawn features, saved draw layers, in-progress sketches) re-format.
  const handleUnitsChange = (newUnits: UnitsSystem) => {
    setUnits(newUnits);
    unitsRef.current = newUnits;
    if (scaleLineRef.current) {
      scaleLineRef.current.setUnits(newUnits === 'imperial' ? 'imperial' : 'metric');
    }
    if (mapRef.current) {
      mapRef.current.getLayers().forEach((layer: any) => layer.changed && layer.changed());
      mapRef.current.render();
    }
  };

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
    if (stickyVertexRef.current) exitStickyVertex();

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
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
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

  const handleGoTo = (lonlat: [number, number], zoom: number) => {
    if (!mapRef.current) return;
    const view = mapRef.current.getView();
    const center = fromLonLat(lonlat);
    view.animate({ center, zoom, duration: 500 });
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };


  /** Handle a dropped/selected GeoTIFF file: validate as COG, then add as a raster layer. */
  const handleAddCogFile = async (file: File) => {
    if (!mapRef.current) return;
    try {
      const buffer = await file.arrayBuffer();
      const validation = validateCogBuffer(buffer, file.name);

      if (!validation.isTiff) {
        showLayerError('Not a valid GeoTIFF', validation.error || 'The selected file is not a valid TIFF.');
        return;
      }

      // If it's not a COG and has a blocking error (too large), refuse
      if (!validation.isCog && validation.error && validation.fileSize > MAX_NON_COG_TIFF_SIZE) {
        showLayerError('Too large to render', validation.error || 'File exceeds the safe size limit.');
        return;
      }

      // Warn (but allow) for small non-COG TIFFs
      if (!validation.isCog && validation.error) {
        if (!window.confirm(validation.error + '\n\nLoad anyway?')) return;
      }

      // Create a blob URL for the OL GeoTIFF source (session-only; not persisted)
      const blob = new Blob([buffer], { type: 'image/tiff' });
      const blobUrl = URL.createObjectURL(blob);

      const layerName = file.name.replace(/\.(tif|tiff|geotiff)$/i, '');
      const layerConfig: RasterLayer = {
        id: Date.now().toString(),
        name: layerName,
        type: 'cog',
        url: blobUrl,
        cogSource: 'file',
        cogFileName: file.name,
      };

      const cogResult = await createCogLayer(blobUrl);
      const olLayer = cogResult.olLayer;
      olLayer.setVisible(true);
      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      const extentPatch = cogResult.extent ? { extent: cogResult.extent } : {};
      const newRasterLayers = [...rasterLayers, { ...layerConfig, olLayer, ...extentPatch }];
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);
    } catch (error: any) {
      console.error('Failed to add COG file:', error);
      showLayerError('Failed to load GeoTIFF', error?.message || String(error));
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'tif' || ext === 'tiff' || ext === 'geotiff') {
        await handleAddCogFile(file);
      } else {
        await handleAddVectorLayer(file);
      }
    }
  };

  const handleApplyColorAdjustments = (layerId: string, adjustments: { brightness?: number; saturation?: number; contrast?: number; opacity?: number }) => {
    const olLayer = rasterLayersRef.current.get(layerId);
    if (!olLayer || !mapRef.current) return;

    // For immediate update, apply directly (no need to recreate the layer)
    applyColorAdjustments(olLayer, adjustments);
  };

  const handleAddRasterLayer = async (layerConfig: RasterLayer) => {
    if (!mapRef.current) return;

    try {
      let olLayer: any;
      let extent: number[] | null = null;

      if (layerConfig.type === 'wmts') {
        const response = await fetch(layerConfig.wmtsCapabilitiesUrl || layerConfig.url);
        const text = await response.text();
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        
        const wmtsOptions = optionsFromCapabilities(capabilities, {
          layer: layerConfig.wmtsLayer || '',
        });
        
        if (!wmtsOptions) {
          throw new Error('Failed to create WMTS options from capabilities');
        }
        
        extent = extractWmtsExtent(capabilities, layerConfig.wmtsLayer || '');
        olLayer = new TileLayer({
          source: createWmtsSource(wmtsOptions, layerConfig.minZoom, layerConfig.maxZoom),
        });
      } else if (layerConfig.type === 'wms') {
        // Fetch capabilities to extract extent
        try {
          const response = await fetch(layerConfig.wmsCapabilitiesUrl || layerConfig.url);
          const text = await response.text();
          const parser = new WMSCapabilities();
          const capabilities = parser.read(text);
          extent = extractWmsExtent(capabilities, layerConfig.wmsLayer || '');
        } catch (capError) {
          console.warn('Failed to fetch WMS capabilities for extent:', capError);
        }

        olLayer = new ImageLayer({
          source: new ImageWMS({
            url: extractBaseUrl(layerConfig.wmsCapabilitiesUrl || layerConfig.url),
            params: { LAYERS: layerConfig.wmsLayer || '' },
            ratio: 1,
            serverType: 'geoserver',
          }),
        });
      } else if (layerConfig.type === 'cog') {
        const cogUrl = await resolveCogUrl(layerConfig);
        const cogResult = await createCogLayer(cogUrl);
        olLayer = cogResult.olLayer;
        extent = cogResult.extent;
      } else {
        olLayer = new TileLayer({
          source: createXYZSource(layerConfig.url, layerConfig.minZoom, layerConfig.maxZoom),
        });
      }

      olLayer.setVisible(layerConfig.visible !== false);
      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer, ...(extent ? { extent } : {}) };
      const newRasterLayers = [...rasterLayers, layerConfigWithRef];
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);

      // Apply saved color adjustments after layer is rendered
      if (layerConfig.brightness !== undefined || layerConfig.saturation !== undefined ||
          layerConfig.contrast !== undefined || layerConfig.opacity !== undefined) {
        mapRef.current.once('rendercomplete', () => {
          applyColorAdjustments(olLayer, {
            brightness: layerConfig.brightness,
            saturation: layerConfig.saturation,
            contrast: layerConfig.contrast,
            opacity: layerConfig.opacity,
          });
        });
      }
    } catch (error) {
      console.error('Failed to add raster layer:', error);      showLayerError('Failed to add raster layer', error instanceof Error ? error.message : String(error));
    }
  };

  /* ---------------------------------------------------------------------
     Right-click context menu — an in-app replacement for the browser's
     native context menu on the map surface. Offers "Copy coordinates",
     "Save image as…" and "Copy image" (the latter two capture the rendered
     map canvas). See components/MapContextMenu.tsx for the menu itself.
     --------------------------------------------------------------------- */

  const showToast = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    setToast({ id: Date.now(), message, kind });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  /** Show a persistent, dismissible error banner for layer-loading failures. */
  const showLayerError = useCallback((title: string, detail: string) => {
    setLayerError({ id: Date.now(), title, detail });
  }, []);

  // Format the clicked coordinate using the same projection and precision as
  // the on-screen readout, so what gets copied matches what the user sees.
  const formatCoordinateForCopy = useCallback(
    (coordinate: [number, number]): string => {
      if (coordProjection === 'EPSG:4326') {
        const [lon, lat] = toLonLat(coordinate);
        return `${lat.toFixed(coordDecimals)}, ${lon.toFixed(coordDecimals)}`;
      }
      return `${coordinate[0].toFixed(coordDecimals)}, ${coordinate[1].toFixed(coordDecimals)}`;
    },
    [coordProjection, coordDecimals],
  );

  const handleMapContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only replace the browser menu on the map surface itself — controls,
    // popups, panels and text inputs keep their native context menu.
    const target = e.target as HTMLElement;
    if (target.tagName !== 'CANVAS' && !target.closest('.ol-layer')) return;

    const map = mapRef.current;
    if (!map) return;
    e.preventDefault();

    const viewportRect = map.getViewport().getBoundingClientRect();
    const coordinate = map.getCoordinateFromPixel([
      e.clientX - viewportRect.left,
      e.clientY - viewportRect.top,
    ]);
    if (!coordinate) return;

    const containerRect = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
      coordinate: coordinate as [number, number],
    });
  };

  const handleCopyCoordinates = async () => {
    if (!contextMenu) return;
    const text = formatCoordinateForCopy(contextMenu.coordinate);
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Coordinates copied \u00b7 ${text}`);
    } catch {
      showToast('Could not copy coordinates', 'error');
    }
  };

  const reportCaptureError = (err: unknown) => {
    if (isTaintedCanvasError(err)) {
      showToast('Can\u2019t capture image \u2014 a layer blocks cross-origin tile access', 'error');
    } else {
      showToast('Could not capture the map image', 'error');
    }
  };

  const handleSaveImageAs = async () => {
    const map = mapRef.current;
    setContextMenu(null);
    if (!map) return;
    try {
      const canvas = await captureMapCanvas(map);
      const blob = await canvasToPngBlob(canvas);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `map-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Map image saved');
    } catch (err) {
      reportCaptureError(err);
    }
  };

  const handleCopyImage = async () => {
    const map = mapRef.current;
    setContextMenu(null);
    if (!map) return;
    try {
      const canvas = await captureMapCanvas(map);
      const blob = await canvasToPngBlob(canvas);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Map image copied to clipboard');
    } catch (err) {
      reportCaptureError(err);
    }
  };

  return (
    <div 
      id="map" 
      className="map-container"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleMapContextMenu}
    >
      {isDragging && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(66, 133, 244, 0.3)',
          border: '3px dashed #4285f4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          pointerEvents: 'none',
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '20px 40px',
            borderRadius: '8px',
            fontSize: '18px',
            fontWeight: 'bold',
            color: '#4285f4',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}>
            Drop vector files or GeoTIFF here
          </div>
        </div>
      )}
      <GoToBar onGoTo={handleGoTo} />
      {showCoordinates && <MouseCoordinateDisplay
        coordinate={mouseCoord}
        projection={coordProjection}
        onProjectionChange={setCoordProjection}
        decimals={coordDecimals}
        onDecimalsChange={setCoordDecimals}
      />}

      {showDrawToolbar && (
        <DrawToolbar
          activeTool={activeDrawTool}
          onToolSelect={handleDrawTool}
          undoDepth={undoDepth}
          redoDepth={redoDepth}
          onUndo={handleUndo}
          onRedo={handleRedo}
          showHistory={activeDrawTool !== null || editingVectorLayerId !== null}
        />
      )}
      {showDrawToolbar && activeDrawTool !== null && editingVectorLayerId === null && (
        <DrawnFeaturesPanel
          drawnFeatures={drawnFeatures}
          expanded={showDrawnPanel}
          onToggle={() => setShowDrawnPanel(!showDrawnPanel)}
          onRemove={handleRemoveDrawnFeature}
          onSaveToLayers={handleSaveDrawnToLayers}
          onExport={handleExportDrawnFeatures}
          drawStyle={drawStyle}
          onDrawStyleChange={handleDrawStyleChange}
          onFeatureStyleChange={handleFeatureStyleChange}
          onEditLabelText={handleEditLabelText}
          units={units}
          measureVersion={measureTick}
        />
      )}
      {(activeDrawTool === 'modify' || editingVectorLayerId !== null) && (
        <div className={`draw-modify-hint ${stickyVertex ? 'sticky' : ''}`} role="status">
          {stickyVertex ? (
            <>
              <span><b>Click</b> to place the vertex</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Del</b> removes it</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Esc</b> puts it back</span>
            </>
          ) : activeDrawTool === 'modify' && drawnFeatures.length === 0 ? (
            <span>Nothing to edit yet — draw a line, polygon, rectangle or label first</span>
          ) : (
            <>
              <span><b>Drag</b> a vertex to reshape</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Drag</b> the feature to move it</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Click</b> a vertex to pick it up</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Click</b> a segment to add one</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Double-click</b> a label to edit its text</span>
            </>
          )}
        </div>
      )}
      {labelDialogState && (
        <LabelInputDialog
          pixel={labelDialogState.pixel}
          initialText={labelDialogState.existingText}
          onApply={handleLabelDialogApply}
          onCancel={handleLabelDialogCancel}
        />
      )}
      <div ref={zoomRef} className="map-controls" />
      <div ref={attributionRef} className="map-attribution" />

      <div className="map-settings-wrapper" ref={settingsWrapperRef}>
        {showSettings && (
          <SettingsDialog 
            onClose={() => setShowSettings(false)} 
            pinned={settingsPinned}
            onPinToggle={setSettingsPinned}
            showBasemap={showBasemap}
            onBasemapToggle={setShowBasemap}
            showGrid={showGrid}
            onGridToggle={setShowGrid}
            showDrawToolbar={showDrawToolbar}
            onDrawToolbarToggle={setShowDrawToolbar}
            showCoordinates={showCoordinates}
            onCoordinatesToggle={setShowCoordinates}
            rasterLayers={rasterLayers}
            rasterGroups={rasterGroups}
            onUpdateRasterGroups={handleUpdateRasterGroups}
            onToggleRasterGroup={handleToggleRasterGroup}
            onMoveRasterLayerToGroup={handleMoveRasterLayerToGroup}
            onAddRasterLayer={handleAddRasterLayer}
            onEditRasterLayer={handleEditRasterLayer}
            onRemoveRasterLayer={handleRemoveRasterLayer}
            onToggleRasterLayer={handleToggleRasterLayer}
            onApplyColorAdjustments={handleApplyColorAdjustments}
            onApplyTileZoomRange={handleApplyTileZoomRange}
            vectorLayers={vectorLayers}
            vectorGroups={vectorGroups}
            onUpdateVectorGroups={handleUpdateVectorGroups}
            onToggleVectorGroup={handleToggleVectorGroup}
            onMoveVectorLayerToGroup={handleMoveVectorLayerToGroup}
            onToggleVectorLayer={handleToggleVectorLayer}
            onRemoveVectorLayer={handleRemoveVectorLayer}
            onEditVectorLayer={handleEditVectorLayer}
            onApplyVectorStyle={handleApplyVectorStyle}
            onApplyVectorZoomRange={handleApplyVectorZoomRange}
            onApplyVectorCluster={handleApplyVectorCluster}
            onApplyVectorFilter={handleApplyVectorFilter}
            onApplyVectorFeatureStyle={handleApplyVectorFeatureStyle}
            onReorderRasterLayers={handleReorderRasterLayers}
            onReorderVectorLayers={handleReorderVectorLayers}
            onAddVectorLayer={handleAddVectorLayer}
            onAddMVTLayer={handleAddMVTLayer}
            onAddWFSLayer={handleAddWFSLayer}
            onAddSTACLayer={handleAddSTACLayer}
            onExportVectorLayer={handleExportVectorLayer}
            onReeditVectorLayer={handleReeditVectorLayer}
            editingVectorLayerId={editingVectorLayerId}
            onGoToVectorLayerExtent={handleGoToVectorLayerExtent}
            onGoToRasterLayerExtent={handleGoToRasterLayerExtent}
            onAdvancedSettings={() => setShowAdvancedSettings(true)}
            knownSources={knownSources}
            isRestoringLayers={isRestoringLayers}
            loadingVectorIds={loadingVectorIds}
            units={units}
            workspaceId={workspaceId}
            workspaces={workspaces}
            onSwitchWorkspace={onSwitchWorkspace}
            onCreateWorkspace={onCreateWorkspace}
            onRenameWorkspace={onRenameWorkspace}
            onDuplicateWorkspace={onDuplicateWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            onLockApp={onLockApp}
            hasLockPassword={hasLockPassword}
            onSetPassword={onSetPassword}
            onResetPassword={onResetPassword}
          />
        )}
        <button
          className="map-settings-button"
          onClick={() => setShowSettings((prev) => !prev)}
          title="Settings"
        >
          <GearIcon />
        </button>
      </div>
      {showAdvancedSettings && (
        <AdvancedSettingsDialog 
          onClose={() => setShowAdvancedSettings(false)} 
          knownSources={knownSources}
          onUpdateSources={handleUpdateKnownSources}
          basemapUrl={basemapUrl}
          onBasemapChange={(url) => setBasemapUrl(url)}
          basemapMinZoom={basemapMinZoom}
          basemapMaxZoom={basemapMaxZoom}
          onBasemapZoomRangeChange={(min, max) => {
            setBasemapMinZoom(min);
            setBasemapMaxZoom(max);
          }}
          units={units}
          onUnitsChange={handleUnitsChange}
          hasLockPassword={hasLockPassword}
          getLockPassword={getLockPassword}
        />
      )}
      {contextMenu && (
        <MapContextMenu
          key={`${contextMenu.x}-${contextMenu.y}`}
          x={contextMenu.x}
          y={contextMenu.y}
          coordinateText={formatCoordinateForCopy(contextMenu.coordinate)}
          onCopyCoordinates={handleCopyCoordinates}
          onSaveImage={handleSaveImageAs}
          onCopyImage={handleCopyImage}
          onClose={() => setContextMenu(null)}
        />
      )}
      {layerError && (
        <div key={layerError.id} className="layer-error-banner" role="alert">
          <svg className="layer-error-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div className="layer-error-body">
            <div className="layer-error-title">{layerError.title}</div>
            <div className="layer-error-detail">{layerError.detail}</div>
          </div>
          <button
            type="button"
            className="layer-error-close"
            onClick={() => setLayerError(null)}
            aria-label="Dismiss error"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {toast && (
        <div key={toast.id} className={`map-toast map-toast-${toast.kind}`} role="status">
          {toast.kind === 'success' ? (
            <svg className="map-toast-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg className="map-toast-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   App lock: password setup dialog + full-screen lock overlay
   --------------------------------------------------------------------------- */

