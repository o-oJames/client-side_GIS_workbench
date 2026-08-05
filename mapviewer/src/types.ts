// ---------------------------------------------------------------------------
// Shared type definitions extracted from App.tsx
// ---------------------------------------------------------------------------

export interface WmtsLayerInfo {
  identifier: string;
  title: string;
}

export interface WmsLayerInfo {
  name: string;
  title: string;
}

export interface KnownSource {
  id: string;
  name: string;
  type: 'wmts' | 'wms' | 'xyz' | 'vtile' | 'wfs' | 'stac';
  url: string;
  wfsTypeName?: string;    // Legacy: saved WFS sources used to store the feature type; now only used as a preselect hint when adding a layer
  stacCollection?: string; // STAC sources: collection id (empty/omitted = url is a direct STAC Item)
  stacLimit?: number;      // STAC sources: max items to fetch
}

export interface RasterLayer {
  id: string;
  name: string;
  type: 'xyz' | 'wmts' | 'wms' | 'cog';
  url: string;
  wmtsCapabilitiesUrl?: string;
  wmtsLayer?: string;
  wmsCapabilitiesUrl?: string;
  wmsLayer?: string;
  wmsFeatureInfoEnabled?: boolean; // WMS only: issue GetFeatureInfo on map click to inspect raster attributes
  olLayer?: any;
  visible?: boolean;
  extent?: number[]; // [minx, miny, maxx, maxy] in EPSG:3857
  brightness?: number;    // 0-200, default 100
  saturation?: number;    // 0-200, default 100
  contrast?: number;      // 0-200, default 100
  opacity?: number;       // 0-100, default 100
  minZoom?: number;       // XYZ only: min tile zoom to request (below this, min-zoom tiles are downscaled)
  maxZoom?: number;       // XYZ only: max tile zoom to request (above this, max-zoom tiles are upscaled)
  groupId?: string;       // id of the LayerGroup (folder) this layer belongs to, if any
  // ----- COG (Cloud Optimized GeoTIFF) specific fields -----
  cogSource?: 'file' | 'http' | 's3';  // how the COG is accessed
  cogFileName?: string;       // original file name (file source)
  cogBucket?: string;         // S3 bucket name
  cogObjectKey?: string;      // S3 object key
  cogRegion?: string;         // S3 region (default us-east-1)
  cogEndpoint?: string;       // custom S3-compatible endpoint (MinIO, R2, etc.)
  cogAccessKeyId?: string;    // AWS_ACCESS_KEY_ID
  cogSecretAccessKey?: string;// AWS_SECRET_ACCESS_KEY
  cogSessionToken?: string;   // AWS_SESSION_TOKEN (temporary credentials)
}

/**
 * A named folder for organising layers in the settings panel. Groups are
 * purely organisational - they have no map representation of their own.
 * A group's visibility toggle flips every member layer at once, and its
 * header expands/collapses to reveal or hide the member list.
 */
export interface LayerGroup {
  id: string;
  name: string;
  expanded: boolean; // whether member layers are listed under the group header
  // Where an EMPTY group sits in the panel (groups with members are placed
  // at their first member's position in the layer list). null = top of the
  // list, a layer/group id = right after that item, undefined = end.
  afterId?: string | null;
}

export type WmsFeatureInfoResult =
  | { features: Array<Record<string, any>> }
  | { text: string };

// ---------------------------------------------------------------------------
// Attribute-driven rendering ("smart mapping", ArcGIS Online style): a
// feature's colour / size is computed from one of its attribute values
// instead of every feature sharing one fixed layer style. The computed
// statistics (domain, class breaks, category assignments) are stored on the
// config so the legend stays stable across reloads and lazy feature loads.
// ---------------------------------------------------------------------------

export type AttrRenderMode = 'types' | 'color' | 'size';
export type AttrClassMethod = 'equal-interval' | 'quantile';

export interface AttributeRenderConfig {
  enabled: boolean;
  field?: string;              // attribute field driving the style
  mode: AttrRenderMode;        // 'types' = unique symbols, 'color' = classed ramp, 'size' = proportional size
  // Numeric modes ('color' / 'size'):
  method?: AttrClassMethod;    // classification for 'color' mode (default equal-interval)
  classes?: number;            // class count for 'color' mode (3-7, default 5)
  rampId?: string;             // colour ramp id for 'color' mode
  sizeMin?: number;            // px at domainMin for 'size' mode (default 4)
  sizeMax?: number;            // px at domainMax for 'size' mode (default 20)
  domainMin?: number;          // dataset stats captured when the field was picked
  domainMax?: number;
  classBreaks?: number[];      // class boundaries for 'color' mode (classes + 1 values)
  // Categorical mode ('types'):
  categories?: Array<{ value: string; colorIndex: number }>; // most-frequent values, in palette order
  distinctCount?: number;      // total distinct values seen when categories were built
  missingCount?: number;       // features with no usable value for the field
}

