import OLMap from 'ol/Map.js';
import { unByKey } from 'ol/Observable.js';
import Cluster from 'ol/source/Cluster.js';
import OSM from 'ol/source/OSM.js';
import TileDebug from 'ol/source/TileDebug.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import { VectorLayerConfig, RasterLayer, WmsFeatureInfoResult } from '../types';
import { compileFeatureFilter, featureProperties } from './featureFilter';

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
 * Names of the GPU style variables used to drive colour adjustments on
 * COG (WebGLTile) layers. Kept in one place so the layer style created by
 * `createCogTileStyle` and the values written by `applyColorAdjustments`
 * always agree.
 */
export const COG_COLOR_VARIABLES = {
  exposure: 'cogExposure',
  contrast: 'cogContrast',
  saturation: 'cogSaturation',
} as const;

/**
 * Build the OpenLayers WebGLTile style used for COG layers.
 *
 * Brightness/contrast/saturation are declared as GPU style variables so they
 * can be tweaked cheaply at runtime via `layer.updateStyleVariables()` —
 * unlike canvas layers, WebGL layers are not affected by CSS filters, so the
 * colour adjustments must happen inside the tile shader.
 *
 * The variables use OpenLayers' native -1..1 range (0 = no change):
 * - `exposure` multiplies the colour, matching CSS `brightness()`
 * - `contrast` and `saturation` use the same formulas as their CSS filters
 */
export function createCogTileStyle() {
  return {
    variables: {
      [COG_COLOR_VARIABLES.exposure]: 0,
      [COG_COLOR_VARIABLES.contrast]: 0,
      [COG_COLOR_VARIABLES.saturation]: 0,
    },
    exposure: ['var', COG_COLOR_VARIABLES.exposure],
    contrast: ['var', COG_COLOR_VARIABLES.contrast],
    saturation: ['var', COG_COLOR_VARIABLES.saturation],
  };
}

/**
 * Convert the app's colour-adjustment values (0-200 scale, 100 = neutral) to
 * the OpenLayers WebGL style-variable range (-1..1, 0 = neutral).
 */
export function cogColorVariables(adjustments: {
  brightness?: number;
  saturation?: number;
  contrast?: number;
}): Record<string, number> {
  const toGlsl = (value?: number) => (value ?? 100) / 100 - 1;
  return {
    [COG_COLOR_VARIABLES.exposure]: toGlsl(adjustments.brightness),
    [COG_COLOR_VARIABLES.contrast]: toGlsl(adjustments.contrast),
    [COG_COLOR_VARIABLES.saturation]: toGlsl(adjustments.saturation),
  };
}

/** True when the layer is an OpenLayers WebGLTile layer (e.g. a COG layer). */
export function isWebGlTileLayer(olLayer: any): boolean {
  return !!olLayer && typeof olLayer.updateStyleVariables === 'function';
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

  // WebGLTile layers (COGs) render with their own WebGL canvas, so CSS
  // filters never reach them. Drive their shader style variables instead.
  if (isWebGlTileLayer(olLayer)) {
    olLayer.updateStyleVariables(cogColorVariables(adjustments));
    return;
  }

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
 * Type guard for a parsed STAC Item: a GeoJSON Feature that carries a
 * `stac_version` field. Static items hosted on plain object storage (e.g.
 * the Sentinel-2 COG bucket on S3) look like this, as opposed to a STAC
 * API catalog which answers `/collections` and `/collections/{id}/items`.
 */
export function isStacItem(data: any): boolean {
  return !!data && data.type === 'Feature' && typeof data.stac_version === 'string';
}

/** Human-readable label for a STAC Item: its title (or id), plus collection. */
export function stacItemLabel(item: any): string {
  const title = item?.properties?.title || item?.id || 'Untitled item';
  return item?.collection ? `${title} — ${item.collection}` : String(title);
}

/**
 * Fetch a URL that points directly at a single static STAC Item JSON
 * document and validate its shape. Throws when the response is missing,
 * is not JSON, or is not a STAC Item.
 */
export async function fetchDirectStacItem(url: string): Promise<any> {
  const response: Response = await fetch(url);
  if (!response.ok) throw new Error('STAC item request failed: HTTP ' + response.status);
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error('URL did not return valid JSON');
  }
  if (!isStacItem(data)) {
    throw new Error('URL is not a STAC Item (expected a GeoJSON Feature with a stac_version field)');
  }
  return data;
}

