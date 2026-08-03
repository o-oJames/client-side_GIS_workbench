/**
 * Raster layer OL factory.
 *
 * Consolidates the WMTS / WMS / COG / XYZ layer-creation switch that was
 * previously copy-pasted three times in MapPage.tsx (init restore, edit,
 * add). Pure OpenLayers + fetch logic — no React imports (AGENTS.md §3).
 */
import TileLayer from 'ol/layer/Tile.js';
import ImageLayer from 'ol/layer/Image.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import GeoTIFFSource from 'ol/source/GeoTIFF.js';
import ImageWMS from 'ol/source/ImageWMS.js';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import { optionsFromCapabilities } from 'ol/source/WMTS.js';
import { transformExtent, get as getOlProjection } from 'ol/proj.js';

import type { RasterLayer } from '../types';
import {
  createXYZSource,
  createWmtsSource,
  extractWmtsExtent,
  extractWmsExtent,
  extractBaseUrl,
} from './tileHelpers';
import { createCogTileStyle } from './layerHelpers';
import { registerProjectionFromEPSGCode } from './projectionHelper';
import { resolveS3CogUrl } from './cogHelpers';
import { idbGetBinaryWithRetry } from './idb';
import type { S3Config } from './cogHelpers';

// --- COG helpers ------------------------------------------------------------

/**
 * Resolve the effective URL for a COG layer config:
 * - file: recreate blob URL from IndexedDB bytes
 * - s3: pre-sign (with credentials) or build public HTTPS URL
 * - http: use the URL as-is
 */
export async function resolveCogUrl(layerConfig: RasterLayer): Promise<string> {
  if (layerConfig.cogSource === 'file') {
    // File-sourced COGs are session-only: they are never persisted to the
    // workspace settings, so this path only runs in-session (e.g. when the
    // layer is edited and recreated). Blob URLs stay valid for the document
    // lifetime, so the URL created when the file was added is still usable.
    if (layerConfig.url && layerConfig.url.startsWith('blob:')) {
      return layerConfig.url;
    }
    // Otherwise recreate the blob URL from the IndexedDB bytes, if kept.
    if (layerConfig.cogIdbKey) {
      const bytes = await idbGetBinaryWithRetry(layerConfig.cogIdbKey);
      if (bytes) {
        return URL.createObjectURL(new Blob([bytes], { type: 'image/tiff' }));
      }
    }
    throw new Error('File-based COG layers are not persisted. Please re-add the file.');
  }
  if (layerConfig.cogSource === 's3') {
    const s3: S3Config = {
      bucket: layerConfig.cogBucket || '',
      objectKey: layerConfig.cogObjectKey || '',
      region: layerConfig.cogRegion,
      endpoint: layerConfig.cogEndpoint,
      accessKeyId: layerConfig.cogAccessKeyId,
      secretAccessKey: layerConfig.cogSecretAccessKey,
      sessionToken: layerConfig.cogSessionToken,
    };
    const url = await resolveS3CogUrl(s3);
    return url;
  }
  return layerConfig.url;
}

/**
 * Create a WebGLTile layer from a GeoTIFF/COG URL, wait for metadata,
 * register the source projection if needed, and extract the extent in
 * EPSG:3857.
 */
