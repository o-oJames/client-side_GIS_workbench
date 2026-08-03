// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
export const KNOWN_SOURCES_KEY = 'mapviewer-known-sources';
export const STORAGE_KEY = 'mapviewer-settings';
export const VIEW_STORAGE_KEY = 'mapviewer-view';
export const WORKSPACES_KEY = 'mapviewer-workspaces';
export const DRAW_STORAGE_KEY = 'mapviewer-draw';

// The URL query parameter that reflects (and deep-links to) the active
// workspace, e.g. /map?ws=ws-abc123&lat=...&lng=...&z=...
export const WORKSPACE_QUERY_PARAM = 'ws';

// ---------------------------------------------------------------------------
// Split-screen comparison (two workspaces side by side)
// ---------------------------------------------------------------------------
// URL params that carry the split state so a refresh restores it,
// e.g. /map?split-screen=true&workspaces=ws-abc,ws-xyz
export const SPLIT_SCREEN_QUERY_PARAM = 'split-screen';
export const SPLIT_WORKSPACES_QUERY_PARAM = 'workspaces';
// Divider position (left pane percentage) persisted across sessions. The
// 'mapviewer-' prefix means the app-lock vault encrypts it too.
export const SPLIT_DIVIDER_KEY = 'mapviewer-split-divider';
// Split-view-only basic settings carried in the URL (never used in normal mode)
export const SPLIT_BASEMAP_QUERY_PARAM = 'basemap';
export const SPLIT_GRID_QUERY_PARAM = 'grid';
export const SPLIT_SHOW_COORD_QUERY_PARAM = 'show_coord';
export const SPLIT_MIN_PCT = 15;
export const SPLIT_MAX_PCT = 85;
export const SPLIT_DEFAULT_PCT = 50;

// The workspace that owns the original (pre-workspaces) storage keys, so
// existing users keep their layers, basemap and settings after upgrading.
export const DEFAULT_WORKSPACE_ID = 'default';

// ---------------------------------------------------------------------------
// Basemap (background tile layer) configuration
// ---------------------------------------------------------------------------
export const DEFAULT_BASEMAP_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const BASEMAP_PRESETS: Array<{ name: string; url: string }> = [
  { name: 'OSM Standard', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  { name: 'Carto Light', url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png' },
  { name: 'Carto Dark', url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png' },
  { name: 'Esri Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' },
];

// ---------------------------------------------------------------------------
// Measurement label styling
// ---------------------------------------------------------------------------
export const MEASURE_FONT = '600 11px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
export const MEASURE_FONT_AREA = '600 12px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
export const MEASURE_TEXT_COLOR = '#263238';
export const MEASURE_CHIP_BG = 'rgba(255, 255, 255, 0.92)';

// ---------------------------------------------------------------------------
// Undo/redo history
// ---------------------------------------------------------------------------
export const HISTORY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Tile zoom range control (min/max zoom for XYZ raster layers)
// ---------------------------------------------------------------------------
export const TILE_ZOOM_MIN = 0;
export const TILE_ZOOM_MAX = 25; // matches the map view's maxZoom

// ---------------------------------------------------------------------------
// Checkerboard backdrop used to visualize transparency
// ---------------------------------------------------------------------------
export const CHECKERBOARD =
  'linear-gradient(45deg, #cfd6df 25%, transparent 25%, transparent 75%, #cfd6df 75%), ' +
  'linear-gradient(45deg, #cfd6df 25%, transparent 25%, transparent 75%, #cfd6df 75%)';

// ---------------------------------------------------------------------------
// Unique ID generation for layers and features
// ---------------------------------------------------------------------------
/** Generate a unique layer/feature ID (timestamp + random suffix). */
export function generateId(suffixLength = 9): string {
  return Date.now().toString() + '_' + Math.random().toString(36).substr(2, suffixLength);
}