/**
 * Probe whether a URL points directly at a single STAC Item. Returns the
 * parsed item, or null when the URL is unreachable or not a STAC Item —
 * never throws, so it is safe to use as a speculative fallback when a URL
 * fails to behave like a STAC API catalog.
 */
export async function probeDirectStacItem(url: string): Promise<any | null> {
  try {
    return await fetchDirectStacItem(url);
  } catch {
    return null;
  }
}

/**
 * Fetch STAC items with automatic pagination.
 * Follows `rel: "next"` links until all items are retrieved or `maxItems` is reached.
 *
 * When `collection` is empty the `baseUrl` is treated as a direct link to a
 * single static STAC Item JSON document (e.g. an item hosted on S3) rather
 * than a STAC API catalog; the item is wrapped in a FeatureCollection so
 * both source kinds flow through the exact same loading path.
 *
 * @param baseUrl  STAC API base URL, or a direct STAC Item URL when collection is empty
 * @param collection  Collection ID (empty = direct STAC Item mode)
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
  // Direct STAC Item mode: the URL itself is the item document.
  if (!collection || !collection.trim()) {
    const item = await fetchDirectStacItem(baseUrl);
    if (onProgress) onProgress(1);
    return { type: 'FeatureCollection', features: [item] };
  }

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
      console.warn('[LayerHelpers] GetFeatureInfo request failed:', response.status, response.statusText);
      return null;
    }

    return parseWmsFeatureInfoText(await response.text());
  } catch (e) {
    console.warn('[LayerHelpers] GetFeatureInfo request error:', e);
    return null;
  }
}

/**
 * Parse a raw GetFeatureInfo payload. JSON/GeoJSON responses are reduced to
 * per-feature attribute objects; anything else is returned verbatim as text
 * so nothing is silently dropped.
 */
export function parseWmsFeatureInfoText(text: string): WmsFeatureInfoResult {
  if (!text || !text.trim()) return { features: [] };
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.features)) {
      return { features: data.features.map((f: any) => (f && f.properties) || {}) };
    }
    return { text: JSON.stringify(data, null, 2) };
  } catch {
    // Not JSON - surface the raw payload (text/html/xml).
    return { text };
  }
}

/**
 * Issue a WMS GetFeatureInfo request covering an extent (used by the box
 * selection "Features" action). The request's BBOX matches the selection box
 * exactly, with the query pixel aimed at its centre, so servers return the
 * features intersecting the box.
 */