export interface VectorLayerConfig {
  id: string;
  name: string;
  type: 'geojson' | 'kml' | 'kmz' | 'shapefile' | 'mvt' | 'wfs' | 'stac';
  visible: boolean;
  olLayer?: any;
  url?: string;
  isDrawnInApp?: boolean;
  opacity?: number;      // 0-100, default 100
  lineColor?: string;    // stroke color rgba, e.g. 'rgba(66, 133, 244, 1)'
  lineWidth?: number;    // stroke width px, default 2
  fillColor?: string;    // fill color rgba, e.g. 'rgba(66, 133, 244, 0.3)'
  fontColor?: string;    // label text color rgba, default black
  fontSize?: number;     // label font size px, default 14
  drawnGeoJson?: string; // serialized features for drawn-in-app layers (persistence)
  drawnFeatureMeta?: Array<{ style?: DrawStyle; name?: string; showMeasurements?: boolean }>; // per-feature style/name/measurement-labels flag
  geometryIdbKey?: string; // file layers: key into IndexedDB holding the (bulky) serialized geometry
  minZoom?: number;      // MVT: min tile zoom to request; other types: min zoom at which the layer is visible
  maxZoom?: number;      // MVT: max tile zoom to request; other types: max zoom at which the layer is visible
  wfsTypeName?: string;   // WFS: feature type name (e.g., 'namespace:layername')
  stacCollection?: string; // STAC: collection ID (e.g., 'sentinel-2-l2a'); empty/omitted = url is a direct STAC Item
  stacLimit?: number;      // STAC: max number of items to fetch (undefined = all)
  groupId?: string;      // id of the LayerGroup (folder) this layer belongs to, if any
  clusterPoints?: boolean;  // cluster point features together at low zoom (dense point datasets)
  clusterDistance?: number; // clustering distance in pixels (default 40)
  filterEnabled?: boolean;   // attribute filter active: only matching features are shown
  filterExpression?: string; // the query expression, e.g. "capture_date" > '2024-01-01'
  attrRender?: AttributeRenderConfig | null; // attribute-driven rendering (smart mapping) config
}

export interface WorkspaceMeta {
  id: string;
  name: string;
}

export interface WorkspaceRegistry {
  workspaces: WorkspaceMeta[];
  activeId: string;
}

/** Split-screen comparison state: which workspace each pane displays. */
export interface SplitScreenState {
  left: string;
  right: string;
}

/** Split-view-only basic settings. Isolated from every workspace's own
 * settings — carried in the URL while split mode is active. */
export interface SplitViewPrefs {
  basemap: boolean;
  grid: boolean;
  showCoords: boolean;
}

export type UnitsSystem = 'metric' | 'imperial';

export interface StoredSettings {
  settingsPinned: boolean;
  showBasemap: boolean;
  basemapUrl: string;
  basemapMinZoom?: number;
  basemapMaxZoom?: number;
  units: UnitsSystem;
  showGrid: boolean;
  showDrawToolbar: boolean;
  showCoordinates: boolean;
  rasterLayers: RasterLayer[];
  rasterGroups: LayerGroup[];
  vectorLayers: VectorLayerConfig[];
  vectorGroups: LayerGroup[];
}

// Vector layers uploaded from a local file. Unlike remote layers (mvt/wfs/stac)
// their features live only in memory, so they're serialized to inline GeoJSON
// (drawnGeoJson) to survive a workspace switch / reload. Drawn-in-app layers
// also use 'geojson' but are distinguished by the isDrawnInApp flag.
export const FILE_VECTOR_TYPES: VectorLayerConfig['type'][] = ['geojson', 'kml', 'kmz', 'shapefile'];

export interface CustomSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface Rgba { r: number; g: number; b: number; a: number; }

// Style applied to in-progress drawn features (editable before saving to a layer).
export interface DrawStyle {
  opacity: number;
  lineColor: string;
  lineWidth: number;
  fillColor: string;
  fontColor: string;
  fontSize: number;
}

export const DEFAULT_DRAW_STYLE: DrawStyle = {
  opacity: 100,
  lineColor: 'rgba(255, 204, 51, 1)',
  lineWidth: 2,
  fillColor: 'rgba(255, 204, 51, 0.2)',
  fontColor: 'rgba(0, 0, 0, 1)',
  fontSize: 14,
};

// The DrawStyle fields — used to keep foreign config keys (name, olLayer,
// persisted GeoJSON…) out of features' stored per-feature styles.
export const DRAW_STYLE_KEYS: Array<keyof DrawStyle> = ['opacity', 'lineColor', 'lineWidth', 'fillColor', 'fontColor', 'fontSize'];

