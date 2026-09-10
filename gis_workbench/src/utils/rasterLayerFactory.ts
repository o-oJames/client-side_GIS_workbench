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

import type { RasterLayer, CogRenderConfig } from '../types';
import {
  createXYZSource,
  createWmtsSource,
  extractWmtsExtent,
  extractWmsExtent,
  extractBaseUrl,
} from './tileHelpers';
import {
  buildCogRenderStyle,
  cogBakeRanges,
  describeCogBands,
  normalizeCogRender,
  type CogBandInfo,
} from './cogBands';
import { registerProjectionFromEPSGCode } from './projectionHelper';
import { createTileHillshadeLayer } from './tileHillshade';
import { resolveS3CogUrl, buildS3HttpsUrl, hasS3Credentials, detectS3BucketRegion } from './cogHelpers';
import { getCogFileUrl } from './cogFileRegistry';
import type { S3Config } from './cogHelpers';
import {
  findConnector,
  companionHasCapability,
  companionDetectS3Region,
  companionPresignS3Url,
  companionProxyUrl,
  getCogEncryptionKey,
} from './companion';
import { decryptCogCredentials } from './cogCredentials';

// --- COG helpers ------------------------------------------------------------

/**
 * Resolve the effective URL for a COG layer config:
 * - file: reuse the session blob URL kept in cogFileRegistry
 * - s3: pre-sign (with credentials) or build public HTTPS URL
 *        If the companion is running with cog-proxy capability,
 *        route through the companion to bypass CORS.
 * - http: use the URL as-is
 */
export async function resolveCogUrl(layerConfig: RasterLayer): Promise<string> {
  if (layerConfig.cogSource === 'file') {
    // File-sourced COGs never copy their bytes (no IndexedDB): the blob URL
    // created from the File when the layer was added is kept alive in the
    // session registry for the document lifetime, which lets the layer be
    // rebuilt across workspace switches. The persisted `url` field is not
    // trusted — after a page reload it points at a dead blob URL and the
    // registry is empty, so the file must be re-added.
    const liveUrl = getCogFileUrl(layerConfig.id);
    if (liveUrl) return liveUrl;
    throw new Error('File-based COG layers are not persisted. Please re-add the file.');
  }
  if (layerConfig.cogSource === 's3') {
    // Decrypt S3 credentials from the encrypted blob (plain-text fields are
    // never persisted -- they only exist transiently during layer creation).
    let accessKeyId: string | undefined;
    let secretAccessKey: string | undefined;
    let sessionToken: string | undefined;

    if (layerConfig.cogCredentialsEncrypted) {
      try {
        const encKey = await getCogEncryptionKey();
        const creds = await decryptCogCredentials(layerConfig.cogCredentialsEncrypted, encKey);
        if (creds) {
          accessKeyId = creds.cogAccessKeyId;
          secretAccessKey = creds.cogSecretAccessKey;
          sessionToken = creds.cogSessionToken;
        }
      } catch (e) {
        console.warn('[COG] Failed to decrypt S3 credentials:', e);
      }
    }

    // Fallback: plain-text fields still on the config (legacy layers created
    // before encrypted storage was introduced, or in-memory during creation).
    if (!accessKeyId && layerConfig.cogAccessKeyId) accessKeyId = layerConfig.cogAccessKeyId;
    if (!secretAccessKey && layerConfig.cogSecretAccessKey) secretAccessKey = layerConfig.cogSecretAccessKey;
    if (!sessionToken && layerConfig.cogSessionToken) sessionToken = layerConfig.cogSessionToken;

    const s3: S3Config = {
      bucket: layerConfig.cogBucket || '',
      objectKey: layerConfig.cogObjectKey || '',
      region: layerConfig.cogRegion,
      endpoint: layerConfig.cogEndpoint,
      accessKeyId,
      secretAccessKey,
      sessionToken,
    };

    // Check if companion is available with cog-proxy capability
    const companionUrl = await findConnector();
    if (companionUrl) {
      const hasProxy = await companionHasCapability('cog-proxy');
      if (hasProxy) {
        // Use companion for region detection (no CORS issues)
        if (!s3.endpoint && !s3.region) {
          const detectedRegion = await companionDetectS3Region(companionUrl, s3.bucket, s3.endpoint);
          if (detectedRegion) {
            console.log(`[COG] Companion detected S3 bucket region: ${detectedRegion}`);
            s3.region = detectedRegion;
          }
        }

        // If credentials provided, use companion to presign (no CORS issues)
        if (hasS3Credentials(s3)) {
          const signedUrl = await companionPresignS3Url(companionUrl, {
            bucket: s3.bucket,
            objectKey: s3.objectKey,
            region: s3.region,
            endpoint: s3.endpoint,
            accessKeyId: s3.accessKeyId!,
            secretAccessKey: s3.secretAccessKey!,
            sessionToken: s3.sessionToken,
          });
          if (signedUrl) {
            // Route through companion proxy to bypass CORS
            return companionProxyUrl(companionUrl, signedUrl);
          }
        }

        // Public bucket — route through companion proxy to bypass CORS
        const publicUrl = buildS3HttpsUrl(s3);
        return companionProxyUrl(companionUrl, publicUrl);
      }
    }

    // Fallback: no companion, use browser-side resolution (may fail due to CORS)
    const url = await resolveS3CogUrl(s3);
    return url;
  }
  return layerConfig.url;
}

