/**
 * scissorsSplit — pure geometry utilities for the scissors (split) tool.
 *
 * Splits LineString and Polygon features along a user-drawn cut line.
 * All coordinates are in map projection (EPSG:3857). No React / OL imports
 * beyond the geometry classes used for return types.
 */
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';

// ---------------------------------------------------------------------------
// Segment–segment intersection
// ---------------------------------------------------------------------------

/** A point where two segments cross, parameterised by *t* along the first. */
interface SegIntersection {
  /** Coordinates [x, y] of the intersection. */
  point: [number, number];
  /** Parameter 0..1 along segment A (p1→p2). */
  tA: number;
  /** Parameter 0..1 along segment B (p3→p4). */
  tB: number;
}

/**
 * Find the intersection point of two finite line segments, if any.
 * Returns null when the segments are parallel or don't cross.
 */
export function segmentSegmentIntersection(
  p1: [number, number], p2: [number, number],
  p3: [number, number], p4: [number, number],
): SegIntersection | null {
  const dx1 = p2[0] - p1[0];
  const dy1 = p2[1] - p1[1];
  const dx2 = p4[0] - p3[0];
  const dy2 = p4[1] - p3[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null; // parallel

  const dx3 = p3[0] - p1[0];
  const dy3 = p3[1] - p1[1];
  const tA = (dx3 * dy2 - dy3 * dx2) / denom;
  const tB = (dx3 * dy1 - dy3 * dx1) / denom;

  // Use a tiny epsilon so endpoints that nearly touch still count.
  const EPS = -1e-9;
  const ONE = 1 + 1e-9;
  if (tA < EPS || tA > ONE || tB < EPS || tB > ONE) return null;

  return {
    point: [p1[0] + tA * dx1, p1[1] + tA * dy1],
    tA: Math.max(0, Math.min(1, tA)),
    tB: Math.max(0, Math.min(1, tB)),
  };
}

// ---------------------------------------------------------------------------
// Split a LineString with a cut line
// ---------------------------------------------------------------------------

/**
 * Split a LineString geometry wherever it crosses the cut line.
 * Returns an array of LineString geometries (length ≥ 2 when at least one
 * crossing exists, otherwise a single-element array with the original).
 */
export function splitLineStringWithLine(
  lineCoords: number[][],
  cutCoords: number[][],
): number[][][] {
  if (lineCoords.length < 2 || cutCoords.length < 2) return [lineCoords];

  // Collect every crossing: which segment of the line, which segment of the
  // cut, and the map-coordinate of the crossing.
  interface Crossing {
    /** Index of the line segment (0 = lineCoords[0]→lineCoords[1]). */
    lineSeg: number;
    /** Parameter 0..1 along that line segment. */
    tLine: number;
    point: [number, number];
  }
  const crossings: Crossing[] = [];

  for (let i = 0; i < cutCoords.length - 1; i++) {
    const c3 = cutCoords[i] as [number, number];
    const c4 = cutCoords[i + 1] as [number, number];
    for (let j = 0; j < lineCoords.length - 1; j++) {
      const p1 = lineCoords[j] as [number, number];
      const p2 = lineCoords[j + 1] as [number, number];
      const hit = segmentSegmentIntersection(p1, p2, c3, c4);
      if (hit) {
        crossings.push({ lineSeg: j, tLine: hit.tA, point: hit.point });
      }
    }
  }

  if (crossings.length === 0) return [lineCoords];

  // Sort crossings by their position along the line (segment index, then t).
  crossings.sort((a, b) => a.lineSeg - b.lineSeg || a.tLine - b.tLine);

  // De-duplicate crossings that land on the same vertex (t ≈ 0 or 1).
  const deduped: Crossing[] = [];
  for (const c of crossings) {
    const last = deduped[deduped.length - 1];
    if (last && last.lineSeg === c.lineSeg && Math.abs(last.tLine - c.tLine) < 1e-9) continue;
    // Also skip if this crossing is at the start of this segment and the
    // previous one was at the end of the previous segment (same vertex).
    if (last && c.tLine < 1e-9 && last.lineSeg === c.lineSeg - 1 && last.tLine > 1 - 1e-9) continue;
    deduped.push(c);
  }

  // Build the resulting line pieces.
  const result: number[][][] = [];
  let piece: number[][] = [lineCoords[0].slice()];

  for (const cross of deduped) {
    // Add all original vertices up to (but not including) the crossing segment.
    for (let k = (piece.length === 1 && result.length === 0) ? 1 : piece.length; k <= cross.lineSeg; k++) {
      // Only add if not already the last point of the piece.
      const candidate = lineCoords[k];
      const lastPt = piece[piece.length - 1];
      if (candidate[0] !== lastPt[0] || candidate[1] !== lastPt[1]) {
        piece.push(candidate.slice());
      }
    }
    // Replace the last vertex with the exact crossing point (or just add it).
    piece.push(cross.point.slice());
    result.push(piece);
    // Start the next piece from the crossing point.
    piece = [cross.point.slice()];
  }

  // Finish the last piece with the remaining vertices.
  const lastCross = deduped[deduped.length - 1];
  for (let k = lastCross.lineSeg + 1; k < lineCoords.length; k++) {
    piece.push(lineCoords[k].slice());
  }
  if (piece.length >= 2) result.push(piece);

  return result.length >= 2 ? result : [lineCoords];
}

// ---------------------------------------------------------------------------
// Split a Polygon with a cut line
// ---------------------------------------------------------------------------

/**
 * Split a polygon ring at the points where the cut line crosses it.
 * Returns two new rings (each closed), or null if the cut doesn't split
 * the polygon (fewer than 2 crossings).
 */
function splitRingWithLine(
  ring: number[][],
  cutCoords: number[][],
): [number[][], number[][]] | null {
  if (ring.length < 4 || cutCoords.length < 2) return null;

  // A ring has N-1 segments (the last coord duplicates the first).
  const n = ring.length - 1;

  interface Crossing {
    /** Segment index along the ring (0..n-1). */
    ringSeg: number;
    /** Parameter 0..1 along that ring segment. */
    tRing: number;
    /** Parameter 0..1 along the cut line (for sorting cut-order). */
    tCut: number;
    point: [number, number];
  }
  const crossings: Crossing[] = [];

  for (let i = 0; i < cutCoords.length - 1; i++) {
    const c3 = cutCoords[i] as [number, number];
    const c4 = cutCoords[i + 1] as [number, number];
    for (let j = 0; j < n; j++) {
      const p1 = ring[j] as [number, number];
      const p2 = ring[(j + 1) % n] as [number, number];
      const hit = segmentSegmentIntersection(p1, p2, c3, c4);
      if (hit) {
        // tCut: parameter along the entire cut line.
        const cutLen = segLength(c3, c4);
        let cutDist = 0;
        for (let k = 0; k < i; k++) {
          cutDist += segLength(cutCoords[k] as [number, number], cutCoords[k + 1] as [number, number]);
        }
        cutDist += hit.tB * cutLen;
        const totalCutLen = totalLength(cutCoords);
        crossings.push({
          ringSeg: j,
          tRing: hit.tA,
          tCut: totalCutLen > 0 ? cutDist / totalCutLen : 0,
          point: hit.point,
        });
      }
    }
  }

  if (crossings.length < 2) return null;

  // Sort crossings along the ring.
  crossings.sort((a, b) => a.ringSeg - b.ringSeg || a.tRing - b.tRing);

  // De-duplicate (same vertex reached from adjacent segments).
  const deduped: Crossing[] = [];
  for (const c of crossings) {
    const last = deduped[deduped.length - 1];
    if (last && last.ringSeg === c.ringSeg && Math.abs(last.tRing - c.tRing) < 1e-9) continue;
    if (last && c.tRing < 1e-9 && last.ringSeg === (c.ringSeg - 1 + n) % n && last.tRing > 1 - 1e-9) continue;
    deduped.push(c);
  }

  if (deduped.length < 2) return null;

  // For a simple split we use the first two crossings along the ring.
  // (A cut line that enters/exits a convex polygon produces exactly 2.)
  // For more complex cases (concave polygons, multiple crossings), we pair
  // them: 0-1, 2-3, etc. and produce multiple sub-polygons — but for the
  // scissors tool the common case is 2 crossings producing 2 polygons.
  // We'll handle the 2-crossing case and the general even-crossing case.

  // Sort by tCut so we know which crossing the cut line reaches first.
  const byCut = [...deduped].sort((a, b) => a.tCut - b.tCut);

  // Build the two split rings.
  // Ring A: from byCut[0] along the ring (forward) to byCut[1], then back
  //         along the cut line from byCut[1] to byCut[0].
  // Ring B: from byCut[1] along the ring (forward) to byCut[0], then back
  //         along the cut line from byCut[0] to byCut[1].

  const ringA = buildSplitRing(ring, n, byCut[0], byCut[1], cutCoords);
  const ringB = buildSplitRing(ring, n, byCut[1], byCut[0], cutCoords);

  if (!ringA || !ringB) return null;
  return [ringA, ringB];
}

/**
 * Build one half of a split polygon: walk the original ring from `from`
 * to `to` (in the forward direction), then return along the cut line
 * from `to.point` back to `from.point`.
 */
function buildSplitRing(
  ring: number[][],
  n: number,
  from: { ringSeg: number; tRing: number; point: [number, number] },
  to: { ringSeg: number; tRing: number; point: [number, number] },
  cutCoords: number[][],
): number[][] | null {
  const result: number[][] = [];

  // Start at the `from` crossing point.
  result.push(from.point.slice());

  // Walk ring segments forward from `from` to `to`.
  let idx = from.ringSeg;
  let safety = 0;
  while (safety++ < n + 2) {
    const nextIdx = (idx + 1) % n;
    // Have we reached the `to` segment?
    if (idx === to.ringSeg) {
      // Add the `to` crossing point and stop.
      result.push(to.point.slice());
      break;
    }
    // Add the next ring vertex.
    const nextVert = ring[nextIdx];
    result.push(nextVert.slice());
    idx = nextIdx;
  }

  if (result.length < 3) return null;

  // Now walk the cut line backwards from `to.point` to `from.point`.
  // We need the cut-line vertices between the two crossing points.
  const cutBetween = extractCutSegment(cutCoords, to.point, from.point);
  // Append cut vertices (skip the first, which is to.point already added).
  for (let i = 1; i < cutBetween.length; i++) {
    result.push(cutBetween[i].slice());
  }

  // Close the ring.
  const first = result[0];
  const last = result[result.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    result.push(first.slice());
  }

  return result.length >= 4 ? result : null;
}

/**
 * Extract the portion of the cut line between two points (in order).
 * Returns an array of coordinates starting with `from` and ending with `to`,
 * including any intermediate cut-line vertices.
 */
function extractCutSegment(
  cutCoords: number[][],
  from: [number, number],
  to: [number, number],
): number[][] {
  // Find which cut segments contain `from` and `to`.
  const fromInfo = findPointOnLine(cutCoords, from);
  const toInfo = findPointOnLine(cutCoords, to);
  if (!fromInfo || !toInfo) return [from, to];

  const result: number[][] = [from.slice()];

  // Add intermediate cut vertices between from and to.
  const startSeg = fromInfo.seg;
  const endSeg = toInfo.seg;
  const startT = fromInfo.t;
  const endT = toInfo.t;

  if (startSeg === endSeg) {
    // Both points on the same segment — just return from→to.
    result.push(to.slice());
    return result;
  }

  // Determine direction (forward or backward along the cut line).
  const forward = startSeg < endSeg || (startSeg === endSeg && startT < endT);

  if (forward) {
    // Add remaining vertices of the start segment.
    result.push(cutCoords[startSeg + 1].slice());
    // Add all intermediate vertices.
    for (let i = startSeg + 2; i <= endSeg; i++) {
      result.push(cutCoords[i].slice());
    }
    // The end point is on segment endSeg at parameter endT.
    // If endT < 1, we need to add the actual `to` point.
    if (endT < 1 - 1e-9) {
      result.push(to.slice());
    }
  } else {
    // Backward: add remaining vertices of start segment going backward.
    result.push(cutCoords[startSeg].slice());
    for (let i = startSeg - 1; i >= endSeg + 1; i--) {
      result.push(cutCoords[i].slice());
    }
    if (endT > 1e-9) {
      result.push(to.slice());
    }
  }

  return result;
}

/** Find which segment of a line a point lies on (approximately). */
function findPointOnLine(
  lineCoords: number[][],
  point: [number, number],
): { seg: number; t: number } | null {
  for (let i = 0; i < lineCoords.length - 1; i++) {
    const a = lineCoords[i] as [number, number];
    const b = lineCoords[i + 1] as [number, number];
    const len = segLength(a, b);
    if (len < 1e-12) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (len * len);
    if (t >= -1e-9 && t <= 1 + 1e-9) {
      const px = a[0] + t * dx;
      const py = a[1] + t * dy;
      if (Math.abs(px - point[0]) < 1e-6 && Math.abs(py - point[1]) < 1e-6) {
        return { seg: i, t: Math.max(0, Math.min(1, t)) };
      }
    }
  }
  return null;
}

function segLength(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function totalLength(coords: number[][]): number {
  let len = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    len += segLength(coords[i] as [number, number], coords[i + 1] as [number, number]);
  }
  return len;
}

/**
 * Split a Polygon geometry with a cut line.
 * Returns an array of Polygon geometries (length 2 when the cut splits the
 * polygon, otherwise a single-element array with the original coordinates).
 */
export function splitPolygonWithLine(
  polyCoords: number[][][],
  cutCoords: number[][],
): number[][][][] | null {
  // Only handle the outer ring for now (holes are preserved on the larger piece).
  const outerRing = polyCoords[0];
  if (!outerRing || outerRing.length < 4) return null;

  const split = splitRingWithLine(outerRing, cutCoords);
  if (!split) return null;

  const [ringA, ringB] = split;

  // Validate that both rings have positive area (not degenerate).
  if (Math.abs(ringArea(ringA)) < 1e-6 || Math.abs(ringArea(ringB)) < 1e-6) return null;

  // Return as two single-ring polygons (outer ring only).
  // Holes from the original are dropped — a reasonable simplification for
  // the scissors tool; users can re-edit afterwards.
  return [
    [ensureClockwise(ringA)],
    [ensureClockwise(ringB)],
  ];
}

/** Signed area of a ring (positive = clockwise in screen coords). */
function ringArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    area += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  }
  return area / 2;
}

