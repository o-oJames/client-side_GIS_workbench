// ---------------------------------------------------------------------------
// tileContoursWorker — Web Worker for tile contour tracing with progressive
// rendering.
//
// Receives tiles incrementally, builds the elevation grid progressively, and
// returns contour paths after each tile so the UI can update immediately.
// This gives a "loading" effect where contours appear tile-by-tile rather
// than waiting for all tiles to finish.
// ---------------------------------------------------------------------------

import type {
  JobRequest,
  JobResult,
  ContourPath,
  TileElevationEncoding,
  TileJob,
  WorkerRequest,
} from '../utils/tileContoursWorkerApi';

// --- PNG Decoder (duplicated from tileElevation.ts for worker use) ----------

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset);
}

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

function crc32(data: Uint8Array, offset: number, length: number): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < length; i++) {
    crc = CRC_TABLE[(crc ^ data[offset + i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function decompressZlib(data: Uint8Array): Promise<Uint8Array> {
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

enum FilterType {
  None = 0,
  Sub = 1,
  Up = 2,
  Average = 3,
  Paeth = 4
}

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

async function decodePNG(buffer: ArrayBuffer): Promise<{ width: number; height: number; pixels: Uint8Array } | null> {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return null;
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks: Uint8Array[] = [];
  while (offset < data.length) {
    const chunkLength = readUint32(view, offset);
    const chunkType = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const chunkData = data.slice(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 'IHDR') {
      width = readUint32(view, offset + 8);
      height = readUint32(view, offset + 12);
      bitDepth = data[offset + 16];
      colorType = data[offset + 17];
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (chunkType === 'IEND') break;
    offset += 12 + chunkLength;
  }
  if (width === 0 || height === 0) return null;
  let totalLength = 0;
  for (const chunk of idatChunks) totalLength += chunk.length;
  const compressed = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of idatChunks) { compressed.set(chunk, pos); pos += chunk.length; }
  const decompressed = await decompressZlib(compressed);
  let bytesPerPixel: number;
  switch (colorType) {
    case 0: bytesPerPixel = bitDepth / 8; break;
    case 2: bytesPerPixel = 3 * (bitDepth / 8); break;
    case 4: bytesPerPixel = 2 * (bitDepth / 8); break;
    case 6: bytesPerPixel = 4 * (bitDepth / 8); break;
    default: return null;
  }
  const filtered = applyFilter(decompressed, width, height, bytesPerPixel);
  const pixels = new Uint8Array(width * height * 4);
  const stride = width * bytesPerPixel + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * stride + 1 + x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      if (colorType === 0) {
        pixels[dstIdx] = pixels[dstIdx + 1] = pixels[dstIdx + 2] = filtered[srcIdx];
        pixels[dstIdx + 3] = 255;
      } else if (colorType === 2) {
        pixels[dstIdx] = filtered[srcIdx];
        pixels[dstIdx + 1] = filtered[srcIdx + 1];
        pixels[dstIdx + 2] = filtered[srcIdx + 2];
        pixels[dstIdx + 3] = 255;
      } else if (colorType === 4) {
        pixels[dstIdx] = pixels[dstIdx + 1] = pixels[dstIdx + 2] = filtered[srcIdx];
        pixels[dstIdx + 3] = filtered[srcIdx + 1];
      } else if (colorType === 6) {
        pixels[dstIdx] = filtered[srcIdx];
        pixels[dstIdx + 1] = filtered[srcIdx + 1];
        pixels[dstIdx + 2] = filtered[srcIdx + 2];
        pixels[dstIdx + 3] = filtered[srcIdx + 3];
      }
    }
  }
  return { width, height, pixels };
}

// --- Elevation decoding -----------------------------------------------------

function decodeElevation(
  r: number, g: number, b: number,
  encoding: TileElevationEncoding,
  grayscaleRange?: { min: number; max: number },
): number {
  switch (encoding) {
    case 'terrarium': return r * 256 + g + b / 256 - 32768;
    case 'mapbox': return (r * 256 * 256 + g * 256 + b) * 0.1 - 10000;
    case 'grayscale': {
      const range = grayscaleRange ?? { min: 0, max: 255 };
      return range.min + (r / 255) * (range.max - range.min);
    }
    default: return NaN;
  }
}

// --- Marching squares (abbreviated for space) --------------------------------

interface Pt { x: number; y: number; }
interface IsoPath { points: Pt[]; closed: boolean; }

function edgeCrossing(v1: number, v2: number, x1: number, y1: number, x2: number, y2: number, iso: number): Pt {
  const d = v2 - v1;
  const t = Math.abs(d) < 1e-9 ? 0.5 : (iso - v1) / d;
  return { x: x1 + Math.max(0, Math.min(1, t)) * (x2 - x1), y: y1 + Math.max(0, Math.min(1, t)) * (y2 - y1) };
}

function marchingSquaresSegments(field: Float32Array, width: number, height: number, iso: number): Array<[Pt, Pt]> {
  const v = (x: number, y: number) => field[y * width + x];
  const segments: Array<[Pt, Pt]> = [];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = v(x, y), tr = v(x + 1, y), br = v(x + 1, y + 1), bl = v(x, y + 1);
      if (!Number.isFinite(tl) || !Number.isFinite(tr) || !Number.isFinite(br) || !Number.isFinite(bl)) continue;
      let caseIndex = 0;
      if (tl > iso) caseIndex |= 8;
      if (tr > iso) caseIndex |= 4;
      if (br > iso) caseIndex |= 2;
      if (bl > iso) caseIndex |= 1;
      if (caseIndex === 0 || caseIndex === 15) continue;
      let top: Pt | null = null, right: Pt | null = null, bottom: Pt | null = null, left: Pt | null = null;
      const getTop = () => (top || (top = edgeCrossing(tl, tr, x, y, x + 1, y, iso)));
      const getRight = () => (right || (right = edgeCrossing(tr, br, x + 1, y, x + 1, y + 1, iso)));
      const getBottom = () => (bottom || (bottom = edgeCrossing(bl, br, x, y + 1, x + 1, y + 1, iso)));
      const getLeft = () => (left || (left = edgeCrossing(tl, bl, x, y, x, y + 1, iso)));
      switch (caseIndex) {
        case 1: case 14: segments.push([getLeft(), getBottom()]); break;
        case 2: case 13: segments.push([getBottom(), getRight()]); break;
        case 3: case 12: segments.push([getLeft(), getRight()]); break;
        case 4: case 11: segments.push([getTop(), getRight()]); break;
        case 6: case 9: segments.push([getTop(), getBottom()]); break;
        case 7: case 8: segments.push([getLeft(), getTop()]); break;
        case 5: case 10: {
          const centre = (tl + tr + br + bl) / 4;
          if (caseIndex === 5) {
            if (centre > iso) { segments.push([getLeft(), getTop()]); segments.push([getBottom(), getRight()]); }
            else { segments.push([getLeft(), getBottom()]); segments.push([getTop(), getRight()]); }
          } else {
            if (centre > iso) { segments.push([getTop(), getRight()]); segments.push([getLeft(), getBottom()]); }
            else { segments.push([getLeft(), getTop()]); segments.push([getBottom(), getRight()]); }
          }
          break;
        }
      }
    }
  }
  return segments;
}

function nextUnusedSegment(adjacency: Map<string, Array<{ seg: number; end: 0 | 1 }>>, key: string, used: Uint8Array) {
  const candidates = adjacency.get(key);
  return candidates ? candidates.find((c) => !used[c.seg]) : undefined;
}

function stitchSegments(segments: Array<[Pt, Pt]>): IsoPath[] {
  const keyOf = (p: Pt) => `${p.x}|${p.y}`;
  const adjacency = new Map<string, Array<{ seg: number; end: 0 | 1 }>>();
  segments.forEach((seg, i) => {
    const k0 = keyOf(seg[0]), k1 = keyOf(seg[1]);
    if (!adjacency.has(k0)) adjacency.set(k0, []);
    if (!adjacency.has(k1)) adjacency.set(k1, []);
    adjacency.get(k0)!.push({ seg: i, end: 0 });
    adjacency.get(k1)!.push({ seg: i, end: 1 });
  });
  const used = new Uint8Array(segments.length);
  const paths: IsoPath[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const points: Pt[] = [segments[i][0], segments[i][1]];
    let closed = false, guard = 0;
    while (guard++ <= segments.length) {
      const tail = points[points.length - 1];
      const next = nextUnusedSegment(adjacency, keyOf(tail), used);
      if (!next) break;
      used[next.seg] = 1;
      const seg = segments[next.seg];
      const nextPt = next.end === 0 ? seg[1] : seg[0];
      points.push(nextPt);
      if (nextPt.x === points[0].x && nextPt.y === points[0].y) { closed = true; break; }
    }
    if (closed) {
      points.pop();
      paths.push({ points, closed: true });
      continue;
    }
    const before: Pt[] = [];
    guard = 0;
    while (guard++ <= segments.length) {
      const head = before.length > 0 ? before[before.length - 1] : points[0];
      const next = nextUnusedSegment(adjacency, keyOf(head), used);
      if (!next) break;
      used[next.seg] = 1;
      const seg = segments[next.seg];
      before.push(next.end === 0 ? seg[1] : seg[0]);
    }
    before.reverse();
    paths.push({ points: before.concat(points), closed: false });
  }
  return paths;
}

function marchingSquaresPaths(field: Float32Array, width: number, height: number, iso = 0): IsoPath[] {
  return stitchSegments(marchingSquaresSegments(field, width, height, iso))
    .filter((path) => (path.closed ? path.points.length >= 3 : path.points.length >= 2));
}

// --- Simplification ----------------------------------------------------------

function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.sqrt((a.x + t * dx - p.x) ** 2 + (a.y + t * dy - p.y) ** 2);
}