export async function fetchWmsFeatureInfoExtent(
  olLayer: any,
  extent: [number, number, number, number],
  map: any
): Promise<WmsFeatureInfoResult | null> {
  try {
    const source = olLayer?.getSource?.();
    const view = map?.getView?.();
    if (!source || !view) return null;

    const resolution = view.getResolution();
    const projection = view.getProjection();
    if (!resolution || !projection) return null;

    const params = source.getParams?.() || {};
    const layers = params.LAYERS || params.layers;
    const urls = source.getUrls?.();
    const baseUrl = (urls && urls.length ? urls[0] : undefined) || source.getUrl?.();
    if (!layers || !baseUrl) return null;

    const width = Math.max(1, Math.round((extent[2] - extent[0]) / resolution));
    const height = Math.max(1, Math.round((extent[3] - extent[1]) / resolution));
    const version = params.VERSION || '1.1.1';

    const query: Record<string, string> = {
      SERVICE: 'WMS',
      VERSION: version,
      REQUEST: 'GetFeatureInfo',
      LAYERS: layers,
      QUERY_LAYERS: params.QUERY_LAYERS || layers,
      STYLES: params.STYLES || '',
      BBOX: extent.join(','),
      WIDTH: String(width),
      HEIGHT: String(height),
      X: String(Math.floor(width / 2)),
      Y: String(Math.floor(height / 2)),
      INFO_FORMAT: 'application/json',
      FEATURE_COUNT: '10',
    };
    query[version === '1.3.0' ? 'CRS' : 'SRS'] = projection.getCode();

    const qs = Object.entries(query)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + qs;

    const response = await fetch(url);
    if (!response.ok) {
      console.warn('[LayerHelpers] GetFeatureInfo (extent) request failed:', response.status, response.statusText);
      return null;
    }

    return parseWmsFeatureInfoText(await response.text());
  } catch (e) {
    console.warn('[LayerHelpers] GetFeatureInfo (extent) request error:', e);
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

// ---------------------------------------------------------------------------
// Attribute filtering for vector layers
// ---------------------------------------------------------------------------

/**
 * The editable feature source of a vector OL layer: the stashed raw source
 * when clustering is active (the Cluster wrapper only holds generated
 * bubbles), otherwise the layer's own source. Unwraps a Cluster source too,
 * for safety.
 */
export function vectorFeatureSource(olLayer: any): any {
  if (!olLayer) return null;
  let source = olLayer._rawSource || (olLayer.getSource && olLayer.getSource());
  if (source instanceof Cluster && (source as any).getSource) source = (source as any).getSource();
  return source && typeof source.getFeatures === 'function' ? source : null;
}

/**
 * Apply (or clear) an attribute filter on a vector layer.
 *
 * The full feature set is stashed once on the layer (`_filterMaster`) and the
 * live source is swapped to hold only the matching features - hidden features
 * leave the map entirely (no clicks, no extent, re-clustered automatically).
 * The stash keeps the dataset intact: clearing the filter restores every
 * feature, and workspace persistence serialises the master set rather than
 * the filtered view so nothing is ever lost.
 *
 * While a filter is active, source-level listeners keep the stash in sync
 * with external edits - features drawn into the layer are evaluated against
 * the active query (and hidden when they don't match), and removed features
 * leave the stash too. Throws on an invalid expression, leaving the layer
 * untouched.
 */
export function applyVectorFeatureFilter(olLayer: any, expression: string | null | undefined): void {
  if (!olLayer) return;
  const source = vectorFeatureSource(olLayer);
  if (!source) return;

  const detachListeners = () => {
    if (olLayer._filterListeners) {
      olLayer._filterListeners.forEach((key: any) => unByKey(key));
      olLayer._filterListeners = null;
    }
  };

  const swapTo = (features: any[]) => {
    olLayer._filterSwapping = true;
    try {
      source.clear();
      source.addFeatures(features);
    } finally {
      olLayer._filterSwapping = false;
    }
  };

  // Clearing: restore the full dataset and forget the filter state.
  if (!expression || !expression.trim()) {
    const master: any[] | undefined = olLayer._filterMaster;
    detachListeners();
    olLayer._filterMaster = undefined;
    olLayer._filterPredicate = undefined;
    olLayer._filterExpression = undefined;
    if (master) swapTo(master);
    if (olLayer.changed) olLayer.changed();
    return;
  }

  const compiled = compileFeatureFilter(expression); // throws on bad syntax

  // First activation captures the unfiltered dataset; later activations
  // reuse the stash so re-filtering never narrows an already-narrowed view.
  if (!Array.isArray(olLayer._filterMaster)) {
    olLayer._filterMaster = source.getFeatures().slice();
  }
  const master: any[] = olLayer._filterMaster;

  if (!olLayer._filterListeners) {
    const onAdd = (e: any) => {
      if (olLayer._filterSwapping) return; // our own swap - already accounted for
      const f = e.feature;
      if (master.indexOf(f) < 0) master.push(f);
      const predicate = olLayer._filterPredicate;
      if (predicate && !predicate(featureProperties(f))) {
        // Newly added feature fails the active query - hide it immediately.
        olLayer._filterSwapping = true;
        try { source.removeFeature(f); } finally { olLayer._filterSwapping = false; }
      }
    };
    const onRemove = (e: any) => {
      if (olLayer._filterSwapping) return;
      const i = master.indexOf(e.feature);
      if (i >= 0) master.splice(i, 1);
    };
    const onClear = () => {
      if (olLayer._filterSwapping) return;
      master.length = 0;
    };
    olLayer._filterListeners = [
      source.on('addfeature', onAdd),
      source.on('removefeature', onRemove),
      source.on('clear', onClear),
    ];
  }

  olLayer._filterPredicate = compiled.predicate;
  olLayer._filterExpression = compiled.source;

  swapTo(master.filter(f => compiled.predicate(featureProperties(f))));
  if (olLayer.changed) olLayer.changed();
}

/**
 * Filter stats for the settings UI: how many features are currently shown
 * versus how many the layer holds in total. `filtered` is true while a
 * filter is active (master stash present).
 */
export function vectorFilterStats(olLayer: any): { shown: number; total: number; filtered: boolean } {
  const source = vectorFeatureSource(olLayer);
  const shown = source ? source.getFeatures().length : 0;
  const master = olLayer && olLayer._filterMaster;
  const filtered = Array.isArray(master);
  return { shown, total: filtered ? master.length : shown, filtered };
}
