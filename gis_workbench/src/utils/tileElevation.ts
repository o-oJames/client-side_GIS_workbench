// ---------------------------------------------------------------------------
// tileElevation — read elevation data from rendered XYZ/WMTS/WMS tile images.
//
// Unlike COG layers (which expose raw pixel values through geotiff.js), tile
// layers serve pre-rendered PNG/JPEG images. For terrain tiles like AWS's
// "terrarium" encoding, elevation is packed into RGB channels:
//
//   elevation = R * 256 + G + B / 256 - 32768   (metres)
//
// This module fetches the tiles covering a view extent, decodes their pixels
// into an elevation grid, and hands that grid to the same marching-squares
// tracer the COG contours use — so contour lines and hillshade work on any
// tile layer whose tiles encode terrain, not just GeoTIFF files.
//
// CRITICAL: We decode PNG bytes directly to avoid browser sRGB gamma correction
// that corrupts raw elevation data stored in RGB channels.
//
// Framework-agnostic per AGENTS.md §3: plain data in, plain data out.
// ---------------------------------------------------------------------------
import { getTransform, transformExtent } from 'ol/proj.js';
import { getIntersection } from 'ol/extent.js';
import type { TileGrid } from 'ol/tilegrid.js';
/**
 * Tile cache to avoid re-decoding the same tiles on every pan.
 * Key: tile URL, Value: decoded pixel data
 */
