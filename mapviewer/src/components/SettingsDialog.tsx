import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import {
  RasterLayer,
  LayerGroup,
  VectorLayerConfig,
  KnownSource,
  WmtsLayerInfo,
  WmsLayerInfo,
  DrawStyle,
  UnitsSystem,
  WorkspaceMeta,
} from '../types';
import { CHECKERBOARD, TILE_ZOOM_MIN, TILE_ZOOM_MAX } from '../constants';
import { parseColor, rgbaToString } from '../utils/colorHelpers';
import { VECTOR_EXPORT_FORMATS, VectorExportFormat } from '../utils/vectorExport';
import { layerPointStats, vectorFilterStats, vectorFeatureSource } from '../utils/layerHelpers';
import { checkFeatureFilter, compileFeatureFilter, featureProperties } from '../utils/featureFilter';
import {
  GearIcon,
  LockIcon,
  PinIcon,
  PencilIcon,
  EyeIcon,
  ZoomToExtentIcon,
  FolderIcon,
  FolderPlusIcon,
  GroupEyeIcon,
  KeyIcon,
  ResetKeyIcon,
  FunnelIcon,
} from './Icons';
import { CustomSelect } from './CustomSelect';
import { ColorAlphaEditor } from './ColorAlphaEditor';
import { TileZoomRangeControl, parseZoomInput } from './TileZoomRangeControl';
import { WorkspaceSelector } from './WorkspaceSelector';
import { VectorFeatureStyleItem } from './DrawToolbar';
import {
  buildLayerPanelItems,
  moveLayerToSlot,
  moveGroupToSlot,
  moveLayerToJoinAt,
  syncGroupAnchors,
  anchorEmptiedGroups,
  layerOrderKey,
  makeGroupId,
  GroupAssignMenu,
  dropPlace,
  spanActivate,
  itemIdxOfLayer,
  slotAfterId,
} from './LayerPanel';

// Query-expression constructs surfaced as hint chips under the filter field,
// so users can discover the grammar without reading docs.
const FILTER_SYNTAX_HINTS = ['=', '!=', '<', '>', '<=', '>=', 'is true', 'is null', "like '%…%'", 'and', 'or', '( )'];

