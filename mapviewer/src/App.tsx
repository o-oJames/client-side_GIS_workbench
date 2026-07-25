import './App.css';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Routes, Route, Navigate } from 'react-router-dom';
import OLMap from 'ol/Map.js';
import OSM, { ATTRIBUTION as OSM_ATTRIBUTION } from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import ImageLayer from 'ol/layer/Image.js';
import TileDebug from 'ol/source/TileDebug.js';
import XYZ from 'ol/source/XYZ.js';
import WMTS from 'ol/source/WMTS.js';
import { optionsFromCapabilities } from 'ol/source/WMTS.js';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import ImageWMS from 'ol/source/ImageWMS.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import ScaleLine from 'ol/control/ScaleLine.js';
import Attribution from 'ol/control/Attribution.js';
import Overlay from 'ol/Overlay.js';
import { defaults as defaultControls } from 'ol/control.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from 'ol/style.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import JSZip from 'jszip';
import proj4 from 'proj4';
import { register as registerProj4 } from 'ol/proj/proj4.js';
import Projection from 'ol/proj/Projection.js';
import { parseShapefile, ShapefileResult } from './utils/shapefileParser';
import { registerProjectionFromWKT, registerProjectionFromEPSGCode } from './utils/projectionHelper';
import { fromLonLat, toLonLat } from 'ol/proj.js';

// Register proj4 with OpenLayers
registerProj4(proj4);


interface WmtsLayerInfo {
  identifier: string;
  title: string;
}

interface WmsLayerInfo {
  name: string;
  title: string;
}

interface KnownSource {
  id: string;
  name: string;
  type: 'wmts' | 'wms' | 'xyz' | 'vtile' | 'wfs' | 'stac';
  url: string;
  wfsTypeName?: string;    // WFS sources: feature type name
  stacCollection?: string; // STAC sources: collection id
  stacLimit?: number;      // STAC sources: max items to fetch
}

const KNOWN_SOURCES_KEY = 'mapviewer-known-sources';

function loadKnownSources(): KnownSource[] {
  try {
    const raw = localStorage.getItem(KNOWN_SOURCES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((s: any) => s.id && s.name && s.type && s.url);
      }
    }
  } catch (e) {
    console.error('Failed to load known sources:', e);
  }
  return [];
}

function saveKnownSources(sources: KnownSource[]) {
  try {
    localStorage.setItem(KNOWN_SOURCES_KEY, JSON.stringify(sources));
  } catch (e) {
    console.error('Failed to save known sources:', e);
  }
}

// ---------------------------------------------------------------------------
// Basemap (background tile layer) configuration
// ---------------------------------------------------------------------------
const DEFAULT_BASEMAP_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const BASEMAP_PRESETS: Array<{ name: string; url: string }> = [
  { name: 'OSM Standard', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  { name: 'Carto Light', url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png' },
  { name: 'Carto Dark', url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png' },
  { name: 'Esri Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' },
];

/** Encode an XYZ tile coordinate as a Bing-style quadkey ({q}). */
function tileToQuadKey(z: number, x: number, y: number): string {
  let quadKey = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadKey += digit;
  }
  return quadKey;
}

/**
 * Create an XYZ tile source from a URL template. Supports the standard
 * {z}/{x}/{y} placeholders as well as Bing-style {q} quadkey templates
 * (e.g. https://t.ssl.ak.dynamic.tiles.virtualearth.net/comp/ch/{q}?it=GB,LC).
 *
 * Optional minZoom/maxZoom clamp the tile *requests* to that range: when the
 * view is zoomed beyond the range, OpenLayers keeps requesting the nearest
 * allowed zoom level and magnifies those tiles (overzoom/underzoom) instead
 * of asking the server for tiles it may not have.
 */
function createXYZSource(url: string, minZoom?: number, maxZoom?: number): XYZ {
  const zoomOptions: { minZoom?: number; maxZoom?: number } = {};
  if (minZoom !== undefined) zoomOptions.minZoom = minZoom;
  if (maxZoom !== undefined) zoomOptions.maxZoom = maxZoom;
  if (url.includes('{q}')) {
    return new XYZ({
      ...zoomOptions,
      tileUrlFunction: (tileCoord: number[]) =>
        url.replace(/\{q\}/g, tileToQuadKey(tileCoord[0], tileCoord[1], tileCoord[2])),
    });
  }
  return new XYZ({ ...zoomOptions, url });
}

/**
 * Create a WMTS source, optionally clamping tile-matrix requests to a
 * [minZoom, maxZoom] range. Outside the range the nearest allowed matrix is
 * magnified (same overzoom/underzoom behaviour as XYZ layers). Values are
 * clamped to the matrix range advertised by the service.
 */
function createWmtsSource(options: any, minZoom?: number, maxZoom?: number): WMTS {
  const source = new WMTS(options);
  if (minZoom === undefined && maxZoom === undefined) return source;
  const grid: any = source.getTileGrid();
  if (grid) {
    const nativeMin: number = grid.getMinZoom();
    const nativeMax: number = grid.getMaxZoom();
    // minZoom/maxZoom are public runtime fields on ol TileGrid; getZForResolution
    // clamps every request to [minZoom, maxZoom] (TS marks them protected, hence any)
    if (minZoom !== undefined) grid.minZoom = Math.max(nativeMin, Math.min(minZoom, nativeMax));
    if (maxZoom !== undefined) grid.maxZoom = Math.min(nativeMax, Math.max(maxZoom, grid.minZoom));
  }
  return source;
}

/** Identity of the basemap source config, used to skip redundant source swaps. */
function basemapSourceKey(url: string, minZoom?: number, maxZoom?: number): string {
  return `${url}|${minZoom ?? ''}|${maxZoom ?? ''}`;
}

/**
 * Create the basemap tile source for an XYZ template URL (OSM for the default).
 * Optional minZoom/maxZoom clamp tile requests the same way they do for XYZ
 * raster layers (overzoom/underzoom outside the range).
 */
function createBasemapSource(url: string, minZoom?: number, maxZoom?: number): OSM | XYZ {
  const isDefault = !url || url === DEFAULT_BASEMAP_URL;
  const hasCustomRange = minZoom !== undefined || maxZoom !== undefined;
  if (isDefault && !hasCustomRange) {
    return new OSM();
  }
  if (isDefault) {
    // Keep OSM's attribution and native max zoom (19) unless overridden
    return new XYZ({
      url: DEFAULT_BASEMAP_URL,
      attributions: OSM_ATTRIBUTION,
      minZoom,
      maxZoom: maxZoom ?? 19,
    });
  }
  return createXYZSource(url, minZoom, maxZoom);
}

/**
 * A usable tile template must be an http(s) URL with either {z}, {x} and {y}
 * placeholders or a {q} quadkey placeholder.
 */
function isValidTileTemplate(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  if (trimmed.includes('{q}')) return true;
  return trimmed.includes('{z}') && trimmed.includes('{x}') && trimmed.includes('{y}');
}

/** Expand an XYZ / quadkey template into a concrete tile URL (used for the live preview). */
function templateToTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{-y\}/g, String(Math.pow(2, z) - 1 - y)) // TMS scheme
    .replace(/\{q\}/g, tileToQuadKey(z, x, y)) // Bing-style quadkey
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, 'a')
    .replace(/\{subdomain\}/gi, 'a');
}

const extractBaseUrl = (url: string): string => {
  const questionMarkIndex = url.indexOf('?');
  return questionMarkIndex !== -1 ? url.substring(0, questionMarkIndex) : url;
};

/**
 * Extract extent [minx, miny, maxx, maxy] in EPSG:3857 from WMTS capabilities for a specific layer.
 */
function extractWmtsExtent(capabilities: any, layerIdentifier: string): number[] | null {
  const layers = capabilities?.Contents?.Layer;
  if (!Array.isArray(layers)) return null;

  const layer = layers.find((l: any) => l.Identifier === layerIdentifier);
  if (!layer) return null;

  // Try WGS84BoundingBox - OL parser returns this as a flat extent array [minLon, minLat, maxLon, maxLat]
  if (layer.WGS84BoundingBox) {
    const extent = layer.WGS84BoundingBox;
    // OL parser returns extent directly as [minLon, minLat, maxLon, maxLat]
    if (Array.isArray(extent) && extent.length === 4 && extent.every((v: any) => typeof v === 'number' && isFinite(v))) {
      const [x1, y1] = fromLonLat([extent[0], extent[1]]);
      const [x2, y2] = fromLonLat([extent[2], extent[3]]);
      return [x1, y1, x2, y2];
    }
  }

  // Try BoundingBox array
  if (Array.isArray(layer.BoundingBox) && layer.BoundingBox.length > 0) {
    const bbox = layer.BoundingBox[0];
    if (bbox.extent && bbox.extent.length === 4 && bbox.extent.every(isFinite)) {
      const ext = bbox.extent;
      // If CRS is EPSG:4326, transform; if already 3857 use as-is
      const crs = (bbox.crs || bbox.CRS || '').toString().toLowerCase();
      if (crs.includes('4326')) {
        const [x1, y1] = fromLonLat([ext[0], ext[1]]);
        const [x2, y2] = fromLonLat([ext[2], ext[3]]);
        return [x1, y1, x2, y2];
      }
      return ext.slice();
    }
  }

  return null;
}

/**
 * Extract extent [minx, miny, maxx, maxy] in EPSG:3857 from WMS capabilities for a specific layer.
 */
function extractWmsExtent(capabilities: any, layerName: string): number[] | null {
  const findLayerBBox = (layerArray: any[] | undefined, name: string): any => {
    if (!layerArray) return null;
    for (const layer of layerArray) {
      if (layer.Name === name) {
        if (layer.EX_GeographicBoundingBox) return { type: 'exgeo', data: layer.EX_GeographicBoundingBox };
        if (layer.BoundingBox && layer.BoundingBox.length > 0) return { type: 'bbox', data: layer.BoundingBox[0] };
        if (layer.LatLonBoundingBox) return { type: 'llbbox', data: layer.LatLonBoundingBox };
        return null;
      }
      const found = findLayerBBox(layer.Layer, name);
      if (found) return found;
    }
    return null;
  };

  const result = findLayerBBox(capabilities?.Capability?.Layer?.Layer || [], layerName);
  if (!result) return null;

  let extent: number[] | null = null;
  if (result.type === 'exgeo') {
    const bb = result.data;
    if (bb.westBoundLongitude !== undefined) {
      extent = [bb.westBoundLongitude, bb.southBoundLatitude, bb.eastBoundLongitude, bb.northBoundLatitude];
    }
  } else if (result.type === 'bbox') {
    const bb = result.data;
    if (bb.extent && bb.extent.length === 4) {
      const crs = (bb.crs || bb.CRS || '').toString().toLowerCase();
      if (crs.includes('4326')) {
        extent = bb.extent.slice();
      } else if (crs.includes('3857') || crs.includes('900913')) {
        return bb.extent.slice();
      } else {
        // assume geographic
        extent = bb.extent.slice();
      }
    }
  } else if (result.type === 'llbbox') {
    const bb = result.data;
    if (Array.isArray(bb) && bb.length === 4) {
      extent = bb.slice();
    }
  }

  if (extent && extent.length === 4 && extent.every(isFinite)) {
    const [x1, y1] = fromLonLat([extent[0], extent[1]]);
    const [x2, y2] = fromLonLat([extent[2], extent[3]]);
    return [x1, y1, x2, y2];
  }

  return null;
}


interface RasterLayer {
  id: string;
  name: string;
  type: 'xyz' | 'wmts' | 'wms';
  url: string;
  wmtsCapabilitiesUrl?: string;
  wmtsLayer?: string;
  wmsCapabilitiesUrl?: string;
  wmsLayer?: string;
  olLayer?: any;
  visible?: boolean;
  extent?: number[]; // [minx, miny, maxx, maxy] in EPSG:3857
  brightness?: number;    // 0-200, default 100
  saturation?: number;    // 0-200, default 100
  contrast?: number;      // 0-200, default 100
  opacity?: number;       // 0-100, default 100
  minZoom?: number;       // XYZ only: min tile zoom to request (below this, min-zoom tiles are downscaled)
  maxZoom?: number;       // XYZ only: max tile zoom to request (above this, max-zoom tiles are upscaled)
}


/**
 * Patch a layer's renderer to prevent filter bleeding.
 *
 * OpenLayers' canvas renderer may reuse DOM containers between consecutive layers
 * as a performance optimisation. This causes CSS filters to bleed across layers.
 * The patched useContainer prevents container reuse whenever filters are involved
 * and always explicitly sets the correct filter on the final container.
 */
function patchLayerRenderer(olLayer: any) {
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
function applyColorAdjustments(olLayer: any, adjustments: {
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
function buildWfsUrl(baseUrl: string, typeName: string): string {
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
function buildStacItemsUrl(baseUrl: string, collection: string, pageLimit: number = 100): string {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ limit: String(pageLimit) });
  return `${base}/collections/${encodeURIComponent(collection)}/items?${params.toString()}`;
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
/** Strip query parameters whose values are None/null/empty (server artifacts). */
function cleanStacUrl(rawUrl: string): string {
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

async function fetchAllStacItems(
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
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Human-readable label for a feature inside a multi-feature popup section. */
function popupFeatureLabel(feature: any, index: number): string {
  if (feature._drawName) return feature._drawName;
  const get = typeof feature.get === 'function' ? (k: string) => feature.get(k) : () => undefined;
  const labelText = get('labelText');
  if (labelText) return 'Label: ' + labelText;
  const name = get('name');
  if (name !== undefined && name !== null && String(name).trim() !== '') return String(name);
  return 'Feature ' + (index + 1);
}

interface VectorLayerConfig {
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
  minZoom?: number;      // MVT: min tile zoom to request; other types: min zoom at which the layer is visible
  maxZoom?: number;      // MVT: max tile zoom to request; other types: max zoom at which the layer is visible
  wfsTypeName?: string;   // WFS: feature type name (e.g., 'namespace:layername')
  stacCollection?: string; // STAC: collection ID (e.g., 'sentinel-2-l2a')
  stacLimit?: number;      // STAC: max number of items to fetch (undefined = all)
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
function applyVectorLayerZoomRange(olLayer: any, type: VectorLayerConfig['type'], minZoom?: number, maxZoom?: number) {
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

const STORAGE_KEY = 'mapviewer-settings';
const VIEW_STORAGE_KEY = 'mapviewer-view';

interface StoredSettings {
  settingsPinned: boolean;
  showBasemap: boolean;
  basemapUrl: string;
  basemapMinZoom?: number;
  basemapMaxZoom?: number;
  showGrid: boolean;
  showDrawToolbar: boolean;
  showCoordinates: boolean;
  rasterLayers: RasterLayer[];
  vectorLayers: VectorLayerConfig[];
}

function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Filter out raster layers with blob fields (file-based sources can't persist)
      const validRasterLayers = Array.isArray(parsed.rasterLayers) 
        ? parsed.rasterLayers.filter((layer: any) => !layer.blob)
        : [];
      
      // Keep MVT layers and drawn-in-app layers (both can be persisted)
      const validVectorLayers = Array.isArray(parsed.vectorLayers)
        ? parsed.vectorLayers.filter((layer: any) => layer.type === 'mvt' || layer.type === 'wfs' || layer.type === 'stac' || layer.isDrawnInApp)
        : [];
      
      return {
        settingsPinned: !!parsed.settingsPinned,
        showBasemap: parsed.showBasemap !== false,
        basemapUrl:
          typeof parsed.basemapUrl === 'string' && parsed.basemapUrl.trim()
            ? parsed.basemapUrl
            : DEFAULT_BASEMAP_URL,
        basemapMinZoom: typeof parsed.basemapMinZoom === 'number' ? parsed.basemapMinZoom : undefined,
        basemapMaxZoom: typeof parsed.basemapMaxZoom === 'number' ? parsed.basemapMaxZoom : undefined,
        showGrid: !!parsed.showGrid,
        showDrawToolbar: parsed.showDrawToolbar !== false,
        showCoordinates: parsed.showCoordinates !== false,
        rasterLayers: validRasterLayers,
        vectorLayers: validVectorLayers,
      };
    }
  } catch (e) {
    console.error('Failed to load settings from localStorage:', e);
  }
  return { settingsPinned: false, showBasemap: true, basemapUrl: DEFAULT_BASEMAP_URL, showGrid: false, showDrawToolbar: true, showCoordinates: true, rasterLayers: [], vectorLayers: [] };
}

function saveSettings(settings: StoredSettings) {
  try {
    // Remove olLayer and blob references before saving (they can't be serialized)
    const serializableSettings = {
      ...settings,
      rasterLayers: settings.rasterLayers
        .filter(layer => !(layer as any).blob) // Don't save file-based layers
        .map(({ olLayer, ...rest }) => rest),
      vectorLayers: settings.vectorLayers
        .filter(layer => layer.type === 'mvt' || layer.type === 'wfs' || layer.type === 'stac' || layer.isDrawnInApp) // MVT + WFS + STAC + drawn-in-app
        .map((layer) => {
          const { olLayer, ...rest } = layer;
          // Serialize drawn-in-app features (geometry + per-feature style) so they survive a reload
          if (layer.isDrawnInApp && olLayer && olLayer.getSource) {
            const feats = olLayer.getSource().getFeatures();
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
                console.error('Failed to serialize drawn layer:', e);
              }
            }
          }
          return rest;
        }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableSettings));
  } catch (e) {
    console.error('Failed to save settings to localStorage:', e);
  }
}


function reorderLayers(map: OLMap, orderedRasterLayers?: RasterLayer[], orderedVectorLayers?: VectorLayerConfig[]) {
  const collection = map.getLayers();
  const allLayers = collection.getArray().slice();

  const baseLayers: any[] = [];
  const gridLayers: any[] = [];
  const rasterOLayers: any[] = [];
  const vectorOLayers: any[] = [];
  const drawLayers: any[] = [];

  allLayers.forEach((layer: any) => {
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
  // Order: base (bottom) < raster < vector < grid < draw layers (top)
  // Within each category, reverse so first in UI list = top of map (last added to OL)
  [...baseLayers, ...rasterOLayers.slice().reverse(), ...vectorOLayers.slice().reverse(), ...gridLayers, ...drawLayers].forEach(layer => collection.push(layer));
}
function getInitialView() {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat') || '');
  const lng = parseFloat(params.get('lng') || '');
  const z = parseInt(params.get('z') || '', 10);

  if (!isNaN(lat) && !isNaN(lng) && !isNaN(z)) {
    return { center: fromLonLat([lng, lat]), zoom: z };
  }

  // Fall back to localStorage
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
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
    console.error('Failed to load view from localStorage:', e);
  }

  return { center: [14960009, -3001695], zoom: 4 };
}

function updateUrlParams(view: View) {
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
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      lat: lat.toFixed(5),
      lng: lng.toFixed(5),
      z: Math.round(zoom).toString(),
    }));
  } catch (e) {
    console.error('Failed to save view to localStorage:', e);
  }
}

function GearIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
      fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
function EyeIcon({ visible }: { visible: boolean }) {
  if (visible) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    );
  } else {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
    );
  }
}

function ZoomToExtentIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6"/>
      <path d="M9 21H3v-6"/>
      <path d="M21 3l-7 7"/>
      <path d="M3 21l7-7"/>
    </svg>
  );
}



interface CustomSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function CustomSelect({ 
  value, 
  onChange, 
  options, 
  className, 
  disabled, 
  placeholder,
  onOpen,
  filterable,
}: { 
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  onOpen?: () => void;
  filterable?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [menuPosition, setMenuPosition] = useState<{ top?: number; bottom?: number; left: number; minWidth: number; maxHeight: number; openUp: boolean } | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalMenuRef = useRef<HTMLDivElement>(null);

  // Close on click outside (checks both wrapper and portal menu)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrapper = wrapperRef.current?.contains(target);
      const inPortalMenu = portalMenuRef.current?.contains(target);
      if (!inWrapper && !inPortalMenu) {
        setIsOpen(false);
        setFilterText('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Calculate menu position when opened, and follow trigger on scroll/resize
  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      // Keep the menu fully inside the viewport: prefer opening downward,
      // flip upward when there is not enough room below, and clamp the
      // height to the available space so long lists scroll instead of
      // overflowing the window.
      const MENU_MAX_HEIGHT = 240;
      const VIEWPORT_MARGIN = 8;
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - VIEWPORT_MARGIN;
      const openUp = spaceBelow < MENU_MAX_HEIGHT && spaceAbove > spaceBelow;
      const available = openUp ? spaceAbove : spaceBelow;
      const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, available));
      setMenuPosition({
        top: openUp ? undefined : rect.bottom + 2,
        bottom: openUp ? window.innerHeight - rect.top + 2 : undefined,
        left: rect.left,
        minWidth: rect.width,
        maxHeight,
        openUp,
      });
    };

    updatePosition();

    // Reposition menu to follow trigger on scroll/resize instead of closing
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen]);

  // Focus the filter input when the menu opens
  useEffect(() => {
    if (isOpen && filterable && filterInputRef.current) {
      filterInputRef.current.focus();
    }
  }, [isOpen, filterable]);

  const selectedOption = options.find(o => o.value === value);
  const displayLabel = selectedOption?.label || placeholder || '';

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && onOpen) {
      onOpen();
    }
    if (isOpen) {
      setFilterText('');
    }
    setIsOpen(!isOpen);
  };

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setFilterText('');
    setIsOpen(false);
  };

  const lowerFilter = filterText.toLowerCase();
  const filteredOptions = filterable && filterText
    ? options.filter(o => o.disabled || o.label.toLowerCase().includes(lowerFilter) || (o.value && o.value.toLowerCase().includes(lowerFilter)))
    : options;

  const menuElement = isOpen && menuPosition ? (
    <div
      ref={portalMenuRef}
      className={`custom-select-menu custom-select-menu-portal${menuPosition.openUp ? ' custom-select-menu-up' : ''} ${className || ''}`}
      style={{
        position: 'fixed',
        top: menuPosition.top !== undefined ? menuPosition.top : 'auto',
        bottom: menuPosition.bottom !== undefined ? menuPosition.bottom : 'auto',
        left: menuPosition.left,
        width: menuPosition.minWidth,
        maxHeight: menuPosition.maxHeight,
      }}
    >
      {filterable && (
        <div className="custom-select-filter" onClick={(e) => e.stopPropagation()}>
          <input
            ref={filterInputRef}
            type="text"
            className="custom-select-filter-input"
            placeholder="Filter layers…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
      )}
      <div className="custom-select-options">
        {filteredOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`custom-select-option${option.value === value ? ' custom-select-option-selected' : ''}${option.disabled ? ' custom-select-option-disabled' : ''}`}
            onClick={() => !option.disabled && handleSelect(option.value)}
            disabled={option.disabled}
          >
            {option.label}
          </button>
        ))}
        {filterable && filteredOptions.length === 0 && (
          <div className="custom-select-no-results">No matching layers</div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={wrapperRef} className={`custom-select-wrapper ${className || ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`custom-select-trigger${disabled ? ' custom-select-disabled' : ''}`}
        onClick={handleToggle}
        disabled={disabled}
      >
        <span className="custom-select-value">{displayLabel}</span>
        <span className={`custom-select-chevron${isOpen ? ' custom-select-chevron-open' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {menuElement && createPortal(menuElement, document.body)}
    </div>
  );
}

// ---- Color helpers (hex <-> rgba) ----
interface Rgba { r: number; g: number; b: number; a: number; }

// Parse any CSS color string (hex, rgb, rgba) into RGBA components.
function parseColor(color: string | undefined, defaultAlpha: number): Rgba {
  const fallback: Rgba = { r: 66, g: 133, b: 244, a: defaultAlpha };
  if (!color) return fallback;
  const c = color.trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    if (hex.length === 6) hex += 'ff';
    if (hex.length < 8) return fallback;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = parseInt(hex.slice(6, 8), 16) / 255;
    if ([r, g, b].some(isNaN)) return fallback;
    return { r, g, b, a: isNaN(a) ? defaultAlpha : a };
  }
  const m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (m) {
    return {
      r: Math.round(parseFloat(m[1])),
      g: Math.round(parseFloat(m[2])),
      b: Math.round(parseFloat(m[3])),
      a: m[4] !== undefined ? parseFloat(m[4]) : defaultAlpha,
    };
  }
  return fallback;
}

function rgbaToString({ r, g, b, a }: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`;
}

function rgbaToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Convert HSL (h: 0-360, s/l: 0-100) to RGB.
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

// A random, distinguishable line/fill color pair (same hue, fill is translucent).
// Returning the exact values used for the OL style keeps the color editor in sync
// with what is actually drawn on the map.
function getRandomVectorColors(): { lineColor: string; fillColor: string } {
  const hue = Math.floor(Math.random() * 360);
  const { r, g, b } = hslToRgb(hue, 70, 50);
  return {
    lineColor: rgbaToString({ r, g, b, a: 1 }),
    fillColor: rgbaToString({ r, g, b, a: 0.3 }),
  };
}

// Normalize an OpenLayers color (CSS string or [r,g,b,a] array, a in 0-1) to an rgba() string.
function normalizeOlColor(color: any, defaultAlpha: number): string {
  if (color == null) {
    return rgbaToString({ r: 66, g: 133, b: 244, a: defaultAlpha });
  }
  if (Array.isArray(color)) {
    const [r, g, b, a] = color;
    return rgbaToString({
      r: Math.round(r),
      g: Math.round(g),
      b: Math.round(b),
      a: a != null ? a : defaultAlpha,
    });
  }
  return rgbaToString(parseColor(String(color), defaultAlpha));
}

// Checkerboard backdrop used to visualize transparency.
const CHECKERBOARD =
  'linear-gradient(45deg, #cfd6df 25%, transparent 25%, transparent 75%, #cfd6df 75%), ' +
  'linear-gradient(45deg, #cfd6df 25%, transparent 25%, transparent 75%, #cfd6df 75%)';

// Style applied to in-progress drawn features (editable before saving to a layer).
interface DrawStyle {
  opacity: number;
  lineColor: string;
  lineWidth: number;
  fillColor: string;
  fontColor: string;
  fontSize: number;
}
const DEFAULT_DRAW_STYLE: DrawStyle = {
  opacity: 100,
  lineColor: 'rgba(255, 204, 51, 1)',
  lineWidth: 2,
  fillColor: 'rgba(255, 204, 51, 0.2)',
  fontColor: 'rgba(0, 0, 0, 1)',
  fontSize: 14,
};

// Build a single OpenLayers style for one drawn feature from a DrawStyle.
function buildDrawFeatureStyle(ds: DrawStyle, labelText?: string): Style {
  const line = rgbaToString(parseColor(ds.lineColor, 1));
  const fill = rgbaToString(parseColor(ds.fillColor, 0.2));
  const fontColor = rgbaToString(parseColor(ds.fontColor, 1));
  const base = {
    fill: new Fill({ color: fill }),
    stroke: new Stroke({ color: line, width: ds.lineWidth }),
    image: new CircleStyle({
      radius: 6,
      fill: new Fill({ color: line }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
  };
  if (labelText) {
    return new Style({
      ...base,
      text: new Text({
        text: labelText,
        font: ds.fontSize + 'px Arial',
        fill: new Fill({ color: fontColor }),
        stroke: new Stroke({ color: '#fff', width: 3 }),
        offsetY: -15,
      }),
    });
  }
  return new Style(base);
}

// RGB color picker + a separate transparency (opacity) slider.
function ColorAlphaEditor({
  label,
  value,
  defaultAlpha,
  onChange,
}: {
  label: string;
  value: string;
  defaultAlpha: number;
  onChange: (rgba: string) => void;
}) {
  const { r, g, b, a } = parseColor(value, defaultAlpha);
  const hex = rgbaToHex({ r, g, b });
  const alphaPct = Math.round(a * 100);

  // RGB from the native picker; keep the current alpha.
  const handleColor = (newHex: string) => {
    const c = parseColor(newHex, 1);
    onChange(rgbaToString({ r: c.r, g: c.g, b: c.b, a }));
  };

  // Alpha from the slider; keep the current RGB.
  const handleAlpha = (pct: number) => {
    onChange(rgbaToString({ r, g, b, a: pct / 100 }));
  };

  return (
    <div className="ca-editor">
      <div className="ca-editor-header">
        <span className="ca-editor-label">{label}</span>
        <span className="ca-hex">{hex}</span>
        <span className="ca-alpha-pct">{alphaPct}%</span>
      </div>
      <div className="ca-editor-body">
        <label
          className="ca-swatch"
          title="Click to pick a color"
          style={{
            backgroundColor: '#fff',
            backgroundImage: `linear-gradient(rgba(${r}, ${g}, ${b}, ${a}), rgba(${r}, ${g}, ${b}, ${a})), ${CHECKERBOARD}`,
            backgroundSize: '100% 100%, 8px 8px, 8px 8px',
            backgroundPosition: '0 0, 0 0, 4px 4px',
          }}
        >
          <input type="color" value={hex} onChange={(e) => handleColor(e.target.value)} />
        </label>
        <input
          type="range"
          min="0"
          max="100"
          value={alphaPct}
          className="settings-slider ca-opacity-slider"
          title="Opacity"
          style={{
            backgroundColor: '#fff',
            backgroundImage: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0), rgba(${r}, ${g}, ${b}, 1)), ${CHECKERBOARD}`,
            backgroundSize: '100% 100%, 10px 10px, 10px 10px',
            backgroundPosition: '0 0, 0 0, 5px 5px',
          }}
          onChange={(e) => handleAlpha(parseInt(e.target.value, 10))}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile zoom range control (min/max zoom for XYZ raster layers)
// ---------------------------------------------------------------------------
const TILE_ZOOM_MIN = 0;
const TILE_ZOOM_MAX = 25; // matches the map view's maxZoom

/** Parse a zoom input string into a clamped integer, or undefined when empty (= unlimited). */
function parseZoomInput(value: string, lo: number = TILE_ZOOM_MIN, hi: number = TILE_ZOOM_MAX): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const n = parseInt(trimmed, 10);
  if (isNaN(n)) return undefined;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compact min/max tile-zoom editor with stepper buttons. Values are kept as
 * strings by the parent so a field can be emptied to mean "unlimited".
 */
