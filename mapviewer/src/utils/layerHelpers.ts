import OLMap from 'ol/Map.js';
import Cluster from 'ol/source/Cluster.js';
import OSM from 'ol/source/OSM.js';
import TileDebug from 'ol/source/TileDebug.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import { VectorLayerConfig, RasterLayer, WmsFeatureInfoResult } from '../types';

export type { WmsFeatureInfoResult };

export function patchLayerRenderer(olLayer: any) {
  if (!olLayer || olLayer._rendererPatched) return;
  
  try {
    const renderer = olLayer.getRenderer?.();
    if (!renderer) return;
    
    olLayer._rendererPatched = true;
    
    const originalUseContainer = renderer.useContainer.bind(renderer);
    renderer.useContainer = function (target: any, transform: any, backgroundColor?: any) {
      // Determine if we must force a dedicated container.
      // Block reuse in two cases:
      //   1. This layer has a colour filter → must not share with any other layer
      //   2. The target container has a filter → must not inherit it
      const targetHasFilter = target && target.style && target.style.filter;
      const needsDedicatedContainer = !!this._colorFilter || !!targetHasFilter;

      if (needsDedicatedContainer) {
        this.containerReused = false;
        this.container = null;
        originalUseContainer(null, transform, backgroundColor);
      } else {
        originalUseContainer(target, transform, backgroundColor);
      }

      // Always explicitly set the filter on the container.
      // This handles:
      //   - Applying a filter to a new or reused container
      //   - Clearing a stale filter from a reused container
      if (this.container) {
        this.container.style.filter = this._colorFilter || '';
      }
    };
  } catch (e) {
    // Renderer may not be ready yet
  }
}

/**
 * Apply color adjustments (brightness, saturation, contrast, opacity) to an OpenLayers layer.
 * Uses CSS filters for brightness/saturation/contrast and setOpacity for transparency.
 *
 * OpenLayers' canvas renderer may reuse DOM containers between compatible consecutive
 * layers as a performance optimisation. When a container is shared, setting a CSS
 * filter on it would affect every layer drawing into that same element, causing colour
 * adjustments to bleed across layers. To prevent this, the renderer's useContainer
 * method is patched so that:
 * 1. Layers with active colour adjustments always receive their own dedicated container
 * 2. The filter is reapplied on every render frame
 * 3. Layers never reuse a container that has a filter applied to it
 */
export function applyColorAdjustments(olLayer: any, adjustments: {
  brightness?: number;
  saturation?: number;
  contrast?: number;
  opacity?: number;
}) {
  if (!olLayer) return;

  // Apply opacity via OpenLayers API
  olLayer.setOpacity((adjustments.opacity ?? 100) / 100);

  // Apply CSS filters for brightness, saturation, contrast
  const brightness = adjustments.brightness ?? 100;
  const saturation = adjustments.saturation ?? 100;
  const contrast = adjustments.contrast ?? 100;

  const filterValue = brightness === 100 && saturation === 100 && contrast === 100
    ? ''
    : `brightness(${brightness}%) saturate(${saturation}%) contrast(${contrast}%)`;

  try {
    const renderer = olLayer.getRenderer?.();
    if (!renderer) return;

    // Store the filter value on the renderer so the patched useContainer
    // can apply it after creating the dedicated container on every frame.
    renderer._colorFilter = filterValue;

    // Ensure the renderer is patched to prevent container reuse
    patchLayerRenderer(olLayer);

    // Request a map re-render so the patched useContainer runs and the
    // filter is applied to the newly-created dedicated container.
    if (typeof olLayer.changed === 'function') {
      olLayer.changed();
    }
  } catch (e) {
    // Renderer may not be ready yet; will be applied on next render
  }
}


/** Build a WFS GetFeature URL requesting GeoJSON output in EPSG:3857. */
export function buildWfsUrl(baseUrl: string, typeName: string): string {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: typeName,
    outputFormat: 'application/json',
    srsname: 'EPSG:3857',
  });
  return baseUrl + sep + params.toString();
}

/** Build a STAC API items URL for a given collection. */
export function buildStacItemsUrl(baseUrl: string, collection: string, pageLimit: number = 100): string {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ limit: String(pageLimit) });
  return `${base}/collections/${encodeURIComponent(collection)}/items?${params.toString()}`;
}

