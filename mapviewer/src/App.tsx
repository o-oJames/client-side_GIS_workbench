import './App.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import Cluster from 'ol/source/Cluster.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { Style, Fill, Stroke, Circle as CircleStyle, RegularShape, Text } from 'ol/style.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import Translate from 'ol/interaction/Translate.js';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom.js';
import { primaryAction } from 'ol/events/condition.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { getArea, getLength } from 'ol/sphere.js';
import JSZip from 'jszip';
import proj4 from 'proj4';
import { register as registerProj4 } from 'ol/proj/proj4.js';
import Projection from 'ol/proj/Projection.js';
import { parseShapefile, ShapefileResult } from './utils/shapefileParser';
import { registerProjectionFromWKT, registerProjectionFromEPSGCode } from './utils/projectionHelper';
import {
  WrongPasswordError,
  clearAppStorage,
  collectAppStorage,
  decryptAppData,
  encryptAppData,
  hasLockedVault,
  readVault,
  restoreAppStorage,
  writeVault,
} from './utils/appLock';
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
interface LayerGroup {
  id: string;
  name: string;
  expanded: boolean; // whether member layers are listed under the group header
  // Where an EMPTY group sits in the panel (groups with members are placed
  // at their first member's position in the layer list). null = top of the
  // list, a layer/group id = right after that item, undefined = end.
  afterId?: string | null;
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

/**
 * Result of a WMS GetFeatureInfo query: either a list of feature attribute
 * objects (parsed from a GeoJSON/JSON response) or raw text (for servers that
 * answer with text/plain, HTML, XML, ...).
 */
type WmsFeatureInfoResult =
  | { features: Array<Record<string, any>> }
  | { text: string };

/**
 * Issue a WMS GetFeatureInfo request for the given map position against an
 * ImageWMS-backed layer and return the parsed attributes.
 *
 * Uses the source's own getFeatureInfoUrl builder so the request matches the
 * exact image that is currently displayed (same bbox/size/crs). JSON/GeoJSON
 * responses are reduced to per-feature attribute objects; anything else is
 * returned verbatim as text so nothing is silently dropped.
 */
async function fetchWmsFeatureInfo(
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
  groupId?: string;      // id of the LayerGroup (folder) this layer belongs to, if any
  clusterPoints?: boolean;  // cluster point features together at low zoom (dense point datasets)
  clusterDistance?: number; // clustering distance in pixels (default 40)
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

/**
 * Inspect a vector layer's features and report how many are points.
 *
 * Used to decide whether the "Point clustering" option applies to a layer -
 * clustering only makes sense for point datasets. Looks through any Cluster
 * wrapper (or the stashed raw source) so it counts the real underlying
 * features rather than the generated cluster bubbles.
 */
function layerPointStats(olLayer: any): { total: number; pointCount: number } {
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

const STORAGE_KEY = 'mapviewer-settings';
const VIEW_STORAGE_KEY = 'mapviewer-view';
const WORKSPACES_KEY = 'mapviewer-workspaces';

// The workspace that owns the original (pre-workspaces) storage keys, so
// existing users keep their layers, basemap and settings after upgrading.
export const DEFAULT_WORKSPACE_ID = 'default';

export interface WorkspaceMeta {
  id: string;
  name: string;
}

export interface WorkspaceRegistry {
  workspaces: WorkspaceMeta[];
  activeId: string;
}

// Settings and the saved map view live under the legacy keys for the default
// workspace and under namespaced keys for every workspace created afterwards.
function settingsKeyFor(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? STORAGE_KEY : `${STORAGE_KEY}:${workspaceId}`;
}

function viewKeyFor(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? VIEW_STORAGE_KEY : `${VIEW_STORAGE_KEY}:${workspaceId}`;
}

function generateWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadWorkspaceRegistry(): WorkspaceRegistry {
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
    console.error('Failed to load workspace registry:', e);
  }
  return { workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default' }], activeId: DEFAULT_WORKSPACE_ID };
}

function saveWorkspaceRegistry(registry: WorkspaceRegistry) {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(registry));
  } catch (e) {
    console.error('Failed to save workspace registry:', e);
  }
}

/** Remove a workspace's persisted settings and view (never the registry). */
function deleteWorkspaceStorage(workspaceId: string) {
  try {
    localStorage.removeItem(settingsKeyFor(workspaceId));
    localStorage.removeItem(viewKeyFor(workspaceId));
  } catch (e) {
    console.error('Failed to delete workspace storage:', e);
  }
}

/** Copy one workspace's persisted settings and view into another ("Duplicate"). */
function copyWorkspaceStorage(sourceId: string, targetId: string) {
  try {
    const settings = localStorage.getItem(settingsKeyFor(sourceId));
    if (settings) localStorage.setItem(settingsKeyFor(targetId), settings);
    const view = localStorage.getItem(viewKeyFor(sourceId));
    if (view) localStorage.setItem(viewKeyFor(targetId), view);
  } catch (e) {
    console.error('Failed to copy workspace storage:', e);
  }
}

// Unit system used for drawing measurements and the map scale line.
type UnitsSystem = 'metric' | 'imperial';

interface StoredSettings {
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

/** Parse a persisted layer-group list, tolerating missing or legacy data. */
function sanitizeGroups(raw: any): LayerGroup[] {
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

function loadSettings(workspaceId: string = DEFAULT_WORKSPACE_ID): StoredSettings {
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
        ? parsed.vectorLayers.filter((layer: any) => layer.type === 'mvt' || layer.type === 'wfs' || layer.type === 'stac' || layer.isDrawnInApp)
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
    console.error('Failed to load settings from localStorage:', e);
  }
  return { settingsPinned: false, showBasemap: true, basemapUrl: DEFAULT_BASEMAP_URL, units: 'metric', showGrid: false, showDrawToolbar: true, showCoordinates: true, rasterLayers: [], rasterGroups: [], vectorLayers: [], vectorGroups: [] };
}

function saveSettings(settings: StoredSettings, workspaceId: string = DEFAULT_WORKSPACE_ID) {
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
            // Serialize the real features, not the generated cluster bubbles -
            // look through the Cluster wrapper when clustering is active.
            const serSource = olLayer._rawSource || olLayer.getSource();
            const feats = serSource.getFeatures();
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
    localStorage.setItem(settingsKeyFor(workspaceId), JSON.stringify(serializableSettings));
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
function getInitialView(workspaceId: string = DEFAULT_WORKSPACE_ID) {
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
    console.error('Failed to load view from localStorage:', e);
  }

  return { center: [14960009, -3001695], zoom: 4 };
}

function updateUrlParams(view: View, workspaceId: string = DEFAULT_WORKSPACE_ID) {
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

/** Padlock glyph for the app-lock button in the Settings footer. */
function LockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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

// The DrawStyle fields — used to keep foreign config keys (name, olLayer,
// persisted GeoJSON…) out of features' stored per-feature styles.
const DRAW_STYLE_KEYS: Array<keyof DrawStyle> = ['opacity', 'lineColor', 'lineWidth', 'fillColor', 'fontColor', 'fontSize'];

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

// ---------------------------------------------------------------------------
// Geodesic measurements for drawn features
//
// Lines show one label per segment (vertex-to-vertex distance); polygons and
// rectangles show one label per edge plus a filled chip with the enclosed
// area. Values are computed
// geodesically (ol/sphere) in the map projection and formatted with two
// decimals, switching m -> km and m^2 -> km^2 for large values.
// ---------------------------------------------------------------------------

// Font for on-map measurement labels (matches the app's monospace stack).
const MEASURE_FONT = '600 11px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
const MEASURE_FONT_AREA = '600 12px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
const MEASURE_TEXT_COLOR = '#263238';
const MEASURE_CHIP_BG = 'rgba(255, 255, 255, 0.92)';

function measureGeodesicLength(geom: any): number {
  return getLength(geom, { projection: 'EPSG:3857' });
}

function measureGeodesicArea(geom: any): number {
  return Math.abs(getArea(geom, { projection: 'EPSG:3857' }));
}

// Imperial conversion constants (exact international definitions).
const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;
const SQ_METERS_PER_SQ_FOOT = METERS_PER_FOOT * METERS_PER_FOOT;
const SQ_METERS_PER_SQ_MILE = METERS_PER_MILE * METERS_PER_MILE;

const MEASURE_NUMBER_OPTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

// Format a length in meters with 2 decimals — metric: m, switching to km from
// 1,000 m; imperial: ft, switching to mi from 5,280 ft (one mile).
function formatLength(meters: number, units: UnitsSystem): string {
  if (units === 'imperial') {
    if (meters >= METERS_PER_MILE) {
      return (meters / METERS_PER_MILE).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' mi';
    }
    return (meters / METERS_PER_FOOT).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' ft';
  }
  if (meters >= 1000) {
    return (meters / 1000).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' km';
  }
  return meters.toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' m';
}

// Format an area in square meters with 2 decimals — metric: m^2, switching to
// km^2 from 1,000,000 m^2; imperial: ft^2, switching to mi^2 from one square mile.
function formatArea(sqMeters: number, units: UnitsSystem): string {
  if (units === 'imperial') {
    if (sqMeters >= SQ_METERS_PER_SQ_MILE) {
      return (sqMeters / SQ_METERS_PER_SQ_MILE).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' mi\u00b2';
    }
    return (sqMeters / SQ_METERS_PER_SQ_FOOT).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' ft\u00b2';
  }
  if (sqMeters >= 1000000) {
    return (sqMeters / 1000000).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' km\u00b2';
  }
  return sqMeters.toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' m\u00b2';
}

// One measurement "chip" label anchored at a point geometry. The chip border
// picks up the feature's line colour so it reads as part of the feature.
function buildMeasurementChipStyle(text: string, anchor: Point, borderColor: string, offsetY = 0): Style {
  return new Style({
    geometry: anchor,
    text: new Text({
      text: text,
      font: MEASURE_FONT,
      fill: new Fill({ color: MEASURE_TEXT_COLOR }),
      backgroundFill: new Fill({ color: MEASURE_CHIP_BG }),
      backgroundStroke: new Stroke({ color: borderColor, width: 1 }),
      padding: [3, 6, 3, 6],
      offsetY: offsetY,
      overflow: true,
    }),
  });
}

// One distance chip per consecutive coordinate pair. Closed rings (first
// coordinate repeated at the end) yield exactly one chip per edge.
function buildSegmentLabelStyles(coords: any[], borderColor: string, units: UnitsSystem): Style[] {
  const styles: Style[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segmentLength = measureGeodesicLength(new LineString([a, b]));
    const midpoint = new Point([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    styles.push(buildMeasurementChipStyle(formatLength(segmentLength, units), midpoint, borderColor, -14));
  }
  return styles;
}

// Area summary chip for polygons/rectangles. Filled with the feature's line
// colour — with an auto-picked text colour for contrast — so it stands out
// from the white per-edge distance chips.
function buildAreaChipStyle(geom: any, ds: DrawStyle, units: UnitsSystem): Style {
  const bg = parseColor(ds.lineColor, 1);
  const luminance = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
  const textColor = luminance > 0.6 ? MEASURE_TEXT_COLOR : '#ffffff';
  return new Style({
    geometry: geom.getInteriorPoint(),
    text: new Text({
      text: formatArea(measureGeodesicArea(geom), units),
      font: MEASURE_FONT_AREA,
      fill: new Fill({ color: textColor }),
      backgroundFill: new Fill({ color: rgbaToString(bg) }),
      backgroundStroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1 }),
      padding: [3, 7, 3, 7],
      overflow: true,
    }),
  });
}

// Measurement label styles for a drawn geometry:
//  - LineString: one chip per segment showing the vertex-to-vertex distance
//  - Polygon (incl. rectangles): one chip per edge plus a filled chip with
//    the geodesic area at the interior point
function buildMeasurementStyles(geom: any, ds: DrawStyle, units: UnitsSystem): Style[] {
  if (!geom || !geom.getType) return [];
  const border = rgbaToString(parseColor(ds.lineColor, 1));
  const type = geom.getType();
  const styles: Style[] = [];

  if (type === 'LineString') {
    styles.push(...buildSegmentLabelStyles(geom.getCoordinates(), border, units));
  } else if (type === 'Polygon') {
    // Outer ring only; the ring is closed, so iterating consecutive pairs
    // covers every edge exactly once.
    const ring = geom.getCoordinates()[0] || [];
    styles.push(...buildSegmentLabelStyles(ring, border, units));
    styles.push(buildAreaChipStyle(geom, ds, units));
  }
  return styles;
}

// Short measurement summary for a drawn feature, shown next to its name in
// feature lists (total length for lines, area for polygons/rectangles).
function getFeatureMeasurementText(feature: any, units: UnitsSystem): string | null {
  const geom = feature && feature.getGeometry ? feature.getGeometry() : null;
  if (!geom || !geom.getType) return null;
  const type = geom.getType();
  if (type === 'LineString') return formatLength(measureGeodesicLength(geom), units);
  if (type === 'Polygon') return formatArea(measureGeodesicArea(geom), units);
  return null;
}

// Vertex handles for the Modify interactions (draw-toolbar edit tool and
// saved-layer re-edit): hollow squares in an accent colour — the inverse of
// the drawn-point style — so they read clearly as editing handles.
function buildModifyVertexStyle(accentColor: string): Style {
  const line = rgbaToString(parseColor(accentColor, 1));
  return new Style({
    image: new RegularShape({
      points: 4,
      radius: 6,
      angle: Math.PI / 4,
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color: line, width: 2 }),
    }),
  });
}

// ---------------------------------------------------------------------------
// Vertex hit-testing and geometry surgery for the click-based edit gestures:
// click a vertex to pick it up, click again to place it, Delete to remove it,
// click a segment to insert one. Every vertex carries an "index path" so the
// same code serves points ([]), lines ([i]) and polygon rings ([ring, i]).
// ---------------------------------------------------------------------------

interface VertexHit {
  feature: any;
  geom: any;
  indexPath: number[];
  coord: number[]; // original position — used to restore on Escape
}

interface SegmentHit {
  feature: any;
  geom: any;
  index: number; // first vertex of the segment; the new one goes right after
  ringIndex: number; // -1 for lines
  coord: number[]; // nearest point on the segment, in map coordinates
}

function forEachGeometryVertex(geom: any, cb: (indexPath: number[], coord: number[]) => void) {
  const type = geom.getType();
  if (type === 'Point') {
    cb([], geom.getCoordinates());
  } else if (type === 'LineString') {
    geom.getCoordinates().forEach((c: number[], i: number) => cb([i], c));
  } else if (type === 'Polygon') {
    geom.getCoordinates().forEach((ring: number[][], r: number) =>
      ring.forEach((c: number[], i: number) => cb([r, i], c))
    );
  }
}

// Nearest vertex within tolerance (screen pixels), or null. Ring-closing
// duplicates are skipped — they are vertex 0 in disguise.
function findNearestVertex(map: OLMap, source: any, pixel: number[], tolerancePx: number): VertexHit | null {
  let best: VertexHit | null = null;
  let bestDist = tolerancePx;
  (source.getFeatures() as any[]).forEach((feature) => {
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom || !geom.getType) return;
    const type = geom.getType();
    if (type !== 'Point' && type !== 'LineString' && type !== 'Polygon') return;
    forEachGeometryVertex(geom, (indexPath, coord) => {
      if (type === 'Polygon') {
        const ring = geom.getCoordinates()[indexPath[0]];
        if (indexPath[1] === ring.length - 1) return;
      }
      const vp = map.getPixelFromCoordinate(coord);
      const d = Math.hypot(vp[0] - pixel[0], vp[1] - pixel[1]);
      if (d <= bestDist) {
        bestDist = d;
        best = { feature, geom, indexPath, coord: coord.slice() };
      }
    });
  });
  return best;
}

function nearestPointOnSegmentPixel(p: number[], a: number[], b: number[]): { dist: number; px: number[] } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = [a[0] + t * dx, a[1] + t * dy];
  return { dist: Math.hypot(px[0] - p[0], px[1] - p[1]), px };
}

// Nearest segment within tolerance (screen pixels), with the insertion point
// already projected onto it.
function findNearestSegment(map: OLMap, source: any, pixel: number[], tolerancePx: number): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestDist = tolerancePx;
  (source.getFeatures() as any[]).forEach((feature) => {
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom || !geom.getType) return;
    const type = geom.getType();
    let rings: number[][][] = [];
    if (type === 'LineString') rings = [geom.getCoordinates()];
    else if (type === 'Polygon') rings = geom.getCoordinates();
    else return;
    rings.forEach((coords, ringIndex) => {
      for (let i = 0; i < coords.length - 1; i++) {
        const a = map.getPixelFromCoordinate(coords[i]);
        const b = map.getPixelFromCoordinate(coords[i + 1]);
        const hit = nearestPointOnSegmentPixel(pixel as number[], a, b);
        if (hit.dist <= bestDist) {
          bestDist = hit.dist;
          best = {
            feature,
            geom,
            index: i,
            ringIndex: type === 'Polygon' ? ringIndex : -1,
            coord: map.getCoordinateFromPixel(hit.px),
          };
        }
      }
    });
  });
  return best;
}

function setVertexCoordinate(geom: any, indexPath: number[], coord: number[]) {
  const type = geom.getType();
  if (type === 'Point') {
    geom.setCoordinates(coord);
  } else if (type === 'LineString') {
    const coords = geom.getCoordinates();
    coords[indexPath[0]] = coord;
    geom.setCoordinates(coords);
  } else if (type === 'Polygon') {
    const rings = geom.getCoordinates();
    const ring = rings[indexPath[0]];
    ring[indexPath[1]] = coord;
    // Keep closed rings closed — vertex 0 is duplicated at the end.
    if (indexPath[1] === 0) ring[ring.length - 1] = coord;
    geom.setCoordinates(rings);
  }
}

// Remove a vertex, refusing to degenerate the geometry (a line keeps at
// least two vertices, a ring at least three unique ones). True on success.
function removeVertexFromGeom(geom: any, indexPath: number[]): boolean {
  const type = geom.getType();
  if (type === 'LineString') {
    const coords = geom.getCoordinates();
    if (coords.length <= 2) return false;
    coords.splice(indexPath[0], 1);
    geom.setCoordinates(coords);
    return true;
  }
  if (type === 'Polygon') {
    const rings = geom.getCoordinates();
    const ring = rings[indexPath[0]];
    if (ring.length <= 4) return false; // 3 unique vertices + closing duplicate
    ring.splice(indexPath[1], 1);
    if (indexPath[1] === 0) ring[ring.length - 1] = ring[0];
    geom.setCoordinates(rings);
    return true;
  }
  return false;
}

function insertVertexInGeom(hit: SegmentHit) {
  const { geom, index, ringIndex, coord } = hit;
  if (ringIndex === -1) {
    const coords = geom.getCoordinates();
    coords.splice(index + 1, 0, coord);
    geom.setCoordinates(coords);
  } else {
    const rings = geom.getCoordinates();
    // Splicing before the closing duplicate keeps the ring closed even when
    // the click landed on the closing segment.
    rings[ringIndex].splice(index + 1, 0, coord);
    geom.setCoordinates(rings);
  }
}

