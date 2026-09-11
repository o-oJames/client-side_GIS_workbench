// ---------------------------------------------------------------------------
// livewire — classical, model-free edge extraction for the magnetic drawing
// mode ("intelligent scissors" / magnetic-lasso front end).
//
// Pipeline (the standard Canny-style front end used by livewire tools):
//   RGBA snapshot → box-downsampled greyscale → 3×3 Gaussian blur
//   → Sobel gradient (magnitude + direction) → non-maximum suppression
//   (thin edges to 1-px ridges) → hysteresis thresholding with ordered
//   8-connected chain tracing → simplified polylines.
//
// No React, no OpenLayers — fully unit-testable. Coordinates in the returned
// chains are expressed in *snapshot pixel* space (pixel (0,0) top-left).
// ---------------------------------------------------------------------------

import { Pt } from './contourExtract';

/** Structural ImageData so tests can pass plain objects. */
export interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ExtractEdgeOptions {
  /** Long-edge size of the working grid the detection runs on. */
  maxDim?: number;
  /**
   * Fraction of the strongest edge pixels treated as "strong" seeds. The
   * strong threshold is placed so roughly this share of the non-zero NMS
   * magnitudes remains above it — percentile-based so a few extreme
   * outliers (labels, glint) cannot starve real edges like rooftops.
   */
  strongRatio?: number;
  /** Weak threshold as a factor of the strong threshold. */
  lowFactor?: number;
  /** Absolute noise floor for the strong threshold (Sobel magnitude units). */
  minAbsHigh?: number;
  /** Chains shorter than this (working-grid pixels) are discarded. */
  minChainLength?: number;
  /** Vertex budget — longest chains win. */
  maxChains?: number;
  /** Douglas–Peucker tolerance in working-grid pixels. */
  simplifyTolerance?: number;
}

export interface EdgeChains {
  /** Ordered edge polylines in snapshot pixel coordinates. */
  chains: Pt[][];
  /** Snapshot width the chains are expressed in. */
  width: number;
  /** Snapshot height the chains are expressed in. */
  height: number;
}

const DEFAULT_OPTIONS = {
  maxDim: 1024,
  strongRatio: 0.04,
  lowFactor: 0.45,
  minAbsHigh: 14,
  minChainLength: 8,
  maxChains: 1500,
  simplifyTolerance: 0.75,
};

/**
 * Downsample RGBA pixels to a greyscale working grid (box average) so the
 * detection runs on a bounded number of pixels regardless of viewport size.
 * Returns the luminance field plus the working dimensions and the scale
 * factors back to snapshot pixels.
 */
export function rgbaToLumaDownsampled(
  image: ImageLike,
  maxDim = DEFAULT_OPTIONS.maxDim,
): { luma: Float32Array; width: number; height: number; scaleX: number; scaleY: number } {
  const { data, width, height } = image;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const workW = Math.max(2, Math.round(width * scale));
  const workH = Math.max(2, Math.round(height * scale));
  const scaleX = width / workW;
  const scaleY = height / workH;
  const luma = new Float32Array(workW * workH);

  for (let wy = 0; wy < workH; wy++) {
    const srcY0 = Math.floor(wy * scaleY);
    const srcY1 = Math.min(height, Math.max(srcY0 + 1, Math.ceil((wy + 1) * scaleY)));
    for (let wx = 0; wx < workW; wx++) {
      const srcX0 = Math.floor(wx * scaleX);
      const srcX1 = Math.min(width, Math.max(srcX0 + 1, Math.ceil((wx + 1) * scaleX)));
      let sum = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        let idx = (sy * width + srcX0) * 4;
        for (let sx = srcX0; sx < srcX1; sx++, idx += 4) {
          sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          count++;
        }
      }
      luma[wy * workW + wx] = count > 0 ? sum / count : 0;
    }
  }
  return { luma, width: workW, height: workH, scaleX, scaleY };
}

/**
 * Downsample RGBA pixels to per-channel working grids (box average). The
 * colour channels are kept separate so the detector can see chroma-only
 * edges (e.g. a red roof against green grass at equal luminance), which a
 * greyscale pipeline misses.
 */