export function SettingsDialog({ 
  onClose, 
  pinned,
  onPinToggle,
  showBasemap,
  onBasemapToggle,
  showGrid, 
  onGridToggle,
  showDrawToolbar,
  onDrawToolbarToggle,
  showCoordinates,
  onCoordinatesToggle,
  rasterLayers,
  rasterGroups,
  onUpdateRasterGroups,
  onToggleRasterGroup,
  onMoveRasterLayerToGroup,
  onAddRasterLayer,
  onEditRasterLayer,
  onRemoveRasterLayer,
  onToggleRasterLayer,
  onApplyColorAdjustments,
  onApplyTileZoomRange,
  vectorLayers,
  vectorGroups,
  onUpdateVectorGroups,
  onToggleVectorGroup,
  onMoveVectorLayerToGroup,
  onToggleVectorLayer,
  onRemoveVectorLayer,
  onEditVectorLayer,
  onApplyVectorStyle,
  onApplyVectorZoomRange,
  onApplyVectorCluster,
  onApplyVectorFilter,
  onApplyVectorFeatureStyle,
  onReorderRasterLayers,
  onReorderVectorLayers,
  onAddVectorLayer,
  onAddMVTLayer,
  onAddWFSLayer,
  onAddSTACLayer,  onExportVectorLayer,
  onReeditVectorLayer,
  editingVectorLayerId,
  onGoToVectorLayerExtent,
  onGoToRasterLayerExtent,
  onAdvancedSettings,
  knownSources,
  isRestoringLayers,
  loadingVectorIds,
  units,
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
}: { 
  onClose: () => void; 
  pinned: boolean;
  onPinToggle: (pinned: boolean) => void;
  showBasemap: boolean;
  onBasemapToggle: (checked: boolean) => void;
  showGrid: boolean;
  onGridToggle: (checked: boolean) => void;
  showDrawToolbar: boolean;
  onDrawToolbarToggle: (checked: boolean) => void;
  showCoordinates: boolean;
  onCoordinatesToggle: (checked: boolean) => void;
  rasterLayers: RasterLayer[];
  rasterGroups: LayerGroup[];
  onUpdateRasterGroups: (groups: LayerGroup[]) => void;
  onToggleRasterGroup: (groupId: string) => void;
  onMoveRasterLayerToGroup: (layerId: string, groupId: string | undefined) => void;
  onAddRasterLayer: (layer: RasterLayer) => Promise<void>;
  onEditRasterLayer: (layer: RasterLayer) => void;
  onRemoveRasterLayer: (id: string) => void;
  onToggleRasterLayer: (id: string) => void;
  onApplyColorAdjustments: (layerId: string, adjustments: { brightness?: number; saturation?: number; contrast?: number; opacity?: number }) => void;
  onApplyTileZoomRange: (layerId: string, minZoom?: number, maxZoom?: number) => void;
  vectorLayers: VectorLayerConfig[];
  vectorGroups: LayerGroup[];
  onUpdateVectorGroups: (groups: LayerGroup[]) => void;
  onToggleVectorGroup: (groupId: string) => void;
  onMoveVectorLayerToGroup: (layerId: string, groupId: string | undefined) => void;
  onToggleVectorLayer: (id: string) => void;
  onRemoveVectorLayer: (id: string) => void;
  onEditVectorLayer: (layer: VectorLayerConfig) => void;
  onApplyVectorStyle: (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => void;
  onApplyVectorZoomRange: (layerId: string, minZoom?: number, maxZoom?: number) => void;
  onApplyVectorCluster: (layerId: string, clusterPoints: boolean, clusterDistance: number) => void;
  onApplyVectorFilter: (layerId: string, enabled: boolean, expression: string) => boolean;
  onApplyVectorFeatureStyle: (layerId: string, feature: any, style: DrawStyle) => void;
  onReorderRasterLayers: (layers: RasterLayer[]) => void;
  onReorderVectorLayers: (layers: VectorLayerConfig[]) => void;
  onAddVectorLayer: (file: File, layerName?: string) => Promise<void>;
  onAddMVTLayer: (url: string, name: string) => Promise<void>;
  onAddWFSLayer: (url: string, typeName: string, name: string) => Promise<void>;
  onAddSTACLayer: (url: string, collection: string, name: string, limit?: number) => Promise<void>;  onExportVectorLayer: (layerId: string, format: VectorExportFormat) => void;
  onReeditVectorLayer: (layerId: string) => void;
  editingVectorLayerId: string | null;
  onGoToVectorLayerExtent: (layerId: string) => void;
  onGoToRasterLayerExtent: (layerId: string) => void;
  onAdvancedSettings: () => void;
  knownSources: KnownSource[];
  isRestoringLayers: boolean;
  loadingVectorIds: Set<string>;
  units: UnitsSystem;
  workspaceId: string;
  workspaces: WorkspaceMeta[];
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDuplicateWorkspace: (id: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onLockApp: () => void;
  /** True once a lock password has been established this session. Drives the
   * lock icon's right-click menu label ("Reset" vs "Set" password). */
  hasLockPassword: boolean;
  /** Right-click menu: define the first password (does not lock immediately). */
  onSetPassword: () => void;
  /** Right-click menu: change the existing password (asks for the current one). */
  onResetPassword: () => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  // ----- Lock icon right-click menu (Set / Reset password) -----
  const lockButtonRef = useRef<HTMLButtonElement>(null);
  const lockMenuRef = useRef<HTMLDivElement>(null);
  // Viewport-anchored position (fixed) of the menu; null = closed.
  const [lockMenuPos, setLockMenuPos] = useState<{ left: number; bottom: number } | null>(null);

  const closeLockMenu = useCallback(() => setLockMenuPos(null), []);

  const openLockMenu = useCallback((e: React.MouseEvent) => {
    // Suppress the native menu and anchor ours just above the lock button.
    e.preventDefault();
    e.stopPropagation();
    const rect = lockButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const MENU_WIDTH = 208;
    const MARGIN = 8;
    let left = rect.left;
    const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;
    setLockMenuPos({ left, bottom: window.innerHeight - rect.top + 6 });
  }, []);

  const handleLockMenuSet = useCallback(() => { closeLockMenu(); onSetPassword(); }, [closeLockMenu, onSetPassword]);
  const handleLockMenuReset = useCallback(() => { closeLockMenu(); onResetPassword(); }, [closeLockMenu, onResetPassword]);

  // Dismiss the menu on any outside interaction, Escape or resize. (No scroll
  // listener: the app viewport does not scroll and the footer anchor is fixed.)
  useEffect(() => {
    if (!lockMenuPos) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (lockMenuRef.current?.contains(t)) return;
      if (lockButtonRef.current?.contains(t)) return; // button re-toggles itself
      closeLockMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLockMenu(); };
    const onReposition = () => closeLockMenu();
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
    };
  }, [lockMenuPos, closeLockMenu]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  // WMS-only: whether GetFeatureInfo (click-to-inspect) is toggled on
  const [editWmsFeatureInfo, setEditWmsFeatureInfo] = useState(false);
  // Color adjustment state for live preview
  const [editBrightness, setEditBrightness] = useState(100);
  const [editSaturation, setEditSaturation] = useState(100);
  const [editContrast, setEditContrast] = useState(100);
  const [editOpacity, setEditOpacity] = useState(100);
  // Store original values for Cancel revert
  const [originalAdjustments, setOriginalAdjustments] = useState({ brightness: 100, saturation: 100, contrast: 100, opacity: 100 });
  // Tile zoom range state for XYZ layers (strings so fields can be emptied = unlimited)
  const [editMinZoom, setEditMinZoom] = useState('');
  const [editMaxZoom, setEditMaxZoom] = useState('');
  const [colorsExpanded, setColorsExpanded] = useState(false);
  const [originalZoomRange, setOriginalZoomRange] = useState<{ min?: number; max?: number }>({});
  const [newMinZoom, setNewMinZoom] = useState('');
  const [newMaxZoom, setNewMaxZoom] = useState('');
  const [vectorEditingId, setVectorEditingId] = useState<string | null>(null);
  // Grouped "Download" menu on drawn vector layers (null = closed). It is
  // rendered through a portal at position:fixed — exactly like the lock menu
  // — so it floats above the dialog instead of stretching the dialog body's
  // scrollable area; an absolutely-positioned menu inside that scroll
  // container forced a horizontal scrollbar the moment it poked past an edge.
  const [downloadMenu, setDownloadMenu] = useState<{ layerId: string; left: number; bottom?: number; top?: number } | null>(null);
  const downloadToggleRef = useRef<HTMLDivElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);

  const openDownloadMenu = useCallback((layerId: string, anchor: HTMLElement) => {
    const MENU_WIDTH = 184;
    const MENU_HEIGHT = 150;
    const MARGIN = 8;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;
    // Prefer opening upward (the button row sits near the dialog's bottom);
    // flip below the button only when there is no room above.
    setDownloadMenu(
      rect.top >= MENU_HEIGHT + MARGIN
        ? { layerId, left, bottom: window.innerHeight - rect.top + 6 }
        : { layerId, left, top: rect.bottom + 6 }
    );
  }, []);

  useEffect(() => {
    if (!downloadMenu) return;
    const close = () => setDownloadMenu(null);
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (downloadMenuRef.current?.contains(t)) return; // menu items close themselves
      if (downloadToggleRef.current?.contains(t)) return; // button re-toggles itself
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // The menu is viewport-anchored, so any scroll (the dialog body scrolls)
    // or resize would detach it from its button — dismiss instead of drift.
    const onScroll = (e: Event) => {
      if (downloadMenuRef.current && downloadMenuRef.current.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [downloadMenu]);
  const [vectorEditName, setVectorEditName] = useState('');
  const [vectorEditUrl, setVectorEditUrl] = useState('');
  const [vectorEditOpacity, setVectorEditOpacity] = useState(100);
  const [vectorEditLineColor, setVectorEditLineColor] = useState('rgba(66, 133, 244, 1)');
  const [vectorEditLineWidth, setVectorEditLineWidth] = useState(2);
  const [vectorEditFillColor, setVectorEditFillColor] = useState('rgba(66, 133, 244, 0.3)');
  const [vectorEditFontColor, setVectorEditFontColor] = useState('rgba(0, 0, 0, 1)');
  const [vectorEditFontSize, setVectorEditFontSize] = useState(14);
  const [vectorStyleExpanded, setVectorStyleExpanded] = useState(false);
  const [originalVectorStyle, setOriginalVectorStyle] = useState({ opacity: 100, lineColor: 'rgba(66, 133, 244, 1)', lineWidth: 2, fillColor: 'rgba(66, 133, 244, 0.3)', fontColor: 'rgba(0, 0, 0, 1)', fontSize: 14 });
  // Zoom range state for vector layers (strings so fields can be emptied = unlimited)
  const [vectorEditMinZoom, setVectorEditMinZoom] = useState('');
  const [vectorEditMaxZoom, setVectorEditMaxZoom] = useState('');
  const [originalVectorZoomRange, setOriginalVectorZoomRange] = useState<{ min?: number; max?: number }>({});
  // Point clustering state for vector layers (checkbox + cluster distance px)
  const [vectorEditCluster, setVectorEditCluster] = useState(false);
  const [vectorEditClusterDistance, setVectorEditClusterDistance] = useState(40);
  const [originalVectorCluster, setOriginalVectorCluster] = useState<{ clusterPoints: boolean; clusterDistance: number }>({ clusterPoints: false, clusterDistance: 40 });

  // Attribute filter state for vector layers: the toggle, the query
  // expression being typed, inline validation feedback, and the values the
  // edit session started with (restored on Cancel).
  const [vectorEditFilterEnabled, setVectorEditFilterEnabled] = useState(false);
  const [vectorEditFilterExpr, setVectorEditFilterExpr] = useState('');
  const [vectorFilterError, setVectorFilterError] = useState<string | null>(null);
  const [vectorFilterTouched, setVectorFilterTouched] = useState(false);
  const [originalVectorFilter, setOriginalVectorFilter] = useState<{ enabled: boolean; expression: string }>({ enabled: false, expression: '' });

  // Id of the group whose drag session is currently alive. Set/cleared
  // synchronously in dragstart/dragend so the DEFERRED dragstart state
  // update can bail out when the drag already ended before its tick ran
  // (otherwise a quick/cancelled drag leaves the group stuck greyed out).
  const dragSessionRef = useRef<string | null>(null);

  // Layer-group (folder) UI state: which group is being renamed inline, and
  // which drop target (group header / section title) a dragged layer hovers.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<'raster' | 'vector' | null>(null);
  // The row a dragged layer would join/leave if dropped right now. Cross-parent
  // moves commit on DROP (not live) so the drag survives crossing a group's
  // members - this state drives the before/after insertion cue on that row.
  const [rowDropTarget, setRowDropTarget] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  const markRowDropTarget = (id: string | null, place: 'before' | 'after' | null) => setRowDropTarget(prev => {
    if (id === null) return prev === null ? prev : null;
    return prev && prev.id === id && prev.place === place ? prev : { id, place: place! };
  });
  const markGroupDragOver = (id: string | null) => {
    setDragOverGroupId(prev => (prev === id ? prev : id));
    // Hovering a group header (or leaving a row for one) clears the row cue.
    setRowDropTarget(prev => (prev === null ? prev : null));
  };
  const markSectionDragOver = (kind: 'raster' | 'vector' | null) => setDragOverSection(prev => (prev === kind ? prev : kind));
  // Id of the group whose header is currently being dragged (whole-block move).
  const [draggedRasterGroupId, setDraggedRasterGroupId] = useState<string | null>(null);
  const [draggedVectorGroupId, setDraggedVectorGroupId] = useState<string | null>(null);

  // Build the full style payload from the current edit state, overriding one field.
  const vectorStylePayload = (override: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number } = {}) => ({
    opacity: vectorEditOpacity,
    lineColor: vectorEditLineColor,
    lineWidth: vectorEditLineWidth,
    fillColor: vectorEditFillColor,
    fontColor: vectorEditFontColor,
    fontSize: vectorEditFontSize,
    ...override,
  });
  const [draggedRasterId, setDraggedRasterId] = useState<string | null>(null);
  const [draggedVectorId, setDraggedVectorId] = useState<string | null>(null);
  const [newLayerName, setNewLayerName] = useState('');
  const [newLayerType, setNewLayerType] = useState<'xyz' | 'wmts' | 'wms' | 'known'>('xyz');
  const [newLayerUrl, setNewLayerUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAddVectorForm, setShowAddVectorForm] = useState(false);
  const [vectorSourceType, setVectorSourceType] = useState<'file' | 'mvt' | 'wfs' | 'stac' | 'known'>('file');
  const [mvtUrl, setMvtUrl] = useState('');
  const [mvtLayerName, setMvtLayerName] = useState('');
  const [fileLayerName, setFileLayerName] = useState('');
  const [selectedVectorSourceId, setSelectedVectorSourceId] = useState('');
  const [wfsTypeName, setWfsTypeName] = useState('');
  const [stacCollection, setStacCollection] = useState('');
  const [stacLimit, setStacLimit] = useState(''); // empty = all items
  // WFS feature-type discovery (GetCapabilities) for the type-name selector
  const [wfsTypeOptions, setWfsTypeOptions] = useState<Array<{ name: string; title: string }>>([]);
  const [wfsTypesLoading, setWfsTypesLoading] = useState(false);
  const [wfsTypesError, setWfsTypesError] = useState('');
  const [wfsTypesForUrl, setWfsTypesForUrl] = useState(''); // URL the cached options belong to
  // STAC collection discovery for the collection selector
  const [stacCollectionOptions, setStacCollectionOptions] = useState<Array<{ id: string; title: string }>>([]);
  const [stacCollectionsLoading, setStacCollectionsLoading] = useState(false);
  const [stacCollectionsError, setStacCollectionsError] = useState('');
  const [stacCollectionsForUrl, setStacCollectionsForUrl] = useState(''); // URL the cached options belong to
  const [wmtsCapabilitiesUrl, setWmtsCapabilitiesUrl] = useState('');
  const [wmtsLayers, setWmtsLayers] = useState<WmtsLayerInfo[]>([]);
  const [selectedWmtsLayer, setSelectedWmtsLayer] = useState('');
  const [wmtsLoading, setWmtsLoading] = useState(false);
  const [wmtsFetched, setWmtsFetched] = useState(false);
  const [wmsCapabilitiesUrl, setWmsCapabilitiesUrl] = useState('');
  const [wmsLayers, setWmsLayers] = useState<WmsLayerInfo[]>([]);
  const [selectedWmsLayer, setSelectedWmsLayer] = useState('');
  const [wmsLoading, setWmsLoading] = useState(false);
  const [wmsFetched, setWmsFetched] = useState(false);
  const nameManuallyEditedRef = useRef(false);
  const [addingRaster, setAddingRaster] = useState(false);

  // "Add from known source" state
  const [selectedKnownSourceId, setSelectedKnownSourceId] = useState('');
  const [knownSourceLayers, setKnownSourceLayers] = useState<Array<{id: string; title: string}>>([]);
  const [selectedKnownSourceLayer, setSelectedKnownSourceLayer] = useState('');
  const [knownSourceLoading, setKnownSourceLoading] = useState(false);
  const [knownSourceFetched, setKnownSourceFetched] = useState(false);

  const fetchKnownSourceCapabilities = async (sourceId: string) => {
    const source = knownSources.find(s => s.id === sourceId);
    if (!source) return;

    setKnownSourceLoading(true);
    setKnownSourceFetched(false);
    setKnownSourceLayers([]);
    setSelectedKnownSourceLayer('');

    // XYZ sources don't have capabilities to fetch - just set as fetched with no layers
    if (source.type === 'xyz') {
      setKnownSourceFetched(true);
      setKnownSourceLoading(false);
      return;
    }

    try {
      const response = await fetch(source.url);
      const text = await response.text();

      if (source.type === 'wmts') {
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        const layers = (capabilities.Contents?.Layer || []).map((layer: any) => ({
          id: layer.Identifier,
          title: layer.Title || layer.Identifier,
        }));
        setKnownSourceLayers(layers);
        setKnownSourceFetched(true);
        if (layers.length > 0) {
          setSelectedKnownSourceLayer(layers[0].id);
        }
      } else {
        // WMS
        const parser = new WMSCapabilities();
        const capabilities = parser.read(text);
        const extractLayers = (arr: any[], depth: number = 0): Array<{id: string; title: string}> => {
          if (!arr) return [];
          const result: Array<{id: string; title: string}> = [];
          arr.forEach((layer: any) => {
            if (layer.Name) {
              result.push({ id: layer.Name, title: '  '.repeat(depth) + (layer.Title || layer.Name) });
            }
            result.push(...extractLayers(layer.Layer, depth + 1));
          });
          return result;
        };
        const layers = extractLayers(capabilities.Capability?.Layer?.Layer || []);
        setKnownSourceLayers(layers);
        setKnownSourceFetched(true);
        if (layers.length > 0) {
          setSelectedKnownSourceLayer(layers[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to fetch capabilities for known source:', error);
      setKnownSourceLayers([]);
      setKnownSourceFetched(false);
    } finally {
      setKnownSourceLoading(false);
    }
  };

  const extractWmsLayers = (layerArray: any[] | undefined, depth: number = 0): WmsLayerInfo[] => {
    if (!layerArray) return [];
    
    const result: WmsLayerInfo[] = [];
    const indent = '  '.repeat(depth);
    
    layerArray.forEach((layer: any) => {
      if (layer.Name) {
        result.push({
          name: layer.Name,
          title: indent + (layer.Title || layer.Name),
        });
      }
      // Recursively extract sub-layers
      result.push(...extractWmsLayers(layer.Layer, depth + 1));
    });
    
    return result;
  };

  const fetchWmsCapabilities = async () => {
    if (!wmsCapabilitiesUrl.trim() || wmsLoading) return;
    
    setWmsLoading(true);
    try {
      const response = await fetch(wmsCapabilitiesUrl.trim());
      const text = await response.text();
      const parser = new WMSCapabilities();
      const capabilities = parser.read(text);
      
      const layers = extractWmsLayers(capabilities.Capability?.Layer?.Layer || []);
      
      setWmsLayers(layers);
      setWmsFetched(true);
      if (layers.length > 0 && !selectedWmsLayer) {
        setSelectedWmsLayer(layers[0].name);
        if (!nameManuallyEditedRef.current) {
          setNewLayerName(layers[0].title.trim());
        }
      }
    } catch (error) {
      console.error('Failed to fetch WMS capabilities:', error);
      setWmsLayers([]);
      setWmsFetched(false);
    } finally {
      setWmsLoading(false);
    }
  };

  const fetchWmtsCapabilities = async () => {
    if (!wmtsCapabilitiesUrl.trim() || wmtsLoading) return;
    
    setWmtsLoading(true);
    try {
      const response = await fetch(wmtsCapabilitiesUrl.trim());
      const text = await response.text();
      const parser = new WMTSCapabilities();
      const capabilities = parser.read(text);
      
      const layers: WmtsLayerInfo[] = (capabilities.Contents?.Layer || []).map((layer: any) => ({
        identifier: layer.Identifier,
        title: layer.Title || layer.Identifier,
      }));
      
      setWmtsLayers(layers);
      setWmtsFetched(true);
      if (layers.length > 0 && !selectedWmtsLayer) {
        setSelectedWmtsLayer(layers[0].identifier);
        if (!nameManuallyEditedRef.current) {
          setNewLayerName(layers[0].title);
        }
      }
    } catch (error) {
      console.error('Failed to fetch WMTS capabilities:', error);
      setWmtsLayers([]);
      setWmtsFetched(false);
    } finally {
      setWmtsLoading(false);
    }
  };

  const handleRasterDragStart = (e: React.DragEvent, id: string) => {
    // setData must happen synchronously (Safari refuses to start a drag
    // without it), but the STATE update is deferred one tick: React would
    // otherwise flush the resulting DOM mutations (the row's drag opacity
    // and the end-of-list drop strip) inside the dragstart event, and
    // Chrome cancels a drag session when the source subtree mutates at
    // that moment - the same fix the group header dragstart already uses.
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', id);
    dragSessionRef.current = id;
    window.setTimeout(() => {
      // The drag may already be over (dragend beat this tick) - don't
      // re-apply the dragging state in that case.
      if (dragSessionRef.current !== id) return;
      setDraggedRasterId(id);
    }, 0);
  };

  const handleRasterDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(null);
    markSectionDragOver(null);
    // A dragged group moves as a whole block: it lands before the hovered
    // row - or before that row's group, since groups are never split.
    if (draggedRasterGroupId) {
      e.stopPropagation();
      const target = rasterLayers.find(l => l.id === targetId);
      if (!target || target.groupId === draggedRasterGroupId) return;
      // Slot the dragged block before/after the hovered row (or its whole
      // group block, when the row is grouped) - groups and individual layers
      // interleave freely.
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const place = dropPlace(e);
        moveDraggedGroupToSlot('raster', place === 'before' ? idx : idx + 1);
      }
      return;
    }
    if (!draggedRasterId || draggedRasterId === targetId) return;
    const dragged = rasterLayers.find(l => l.id === draggedRasterId);
    const target = rasterLayers.find(l => l.id === targetId);
    if (!dragged || !target) return;
    // Cleared here; the cross-parent branch below re-sets it when relevant.
    markRowDropTarget(null, null);

    if (dragged.groupId && dragged.groupId === target.groupId) {
      // Reordering within the same group: plain splice, membership unchanged.
      const draggedIndex = rasterLayers.findIndex(l => l.id === draggedRasterId);
      const targetIndex = rasterLayers.findIndex(l => l.id === targetId);
      const newLayers = [...rasterLayers];
      const [draggedLayer] = newLayers.splice(draggedIndex, 1);
      newLayers.splice(targetIndex, 0, draggedLayer);
      if (layerOrderKey(newLayers) !== layerOrderKey(rasterLayers)) onReorderRasterLayers(newLayers);
      return;
    }

    const place = dropPlace(e);
    if (dragged.groupId !== target.groupId) {
      // Cross-parent move (the layer would join or leave a group). Committing
      // it LIVE would reparent the drag source row under a different React
      // parent (a brand-new DOM node), which loses the browser dragend and
      // kills the drag mid-gesture - you could never drag a free layer PAST a
      // group's members to drop it below the group or on the end-of-list strip.
      // So only highlight the target row; the move commits on DROP.
      markRowDropTarget(targetId, place);
      return;
    }
    // Both ungrouped (same parent list): safe to reorder live - the row stays
    // under the same React parent, so the drag source node survives.
    const items = buildLayerPanelItems(rasterLayers, rasterGroups);
    const idx = itemIdxOfLayer(items, targetId);
    if (idx === -1) return;
    const slot = place === 'before' ? idx : idx + 1;
    const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, slot);
    if (next !== rasterLayers) {
      onReorderRasterLayers(next);
      const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, slot);
      if (ga) onUpdateRasterGroups(ga);
    }
  };

  const handleRasterDragEnd = () => {
    dragSessionRef.current = null;
    setDraggedRasterId(null);
    markGroupDragOver(null);
    markSectionDragOver(null);
    markRowDropTarget(null, null);
    clearHoverExpand();
  };

  const handleVectorDragStart = (e: React.DragEvent, id: string) => {
    // See handleRasterDragStart - synchronous setData, deferred state update.
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', id);
    dragSessionRef.current = id;
    window.setTimeout(() => {
      if (dragSessionRef.current !== id) return;
      setDraggedVectorId(id);
    }, 0);
  };

  const handleVectorDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(null);
    markSectionDragOver(null);
    // A dragged group moves as a whole block: it lands before the hovered
    // row - or before that row's group, since groups are never split.
    if (draggedVectorGroupId) {
      e.stopPropagation();
      const target = vectorLayers.find(l => l.id === targetId);
      if (!target || target.groupId === draggedVectorGroupId) return;
      // Slot the dragged block before/after the hovered row (or its whole
      // group block, when the row is grouped) - groups and individual layers
      // interleave freely.
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const place = dropPlace(e);
        moveDraggedGroupToSlot('vector', place === 'before' ? idx : idx + 1);
      }
      return;
    }
    if (!draggedVectorId || draggedVectorId === targetId) return;
    const dragged = vectorLayers.find(l => l.id === draggedVectorId);
    const target = vectorLayers.find(l => l.id === targetId);
    if (!dragged || !target) return;
    // Cleared here; the cross-parent branch below re-sets it when relevant.
    markRowDropTarget(null, null);

    if (dragged.groupId && dragged.groupId === target.groupId) {
      // Reordering within the same group: plain splice, membership unchanged.
      const draggedIndex = vectorLayers.findIndex(l => l.id === draggedVectorId);
      const targetIndex = vectorLayers.findIndex(l => l.id === targetId);
      const newLayers = [...vectorLayers];
      const [draggedLayer] = newLayers.splice(draggedIndex, 1);
      newLayers.splice(targetIndex, 0, draggedLayer);
      if (layerOrderKey(newLayers) !== layerOrderKey(vectorLayers)) onReorderVectorLayers(newLayers);
      return;
    }

    const place = dropPlace(e);
    if (dragged.groupId !== target.groupId) {
      // Cross-parent move - highlight only; commits on DROP (see the raster
      // handler for the full rationale).
      markRowDropTarget(targetId, place);
      return;
    }
    // Both ungrouped (same parent list): safe to reorder live.
    const items = buildLayerPanelItems(vectorLayers, vectorGroups);
    const idx = itemIdxOfLayer(items, targetId);
    if (idx === -1) return;
    const slot = place === 'before' ? idx : idx + 1;
    const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, slot);
    if (next !== vectorLayers) {
      onReorderVectorLayers(next);
      const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, slot);
      if (ga) onUpdateVectorGroups(ga);
    }
  };

  const handleVectorDragEnd = () => {
    dragSessionRef.current = null;
    setDraggedVectorId(null);
    markGroupDragOver(null);
    markSectionDragOver(null);
    markRowDropTarget(null, null);
    clearHoverExpand();
  };

  // Commit a cross-parent layer move on DROP (live dragover only highlights the
  // target row). Joining a group adopts its groupId at the pointer position;
  // dropping on an ungrouped row places the layer beside it and leaves any
  // group. The source row is reparented only now (after the gesture), so the
  // browser drag source node survived the drag and we clear state explicitly.
  const handleRasterRowDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markRowDropTarget(null, null);
    if (!draggedRasterId || draggedRasterId === targetId) return;
    const dragged = rasterLayers.find(l => l.id === draggedRasterId);
    const target = rasterLayers.find(l => l.id === targetId);
    if (!dragged || !target || dragged.groupId === target.groupId) return;
    const place = dropPlace(e);
    if (target.groupId) {
      const next = moveLayerToJoinAt(rasterLayers, draggedRasterId, target.groupId, targetId, place);
      if (next !== rasterLayers) {
        onReorderRasterLayers(next);
        const ga = anchorEmptiedGroups(rasterLayers, next, rasterGroups);
        if (ga) onUpdateRasterGroups(ga);
      }
    } else {
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const slot = place === 'before' ? idx : idx + 1;
        const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, slot);
        if (next !== rasterLayers) onReorderRasterLayers(next);
        const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, slot);
        if (ga) onUpdateRasterGroups(ga);
      }
    }
    handleRasterDragEnd();
  };

  const handleVectorRowDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markRowDropTarget(null, null);
    if (!draggedVectorId || draggedVectorId === targetId) return;
    const dragged = vectorLayers.find(l => l.id === draggedVectorId);
    const target = vectorLayers.find(l => l.id === targetId);
    if (!dragged || !target || dragged.groupId === target.groupId) return;
    const place = dropPlace(e);
    if (target.groupId) {
      const next = moveLayerToJoinAt(vectorLayers, draggedVectorId, target.groupId, targetId, place);
      if (next !== vectorLayers) {
        onReorderVectorLayers(next);
        const ga = anchorEmptiedGroups(vectorLayers, next, vectorGroups);
        if (ga) onUpdateVectorGroups(ga);
      }
    } else {
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const slot = place === 'before' ? idx : idx + 1;
        const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, slot);
        if (next !== vectorLayers) onReorderVectorLayers(next);
        const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, slot);
        if (ga) onUpdateVectorGroups(ga);
      }
    }
    handleVectorDragEnd();
  };

  /**
   * Fetch the WFS GetCapabilities document for the given URL and extract the
   * advertised feature types (Name + Title) to populate the type selector.
   * Results are cached per URL; opening the selector again for the same URL
   * re-uses them, while editing the URL invalidates the cache.
   */
  const fetchWfsFeatureTypes = async (url: string, force: boolean = false) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!force && wfsTypesForUrl === trimmed && (wfsTypeOptions.length > 0 || wfsTypesLoading)) return;

    setWfsTypesLoading(true);
    setWfsTypesError('');
    setWfsTypesForUrl(trimmed);

    try {
      const sep = trimmed.includes('?') ? '&' : '?';
      const capUrl = trimmed + sep + new URLSearchParams({ service: 'WFS', request: 'GetCapabilities' }).toString();
      const response = await fetch(capUrl);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();

      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('Response is not valid XML');
      }

      // Namespace-agnostic walk over <FeatureType> entries (WFS 1.0/1.1/2.0)
      const featureTypes = doc.getElementsByTagNameNS('*', 'FeatureType');
      const types: Array<{ name: string; title: string }> = [];
      for (let i = 0; i < featureTypes.length; i++) {
        const ft = featureTypes[i];
        const name = ft.getElementsByTagNameNS('*', 'Name')[0]?.textContent?.trim();
        const title = ft.getElementsByTagNameNS('*', 'Title')[0]?.textContent?.trim();
        if (name) types.push({ name, title: title || name });
      }

      setWfsTypeOptions(types);
      if (types.length === 0) {
        setWfsTypesError('No feature types advertised by this service.');
      }
    } catch (error) {
      console.error('Failed to fetch WFS capabilities:', error);
      setWfsTypeOptions([]);
      setWfsTypesError('Could not read feature types from this URL. Check the service and try again.');
    } finally {
      setWfsTypesLoading(false);
    }
  };


  /**
   * Fetch the list of collections from a STAC API endpoint.
   * Caches results per URL so re-opening the dropdown re-uses them,
   * while editing the URL invalidates the cache.
   */
  const fetchStacCollections = async (url: string, force: boolean = false) => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    if (!force && stacCollectionsForUrl === trimmed && (stacCollectionOptions.length > 0 || stacCollectionsLoading)) return;

    setStacCollectionsLoading(true);
    setStacCollectionsError('');
    setStacCollectionsForUrl(trimmed);

    try {
      const collectionsUrl = trimmed + '/collections';
      const response = await fetch(collectionsUrl);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();

      const collections: Array<{ id: string; title: string }> = [];
      if (Array.isArray(data.collections)) {
        for (const col of data.collections) {
          if (col.id) {
            collections.push({ id: col.id, title: col.title || col.id });
          }
        }
      }

      setStacCollectionOptions(collections);
      if (collections.length === 0) {
        setStacCollectionsError('No collections found at this STAC API.');
      }
    } catch (error) {
      console.error('Failed to fetch STAC collections:', error);
      setStacCollectionOptions([]);
      setStacCollectionsError('Could not read collections from this URL. Check the STAC API and try again.');
    } finally {
      setStacCollectionsLoading(false);
    }
  };
  const handleAddLayer = async (existingRasterLayers: RasterLayer[]) => {
    let layerName = newLayerName.trim();
    
    let layer: RasterLayer;
    
    if (newLayerType === 'known') {
      const source = knownSources.find(s => s.id === selectedKnownSourceId);
      if (!source) return;
      if (source.type !== 'xyz' && !selectedKnownSourceLayer) return;
      
      if (!layerName) {
        if (source.type === 'xyz') {
          layerName = source.name;
        } else {
          const matched = knownSourceLayers.find(l => l.id === selectedKnownSourceLayer);
          layerName = matched ? matched.title.trim() : selectedKnownSourceLayer;
        }
      }
      
      layer = {
        id: Date.now().toString(),
        name: layerName,
        type: source.type as RasterLayer['type'],
        url: source.url,
        ...(source.type === 'wmts' ? {
          wmtsCapabilitiesUrl: source.url,
          wmtsLayer: selectedKnownSourceLayer,
        } : source.type === 'wms' ? {
          wmsCapabilitiesUrl: source.url,
          wmsLayer: selectedKnownSourceLayer,
        } : {}), // XYZ has no extra fields
        ...(source.type === 'xyz' ? {
          minZoom: parseZoomInput(newMinZoom),
          maxZoom: parseZoomInput(newMaxZoom),
        } : {}),
      };
    } else if (newLayerType === 'wmts') {
      if (!wmtsCapabilitiesUrl.trim() || !selectedWmtsLayer) return;
      if (!layerName) {
        const matched = wmtsLayers.find(l => l.identifier === selectedWmtsLayer);
        layerName = matched ? matched.title : selectedWmtsLayer;
      }
      layer = {
        id: Date.now().toString(),
        name: layerName,
        type: 'wmts',
        url: wmtsCapabilitiesUrl.trim(),
        wmtsCapabilitiesUrl: wmtsCapabilitiesUrl.trim(),
        wmtsLayer: selectedWmtsLayer,
      };
    } else if (newLayerType === 'wms') {
      if (!wmsCapabilitiesUrl.trim() || !selectedWmsLayer) return;
      if (!layerName) {
        const matched = wmsLayers.find(l => l.name === selectedWmsLayer);
        layerName = matched ? matched.title.trim() : selectedWmsLayer;
      }
      layer = {
        id: Date.now().toString(),
        name: layerName,
        type: 'wms',
        url: wmsCapabilitiesUrl.trim(),
        wmsCapabilitiesUrl: wmsCapabilitiesUrl.trim(),
        wmsLayer: selectedWmsLayer,
      };
    } else {
      if (!newLayerUrl.trim()) return;
      if (!layerName) {
        const xyzCount = existingRasterLayers.filter(l => l.name.startsWith('xyz_')).length;
        layerName = 'xyz_' + (xyzCount + 1);
      }
      layer = {
        id: Date.now().toString(),
        name: layerName,
        type: 'xyz',
        url: newLayerUrl.trim(),
        minZoom: parseZoomInput(newMinZoom),
        maxZoom: parseZoomInput(newMaxZoom),
      };
    }
    
    setAddingRaster(true);
    try {
      await onAddRasterLayer(layer);
    } finally {
      setAddingRaster(false);
    }
    setNewLayerName('');
    setNewLayerUrl('');
    setNewMinZoom('');
    setNewMaxZoom('');
    setWmtsCapabilitiesUrl('');
    setWmtsLayers([]);
    setSelectedWmtsLayer('');
    setWmtsFetched(false);
    setWmsCapabilitiesUrl('');
    setWmsLayers([]);
    setSelectedWmsLayer('');
    setWmsFetched(false);
    nameManuallyEditedRef.current = false;
    // Reset known source state
    setSelectedKnownSourceId('');
    setKnownSourceLayers([]);
    setSelectedKnownSourceLayer('');
    setKnownSourceFetched(false);
    setShowAddForm(false);
  };

  /** Live-apply a (valid) tile zoom range while editing an XYZ layer. */
  const applyZoomRange = (layerId: string, minStr: string, maxStr: string) => {
    const min = parseZoomInput(minStr);
    const max = parseZoomInput(maxStr);
    if (min !== undefined && max !== undefined && min > max) return; // invalid pair — wait for a valid one
    onApplyTileZoomRange(layerId, min, max);
  };

  // Same as applyZoomRange but for vector layers (MVT tile clamp / visibility range)
  const applyVectorZoomRange = (layerId: string, minStr: string, maxStr: string) => {
    const min = parseZoomInput(minStr);
    const max = parseZoomInput(maxStr);
    if (min !== undefined && max !== undefined && min > max) return; // invalid pair — wait for a valid one
    onApplyVectorZoomRange(layerId, min, max);
  };

  // Compact summary of non-default color adjustments (shown in the collapsed header)
  const colorSummary = [
    editBrightness !== 100 ? `B${editBrightness}` : '',
    editSaturation !== 100 ? `S${editSaturation}` : '',
    editContrast !== 100 ? `C${editContrast}` : '',
    editOpacity !== 100 ? `O${editOpacity}` : '',
  ].filter(Boolean).join(' ');

  const selectedKnownSource = knownSources.find(s => s.id === selectedKnownSourceId);
  const addingXyzLayer =
    newLayerType === 'xyz' || (newLayerType === 'known' && selectedKnownSource?.type === 'xyz');

  // ----- Layer groups (folders) -------------------------------------------

  const groupsOf = (kind: 'raster' | 'vector') => (kind === 'raster' ? rasterGroups : vectorGroups);
  const updateGroups = (kind: 'raster' | 'vector', groups: LayerGroup[]) =>
    kind === 'raster' ? onUpdateRasterGroups(groups) : onUpdateVectorGroups(groups);
  const updateGroup = (kind: 'raster' | 'vector', groupId: string, patch: Partial<LayerGroup>) =>
    updateGroups(kind, groupsOf(kind).map(g => (g.id === groupId ? { ...g, ...patch } : g)));

  const startGroupRename = (group: LayerGroup) => {
    setRenamingGroupId(group.id);
    setRenameValue(group.name);
  };

  const commitGroupRename = (kind: 'raster' | 'vector', group: LayerGroup) => {
    const name = renameValue.trim();
    if (name && name !== group.name) updateGroup(kind, group.id, { name });
    setRenamingGroupId(null);
  };

  /** Create a group and immediately open its inline rename field. */
  const addGroup = (kind: 'raster' | 'vector') => {
    const id = makeGroupId();
    updateGroups(kind, [...groupsOf(kind), { id, name: 'New group', expanded: true }]);
    setRenamingGroupId(id);
    setRenameValue('New group');
  };

  /** Remove a group but keep its layers - they become ungrouped. */
  const removeGroup = (kind: 'raster' | 'vector', groupId: string) => {
    const remainingGroups = groupsOf(kind).filter(g => g.id !== groupId);
    updateGroups(kind, remainingGroups);
    if (kind === 'raster') {
      if (rasterLayers.some(l => l.groupId === groupId)) {
        onReorderRasterLayers(rasterLayers.map(l => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
      }
    } else if (vectorLayers.some(l => l.groupId === groupId)) {
      onReorderVectorLayers(vectorLayers.map(l => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
    }
  };

  /** Create a new group from a layer's assign-menu and move the layer into it. */
  const createGroupWithLayer = (kind: 'raster' | 'vector', layerId: string, name: string) => {
    const id = makeGroupId();
    updateGroups(kind, [...groupsOf(kind), { id, name, expanded: true }]);
    if (kind === 'raster') onMoveRasterLayerToGroup(layerId, id);
    else onMoveVectorLayerToGroup(layerId, id);
  };

  // Hover-expand: while a layer drag hovers a collapsed group header,
  // expand the group after 300ms so its member rows become drop targets for
  // precise insertion. Releasing on the header itself drops at the group's
  // end (joinLayerAtGroupEnd in the header's onDrop).
  const hoverExpandRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; key: string | null }>({ timer: null, key: null });
  // The group auto-expanded by the hover during the current drag. A layer
  // dropped on a group header lands ABOVE the group ("take its place") unless
  // it was this very group that the hover just expanded - then the drop joins
  // the folder's end, per the drag spec.
  const hoverExpandedGroupRef = useRef<string | null>(null);
  const clearHoverExpand = () => {
    if (hoverExpandRef.current.timer !== null) clearTimeout(hoverExpandRef.current.timer);
    hoverExpandRef.current = { timer: null, key: null };
    hoverExpandedGroupRef.current = null;
  };
  const armHoverExpand = (kind: 'raster' | 'vector', groupId: string) => {
    const groups = kind === 'raster' ? rasterGroups : vectorGroups;
    const group = groups.find(g => g.id === groupId);
    if (!group || group.expanded) return;
    const key = kind + ':' + groupId;
    if (hoverExpandRef.current.key === key) return; // already armed
    clearHoverExpand();
    hoverExpandRef.current = {
      key,
      timer: setTimeout(() => {
        hoverExpandRef.current = { timer: null, key: null };
        // Remember that THIS group was hover-expanded: a header drop now joins
        // the folder's end instead of landing above the group.
        hoverExpandedGroupRef.current = groupId;
        updateGroup(kind, groupId, { expanded: true });
      }, 300),
    };
  };

  // Add a layer to a group at the END of the group's member list (used when
  // a drag is released on the group header). Empty groups go through the App
  // handler, which slots the layer at the group's anchored position and
  // expands it.
  const joinLayerAtGroupEnd = (kind: 'raster' | 'vector', layerId: string, groupId: string) => {
    if (kind === 'raster') {
      const layer = rasterLayers.find(l => l.id === layerId);
      if (!layer) return;
      if (!rasterLayers.some(l => l.groupId === groupId)) {
        onMoveRasterLayerToGroup(layerId, groupId);
        return;
      }
      const rest = rasterLayers.filter(l => l.id !== layerId);
      let lastIdx = -1;
      rest.forEach((l, i) => { if (l.groupId === groupId) lastIdx = i; });
      const next = [...rest.slice(0, lastIdx + 1), { ...layer, groupId }, ...rest.slice(lastIdx + 1)];
      if (layerOrderKey(next) !== layerOrderKey(rasterLayers)) onReorderRasterLayers(next);
    } else {
      const layer = vectorLayers.find(l => l.id === layerId);
      if (!layer) return;
      if (!vectorLayers.some(l => l.groupId === groupId)) {
        onMoveVectorLayerToGroup(layerId, groupId);
        return;
      }
      const rest = vectorLayers.filter(l => l.id !== layerId);
      let lastIdx = -1;
      rest.forEach((l, i) => { if (l.groupId === groupId) lastIdx = i; });
      const next = [...rest.slice(0, lastIdx + 1), { ...layer, groupId }, ...rest.slice(lastIdx + 1)];
      if (layerOrderKey(next) !== layerOrderKey(vectorLayers)) onReorderVectorLayers(next);
    }
  };

  // Move the group being dragged so its block occupies the given panel slot
  // (0 = top, -1 = end). Non-empty groups move their member layers in the
  // flat array (map stacking follows); empty groups just get a new afterId
  // anchor. When dropping BEFORE an empty target group, that group is
  // re-anchored below the moved block so the two don't share the same slot.
  const moveDraggedGroupToSlot = (kind: 'raster' | 'vector', slot: number, emptyTargetGroupId?: string, place?: 'before' | 'after') => {
    const draggedId = kind === 'raster' ? draggedRasterGroupId : draggedVectorGroupId;
    if (!draggedId) return;
    if (kind === 'raster') {
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      if (rasterLayers.some(l => l.groupId === draggedId)) {
        const next = moveGroupToSlot(rasterLayers, draggedId, items, slot);
        if (next !== rasterLayers) {
          onReorderRasterLayers(next);
          if (emptyTargetGroupId && place === 'before') {
            const lastMemberId = next.filter(l => l.groupId === draggedId).pop()?.id;
            if (lastMemberId) {
              onUpdateRasterGroups(rasterGroups.map(g => (g.id === emptyTargetGroupId ? { ...g, afterId: lastMemberId } : g)));
            }
          }
        }
      } else {
        // Empty group: compute the anchor from items WITHOUT the dragged
        // group so slotAfterId never returns a self-reference (which is
        // unresolvable and sends the folder to the end of the list).
        const draggedIdx = items.findIndex(it => it.kind === 'group' && it.group.id === draggedId);
        const itemsWithout = items.filter(it => !(it.kind === 'group' && it.group.id === draggedId));
        const adjustedSlot = draggedIdx !== -1 && draggedIdx < slot ? slot - 1 : slot;
        const afterId = slotAfterId(itemsWithout, adjustedSlot);
        const nextGroups = rasterGroups.map(g => {
          if (g.id !== draggedId) return g;
          const updated = { ...g };
          if (afterId === undefined) delete updated.afterId;
          else updated.afterId = afterId;
          return updated;
        });
        if (nextGroups.some((g, i) => g.afterId !== rasterGroups[i].afterId)) onUpdateRasterGroups(nextGroups);
      }
    } else {
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      if (vectorLayers.some(l => l.groupId === draggedId)) {
        const next = moveGroupToSlot(vectorLayers, draggedId, items, slot);
        if (next !== vectorLayers) {
          onReorderVectorLayers(next);
          if (emptyTargetGroupId && place === 'before') {
            const lastMemberId = next.filter(l => l.groupId === draggedId).pop()?.id;
            if (lastMemberId) {
              onUpdateVectorGroups(vectorGroups.map(g => (g.id === emptyTargetGroupId ? { ...g, afterId: lastMemberId } : g)));
            }
          }
        }
      } else {
        // Empty group: compute the anchor from items WITHOUT the dragged
        // group so slotAfterId never returns a self-reference (which is
        // unresolvable and sends the folder to the end of the list).
        const draggedIdx = items.findIndex(it => it.kind === 'group' && it.group.id === draggedId);
        const itemsWithout = items.filter(it => !(it.kind === 'group' && it.group.id === draggedId));
        const adjustedSlot = draggedIdx !== -1 && draggedIdx < slot ? slot - 1 : slot;
        const afterId = slotAfterId(itemsWithout, adjustedSlot);
        const nextGroups = vectorGroups.map(g => {
          if (g.id !== draggedId) return g;
          const updated = { ...g };
          if (afterId === undefined) delete updated.afterId;
          else updated.afterId = afterId;
          return updated;
        });
        if (nextGroups.some((g, i) => g.afterId !== vectorGroups[i].afterId)) onUpdateVectorGroups(nextGroups);
      }
    }
  };

  // Drag a layer onto a group header: it joins the group (which auto-expands
  // so the user sees where it lands), placed after the group's last member.
  const handleRasterDragOverGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // Group-on-group: the dragged group lands, as a block, before the target.
    if (draggedRasterGroupId) {
      if (draggedRasterGroupId !== groupId) {
        const items = buildLayerPanelItems(rasterLayers, rasterGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) {
          const place = dropPlace(e);
          const targetEmpty = !rasterLayers.some(l => l.groupId === groupId);
          moveDraggedGroupToSlot('raster', place === 'before' ? idx : idx + 1, targetEmpty ? groupId : undefined, place);
        }
      }
      return;
    }
    if (!draggedRasterId) return;
    // Hovering the header while dragging a layer targets the group itself.
    // The drop decides: it lands ABOVE the group ("take its place") unless
    // the hover just expanded this group, in which case it joins the folder's
    // end. Holding the hover ~300ms expands a collapsed group so the user can
    // drag on into a precise member position. No live reorder here.
    armHoverExpand('raster', groupId);
  };

  const handleVectorDragOverGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // Group-on-group: the dragged group lands, as a block, before the target.
    if (draggedVectorGroupId) {
      if (draggedVectorGroupId !== groupId) {
        const items = buildLayerPanelItems(vectorLayers, vectorGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) {
          const place = dropPlace(e);
          const targetEmpty = !vectorLayers.some(l => l.groupId === groupId);
          moveDraggedGroupToSlot('vector', place === 'before' ? idx : idx + 1, targetEmpty ? groupId : undefined, place);
        }
      }
      return;
    }
    if (!draggedVectorId) return;
    // Hovering the header while dragging a layer targets the group itself.
    // The drop decides: it lands ABOVE the group ("take its place") unless
    // the hover just expanded this group, in which case it joins the folder's
    // end. Holding the hover ~300ms expands a collapsed group so the user can
    // drag on into a precise member position. No live reorder here.
    armHoverExpand('vector', groupId);
  };

  const handleGroupDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      markGroupDragOver(null);
      clearHoverExpand();
    }
  };

  // Drag over the expanded children area of a group (below the header).
  // The header has its own handlers; this covers the dead zone that appears
  // after a hover-expand (or between member rows) so the browser allows the
  // drop and the layer joins the group at its end.
  const handleGroupChildrenDragOver = (e: React.DragEvent, kind: 'raster' | 'vector', groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // A dragged group dropped inside another group's children area lands
    // AFTER that group (the whole block moves below).
    if (kind === 'raster' && draggedRasterGroupId) {
      if (draggedRasterGroupId !== groupId) {
        const items = buildLayerPanelItems(rasterLayers, rasterGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) moveDraggedGroupToSlot('raster', idx + 1);
      }
      return;
    }
    if (kind === 'vector' && draggedVectorGroupId) {
      if (draggedVectorGroupId !== groupId) {
        const items = buildLayerPanelItems(vectorLayers, vectorGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) moveDraggedGroupToSlot('vector', idx + 1);
      }
      return;
    }
  };

  const handleGroupChildrenDrop = (e: React.DragEvent, kind: 'raster' | 'vector', groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markGroupDragOver(null);
    clearHoverExpand();
    if (kind === 'raster') {
      if (draggedRasterGroupId) { handleRasterDragEnd(); return; }
      if (!draggedRasterId) return;
      joinLayerAtGroupEnd('raster', draggedRasterId, groupId);
      handleRasterDragEnd();
    } else {
      if (draggedVectorGroupId) { handleVectorDragEnd(); return; }
      if (!draggedVectorId) return;
      joinLayerAtGroupEnd('vector', draggedVectorId, groupId);
      handleVectorDragEnd();
    }
  };

  // Drag a grouped layer onto the section title to strip its group membership.
  const handleSectionDragOver = (e: React.DragEvent, kind: 'raster' | 'vector') => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markSectionDragOver(kind);
    markGroupDragOver(null);
    if (kind === 'raster') {
      // A dragged group dropped on the section title moves to the very top.
      if (draggedRasterGroupId) {
        moveDraggedGroupToSlot('raster', 0);
        return;
      }
      if (!draggedRasterId) return;
      const dragged = rasterLayers.find(l => l.id === draggedRasterId);
      if (!dragged) return;
      // Dropping a layer on the section title moves it to the very top of
      // the list (and out of any group) - the counterpart of the
      // end-of-list strip, and the way to place a layer above a group that
      // is itself first in the list.
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, 0);
      if (next !== rasterLayers) {
        onReorderRasterLayers(next);
        if (dragged.groupId) handleRasterDragEnd(); // reparented out of its group
      }
      const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, 0);
      if (ga) onUpdateRasterGroups(ga);
    } else {
      // A dragged group dropped on the section title moves to the very top.
      if (draggedVectorGroupId) {
        moveDraggedGroupToSlot('vector', 0);
        return;
      }
      if (!draggedVectorId) return;
      const dragged = vectorLayers.find(l => l.id === draggedVectorId);
      if (!dragged) return;
      // Dropping a layer on the section title moves it to the very top of
      // the list (and out of any group) - the counterpart of the
      // end-of-list strip, and the way to place a layer above a group that
      // is itself first in the list.
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, 0);
      if (next !== vectorLayers) {
        onReorderVectorLayers(next);
        if (dragged.groupId) handleVectorDragEnd(); // reparented out of its group
      }
      const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, 0);
      if (ga) onUpdateVectorGroups(ga);
    }
  };

  const handleSectionDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      markSectionDragOver(null);
    }
  };

  // Dragging a group over the drop strip below the last row moves it to the
  // end of the list.
  // Dragging onto the end-of-list strip: a group moves its whole block to
  // the end; a layer moves (ungrouped) to the very bottom of the list - the
  // way to place a layer below a group that is itself last in the list.
  const handleRasterListDragOver = (e: React.DragEvent) => {
    if (draggedRasterGroupId) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      moveDraggedGroupToSlot('raster', -1);
      return;
    }
    if (!draggedRasterId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const dragged = rasterLayers.find(l => l.id === draggedRasterId);
    if (!dragged) return;
    const items = buildLayerPanelItems(rasterLayers, rasterGroups);
    const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, -1);
    if (next !== rasterLayers) {
      onReorderRasterLayers(next);
      if (dragged.groupId) handleRasterDragEnd(); // reparented out of its group
    }
    const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, -1);
    if (ga) onUpdateRasterGroups(ga);
  };

  // Dragging onto the end-of-list strip: a group moves its whole block to
  // the end; a layer moves (ungrouped) to the very bottom of the list - the
  // way to place a layer below a group that is itself last in the list.
  const handleVectorListDragOver = (e: React.DragEvent) => {
    if (draggedVectorGroupId) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      moveDraggedGroupToSlot('vector', -1);
      return;
    }
    if (!draggedVectorId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const dragged = vectorLayers.find(l => l.id === draggedVectorId);
    if (!dragged) return;
    const items = buildLayerPanelItems(vectorLayers, vectorGroups);
    const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, -1);
    if (next !== vectorLayers) {
      onReorderVectorLayers(next);
      if (dragged.groupId) handleVectorDragEnd(); // reparented out of its group
    }
    const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, -1);
    if (ga) onUpdateVectorGroups(ga);
  };

  // Releasing a LAYER on a group header is decided by the pointer's half: the
  // TOP half slots the layer in immediately BEFORE the group (ungrouped) - the
  // way to stack a free layer above a folder; the BOTTOM half joins the group
  // at its end (the "drop onto a folder = file into it" gesture, and the
  // outcome of the hover-to-expand flow). Group drags reorder live on dragover
  // and never reach the drop handler.
  const dropLayerOnGroupHeader = (kind: 'raster' | 'vector', groupId: string, place: 'before' | 'after') => {
    if (place === 'before') {
      if (kind === 'raster') {
        if (!draggedRasterId) return;
        const items = buildLayerPanelItems(rasterLayers, rasterGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx === -1) return;
        const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, idx);
        if (next !== rasterLayers) onReorderRasterLayers(next);
        const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, idx);
        if (ga) onUpdateRasterGroups(ga);
      } else {
        if (!draggedVectorId) return;
        const items = buildLayerPanelItems(vectorLayers, vectorGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx === -1) return;
        const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, idx);
        if (next !== vectorLayers) onReorderVectorLayers(next);
        const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, idx);
        if (ga) onUpdateVectorGroups(ga);
      }
      return;
    }
    // Bottom half -> join the group at its end.
    if (kind === 'raster' && draggedRasterId) joinLayerAtGroupEnd('raster', draggedRasterId, groupId);
    else if (kind === 'vector' && draggedVectorId) joinLayerAtGroupEnd('vector', draggedVectorId, groupId);
  };

  // Group header row: expand chevron, folder icon, inline-renameable name,
  // member count, a tri-state eye that toggles the whole cluster at once,
  // and a remove button that dissolves the group but keeps its layers.
  const renderGroupHeader = (kind: 'raster' | 'vector', group: LayerGroup, members: Array<{ id: string; visible?: boolean }>) => {
    const isVisible = (l: { visible?: boolean }) => (kind === 'raster' ? l.visible !== false : l.visible === true);
    const visibleCount = members.filter(isVisible).length;
    const eyeState: 'all' | 'some' | 'none' =
      members.length > 0 && visibleCount === members.length ? 'all' : visibleCount > 0 ? 'some' : 'none';
    const isRenaming = renamingGroupId === group.id;
    const isDragTarget = dragOverGroupId === group.id;
    // While a layer is dragged over this header the drop lands ABOVE the group,
    // unless this group was just auto-expanded by the hover (then it joins the
    // folder's end) - show the matching drop-target cue.
    const willJoinEnd = isDragTarget && hoverExpandedGroupRef.current === group.id;
    const eyeTitle =
      members.length === 0 ? 'Empty group'
      : eyeState === 'none' ? 'Restore the layers\u2019 previous visibility'
      : 'Hide every layer in this group';
    return (
      <div
        className={'settings-group-header' + (isDragTarget ? ' drag-over' : '') + (isDragTarget && !willJoinEnd ? ' drag-over-before' : '')}
        draggable
        onDragStart={(e) => {
          // setData must happen synchronously (Safari refuses to start a
          // drag without it), but every STATE update is deferred one tick:
          // React would otherwise flush the resulting DOM mutations (the
          // 'dragging' class and the drop strip) inside the dragstart
          // event, and Chrome cancels a drag session when the source
          // subtree mutates at that moment.
          if (e.dataTransfer) e.dataTransfer.setData('text/plain', group.id);
          const gid = group.id;
          const gkind = kind;
          dragSessionRef.current = gid;
          window.setTimeout(() => {
            // The drag may already be over (dragend beat this tick) - don't
            // re-apply the dragging state in that case.
            if (dragSessionRef.current !== gid) return;
            if (gkind === 'raster') setDraggedRasterGroupId(gid);
            else setDraggedVectorGroupId(gid);
          }, 0);
        }}
        onDragEnd={() => {
          dragSessionRef.current = null;
          setDraggedRasterGroupId(null);
          setDraggedVectorGroupId(null);
          markGroupDragOver(null);
          markSectionDragOver(null);
        }}
        onDragOver={(e) => (kind === 'raster' ? handleRasterDragOverGroup(e, group.id) : handleVectorDragOverGroup(e, group.id))}
        onDragLeave={handleGroupDragLeave}
        onDrop={(e) => {
          e.preventDefault();
          // A layer dropped on the header lands ABOVE the group ("take its
          // place") - unless this group was just auto-expanded by the hover,
          // in which case the drop joins the folder's end. Read the flag
          // before clearHoverExpand() resets it.
          const joinAtEnd = hoverExpandedGroupRef.current === group.id;
          markGroupDragOver(null);
          clearHoverExpand();
          dropLayerOnGroupHeader(kind, group.id, joinAtEnd ? 'after' : 'before');
          if (kind === 'raster' && draggedRasterId) handleRasterDragEnd();
          else if (kind === 'vector' && draggedVectorId) handleVectorDragEnd();
        }}
        title="Drag to reorder the whole group"
      >
        {/*
          The whole header is the drag surface. The action controls below are
          deliberately <span role="button"> instead of real <button>s: Chrome
          refuses to start a drag from a form control, so real buttons would
          leave dead zones in the header (which is why dragging used to fail
          from the right-hand side - e.g. right after clicking the chevron
          to collapse the group).
        */}
        <span className="settings-drag-handle">{'\u22ee\u22ee'}</span>
        <span className="settings-group-folder"><FolderIcon /></span>
          {isRenaming ? (
            <input
              autoFocus
              type="text"
              className="settings-group-rename"
              value={renameValue}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGroupRename(kind, group);
                if (e.key === 'Escape') setRenamingGroupId(null);
              }}
              onBlur={() => commitGroupRename(kind, group)}
            />
          ) : (
            <span
              className="settings-group-name"
              onDoubleClick={() => startGroupRename(group)}
              title={group.name + ' \u2014 double-click to rename'}
            >
              {group.name}
            </span>
          )}
        <span className="settings-group-count" title={members.length === 1 ? '1 layer' : members.length + ' layers'}>
          {members.length}
        </span>
        <div className="settings-group-header-actions">
          <span
            role="button"
            tabIndex={0}
            className="settings-group-chevron"
            onClick={() => updateGroup(kind, group.id, { expanded: !group.expanded })}
            onKeyDown={spanActivate(() => updateGroup(kind, group.id, { expanded: !group.expanded }))}
            title={group.expanded ? 'Collapse group' : 'Expand group'}
            aria-expanded={group.expanded}
          >
            <span className={'settings-group-chevron-icon' + (group.expanded ? ' expanded' : '')}>{'\u25b8'}</span>
          </span>
          <span
            role="button"
            tabIndex={0}
            className="settings-layer-edit"
            onClick={() => startGroupRename(group)}
            onKeyDown={spanActivate(() => startGroupRename(group))}
            title="Rename group"
          >
            <PencilIcon />
          </span>
          <span
            role="button"
            tabIndex={members.length === 0 ? -1 : 0}
            aria-disabled={members.length === 0}
            className="settings-layer-visibility"
            onClick={() => { if (members.length > 0) (kind === 'raster' ? onToggleRasterGroup(group.id) : onToggleVectorGroup(group.id)); }}
            onKeyDown={spanActivate(() => { if (members.length > 0) (kind === 'raster' ? onToggleRasterGroup(group.id) : onToggleVectorGroup(group.id)); })}
            title={eyeTitle}
          >
            <GroupEyeIcon state={eyeState} />
          </span>
          <span
            role="button"
            tabIndex={0}
            className="settings-layer-remove"
            onClick={() => removeGroup(kind, group.id)}
            onKeyDown={spanActivate(() => removeGroup(kind, group.id))}
            title="Remove group (its layers are kept)"
          >
            &times;
          </span>
        </div>
      </div>
    );
  };

  const renderRasterLayerRow = (layer: RasterLayer, inGroup: boolean) => (
    editingId === layer.id ? (
              <div key={layer.id} className="settings-add-form">
                <input
                  type="text"
                  placeholder="Layer name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="settings-input"
                />
                <input
                  type="text"
                  placeholder={layer.type === 'wmts' || layer.type === 'wms' ? 'GetCapabilities URL' : 'XYZ URL'}
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="settings-input"
                />
                {layer.type === 'wmts' && (
                  <div className="settings-wmts-info">
                    Layer: {layer.wmtsLayer}
                  </div>
                )}
                {layer.type === 'wms' && (
                  <div className="settings-wmts-info">
                    Layer: {layer.wmsLayer}
                  </div>
                )}
                {layer.type === 'wms' && (
                  <div className="settings-checkbox-row" title="When enabled, clicking the map queries the WMS server for the raster attributes at that position.">
                    <input
                      type="checkbox"
                      id={'wms-featureinfo-' + layer.id}
                      checked={editWmsFeatureInfo}
                      onChange={(e) => setEditWmsFeatureInfo(e.target.checked)}
                    />
                    <label htmlFor={'wms-featureinfo-' + layer.id}>GetFeatureInfo (click to inspect)</label>
                  </div>
                )}
                {(layer.type === 'xyz' || layer.type === 'wmts') && (() => {
                  // For WMTS, constrain the control to the matrix range of the live source
                  const wmtsGrid = layer.type === 'wmts' ? layer.olLayer?.getSource?.()?.getTileGrid?.() : null;
                  const native = (layer.olLayer as any)?._nativeTileZoomRange
                    ?? (wmtsGrid ? { min: wmtsGrid.getMinZoom(), max: wmtsGrid.getMaxZoom() } : null);
                  return (
                    <TileZoomRangeControl
                      minValue={editMinZoom}
                      maxValue={editMaxZoom}
                      onMinChange={(v) => { setEditMinZoom(v); applyZoomRange(layer.id, v, editMaxZoom); }}
                      onMaxChange={(v) => { setEditMaxZoom(v); applyZoomRange(layer.id, editMinZoom, v); }}
                      collapsible
                      defaultOpen={layer.minZoom !== undefined || layer.maxZoom !== undefined}
                      nativeMin={native?.min}
                      nativeMax={native?.max}
                    />
                  );
                })()}
                <div className="settings-color-adjustments color-adjust-collapsible">
                  <button
                    type="button"
                    className="color-adjust-toggle"
                    onClick={() => setColorsExpanded(c => !c)}
                    aria-expanded={colorsExpanded}
                    title={colorsExpanded ? 'Collapse' : 'Expand'}
                  >
                    <span className="color-adjust-toggle-left">
                      <span className={'color-adjust-chevron' + (colorsExpanded ? ' expanded' : '')}>{'\u25b8'}</span>
                      <span className="color-adjust-title">Colors</span>
                    </span>
                    <span className={'color-adjust-badge' + (colorSummary !== '' ? ' custom' : '')}>
                      {colorSummary !== '' ? colorSummary : 'default'}
                    </span>
                  </button>
                  {colorsExpanded && (
                  <div className="color-adjust-body">
                  <div className="settings-slider-row">
                    <label className="settings-slider-label">Brightness</label>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={editBrightness}
                      className="settings-slider"
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setEditBrightness(val);
                        onApplyColorAdjustments(layer.id, { brightness: val, saturation: editSaturation, contrast: editContrast, opacity: editOpacity });
                      }}
                    />
                    <span className="settings-slider-value">{editBrightness}%</span>
                    <button
                        className={'settings-slider-reset' + (editBrightness === 100 ? ' settings-slider-reset-hidden' : '')}
                        onClick={() => {
                          setEditBrightness(100);
                          onApplyColorAdjustments(layer.id, { brightness: 100, saturation: editSaturation, contrast: editContrast, opacity: editOpacity });
                        }}
                        title="Reset brightness"
                        disabled={editBrightness === 100}
                      >↺</button>
                  </div>
                  <div className="settings-slider-row">
                    <label className="settings-slider-label">Saturation</label>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={editSaturation}
                      className="settings-slider"
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setEditSaturation(val);
                        onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: val, contrast: editContrast, opacity: editOpacity });
                      }}
                    />
                    <span className="settings-slider-value">{editSaturation}%</span>
                    <button
                        className={'settings-slider-reset' + (editSaturation === 100 ? ' settings-slider-reset-hidden' : '')}
                        onClick={() => {
                          setEditSaturation(100);
                          onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: 100, contrast: editContrast, opacity: editOpacity });
                        }}
                        title="Reset saturation"
                        disabled={editSaturation === 100}
                      >↺</button>
                  </div>
                  <div className="settings-slider-row">
                    <label className="settings-slider-label">Contrast</label>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={editContrast}
                      className="settings-slider"
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setEditContrast(val);
                        onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: val, opacity: editOpacity });
                      }}
                    />
                    <span className="settings-slider-value">{editContrast}%</span>
                    <button
                        className={'settings-slider-reset' + (editContrast === 100 ? ' settings-slider-reset-hidden' : '')}
                        onClick={() => {
                          setEditContrast(100);
                          onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: 100, opacity: editOpacity });
                        }}
                        title="Reset contrast"
                        disabled={editContrast === 100}
                      >↺</button>
                  </div>
                  <div className="settings-slider-row">
                    <label className="settings-slider-label">Opacity</label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={editOpacity}
                      className="settings-slider"
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setEditOpacity(val);
                        onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: val });
                      }}
                    />
                    <span className="settings-slider-value">{editOpacity}%</span>
                    <button
                        className={'settings-slider-reset' + (editOpacity === 100 ? ' settings-slider-reset-hidden' : '')}
                        onClick={() => {
                          setEditOpacity(100);
                          onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: 100 });
                        }}
                        title="Reset opacity"
                        disabled={editOpacity === 100}
                      >↺</button>
                  </div>
                  </div>
                  )}
                </div>
                <div className="settings-form-buttons">
                  <button className="settings-button-primary" onClick={() => {
                    if (editName.trim() && editUrl.trim()) {
                      let updated: RasterLayer;
                      if (layer.type === 'wmts') {
                        updated = { ...layer, name: editName.trim(), wmtsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, minZoom: parseZoomInput(editMinZoom), maxZoom: parseZoomInput(editMaxZoom) };
                      } else if (layer.type === 'wms') {
                        updated = { ...layer, name: editName.trim(), wmsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, wmsFeatureInfoEnabled: editWmsFeatureInfo };
                      } else {
                        updated = { ...layer, name: editName.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, minZoom: parseZoomInput(editMinZoom), maxZoom: parseZoomInput(editMaxZoom) };
                      }
                      onEditRasterLayer(updated);
                      setEditingId(null);
                    }
                  }}>Apply</button>
                  <button className="settings-button-secondary" onClick={() => {
                    // Revert to original color adjustments on cancel
                    onApplyColorAdjustments(layer.id, originalAdjustments);
                    // Revert tile zoom range for XYZ layers
                    if (layer.type === 'xyz') {
                      onApplyTileZoomRange(layer.id, originalZoomRange.min, originalZoomRange.max);
                    }
                    setEditingId(null);
                  }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div 
                key={layer.id} 
                className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible === false ? ' layer-off' : '') + (rowDropTarget && rowDropTarget.id === layer.id ? (rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '')}
                draggable
                onDragStart={(e) => handleRasterDragStart(e, layer.id)}
                onDragOver={(e) => handleRasterDragOver(e, layer.id)}
                onDrop={(e) => handleRasterRowDrop(e, layer.id)}
                onDragEnd={handleRasterDragEnd}
                style={{ cursor: 'grab', opacity: draggedRasterId === layer.id ? 0.5 : 1 }}
              >
                <span className="settings-drag-handle">⋮⋮</span>
                <span className="settings-layer-name">{layer.name}</span>
                <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                {(layer.type === 'xyz' || layer.type === 'wmts') && (layer.minZoom !== undefined || layer.maxZoom !== undefined) && (
                  <span className="settings-layer-zoom-chip" title="Tile zoom range">
                    z{layer.minZoom ?? TILE_ZOOM_MIN}{'\u2013'}{layer.maxZoom ?? TILE_ZOOM_MAX}
                  </span>
                )}
                <GroupAssignMenu
                  groups={rasterGroups}
                  currentGroupId={layer.groupId}
                  onAssign={(gid) => onMoveRasterLayerToGroup(layer.id, gid)}
                  onCreateGroup={(name) => createGroupWithLayer('raster', layer.id, name)}
                />
                <button
                  className="settings-layer-edit"
                  onClick={() => {
                    setEditingId(layer.id);
                    setEditName(layer.name);
                    setEditUrl(
                      layer.type === 'wmts' ? (layer.wmtsCapabilitiesUrl || layer.url) :
                      layer.type === 'wms' ? (layer.wmsCapabilitiesUrl || layer.url) :
                      layer.url
                    );
                    // Initialize the WMS GetFeatureInfo toggle from the layer value
                    setEditWmsFeatureInfo(!!layer.wmsFeatureInfoEnabled);
                    // Initialize color adjustment state from layer values
                    const brightness = layer.brightness ?? 100;
                    const saturation = layer.saturation ?? 100;
                    const contrast = layer.contrast ?? 100;
                    const opacity = layer.opacity ?? 100;
                    setEditBrightness(brightness);
                    setEditSaturation(saturation);
                    setEditContrast(contrast);
                    setEditOpacity(opacity);
                    setOriginalAdjustments({ brightness, saturation, contrast, opacity });
                    // Open the colors panel only when the layer already has custom adjustments
                    setColorsExpanded(brightness !== 100 || saturation !== 100 || contrast !== 100 || opacity !== 100);
                    // Initialize tile zoom range state (XYZ layers only)
                    setEditMinZoom(layer.minZoom !== undefined ? String(layer.minZoom) : '');
                    setEditMaxZoom(layer.maxZoom !== undefined ? String(layer.maxZoom) : '');
                    setOriginalZoomRange({ min: layer.minZoom, max: layer.maxZoom });
                  }}
                  title="Edit layer"
                >
                  <PencilIcon />
                </button>
                <button
                  className="settings-layer-visibility"
                  onClick={() => onToggleRasterLayer(layer.id)}
                  title={layer.visible !== false ? "Hide layer" : "Show layer"}
                >
                  <EyeIcon visible={layer.visible !== false} />
                </button>
                {layer.type !== 'xyz' && (
                  <button
                    className="settings-layer-extent"
                    onClick={() => onGoToRasterLayerExtent(layer.id)}
                    title="Zoom to layer extent"
                  >
                    <ZoomToExtentIcon />
                  </button>
                )}
                <button 
                  className="settings-layer-remove"
                  onClick={() => onRemoveRasterLayer(layer.id)}
                  title="Remove layer"
                >
                  &times;
                </button>
              </div>
    )
  );

  const renderRasterGroupBlock = (group: LayerGroup, members: RasterLayer[]) => (
    <div
      key={'raster-group-' + group.id}
      className={'settings-group-block' + (draggedRasterGroupId === group.id ? ' dragging' : '')}
    >
      {renderGroupHeader('raster', group, members)}
      {/*
        Collapsed groups unmount their member rows entirely. (The previous
        always-mounted, CSS-grid 0fr collapse kept a zero-height grid track
        under the header, which stopped Chrome from starting header drags
        on collapsed groups - and its overflow:hidden clipped the per-layer
        group-assignment popovers.)
      */}
      {group.expanded && (
        <div
          className="settings-group-children"
          onDragOver={(e) => handleGroupChildrenDragOver(e, 'raster', group.id)}
          onDrop={(e) => handleGroupChildrenDrop(e, 'raster', group.id)}
          onDragLeave={handleGroupDragLeave}
        >
          <div className="settings-group-children-inner">
            {members.length === 0 ? (
              <div className="settings-group-empty">Empty group {'\u2014'} drag a layer onto this header, or use a layer{'\u2019'}s folder button.</div>
            ) : (
              members.map((layer) => renderRasterLayerRow(layer, true))
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderRasterPanelItems = () => {
    const items = buildLayerPanelItems(rasterLayers, rasterGroups).map((item) =>
      item.kind === 'group'
        ? renderRasterGroupBlock(item.group, item.members)
        : renderRasterLayerRow(item.layer, false)
    );
    // While a group is being dragged, offer an explicit drop strip at the
    // bottom of the list: dropping there moves the whole group to the end.
    if (draggedRasterGroupId || draggedRasterId) {
      items.push(
        <div
          key="raster-dropzone"
          className="settings-group-dropzone"
          onDragOver={(e) => handleRasterListDragOver(e)}
          onDrop={(e) => e.preventDefault()}
        >
          {draggedRasterGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

  const renderVectorLayerRow = (layer: VectorLayerConfig, inGroup: boolean) => (
    vectorEditingId === layer.id ? (
                  <div key={layer.id} className="settings-add-form">
                    <input
                      type="text"
                      placeholder="Layer name"
                      value={vectorEditName}
                      onChange={(e) => setVectorEditName(e.target.value)}
                      className="settings-input"
                    />
                    {['mvt', 'wfs', 'stac'].includes(layer.type) && (
                      <input
                        type="text"
                        placeholder={layer.type === 'wfs' ? 'WFS URL' : layer.type === 'stac' ? 'STAC API URL' : 'MVT URL'}
                        value={vectorEditUrl}
                        onChange={(e) => setVectorEditUrl(e.target.value)}
                        className="settings-input"
                      />
                    )}
                    <div className="settings-color-adjustments">
                      <div className="settings-slider-row">
                        <label className="settings-slider-label">Opacity</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={vectorEditOpacity}
                          className="settings-slider"
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setVectorEditOpacity(val);
                            onApplyVectorStyle(layer.id, vectorStylePayload({ opacity: val }));
                          }}
                        />
                        <span className="settings-slider-value">{vectorEditOpacity}%</span>
                        <button
                          className={'settings-slider-reset' + (vectorEditOpacity === 100 ? ' settings-slider-reset-hidden' : '')}
                          onClick={() => {
                            setVectorEditOpacity(100);
                            onApplyVectorStyle(layer.id, vectorStylePayload({ opacity: 100 }));
                          }}
                          title="Reset opacity"
                          disabled={vectorEditOpacity === 100}
                        >↺</button>
                      </div>
                      <div className="settings-style-collapse">
                        <button
                          type="button"
                          className="settings-style-collapse-header"
                          onClick={() => setVectorStyleExpanded((expanded) => !expanded)}
                          aria-expanded={vectorStyleExpanded}
                        >
                          <span className={'settings-style-collapse-chevron' + (vectorStyleExpanded ? ' expanded' : '')}>▸</span>
                          <span className="settings-style-collapse-title">Colors & style</span>
                          <span className="settings-style-collapse-summary">
                            <span className="settings-style-collapse-swatch" style={{ background: vectorEditLineColor }} title="Line color" />
                            <span className="settings-style-collapse-swatch" style={{ background: vectorEditFillColor }} title="Fill color" />
                            <span className="settings-style-collapse-swatch" style={{ background: vectorEditFontColor }} title="Font color" />
                          </span>
                        </button>
                        {vectorStyleExpanded && (
                          <div className="settings-style-collapse-body">
                            <div className="settings-slider-row">
                              <label className="settings-slider-label">Line width</label>
                              <input
                                type="range"
                                min="1"
                                max="10"
                                value={vectorEditLineWidth}
                                className="settings-slider"
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setVectorEditLineWidth(val);
                                  onApplyVectorStyle(layer.id, vectorStylePayload({ lineWidth: val }));
                                }}
                              />
                              <span className="settings-slider-value">{vectorEditLineWidth}px</span>
                              <button
                                className={'settings-slider-reset' + (vectorEditLineWidth === 2 ? ' settings-slider-reset-hidden' : '')}
                                onClick={() => {
                                  setVectorEditLineWidth(2);
                                  onApplyVectorStyle(layer.id, vectorStylePayload({ lineWidth: 2 }));
                                }}
                                title="Reset line width"
                                disabled={vectorEditLineWidth === 2}
                              >↺</button>
                            </div>
                            <ColorAlphaEditor
                              label="Line color"
                              value={vectorEditLineColor}
                              defaultAlpha={1}
                              onChange={(val) => {
                                setVectorEditLineColor(val);
                                onApplyVectorStyle(layer.id, vectorStylePayload({ lineColor: val }));
                              }}
                            />
                            <ColorAlphaEditor
                              label="Fill color"
                              value={vectorEditFillColor}
                              defaultAlpha={0.3}
                              onChange={(val) => {
                                setVectorEditFillColor(val);
                                onApplyVectorStyle(layer.id, vectorStylePayload({ fillColor: val }));
                              }}
                            />
                            <div className="settings-slider-row">
                              <label className="settings-slider-label">Font size</label>
                              <input
                                type="range"
                                min="8"
                                max="32"
                                value={vectorEditFontSize}
                                className="settings-slider"
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10);
                                  setVectorEditFontSize(val);
                                  onApplyVectorStyle(layer.id, vectorStylePayload({ fontSize: val }));
                                }}
                              />
                              <span className="settings-slider-value">{vectorEditFontSize}px</span>
                              <button
                                className={'settings-slider-reset' + (vectorEditFontSize === 14 ? ' settings-slider-reset-hidden' : '')}
                                onClick={() => {
                                  setVectorEditFontSize(14);
                                  onApplyVectorStyle(layer.id, vectorStylePayload({ fontSize: 14 }));
                                }}
                                title="Reset font size"
                                disabled={vectorEditFontSize === 14}
                              >↺</button>
                            </div>
                            <ColorAlphaEditor
                              label="Font color"
                              value={vectorEditFontColor}
                              defaultAlpha={1}
                              onChange={(val) => {
                                setVectorEditFontColor(val);
                                onApplyVectorStyle(layer.id, vectorStylePayload({ fontColor: val }));
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    {(() => {
                      // MVT layers clamp tile requests to the grid's native range;
                      // other vector types use the range as a visibility window.
                      const mvtGrid = layer.type === 'mvt' ? layer.olLayer?.getSource?.()?.getTileGrid?.() : null;
                      const native = layer.type === 'mvt'
                        ? ((layer.olLayer as any)?._nativeTileZoomRange ?? (mvtGrid ? { min: mvtGrid.getMinZoom(), max: mvtGrid.getMaxZoom() } : null))
                        : null;
                      return (
                        <TileZoomRangeControl
                          minValue={vectorEditMinZoom}
                          maxValue={vectorEditMaxZoom}
                          onMinChange={(v) => { setVectorEditMinZoom(v); applyVectorZoomRange(layer.id, v, vectorEditMaxZoom); }}
                          onMaxChange={(v) => { setVectorEditMaxZoom(v); applyVectorZoomRange(layer.id, vectorEditMinZoom, v); }}
                          collapsible
                          defaultOpen={layer.minZoom !== undefined || layer.maxZoom !== undefined}
                          nativeMin={native?.min}
                          nativeMax={native?.max}
                          title={layer.type === 'mvt' ? 'Tile zoom range' : 'Zoom range'}
                          hint={layer.type === 'mvt'
                            ? undefined
                            : 'The layer is only visible while the map zoom is inside this range.'}
                        />
                      );
                    })()}
                    {layer.type !== 'mvt' && (() => {
                      // Clustering only applies to point datasets. Inspect the
                      // live features to decide whether the option is available.
                      const stats = layerPointStats(layer.olLayer);
                      const canCluster = stats.total === 0 || stats.pointCount === stats.total;
                      return (
                        <div className={'settings-cluster-control' + (canCluster ? '' : ' disabled')}>
                          <label
                            className="settings-cluster-checkbox"
                            title={canCluster
                              ? 'Group nearby points into count bubbles — ideal for dense point datasets'
                              : 'Clustering needs a point dataset — this layer mixes in lines or polygons'}
                          >
                            <input
                              type="checkbox"
                              checked={vectorEditCluster}
                              disabled={!canCluster}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setVectorEditCluster(checked);
                                onApplyVectorCluster(layer.id, checked, vectorEditClusterDistance);
                              }}
                            />
                            <span className="settings-cluster-label">Point clustering</span>
                            {stats.pointCount > 0 && (
                              <span className="settings-cluster-count" title="Point features in this layer">
                                {stats.pointCount.toLocaleString()} {stats.pointCount === 1 ? 'point' : 'points'}
                              </span>
                            )}
                          </label>
                          {vectorEditCluster && canCluster && (
                            <div className="settings-slider-row">
                              <label className="settings-slider-label">Cluster distance</label>
                              <input
                                type="range"
                                min="10"
                                max="120"
                                value={vectorEditClusterDistance}
                                className="settings-slider"
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10);
                                  setVectorEditClusterDistance(val);
                                  onApplyVectorCluster(layer.id, true, val);
                                }}
                              />
                              <span className="settings-slider-value">{vectorEditClusterDistance}px</span>
                              <button
                                className={'settings-slider-reset' + (vectorEditClusterDistance === 40 ? ' settings-slider-reset-hidden' : '')}
                                onClick={() => {
                                  setVectorEditClusterDistance(40);
                                  onApplyVectorCluster(layer.id, true, 40);
                                }}
                                title="Reset cluster distance"
                                disabled={vectorEditClusterDistance === 40}
                              >↺</button>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {layer.type !== 'mvt' && (() => {
                      // Attribute filter: a toggle that pops out a query
                      // expression field. Apply narrows the layer to the
                      // matching features; the full dataset stays stashed on
                      // the OL layer so Clear/Cancel restores everything.
                      const stats = vectorFilterStats(layer.olLayer);
                      const exprTrimmed = vectorEditFilterExpr.trim();
                      const liveCheck = vectorEditFilterEnabled && exprTrimmed ? checkFeatureFilter(exprTrimmed) : null;
                      // Preview how many features the typed expression would
                      // match, evaluated against the full (unfiltered) set.
                      const masterFeats: any[] | null = layer.olLayer
                        ? (Array.isArray(layer.olLayer._filterMaster)
                            ? layer.olLayer._filterMaster
                            : (vectorFeatureSource(layer.olLayer)?.getFeatures() ?? null))
                        : null;
                      let liveMatched: number | null = null;
                      if (liveCheck && liveCheck.ok && masterFeats) {
                        try {
                          const pred = compileFeatureFilter(exprTrimmed).predicate;
                          liveMatched = masterFeats.filter((f: any) => pred(featureProperties(f))).length;
                        } catch { liveMatched = null; }
                      }
                      const liveError = liveCheck && !liveCheck.ok ? liveCheck.error : null;
                      const showError = vectorFilterError || (vectorFilterTouched ? liveError : null);

                      const applyFilterExpr = () => {
                        if (!exprTrimmed) return;
                        const check = checkFeatureFilter(exprTrimmed);
                        if (!check.ok) { setVectorFilterError(check.error); return; }
                        setVectorFilterError(null);
                        onApplyVectorFilter(layer.id, true, exprTrimmed);
                      };

                      return (
                        <div className={'settings-filter-control' + (vectorEditFilterEnabled ? ' active' : '')}>
                          <div className="settings-filter-header">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={vectorEditFilterEnabled}
                              className={'settings-filter-switch' + (vectorEditFilterEnabled ? ' on' : '')}
                              title={vectorEditFilterEnabled
                                ? 'Turn the attribute filter off'
                                : 'Show only the features that match a query expression'}
                              onClick={() => {
                                const next = !vectorEditFilterEnabled;
                                setVectorEditFilterEnabled(next);
                                setVectorFilterError(null);
                                setVectorFilterTouched(false);
                                // Toggling off clears the filter from the map at
                                // once; toggling on only opens the expression
                                // field - nothing is filtered until Apply.
                                if (!next) onApplyVectorFilter(layer.id, false, '');
                              }}
                            >
                              <span className="settings-filter-switch-knob" />
                            </button>
                            <span className="settings-filter-title">
                              <FunnelIcon size={13} />
                              Filter
                            </span>
                            {vectorEditFilterEnabled && stats.filtered && (
                              <span className="settings-filter-count" title="Features shown / total features in the layer">
                                {stats.shown.toLocaleString()} of {stats.total.toLocaleString()}
                              </span>
                            )}
                          </div>
                          <div className={'settings-filter-body' + (vectorEditFilterEnabled ? ' open' : '')}>
                            <div className="settings-filter-body-inner">
                              <input
                                className={'settings-filter-input' + (showError ? ' has-error' : '')}
                                value={vectorEditFilterExpr}
                                autoFocus
                                spellCheck={false}
                                autoComplete="off"
                                aria-label="Filter query expression"
                                placeholder={'e.g. "capture_date" > \'2024-01-01\'  or  "published" is true'}
                                onChange={(e) => { setVectorEditFilterExpr(e.target.value); setVectorFilterError(null); }}
                                onBlur={() => setVectorFilterTouched(true)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFilterExpr(); } }}
                              />
                              <div className="settings-filter-syntax">
                                <span className="settings-filter-syntax-label">Syntax</span>
                                {FILTER_SYNTAX_HINTS.map((hint) => (
                                  <code key={hint} className="settings-filter-syntax-chip">{hint}</code>
                                ))}
                              </div>
                              {showError ? (
                                <div className="settings-filter-feedback error" role="alert">{showError}</div>
                              ) : exprTrimmed && liveCheck && liveCheck.ok ? (
                                <div className="settings-filter-feedback ok">
                                  {'\u2713'} Valid expression{masterFeats && liveMatched !== null && (
                                    <span> {'\u2014'} matches {liveMatched.toLocaleString()} of {masterFeats.length.toLocaleString()} {masterFeats.length === 1 ? 'feature' : 'features'}</span>
                                  )}
                                </div>
                              ) : null}
                              <div className="settings-filter-actions">
                                <button
                                  className="settings-filter-apply"
                                  disabled={!exprTrimmed}
                                  onClick={applyFilterExpr}
                                >Apply</button>
                                {stats.filtered && (
                                  <button
                                    className="settings-filter-clear"
                                    onClick={() => {
                                      setVectorEditFilterExpr('');
                                      setVectorFilterError(null);
                                      setVectorFilterTouched(false);
                                      onApplyVectorFilter(layer.id, false, '');
                                    }}
                                  >Clear filter</button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    {layer.isDrawnInApp && layer.olLayer && (() => {
                      const feats = layer.olLayer.getSource?.()?.getFeatures?.() || [];
                      if (feats.length === 0) return null;
                      return (
                        <div className="settings-vector-features">
                          <div className="settings-vector-features-title">Individual features</div>
                          <div className="settings-vector-features-list">
                            {feats.map((f: any, i: number) => (
                              <VectorFeatureStyleItem
                                key={i}
                                feature={f}
                                index={i}
                                onApply={(feat, s) => onApplyVectorFeatureStyle(layer.id, feat, s)}
                                units={units}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    <div className="settings-form-buttons">
                      <button className="settings-button-primary" onClick={() => {
                        if (vectorEditName.trim() && (!['mvt', 'wfs', 'stac'].includes(layer.type) || vectorEditUrl.trim())) {
                          // Commit the filter alongside the other edits: an
                          // invalid expression blocks the commit (the error is
                          // surfaced inline in the filter panel above).
                          const filterExpr = vectorEditFilterEnabled ? vectorEditFilterExpr.trim() : '';
                          if (filterExpr) {
                            const filterCheck = checkFeatureFilter(filterExpr);
                            if (!filterCheck.ok) {
                              setVectorFilterError(filterCheck.error);
                              return;
                            }
                            onApplyVectorFilter(layer.id, true, filterExpr);
                          } else if (layer.filterEnabled) {
                            onApplyVectorFilter(layer.id, false, '');
                          }
                          const updated: VectorLayerConfig = {
                            ...layer,
                            name: vectorEditName.trim(),
                            ...(['mvt', 'wfs', 'stac'].includes(layer.type) ? { url: vectorEditUrl.trim() } : {}),
                            opacity: vectorEditOpacity,
                            lineColor: vectorEditLineColor,
                            lineWidth: vectorEditLineWidth,
                            fillColor: vectorEditFillColor,
                            fontColor: vectorEditFontColor,
                            fontSize: vectorEditFontSize,
                            minZoom: parseZoomInput(vectorEditMinZoom),
                            maxZoom: parseZoomInput(vectorEditMaxZoom),
                            clusterPoints: vectorEditCluster,
                            clusterDistance: vectorEditClusterDistance,
                            filterEnabled: !!filterExpr,
                            filterExpression: filterExpr,
                          };
                          onEditVectorLayer(updated);
                          // Applying commits the layer — that also ends any geometry
                          // re-edit session on it, exactly like "Done editing".
                          if (editingVectorLayerId === layer.id) {
                            onReeditVectorLayer(layer.id);
                          }
                          setVectorEditingId(null);
                        }
                      }}>Apply</button>
                      <button className="settings-button-secondary" onClick={() => {
                        onApplyVectorStyle(layer.id, originalVectorStyle);
                        onApplyVectorZoomRange(layer.id, originalVectorZoomRange.min, originalVectorZoomRange.max);
                        onApplyVectorCluster(layer.id, originalVectorCluster.clusterPoints, originalVectorCluster.clusterDistance);
                        setVectorEditCluster(originalVectorCluster.clusterPoints);
                        setVectorEditClusterDistance(originalVectorCluster.clusterDistance);
                        onApplyVectorFilter(layer.id, originalVectorFilter.enabled, originalVectorFilter.expression);
                        setVectorEditFilterEnabled(originalVectorFilter.enabled);
                        setVectorEditFilterExpr(originalVectorFilter.expression);
                        setVectorFilterError(null);
                        setVectorFilterTouched(false);
                        setVectorEditingId(null);
                      }}>Cancel</button>
                      {layer.isDrawnInApp && (
                        <>
                          <button
                            className={`settings-button-reedit ${editingVectorLayerId === layer.id ? 'active' : ''}`}
                            onClick={() => onReeditVectorLayer(layer.id)}
                            title={editingVectorLayerId === layer.id
                              ? 'Finish editing the layer'
                              : 'Edit this layer on the map \u2014 reshape and move its features, draw new ones straight into it, undo/redo included'}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 19l5-11 5 5 6-8" />
                              <rect x="6.9" y="5.9" width="4.2" height="4.2" fill="#fff" />
                            </svg>
                            {editingVectorLayerId === layer.id ? 'Done editing' : 'Re-edit layer'}
                          </button>
                          <div className="settings-export-wrapper" ref={downloadToggleRef}>
                            <button
                              className={'settings-button-export settings-export-toggle' + (downloadMenu && downloadMenu.layerId === layer.id ? ' open' : '')}
                              onClick={(e) => {
                                if (downloadMenu && downloadMenu.layerId === layer.id) {
                                  setDownloadMenu(null);
                                } else {
                                  openDownloadMenu(layer.id, e.currentTarget);
                                }
                              }}
                              title="Download this layer’s features"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              Download
                              <svg className="settings-export-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="6 9 12 15 18 9"/>
                              </svg>
                            </button>
                            {downloadMenu && downloadMenu.layerId === layer.id && createPortal(
                              <div
                                className={'settings-export-menu' + (downloadMenu.top !== undefined ? ' below' : '')}
                                role="menu"
                                ref={downloadMenuRef}
                                style={downloadMenu.bottom !== undefined
                                  ? { left: downloadMenu.left, bottom: downloadMenu.bottom }
                                  : { left: downloadMenu.left, top: downloadMenu.top }}
                              >
                                {VECTOR_EXPORT_FORMATS.map((fmt) => (
                                  <button
                                    key={fmt.id}
                                    role="menuitem"
                                    onClick={() => { setDownloadMenu(null); onExportVectorLayer(layer.id, fmt.id); }}
                                  >
                                    <span className="settings-export-menu-label">{fmt.label}</span>
                                    <span className="settings-export-menu-ext">{fmt.extension}</span>
                                  </button>
                                ))}
                              </div>,
                              document.body
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div 
                    key={layer.id} 
                    className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible !== true ? ' layer-off' : '') + (rowDropTarget && rowDropTarget.id === layer.id ? (rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '')}
                    draggable
                    onDragStart={(e) => handleVectorDragStart(e, layer.id)}
                    onDragOver={(e) => handleVectorDragOver(e, layer.id)}
                    onDrop={(e) => handleVectorRowDrop(e, layer.id)}
                    onDragEnd={handleVectorDragEnd}
                    style={{ cursor: 'grab', opacity: draggedVectorId === layer.id ? 0.5 : 1 }}
                  >
                    <span className="settings-drag-handle">⋮⋮</span>
                    <span className="settings-layer-name">{layer.name}</span>
                    {loadingVectorIds.has(layer.id) && (
                      <span className="settings-layer-loading" title="Loading data…">
                        <span className="settings-layer-loading-spinner" />
                      </span>
                    )}
                    <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                    {(layer.minZoom !== undefined || layer.maxZoom !== undefined) && (
                      <span className="settings-layer-zoom-chip" title={layer.type === 'mvt' ? 'Tile zoom range' : 'Visible zoom range'}>
                        z{layer.minZoom ?? TILE_ZOOM_MIN}{'\u2013'}{layer.maxZoom ?? TILE_ZOOM_MAX}
                      </span>
                    )}
                    {layer.filterEnabled && !!layer.filterExpression && (
                      <span className="settings-layer-filter-chip" title={'Filtering features: ' + layer.filterExpression}>
                        <FunnelIcon size={9} />
                        Filtered
                      </span>
                    )}
                    <GroupAssignMenu
                      groups={vectorGroups}
                      currentGroupId={layer.groupId}
                      onAssign={(gid) => onMoveVectorLayerToGroup(layer.id, gid)}
                      onCreateGroup={(name) => createGroupWithLayer('vector', layer.id, name)}
                    />
                    <button
                      className="settings-layer-edit"
                      onClick={() => {
                        setVectorEditingId(layer.id);
                        setVectorStyleExpanded(false);
                        setVectorEditName(layer.name);
                        setVectorEditUrl(layer.url || '');
                        const opacity = layer.opacity ?? 100;
                        const lineColor = rgbaToString(parseColor(layer.lineColor, 1));
                        const lineWidth = layer.lineWidth ?? 2;
                        const fillColor = rgbaToString(parseColor(layer.fillColor, 0.3));
                        const fontColor = rgbaToString(parseColor(layer.fontColor, 1));
                        const fontSize = layer.fontSize ?? 14;
                        setVectorEditOpacity(opacity);
                        setVectorEditLineColor(lineColor);
                        setVectorEditLineWidth(lineWidth);
                        setVectorEditFillColor(fillColor);
                        setVectorEditFontColor(fontColor);
                        setVectorEditFontSize(fontSize);
                        setOriginalVectorStyle({ opacity, lineColor, lineWidth, fillColor, fontColor, fontSize });
                        setVectorEditMinZoom(layer.minZoom !== undefined ? String(layer.minZoom) : '');
                        setVectorEditMaxZoom(layer.maxZoom !== undefined ? String(layer.maxZoom) : '');
                        setOriginalVectorZoomRange({ min: layer.minZoom, max: layer.maxZoom });
                        const clusterPoints = layer.clusterPoints === true;
                        const clusterDistance = layer.clusterDistance ?? 40;
                        setVectorEditCluster(clusterPoints);
                        setVectorEditClusterDistance(clusterDistance);
                        setOriginalVectorCluster({ clusterPoints, clusterDistance });
                        const filterEnabled = layer.filterEnabled === true && !!layer.filterExpression;
                        setVectorEditFilterEnabled(filterEnabled);
                        setVectorEditFilterExpr(layer.filterExpression || '');
                        setOriginalVectorFilter({ enabled: filterEnabled, expression: layer.filterExpression || '' });
                        setVectorFilterError(null);
                        setVectorFilterTouched(false);
                      }}
                      title="Edit layer"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      className="settings-layer-visibility"
                      onClick={() => onToggleVectorLayer(layer.id)}
                      title={layer.visible ? "Hide layer" : "Show layer"}
                    >
                      <EyeIcon visible={layer.visible} />
                    </button>
                    {layer.type !== 'mvt' && (
                      <button
                        className="settings-layer-extent"
                        onClick={() => onGoToVectorLayerExtent(layer.id)}
                        title="Zoom to layer extent"
                      >
                        <ZoomToExtentIcon />
                      </button>
                    )}
                    <button 
                      className="settings-layer-remove"
                      onClick={() => onRemoveVectorLayer(layer.id)}
                      title="Remove layer"
                    >
                      &times;
                    </button>
                  </div>
    )
  );

  const renderVectorGroupBlock = (group: LayerGroup, members: VectorLayerConfig[]) => (
    <div
      key={'vector-group-' + group.id}
      className={'settings-group-block' + (draggedVectorGroupId === group.id ? ' dragging' : '')}
    >
      {renderGroupHeader('vector', group, members)}
      {/* Collapsed groups unmount their member rows - see the raster block. */}
      {group.expanded && (
        <div
          className="settings-group-children"
          onDragOver={(e) => handleGroupChildrenDragOver(e, 'vector', group.id)}
          onDrop={(e) => handleGroupChildrenDrop(e, 'vector', group.id)}
          onDragLeave={handleGroupDragLeave}
        >
          <div className="settings-group-children-inner">
            {members.length === 0 ? (
              <div className="settings-group-empty">Empty group {'\u2014'} drag a layer onto this header, or use a layer{'\u2019'}s folder button.</div>
            ) : (
              members.map((layer) => renderVectorLayerRow(layer, true))
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderVectorPanelItems = () => {
    const items = buildLayerPanelItems(vectorLayers, vectorGroups).map((item) =>
      item.kind === 'group'
        ? renderVectorGroupBlock(item.group, item.members)
        : renderVectorLayerRow(item.layer, false)
    );
    // While a group is being dragged, offer an explicit drop strip at the
    // bottom of the list: dropping there moves the whole group to the end.
    if (draggedVectorGroupId || draggedVectorId) {
      items.push(
        <div
          key="vector-dropzone"
          className="settings-group-dropzone"
          onDragOver={(e) => handleVectorListDragOver(e)}
          onDrop={(e) => e.preventDefault()}
        >
          {draggedVectorGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

  return (
    <div className="settings-dialog" onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <div className="settings-dialog-header">
        <div className="settings-dialog-title-row">
          <span className="settings-dialog-title">Settings</span>
          <button
            type="button"
            className={`settings-dialog-pin${pinned ? ' pinned' : ''}`}
            onClick={() => onPinToggle(!pinned)}
            title={pinned ? 'Unpin — clicking outside closes Settings' : 'Pin — keep Settings open while using the map'}
            aria-pressed={pinned}
          >
            <PinIcon pinned={pinned} />
          </button>
        </div>
        <button className="settings-dialog-close" onClick={onClose}>&times;</button>
      </div>
      <div className="settings-dialog-body">
        <div className="settings-section">
          <div className="settings-section-title">Basic Settings</div>
          <div className="settings-basic-grid">
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="basemap-toggle"
                checked={showBasemap}
                onChange={(e) => onBasemapToggle(e.target.checked)}
              />
              <label htmlFor="basemap-toggle">Basemap</label>
            </div>
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="grid-toggle"
                checked={showGrid}
                onChange={(e) => onGridToggle(e.target.checked)}
              />
              <label htmlFor="grid-toggle">Show Grid</label>
            </div>
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="draw-toolbar-toggle"
                checked={showDrawToolbar}
                onChange={(e) => onDrawToolbarToggle(e.target.checked)}
              />
              <label htmlFor="draw-toolbar-toggle">Drawing Tool</label>
            </div>
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="coordinates-toggle"
                checked={showCoordinates}
                onChange={(e) => onCoordinatesToggle(e.target.checked)}
              />
              <label htmlFor="coordinates-toggle">Show Coordinates</label>
            </div>
          </div>
        </div>
        <div className="settings-section">
          <div
            className="settings-section-title-row"
            onDragOver={(e) => handleSectionDragOver(e, 'raster')}
            onDragLeave={handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dragOverSection === 'raster' ? ' drag-over' : '')}>Raster Layers</div>
            <button
              type="button"
              className="settings-new-group-btn"
              onClick={() => addGroup('raster')}
              title="Create a folder to organise raster layers"
            >
              <FolderPlusIcon /> New group
            </button>
          </div>
          {isRestoringLayers && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Restoring raster layers...</span>
            </div>
          )}
          <div className="settings-layers-list">
            {renderRasterPanelItems()}
          </div>
          {addingRaster && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Adding layer...</span>
            </div>
          )}
          {!showAddForm ? (
            <button 
              className="settings-add-button"
              onClick={() => setShowAddForm(true)}
            >
              + Add Raster Layer
            </button>
          ) : (
            <div className="settings-add-form">
              <CustomSelect
                value={newLayerType}
                onChange={(val) => {
                  setNewLayerType(val as 'xyz' | 'wmts' | 'wms' | 'known');
                  setWmtsLayers([]);
                  setWmtsFetched(false);
                  setSelectedWmtsLayer('');
                  setWmsLayers([]);
                  setWmsFetched(false);
                  setSelectedWmsLayer('');
                  nameManuallyEditedRef.current = false;
                  // Reset known source state
                  setSelectedKnownSourceId('');
                  setKnownSourceLayers([]);
                  setSelectedKnownSourceLayer('');
                  setKnownSourceFetched(false);
                }}
                className="settings-select"
                options={[
                  { value: 'xyz', label: 'XYZ' },
                  { value: 'wmts', label: 'WMTS' },
                  { value: 'wms', label: 'WMS' },
                  ...(knownSources.filter(s => s.type !== 'vtile' && s.type !== 'wfs' && s.type !== 'stac').length > 0 ? [{ value: 'known', label: 'Known source' }] : []),
                ]}
              />
              <input
                type="text"
                placeholder="Layer name"
                value={newLayerName}
                onChange={(e) => { setNewLayerName(e.target.value); nameManuallyEditedRef.current = true; }}
                className="settings-input"
              />
              {newLayerType === 'xyz' ? (
                <input
                  type="text"
                  placeholder="XYZ URL ({'{z}/{x}/{y}'} or {'{q}'} quadkey, e.g., https://tile.example.com/{'{z}/{x}/{y}'}.png)"
                  value={newLayerUrl}
                  onChange={(e) => setNewLayerUrl(e.target.value)}
                  className="settings-input"
                />
              ) : newLayerType === 'known' ? (
                <>
                  <CustomSelect
                    value={selectedKnownSourceId}
                    onChange={(val) => {
                      setSelectedKnownSourceId(val);
                      if (val) {
                        // Prefill layer name with source name
                        const src = knownSources.find(s => s.id === val);
                        if (src && !nameManuallyEditedRef.current) {
                          setNewLayerName(src.name);
                        }
                        fetchKnownSourceCapabilities(val);
                      } else {
                        setKnownSourceLayers([]);
                        setSelectedKnownSourceLayer('');
                        setKnownSourceFetched(false);
                      }
                    }}
                    className="settings-select"
                    options={[
                      { value: '', label: 'Select a source', disabled: true },
                      ...knownSources.filter(s => s.type !== 'vtile' && s.type !== 'wfs' && s.type !== 'stac').map(s => ({ 
                        value: s.id, 
                        label: `${s.name} (${s.type.toUpperCase()})` 
                      })),
                    ]}
                  />
                  {knownSourceLoading && (
                    <div className="settings-loading-indicator">
                      <div className="settings-loading-spinner"></div>
                      <span>Loading layers...</span>
                    </div>
                  )}
                  {knownSourceFetched && knownSourceLayers.length === 0 && selectedKnownSourceId && (() => {
                    const source = knownSources.find(s => s.id === selectedKnownSourceId);
                    return source?.type === 'xyz' ? (
                      <div className="settings-info-message">
                        XYZ tile sources don't have multiple layers. Enter a name and add the layer.
                      </div>
                    ) : null;
                  })()}
                  {knownSourceFetched && knownSourceLayers.length > 0 && (
                    <CustomSelect
                      value={selectedKnownSourceLayer}
                      onChange={(val) => {
                        setSelectedKnownSourceLayer(val);
                        const matched = knownSourceLayers.find(l => l.id === val);
                        if (matched && !nameManuallyEditedRef.current) {
                          setNewLayerName(matched.title.trim());
                        }
                      }}
                      className="settings-select"
                      placeholder="Select a layer"
                      filterable
                      options={[
                        ...knownSourceLayers.map(l => ({ value: l.id, label: l.title })),
                      ]}
                    />
                  )}
                </>
              ) : newLayerType === 'wmts' ? (
                <>
                  <input
                    type="text"
                    placeholder="GetCapabilities URL"
                    value={wmtsCapabilitiesUrl}
                    onChange={(e) => {
                      setWmtsCapabilitiesUrl(e.target.value);
                      setWmtsFetched(false);
                      setWmtsLayers([]);
                    }}
                    className="settings-input"
                  />
                  <CustomSelect
                    value={selectedWmtsLayer}
                    onOpen={() => {
                      if (wmtsCapabilitiesUrl.trim() && !wmtsFetched && !wmtsLoading) {
                        fetchWmtsCapabilities();
                      }
                    }}
                    onChange={(val) => {
                      setSelectedWmtsLayer(val);
                      const matched = wmtsLayers.find(l => l.identifier === val);
                      if (matched && !nameManuallyEditedRef.current) {
                        setNewLayerName(matched.title);
                      }
                    }}
                    className="settings-select"
                    disabled={!wmtsCapabilitiesUrl.trim()}
                    placeholder={wmtsLoading ? 'Loading...' : 'Select a layer'}
                    filterable
                    options={wmtsLoading ? [] : [
                      ...wmtsLayers.map((layer) => ({ value: layer.identifier, label: layer.title })),
                    ]}
                  />
                </>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="GetCapabilities URL"
                    value={wmsCapabilitiesUrl}
                    onChange={(e) => {
                      setWmsCapabilitiesUrl(e.target.value);
                      setWmsFetched(false);
                      setWmsLayers([]);
                    }}
                    className="settings-input"
                  />
                  <CustomSelect
                    value={selectedWmsLayer}
                    onOpen={() => {
                      if (wmsCapabilitiesUrl.trim() && !wmsFetched && !wmsLoading) {
                        fetchWmsCapabilities();
                      }
                    }}
                    onChange={(val) => {
                      setSelectedWmsLayer(val);
                      const matched = wmsLayers.find(l => l.name === val);
                      if (matched && !nameManuallyEditedRef.current) {
                        setNewLayerName(matched.title.trim());
                      }
                    }}
                    className="settings-select"
                    disabled={!wmsCapabilitiesUrl.trim()}
                    placeholder={wmsLoading ? 'Loading...' : 'Select a layer'}
                    filterable
                    options={wmsLoading ? [] : [
                      ...wmsLayers.map((layer) => ({ value: layer.name, label: layer.title })),
                    ]}
                  />
                </>
              )}
              {addingXyzLayer && (
                <TileZoomRangeControl
                  minValue={newMinZoom}
                  maxValue={newMaxZoom}
                  onMinChange={setNewMinZoom}
                  onMaxChange={setNewMaxZoom}
                  collapsible
                  defaultOpen={false}
                />
              )}
              <div className="settings-form-buttons">
                <button className="settings-button-primary" onClick={() => handleAddLayer(rasterLayers)}>
                  Add
                </button>
                <button className="settings-button-secondary" onClick={() => { setShowAddForm(false); setNewLayerName(''); nameManuallyEditedRef.current = false; }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

        </div>
        <div className="settings-section">
          <div
            className="settings-section-title-row"
            onDragOver={(e) => handleSectionDragOver(e, 'vector')}
            onDragLeave={handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dragOverSection === 'vector' ? ' drag-over' : '')}>Vector Layers</div>
            <button
              type="button"
              className="settings-new-group-btn"
              onClick={() => addGroup('vector')}
              title="Create a folder to organise vector layers"
            >
              <FolderPlusIcon /> New group
            </button>
          </div>
          {isRestoringLayers && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Restoring vector layers...</span>
            </div>
          )}
          {vectorLayers.length === 0 && vectorGroups.length === 0 ? (
            <p className="settings-placeholder">No vector layers added yet. Drag and drop GeoJSON, KML, or KMZ files onto the map.</p>
          ) : (
            <div className="settings-layers-list">
              {renderVectorPanelItems()}
            </div>
          )}
          {!showAddVectorForm ? (
            <button 
              className="settings-add-button"
              onClick={() => setShowAddVectorForm(true)}
            >
              + Add Vector Layer
            </button>
          ) : (
            <div className="settings-add-form">
              <CustomSelect
                value={vectorSourceType}
                onChange={(val) => setVectorSourceType(val as 'file' | 'mvt' | 'wfs' | 'stac' | 'known')}
                className="settings-select"
                options={[
                  { value: 'file', label: 'File (GeoJSON/KML/KMZ)' },
                  { value: 'mvt', label: 'MVT (Vector Tiles)' },
                  { value: 'wfs', label: 'WFS (Web Feature Service)' },
                  { value: 'stac', label: 'STAC (SpatioTemporal Asset Catalog)' },
                  ...(knownSources.filter(s => s.type === 'vtile' || s.type === 'wfs' || s.type === 'stac').length > 0 ? [{ value: 'known', label: 'Saved source' }] : []),
                ]}
              />
              {vectorSourceType === 'file' ? (
                <>
                  <input
                    type="text"
                    placeholder="Layer name (optional)"
                    value={fileLayerName}
                    onChange={(e) => setFileLayerName(e.target.value)}
                    className="settings-input"
                  />
                  <input
                    type="file"
                    accept=".geojson,.json,.kml,.kmz"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        onAddVectorLayer(file, fileLayerName.trim() || undefined);
                        setFileLayerName('');
                        setShowAddVectorForm(false);
                      }
                      e.target.value = '';
                    }}
                    style={{ display: 'none' }}
                    ref={fileInputRef}
                  />
                  <button
                    className="settings-add-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Choose File
                  </button>
                </>
              ) : vectorSourceType === 'mvt' ? (
                <>
                  <input
                    type="text"
                    placeholder="Layer name"
                    value={mvtLayerName}
                    onChange={(e) => setMvtLayerName(e.target.value)}
                    className="settings-input"
                  />
                  <input
                    type="text"
                    placeholder="MVT URL (e.g., https://example.com/tiles/{z}/{x}/{y}.pbf)"
                    value={mvtUrl}
                    onChange={(e) => setMvtUrl(e.target.value)}
                    className="settings-input"
                  />
                </>
              ) : vectorSourceType === 'wfs' ? (
                <>
                  <input
                    type="text"
                    placeholder="Layer name"
                    value={mvtLayerName}
                    onChange={(e) => setMvtLayerName(e.target.value)}
                    className="settings-input"
                  />
                  <input
                    type="text"
                    placeholder="WFS URL (e.g., https://example.com/geoserver/wfs)"
                    value={mvtUrl}
                    onChange={(e) => {
                      const val = e.target.value;
                      setMvtUrl(val);
                      // Editing the URL invalidates any previously fetched types
                      if (val.trim() !== wfsTypesForUrl) {
                        setWfsTypeOptions([]);
                        setWfsTypesForUrl('');
                        setWfsTypesError('');
                        setWfsTypeName('');
                      }
                    }}
                    className="settings-input"
                  />
                  <CustomSelect
                    value={wfsTypeName}
                    onChange={(val) => {
                      setWfsTypeName(val);
                      // Auto-fill the layer name from the chosen type's title
                      const t = wfsTypeOptions.find(o => o.name === val);
                      if (t && !mvtLayerName.trim()) setMvtLayerName(t.title);
                    }}
                    disabled={!mvtUrl.trim() || wfsTypesLoading}
                    onOpen={() => fetchWfsFeatureTypes(mvtUrl)}
                    filterable
                    className="settings-select"
                    placeholder={
                      !mvtUrl.trim()
                        ? 'Enter a WFS URL first'
                        : wfsTypesLoading
                        ? 'Reading feature types…'
                        : 'Select a feature type'
                    }
                    options={wfsTypeOptions.map(t => ({
                      value: t.name,
                      label: t.title !== t.name ? t.title + ' (' + t.name + ')' : t.name,
                    }))}
                  />
                  {wfsTypesLoading && (
                    <div className="settings-loading-indicator">
                      <div className="settings-loading-spinner"></div>
                      <span>Reading feature types from service...</span>
                    </div>
                  )}
                  {wfsTypesError && !wfsTypesLoading && (
                    <div className="settings-error-message">{wfsTypesError}</div>
                  )}
                </>
              ) : vectorSourceType === 'stac' ? (
                <>
                  <input
                    type="text"
                    placeholder="Layer name"
                    value={mvtLayerName}
                    onChange={(e) => setMvtLayerName(e.target.value)}
                    className="settings-input"
                  />
                  <input
                    type="text"
                    placeholder="STAC API URL (e.g., https://earth-search.aws.element84.com/v1)"
                    value={mvtUrl}
                    onChange={(e) => {
                      const val = e.target.value;
                      setMvtUrl(val);
                      // Editing the URL invalidates any previously fetched collections
                      if (val.trim().replace(/\/+$/, '') !== stacCollectionsForUrl) {
                        setStacCollectionOptions([]);
                        setStacCollectionsForUrl('');
                        setStacCollectionsError('');
                        setStacCollection('');
                      }
                    }}
                    className="settings-input"
                  />
                  <CustomSelect
                    value={stacCollection}
                    onChange={(val) => {
                      setStacCollection(val);
                      // Auto-fill the layer name from the chosen collection's title
                      const c = stacCollectionOptions.find(o => o.id === val);
                      if (c && !mvtLayerName.trim()) setMvtLayerName(c.title);
                    }}
                    disabled={!mvtUrl.trim() || stacCollectionsLoading}
                    onOpen={() => fetchStacCollections(mvtUrl)}
                    filterable
                    className="settings-select"
                    placeholder={
                      !mvtUrl.trim()
                        ? 'Enter a STAC API URL first'
                        : stacCollectionsLoading
                        ? 'Loading collections\u2026'
                        : 'Select a collection'
                    }
                    options={stacCollectionOptions.map(c => ({
                      value: c.id,
                      label: c.title !== c.id ? c.title + ' (' + c.id + ')' : c.id,
                    }))}
                  />
                  {stacCollectionsLoading && (
                    <div className="settings-loading-indicator">
                      <div className="settings-loading-spinner"></div>
                      <span>Loading collections from STAC API...</span>
                    </div>
                  )}
                  {stacCollectionsError && !stacCollectionsLoading && (
                    <div className="settings-error-message">{stacCollectionsError}</div>
                  )}
                  <input
                    type="number"
                    min="1"
                    placeholder="Item limit (blank = fetch all)"
                    value={stacLimit}
                    onChange={(e) => setStacLimit(e.target.value)}
                    className="settings-input"
                  />
                </>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="Layer name (optional)"
                    value={mvtLayerName}
                    onChange={(e) => setMvtLayerName(e.target.value)}
                    className="settings-input"
                  />
                  <CustomSelect
                    value={selectedVectorSourceId}
                    onChange={(val) => {
                      const src = knownSources.find(s => s.id === val);
                      // STAC sources only store a URL: jump into the STAC form so the
                      // collection can be picked from the live dropdown.
                      if (src && src.type === 'stac') {
                        setVectorSourceType('stac');
                        setMvtUrl(src.url);
                        if (!mvtLayerName.trim()) setMvtLayerName(src.name);
                        setStacCollection('');
                        setSelectedVectorSourceId('');
                        fetchStacCollections(src.url);
                        return;
                      }
                      setSelectedVectorSourceId(val);
                      // Auto-fill name from source if name field is empty
                      if (src && !mvtLayerName.trim()) {
                        setMvtLayerName(src.name);
                      }
                    }}
                    className="settings-select"
                    options={[
                      { value: '', label: 'Select a saved vector source...', disabled: true },
                      ...knownSources.filter(s => s.type === 'vtile' || s.type === 'wfs' || s.type === 'stac').map(s => ({
                        value: s.id,
                        label: s.name + ' [' + s.type.toUpperCase() + '] (' + s.url.substring(0, 40) + (s.url.length > 40 ? '...' : '') + ')',
                      })),
                    ]}
                  />
                </>
              )}
              <div className="settings-form-buttons">
                {(vectorSourceType === 'mvt' || vectorSourceType === 'wfs' || vectorSourceType === 'stac' || vectorSourceType === 'known') && (
                  <button 
                    className="settings-button-primary" 
                    onClick={() => {
                      if (vectorSourceType === 'known') {
                        const src = knownSources.find(s => s.id === selectedVectorSourceId);
                        if (src) {
                          const layerName = mvtLayerName.trim() || src.name;
                          if (src.type === 'wfs') {
                            onAddWFSLayer(src.url, src.wfsTypeName || '', layerName);
                          } else if (src.type === 'stac') {
                            onAddSTACLayer(src.url, src.stacCollection || '', layerName, src.stacLimit);
                          } else {
                            onAddMVTLayer(src.url, layerName);
                          }
                          setMvtUrl('');
                          setMvtLayerName('');
                          setSelectedVectorSourceId('');
                          setShowAddVectorForm(false);
                        }
                      } else if (vectorSourceType === 'wfs') {
                        if (mvtLayerName.trim() && mvtUrl.trim() && wfsTypeName.trim()) {
                          onAddWFSLayer(mvtUrl.trim(), wfsTypeName.trim(), mvtLayerName.trim());
                          setMvtUrl('');
                          setMvtLayerName('');
                          setWfsTypeName('');
                          setWfsTypeOptions([]);
                          setWfsTypesForUrl('');
                          setWfsTypesError('');
                          setShowAddVectorForm(false);
                        }
                      } else if (vectorSourceType === 'stac') {
                        if (mvtLayerName.trim() && mvtUrl.trim() && stacCollection.trim()) {
                          const parsedLimit = stacLimit.trim() ? parseInt(stacLimit.trim(), 10) : undefined;
                          onAddSTACLayer(mvtUrl.trim(), stacCollection.trim(), mvtLayerName.trim(), parsedLimit && parsedLimit > 0 ? parsedLimit : undefined);
                          setMvtUrl('');
                          setMvtLayerName('');
                          setStacCollection('');
                          setStacCollectionOptions([]);
                          setStacCollectionsForUrl('');
                          setStacCollectionsError('');
                          setStacLimit('');
                          setShowAddVectorForm(false);
                        }
                      } else {
                        if (mvtLayerName.trim() && mvtUrl.trim()) {
                          onAddMVTLayer(mvtUrl.trim(), mvtLayerName.trim());
                          setMvtUrl('');
                          setMvtLayerName('');
                          setShowAddVectorForm(false);
                        }
                      }
                    }}
                    disabled={
                      (vectorSourceType === 'known' && !selectedVectorSourceId) ||
                      (vectorSourceType === 'wfs' && !(mvtLayerName.trim() && mvtUrl.trim() && wfsTypeName.trim())) ||
                      (vectorSourceType === 'stac' && !(mvtLayerName.trim() && mvtUrl.trim() && stacCollection.trim()))
                    }
                  >
                    Add
                  </button>
                )}
                <button 
                  className="settings-button-secondary" 
                  onClick={() => {
                    setShowAddVectorForm(false);
                    setSelectedVectorSourceId('');
                    setFileLayerName('');
                    setMvtUrl('');
                    setMvtLayerName('');
                    setWfsTypeName('');
                    setStacCollection('');
                    setStacCollectionOptions([]);
                    setStacCollectionsForUrl('');
                    setStacCollectionsError('');
                    setStacLimit('');
                    setWfsTypeOptions([]);
                    setWfsTypesForUrl('');
                    setWfsTypesError('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="settings-dialog-footer">
        <div className="settings-footer-left">
          <button
            ref={lockButtonRef}
            className="settings-lock-button"
            onClick={() => { closeLockMenu(); onLockApp(); }}
            onContextMenu={openLockMenu}
            title="Lock app — encrypts your saved data behind a password. Right-click for password options."
            aria-label="Lock app"
          >
            <LockIcon />
          </button>
          {lockMenuPos && createPortal(
            <div
              ref={lockMenuRef}
              className="lock-context-menu"
              role="menu"
              aria-label="Lock password options"
              style={{ position: 'fixed', left: lockMenuPos.left, bottom: lockMenuPos.bottom }}
            >
              {hasLockPassword ? (
                <button
                  type="button"
                  className="lock-context-menu-item"
                  role="menuitem"
                  onClick={handleLockMenuReset}
                >
                  <span className="lock-context-menu-item-icon"><ResetKeyIcon /></span>
                  <span className="lock-context-menu-item-label">Reset Password</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="lock-context-menu-item"
                  role="menuitem"
                  onClick={handleLockMenuSet}
                >
                  <span className="lock-context-menu-item-icon"><KeyIcon /></span>
                  <span className="lock-context-menu-item-label">Set Password</span>
                </button>
              )}
            </div>,
            document.body
          )}
          <WorkspaceSelector
            workspaceId={workspaceId}
            workspaces={workspaces}
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onRename={onRenameWorkspace}
            onDuplicate={onDuplicateWorkspace}
            onDelete={onDeleteWorkspace}
          />
        </div>
        <span className="settings-advanced-link" onClick={onAdvancedSettings}>Advanced Settings</span>
      </div>
    </div>
  );
}

