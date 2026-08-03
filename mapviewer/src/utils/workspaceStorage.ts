import View from 'ol/View.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { LayerGroup, StoredSettings, WorkspaceRegistry, WorkspaceMeta } from '../types';
import { DEFAULT_WORKSPACE_ID, DEFAULT_BASEMAP_URL, STORAGE_KEY, VIEW_STORAGE_KEY, WORKSPACES_KEY, DRAW_STORAGE_KEY } from '../constants';
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

export function getInitialView(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat') || '');
  const lng = parseFloat(params.get('lng') || '');
  const z = parseInt(params.get('z') || '', 10);

  if (!isNaN(lat) && !isNaN(lng) && !isNaN(z)) {
    return { center: fromLonLat([lng, lat]), zoom: z };
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

export function updateUrlParams(view: View, workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || zoom === undefined) return;

  const [lng, lat] = toLonLat(center);
  const params = new URLSearchParams();
  params.set('lat', lat.toFixed(5));
  params.set('lng', lng.toFixed(5));
  params.set('z', Math.round(zoom).toString());

  window.history.replaceState(null, '', '?' + params.toString());

  // Save to localStorage so refresh restores the last view
  try {
    localStorage.setItem(viewKeyFor(workspaceId), JSON.stringify({
      lat: lat.toFixed(5),
      lng: lng.toFixed(5),
      z: Math.round(zoom).toString(),
    }));
  } catch (e) {
    console.error('[WorkspaceStorage] Failed to save view to localStorage:', e);
  }
}