/**
 * Wait for a GeoTIFF source to finish loading its metadata (projection,
 * extent, tile grid). The source transitions from 'loading' to 'ready' (or
 * 'error'); a CORS/network failure is rewritten into actionable guidance.
 */
async function waitForGeoTiffSource(source: any): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const wrapError = (raw: any) => {
      const msg = raw?.message || String(raw);
      // Detect likely CORS or network failures from the geotiff fetch
      if (/failed to fetch|networkerror|load failed|cors|access-control/i.test(msg)) {
        // Plain text on purpose: this message is rendered verbatim by the
        // layer error banner and by the add-raster-layer form's inline error
        // block (neither parses markdown).
        return new Error(
          'Could not load the GeoTIFF — the bucket is blocking cross-origin requests (CORS).\n\n' +
          'Two ways to fix it:\n\n' +
          '1. Run the Workbench Companion (recommended). It proxies S3/COG requests\n' +
          '   from your own machine, so CORS never applies. Start it and press Add\n' +
          '   again — your inputs are kept. Get it from the PostGIS setup wizard.\n\n' +
          '2. Ask the bucket owner to allow CORS: S3 console → bucket → Permissions\n' +
          '   → "Cross-origin resource sharing (CORS)" → Edit, then add:\n\n' +
          '   [\n' +
          '     {\n' +
          '       "AllowedHeaders": ["*"],\n' +
          '       "AllowedMethods": ["GET", "HEAD"],\n' +
          '       "AllowedOrigins": ["*"],\n' +
          '       "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"]\n' +
          '     }\n' +
          '   ]\n\n' +
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
}

export interface CogLayerResult {
  olLayer: any;
  extent: number[] | null;
  /** Band layout read from the file, so callers can cache it for the editor. */
  bandInfo: CogBandInfo | null;
}

/**
 * Create a WebGLTile layer from a GeoTIFF/COG URL, wait for metadata, apply
 * the band/renderer choice, register the source projection if needed, and
 * extract the extent in EPSG:3857.
 *
 * Two-phase on purpose. The band layout (sample types, colour table, GDAL
 * statistics) is only known once the file header has been read, so a plain
 * source is opened first. If the chosen renderer needs a display stretch or a
 * colour table, that range is then baked into a second source's per-band
 * normalisation — giving full 8-bit precision across exactly the window the
 * user asked for instead of quantising the file's whole range first. Band
 * *mapping* (which band is red, which is displayed) needs no rebuild: it is a
 * `color` expression over bands the source already loaded.
 *
 * The style also exposes exposure/contrast/saturation as GPU variables so the
 * colour sliders work on WebGL-rendered COGs (CSS filters cannot affect them) —
 * see createCogTileStyle/applyColorAdjustments in layerHelpers.
 */
export async function createCogLayer(
  url: string,
  render?: CogRenderConfig | null,
): Promise<CogLayerResult> {
  let source = new GeoTIFFSource({ sources: [{ url }] });
  await waitForGeoTiffSource(source);

  let bandInfo: CogBandInfo | null = await describeCogBands(source);
  const effective = normalizeCogRender(render, bandInfo);
  const bake = cogBakeRanges(effective, bandInfo);
  if (bake) {
    source = new GeoTIFFSource({ sources: [{ url, min: bake.min, max: bake.max }] });
    await waitForGeoTiffSource(source);
    bandInfo = await describeCogBands(source);
  }

  const olLayer = new WebGLTileLayer({ source, style: buildCogRenderStyle(effective, bandInfo) });

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

  return { olLayer, extent: extent3857, bandInfo };
}

// --- Unified raster layer factory -------------------------------------------

/**
 * Create an OL layer + extent from a RasterLayer config.
 * Handles WMTS, WMS, COG and XYZ types.
 */
export async function createRasterOlLayer(config: RasterLayer): Promise<{ olLayer: any; extent: number[] | null; bandInfo?: CogBandInfo | null }> {
  let olLayer: any;
  let extent: number[] | null = null;
  let bandInfo: CogBandInfo | null = null;

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
    const wmtsSource = createWmtsSource(wmtsOptions, config.minZoom, config.maxZoom);
    
    // If tileRender is hillshade mode, wrap the source in a RasterSource
    if (config.tileRender?.mode === 'hillshade') {
      const hillshadeLayer = createTileHillshadeLayer(wmtsSource, config.tileRender);
      olLayer = hillshadeLayer;
    } else {
      olLayer = new TileLayer({ source: wmtsSource });
    }
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
    const cogResult = await createCogLayer(cogUrl, config.cogRender);
    olLayer = cogResult.olLayer;
    extent = cogResult.extent;
    bandInfo = cogResult.bandInfo;
  } else {
    // XYZ (default)
    const tileSource = createXYZSource(config.url, config.minZoom, config.maxZoom);
    
    // If tileRender is hillshade mode, wrap the source in a RasterSource
    if (config.tileRender?.mode === 'hillshade') {
      const hillshadeLayer = createTileHillshadeLayer(tileSource, config.tileRender);
      olLayer = hillshadeLayer;
    } else {
      olLayer = new TileLayer({ source: tileSource });
    }
  }

  return { olLayer, extent, bandInfo };
}
