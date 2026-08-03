import View from 'ol/View.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { LayerGroup, SplitViewPrefs, StoredSettings, WorkspaceRegistry, WorkspaceMeta } from '../types';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_BASEMAP_URL,
  STORAGE_KEY,
  VIEW_STORAGE_KEY,
  WORKSPACES_KEY,
  DRAW_STORAGE_KEY,
  WORKSPACE_QUERY_PARAM,
  SPLIT_SCREEN_QUERY_PARAM,
  SPLIT_WORKSPACES_QUERY_PARAM,
  SPLIT_DIVIDER_KEY,
  SPLIT_MIN_PCT,
  SPLIT_MAX_PCT,
  SPLIT_DEFAULT_PCT,
  SPLIT_BASEMAP_QUERY_PARAM,
  SPLIT_GRID_QUERY_PARAM,
  SPLIT_SHOW_COORD_QUERY_PARAM,
} from '../constants';
import { FILE_VECTOR_TYPES } from '../types';
import { idbPut, idbDeleteWorkspace, idbCopyWorkspace } from './idb';

export { DEFAULT_WORKSPACE_ID };

export function settingsKeyFor(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? STORAGE_KEY : `${STORAGE_KEY}:${workspaceId}`;
}

export function viewKeyFor(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? VIEW_STORAGE_KEY : `${VIEW_STORAGE_KEY}:${workspaceId}`;
}

export function drawKeyFor(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? DRAW_STORAGE_KEY : `${DRAW_STORAGE_KEY}:${workspaceId}`;
}

export function generateWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadWorkspaceRegistry(): WorkspaceRegistry {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const workspaces: WorkspaceMeta[] = Array.isArray(parsed?.workspaces)
        ? parsed.workspaces.filter((w: any) => w && typeof w.id === 'string' && typeof w.name === 'string' && w.name.trim())
        : [];
      if (workspaces.length > 0) {
        const activeId = workspaces.some(w => w.id === parsed.activeId) ? parsed.activeId : workspaces[0].id;
        return { workspaces, activeId };
      }
    }
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to load workspace registry:', e);
  }
  return { workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default' }], activeId: DEFAULT_WORKSPACE_ID };
}

export function saveWorkspaceRegistry(registry: WorkspaceRegistry) {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(registry));
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to save workspace registry:', e);
  }
}

/** Honour a ?ws=<id> deep link: when the URL names an existing workspace,
 * that workspace becomes the active one. Unknown or missing ids leave the
 * persisted active workspace untouched. */
export function resolveActiveWorkspaceFromUrl(registry: WorkspaceRegistry): WorkspaceRegistry {
  try {
    const urlId = new URLSearchParams(window.location.search).get(WORKSPACE_QUERY_PARAM);
    if (urlId && urlId !== registry.activeId && registry.workspaces.some(w => w.id === urlId)) {
      return { ...registry, activeId: urlId };
    }
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to read workspace id from URL:', e);
  }
  return registry;
}

/** Load the registry and apply any ?ws=<id> deep link, persisting the choice
 * so a later reload without the param stays on the same workspace. */
export function loadWorkspaceRegistryFromUrl(): WorkspaceRegistry {
  const stored = loadWorkspaceRegistry();
  const resolved = resolveActiveWorkspaceFromUrl(stored);
  if (resolved !== stored) saveWorkspaceRegistry(resolved);
  return resolved;
}

/** Point the URL at the given workspace. The lat/lng/z view params are
 * stripped so the incoming workspace restores its own saved view instead of
 * inheriting the outgoing one from the URL. */
export function setWorkspaceUrlParam(workspaceId: string) {
  try {
    const params = new URLSearchParams();
    params.set(WORKSPACE_QUERY_PARAM, workspaceId);
    window.history.replaceState(null, '', '?' + params.toString());
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to update workspace URL param:', e);
  }
}

/** Parse ?split-screen=true&workspaces=a,b into a raw pane intent. The ids
 * may be unknown to the registry; resolving them is a separate step. */