function TileZoomRangeControl({
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  collapsible = false,
  defaultOpen = true,
  nativeMin,
  nativeMax,
  title = 'Tile zoom range',
  hint,
}: {
  minValue: string;
  maxValue: string;
  onMinChange: (value: string) => void;
  onMaxChange: (value: string) => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  nativeMin?: number;
  nativeMax?: number;
  title?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Services with a fixed matrix set (WMTS) constrain the usable range
  const lo = nativeMin ?? TILE_ZOOM_MIN;
  const hi = nativeMax ?? TILE_ZOOM_MAX;
  const min = parseZoomInput(minValue, lo, hi);
  const max = parseZoomInput(maxValue, lo, hi);
  const invalid = min !== undefined && max !== undefined && min > max;
  const hasCustomRange = min !== undefined || max !== undefined;

  const step = (current: string, delta: number, fallback: number, onChange: (v: string) => void) => {
    const parsed = parseZoomInput(current, lo, hi) ?? fallback;
    onChange(String(Math.max(lo, Math.min(hi, parsed + delta))));
  };

  const renderField = (
    label: string,
    value: string,
    parsed: number | undefined,
    fallback: number,
    onChange: (v: string) => void,
  ) => {
    const effective = parsed ?? fallback;
    return (
      <div className="zoom-range-field">
        <span className="zoom-range-field-label">{label}</span>
        <div className="zoom-range-stepper">
          <button
            type="button"
            className="zoom-range-step-btn"
            onClick={() => step(value, -1, fallback, onChange)}
            disabled={effective <= lo}
            title="Decrease"
          >−</button>
          <input
            type="number"
            min={lo}
            max={hi}
            value={value}
            placeholder="auto"
            onChange={(e) => onChange(e.target.value)}
            className="zoom-range-input"
          />
          <button
            type="button"
            className="zoom-range-step-btn"
            onClick={() => step(value, 1, fallback, onChange)}
            disabled={effective >= hi}
            title="Increase"
          >+</button>
        </div>
      </div>
    );
  };

  const nativeNote = (nativeMin !== undefined && nativeMax !== undefined) ? (
    <span className="zoom-range-native" title="Zoom range advertised by the tile service">
      service z{nativeMin}{'\u2013'}z{nativeMax}
    </span>
  ) : null;

  const badge = (
    <span className={'zoom-range-badge' + (invalid ? ' error' : hasCustomRange ? ' custom' : '')}>
      {invalid
        ? 'min \u003e max'
        : `z${min ?? lo}\u2013z${max ?? hi}`}
    </span>
  );

  return (
    <div className={'zoom-range' + (invalid ? ' invalid' : '') + (collapsible ? ' collapsible' : '')}>
      {collapsible ? (
        <button
          type="button"
          className="zoom-range-header zoom-range-toggle"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          <span className="zoom-range-header-left">
            <span className={'zoom-range-chevron' + (open ? ' expanded' : '')}>{'\u25b8'}</span>
            <span className="zoom-range-title">{title}</span>
          </span>
          {nativeNote}
          {badge}
        </button>
      ) : (
        <div className="zoom-range-header">
          <span className="zoom-range-title">{title}</span>
          {nativeNote}
          {badge}
        </div>
      )}
      {(!collapsible || open) && (
        <div className="zoom-range-body">
          <div className="zoom-range-row">
            {renderField('Min', minValue, min, TILE_ZOOM_MIN, onMinChange)}
            <span className="zoom-range-dash">{'\u2013'}</span>
            {renderField('Max', maxValue, max, TILE_ZOOM_MAX, onMaxChange)}
          </div>
          <p className="zoom-range-hint">
            {invalid
              ? 'Min zoom must be less than or equal to max zoom.'
              : (hint ?? 'Outside this range the nearest allowed tiles are magnified instead of requesting new ones.')}
          </p>
        </div>
      )}
    </div>
  );
}

function SettingsDialog({ 
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
  onAddRasterLayer,
  onEditRasterLayer,
  onRemoveRasterLayer,
  onToggleRasterLayer,
  onApplyColorAdjustments,
  onApplyTileZoomRange,
  vectorLayers,
  onToggleVectorLayer,
  onRemoveVectorLayer,
  onEditVectorLayer,
  onApplyVectorStyle,
  onApplyVectorZoomRange,
  onApplyVectorFeatureStyle,
  onReorderRasterLayers,
  onReorderVectorLayers,
  onAddVectorLayer,
  onAddMVTLayer,
  onAddWFSLayer,
  onAddSTACLayer,  onExportVectorLayer,
  onGoToVectorLayerExtent,
  onGoToRasterLayerExtent,
  onAdvancedSettings,
  knownSources,
  isRestoringLayers,
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
  onAddRasterLayer: (layer: RasterLayer) => Promise<void>;
  onEditRasterLayer: (layer: RasterLayer) => void;
  onRemoveRasterLayer: (id: string) => void;
  onToggleRasterLayer: (id: string) => void;
  onApplyColorAdjustments: (layerId: string, adjustments: { brightness?: number; saturation?: number; contrast?: number; opacity?: number }) => void;
  onApplyTileZoomRange: (layerId: string, minZoom?: number, maxZoom?: number) => void;
  vectorLayers: VectorLayerConfig[];
  onToggleVectorLayer: (id: string) => void;
  onRemoveVectorLayer: (id: string) => void;
  onEditVectorLayer: (layer: VectorLayerConfig) => void;
  onApplyVectorStyle: (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => void;
  onApplyVectorZoomRange: (layerId: string, minZoom?: number, maxZoom?: number) => void;
  onApplyVectorFeatureStyle: (layerId: string, feature: any, style: DrawStyle) => void;
  onReorderRasterLayers: (layers: RasterLayer[]) => void;
  onReorderVectorLayers: (layers: VectorLayerConfig[]) => void;
  onAddVectorLayer: (file: File, layerName?: string) => Promise<void>;
  onAddMVTLayer: (url: string, name: string) => Promise<void>;
  onAddWFSLayer: (url: string, typeName: string, name: string) => Promise<void>;
  onAddSTACLayer: (url: string, collection: string, name: string, limit?: number) => Promise<void>;  onExportVectorLayer: (layerId: string, format: 'geojson' | 'kml') => void;
  onGoToVectorLayerExtent: (layerId: string) => void;
  onGoToRasterLayerExtent: (layerId: string) => void;
  onAdvancedSettings: () => void;
  knownSources: KnownSource[];
  isRestoringLayers: boolean;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
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

  const handleRasterDragStart = (id: string) => {
    setDraggedRasterId(id);
  };

  const handleRasterDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedRasterId || draggedRasterId === targetId) return;
    
    const draggedIndex = rasterLayers.findIndex(l => l.id === draggedRasterId);
    const targetIndex = rasterLayers.findIndex(l => l.id === targetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    const newLayers = [...rasterLayers];
    const [draggedLayer] = newLayers.splice(draggedIndex, 1);
    newLayers.splice(targetIndex, 0, draggedLayer);
    
    onReorderRasterLayers(newLayers);
  };

  const handleRasterDragEnd = () => {
    setDraggedRasterId(null);
  };

  const handleVectorDragStart = (id: string) => {
    setDraggedVectorId(id);
  };

  const handleVectorDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedVectorId || draggedVectorId === targetId) return;
    
    const draggedIndex = vectorLayers.findIndex(l => l.id === draggedVectorId);
    const targetIndex = vectorLayers.findIndex(l => l.id === targetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    const newLayers = [...vectorLayers];
    const [draggedLayer] = newLayers.splice(draggedIndex, 1);
    newLayers.splice(targetIndex, 0, draggedLayer);
    
    onReorderVectorLayers(newLayers);
  };

  const handleVectorDragEnd = () => {
    setDraggedVectorId(null);
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
          <div className="settings-section-title">Raster Layers</div>
          {isRestoringLayers && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Restoring raster layers...</span>
            </div>
          )}
          {rasterLayers.map((layer) => (
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
                        updated = { ...layer, name: editName.trim(), wmsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity };
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
                className="settings-layer-item"
                draggable
                onDragStart={() => handleRasterDragStart(layer.id)}
                onDragOver={(e) => handleRasterDragOver(e, layer.id)}
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
          ))}
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
          <div className="settings-section-title">Vector Layers</div>
          {isRestoringLayers && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Restoring vector layers...</span>
            </div>
          )}
          {vectorLayers.length === 0 ? (
            <p className="settings-placeholder">No vector layers added yet. Drag and drop GeoJSON, KML, or KMZ files onto the map.</p>
          ) : (
            <div className="settings-layers-list">
              {vectorLayers.map((layer) => (
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
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    <div className="settings-form-buttons">
                      <button className="settings-button-primary" onClick={() => {
                        if (vectorEditName.trim() && (!['mvt', 'wfs', 'stac'].includes(layer.type) || vectorEditUrl.trim())) {
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
                          };
                          onEditVectorLayer(updated);
                          setVectorEditingId(null);
                        }
                      }}>Apply</button>
                      <button className="settings-button-secondary" onClick={() => {
                        onApplyVectorStyle(layer.id, originalVectorStyle);
                        onApplyVectorZoomRange(layer.id, originalVectorZoomRange.min, originalVectorZoomRange.max);
                        setVectorEditingId(null);
                      }}>Cancel</button>
                      {layer.isDrawnInApp && (
                        <>
                          <button className="settings-button-export" onClick={() => onExportVectorLayer(layer.id, 'geojson')} title="Export as GeoJSON">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                              <polyline points="7 10 12 15 17 10"/>
                              <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            GeoJSON
                          </button>
                          <button className="settings-button-export" onClick={() => onExportVectorLayer(layer.id, 'kml')} title="Export as KML">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                              <polyline points="7 10 12 15 17 10"/>
                              <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            KML
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div 
                    key={layer.id} 
                    className="settings-layer-item"
                    draggable
                    onDragStart={() => handleVectorDragStart(layer.id)}
                    onDragOver={(e) => handleVectorDragOver(e, layer.id)}
                    onDragEnd={handleVectorDragEnd}
                    style={{ cursor: 'grab', opacity: draggedVectorId === layer.id ? 0.5 : 1 }}
                  >
                    <span className="settings-drag-handle">⋮⋮</span>
                    <span className="settings-layer-name">{layer.name}</span>
                    <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                    {(layer.minZoom !== undefined || layer.maxZoom !== undefined) && (
                      <span className="settings-layer-zoom-chip" title={layer.type === 'mvt' ? 'Tile zoom range' : 'Visible zoom range'}>
                        z{layer.minZoom ?? TILE_ZOOM_MIN}{'\u2013'}{layer.maxZoom ?? TILE_ZOOM_MAX}
                      </span>
                    )}
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
              ))}
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
                      setSelectedVectorSourceId(val);
                      // Auto-fill name from source if name field is empty
                      const src = knownSources.find(s => s.id === val);
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
        <span className="settings-advanced-link" onClick={onAdvancedSettings}>Advanced Settings</span>
      </div>
    </div>
  );
}

/** Small globe glyph used in the "Edit Base Map" section header. */
function BasemapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function RasterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </svg>
  );
}

function VectorIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5 19 9l-2.5 8.5h-9L5 9z" />
      <circle cx="12" cy="4.5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="19" cy="9" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="17.5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="17.5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="5" cy="9" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Live three-tile preview (z4 over Australia) for an XYZ template. */
function BasemapPreview({ template }: { template: string | null }) {
  const [loaded, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(0);
    setFailed(false);
  }, [template]);

  if (!template) {
    return (
      <div className="basemap-preview basemap-preview-empty">
        <span>Enter a valid XYZ URL to see a live preview</span>
      </div>
    );
  }

  const tiles = [12, 13, 14].map(x => ({ x, src: templateToTileUrl(template, 4, x, 9) }));
  const done = loaded >= tiles.length;

  return (
    <div className="basemap-preview">
      {tiles.map(tile => (
        <img
          key={template + '/' + tile.x}
          src={tile.src}
          alt=""
          className="basemap-preview-tile"
          onLoad={() => setLoaded(n => n + 1)}
          onError={() => setFailed(true)}
        />
      ))}
      <div className={'basemap-preview-status' + (failed ? ' error' : done ? ' ok' : '')}>
        {failed
          ? 'Preview failed to load — check the URL (and CORS)'
          : done
            ? 'Preview loaded · z4 sample tiles'
            : 'Loading preview…'}
      </div>
    </div>
  );
}