export function rgbaToRgbDownsampled(
  image: ImageLike,
  maxDim = DEFAULT_OPTIONS.maxDim,
): {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
} {
  const { data, width, height } = image;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const workW = Math.max(2, Math.round(width * scale));
  const workH = Math.max(2, Math.round(height * scale));
  const scaleX = width / workW;
  const scaleY = height / workH;
  const r = new Float32Array(workW * workH);
  const g = new Float32Array(workW * workH);
  const b = new Float32Array(workW * workH);

  for (let wy = 0; wy < workH; wy++) {
    const srcY0 = Math.floor(wy * scaleY);
    const srcY1 = Math.min(height, Math.max(srcY0 + 1, Math.ceil((wy + 1) * scaleY)));
    for (let wx = 0; wx < workW; wx++) {
      const srcX0 = Math.floor(wx * scaleX);
      const srcX1 = Math.min(width, Math.max(srcX0 + 1, Math.ceil((wx + 1) * scaleX)));
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        let idx = (sy * width + srcX0) * 4;
        for (let sx = srcX0; sx < srcX1; sx++, idx += 4) {
          sr += data[idx];
          sg += data[idx + 1];
          sb += data[idx + 2];
          count++;
        }
      }
      const o = wy * workW + wx;
      if (count > 0) {
        r[o] = sr / count;
        g[o] = sg / count;
        b[o] = sb / count;
      }
    }
  }
  return { r, g, b, width: workW, height: workH, scaleX, scaleY };
}

/** Separable 3×3 Gaussian blur ([1,2,1]/4 in each pass) — Canny pre-smoothing. */
export function gaussianBlur3(field: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(field.length);
  const out = new Float32Array(field.length);
  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const l = field[row + Math.max(0, x - 1)];
      const c = field[row + x];
      const r = field[row + Math.min(width - 1, x + 1)];
      tmp[row + x] = (l + 2 * c + r) * 0.25;
    }
  }
  // Vertical pass.
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const mid = y * width;
    const down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      out[mid + x] = (tmp[up + x] + 2 * tmp[mid + x] + tmp[down + x]) * 0.25;
    }
  }
  return out;
}

/** Sobel gradient. Returns the component fields and the magnitude. */
export function sobelGradient(
  field: Float32Array,
  width: number,
  height: number,
): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const gx = new Float32Array(field.length);
  const gy = new Float32Array(field.length);
  const mag = new Float32Array(field.length);
  for (let y = 1; y < height - 1; y++) {
    const up = (y - 1) * width;
    const mid = y * width;
    const down = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const tl = field[up + x - 1];
      const tc = field[up + x];
      const tr = field[up + x + 1];
      const ml = field[mid + x - 1];
      const mr = field[mid + x + 1];
      const bl = field[down + x - 1];
      const bc = field[down + x];
      const br = field[down + x + 1];
      const sx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const sy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      gx[mid + x] = sx;
      gy[mid + x] = sy;
      mag[mid + x] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

/**
 * Colour Sobel gradient: runs Sobel on each RGB channel and combines them.
 * The magnitude is the Frobenius norm of the 3-channel Jacobian, so edges
 * defined by colour alone (no luminance change) are detected too. The
 * reported direction comes from the channel with the strongest gradient,
 * which is what non-maximum suppression needs to thin the ridge.
 */
export function colorSobelGradient(
  r: Float32Array,
  g: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const gx = new Float32Array(r.length);
  const gy = new Float32Array(r.length);
  const mag = new Float32Array(r.length);
  const channels = [r, g, b];
  for (let y = 1; y < height - 1; y++) {
    const up = (y - 1) * width;
    const mid = y * width;
    const down = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const i = mid + x;
      let sumSq = 0;
      let bestSq = -1;
      let bestGx = 0;
      let bestGy = 0;
      for (let c = 0; c < 3; c++) {
        const field = channels[c];
        const tl = field[up + x - 1];
        const tc = field[up + x];
        const tr = field[up + x + 1];
        const ml = field[mid + x - 1];
        const mr = field[mid + x + 1];
        const bl = field[down + x - 1];
        const bc = field[down + x];
        const br = field[down + x + 1];
        const sx = tr + 2 * mr + br - (tl + 2 * ml + bl);
        const sy = bl + 2 * bc + br - (tl + 2 * tc + tr);
        const sq = sx * sx + sy * sy;
        sumSq += sq;
        if (sq > bestSq) {
          bestSq = sq;
          bestGx = sx;
          bestGy = sy;
        }
      }
      gx[i] = bestGx;
      gy[i] = bestGy;
      mag[i] = Math.sqrt(sumSq);
    }
  }
  return { gx, gy, mag };
}