export function parseSplitScreenFromUrl(): { left: string | null; right: string | null } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(SPLIT_SCREEN_QUERY_PARAM) !== 'true') return null;
    const ids = (params.get(SPLIT_WORKSPACES_QUERY_PARAM) || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return { left: ids[0] || null, right: ids[1] || null };
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to parse split-screen URL params:', e);
    return null;
  }
}

/** Defaults for the split-view-only basic settings: basemap and the
 * coordinate readout on, grid off. */
export const SPLIT_PREFS_DEFAULTS: SplitViewPrefs = { basemap: true, grid: false, showCoords: true };

/** Parse the split-view basic settings (?basemap=&grid=&show_coord=).
 * Missing params fall back to the defaults. */
export function parseSplitPrefsFromUrl(): SplitViewPrefs {
  try {
    const params = new URLSearchParams(window.location.search);
    const readBool = (key: string, fallback: boolean) => {
      const v = params.get(key);
      if (v === 'true') return true;
      if (v === 'false') return false;
      return fallback;
    };
    return {
      basemap: readBool(SPLIT_BASEMAP_QUERY_PARAM, SPLIT_PREFS_DEFAULTS.basemap),
      grid: readBool(SPLIT_GRID_QUERY_PARAM, SPLIT_PREFS_DEFAULTS.grid),
      showCoords: readBool(SPLIT_SHOW_COORD_QUERY_PARAM, SPLIT_PREFS_DEFAULTS.showCoords),
    };
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to parse split prefs from URL:', e);
    return SPLIT_PREFS_DEFAULTS;
  }
}

/** Write the split-screen state into the URL so a refresh restores it —
 * workspaces AND the split-view-only basic settings. */
export function setSplitScreenUrlParams(leftId: string, rightId: string, prefs: SplitViewPrefs = SPLIT_PREFS_DEFAULTS) {
  try {
    const params = new URLSearchParams();
    params.set(SPLIT_SCREEN_QUERY_PARAM, 'true');
    params.set(SPLIT_WORKSPACES_QUERY_PARAM, `${leftId},${rightId}`);
    params.set(SPLIT_BASEMAP_QUERY_PARAM, String(prefs.basemap));
    params.set(SPLIT_GRID_QUERY_PARAM, String(prefs.grid));
    params.set(SPLIT_SHOW_COORD_QUERY_PARAM, String(prefs.showCoords));
    window.history.replaceState(null, '', '?' + params.toString());
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to update split-screen URL params:', e);
  }
}

/** A unique "Workspace N" name for auto-created comparison workspaces. */
export function nextWorkspaceName(workspaces: WorkspaceMeta[]): string {
  const taken = new Set(workspaces.map(w => w.name));
  let n = workspaces.length + 1;
  let name = `Workspace ${n}`;
  while (taken.has(name)) name = `Workspace ${++n}`;
  return name;
}

/**
 * Resolve a split-screen deep link against the registry. Pure with respect
 * to storage: returns a (possibly extended) registry plus the resolved pane
 * assignment; the caller persists the registry when it changed. Unknown ids
 * fall back to existing workspaces, and when there is only one workspace a
 * fresh comparison workspace is created so split screen always has two
 * distinct sides.
 */
export function resolveSplitScreenFromUrl(registry: WorkspaceRegistry): {
  registry: WorkspaceRegistry;
  split: { left: string; right: string } | null;
} {
  const intent = parseSplitScreenFromUrl();
  if (!intent) return { registry, split: null };

  const workspaces = [...registry.workspaces];
  const pick = (requested: string | null, fallback: string | null, exclude: string | null): string => {
    if (requested && workspaces.some(w => w.id === requested)) return requested;
    if (fallback && fallback !== exclude && workspaces.some(w => w.id === fallback)) return fallback;
    const candidate = workspaces.find(w => w.id !== exclude);
    if (candidate) return candidate.id;
    // Only one workspace exists: create the comparison workspace on the fly.
    const created = { id: generateWorkspaceId(), name: nextWorkspaceName(workspaces) };
    workspaces.push(created);
    return created.id;
  };

  const left = pick(intent.left, registry.activeId, null);
  const right = pick(intent.right, null, left);

  // The left pane is the "primary" workspace: keep the persisted active id
  // in step so a later plain load (no split params) opens the same place.
  const nextRegistry =
    workspaces.length !== registry.workspaces.length || registry.activeId !== left
      ? { workspaces, activeId: left }
      : registry;
  return { registry: nextRegistry, split: { left, right } };
}

