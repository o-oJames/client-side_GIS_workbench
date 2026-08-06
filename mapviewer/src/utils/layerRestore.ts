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
