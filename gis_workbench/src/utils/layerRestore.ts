/**
 * Vector layer restore utilities.
 *
 * Consolidates the per-type vector layer restore logic that was inline in
 * MapPage's init effect. Pure OpenLayers + async logic — no React imports
 * (AGENTS.md §3).
 */
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import GeoJSON from 'ol/format/GeoJSON.js';

import type { VectorLayerConfig, UnitsSystem } from '../types';
import { DEFAULT_DRAW_STYLE, FILE_VECTOR_TYPES } from '../types';
import { buildVectorStyle, applyVectorClusteringToLayer } from './vectorStyleHelpers';
import {
  applyVectorLayerZoomRange,
  applyVectorFeatureFilter,
  buildWfsUrl,
  fetchAllStacItems,
} from './layerHelpers';
import { applyDrawFeatureStyle } from './drawHelpers';
import { idbGetWithRetry } from './idb';

// --- Common post-creation setup ---------------------------------------------

/**
 * Apply the standard post-creation steps shared by every vector layer type:
 * zoom range, clustering, and attribute filter.
 */
export function applyVectorPostSetup(
  olLayer: any,
  config: VectorLayerConfig,
  getUnits: () => UnitsSystem,
) {
  applyVectorLayerZoomRange(olLayer, config.type, config.minZoom, config.maxZoom);
  if (config.clusterPoints) {
    applyVectorClusteringToLayer(
      olLayer, true, config.clusterDistance,
      { ...config, opacity: config.opacity ?? 100 },
      getUnits,
    );
  }
  if (config.filterEnabled && config.filterExpression) {
    try { applyVectorFeatureFilter(olLayer, config.filterExpression); }
    catch (e) { console.warn('[LayerRestore] Failed to re-apply vector filter:', e); }
  }
}

/** Create a VectorLayer from a source + config, set opacity/visibility. */
function createVectorOlLayer(source: any, config: VectorLayerConfig): any {
  const olLayer = new VectorLayer({
    source,
    style: buildVectorStyle(config),
    visible: config.visible !== false,
  });
  olLayer.setOpacity((config.opacity ?? 100) / 100);
  return olLayer;
}

// --- Callbacks interface ----------------------------------------------------

export interface RestoreCallbacks {
  markVectorLoading: (id: string, loading: boolean) => void;
  wireVectorTileLoading: (source: any, id: string) => void;
  getUnits: () => UnitsSystem;
}

// --- Per-type restore functions ---------------------------------------------

/** Restore all MVT vector layers. */
export function restoreMvtLayers(
  map: any,
  configs: VectorLayerConfig[],
  layersRef: Map<string, any>,
  cb: RestoreCallbacks,
): VectorLayerConfig[] {
  const restored: VectorLayerConfig[] = [];
  configs.filter(l => l.type === 'mvt').forEach((config) => {
    try {
      const source = new VectorTileSource({ format: new MVT(), url: config.url || '' });
      const olLayer = new VectorTileLayer({
        source,
        style: buildVectorStyle(config),
        visible: config.visible !== false,
      });
      olLayer.setOpacity((config.opacity ?? 100) / 100);
      cb.wireVectorTileLoading(source, config.id);
      map.addLayer(olLayer);
      layersRef.set(config.id, olLayer);
      applyVectorLayerZoomRange(olLayer, 'mvt', config.minZoom, config.maxZoom);
      restored.push({ ...config, olLayer });
    } catch (error) {
      console.error('[LayerRestore] Failed to restore MVT layer:', error);
    }
  });
  return restored;
}