/** Load the persisted divider position (left pane percentage). */
export function loadSplitDivider(): number {
  try {
    const pct = parseFloat(localStorage.getItem(SPLIT_DIVIDER_KEY) || '');
    if (!isNaN(pct)) return Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct));
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to load split divider:', e);
  }
  return SPLIT_DEFAULT_PCT;
}

/** Persist the divider position (left pane percentage). */
export function saveSplitDivider(pct: number) {
  try {
    localStorage.setItem(SPLIT_DIVIDER_KEY, String(pct));
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to save split divider:', e);
  }
}

/** Remove a workspace's persisted settings and view (never the registry). */
export function deleteWorkspaceStorage(workspaceId: string) {
  try {
    localStorage.removeItem(settingsKeyFor(workspaceId));
    localStorage.removeItem(viewKeyFor(workspaceId));
    localStorage.removeItem(drawKeyFor(workspaceId));
    void idbDeleteWorkspace(workspaceId);
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to delete workspace storage:', e);
  }
}

/** Copy one workspace's persisted settings and view into another ("Duplicate"). */
export function copyWorkspaceStorage(sourceId: string, targetId: string) {
  try {
    const settings = localStorage.getItem(settingsKeyFor(sourceId));
    if (settings) {
      // Repoint any IDB-backed file-layer geometry from the source workspace's
      // keys to the target's, then copy the blobs themselves.
      try {
        const parsed = JSON.parse(settings);
        const srcPrefix = `file:${sourceId}:`;
        if (Array.isArray(parsed.vectorLayers)) {
          parsed.vectorLayers.forEach((l: any) => {
            if (typeof l.geometryIdbKey === 'string' && l.geometryIdbKey.startsWith(srcPrefix)) {
              l.geometryIdbKey = `file:${targetId}:${l.geometryIdbKey.slice(srcPrefix.length)}`;
            }
          });
        }
        localStorage.setItem(settingsKeyFor(targetId), JSON.stringify(parsed));
      } catch {
        localStorage.setItem(settingsKeyFor(targetId), settings);
      }
    }
    const view = localStorage.getItem(viewKeyFor(sourceId));
    if (view) localStorage.setItem(viewKeyFor(targetId), view);
    const draw = localStorage.getItem(drawKeyFor(sourceId));
    if (draw) localStorage.setItem(drawKeyFor(targetId), draw);
    void idbCopyWorkspace(sourceId, targetId);
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to copy workspace storage:', e);
  }
}

/** Parse a persisted layer-group list, tolerating missing or legacy data. */
export function sanitizeGroups(raw: any): LayerGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g: any) => g && typeof g.id === 'string' && typeof g.name === 'string')
    .map((g: any) => ({
      id: g.id,
      name: g.name,
      expanded: g.expanded !== false,
      afterId: typeof g.afterId === 'string' ? g.afterId : g.afterId === null ? null : undefined,
    }));
}