const tileCache = new Map<string, { pixels: Uint8Array; width: number; height: number; timestamp: number }>();
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 60000; // 1 minute
function getFromCache(url: string): { pixels: Uint8Array; width: number; height: number } | null {
  const cached = tileCache.get(url);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    tileCache.delete(url);
    return null;
  }
  return cached;
}
function addToCache(url: string, data: { pixels: Uint8Array; width: number; height: number }): void {
  if (tileCache.size >= MAX_CACHE_SIZE) {
    // Remove oldest entry
    const oldest = Array.from(tileCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    tileCache.delete(oldest[0]);
  }
  tileCache.set(url, { ...data, timestamp: Date.now() });
}
/** How the tile's RGB channels encode elevation. */
export type TileElevationEncoding =
  | 'terrarium'   // R*256 + G + B/256 - 32768 (AWS terrain tiles)
  | 'mapbox'      // (R*256*256 + G*256 + B) * 0.1 - 10000 (Mapbox terrain-rgb)
  | 'grayscale';  // single-band: R is elevation (0-255 mapped to a range)
/** Parameters for reading elevation from a tile layer. */
export interface TileElevationOptions {
  /** The OL tile source (XYZ, WMTS, etc.). */
  source: any;
  /** The tile grid (from source.getTileGrid()). */
  tileGrid: TileGrid;
  /** Area to cover in the view projection. */
  viewExtent: number[];
  /** EPSG code of the view projection. */
  viewProjection: string;
  /** Target output grid size (width × height in cells). */
  viewport: { width: number; height: number };
  /** How RGB encodes elevation. */
  encoding: TileElevationEncoding;
  /** For 'grayscale': the elevation range the 0-255 values map to. */
  grayscaleRange?: { min: number; max: number };
  /** How many times coarser than the viewport to sample (default 1). */
  downscale?: number;
  /** Optional: explicit zoom level to use. If not provided, calculated from view resolution. */
  zoom?: number;
}
/** An elevation grid sampled from tile images. */
export interface TileElevationGrid {
  /** Elevations in metres; NaN where no tile covered or decoding failed. */
  field: Float32Array;
  width: number;
  height: number;
  /** Area covered in the view projection: [minx, miny, maxx, maxy]. */
  extent: number[];
}
/** Decode one RGB pixel into an elevation value. */
export function decodeElevation(
  r: number, g: number, b: number,
  encoding: TileElevationEncoding,
  grayscaleRange?: { min: number; max: number },
): number {
  switch (encoding) {
    case 'terrarium': {
      const step1 = r * 256;
      const step2 = step1 + g;
      const step3 = step2 + b / 256;
      const result = step3 - 32768;
      return result;
    }
    case 'mapbox':
      return (r * 256 * 256 + g * 256 + b) * 0.1 - 10000;
    case 'grayscale': {
      const range = grayscaleRange ?? { min: 0, max: 255 };
      const t = r / 255;
      return range.min + t * (range.max - range.min);
    }
    default:
      return NaN;
  }
}
// ---------------------------------------------------------------------------
// Minimal PNG decoder — extracts raw RGB values without browser color management
// ---------------------------------------------------------------------------
/** PNG signature bytes */
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** Read a 32-bit big-endian integer from a DataView */
function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset);
}
/** CRC32 lookup table */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc;
  }
  return table;
})();
/** Compute CRC32 for a byte array */
function crc32(data: Uint8Array, offset: number, length: number): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < length; i++) {
    crc = CRC_TABLE[(crc ^ data[offset + i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
/** Decompress zlib data using DecompressionStream (browser native) */
async function decompressZlib(data: Uint8Array): Promise<Uint8Array> {
  // PNG IDAT contains zlib-wrapped data (2-byte header + deflate + 4-byte checksum)
  // DecompressionStream('deflate') expects the full zlib-wrapped format
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data);
  writer.close();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
/** PNG filter types */
enum FilterType {
  None = 0,
  Sub = 1,
  Up = 2,
  Average = 3,
  Paeth = 4
}
/** Apply PNG scanline filter */
function applyFilter(
  filtered: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number
): Uint8Array {
  const stride = width * bytesPerPixel;
  const result = new Uint8Array(filtered.length);
  for (let y = 0; y < height; y++) {
    const filterType = filtered[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const prevRowStart = y > 0 ? (y - 1) * (stride + 1) + 1 : 0;
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? result[rowStart + x - bytesPerPixel] : 0;
      const b = y > 0 ? result[prevRowStart + x] : 0;
      const c = (x >= bytesPerPixel && y > 0) ? result[prevRowStart + x - bytesPerPixel] : 0;
      let raw: number;
      switch (filterType) {
        case FilterType.None:
          raw = filtered[rowStart + x];
          break;
        case FilterType.Sub:
          raw = (filtered[rowStart + x] + a) & 0xFF;
          break;
        case FilterType.Up:
          raw = (filtered[rowStart + x] + b) & 0xFF;
          break;
        case FilterType.Average:
          raw = (filtered[rowStart + x] + Math.floor((a + b) / 2)) & 0xFF;
          break;
        case FilterType.Paeth: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          raw = (filtered[rowStart + x] + pr) & 0xFF;
          break;
        }
        default:
          raw = filtered[rowStart + x];
      }
      result[rowStart + x] = raw;
    }
  }
  return result;
}
/** Decode PNG and extract raw RGB pixels */
async function decodePNG(buffer: ArrayBuffer): Promise<{ width: number; height: number; pixels: Uint8Array } | null> {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // Check PNG signature
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) {
      console.warn('[decodePNG] Invalid PNG signature');
      return null;
    }
  }
  // Parse chunks
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];
  while (offset < data.length) {
    const chunkLength = readUint32(view, offset);
    const chunkType = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const chunkData = data.slice(offset + 8, offset + 8 + chunkLength);
    const chunkCRC = readUint32(view, offset + 8 + chunkLength);
    // Verify CRC
    const computedCRC = crc32(data, offset + 4, chunkLength + 4);
    if (computedCRC !== chunkCRC) {
      console.warn('[decodePNG] CRC mismatch for chunk:', chunkType);
    }
    if (chunkType === 'IHDR') {
      width = readUint32(view, offset + 8);
      height = readUint32(view, offset + 12);
      bitDepth = data[offset + 16];
      colorType = data[offset + 17];
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (chunkType === 'IEND') {
      break;
    }
    offset += 12 + chunkLength;
  }
  if (width === 0 || height === 0) {
    console.warn('[decodePNG] Invalid dimensions:', width, height);
    return null;
  }
  // Concatenate IDAT data
  let totalLength = 0;
  for (const chunk of idatChunks) {
    totalLength += chunk.length;
  }
  const compressed = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, pos);
    pos += chunk.length;
  }
  // Decompress
  const decompressed = await decompressZlib(compressed);
  // Determine bytes per pixel
  let bytesPerPixel: number;
  switch (colorType) {
    case 0: // Grayscale
      bytesPerPixel = bitDepth / 8;
      break;
    case 2: // RGB
      bytesPerPixel = 3 * (bitDepth / 8);
      break;
    case 4: // Grayscale + Alpha
      bytesPerPixel = 2 * (bitDepth / 8);
      break;
    case 6: // RGBA
      bytesPerPixel = 4 * (bitDepth / 8);
      break;
    default:
      console.warn('[decodePNG] Unsupported color type:', colorType);
      return null;
  }
  // Apply filters
  const filtered = applyFilter(decompressed, width, height, bytesPerPixel);
  // Extract RGB pixels (convert to RGBA for consistency)
  const pixels = new Uint8Array(width * height * 4);
  const stride = width * bytesPerPixel + 1; // +1 for filter byte
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * stride + 1 + x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      if (colorType === 0) {
        // Grayscale
        pixels[dstIdx] = filtered[srcIdx];
        pixels[dstIdx + 1] = filtered[srcIdx];
        pixels[dstIdx + 2] = filtered[srcIdx];
        pixels[dstIdx + 3] = 255;
      } else if (colorType === 2) {
        // RGB
        pixels[dstIdx] = filtered[srcIdx];
        pixels[dstIdx + 1] = filtered[srcIdx + 1];
        pixels[dstIdx + 2] = filtered[srcIdx + 2];
        pixels[dstIdx + 3] = 255;
      } else if (colorType === 4) {
        // Grayscale + Alpha
        pixels[dstIdx] = filtered[srcIdx];
        pixels[dstIdx + 1] = filtered[srcIdx];
        pixels[dstIdx + 2] = filtered[srcIdx];
        pixels[dstIdx + 3] = filtered[srcIdx + 1];
      } else if (colorType === 6) {
        // RGBA
        pixels[dstIdx] = filtered[srcIdx];
        pixels[dstIdx + 1] = filtered[srcIdx + 1];
        pixels[dstIdx + 2] = filtered[srcIdx + 2];
        pixels[dstIdx + 3] = filtered[srcIdx + 3];
      }
    }
  }
  return { width, height, pixels };
}
/**
 * Fetch a single tile image and decode it into raw RGB pixels.
 * Returns null if the tile could not be loaded (CORS, network error, etc.).
 */