// Marker for a "picked up" vertex: a filled diamond in the session accent
// colour inside a larger hollow one, so the floating vertex is unmistakable.
function buildEditMarkerStyles(accentColor: string): Style[] {
  const line = rgbaToString(parseColor(accentColor, 1));
  return [
    new Style({
      image: new RegularShape({
        points: 4,
        radius: 13,
        angle: Math.PI / 4,
        stroke: new Stroke({ color: line, width: 1.5 }),
      }),
    }),
    new Style({
      image: new RegularShape({
        points: 4,
        radius: 6.5,
        angle: Math.PI / 4,
        fill: new Fill({ color: line }),
        stroke: new Stroke({ color: '#ffffff', width: 2 }),
      }),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Undo/redo for the draw session. A snapshot serialises every feature on the
// draw source — geometry plus the name, style, label text and customisation
// flag each one carries — so any completed action (a stroke, a deletion, a
// vertex drag, a whole-feature move, a vertex insert/remove, a label text
// edit) can be stepped backwards and forwards.
// ---------------------------------------------------------------------------

interface SessionSnapshotItem {
  id: string;
  type: 'LineString' | 'Polygon' | 'Point';
  name: string;
  customized: boolean;
  style: DrawStyle;
  labelText?: string;
  geometry: any; // cloned OL geometry
}

interface SessionSnapshot {
  items: SessionSnapshotItem[];
}

const HISTORY_LIMIT = 100;

// `extraFeatures` folds in features OpenLayers has finished drawing but not
// yet inserted into the source — drawend is dispatched before the insert.
function captureDrawSnapshot(source: any, extraFeatures?: any[]): SessionSnapshot {
  const feats = (source.getFeatures() as any[]).concat(extraFeatures || []);
  return {
    items: feats.map((f) => {
      const geom = f.getGeometry();
      return {
        id: f._drawFeatureId || '',
        type: (geom && geom.getType ? geom.getType() : 'Point') as any,
        name: f._drawName || '',
        customized: !!f._drawCustomized,
        style: f._drawStyle ? { ...f._drawStyle } : { ...DEFAULT_DRAW_STYLE },
        labelText: f.get ? f.get('labelText') : undefined,
        geometry: geom.clone(),
      };
    }),
  };
}

// Cheap canonical form so consecutive identical states (a zero-distance
// vertex drag, a cancelled pick-up…) don't grow the stack.
function snapshotKey(snap: SessionSnapshot): string {
  return JSON.stringify(snap.items.map(it => ({
    id: it.id,
    name: it.name,
    customized: it.customized,
    style: it.style,
    labelText: it.labelText,
    coords: it.geometry.getCoordinates(),
  })));
}

// Apply a DrawStyle to a drawn feature via a style function so its
// measurement labels always stay in sync with the feature's geometry, style
// and unit system (works for both finished features and the in-progress
// sketch). Units are read lazily so a metric/imperial switch re-formats
// every label on the next render without re-styling each feature.
function applyDrawFeatureStyle(feature: any, ds: DrawStyle, getUnits: () => UnitsSystem) {
  feature._drawStyle = ds;
  feature.setStyle(() => {
    const labelText = feature.get ? feature.get('labelText') : undefined;
    const styles: Style[] = [buildDrawFeatureStyle(ds, labelText)];
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (geom) styles.push(...buildMeasurementStyles(geom, ds, getUnits()));
    return styles;
  });
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

// ---------------------------------------------------------------------------
// Layer groups (folders) - panel-side helpers
// ---------------------------------------------------------------------------

function makeGroupId(): string {
  return 'group-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Stable key of a layer list's order + group membership. Dragover events fire
 * continuously while dragging; comparing this key skips no-op reorder updates.
 */
function layerOrderKey(layers: Array<{ id: string; groupId?: string }>): string {
  return layers.map(l => l.id + ':' + (l.groupId || '')).join('|');
}

type LayerPanelItem<L> =
  | { kind: 'group'; group: LayerGroup; members: L[] }
  | { kind: 'layer'; layer: L };

/**
 * Panel order: the flat layer list, with each group rendered as one block at
 * the position of its FIRST member - so groups and ungrouped layers
 * interleave freely and reordering layers moves blocks around with them.
 * Empty groups have no members to anchor them, so they are placed at their
 * persisted `afterId` slot (null = top, layer/group id = after that item,
 * undefined/unknown = end).
 */
function buildLayerPanelItems<L extends { id: string; groupId?: string }>(
  layers: L[],
  groups: LayerGroup[]
): Array<LayerPanelItem<L>> {
  const items: Array<LayerPanelItem<L>> = [];
  const placed = new Set<string>();
  for (const layer of layers) {
    const group = layer.groupId ? groups.find(g => g.id === layer.groupId) : undefined;
    if (group) {
      if (!placed.has(group.id)) {
        placed.add(group.id);
        items.push({ kind: 'group', group, members: layers.filter(l => l.groupId === group.id) });
      }
      // Grouped layers render inside their group block, not at the top level.
    } else {
      items.push({ kind: 'layer', layer });
    }
  }
  // Empty groups, at their anchored slots. Anchors may reference other empty
  // groups, so resolve in passes until nothing new can be placed.
  let pending = groups.filter(g => !placed.has(g.id));
  let guard = pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const deferred: LayerGroup[] = [];
    for (const group of pending) {
      const item: LayerPanelItem<L> = { kind: 'group', group, members: [] };
      const anchor = group.afterId;
      if (anchor === null) {
        items.unshift(item);
        placed.add(group.id);
      } else if (!anchor) {
        items.push(item);
        placed.add(group.id);
      } else {
        const idx = items.findIndex(it => (it.kind === 'layer' ? it.layer.id === anchor : it.group.id === anchor));
        if (idx === -1) {
          deferred.push(group); // anchor not placed yet - retry next pass
        } else {
          items.splice(idx + 1, 0, item);
          placed.add(group.id);
        }
      }
    }
    if (deferred.length === pending.length) {
      // Unresolvable anchors (stale ids/cycles): fall back to the end.
      deferred.forEach(g => items.push({ kind: 'group', group: g, members: [] }));
      break;
    }
    pending = deferred;
  }
  return items;
}

/** Index of the panel item that contains the given layer (its row or block). */
function itemIdxOfLayer<L extends { id: string; groupId?: string }>(items: Array<LayerPanelItem<L>>, layerId: string): number {
  return items.findIndex(it => (it.kind === 'layer' ? it.layer.id === layerId : it.members.some(m => m.id === layerId)));
}

/**
 * The `afterId` value for an empty group dropped at panel position `slot`
 * (null = top, undefined = end of list, otherwise the id of the item that
 * will sit just above it).
 */
function slotAfterId<L extends { id: string; groupId?: string }>(items: Array<LayerPanelItem<L>>, slot: number): string | null | undefined {
  if (slot < 0) return undefined;
  if (slot === 0) return null;
  const prev = items[slot - 1];
  if (!prev) return undefined;
  if (prev.kind === 'layer') return prev.layer.id;
  if (prev.members.length > 0) return prev.members[prev.members.length - 1].id;
  return prev.group.id; // anchoring to an empty group is fine - it resolves recursively
}

/**
 * Move a group's member layers so the whole block occupies panel slot `slot`
 * (0 = top, -1 = end). The block stays contiguous; other layers keep their
 * relative order. Returns the original reference when nothing changes.
 */
function moveGroupToSlot<L extends { id: string; groupId?: string }>(
  layers: L[],
  groupId: string,
  items: Array<LayerPanelItem<L>>,
  slot: number
): L[] {
  const members = layers.filter(l => l.groupId === groupId);
  if (members.length === 0) return layers;
  // Flat index of the first real layer at/after the slot (empty-group items
  // have no layers of their own - look through to the next item).
  let flatAt = layers.length;
  if (slot >= 0) {
    for (let j = slot; j < items.length; j++) {
      const it = items[j];
      const firstId = it.kind === 'layer' ? it.layer.id : it.members[0]?.id;
      if (firstId) {
        const fi = layers.findIndex(l => l.id === firstId);
        if (fi !== -1) { flatAt = fi; break; }
      }
    }
  }
  const rest = layers.filter(l => l.groupId !== groupId);
  const insertAt = layers.slice(0, flatAt).filter(l => l.groupId !== groupId).length;
  const next = [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)];
  return layerOrderKey(next) === layerOrderKey(layers) ? layers : next;
}

/**
 * Move a layer INTO a group at the position of a member row: 'before' or
 * 'after' the target row within the group's member list. Returns the
 * original reference when nothing changes.
 */
function moveLayerToJoinAt<L extends { id: string; groupId?: string }>(
  layers: L[],
  layerId: string,
  groupId: string,
  targetId: string,
  place: 'before' | 'after'
): L[] {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return layers;
  const rest = layers.filter(l => l.id !== layerId);
  const targetIdx = rest.findIndex(l => l.id === targetId);
  if (targetIdx === -1) return layers;
  const insertAt = place === 'before' ? targetIdx : targetIdx + 1;
  const next = [...rest.slice(0, insertAt), { ...layer, groupId }, ...rest.slice(insertAt)];
  return layerOrderKey(next) === layerOrderKey(layers) ? layers : next;
}

/**
 * Move a single layer so it occupies panel slot `slot` (0 = top, -1 = end),
 * leaving any group it belonged to - dragging reorders, the folder button
 * manages membership. Returns the original reference when nothing changes.
 */
function moveLayerToSlot<L extends { id: string; groupId?: string }>(
  layers: L[],
  layerId: string,
  items: Array<LayerPanelItem<L>>,
  slot: number
): L[] {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return layers;
  // Flat index of the first real layer at/after the slot (empty-group items
  // have no layers - look through to the next item).
  let flatAt = layers.length;
  if (slot >= 0) {
    for (let j = slot; j < items.length; j++) {
      const it = items[j];
      const firstId = it.kind === 'layer' ? it.layer.id : it.members[0]?.id;
      if (firstId) {
        const fi = layers.findIndex(l => l.id === firstId);
        if (fi !== -1) { flatAt = fi; break; }
      }
    }
  }
  const rest = layers.filter(l => l.id !== layerId);
  const insertAt = layers.slice(0, flatAt).filter(l => l.id !== layerId).length;
  const moved = layer.groupId ? { ...layer, groupId: undefined } : layer;
  const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  return layerOrderKey(next) === layerOrderKey(layers) ? layers : next;
}

/**
 * Flat-array position where a layer joining the (currently empty) group
 * should land so the group materialises at its anchored panel slot.
 */
function flatIndexForGroupSlot<L extends { id: string; groupId?: string }>(layers: L[], groups: LayerGroup[], groupId: string): number {
  const group = groups.find(g => g.id === groupId);
  const after = group ? group.afterId : undefined;
  if (after === null) return 0;
  if (!after) return layers.length;
  const idx = layers.findIndex(l => l.id === after);
  if (idx !== -1) {
    const anchorGroup = layers[idx].groupId;
    if (anchorGroup) {
      let last = idx;
      layers.forEach((l, i) => { if (l.groupId === anchorGroup) last = i; });
      return last + 1;
    }
    return idx + 1;
  }
  // Anchor references a group: sit after that group's last member.
  let last = -1;
  layers.forEach((l, i) => { if (l.groupId === after) last = i; });
  return last === -1 ? layers.length : last + 1;
}

/**
 * After a layer move, anchor any group that lost its last member so the
 * now-empty folder stays at its current panel position instead of jumping
 * to the end of the list. The anchor is computed from the NEW panel layout
 * (with the moved layer in its new position) so the folder sits where the
 * user sees it.
 */
function anchorEmptiedGroups<L extends { id: string; groupId?: string }>(
  oldLayers: L[],
  newLayers: L[],
  groups: LayerGroup[]
): LayerGroup[] | null {
  const oldGroupIds = new Set(oldLayers.filter(l => l.groupId).map(l => l.groupId!));
  const newGroupIds = new Set(newLayers.filter(l => l.groupId).map(l => l.groupId!));
  const emptiedIds = Array.from(oldGroupIds).filter(id => !newGroupIds.has(id) && groups.some(g => g.id === id));
  if (emptiedIds.length === 0) return null;

  // Old panel position of each emptied group (to preserve its slot).
  const oldItems = buildLayerPanelItems(oldLayers, groups);

  // New panel WITHOUT the emptied groups - used to compute their anchors.
  const survivingGroups = groups.filter(g => !emptiedIds.includes(g.id));
  const newItems = buildLayerPanelItems(newLayers, survivingGroups);

  let changed = false;
  const result = groups.map(g => {
    if (!emptiedIds.includes(g.id)) return g;
    const oldIdx = oldItems.findIndex(it => it.kind === 'group' && it.group.id === g.id);
    if (oldIdx === -1) return g;

    // Anchor the group relative to the item that was BELOW it in the old
    // panel.  Using the raw old index fails when the group's former member
    // is now a standalone item occupying the same slot - the folder would
    // land before its former member instead of after it.
    let newAfterId: string | null | undefined;
    if (oldIdx >= oldItems.length - 1) {
      // Group was at the very end - keep it there.
      newAfterId = slotAfterId(newItems, newItems.length);
    } else {
      const belowItem = oldItems[oldIdx + 1];
      let belowNewIdx = -1;
      if (belowItem.kind === 'layer') {
        const bid = belowItem.layer.id;
        belowNewIdx = newItems.findIndex(it =>
          it.kind === 'layer' ? it.layer.id === bid : it.members.some(m => m.id === bid)
        );
      } else {
        belowNewIdx = newItems.findIndex(it => it.kind === 'group' && it.group.id === belowItem.group.id);
      }
      if (belowNewIdx === -1) {
        // The item below no longer exists; fall back to clamped old index.
        newAfterId = slotAfterId(newItems, Math.min(oldIdx, newItems.length));
      } else {
        // Place the group just before the item-below's new position.
        newAfterId = slotAfterId(newItems, belowNewIdx);
      }
    }

    if (newAfterId === g.afterId) return g;
    changed = true;
    return { ...g, afterId: newAfterId };
  });
  return changed ? result : null;
}

/**
 * After moving a layer to a panel slot, re-anchor any empty groups that the
 * layer crossed so they stay on the correct side. Without this, dragging the
 * only ungrouped layer past an empty folder is a no-op (the flat array does
 * not change) and the folder never moves.
 */
function reanchorCrossedEmptyGroups<L extends { id: string; groupId?: string }>(
  layers: L[],
  groups: LayerGroup[],
  layerId: string,
  targetSlot: number,
  skipIds?: Set<string>
): LayerGroup[] | null {
  const items = buildLayerPanelItems(layers, groups);
  const layerIdx = items.findIndex(it => it.kind === 'layer' && it.layer.id === layerId);
  if (layerIdx === -1) return null;

  const effectiveTarget = targetSlot < 0 ? items.length - 1 : targetSlot;
  if (layerIdx === effectiveTarget) return null;

  const emptyGroupIds = new Set(
    groups.filter(g => !layers.some(l => l.groupId === g.id) && !(skipIds && skipIds.has(g.id))).map(g => g.id)
  );
  const crossed = Array.from(emptyGroupIds).filter(gid => {
    const groupIdx = items.findIndex(it => it.kind === 'group' && it.group.id === gid);
    if (groupIdx === -1) return false;
    return layerIdx < effectiveTarget
      ? groupIdx > layerIdx && groupIdx <= effectiveTarget
      : groupIdx < layerIdx && groupIdx >= effectiveTarget;
  });
  if (crossed.length === 0) return null;

  // Build the panel with the layer at its new slot to derive correct anchors.
  const layerItem = items[layerIdx];
  const itemsWithout = items.filter((_, i) => i !== layerIdx);
  const insertAt = targetSlot < 0 ? itemsWithout.length : Math.min(targetSlot, itemsWithout.length);
  const newItems = [...itemsWithout.slice(0, insertAt), layerItem, ...itemsWithout.slice(insertAt)];

  let changed = false;
  const result = groups.map(g => {
    if (!crossed.includes(g.id)) return g;
    const newIdx = newItems.findIndex(it => it.kind === 'group' && it.group.id === g.id);
    if (newIdx === -1) return g;
    const newAfterId = slotAfterId(newItems, newIdx);
    if (newAfterId === g.afterId) return g;
    changed = true;
    return { ...g, afterId: newAfterId };
  });
  return changed ? result : null;
}


/**
 * After a layer moves, re-anchor any empty group whose `afterId` references
 * the moved layer directly.  Without this the group "follows" the layer to
 * its new position instead of staying at its old panel slot.
 */
function reanchorGroupsChainedToMovedLayer<L extends { id: string; groupId?: string }>(
  oldLayers: L[],
  newLayers: L[],
  groups: LayerGroup[],
  movedLayerId: string,
  skipIds?: Set<string>
): LayerGroup[] | null {
  // Empty groups anchored directly to the moved layer.
  const affected = groups.filter(g =>
    g.afterId === movedLayerId && !newLayers.some(l => l.groupId === g.id)
      && !(skipIds && skipIds.has(g.id))
  );
  if (affected.length === 0) return null;

  const affectedIds = new Set(affected.map(g => g.id));

  // Old panel position of each affected group.
  const oldItems = buildLayerPanelItems(oldLayers, groups);

  // New panel WITHOUT the affected groups - used to compute their new anchors.
  const survivingGroups = groups.filter(g => !affectedIds.has(g.id));
  const newItems = buildLayerPanelItems(newLayers, survivingGroups);

  let changed = false;
  const result = groups.map(g => {
    if (!affectedIds.has(g.id)) return g;
    const oldIdx = oldItems.findIndex(it => it.kind === 'group' && it.group.id === g.id);
    if (oldIdx === -1) return g;
    const clampedIdx = Math.min(oldIdx, newItems.length);
    const newAfterId = slotAfterId(newItems, clampedIdx);
    if (newAfterId === g.afterId) return g;
    changed = true;
    return { ...g, afterId: newAfterId };
  });
  return changed ? result : null;
}

/**
 * Combined anchor sync: call after any layer move (reorder, reparent,
 * extreme-slot drop). Returns updated groups or null when nothing changed.
 */
function syncGroupAnchors<L extends { id: string; groupId?: string }>(
  oldLayers: L[],
  newLayers: L[],
  groups: LayerGroup[],
  movedLayerId: string,
  targetSlot: number
): LayerGroup[] | null {
  let current = groups;
  const anchored = anchorEmptiedGroups(oldLayers, newLayers, current);
  if (anchored) current = anchored;
  // Groups that just lost their last member are already anchored by step 1;
  // skip them in subsequent steps so their anchors are not overridden.
  const justEmptied = new Set(
    Array.from(new Set(oldLayers.filter(l => l.groupId).map(l => l.groupId!)))
      .filter(id => !newLayers.some(l => l.groupId === id) && groups.some(g => g.id === id))
  );
  // Re-anchor empty groups that were chained to the moved layer so they
  // stay at their old panel position instead of following the layer.
  const chained = reanchorGroupsChainedToMovedLayer(oldLayers, newLayers, current, movedLayerId, justEmptied);
  if (chained) current = chained;
  const crossed = reanchorCrossedEmptyGroups(newLayers, current, movedLayerId, targetSlot, justEmptied);
  if (crossed) current = crossed;
  return current === groups ? null : current;
}

/**
 * Group visibility toggle with per-layer memory. While any member is
 * visible, toggling hides every member and records each layer's own
 * visibility in `groupHiddenVisible`; when every member is hidden, toggling
 * restores those recorded states (defaulting to visible) and clears them.
 * Individual on/off choices therefore survive a group off -> on cycle.
 */
export function toggleGroupLayerVisibility<L extends { id: string; groupId?: string; visible?: boolean; groupHiddenVisible?: boolean }>(
  layers: L[],
  groupId: string
): L[] {
  const members = layers.filter(l => l.groupId === groupId);
  if (members.length === 0) return layers;
  const noneVisible = members.every(l => l.visible === false);
  if (noneVisible) {
    return layers.map(l => {
      if (l.groupId !== groupId) return l;
      const restore = l.groupHiddenVisible !== undefined ? l.groupHiddenVisible : true;
      const { groupHiddenVisible, ...rest } = l;
      return { ...rest, visible: restore } as L;
    });
  }
  return layers.map(l => {
    if (l.groupId !== groupId) return l;
    return { ...l, groupHiddenVisible: l.visible !== false, visible: false };
  });
}

/**
 * Move a layer into (or out of) a group, keeping it adjacent to its new group
 * members so the panel order and map stacking order stay consistent. Returns
 * the original array reference when nothing changes.
 */
function moveLayerToGroup<L extends { id: string; groupId?: string }>(
  layers: L[],
  layerId: string,
  groupId: string | undefined
): L[] {
  const layer = layers.find(l => l.id === layerId);
  if (!layer || layer.groupId === groupId) return layers;
  const next = layers.filter(l => l.id !== layerId);
  const moved = { ...layer, groupId };
  if (groupId) {
    let lastMemberIdx = -1;
    next.forEach((l, i) => { if (l.groupId === groupId) lastMemberIdx = i; });
    if (lastMemberIdx === -1) next.push(moved);
    else next.splice(lastMemberIdx + 1, 0, moved);
    return next;
  }
  // Leaving a group: keep the layer where it was, now ungrouped.
  const origIdx = layers.findIndex(l => l.id === layerId);
  next.splice(Math.min(origIdx, next.length), 0, moved);
  return next;
}

function FolderIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/>
      <line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  );
}

/**
 * Tri-state eye for a group header: all members visible, some visible, or
 * none visible. Clicking toggles every member at once (handled by the parent
 * dialog - this component is display-only).
 */
function GroupEyeIcon({ state }: { state: 'all' | 'some' | 'none' }) {
  if (state === 'none') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
    );
  }
  return (
    <span className={'group-eye' + (state === 'some' ? ' partial' : '')}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      {state === 'some' && <span className="group-eye-dash" />}
    </span>
  );
}

/**
 * Per-layer "move to group" popover: pick an existing group, leave the
 * current group, or create a new group on the spot.
 */