export async function createCogLayer(url: string): Promise<{ olLayer: any; extent: number[] | null }> {
  const source = new GeoTIFFSource({
    sources: [{ url }],
  });
  // The style exposes exposure/contrast/saturation as GPU variables so the
  // colour sliders work on WebGL-rendered COGs (CSS filters cannot affect
  // them). See createCogTileStyle/applyColorAdjustments in layerHelpers.
  const olLayer = new WebGLTileLayer({ source, style: createCogTileStyle() });

  // Wait for the source to finish loading its metadata (projection, extent,
  // tile grid). The source transitions from 'loading' to 'ready' (or 'error').
  await new Promise<void>((resolve, reject) => {
    const wrapError = (raw: any) => {
      const msg = raw?.message || String(raw);
      // Detect likely CORS or network failures from the geotiff fetch
      if (/failed to fetch|networkerror|load failed|cors|access-control/i.test(msg)) {
        return new Error(
          'Could not load the GeoTIFF — the server blocked the cross-origin request (CORS).\n\n' +
          'For S3 buckets, add this CORS configuration in the bucket Permissions tab:\n\n' +
          '  [ { "AllowedHeaders": ["*"], "AllowedMethods": ["GET", "HEAD"],\n' +
          '      "AllowedOrigins": ["*"],\n' +
          '      "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"] } ]\n\n' +
          'For other object storage (MinIO, R2, etc.), enable equivalent CORS rules.\n' +
          'Original error: ' + msg
        );
      }
      return raw instanceof Error ? raw : new Error(msg);
    };
    if (source.getState() === 'ready') { resolve(); return; }
    if (source.getState() === 'error') { reject(wrapError(source.getError())); return; }
    const onChange = () => {
      const state = source.getState();
      if (state === 'ready') { resolve(); }
      else if (state === 'error') { reject(wrapError(source.getError())); }
    };
    source.on('change', onChange);
  });

  // --- Register the source projection if it is not already known ---
  const srcProj = source.getProjection();
  let extent3857: number[] | null = null;

  if (srcProj) {
    const code: string = srcProj.getCode ? srcProj.getCode() : String(srcProj);
    const epsgMatch = code.match(/EPSG:(\d+)/i);

    if (epsgMatch) {
      const epsgNum = epsgMatch[1];
      // Ensure proj4 knows this projection so OL can transform coordinates
      if (!getOlProjection(code)) {
        try {
          await registerProjectionFromEPSGCode(epsgNum);
        } catch (e) {
          console.warn(`[COG] Could not register projection ${code}:`, e);
        }
      }
    }

    // --- Extract the extent and transform to EPSG:3857 ---
    try {
      const tileGrid = source.getTileGrid?.();
      const rawExtent: number[] | undefined = tileGrid?.getExtent?.();
      if (rawExtent && rawExtent.length === 4 && rawExtent.every(isFinite)) {
        const resolvedProj = getOlProjection(code) || srcProj;
        if (code === 'EPSG:3857') {
          extent3857 = rawExtent.slice();
        } else {
          try {
            extent3857 = transformExtent(rawExtent, resolvedProj, 'EPSG:3857');
          } catch (e) {
            console.warn('[COG] Failed to transform extent to EPSG:3857:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[COG] Failed to read extent from GeoTIFF source:', e);
    }
  }

  return { olLayer, extent: extent3857 };
}

// --- Unified raster layer factory -------------------------------------------

/**
 * Create an OL layer + extent from a RasterLayer config.
 * Handles WMTS, WMS, COG and XYZ types.
 */
export async function createRasterOlLayer(config: RasterLayer): Promise<{ olLayer: any; extent: number[] | null }> {
  let olLayer: any;
  let extent: number[] | null = null;

  if (config.type === 'wmts') {
    const response = await fetch(config.wmtsCapabilitiesUrl || config.url);
    const text = await response.text();
    const parser = new WMTSCapabilities();
    const capabilities = parser.read(text);

    const wmtsOptions = optionsFromCapabilities(capabilities, {
      layer: config.wmtsLayer || '',
    });

    if (!wmtsOptions) {
      throw new Error('Failed to create WMTS options from capabilities');
    }

    extent = extractWmtsExtent(capabilities, config.wmtsLayer || '');
    olLayer = new TileLayer({
      source: createWmtsSource(wmtsOptions, config.minZoom, config.maxZoom),
    });
  } else if (config.type === 'wms') {
    // Fetch capabilities to extract extent
    try {
      const response = await fetch(config.wmsCapabilitiesUrl || config.url);
      const text = await response.text();
      const parser = new WMSCapabilities();
      const capabilities = parser.read(text);
      extent = extractWmsExtent(capabilities, config.wmsLayer || '');
    } catch (capError) {
      console.warn('[RasterLayerFactory] Failed to fetch WMS capabilities for extent:', capError);
    }

    olLayer = new ImageLayer({
      source: new ImageWMS({
        url: extractBaseUrl(config.wmsCapabilitiesUrl || config.url),
        params: { LAYERS: config.wmsLayer || '' },
        ratio: 1,
        serverType: 'geoserver',
        crossOrigin: 'anonymous',
      }),
    });
  } else if (config.type === 'cog') {
    const cogUrl = await resolveCogUrl(config);
    const cogResult = await createCogLayer(cogUrl);
    olLayer = cogResult.olLayer;
    extent = cogResult.extent;
  } else {
    // XYZ (default)
    olLayer = new TileLayer({
      source: createXYZSource(config.url, config.minZoom, config.maxZoom),
    });
  }

  return { olLayer, extent };
}