/** Restore all WFS vector layers. */
export function restoreWfsLayers(
  map: any,
  configs: VectorLayerConfig[],
  layersRef: Map<string, any>,
  cb: RestoreCallbacks,
): VectorLayerConfig[] {
  const restored: VectorLayerConfig[] = [];
  configs.filter(l => l.type === 'wfs').forEach((config) => {
    try {
      const wfsUrl = buildWfsUrl(config.url || '', config.wfsTypeName || '');
      const source = new VectorSource({
        format: new GeoJSON(),
        loader: () => {
          cb.markVectorLoading(config.id, true);
          fetch(wfsUrl)
            .then(r => r.json())
            .then(data => {
              source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
              cb.markVectorLoading(config.id, false);
            })
            .catch(e => {
              console.error('[LayerRestore] WFS restore error:', e);
              cb.markVectorLoading(config.id, false);
            });
        },
      });
      const olLayer = createVectorOlLayer(source, config);
      map.addLayer(olLayer);
      layersRef.set(config.id, olLayer);
      applyVectorPostSetup(olLayer, config, cb.getUnits);
      restored.push({ ...config, olLayer });
    } catch (error) {
      console.error('[LayerRestore] Failed to restore WFS layer:', error);
    }
  });
  return restored;
}

/** Restore all STAC vector layers. */
export function restoreStacLayers(
  map: any,
  configs: VectorLayerConfig[],
  layersRef: Map<string, any>,
  cb: RestoreCallbacks,
): VectorLayerConfig[] {
  const restored: VectorLayerConfig[] = [];
  configs.filter(l => l.type === 'stac').forEach((config) => {
    try {
      const source = new VectorSource({
        format: new GeoJSON(),
        loader: () => {
          cb.markVectorLoading(config.id, true);
          fetchAllStacItems(config.url || '', config.stacCollection || '', config.stacLimit)
            .then(data => {
              source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
              cb.markVectorLoading(config.id, false);
            })
            .catch(e => {
              console.error('[LayerRestore] STAC restore error:', e);
              cb.markVectorLoading(config.id, false);
            });
        },
      });
      const olLayer = createVectorOlLayer(source, config);
      map.addLayer(olLayer);
      layersRef.set(config.id, olLayer);
      applyVectorPostSetup(olLayer, config, cb.getUnits);
      restored.push({ ...config, olLayer });
    } catch (error) {
      console.error('[LayerRestore] Failed to restore STAC layer:', error);
    }
  });
  return restored;
}