function douglasPeuckerOpen(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1, maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pointSegmentDistance(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIndex = i; }
    }
    if (maxDist > tolerance && maxIndex !== -1) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function simplifyPath(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  return douglasPeuckerOpen(points, tolerance);
}

function chaikinSmooth(points: Pt[], iterations: number = 2): Pt[] {
  if (points.length < 3) return points.slice();
  let result = points;
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed: Pt[] = [];
    for (let i = 0; i < result.length - 1; i++) {
      const p0 = result[i], p1 = result[i + 1];
      smoothed.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
      smoothed.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
    }
    result = smoothed;
  }
  return result;
}

// --- Tile fetching -----------------------------------------------------------

// --- Tile cache --------------------------------------------------------------

interface CachedTile {
  pixels: Uint8Array;
  width: number;
  height: number;
  timestamp: number;
}

const tileCache = new Map<string, CachedTile>();
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 60000; // 1 minute

function getFromCache(url: string): CachedTile | null {
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

async function fetchTile(url: string): Promise<{ pixels: Uint8Array; width: number; height: number } | null> {
  // Check cache first
  const cached = getFromCache(url);
  if (cached) return cached;
  
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const decoded = await decodePNG(buffer);
    if (decoded) {
      addToCache(url, decoded);
    }
    return decoded;
  } catch { return null; }
}