function AdvancedSettingsDialog({ 
  onClose, 
  knownSources,
  onUpdateSources,
  basemapUrl,
  onBasemapChange,
  basemapMinZoom,
  basemapMaxZoom,
  onBasemapZoomRangeChange,
}: { 
  onClose: () => void;
  knownSources: KnownSource[];
  onUpdateSources: (sources: KnownSource[]) => void;
  basemapUrl: string;
  onBasemapChange: (url: string) => void;
  basemapMinZoom?: number;
  basemapMaxZoom?: number;
  onBasemapZoomRangeChange: (minZoom?: number, maxZoom?: number) => void;
}) {
  const rasterSources = knownSources.filter(s => s.type !== 'vtile' && s.type !== 'wfs' && s.type !== 'stac');
  const vectorSources = knownSources.filter(s => s.type === 'vtile' || s.type === 'wfs' || s.type === 'stac');

  // Raster sources state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<'wmts' | 'wms' | 'xyz'>('wmts');
  const [editUrl, setEditUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'wmts' | 'wms' | 'xyz'>('wmts');
  const [newUrl, setNewUrl] = useState('');
  const [addTesting, setAddTesting] = useState(false);
  const [addError, setAddError] = useState('');
  const [editTesting, setEditTesting] = useState(false);
  const [editError, setEditError] = useState('');

  // Vector sources state
  const [showVAddForm, setShowVAddForm] = useState(false);
  const [vEditingId, setVEditingId] = useState<string | null>(null);
  const [vEditName, setVEditName] = useState('');
  const [vEditUrl, setVEditUrl] = useState('');
  const [vNewName, setVNewName] = useState('');
  const [vNewUrl, setVNewUrl] = useState('');
  const [vNewType, setVNewType] = useState<'vtile' | 'wfs' | 'stac'>('vtile');
  const [vNewExtra, setVNewExtra] = useState(''); // WFS type name or STAC collection id
  const [vEditType, setVEditType] = useState<'vtile' | 'wfs' | 'stac'>('vtile');
  const [vEditExtra, setVEditExtra] = useState('');

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    
    // XYZ sources don't need validation
    if (newType === 'xyz') {
      const newSource: KnownSource = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: newName.trim(),
        type: newType,
        url: newUrl.trim(),
      };
      onUpdateSources([...knownSources, newSource]);
      setNewName('');
      setNewUrl('');
      setShowAddForm(false);
      return;
    }
    
    // WMS and WMTS need validation
    setAddTesting(true);
    setAddError('');
    
    try {
      const response = await fetch(newUrl.trim());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const text = await response.text();
      
      // Validate based on type
      if (newType === 'wmts') {
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Contents || !capabilities.Contents.Layer) {
          throw new Error('Invalid WMTS capabilities document');
        }
      } else if (newType === 'wms') {
        const parser = new WMSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Capability) {
          throw new Error('Invalid WMS capabilities document');
        }
      }
      
      const newSource: KnownSource = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: newName.trim(),
        type: newType,
        url: newUrl.trim(),
      };
      onUpdateSources([...knownSources, newSource]);
      setNewName('');
      setNewUrl('');
      setShowAddForm(false);
    } catch (error: any) {
      setAddError(error.message || 'Failed to validate URL');
    } finally {
      setAddTesting(false);
    }
  };

  const handleEdit = async () => {
    if (!editingId || !editName.trim() || !editUrl.trim()) return;
    
    // XYZ sources don't need validation
    if (editType === 'xyz') {
      onUpdateSources(knownSources.map(s => 
        s.id === editingId ? { ...s, name: editName.trim(), type: editType, url: editUrl.trim() } : s
      ));
      setEditingId(null);
      setEditName('');
      setEditUrl('');
      return;
    }
    
    // WMS and WMTS need validation
    setEditTesting(true);
    setEditError('');
    
    try {
      const response = await fetch(editUrl.trim());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const text = await response.text();
      
      // Validate based on type
      if (editType === 'wmts') {
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Contents || !capabilities.Contents.Layer) {
          throw new Error('Invalid WMTS capabilities document');
        }
      } else if (editType === 'wms') {
        const parser = new WMSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Capability) {
          throw new Error('Invalid WMS capabilities document');
        }
      }
      
      onUpdateSources(knownSources.map(s => 
        s.id === editingId ? { ...s, name: editName.trim(), type: editType, url: editUrl.trim() } : s
      ));
      setEditingId(null);
      setEditName('');
      setEditUrl('');
      setEditError('');
    } catch (error: any) {
      setEditError(error.message || 'Failed to validate URL');
    } finally {
      setEditTesting(false);
    }
  };

  const handleRemove = (id: string) => {
    onUpdateSources(knownSources.filter(s => s.id !== id));
  };

  const startEdit = (source: KnownSource) => {
    setEditingId(source.id);
    setEditName(source.name);
    setEditType(source.type as 'wmts' | 'wms' | 'xyz');
    setEditUrl(source.url);
  };

  // Vector sources handlers
  const handleVAdd = () => {
    if (!vNewName.trim() || !vNewUrl.trim()) return;
    // WFS/STAC need their extra identifier (type name / collection id)
    if (vNewType !== 'vtile' && !vNewExtra.trim()) return;
    const newSource: KnownSource = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      name: vNewName.trim(),
      type: vNewType,
      url: vNewUrl.trim(),
      ...(vNewType === 'wfs' ? { wfsTypeName: vNewExtra.trim() } : {}),
      ...(vNewType === 'stac' ? { stacCollection: vNewExtra.trim() } : {}),
    };
    onUpdateSources([...knownSources, newSource]);
    setVNewName('');
    setVNewUrl('');
    setVNewType('vtile');
    setVNewExtra('');
    setShowVAddForm(false);
  };

  const handleVEdit = () => {
    if (!vEditingId || !vEditName.trim() || !vEditUrl.trim()) return;
    if (vEditType !== 'vtile' && !vEditExtra.trim()) return;
    onUpdateSources(knownSources.map(s =>
      s.id === vEditingId ? {
        ...s,
        name: vEditName.trim(),
        type: vEditType,
        url: vEditUrl.trim(),
        wfsTypeName: vEditType === 'wfs' ? vEditExtra.trim() : undefined,
        stacCollection: vEditType === 'stac' ? vEditExtra.trim() : undefined,
      } : s
    ));
    setVEditingId(null);
    setVEditName('');
    setVEditUrl('');
    setVEditType('vtile');
    setVEditExtra('');
  };

  const handleVRemove = (id: string) => {
    onUpdateSources(knownSources.filter(s => s.id !== id));
  };

  const startVEdit = (source: KnownSource) => {
    setVEditingId(source.id);
    setVEditName(source.name);
    setVEditUrl(source.url);
    const t = (source.type === 'wfs' || source.type === 'stac') ? source.type : 'vtile';
    setVEditType(t);
    setVEditExtra(t === 'wfs' ? (source.wfsTypeName || '') : t === 'stac' ? (source.stacCollection || '') : '');
  };

  // ----- Basemap editing -----
  const [bmUrl, setBmUrl] = useState(basemapUrl);
  const [bmPreviewTemplate, setBmPreviewTemplate] = useState<string | null>(
    isValidTileTemplate(basemapUrl) ? basemapUrl.trim() : null
  );
  const [bmAppliedFlash, setBmAppliedFlash] = useState(false);
  const [bmMinZoom, setBmMinZoom] = useState(basemapMinZoom !== undefined ? String(basemapMinZoom) : '');
  const [bmMaxZoom, setBmMaxZoom] = useState(basemapMaxZoom !== undefined ? String(basemapMaxZoom) : '');

  // Debounce the live preview so we don't hammer the tile server while typing
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = bmUrl.trim();
      setBmPreviewTemplate(isValidTileTemplate(trimmed) ? trimmed : null);
    }, 350);
    return () => clearTimeout(timer);
  }, [bmUrl]);

  const bmTrimmed = bmUrl.trim();
  const bmInputValid = isValidTileTemplate(bmTrimmed);
  const bmDirty = bmTrimmed !== basemapUrl;

  const applyBasemap = (url: string) => {
    const trimmed = url.trim();
    if (!isValidTileTemplate(trimmed)) return;
    onBasemapChange(trimmed);
    setBmUrl(trimmed);
    setBmAppliedFlash(true);
    window.setTimeout(() => setBmAppliedFlash(false), 2200);
  };

  /** Live-apply a (valid) basemap tile zoom range. */
  const applyBasemapZoomRange = (minStr: string, maxStr: string) => {
    const min = parseZoomInput(minStr);
    const max = parseZoomInput(maxStr);
    if (min !== undefined && max !== undefined && min > max) return; // invalid pair — wait for a valid one
    onBasemapZoomRangeChange(min, max);
  };

  const bmRangeCustomized = basemapMinZoom !== undefined || basemapMaxZoom !== undefined;

  return (
    <div className="advanced-settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="advanced-settings-dialog">
        <div className="advanced-settings-header">
          <span className="advanced-settings-title">Advanced Settings</span>
          <button className="advanced-settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="advanced-settings-body">
          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <BasemapIcon />
              Edit Base Map
            </div>
            <p className="advanced-settings-section-desc">
              Change the background tile layer. Use an XYZ template with {'{z}'} / {'{x}'} / {'{y}'} placeholders — or a Bing-style {'{q}'} quadkey. The preview below updates as you type.
            </p>
            <input
              type="text"
              value={bmUrl}
              onChange={(e) => setBmUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyBasemap(bmUrl); }}
              placeholder="XYZ URL ({z}/{x}/{y} or {q} quadkey, e.g., https://tile.openstreetmap.org/{z}/{x}/{y}.png)"
              className="advanced-settings-input basemap-input"
              spellCheck={false}
            />
            <div className="basemap-presets">
              {BASEMAP_PRESETS.map(preset => (
                <button
                  key={preset.name}
                  type="button"
                  className={'basemap-preset-chip' + (bmTrimmed === preset.url ? ' active' : '')}
                  onClick={() => setBmUrl(preset.url)}
                  title={preset.url}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <BasemapPreview template={bmPreviewTemplate} />
            {bmTrimmed !== '' && !bmInputValid && (
              <div className="advanced-settings-error basemap-error">
                Not a valid tile template — the URL must start with http(s) and include {'{z}'}, {'{x}'} and {'{y}'} placeholders, or a {'{q}'} quadkey.
              </div>
            )}
            <TileZoomRangeControl
              minValue={bmMinZoom}
              maxValue={bmMaxZoom}
              onMinChange={(v) => { setBmMinZoom(v); applyBasemapZoomRange(v, bmMaxZoom); }}
              onMaxChange={(v) => { setBmMaxZoom(v); applyBasemapZoomRange(bmMinZoom, v); }}
              collapsible
              defaultOpen={bmRangeCustomized}
            />
            <div className="advanced-settings-form-buttons basemap-buttons">
              <button
                className="settings-button-primary"
                onClick={() => applyBasemap(bmUrl)}
                disabled={!bmInputValid || !bmDirty}
              >
                Apply
              </button>
              <button
                className="settings-button-secondary"
                onClick={() => {
                  applyBasemap(DEFAULT_BASEMAP_URL);
                  setBmMinZoom('');
                  setBmMaxZoom('');
                  onBasemapZoomRangeChange(undefined, undefined);
                }}
                disabled={!bmDirty && !bmRangeCustomized && basemapUrl === DEFAULT_BASEMAP_URL}
              >
                Reset to Default
              </button>
              {bmAppliedFlash ? (
                <span className="basemap-applied-note">Basemap updated ✓</span>
              ) : bmDirty && bmInputValid ? (
                <span className="basemap-dirty-note">Unsaved changes</span>
              ) : null}
            </div>
          </div>

          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <RasterIcon />
              Saved Raster Sources
            </div>
            <p className="advanced-settings-section-desc">Save WMS, WMTS, and XYZ URLs for quick access when adding raster layers.</p>
            {rasterSources.length === 0 ? (
              <p className="advanced-settings-placeholder">No sources added yet.</p>
            ) : (
              <div className="advanced-settings-sources-list">
                {rasterSources.map(source => (
                  editingId === source.id ? (
                    <div key={source.id} className="advanced-settings-source-edit">
                      <input
                        type="text"
                        placeholder="Source name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="advanced-settings-input"
                      />
                      <CustomSelect
                        value={editType}
                        onChange={(val) => setEditType(val as 'wmts' | 'wms' | 'xyz')}
                        className="advanced-settings-select"
                        options={[
                          { value: 'wmts', label: 'WMTS' },
                          { value: 'wms', label: 'WMS' },
                          { value: 'xyz', label: 'XYZ' },
                        ]}
                      />
                      <input
                        type="text"
                        placeholder={editType === 'xyz' ? 'XYZ URL ({z}/{x}/{y} or {q} quadkey)' : 'Capabilities URL'}
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        className="advanced-settings-input"
                      />
                      {editTesting && (
                        <div className="settings-loading-indicator">
                          <div className="settings-loading-spinner"></div>
                          <span>Testing connection...</span>
                        </div>
                      )}
                      {editError && (
                        <div className="advanced-settings-error">{editError}</div>
                      )}
                      <div className="advanced-settings-form-buttons">
                        <button className="settings-button-primary" onClick={handleEdit} disabled={editTesting}>
                          {editTesting ? 'Testing...' : 'Save'}
                        </button>
                        <button className="settings-button-secondary" onClick={() => setEditingId(null)} disabled={editTesting}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div key={source.id} className="advanced-settings-source-item">
                      <div className="advanced-settings-source-info">
                        <span className="advanced-settings-source-name">{source.name}</span>
                        <span className="advanced-settings-source-type">{source.type.toUpperCase()}</span>
                      </div>
                      <div className="advanced-settings-source-url">{source.url}</div>
                      <div className="advanced-settings-source-actions">
                        <button
                          className="advanced-settings-source-edit-btn"
                          onClick={() => startEdit(source)}
                          title="Edit"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="advanced-settings-source-remove-btn"
                          onClick={() => handleRemove(source.id)}
                          title="Remove"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {!showAddForm ? (
              <button
                className="advanced-settings-add-button"
                onClick={() => setShowAddForm(true)}
              >
                + Add Source
              </button>
            ) : (
              <div className="advanced-settings-source-edit">
                <input
                  type="text"
                  placeholder="Source name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="advanced-settings-input"
                />
                <CustomSelect
                  value={newType}
                  onChange={(val) => setNewType(val as 'wmts' | 'wms' | 'xyz')}
                  className="advanced-settings-select"
                  options={[
                    { value: 'wmts', label: 'WMTS' },
                    { value: 'wms', label: 'WMS' },
                    { value: 'xyz', label: 'XYZ' },
                  ]}
                />
                <input
                  type="text"
                  placeholder={newType === 'xyz' ? 'XYZ URL ({z}/{x}/{y} or {q} quadkey)' : 'Capabilities URL'}
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  className="advanced-settings-input"
                />
                {addTesting && (
                  <div className="settings-loading-indicator">
                    <div className="settings-loading-spinner"></div>
                    <span>Testing connection...</span>
                  </div>
                )}
                {addError && (
                  <div className="advanced-settings-error">{addError}</div>
                )}
                <div className="advanced-settings-form-buttons">
                  <button className="settings-button-primary" onClick={handleAdd} disabled={addTesting}>
                    {addTesting ? 'Testing...' : 'Add'}
                  </button>
                  <button className="settings-button-secondary" onClick={() => setShowAddForm(false)} disabled={addTesting}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <VectorIcon />
              Saved Vector Sources
            </div>
            <p className="advanced-settings-section-desc">Save MVT, WFS, or STAC endpoints for quick access when adding vector layers.</p>
            {vectorSources.length === 0 ? (
              <p className="advanced-settings-placeholder">No vector sources added yet.</p>
            ) : (
              <div className="advanced-settings-sources-list">
                {vectorSources.map(source => (
                  vEditingId === source.id ? (
                    <div key={source.id} className="advanced-settings-source-edit">
                      <CustomSelect
                        value={vEditType}
                        onChange={(val) => { setVEditType(val as 'vtile' | 'wfs' | 'stac'); }}
                        className="advanced-settings-select"
                        options={[
                          { value: 'vtile', label: 'MVT (Vector Tiles)' },
                          { value: 'wfs', label: 'WFS (Web Feature Service)' },
                          { value: 'stac', label: 'STAC (SpatioTemporal Asset Catalog)' },
                        ]}
                      />
                      <input
                        type="text"
                        placeholder="Source name"
                        value={vEditName}
                        onChange={(e) => setVEditName(e.target.value)}
                        className="advanced-settings-input"
                      />
                      <input
                        type="text"
                        placeholder={vEditType === 'wfs'
                          ? 'WFS URL (e.g., https://example.com/geoserver/wfs)'
                          : vEditType === 'stac'
                          ? 'STAC API URL (e.g., https://earth-search.aws.element84.com/v1)'
                          : 'MVT URL (e.g., https://example.com/tiles/{z}/{x}/{y}.pbf)'}
                        value={vEditUrl}
                        onChange={(e) => setVEditUrl(e.target.value)}
                        className="advanced-settings-input"
                      />
                      {vEditType === 'wfs' && (
                        <input
                          type="text"
                          placeholder="Type name (e.g., namespace:layername)"
                          value={vEditExtra}
                          onChange={(e) => setVEditExtra(e.target.value)}
                          className="advanced-settings-input"
                        />
                      )}
                      {vEditType === 'stac' && (
                        <input
                          type="text"
                          placeholder="Collection ID (e.g., sentinel-2-l2a)"
                          value={vEditExtra}
                          onChange={(e) => setVEditExtra(e.target.value)}
                          className="advanced-settings-input"
                        />
                      )}
                      <div className="advanced-settings-form-buttons">
                        <button
                          className="settings-button-primary"
                          onClick={handleVEdit}
                          disabled={vEditType !== 'vtile' && !vEditExtra.trim()}
                        >
                          Save
                        </button>
                        <button className="settings-button-secondary" onClick={() => setVEditingId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div key={source.id} className="advanced-settings-source-item">
                      <div className="advanced-settings-source-info">
                        <span className="advanced-settings-source-name">{source.name}</span>
                        <span className="advanced-settings-source-type">{source.type.toUpperCase()}</span>
                      </div>
                      <div className="advanced-settings-source-url">{source.url}</div>
                      {(source.wfsTypeName || source.stacCollection) && (
                        <div className="advanced-settings-source-url">
                          {source.type === 'wfs' ? 'Type: ' + source.wfsTypeName : 'Collection: ' + source.stacCollection}
                        </div>
                      )}
                      <div className="advanced-settings-source-actions">
                        <button
                          className="advanced-settings-source-edit-btn"
                          onClick={() => startVEdit(source)}
                          title="Edit"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="advanced-settings-source-remove-btn"
                          onClick={() => handleVRemove(source.id)}
                          title="Remove"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {!showVAddForm ? (
              <button
                className="advanced-settings-add-button"
                onClick={() => setShowVAddForm(true)}
              >
                + Add Vector Source
              </button>
            ) : (
              <div className="advanced-settings-source-edit">
                <CustomSelect
                  value={vNewType}
                  onChange={(val) => { setVNewType(val as 'vtile' | 'wfs' | 'stac'); }}
                  className="advanced-settings-select"
                  options={[
                    { value: 'vtile', label: 'MVT (Vector Tiles)' },
                    { value: 'wfs', label: 'WFS (Web Feature Service)' },
                    { value: 'stac', label: 'STAC (SpatioTemporal Asset Catalog)' },
                  ]}
                />
                <input
                  type="text"
                  placeholder="Source name"
                  value={vNewName}
                  onChange={(e) => setVNewName(e.target.value)}
                  className="advanced-settings-input"
                />
                <input
                  type="text"
                  placeholder={vNewType === 'wfs'
                    ? 'WFS URL (e.g., https://example.com/geoserver/wfs)'
                    : vNewType === 'stac'
                    ? 'STAC API URL (e.g., https://earth-search.aws.element84.com/v1)'
                    : 'MVT URL (e.g., https://example.com/tiles/{z}/{x}/{y}.pbf)'}
                  value={vNewUrl}
                  onChange={(e) => setVNewUrl(e.target.value)}
                  className="advanced-settings-input"
                />
                {vNewType === 'wfs' && (
                  <input
                    type="text"
                    placeholder="Type name (e.g., namespace:layername)"
                    value={vNewExtra}
                    onChange={(e) => setVNewExtra(e.target.value)}
                    className="advanced-settings-input"
                  />
                )}
                {vNewType === 'stac' && (
                  <input
                    type="text"
                    placeholder="Collection ID (e.g., sentinel-2-l2a)"
                    value={vNewExtra}
                    onChange={(e) => setVNewExtra(e.target.value)}
                    className="advanced-settings-input"
                  />
                )}
                <div className="advanced-settings-form-buttons">
                  <button
                    className="settings-button-primary"
                    onClick={handleVAdd}
                    disabled={vNewType !== 'vtile' && !vNewExtra.trim()}
                  >
                    Add
                  </button>
                  <button className="settings-button-secondary" onClick={() => setShowVAddForm(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}



type GoToMethod = 'zxy' | 'latlng' | 'address';

function GoToBar({ onGoTo }: { onGoTo: (center: [number, number], zoom: number) => void }) {
  const [method, setMethod] = useState<GoToMethod>('zxy');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAddressSearch = async (query: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!response.ok) {
        throw new Error('Search request failed');
      }
      const results = await response.json();
      if (!results || results.length === 0) {
        setError('No results found');
        return;
      }
      const result = results[0];
      const lat = parseFloat(result.lat);
      const lon = parseFloat(result.lon);

      // Compute zoom from bounding box if available
      let zoom = 15;
      if (result.boundingbox) {
        const south = parseFloat(result.boundingbox[0]);
        const north = parseFloat(result.boundingbox[1]);
        const west = parseFloat(result.boundingbox[2]);
        const east = parseFloat(result.boundingbox[3]);
        const latDiff = north - south;
        const lonDiff = east - west;
        const maxDiff = Math.max(latDiff, lonDiff);
        if (maxDiff > 0) {
          zoom = Math.max(1, Math.min(18, Math.floor(Math.log2(360 / maxDiff)) - 1));
        }
      }

      onGoTo([lon, lat], zoom);
    } catch (err: any) {
      setError(err?.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = input.trim();
    if (!trimmed) return;

    if (method === 'zxy') {
      const match = trimmed.match(/^(\d+)\/(\d+)\/(\d+)$/);
      if (!match) {
        setError('Format: z/x/y');
        return;
      }
      const z = parseInt(match[1], 10);
      const x = parseInt(match[2], 10);
      const y = parseInt(match[3], 10);

      if (z < 0 || z > 25) {
        setError('Zoom must be 0-25');
        return;
      }
      const maxTile = Math.pow(2, z);
      if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) {
        setError('Tile out of range');
        return;
      }

      const n = Math.pow(2, z);
      const lon = (x + 0.5) / n * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
      const lat = latRad * 180 / Math.PI;

      onGoTo([lon, lat], z);
    } else if (method === 'latlng') {
      const match = trimmed.match(/^(-?[\d.]+)[,\s]+(-?[\d.]+)$/);
      if (!match) {
        setError('Format: lat,lng');
        return;
      }
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);

      if (lat < -90 || lat > 90) {
        setError('Lat must be -90 to 90');
        return;
      }
      if (lng < -180 || lng > 180) {
        setError('Lng must be -180 to 180');
        return;
      }

      onGoTo([lng, lat], 15);
    } else {
      // address search
      handleAddressSearch(trimmed);
    }
  };

  const placeholders: Record<GoToMethod, string> = {
    zxy: 'z/x/y e.g. 11/1811/1236',
    latlng: 'lat,lng e.g. -34.111,138.222',
    address: 'Search address...',
  };

  return (
    <form className={`goto-bar${method === 'address' ? ' goto-bar-address' : ''}`} onSubmit={handleSubmit} onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <CustomSelect
        className="goto-select"
        value={method}
        onChange={val => { setMethod(val as GoToMethod); setError(''); setInput(''); }}
        options={[
          { value: 'zxy', label: 'ZXY' },
          { value: 'latlng', label: 'LatLng' },
          { value: 'address', label: 'Address' },
        ]}
      />
      <div className={`goto-input-wrapper${method === 'address' ? ' goto-input-wide' : ''}`}>
        <input
          className={`goto-input${error ? ' goto-input-error' : ''}`}
          type="text"
          placeholder={placeholders[method]}
          value={input}
          onChange={e => { setInput(e.target.value); setError(''); }}
          disabled={loading}
        />
        {input && !loading && (
          <button
            type="button"
            className="goto-clear"
            onClick={() => { setInput(''); setError(''); }}
            title="Clear"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
        {loading && (
          <span className="goto-spinner" />
        )}
      </div>
      <button className="goto-button" type="submit" title="Go" disabled={loading}>
        {loading ? (
          <span className="goto-button-spinner" />
        ) : (
          method === 'address' ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          )
        )}
      </button>
      {error && <span className="goto-error">{error}</span>}
    </form>
  );
}

// DrawToolbar component
function DrawToolbar({ 
  activeTool, 
  onToolSelect 
}: { 
  activeTool: 'line' | 'polygon' | 'rectangle' | 'label' | null;
  onToolSelect: (tool: 'line' | 'polygon' | 'rectangle' | 'label' | null) => void;
}) {
  const tools = [
    {
      id: 'line' as const,
      title: 'Draw Line',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="19" x2="19" y2="5" />
        </svg>
      ),
    },
    {
      id: 'polygon' as const,
      title: 'Draw Polygon',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8.5 18 21 6 21 2 8.5" />
        </svg>
      ),
    },
    {
      id: 'rectangle' as const,
      title: 'Draw Rectangle',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="1" />
        </svg>
      ),
    },
    {
      id: 'label' as const,
      title: 'Add Label',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </svg>
      ),
    },
  ];

  return (
    <div className="draw-toolbar" onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      {tools.map((tool) => (
        <button
          key={tool.id}
          className={`draw-toolbar-button ${activeTool === tool.id ? 'active' : ''}`}
          onClick={() => onToolSelect(activeTool === tool.id ? null : tool.id)}
          title={tool.title}
        >
          {tool.icon}
        </button>
      ))}
    </div>
  );
}

// Label Input Dialog component - appears at map position for label text entry
function LabelInputDialog({
  pixel,
  onApply,
  onCancel,
}: {
  pixel: [number, number];
  onApply: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus the input when dialog appears
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleApply = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onApply(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  // Calculate position, keeping dialog within viewport bounds
  const dialogWidth = 260;
  const dialogHeight = 90;
  const mapEl = document.getElementById('map');
  const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;

  let left = pixel[0] + 12;
  let top = pixel[1] - 20;

  if (mapRect) {
    // Ensure dialog stays within map bounds
    if (left + dialogWidth > mapRect.width) {
      left = pixel[0] - dialogWidth - 12;
    }
    if (top + dialogHeight > mapRect.height) {
      top = mapRect.height - dialogHeight - 10;
    }
    if (top < 10) {
      top = 10;
    }
    if (left < 10) {
      left = 10;
    }
  }

  return (
    <div
      className="label-input-dialog"
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        zIndex: 10,
      }}
    >
      <div className="label-input-dialog-title">Enter Label</div>
      <input
        ref={inputRef}
        type="text"
        className="label-input-dialog-input"
        placeholder="Label text..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={100}
      />
      <div className="label-input-dialog-buttons">
        <button className="label-input-dialog-btn label-input-dialog-btn-apply" onClick={handleApply} disabled={!text.trim()}>
          Apply
        </button>
        <button className="label-input-dialog-btn label-input-dialog-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Reusable style controls for drawn features (opacity is layer-level, so it is
// only shown for the global style, not per-feature overrides).
function DrawStyleEditor({
  style,
  onChange,
  showOpacity,
}: {
  style: DrawStyle;
  onChange: (style: DrawStyle) => void;
  showOpacity: boolean;
}) {
  return (
    <>
      {showOpacity && (
        <div className="settings-slider-row">
          <label className="settings-slider-label">Opacity</label>
          <input
            type="range"
            min="0"
            max="100"
            value={style.opacity}
            className="settings-slider"
            onChange={(e) => onChange({ ...style, opacity: parseInt(e.target.value, 10) })}
          />
          <span className="settings-slider-value">{style.opacity}%</span>
        </div>
      )}
      <div className="settings-slider-row">
        <label className="settings-slider-label">Line width</label>
        <input
          type="range"
          min="1"
          max="10"
          value={style.lineWidth}
          className="settings-slider"
          onChange={(e) => onChange({ ...style, lineWidth: parseInt(e.target.value, 10) })}
        />
        <span className="settings-slider-value">{style.lineWidth}px</span>
      </div>
      <ColorAlphaEditor
        label="Line color"
        value={style.lineColor}
        defaultAlpha={1}
        onChange={(val) => onChange({ ...style, lineColor: val })}
      />
      <ColorAlphaEditor
        label="Fill color"
        value={style.fillColor}
        defaultAlpha={0.2}
        onChange={(val) => onChange({ ...style, fillColor: val })}
      />
      <div className="settings-slider-row">
        <label className="settings-slider-label">Font size</label>
        <input
          type="range"
          min="8"
          max="32"
          value={style.fontSize}
          className="settings-slider"
          onChange={(e) => onChange({ ...style, fontSize: parseInt(e.target.value, 10) })}
        />
        <span className="settings-slider-value">{style.fontSize}px</span>
      </div>
      <ColorAlphaEditor
        label="Font color"
        value={style.fontColor}
        defaultAlpha={1}
        onChange={(val) => onChange({ ...style, fontColor: val })}
      />
    </>
  );
}

// Expandable per-feature style row used for drawn-in-app vector layers.
function VectorFeatureStyleItem({
  feature,
  index,
  onApply,
}: {
  feature: any;
  index: number;
  onApply: (feature: any, style: DrawStyle) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [style, setStyle] = useState<DrawStyle>(() =>
    feature._drawStyle ? { ...feature._drawStyle } : { ...DEFAULT_DRAW_STYLE }
  );

  const labelText = feature.get ? feature.get('labelText') : undefined;
  const geom = feature.getGeometry ? feature.getGeometry() : null;
  const geomType = geom ? geom.getType() : 'Feature';
  const featName = feature._drawName || (labelText ? 'Label: ' + labelText : geomType + ' ' + (index + 1));

  return (
    <div className="drawn-features-item-block">
      <div
        className={`drawn-features-item ${expanded ? 'active' : ''}`}
        onClick={() => {
          if (!expanded) {
            setStyle(feature._drawStyle ? { ...feature._drawStyle } : { ...DEFAULT_DRAW_STYLE });
          }
          setExpanded(!expanded);
        }}
      >
        <span className={`drawn-features-item-chevron ${expanded ? 'expanded' : ''}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </span>
        <span className="drawn-features-item-swatch" style={{ background: style.fillColor, borderColor: style.lineColor }} />
        <span className="drawn-features-item-name">{featName}</span>
      </div>
      {expanded && (
        <div className="drawn-features-feature-editor">
          <DrawStyleEditor
            style={style}
            onChange={(s) => { setStyle(s); onApply(feature, s); }}
            showOpacity={false}
          />
        </div>
      )}
    </div>
  );
}

// DrawnFeaturesPanel component
function DrawnFeaturesPanel({
  drawnFeatures,
  expanded,
  onToggle,
  onRemove,
  onSaveToLayers,
  onExport,
  drawStyle,
  onDrawStyleChange,
  onFeatureStyleChange,
}: {
  drawnFeatures: Array<{ id: string; type: string; name: string; feature: any; style: DrawStyle; customized: boolean }>;
  expanded: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  onSaveToLayers: (layerName: string) => void;
  onExport: (format: 'geojson' | 'kml') => void;
  drawStyle: DrawStyle;
  onDrawStyleChange: (style: DrawStyle) => void;
  onFeatureStyleChange: (id: string, style: DrawStyle) => void;
}) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [layerName, setLayerName] = useState('');
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  const [expandedFeatureId, setExpandedFeatureId] = useState<string | null>(null);

  return (
    <div className={`drawn-features-panel ${expanded ? 'expanded' : ''}`}>
      <div className="drawn-features-header" onClick={onToggle}>
        <span className="drawn-features-title">
          Drawn Features
          {drawnFeatures.length > 0 && (
            <span className="drawn-features-count">{drawnFeatures.length}</span>
          )}
        </span>
        <span className={`drawn-features-chevron ${expanded ? 'expanded' : ''}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </div>
      {expanded && (
        <div className="drawn-features-body">
          {drawnFeatures.length === 0 ? (
            <div className="drawn-features-empty">No features drawn yet</div>
          ) : (
            <div className="drawn-features-list">
              {drawnFeatures.map((item) => (
                <div key={item.id} className="drawn-features-item-block">
                  <div
                    className={`drawn-features-item ${expandedFeatureId === item.id ? 'active' : ''}`}
                    onClick={() => setExpandedFeatureId(expandedFeatureId === item.id ? null : item.id)}
                  >
                    <span className={`drawn-features-item-chevron ${expandedFeatureId === item.id ? 'expanded' : ''}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                    </span>
                    <span
                      className="drawn-features-item-swatch"
                      style={{ background: item.style.fillColor, borderColor: item.style.lineColor }}
                    />
                    <span className="drawn-features-item-name">{item.name}</span>
                    {item.customized && (
                      <span className="drawn-features-customized-dot" title="Custom style" />
                    )}
                    <button
                      className="drawn-features-item-remove"
                      onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                      title="Remove feature"
                    >
                      &times;
                    </button>
                  </div>
                  {expandedFeatureId === item.id && (
                    <div className="drawn-features-feature-editor">
                      <DrawStyleEditor
                        style={item.style}
                        onChange={(s) => onFeatureStyleChange(item.id, s)}
                        showOpacity={false}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="drawn-features-style">
            <div className="drawn-features-style-header" onClick={() => setShowStyleEditor(!showStyleEditor)}>
              <span className="drawn-features-style-title">New feature style</span>
              <span className="drawn-features-style-swatches">
                <span className="drawn-features-style-swatch" style={{ background: drawStyle.lineColor }} title="Line color" />
                <span className="drawn-features-style-swatch" style={{ background: drawStyle.fillColor }} title="Fill color" />
              </span>
              <span className={`drawn-features-chevron ${showStyleEditor ? 'expanded' : ''}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </div>
            {showStyleEditor && (
              <div className="drawn-features-style-body">
                <DrawStyleEditor style={drawStyle} onChange={onDrawStyleChange} showOpacity={true} />
              </div>
            )}
          </div>

          {drawnFeatures.length > 0 && (
            <>
              <div className="drawn-features-layer-name">
                <input
                  type="text"
                  className="drawn-features-name-input"
                  placeholder="Layer name (optional)"
                  value={layerName}
                  onChange={(e) => setLayerName(e.target.value)}
                />
              </div>
              <div className="drawn-features-actions">
                <button
                  className="drawn-features-btn drawn-features-btn-save"
                  onClick={() => onSaveToLayers(layerName.trim())}
                  disabled={drawnFeatures.length === 0}
                  title="Add to vector layers"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                  Save to Layers
                </button>
                <div className="drawn-features-export-wrapper">
                  <button
                    className="drawn-features-btn drawn-features-btn-export"
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    disabled={drawnFeatures.length === 0}
                    title="Export features"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Export
                  </button>
                  {showExportMenu && (
                    <div className="drawn-features-export-menu">
                      <button onClick={() => { onExport('geojson'); setShowExportMenu(false); }}>
                        Export as GeoJSON
                      </button>
                      <button onClick={() => { onExport('kml'); setShowExportMenu(false); }}>
                        Export as KML
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MouseCoordinateDisplay({ 
  coordinate, 
  projection, 
  onProjectionChange,
  decimals,
  onDecimalsChange
}: { 
  coordinate: [number, number] | null; 
  projection: string;
  onProjectionChange: (proj: string) => void;
  decimals: number;
  onDecimalsChange: (decimals: number) => void;
}) {
  let coordContent: React.ReactNode;
  
  if (coordinate) {
    if (projection === 'EPSG:4326') {
      const [lon, lat] = toLonLat(coordinate);
      coordContent = (
        <>
          <span className="coord-label">Lat: </span>
          <span className="coord-value">{lat.toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Lng: </span>
          <span className="coord-value">{lon.toFixed(decimals)}</span>
        </>
      );
    } else {
      coordContent = (
        <>
          <span className="coord-label">X: </span>
          <span className="coord-value">{coordinate[0].toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Y: </span>
          <span className="coord-value">{coordinate[1].toFixed(decimals)}</span>
        </>
      );
    }
  } else {
    coordContent = <span className="coord-label">Move mouse over map</span>;
  }

  return (
    <div className="mouse-coordinate-display" onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <span className="mouse-coordinate-text">{coordContent}</span>
      <CustomSelect
        className="mouse-coordinate-select"
        value={projection}
        onChange={(val) => {
          onProjectionChange(val);
          onDecimalsChange(val === 'EPSG:4326' ? 6 : 3);
        }}
        options={[
          { value: 'EPSG:4326', label: 'EPSG:4326' },
          { value: 'EPSG:3857', label: 'EPSG:3857' },
        ]}
      />
      <label className="mouse-coordinate-label">Decimal:</label>
      <input
        type="number"
        className="mouse-coordinate-spinbox"
        min="3"
        max="10"
        value={decimals}
        onChange={(e) => onDecimalsChange(parseInt(e.target.value, 10))}
      />
    </div>
  );
}

function MapPage() {
  const zoomRef = useRef<HTMLDivElement>(null);
  const attributionRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const gridLayerRef = useRef<TileLayer<any> | null>(null);
  const basemapLayerRef = useRef<TileLayer<any> | null>(null);
  const rasterLayersRef = useRef<Map<string, any>>(new Map());
  const vectorLayersRef = useRef<Map<string, any>>(new Map());
  // Maps an OL vector layer object to its display name so the once-registered
  // map click handler can label popup sections with the current layer names.
  const vectorLayerNamesRef = useRef<Map<any, string>>(new Map());
  const storedSettings = useRef(loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPinned, setSettingsPinned] = useState(storedSettings.current.settingsPinned);
  const settingsWrapperRef = useRef<HTMLDivElement>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [knownSources, setKnownSources] = useState<KnownSource[]>(() => loadKnownSources());

  const handleUpdateKnownSources = (sources: KnownSource[]) => {
    setKnownSources(sources);
    saveKnownSources(sources);
  };
  const [showGrid, setShowGrid] = useState(storedSettings.current.showGrid);
  const [showDrawToolbar, setShowDrawToolbar] = useState(storedSettings.current.showDrawToolbar);
  const [showCoordinates, setShowCoordinates] = useState(storedSettings.current.showCoordinates);
  const [showBasemap, setShowBasemap] = useState(storedSettings.current.showBasemap);
  const [basemapUrl, setBasemapUrl] = useState<string>(storedSettings.current.basemapUrl);
  const [basemapMinZoom, setBasemapMinZoom] = useState<number | undefined>(storedSettings.current.basemapMinZoom);
  const [basemapMaxZoom, setBasemapMaxZoom] = useState<number | undefined>(storedSettings.current.basemapMaxZoom);
  const appliedBasemapKeyRef = useRef<string>(
    basemapSourceKey(storedSettings.current.basemapUrl, storedSettings.current.basemapMinZoom, storedSettings.current.basemapMaxZoom)
  );
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>(storedSettings.current.rasterLayers);
  const [vectorLayers, setVectorLayers] = useState<VectorLayerConfig[]>([]);
  const [isRestoringLayers, setIsRestoringLayers] = useState(storedSettings.current.rasterLayers.length > 0 || storedSettings.current.vectorLayers.length > 0);
  const [isDragging, setIsDragging] = useState(false);
  const [popupContent, setPopupContent] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<[number, number] | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const popupOverlayRef = useRef<Overlay | null>(null);
  const [activeDrawTool, setActiveDrawTool] = useState<'line' | 'polygon' | 'rectangle' | 'label' | null>(null);
  // Mirrors activeDrawTool for the once-registered map click handler (its closure
  // only ever sees the initial state value).
  const activeDrawToolRef = useRef<'line' | 'polygon' | 'rectangle' | 'label' | null>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const drawSourceRef = useRef<VectorSource | null>(null);
  const drawLayerRef = useRef<VectorLayer<any> | null>(null);
  const [drawStyle, setDrawStyle] = useState<DrawStyle>(DEFAULT_DRAW_STYLE);
  const drawStyleRef = useRef<DrawStyle>(DEFAULT_DRAW_STYLE);
  const [drawnFeatures, setDrawnFeatures] = useState<Array<{
    id: string;
    type: 'LineString' | 'Polygon' | 'Point';
    name: string;
    feature: any;
    style: DrawStyle;
    customized: boolean;
  }>>([]);
  const [showDrawnPanel, setShowDrawnPanel] = useState(false);
  const [labelDialogState, setLabelDialogState] = useState<{
    pixel: [number, number];
    feature: any;
    featureId: string;
  } | null>(null);
  const [mouseCoord, setMouseCoord] = useState<[number, number] | null>(null);
  const [coordProjection, setCoordProjection] = useState<string>('EPSG:4326');
  const [coordDecimals, setCoordDecimals] = useState<number>(6);




  useEffect(() => {
    if (!zoomRef.current || !attributionRef.current) {
      return;
    }

    const zoomControl = new Zoom({ target: zoomRef.current });
    const attributionControl = new Attribution({
      target: attributionRef.current,
      collapsible: false,
    });
    const scaleLineControl = new ScaleLine();

    const { center, zoom } = getInitialView();

    const mapview = new View({
      center: center,
      zoom: zoom,
      minZoom: 2,
      maxZoom: 25,
    });

    const map = new OLMap({
      target: 'map',
      controls: defaultControls({ zoom: false, attribution: false }).extend([
        zoomControl,
        attributionControl,
        scaleLineControl,
      ]),
      layers: [
        new TileLayer({
          source: createBasemapSource(
            storedSettings.current.basemapUrl,
            storedSettings.current.basemapMinZoom,
            storedSettings.current.basemapMaxZoom,
          ),
        }),
      ],
      view: mapview,
    });

    // Store reference to the basemap layer for toggle
    basemapLayerRef.current = map.getLayers().getArray()[0] as TileLayer<any>;

    mapRef.current = map;

    // Patch all layers to prevent filter bleeding
    // This ensures layers with colour filters don't affect other layers
    map.getLayers().getArray().forEach((layer: any) => {
      // Patch immediately if renderer is ready
      if (layer.getRenderer()) {
        patchLayerRenderer(layer);
      }
    });

    // Automatically patch any new layers as they're added
    map.getLayers().on('add', (event: any) => {
      const layer = event.element;
      // Patch when renderer is ready (may be async)
      const patchWhenReady = () => {
        if (layer.getRenderer()) {
          patchLayerRenderer(layer);
        } else {
          // Retry after a short delay
          setTimeout(patchWhenReady, 100);
        }
      };
      patchWhenReady();
    });

    // Track mouse coordinates on the map
    map.on('pointermove', (evt) => {
      if (evt.dragging) return;
      setMouseCoord(evt.coordinate as [number, number]);
    });

    // Setup drawing layer with style function
    const drawSource = new VectorSource();
    
    const drawLayerStyle = (feature: any) => {
      const labelText = feature.get('labelText');
      const ds = drawStyleRef.current;
      const line = rgbaToString(parseColor(ds.lineColor, 1));
      const fill = rgbaToString(parseColor(ds.fillColor, 0.2));
      const fontColor = rgbaToString(parseColor(ds.fontColor, 1));
      const baseStyle = new Style({
        fill: new Fill({ color: fill }),
        stroke: new Stroke({ color: line, width: ds.lineWidth }),
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: line }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
        }),
      });
      
      if (labelText) {
        return new Style({
          fill: new Fill({ color: fill }),
          stroke: new Stroke({ color: line, width: ds.lineWidth }),
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: line }),
            stroke: new Stroke({ color: '#fff', width: 2 }),
          }),
          text: new Text({
            text: labelText,
            font: ds.fontSize + 'px Arial',
            fill: new Fill({ color: fontColor }),
            stroke: new Stroke({ color: '#fff', width: 3 }),
            offsetY: -15,
          }),
        });
      }
      
      return baseStyle;
    };
    
    const drawLayer = new VectorLayer({
      source: drawSource,
      style: drawLayerStyle,
    });
    drawLayer.setZIndex(9999);
    drawLayer.set('_isDrawLayer', true);
    map.addLayer(drawLayer);
    drawSourceRef.current = drawSource;
    drawLayerRef.current = drawLayer;


    // Setup popup overlay - create element in JS to avoid React/OL DOM conflicts
    const popupEl = document.createElement('div');
    popupEl.className = 'map-popup';
    popupEl.style.display = 'none';
    
    const closerBtn = document.createElement('button');
    closerBtn.className = 'popup-closer';
    closerBtn.innerHTML = '&times;';
    closerBtn.onclick = () => {
      setPopupContent(null);
      setPopupPosition(null);
    };
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'popup-content';

    // Footer with master collapse/expand controls — only shown when the
    // popup contains more than one feature (toggled in the content effect).
    const footerEl = document.createElement('div');
    footerEl.className = 'popup-footer';
    footerEl.style.display = 'none';
    footerEl.innerHTML =
      '<button type="button" class="popup-footer-btn" data-popup-action="collapse-all">Collapse all</button>' +
      '<button type="button" class="popup-footer-btn popup-footer-btn-solid" data-popup-action="show-all">Show all</button>';

    popupEl.appendChild(closerBtn);
    popupEl.appendChild(contentDiv);
    popupEl.appendChild(footerEl);

    // Delegated click handling for the collapsible feature blocks and the
    // footer buttons (content is swapped via innerHTML, so listeners must
    // live on the persistent popup element).
    popupEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const actionEl = target.closest('[data-popup-action]') as HTMLElement | null;
      if (actionEl) {
        const collapse = actionEl.getAttribute('data-popup-action') === 'collapse-all';
        popupEl.querySelectorAll('.popup-feature').forEach(f => f.classList.toggle('collapsed', collapse));
        return;
      }
      const headerEl = target.closest('.popup-feature-header') as HTMLElement | null;
      if (headerEl) {
        const featureEl = headerEl.closest('.popup-feature');
        if (featureEl) featureEl.classList.toggle('collapsed');
      }
    });

    // Add popup element to the map container
    
    const popupOverlay = new Overlay({
      element: popupEl,
      autoPan: true,
      positioning: 'bottom-center',
      offset: [0, -12],
    });
    map.addOverlay(popupOverlay);
    popupOverlayRef.current = popupOverlay;
    popupRef.current = popupEl;

    // Click handler for vector layer features — shows info for *every*
    // feature under the clicked point, grouped by layer (topmost first).
    map.on('click', (evt) => {
      // While a draw tool is active, clicks place vertices — suppress the
      // feature-info popup so drawing isn't interrupted by it.
      if (activeDrawToolRef.current !== null) return;

      // Collect all features at the pixel, grouped by layer in topmost-first
      // order. A single feature can be reported more than once (one per style
      // part, e.g. stroke + fill), so dedupe by feature identity.
      const hitsByLayer = new Map<any, Array<{ feature: any; metadata: Record<string, any> }>>();
      const seenFeatures = new Set<any>();

      map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
        if (!layer || seenFeatures.has(feature)) return;
        seenFeatures.add(feature);

        const properties = feature.getProperties();
        const metadata: Record<string, any> = {};
        Object.keys(properties).forEach(key => {
          const value = properties[key];
          if (key === 'geometry') return;
          if (typeof value === 'object' && value !== null && value.getType) return;
          metadata[key] = value;
        });
        if (Object.keys(metadata).length === 0) return;

        if (!hitsByLayer.has(layer)) hitsByLayer.set(layer, []);
        hitsByLayer.get(layer)!.push({ feature, metadata });
      });

      if (hitsByLayer.size === 0) {
        setPopupContent(null);
        setPopupPosition(null);
        return;
      }

      const totalFeatures = Array.from(hitsByLayer.values())
        .reduce((count, entries) => count + entries.length, 0);
      const collapsible = totalFeatures > 1;

      const renderRows = (metadata: Record<string, any>) =>
        Object.entries(metadata)
          .map(([key, value]) =>
            '<div class="popup-row"><strong>' + escapeHtml(key) + ':</strong> ' + escapeHtml(String(value)) + '</div>')
          .join('');

      const renderFeatureBlock = (title: string, metadata: Record<string, any>) =>
        '<div class="popup-feature">' +
          '<button type="button" class="popup-feature-header">' +
            '<span class="popup-feature-title-text">' + escapeHtml(title) + '</span>' +
          '</button>' +
          '<div class="popup-feature-body">' + renderRows(metadata) + '</div>' +
        '</div>';

      const sections: string[] = [];
      hitsByLayer.forEach((entries, layer) => {
        const layerName =
          vectorLayerNamesRef.current.get(layer) ||
          (layer.get && layer.get('_isDrawLayer') ? 'Drawing' : 'Layer');

        if (!collapsible) {
          // Single feature overall — plain, non-collapsible section.
          sections.push(
            '<div class="popup-section">' +
              '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
              renderRows(entries[0].metadata) +
            '</div>'
          );
          return;
        }

        if (entries.length === 1) {
          // One feature from this layer — the layer name heads its block.
          sections.push(
            '<div class="popup-section">' + renderFeatureBlock(layerName, entries[0].metadata) + '</div>'
          );
          return;
        }

        // Several features from the same layer — static group title plus one
        // collapsible block per feature.
        const blocks = entries.map(({ feature, metadata }, index) =>
          renderFeatureBlock(popupFeatureLabel(feature, index), metadata)
        );
        sections.push(
          '<div class="popup-section">' +
            '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
            blocks.join('') +
          '</div>'
        );
      });

      setPopupContent(sections.join(''));
      setPopupPosition(evt.coordinate as [number, number]);
    });

    map.on('moveend', () => updateUrlParams(mapview));

    // Restore layers from localStorage
    (async () => {
    const restoredRasterLayers: RasterLayer[] = [];
    for (const layerConfig of storedSettings.current.rasterLayers) {
      try {
        let olLayer: any;
        let extent: number[] | null = null;

        if (layerConfig.type === 'wmts') {
          const response = await fetch(layerConfig.wmtsCapabilitiesUrl || layerConfig.url);
          const text = await response.text();
          const parser = new WMTSCapabilities();
          const capabilities = parser.read(text);
          
          const wmtsOptions = optionsFromCapabilities(capabilities, {
            layer: layerConfig.wmtsLayer || '',
          });
          
          if (!wmtsOptions) {
            throw new Error('Failed to create WMTS options from capabilities');
          }
          
          extent = extractWmtsExtent(capabilities, layerConfig.wmtsLayer || '');
          olLayer = new TileLayer({
            source: createWmtsSource(wmtsOptions, layerConfig.minZoom, layerConfig.maxZoom),
          });
        } else if (layerConfig.type === 'wms') {
          // Fetch capabilities to extract extent
          try {
            const response = await fetch(layerConfig.wmsCapabilitiesUrl || layerConfig.url);
            const text = await response.text();
            const parser = new WMSCapabilities();
            const capabilities = parser.read(text);
            extent = extractWmsExtent(capabilities, layerConfig.wmsLayer || '');
          } catch (capError) {
            console.warn('Failed to fetch WMS capabilities for extent during restore:', capError);
          }

          olLayer = new ImageLayer({
            source: new ImageWMS({
              url: extractBaseUrl(layerConfig.wmsCapabilitiesUrl || layerConfig.url),
              params: { LAYERS: layerConfig.wmsLayer || '' },
              ratio: 1,
              serverType: 'geoserver',
            }),
          });
        } else {
          olLayer = new TileLayer({
            source: createXYZSource(layerConfig.url, layerConfig.minZoom, layerConfig.maxZoom),
          });
        }

        olLayer.setVisible(layerConfig.visible !== false);
        map.addLayer(olLayer);
        rasterLayersRef.current.set(layerConfig.id, olLayer);
        // Apply saved color adjustments for restored layers
        if (layerConfig.brightness !== undefined || layerConfig.saturation !== undefined ||
            layerConfig.contrast !== undefined || layerConfig.opacity !== undefined) {
          const adjLayer = olLayer;
          map.once('rendercomplete', () => {
            applyColorAdjustments(adjLayer, {
              brightness: layerConfig.brightness,
              saturation: layerConfig.saturation,
              contrast: layerConfig.contrast,
              opacity: layerConfig.opacity,
            });
          });
        }
        restoredRasterLayers.push({ ...layerConfig, olLayer, ...(extent ? { extent } : {}) });
      } catch (error) {
        console.error('Failed to restore raster layer:', error);
      }
    }

    // Restore MVT vector layers from localStorage
    const restoredMvtLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'mvt')
      .forEach((layerConfig) => {
        try {
          const source = new VectorTileSource({
            format: new MVT(),
            url: layerConfig.url || '',
          });

          const olLayer = new VectorTileLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);

          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          
          // Re-apply any persisted tile zoom range
          applyVectorLayerZoomRange(olLayer, 'mvt', layerConfig.minZoom, layerConfig.maxZoom);
          // Add to restored layers with OL layer reference
          restoredMvtLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore MVT layer:', error);
        }
      });
    // Restore WFS vector layers from localStorage
    const restoredWfsLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'wfs')
      .forEach((layerConfig) => {
        try {
          const wfsUrl = buildWfsUrl(layerConfig.url || '', layerConfig.wfsTypeName || '');
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: (extent: any, resolution: any, projection: any) => {
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' })))
                .catch(e => console.error('WFS restore error:', e));
            },
          });
          const olLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          applyVectorLayerZoomRange(olLayer, 'wfs', layerConfig.minZoom, layerConfig.maxZoom);
          restoredWfsLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore WFS layer:', error);
        }
      });

    // Restore STAC vector layers from localStorage
    const restoredStacLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'stac')
      .forEach((layerConfig) => {
        try {
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: () => {
              fetchAllStacItems(layerConfig.url || '', layerConfig.stacCollection || '', layerConfig.stacLimit)
                .then(data => source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' })))
                .catch(e => console.error('STAC restore error:', e));
            },
          });
          const olLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          applyVectorLayerZoomRange(olLayer, 'stac', layerConfig.minZoom, layerConfig.maxZoom);
          restoredStacLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore STAC layer:', error);
        }
      });

    
    // Restore drawn-in-app vector layers from localStorage
    const restoredDrawnLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.isDrawnInApp && layer.drawnGeoJson)
      .forEach((layerConfig) => {
        try {
          const geojsonFormat = new GeoJSON();
          const features = geojsonFormat.readFeatures(layerConfig.drawnGeoJson, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
          });
          // Re-attach per-feature style/name and apply each feature's own style
          features.forEach((f: any, i: number) => {
            const meta = layerConfig.drawnFeatureMeta?.[i];
            if (meta) {
              f._drawStyle = meta.style;
              f._drawName = meta.name;
            }
            const ds = f._drawStyle || DEFAULT_DRAW_STYLE;
            f.setStyle(buildDrawFeatureStyle(ds, f.get('labelText')));
          });
          const source = new VectorSource({ features });
          const olLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(layerConfig),
            visible: layerConfig.visible !== false,
          });
          olLayer.setOpacity((layerConfig.opacity ?? 100) / 100);
          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          // Re-apply any persisted visibility zoom range
          applyVectorLayerZoomRange(olLayer, layerConfig.type, layerConfig.minZoom, layerConfig.maxZoom);
          restoredDrawnLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore drawn layer:', error);
        }
      });

    // Set state with all restored layers
    const restoredVectorLayers = [...restoredMvtLayers, ...restoredWfsLayers, ...restoredStacLayers, ...restoredDrawnLayers];
    setRasterLayers(restoredRasterLayers);
    setVectorLayers(restoredVectorLayers);
    if (restoredRasterLayers.length > 0 || restoredVectorLayers.length > 0) {
      reorderLayers(map, restoredRasterLayers, restoredVectorLayers);
    }
    setIsRestoringLayers(false);
    })();

    return () => {
      if (zoomRef.current) {
        zoomRef.current.innerHTML = '';
      }
      if (attributionRef.current) {
        attributionRef.current.innerHTML = '';
      }
      if (popupOverlayRef.current) {
        map.removeOverlay(popupOverlayRef.current);
        popupOverlayRef.current = null;
      }
      map.setTarget(undefined);
    };
  }, []);

  useEffect(() => {
    saveSettings({ settingsPinned, showBasemap, basemapUrl, basemapMinZoom, basemapMaxZoom, showGrid, showDrawToolbar, showCoordinates, rasterLayers, vectorLayers });
  }, [settingsPinned, showBasemap, basemapUrl, basemapMinZoom, basemapMaxZoom, showGrid, showDrawToolbar, showCoordinates, rasterLayers, vectorLayers]);

  // Close the Settings panel when the user clicks anywhere outside of it,
  // unless it has been pinned open with the pin button in its header.
  useEffect(() => {
    if (!showSettings || settingsPinned) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // Clicks inside the wrapper (dialog + gear button) have their own handlers
      if (settingsWrapperRef.current && settingsWrapperRef.current.contains(target)) return;
      // Keep Settings open while the Advanced Settings overlay (opened from it) is in use
      if (target.closest('.advanced-settings-overlay')) return;
      // CustomSelect dropdowns render their menus in a portal on document.body,
      // so the menu lives outside the wrapper even when the select itself is
      // inside the Settings dialog — don't treat clicks on it as outside clicks.
      if (target.closest('.custom-select-menu-portal')) return;
      setShowSettings(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [showSettings, settingsPinned]);

  // Update popup position and content
  useEffect(() => {
    if (popupOverlayRef.current && popupPosition && popupContent) {
      popupOverlayRef.current.setPosition(popupPosition);
      if (popupRef.current) {
        // Must be 'flex' (not 'block'): the popup is a flex column so the
        // content scrolls while the Collapse/Show-all footer stays pinned to
        // the bottom. An inline 'block' would override the stylesheet and let
        // a tall content area push the footer out of the clipped popup.
        popupRef.current.style.display = 'flex';
        const contentDiv = popupRef.current.querySelector('.popup-content');
        if (contentDiv) {
          contentDiv.innerHTML = popupContent;
        }
        // Collapse/Show-all footer only applies to multi-feature popups.
        const footer = popupRef.current.querySelector('.popup-footer') as HTMLElement | null;
        if (footer) {
          const isMulti = !!(contentDiv && contentDiv.querySelector('.popup-feature'));
          footer.style.display = isMulti ? 'flex' : 'none';
        }
      }
    } else if (popupOverlayRef.current) {
      popupOverlayRef.current.setPosition(undefined);
      if (popupRef.current) {
        popupRef.current.style.display = 'none';
      }
    }
  }, [popupPosition, popupContent]);

  useEffect(() => {
    if (!mapRef.current) return;

    if (showGrid) {
      const gridLayer = new TileLayer({
        source: new TileDebug(),
      });
      mapRef.current.addLayer(gridLayer);
      gridLayerRef.current = gridLayer;
      reorderLayers(mapRef.current, rasterLayers, vectorLayers);
    } else {
      if (gridLayerRef.current) {
        mapRef.current.removeLayer(gridLayerRef.current);
        gridLayerRef.current = null;
      }
    }
  }, [showGrid]);

  useEffect(() => {
    if (basemapLayerRef.current) {
      basemapLayerRef.current.setVisible(showBasemap);
    }
  }, [showBasemap]);

  // Swap the basemap tile source live when the user edits the basemap URL
  useEffect(() => {
    if (!basemapLayerRef.current) return;
    const key = basemapSourceKey(basemapUrl, basemapMinZoom, basemapMaxZoom);
    if (appliedBasemapKeyRef.current === key) return;
    appliedBasemapKeyRef.current = key;
    basemapLayerRef.current.setSource(createBasemapSource(basemapUrl, basemapMinZoom, basemapMaxZoom));
  }, [basemapUrl, basemapMinZoom, basemapMaxZoom]);

  // Keep the draw-mode ref in sync so the map click handler always sees the
  // current tool (the handler is registered once and can't read state directly).
  useEffect(() => {
    activeDrawToolRef.current = activeDrawTool;
  }, [activeDrawTool]);

  // Keep the OL-layer → display-name map in sync so popup sections can be
  // labelled with the current vector layer names.
  useEffect(() => {
    const names = new Map<any, string>();
    vectorLayers.forEach(cfg => {
      if (cfg.olLayer) names.set(cfg.olLayer, cfg.name);
    });
    vectorLayerNamesRef.current = names;
  }, [vectorLayers]);

  // Auto-open panel when entering draw mode
  useEffect(() => {
    if (activeDrawTool !== null) {
      setShowDrawnPanel(true);
    }
  }, [activeDrawTool]);

  // Clear drawing interaction and unsaved geometry when toolbar is hidden
  useEffect(() => {
    if (!showDrawToolbar) {
      // Remove active draw interaction
      if (activeDrawTool !== null) {
        if (drawInteractionRef.current && mapRef.current) {
          mapRef.current.removeInteraction(drawInteractionRef.current);
          drawInteractionRef.current = null;
        }
        setActiveDrawTool(null);
      }
      // Clear unsaved drawn features from the map
      if (drawSourceRef.current) {
        drawSourceRef.current.clear();
      }
      setDrawnFeatures([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrawToolbar]);

  /** Apply a new tile zoom range live (XYZ: swap source; WMTS: clamp the matrix grid). */
  const handleApplyTileZoomRange = (layerId: string, minZoom?: number, maxZoom?: number) => {
    const layer = rasterLayers.find(l => l.id === layerId);
    const olLayer = rasterLayersRef.current.get(layerId);
    if (!layer || !olLayer) return;
    if (layer.type === 'xyz') {
      olLayer.setSource(createXYZSource(layer.url, minZoom, maxZoom));
    } else if (layer.type === 'wmts') {
      const grid: any = olLayer.getSource()?.getTileGrid?.();
      if (!grid) return;
      // Remember the native matrix range so clearing the fields restores it
      if (!olLayer._nativeTileZoomRange) {
        olLayer._nativeTileZoomRange = { min: grid.getMinZoom(), max: grid.getMaxZoom() };
      }
      const native = olLayer._nativeTileZoomRange;
      grid.minZoom = minZoom !== undefined ? Math.max(native.min, Math.min(minZoom, native.max)) : native.min;
      grid.maxZoom = maxZoom !== undefined ? Math.min(native.max, Math.max(maxZoom, grid.minZoom)) : native.max;
      if (grid.minZoom > grid.maxZoom) grid.minZoom = grid.maxZoom;
      olLayer.changed();
    } else {
      return;
    }
    setRasterLayers(prev => prev.map(l => (l.id === layerId ? { ...l, minZoom, maxZoom } : l)));
  };

  const handleEditRasterLayer = async (updated: RasterLayer) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      mapRef.current.removeLayer(olLayer);
      let newOlLayer: any;
      let extent: number[] | null = null;

      if (updated.type === 'wmts') {
        const response = await fetch(updated.wmtsCapabilitiesUrl || updated.url);
        const text = await response.text();
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        
        const wmtsOptions = optionsFromCapabilities(capabilities, {
          layer: updated.wmtsLayer || '',
        });
        
        if (!wmtsOptions) {
          throw new Error('Failed to create WMTS options from capabilities');
        }
        
        extent = extractWmtsExtent(capabilities, updated.wmtsLayer || '');
        newOlLayer = new TileLayer({
          source: createWmtsSource(wmtsOptions, updated.minZoom, updated.maxZoom),
        });
      } else if (updated.type === 'wms') {
        // Fetch capabilities to extract extent
        try {
          const response = await fetch(updated.wmsCapabilitiesUrl || updated.url);
          const text = await response.text();
          const parser = new WMSCapabilities();
          const capabilities = parser.read(text);
          extent = extractWmsExtent(capabilities, updated.wmsLayer || '');
        } catch (capError) {
          console.warn('Failed to fetch WMS capabilities for extent:', capError);
        }

        newOlLayer = new ImageLayer({
          source: new ImageWMS({
            url: extractBaseUrl(updated.wmsCapabilitiesUrl || updated.url),
            params: { LAYERS: updated.wmsLayer || '' },
            ratio: 1,
            serverType: 'geoserver',
          }),
        });
      } else {
        newOlLayer = new TileLayer({
          source: createXYZSource(updated.url, updated.minZoom, updated.maxZoom),
        });
      }

      mapRef.current.addLayer(newOlLayer);
      rasterLayersRef.current.set(updated.id, newOlLayer);
      const updatedWithRef = { ...updated, olLayer: newOlLayer, ...(extent ? { extent } : {}) };
      const newRasterLayers = rasterLayers.map(l => l.id === updated.id ? updatedWithRef : l);
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);

      // Re-apply color adjustments after layer recreation
      if (updated.brightness !== undefined || updated.saturation !== undefined ||
          updated.contrast !== undefined || updated.opacity !== undefined) {
        mapRef.current.once('rendercomplete', () => {
          applyColorAdjustments(newOlLayer, {
            brightness: updated.brightness,
            saturation: updated.saturation,
            contrast: updated.contrast,
            opacity: updated.opacity,
          });
        });
      }
    } catch (error) {
      console.error('Failed to edit raster layer:', error);
    }
  };

  const handleAddVectorLayer = async (file: File, layerName?: string) => {
    if (!mapRef.current) return;

    const fileName = file.name;
    const extension = fileName.split('.').pop()?.toLowerCase();
    
    if (!extension) {
      alert('Invalid file format');
      return;
    }

    let layerType: VectorLayerConfig['type'];
    let features: any[] = [];

    try {
      if (extension === 'geojson' || extension === 'json') {
        layerType = 'geojson';
        const text = await file.text();
        const geojsonData = JSON.parse(text);
        const format = new GeoJSON();
        
        // Check for CRS property in GeoJSON and register projection
        let dataProjection: string | Projection = 'EPSG:4326';
        if (geojsonData.crs) {
          const crsName = geojsonData.crs.properties?.name;
          if (crsName) {
            // Extract EPSG code from CRS name like "urn:ogc:def:crs:EPSG::4326"
            const epsgMatch = crsName.match(/EPSG::?(\d+)/);
            if (epsgMatch) {
              const epsgCode = epsgMatch[1];
              if (epsgCode !== '4326') {
                const registeredId = await registerProjectionFromEPSGCode(epsgCode);
                if (registeredId) {
                  dataProjection = registeredId;
                }
              }
            }
          }
        }
        
        features = format.readFeatures(text, {
          dataProjection: dataProjection,
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'kml') {
        layerType = 'kml';
        const text = await file.text();
        const format = new KML({
          extractStyles: true,
        });
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'kmz') {
        layerType = 'kmz';
        const zip = await JSZip.loadAsync(file);
        const kmlFile = Object.keys(zip.files).find(f => f.endsWith('.kml'));
        if (!kmlFile) {
          alert('No KML file found in KMZ archive');
          return;
        }
        const text = await zip.files[kmlFile].async('text');
        const format = new KML({
          extractStyles: true,
        });
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'zip') {
        layerType = 'shapefile';
        const shapefileResult = await parseShapefile(file);
        if (shapefileResult.features.length === 0) {
          alert('No features found in the shapefile');
          return;
        }

        // Register projection from .prj file if present
        let dataProjection: string | Projection = 'EPSG:4326';
        if (shapefileResult.projectionWKT) {
          const registeredId = await registerProjectionFromWKT(shapefileResult.projectionWKT);
          if (registeredId) {
            dataProjection = registeredId;
          }
        }

        // Debug: Log WKT projection
        console.log('=== SHAPEFILE DEBUG ===');
        console.log('[1] WKT from .prj file:', shapefileResult.projectionWKT);
        console.log('[2] Feature count:', shapefileResult.features.length);

        // Debug: Log source coordinates before transformation
        if (shapefileResult.features.length > 0) {
          const firstFeature = shapefileResult.features[0];
          const firstGeom = firstFeature.geometry;
          console.log('[3] First feature geometry type:', firstGeom.type);
          
          // Get coordinates based on geometry type
          let sourceCoords: any = null;
          if (firstGeom.type === 'Polygon') {
            sourceCoords = firstGeom.coordinates[0].slice(0, 5); // First 5 points of outer ring
          } else if (firstGeom.type === 'MultiPolygon') {
            sourceCoords = firstGeom.coordinates[0][0].slice(0, 5);
          } else if (firstGeom.type === 'LineString') {
            sourceCoords = firstGeom.coordinates.slice(0, 5);
          } else if (firstGeom.type === 'MultiLineString') {
            sourceCoords = firstGeom.coordinates[0].slice(0, 5);
          } else if (firstGeom.type === 'Point') {
            sourceCoords = firstGeom.coordinates;
          } else if (firstGeom.type === 'MultiPoint') {
            sourceCoords = firstGeom.coordinates.slice(0, 5);
          }
          console.log('[4] Source coordinates (from shapefile):', sourceCoords);
        }

        console.log('[5] dataProjection before readFeatures:', dataProjection);

        const geojsonFormat = new GeoJSON();
        features = geojsonFormat.readFeatures({
          type: 'FeatureCollection',
          features: shapefileResult.features
        }, {
          dataProjection: dataProjection,
          featureProjection: 'EPSG:3857',
        });

        // Debug: Log transformed coordinates
        if (features.length > 0) {
          const firstFeature = features[0];
          const geom = firstFeature.getGeometry();
          if (geom) {
            console.log('[6] OL geometry type:', geom.getType());
            const coords = geom.getCoordinates();
            
            // Get coordinates based on geometry type
            let transformedCoords: any = null;
            if (geom.getType() === 'Polygon') {
              transformedCoords = coords[0].slice(0, 5); // First 5 points of outer ring
            } else if (geom.getType() === 'MultiPolygon') {
              transformedCoords = coords[0][0].slice(0, 5);
            } else if (geom.getType() === 'LineString') {
              transformedCoords = coords.slice(0, 5);
            } else if (geom.getType() === 'MultiLineString') {
              transformedCoords = coords[0].slice(0, 5);
            } else if (geom.getType() === 'Point') {
              transformedCoords = coords;
            } else if (geom.getType() === 'MultiPoint') {
              transformedCoords = coords.slice(0, 5);
            }
            console.log('[7] Transformed coordinates (EPSG:3857):', transformedCoords);
            
            // Get extent
            const extent = geom.getExtent();
            console.log('[8] Feature extent (EPSG:3857):', extent);
          }
        }
        console.log('=== END SHAPEFILE DEBUG ===');
      } else {
        alert(`Unsupported file format: .${extension}`);
        return;
      }

      if (features.length === 0) {
        alert('No features found in the file');
        return;
      }

      const source = new VectorSource({
        features: features,
      });


      // Check if features have their own styles (KML/KMZ with extractStyles)
      const hasOwnStyles = features.some(f => f.getStyle && f.getStyle() !== null);

      // Start from a random color, then prefer the file's own style colors so the
      // color editor reflects the layer's actual appearance on the map.
      const randomColors = getRandomVectorColors();
      let lineColor = randomColors.lineColor;
      let fillColor = randomColors.fillColor;
      let lineWidth = 2;
      if (hasOwnStyles) {
        const styled = features.find(f => f.getStyle && f.getStyle());
        let st: any = styled && styled.getStyle();
        if (Array.isArray(st)) st = st[0];
        if (st && typeof st.getStroke === 'function') {
          const stroke = st.getStroke();
          const fill = st.getFill();
          if (stroke && stroke.getColor() != null) {
            lineColor = normalizeOlColor(stroke.getColor(), 1);
            if (stroke.getWidth() != null) lineWidth = stroke.getWidth();
          }
          if (fill && fill.getColor() != null) {
            fillColor = normalizeOlColor(fill.getColor(), 0.3);
          }
        }
      }

      const olLayer = new VectorLayer({
        source: source,
        style: hasOwnStyles ? undefined : buildVectorStyle({ lineColor, fillColor, lineWidth }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: layerName && layerName.trim() ? layerName.trim() : fileName.replace(/\.(geojson|json|kml|kmz|zip)$/i, ''),
        type: layerType!,
        visible: true,
        opacity: 100,
        lineColor,
        lineWidth,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer };
      setVectorLayers(prev => [...prev, layerConfigWithRef]);

      // Fit map to features extent
      const extent = source.getExtent();
      if (extent && extent.every(v => isFinite(v))) {
        mapRef.current.getView().fit(extent, {
          padding: [50, 50, 50, 50],
          maxZoom: 18,
        });
      }
    } catch (error) {
      console.error('Failed to load vector layer:', error);
      alert(`Failed to load "${fileName}". The file may be corrupted or in an unsupported format.`);
    }
  };

  const handleAddMVTLayer = async (url: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const source = new VectorTileSource({
        format: new MVT(),
        url: url,
      });

      const { lineColor, fillColor } = getRandomVectorColors();

      const olLayer = new VectorTileLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        type: 'mvt',
        visible: true,
        olLayer: olLayer,
        url: url,
        opacity: 100,
        lineColor,
        lineWidth: 2,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);

      // Reorder layers
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load MVT layer:', error);
      alert(`Failed to load MVT layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleAddWFSLayer = async (url: string, typeName: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const wfsUrl = buildWfsUrl(url, typeName);
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: (extent: any, resolution: any, projection: any) => {
          fetch(wfsUrl)
            .then(r => {
              if (!r.ok) throw new Error('WFS request failed: ' + r.status);
              return r.json();
            })
            .then(data => {
              const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
              source.addFeatures(features);
            })
            .catch(e => {
              console.error('WFS load error:', e);
              alert('Failed to load WFS features. Check the URL and type name.');
            });
        },
      });

      const olLayer = new VectorLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        type: 'wfs',
        visible: true,
        olLayer: olLayer,
        url: url,
        wfsTypeName: typeName,
        opacity: 100,
        lineColor,
        lineWidth: 2,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load WFS layer:', error);
      alert(`Failed to load WFS layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleAddSTACLayer = async (url: string, collection: string, name: string, limit?: number) => {
    if (!mapRef.current) return;

    try {
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: () => {
          fetchAllStacItems(url, collection, limit)
            .then(data => {
              const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
              source.addFeatures(features);
            })
            .catch(e => {
              console.error('STAC load error:', e);
              alert('Failed to load STAC items. Check the URL and collection ID.');
            });
        },
      });

      const olLayer = new VectorLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        type: 'stac',
        visible: true,
        olLayer: olLayer,
        url: url,
        stacCollection: collection,
        stacLimit: limit,
        opacity: 100,
        lineColor,
        lineWidth: 2,
        fillColor,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load STAC layer:', error);
      alert(`Failed to load STAC layer "${name}". The URL may be invalid or inaccessible.`);
    }
  };

  const handleToggleVectorLayer = (id: string) => {
    const olLayer = vectorLayersRef.current.get(id);
    if (!olLayer) return;

    setVectorLayers(prev =>
      prev.map(l => {
        if (l.id === id) {
          const newVisible = !l.visible;
          olLayer.setVisible(newVisible);
          return { ...l, visible: newVisible };
        }
        return l;
      })
    );
  };

  const handleRemoveVectorLayer = (id: string) => {
    if (!mapRef.current) return;

    const olLayer = vectorLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      vectorLayersRef.current.delete(id);
    }

    setVectorLayers(prev => prev.filter(l => l.id !== id));
  };

  const buildVectorStyle = (styleConfig: { lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    const lineWidth = styleConfig.lineWidth ?? 2;
    // Colors are stored as rgba strings; parseColor also accepts legacy hex.
    const line = rgbaToString(parseColor(styleConfig.lineColor, 1));
    const fill = rgbaToString(parseColor(styleConfig.fillColor, 0.3));
    const fontColor = rgbaToString(parseColor(styleConfig.fontColor, 1));
    const fontSize = styleConfig.fontSize ?? 14;

    // Return a per-feature style function so features carrying a label
    // (e.g. drawn features saved to a layer) render their text too.
    return (feature: any) => {
      const labelText = feature && feature.get ? feature.get('labelText') : undefined;
      const base = {
        fill: new Fill({ color: fill }),
        stroke: new Stroke({ color: line, width: lineWidth }),
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: line }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
        }),
      };
      if (labelText) {
        return new Style({
          ...base,
          text: new Text({
            text: labelText,
            font: fontSize + 'px Arial',
            fill: new Fill({ color: fontColor }),
            stroke: new Stroke({ color: '#fff', width: 3 }),
            offsetY: -15,
          }),
        });
      }
      return new Style(base);
    };
  };

  // Apply a style to a vector layer. KML/KMZ features carry their own styles which
  // take precedence over the layer style in OpenLayers, so we clear those per-feature
  // styles (once) to let the chosen layer style take effect.
  const applyVectorStyleToLayer = (olLayer: any, styleConfig: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    if (styleConfig.opacity !== undefined) {
      olLayer.setOpacity(styleConfig.opacity / 100);
    }
    olLayer.setStyle(buildVectorStyle(styleConfig));

    const source = olLayer.getSource && olLayer.getSource();
    if (source && typeof source.getFeatures === 'function') {
      // Only defined fields override the stored per-feature style.
      const defined: any = {};
      (Object.keys(styleConfig) as Array<keyof typeof styleConfig>).forEach(k => {
        if (styleConfig[k] !== undefined) defined[k] = styleConfig[k];
      });
      for (const f of source.getFeatures()) {
        const fs = f.getStyle && f.getStyle();
        if (fs !== undefined && fs !== null) {
          f.setStyle(undefined); // fall back to the layer style
        }
        if (f._drawStyle) {
          f._drawStyle = { ...f._drawStyle, ...defined };
        }
      }
    }
  };

  const handleApplyVectorStyle = (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    // Apply opacity + style (also overrides KML per-feature styles)
    applyVectorStyleToLayer(olLayer, style);

    // Update config in state (live preview)
    setVectorLayers(prev =>
      prev.map(l => {
        if (l.id === layerId) {
          return {
            ...l,
            opacity: style.opacity ?? l.opacity,
            lineColor: style.lineColor ?? l.lineColor,
            lineWidth: style.lineWidth ?? l.lineWidth,
            fillColor: style.fillColor ?? l.fillColor,
            fontColor: style.fontColor ?? l.fontColor,
            fontSize: style.fontSize ?? l.fontSize,
          };
        }
        return l;
      })
    );
  };

  // Live-update a vector layer's zoom range. MVT layers clamp tile requests;
  // other vector types use it as a visibility range.
  const handleApplyVectorZoomRange = (layerId: string, minZoom?: number, maxZoom?: number) => {
    const layer = vectorLayers.find(l => l.id === layerId);
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!layer || !olLayer) return;
    applyVectorLayerZoomRange(olLayer, layer.type, minZoom, maxZoom);
    setVectorLayers(prev => prev.map(l => (l.id === layerId ? { ...l, minZoom, maxZoom } : l)));
  };

  // Apply a style to a single feature of a drawn-in-app vector layer.
  const handleApplyVectorFeatureStyle = (layerId: string, feature: any, style: DrawStyle) => {
    if (!feature) return;
    feature._drawStyle = style;
    feature.setStyle(buildDrawFeatureStyle(style, feature.get && feature.get('labelText')));
  };

  const handleEditVectorLayer = async (updated: VectorLayerConfig) => {
    if (!mapRef.current) return;

    const olLayer = vectorLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      // MVT, WFS, and STAC layers support URL changes; file-based layers just update name
      if ((updated.type === 'mvt' || updated.type === 'wfs' || updated.type === 'stac') && updated.url) {
        mapRef.current.removeLayer(olLayer);

        let newOlLayer: any;
        if (updated.type === 'mvt') {
          const source = new VectorTileSource({
            format: new MVT(),
            url: updated.url,
          });
          newOlLayer = new VectorTileLayer({
            source: source,
            style: buildVectorStyle(updated),
            visible: updated.visible !== false,
          });
        } else if (updated.type === 'wfs') {
          const wfsUrl = buildWfsUrl(updated.url, updated.wfsTypeName || '');
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: (extent: any, resolution: any, projection: any) => {
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' })))
                .catch(e => console.error('WFS load error:', e));
            },
          });
          newOlLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(updated),
            visible: updated.visible !== false,
          });
        } else {
          // STAC
          const source = new VectorSource({
            format: new GeoJSON(),
            loader: () => {
              fetchAllStacItems(updated.url || '', updated.stacCollection || '', updated.stacLimit)
                .then(data => source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' })))
                .catch(e => console.error('STAC load error:', e));
            },
          });
          newOlLayer = new VectorLayer({
            source: source,
            style: buildVectorStyle(updated),
            visible: updated.visible !== false,
          });
        }
        newOlLayer.setOpacity((updated.opacity ?? 100) / 100);
        applyVectorLayerZoomRange(newOlLayer, updated.type, updated.minZoom, updated.maxZoom);
        mapRef.current.addLayer(newOlLayer);
        vectorLayersRef.current.set(updated.id, newOlLayer);

        const updatedWithRef = { ...updated, olLayer: newOlLayer };
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updatedWithRef : l);
        setVectorLayers(newVectorLayers);
        reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
      } else {
        // File-based layer: update name and apply style (overrides KML per-feature styles)
        applyVectorStyleToLayer(olLayer, { ...updated, opacity: updated.opacity ?? 100 });
        applyVectorLayerZoomRange(olLayer, updated.type, updated.minZoom, updated.maxZoom);
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updated : l);
        setVectorLayers(newVectorLayers);
      }
    } catch (error) {
      console.error('Failed to edit vector layer:', error);
    }
  };

  const handleReorderRasterLayers = (newLayers: RasterLayer[]) => {
    setRasterLayers(newLayers);
    if (mapRef.current) {
      reorderLayers(mapRef.current, newLayers, vectorLayers);
    }
  };

  const handleReorderVectorLayers = (newLayers: VectorLayerConfig[]) => {
    setVectorLayers(newLayers);
    if (mapRef.current) {
      reorderLayers(mapRef.current, rasterLayers, newLayers);
    }
  };

  const handleRemoveRasterLayer = (id: string) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      rasterLayersRef.current.delete(id);
    }
    const newLayers = rasterLayers.filter(l => l.id !== id);
    setRasterLayers(newLayers);
    reorderLayers(mapRef.current, newLayers, vectorLayers);
  };

  const handleToggleRasterLayer = (id: string) => {
    const olLayer = rasterLayersRef.current.get(id);
    if (!olLayer) return;

    setRasterLayers(prev =>
      prev.map(l => {
        if (l.id === id) {
          const newVisible = l.visible === false ? true : false;
          olLayer.setVisible(newVisible);
          return { ...l, visible: newVisible };
        }
        return l;
      })
    );
  };


  const handleDrawTool = (tool: 'line' | 'polygon' | 'rectangle' | 'label' | null) => {
    if (!mapRef.current || !drawSourceRef.current) return;

    // Remove existing draw interaction
    if (drawInteractionRef.current) {
      mapRef.current.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }

    // If same tool clicked, toggle off
    if (tool === activeDrawTool) {
      setActiveDrawTool(null);
      return;
    }

    setActiveDrawTool(tool);

    if (!tool) return;

    // Give each fresh drawing batch a random color, just like adding a vector
    // layer. Only re-roll when the batch is empty so in-progress work (and any
    // manually chosen style) keeps its color across tool switches.
    if (drawnFeatures.length === 0) {
      const { lineColor, fillColor } = getRandomVectorColors();
      handleDrawStyleChange({ ...drawStyleRef.current, lineColor, fillColor });
    }

    let drawType: any;
    let geometryFunction: any = undefined;

    if (tool === 'line') {
      drawType = 'LineString';
    } else if (tool === 'polygon') {
      drawType = 'Polygon';
    } else if (tool === 'rectangle') {
      drawType = 'Circle';
      geometryFunction = createBox();
    } else if (tool === 'label') {
      drawType = 'Point';
    }

    const drawInteraction = new Draw({
      source: drawSourceRef.current,
      type: drawType,
      geometryFunction: geometryFunction,
    });

    // Track features as they are drawn
    drawInteraction.on('drawend', (evt) => {
      const feature = evt.feature;
      const featureId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6);
      const geomType = feature.getGeometry()?.getType() || 'Unknown';
      
      // Each feature carries its own style, seeded from the current draw style.
      const initStyle = { ...drawStyleRef.current };
      feature.setStyle(buildDrawFeatureStyle(initStyle, feature.get('labelText')));
      (feature as any)._drawStyle = initStyle;
      
      if (tool === 'label') {
        // Get the pixel position of the drawn point for dialog placement
        const pointCoords = (feature.getGeometry() as any).getCoordinates();
        const pixel = mapRef.current!.getPixelFromCoordinate(pointCoords);
        
        // Show the in-app label dialog instead of browser prompt
        setLabelDialogState({
          pixel: pixel as [number, number],
          feature: feature,
          featureId: featureId,
        });
      } else {
        // Non-label features — compute name inside updater so we always see the latest list
        setDrawnFeatures(prev => {
          let displayName = '';
          if (tool === 'line') displayName = 'Line ' + (prev.filter(f => f.type === 'LineString').length + 1);
          else if (tool === 'polygon') displayName = 'Polygon ' + (prev.filter(f => f.type === 'Polygon' && !f.name.startsWith('Rectangle')).length + 1);
          else if (tool === 'rectangle') displayName = 'Rectangle ' + (prev.filter(f => f.name.startsWith('Rectangle')).length + 1);
          (feature as any)._drawName = displayName;
          
          return [...prev, {
            id: featureId,
            type: tool === 'rectangle' ? 'Polygon' : (geomType as any),
            name: displayName,
            feature: feature,
            style: initStyle,
            customized: false,
          }];
        });
      }
    });

    mapRef.current.addInteraction(drawInteraction);
    drawInteractionRef.current = drawInteraction;
  };

  const handleLabelDialogApply = (text: string) => {
    if (!labelDialogState) return;
    const { feature, featureId } = labelDialogState;
    
    feature.set('labelText', text);
    const initStyle = { ...drawStyleRef.current };
    feature.setStyle(buildDrawFeatureStyle(initStyle, text));
    (feature as any)._drawStyle = initStyle;
    (feature as any)._drawName = 'Label: ' + text;
    setDrawnFeatures(prev => [...prev, {
      id: featureId,
      type: 'Point',
      name: 'Label: ' + text,
      feature: feature,
      style: initStyle,
      customized: false,
    }]);
    setLabelDialogState(null);
  };

  const handleLabelDialogCancel = () => {
    if (!labelDialogState) return;
    const { feature } = labelDialogState;
    
    // Remove the feature from draw source since no label was provided
    if (drawSourceRef.current) {
      drawSourceRef.current.removeFeature(feature);
    }
    setLabelDialogState(null);
  };

  const handleExportVectorLayer = (layerId: string, format: 'geojson' | 'kml') => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    const source = olLayer.getSource();
    if (!source) return;

    const features = source.getFeatures().slice();
    if (features.length === 0) {
      alert('No features to export.');
      return;
    }

    const layerConfig = vectorLayers.find(l => l.id === layerId);
    const baseName = layerConfig?.name || 'export';
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'geojson') {
      const geojsonFormat = new GeoJSON();
      content = geojsonFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = safeName + '.geojson';
      mimeType = 'application/geo+json';
    } else {
      const kmlFormat = new KML({ extractStyles: false });
      content = kmlFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = safeName + '.kml';
      mimeType = 'application/vnd.google-earth.kml+xml';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleGoToRasterLayerExtent = (layerId: string) => {
    if (!mapRef.current) return;
    const layerConfig = rasterLayers.find(l => l.id === layerId);
    if (!layerConfig || !layerConfig.extent) return;

    const extent = layerConfig.extent;
    if (extent.length === 4 && extent.every((v: number) => isFinite(v))) {
      mapRef.current.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 18,
        duration: 500,
      });
    }
  };

  const handleGoToVectorLayerExtent = (layerId: string) => {
    if (!mapRef.current) return;
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;
    const source = olLayer.getSource();
    if (!source) return;
    const extent = source.getExtent();
    if (extent && extent.every((v: number) => isFinite(v))) {
      mapRef.current.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 18,
        duration: 500,
      });
    }
  };

  const handleRemoveDrawnFeature = (id: string) => {
    const featureToRemove = drawnFeatures.find(f => f.id === id);
    if (featureToRemove && drawSourceRef.current) {
      drawSourceRef.current.removeFeature(featureToRemove.feature);
    }
    setDrawnFeatures(prev => prev.filter(f => f.id !== id));
  };

  // Live-update the global draw style. Acts as the template for new features and
  // re-styles every feature that hasn't been individually customized.
  const handleDrawStyleChange = (newStyle: DrawStyle) => {
    setDrawStyle(newStyle);
    drawStyleRef.current = newStyle;
    const layer = drawLayerRef.current;
    if (layer) layer.setOpacity(newStyle.opacity / 100);
    setDrawnFeatures(prev => prev.map(item => {
      if (item.customized) return item;
      item.feature.setStyle(buildDrawFeatureStyle(newStyle, item.feature.get('labelText')));
      item.feature._drawStyle = newStyle;
      return { ...item, style: newStyle };
    }));
  };

  // Edit the style of a single drawn feature. Marks it as customized so the
  // global style no longer overrides it.
  const handleFeatureStyleChange = (id: string, newStyle: DrawStyle) => {
    setDrawnFeatures(prev => prev.map(item => {
      if (item.id !== id) return item;
      item.feature.setStyle(buildDrawFeatureStyle(newStyle, item.feature.get('labelText')));
      item.feature._drawStyle = newStyle;
      return { ...item, style: newStyle, customized: true };
    }));
  };

  const handleSaveDrawnToLayers = (layerName: string) => {
    if (drawnFeatures.length === 0 || !mapRef.current || !drawSourceRef.current) return;

    // Clone features from draw source
    const features = drawSourceRef.current.getFeatures().slice();
    if (features.length === 0) return;

    // Carry the currently edited draw style over to the saved layer.
    const ds = drawStyleRef.current;

    // Create a new vector layer with these features
    const source = new VectorSource({ features: features });
    const olLayer = new VectorLayer({
      source: source,
      style: buildVectorStyle({ lineColor: ds.lineColor, fillColor: ds.fillColor, lineWidth: ds.lineWidth, fontColor: ds.fontColor, fontSize: ds.fontSize }),
    });
    olLayer.setOpacity(ds.opacity / 100);

    mapRef.current.addLayer(olLayer);

    const layerConfig: VectorLayerConfig = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      name: layerName || ('Drawn Features ' + (vectorLayers.length + 1)),
      type: 'geojson',
      visible: true,
      olLayer: olLayer,
      isDrawnInApp: true,
      opacity: ds.opacity,
      lineColor: ds.lineColor,
      lineWidth: ds.lineWidth,
      fillColor: ds.fillColor,
      fontColor: ds.fontColor,
      fontSize: ds.fontSize,
    };

    vectorLayersRef.current.set(layerConfig.id, olLayer);
    setVectorLayers(prev => [...prev, layerConfig]);
    reorderLayers(mapRef.current, rasterLayers, [...vectorLayers, layerConfig]);

    // Clear drawn features from the draw layer
    drawSourceRef.current.clear();
    setDrawnFeatures([]);
  };

  const handleExportDrawnFeatures = (format: 'geojson' | 'kml') => {
    if (drawnFeatures.length === 0 || !drawSourceRef.current) return;

    const features = drawSourceRef.current.getFeatures().slice();
    if (features.length === 0) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'geojson') {
      const geojsonFormat = new GeoJSON();
      content = geojsonFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = 'drawn-features.geojson';
      mimeType = 'application/geo+json';
    } else {
      const kmlFormat = new KML({ extractStyles: false });
      content = kmlFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = 'drawn-features.kml';
      mimeType = 'application/vnd.google-earth.kml+xml';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleGoTo = (lonlat: [number, number], zoom: number) => {
    if (!mapRef.current) return;
    const view = mapRef.current.getView();
    const center = fromLonLat(lonlat);
    view.animate({ center, zoom, duration: 500 });
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    
    for (const file of files) {
      await handleAddVectorLayer(file);
    }
  };

  const handleApplyColorAdjustments = (layerId: string, adjustments: { brightness?: number; saturation?: number; contrast?: number; opacity?: number }) => {
    const olLayer = rasterLayersRef.current.get(layerId);
    if (!olLayer || !mapRef.current) return;

    // For immediate update, apply directly (no need to recreate the layer)
    applyColorAdjustments(olLayer, adjustments);
  };

  const handleAddRasterLayer = async (layerConfig: RasterLayer) => {
    if (!mapRef.current) return;

    try {
      let olLayer: any;
      let extent: number[] | null = null;

      if (layerConfig.type === 'wmts') {
        const response = await fetch(layerConfig.wmtsCapabilitiesUrl || layerConfig.url);
        const text = await response.text();
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        
        const wmtsOptions = optionsFromCapabilities(capabilities, {
          layer: layerConfig.wmtsLayer || '',
        });
        
        if (!wmtsOptions) {
          throw new Error('Failed to create WMTS options from capabilities');
        }
        
        extent = extractWmtsExtent(capabilities, layerConfig.wmtsLayer || '');
        olLayer = new TileLayer({
          source: createWmtsSource(wmtsOptions, layerConfig.minZoom, layerConfig.maxZoom),
        });
      } else if (layerConfig.type === 'wms') {
        // Fetch capabilities to extract extent
        try {
          const response = await fetch(layerConfig.wmsCapabilitiesUrl || layerConfig.url);
          const text = await response.text();
          const parser = new WMSCapabilities();
          const capabilities = parser.read(text);
          extent = extractWmsExtent(capabilities, layerConfig.wmsLayer || '');
        } catch (capError) {
          console.warn('Failed to fetch WMS capabilities for extent:', capError);
        }

        olLayer = new ImageLayer({
          source: new ImageWMS({
            url: extractBaseUrl(layerConfig.wmsCapabilitiesUrl || layerConfig.url),
            params: { LAYERS: layerConfig.wmsLayer || '' },
            ratio: 1,
            serverType: 'geoserver',
          }),
        });
      } else {
        olLayer = new TileLayer({
          source: createXYZSource(layerConfig.url, layerConfig.minZoom, layerConfig.maxZoom),
        });
      }

      olLayer.setVisible(layerConfig.visible !== false);
      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer, ...(extent ? { extent } : {}) };
      const newRasterLayers = [...rasterLayers, layerConfigWithRef];
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);

      // Apply saved color adjustments after layer is rendered
      if (layerConfig.brightness !== undefined || layerConfig.saturation !== undefined ||
          layerConfig.contrast !== undefined || layerConfig.opacity !== undefined) {
        mapRef.current.once('rendercomplete', () => {
          applyColorAdjustments(olLayer, {
            brightness: layerConfig.brightness,
            saturation: layerConfig.saturation,
            contrast: layerConfig.contrast,
            opacity: layerConfig.opacity,
          });
        });
      }
    } catch (error) {
      console.error('Failed to add raster layer:', error);
    }
  };

  return (
    <div 
      id="map" 
      className="map-container"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(66, 133, 244, 0.3)',
          border: '3px dashed #4285f4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          pointerEvents: 'none',
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '20px 40px',
            borderRadius: '8px',
            fontSize: '18px',
            fontWeight: 'bold',
            color: '#4285f4',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}>
            Drop vector files here
          </div>
        </div>
      )}
      <GoToBar onGoTo={handleGoTo} />
      {showCoordinates && <MouseCoordinateDisplay
        coordinate={mouseCoord}
        projection={coordProjection}
        onProjectionChange={setCoordProjection}
        decimals={coordDecimals}
        onDecimalsChange={setCoordDecimals}
      />}

      {showDrawToolbar && <DrawToolbar activeTool={activeDrawTool} onToolSelect={handleDrawTool} />}
      {showDrawToolbar && activeDrawTool !== null && (
        <DrawnFeaturesPanel
          drawnFeatures={drawnFeatures}
          expanded={showDrawnPanel}
          onToggle={() => setShowDrawnPanel(!showDrawnPanel)}
          onRemove={handleRemoveDrawnFeature}
          onSaveToLayers={handleSaveDrawnToLayers}
          onExport={handleExportDrawnFeatures}
          drawStyle={drawStyle}
          onDrawStyleChange={handleDrawStyleChange}
          onFeatureStyleChange={handleFeatureStyleChange}
        />
      )}
      {labelDialogState && (
        <LabelInputDialog
          pixel={labelDialogState.pixel}
          onApply={handleLabelDialogApply}
          onCancel={handleLabelDialogCancel}
        />
      )}
      <div ref={zoomRef} className="map-controls" />
      <div ref={attributionRef} className="map-attribution" />

      <div className="map-settings-wrapper" ref={settingsWrapperRef}>
        {showSettings && (
          <SettingsDialog 
            onClose={() => setShowSettings(false)} 
            pinned={settingsPinned}
            onPinToggle={setSettingsPinned}
            showBasemap={showBasemap}
            onBasemapToggle={setShowBasemap}
            showGrid={showGrid}
            onGridToggle={setShowGrid}
            showDrawToolbar={showDrawToolbar}
            onDrawToolbarToggle={setShowDrawToolbar}
            showCoordinates={showCoordinates}
            onCoordinatesToggle={setShowCoordinates}
            rasterLayers={rasterLayers}
            onAddRasterLayer={handleAddRasterLayer}
            onEditRasterLayer={handleEditRasterLayer}
            onRemoveRasterLayer={handleRemoveRasterLayer}
            onToggleRasterLayer={handleToggleRasterLayer}
            onApplyColorAdjustments={handleApplyColorAdjustments}
            onApplyTileZoomRange={handleApplyTileZoomRange}
            vectorLayers={vectorLayers}
            onToggleVectorLayer={handleToggleVectorLayer}
            onRemoveVectorLayer={handleRemoveVectorLayer}
            onEditVectorLayer={handleEditVectorLayer}
            onApplyVectorStyle={handleApplyVectorStyle}
            onApplyVectorZoomRange={handleApplyVectorZoomRange}
            onApplyVectorFeatureStyle={handleApplyVectorFeatureStyle}
            onReorderRasterLayers={handleReorderRasterLayers}
            onReorderVectorLayers={handleReorderVectorLayers}
            onAddVectorLayer={handleAddVectorLayer}
            onAddMVTLayer={handleAddMVTLayer}
            onAddWFSLayer={handleAddWFSLayer}
            onAddSTACLayer={handleAddSTACLayer}
            onExportVectorLayer={handleExportVectorLayer}
            onGoToVectorLayerExtent={handleGoToVectorLayerExtent}
            onGoToRasterLayerExtent={handleGoToRasterLayerExtent}
            onAdvancedSettings={() => setShowAdvancedSettings(true)}
            knownSources={knownSources}
            isRestoringLayers={isRestoringLayers}
          />
        )}
        <button
          className="map-settings-button"
          onClick={() => setShowSettings((prev) => !prev)}
          title="Settings"
        >
          <GearIcon />
        </button>
      </div>
      {showAdvancedSettings && (
        <AdvancedSettingsDialog 
          onClose={() => setShowAdvancedSettings(false)} 
          knownSources={knownSources}
          onUpdateSources={handleUpdateKnownSources}
          basemapUrl={basemapUrl}
          onBasemapChange={(url) => setBasemapUrl(url)}
          basemapMinZoom={basemapMinZoom}
          basemapMaxZoom={basemapMaxZoom}
          onBasemapZoomRangeChange={(min, max) => {
            setBasemapMinZoom(min);
            setBasemapMaxZoom(max);
          }}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/map" element={<MapPage />} />
      <Route path="/" element={<Navigate to="/map" replace />} />
    </Routes>
  );
}

export default App;