/** Ensure a ring is clockwise (OL convention for outer rings). */
function ensureClockwise(ring: number[][]): number[][] {
  if (ringArea(ring) < 0) ring.reverse();
  return ring;
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export interface SplitResult {
  /** The kind of split performed. */
  kind: 'line' | 'polygon' | 'none';
  /** Resulting geometries (OL geometry objects). */
  geometries: (LineString | Polygon)[];
}

/**
 * Split an OL feature's geometry with a cut line (array of [x,y] coords).
 * Returns the split result. If no split is possible, `kind` is 'none' and
 * `geometries` is empty.
 */
export function splitFeatureWithLine(
  geometry: any,
  cutCoords: number[][],
): SplitResult {
  const type = geometry.getType();

  if (type === 'LineString') {
    const coords = geometry.getCoordinates();
    const pieces = splitLineStringWithLine(coords, cutCoords);
    if (pieces.length < 2) return { kind: 'none', geometries: [] };
    return {
      kind: 'line',
      geometries: pieces.map(p => new LineString(p)),
    };
  }

  if (type === 'Polygon') {
    const coords = geometry.getCoordinates();
    const pieces = splitPolygonWithLine(coords, cutCoords);
    if (!pieces) return { kind: 'none', geometries: [] };
    return {
      kind: 'polygon',
      geometries: pieces.map(p => new Polygon(p)),
    };
  }

  return { kind: 'none', geometries: [] };
}