function gridRange(field: Float32Array): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity, samples = 0;
  for (let i = 0; i < field.length; i++) {
    const value = field[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    samples++;
  }
  return samples > 0 ? { min, max } : null;
}

// --- Progressive job state ---------------------------------------------------

interface JobState {
  jobId: string;
  tiles: TileJob[];
  tileGrid: { origin: [number, number]; resolution: number; tileSize: number; zoom: number };
  viewExtent: [number, number, number, number];
  outputGrid: { width: number; height: number };
  encoding: TileElevationEncoding;
  grayscaleRange?: { min: number; max: number };
  levels: Array<{ level: number; index: boolean }>;
  simplify: number;
  expandedExtent: number[];
  expandedW: number;
  expandedH: number;
  field: Float32Array;
  counts: Uint16Array;
  processedTiles: number;
}

let currentJob: JobState | null = null;

function initJob(req: JobRequest): JobState {
  const { jobId, tiles, tileGrid, viewExtent, outputGrid, encoding, grayscaleRange, levels, simplify } = req;
  const { origin, resolution, tileSize } = tileGrid;
  const [originX, originY] = origin;
  const tileGroundSize = resolution * tileSize;
  const [vx0, vy0, vx1, vy1] = viewExtent;
  const spanX = vx1 - vx0, spanY = vy1 - vy0;
  const outW = Math.max(2, outputGrid.width), outH = Math.max(2, outputGrid.height);
  const cellSizeX = spanX / outW, cellSizeY = spanY / outH;

  let tileMinX = Infinity, tileMaxX = -Infinity, tileMinY = Infinity, tileMaxY = -Infinity;
  for (const t of tiles) {
    if (t.tx < tileMinX) tileMinX = t.tx;
    if (t.tx > tileMaxX) tileMaxX = t.tx;
    if (t.ty < tileMinY) tileMinY = t.ty;
    if (t.ty > tileMaxY) tileMaxY = t.ty;
  }

  const expandedExtent = [
    originX + tileMinX * tileGroundSize,
    originY - (tileMaxY + 1) * tileGroundSize,
    originX + (tileMaxX + 1) * tileGroundSize,
    originY - tileMinY * tileGroundSize,
  ];
  const expandedW = Math.max(2, Math.round((expandedExtent[2] - expandedExtent[0]) / cellSizeX));
  const expandedH = Math.max(2, Math.round((expandedExtent[3] - expandedExtent[1]) / cellSizeY));

  return {
    jobId, tiles, tileGrid, viewExtent, outputGrid, encoding, grayscaleRange, levels, simplify,
    expandedExtent, expandedW, expandedH,
    field: new Float32Array(expandedW * expandedH).fill(NaN),
    counts: new Uint16Array(expandedW * expandedH).fill(0),
    processedTiles: 0,
  };
}