function GroupAssignMenu({
  groups,
  currentGroupId,
  onAssign,
  onCreateGroup,
}: {
  groups: LayerGroup[];
  currentGroupId?: string;
  onAssign: (groupId: string | undefined) => void;
  onCreateGroup: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false); setCreating(false); setNewName('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); setCreating(false); setNewName(''); };

  return (
    <div className="group-assign" ref={rootRef}>
      <button
        type="button"
        className={'settings-layer-group-btn' + (currentGroupId ? ' assigned' : '')}
        title={currentGroupId ? 'Move to another group' : 'Add to a group'}
        onClick={() => setOpen(o => !o)}
      >
        <FolderIcon />
      </button>
      {open && (
        <div className="group-assign-menu">
          <div className="group-assign-title">Move to group</div>
          {currentGroupId && (
            <button type="button" className="group-assign-item" onClick={() => { onAssign(undefined); close(); }}>
              <span className="group-assign-check" />No group
            </button>
          )}
          {groups.map(g => (
            <button
              key={g.id}
              type="button"
              className={'group-assign-item' + (g.id === currentGroupId ? ' current' : '')}
              onClick={() => { if (g.id !== currentGroupId) onAssign(g.id); close(); }}
            >
              <span className="group-assign-check">{g.id === currentGroupId ? '\u2713' : ''}</span>
              <FolderIcon />
              <span className="group-assign-name">{g.name}</span>
            </button>
          ))}
          {groups.length === 0 && !currentGroupId && (
            <div className="group-assign-empty">No groups yet</div>
          )}
          <div className="group-assign-divider" />
          {creating ? (
            <div className="group-assign-create">
              <input
                autoFocus
                type="text"
                className="settings-input"
                placeholder="Group name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) { onCreateGroup(newName.trim()); close(); }
                  if (e.key === 'Escape') close();
                }}
              />
              <button
                type="button"
                className="settings-button-primary group-assign-create-btn"
                disabled={!newName.trim()}
                onClick={() => { onCreateGroup(newName.trim()); close(); }}
              >Create</button>
            </div>
          ) : (
            <button type="button" className="group-assign-item" onClick={() => setCreating(true)}>
              <span className="group-assign-check" />+ New group…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which side of the hovered row/header the pointer is on: a dragged group
 * lands BEFORE the target when the pointer is in its top half, AFTER it when
 * in the bottom half. Anchoring placement to the pointer - not to the array
 * order - is what keeps live reordering stable: after a swap the pointer is
 * in the half that matches the new order, so repeated dragover events (they
 * fire continuously) are no-ops instead of flipping the order back and forth.
 */
function dropPlace(e: React.DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
}

/** Enter/Space activation for the span-based group-header actions (a11y). */
function spanActivate(fn: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

/** Stacked-layers glyph for the workspace switcher trigger. */
function WorkspaceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 2 9 4.9-9 4.9-9-4.9L12 2z" />
      <path d="m3 11.9 9 4.9 9-4.9" />
      <path d="m3 16.9 9 4.9 9-4.9" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * Workspace switcher in the bottom-left corner of the Settings footer.
 * Every workspace keeps its own layers, groups, basemap and toggles; picking
 * one reloads the map with that workspace's saved setup.
 */
export function WorkspaceSelector({
  workspaceId,
  workspaces,
  onSwitch,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: {
  workspaceId: string;
  workspaces: WorkspaceMeta[];
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newValue, setNewValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const active = workspaces.find(w => w.id === workspaceId);
  const canDelete = workspaces.length > 1;

  // Close the popover on any pointer-down outside of it.
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setRenamingId(null);
        setConfirmDeleteId(null);
        setCreating(false);
        setNewValue('');
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [open]);

  // Escape closes the popover (or cancels an inline edit first).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (renamingId) { setRenamingId(null); return; }
      if (creating) { setCreating(false); setNewValue(''); return; }
      if (confirmDeleteId) { setConfirmDeleteId(null); return; }
      setOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, renamingId, creating, confirmDeleteId]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (creating && newInputRef.current) newInputRef.current.focus();
  }, [creating]);

  const commitRename = () => {
    if (renamingId) {
      const name = renameValue.trim();
      if (name) onRename(renamingId, name);
    }
    setRenamingId(null);
  };

  const commitCreate = () => {
    const name = newValue.trim();
    setCreating(false);
    setNewValue('');
    if (name) {
      setOpen(false); // the switch remounts the page anyway; close for neatness
      onCreate(name);
    }
  };

  return (
    <div className="workspace-selector" ref={rootRef}>
      <button
        type="button"
        className={`workspace-selector-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Switch workspace — each workspace keeps its own layers and settings"
        aria-label={`Switch workspace — current: ${active ? active.name : 'none'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <WorkspaceIcon />
        <span className="workspace-selector-name">{active ? active.name : 'Workspace'}</span>
        <svg className="workspace-selector-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      {open && (
        <div className="workspace-menu" role="listbox" aria-label="Workspaces">
          <div className="workspace-menu-heading">Workspaces</div>
          <div className="workspace-menu-list">
            {workspaces.map(ws => (
              <div
                key={ws.id}
                className={`workspace-row${ws.id === workspaceId ? ' active' : ''}`}
                role="option"
                aria-selected={ws.id === workspaceId}
              >
                {renamingId === ws.id ? (
                  <input
                    ref={renameInputRef}
                    className="workspace-rename-input"
                    value={renameValue}
                    maxLength={40}
                    onChange={e => setRenameValue(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    type="button"
                    className="workspace-row-name"
                    aria-label={ws.id === workspaceId ? `${ws.name} (current workspace)` : `Switch to ${ws.name}`}
                    title={ws.id === workspaceId ? 'Current workspace' : `Switch to \u201c${ws.name}\u201d`}
                    onClick={() => {
                      if (ws.id !== workspaceId) {
                        setOpen(false);
                        onSwitch(ws.id);
                      }
                    }}
                  >
                    {ws.name}
                  </button>
                )}
                <span className="workspace-row-actions">
                  {ws.id === workspaceId && (
                    <svg className="workspace-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                  {confirmDeleteId === ws.id ? (
                    <button
                      type="button"
                      className="workspace-action workspace-delete-confirm"
                      title="Confirm delete"
                      onMouseDown={e => e.preventDefault()}
                      onClick={e => {
                        e.stopPropagation();
                        setConfirmDeleteId(null);
                        onDelete(ws.id);
                      }}
                    >
                      Sure?
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="workspace-action"
                        title="Rename workspace"
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          setRenamingId(ws.id);
                          setRenameValue(ws.name);
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="workspace-action"
                        title="Duplicate workspace"
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          onDuplicate(ws.id);
                        }}
                      >
                        <CopyIcon />
                      </button>
                      <button
                        type="button"
                        className="workspace-action workspace-delete"
                        title={canDelete ? 'Delete workspace' : 'The last workspace cannot be deleted'}
                        disabled={!canDelete}
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation();
                          if (canDelete) setConfirmDeleteId(ws.id);
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="workspace-menu-footer">
            {creating ? (
              <div className="workspace-create-row">
                <input
                  ref={newInputRef}
                  className="workspace-rename-input"
                  placeholder="Workspace name"
                  value={newValue}
                  maxLength={40}
                  onChange={e => setNewValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitCreate();
                    else if (e.key === 'Escape') { setCreating(false); setNewValue(''); }
                  }}
                  onBlur={commitCreate}
                />
                <button
                  type="button"
                  className="workspace-apply-button"
                  disabled={!newValue.trim()}
                  title="Create workspace"
                  // Keep focus on the input so its blur handler does not
                  // double-commit before this click lands.
                  onMouseDown={e => e.preventDefault()}
                  onClick={commitCreate}
                >
                  Apply
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="workspace-new-button"
                onClick={() => {
                  setRenamingId(null);
                  setConfirmDeleteId(null);
                  setCreating(true);
                }}
              >
                <PlusIcon /> New workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog({ 
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
  rasterGroups,
  onUpdateRasterGroups,
  onToggleRasterGroup,
  onMoveRasterLayerToGroup,
  onAddRasterLayer,
  onEditRasterLayer,
  onRemoveRasterLayer,
  onToggleRasterLayer,
  onApplyColorAdjustments,
  onApplyTileZoomRange,
  vectorLayers,
  vectorGroups,
  onUpdateVectorGroups,
  onToggleVectorGroup,
  onMoveVectorLayerToGroup,
  onToggleVectorLayer,
  onRemoveVectorLayer,
  onEditVectorLayer,
  onApplyVectorStyle,
  onApplyVectorZoomRange,
  onApplyVectorCluster,
  onApplyVectorFeatureStyle,
  onReorderRasterLayers,
  onReorderVectorLayers,
  onAddVectorLayer,
  onAddMVTLayer,
  onAddWFSLayer,
  onAddSTACLayer,  onExportVectorLayer,
  onReeditVectorLayer,
  editingVectorLayerId,
  onGoToVectorLayerExtent,
  onGoToRasterLayerExtent,
  onAdvancedSettings,
  knownSources,
  isRestoringLayers,
  loadingVectorIds,
  units,
  workspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDuplicateWorkspace,
  onDeleteWorkspace,
  onLockApp,
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
  onApplyVectorFeatureStyle: (layerId: string, feature: any, style: DrawStyle) => void;
  onReorderRasterLayers: (layers: RasterLayer[]) => void;
  onReorderVectorLayers: (layers: VectorLayerConfig[]) => void;
  onAddVectorLayer: (file: File, layerName?: string) => Promise<void>;
  onAddMVTLayer: (url: string, name: string) => Promise<void>;
  onAddWFSLayer: (url: string, typeName: string, name: string) => Promise<void>;
  onAddSTACLayer: (url: string, collection: string, name: string, limit?: number) => Promise<void>;  onExportVectorLayer: (layerId: string, format: 'geojson' | 'kml') => void;
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
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  // WMS-only: whether GetFeatureInfo (click-to-inspect) is toggled on
  const [editWmsFeatureInfo, setEditWmsFeatureInfo] = useState(false);
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
  // Point clustering state for vector layers (checkbox + cluster distance px)
  const [vectorEditCluster, setVectorEditCluster] = useState(false);
  const [vectorEditClusterDistance, setVectorEditClusterDistance] = useState(40);
  const [originalVectorCluster, setOriginalVectorCluster] = useState<{ clusterPoints: boolean; clusterDistance: number }>({ clusterPoints: false, clusterDistance: 40 });

  // Id of the group whose drag session is currently alive. Set/cleared
  // synchronously in dragstart/dragend so the DEFERRED dragstart state
  // update can bail out when the drag already ended before its tick ran
  // (otherwise a quick/cancelled drag leaves the group stuck greyed out).
  const dragSessionRef = useRef<string | null>(null);

  // Layer-group (folder) UI state: which group is being renamed inline, and
  // which drop target (group header / section title) a dragged layer hovers.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<'raster' | 'vector' | null>(null);
  // The row a dragged layer would join/leave if dropped right now. Cross-parent
  // moves commit on DROP (not live) so the drag survives crossing a group's
  // members - this state drives the before/after insertion cue on that row.
  const [rowDropTarget, setRowDropTarget] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  const markRowDropTarget = (id: string | null, place: 'before' | 'after' | null) => setRowDropTarget(prev => {
    if (id === null) return prev === null ? prev : null;
    return prev && prev.id === id && prev.place === place ? prev : { id, place: place! };
  });
  const markGroupDragOver = (id: string | null) => {
    setDragOverGroupId(prev => (prev === id ? prev : id));
    // Hovering a group header (or leaving a row for one) clears the row cue.
    setRowDropTarget(prev => (prev === null ? prev : null));
  };
  const markSectionDragOver = (kind: 'raster' | 'vector' | null) => setDragOverSection(prev => (prev === kind ? prev : kind));
  // Id of the group whose header is currently being dragged (whole-block move).
  const [draggedRasterGroupId, setDraggedRasterGroupId] = useState<string | null>(null);
  const [draggedVectorGroupId, setDraggedVectorGroupId] = useState<string | null>(null);

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

  const handleRasterDragStart = (e: React.DragEvent, id: string) => {
    // setData must happen synchronously (Safari refuses to start a drag
    // without it), but the STATE update is deferred one tick: React would
    // otherwise flush the resulting DOM mutations (the row's drag opacity
    // and the end-of-list drop strip) inside the dragstart event, and
    // Chrome cancels a drag session when the source subtree mutates at
    // that moment - the same fix the group header dragstart already uses.
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', id);
    dragSessionRef.current = id;
    window.setTimeout(() => {
      // The drag may already be over (dragend beat this tick) - don't
      // re-apply the dragging state in that case.
      if (dragSessionRef.current !== id) return;
      setDraggedRasterId(id);
    }, 0);
  };

  const handleRasterDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(null);
    markSectionDragOver(null);
    // A dragged group moves as a whole block: it lands before the hovered
    // row - or before that row's group, since groups are never split.
    if (draggedRasterGroupId) {
      e.stopPropagation();
      const target = rasterLayers.find(l => l.id === targetId);
      if (!target || target.groupId === draggedRasterGroupId) return;
      // Slot the dragged block before/after the hovered row (or its whole
      // group block, when the row is grouped) - groups and individual layers
      // interleave freely.
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const place = dropPlace(e);
        moveDraggedGroupToSlot('raster', place === 'before' ? idx : idx + 1);
      }
      return;
    }
    if (!draggedRasterId || draggedRasterId === targetId) return;
    const dragged = rasterLayers.find(l => l.id === draggedRasterId);
    const target = rasterLayers.find(l => l.id === targetId);
    if (!dragged || !target) return;
    // Cleared here; the cross-parent branch below re-sets it when relevant.
    markRowDropTarget(null, null);

    if (dragged.groupId && dragged.groupId === target.groupId) {
      // Reordering within the same group: plain splice, membership unchanged.
      const draggedIndex = rasterLayers.findIndex(l => l.id === draggedRasterId);
      const targetIndex = rasterLayers.findIndex(l => l.id === targetId);
      const newLayers = [...rasterLayers];
      const [draggedLayer] = newLayers.splice(draggedIndex, 1);
      newLayers.splice(targetIndex, 0, draggedLayer);
      if (layerOrderKey(newLayers) !== layerOrderKey(rasterLayers)) onReorderRasterLayers(newLayers);
      return;
    }

    const place = dropPlace(e);
    if (dragged.groupId !== target.groupId) {
      // Cross-parent move (the layer would join or leave a group). Committing
      // it LIVE would reparent the drag source row under a different React
      // parent (a brand-new DOM node), which loses the browser dragend and
      // kills the drag mid-gesture - you could never drag a free layer PAST a
      // group's members to drop it below the group or on the end-of-list strip.
      // So only highlight the target row; the move commits on DROP.
      markRowDropTarget(targetId, place);
      return;
    }
    // Both ungrouped (same parent list): safe to reorder live - the row stays
    // under the same React parent, so the drag source node survives.
    const items = buildLayerPanelItems(rasterLayers, rasterGroups);
    const idx = itemIdxOfLayer(items, targetId);
    if (idx === -1) return;
    const slot = place === 'before' ? idx : idx + 1;
    const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, slot);
    if (next !== rasterLayers) {
      onReorderRasterLayers(next);
      const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, slot);
      if (ga) onUpdateRasterGroups(ga);
    }
  };

  const handleRasterDragEnd = () => {
    dragSessionRef.current = null;
    setDraggedRasterId(null);
    markGroupDragOver(null);
    markSectionDragOver(null);
    markRowDropTarget(null, null);
    clearHoverExpand();
  };

  const handleVectorDragStart = (e: React.DragEvent, id: string) => {
    // See handleRasterDragStart - synchronous setData, deferred state update.
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', id);
    dragSessionRef.current = id;
    window.setTimeout(() => {
      if (dragSessionRef.current !== id) return;
      setDraggedVectorId(id);
    }, 0);
  };

  const handleVectorDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(null);
    markSectionDragOver(null);
    // A dragged group moves as a whole block: it lands before the hovered
    // row - or before that row's group, since groups are never split.
    if (draggedVectorGroupId) {
      e.stopPropagation();
      const target = vectorLayers.find(l => l.id === targetId);
      if (!target || target.groupId === draggedVectorGroupId) return;
      // Slot the dragged block before/after the hovered row (or its whole
      // group block, when the row is grouped) - groups and individual layers
      // interleave freely.
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const place = dropPlace(e);
        moveDraggedGroupToSlot('vector', place === 'before' ? idx : idx + 1);
      }
      return;
    }
    if (!draggedVectorId || draggedVectorId === targetId) return;
    const dragged = vectorLayers.find(l => l.id === draggedVectorId);
    const target = vectorLayers.find(l => l.id === targetId);
    if (!dragged || !target) return;
    // Cleared here; the cross-parent branch below re-sets it when relevant.
    markRowDropTarget(null, null);

    if (dragged.groupId && dragged.groupId === target.groupId) {
      // Reordering within the same group: plain splice, membership unchanged.
      const draggedIndex = vectorLayers.findIndex(l => l.id === draggedVectorId);
      const targetIndex = vectorLayers.findIndex(l => l.id === targetId);
      const newLayers = [...vectorLayers];
      const [draggedLayer] = newLayers.splice(draggedIndex, 1);
      newLayers.splice(targetIndex, 0, draggedLayer);
      if (layerOrderKey(newLayers) !== layerOrderKey(vectorLayers)) onReorderVectorLayers(newLayers);
      return;
    }

    const place = dropPlace(e);
    if (dragged.groupId !== target.groupId) {
      // Cross-parent move - highlight only; commits on DROP (see the raster
      // handler for the full rationale).
      markRowDropTarget(targetId, place);
      return;
    }
    // Both ungrouped (same parent list): safe to reorder live.
    const items = buildLayerPanelItems(vectorLayers, vectorGroups);
    const idx = itemIdxOfLayer(items, targetId);
    if (idx === -1) return;
    const slot = place === 'before' ? idx : idx + 1;
    const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, slot);
    if (next !== vectorLayers) {
      onReorderVectorLayers(next);
      const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, slot);
      if (ga) onUpdateVectorGroups(ga);
    }
  };

  const handleVectorDragEnd = () => {
    dragSessionRef.current = null;
    setDraggedVectorId(null);
    markGroupDragOver(null);
    markSectionDragOver(null);
    markRowDropTarget(null, null);
    clearHoverExpand();
  };

  // Commit a cross-parent layer move on DROP (live dragover only highlights the
  // target row). Joining a group adopts its groupId at the pointer position;
  // dropping on an ungrouped row places the layer beside it and leaves any
  // group. The source row is reparented only now (after the gesture), so the
  // browser drag source node survived the drag and we clear state explicitly.
  const handleRasterRowDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markRowDropTarget(null, null);
    if (!draggedRasterId || draggedRasterId === targetId) return;
    const dragged = rasterLayers.find(l => l.id === draggedRasterId);
    const target = rasterLayers.find(l => l.id === targetId);
    if (!dragged || !target || dragged.groupId === target.groupId) return;
    const place = dropPlace(e);
    if (target.groupId) {
      const next = moveLayerToJoinAt(rasterLayers, draggedRasterId, target.groupId, targetId, place);
      if (next !== rasterLayers) {
        onReorderRasterLayers(next);
        const ga = anchorEmptiedGroups(rasterLayers, next, rasterGroups);
        if (ga) onUpdateRasterGroups(ga);
      }
    } else {
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const slot = place === 'before' ? idx : idx + 1;
        const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, slot);
        if (next !== rasterLayers) onReorderRasterLayers(next);
        const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, slot);
        if (ga) onUpdateRasterGroups(ga);
      }
    }
    handleRasterDragEnd();
  };

  const handleVectorRowDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markRowDropTarget(null, null);
    if (!draggedVectorId || draggedVectorId === targetId) return;
    const dragged = vectorLayers.find(l => l.id === draggedVectorId);
    const target = vectorLayers.find(l => l.id === targetId);
    if (!dragged || !target || dragged.groupId === target.groupId) return;
    const place = dropPlace(e);
    if (target.groupId) {
      const next = moveLayerToJoinAt(vectorLayers, draggedVectorId, target.groupId, targetId, place);
      if (next !== vectorLayers) {
        onReorderVectorLayers(next);
        const ga = anchorEmptiedGroups(vectorLayers, next, vectorGroups);
        if (ga) onUpdateVectorGroups(ga);
      }
    } else {
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx !== -1) {
        const slot = place === 'before' ? idx : idx + 1;
        const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, slot);
        if (next !== vectorLayers) onReorderVectorLayers(next);
        const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, slot);
        if (ga) onUpdateVectorGroups(ga);
      }
    }
    handleVectorDragEnd();
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

  // ----- Layer groups (folders) -------------------------------------------

  const groupsOf = (kind: 'raster' | 'vector') => (kind === 'raster' ? rasterGroups : vectorGroups);
  const updateGroups = (kind: 'raster' | 'vector', groups: LayerGroup[]) =>
    kind === 'raster' ? onUpdateRasterGroups(groups) : onUpdateVectorGroups(groups);
  const updateGroup = (kind: 'raster' | 'vector', groupId: string, patch: Partial<LayerGroup>) =>
    updateGroups(kind, groupsOf(kind).map(g => (g.id === groupId ? { ...g, ...patch } : g)));

  const startGroupRename = (group: LayerGroup) => {
    setRenamingGroupId(group.id);
    setRenameValue(group.name);
  };

  const commitGroupRename = (kind: 'raster' | 'vector', group: LayerGroup) => {
    const name = renameValue.trim();
    if (name && name !== group.name) updateGroup(kind, group.id, { name });
    setRenamingGroupId(null);
  };

  /** Create a group and immediately open its inline rename field. */
  const addGroup = (kind: 'raster' | 'vector') => {
    const id = makeGroupId();
    updateGroups(kind, [...groupsOf(kind), { id, name: 'New group', expanded: true }]);
    setRenamingGroupId(id);
    setRenameValue('New group');
  };

  /** Remove a group but keep its layers - they become ungrouped. */
  const removeGroup = (kind: 'raster' | 'vector', groupId: string) => {
    const remainingGroups = groupsOf(kind).filter(g => g.id !== groupId);
    updateGroups(kind, remainingGroups);
    if (kind === 'raster') {
      if (rasterLayers.some(l => l.groupId === groupId)) {
        onReorderRasterLayers(rasterLayers.map(l => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
      }
    } else if (vectorLayers.some(l => l.groupId === groupId)) {
      onReorderVectorLayers(vectorLayers.map(l => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
    }
  };

  /** Create a new group from a layer's assign-menu and move the layer into it. */
  const createGroupWithLayer = (kind: 'raster' | 'vector', layerId: string, name: string) => {
    const id = makeGroupId();
    updateGroups(kind, [...groupsOf(kind), { id, name, expanded: true }]);
    if (kind === 'raster') onMoveRasterLayerToGroup(layerId, id);
    else onMoveVectorLayerToGroup(layerId, id);
  };

  // Hover-expand: while a layer drag hovers a collapsed group header,
  // expand the group after 300ms so its member rows become drop targets for
  // precise insertion. Releasing on the header itself drops at the group's
  // end (joinLayerAtGroupEnd in the header's onDrop).
  const hoverExpandRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; key: string | null }>({ timer: null, key: null });
  // The group auto-expanded by the hover during the current drag. A layer
  // dropped on a group header lands ABOVE the group ("take its place") unless
  // it was this very group that the hover just expanded - then the drop joins
  // the folder's end, per the drag spec.
  const hoverExpandedGroupRef = useRef<string | null>(null);
  const clearHoverExpand = () => {
    if (hoverExpandRef.current.timer !== null) clearTimeout(hoverExpandRef.current.timer);
    hoverExpandRef.current = { timer: null, key: null };
    hoverExpandedGroupRef.current = null;
  };
  const armHoverExpand = (kind: 'raster' | 'vector', groupId: string) => {
    const groups = kind === 'raster' ? rasterGroups : vectorGroups;
    const group = groups.find(g => g.id === groupId);
    if (!group || group.expanded) return;
    const key = kind + ':' + groupId;
    if (hoverExpandRef.current.key === key) return; // already armed
    clearHoverExpand();
    hoverExpandRef.current = {
      key,
      timer: setTimeout(() => {
        hoverExpandRef.current = { timer: null, key: null };
        // Remember that THIS group was hover-expanded: a header drop now joins
        // the folder's end instead of landing above the group.
        hoverExpandedGroupRef.current = groupId;
        updateGroup(kind, groupId, { expanded: true });
      }, 300),
    };
  };

  // Add a layer to a group at the END of the group's member list (used when
  // a drag is released on the group header). Empty groups go through the App
  // handler, which slots the layer at the group's anchored position and
  // expands it.
  const joinLayerAtGroupEnd = (kind: 'raster' | 'vector', layerId: string, groupId: string) => {
    if (kind === 'raster') {
      const layer = rasterLayers.find(l => l.id === layerId);
      if (!layer) return;
      if (!rasterLayers.some(l => l.groupId === groupId)) {
        onMoveRasterLayerToGroup(layerId, groupId);
        return;
      }
      const rest = rasterLayers.filter(l => l.id !== layerId);
      let lastIdx = -1;
      rest.forEach((l, i) => { if (l.groupId === groupId) lastIdx = i; });
      const next = [...rest.slice(0, lastIdx + 1), { ...layer, groupId }, ...rest.slice(lastIdx + 1)];
      if (layerOrderKey(next) !== layerOrderKey(rasterLayers)) onReorderRasterLayers(next);
    } else {
      const layer = vectorLayers.find(l => l.id === layerId);
      if (!layer) return;
      if (!vectorLayers.some(l => l.groupId === groupId)) {
        onMoveVectorLayerToGroup(layerId, groupId);
        return;
      }
      const rest = vectorLayers.filter(l => l.id !== layerId);
      let lastIdx = -1;
      rest.forEach((l, i) => { if (l.groupId === groupId) lastIdx = i; });
      const next = [...rest.slice(0, lastIdx + 1), { ...layer, groupId }, ...rest.slice(lastIdx + 1)];
      if (layerOrderKey(next) !== layerOrderKey(vectorLayers)) onReorderVectorLayers(next);
    }
  };

  // Move the group being dragged so its block occupies the given panel slot
  // (0 = top, -1 = end). Non-empty groups move their member layers in the
  // flat array (map stacking follows); empty groups just get a new afterId
  // anchor. When dropping BEFORE an empty target group, that group is
  // re-anchored below the moved block so the two don't share the same slot.
  const moveDraggedGroupToSlot = (kind: 'raster' | 'vector', slot: number, emptyTargetGroupId?: string, place?: 'before' | 'after') => {
    const draggedId = kind === 'raster' ? draggedRasterGroupId : draggedVectorGroupId;
    if (!draggedId) return;
    if (kind === 'raster') {
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      if (rasterLayers.some(l => l.groupId === draggedId)) {
        const next = moveGroupToSlot(rasterLayers, draggedId, items, slot);
        if (next !== rasterLayers) {
          onReorderRasterLayers(next);
          if (emptyTargetGroupId && place === 'before') {
            const lastMemberId = next.filter(l => l.groupId === draggedId).pop()?.id;
            if (lastMemberId) {
              onUpdateRasterGroups(rasterGroups.map(g => (g.id === emptyTargetGroupId ? { ...g, afterId: lastMemberId } : g)));
            }
          }
        }
      } else {
        // Empty group: compute the anchor from items WITHOUT the dragged
        // group so slotAfterId never returns a self-reference (which is
        // unresolvable and sends the folder to the end of the list).
        const draggedIdx = items.findIndex(it => it.kind === 'group' && it.group.id === draggedId);
        const itemsWithout = items.filter(it => !(it.kind === 'group' && it.group.id === draggedId));
        const adjustedSlot = draggedIdx !== -1 && draggedIdx < slot ? slot - 1 : slot;
        const afterId = slotAfterId(itemsWithout, adjustedSlot);
        const nextGroups = rasterGroups.map(g => {
          if (g.id !== draggedId) return g;
          const updated = { ...g };
          if (afterId === undefined) delete updated.afterId;
          else updated.afterId = afterId;
          return updated;
        });
        if (nextGroups.some((g, i) => g.afterId !== rasterGroups[i].afterId)) onUpdateRasterGroups(nextGroups);
      }
    } else {
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      if (vectorLayers.some(l => l.groupId === draggedId)) {
        const next = moveGroupToSlot(vectorLayers, draggedId, items, slot);
        if (next !== vectorLayers) {
          onReorderVectorLayers(next);
          if (emptyTargetGroupId && place === 'before') {
            const lastMemberId = next.filter(l => l.groupId === draggedId).pop()?.id;
            if (lastMemberId) {
              onUpdateVectorGroups(vectorGroups.map(g => (g.id === emptyTargetGroupId ? { ...g, afterId: lastMemberId } : g)));
            }
          }
        }
      } else {
        // Empty group: compute the anchor from items WITHOUT the dragged
        // group so slotAfterId never returns a self-reference (which is
        // unresolvable and sends the folder to the end of the list).
        const draggedIdx = items.findIndex(it => it.kind === 'group' && it.group.id === draggedId);
        const itemsWithout = items.filter(it => !(it.kind === 'group' && it.group.id === draggedId));
        const adjustedSlot = draggedIdx !== -1 && draggedIdx < slot ? slot - 1 : slot;
        const afterId = slotAfterId(itemsWithout, adjustedSlot);
        const nextGroups = vectorGroups.map(g => {
          if (g.id !== draggedId) return g;
          const updated = { ...g };
          if (afterId === undefined) delete updated.afterId;
          else updated.afterId = afterId;
          return updated;
        });
        if (nextGroups.some((g, i) => g.afterId !== vectorGroups[i].afterId)) onUpdateVectorGroups(nextGroups);
      }
    }
  };

  // Drag a layer onto a group header: it joins the group (which auto-expands
  // so the user sees where it lands), placed after the group's last member.
  const handleRasterDragOverGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // Group-on-group: the dragged group lands, as a block, before the target.
    if (draggedRasterGroupId) {
      if (draggedRasterGroupId !== groupId) {
        const items = buildLayerPanelItems(rasterLayers, rasterGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) {
          const place = dropPlace(e);
          const targetEmpty = !rasterLayers.some(l => l.groupId === groupId);
          moveDraggedGroupToSlot('raster', place === 'before' ? idx : idx + 1, targetEmpty ? groupId : undefined, place);
        }
      }
      return;
    }
    if (!draggedRasterId) return;
    // Hovering the header while dragging a layer targets the group itself.
    // The drop decides: it lands ABOVE the group ("take its place") unless
    // the hover just expanded this group, in which case it joins the folder's
    // end. Holding the hover ~300ms expands a collapsed group so the user can
    // drag on into a precise member position. No live reorder here.
    armHoverExpand('raster', groupId);
  };

  const handleVectorDragOverGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // Group-on-group: the dragged group lands, as a block, before the target.
    if (draggedVectorGroupId) {
      if (draggedVectorGroupId !== groupId) {
        const items = buildLayerPanelItems(vectorLayers, vectorGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) {
          const place = dropPlace(e);
          const targetEmpty = !vectorLayers.some(l => l.groupId === groupId);
          moveDraggedGroupToSlot('vector', place === 'before' ? idx : idx + 1, targetEmpty ? groupId : undefined, place);
        }
      }
      return;
    }
    if (!draggedVectorId) return;
    // Hovering the header while dragging a layer targets the group itself.
    // The drop decides: it lands ABOVE the group ("take its place") unless
    // the hover just expanded this group, in which case it joins the folder's
    // end. Holding the hover ~300ms expands a collapsed group so the user can
    // drag on into a precise member position. No live reorder here.
    armHoverExpand('vector', groupId);
  };

  const handleGroupDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      markGroupDragOver(null);
      clearHoverExpand();
    }
  };

  // Drag over the expanded children area of a group (below the header).
  // The header has its own handlers; this covers the dead zone that appears
  // after a hover-expand (or between member rows) so the browser allows the
  // drop and the layer joins the group at its end.
  const handleGroupChildrenDragOver = (e: React.DragEvent, kind: 'raster' | 'vector', groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // A dragged group dropped inside another group's children area lands
    // AFTER that group (the whole block moves below).
    if (kind === 'raster' && draggedRasterGroupId) {
      if (draggedRasterGroupId !== groupId) {
        const items = buildLayerPanelItems(rasterLayers, rasterGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) moveDraggedGroupToSlot('raster', idx + 1);
      }
      return;
    }
    if (kind === 'vector' && draggedVectorGroupId) {
      if (draggedVectorGroupId !== groupId) {
        const items = buildLayerPanelItems(vectorLayers, vectorGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) moveDraggedGroupToSlot('vector', idx + 1);
      }
      return;
    }
  };

  const handleGroupChildrenDrop = (e: React.DragEvent, kind: 'raster' | 'vector', groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markGroupDragOver(null);
    clearHoverExpand();
    if (kind === 'raster') {
      if (draggedRasterGroupId) { handleRasterDragEnd(); return; }
      if (!draggedRasterId) return;
      joinLayerAtGroupEnd('raster', draggedRasterId, groupId);
      handleRasterDragEnd();
    } else {
      if (draggedVectorGroupId) { handleVectorDragEnd(); return; }
      if (!draggedVectorId) return;
      joinLayerAtGroupEnd('vector', draggedVectorId, groupId);
      handleVectorDragEnd();
    }
  };

  // Drag a grouped layer onto the section title to strip its group membership.
  const handleSectionDragOver = (e: React.DragEvent, kind: 'raster' | 'vector') => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markSectionDragOver(kind);
    markGroupDragOver(null);
    if (kind === 'raster') {
      // A dragged group dropped on the section title moves to the very top.
      if (draggedRasterGroupId) {
        moveDraggedGroupToSlot('raster', 0);
        return;
      }
      if (!draggedRasterId) return;
      const dragged = rasterLayers.find(l => l.id === draggedRasterId);
      if (!dragged) return;
      // Dropping a layer on the section title moves it to the very top of
      // the list (and out of any group) - the counterpart of the
      // end-of-list strip, and the way to place a layer above a group that
      // is itself first in the list.
      const items = buildLayerPanelItems(rasterLayers, rasterGroups);
      const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, 0);
      if (next !== rasterLayers) {
        onReorderRasterLayers(next);
        if (dragged.groupId) handleRasterDragEnd(); // reparented out of its group
      }
      const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, 0);
      if (ga) onUpdateRasterGroups(ga);
    } else {
      // A dragged group dropped on the section title moves to the very top.
      if (draggedVectorGroupId) {
        moveDraggedGroupToSlot('vector', 0);
        return;
      }
      if (!draggedVectorId) return;
      const dragged = vectorLayers.find(l => l.id === draggedVectorId);
      if (!dragged) return;
      // Dropping a layer on the section title moves it to the very top of
      // the list (and out of any group) - the counterpart of the
      // end-of-list strip, and the way to place a layer above a group that
      // is itself first in the list.
      const items = buildLayerPanelItems(vectorLayers, vectorGroups);
      const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, 0);
      if (next !== vectorLayers) {
        onReorderVectorLayers(next);
        if (dragged.groupId) handleVectorDragEnd(); // reparented out of its group
      }
      const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, 0);
      if (ga) onUpdateVectorGroups(ga);
    }
  };

  const handleSectionDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      markSectionDragOver(null);
    }
  };

  // Dragging a group over the drop strip below the last row moves it to the
  // end of the list.
  // Dragging onto the end-of-list strip: a group moves its whole block to
  // the end; a layer moves (ungrouped) to the very bottom of the list - the
  // way to place a layer below a group that is itself last in the list.
  const handleRasterListDragOver = (e: React.DragEvent) => {
    if (draggedRasterGroupId) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      moveDraggedGroupToSlot('raster', -1);
      return;
    }
    if (!draggedRasterId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const dragged = rasterLayers.find(l => l.id === draggedRasterId);
    if (!dragged) return;
    const items = buildLayerPanelItems(rasterLayers, rasterGroups);
    const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, -1);
    if (next !== rasterLayers) {
      onReorderRasterLayers(next);
      if (dragged.groupId) handleRasterDragEnd(); // reparented out of its group
    }
    const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, -1);
    if (ga) onUpdateRasterGroups(ga);
  };

  // Dragging onto the end-of-list strip: a group moves its whole block to
  // the end; a layer moves (ungrouped) to the very bottom of the list - the
  // way to place a layer below a group that is itself last in the list.
  const handleVectorListDragOver = (e: React.DragEvent) => {
    if (draggedVectorGroupId) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      moveDraggedGroupToSlot('vector', -1);
      return;
    }
    if (!draggedVectorId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const dragged = vectorLayers.find(l => l.id === draggedVectorId);
    if (!dragged) return;
    const items = buildLayerPanelItems(vectorLayers, vectorGroups);
    const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, -1);
    if (next !== vectorLayers) {
      onReorderVectorLayers(next);
      if (dragged.groupId) handleVectorDragEnd(); // reparented out of its group
    }
    const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, -1);
    if (ga) onUpdateVectorGroups(ga);
  };

  // Releasing a LAYER on a group header is decided by the pointer's half: the
  // TOP half slots the layer in immediately BEFORE the group (ungrouped) - the
  // way to stack a free layer above a folder; the BOTTOM half joins the group
  // at its end (the "drop onto a folder = file into it" gesture, and the
  // outcome of the hover-to-expand flow). Group drags reorder live on dragover
  // and never reach the drop handler.
  const dropLayerOnGroupHeader = (kind: 'raster' | 'vector', groupId: string, place: 'before' | 'after') => {
    if (place === 'before') {
      if (kind === 'raster') {
        if (!draggedRasterId) return;
        const items = buildLayerPanelItems(rasterLayers, rasterGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx === -1) return;
        const next = moveLayerToSlot(rasterLayers, draggedRasterId, items, idx);
        if (next !== rasterLayers) onReorderRasterLayers(next);
        const ga = syncGroupAnchors(rasterLayers, next, rasterGroups, draggedRasterId, idx);
        if (ga) onUpdateRasterGroups(ga);
      } else {
        if (!draggedVectorId) return;
        const items = buildLayerPanelItems(vectorLayers, vectorGroups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx === -1) return;
        const next = moveLayerToSlot(vectorLayers, draggedVectorId, items, idx);
        if (next !== vectorLayers) onReorderVectorLayers(next);
        const ga = syncGroupAnchors(vectorLayers, next, vectorGroups, draggedVectorId, idx);
        if (ga) onUpdateVectorGroups(ga);
      }
      return;
    }
    // Bottom half -> join the group at its end.
    if (kind === 'raster' && draggedRasterId) joinLayerAtGroupEnd('raster', draggedRasterId, groupId);
    else if (kind === 'vector' && draggedVectorId) joinLayerAtGroupEnd('vector', draggedVectorId, groupId);
  };

  // Group header row: expand chevron, folder icon, inline-renameable name,
  // member count, a tri-state eye that toggles the whole cluster at once,
  // and a remove button that dissolves the group but keeps its layers.
  const renderGroupHeader = (kind: 'raster' | 'vector', group: LayerGroup, members: Array<{ id: string; visible?: boolean }>) => {
    const isVisible = (l: { visible?: boolean }) => (kind === 'raster' ? l.visible !== false : l.visible === true);
    const visibleCount = members.filter(isVisible).length;
    const eyeState: 'all' | 'some' | 'none' =
      members.length > 0 && visibleCount === members.length ? 'all' : visibleCount > 0 ? 'some' : 'none';
    const isRenaming = renamingGroupId === group.id;
    const isDragTarget = dragOverGroupId === group.id;
    // While a layer is dragged over this header the drop lands ABOVE the group,
    // unless this group was just auto-expanded by the hover (then it joins the
    // folder's end) - show the matching drop-target cue.
    const willJoinEnd = isDragTarget && hoverExpandedGroupRef.current === group.id;
    const eyeTitle =
      members.length === 0 ? 'Empty group'
      : eyeState === 'none' ? 'Restore the layers\u2019 previous visibility'
      : 'Hide every layer in this group';
    return (
      <div
        className={'settings-group-header' + (isDragTarget ? ' drag-over' : '') + (isDragTarget && !willJoinEnd ? ' drag-over-before' : '')}
        draggable
        onDragStart={(e) => {
          // setData must happen synchronously (Safari refuses to start a
          // drag without it), but every STATE update is deferred one tick:
          // React would otherwise flush the resulting DOM mutations (the
          // 'dragging' class and the drop strip) inside the dragstart
          // event, and Chrome cancels a drag session when the source
          // subtree mutates at that moment.
          if (e.dataTransfer) e.dataTransfer.setData('text/plain', group.id);
          const gid = group.id;
          const gkind = kind;
          dragSessionRef.current = gid;
          window.setTimeout(() => {
            // The drag may already be over (dragend beat this tick) - don't
            // re-apply the dragging state in that case.
            if (dragSessionRef.current !== gid) return;
            if (gkind === 'raster') setDraggedRasterGroupId(gid);
            else setDraggedVectorGroupId(gid);
          }, 0);
        }}
        onDragEnd={() => {
          dragSessionRef.current = null;
          setDraggedRasterGroupId(null);
          setDraggedVectorGroupId(null);
          markGroupDragOver(null);
          markSectionDragOver(null);
        }}
        onDragOver={(e) => (kind === 'raster' ? handleRasterDragOverGroup(e, group.id) : handleVectorDragOverGroup(e, group.id))}
        onDragLeave={handleGroupDragLeave}
        onDrop={(e) => {
          e.preventDefault();
          // A layer dropped on the header lands ABOVE the group ("take its
          // place") - unless this group was just auto-expanded by the hover,
          // in which case the drop joins the folder's end. Read the flag
          // before clearHoverExpand() resets it.
          const joinAtEnd = hoverExpandedGroupRef.current === group.id;
          markGroupDragOver(null);
          clearHoverExpand();
          dropLayerOnGroupHeader(kind, group.id, joinAtEnd ? 'after' : 'before');
          if (kind === 'raster' && draggedRasterId) handleRasterDragEnd();
          else if (kind === 'vector' && draggedVectorId) handleVectorDragEnd();
        }}
        title="Drag to reorder the whole group"
      >
        {/*
          The whole header is the drag surface. The action controls below are
          deliberately <span role="button"> instead of real <button>s: Chrome
          refuses to start a drag from a form control, so real buttons would
          leave dead zones in the header (which is why dragging used to fail
          from the right-hand side - e.g. right after clicking the chevron
          to collapse the group).
        */}
        <span className="settings-drag-handle">{'\u22ee\u22ee'}</span>
        <span className="settings-group-folder"><FolderIcon /></span>
          {isRenaming ? (
            <input
              autoFocus
              type="text"
              className="settings-group-rename"
              value={renameValue}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGroupRename(kind, group);
                if (e.key === 'Escape') setRenamingGroupId(null);
              }}
              onBlur={() => commitGroupRename(kind, group)}
            />
          ) : (
            <span
              className="settings-group-name"
              onDoubleClick={() => startGroupRename(group)}
              title={group.name + ' \u2014 double-click to rename'}
            >
              {group.name}
            </span>
          )}
        <span className="settings-group-count" title={members.length === 1 ? '1 layer' : members.length + ' layers'}>
          {members.length}
        </span>
        <div className="settings-group-header-actions">
          <span
            role="button"
            tabIndex={0}
            className="settings-group-chevron"
            onClick={() => updateGroup(kind, group.id, { expanded: !group.expanded })}
            onKeyDown={spanActivate(() => updateGroup(kind, group.id, { expanded: !group.expanded }))}
            title={group.expanded ? 'Collapse group' : 'Expand group'}
            aria-expanded={group.expanded}
          >
            <span className={'settings-group-chevron-icon' + (group.expanded ? ' expanded' : '')}>{'\u25b8'}</span>
          </span>
          <span
            role="button"
            tabIndex={0}
            className="settings-layer-edit"
            onClick={() => startGroupRename(group)}
            onKeyDown={spanActivate(() => startGroupRename(group))}
            title="Rename group"
          >
            <PencilIcon />
          </span>
          <span
            role="button"
            tabIndex={members.length === 0 ? -1 : 0}
            aria-disabled={members.length === 0}
            className="settings-layer-visibility"
            onClick={() => { if (members.length > 0) (kind === 'raster' ? onToggleRasterGroup(group.id) : onToggleVectorGroup(group.id)); }}
            onKeyDown={spanActivate(() => { if (members.length > 0) (kind === 'raster' ? onToggleRasterGroup(group.id) : onToggleVectorGroup(group.id)); })}
            title={eyeTitle}
          >
            <GroupEyeIcon state={eyeState} />
          </span>
          <span
            role="button"
            tabIndex={0}
            className="settings-layer-remove"
            onClick={() => removeGroup(kind, group.id)}
            onKeyDown={spanActivate(() => removeGroup(kind, group.id))}
            title="Remove group (its layers are kept)"
          >
            &times;
          </span>
        </div>
      </div>
    );
  };

  const renderRasterLayerRow = (layer: RasterLayer, inGroup: boolean) => (
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
                {layer.type === 'wms' && (
                  <div className="settings-checkbox-row" title="When enabled, clicking the map queries the WMS server for the raster attributes at that position.">
                    <input
                      type="checkbox"
                      id={'wms-featureinfo-' + layer.id}
                      checked={editWmsFeatureInfo}
                      onChange={(e) => setEditWmsFeatureInfo(e.target.checked)}
                    />
                    <label htmlFor={'wms-featureinfo-' + layer.id}>GetFeatureInfo (click to inspect)</label>
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
                        updated = { ...layer, name: editName.trim(), wmsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, wmsFeatureInfoEnabled: editWmsFeatureInfo };
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
                className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible === false ? ' layer-off' : '') + (rowDropTarget && rowDropTarget.id === layer.id ? (rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '')}
                draggable
                onDragStart={(e) => handleRasterDragStart(e, layer.id)}
                onDragOver={(e) => handleRasterDragOver(e, layer.id)}
                onDrop={(e) => handleRasterRowDrop(e, layer.id)}
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
                <GroupAssignMenu
                  groups={rasterGroups}
                  currentGroupId={layer.groupId}
                  onAssign={(gid) => onMoveRasterLayerToGroup(layer.id, gid)}
                  onCreateGroup={(name) => createGroupWithLayer('raster', layer.id, name)}
                />
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
                    // Initialize the WMS GetFeatureInfo toggle from the layer value
                    setEditWmsFeatureInfo(!!layer.wmsFeatureInfoEnabled);
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
  );

  const renderRasterGroupBlock = (group: LayerGroup, members: RasterLayer[]) => (
    <div
      key={'raster-group-' + group.id}
      className={'settings-group-block' + (draggedRasterGroupId === group.id ? ' dragging' : '')}
    >
      {renderGroupHeader('raster', group, members)}
      {/*
        Collapsed groups unmount their member rows entirely. (The previous
        always-mounted, CSS-grid 0fr collapse kept a zero-height grid track
        under the header, which stopped Chrome from starting header drags
        on collapsed groups - and its overflow:hidden clipped the per-layer
        group-assignment popovers.)
      */}
      {group.expanded && (
        <div
          className="settings-group-children"
          onDragOver={(e) => handleGroupChildrenDragOver(e, 'raster', group.id)}
          onDrop={(e) => handleGroupChildrenDrop(e, 'raster', group.id)}
          onDragLeave={handleGroupDragLeave}
        >
          <div className="settings-group-children-inner">
            {members.length === 0 ? (
              <div className="settings-group-empty">Empty group {'\u2014'} drag a layer onto this header, or use a layer{'\u2019'}s folder button.</div>
            ) : (
              members.map((layer) => renderRasterLayerRow(layer, true))
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderRasterPanelItems = () => {
    const items = buildLayerPanelItems(rasterLayers, rasterGroups).map((item) =>
      item.kind === 'group'
        ? renderRasterGroupBlock(item.group, item.members)
        : renderRasterLayerRow(item.layer, false)
    );
    // While a group is being dragged, offer an explicit drop strip at the
    // bottom of the list: dropping there moves the whole group to the end.
    if (draggedRasterGroupId || draggedRasterId) {
      items.push(
        <div
          key="raster-dropzone"
          className="settings-group-dropzone"
          onDragOver={(e) => handleRasterListDragOver(e)}
          onDrop={(e) => e.preventDefault()}
        >
          {draggedRasterGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

  const renderVectorLayerRow = (layer: VectorLayerConfig, inGroup: boolean) => (
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
                    {layer.type !== 'mvt' && (() => {
                      // Clustering only applies to point datasets. Inspect the
                      // live features to decide whether the option is available.
                      const stats = layerPointStats(layer.olLayer);
                      const canCluster = stats.total === 0 || stats.pointCount === stats.total;
                      return (
                        <div className={'settings-cluster-control' + (canCluster ? '' : ' disabled')}>
                          <label
                            className="settings-cluster-checkbox"
                            title={canCluster
                              ? 'Group nearby points into count bubbles — ideal for dense point datasets'
                              : 'Clustering needs a point dataset — this layer mixes in lines or polygons'}
                          >
                            <input
                              type="checkbox"
                              checked={vectorEditCluster}
                              disabled={!canCluster}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setVectorEditCluster(checked);
                                onApplyVectorCluster(layer.id, checked, vectorEditClusterDistance);
                              }}
                            />
                            <span className="settings-cluster-label">Point clustering</span>
                            {stats.pointCount > 0 && (
                              <span className="settings-cluster-count" title="Point features in this layer">
                                {stats.pointCount.toLocaleString()} {stats.pointCount === 1 ? 'point' : 'points'}
                              </span>
                            )}
                          </label>
                          {vectorEditCluster && canCluster && (
                            <div className="settings-slider-row">
                              <label className="settings-slider-label">Cluster distance</label>
                              <input
                                type="range"
                                min="10"
                                max="120"
                                value={vectorEditClusterDistance}
                                className="settings-slider"
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10);
                                  setVectorEditClusterDistance(val);
                                  onApplyVectorCluster(layer.id, true, val);
                                }}
                              />
                              <span className="settings-slider-value">{vectorEditClusterDistance}px</span>
                              <button
                                className={'settings-slider-reset' + (vectorEditClusterDistance === 40 ? ' settings-slider-reset-hidden' : '')}
                                onClick={() => {
                                  setVectorEditClusterDistance(40);
                                  onApplyVectorCluster(layer.id, true, 40);
                                }}
                                title="Reset cluster distance"
                                disabled={vectorEditClusterDistance === 40}
                              >↺</button>
                            </div>
                          )}
                        </div>
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
                                units={units}
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
                            clusterPoints: vectorEditCluster,
                            clusterDistance: vectorEditClusterDistance,
                          };
                          onEditVectorLayer(updated);
                          // Applying commits the layer — that also ends any geometry
                          // re-edit session on it, exactly like "Done editing".
                          if (editingVectorLayerId === layer.id) {
                            onReeditVectorLayer(layer.id);
                          }
                          setVectorEditingId(null);
                        }
                      }}>Apply</button>
                      <button className="settings-button-secondary" onClick={() => {
                        onApplyVectorStyle(layer.id, originalVectorStyle);
                        onApplyVectorZoomRange(layer.id, originalVectorZoomRange.min, originalVectorZoomRange.max);
                        onApplyVectorCluster(layer.id, originalVectorCluster.clusterPoints, originalVectorCluster.clusterDistance);
                        setVectorEditCluster(originalVectorCluster.clusterPoints);
                        setVectorEditClusterDistance(originalVectorCluster.clusterDistance);
                        setVectorEditingId(null);
                      }}>Cancel</button>
                      {layer.isDrawnInApp && (
                        <>
                          <button
                            className={`settings-button-reedit ${editingVectorLayerId === layer.id ? 'active' : ''}`}
                            onClick={() => onReeditVectorLayer(layer.id)}
                            title={editingVectorLayerId === layer.id
                              ? 'Finish editing the layer'
                              : 'Edit this layer on the map \u2014 reshape and move its features, draw new ones straight into it, undo/redo included'}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 19l5-11 5 5 6-8" />
                              <rect x="6.9" y="5.9" width="4.2" height="4.2" fill="#fff" />
                            </svg>
                            {editingVectorLayerId === layer.id ? 'Done editing' : 'Re-edit layer'}
                          </button>
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
                    className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible !== true ? ' layer-off' : '') + (rowDropTarget && rowDropTarget.id === layer.id ? (rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '')}
                    draggable
                    onDragStart={(e) => handleVectorDragStart(e, layer.id)}
                    onDragOver={(e) => handleVectorDragOver(e, layer.id)}
                    onDrop={(e) => handleVectorRowDrop(e, layer.id)}
                    onDragEnd={handleVectorDragEnd}
                    style={{ cursor: 'grab', opacity: draggedVectorId === layer.id ? 0.5 : 1 }}
                  >
                    <span className="settings-drag-handle">⋮⋮</span>
                    <span className="settings-layer-name">{layer.name}</span>
                    {loadingVectorIds.has(layer.id) && (
                      <span className="settings-layer-loading" title="Loading data…">
                        <span className="settings-layer-loading-spinner" />
                      </span>
                    )}
                    <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                    {(layer.minZoom !== undefined || layer.maxZoom !== undefined) && (
                      <span className="settings-layer-zoom-chip" title={layer.type === 'mvt' ? 'Tile zoom range' : 'Visible zoom range'}>
                        z{layer.minZoom ?? TILE_ZOOM_MIN}{'\u2013'}{layer.maxZoom ?? TILE_ZOOM_MAX}
                      </span>
                    )}
                    <GroupAssignMenu
                      groups={vectorGroups}
                      currentGroupId={layer.groupId}
                      onAssign={(gid) => onMoveVectorLayerToGroup(layer.id, gid)}
                      onCreateGroup={(name) => createGroupWithLayer('vector', layer.id, name)}
                    />
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
                        const clusterPoints = layer.clusterPoints === true;
                        const clusterDistance = layer.clusterDistance ?? 40;
                        setVectorEditCluster(clusterPoints);
                        setVectorEditClusterDistance(clusterDistance);
                        setOriginalVectorCluster({ clusterPoints, clusterDistance });
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
  );

  const renderVectorGroupBlock = (group: LayerGroup, members: VectorLayerConfig[]) => (
    <div
      key={'vector-group-' + group.id}
      className={'settings-group-block' + (draggedVectorGroupId === group.id ? ' dragging' : '')}
    >
      {renderGroupHeader('vector', group, members)}
      {/* Collapsed groups unmount their member rows - see the raster block. */}
      {group.expanded && (
        <div
          className="settings-group-children"
          onDragOver={(e) => handleGroupChildrenDragOver(e, 'vector', group.id)}
          onDrop={(e) => handleGroupChildrenDrop(e, 'vector', group.id)}
          onDragLeave={handleGroupDragLeave}
        >
          <div className="settings-group-children-inner">
            {members.length === 0 ? (
              <div className="settings-group-empty">Empty group {'\u2014'} drag a layer onto this header, or use a layer{'\u2019'}s folder button.</div>
            ) : (
              members.map((layer) => renderVectorLayerRow(layer, true))
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderVectorPanelItems = () => {
    const items = buildLayerPanelItems(vectorLayers, vectorGroups).map((item) =>
      item.kind === 'group'
        ? renderVectorGroupBlock(item.group, item.members)
        : renderVectorLayerRow(item.layer, false)
    );
    // While a group is being dragged, offer an explicit drop strip at the
    // bottom of the list: dropping there moves the whole group to the end.
    if (draggedVectorGroupId || draggedVectorId) {
      items.push(
        <div
          key="vector-dropzone"
          className="settings-group-dropzone"
          onDragOver={(e) => handleVectorListDragOver(e)}
          onDrop={(e) => e.preventDefault()}
        >
          {draggedVectorGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

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
          <div
            className="settings-section-title-row"
            onDragOver={(e) => handleSectionDragOver(e, 'raster')}
            onDragLeave={handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dragOverSection === 'raster' ? ' drag-over' : '')}>Raster Layers</div>
            <button
              type="button"
              className="settings-new-group-btn"
              onClick={() => addGroup('raster')}
              title="Create a folder to organise raster layers"
            >
              <FolderPlusIcon /> New group
            </button>
          </div>
          {isRestoringLayers && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Restoring raster layers...</span>
            </div>
          )}
          <div className="settings-layers-list">
            {renderRasterPanelItems()}
          </div>
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
          <div
            className="settings-section-title-row"
            onDragOver={(e) => handleSectionDragOver(e, 'vector')}
            onDragLeave={handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dragOverSection === 'vector' ? ' drag-over' : '')}>Vector Layers</div>
            <button
              type="button"
              className="settings-new-group-btn"
              onClick={() => addGroup('vector')}
              title="Create a folder to organise vector layers"
            >
              <FolderPlusIcon /> New group
            </button>
          </div>
          {isRestoringLayers && (
            <div className="settings-loading-indicator">
              <div className="settings-loading-spinner"></div>
              <span>Restoring vector layers...</span>
            </div>
          )}
          {vectorLayers.length === 0 && vectorGroups.length === 0 ? (
            <p className="settings-placeholder">No vector layers added yet. Drag and drop GeoJSON, KML, or KMZ files onto the map.</p>
          ) : (
            <div className="settings-layers-list">
              {renderVectorPanelItems()}
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
                      const src = knownSources.find(s => s.id === val);
                      // STAC sources only store a URL: jump into the STAC form so the
                      // collection can be picked from the live dropdown.
                      if (src && src.type === 'stac') {
                        setVectorSourceType('stac');
                        setMvtUrl(src.url);
                        if (!mvtLayerName.trim()) setMvtLayerName(src.name);
                        setStacCollection('');
                        setSelectedVectorSourceId('');
                        fetchStacCollections(src.url);
                        return;
                      }
                      setSelectedVectorSourceId(val);
                      // Auto-fill name from source if name field is empty
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
        <div className="settings-footer-left">
          <button
            className="settings-lock-button"
            onClick={onLockApp}
            title="Lock app — encrypts your saved data behind a password"
            aria-label="Lock app"
          >
            <LockIcon />
          </button>
          <WorkspaceSelector
            workspaceId={workspaceId}
            workspaces={workspaces}
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onRename={onRenameWorkspace}
            onDuplicate={onDuplicateWorkspace}
            onDelete={onDeleteWorkspace}
          />
        </div>
        <span className="settings-advanced-link" onClick={onAdvancedSettings}>Advanced Settings</span>
      </div>
    </div>
  );
}

/** Small globe glyph used in the "Edit Base Map" section header. */
function UnitsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.3 8.7 15.3 2.7a1 1 0 0 0-1.4 0L2.7 13.9a1 1 0 0 0 0 1.4l6 6a1 1 0 0 0 1.4 0L21.3 10.1a1 1 0 0 0 0-1.4z" />
      <path d="m7.5 10.5 2 2" />
      <path d="m10.5 7.5 2 2" />
      <path d="m13.5 4.5 2 2" />
    </svg>
  );
}

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
  units,
  onUnitsChange,
}: { 
  onClose: () => void;
  knownSources: KnownSource[];
  onUpdateSources: (sources: KnownSource[]) => void;
  basemapUrl: string;
  onBasemapChange: (url: string) => void;
  basemapMinZoom?: number;
  basemapMaxZoom?: number;
  onBasemapZoomRangeChange: (minZoom?: number, maxZoom?: number) => void;
  units: UnitsSystem;
  onUnitsChange: (units: UnitsSystem) => void;
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
  const [vNewExtra, setVNewExtra] = useState(''); // WFS type name
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
    // WFS needs its type name; STAC picks its collection when added to the map
    if (vNewType === 'wfs' && !vNewExtra.trim()) return;
    const newSource: KnownSource = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      name: vNewName.trim(),
      type: vNewType,
      url: vNewUrl.trim(),
      ...(vNewType === 'wfs' ? { wfsTypeName: vNewExtra.trim() } : {}),
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
    if (vEditType === 'wfs' && !vEditExtra.trim()) return;
    onUpdateSources(knownSources.map(s =>
      s.id === vEditingId ? {
        ...s,
        name: vEditName.trim(),
        type: vEditType,
        url: vEditUrl.trim(),
        wfsTypeName: vEditType === 'wfs' ? vEditExtra.trim() : undefined,
        stacCollection: undefined,
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
    setVEditExtra(t === 'wfs' ? (source.wfsTypeName || '') : '');
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
              <UnitsIcon />
              Measurement Units
            </div>
            <p className="advanced-settings-section-desc">
              Unit system for drawing measurements (segment lengths and areas) and the map scale line. Changes apply instantly to features already on the map.
            </p>
            <div className="units-toggle" role="radiogroup" aria-label="Measurement units">
              <button
                type="button"
                role="radio"
                aria-checked={units === 'metric'}
                className={'units-toggle-option' + (units === 'metric' ? ' active' : '')}
                onClick={() => onUnitsChange('metric')}
              >
                <span className="units-toggle-name">Metric</span>
                <span className="units-toggle-units">m &middot; km &middot; m&sup2; &middot; km&sup2;</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={units === 'imperial'}
                className={'units-toggle-option' + (units === 'imperial' ? ' active' : '')}
                onClick={() => onUnitsChange('imperial')}
              >
                <span className="units-toggle-name">Imperial</span>
                <span className="units-toggle-units">ft &middot; mi &middot; ft&sup2; &middot; mi&sup2;</span>
              </button>
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
                      <div className="advanced-settings-form-buttons">
                        <button
                          className="settings-button-primary"
                          onClick={handleVEdit}
                          disabled={vEditType === 'wfs' && !vEditExtra.trim()}
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
                      {source.wfsTypeName && (
                        <div className="advanced-settings-source-url">
                          Type: {source.wfsTypeName}
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
                <div className="advanced-settings-form-buttons">
                  <button
                    className="settings-button-primary"
                    onClick={handleVAdd}
                    disabled={vNewType === 'wfs' && !vNewExtra.trim()}
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

// Tools available on the draw toolbar: four draw tools that create new
// features, plus 'modify', which re-edits the geometry of features that have
// already been drawn (drag vertices, insert on a segment, remove with Alt).
type DrawToolId = 'line' | 'polygon' | 'rectangle' | 'label' | 'modify' | null;

// DrawToolbar component
function DrawToolbar({ 
  activeTool, 
  onToolSelect,
  undoDepth,
  redoDepth,
  onUndo,
  onRedo,
  showHistory,
}: { 
  activeTool: DrawToolId;
  onToolSelect: (tool: DrawToolId) => void;
  undoDepth: number;
  redoDepth: number;
  onUndo: () => void;
  onRedo: () => void;
  showHistory: boolean;
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
      <div className="draw-toolbar-divider" aria-hidden="true" />
      <button
        className={`draw-toolbar-button ${activeTool === 'modify' ? 'active' : ''}`}
        onClick={() => onToolSelect(activeTool === 'modify' ? null : 'modify')}
        title="Edit vertices — drag to reshape drawn features"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19l5-11 5 5 6-8" />
          <rect x="6.9" y="5.9" width="4.2" height="4.2" fill="#fff" />
        </svg>
      </button>
      {showHistory && (
        <div className="draw-toolbar-history">
          <div className="draw-toolbar-divider" aria-hidden="true" />
          <button
            className="draw-toolbar-button"
            onClick={onUndo}
            disabled={undoDepth === 0}
            title="Undo (Ctrl+Z)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v1" />
            </svg>
          </button>
          <button
            className="draw-toolbar-button"
            onClick={onRedo}
            disabled={redoDepth === 0}
            title="Redo (Ctrl+Shift+Z)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v1" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// Label Input Dialog component - appears at map position for label text entry
function LabelInputDialog({
  pixel,
  initialText,
  onApply,
  onCancel,
}: {
  pixel: [number, number];
  initialText?: string;
  onApply: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const initialTextRef = useRef(initialText);

  useEffect(() => {
    // Auto-focus the input when the dialog appears; pre-existing text is
    // selected so typing immediately replaces it.
    if (inputRef.current) {
      inputRef.current.focus();
      if (initialTextRef.current) {
        inputRef.current.select();
      }
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
      <div className="label-input-dialog-title">{initialText !== undefined ? 'Edit Label' : 'Enter Label'}</div>
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
  units,
}: {
  feature: any;
  index: number;
  onApply: (feature: any, style: DrawStyle) => void;
  units: UnitsSystem;
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
        {(() => {
          const measure = getFeatureMeasurementText(feature, units);
          return measure ? (
            <span className="drawn-features-item-measure" title={geomType === 'LineString' ? 'Total length' : 'Area'}>
              {measure}
            </span>
          ) : null;
        })()}
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
  onEditLabelText,
  units,
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
  onEditLabelText: (feature: any) => void;
  units: UnitsSystem;
  // Bumped after vertex edits; a fresh value re-renders the panel so the
  // per-feature length/area readouts reflect the edited geometry.
  measureVersion: number;
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
                    {(() => {
                      const measure = getFeatureMeasurementText(item.feature, units);
                      return measure ? (
                        <span className="drawn-features-item-measure" title={item.type === 'LineString' ? 'Total length' : 'Area'}>
                          {measure}
                        </span>
                      ) : null;
                    })()}
                    {item.customized && (
                      <span className="drawn-features-customized-dot" title="Custom style" />
                    )}
                    {item.type === 'Point' && (
                      <button
                        className="drawn-features-item-edit-text"
                        onClick={(e) => { e.stopPropagation(); onEditLabelText(item.feature); }}
                        title="Edit label text"
                      >
                        <PencilIcon />
                      </button>
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

interface MapPageProps {
  workspaceId: string;
  workspaces: WorkspaceMeta[];
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDuplicateWorkspace: (id: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onLockApp: () => void;
}

function MapPage({
  workspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDuplicateWorkspace,
  onDeleteWorkspace,
  onLockApp,
}: MapPageProps) {
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
  // The component is remounted (via key) whenever the active workspace
  // changes, so this loads the incoming workspace's persisted setup.
  const storedSettings = useRef(loadSettings(workspaceId));
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
  const [units, setUnits] = useState<UnitsSystem>(storedSettings.current.units);
  const unitsRef = useRef<UnitsSystem>(units);
  const scaleLineRef = useRef<ScaleLine | null>(null);
  const appliedBasemapKeyRef = useRef<string>(
    basemapSourceKey(storedSettings.current.basemapUrl, storedSettings.current.basemapMinZoom, storedSettings.current.basemapMaxZoom)
  );
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>(storedSettings.current.rasterLayers);
  const [vectorLayers, setVectorLayers] = useState<VectorLayerConfig[]>([]);
  const [rasterGroups, setRasterGroups] = useState<LayerGroup[]>(storedSettings.current.rasterGroups);
  const [vectorGroups, setVectorGroups] = useState<LayerGroup[]>(storedSettings.current.vectorGroups);
  const [isRestoringLayers, setIsRestoringLayers] = useState(storedSettings.current.rasterLayers.length > 0 || storedSettings.current.vectorLayers.length > 0);
  // IDs of vector layers currently fetching data (STAC/WFS initial load, MVT tiles).
  const [loadingVectorIds, setLoadingVectorIds] = useState<Set<string>>(new Set());
  const markVectorLoading = useCallback((layerId: string, loading: boolean) => {
    setLoadingVectorIds(prev => {
      if (prev.has(layerId) === loading) return prev; // no-op, avoid re-render
      const next = new Set(prev);
      if (loading) next.add(layerId); else next.delete(layerId);
      return next;
    });
  }, []);
  // MVT tiles load incrementally: track a per-layer pending-tile counter.
  const wireVectorTileLoading = useCallback((source: any, layerId: string) => {
    let pending = 0;
    source.on('tileloadstart', () => {
      pending += 1;
      if (pending === 1) markVectorLoading(layerId, true);
    });
    const tileDone = () => {
      pending = Math.max(0, pending - 1);
      if (pending === 0) markVectorLoading(layerId, false);
    };
    source.on('tileloadend', tileDone);
    source.on('tileloaderror', tileDone);
  }, [markVectorLoading]);
  const [isDragging, setIsDragging] = useState(false);
  const [popupContent, setPopupContent] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<[number, number] | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const popupOverlayRef = useRef<Overlay | null>(null);
  // WMS layers whose GetFeatureInfo toggle is on. Mirrors rasterLayers for the
  // once-registered map click handler (its closure only sees initial state).
  const wmsFeatureInfoRef = useRef<Array<{ id: string; name: string; olLayer: any }>>([]);
  // Monotonic counter so stale async GetFeatureInfo responses never overwrite
  // the popup belonging to a newer click.
  const popupClickSeqRef = useRef(0);
  const [activeDrawTool, setActiveDrawTool] = useState<DrawToolId>(null);
  // Mirrors activeDrawTool for the once-registered map click handler (its closure
  // only ever sees the initial state value).
  const activeDrawToolRef = useRef<DrawToolId>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const modifyInteractionRef = useRef<Modify | null>(null);
  // Bumped after every vertex edit so the drawn-features panel and layer
  // edit menus re-render and their length/area readouts pick up the edited
  // geometry.
  const [measureTick, setMeasureTick] = useState(0);
  // Id of the saved drawn-in-app layer currently being re-edited in place
  // (null while none is). Geometry edits run through a Modify interaction
  // bound to that layer's own source.
  const [editingVectorLayerId, setEditingVectorLayerId] = useState<string | null>(null);
  const editingVectorLayerIdRef = useRef<string | null>(null);
  const layerModifyInteractionRef = useRef<Modify | null>(null);
  // Whole-feature drag-to-move companions for the two Modify interactions.
  const drawTranslateRef = useRef<Translate | null>(null);
  const layerTranslateRef = useRef<Translate | null>(null);
  // Overlay source holding the single "picked up vertex" marker.
  const editMarkerSourceRef = useRef<VectorSource | null>(null);
  const editMarkerFeatureRef = useRef<any>(null);
  // Accent colour (vertex handles + marker) for the current edit session.
  const editAccentRef = useRef<string>(DEFAULT_DRAW_STYLE.lineColor);
  const doubleClickZoomRef = useRef<any>(null);
  // Vertex picked up with a click: follows the pointer until the next click
  // places it; Delete removes it, Escape puts it back.
  const [stickyVertex, setStickyVertex] = useState<VertexHit | null>(null);
  const stickyVertexRef = useRef<VertexHit | null>(null);
  // Undo/redo history for the draw session — stepped from the toolbar
  // buttons or Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
  const historyRef = useRef<{ stack: Array<{ snap: SessionSnapshot; key: string }>; index: number }>({ stack: [], index: -1 });
  // Separate stack for saved-layer re-edit sessions, so the drawing batch's
  // history and a layer's history never tangle.
  const layerHistoryRef = useRef<{ stack: Array<{ snap: SessionSnapshot; key: string }>; index: number }>({ stack: [], index: -1 });
  // Style seed for features drawn into a layer during its re-edit session —
  // the layer's own colours, kept live by the style preview.
  const reeditStyleSeedRef = useRef<DrawStyle>({ ...DEFAULT_DRAW_STYLE });
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
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
  // Mirror of drawnFeatures for OL event callbacks, which are registered
  // once and can't read fresh state directly.
  const drawnFeaturesRef = useRef<typeof drawnFeatures>([]);
  const [showDrawnPanel, setShowDrawnPanel] = useState(false);
  const [labelDialogState, setLabelDialogState] = useState<{
    pixel: [number, number];
    feature: any;
    featureId: string;
    existingText?: string; // present → re-editing an existing label's text
    targetSource?: any; // source the label's feature lives in
    toLayer?: boolean; // label belongs to a saved layer being re-edited
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
    const scaleLineControl = new ScaleLine({
      units: storedSettings.current.units === 'imperial' ? 'imperial' : 'metric',
    });
    scaleLineRef.current = scaleLineControl;

    const { center, zoom } = getInitialView(workspaceId);

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
      // A picked-up vertex follows the pointer until it is placed — even
      // while a mouse button happens to be held down.
      const sticky = stickyVertexRef.current;
      if (sticky) {
        setVertexCoordinate(sticky.geom, sticky.indexPath, evt.coordinate as number[]);
        if (editMarkerFeatureRef.current) {
          editMarkerFeatureRef.current.getGeometry().setCoordinates(evt.coordinate);
        }
        (map.getTargetElement() as HTMLElement).style.cursor = 'grabbing';
        if (!evt.dragging) setMouseCoord(evt.coordinate as [number, number]);
        return;
      }

      if (evt.dragging) return;
      setMouseCoord(evt.coordinate as [number, number]);

      // While geometry is being edited — the draw toolbar's edit tool or a
      // saved layer's re-edit session — the cursor says what a press will
      // do: grab over a vertex, move over the feature body.
      const reeditLayerId = editingVectorLayerIdRef.current;
      const activeToolNow = activeDrawToolRef.current;
      const editCursorMode = activeToolNow === 'modify' || (reeditLayerId !== null && activeToolNow === null);
      if (editCursorMode) {
        const editSource = reeditLayerId !== null
          ? getLayerRawSource(reeditLayerId)
          : drawSourceRef.current;
        let cursor = '';
        if (editSource && findNearestVertex(map, editSource, evt.pixel as number[], 12)) {
          cursor = 'grab';
        } else {
          const reeditLayer = reeditLayerId !== null ? vectorLayersRef.current.get(reeditLayerId) : null;
          const overEditable = map.hasFeatureAtPixel(evt.pixel, {
            hitTolerance: 6,
            layerFilter: (candidate: any) =>
              reeditLayerId !== null ? candidate === reeditLayer : candidate === drawLayerRef.current,
          });
          cursor = overEditable ? 'move' : '';
        }
        (map.getTargetElement() as HTMLElement).style.cursor = cursor;
      }
    });

    // Setup drawing layer with style function
    const drawSource = new VectorSource();
    
    const drawLayerStyle = (feature: any) => {
      const ds = drawStyleRef.current;
      const styles: Style[] = [buildDrawFeatureStyle(ds, feature.get('labelText'))];
      const geom = feature.getGeometry();
      if (geom) {
        styles.push(...buildMeasurementStyles(geom, ds, unitsRef.current));
      }
      return styles;
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

    // Overlay for the "picked up" vertex marker — reorderLayers knows to
    // keep it above every other layer.
    const editMarkerSource = new VectorSource();
    const editMarkerLayer = new VectorLayer({ source: editMarkerSource, zIndex: 10001 });
    editMarkerLayer.set('_isEditMarkerLayer', true);
    map.addLayer(editMarkerLayer);
    editMarkerSourceRef.current = editMarkerSource;

    // Edit sessions suspend double-click zoom so a quick second click places
    // the picked-up vertex instead of zooming the map.
    doubleClickZoomRef.current =
      map.getInteractions().getArray().find((interaction: any) => interaction instanceof DoubleClickZoom) || null;


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

    // Double-clicking a label while editing reopens its text dialog (the
    // map's double-click zoom is suspended during edit sessions, so the
    // gesture is free to use).
    map.on('dblclick', (evt) => {
      handleEditDoubleClick(evt);
    });

    // Click handler for feature info — shows attributes for *every* vector
    // feature under the clicked point (grouped by layer, topmost first) and,
    // for WMS layers with GetFeatureInfo enabled, queries the server for the
    // raster attributes at that position.
    map.on('click', (evt) => {
      // While a draw tool is active clicks place vertices, and while a saved
      // layer is being re-edited clicks grab vertices — suppress the
      // feature-info popup in both cases so editing isn't interrupted by it.
      if (activeDrawToolRef.current !== null || editingVectorLayerIdRef.current !== null) {
        // Edit modes own clicks: pick up / place vertices, insert on segments.
        handleEditClick(evt);
        return;
      }

      // Bump the click sequence first so any GetFeatureInfo responses still in
      // flight from an earlier click are discarded the moment a new click lands.
      const clickSeq = ++popupClickSeqRef.current;
      const coordinate = evt.coordinate as [number, number];

      // Clicking a cluster bubble zooms in to expand it rather than inspecting
      // the aggregate - the standard clustering interaction.
      let clickedCluster = false;
      map.forEachFeatureAtPixel(evt.pixel, (feature: any) => {
        const members = feature && feature.get ? feature.get('features') : undefined;
        if (Array.isArray(members) && members.length > 1) {
          clickedCluster = true;
          return true; // stop hit-testing
        }
      });
      if (clickedCluster) {
        const view = map.getView();
        view.animate({ zoom: (view.getZoom() ?? 0) + 2, center: coordinate, duration: 300 });
        setPopupContent(null);
        setPopupPosition(null);
        return;
      }

      // Collect all vector features at the pixel, grouped by layer in
      // topmost-first order. A single feature can be reported more than once
      // (one per style part, e.g. stroke + fill), so dedupe by feature identity.
      const hitsByLayer = new Map<any, Array<{ feature: any; metadata: Record<string, any> }>>();
      const seenFeatures = new Set<any>();

      map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
        if (!layer || seenFeatures.has(feature)) return;
        seenFeatures.add(feature);

        // A lone point in a clustered layer is wrapped in a single-member
        // cluster feature - unwrap it so the popup shows the real attributes.
        let target: any = feature;
        const clusterMembers = feature && feature.get ? feature.get('features') : undefined;
        if (Array.isArray(clusterMembers) && clusterMembers.length === 1) {
          target = clusterMembers[0];
        }

        const properties = target.getProperties();
        const metadata: Record<string, any> = {};
        Object.keys(properties).forEach(key => {
          const value = properties[key];
          if (key === 'geometry') return;
          if (typeof value === 'object' && value !== null && value.getType) return;
          metadata[key] = value;
        });
        if (Object.keys(metadata).length === 0) return;

        if (!hitsByLayer.has(layer)) hitsByLayer.set(layer, []);
        hitsByLayer.get(layer)!.push({ feature: target, metadata });
      });

      // WMS layers with GetFeatureInfo toggled on that are currently visible.
      const wmsInfoLayers = wmsFeatureInfoRef.current.filter(entry => {
        const ol = entry.olLayer;
        return ol && ol.getVisible?.() !== false && ol.getSource?.();
      });

      if (hitsByLayer.size === 0 && wmsInfoLayers.length === 0) {
        setPopupContent(null);
        setPopupPosition(null);
        return;
      }

      const vectorFeatureCount = Array.from(hitsByLayer.values())
        .reduce((count, entries) => count + entries.length, 0);

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

      // Build the popup sections for the vector features under the pointer.
      // `collapsible` switches between a flat layout (single hit overall) and
      // per-feature collapsible blocks (multiple hits).
      const buildVectorSections = (collapsible: boolean): string[] => {
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
        return sections;
      };

      // Build the popup sections for resolved GetFeatureInfo results.
      const buildWmsSections = (
        results: Array<{ name: string; result: WmsFeatureInfoResult | null }>,
        collapsible: boolean
      ): string[] => {
        const sections: string[] = [];
        results.forEach(({ name, result }) => {
          if (!result) {
            sections.push(
              '<div class="popup-section">' +
                '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                '<div class="popup-row popup-row-muted">No feature info available</div>' +
              '</div>'
            );
            return;
          }

          if ('features' in result) {
            if (result.features.length === 0) {
              sections.push(
                '<div class="popup-section">' +
                  '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                  '<div class="popup-row popup-row-muted">No attributes at this location</div>' +
                '</div>'
              );
              return;
            }

            if (result.features.length === 1) {
              if (!collapsible) {
                sections.push(
                  '<div class="popup-section">' +
                    '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                    renderRows(result.features[0]) +
                  '</div>'
                );
              } else {
                sections.push(
                  '<div class="popup-section">' + renderFeatureBlock(name, result.features[0]) + '</div>'
                );
              }
              return;
            }

            // Several attributes sets from the same layer — one collapsible
            // block per feature.
            const blocks = result.features.map((props, index) =>
              renderFeatureBlock(name + ' \u2014 ' + (index + 1), props)
            );
            sections.push(
              '<div class="popup-section">' +
                '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
                blocks.join('') +
              '</div>'
            );
            return;
          }

          // Raw (non-JSON) payload — show it verbatim.
          sections.push(
            '<div class="popup-section">' +
              '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
              '<pre class="popup-pre">' + escapeHtml(result.text) + '</pre>' +
            '</div>'
          );
        });
        return sections;
      };

      // Assemble the full popup HTML from vector hits + resolved WMS results,
      // choosing the collapsible layout based on the combined hit count.
      const buildPopup = (
        wmsResults: Array<{ name: string; result: WmsFeatureInfoResult | null }>
      ): string => {
        const wmsFeatureCount = wmsResults.reduce((count, r) => {
          const res = r.result;
          return res && 'features' in res ? count + res.features.length : count;
        }, 0);
        const collapsible = vectorFeatureCount + wmsFeatureCount > 1;
        return [...buildVectorSections(collapsible), ...buildWmsSections(wmsResults, collapsible)].join('');
      };

      // No WMS layers to query — render synchronously (original behaviour).
      if (wmsInfoLayers.length === 0) {
        setPopupContent(buildPopup([]));
        setPopupPosition(coordinate);
        return;
      }

      // WMS present — show what we already know (vector hits) plus a loading
      // indicator per WMS layer, then fill in results as they arrive.
      const loadingSections = wmsInfoLayers.map(({ name }) =>
        '<div class="popup-section">' +
          '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
          '<div class="popup-row popup-loading"><span class="popup-loading-spinner"></span>Querying feature info\u2026</div>' +
        '</div>'
      );
      setPopupContent([...buildVectorSections(vectorFeatureCount > 1), ...loadingSections].join(''));
      setPopupPosition(coordinate);

      Promise.all(
        wmsInfoLayers.map(async ({ name, olLayer }) => ({
          name,
          result: await fetchWmsFeatureInfo(olLayer, coordinate, map),
        }))
      ).then(wmsResults => {
        // A newer click has already taken over the popup — drop stale results.
        if (popupClickSeqRef.current !== clickSeq) return;
        setPopupContent(buildPopup(wmsResults));
        setPopupPosition(coordinate);
      }).catch(() => {
        // Defensive: never leave the popup stuck on the loading indicator.
        if (popupClickSeqRef.current !== clickSeq) return;
        setPopupContent(buildPopup([]));
        setPopupPosition(coordinate);
      });
    });

    map.on('moveend', () => updateUrlParams(mapview, workspaceId));

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
          wireVectorTileLoading(source, layerConfig.id);

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
              markVectorLoading(layerConfig.id, true);
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(layerConfig.id, false);
                })
                .catch(e => {
                  console.error('WFS restore error:', e);
                  markVectorLoading(layerConfig.id, false);
                });
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
          // Re-apply any persisted point clustering
          if (layerConfig.clusterPoints) {
            applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
          }
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
              markVectorLoading(layerConfig.id, true);
              fetchAllStacItems(layerConfig.url || '', layerConfig.stacCollection || '', layerConfig.stacLimit)
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(layerConfig.id, false);
                })
                .catch(e => {
                  console.error('STAC restore error:', e);
                  markVectorLoading(layerConfig.id, false);
                });
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
          // Re-apply any persisted point clustering
          if (layerConfig.clusterPoints) {
            applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
          }
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
            applyDrawFeatureStyle(f, ds, () => unitsRef.current);
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
          // Re-apply any persisted point clustering
          if (layerConfig.clusterPoints) {
            applyVectorClusteringToLayer(olLayer, true, layerConfig.clusterDistance, { ...layerConfig, opacity: layerConfig.opacity ?? 100 });
          }
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

    // Session-wide undo/redo shortcuts — Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and
    // Ctrl/Cmd+Y — ignored while typing in a field.
    const handleHistoryKeys = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (k === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };

    // Delete removes the picked-up vertex (or its whole label feature);
    // Escape puts it back where it was picked up.
    const handleEditKeys = (e: KeyboardEvent) => {
      if (!stickyVertexRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteStickyTarget();
      } else if (e.key === 'Escape') {
        cancelStickyVertex();
      }
    };
    window.addEventListener('keydown', handleEditKeys);
    window.addEventListener('keydown', handleHistoryKeys);

    return () => {
      window.removeEventListener('keydown', handleEditKeys);
      window.removeEventListener('keydown', handleHistoryKeys);
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

  // Latest serializable snapshot, kept in a ref so the unmount-only flush
  // below always persists the final state without re-running on every change.
  const latestSettingsRef = useRef<StoredSettings | null>(null);
  useEffect(() => {
    const snapshot = { settingsPinned, showBasemap, basemapUrl, basemapMinZoom, basemapMaxZoom, units, showGrid, showDrawToolbar, showCoordinates, rasterLayers, rasterGroups, vectorLayers, vectorGroups };
    latestSettingsRef.current = snapshot;
    saveSettings(snapshot, workspaceId);
  }, [settingsPinned, showBasemap, basemapUrl, basemapMinZoom, basemapMaxZoom, units, showGrid, showDrawToolbar, showCoordinates, rasterLayers, rasterGroups, vectorLayers, vectorGroups, workspaceId]);

  // Flush once more on unmount (i.e. when switching workspaces) so the
  // outgoing workspace's storage always reflects its last committed state.
  // workspaceId is stable for the lifetime of this mount (remount via key).
  useEffect(() => {
    return () => {
      if (latestSettingsRef.current) {
        saveSettings(latestSettingsRef.current, workspaceId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the GetFeatureInfo-enabled WMS layer list in sync with rasterLayers so
  // the once-registered map click handler always sees the current toggle state.
  useEffect(() => {
    wmsFeatureInfoRef.current = rasterLayers
      .filter(l => l.type === 'wms' && l.wmsFeatureInfoEnabled && l.olLayer)
      .map(l => ({ id: l.id, name: l.name, olLayer: l.olLayer }));
  }, [rasterLayers]);

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

  // Same mirror for the saved-layer re-edit session.
  useEffect(() => {
    editingVectorLayerIdRef.current = editingVectorLayerId;
  }, [editingVectorLayerId]);

  useEffect(() => {
    drawnFeaturesRef.current = drawnFeatures;
  }, [drawnFeatures]);

  // Double-click zoom steps aside for the duration of any edit session so a
  // quick second click places the picked-up vertex instead of zooming.
  useEffect(() => {
    const editSession = activeDrawTool === 'modify' || editingVectorLayerId !== null;
    if (doubleClickZoomRef.current) {
      doubleClickZoomRef.current.setActive(!editSession);
    }
  }, [activeDrawTool, editingVectorLayerId]);

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
        if (modifyInteractionRef.current && mapRef.current) {
          mapRef.current.removeInteraction(modifyInteractionRef.current);
          modifyInteractionRef.current = null;
        }
        if (drawTranslateRef.current && mapRef.current) {
          mapRef.current.removeInteraction(drawTranslateRef.current);
          drawTranslateRef.current = null;
        }
        if (stickyVertexRef.current) {
          exitStickyVertex();
        }
        setActiveDrawTool(null);
      }
      // Clear unsaved drawn features from the map
      if (drawSourceRef.current) {
        drawSourceRef.current.clear();
      }
      setDrawnFeatures([]);
      resetHistory();
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

      // Preserve the layer's current visibility: recreating the OL layer resets
      // it to visible, which would make a toggled-off layer reappear on apply.
      newOlLayer.setVisible(updated.visible !== false);

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
      const layerId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      const source = new VectorTileSource({
        format: new MVT(),
        url: url,
      });

      const { lineColor, fillColor } = getRandomVectorColors();

      const olLayer = new VectorTileLayer({
        source: source,
        style: buildVectorStyle({ lineColor, fillColor, lineWidth: 2 }),
      });
      wireVectorTileLoading(source, layerId);

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: layerId,
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
      const layerId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      const wfsUrl = buildWfsUrl(url, typeName);
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: (extent: any, resolution: any, projection: any) => {
          markVectorLoading(layerId, true);
          fetch(wfsUrl)
            .then(r => {
              if (!r.ok) throw new Error('WFS request failed: ' + r.status);
              return r.json();
            })
            .then(data => {
              const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
              source.addFeatures(features);
              markVectorLoading(layerId, false);
            })
            .catch(e => {
              console.error('WFS load error:', e);
              markVectorLoading(layerId, false);
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
        id: layerId,
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
      const layerId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      const { lineColor, fillColor } = getRandomVectorColors();

      const source = new VectorSource({
        format: new GeoJSON(),
        loader: () => {
          markVectorLoading(layerId, true);
          fetchAllStacItems(url, collection, limit)
            .then(data => {
              const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
              source.addFeatures(features);
              markVectorLoading(layerId, false);
            })
            .catch(e => {
              console.error('STAC load error:', e);
              markVectorLoading(layerId, false);
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
        id: layerId,
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

  // Re-edit the geometry of a saved drawn-in-app layer in place: a Modify
  // interaction on the layer's own source gives the same affordances as the
  // draw toolbar's edit tool — drag vertices, click a segment to insert one,
  // Alt+click a vertex to remove it. Because persistence serialises the live
  // source, edits are reflected in the next session automatically. Clicking
  // the button again (or removing the layer) ends the session.
  const handleReeditVectorLayer = (layerId: string) => {
    const map = mapRef.current;
    if (!map) return;

    // Clicking again on the layer being edited finishes the session.
    if (editingVectorLayerId === layerId) {
      editingVectorLayerIdRef.current = null;
      if (stickyVertexRef.current) exitStickyVertex();
      if (layerModifyInteractionRef.current) {
        map.removeInteraction(layerModifyInteractionRef.current);
        layerModifyInteractionRef.current = null;
      }
      if (layerTranslateRef.current) {
        map.removeInteraction(layerTranslateRef.current);
        layerTranslateRef.current = null;
      }
      setEditingVectorLayerId(null);
      layerHistoryRef.current = { stack: [], index: -1 };
      syncHistoryDepth(); // button depths now mirror the drawing batch again
      (map.getTargetElement() as HTMLElement).style.cursor = '';
      return;
    }

    // Geometry editing is exclusive — leave any active draw tool first.
    if (drawInteractionRef.current) {
      map.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    if (modifyInteractionRef.current) {
      map.removeInteraction(modifyInteractionRef.current);
      modifyInteractionRef.current = null;
    }
    if (drawTranslateRef.current) {
      map.removeInteraction(drawTranslateRef.current);
      drawTranslateRef.current = null;
    }
    if (activeDrawTool !== null) {
      setActiveDrawTool(null);
    }

    // Move an ongoing re-edit session to the newly chosen layer — each
    // layer gets a fresh undo history.
    if (stickyVertexRef.current) exitStickyVertex();
    layerHistoryRef.current = { stack: [], index: -1 };
    if (layerModifyInteractionRef.current) {
      map.removeInteraction(layerModifyInteractionRef.current);
      layerModifyInteractionRef.current = null;
    }
    if (layerTranslateRef.current) {
      map.removeInteraction(layerTranslateRef.current);
      layerTranslateRef.current = null;
    }

    const olLayer = vectorLayersRef.current.get(layerId);
    const source = olLayer && olLayer.getSource ? olLayer.getSource() : null;
    if (!source) return;

    // Handles pick up the layer's own line colour so they read as part of it.
    const layerConfig = vectorLayers.find(l => l.id === layerId);
    const accent = layerConfig?.lineColor || drawStyleRef.current.lineColor;
    editAccentRef.current = accent;

    // Features drawn during the session take on the layer's own colours.
    reeditStyleSeedRef.current = {
      opacity: layerConfig?.opacity ?? 100,
      lineColor: layerConfig?.lineColor || DEFAULT_DRAW_STYLE.lineColor,
      lineWidth: layerConfig?.lineWidth ?? 2,
      fillColor: layerConfig?.fillColor || DEFAULT_DRAW_STYLE.fillColor,
      fontColor: layerConfig?.fontColor || DEFAULT_DRAW_STYLE.fontColor,
      fontSize: layerConfig?.fontSize ?? 14,
    };

    const modifyInteraction = new Modify({
      source: source,
      pixelTolerance: 12,
      // Segment clicks are owned by handleEditClick (insert + pick up);
      // drags elsewhere fall through to the whole-feature Translate below.
      insertVertexCondition: () => false,
      // Reads the ref so a restyle via Apply recolours the handles live.
      style: () => buildModifyVertexStyle(editAccentRef.current),
    });

    // Refresh the per-feature length/area readouts in the layer's edit menu
    // once each edit settles (on-map chips already update live via each
    // feature's style function) — and record the edit as a history step.
    modifyInteraction.on('modifyend', () => {
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
    });

    // Drag anywhere on a feature that is not a vertex moves the whole thing.
    const translateInteraction = new Translate({
      layers: [olLayer as any],
      hitTolerance: 6,
      condition: (evt) =>
        primaryAction(evt) &&
        !stickyVertexRef.current &&
        !findNearestVertex(map, source, evt.pixel as number[], 12),
    });
    translateInteraction.on('translateend', () => {
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
    });

    map.addInteraction(modifyInteraction);
    map.addInteraction(translateInteraction);
    layerModifyInteractionRef.current = modifyInteraction;
    layerTranslateRef.current = translateInteraction;
    // Switch the session over, then open the layer's undo history with its
    // current state as the baseline step.
    editingVectorLayerIdRef.current = layerId;
    setEditingVectorLayerId(layerId);
    layerHistoryRef.current = { stack: [], index: -1 };
    pushHistorySnapshot();
  };

  const handleRemoveVectorLayer = (id: string) => {
    if (!mapRef.current) return;

    // Removing a layer ends its re-edit session, if any.
    if (editingVectorLayerId === id) {
      editingVectorLayerIdRef.current = null;
      if (stickyVertexRef.current) exitStickyVertex();
      if (layerModifyInteractionRef.current) {
        mapRef.current.removeInteraction(layerModifyInteractionRef.current);
        layerModifyInteractionRef.current = null;
      }
      if (layerTranslateRef.current) {
        mapRef.current.removeInteraction(layerTranslateRef.current);
        layerTranslateRef.current = null;
      }
      setEditingVectorLayerId(null);
      layerHistoryRef.current = { stack: [], index: -1 };
      syncHistoryDepth();
    }

    const olLayer = vectorLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      vectorLayersRef.current.delete(id);
    }

    const newLayers = vectorLayers.filter(l => l.id !== id);
    setVectorLayers(newLayers);
    // Anchor any group that just lost its last member so the empty folder
    // stays at its current panel position.
    const ga = anchorEmptiedGroups(vectorLayers, newLayers, vectorGroups);
    if (ga) setVectorGroups(ga);
  };

  const buildVectorStyle = (styleConfig: { lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number; clusterPoints?: boolean }) => {
    const lineWidth = styleConfig.lineWidth ?? 2;
    // Colors are stored as rgba strings; parseColor also accepts legacy hex.
    const line = rgbaToString(parseColor(styleConfig.lineColor, 1));
    const fill = rgbaToString(parseColor(styleConfig.fillColor, 0.3));
    const fontColor = rgbaToString(parseColor(styleConfig.fontColor, 1));
    const fontSize = styleConfig.fontSize ?? 14;
    const clustered = styleConfig.clusterPoints === true;

    // Return a per-feature style function so features carrying a label
    // (e.g. drawn features saved to a layer) render their text too.
    return (feature: any) => {
      // Clustered layers render aggregate bubbles for groups of points. The
      // Cluster source tags each generated feature with a `features` array of
      // the original points it swallowed.
      if (clustered && feature && feature.get) {
        const members = feature.get('features');
        if (Array.isArray(members) && members.length > 1) {
          const count = members.length;
          // Bubble grows with the cluster size, capped so huge clusters stay readable.
          const radius = 9 + Math.min(14, Math.round(Math.sqrt(count) * 1.6));
          return new Style({
            image: new CircleStyle({
              radius,
              fill: new Fill({ color: line }),
              stroke: new Stroke({ color: '#fff', width: 2.5 }),
            }),
            text: new Text({
              text: count > 999 ? (count / 1000).toFixed(1) + 'k' : String(count),
              font: 'bold ' + Math.max(11, Math.min(14, radius - 2)) + 'px Arial',
              fill: new Fill({ color: '#fff' }),
            }),
          });
        }
      }
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
    // If the layer is currently clustered, the style must render cluster
    // bubbles - detect it from the live source so the style always matches.
    const currentSource = olLayer.getSource && olLayer.getSource();
    const isClustered = currentSource instanceof Cluster;
    olLayer.setStyle(buildVectorStyle({ ...styleConfig, clusterPoints: isClustered }));

    // Per-feature style overrides live on the *raw* source, not the cluster
    // wrapper, so look through the Cluster source when present.
    const source = isClustered && currentSource.getSource ? currentSource.getSource() : currentSource;
    if (source && typeof source.getFeatures === 'function') {
      // Only defined DrawStyle fields override the stored per-feature style.
      const defined: Partial<DrawStyle> = {};
      DRAW_STYLE_KEYS.forEach(k => {
        if (styleConfig[k] !== undefined) defined[k] = styleConfig[k] as any;
      });
      for (const f of source.getFeatures()) {
        if (f._drawStyle) {
          // Drawn-in-app feature: keep its own style function — it renders
          // the measurement chips — and fold the new values into it.
          f._drawStyle = { ...f._drawStyle, ...defined };
          applyDrawFeatureStyle(f, f._drawStyle, () => unitsRef.current);
        } else {
          const fs = f.getStyle && f.getStyle();
          if (fs !== undefined && fs !== null) {
            f.setStyle(undefined); // fall back to the layer style
          }
        }
      }
    }
  };

  /**
   * Turn point clustering on or off for a vector layer.
   *
   * Enabling wraps the layer's real (raw) source in an ol/source/Cluster so
   * nearby points collapse into count bubbles; disabling swaps the raw source
   * back in. The raw source is stashed on the layer the first time clustering
   * is enabled so it can always be recovered - this also keeps feature
   * serialisation, extent calculation and vertex editing pointed at the real
   * features rather than the generated clusters.
   */
  const applyVectorClusteringToLayer = (
    olLayer: any,
    clusterPoints: boolean,
    clusterDistance: number | undefined,
    styleConfig: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number },
  ) => {
    if (!olLayer) return;
    const currentSource = olLayer.getSource && olLayer.getSource();

    if (clusterPoints) {
      // Stash the underlying source once; if we're already clustered keep the
      // existing raw source rather than wrapping the cluster wrapper.
      const rawSource = olLayer._rawSource || currentSource;
      olLayer._rawSource = rawSource;
      const clusterSource = new Cluster({
        source: rawSource,
        distance: clusterDistance ?? 40,
        // Only Point geometries take part in clustering. Returning null for
        // anything else (instead of the default's hard assertion) keeps mixed
        // datasets from throwing - non-point features simply sit out clustering.
        geometryFunction: (feature: any) => {
          const geometry = feature.getGeometry && feature.getGeometry();
          return geometry && geometry.getType() === 'Point' ? geometry : null;
        },
      });
      olLayer.setSource(clusterSource);
    } else if (olLayer._rawSource) {
      olLayer.setSource(olLayer._rawSource);
      olLayer._rawSource = undefined;
    }

    // Re-apply the style - it reads the live source to decide whether to draw
    // cluster bubbles, so it always matches the new (un)clustered state.
    applyVectorStyleToLayer(olLayer, styleConfig);
    if (olLayer.changed) olLayer.changed();
  };

  // The editable/serialisable source of a vector layer: the raw feature source
  // when clustering is active (the Cluster wrapper only holds generated
  // bubbles), otherwise the layer's own source.
  const getLayerRawSource = (layerId: string) => {
    const l = vectorLayersRef.current.get(layerId);
    if (!l) return null;
    return l._rawSource || (l.getSource && l.getSource());
  };

  const handleApplyVectorStyle = (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    // Apply opacity + style (also overrides KML per-feature styles)
    applyVectorStyleToLayer(olLayer, style);

    // While a re-edit session is live, its vertex handles follow the colour
    // being previewed, and features drawn into the layer take on the
    // previewed style.
    if (layerId === editingVectorLayerId) {
      if (style.lineColor) editAccentRef.current = style.lineColor;
      const patch: Partial<DrawStyle> = {};
      DRAW_STYLE_KEYS.forEach(k => {
        if (style[k] !== undefined) (patch as any)[k] = style[k];
      });
      reeditStyleSeedRef.current = { ...reeditStyleSeedRef.current, ...patch };
    }

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

  // Live-preview point clustering for a vector layer (called from the edit
  // menu checkbox / distance slider). Swaps the layer's source in or out of a
  // Cluster wrapper and records the choice in the layer config so it persists.
  const handleApplyVectorCluster = (layerId: string, clusterPoints: boolean, clusterDistance: number) => {
    const layer = vectorLayers.find(l => l.id === layerId);
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!layer || !olLayer) return;
    // MVT layers are tiled - there is no feature source to cluster.
    if (layer.type === 'mvt') return;
    applyVectorClusteringToLayer(olLayer, clusterPoints, clusterDistance, {
      opacity: layer.opacity ?? 100,
      lineColor: layer.lineColor,
      lineWidth: layer.lineWidth,
      fillColor: layer.fillColor,
      fontColor: layer.fontColor,
      fontSize: layer.fontSize,
    });
    setVectorLayers(prev => prev.map(l => (l.id === layerId ? { ...l, clusterPoints, clusterDistance } : l)));
  };

  // Apply a style to a single feature of a drawn-in-app vector layer.
  const handleApplyVectorFeatureStyle = (layerId: string, feature: any, style: DrawStyle) => {
    if (!feature) return;
    applyDrawFeatureStyle(feature, style, () => unitsRef.current);
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
          wireVectorTileLoading(source, updated.id);
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
              markVectorLoading(updated.id, true);
              fetch(wfsUrl)
                .then(r => r.json())
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(updated.id, false);
                })
                .catch(e => {
                  console.error('WFS load error:', e);
                  markVectorLoading(updated.id, false);
                });
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
              markVectorLoading(updated.id, true);
              fetchAllStacItems(updated.url || '', updated.stacCollection || '', updated.stacLimit)
                .then(data => {
                  source.addFeatures(new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' }));
                  markVectorLoading(updated.id, false);
                })
                .catch(e => {
                  console.error('STAC load error:', e);
                  markVectorLoading(updated.id, false);
                });
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
        // WFS/STAC point layers can be clustered (MVT is tiled, so it cannot).
        if (updated.type !== 'mvt' && updated.clusterPoints) {
          applyVectorClusteringToLayer(newOlLayer, true, updated.clusterDistance, { ...updated, opacity: updated.opacity ?? 100 });
        }
        mapRef.current.addLayer(newOlLayer);
        vectorLayersRef.current.set(updated.id, newOlLayer);

        const updatedWithRef = { ...updated, olLayer: newOlLayer };
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updatedWithRef : l);
        setVectorLayers(newVectorLayers);
        reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
      } else {
        // File-based layer: update name, apply style (overrides KML per-feature
        // styles) and sync the clustering state. applyVectorClusteringToLayer
        // wraps/unwraps the Cluster source as needed and re-applies the style.
        applyVectorClusteringToLayer(olLayer, updated.clusterPoints === true, updated.clusterDistance, { ...updated, opacity: updated.opacity ?? 100 });
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
    // Anchor any group that just lost its last member so the empty folder
    // stays at its current panel position.
    const ga = anchorEmptiedGroups(rasterLayers, newLayers, rasterGroups);
    if (ga) setRasterGroups(ga);
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

  // ----- Layer groups (folders) ---------------------------------------------
  // Groups are a panel-side organisation of the flat layer arrays: they
  // cluster rows in the settings list, and a group's eye toggle flips every
  // member at once. Map stacking order still comes from the flat arrays.

  // Group metadata (name/expanded/anchors) - panel order itself lives in
  // the flat layer arrays plus each empty group's afterId anchor.
  const handleUpdateRasterGroups = (groups: LayerGroup[]) => setRasterGroups(groups);
  const handleUpdateVectorGroups = (groups: LayerGroup[]) => setVectorGroups(groups);

  /** Toggle a group: hide every member (remembering each layer's own
   * visibility) unless all members are already hidden, in which case each
   * layer's remembered visibility is restored. */
  const handleToggleRasterGroup = (groupId: string) => {
    const next = toggleGroupLayerVisibility(rasterLayers, groupId);
    if (next === rasterLayers) return;
    next.forEach(l => {
      if (l.groupId === groupId) {
        const ol = rasterLayersRef.current.get(l.id);
        if (ol) ol.setVisible(l.visible !== false);
      }
    });
    setRasterLayers(next);
  };

  const handleToggleVectorGroup = (groupId: string) => {
    const next = toggleGroupLayerVisibility(vectorLayers, groupId);
    if (next === vectorLayers) return;
    next.forEach(l => {
      if (l.groupId === groupId) {
        const ol = vectorLayersRef.current.get(l.id);
        if (ol) ol.setVisible(l.visible === true);
      }
    });
    setVectorLayers(next);
  };

  const handleMoveRasterLayerToGroup = (layerId: string, groupId: string | undefined) => {
    const layer = rasterLayers.find(l => l.id === layerId);
    if (!layer || layer.groupId === groupId) return;
    let next: RasterLayer[];
    if (groupId && !rasterLayers.some(l => l.groupId === groupId)) {
      // Joining an EMPTY group: land at the group's anchored panel slot so
      // the group materialises where it was sitting.
      const at = flatIndexForGroupSlot(rasterLayers, rasterGroups, groupId);
      const moved = { ...layer, groupId };
      next = rasterLayers.filter(l => l.id !== layerId);
      next.splice(Math.min(at, next.length), 0, moved);
    } else {
      next = moveLayerToGroup(rasterLayers, layerId, groupId);
    }
    setRasterLayers(next);
    // Reveal the moved layer: the receiving group expands automatically.
    if (groupId) {
      setRasterGroups(prev => prev.map(g => (g.id === groupId && !g.expanded ? { ...g, expanded: true } : g)));
    }
    if (mapRef.current) reorderLayers(mapRef.current, next, vectorLayers);
  };

  const handleMoveVectorLayerToGroup = (layerId: string, groupId: string | undefined) => {
    const layer = vectorLayers.find(l => l.id === layerId);
    if (!layer || layer.groupId === groupId) return;
    let next: VectorLayerConfig[];
    if (groupId && !vectorLayers.some(l => l.groupId === groupId)) {
      // Joining an EMPTY group: land at the group's anchored panel slot so
      // the group materialises where it was sitting.
      const at = flatIndexForGroupSlot(vectorLayers, vectorGroups, groupId);
      const moved = { ...layer, groupId };
      next = vectorLayers.filter(l => l.id !== layerId);
      next.splice(Math.min(at, next.length), 0, moved);
    } else {
      next = moveLayerToGroup(vectorLayers, layerId, groupId);
    }
    setVectorLayers(next);
    // Reveal the moved layer: the receiving group expands automatically.
    if (groupId) {
      setVectorGroups(prev => prev.map(g => (g.id === groupId && !g.expanded ? { ...g, expanded: true } : g)));
    }
    if (mapRef.current) reorderLayers(mapRef.current, rasterLayers, next);
  };


  // ---------------------------------------------------------------------------
  // Click-to-pick-up vertex editing, shared by the draw toolbar's edit tool
  // and saved-layer re-edit. Clicking a vertex picks it up — it then follows
  // the pointer (see the pointermove handler) until the next click places it.
  // Delete removes it, Escape restores it, and clicking a segment inserts a
  // fresh vertex that is picked up immediately.
  // ---------------------------------------------------------------------------

  const setEditInteractionsActive = (active: boolean) => {
    [modifyInteractionRef.current, drawTranslateRef.current, layerModifyInteractionRef.current, layerTranslateRef.current].forEach((interaction) => {
      if (interaction) interaction.setActive(active);
    });
  };

  const exitStickyVertex = () => {
    stickyVertexRef.current = null;
    setStickyVertex(null);
    editMarkerFeatureRef.current = null;
    if (editMarkerSourceRef.current) editMarkerSourceRef.current.clear();
    setEditInteractionsActive(true);
    if (mapRef.current) {
      (mapRef.current.getTargetElement() as HTMLElement).style.cursor = '';
    }
  };

  const enterStickyVertex = (hit: VertexHit) => {
    const sticky: VertexHit = { feature: hit.feature, geom: hit.geom, indexPath: hit.indexPath.slice(), coord: hit.coord.slice() };
    stickyVertexRef.current = sticky;
    setStickyVertex(sticky);
    // Modify/Translate stand aside while a vertex is airborne so the
    // placement click is not mistaken for a new drag.
    setEditInteractionsActive(false);

    if (editMarkerSourceRef.current) {
      const marker = new Feature(new Point(hit.coord.slice()));
      marker.setStyle(buildEditMarkerStyles(editAccentRef.current));
      editMarkerSourceRef.current.clear();
      editMarkerSourceRef.current.addFeature(marker);
      editMarkerFeatureRef.current = marker;
    }
    if (mapRef.current) {
      (mapRef.current.getTargetElement() as HTMLElement).style.cursor = 'grabbing';
    }
  };

  // The next click drops the vertex where the pointer already is.
  const commitStickyVertex = () => {
    exitStickyVertex();
    pushHistorySnapshot(); // routes to the active session; dedupe skips no-ops
    setMeasureTick(tick => tick + 1);
  };

  // Escape puts the vertex back where it was picked up.
  const cancelStickyVertex = () => {
    const sticky = stickyVertexRef.current;
    if (!sticky) return;
    setVertexCoordinate(sticky.geom, sticky.indexPath, sticky.coord);
    exitStickyVertex();
    pushHistorySnapshot(); // routes to the active session; dedupe skips no-ops
    setMeasureTick(tick => tick + 1);
  };

  // Delete removes the picked-up vertex — or the whole feature when the
  // vertex *is* the feature (labels).
  const deleteStickyTarget = () => {
    const sticky = stickyVertexRef.current;
    if (!sticky) return;
    const { feature, geom, indexPath } = sticky;

    if (geom.getType && geom.getType() === 'Point') {
      const isDrawEdit = activeDrawToolRef.current === 'modify';
      const reeditId = editingVectorLayerIdRef.current;
      const source = isDrawEdit
        ? drawSourceRef.current
        : (reeditId !== null ? getLayerRawSource(reeditId) : null);
      if (source) source.removeFeature(feature);
      if (isDrawEdit) {
        setDrawnFeatures(prev => prev.filter(item => item.feature !== feature));
      }
      exitStickyVertex();
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
      return;
    }

    if (removeVertexFromGeom(geom, indexPath)) {
      exitStickyVertex();
      pushHistorySnapshot();
      setMeasureTick(tick => tick + 1);
    }
    // At the minimum vertex count the vertex simply stays picked up.
  };

  const handleEditClick = (evt: any) => {
    const map = mapRef.current;
    if (!map) return;
    const activeTool = activeDrawToolRef.current;
    // Drawing tools own their clicks, even during a re-edit session.
    if (activeTool !== null && activeTool !== 'modify') return;
    const isDrawEdit = activeTool === 'modify';
    const reeditId = editingVectorLayerIdRef.current;
    if (!isDrawEdit && reeditId === null) return;

    // A picked-up vertex is placed by the next click.
    if (stickyVertexRef.current) {
      commitStickyVertex();
      return;
    }

    // Alt+click stays owned by the Modify interaction (vertex removal).
    if (evt.originalEvent && evt.originalEvent.altKey) return;

    const source = isDrawEdit
      ? drawSourceRef.current
      : getLayerRawSource(reeditId as string);
    if (!source) return;

    const vertex = findNearestVertex(map, source, evt.pixel as number[], 12);
    if (vertex) {
      enterStickyVertex(vertex);
      return;
    }

    const segment = findNearestSegment(map, source, evt.pixel as number[], 10);
    if (segment) {
      insertVertexInGeom(segment);
      // Pick the fresh vertex up immediately — the next click places it.
      const indexPath = segment.ringIndex === -1 ? [segment.index + 1] : [segment.ringIndex, segment.index + 1];
      enterStickyVertex({ feature: segment.feature, geom: segment.geom, indexPath, coord: segment.coord.slice() });
      setMeasureTick(tick => tick + 1);
    }
  };

  // Double-clicking a label while editing reopens the text dialog with the
  // current text. The two vertex-clicks that precede the double click pick
  // the point up and put it straight back down, so the label stays exactly
  // where it was.
  const handleEditDoubleClick = (evt: any) => {
    const map = mapRef.current;
    if (!map) return;
    const activeTool = activeDrawToolRef.current;
    // Drawing tools own their clicks, even during a re-edit session.
    if (activeTool !== null && activeTool !== 'modify') return;
    const isDrawEdit = activeTool === 'modify';
    const reeditId = editingVectorLayerIdRef.current;
    if (!isDrawEdit && reeditId === null) return;

    const source = isDrawEdit
      ? drawSourceRef.current
      : getLayerRawSource(reeditId as string);
    if (!source) return;

    // The label's point vertex and its rendered text (which floats above
    // the point) both count as "the label".
    let labelFeature: any = null;
    const vertex = findNearestVertex(map, source, evt.pixel as number[], 12);
    if (vertex && vertex.geom.getType() === 'Point' && vertex.feature.get('labelText') !== undefined) {
      labelFeature = vertex.feature;
    } else {
      const editLayer = isDrawEdit ? drawLayerRef.current : vectorLayersRef.current.get(reeditId as string);
      map.forEachFeatureAtPixel(evt.pixel, (f: any, layer: any) => {
        if (!labelFeature && layer === editLayer && f.get && f.get('labelText') !== undefined) {
          labelFeature = f;
        }
      }, { hitTolerance: 6 });
    }
    if (!labelFeature) return;

    setLabelDialogState({
      pixel: map.getPixelFromCoordinate(labelFeature.getGeometry().getCoordinates()) as [number, number],
      feature: labelFeature,
      featureId: '',
      existingText: String(labelFeature.get('labelText') ?? ''),
    });
  };

  // Reopen the label dialog from the drawn-features panel, anchored at the
  // label's current map position.
  const handleEditLabelText = (feature: any) => {
    const map = mapRef.current;
    const geom = feature && feature.getGeometry ? feature.getGeometry() : null;
    if (!map || !geom) return;
    setLabelDialogState({
      pixel: map.getPixelFromCoordinate(geom.getCoordinates()) as [number, number],
      feature: feature,
      featureId: '',
      existingText: String(feature.get('labelText') ?? ''),
    });
  };

  // ---------------------------------------------------------------------------
  // Undo / redo for the draw session
  // ---------------------------------------------------------------------------

  // Which source/history the edit gestures currently belong to: the layer
  // being re-edited when a session is live, otherwise the drawing batch.
  const getActiveEditContext = () => {
    const reeditId = editingVectorLayerIdRef.current;
    if (reeditId !== null) {
      const olLayer = vectorLayersRef.current.get(reeditId);
      const source = olLayer && olLayer.getSource ? olLayer.getSource() : null;
      return { kind: 'layer' as const, source, history: layerHistoryRef };
    }
    return { kind: 'draw' as const, source: drawSourceRef.current, history: historyRef };
  };

  const syncHistoryDepth = () => {
    const h = getActiveEditContext().history.current;
    setUndoDepth(h.index + 1);
    setRedoDepth(h.stack.length - 1 - h.index);
  };

  const resetHistory = () => {
    historyRef.current = { stack: [], index: -1 };
    syncHistoryDepth();
  };

  // Record the active session's current state as the latest history step.
  // Steps identical to the one on top are skipped, and a new step drops the
  // redo tail — the usual linear-undo semantics.
  // `extraFeature` covers a stroke OpenLayers reported in drawend but hasn't
  // added to the source yet (it dispatches the event first, then inserts).
  const pushHistorySnapshot = (extraFeature?: any) => {
    const ctx = getActiveEditContext();
    if (!ctx.source) return;
    const snap = captureDrawSnapshot(ctx.source, extraFeature ? [extraFeature] : undefined);
    const key = snapshotKey(snap);
    const h = ctx.history.current;
    if (h.index >= 0 && h.stack[h.index].key === key) return;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push({ snap, key });
    if (h.stack.length > HISTORY_LIMIT) h.stack.shift();
    h.index = h.stack.length - 1;
    syncHistoryDepth();
  };

  const restoreSnapshot = (snap: SessionSnapshot) => {
    const ctx = getActiveEditContext();
    const source = ctx.source;
    if (!source) return;
    if (stickyVertexRef.current) exitStickyVertex();
    // A label dialog mid-flight belongs to the timeline being left behind.
    setLabelDialogState(null);

    source.clear();
    const items = snap.items.map((si) => {
      const feature = new Feature(si.geometry.clone());
      (feature as any)._drawFeatureId = si.id;
      (feature as any)._drawName = si.name;
      (feature as any)._drawCustomized = si.customized;
      if (si.labelText !== undefined) feature.set('labelText', si.labelText);
      applyDrawFeatureStyle(feature, { ...si.style }, () => unitsRef.current);
      source.addFeature(feature);
      return {
        id: si.id,
        type: si.type,
        name: si.name,
        feature: feature,
        style: { ...si.style },
        customized: si.customized,
      };
    });
    // The drawing batch mirrors its source in state; a layer's edit menu
    // reads its source live and just needs a re-render nudge.
    if (ctx.kind === 'draw') setDrawnFeatures(items);
    setMeasureTick(tick => tick + 1);
  };

  const handleUndo = () => {
    const h = getActiveEditContext().history.current;
    if (h.index <= 0) return;
    h.index -= 1;
    restoreSnapshot(h.stack[h.index].snap);
    syncHistoryDepth();
  };

  const handleRedo = () => {
    const h = getActiveEditContext().history.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    restoreSnapshot(h.stack[h.index].snap);
    syncHistoryDepth();
  };

  // Suspend/resume the saved-layer Modify+Translate pair while a drawing
  // tool owns the gestures during a re-edit session.
  const setLayerInteractionsActive = (active: boolean) => {
    if (layerModifyInteractionRef.current) layerModifyInteractionRef.current.setActive(active);
    if (layerTranslateRef.current) layerTranslateRef.current.setActive(active);
  };

  const handleDrawTool = (tool: DrawToolId) => {
    if (!mapRef.current || !drawSourceRef.current) return;
    const inReedit = editingVectorLayerId !== null;

    // Remove existing draw/modify interactions
    if (drawInteractionRef.current) {
      mapRef.current.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    if (modifyInteractionRef.current) {
      mapRef.current.removeInteraction(modifyInteractionRef.current);
      modifyInteractionRef.current = null;
    }
    if (drawTranslateRef.current) {
      mapRef.current.removeInteraction(drawTranslateRef.current);
      drawTranslateRef.current = null;
    }
    // A picked-up vertex never survives a tool switch.
    if (stickyVertexRef.current) {
      exitStickyVertex();
    }

    // Drop any hover cursor left behind by an edit session; the pointermove
    // handler re-applies it on the next move while editing stays active.
    (mapRef.current.getTargetElement() as HTMLElement).style.cursor = '';

    // If same tool clicked, toggle off
    if (tool === activeDrawTool) {
      setActiveDrawTool(null);
      // Back to the layer's own vertex editing, if a session is live.
      if (inReedit) setLayerInteractionsActive(true);
      return;
    }

    setActiveDrawTool(tool);

    if (!tool) {
      if (inReedit) setLayerInteractionsActive(true);
      return;
    }

    // During a re-edit session the edit tool *is* the layer's own vertex
    // editing — resume it rather than starting a second Modify.
    if (inReedit && tool === 'modify') {
      setActiveDrawTool(null);
      setLayerInteractionsActive(true);
      return;
    }

    // While a drawing tool owns the gestures, the layer's Modify/Translate
    // stand aside (the re-edit session itself stays alive).
    if (inReedit) setLayerInteractionsActive(false);

    // Edit tool — reshape features that are already drawn instead of adding
    // new ones. Vertices drag to new positions, clicking a segment inserts a
    // vertex and Alt+clicking a vertex removes it (OpenLayers Modify
    // defaults). The on-map measurement chips stay in sync automatically
    // because each feature's style function re-runs on every geometry change.
    if (tool === 'modify') {
      editAccentRef.current = drawStyleRef.current.lineColor;
      const modifyInteraction = new Modify({
        source: drawSourceRef.current,
        pixelTolerance: 12,
        // Segment clicks are owned by handleEditClick (insert + pick up), so
        // Modify stays vertex-only and presses elsewhere fall through to the
        // whole-feature Translate interaction below.
        insertVertexCondition: () => false,
        // Handles follow the current draw line colour.
        style: () => buildModifyVertexStyle(drawStyleRef.current.lineColor),
      });

      // Refresh the drawn-features panel once each edit settles so its
      // length/area readouts match the new geometry — and record the edit
      // as a history step.
      modifyInteraction.on('modifyend', () => {
        pushHistorySnapshot();
        setMeasureTick(tick => tick + 1);
      });

      // Drag anywhere on a feature that is not a vertex moves the whole
      // feature. Added after Modify, so it is offered events first and can
      // stand aside whenever a vertex is within grabbing distance.
      const drawLayer = drawLayerRef.current;
      const translateInteraction = new Translate({
        layers: drawLayer ? [drawLayer as any] : [],
        hitTolerance: 6,
        condition: (evt) =>
          primaryAction(evt) &&
          !stickyVertexRef.current &&
          !findNearestVertex(mapRef.current as OLMap, drawSourceRef.current, evt.pixel as number[], 12),
      });
      translateInteraction.on('translateend', () => {
        pushHistorySnapshot();
        setMeasureTick(tick => tick + 1);
      });

      mapRef.current.addInteraction(modifyInteraction);
      mapRef.current.addInteraction(translateInteraction);
      modifyInteractionRef.current = modifyInteraction;
      drawTranslateRef.current = translateInteraction;
      return;
    }

    // Give each fresh drawing batch a random color, just like adding a vector
    // layer. Only re-roll when the batch is empty so in-progress work (and any
    // manually chosen style) keeps its color across tool switches.
    if (!inReedit && drawnFeatures.length === 0) {
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

    // During a re-edit session, new features are drawn straight into the
    // layer being edited.
    const targetSource = inReedit
      ? (getLayerRawSource(editingVectorLayerId as string) || drawSourceRef.current)
      : drawSourceRef.current;

    const drawInteraction = new Draw({
      source: targetSource,
      type: drawType,
      geometryFunction: geometryFunction,
    });

    // Style the in-progress sketch with the current draw style and live
    // measurement labels (segment lengths for lines, area for polygons and
    // rectangles). The style function re-runs on every geometry change, so
    // the readouts update as the user moves the pointer.
    drawInteraction.on('drawstart', (evt) => {
      // History baseline: the session state before this stroke lands (the
      // dedupe inside skips it when it matches the step already on top).
      pushHistorySnapshot();

      const sketch = evt.feature as any;
      sketch.setStyle(() => {
        const ds = inReedit ? reeditStyleSeedRef.current : drawStyleRef.current;
        const styles: Style[] = [buildDrawFeatureStyle(ds)];
        const geom = sketch.getGeometry ? sketch.getGeometry() : null;
        if (geom) styles.push(...buildMeasurementStyles(geom, ds, unitsRef.current));
        return styles;
      });
    });

    // Track features as they are drawn
    drawInteraction.on('drawend', (evt) => {
      const feature = evt.feature;
      const featureId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6);
      const geomType = feature.getGeometry()?.getType() || 'Unknown';
      
      // Each feature carries its own style — seeded from the current draw
      // style, or from the layer's own colours during a re-edit session.
      const initStyle = inReedit ? { ...reeditStyleSeedRef.current } : { ...drawStyleRef.current };
      applyDrawFeatureStyle(feature, initStyle, () => unitsRef.current);
      
      if (tool === 'label') {
        // Get the pixel position of the drawn point for dialog placement
        const pointCoords = (feature.getGeometry() as any).getCoordinates();
        const pixel = mapRef.current!.getPixelFromCoordinate(pointCoords);
        (feature as any)._drawFeatureId = featureId;
        
        // Show the in-app label dialog instead of browser prompt
        setLabelDialogState({
          pixel: pixel as [number, number],
          feature: feature,
          featureId: featureId,
          targetSource: targetSource,
          toLayer: inReedit,
        });
      } else {
        (feature as any)._drawFeatureId = featureId;
        let displayName = '';
        if (inReedit) {
          // Name from the layer's existing contents — the new feature isn't
          // in the source yet at drawend time.
          const layerFeats = targetSource.getFeatures() as any[];
          const featType = (f: any) => (f.getGeometry && f.getGeometry() ? f.getGeometry().getType() : '');
          const featName = (f: any) => f._drawName || '';
          if (tool === 'line') displayName = 'Line ' + (layerFeats.filter(f => featType(f) === 'LineString').length + 1);
          else if (tool === 'polygon') displayName = 'Polygon ' + (layerFeats.filter(f => featType(f) === 'Polygon' && !featName(f).startsWith('Rectangle')).length + 1);
          else if (tool === 'rectangle') displayName = 'Rectangle ' + (layerFeats.filter(f => featName(f).startsWith('Rectangle')).length + 1);
        } else {
          // Name from the current batch contents.
          if (tool === 'line') displayName = 'Line ' + (drawnFeaturesRef.current.filter(f => f.type === 'LineString').length + 1);
          else if (tool === 'polygon') displayName = 'Polygon ' + (drawnFeaturesRef.current.filter(f => f.type === 'Polygon' && !f.name.startsWith('Rectangle')).length + 1);
          else if (tool === 'rectangle') displayName = 'Rectangle ' + (drawnFeaturesRef.current.filter(f => f.name.startsWith('Rectangle')).length + 1);
        }
        (feature as any)._drawName = displayName;

        // History step for the completed stroke — the feature is passed in
        // explicitly because it isn't in the source yet at drawend time.
        pushHistorySnapshot(feature);

        if (inReedit) {
          // The feature lives in the layer now; refresh its feature list.
          setMeasureTick(tick => tick + 1);
        } else {
          setDrawnFeatures(prev => [...prev, {
            id: featureId,
            type: tool === 'rectangle' ? 'Polygon' : (geomType as any),
            name: displayName,
            feature: feature,
            style: initStyle,
            customized: false,
          }]);
        }
      }
    });

    mapRef.current.addInteraction(drawInteraction);
    drawInteractionRef.current = drawInteraction;
  };

  const handleLabelDialogApply = (text: string) => {
    if (!labelDialogState) return;
    const { feature, featureId, existingText } = labelDialogState;

    // Re-edit: swap the text in place. The feature's own style function
    // reads labelText live, so its style (and any customisation) survives.
    if (existingText !== undefined) {
      feature.set('labelText', text);
      (feature as any)._drawName = 'Label: ' + text;
      setDrawnFeatures(prev => prev.map(item =>
        item.feature === feature ? { ...item, name: 'Label: ' + text } : item
      ));
      pushHistorySnapshot();
      setLabelDialogState(null);
      setMeasureTick(tick => tick + 1); // refresh saved-layer name readouts
      return;
    }

    feature.set('labelText', text);
    const initStyle = labelDialogState.toLayer ? { ...reeditStyleSeedRef.current } : { ...drawStyleRef.current };
    applyDrawFeatureStyle(feature, initStyle, () => unitsRef.current);
    (feature as any)._drawName = 'Label: ' + text;
    pushHistorySnapshot();
    if (labelDialogState.toLayer) {
      // The label lives in the layer; refresh its feature list.
      setMeasureTick(tick => tick + 1);
    } else {
      setDrawnFeatures(prev => [...prev, {
        id: featureId,
        type: 'Point',
        name: 'Label: ' + text,
        feature: feature,
        style: initStyle,
        customized: false,
      }]);
    }
    setLabelDialogState(null);
  };

  const handleLabelDialogCancel = () => {
    if (!labelDialogState) return;
    const { feature, existingText, targetSource } = labelDialogState;

    // Only a brand-new label is discarded — a re-edited one keeps its text.
    if (existingText === undefined && targetSource) {
      targetSource.removeFeature(feature);
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
    // Use the raw source when clustered so the extent covers every real
    // feature rather than just the currently generated cluster bubbles.
    const source = olLayer._rawSource || olLayer.getSource();
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

  // Switch between metric and imperial measurements. Updates the scale line
  // and forces every layer to re-render so all measurement labels on the map
  // (drawn features, saved draw layers, in-progress sketches) re-format.
  const handleUnitsChange = (newUnits: UnitsSystem) => {
    setUnits(newUnits);
    unitsRef.current = newUnits;
    if (scaleLineRef.current) {
      scaleLineRef.current.setUnits(newUnits === 'imperial' ? 'imperial' : 'metric');
    }
    if (mapRef.current) {
      mapRef.current.getLayers().forEach((layer: any) => layer.changed && layer.changed());
      mapRef.current.render();
    }
  };

  const handleRemoveDrawnFeature = (id: string) => {
    const featureToRemove = drawnFeatures.find(f => f.id === id);
    if (featureToRemove && drawSourceRef.current) {
      drawSourceRef.current.removeFeature(featureToRemove.feature);
    }
    setDrawnFeatures(prev => prev.filter(f => f.id !== id));
    pushHistorySnapshot();
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
      applyDrawFeatureStyle(item.feature, newStyle, () => unitsRef.current);
      return { ...item, style: newStyle };
    }));
  };

  // Edit the style of a single drawn feature. Marks it as customized so the
  // global style no longer overrides it.
  const handleFeatureStyleChange = (id: string, newStyle: DrawStyle) => {
    setDrawnFeatures(prev => prev.map(item => {
      if (item.id !== id) return item;
      applyDrawFeatureStyle(item.feature, newStyle, () => unitsRef.current);
      (item.feature as any)._drawCustomized = true;
      return { ...item, style: newStyle, customized: true };
    }));
  };

  const handleSaveDrawnToLayers = (layerName: string) => {
    if (drawnFeatures.length === 0 || !mapRef.current || !drawSourceRef.current) return;

    // Nothing may be mid-air while the batch changes hands.
    if (stickyVertexRef.current) exitStickyVertex();

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

    // Clear drawn features from the draw layer — a fresh batch starts a
    // fresh history.
    drawSourceRef.current.clear();
    setDrawnFeatures([]);
    resetHistory();
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

      {showDrawToolbar && (
        <DrawToolbar
          activeTool={activeDrawTool}
          onToolSelect={handleDrawTool}
          undoDepth={undoDepth}
          redoDepth={redoDepth}
          onUndo={handleUndo}
          onRedo={handleRedo}
          showHistory={activeDrawTool !== null || editingVectorLayerId !== null}
        />
      )}
      {showDrawToolbar && activeDrawTool !== null && editingVectorLayerId === null && (
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
          onEditLabelText={handleEditLabelText}
          units={units}
          measureVersion={measureTick}
        />
      )}
      {(activeDrawTool === 'modify' || editingVectorLayerId !== null) && (
        <div className={`draw-modify-hint ${stickyVertex ? 'sticky' : ''}`} role="status">
          {stickyVertex ? (
            <>
              <span><b>Click</b> to place the vertex</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Del</b> removes it</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Esc</b> puts it back</span>
            </>
          ) : activeDrawTool === 'modify' && drawnFeatures.length === 0 ? (
            <span>Nothing to edit yet — draw a line, polygon, rectangle or label first</span>
          ) : (
            <>
              <span><b>Drag</b> a vertex to reshape</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Drag</b> the feature to move it</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Click</b> a vertex to pick it up</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Click</b> a segment to add one</span>
              <span className="draw-modify-hint-sep" aria-hidden="true" />
              <span><b>Double-click</b> a label to edit its text</span>
            </>
          )}
        </div>
      )}
      {labelDialogState && (
        <LabelInputDialog
          pixel={labelDialogState.pixel}
          initialText={labelDialogState.existingText}
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
            rasterGroups={rasterGroups}
            onUpdateRasterGroups={handleUpdateRasterGroups}
            onToggleRasterGroup={handleToggleRasterGroup}
            onMoveRasterLayerToGroup={handleMoveRasterLayerToGroup}
            onAddRasterLayer={handleAddRasterLayer}
            onEditRasterLayer={handleEditRasterLayer}
            onRemoveRasterLayer={handleRemoveRasterLayer}
            onToggleRasterLayer={handleToggleRasterLayer}
            onApplyColorAdjustments={handleApplyColorAdjustments}
            onApplyTileZoomRange={handleApplyTileZoomRange}
            vectorLayers={vectorLayers}
            vectorGroups={vectorGroups}
            onUpdateVectorGroups={handleUpdateVectorGroups}
            onToggleVectorGroup={handleToggleVectorGroup}
            onMoveVectorLayerToGroup={handleMoveVectorLayerToGroup}
            onToggleVectorLayer={handleToggleVectorLayer}
            onRemoveVectorLayer={handleRemoveVectorLayer}
            onEditVectorLayer={handleEditVectorLayer}
            onApplyVectorStyle={handleApplyVectorStyle}
            onApplyVectorZoomRange={handleApplyVectorZoomRange}
            onApplyVectorCluster={handleApplyVectorCluster}
            onApplyVectorFeatureStyle={handleApplyVectorFeatureStyle}
            onReorderRasterLayers={handleReorderRasterLayers}
            onReorderVectorLayers={handleReorderVectorLayers}
            onAddVectorLayer={handleAddVectorLayer}
            onAddMVTLayer={handleAddMVTLayer}
            onAddWFSLayer={handleAddWFSLayer}
            onAddSTACLayer={handleAddSTACLayer}
            onExportVectorLayer={handleExportVectorLayer}
            onReeditVectorLayer={handleReeditVectorLayer}
            editingVectorLayerId={editingVectorLayerId}
            onGoToVectorLayerExtent={handleGoToVectorLayerExtent}
            onGoToRasterLayerExtent={handleGoToRasterLayerExtent}
            onAdvancedSettings={() => setShowAdvancedSettings(true)}
            knownSources={knownSources}
            isRestoringLayers={isRestoringLayers}
            loadingVectorIds={loadingVectorIds}
            units={units}
            workspaceId={workspaceId}
            workspaces={workspaces}
            onSwitchWorkspace={onSwitchWorkspace}
            onCreateWorkspace={onCreateWorkspace}
            onRenameWorkspace={onRenameWorkspace}
            onDuplicateWorkspace={onDuplicateWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            onLockApp={onLockApp}
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
          units={units}
          onUnitsChange={handleUnitsChange}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   App lock: password setup dialog + full-screen lock overlay
   --------------------------------------------------------------------------- */

/** Rough 0–4 strength score that drives the setup dialog's meter. */
function passwordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 4) score++;
  if (pw.length >= 8) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

/**
 * First-lock dialog: the app has no password yet, so locking starts by
 * choosing one. The password is never stored — it only derives the key
 * that encrypts the storage vault.
 */
export function SetPasswordDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState(false);

  const tooShort = password.length < 4;
  const mismatch = confirm !== password;
  const valid = !tooShort && !mismatch;
  const strength = passwordStrength(password);

  const submit = () => {
    setTouched(true);
    if (valid) onConfirm(password);
  };

  return (
    <div className="setpw-overlay" role="dialog" aria-modal="true" aria-labelledby="setpw-title">
      <div className="setpw-dialog">
        <div className="setpw-header">
          <span className="setpw-badge" aria-hidden="true"><LockIcon /></span>
          <div className="setpw-heading">
            <h2 id="setpw-title" className="setpw-title">Set a password to lock the app</h2>
            <p className="setpw-subtitle">
              Your workspaces, layers and settings are encrypted on this device
              and hidden behind a lock screen until the password is entered.
            </p>
          </div>
        </div>
        <div className="setpw-body">
          <label className="setpw-label" htmlFor="setpw-password">Password</label>
          <div className="setpw-field">
            <input
              id="setpw-password"
              type={showPw ? 'text' : 'password'}
              value={password}
              autoFocus
              placeholder="At least 4 characters"
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
            <button
              type="button"
              className="setpw-eye"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              title={showPw ? 'Hide password' : 'Show password'}
            >
              <EyeIcon visible={!showPw} />
            </button>
          </div>
          {password.length > 0 && (
            <div className="setpw-strength" data-level={strength}>
              <span className="setpw-strength-bar"><span className="setpw-strength-fill" /></span>
              <span className="setpw-strength-label">{STRENGTH_LABELS[strength]}</span>
            </div>
          )}
          <label className="setpw-label" htmlFor="setpw-confirm">Confirm password</label>
          <div className="setpw-field">
            <input
              id="setpw-confirm"
              type={showPw ? 'text' : 'password'}
              value={confirm}
              placeholder="Repeat the password"
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          </div>
          {touched && tooShort && <p className="setpw-error">Use at least 4 characters.</p>}
          {touched && !tooShort && mismatch && <p className="setpw-error">Passwords don’t match.</p>}
          <p className="setpw-note">
            The password is never stored anywhere. If you forget it, the only
            recovery is “Start fresh” on the lock screen, which erases all data.
          </p>
        </div>
        <div className="setpw-actions">
          <button className="settings-button-secondary" onClick={onCancel}>Cancel</button>
          <button className="setpw-confirm-button" onClick={submit}>
            <LockIcon /> Set password &amp; lock
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen lock overlay. The live app stays mounted underneath a heavy
 * blur; the password card sits centred in the window. Unlocking decrypts
 * the storage vault back into localStorage. “Start fresh” wipes the vault
 * and every persisted setting for a clean slate.
 */
export function LockScreen({
  onUnlock,
  onStartFresh,
}: {
  onUnlock: (password: string) => Promise<void>;
  onStartFresh: () => void;
}) {
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every failed attempt so the shake animation replays.
  const [shakeKey, setShakeKey] = useState(0);
  const [capsLock, setCapsLock] = useState(false);
  const [confirmingFresh, setConfirmingFresh] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  // Re-focus (and select) the field after a failed attempt remounts the form.
  useEffect(() => {
    if (shakeKey > 0 && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [shakeKey]);

  const trackCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLock(e.getModifierState('CapsLock'));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checking || !password) return;
    setChecking(true);
    setError(null);
    try {
      await onUnlock(password);
    } catch (err) {
      setChecking(false);
      if (err instanceof WrongPasswordError) {
        setError('Incorrect password — try again.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not unlock the vault.');
      }
      setShakeKey((k) => k + 1);
    }
  };

  return (
    <div className="lock-overlay" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-card">
        <span className="lock-badge" aria-hidden="true"><LockIcon /></span>
        <h1 id="lock-title" className="lock-title">Map Viewer is locked</h1>
        <p className="lock-subtitle">
          Enter your password to restore your workspaces, layers and settings.
        </p>
        <form className="lock-form" onSubmit={submit} key={shakeKey} noValidate>
          <div className={`lock-field${error ? ' invalid' : ''}`}>
            <input
              ref={inputRef}
              type={showPw ? 'text' : 'password'}
              value={password}
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
              disabled={checking}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={trackCaps}
              onKeyUp={trackCaps}
            />
            <button
              type="button"
              className="lock-eye"
              tabIndex={-1}
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              title={showPw ? 'Hide password' : 'Show password'}
            >
              <EyeIcon visible={!showPw} />
            </button>
          </div>
          {capsLock && <p className="lock-hint">Caps Lock is on</p>}
          {error && <p className="lock-error" role="alert">{error}</p>}
          <button type="submit" className="lock-unlock-button" disabled={checking || !password}>
            {checking ? (
              <>
                <span className="lock-spinner" aria-hidden="true" />
                Unlocking…
              </>
            ) : (
              'Unlock'
            )}
          </button>
        </form>
        <div className="lock-footer">
          <span className="lock-footer-note">
            Your data never leaves this device — it is encrypted with your password.
          </span>
          {confirmingFresh ? (
            <span className="lock-fresh-confirm" role="group" aria-label="Start fresh confirmation">
              <span className="lock-fresh-confirm-text">Erase everything?</span>
              <button className="lock-fresh-yes" onClick={onStartFresh}>Yes, start fresh</button>
              <button className="lock-fresh-no" onClick={() => setConfirmingFresh(false)}>Cancel</button>
            </span>
          ) : (
            <button
              className="lock-fresh-link"
              onClick={() => setConfirmingFresh(true)}
              title="Erase all locked data and start over"
            >
              Start fresh
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Strip lat/lng/z query params so an incoming workspace restores its own
 * saved view instead of inheriting the outgoing one from the URL. */
function clearViewQueryParams() {
  if (window.location.search) {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

function App() {
  const [registry, setRegistry] = useState<WorkspaceRegistry>(() => loadWorkspaceRegistry());
  // Locked when an encrypted vault is present (e.g. the page reloaded while
  // locked); the map renders underneath a heavy blur until the correct
  // password decrypts the storage back into place.
  const [lockState, setLockState] = useState<'locked' | 'unlocked'>(() =>
    hasLockedVault() ? 'locked' : 'unlocked'
  );
  const [showSetPassword, setShowSetPassword] = useState(false);
  // Bumped after unlocking so MapPage remounts and reloads restored storage.
  const [unlockEpoch, setUnlockEpoch] = useState(0);
  // The lock password lives only in memory for this session, so re-locking
  // from the Settings footer never asks for it again.
  const lockPasswordRef = useRef<string | null>(null);
  const appRootRef = useRef<HTMLDivElement>(null);

  /** Encrypt every persisted app key into the vault and engage the lock. */
  const engageLock = useCallback(async (password: string) => {
    const entries = collectAppStorage();
    const vault = await encryptAppData(entries, password);
    // Write the vault first, then strip the plaintext keys around it, so a
    // crash in between can never leave unencrypted data behind.
    writeVault(vault);
    clearAppStorage(true);
    lockPasswordRef.current = password;
    setShowSetPassword(false);
    setLockState('locked');
  }, []);

  /** Settings-footer lock icon: reuse the session password or ask for one. */
  const handleLockRequest = useCallback(() => {
    if (lockPasswordRef.current) {
      void engageLock(lockPasswordRef.current);
    } else {
      setShowSetPassword(true);
    }
  }, [engageLock]);

  /** Lock-screen submit: decrypt the vault back into localStorage. */
  const handleUnlock = useCallback(async (password: string) => {
    const vault = readVault();
    if (vault === null) {
      // Vault vanished (storage cleared elsewhere) - boot straight in.
      setLockState('unlocked');
      return;
    }
    const entries = await decryptAppData(vault, password); // throws on a wrong password
    clearAppStorage();
    restoreAppStorage(entries);
    lockPasswordRef.current = password;
    setRegistry(loadWorkspaceRegistry());
    setUnlockEpoch((epoch) => epoch + 1);
    setLockState('unlocked');
  }, []);

  /** "Start fresh": wipe the vault plus every persisted key and reboot. */
  const handleStartFresh = useCallback(() => {
    clearAppStorage();
    lockPasswordRef.current = null;
    window.location.reload();
  }, []);

  // While locked, the blurred app underneath must not be operable.
  useEffect(() => {
    const root = appRootRef.current;
    if (!root) return;
    if (lockState === 'locked') {
      root.setAttribute('inert', '');
      root.setAttribute('aria-hidden', 'true');
    } else {
      root.removeAttribute('inert');
      root.removeAttribute('aria-hidden');
    }
  }, [lockState]);

  const updateRegistry = useCallback((next: WorkspaceRegistry) => {
    setRegistry(next);
    saveWorkspaceRegistry(next);
  }, []);

  const handleSwitchWorkspace = useCallback((id: string) => {
    if (registry.activeId === id || !registry.workspaces.some(w => w.id === id)) return;
    clearViewQueryParams();
    updateRegistry({ ...registry, activeId: id });
  }, [registry, updateRegistry]);

  const handleCreateWorkspace = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = generateWorkspaceId();
    clearViewQueryParams();
    // The fresh workspace starts from the app defaults: loadSettings()
    // returns them when no storage exists yet for the new id.
    updateRegistry({ workspaces: [...registry.workspaces, { id, name: trimmed }], activeId: id });
  }, [registry, updateRegistry]);

  const handleRenameWorkspace = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateRegistry({
      ...registry,
      workspaces: registry.workspaces.map(w => (w.id === id ? { ...w, name: trimmed } : w)),
    });
  }, [registry, updateRegistry]);

  const handleDuplicateWorkspace = useCallback((id: string) => {
    const source = registry.workspaces.find(w => w.id === id);
    if (!source) return;
    const newId = generateWorkspaceId();
    copyWorkspaceStorage(id, newId);
    const baseName = source.name.replace(/ copy( \d+)?$/, '');
    const takenNames = new Set(registry.workspaces.map(w => w.name));
    let name = `${baseName} copy`;
    let n = 2;
    while (takenNames.has(name)) {
      name = `${baseName} copy ${n++}`;
    }
    clearViewQueryParams();
    updateRegistry({ workspaces: [...registry.workspaces, { id: newId, name }], activeId: newId });
  }, [registry, updateRegistry]);

  const handleDeleteWorkspace = useCallback((id: string) => {
    if (registry.workspaces.length <= 1) return; // never delete the last workspace
    deleteWorkspaceStorage(id);
    const remaining = registry.workspaces.filter(w => w.id !== id);
    const activeId = registry.activeId === id ? remaining[0].id : registry.activeId;
    if (registry.activeId === id) clearViewQueryParams();
    updateRegistry({ workspaces: remaining, activeId });
  }, [registry, updateRegistry]);

  return (
    <>
      <div className="app-root" ref={appRootRef}>
        <Routes>
          <Route
            path="/map"
            element={
              <MapPage
                key={`${registry.activeId}:${unlockEpoch}`}
                workspaceId={registry.activeId}
                workspaces={registry.workspaces}
                onSwitchWorkspace={handleSwitchWorkspace}
                onCreateWorkspace={handleCreateWorkspace}
                onRenameWorkspace={handleRenameWorkspace}
                onDuplicateWorkspace={handleDuplicateWorkspace}
                onDeleteWorkspace={handleDeleteWorkspace}
                onLockApp={handleLockRequest}
              />
            }
          />
          <Route path="/" element={<Navigate to="/map" replace />} />
        </Routes>
      </div>
      {lockState === 'locked' && (
        <LockScreen onUnlock={handleUnlock} onStartFresh={handleStartFresh} />
      )}
      {lockState === 'unlocked' && showSetPassword && (
        <SetPasswordDialog
          onCancel={() => setShowSetPassword(false)}
          onConfirm={(password) => void engageLock(password)}
        />
      )}
    </>
  );
}

export default App;