/** Restore drawn-in-app vector layers. */
export function restoreDrawnLayers(
  map: any,
  configs: VectorLayerConfig[],
  layersRef: Map<string, any>,
  cb: RestoreCallbacks,
): VectorLayerConfig[] {
  const restored: VectorLayerConfig[] = [];
  configs.filter(l => l.isDrawnInApp && l.drawnGeoJson).forEach((config) => {
    try {
      const features = new GeoJSON().readFeatures(config.drawnGeoJson, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      features.forEach((f: any, i: number) => {
        const meta = config.drawnFeatureMeta?.[i];
        if (meta) {
          f._drawStyle = meta.style;
          f._drawName = meta.name;
          if (typeof meta.showMeasurements === 'boolean') f._showMeasurements = meta.showMeasurements;
          if (typeof meta.showNameLabel === 'boolean') f._showNameLabel = meta.showNameLabel;
          // Circle-tool features: keeps their single area chip (a 128-vertex
          // ring would otherwise fall under the vertex-count default).
          if (meta.circleMode !== undefined) f._circleMode = meta.circleMode;
          // Centre point dropped by the Circle tool: keeps its link to the
          // circle it belongs to (removing that circle removes the centre).
          if (meta.circleCenterOf !== undefined) f._circleCenterOf = meta.circleCenterOf;
        }
        const ds = f._drawStyle || DEFAULT_DRAW_STYLE;
        applyDrawFeatureStyle(f, ds, cb.getUnits);
      });
      const olLayer = createVectorOlLayer(new VectorSource({ features }), config);
      map.addLayer(olLayer);
      layersRef.set(config.id, olLayer);
      applyVectorPostSetup(olLayer, config, cb.getUnits);
      restored.push({ ...config, olLayer });
    } catch (error) {
      console.error('[LayerRestore] Failed to restore drawn layer:', error);
    }
  });
  return restored;
}

/** Restore uploaded file vector layers (geojson/kml/kmz/shapefile) from IDB or inline GeoJSON. */
export async function restoreFileLayers(
  map: any,
  configs: VectorLayerConfig[],
  layersRef: Map<string, any>,
  cb: RestoreCallbacks,
): Promise<VectorLayerConfig[]> {
  const restored: VectorLayerConfig[] = [];
  const fileLayers = configs.filter(
    l => !l.isDrawnInApp && FILE_VECTOR_TYPES.includes(l.type) && (l.geometryIdbKey || l.drawnGeoJson)
  );
  for (const config of fileLayers) {
    try {
      const geojson: string | undefined = config.geometryIdbKey
        ? await idbGetWithRetry(config.geometryIdbKey)
        : config.drawnGeoJson;
      if (!geojson) {
        console.warn('[LayerRestore] No persisted geometry found for file layer:', config.name);
        continue;
      }
      const features = new GeoJSON().readFeatures(geojson, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      const olLayer = createVectorOlLayer(new VectorSource({ features }), config);
      map.addLayer(olLayer);
      layersRef.set(config.id, olLayer);
      applyVectorPostSetup(olLayer, config, cb.getUnits);
      restored.push({ ...config, olLayer });
    } catch (error) {
      console.error('[LayerRestore] Failed to restore file layer:', error);
    }
  }
  return restored;
}

// --- Restore order ------------------------------------------------------------

/**
 * Reorder restored vector layers to match the persisted config order.
 *
 * The per-type restore buckets (MVT, WFS, STAC, drawn, file) each keep the
 * config order within their own type, but simply concatenating the buckets
 * re-stacks every layer of one type above every layer of another - silently
 * undoing user drag-reorders across types (e.g. a drawn layer dragged below
 * a file layer jumps back above it after a refresh or workspace switch, and
 * the reverted order then gets re-persisted). Sorting by the persisted
 * config order keeps exactly the stacking the user last committed.
 *
 * Layers that failed to restore are absent from `restored` and skipped;
 * restored layers missing from `persistedOrder` (defensive - cannot happen
 * in practice since restore only reads those configs) keep their relative
 * order at the end.
 */
export function sortRestoredVectorLayers(
  restored: VectorLayerConfig[],
  persistedOrder: VectorLayerConfig[],
): VectorLayerConfig[] {
  const byId = new Map<string, VectorLayerConfig>(restored.map(l => [l.id, l]));
  const sorted: VectorLayerConfig[] = [];
  persistedOrder.forEach(cfg => {
    const layer = byId.get(cfg.id);
    if (layer) {
      sorted.push(layer);
      byId.delete(cfg.id);
    }
  });
  restored.forEach(l => {
    if (byId.has(l.id)) sorted.push(l);
  });
  return sorted;
}

// --- PostGIS restore --------------------------------------------------------

/**
 * Restore all PostGIS vector layers.
 *
 * Each persisted PostGIS layer is re-created as an empty OL VectorLayer with
 * the saved style. We then attempt to discover the Workbench Companion; if it
 * is running, we fetch features for the current map extent and attach a
 * moveend listener for dynamic bbox reloading (same behaviour as the initial
 * add-layer flow in MapPage). If the connector is not reachable, the layer
 * is left empty and marked `postgisDisconnected: true` so the UI can show a
 * reconnect affordance.
 */
export async function restorePostgisLayers(
  map: any,
  configs: VectorLayerConfig[],
  layersRef: Map<string, any>,
  cb: RestoreCallbacks,
): Promise<VectorLayerConfig[]> {
  const restored: VectorLayerConfig[] = [];
  const postgisConfigs = configs.filter(l => l.type === 'postgis');
  if (postgisConfigs.length === 0) return restored;

  // Lazy import to avoid circular deps and keep this module testable
  const { findConnector, queryGeoJSON } = await import('./companion');
  const { transformExtent } = await import('ol/proj.js');
  const { unlistenByKey } = await import('ol/events.js');

  // Try to discover the connector once for all PostGIS layers
  let connectorUrl: string | null = null;
  try {
    connectorUrl = await findConnector();
  } catch {
    connectorUrl = null;
  }

  postgisConfigs.forEach((config) => {
    try {
      const source = new VectorSource({ format: new GeoJSON() });
      const olLayer = createVectorOlLayer(source, config);
      map.addLayer(olLayer);
      layersRef.set(config.id, olLayer);
      applyVectorPostSetup(olLayer, config, cb.getUnits);

      if (connectorUrl) {
        // Connector is available — fetch initial features and attach moveend
        const fetchAndPopulate = async () => {
          try {
            const mapExtent = map.getView().calculateExtent(map.getSize());
            const [minX, minY, maxX, maxY] = transformExtent(mapExtent, 'EPSG:3857', 'EPSG:4326');
            const bbox: [number, number, number, number] = [minX, minY, maxX, maxY];

            cb.markVectorLoading(config.id, true);
            const geojson = await queryGeoJSON(
              connectorUrl!,
              config.postgisConnectionId || '',
              config.postgisTable || '',
              config.postgisGeomColumn || 'geom',
              {
                filter: config.postgisFilter,
                bbox,
                srid: config.postgisSrid || 4326,
                limit: 10000,
              },
            );
            const format = new GeoJSON();
            const features = format.readFeatures(geojson, { featureProjection: 'EPSG:3857' });
            source.clear();
            source.addFeatures(features);
            cb.markVectorLoading(config.id, false);

            // Store metadata for dynamic reloading
            (olLayer as any).postgisMeta = {
              connectorUrl: connectorUrl!,
              connectionId: config.postgisConnectionId,
              table: config.postgisTable,
              geomColumn: config.postgisGeomColumn,
              filter: config.postgisFilter,
              srid: config.postgisSrid || 4326,
              format,
            };

            // Attach moveend listener for dynamic bbox reloading
            let moveEndDebounceTimer: any = null;
            const moveEndListener = () => {
              if (moveEndDebounceTimer) clearTimeout(moveEndDebounceTimer);
              moveEndDebounceTimer = setTimeout(async () => {
                if (!map) return;
                const meta = (olLayer as any).postgisMeta;
                if (!meta) return;
                try {
                  const newExtent = map.getView().calculateExtent(map.getSize());
                  const [nMinX, nMinY, nMaxX, nMaxY] = transformExtent(newExtent, 'EPSG:3857', 'EPSG:4326');
                  const newBbox: [number, number, number, number] = [nMinX, nMinY, nMaxX, nMaxY];
                  const newGeojson = await queryGeoJSON(
                    meta.connectorUrl,
                    meta.connectionId,
                    meta.table,
                    meta.geomColumn,
                    { filter: meta.filter, bbox: newBbox, srid: meta.srid, limit: 10000 },
                  );
                  const newFeatures = meta.format.readFeatures(newGeojson, { featureProjection: 'EPSG:3857' });
                  source.clear();
                  source.addFeatures(newFeatures);
                } catch (error) {
                  console.error('[LayerRestore] Failed to reload PostGIS features:', error);
                }
              }, 300);
            };
            const moveEndKey = map.on('moveend', moveEndListener);
            (olLayer as any).postgisCleanup = () => {
              if (moveEndDebounceTimer) clearTimeout(moveEndDebounceTimer);
              unlistenByKey(moveEndKey);
            };
          } catch (error) {
            console.error('[LayerRestore] Failed to fetch PostGIS features:', error);
            cb.markVectorLoading(config.id, false);
          }
        };
        void fetchAndPopulate();

        restored.push({ ...config, olLayer, postgisDisconnected: false });
      } else {
        // Connector not available — mark as disconnected
        restored.push({ ...config, olLayer, postgisDisconnected: true });
      }
    } catch (error) {
      console.error('[LayerRestore] Failed to restore PostGIS layer:', error);
    }
  });

  return restored;
}