/** Strip query parameters whose values are None/null/empty (server artifacts). */
export function cleanStacUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const keysToRemove: string[] = [];
    u.searchParams.forEach((value, key) => {
      const lower = value.toLowerCase();
      if (lower === 'none' || lower === 'null' || value === '') {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Fetch STAC items with automatic pagination.
 * Follows `rel: "next"` links until all items are retrieved or `maxItems` is reached.
 * @param baseUrl  STAC API base URL
 * @param collection  Collection ID
 * @param maxItems  Maximum number of items to fetch (undefined = all)
 * @param onProgress  Optional callback reporting (fetchedSoFar) after each page
 * @returns GeoJSON FeatureCollection with all fetched features
 */
export async function fetchAllStacItems(
  baseUrl: string,
  collection: string,
  maxItems?: number,
  onProgress?: (count: number) => void,
): Promise<any> {
  const PAGE_SIZE = 100;
  let url: string | null = buildStacItemsUrl(baseUrl, collection, PAGE_SIZE);
  const allFeatures: any[] = [];

  while (url) {
    const response: Response = await fetch(url);
    if (!response.ok) throw new Error('STAC request failed: ' + response.status);
    const data: any = await response.json();

    if (Array.isArray(data.features)) {
      allFeatures.push(...data.features);
    }

    if (onProgress) onProgress(allFeatures.length);

    // Stop if we've reached the user-specified limit
    if (maxItems !== undefined && allFeatures.length >= maxItems) {
      allFeatures.length = maxItems; // trim to exact limit
      break;
    }

    // Follow the "next" link for pagination
    const nextLink: any = Array.isArray(data.links)
      ? data.links.find((l: any) => l.rel === 'next')
      : null;
    url = nextLink ? (typeof nextLink.href === 'string' ? cleanStacUrl(nextLink.href) : null) : null;
  }

  return { type: 'FeatureCollection', features: allFeatures };
}

/** Escape a string for safe insertion into the popup's innerHTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Human-readable label for a feature inside a multi-feature popup section. */
export function popupFeatureLabel(feature: any, index: number): string {
  if (feature._drawName) return feature._drawName;
  const get = typeof feature.get === 'function' ? (k: string) => feature.get(k) : () => undefined;
  const labelText = get('labelText');
  if (labelText) return 'Label: ' + labelText;
  const name = get('name');
  if (name !== undefined && name !== null && String(name).trim() !== '') return String(name);
  return 'Feature ' + (index + 1);
}

/**
 * Issue a WMS GetFeatureInfo request for the given map position against an
 * ImageWMS-backed layer and return the parsed attributes.
 *
 * Uses the source's own getFeatureInfoUrl builder so the request matches the
 * exact image that is currently displayed (same bbox/size/crs). JSON/GeoJSON
 * responses are reduced to per-feature attribute objects; anything else is
 * returned verbatim as text so nothing is silently dropped.
 */
export async function fetchWmsFeatureInfo(
  olLayer: any,
  coordinate: number[],
  map: any
): Promise<WmsFeatureInfoResult | null> {
  try {
    const source = olLayer?.getSource?.();
    const view = map?.getView?.();
    if (!source || !view) return null;

    const resolution = view.getResolution();
    const projection = view.getProjection();
    if (!resolution) return null;

    const url = source.getFeatureInfoUrl?.(coordinate, resolution, projection, {
      INFO_FORMAT: 'application/json',
      FEATURE_COUNT: 10,
    });
    if (!url) return null;

    const response = await fetch(url);
    if (!response.ok) {
      console.warn('GetFeatureInfo request failed:', response.status, response.statusText);
      return null;
    }

    const text = await response.text();
    if (!text || !text.trim()) return { features: [] };

    // Prefer structured output when the server returns JSON/GeoJSON.
    try {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.features)) {
        return { features: data.features.map((f: any) => (f && f.properties) || {}) };
      }
      return { text: JSON.stringify(data, null, 2) };
    } catch {
      // Not JSON - fall through and surface the raw payload (text/html/xml).
      return { text };
    }
  } catch (e) {
    console.warn('GetFeatureInfo request error:', e);
    return null;
  }
}

/**
 * Apply a zoom range to a vector layer.
 *
 * MVT (vector tile) layers clamp tile *requests* to the given range, exactly
 * like XYZ/WMTS raster layers: outside the range the nearest allowed tiles are
 * magnified instead of requesting new ones. The grid's native range is
 * remembered on the layer so clearing the fields restores it.
 *
 * Other vector layer types are not tiled, so the range acts as a *visibility*
 * range instead: the layer is only drawn while the view zoom is inside it.
 * OpenLayers treats a layer's minZoom as exclusive (visible when
 * zoom > minZoom), so a tiny epsilon is subtracted to make the user-facing
 * range inclusive at both ends.
 */
export function applyVectorLayerZoomRange(olLayer: any, type: VectorLayerConfig['type'], minZoom?: number, maxZoom?: number) {
  if (!olLayer) return;
  if (type === 'mvt') {
    const grid: any = olLayer.getSource?.()?.getTileGrid?.();
    if (!grid) return;
    // Remember the native grid range so clearing the fields restores it
    if (!olLayer._nativeTileZoomRange) {
      olLayer._nativeTileZoomRange = { min: grid.getMinZoom(), max: grid.getMaxZoom() };
    }
    const native = olLayer._nativeTileZoomRange;
    grid.minZoom = minZoom !== undefined ? Math.max(native.min, Math.min(minZoom, native.max)) : native.min;
    grid.maxZoom = maxZoom !== undefined ? Math.min(native.max, Math.max(maxZoom, grid.minZoom)) : native.max;
    if (grid.minZoom > grid.maxZoom) grid.minZoom = grid.maxZoom;
    olLayer.changed();
  } else {
    olLayer.setMinZoom(minZoom !== undefined ? minZoom - 1e-9 : -Infinity);
    olLayer.setMaxZoom(maxZoom !== undefined ? maxZoom : Infinity);
  }
}

/**
 * Inspect a vector layer's features and report how many are points.
 *
 * Used to decide whether the "Point clustering" option applies to a layer -
 * clustering only makes sense for point datasets. Looks through any Cluster
 * wrapper (or the stashed raw source) so it counts the real underlying
 * features rather than the generated cluster bubbles.
 */
export function layerPointStats(olLayer: any): { total: number; pointCount: number } {
  if (!olLayer || !olLayer.getSource) return { total: 0, pointCount: 0 };
  let source = olLayer._rawSource || olLayer.getSource();
  if (source instanceof Cluster && (source as any).getSource) source = (source as any).getSource();
  if (!source || typeof source.getFeatures !== 'function') return { total: 0, pointCount: 0 };
  const feats = source.getFeatures();
  let pointCount = 0;
  for (const f of feats) {
    const g = f.getGeometry && f.getGeometry();
    if (g && g.getType() === 'Point') pointCount++;
  }
  return { total: feats.length, pointCount };
}

export function reorderLayers(map: OLMap, orderedRasterLayers?: RasterLayer[], orderedVectorLayers?: VectorLayerConfig[]) {
  const collection = map.getLayers();
  const allLayers = collection.getArray().slice();

  const baseLayers: any[] = [];
  const gridLayers: any[] = [];
  const rasterOLayers: any[] = [];
  const vectorOLayers: any[] = [];
  const drawLayers: any[] = [];
  const markerLayers: any[] = [];

  allLayers.forEach((layer: any) => {
    // The picked-up-vertex marker sits above everything, drawings included
    if (layer.get('_isEditMarkerLayer')) {
      markerLayers.push(layer);
      return;
    }
    // Separate draw layers - they always stay on top
    if (layer.get('_isDrawLayer')) {
      drawLayers.push(layer);
      return;
    }
    const source = layer.getSource?.();
    if (source instanceof OSM) {
      baseLayers.push(layer);
    } else if (source instanceof TileDebug) {
      gridLayers.push(layer);
    } else if (source instanceof VectorSource || source instanceof VectorTileSource) {
      vectorOLayers.push(layer);
    } else {
      // XYZ, WMTS, and WMS are all raster layers
      rasterOLayers.push(layer);
    }
  });

  // If ordered arrays are provided, respect their order
  if (orderedRasterLayers && orderedRasterLayers.length > 0) {
    const orderedRasterOLayers: any[] = [];
    orderedRasterLayers.forEach(config => {
      if (config.olLayer && rasterOLayers.includes(config.olLayer)) {
        orderedRasterOLayers.push(config.olLayer);
      }
    });
    // Add any raster layers not in the config (shouldn't happen, but safety)
    rasterOLayers.forEach(l => {
      if (!orderedRasterOLayers.includes(l)) {
        orderedRasterOLayers.push(l);
      }
    });
    rasterOLayers.length = 0;
    rasterOLayers.push(...orderedRasterOLayers);
  }

  if (orderedVectorLayers && orderedVectorLayers.length > 0) {
    const orderedVectorOLayers: any[] = [];
    orderedVectorLayers.forEach(config => {
      if (config.olLayer && vectorOLayers.includes(config.olLayer)) {
        orderedVectorOLayers.push(config.olLayer);
      }
    });
    vectorOLayers.length = 0;
    vectorOLayers.push(...orderedVectorOLayers);
  }

  collection.clear();
  // Order: base (bottom) < raster < vector < grid < draw layers < edit marker (top)
  // Within each category, reverse so first in UI list = top of map (last added to OL)
  [...baseLayers, ...rasterOLayers.slice().reverse(), ...vectorOLayers.slice().reverse(), ...gridLayers, ...drawLayers, ...markerLayers].forEach(layer => collection.push(layer));
}
