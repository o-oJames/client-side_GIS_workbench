import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import OLMap from 'ol/Map.js';
import TileLayer from 'ol/layer/Tile.js';
import TileDebug from 'ol/source/TileDebug.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import ScaleLine from 'ol/control/ScaleLine.js';
import Attribution from 'ol/control/Attribution.js';
import Overlay from 'ol/Overlay.js';
import { defaults as defaultControls } from 'ol/control.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { Style } from 'ol/style.js';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom.js';
import JSZip from 'jszip';
import Projection from 'ol/proj/Projection.js';
import { fromLonLat, toLonLat, transformExtent, get as getOlProjection } from 'ol/proj.js';
import { parseShapefile } from '../utils/shapefileParser';
import { exportFeaturesToFile, VectorExportFormat } from '../utils/vectorExport';
import { captureMapCanvas, canvasToPngBlob, isTaintedCanvasError } from '../utils/mapExport';
import { buildLegendEntries, drawMapDetails, ImageDetailOptions } from '../utils/mapImageOverlays';
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
  DRAW_STYLE_KEYS,
} from '../types';
import { generateId } from '../constants';
import { loadKnownSources, saveKnownSources } from '../utils/knownSources';
import {
  createXYZSource,
  createBasemapSource,
  basemapSourceKey,
} from '../utils/tileHelpers';
import {
  patchLayerRenderer,
  applyColorAdjustments,
  buildWfsUrl,
  fetchAllStacItems,
  escapeHtml,
  fetchWmsFeatureInfo,
  fetchWmsFeatureInfoExtent,
  applyVectorLayerZoomRange,
  applyVectorFeatureFilter,
  reorderLayers,
} from '../utils/layerHelpers';
import { normalizeOlColor, getRandomVectorColors } from '../utils/colorHelpers';
import { buildMeasurementStyles, shouldShowFeatureMeasurements } from '../utils/measurement';
import {
  buildDrawFeatureStyle,
  applyDrawFeatureStyle,
  setDrawFeatureMeasurementsVisible,
  saveDrawSession,
  loadDrawSession,
  findNearestVertex,
  setVertexCoordinate,
} from '../utils/drawHelpers';
import { hasLockedVault } from '../utils/appLock';
import {
  loadSettings,
  saveSettings,
  getInitialView,
  updateUrlParams,
  saveView,
} from '../utils/workspaceStorage';
import { idbDelete } from '../utils/idb';
import { validateCogBuffer, MAX_NON_COG_TIFF_SIZE, COG_HEADER_VALIDATION_BYTES } from '../utils/cogHelpers';
import { registerCogFile, releaseCogFile } from '../utils/cogFileRegistry';
import { BoxContextMenu } from './BoxContextMenu';
import { useBoxSelection } from '../hooks/useBoxSelection';
import {
  collectVectorHitsInExtent,
  extentToPixelRect,
  clampRectToSize,
  cropCanvasToRect,
} from '../utils/boxSelection';
import { SettingsDialog } from './SettingsDialog';
import { AdvancedSettingsDialog } from './AdvancedSettingsDialog';
import { GoToBar } from './GoToBar';
import { DrawToolbar, LabelInputDialog } from './DrawToolbar';
import { useDrawSession } from '../hooks/useDrawSession';
import { useSamTools } from '../hooks/useSamTools';
import { useMagneticDraw } from '../hooks/useMagneticDraw';
import { DrawnFeaturesPanel } from './DrawnFeaturesPanel';
import { MouseCoordinateDisplay } from './MouseCoordinateDisplay';
import { MapContextMenu } from './MapContextMenu';
import { SettingsContextMenu } from './SettingsContextMenu';
import { GearIcon } from './Icons';
import {
  anchorEmptiedGroups,
  toggleGroupLayerVisibility,
  flatIndexForGroupSlot,
  moveLayerToGroup,
} from './LayerPanel';
import { buildVectorStyle, applyVectorStyleToLayer, applyVectorClusteringToLayer, getLayerRawSource } from '../utils/vectorStyleHelpers';
import { createRasterOlLayer, createCogLayer } from '../utils/rasterLayerFactory';
import { restoreMvtLayers, restoreWfsLayers, restoreStacLayers, restoreDrawnLayers, restoreFileLayers } from '../utils/layerRestore';
import type { RestoreCallbacks } from '../utils/layerRestore';
import { buildVectorSections, buildPopup } from '../utils/popupHtml';
import { LayerErrorBanner } from './LayerErrorBanner';
import { MapToast } from './MapToast';

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
  /** Split-screen pane mode: hides the full-app chrome (settings, drawing,
   * go-to bar) and keeps the shared URL static — each pane only persists its
   * own view to localStorage. */
  splitPane?: boolean;
  /** DOM id for the OL map target. Split-screen renders two MapPages, so each
   * pane needs its own target; defaults to the single-map 'map'. */
  mapTargetId?: string;
  /** Enter split-screen comparison (normal mode only) — rendered as the
   * split button in the settings footer, next to the lock button. No
   * arguments = active workspace + auto-picked second one; explicit ids come
   * from the split button's right-click workspace picker. */
  onEnterSplitScreen?: (leftId?: string, rightId?: string) => void;
  /** Split-screen panes share ONE view instance so both sides always show
   * the same extent and zoom; when set, MapPage uses it instead of creating
   * its own view. */
  sharedView?: View;
  /** Split-screen: lift pointer coordinates to the single centred display
   * shared by both panes. */
  onMouseCoordinate?: (coordinate: [number, number] | null) => void;
  /** Which side of the split-screen this pane is on. */
  splitSide?: 'left' | 'right';
  /** Split-screen: the split-level gear controls the dialog instead of the
   * per-map gear (which is hidden). */
  splitSettingsOpen?: boolean;
  onSplitSettingsClose?: () => void;
  /** Split-screen: pin state of the shared split-level settings panel (one
   * pin for the whole panel, isolated from workspace settings). */
  splitSettingsPinned?: boolean;
  onSplitSettingsPinned?: (pinned: boolean) => void;
  /** Split-view-only basic settings — isolated from workspace settings. */
  splitShowBasemap?: boolean;
  splitShowGrid?: boolean;
  splitShowCoords?: boolean;
  onSplitBasemapToggle?: (checked: boolean) => void;
  onSplitGridToggle?: (checked: boolean) => void;
  onSplitCoordsToggle?: (checked: boolean) => void;
  /** Split-screen: workspace tabs rendered inside the settings dialog; each
   * tab carries the workspace shown on its side for the integrated dropdown. */
  splitTabs?: Array<{ id: string; label: string; workspaceId: string }>;
  activeSplitTabId?: string;
  onSplitTabChange?: (id: string) => void;
  /** Split-screen: change the workspace shown on a side, picked from the
   * dropdown integrated into that side's tab. */
  onSplitTabWorkspaceChange?: (tabId: string, workspaceId: string) => void;
  /** Split-screen footer action: exit split mode. */
  onExitSplitMode?: () => void;
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
  splitPane = false,
  mapTargetId = 'map',
  onEnterSplitScreen,
  sharedView,
  onMouseCoordinate,
  splitSide = 'left',
  splitSettingsOpen,
  onSplitSettingsClose,
  splitSettingsPinned,
  onSplitSettingsPinned,
  splitShowBasemap,
  splitShowGrid,
  splitShowCoords,
  onSplitBasemapToggle,
  onSplitGridToggle,
  onSplitCoordsToggle,
  splitTabs,
  activeSplitTabId,
  onSplitTabChange,
  onSplitTabWorkspaceChange,
  onExitSplitMode,
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

  // Split-screen overrides: the split view's own basic settings (kept in the
  // URL) win over — but never mutate — the workspace's saved settings, so
  // closing the split leaves the workspace exactly as it was.
  const effShowBasemap = splitPane ? !!splitShowBasemap : showBasemap;
  const effShowGrid = splitPane ? !!splitShowGrid : showGrid;
  const effShowCoordinates = splitPane ? !!splitShowCoords : showCoordinates;
  // In split mode the split-level gear owns the dialog's open state.
  const settingsOpen = splitPane ? !!splitSettingsOpen : showSettings;
  // ...and the split-level panel has its own shared pin state (the workspace
  // pin only ever applies to the normal view).
  const effSettingsPinned = splitPane ? !!splitSettingsPinned : settingsPinned;
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
  const doubleClickZoomRef = useRef<any>(null);

  // Transient toast for action feedback (copied coordinates / image, errors).
  const [toast, setToast] = useState<{ id: number; message: string; kind: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    setToast({ id: Date.now(), message, kind });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Draw/vertex-edit subsystem: tools, drawn features, styles, label dialog,
  // undo/redo history, session persistence, sticky-vertex editing and the
  // saved-layer re-edit mode (see hooks/useDrawSession + hooks/useVertexEditing).
  const drawSession = useDrawSession({
    mapRef,
    doubleClickZoomRef,
    workspaceId,
    unitsRef,
    vectorLayersRef,
    vectorLayers,
    rasterLayers,
    setVectorLayers,
    showDrawToolbar,
  });
  const {
    activeDrawTool, drawnFeatures, drawStyle, showDrawnPanel, labelDialogState,
    undoDepth, redoDepth, measureTick, editingVectorLayerId, stickyVertex,
    drawSourceRef, drawLayerRef, drawStyleRef, activeDrawToolRef,
    editingVectorLayerIdRef, editMarkerSourceRef, editMarkerFeatureRef,
    editAccentRef, reeditStyleSeedRef, stickyVertexRef,
    setDrawnFeatures, setShowDrawnPanel,
    handleDrawTool, handleUndo, handleRedo, handleLabelDialogApply, handleLabelDialogCancel,
    handleDrawStyleChange, handleFeatureStyleChange, handleToggleFeatureMeasurements, handleRemoveDrawnFeature,
    handleSaveDrawnToLayers, handleExportDrawnFeatures, handleEditLabelText,
    handleReeditVectorLayer, endReeditSession,
    handleEditClick, handleEditDoubleClick, cancelStickyVertex, deleteStickyTarget,
    addExternalPolygon, liveUpdateDrawnFeatureGeometry, commitSnapCleanup,
  } = drawSession;

  const [mouseCoord, setMouseCoord] = useState<[number, number] | null>(null);
  const [coordProjection, setCoordProjection] = useState<string>('EPSG:4326');
  const [coordDecimals, setCoordDecimals] = useState<number>(6);
  // In-app right-click menu: where it opened (px relative to the map
  // container) plus the map coordinate that was under the cursor.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; coordinate: [number, number] } | null>(null);
  // Box-selection tool: whether the tool is armed and where its right-click
  // menu opened (px relative to the map container).
  const [boxSelectActive, setBoxSelectActive] = useState(false);
  const [boxMenu, setBoxMenu] = useState<{ x: number; y: number } | null>(null);
  // Right-click menu on the settings (gear) button: anchor point (px
  // relative to the map container) of the button's top-right corner.
  const [settingsMenu, setSettingsMenu] = useState<{ x: number; y: number } | null>(null);
  // Which optional details (scale bar, legend, north arrow) get composited
  // onto captured map images ("Save image as…" / "Copy image" in the map
  // context menu). Session-only: plain capture stays the default.
  const [imageDetails, setImageDetails] = useState<ImageDetailOptions>({
    scaleBar: false,
    legend: false,
    northArrow: false,
  });
  // Magnetic edge snapping for the line/polygon tools — classical livewire
  // edge detection (no AI model): holding Shift while drawing snaps
  // vertices to the detected edges of the map image.
  const magneticDraw = useMagneticDraw({
    mapRef,
    activeDrawToolRef,
    activeDrawTool,
    showDrawToolbar,
    showToast,
  });

  // SAM 2.1 AI drawing assistance: magic-wand object tracing (4th toolbar
  // tool). Edge snapping for the line/polygon tools is model-free — see
  // useMagneticDraw above.
  const samTools = useSamTools({
    mapRef,
    activeDrawToolRef,
    activeDrawTool,
    showDrawToolbar,
    addExternalPolygon,
    showToast,
  });

  // Start the SAM 2.1 model download as soon as the wand tool is picked,
  // rather than making the first click wait for ~111 MB.
  const samPrefetch = samTools.prefetch; // stable callback — keeps deps quiet
  useEffect(() => {
    if (activeDrawTool === 'wand') samPrefetch();
  }, [activeDrawTool, samPrefetch]);
  // Persistent, dismissible banner for layer-loading errors (COG / raster).
  // Unlike the transient toast, these carry actionable detail (e.g. the S3
  // CORS config to apply) so they stay until the user closes them.
  const [layerError, setLayerError] = useState<{ id: number; title: string; detail: string } | null>(null);

  // Box-selection subsystem: dashed drag box on the map with move/resize
  // gestures and a right-click menu (see hooks/useBoxSelection and
  // components/BoxContextMenu). The tool is exclusive with the draw tools.
  const boxSelection = useBoxSelection({
    mapRef,
    doubleClickZoomRef,
    active: boxSelectActive && !splitPane,
    onBoxContextMenu: (x, y) => {
      setContextMenu(null);
      setBoxMenu({ x, y });
    },
    activeDrawToolRef,
    editingVectorLayerIdRef,
  });

  const handleBoxToolToggle = () => {
    const next = !boxSelectActive;
    setBoxSelectActive(next);
    setBoxMenu(null);
    setContextMenu(null);
    if (next) {
      // The box tool owns gestures exclusively — stand the draw tools and any
      // saved-layer re-edit session aside.
      handleDrawTool(null);
      if (editingVectorLayerId) endReeditSession(editingVectorLayerId);
    }
  };

  const handleDrawToolSelect = (tool: DrawToolId) => {
    if (tool) setBoxSelectActive(false);
    handleDrawTool(tool);
  };




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

    // Split-screen panes share a single View instance (created by
    // SplitScreen) so both sides always show the same extent and zoom —
    // dragging the divider reveals differences at the same location.
    let mapview: View;
    if (sharedView) {
      mapview = sharedView;
    } else {
      const { center, zoom } = getInitialView(workspaceId, !splitPane);
      mapview = new View({
        center: center,
        zoom: zoom,
        minZoom: 2,
        maxZoom: 25,
      });
    }

    const map = new OLMap({
      target: mapTargetId,
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

    // Keep the canvas in step with its container — split-screen pane widths
    // change live while the divider is dragged.
    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => map.updateSize());
      const targetEl = document.getElementById(mapTargetId);
      if (targetEl) resizeObserver.observe(targetEl);
    }

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
    const onMapPointerMove = (evt: any) => {
      // A picked-up vertex follows the pointer until it is placed — even
      // while a mouse button happens to be held down.
      const sticky = stickyVertexRef.current;
      if (sticky) {
        setVertexCoordinate(sticky.geom, sticky.indexPath, evt.coordinate as number[]);
        if (editMarkerFeatureRef.current) {
          editMarkerFeatureRef.current.getGeometry().setCoordinates(evt.coordinate);
        }
        (map.getTargetElement() as HTMLElement).style.cursor = 'grabbing';
        if (!evt.dragging) {
          setMouseCoord(evt.coordinate as [number, number]);
          if (splitPane && onMouseCoordinate) onMouseCoordinate(evt.coordinate as [number, number]);
        }
        return;
      }

      if (evt.dragging) return;
      setMouseCoord(evt.coordinate as [number, number]);
      if (splitPane && onMouseCoordinate) onMouseCoordinate(evt.coordinate as [number, number]);

      // While geometry is being edited — the draw toolbar's edit tool or a
      // saved layer's re-edit session — the cursor says what a press will
      // do: grab over a vertex, move over the feature body.
      const reeditLayerId = editingVectorLayerIdRef.current;
      const activeToolNow = activeDrawToolRef.current;

      // The magic wand aims at objects — show a crosshair while it's active.
      if (activeToolNow === 'wand') {
        (map.getTargetElement() as HTMLElement).style.cursor = 'crosshair';
        return;
      }

      const editCursorMode = activeToolNow === 'modify' || (reeditLayerId !== null && activeToolNow === null);
      if (editCursorMode) {
        const editSource = reeditLayerId !== null
          ? getLayerRawSource(vectorLayersRef.current, reeditLayerId)
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
    };
    map.on('pointermove', onMapPointerMove);

    // Setup drawing layer with style function
    const drawSource = new VectorSource();
    
    const drawLayerStyle = (feature: any) => {
      const ds = drawStyleRef.current;
      const styles: Style[] = [buildDrawFeatureStyle(ds, feature.get('labelText'))];
      const geom = feature.getGeometry();
      if (geom && shouldShowFeatureMeasurements(feature)) {
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

    // SAM overlay layer (wand preview) — flagged _isSamLayer so captures
    // and reordering skip it.
    samTools.attachSamLayers(map);

    // Magnetic-edge guide layer (livewire) — flagged _isMagneticLayer for
    // the same reason.
    magneticDraw.attachLayers(map);

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
    const onMapDblClick = (evt: any) => {
      // Double-click finishes a magic-wand trace (commits the preview polygon).
      if (activeDrawToolRef.current === 'wand') {
        evt.stopPropagation();
        samTools.confirmWand();
        return;
      }
      handleEditDoubleClick(evt);
    };
    map.on('dblclick', onMapDblClick);

    // Click handler for feature info — shows attributes for *every* vector
    // feature under the clicked point (grouped by layer, topmost first) and,
    // for WMS layers with GetFeatureInfo enabled, queries the server for the
    // raster attributes at that position.
    const onMapClick = (evt: any) => {
      // Magic wand: clicks are SAM point prompts that trace/refine the
      // object under the pointer — never feature queries.
      if (activeDrawToolRef.current === 'wand') {
        void samTools.handleWandClick(evt);
        return;
      }
      // While a draw tool is active clicks place vertices, and while a saved
      // layer is being re-edited clicks grab vertices — suppress the
      // feature-info popup in both cases so editing isn't interrupted by it.
      if (activeDrawToolRef.current !== null || editingVectorLayerIdRef.current !== null) {
        // Edit modes own clicks: pick up / place vertices, insert on segments.
        handleEditClick(evt);
        return;
      }
      // The box-selection tool owns clicks too: they place the box corners.
      if (boxSelection.activeRef.current) return;

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

      // renderRows, renderFeatureBlock, buildVectorSections, buildWmsSections, buildPopup
      // — extracted to utils/popupHtml.ts


      // No WMS layers to query — render synchronously (original behaviour).
      if (wmsInfoLayers.length === 0) {
        setPopupContent(buildPopup(hitsByLayer, vectorLayerNamesRef.current, vectorFeatureCount, []));
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
      setPopupContent([...buildVectorSections(hitsByLayer, vectorLayerNamesRef.current, vectorFeatureCount > 1), ...loadingSections].join(''));
      setPopupPosition(coordinate);

      Promise.all(
        wmsInfoLayers.map(async ({ name, olLayer }) => ({
          name,
          result: await fetchWmsFeatureInfo(olLayer, coordinate, map),
        }))
      ).then(wmsResults => {
        // A newer click has already taken over the popup — drop stale results.
        if (popupClickSeqRef.current !== clickSeq) return;
        setPopupContent(buildPopup(hitsByLayer, vectorLayerNamesRef.current, vectorFeatureCount, wmsResults));
        setPopupPosition(coordinate);
      }).catch(() => {
        // Defensive: never leave the popup stuck on the loading indicator.
        if (popupClickSeqRef.current !== clickSeq) return;
        setPopupContent(buildPopup(hitsByLayer, vectorLayerNamesRef.current, vectorFeatureCount, []));
        setPopupPosition(coordinate);
      });
    };
    map.on('click', onMapClick);

    // Split-screen panes persist their view to storage only — the shared URL
    // belongs to the split state, not to either pane.
    map.on('moveend', () => {
      if (splitPane) saveView(mapview, workspaceId);
      else updateUrlParams(mapview, workspaceId);
    });

    // Restore layers from localStorage
    const restorePersistedLayers = async () => {
    const restoredRasterLayers: RasterLayer[] = [];
    let missedFileCog = false;
    for (const layerConfig of storedSettings.current.rasterLayers) {
      try {
        const { olLayer, extent } = await createRasterOlLayer(layerConfig);

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
        // File COG layers only survive workspace switches (their blob URL is
        // kept in the session registry); after a page reload the file bytes
        // are gone and the user must re-add the file.
        if (layerConfig.type === 'cog' && layerConfig.cogSource === 'file') missedFileCog = true;
        console.error('[MapPage] Failed to restore raster layer:', error);
      }
    }
    if (missedFileCog) {
      showToast('File-based COG layers are session-only — please re-add the GeoTIFF file(s).', 'error');
    }

    // Restore all vector layers from localStorage via utils/layerRestore
    const restoreCb: RestoreCallbacks = {
      markVectorLoading,
      wireVectorTileLoading,
      getUnits: () => unitsRef.current,
    };
    const allVectorConfigs = storedSettings.current.vectorLayers;
    const restoredMvtLayers = restoreMvtLayers(map, allVectorConfigs, vectorLayersRef.current, restoreCb);
    const restoredWfsLayers = restoreWfsLayers(map, allVectorConfigs, vectorLayersRef.current, restoreCb);
    const restoredStacLayers = restoreStacLayers(map, allVectorConfigs, vectorLayersRef.current, restoreCb);
    const restoredDrawnLayers = restoreDrawnLayers(map, allVectorConfigs, vectorLayersRef.current, restoreCb);
    const restoredFileLayers = await restoreFileLayers(map, allVectorConfigs, vectorLayersRef.current, restoreCb);

    // Set state with all restored layers
    const restoredVectorLayers = [...restoredMvtLayers, ...restoredWfsLayers, ...restoredStacLayers, ...restoredDrawnLayers, ...restoredFileLayers];
    setRasterLayers(restoredRasterLayers);
    setVectorLayers(restoredVectorLayers);
    if (restoredRasterLayers.length > 0 || restoredVectorLayers.length > 0) {
      reorderLayers(map, restoredRasterLayers, restoredVectorLayers);
    }
    setIsRestoringLayers(false);
    };
    void restorePersistedLayers();

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
    // Escape puts it back where it was picked up. preventDefault marks the
    // Escape as consumed so the draw session's exit-on-Escape handler (which
    // is registered later and therefore fires after this one) stands aside.
    const handleEditKeys = (e: KeyboardEvent) => {
      if (!stickyVertexRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteStickyTarget();
      } else if (e.key === 'Escape') {
        e.preventDefault();
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
      if (resizeObserver) resizeObserver.disconnect();
      samTools.disposeSamTools();
      magneticDraw.dispose();
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
    if (!settingsOpen || effSettingsPinned) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // Clicks inside the wrapper (dialog + gear button) have their own handlers
      if (settingsWrapperRef.current && settingsWrapperRef.current.contains(target)) return;
      // The split-level gear toggles this dialog itself — don't race it
      if (target.closest('.split-settings-button')) return;
      // In split mode the dialog is portaled outside the wrapper
      if (target.closest('.settings-dialog')) return;
      // Keep Settings open while the Advanced Settings overlay (opened from it) is in use
      if (target.closest('.advanced-settings-overlay')) return;
      // CustomSelect dropdowns render their menus in a portal on document.body,
      // so the menu lives outside the wrapper even when the select itself is
      // inside the Settings dialog — don't treat clicks on it as outside clicks.
      if (target.closest('.custom-select-menu-portal')) return;
      // The lock icon's right-click password menu is likewise portaled to body.
      if (target.closest('.lock-context-menu')) return;
      // As is the split button's right-click workspace picker.
      if (target.closest('.split-menu')) return;
      // As is the vector layer's grouped Download format menu.
      if (target.closest('.settings-export-menu')) return;
      // The Set/Reset-password dialogs render as full-window overlays outside
      // the wrapper (opened from the Settings footer) - keep Settings open while
      // the user interacts with them. The lock overlay is excluded for symmetry.
      if (target.closest('.setpw-overlay') || target.closest('.lock-overlay')) return;
      if (splitPane) {
        // The split-level dialog's open state lives in SplitScreen.
        if (onSplitSettingsClose) onSplitSettingsClose();
      } else {
        setShowSettings(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [settingsOpen, effSettingsPinned, splitPane, onSplitSettingsClose]);

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

    if (effShowGrid) {
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
  }, [effShowGrid]);

  useEffect(() => {
    if (basemapLayerRef.current) {
      basemapLayerRef.current.setVisible(effShowBasemap);
    }
  }, [effShowBasemap]);

  // Swap the basemap tile source live when the user edits the basemap URL
  useEffect(() => {
    if (!basemapLayerRef.current) return;
    const key = basemapSourceKey(basemapUrl, basemapMinZoom, basemapMaxZoom);
    if (appliedBasemapKeyRef.current === key) return;
    appliedBasemapKeyRef.current = key;
    basemapLayerRef.current.setSource(createBasemapSource(basemapUrl, basemapMinZoom, basemapMaxZoom));
  }, [basemapUrl, basemapMinZoom, basemapMaxZoom]);


  // Keep the OL-layer → display-name map in sync so popup sections can be
  // labelled with the current vector layer names.
  useEffect(() => {
    const names = new Map<any, string>();
    vectorLayers.forEach(cfg => {
      if (cfg.olLayer) names.set(cfg.olLayer, cfg.name);
    });
    vectorLayerNamesRef.current = names;
  }, [vectorLayers]);


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
  // createCogLayer — extracted to utils/rasterLayerFactory.ts


  // resolveCogUrl — extracted to utils/rasterLayerFactory.ts


  const handleEditRasterLayer = async (updated: RasterLayer) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      mapRef.current.removeLayer(olLayer);
      const { olLayer: newOlLayer, extent } = await createRasterOlLayer(updated);

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
      // The old OL layer was already removed from the map - restore it so a
      // failed edit (e.g. unreachable WMTS capabilities URL) does not leave
      // the layer invisible, and surface the error to the user.
      mapRef.current.addLayer(olLayer);
      showToast('Could not apply raster layer edits', 'error');
      console.error('[MapPage] Failed to edit raster layer:', error);
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

        const geojsonFormat = new GeoJSON();
        features = geojsonFormat.readFeatures({
          type: 'FeatureCollection',
          features: shapefileResult.features
        }, {
          dataProjection: dataProjection,
          featureProjection: 'EPSG:3857',
        });

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
        id: generateId(),
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
      console.error('[MapPage] Failed to load vector layer:', error);
      alert(`Failed to load "${fileName}". The file may be corrupted or in an unsupported format.`);
    }
  };

  const handleAddMVTLayer = async (url: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const layerId = generateId();
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
      console.error('[MapPage] Failed to load MVT layer:', error);
      alert(`Failed to load MVT layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleAddWFSLayer = async (url: string, typeName: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const layerId = generateId();
      const wfsUrl = buildWfsUrl(url, typeName);
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: () => {
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
              console.error('[MapPage] WFS load error:', e);
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
      console.error('[MapPage] Failed to load WFS layer:', error);
      alert(`Failed to load WFS layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleAddSTACLayer = async (url: string, collection: string, name: string, limit?: number) => {
    if (!mapRef.current) return;

    try {
      const layerId = generateId();
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
              console.error('[MapPage] STAC load error:', e);
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
      console.error('[MapPage] Failed to load STAC layer:', error);
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
  const handleRemoveVectorLayer = (id: string) => {
    if (!mapRef.current) return;

    // Removing a layer ends its re-edit session, if any.
    endReeditSession(id);

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


  // applyVectorStyleToLayer, applyVectorClusteringToLayer, getLayerRawSource,
  // buildVectorStyle — extracted to utils/vectorStyleHelpers.ts




  const handleApplyVectorStyle = (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    // Apply opacity + style (also overrides KML per-feature styles)
    applyVectorStyleToLayer(olLayer, style, () => unitsRef.current);

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
    }, () => unitsRef.current);
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
      console.warn('[MapPage] Invalid filter expression:', e);
      return false;
    }
    setVectorLayers(prev => prev.map(l => (l.id === layerId ? { ...l, filterEnabled: !!expr, filterExpression: expr } : l)));
    return true;
  };

  // Apply a style to a single feature of a drawn-in-app vector layer.
  const handleApplyVectorFeatureStyle = (_layerId: string, feature: any, style: DrawStyle) => {
    if (!feature) return;
    applyDrawFeatureStyle(feature, style, () => unitsRef.current);
  };

  // Toggle a saved drawn-layer feature's on-map measurement labels.
  const handleToggleVectorFeatureMeasurements = (_layerId: string, feature: any, visible: boolean) => {
    if (!feature) return;
    setDrawFeatureMeasurementsVisible(feature, visible, () => unitsRef.current);
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
            loader: () => {
              markVectorLoading(updated.id, true);
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(updated.id, false);
                })
                .catch(e => {
                  console.error('[MapPage] WFS load error:', e);
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
                  console.error('[MapPage] STAC load error:', e);
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
          applyVectorClusteringToLayer(newOlLayer, true, updated.clusterDistance, { ...updated, opacity: updated.opacity ?? 100 }, () => unitsRef.current);
        }
        // Re-apply any persisted attribute filter to the fresh source. For
        // loader-backed sources the filter listeners evaluate each feature as
        // it arrives.
        if (updated.type !== 'mvt' && updated.filterEnabled && updated.filterExpression) {
          try { applyVectorFeatureFilter(newOlLayer, updated.filterExpression); }
          catch (e) { console.warn('[MapPage] Failed to re-apply vector filter:', e); }
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
        applyVectorClusteringToLayer(olLayer, updated.clusterPoints === true, updated.clusterDistance, { ...updated, opacity: updated.opacity ?? 100 }, () => unitsRef.current);
        applyVectorLayerZoomRange(olLayer, updated.type, updated.minZoom, updated.maxZoom);
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updated : l);
        setVectorLayers(newVectorLayers);
      }
    } catch (error) {
      console.error('[MapPage] Failed to edit vector layer:', error);
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
    // Release file-COG resources: revoke the session blob URL.
    const removed = rasterLayers.find(l => l.id === id);
    if (removed?.type === 'cog' && removed.cogSource === 'file') {
      releaseCogFile(removed.id);
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
      // Only the header slice is read for validation — the OL GeoTIFF source
      // streams the rest of the file via Range requests on the blob URL, so
      // even very large files (tens of GB) work without loading them into
      // memory (a full arrayBuffer() read would fail with NotReadableError).
      const header = await file.slice(0, COG_HEADER_VALIDATION_BYTES).arrayBuffer();
      const validation = validateCogBuffer(header, file.name, file.size);

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

      // Create a blob URL straight from the File (session-only: the URL is
      // kept alive in the session registry so the layer survives workspace
      // switches, but after a reload the file must be re-added). No bytes
      // are copied — not into memory, not into IndexedDB.
      const layerId = Date.now().toString();
      const blobUrl = registerCogFile(layerId, file);

      const layerName = file.name.replace(/\.(tif|tiff|geotiff)$/i, '');
      const layerConfig: RasterLayer = {
        id: layerId,
        name: layerName,
        type: 'cog',
        url: blobUrl,
        cogSource: 'file',
        cogFileName: file.name,
      };

      let cogResult;
      try {
        cogResult = await createCogLayer(blobUrl);
      } catch (e) {
        releaseCogFile(layerId);
        throw e;
      }
      const olLayer = cogResult.olLayer;
      olLayer.setVisible(true);
      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      const extentPatch = cogResult.extent ? { extent: cogResult.extent } : {};
      const newRasterLayers = [...rasterLayers, { ...layerConfig, olLayer, ...extentPatch }];
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);
    } catch (error: any) {
      console.error('[MapPage] Failed to add COG file:', error);
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
      const { olLayer, extent } = await createRasterOlLayer(layerConfig);

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
      // A file COG that failed to load must not keep its blob URL alive.
      if (layerConfig.type === 'cog' && layerConfig.cogSource === 'file') {
        releaseCogFile(layerConfig.id);
      }
      console.error('[MapPage] Failed to add raster layer:', error);
      showLayerError('Failed to add raster layer', error instanceof Error ? error.message : String(error));
    }
  };

  /* ---------------------------------------------------------------------
     Right-click context menu — an in-app replacement for the browser's
     native context menu on the map surface. Offers "Copy coordinates",
     "Save image as…" and "Copy image" (the latter two capture the rendered
     map canvas). See components/MapContextMenu.tsx for the menu itself.
     --------------------------------------------------------------------- */

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

  const handleToggleImageDetail = useCallback((key: keyof ImageDetailOptions) => {
    setImageDetails((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Right-click on the gear button opens the settings shortcut menu
  // (lock / reset password / display toggles) instead of the browser menu.
  const handleSettingsContextMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const button = e.currentTarget;
    const container = button.closest('.map-container') as HTMLElement | null;
    if (!container) return;
    const buttonRect = button.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setSettingsMenu({
      x: buttonRect.right - containerRect.left,
      y: buttonRect.top - containerRect.top,
    });
  };

  const handleMapContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only replace the browser menu on the map surface itself — controls,
    // popups, panels and text inputs keep their native context menu.
    const target = e.target as HTMLElement;
    if (target.tagName !== 'CANVAS' && !target.closest('.ol-layer')) return;

    const map = mapRef.current;
    if (!map) return;
    e.preventDefault();
    setBoxMenu(null);

    const viewportRect = map.getViewport().getBoundingClientRect();
    const pixel: [number, number] = [
      e.clientX - viewportRect.left,
      e.clientY - viewportRect.top,
    ];

    // Magic wand: right-click removes the refine/exclude point marker under
    // the cursor (re-tracing the mask without it). When no marker is hit
    // the normal context menu opens below.
    if (activeDrawToolRef.current === 'wand') {
      if (samTools.removeWandPointAtPixel(pixel)) return;
    }

    const coordinate = map.getCoordinateFromPixel(pixel);
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
      drawMapDetails(canvas, map, imageDetails, units, buildLegendEntries(rasterLayers, vectorLayers));
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
      drawMapDetails(canvas, map, imageDetails, units, buildLegendEntries(rasterLayers, vectorLayers));
      const blob = await canvasToPngBlob(canvas);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Map image copied to clipboard');
    } catch (err) {
      reportCaptureError(err);
    }
  };

  /* ---------------------------------------------------------------------
     Selection-box actions — right-click menu on the box drawn by the
     box-selection tool: feature inspection across the boxed extent, and
     image capture of just the boxed region (clipboard or file).
     --------------------------------------------------------------------- */

  /** Show the feature-info popup for everything intersecting the selection
   * box: vector features (extent query instead of point hit) plus WMS
   * GetFeatureInfo for layers with the info toggle on. */
  const handleBoxShowFeatures = () => {
    setBoxMenu(null);
    const map = mapRef.current;
    const extent = boxSelection.getBoxExtent();
    if (!map || !extent) return;

    // Bump the shared popup sequence so in-flight click popups go stale.
    const clickSeq = ++popupClickSeqRef.current;

    const { hitsByLayer, totalCount, truncated } = collectVectorHitsInExtent(map, extent);

    const wmsInfoLayers = wmsFeatureInfoRef.current.filter(entry => {
      const ol = entry.olLayer;
      return ol && ol.getVisible?.() !== false && ol.getSource?.();
    });

    if (totalCount === 0 && wmsInfoLayers.length === 0) {
      setPopupContent(null);
      setPopupPosition(null);
      showToast('No features found in the selection box');
      return;
    }

    // Popup anchored just above the top-centre of the selection box.
    const popupPos: [number, number] = [(extent[0] + extent[2]) / 2, extent[3]];
    const notice = truncated
      ? '<div class="popup-row popup-row-muted">Showing the first ' + totalCount + ' matching features</div>'
      : '';

    if (wmsInfoLayers.length === 0) {
      setPopupContent(notice + buildPopup(hitsByLayer, vectorLayerNamesRef.current, totalCount, []));
      setPopupPosition(popupPos);
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
    setPopupContent(notice + [...buildVectorSections(hitsByLayer, vectorLayerNamesRef.current, totalCount > 1), ...loadingSections].join(''));
    setPopupPosition(popupPos);

    Promise.all(
      wmsInfoLayers.map(async ({ name, olLayer }) => ({
        name,
        result: await fetchWmsFeatureInfoExtent(olLayer, extent, map),
      }))
    ).then(wmsResults => {
      if (popupClickSeqRef.current !== clickSeq) return;
      setPopupContent(notice + buildPopup(hitsByLayer, vectorLayerNamesRef.current, totalCount, wmsResults));
      setPopupPosition(popupPos);
    }).catch(() => {
      if (popupClickSeqRef.current !== clickSeq) return;
      setPopupContent(notice + buildPopup(hitsByLayer, vectorLayerNamesRef.current, totalCount, []));
      setPopupPosition(popupPos);
    });
  };

  /** Composite the rendered map and crop it to the selection box. Returns
   * null (with a toast) when the box is off-screen. */
  const captureSelectionCanvas = async (): Promise<HTMLCanvasElement | null> => {
    const map = mapRef.current;
    const extent = boxSelection.getBoxExtent();
    if (!map || !extent) return null;
    const fullCanvas = await captureMapCanvas(map);
    const boxPixels = extentToPixelRect(extent, (c) => map.getPixelFromCoordinate(c) as [number, number]);
    const rect = clampRectToSize(boxPixels, fullCanvas.width, fullCanvas.height);
    if (!rect || rect.width < 1 || rect.height < 1) {
      showToast('The selection box is outside the current map view', 'error');
      return null;
    }
    return cropCanvasToRect(fullCanvas, rect);
  };

  const handleBoxCopyImage = async () => {
    setBoxMenu(null);
    try {
      const canvas = await captureSelectionCanvas();
      if (!canvas) return;
      const blob = await canvasToPngBlob(canvas);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Selection image copied to clipboard');
    } catch (err) {
      reportCaptureError(err);
    }
  };

  const handleBoxSaveImageAs = async () => {
    setBoxMenu(null);
    try {
      const canvas = await captureSelectionCanvas();
      if (!canvas) return;
      const blob = await canvasToPngBlob(canvas);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `map-selection-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Selection image saved');
    } catch (err) {
      reportCaptureError(err);
    }
  };

  /** Remove the current selection box so a new one can be drawn. */
  const handleBoxDelete = () => {
    setBoxMenu(null);
    boxSelection.clearBox();
    showToast('Selection box removed');
  };


  // The settings dialog as a standalone element: in split mode it is
  // portaled out of the clipped map subtree and docks fixed to the viewport
  // bottom-left (same spot as the normal view's gear). Split mode keeps BOTH
  // sides' dialogs mounted — switching tabs only toggles visibility, so the
  // panel never closes and reopens.
  const settingsDialogElement = (splitPane || settingsOpen) ? (
    <SettingsDialog 
            onClose={splitPane ? () => { if (onSplitSettingsClose) onSplitSettingsClose(); } : () => setShowSettings(false)} 
            onEnterSplitScreen={splitPane ? undefined : onEnterSplitScreen}
            splitPaneMode={splitPane}
            splitTabs={splitTabs}
            activeSplitTabId={activeSplitTabId}
            onSplitTabChange={onSplitTabChange}
            splitHidden={splitPane && !splitSettingsOpen}
            onSplitTabWorkspaceChange={onSplitTabWorkspaceChange}
            onExitSplitMode={onExitSplitMode}
            pinned={effSettingsPinned}
            onPinToggle={splitPane ? (v) => { if (onSplitSettingsPinned) onSplitSettingsPinned(v); } : setSettingsPinned}
            showBasemap={effShowBasemap}
            onBasemapToggle={splitPane ? (v) => { if (onSplitBasemapToggle) onSplitBasemapToggle(v); } : setShowBasemap}
            showGrid={effShowGrid}
            onGridToggle={splitPane ? (v) => { if (onSplitGridToggle) onSplitGridToggle(v); } : setShowGrid}
            showDrawToolbar={splitPane ? false : showDrawToolbar}
            onDrawToolbarToggle={setShowDrawToolbar}
            showCoordinates={effShowCoordinates}
            onCoordinatesToggle={splitPane ? (v) => { if (onSplitCoordsToggle) onSplitCoordsToggle(v); } : setShowCoordinates}
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
            onToggleVectorFeatureMeasurements={handleToggleVectorFeatureMeasurements}
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
  ) : null;

  return (
    <div 
      id={mapTargetId} 
      className={`map-container${splitPane ? ` map-container--split map-container--split-${splitSide}` : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleMapContextMenu}
    >
      {isDragging && (
        <div className="map-drop-overlay">
          <div className="map-drop-overlay-label">
            Drop vector files or GeoTIFF here
          </div>
        </div>
      )}
      {!splitPane && <GoToBar onGoTo={handleGoTo} />}
      {/* Split screen renders ONE centred coordinate display for both panes */}
      {!splitPane && showCoordinates && <MouseCoordinateDisplay
        coordinate={mouseCoord}
        projection={coordProjection}
        onProjectionChange={setCoordProjection}
        decimals={coordDecimals}
        onDecimalsChange={setCoordDecimals}
      />}

      {!splitPane && showDrawToolbar && (
        <DrawToolbar
          activeTool={activeDrawTool}
          onToolSelect={handleDrawToolSelect}
          boxSelectActive={boxSelectActive}
          onBoxSelectToggle={handleBoxToolToggle}
          undoDepth={undoDepth}
          redoDepth={redoDepth}
          onUndo={handleUndo}
          onRedo={handleRedo}
          historyEnabled={activeDrawTool !== null || editingVectorLayerId !== null}
          magneticArmed={magneticDraw.magneticArmed}
          onMagneticToggle={(tool) => {
            const turningOn = !magneticDraw.magneticArmed[tool];
            magneticDraw.toggleMagnetic(tool);
            // Arming also activates the tool it belongs to.
            if (turningOn && activeDrawTool !== tool) {
              handleDrawToolSelect(tool);
            }
          }}
          samBusy={samTools.samStatus.state === 'loading-runtime' || samTools.samStatus.state === 'loading-local' || samTools.samStatus.state === 'downloading' || samTools.samStatus.state === 'extracting' || samTools.samStatus.state === 'compiling'}
        />
      )}
      {!splitPane && showDrawToolbar && activeDrawTool !== null && editingVectorLayerId === null && (
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
          onToggleFeatureMeasurements={handleToggleFeatureMeasurements}
          onEditLabelText={handleEditLabelText}
          units={units}
          measureVersion={measureTick}
          workspaceId={workspaceId}
          onSnapCleanLive={liveUpdateDrawnFeatureGeometry}
          onSnapCleanCommit={commitSnapCleanup}
        />
      )}
      {!splitPane && (activeDrawTool === 'modify' || editingVectorLayerId !== null) && (
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
            <>
              <span>Nothing to edit yet — draw a line, polygon, rectangle or label first</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Esc</b> exits</span>
            </>
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
              {activeDrawTool === 'modify' && (
                <>
                  <span className="draw-modify-hint-sep" aria-hidden="true" />
                  <span><b>Esc</b> exits</span>
                </>
              )}
            </>
          )}
        </div>
      )}
      {!splitPane && boxSelectActive && (
        <div className="draw-modify-hint" role="status">
          <span><b>Click</b> two corners to draw a selection box</span>
          <span className="draw-modify-hint-sep" aria-hidden="true" />
          <span><b>Drag</b> the box to move it, handles to resize</span>
          <span className="draw-modify-hint-sep" aria-hidden="true" />
          <span><b>Right-click</b> the box for actions (or delete it to draw a new one)</span>
          <span className="draw-modify-hint-sep" aria-hidden="true" />
          <span><b>Esc</b> clears it</span>
        </div>
      )}
      {!splitPane && showDrawToolbar && activeDrawTool === 'wand' && (
        <div className="draw-modify-hint" role="status">
          {samTools.samStatus.state === 'downloading' || samTools.samStatus.state === 'loading-runtime' || samTools.samStatus.state === 'loading-local' || samTools.samStatus.state === 'extracting' || samTools.samStatus.state === 'compiling' ? (
            <span className="sam-hint-chip">
              <span className="sam-hint-spinner" aria-hidden="true" />
              {samTools.samStatus.state === 'downloading'
                ? `Downloading SAM 2.1 Tiny\u2026 ${Math.round(samTools.samStatus.progress * 100)}% (one-time, ~111 MB)`
                : samTools.samStatus.message || 'Preparing AI model\u2026'}
            </span>
          ) : samTools.samStatus.state === 'error' ? (
            <span className="sam-hint-chip error">AI model unavailable \u2014 {samTools.samStatus.message}</span>
          ) : samTools.samStatus.state === 'encoding' ? (
            <span className="sam-hint-chip">
              <span className="sam-hint-spinner" aria-hidden="true" />
              Analyzing map image\u2026
            </span>
          ) : (
            <>
              <span><b>Click</b> an object to trace its outline</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Click</b> again to refine, <b>Shift+click</b> to exclude</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Right-click</b> a marker to remove it, <b>Backspace</b> removes the last</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Enter</b> or <b>double-click</b> keeps the polygon</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Esc</b> cancels</span>
            </>
          )}
        </div>
      )}
      {!splitPane && showDrawToolbar && (activeDrawTool === 'line' || activeDrawTool === 'polygon') && magneticDraw.magneticArmed[activeDrawTool] && (
        <div className="draw-modify-hint" role="status">
          <span className="sam-hint-chip">Magnetic edges</span>
          {magneticDraw.magneticStatus === 'extracting' ? (
            <span className="sam-hint-chip">
              <span className="sam-hint-spinner" aria-hidden="true" />
              Finding edges…
            </span>
          ) : magneticDraw.magneticStatus === 'error' ? (
            <span><b>Edge detection failed</b> — right-click the tool button to retry</span>
          ) : (
            <span><b>Hold Shift</b> while drawing to snap vertices to the map's edges</span>
          )}
          <span className="draw-modify-hint-sep" aria-hidden="true" />
          <span><b>Right-click</b> the tool button to turn magnetic edges off</span>
        </div>
      )}
      {!splitPane && labelDialogState && (
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
        {!splitPane && settingsDialogElement}
        {!splitPane && (
        <button
          className="map-settings-button"
          onClick={() => setShowSettings((prev) => !prev)}
          onContextMenu={handleSettingsContextMenu}
          title="Settings"
        >
          <GearIcon />
        </button>
        )}
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
          imageDetails={imageDetails}
          onToggleImageDetail={handleToggleImageDetail}
          onCopyCoordinates={handleCopyCoordinates}
          onSaveImage={handleSaveImageAs}
          onCopyImage={handleCopyImage}
          onClose={() => setContextMenu(null)}
        />
      )}
      {settingsMenu && (
        <SettingsContextMenu
          x={settingsMenu.x}
          y={settingsMenu.y}
          hasLockPassword={hasLockPassword}
          onLockApp={onLockApp}
          onResetPassword={onResetPassword}
          showBasemap={showBasemap}
          showGrid={showGrid}
          showDrawToolbar={showDrawToolbar}
          showCoordinates={showCoordinates}
          onToggleBasemap={() => setShowBasemap((v) => !v)}
          onToggleGrid={() => setShowGrid((v) => !v)}
          onToggleDrawToolbar={() => setShowDrawToolbar((v) => !v)}
          onToggleCoordinates={() => setShowCoordinates((v) => !v)}
          onClose={() => setSettingsMenu(null)}
        />
      )}
      {boxMenu && (
        <BoxContextMenu
          key={`${boxMenu.x}-${boxMenu.y}`}
          x={boxMenu.x}
          y={boxMenu.y}
          onShowFeatures={handleBoxShowFeatures}
          onCopyImage={handleBoxCopyImage}
          onSaveImage={handleBoxSaveImageAs}
          onDelete={handleBoxDelete}
          onClose={() => setBoxMenu(null)}
        />
      )}
      {layerError && (
        <LayerErrorBanner error={layerError} onDismiss={() => setLayerError(null)} />
      )}

      {toast && <MapToast toast={toast} />}
      {splitPane && settingsDialogElement && createPortal(settingsDialogElement, document.body)}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   App lock: password setup dialog + full-screen lock overlay
   --------------------------------------------------------------------------- */