const TAN_22_5 = Math.tan(Math.PI / 8);

/**
 * Non-maximum suppression: keep a pixel's gradient magnitude only when it is
 * the local maximum along its gradient direction (quantised to 4 sectors),
 * producing 1-pixel-wide edge ridges. Border pixels are suppressed.
 */
export function nonMaxSuppress(
  mag: Float32Array,
  gx: Float32Array,
  gy: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(mag.length);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const m = mag[i];
      if (m === 0) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let n1: number;
      let n2: number;
      if (ax >= ay) {
        // Gradient leans horizontal.
        if (ay <= ax * TAN_22_5) {
          n1 = mag[i - 1];
          n2 = mag[i + 1];
        } else if (gx[i] * gy[i] >= 0) {
          n1 = mag[i + width + 1];
          n2 = mag[i - width - 1];
        } else {
          n1 = mag[i + width - 1];
          n2 = mag[i - width + 1];
        }
      } else {
        // Gradient leans vertical.
        if (ax <= ay * TAN_22_5) {
          n1 = mag[i - width];
          n2 = mag[i + width];
        } else if (gx[i] * gy[i] >= 0) {
          n1 = mag[i + width + 1];
          n2 = mag[i - width - 1];
        } else {
          n1 = mag[i + width - 1];
          n2 = mag[i - width + 1];
        }
      }
      if (m >= n1 && m >= n2) out[i] = m;
    }
  }
  return out;
}

/**
 * Hysteresis edge linking: walk 8-connected chains of edge pixels starting
 * from every strong pixel (≥ high), extending through weak pixels (≥ low).
 * At forks the strongest unused neighbour wins; leftover branches seed their
 * own chains later. Returns ordered chains of working-grid pixel indices
 * converted to points.
 */
export function traceEdgeChains(
  nms: Float32Array,
  width: number,
  height: number,
  high: number,
  low: number,
  minLength: number,
): Pt[][] {
  const size = width * height;
  // 0 = none, 1 = weak, 2 = strong.
  const label = new Uint8Array(size);
  let maxMag = 0;
  for (let i = 0; i < size; i++) {
    const v = nms[i];
    if (v > maxMag) maxMag = v;
  }
  if (maxMag < high) return [];
  for (let i = 0; i < size; i++) {
    if (nms[i] >= high) label[i] = 2;
    else if (nms[i] >= low) label[i] = 1;
  }

  const used = new Uint8Array(size);
  const chains: Pt[][] = [];

  // 8-neighbour offsets (x, y).
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

  /** Walk from `start` greedily along the strongest unused edge pixels. */
  const walk = (start: number): number[] => {
    const path: number[] = [];
    let cur = start;
    for (;;) {
      const cx = cur % width;
      const cy = (cur / width) | 0;
      let best = -1;
      let bestVal = -1;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (label[ni] === 0 || used[ni]) continue;
        if (nms[ni] > bestVal) {
          bestVal = nms[ni];
          best = ni;
        }
      }
      if (best === -1) break;
      used[best] = 1;
      path.push(best);
      cur = best;
    }
    return path;
  };

  for (let seedY = 1; seedY < height - 1; seedY++) {
    for (let seedX = 1; seedX < width - 1; seedX++) {
      const seed = seedY * width + seedX;
      if (label[seed] !== 2 || used[seed]) continue;
      used[seed] = 1;
      const forward = walk(seed);
      const backward = walk(seed);
      const full: number[] = [];
      for (let i = backward.length - 1; i >= 0; i--) full.push(backward[i]);
      full.push(seed);
      for (let i = 0; i < forward.length; i++) full.push(forward[i]);
      if (full.length < minLength) continue;
      chains.push(full.map((idx) => ({ x: idx % width, y: (idx / width) | 0 })));
    }
  }
  return chains;
}

/** Perpendicular distance of a point to the segment a–b. */
function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const px = a.x + t * dx - p.x;
  const py = a.y + t * dy - p.y;
  return Math.sqrt(px * px + py * py);
}

