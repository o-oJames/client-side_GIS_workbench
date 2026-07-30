import XYZ from 'ol/source/XYZ.js';
import WMTS from 'ol/source/WMTS.js';
import OSM, { ATTRIBUTION as OSM_ATTRIBUTION } from 'ol/source/OSM.js';
import { fromLonLat } from 'ol/proj.js';
import { DEFAULT_BASEMAP_URL } from '../constants';

/** Encode an XYZ tile coordinate as a Bing-style quadkey ({q}). */
export function tileToQuadKey(z: number, x: number, y: number): string {
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
export function createXYZSource(url: string, minZoom?: number, maxZoom?: number): XYZ {
  const zoomOptions: { minZoom?: number; maxZoom?: number } = {};
  if (minZoom !== undefined) zoomOptions.minZoom = minZoom;
  if (maxZoom !== undefined) zoomOptions.maxZoom = maxZoom;
  // crossOrigin: 'anonymous' loads tiles with CORS so the rendered canvas is
  // not "tainted" — required for the right-click "Save image as…"/"Copy image"
  // canvas capture. Public tile CDNs (OSM, Carto, Esri, Bing, …) all send
  // Access-Control-Allow-Origin.
  if (url.includes('{q}')) {
    return new XYZ({
      ...zoomOptions,
      crossOrigin: 'anonymous',
      tileUrlFunction: (tileCoord: number[]) =>
        url.replace(/\{q\}/g, tileToQuadKey(tileCoord[0], tileCoord[1], tileCoord[2])),
    });
  }
  return new XYZ({ ...zoomOptions, crossOrigin: 'anonymous', url });
}

/**
 * Create a WMTS source, optionally clamping tile-matrix requests to a
 * [minZoom, maxZoom] range. Outside the range the nearest allowed matrix is
 * magnified (same overzoom/underzoom behaviour as XYZ layers). Values are
 * clamped to the matrix range advertised by the service.
 */
export function createWmtsSource(options: any, minZoom?: number, maxZoom?: number): WMTS {
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
export function basemapSourceKey(url: string, minZoom?: number, maxZoom?: number): string {
  return `${url}|${minZoom ?? ''}|${maxZoom ?? ''}`;
}

/**
 * Create the basemap tile source for an XYZ template URL (OSM for the default).
 * Optional minZoom/maxZoom clamp tile requests the same way they do for XYZ
 * raster layers (overzoom/underzoom outside the range).
 */
export function createBasemapSource(url: string, minZoom?: number, maxZoom?: number): OSM | XYZ {
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
      crossOrigin: 'anonymous',
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
export function isValidTileTemplate(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  if (trimmed.includes('{q}')) return true;
  return trimmed.includes('{z}') && trimmed.includes('{x}') && trimmed.includes('{y}');
}

/** Expand an XYZ / quadkey template into a concrete tile URL (used for the live preview). */
export function templateToTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{-y\}/g, String(Math.pow(2, z) - 1 - y)) // TMS scheme
    .replace(/\{q\}/g, tileToQuadKey(z, x, y)) // Bing-style quadkey
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, 'a')
    .replace(/\{subdomain\}/gi, 'a');
}

export const extractBaseUrl = (url: string): string => {
  const questionMarkIndex = url.indexOf('?');
  return questionMarkIndex !== -1 ? url.substring(0, questionMarkIndex) : url;
};

/**
 * Extract extent [minx, miny, maxx, maxy] in EPSG:3857 from WMTS capabilities for a specific layer.
 */
export function extractWmtsExtent(capabilities: any, layerIdentifier: string): number[] | null {
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
export function extractWmsExtent(capabilities: any, layerName: string): number[] | null {
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