async function fetchTileElevation(
  url: string,
  encoding: TileElevationEncoding,
  grayscaleRange?: { min: number; max: number },
  signal?: AbortSignal,
): Promise<{ pixels: Uint8Array; width: number; height: number } | null> {
  try {
      const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) {
      console.warn('[tileElevation] Fetch failed:', response.status, response.statusText);
      return null;
    }
    const buffer = await response.arrayBuffer();
    const decoded = await decodePNG(buffer);
    if (!decoded) {
      console.warn('[tileElevation] PNG decode failed');
      return null;
    }
    return decoded;
  } catch (error) {
    console.warn('[tileElevation] Failed to fetch tile:', url, error);
    return null;
  }
}
/**
 * Build a URL for a tile at the given Z/X/Y from the source.
 * Handles XYZ templates ({x}, {y}, {z}, {-y}) and quadkey ({q}).
 */
function buildTileUrl(source: any, z: number, x: number, y: number): string | null {
  // Try the source's own URL builder first
  if (typeof source.getTileUrlForCoord === 'function') {
    // OL uses [z, x, y, -y] coordinate arrays
    const coord = [z, x, y];
    const url = source.getTileUrlForCoord(coord);
    if (url) return url;
  }
  // Fall back to the URL template
  const urls = source.getUrls?.();
  const urlTemplate = Array.isArray(urls) ? urls[0] : (source.getUrl?.() ?? urls);
  if (!urlTemplate || typeof urlTemplate !== 'string') return null;
  // Compute the TMS y (flipped) if the template uses {-y}
  const tileGrid = source.getTileGrid?.();
  let negY = y;
  if (tileGrid) {
    const fullExtent = tileGrid.getFullExtent?.();
    if (fullExtent) {
      const tileSize = tileGrid.getTileSize(z);
      const size = typeof tileSize === 'number' ? tileSize : tileSize?.[0] ?? 256;
      const matrixHeight = Math.round((fullExtent[3] - fullExtent[1]) / (tileGrid.getResolution(z) * size));
      negY = matrixHeight - y - 1;
    }
  }
  let url = urlTemplate
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{-y}', String(negY));
  // Quadkey expansion (Bing style)
  if (url.includes('{q}')) {
    let quadkey = '';
    for (let i = z; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((x & mask) !== 0) digit++;
      if ((y & mask) !== 0) digit += 2;
      quadkey += digit;
    }
    url = url.replace('{q}', quadkey);
  }
  return url;
}
/**
 * Read elevation data from tile images covering the view extent.
 *
 * Fetches each tile that intersects the extent, decodes its RGB pixels into
 * elevations, and composites them into a single grid at the requested
 * resolution. The grid is sized from the viewport and downscale factor,
 * matching how QGIS sizes its contour input.
 */
