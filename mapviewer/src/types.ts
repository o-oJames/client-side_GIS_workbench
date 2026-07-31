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
  type: 'xyz' | 'wmts' | 'wms';
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
  drawnFeatureMeta?: Array<{ style?: DrawStyle; name?: string }>; // per-feature style/name
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
}

export interface WorkspaceMeta {
  id: string;
  name: string;
}

export interface WorkspaceRegistry {
  workspaces: WorkspaceMeta[];
  activeId: string;
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
  geometry: any; // cloned OL geometry
}

export interface SessionSnapshot {
  items: SessionSnapshotItem[];
}

export type GoToMethod = 'zxy' | 'latlng' | 'address';

// Tools available on the draw toolbar: four draw tools that create new
// features, plus 'modify', which re-edits the geometry of features that have
// already been drawn (drag vertices, insert on a segment, remove with Alt).
export type DrawToolId = 'line' | 'polygon' | 'rectangle' | 'label' | 'modify' | null;