export function loadSettings(workspaceId: string = DEFAULT_WORKSPACE_ID): StoredSettings {
  try {
    const raw = localStorage.getItem(settingsKeyFor(workspaceId));
    if (raw) {
      const parsed = JSON.parse(raw);
      // Filter out raster layers with blob fields (file-based sources can't persist)
      const validRasterLayers = Array.isArray(parsed.rasterLayers) 
        ? parsed.rasterLayers.filter((layer: any) => !layer.blob)
        : [];
      
      // Keep MVT layers and drawn-in-app layers (both can be persisted)
      const validVectorLayers = Array.isArray(parsed.vectorLayers)
        ? parsed.vectorLayers.filter((layer: any) => layer.type === 'mvt' || layer.type === 'wfs' || layer.type === 'stac' || layer.isDrawnInApp || (typeof layer.drawnGeoJson === 'string' && layer.drawnGeoJson) || (typeof layer.geometryIdbKey === 'string' && layer.geometryIdbKey))
        : [];

      // Layer groups (folders): restore them and drop any group reference on
      // a layer whose group no longer exists, so stale ids never render a
      // phantom folder.
      const rasterGroups = sanitizeGroups(parsed.rasterGroups);
      const vectorGroups = sanitizeGroups(parsed.vectorGroups);
      validRasterLayers.forEach((layer: any) => {
        if (layer.groupId && !rasterGroups.some(g => g.id === layer.groupId)) delete layer.groupId;
      });
      validVectorLayers.forEach((layer: any) => {
        if (layer.groupId && !vectorGroups.some(g => g.id === layer.groupId)) delete layer.groupId;
      });
      
      return {
        settingsPinned: !!parsed.settingsPinned,
        showBasemap: parsed.showBasemap !== false,
        basemapUrl:
          typeof parsed.basemapUrl === 'string' && parsed.basemapUrl.trim()
            ? parsed.basemapUrl
            : DEFAULT_BASEMAP_URL,
        basemapMinZoom: typeof parsed.basemapMinZoom === 'number' ? parsed.basemapMinZoom : undefined,
        basemapMaxZoom: typeof parsed.basemapMaxZoom === 'number' ? parsed.basemapMaxZoom : undefined,
        units: parsed.units === 'imperial' ? 'imperial' : 'metric',
        showGrid: !!parsed.showGrid,
        showDrawToolbar: parsed.showDrawToolbar !== false,
        showCoordinates: parsed.showCoordinates !== false,
        rasterLayers: validRasterLayers,
        rasterGroups,
        vectorLayers: validVectorLayers,
        vectorGroups,
      };
    }
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to load settings from localStorage:', e);
  }
  return { settingsPinned: false, showBasemap: true, basemapUrl: DEFAULT_BASEMAP_URL, units: 'metric', showGrid: false, showDrawToolbar: true, showCoordinates: true, rasterLayers: [], rasterGroups: [], vectorLayers: [], vectorGroups: [] };
}

export function saveSettings(settings: StoredSettings, workspaceId: string = DEFAULT_WORKSPACE_ID) {
  try {
    // Remove olLayer and blob references before saving (they can't be serialized)
    const serializableSettings = {
      ...settings,
      rasterLayers: settings.rasterLayers
        .filter(layer => !(layer as any).blob && layer.cogSource !== 'file') // Don't save file-based layers or session-only file COGs
        .map(({ olLayer, ...rest }) => rest),
      vectorLayers: settings.vectorLayers
        .filter(layer => layer.type === 'mvt' || layer.type === 'wfs' || layer.type === 'stac' || layer.isDrawnInApp || FILE_VECTOR_TYPES.includes(layer.type)) // MVT + WFS + STAC + drawn-in-app + uploaded file layers
        .map((layer) => {
          const { olLayer, ...rest } = layer;
          // Serialize drawn-in-app features (geometry + per-feature style) so they survive a reload
          if (layer.isDrawnInApp && olLayer && olLayer.getSource) {
            // Serialize the real features, not the generated cluster bubbles -
            // look through the Cluster wrapper when clustering is active.
            const serSource = olLayer._rawSource || olLayer.getSource();
            // When an attribute filter is active the live source only holds
            // the matching features - persist the full stashed dataset instead
            // so filtering never destroys data.
            const feats = olLayer._filterMaster || serSource.getFeatures();
            if (feats && feats.length > 0) {
              try {
                const geojsonFormat = new GeoJSON();
                const drawnGeoJson = geojsonFormat.writeFeatures(feats, {
                  dataProjection: 'EPSG:4326',
                  featureProjection: 'EPSG:3857',
                });
                const drawnFeatureMeta = feats.map((f: any) => ({ style: f._drawStyle, name: f._drawName }));
                return { ...rest, drawnGeoJson, drawnFeatureMeta };
              } catch (e) {
                console.error('[WorkspaceStorage] Failed to serialize drawn layer:', e);
              }
            }
          } else if (FILE_VECTOR_TYPES.includes(layer.type) && olLayer && olLayer.getSource) {
            // Serialize uploaded file layers (geojson/kml/kmz/shapefile) so they
            // survive a workspace switch / reload. Look through the Cluster wrapper
            // when clustering is active to reach the real features. The geometry can
            // be huge (a KMZ may unpack to tens of MB), so it goes to IndexedDB and
            // only a small marker key is kept in localStorage; environments without
            // IDB (jsdom) fall back to inline storage.
            const serSource = olLayer._rawSource || olLayer.getSource();
            // With an attribute filter active, save the full stashed dataset
            // rather than just the visible (matching) features.
            const feats = olLayer._filterMaster || serSource.getFeatures();
            if (feats && feats.length > 0) {
              try {
                const geojsonFormat = new GeoJSON();
                const geojson = geojsonFormat.writeFeatures(feats, {
                  dataProjection: 'EPSG:4326',
                  featureProjection: 'EPSG:3857',
                });
                if (typeof indexedDB !== 'undefined') {
                  const geometryIdbKey = `file:${workspaceId}:${layer.id}`;
                  void idbPut(geometryIdbKey, geojson); // fire-and-forget; the effect save runs well before any switch
                  return { ...rest, geometryIdbKey };
                }
                return { ...rest, drawnGeoJson: geojson };
              } catch (e) {
                console.error('[WorkspaceStorage] Failed to serialize file layer:', e);
              }
            }
          }
          return rest;
        }),
    };
    localStorage.setItem(settingsKeyFor(workspaceId), JSON.stringify(serializableSettings));
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to save settings to localStorage:', e);
  }
}