export async function readTileElevationGrid(
  options: TileElevationOptions,
  signal?: AbortSignal,
): Promise<TileElevationGrid | null> {
  const {
    source, tileGrid, viewExtent, viewProjection, viewport,
    encoding, grayscaleRange, downscale = 1,
  } = options;
  if (!tileGrid || !viewExtent || viewExtent.length !== 4) return null;
  const factor = Math.max(1, downscale);
  const vpW = Math.max(1, viewport.width ?? 512);
  const vpH = Math.max(1, viewport.height ?? 512);
  const outW = Math.round(vpW / factor);
  const outH = Math.round(vpH / factor);
  if (outW < 2 || outH < 2) return null;
  // Determine the tile Z to use: the finest level whose resolution is
  // close to (or finer than) the output grid's cell size.
  const spanX = viewExtent[2] - viewExtent[0];
  const spanY = viewExtent[3] - viewExtent[1];
  const cellSize = Math.max(spanX / outW, spanY / outH);
  // Use the provided zoom level, or calculate from view resolution if not provided
  const maxZ = tileGrid.getMaxZoom();
  const minZ = tileGrid.getMinZoom();
  let z: number;
  if (options.zoom !== undefined) {
    // Use the explicitly provided zoom level (from the map view)
    z = Math.max(minZ, Math.min(maxZ, Math.round(options.zoom)));
  } else {
    // Calculate from view resolution: how many ground meters per output cell
    const viewResolution = spanX / viewport.width;
    let bestZ = minZ;
    for (let candidateZ = minZ; candidateZ <= maxZ; candidateZ++) {
      const res = tileGrid.getResolution(candidateZ);
      if (res <= viewResolution * 2) {
        bestZ = candidateZ;
      } else {
        break;
      }
    }
    z = bestZ;
  }
  const tileResolution = tileGrid.getResolution(z);
  const tileSize = tileGrid.getTileSize(z);
  const tilePixelSize = typeof tileSize === 'number' ? tileSize : (tileSize?.[0] ?? 256);
  // Origin of the tile grid (top-left corner in the source projection)
  const origin = tileGrid.getOrigin?.(z) ?? tileGrid.getOrigin?.(0);
  if (!origin) return null;
  const originX = origin[0];
  const originY = origin[1];
  // Which tile indices cover the view extent?
  // Expand by 1 tile in each direction (gutter) so marching-squares produces
  // continuous contours across tile boundaries — no more disconnected segments.
  const tileGroundSize = tileResolution * tilePixelSize;
  const tileMinX = Math.floor((viewExtent[0] - originX) / tileGroundSize) - 1;
  const tileMaxX = Math.floor((viewExtent[2] - originX) / tileGroundSize) + 1;
  const tileMinY = Math.floor((originY - viewExtent[3]) / tileGroundSize) - 1;
  const tileMaxY = Math.floor((originY - viewExtent[1]) / tileGroundSize) + 1;
  // Expanded extent covers all fetched tiles (not just the view extent)
  const expandedExtent = [
    originX + tileMinX * tileGroundSize,
    originY - (tileMaxY + 1) * tileGroundSize,
    originX + (tileMaxX + 1) * tileGroundSize,
    originY - tileMinY * tileGroundSize,
  ];
  // Keep the same cell resolution but cover the expanded area
  const cellSizeX = spanX / outW;
  const cellSizeY = spanY / outH;
  const expandedW = Math.max(2, Math.round((expandedExtent[2] - expandedExtent[0]) / cellSizeX));
  const expandedH = Math.max(2, Math.round((expandedExtent[3] - expandedExtent[1]) / cellSizeY));
  const expandedSpanX = expandedExtent[2] - expandedExtent[0];
  const expandedSpanY = expandedExtent[3] - expandedExtent[1];
  // Fetch all tiles in parallel (including the gutter tiles)
  const tilePromises: Array<{
    tx: number; ty: number;
    promise: Promise<{ pixels: Uint8Array; width: number; height: number } | null>;
  }> = [];
  for (let tx = tileMinX; tx <= tileMaxX; tx++) {
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      const url = buildTileUrl(source, z, tx, ty);
      if (!url) continue;
      tilePromises.push({
        tx, ty,
        promise: fetchTileElevation(url, encoding, grayscaleRange, signal),
      });
    }
  }
  const results = await Promise.all(tilePromises.map(async (t) => ({
    ...t,
    data: await t.promise,
  })));
  // Debug: log tile loading results
  const loadedTiles = results.filter(r => r.data !== null);
  if (loadedTiles.length === 0) {
    console.warn('[tileElevation] No tiles loaded! Check CORS or network.');
    return null;
  }
  // Build the expanded output elevation grid
  const field = new Float32Array(expandedW * expandedH).fill(NaN);
  for (const { tx, ty, data } of results) {
    if (!data) continue;
    const { pixels, width: tileW, height: tileH } = data;
    // This tile's ground extent
    const tileMinXGround = originX + tx * tileGroundSize;
    const tileMaxYGround = originY - ty * tileGroundSize;
    const tileMaxXGround = tileMinXGround + tileGroundSize;
    const tileMinYGround = tileMaxYGround - tileGroundSize;
    // Map each expanded-grid cell to a tile pixel
    for (let oy = 0; oy < expandedH; oy++) {
      // Output cell centre in ground coordinates
      const gy = expandedExtent[3] - (oy + 0.5) * (expandedSpanY / expandedH);
      if (gy > tileMaxYGround || gy < tileMinYGround) continue;
      // Fraction within this tile (0 = top/left, 1 = bottom/right)
      const tileFracY = (tileMaxYGround - gy) / tileGroundSize;
      const srcY = Math.min(tileH - 1, Math.max(0, Math.floor(tileFracY * tileH)));
      for (let ox = 0; ox < expandedW; ox++) {
        const gx = expandedExtent[0] + (ox + 0.5) * (expandedSpanX / expandedW);
        if (gx < tileMinXGround || gx > tileMaxXGround) continue;
        const tileFracX = (gx - tileMinXGround) / tileGroundSize;
        const srcX = Math.min(tileW - 1, Math.max(0, Math.floor(tileFracX * tileW)));
        const pixelIndex = (srcY * tileW + srcX) * 4;
        const r = pixels[pixelIndex];
        const g = pixels[pixelIndex + 1];
        const b = pixels[pixelIndex + 2];
        const elev = decodeElevation(r, g, b, encoding, grayscaleRange);
        if (Number.isFinite(elev)) {
          field[oy * expandedW + ox] = elev;
        }
      }
    }
  }
  return { field, width: expandedW, height: expandedH, extent: expandedExtent };
}
/**
 * Convenience: read an elevation grid from an OL tile source for a view.
 * Returns null if the source has no tile grid or the view is unusable.
 */
export async function readTileElevationGridForView(
  source: any,
  viewExtent: number[],
  viewProjection: string,
  viewport: { width: number; height: number },
  encoding: TileElevationEncoding,
  options?: {
    downscale?: number;
    grayscaleRange?: { min: number; max: number };
    zoom?: number;
    signal?: AbortSignal;
  },
): Promise<TileElevationGrid | null> {
  const tileGrid = source?.getTileGrid?.();
  if (!tileGrid) return null;
  return readTileElevationGrid({
    source,
    tileGrid,
    viewExtent,
    viewProjection,
    viewport,
    encoding,
    downscale: options?.downscale ?? 4,
    grayscaleRange: options?.grayscaleRange,
    zoom: options?.zoom,
  }, options?.signal);
}