/** Douglas–Peucker simplification of an open polyline (iterative). */
export function simplifyPolyline(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pointSegmentDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance && maxIndex !== -1) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Choose hysteresis thresholds from the NMS magnitude distribution: the
 * strong threshold sits at the top `strongRatio` quantile of the non-zero
 * magnitudes (percentile-based, so isolated extreme pixels cannot starve
 * real edges), floored by `minAbsHigh`; the weak threshold is a fixed
 * factor below it.
 */
export function computeThresholds(
  nms: Float32Array,
  opts: { strongRatio: number; lowFactor: number; minAbsHigh: number },
): { high: number; low: number } {
  let maxMag = 0;
  let nonZero = 0;
  for (let i = 0; i < nms.length; i++) {
    const v = nms[i];
    if (v > 0) nonZero++;
    if (v > maxMag) maxMag = v;
  }
  if (nonZero === 0 || maxMag === 0) return { high: opts.minAbsHigh, low: 2 };

  const BINS = 512;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < nms.length; i++) {
    const v = nms[i];
    if (v <= 0) continue;
    const bin = Math.min(BINS - 1, ((v / maxMag) * BINS) | 0);
    hist[bin]++;
  }
  // Walk down from the strongest bin until `strongRatio` of the non-zero
  // pixels are at or above the candidate threshold.
  const target = Math.max(1, Math.ceil(opts.strongRatio * nonZero));
  let count = 0;
  let high = maxMag;
  for (let bin = BINS - 1; bin >= 0; bin--) {
    count += hist[bin];
    if (count >= target) {
      high = ((bin + 1) / BINS) * maxMag;
      break;
    }
  }
  high = Math.max(opts.minAbsHigh, high);
  const low = Math.max(2, high * opts.lowFactor);
  return { high, low: Math.min(low, high - 1) };
}

/**
 * Nearest point on a set of open polylines to a given point, measured in
 * whatever units the polylines use (callers pass screen pixels). Returns
 * null when nothing lies within `tolerance`.
 */
export function nearestPointOnPolylines(
  pt: Pt,
  polylines: Pt[][],
  tolerance: number,
): { point: Pt; dist: number; lineIndex: number } | null {
  let best: { point: Pt; dist: number; lineIndex: number } | null = null;
  polylines.forEach((line, lineIndex) => {
    const n = line.length;
    if (n === 0) return;
    if (n === 1) {
      const dx = line[0].x - pt.x;
      const dy = line[0].y - pt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= tolerance && (!best || dist < best.dist)) {
        best = { point: { x: line[0].x, y: line[0].y }, dist, lineIndex };
      }
      return;
    }
    for (let i = 0; i < n - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) {
        t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
      }
      const qx = a.x + t * dx;
      const qy = a.y + t * dy;
      const ex = qx - pt.x;
      const ey = qy - pt.y;
      const dist = Math.sqrt(ex * ex + ey * ey);
      if (dist <= tolerance && (!best || dist < best.dist)) {
        best = { point: { x: qx, y: qy }, dist, lineIndex };
      }
    }
  });
  return best;
}

/**
 * Run the full pipeline over a map snapshot and return the detected edge
 * polylines in snapshot pixel coordinates (longest first, capped).
 */
export function extractEdgePolylines(image: ImageLike, options?: ExtractEdgeOptions): EdgeChains {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { r, g, b, width, height, scaleX, scaleY } = rgbaToRgbDownsampled(image, opts.maxDim);
  const blurredR = gaussianBlur3(r, width, height);
  const blurredG = gaussianBlur3(g, width, height);
  const blurredB = gaussianBlur3(b, width, height);
  const { gx, gy, mag } = colorSobelGradient(blurredR, blurredG, blurredB, width, height);
  const nms = nonMaxSuppress(mag, gx, gy, width, height);

  const { high, low } = computeThresholds(nms, opts);

  const chains = traceEdgeChains(nms, width, height, high, low, opts.minChainLength);
  const simplified = chains
    .map((chain) => simplifyPolyline(chain, opts.simplifyTolerance))
    .filter((chain) => chain.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, opts.maxChains)
    // Working-grid pixels → snapshot pixels.
    .map((chain) => chain.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })));

  return { chains: simplified, width: image.width, height: image.height };
}