export function getInitialView(workspaceId: string = DEFAULT_WORKSPACE_ID, allowUrlView = true) {
  // Split-screen panes pass allowUrlView=false: the shared URL carries the
  // split state there, so each pane restores its workspace's own saved view.
  if (allowUrlView) {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat') || '');
    const lng = parseFloat(params.get('lng') || '');
    const z = parseInt(params.get('z') || '', 10);

    if (!isNaN(lat) && !isNaN(lng) && !isNaN(z)) {
      return { center: fromLonLat([lng, lat]), zoom: z };
    }
  }

  // Fall back to localStorage
  try {
    const raw = localStorage.getItem(viewKeyFor(workspaceId));
    if (raw) {
      const parsed = JSON.parse(raw);
      const sLat = parseFloat(parsed.lat);
      const sLng = parseFloat(parsed.lng);
      const sZ = parseInt(parsed.z, 10);
      if (!isNaN(sLat) && !isNaN(sLng) && !isNaN(sZ)) {
        return { center: fromLonLat([sLng, sLat]), zoom: sZ };
      }
    }
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to load view from localStorage:', e);
  }

  return { center: [14960009, -3001695], zoom: 4 };
}

/** Persist one view (lat/lng in EPSG:4326 degrees, zoom) for a workspace. */
export function saveViewToStorage(workspaceId: string, lat: number, lng: number, z: number) {
  try {
    localStorage.setItem(viewKeyFor(workspaceId), JSON.stringify({
      lat: lat.toFixed(5),
      lng: lng.toFixed(5),
      z: String(z),
    }));
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to save view to localStorage:', e);
  }
}

/** Persist the current view without touching the URL — split-screen panes
 * each save their own view and must not fight over the shared address bar. */
export function saveView(view: View, workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || zoom === undefined) return;
  const [lng, lat] = toLonLat(center);
  saveViewToStorage(workspaceId, lat, lng, Math.round(zoom));
}

/** Reflect the active workspace and current view in the URL
 * (?ws=...&lat=...&lng=...&z=...) and persist the view for the next reload. */
export function updateUrlParams(view: View, workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || zoom === undefined) return;

  const [lng, lat] = toLonLat(center);
  const params = new URLSearchParams();
  params.set(WORKSPACE_QUERY_PARAM, workspaceId);
  params.set('lat', lat.toFixed(5));
  params.set('lng', lng.toFixed(5));
  params.set('z', Math.round(zoom).toString());

  window.history.replaceState(null, '', '?' + params.toString());

  // Save to localStorage so refresh restores the last view
  saveViewToStorage(workspaceId, lat, lng, Math.round(zoom));
}
