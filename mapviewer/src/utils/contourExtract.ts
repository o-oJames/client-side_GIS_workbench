// ---------------------------------------------------------------------------
// contourExtract — pure geometry helpers that turn a SAM mask (a scalar logit
// field) into simplified polygon rings, and map those rings from image pixels
// into map coordinates. No React, no OpenLayers — fully unit-testable.
// ---------------------------------------------------------------------------

export interface Pt {
  x: number;
  y: number;
}

/** A mask outline in pixel space: one outer ring plus optional holes. */
export interface MaskPolygon {
  outer: Pt[];
  holes: Pt[][];
}

/**
 * Bilinear resample of a single-channel scalar field (e.g. 256×256 SAM mask
 * logits → 1024×1024 so contours can be traced at encoder resolution).
 */
export function bilinearResize(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  const out = new Float32Array(dstWidth * dstHeight);
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    out.set(src);
    return out;
  }
  const xRatio = (srcWidth - 1) / Math.max(1, dstWidth - 1);
  const yRatio = (srcHeight - 1) / Math.max(1, dstHeight - 1);
  for (let y = 0; y < dstHeight; y++) {
    const sy = y * yRatio;
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, srcHeight - 1);
    const fy = sy - y0;
    for (let x = 0; x < dstWidth; x++) {
      const sx = x * xRatio;
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, srcWidth - 1);
      const fx = sx - x0;
      const v00 = src[y0 * srcWidth + x0];
      const v10 = src[y0 * srcWidth + x1];
      const v01 = src[y1 * srcWidth + x0];
      const v11 = src[y1 * srcWidth + x1];
      out[y * dstWidth + x] =
        v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }
  return out;
}

/** Linear interpolation of the iso-crossing between two field corners. */
function edgeCrossing(v1: number, v2: number, x1: number, y1: number, x2: number, y2: number, iso: number): Pt {
  const d = v2 - v1;
  const t = Math.abs(d) < 1e-9 ? 0.5 : (iso - v1) / d;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: x1 + clamped * (x2 - x1), y: y1 + clamped * (y2 - y1) };
}

/**
 * Marching-squares contour tracing over a scalar field. Returns closed rings
 * of sub-pixel-accurate points (coordinates in the field's pixel space) for
 * the boundary where the field crosses `iso`.
 *
 * Segments emitted per cell are stitched into rings through a map keyed by
 * exact endpoint coordinates — neighbouring cells compute identical crossing
 * floats, so exact equality is safe.
 */
export function marchingSquaresRings(field: Float32Array, width: number, height: number, iso = 0): Pt[][] {
  const v = (x: number, y: number) => field[y * width + x];
  const segments: Array<[Pt, Pt]> = [];

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = v(x, y);
      const tr = v(x + 1, y);
      const br = v(x + 1, y + 1);
      const bl = v(x, y + 1);
      let caseIndex = 0;
      if (tl > iso) caseIndex |= 8;
      if (tr > iso) caseIndex |= 4;
      if (br > iso) caseIndex |= 2;
      if (bl > iso) caseIndex |= 1;
      if (caseIndex === 0 || caseIndex === 15) continue;

      // Lazily computed edge crossings for this cell.
      let top: Pt | null = null;
      let right: Pt | null = null;
      let bottom: Pt | null = null;
      let left: Pt | null = null;
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
        case 5: // saddle — resolve with the centre average
        case 10: {
          const centre = (tl + tr + br + bl) / 4;
          if (caseIndex === 5) {
            if (centre > iso) {
              segments.push([getLeft(), getTop()]);
              segments.push([getBottom(), getRight()]);
            } else {
              segments.push([getLeft(), getBottom()]);
              segments.push([getTop(), getRight()]);
            }
          } else {
            if (centre > iso) {
              segments.push([getTop(), getRight()]);
              segments.push([getLeft(), getBottom()]);
            } else {
              segments.push([getLeft(), getTop()]);
              segments.push([getBottom(), getRight()]);
            }
          }
          break;
        }
        default: break;
      }
    }
  }

  // ----- Stitch segments into closed rings -------------------------------
  const keyOf = (p: Pt) => `${p.x}|${p.y}`;
  const adjacency = new Map<string, Array<{ seg: number; end: 0 | 1 }>>();
  segments.forEach((seg, i) => {
    const k0 = keyOf(seg[0]);
    const k1 = keyOf(seg[1]);
    if (!adjacency.has(k0)) adjacency.set(k0, []);
    if (!adjacency.has(k1)) adjacency.set(k1, []);
    adjacency.get(k0)!.push({ seg: i, end: 0 });
    adjacency.get(k1)!.push({ seg: i, end: 1 });
  });

  const used = new Uint8Array(segments.length);
  const rings: Pt[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const ring: Pt[] = [segments[i][0], segments[i][1]];
    // Extend the tail until it closes onto the head or dead-ends (the mask
    // touches the image border — discarded later as an open chain).
    let guard = 0;
    while (guard++ <= segments.length) {
      const tail = ring[ring.length - 1];
      const candidates = adjacency.get(keyOf(tail));
      const next = candidates ? candidates.find((c) => !used[c.seg]) : undefined;
      if (!next) break;
      used[next.seg] = 1;
      const seg = segments[next.seg];
      const nextPt = next.end === 0 ? seg[1] : seg[0];
      ring.push(nextPt);
      if (nextPt.x === ring[0].x && nextPt.y === ring[0].y) break;
    }
    // Keep only closed rings with a meaningful vertex count.
    const closed = ring.length > 3 && ring[ring.length - 1].x === ring[0].x && ring[ring.length - 1].y === ring[0].y;
    if (closed) {
      ring.pop(); // drop the duplicated closing point
      rings.push(ring);
    }
  }
  return rings;
}