function addTileToGrid(job: JobState, tile: TileJob, data: { pixels: Uint8Array; width: number; height: number }): void {
  const { tileGrid, expandedExtent, expandedW, expandedH, encoding, grayscaleRange, field, counts } = job;
  const { origin, resolution, tileSize } = tileGrid;
  const [originX, originY] = origin;
  const tileGroundSize = resolution * tileSize;
  const { tx, ty } = tile;
  const { pixels, width: tileW, height: tileH } = data;

  const tileMinXGround = originX + tx * tileGroundSize;
  const tileMaxYGround = originY - ty * tileGroundSize;
  const tileMaxXGround = tileMinXGround + tileGroundSize;
  const tileMinYGround = tileMaxYGround - tileGroundSize;
  const expandedSpanX = expandedExtent[2] - expandedExtent[0];
  const expandedSpanY = expandedExtent[3] - expandedExtent[1];
  const cellGroundW = expandedSpanX / expandedW;
  const cellGroundH = expandedSpanY / expandedH;

  for (let oy = 0; oy < expandedH; oy++) {
    const gy = expandedExtent[3] - (oy + 0.5) * cellGroundH;
    const cellMinY = gy - cellGroundH / 2, cellMaxY = gy + cellGroundH / 2;
    if (cellMinY > tileMaxYGround || cellMaxY < tileMinYGround) continue;
    const tileFracY = (tileMaxYGround - gy) / tileGroundSize;
    const srcY = Math.min(tileH - 1, Math.max(0, Math.floor(tileFracY * tileH)));

    for (let ox = 0; ox < expandedW; ox++) {
      const gx = expandedExtent[0] + (ox + 0.5) * cellGroundW;
      const cellMinX = gx - cellGroundW / 2, cellMaxX = gx + cellGroundW / 2;
      if (cellMinX > tileMaxXGround || cellMaxX < tileMinXGround) continue;
      const tileFracX = (gx - tileMinXGround) / tileGroundSize;
      const srcX = Math.min(tileW - 1, Math.max(0, Math.floor(tileFracX * tileW)));
      const pixelIndex = (srcY * tileW + srcX) * 4;
      const r = pixels[pixelIndex], g = pixels[pixelIndex + 1], b = pixels[pixelIndex + 2];
      const elev = decodeElevation(r, g, b, encoding, grayscaleRange);
      if (Number.isFinite(elev)) {
        const i = oy * expandedW + ox;
        field[i] = (Number.isFinite(field[i]) ? field[i] : 0) + elev;
        counts[i]++;
      }
    }
  }
}

function traceContours(job: JobState): ContourPath[] {
  const { field, expandedW, expandedH, expandedExtent, levels, simplify } = job;
  // Average boundary cells
  const averagedField = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) {
    averagedField[i] = job.counts[i] > 1 ? field[i] / job.counts[i] : field[i];
  }

  const [fx0, fy0, fx1, fy1] = expandedExtent;
  const cellW = (fx1 - fx0) / Math.max(1, expandedW - 1);
  const cellH = (fy1 - fy0) / Math.max(1, expandedH - 1);
  const paths: ContourPath[] = [];

  for (const { level, index } of levels) {
    const isoPaths = marchingSquaresPaths(averagedField, expandedW, expandedH, level);
    for (const path of isoPaths) {
      let points = simplify > 0 ? simplifyPath(path.points, simplify) : path.points;
      if (!points || points.length < 2) continue;
      points = chaikinSmooth(points, 2);
      const coords: number[][] = new Array(points.length);
      for (let i = 0; i < points.length; i++) {
        coords[i] = [fx0 + points[i].x * cellW, fy1 - points[i].y * cellH];
      }
      if (path.closed && coords.length > 2) coords.push(coords[0].slice());
      paths.push({ level, index, closed: path.closed, coords });
    }
  }
  return paths;
}

// --- Worker message handler --------------------------------------------------

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    if (currentJob?.jobId === msg.jobId) {
      currentJob = null;
    }
    return;
  }

  if (msg.type === 'job') {
    // Initialize job state
    currentJob = initJob(msg);
    const job = currentJob;

    // Process tiles concurrently but render progressively as each arrives
    const tilePromises = job.tiles.map(async (tile) => {
      if (currentJob !== job) return; // cancelled
      
      const data = await fetchTile(tile.url);
      if (currentJob !== job) return; // cancelled during fetch
      
      if (data) {
        addTileToGrid(job, tile, data);
        job.processedTiles++;
        
        // Trace contours and post partial result immediately
        const paths = traceContours(job);
        const range = gridRange(job.field);
        self.postMessage({
          type: 'result',
          jobId: job.jobId,
          paths,
          range,
          progress: { processed: job.processedTiles, total: job.tiles.length },
        });
      }
    });
    
    await Promise.all(tilePromises);
    if (currentJob === job) {
      const paths = traceContours(job);
      const range = gridRange(job.field);
      self.postMessage({
        type: 'result',
        jobId: job.jobId,
        paths,
        range,
        complete: true,
      });
      currentJob = null;
    }
  }
};