export interface VertexHit {
  feature: any;
  geom: any;
  indexPath: number[];
  coord: number[]; // original position — used to restore on Escape
}

export interface SegmentHit {
  feature: any;
  geom: any;
  index: number; // first vertex of the segment; the new one goes right after
  ringIndex: number; // -1 for lines
  coord: number[]; // nearest point on the segment, in map coordinates
}

export interface SessionSnapshotItem {
  id: string;
  type: 'LineString' | 'Polygon' | 'Point';
  name: string;
  customized: boolean;
  style: DrawStyle;
  labelText?: string;
  /** Magic-wand ("snap") metadata — present only on traced polygons. */
  snapClass?: string;
  snapIndex?: number;
  snapPrimary?: string;
  /** Explicit measurement-labels choice; undefined = vertex-count default. */
  showMeasurements?: boolean;
  geometry: any; // cloned OL geometry
}

export interface SessionSnapshot {
  items: SessionSnapshotItem[];
}

export type GoToMethod = 'zxy' | 'latlng' | 'address';

// Tools available on the draw toolbar: four classic draw tools that create
// new features, the AI 'wand' (SAM 2.1 "snap to object" tracing), plus
// 'modify', which re-edits the geometry of features that have already been
// drawn (drag vertices, insert on a segment, remove with Alt).
export type DrawToolId = 'line' | 'polygon' | 'rectangle' | 'wand' | 'label' | 'modify' | null;

// One row in the drawn-features panel: a serialisable descriptor plus a live
// reference to the OL feature it mirrors (the feature itself never persists).
export interface DrawnFeatureItem {
  id: string;
  type: 'LineString' | 'Polygon' | 'Point';
  name: string;
  feature: any;
  style: DrawStyle;
  customized: boolean;
}

// State for the in-app label dialog. `existingText` present means an existing
// label's text is being re-edited rather than a fresh label being named.
export interface LabelDialogState {
  pixel: [number, number];
  feature: any;
  featureId: string;
  existingText?: string;
  targetSource?: any;
  toLayer?: boolean;
}


// ---------------------------------------------------------------------------
// SettingsDialog props — named interface per AGENTS.md §14
// ---------------------------------------------------------------------------
export type VectorExportFormat = 'geojson' | 'kml' | 'shapefile' | 'kmz';

export interface SettingsDialogProps {
  onClose: () => void;
  /** Enter split-screen comparison — rendered as the split button in the
   * footer next to the lock button (normal mode only). Called with no
   * arguments on a plain click (active workspace + auto-picked second one);
   * the right-click picker passes the two chosen workspace ids. */
  onEnterSplitScreen?: (leftId?: string, rightId?: string) => void;
  /** Split-screen pane mode: the drawing toggle is greyed out & off, and the
   * workspace selector is integrated into the side tabs. */
  splitPaneMode?: boolean;
  /** Split-screen: one tab per side under the dialog header. Each tab
   * carries the workspace currently shown on its side so the integrated
   * workspace dropdown can mark the current entry and disable the other
   * side's workspace. */
  splitTabs?: Array<{ id: string; label: string; workspaceId: string }>;
  activeSplitTabId?: string;
  onSplitTabChange?: (id: string) => void;
  /** Split-screen: keep the dialog mounted but hidden (inactive tab), so
   * switching tabs never closes and reopens the panel. */
  splitHidden?: boolean;
  /** Split-screen: change the workspace shown on the given side, picked from
   * the dropdown integrated into that side's tab. */
  onSplitTabWorkspaceChange?: (tabId: string, workspaceId: string) => void;
  /** Split-screen footer action: exit split mode (replaces Advanced Settings). */
  onExitSplitMode?: () => void;
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
  onApplyVectorAttrRender: (layerId: string, config: AttributeRenderConfig | null) => void;
  onApplyVectorFeatureStyle: (layerId: string, feature: any, style: DrawStyle) => void;
  onToggleVectorFeatureMeasurements: (layerId: string, feature: any, visible: boolean) => void;
  onReorderRasterLayers: (layers: RasterLayer[]) => void;
  onReorderVectorLayers: (layers: VectorLayerConfig[]) => void;
  onAddVectorLayer: (file: File, layerName?: string) => Promise<void>;
  onAddMVTLayer: (url: string, name: string) => Promise<void>;
  onAddWFSLayer: (url: string, typeName: string, name: string) => Promise<void>;
  onAddSTACLayer: (url: string, collection: string, name: string, limit?: number) => Promise<void>;
  onExportVectorLayer: (layerId: string, format: VectorExportFormat) => void;
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
  hasLockPassword: boolean;
  onSetPassword: () => void;
  onResetPassword: () => void;
}