/** Signed shoelace area — positive for counter-clockwise rings. */
export function ringSignedArea(ring: Pt[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Ray-casting point-in-ring test. */
export function pointInRing(pt: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersects = (yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Perpendicular distance of a point to the segment a-b. */
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
function douglasPeuckerOpen(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
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

/** Simplify a closed ring (Douglas–Peucker over the re-opened path). */
export function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  if (ring.length <= 4 || tolerance <= 0) return ring.slice();
  const opened = ring.concat([ring[0]]);
  const kept = douglasPeuckerOpen(opened, tolerance);
  kept.pop(); // remove the duplicated closing point again
  if (kept.length < 3) {
    // Degenerate — fall back to a coarse triangle of the original ring.
    const n = ring.length;
    return [ring[0], ring[Math.floor(n / 3)], ring[Math.floor((2 * n) / 3)]];
  }
  return kept;
}

/** Minimum ring area (px²) below which contours are treated as noise. */
const MIN_RING_AREA = 16;
/** Starting Douglas–Peucker tolerance in pixel units. */
const BASE_TOLERANCE = 1.5;

export interface ExtractMaskPolygonOptions {
  logits: Float32Array;
  width: number;
  height: number;
  /** Iso-value separating object from background (SAM decoder: 0). */
  threshold?: number;
  /** Point the traced object should contain (usually the user's click). */
  seed?: Pt;
  /** Vertex budget per ring — the tolerance grows until it fits. */
  maxPoints?: number;
}

/**
 * Turn SAM decoder logits into one polygon: the outline ring containing the
 * seed point (or the largest one when no seed is given) plus any holes
 * directly inside it, both simplified to a vertex budget.
 */
export function extractMaskPolygon(options: ExtractMaskPolygonOptions): MaskPolygon | null {
  const { logits, width, height, threshold = 0, seed, maxPoints = 400 } = options;
  const rings = marchingSquaresRings(logits, width, height, threshold);
  if (rings.length === 0) return null;

  const annotated = rings
    .map((ring) => ({ ring, area: Math.abs(ringSignedArea(ring)) }))
    .filter((a) => a.area >= MIN_RING_AREA)
    .sort((a, b) => b.area - a.area);
  if (annotated.length === 0) return null;

  // The object under the pointer wins; otherwise take the biggest blob.
  const outer = (seed && annotated.find((a) => pointInRing(seed, a.ring))) || annotated[0];

  // Holes: rings inside the outer ring that are not themselves inside
  // another hole candidate (that would make them islands of the object).
  const holeCandidates = annotated.filter((a) => a !== outer && pointInRing(a.ring[0], outer.ring));
  const holes = holeCandidates.filter(
    (a) => !holeCandidates.some((b) => b !== a && pointInRing(a.ring[0], b.ring)),
  );

  const simplifyToBudget = (ring: Pt[]): Pt[] => {
    let tolerance = BASE_TOLERANCE;
    let simplified = simplifyRing(ring, tolerance);
    while (simplified.length > maxPoints && tolerance < 128) {
      tolerance *= 1.7;
      simplified = simplifyRing(ring, tolerance);
    }
    return simplified;
  };

  return {
    outer: simplifyToBudget(outer.ring),
    holes: holes.map((h) => simplifyToBudget(h.ring)),
  };
}

/**
 * Map a pixel-space ring into map coordinates (EPSG:3857) using the extent
 * captured when the SAM snapshot was taken: pixel (0,0) is the extent's
 * top-left corner.
 */
export function pixelRingToMapCoords(
  ring: Pt[],
  width: number,
  height: number,
  extent: [number, number, number, number],
): number[][] {
  const [minX, minY, maxX, maxY] = extent;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  return ring.map((p) => [minX + (p.x / width) * spanX, maxY - (p.y / height) * spanY]);
}

/**
 * Nearest point on a set of (closed) rings to a given point, measured in the
 * same units as the ring coordinates (callers pass screen pixels). Returns
 * null when nothing lies within `tolerance`.
 */
export function nearestPointOnRings(
  pt: Pt,
  rings: Pt[][],
  tolerance: number,
): { point: Pt; dist: number; ringIndex: number } | null {
  let best: { point: Pt; dist: number; ringIndex: number } | null = null;
  rings.forEach((ring, ringIndex) => {
    const n = ring.length;
    if (n === 0) return;
    if (n === 1) {
      const dx = ring[0].x - pt.x;
      const dy = ring[0].y - pt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= tolerance && (!best || dist < best.dist)) {
        best = { point: { x: ring[0].x, y: ring[0].y }, dist, ringIndex };
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
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
        best = { point: { x: qx, y: qy }, dist, ringIndex };
      }
    }
  });
  return best;
}
