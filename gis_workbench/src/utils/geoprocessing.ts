/**
 * geoprocessing.ts — Pure vector geoprocessing engines.
 *
 * All functions work on plain GeoJSON-like structures and never import React.
 * Coordinates are in EPSG:3857 (metres) unless noted.
 *
 * Supported tools:
 *   buffer, clip, intersect, union, dissolve, centroid, convexHull, distance,
 *   eliminate, checkValidity, makeValid, collectGeometries, delaunay, densify,
 *   addGeometryAttributes, extractVertices, multipartToSingleparts,
 *   polygonsToLines, simplify, voronoi, linesToPolygons, mergeVectorLayers,
 *   splitVectorLayer, removeSelectedFeatures
 *
 * Cross-cutting infrastructure (all engines are expected to use it):
 *   - `scaleTolerance` — coordinate tolerance derived from the dataset extent,
 *     because fixed 1e-9/1e-12 epsilons sit below the float noise floor at
 *     EPSG:3857 magnitudes (~1.5e7, where the ULP is ~2e-9).
 *   - `PolygonPart` / `getPolygonParts` — shells with their holes attached. The
 *     old flat `getPolygonRings` list turned every hole into a positive-area
 *     polygon; boundary-only work uses `getAllPolygonRings`, shell-only work
 *     uses `getExteriorRings`.
 *   - `ExtentIndex` (utils/geomIndex.ts, backed by ol/structs/RBush) — spatial
 *     pruning for the pairwise engines.
 *   - `ProgressToken` / `progressLoop` — shared progress + cancellation for any
 *     tool that can take long enough to freeze the UI.
 *   - `utils/geodesic.ts` — true ground area/length/distance (holes subtracted),
 *     matching what the measure tool reports.
 */
import {
  groundDistance,
  groundLineLength,
  groundPolygonArea,
  groundPolygonPerimeter,
} from './geodesic';
import {
  ExtentIndex,
  emptyExtent,
  extentOfCoords,
  extentSpan,
  unionExtent,
  type Extent4,
} from './geomIndex';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Coord = [number, number];
export type Ring = Coord[];
export type GeoGeom =
  | { type: 'Point'; coordinates: Coord }
  | { type: 'MultiPoint'; coordinates: Coord[] }
  | { type: 'LineString'; coordinates: Coord[] }
  | { type: 'MultiLineString'; coordinates: Coord[][] }
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] };

export interface GeoFeature {
  type: 'Feature';
  geometry: GeoGeom | null;
  properties: Record<string, any>;
}

export interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export type DistanceUnit = 'meters' | 'kilometers' | 'miles' | 'feet' | 'degrees';

const UNIT_TO_METERS: Record<DistanceUnit, number> = {
  meters: 1,
  kilometers: 1000,
  miles: 1609.344,
  feet: 0.3048,
  degrees: 111319.49079327357, // approximate at equator in EPSG:3857
};

export function toMeters(value: number, unit: DistanceUnit): number {
  return value * UNIT_TO_METERS[unit];
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function dist2(a: Coord, b: Coord): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function dist(a: Coord, b: Coord): number {
  return Math.sqrt(dist2(a, b));
}

/** Signed area of a ring (positive = CCW). */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n;
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/** Ensure ring is CCW (positive area). */
function ensureCCW(ring: Ring): Ring {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

/** Ensure ring is CW (negative area). */
function ensureCW(ring: Ring): Ring {
  return signedArea(ring) > 0 ? ring.slice().reverse() : ring;
}

// ---------------------------------------------------------------------------
// Coordinate tolerance
// ---------------------------------------------------------------------------

/**
 * EPSG:3857 ordinates are of order 1e7, where the double-precision spacing is
 * ~2e-9. Fixed epsilons of 1e-9/1e-12 therefore compare noise, and a 1e-6
 * vertex-coincidence test rejects topologically clean data written at lower
 * precision. Every coordinate comparison derives its tolerance from the extent
 * of the data actually being processed.
 */

/** Absolute floor for a coordinate tolerance, in map units. */
export const MIN_COORD_TOLERANCE = 1e-6;

/** Tolerance as a fraction of the dataset span (1 mm per kilometre). */
const TOLERANCE_SPAN_FACTOR = 1e-9;

/** Coordinate tolerance for a dataset span: 1e-9 × span, floored at 1 µm. */
export function scaleTolerance(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return MIN_COORD_TOLERANCE;
  return Math.max(MIN_COORD_TOLERANCE, span * TOLERANCE_SPAN_FACTOR);
}

/** Are two coordinates equal to within `tolerance`? */
export function coordsClose(a: Coord, b: Coord, tolerance: number): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

/** Is the ring closed to within `tolerance` (rather than bit-exactly)? */
export function isRingClosed(ring: Ring, tolerance: number = MIN_COORD_TOLERANCE): boolean {
  if (ring.length < 2) return false;
  return coordsClose(ring[0], ring[ring.length - 1], tolerance);
}

/** A copy of `ring` guaranteed to end with its first coordinate. */
export function closeRing(ring: Ring): Ring {
  if (ring.length === 0) return [];
  const out = ring.slice();
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

// ---------------------------------------------------------------------------
// Polygon parts (shell + holes)
// ---------------------------------------------------------------------------

/**
 * A polygon expressed as its outer shell plus its inner rings.
 *
 * Anything that cares about the difference between "shell" and "hole" —
 * clipping, buffering, area, centroids — must go through this. The previous
 * flat ring list silently promoted holes to positive-area polygons: they were
 * buffered away, added to the area, and clipped as if solid.
 */
export interface PolygonPart {
  shell: Ring;
  holes: Ring[];
}

/** Outer shell + holes of every polygon/multipolygon part of a geometry. */
export function getPolygonParts(geom: GeoGeom | null): PolygonPart[] {
  if (!geom) return [];
  if (geom.type === 'Polygon') {
    const [shell, ...holes] = geom.coordinates;
    return shell ? [{ shell, holes }] : [];
  }
  if (geom.type === 'MultiPolygon') {
    const parts: PolygonPart[] = [];
    for (const poly of geom.coordinates) {
      const [shell, ...holes] = poly;
      if (shell) parts.push({ shell, holes });
    }
    return parts;
  }
  return [];
}

/**
 * Outer shells only — for tools where holes cannot change the answer
 * (convex hull, Delaunay, Voronoi: holes are interior by definition).
 */
export function getExteriorRings(geom: GeoGeom | null): Ring[] {
  return getPolygonParts(geom).map(part => part.shell);
}

/**
 * Every ring of every polygon part, shells and holes alike, in
 * [shell, ...holes] order. For boundary work only (perimeter, polygons-to-lines,
 * validity) — never for area or clipping.
 */
export function getAllPolygonRings(geom: GeoGeom | null): Ring[] {
  const rings: Ring[] = [];
  for (const part of getPolygonParts(geom)) {
    rings.push(part.shell, ...part.holes);
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Extents & spatial index
// ---------------------------------------------------------------------------

/** Bounding box of a geometry (holes included — they are still geometry). */
export function geometryExtent(geom: GeoGeom | null): Extent4 {
  if (!geom) return emptyExtent();
  switch (geom.type) {
    case 'Point':
      return extentOfCoords([geom.coordinates]);
    case 'MultiPoint':
    case 'LineString':
      return extentOfCoords(geom.coordinates);
    case 'MultiLineString': {
      let ext = emptyExtent();
      for (const line of geom.coordinates) ext = unionExtent(ext, extentOfCoords(line));
      return ext;
    }
    case 'Polygon': {
      let ext = emptyExtent();
      for (const ring of geom.coordinates) ext = unionExtent(ext, extentOfCoords(ring));
      return ext;
    }
    case 'MultiPolygon': {
      let ext = emptyExtent();
      for (const poly of geom.coordinates) {
        for (const ring of poly) ext = unionExtent(ext, extentOfCoords(ring));
      }
      return ext;
    }
  }
}

export function featureExtent(feature: GeoFeature): Extent4 {
  return geometryExtent(feature.geometry);
}

/** Combined extent of a feature list; empty extent when there is nothing. */
export function featuresExtent(features: GeoFeature[]): Extent4 {
  let ext = emptyExtent();
  for (const f of features) ext = unionExtent(ext, featureExtent(f));
  return ext;
}

/** Coordinate tolerance appropriate for a feature list's extent. */
export function toleranceForFeatures(...featureSets: GeoFeature[][]): number {
  let ext = emptyExtent();
  for (const set of featureSets) ext = unionExtent(ext, featuresExtent(set));
  return scaleTolerance(extentSpan(ext));
}

/** R-tree over the features' extents, holding their array indices. */
export function buildFeatureIndex(features: GeoFeature[]): ExtentIndex<number> {
  const index = new ExtentIndex<number>();
  const extents: Extent4[] = [];
  const values: number[] = [];
  for (let i = 0; i < features.length; i++) {
    extents.push(featureExtent(features[i]));
    values.push(i);
  }
  index.load(extents, values);
  return index;
}

// ---------------------------------------------------------------------------
// Progress & cancellation
// ---------------------------------------------------------------------------

/**
 * Shared progress/cancellation token. A caller mutates `cancelled` to abort;
 * long-running engines report through it and yield to the event loop so the UI
 * can repaint (and so the Cancel button can actually be clicked).
 */
export interface ProgressToken {
  /** Current step description. */
  message: string;
  /** Progress from 0 to 1 — always clamped. */
  progress: number;
  /** Set to true to cancel the operation. */
  cancelled: boolean;
}

/** Historical name kept for existing callers/tests. */
export type DissolveProgress = ProgressToken;

export type ProgressReporter = (p: ProgressToken) => void;

/** How long a chunk may run before yielding to the event loop. */
export const PROGRESS_CHUNK_MS = 12;

export function createProgress(message = ''): ProgressToken {
  return { message, progress: 0, cancelled: false };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Yield to the event loop to keep the UI responsive.
 * Call this periodically during long-running operations.
 */
export function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Run `body` for indices 0..count-1 in time-sliced chunks, reporting progress
 * and honouring cancellation. Returns false when the run was cancelled.
 *
 * This is what lets the quadratic engines (clip, intersect, voronoi, delaunay,
 * eliminate) stay interactive instead of freezing the tab.
 */
export async function progressLoop(
  count: number,
  progress: ProgressToken,
  body: (index: number) => void,
  onProgress?: ProgressReporter,
  label = 'Processing'
): Promise<boolean> {
  if (count <= 0) return !progress.cancelled;
  const report = (done: number) => {
    progress.message = `${label}… ${done}/${count}`;
    progress.progress = clamp01(done / count);
    if (onProgress) onProgress(progress);
  };
  let chunkStart = Date.now();
  for (let i = 0; i < count; i++) {
    if (progress.cancelled) return false;
    body(i);
    if (Date.now() - chunkStart >= PROGRESS_CHUNK_MS) {
      report(i + 1);
      await yieldToUI();
      if (progress.cancelled) return false;
      chunkStart = Date.now();
    }
  }
  report(count);
  return true;
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

export type BufferEndCapStyle = 'round' | 'flat' | 'square';
export type BufferJoinStyle = 'round' | 'miter' | 'bevel';

export interface BufferOptions {
  /** Number of line segments used to approximate a quarter circle. */
  segments?: number;
  /** How line endings are handled. */
  endCapStyle?: BufferEndCapStyle;
  /** How corners are handled when offsetting. */
  joinStyle?: BufferJoinStyle;
  /** Maximum ratio of miter length to buffer distance for miter joins. */
  miterLimit?: number;
}

/**
 * Web Mercator (EPSG:3857) uses a spherical model with radius R = 6378137 m.
 * At latitude φ the projection stretches distances by sec(φ) = 1/cos(φ).
 * Given an EPSG:3857 y coordinate, cos(φ) = 1/cosh(y/R), so the scale
 * factor is cosh(y/R). This converts ground meters → EPSG:3857 units.
 */
const WEB_MERCATOR_R = 6378137;

function mercatorScaleFactor(y: number): number {
  return Math.cosh(y / WEB_MERCATOR_R);
}

/** Compute the centroid y of a geometry in EPSG:3857. */
function geomCenterY(geom: GeoGeom): number {
  const coords = collectCoords(geom);
  if (coords.length === 0) return 0;
  let sum = 0;
  for (const c of coords) sum += c[1];
  return sum / coords.length;
}

/** Create a circle polygon around a point. segments = segments per quarter circle. */
function bufferPoint(pt: Coord, radius: number, segments: number): Ring {
  const n = segments * 4;
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    ring.push([pt[0] + radius * Math.cos(angle), pt[1] + radius * Math.sin(angle)]);
  }
  ring.push(ring[0]); // close
  return ring;
}

/** Offset a line segment to one side by `d`. */
function offsetSegment(a: Coord, b: Coord, d: number): [Coord, Coord] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [a, b];
  const nx = -dy / len;
  const ny = dx / len;
  return [
    [a[0] + nx * d, a[1] + ny * d],
    [b[0] + nx * d, b[1] + ny * d],
  ];
}

function lineIntersectPt(a: Coord, b: Coord, c: Coord, d: Coord): Coord | null {
  const denom = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / denom;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Alias for lineIntersectPt — used by clipping code. */
const lineIntersect = lineIntersectPt;

/**
 * Generate arc points from `fromAngle` to `toAngle` sweeping **clockwise**.
 *
 * `generateArc` always sweeps counter-clockwise, which is the wrong side for a
 * line's end caps: the cap at the end of a +x line has to bulge towards +x, and
 * the cap at the start towards −x. Both were sweeping the long way round through
 * the line itself, so round-capped buffers were dented instead of rounded.
 */
function generateArcCw(center: Coord, radius: number, fromAngle: number, toAngle: number, segments: number): Coord[] {
  return generateArc(center, radius, toAngle, fromAngle, segments).reverse();
}

/** Generate arc points from angle1 to angle2 (counter-clockwise). */
function generateArc(center: Coord, radius: number, angle1: number, angle2: number, segments: number): Coord[] {
  let sweep = angle2 - angle1;
  while (sweep < 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  if (sweep < 1e-10) return [[center[0] + radius * Math.cos(angle1), center[1] + radius * Math.sin(angle1)]];
  const numSegs = Math.max(1, Math.round(sweep / (Math.PI / 2) * segments));
  const pts: Coord[] = [];
  for (let i = 0; i <= numSegs; i++) {
    const angle = angle1 + (sweep * i) / numSegs;
    pts.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return pts;
}

/** Add join points at a vertex between two consecutive offset edges. */
function addLineJoin(
  pts: Coord[], vertex: Coord,
  prevA: Coord, prevB: Coord,
  nextA: Coord, nextB: Coord,
  radius: number, opts: Required<BufferOptions>,
): void {
  const joinPt = lineIntersectPt(prevA, prevB, nextA, nextB);

  if (opts.joinStyle === 'miter') {
    if (joinPt) {
      const miterDist = dist(joinPt, vertex);
      if (miterDist <= opts.miterLimit * Math.abs(radius)) {
        pts.push(joinPt);
        return;
      }
    }
    // Miter limit exceeded — fall through to bevel
    pts.push(prevB, nextA);
    return;
  }

  if (opts.joinStyle === 'bevel') {
    pts.push(prevB, nextA);
    return;
  }

  // Round join
  if (joinPt) {
    // Check if the miter is reasonable (within 2x buffer distance)
    const miterDist = dist(joinPt, vertex);
    if (miterDist <= 2 * Math.abs(radius)) {
      pts.push(joinPt);
      return;
    }
  }
  // Arc from outgoing direction of prev segment to incoming direction of next segment
  const dx1 = prevB[0] - prevA[0];
  const dy1 = prevB[1] - prevA[1];
  const dx2 = nextB[0] - nextA[0];
  const dy2 = nextB[1] - nextA[1];
  const angle1 = Math.atan2(dy1, dx1);
  const angle2 = Math.atan2(dy2, dx2);
  const arcPts = generateArc(vertex, Math.abs(radius), angle1, angle2, opts.segments);
  pts.push(...arcPts);
}

/** Buffer a LineString with configurable cap and join styles. */
function bufferLineString(coords: Coord[], radius: number, opts: Required<BufferOptions>): Ring {
  if (coords.length < 2) {
    return coords.length === 1 ? bufferPoint(coords[0], Math.abs(radius), opts.segments) : [];
  }

  // Compute offset edges for each segment
  const offsetEdges: { left: [Coord, Coord]; right: [Coord, Coord] }[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    offsetEdges.push({
      left: offsetSegment(coords[i], coords[i + 1], radius),
      right: offsetSegment(coords[i], coords[i + 1], -radius),
    });
  }

  // Build left (positive offset) side: start → end
  const leftSide: Coord[] = [...offsetEdges[0].left];
  for (let i = 1; i < offsetEdges.length; i++) {
    addLineJoin(leftSide, coords[i],
      offsetEdges[i - 1].left[0], offsetEdges[i - 1].left[1],
      offsetEdges[i].left[0], offsetEdges[i].left[1],
      radius, opts);
    leftSide.push(offsetEdges[i].left[1]);
  }

  // Build right (negative offset) side: end → start
  const rightSide: Coord[] = [...offsetEdges[offsetEdges.length - 1].right];
  for (let i = offsetEdges.length - 2; i >= 0; i--) {
    addLineJoin(rightSide, coords[i + 1],
      offsetEdges[i + 1].right[0], offsetEdges[i + 1].right[1],
      offsetEdges[i].right[0], offsetEdges[i].right[1],
      -radius, opts);
    rightSide.push(offsetEdges[i].right[0]);
  }

  // End cap (at last vertex)
  const endCap: Coord[] = [];
  const lastSeg = coords[coords.length - 1];
  const prevLast = coords[coords.length - 2];
  const outAngle = Math.atan2(lastSeg[1] - prevLast[1], lastSeg[0] - prevLast[0]);
  const leftEndAngle = outAngle + Math.PI / 2;
  const rightEndAngle = outAngle - Math.PI / 2;

  if (opts.endCapStyle === 'round') {
    endCap.push(...generateArcCw(lastSeg, Math.abs(radius), leftEndAngle, rightEndAngle, opts.segments));
  } else if (opts.endCapStyle === 'flat') {
    // nothing — direct connection
  } else {
    // square: extend past the end by |radius|
    const ext: Coord = [lastSeg[0] + Math.abs(radius) * Math.cos(outAngle), lastSeg[1] + Math.abs(radius) * Math.sin(outAngle)];
    endCap.push(
      [ext[0] + Math.abs(radius) * Math.cos(leftEndAngle), ext[1] + Math.abs(radius) * Math.sin(leftEndAngle)],
      [ext[0] + Math.abs(radius) * Math.cos(rightEndAngle), ext[1] + Math.abs(radius) * Math.sin(rightEndAngle)],
    );
  }

  // Start cap (at first vertex)
  const startCap: Coord[] = [];
  const firstSeg = coords[0];
  const nextFirst = coords[1];
  const inAngle = Math.atan2(firstSeg[1] - nextFirst[1], firstSeg[0] - nextFirst[0]);
  const rightStartAngle = inAngle + Math.PI / 2;
  const leftStartAngle = inAngle - Math.PI / 2;

  if (opts.endCapStyle === 'round') {
    startCap.push(...generateArcCw(firstSeg, Math.abs(radius), rightStartAngle, leftStartAngle, opts.segments));
  } else if (opts.endCapStyle === 'flat') {
    // nothing
  } else {
    const ext: Coord = [firstSeg[0] + Math.abs(radius) * Math.cos(inAngle), firstSeg[1] + Math.abs(radius) * Math.sin(inAngle)];
    startCap.push(
      [ext[0] + Math.abs(radius) * Math.cos(rightStartAngle), ext[1] + Math.abs(radius) * Math.sin(rightStartAngle)],
      [ext[0] + Math.abs(radius) * Math.cos(leftStartAngle), ext[1] + Math.abs(radius) * Math.sin(leftStartAngle)],
    );
  }

  // Assemble ring
  const ring: Ring = [...leftSide, ...endCap, ...rightSide.reverse(), ...startCap];
  if (ring.length > 0) ring.push(ring[0]);
  return ring;
}

/** Buffer a polygon ring with configurable join style. */
function bufferPolygonRing(ring: Ring, radius: number, opts: Required<BufferOptions>): Ring | null {
  if (ring.length < 4) return ring;
  const ccw = ensureCCW(ring);
  const n = ccw.length - 1; // exclude closing point
  const offsetEdges: [Coord, Coord][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    offsetEdges.push(offsetSegment(ccw[i], ccw[j], radius));
  }

  const result: Ring = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const prevEdge = offsetEdges[i];
    const nextEdge = offsetEdges[j];
    const vertex = ccw[j];

    if (opts.joinStyle === 'miter') {
      const inter = lineIntersectPt(prevEdge[0], prevEdge[1], nextEdge[0], nextEdge[1]);
      if (inter) {
        const miterDist = dist(inter, vertex);
        if (miterDist <= opts.miterLimit * Math.abs(radius)) {
          result.push(inter);
          continue;
        }
      }
      // Miter limit exceeded — bevel
      result.push(prevEdge[1], nextEdge[0]);
    } else if (opts.joinStyle === 'bevel') {
      result.push(prevEdge[1], nextEdge[0]);
    } else {
      // Round join
      const inter = lineIntersectPt(prevEdge[0], prevEdge[1], nextEdge[0], nextEdge[1]);
      if (inter && dist(inter, vertex) <= 2 * Math.abs(radius)) {
        result.push(inter);
      } else {
        const dx1 = prevEdge[1][0] - prevEdge[0][0];
        const dy1 = prevEdge[1][1] - prevEdge[0][1];
        const dx2 = nextEdge[1][0] - nextEdge[0][0];
        const dy2 = nextEdge[1][1] - nextEdge[0][1];
        const angle1 = Math.atan2(dy1, dx1);
        const angle2 = Math.atan2(dy2, dx2);
        result.push(...generateArc(vertex, Math.abs(radius), angle1, angle2, opts.segments));
      }
    }
  }

  if (result.length < 3) return null;
  result.push(result[0]);

  const area = signedArea(result);
  const originalArea = signedArea(ccw);
  // Offsetting must preserve the ring's orientation; a flip means the offset
  // edges crossed over each other.
  if (Math.sign(area) !== Math.sign(originalArea) || Math.abs(area) < 1e-12) return null;
  // A shrinking buffer has to actually shrink. Once the inset exceeds the ring's
  // in-radius the edges invert into something far larger than the input, which
  // the orientation test alone did not catch: a 1×1 square buffered by −10 used
  // to come back as a 19×19 polygon.
  if (radius < 0 && Math.abs(area) >= Math.abs(originalArea)) return null;
  return result;
}

/**
 * Buffer one polygon part.
 *
 * The shell is offset by `distance` while every hole is offset the *other* way:
 * growing a donut must shrink its hole, and shrinking a donut must widen it.
 * Previously only `coordinates[0]` was buffered, so holes silently vanished.
 */
function bufferPolygonPart(
  part: PolygonPart,
  distance: number,
  opts: Required<BufferOptions>
): Ring[] | null {
  const shell = bufferPolygonRing(part.shell, distance, opts);
  if (!shell) return null;
  const rings: Ring[] = [shell];
  for (const hole of part.holes) {
    const bufferedHole = bufferPolygonRing(hole, -distance, opts);
    if (!bufferedHole || bufferedHole.length < 4) continue; // hole closed up
    const inside = ringInteriorPoint(bufferedHole);
    if (inside && !pointInRing(inside, shell)) continue;    // hole escaped the shell
    rings.push(ensureCW(closeRing(bufferedHole)));
  }
  return rings;
}

/** Buffer any geometry. Returns a Polygon or MultiPolygon. */
export function bufferGeometry(geom: GeoGeom, distance: number, options?: BufferOptions): GeoGeom | null {
  if (distance === 0) return geom;

  // Compensate for Web Mercator distortion: the distance is in ground meters,
  // but we operate in EPSG:3857 projected coordinates. Scale by the local
  // Mercator factor so the buffer radius matches the intended ground distance.
  const centerY = geomCenterY(geom);
  const scaledDistance = distance * mercatorScaleFactor(centerY);

  const opts: Required<BufferOptions> = {
    segments: Math.max(1, options?.segments ?? 8),
    endCapStyle: options?.endCapStyle ?? 'round',
    joinStyle: options?.joinStyle ?? 'round',
    miterLimit: Math.max(1, options?.miterLimit ?? 5),
  };

  switch (geom.type) {
    case 'Point':
      if (scaledDistance < 0) return null;
      return { type: 'Polygon', coordinates: [bufferPoint(geom.coordinates, Math.abs(scaledDistance), opts.segments)] };
    case 'MultiPoint': {
      if (scaledDistance < 0) return null;
      if (geom.coordinates.length === 0) return null;
      if (geom.coordinates.length === 1) return { type: 'Polygon', coordinates: [bufferPoint(geom.coordinates[0], Math.abs(scaledDistance), opts.segments)] };
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map(pt => [bufferPoint(pt, Math.abs(scaledDistance), opts.segments)]),
      };
    }
    case 'LineString':
      if (scaledDistance < 0) return null;
      return { type: 'Polygon', coordinates: [bufferLineString(geom.coordinates, scaledDistance, opts)] };
    case 'MultiLineString': {
      if (scaledDistance < 0) return null;
      const polys = geom.coordinates.map(line => bufferLineString(line, scaledDistance, opts)).filter(r => r.length >= 4);
      if (polys.length === 0) return null;
      return { type: 'MultiPolygon', coordinates: polys.map(r => [r]) };
    }
    case 'Polygon': {
      const parts = getPolygonParts(geom);
      const rings = parts.length > 0 ? bufferPolygonPart(parts[0], scaledDistance, opts) : null;
      if (!rings) return null;
      return { type: 'Polygon', coordinates: rings };
    }
    case 'MultiPolygon': {
      const results: Ring[][] = [];
      for (const part of getPolygonParts(geom)) {
        const rings = bufferPolygonPart(part, scaledDistance, opts);
        if (rings) results.push(rings);
      }
      if (results.length === 0) return null;
      if (results.length === 1) return { type: 'Polygon', coordinates: results[0] };
      return { type: 'MultiPolygon', coordinates: results };
    }
    default:
      return null;
  }
}

export function bufferFeature(feature: GeoFeature, distance: number, options?: BufferOptions): GeoFeature | null {
  if (!feature.geometry) return null;
  const geom = bufferGeometry(feature.geometry, distance, options);
  if (!geom) return null;
  return { type: 'Feature', geometry: geom, properties: { ...feature.properties } };
}

export function bufferFeatures(features: GeoFeature[], distance: number, options?: BufferOptions): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    const buffered = bufferFeature(f, distance, options);
    if (buffered) result.push(buffered);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sutherland-Hodgman polygon clipping
// ---------------------------------------------------------------------------

function clipEdgeByLine(ring: Ring, edgeStart: Coord, edgeEnd: Coord): Ring {
  if (ring.length === 0) return [];
  const out: Coord[] = [];
  const dx = edgeEnd[0] - edgeStart[0];
  const dy = edgeEnd[1] - edgeStart[1];

  function inside(p: Coord): boolean {
    return (dx * (p[1] - edgeStart[1]) - dy * (p[0] - edgeStart[0])) >= 0;
  }

  function intersect(a: Coord, b: Coord): Coord {
    const result = lineIntersect(a, b, edgeStart, edgeEnd);
    return result || a;
  }

  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i + ring.length - 1) % ring.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);

    if (curIn) {
      if (!prevIn) {
        out.push(intersect(prev, cur));
      }
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/**
 * Clip subject polygon by clip polygon using Sutherland-Hodgman.
 *
 * Two long-standing defects fixed here:
 * 1. `clipEdgeByLine` keeps the half-plane to the LEFT of each directed cutter
 *    edge, so the cutter must be counter-clockwise in the standard mathematical
 *    sense. This module's `signedArea` uses the surveyor form, which is *negative*
 *    for a standard-CCW ring, so the cutter has to be normalised with `ensureCW`
 *    — the previous `ensureCCW` call inverted every half-plane and the routine
 *    returned null for essentially all input, i.e. Clip and Intersect produced
 *    no features at all.
 * 2. Sutherland-Hodgman walks an OPEN ring; feeding it the closing duplicate
 *    emitted duplicated vertices. The subject is now opened and re-closed.
 *
 * KNOWN LIMITATION (Stage 2): still exact only for convex cutter rings — a
 * concave cutter needs a general overlay kernel.
 */
export function clipPolygon(subject: Ring, clip: Ring): Ring | null {
  if (subject.length < 4 || clip.length < 4) return null;
  const cutter = ensureCW(clip);
  let output = isRingClosed(subject) ? subject.slice(0, -1) : subject.slice();
  for (let i = 0; i < cutter.length - 1; i++) {
    if (output.length === 0) return null;
    output = clipEdgeByLine(output, cutter[i], cutter[i + 1]);
  }
  if (output.length < 3) return null;
  return closeRing(output);
}

// ---------------------------------------------------------------------------
// Clip — clip input layer features by clip layer polygons
// ---------------------------------------------------------------------------

/** One clip/overlay polygon part, prepared once and reused for the whole input. */
interface OverlayOperand {
  part: PolygonPart;
  extent: Extent4;
  /** Index of the source feature, so overlay attributes can be merged back. */
  featureIndex: number;
}

interface OverlayContext {
  operands: OverlayOperand[];
  index: ExtentIndex<number>;
}

/**
 * Flatten the overlay layer into indexed shell+hole parts.
 *
 * Holes stay *with* their shell instead of being promoted to independent
 * cutters — the old flat ring list filled every donut hole in.
 */
function prepareOverlay(overlayLayer: GeoFeature[]): OverlayContext | null {
  const operands: OverlayOperand[] = [];
  for (let i = 0; i < overlayLayer.length; i++) {
    for (const part of getPolygonParts(overlayLayer[i].geometry)) {
      operands.push({ part, extent: extentOfCoords(part.shell), featureIndex: i });
    }
  }
  if (operands.length === 0) return null;
  const index = new ExtentIndex<number>();
  index.load(operands.map(o => o.extent), operands.map((_, i) => i));
  return { operands, index };
}

/**
 * Clip one subject part by one overlay part, returning [shell, ...holes] rings
 * per surviving piece.
 *
 * KNOWN LIMITATION (tracked for Stage 2): `clipPolygon` is Sutherland-Hodgman,
 * which is only exact for convex cutter rings; and an overlay hole can only
 * discard a whole piece (a piece straddling a hole is dropped, not split)
 * because there is no polygon-difference kernel yet.
 */
function clipPartByPart(subject: PolygonPart, clip: PolygonPart): Ring[][] {
  const clippedShell = clipPolygon(subject.shell, clip.shell);
  if (!clippedShell || clippedShell.length < 4) return [];

  // Cut the overlay's holes back out. Without a difference kernel we can only
  // drop a piece that is *entirely* enclosed by a hole; a piece that merely
  // straddles one is kept (over-reporting, but never losing area silently).
  if (clip.holes.length > 0 && clip.holes.some(hole => ringEnclosedBy(clippedShell, hole))) {
    return [];
  }

  // Subject holes survive as holes of the piece that contains them.
  const holePieces: Ring[] = [];
  for (const hole of subject.holes) {
    const clippedHole = clipPolygon(hole, clip.shell);
    if (clippedHole && clippedHole.length >= 4) holePieces.push(ensureCW(closeRing(clippedHole)));
  }
  if (holePieces.length === 0) return [[clippedShell]];

  const rings: Ring[] = [clippedShell];
  for (const holePiece of holePieces) {
    const p = ringInteriorPoint(holePiece);
    if (p && pointInRing(p, clippedShell)) rings.push(holePiece);
  }
  return [rings];
}

function clipOneFeature(feature: GeoFeature, ctx: OverlayContext): GeoFeature[] {
  const parts = getPolygonParts(feature.geometry);
  if (parts.length === 0) return [];
  const results: GeoFeature[] = [];
  for (const subject of parts) {
    const subjectExtent = extentOfCoords(subject.shell);
    for (const operandIdx of ctx.index.query(subjectExtent)) {
      for (const rings of clipPartByPart(subject, ctx.operands[operandIdx].part)) {
        results.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: rings },
          properties: { ...feature.properties },
        });
      }
    }
  }
  return results;
}

export function clipFeatures(input: GeoFeature[], clipLayer: GeoFeature[]): GeoFeature[] {
  const ctx = prepareOverlay(clipLayer);
  if (!ctx) return [];
  const results: GeoFeature[] = [];
  for (const f of input) results.push(...clipOneFeature(f, ctx));
  return results;
}

/**
 * Clip with progress reporting and cancellation — the interactive variant the
 * panel runs, so large inputs stay responsive instead of freezing the tab.
 */
export async function clipFeaturesAsync(
  input: GeoFeature[],
  clipLayer: GeoFeature[],
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const ctx = prepareOverlay(clipLayer);
  if (!ctx) return [];
  const results: GeoFeature[] = [];
  await progressLoop(
    input.length,
    progress,
    i => results.push(...clipOneFeature(input[i], ctx)),
    onProgress,
    'Clipping'
  );
  return progress.cancelled ? [] : results;
}

// ---------------------------------------------------------------------------
// Intersect — pairwise intersection of two polygon layers
// ---------------------------------------------------------------------------

/**
 * Intersect one A feature against an indexed B layer.
 *
 * Shares the clip kernel, so it inherits the same shell/hole handling — and the
 * same convex-cutter limitation. `layerB` is indexed once per call, turning the
 * old O(|A|·|B|·rings²) brute force into O(|A|·log|B| + overlaps).
 */
function intersectOneFeature(a: GeoFeature, ctx: OverlayContext, layerB: GeoFeature[]): GeoFeature[] {
  const aParts = getPolygonParts(a.geometry);
  if (aParts.length === 0) return [];
  const results: GeoFeature[] = [];
  for (const aPart of aParts) {
    const aExtent = extentOfCoords(aPart.shell);
    for (const operandIdx of ctx.index.query(aExtent)) {
      const operand = ctx.operands[operandIdx];
      const pieces = clipPartByPart(aPart, operand.part);
      if (pieces.length === 0) continue;
      const b = layerB[operand.featureIndex];
      for (const rings of pieces) {
        results.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: rings },
          // KNOWN LIMITATION (Stage 2): colliding field names are overwritten by
          // B rather than disambiguated the way QGIS does.
          properties: { ...a.properties, ...b.properties },
        });
      }
    }
  }
  return results;
}

export function intersectFeatures(layerA: GeoFeature[], layerB: GeoFeature[]): GeoFeature[] {
  const ctx = prepareOverlay(layerB);
  if (!ctx) return [];
  const results: GeoFeature[] = [];
  for (const a of layerA) results.push(...intersectOneFeature(a, ctx, layerB));
  return results;
}

/** Intersect with progress reporting and cancellation (see `clipFeaturesAsync`). */
export async function intersectFeaturesAsync(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const ctx = prepareOverlay(layerB);
  if (!ctx) return [];
  const results: GeoFeature[] = [];
  await progressLoop(
    layerA.length,
    progress,
    i => results.push(...intersectOneFeature(layerA[i], ctx, layerB)),
    onProgress,
    'Intersecting'
  );
  return progress.cancelled ? [] : results;
}

// ---------------------------------------------------------------------------
// Union — combine all features from two layers into one collection
// ---------------------------------------------------------------------------

export async function unionFeatures(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  // True geometric union: combine all features and dissolve shared boundaries
  // between adjacent polygons. Non-polygon features are passed through.
  const allFeatures = [...layerA, ...layerB];

  // Separate polygon features from non-polygon features
  const polyFeatures: GeoFeature[] = [];
  const otherFeatures: GeoFeature[] = [];
  for (const f of allFeatures) {
    if (!f.geometry) { otherFeatures.push(f); continue; }
    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
      polyFeatures.push(f);
    } else {
      otherFeatures.push(f);
    }
  }

  // Dissolve adjacent polygons to merge overlapping boundaries
  const dissolved = await dissolveFeatures(polyFeatures, true, progress, onProgress);

  return [...dissolved, ...otherFeatures.map(f => ({
    type: 'Feature' as const,
    geometry: f.geometry,
    properties: { ...f.properties },
  }))];
}

// ---------------------------------------------------------------------------
// Dissolve — merge all features into a single feature
// ---------------------------------------------------------------------------

/**
 * @param progress Caller-owned token. Mutating `progress.cancelled` aborts the
 *   run — previously the panel owned one object and the engine another, so the
 *   Cancel button could never actually stop a dissolve.
 */
export async function dissolveFeatures(
  features: GeoFeature[],
  dissolveOverlap: boolean = false,
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const report = (message: string, p: number) => {
    progress.message = message;
    progress.progress = clamp01(p);
    if (onProgress) onProgress(progress);
  };

  if (features.length === 0) return [];
  if (features.length === 1) return [{ ...features[0], properties: {} }];

  report('Collecting geometries...', 0.05);

  // Collect all polygon rings, linestrings, and points
  const allPolyRings: Ring[][] = [];
  const allLines: Coord[][] = [];
  const allPoints: Coord[] = [];

  for (const f of features) {
    if (!f.geometry) continue;
    switch (f.geometry.type) {
      case 'Polygon':
        allPolyRings.push(f.geometry.coordinates);
        break;
      case 'MultiPolygon':
        allPolyRings.push(...f.geometry.coordinates);
        break;
      case 'LineString':
        allLines.push(f.geometry.coordinates);
        break;
      case 'MultiLineString':
        allLines.push(...f.geometry.coordinates);
        break;
      case 'Point':
        allPoints.push(f.geometry.coordinates);
        break;
      case 'MultiPoint':
        allPoints.push(...f.geometry.coordinates);
        break;
    }
  }

  const resultGeoms: GeoGeom[] = [];
  if (allPolyRings.length > 0) {
    if (dissolveOverlap && allPolyRings.length > 1) {
      report(`Dissolving ${allPolyRings.length} polygons...`, 0.1);
      await yieldToUI();
      if (progress.cancelled) return [];

      // Attempt to dissolve shared boundaries between adjacent polygons.
      // Iteratively merge pairs that share edges until no more merges are possible.
      const mergedRings = await dissolveAdjacentRingsAsync(allPolyRings, progress, onProgress);
      
      if (progress.cancelled) return [];
      
      if (mergedRings.length === 1) {
        resultGeoms.push({ type: 'Polygon', coordinates: mergedRings[0] });
      } else {
        resultGeoms.push({ type: 'MultiPolygon', coordinates: mergedRings });
      }
    } else {
      resultGeoms.push(allPolyRings.length === 1
        ? { type: 'Polygon', coordinates: allPolyRings[0] }
        : { type: 'MultiPolygon', coordinates: allPolyRings });
    }
  }
  if (allLines.length > 0) {
    resultGeoms.push(allLines.length === 1
      ? { type: 'LineString', coordinates: allLines[0] }
      : { type: 'MultiLineString', coordinates: allLines });
  }
  if (allPoints.length > 0) {
    resultGeoms.push(allPoints.length === 1
      ? { type: 'Point', coordinates: allPoints[0] }
      : { type: 'MultiPoint', coordinates: allPoints });
  }

  report('Complete', 1.0);

  if (resultGeoms.length === 1) {
    return [{ type: 'Feature', geometry: resultGeoms[0], properties: {} }];
  }
  // Mixed geometry types → return as separate features
  return resultGeoms.map(g => ({ type: 'Feature' as const, geometry: g, properties: {} }));
}

/**
 * Iteratively dissolve polygon rings by computing geometric unions.
 * Handles both edge-adjacent and overlapping polygons.
 *
 * Candidates come from an R-tree (utils/geomIndex.ts) rebuilt once per pass, so
 * a pass costs O(n log n + overlaps) instead of the old O(n²) full scan, and the
 * scan no longer restarts from the beginning after every single merge.
 *
 * Each input is a polygon (array of rings: [outer, ...holes]).
 * Returns the resulting array of polygons after all possible merges.
 */
async function dissolveAdjacentRingsAsync(
  polys: Ring[][],
  progress: ProgressToken,
  onProgress?: ProgressReporter
): Promise<Ring[][]> {
  if (polys.length === 0) return [];
  if (polys.length === 1) return polys;

  const total = polys.length;
  const tolerance = scaleTolerance(extentSpan(extentOfCoords(polys.flatMap(poly => poly[0]))));

  // Working copy with active flags and cached extents.
  const working = polys.map(poly => ({ rings: poly, extent: extentOfCoords(poly[0]), active: true }));
  let activeCount = total;

  const report = () => {
    progress.message = `Dissolving… ${activeCount} polygon${activeCount === 1 ? '' : 's'} remaining`;
    // Progress is the fraction of polygons eliminated: monotonic and always ≤ 1.
    // The previous pairs-checked counter could exceed the pair total because the
    // scan restarted after every merge, pushing the bar past 100 %.
    progress.progress = clamp01(0.1 + 0.8 * ((total - activeCount) / Math.max(total - 1, 1)));
    if (onProgress) onProgress(progress);
  };

  let changed = true;
  let passesLeft = total * 2; // safety limit
  let chunkStart = Date.now();

  while (changed && passesLeft > 0 && !progress.cancelled) {
    changed = false;
    passesLeft--;

    // Index the current extents once per pass. Polygons that grew during this
    // pass are re-indexed at the start of the next one (another pass only runs
    // when something merged).
    const index = new ExtentIndex<number>();
    index.load(working.map(w => w.extent), working.map((_, i) => i));

    for (let i = 0; i < working.length && !progress.cancelled; i++) {
      if (!working[i].active) continue;

      // Absorb neighbours into i until none is left, re-querying after each merge
      // because i's extent has grown.
      let mergedOne = true;
      while (mergedOne && !progress.cancelled) {
        mergedOne = false;
        for (const j of index.query(working[i].extent)) {
          if (j <= i || !working[j].active) continue;

          const ring1 = working[i].rings[0];
          const ring2 = working[j].rings[0];

          // Fast path for topologically clean, node-matched neighbours…
          let merged: Ring | null = ringsAdjacent(ring1, ring2, tolerance)
            ? dissolveTwoPolygons(ring1, ring2, tolerance)
            : null;
          // …falling back to the general (approximate) overlap union.
          if (!merged) merged = polygonUnion(ring1, ring2);
          if (!merged) continue;

          working[i].rings = [merged, ...working[i].rings.slice(1), ...working[j].rings.slice(1)];
          working[i].extent = extentOfCoords(merged);
          working[j].active = false;
          activeCount--;
          changed = true;
          mergedOne = true;
          report();

          if (Date.now() - chunkStart >= PROGRESS_CHUNK_MS) {
            await yieldToUI();
            chunkStart = Date.now();
          }
          break; // re-query with i's new extent
        }
      }
    }
  }

  return working.filter(w => w.active).map(w => w.rings);
}

/**
 * Compute the geometric union of two polygons.
 * Uses a simplified approach: finds intersection points and traces the outer boundary.
 * For complex overlaps, may produce approximate results.
 * Returns the merged ring, or null if polygons are disjoint.
 */
function polygonUnion(ring1: Ring, ring2: Ring): Ring | null {
  // Quick bbox check
  const bbox1 = ringBBox(ring1);
  const bbox2 = ringBBox(ring2);
  if (bbox1.maxX < bbox2.minX || bbox1.minX > bbox2.maxX ||
      bbox1.maxY < bbox2.minY || bbox1.minY > bbox2.maxY) {
    return null;
  }

  // Check containment
  if (ringContains(ring1, ring2)) return ring1;
  if (ringContains(ring2, ring1)) return ring2;

  // Find all intersection points
  const intersections: Array<{point: Coord, seg1: number, seg2: number, t1: number, t2: number}> = [];
  const n1 = ring1.length - 1;
  const n2 = ring2.length - 1;

  for (let i = 0; i < n1; i++) {
    const a1 = ring1[i], a2 = ring1[(i + 1) % n1];
    for (let j = 0; j < n2; j++) {
      const b1 = ring2[j], b2 = ring2[(j + 1) % n2];

      const dax = a2[0] - a1[0], day = a2[1] - a1[1];
      const dbx = b2[0] - b1[0], dby = b2[1] - b1[1];
      const denom = dax * dby - day * dbx;
      if (Math.abs(denom) < 1e-12) continue;

      const t1 = ((b1[0] - a1[0]) * dby - (b1[1] - a1[1]) * dbx) / denom;
      const t2 = ((b1[0] - a1[0]) * day - (b1[1] - a1[1]) * dax) / denom;

      if (t1 > 1e-9 && t1 < 1 - 1e-9 && t2 > 1e-9 && t2 < 1 - 1e-9) {
        intersections.push({
          point: [a1[0] + t1 * dax, a1[1] + t1 * day],
          seg1: i, seg2: j, t1, t2
        });
      }
    }
  }

  if (intersections.length < 2) {
    // Not enough intersections for a proper union
    // Fall back to convex hull of all vertices as an approximation
    return convexHullOfRings(ring1, ring2);
  }

  // Sort intersections by position along ring1
  intersections.sort((a, b) => {
    if (a.seg1 !== b.seg1) return a.seg1 - b.seg1;
    return a.t1 - b.t1;
  });

  // Build union by traversing: follow ring1, at each intersection switch to ring2,
  // follow ring2, at next intersection switch back to ring1, etc.
  const result: Ring = [];
  const visitedInters = new Set<number>();
  
  let currentRing = ring1;
  let currentSeg = intersections[0].seg1;
  let currentT = intersections[0].t1;
  let currentInterIdx = 0;
  
  result.push(intersections[0].point);
  visitedInters.add(0);

  const maxIter = (n1 + n2) * 2;
  let iter = 0;

  while (iter < maxIter) {
    iter++;
    const n = currentRing.length - 1;
    
    // Find the next intersection on the current ring (going forward)
    let nextInterIdx = -1;
    let nextInterSeg = -1;
    let nextInterT = -1;
    
    // Search forward from current position
    for (let attempt = 0; attempt < intersections.length; attempt++) {
      const idx = (currentInterIdx + 1 + attempt) % intersections.length;
      if (visitedInters.has(idx) && visitedInters.size > 1) continue;
      
      const inter = intersections[idx];
      let interSeg: number, interT: number;
      
      if (currentRing === ring1) {
        interSeg = inter.seg1;
        interT = inter.t1;
      } else {
        interSeg = inter.seg2;
        interT = inter.t2;
      }
      
      // Check if this intersection is ahead of current position
      if (interSeg > currentSeg || (interSeg === currentSeg && interT > currentT + 1e-9)) {
        nextInterIdx = idx;
        nextInterSeg = interSeg;
        nextInterT = interT;
        break;
      }
    }
    
    // If no intersection found ahead, wrap around
    if (nextInterIdx === -1) {
      for (let idx = 0; idx < intersections.length; idx++) {
        if (visitedInters.has(idx)) continue;
        const inter = intersections[idx];
        let interSeg: number, interT: number;
        
        if (currentRing === ring1) {
          interSeg = inter.seg1;
          interT = inter.t1;
        } else {
          interSeg = inter.seg2;
          interT = inter.t2;
        }
        
        nextInterIdx = idx;
        nextInterSeg = interSeg;
        nextInterT = interT;
        break;
      }
    }
    
    if (nextInterIdx === -1) break; // All intersections visited
    
    const nextInter = intersections[nextInterIdx];
    
    // Add vertices from current position to next intersection
    let s = (currentSeg + 1) % n;
    const targetSeg = nextInterSeg;
    let safety = 0;
    while (s !== (targetSeg + 1) % n && safety < n + 2) {
      result.push(currentRing[s]);
      s = (s + 1) % n;
      safety++;
    }
    
    // Add the intersection point
    result.push(nextInter.point);
    visitedInters.add(nextInterIdx);
    
    // Switch rings
    if (currentRing === ring1) {
      currentRing = ring2;
      currentSeg = nextInter.seg2;
      currentT = nextInter.t2;
    } else {
      currentRing = ring1;
      currentSeg = nextInter.seg1;
      currentT = nextInter.t1;
    }
    currentInterIdx = nextInterIdx;
    
    // Check if we've returned to start
    if (result.length > 3 && dist(result[0], result[result.length - 1]) < 1e-9) {
      break;
    }
  }

  if (result.length < 4) {
    return convexHullOfRings(ring1, ring2);
  }

  // Ensure closed
  if (dist(result[0], result[result.length - 1]) > 1e-9) {
    result.push(result[0]);
  }

  return result;
}

/**
 * Compute convex hull of two rings combined (fallback for complex overlaps).
 */
function convexHullOfRings(ring1: Ring, ring2: Ring): Ring {
  const points: Coord[] = [];
  for (let i = 0; i < ring1.length - 1; i++) points.push(ring1[i]);
  for (let i = 0; i < ring2.length - 1; i++) points.push(ring2[i]);
  
  if (points.length < 3) return ring1;
  
  // Graham scan
  points.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
  const lower: Coord[] = [];
  for (const p of points) {
    while (lower.length >= 2 && cross2d(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Coord[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross2d(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);
  hull.push(hull[0]);
  return hull;
}

function cross2d(o: Coord, a: Coord, b: Coord): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * Compute bounding box of a ring.
 */
function ringBBox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const x = ring[i][0], y = ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Check if outer ring completely contains inner ring.
 */
function ringContains(outer: Ring, inner: Ring): boolean {
  // All vertices of inner must be inside outer
  for (let i = 0; i < inner.length - 1; i++) {
    if (!pointInRing(inner[i], outer)) return false;
  }
  return true;
}

/**
 * Is `inner` entirely enclosed by `outer`?
 *
 * Deliberately conservative: it requires the interior sample point *and* the
 * whole bounding box of `inner` to be inside `outer`. A false negative only means
 * we keep a piece we could have dropped; a false positive would silently delete
 * real area, which is the failure mode this module has had enough of.
 */
function ringEnclosedBy(inner: Ring, outer: Ring): boolean {
  const sample = ringInteriorPoint(inner);
  if (!sample || !pointInRing(sample, outer)) return false;
  const ie = extentOfCoords(inner);
  const oe = extentOfCoords(outer);
  return ie[0] >= oe[0] && ie[1] >= oe[1] && ie[2] <= oe[2] && ie[3] <= oe[3];
}

/**
 * A point representative of a ring's interior, or null when none was found.
 *
 * Used by the containment heuristics that decide which clipped piece a hole
 * belongs to, and whether a clipped piece falls inside a clip-layer hole. The
 * centroid is tried first (correct for convex pieces), then the bbox centre,
 * then vertices nudged toward the centroid.
 */
function ringInteriorPoint(ring: Ring): Coord | null {
  if (ring.length < 4) return null;
  const centroid = ringCentroid(ring);
  if (pointInRing(centroid, ring)) return centroid;
  const bbox = ringBBox(ring);
  const middle: Coord = [(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2];
  if (pointInRing(middle, ring)) return middle;
  for (let i = 0; i < ring.length - 1; i++) {
    const nudged: Coord = [
      ring[i][0] + (centroid[0] - ring[i][0]) * 0.05,
      ring[i][1] + (centroid[1] - ring[i][1]) * 0.05,
    ];
    if (pointInRing(nudged, ring)) return nudged;
  }
  return null;
}

/**
 * Check if a point is inside a ring using ray casting.
 */
function pointInRing(pt: Coord, ring: Ring): boolean {
  const x = pt[0], y = pt[1];
  let inside = false;
  const n = ring.length - 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Centroid — create point features at each feature's centroid
// ---------------------------------------------------------------------------

function ringCentroid(ring: Ring): Coord {
  let cx = 0, cy = 0, area = 0;
  const n = ring.length - 1; // exclude closing point
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    cx += (ring[i][0] + ring[j][0]) * cross;
    cy += (ring[i][1] + ring[j][1]) * cross;
    area += cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    // Degenerate — just average the coords
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Signed first moments (∫x dA, ∫y dA) and signed area of a ring. */
interface Moments { mx: number; my: number; area: number }

function ringMoments(ring: Ring): Moments {
  const area = signedArea(ring);
  const c = ringCentroid(ring);
  return { mx: c[0] * area, my: c[1] * area, area };
}

/**
 * First moments of a polygon part with its holes **subtracted**, normalised so
 * `area` is positive. Previously holes were ignored entirely, which pulled the
 * centroid of a donut toward the middle of the hole.
 */
function partMoments(part: PolygonPart): Moments {
  const shell = ringMoments(part.shell);
  const sign = shell.area < 0 ? -1 : 1; // normalise the shell to CCW
  let mx = sign * shell.mx;
  let my = sign * shell.my;
  let area = sign * shell.area;
  for (const hole of part.holes) {
    const m = ringMoments(hole);
    // A correctly wound hole has the opposite sign to its shell; if the input is
    // wound the same way, flip it before subtracting.
    const holeSign = Math.sign(m.area) === Math.sign(shell.area) ? sign : -sign;
    mx -= holeSign * m.mx;
    my -= holeSign * m.my;
    area -= holeSign * m.area;
  }
  return { mx, my, area };
}

function momentsToCentroid(m: Moments, fallbackRing: Ring): Coord {
  if (!(m.area > 1e-12)) return ringCentroid(fallbackRing);
  return [m.mx / m.area, m.my / m.area];
}

function geomCentroid(geom: GeoGeom): Coord {
  switch (geom.type) {
    case 'Point':
      return geom.coordinates;
    case 'MultiPoint': {
      let sx = 0, sy = 0;
      for (const c of geom.coordinates) { sx += c[0]; sy += c[1]; }
      return [sx / geom.coordinates.length, sy / geom.coordinates.length];
    }
    case 'LineString': {
      // Length-weighted centroid: each segment's midpoint weighted by segment length
      const coords = geom.coordinates;
      if (coords.length < 2) return coords.length === 1 ? coords[0] : [0, 0];
      let totalLen = 0, cx = 0, cy = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        const segLen = dist(coords[i], coords[i + 1]);
        const mx = (coords[i][0] + coords[i + 1][0]) / 2;
        const my = (coords[i][1] + coords[i + 1][1]) / 2;
        cx += mx * segLen;
        cy += my * segLen;
        totalLen += segLen;
      }
      return totalLen > 0 ? [cx / totalLen, cy / totalLen] : coords[0];
    }
    case 'MultiLineString': {
      let totalLen = 0, cx = 0, cy = 0;
      for (const line of geom.coordinates) {
        for (let i = 0; i < line.length - 1; i++) {
          const segLen = dist(line[i], line[i + 1]);
          const mx = (line[i][0] + line[i + 1][0]) / 2;
          const my = (line[i][1] + line[i + 1][1]) / 2;
          cx += mx * segLen;
          cy += my * segLen;
          totalLen += segLen;
        }
      }
      return totalLen > 0 ? [cx / totalLen, cy / totalLen] : [0, 0];
    }
    case 'Polygon': {
      const parts = getPolygonParts(geom);
      return parts.length > 0 ? momentsToCentroid(partMoments(parts[0]), parts[0].shell) : [0, 0];
    }
    case 'MultiPolygon': {
      // Area-weighted across parts, each part with its holes subtracted.
      const parts = getPolygonParts(geom);
      let mx = 0, my = 0, area = 0;
      for (const part of parts) {
        const m = partMoments(part);
        mx += m.mx; my += m.my; area += m.area;
      }
      if (area <= 1e-12) return parts.length > 0 ? ringCentroid(parts[0].shell) : [0, 0];
      return [mx / area, my / area];
    }
  }
}

export function centroidFeatures(features: GeoFeature[]): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    result.push({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: geomCentroid(f.geometry) },
      properties: { ...f.properties },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Convex Hull — Graham scan on all coordinates
// ---------------------------------------------------------------------------


function convexHullRing(points: Coord[]): Ring {
  if (points.length < 3) {
    const ring: Ring = points.slice();
    if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push(ring[0]);
    }
    return ring;
  }

  // Find the lowest point (and leftmost if tied)
  let pivot = points[0];
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] < pivot[1] || (points[i][1] === pivot[1] && points[i][0] < pivot[0])) {
      pivot = points[i];
    }
  }

  // Sort by polar angle relative to pivot
  const sorted = points
    .filter(p => p !== pivot)
    .sort((a, b) => {
      const angleA = Math.atan2(a[1] - pivot[1], a[0] - pivot[0]);
      const angleB = Math.atan2(b[1] - pivot[1], b[0] - pivot[0]);
      if (Math.abs(angleA - angleB) < 1e-12) {
        return dist(pivot, a) - dist(pivot, b);
      }
      return angleA - angleB;
    });

  const stack: Coord[] = [pivot];
  for (const p of sorted) {
    while (stack.length > 1 && cross2d(stack[stack.length - 2], stack[stack.length - 1], p) <= 0) {
      stack.pop();
    }
    stack.push(p);
  }
  stack.push(stack[0]); // close ring
  return stack;
}

export interface CollectCoordsOptions {
  /**
   * Include inner-ring (hole) vertices. Off by default: convex hull, Delaunay
   * and Voronoi are unaffected by interior vertices, and switching them on
   * would only add work.
   */
  includeHoles?: boolean;
}

function collectCoords(geom: GeoGeom, options?: CollectCoordsOptions): Coord[] {
  const holes = options?.includeHoles === true;
  switch (geom.type) {
    case 'Point': return [geom.coordinates];
    case 'MultiPoint': return geom.coordinates;
    case 'LineString': return geom.coordinates;
    case 'MultiLineString': return geom.coordinates.flat();
    case 'Polygon':
      return holes ? geom.coordinates.flat() : geom.coordinates[0];
    case 'MultiPolygon':
      return holes ? geom.coordinates.flat(2) : geom.coordinates.map(p => p[0]).flat();
  }
}

export function convexHullFeature(features: GeoFeature[]): GeoFeature | null {
  const allPoints: Coord[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    allPoints.push(...collectCoords(f.geometry));
  }
  if (allPoints.length === 0) return null;
  if (allPoints.length === 1) {
    return { type: 'Feature', geometry: { type: 'Point', coordinates: allPoints[0] }, properties: {} };
  }
  if (allPoints.length === 2) {
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: allPoints }, properties: {} };
  }
  const hull = convexHullRing(allPoints);
  if (hull.length < 4) {
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: hull }, properties: {} };
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [hull] }, properties: {} };
}

// ---------------------------------------------------------------------------
// Distance — compute minimum distance between features of two layers
// ---------------------------------------------------------------------------

/** The point on segment ab closest to p. */
function closestPointOnSegment(p: Coord, a: Coord, b: Coord): Coord {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

function pointToSegmentDist(p: Coord, a: Coord, b: Coord): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

function ringMinDist(ringA: Ring, ringB: Ring): number {
  let minD = Infinity;
  for (let i = 0; i < ringA.length - 1; i++) {
    for (let j = 0; j < ringB.length - 1; j++) {
      const d = segmentToSegmentDist(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1]);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

export interface SegmentClosest {
  dist: number;
  onA: Coord;
  onB: Coord;
}

/**
 * Closest point pair between two segments.
 *
 * Same analytical solve as before (parameterise P(s)/Q(t), minimise |P−Q|²,
 * handle the degenerate and constrained-edge cases) but it now also returns the
 * two closest coordinates so the caller can convert them to a ground distance.
 */
function closestPointsOnSegments(a1: Coord, a2: Coord, b1: Coord, b2: Coord): SegmentClosest {
  const dax = a2[0] - a1[0], day = a2[1] - a1[1];
  const dbx = b2[0] - b1[0], dby = b2[1] - b1[1];
  const rx = a1[0] - b1[0], ry = a1[1] - b1[1];

  const aa = dax * dax + day * day;
  const bb = dbx * dbx + dby * dby;
  const ab = dax * dbx + day * dby;
  const a_r = dax * rx + day * ry;
  const b_r = dbx * rx + dby * ry;

  const at = (s: number): Coord => [a1[0] + s * dax, a1[1] + s * day];
  const bt = (t: number): Coord => [b1[0] + t * dbx, b1[1] + t * dby];
  const result = (s: number, t: number): SegmentClosest => {
    const pa = at(s), pb = bt(t);
    return { dist: dist(pa, pb), onA: pa, onB: pb };
  };

  const EPS = 1e-12;
  if (aa < EPS && bb < EPS) return result(0, 0);
  if (aa < EPS) return result(0, clamp01(b_r / bb));
  if (bb < EPS) {
    const t = clamp01(a_r / aa);
    return result(t, 0);
  }

  const denom = aa * bb - ab * ab; // ≥ 0 by Cauchy–Schwarz
  if (Math.abs(denom) < EPS) {
    // Parallel — fix s = 0 and solve for t.
    return result(0, clamp01(b_r / bb));
  }

  const s = (ab * b_r - bb * a_r) / denom;
  const t = (aa * b_r - ab * a_r) / denom;
  if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return result(s, t);

  // Outside the unit square: solve the four constrained edge problems.
  let best = result(0, clamp01(b_r / bb));                       // edge s = 0
  const consider = (cand: SegmentClosest) => { if (cand.dist < best.dist) best = cand; };

  { // edge s = 1
    const b_r2 = dbx * (a2[0] - b1[0]) + dby * (a2[1] - b1[1]);
    consider(result(1, clamp01(b_r2 / bb)));
  }
  { // edge t = 0
    consider(result(clamp01(a_r / aa), 0));
  }
  { // edge t = 1
    const a_r2 = dax * (b2[0] - a1[0]) + day * (b2[1] - a1[1]);
    consider(result(clamp01(a_r2 / aa), 1));
  }
  return best;
}

function segmentToSegmentDist(a1: Coord, a2: Coord, b1: Coord, b2: Coord): number {
  return closestPointsOnSegments(a1, a2, b1, b2).dist;
}

/** A geometry reduced to the primitives the distance kernel compares. */
interface GeomPrimitives {
  /** Isolated points (Point / MultiPoint). */
  points: Coord[];
  /** Every coordinate, for containment tests. */
  vertices: Coord[];
  /** Boundary segments of lines and polygon shells. */
  segments: Array<[Coord, Coord]>;
  /** Exterior rings only. */
  rings: Ring[];
}

function geomPrimitives(geom: GeoGeom): GeomPrimitives {
  const points: Coord[] = [];
  const vertices: Coord[] = [];
  const segments: Array<[Coord, Coord]> = [];
  const rings: Ring[] = [];
  const pushLine = (coords: Coord[]) => {
    for (let i = 0; i < coords.length; i++) vertices.push(coords[i]);
    for (let i = 0; i < coords.length - 1; i++) segments.push([coords[i], coords[i + 1]]);
  };
  switch (geom.type) {
    case 'Point':
      points.push(geom.coordinates); vertices.push(geom.coordinates); break;
    case 'MultiPoint':
      points.push(...geom.coordinates); vertices.push(...geom.coordinates); break;
    case 'LineString':
      pushLine(geom.coordinates); break;
    case 'MultiLineString':
      for (const line of geom.coordinates) pushLine(line);
      break;
    case 'Polygon':
    case 'MultiPolygon':
      for (const part of getPolygonParts(geom)) {
        rings.push(part.shell);
        pushLine(part.shell);
      }
      break;
  }
  return { points, vertices, segments, rings };
}

/** First segment pair that actually crosses, and where. */
function firstSegmentCrossing(
  segsA: Array<[Coord, Coord]>,
  segsB: Array<[Coord, Coord]>
): Coord | null {
  for (const [a1, a2] of segsA) {
    for (const [b1, b2] of segsB) {
      if (!segmentsIntersect(a1, a2, b1, b2)) continue;
      return lineIntersectPt(a1, a2, b1, b2) ?? a1;
    }
  }
  return null;
}

/** First vertex of `vertices` that lies inside any of `rings`. */
function firstContainedVertex(rings: Ring[], vertices: Coord[]): Coord | null {
  if (rings.length === 0 || vertices.length === 0) return null;
  for (const v of vertices) {
    for (const ring of rings) {
      if (pointInRing(v, ring)) return v;
    }
  }
  return null;
}

export interface ClosestPoints {
  /** Planar distance in EPSG:3857 map units. */
  mapUnits: number;
  /** Ground distance in metres (spherical — matches the measure tool). */
  meters: number;
  /** The closest coordinate on each geometry, in map units. */
  onA: Coord;
  onB: Coord;
  /** True when the geometries overlap or one contains the other. */
  overlapping: boolean;
}

/**
 * Exact minimum distance between two geometries of *any* type, plus the pair of
 * coordinates that realise it.
 *
 * Two fixes over the previous `geomMinDist`: overlapping or contained
 * geometries now report 0 (GEOS/PostGIS parity) instead of the distance between
 * their boundaries, and non-polygonal inputs are measured properly instead of
 * falling back to centroid-to-centroid distance.
 */
export function geomClosestPoints(a: GeoGeom, b: GeoGeom): ClosestPoints {
  const pa = geomPrimitives(a);
  const pb = geomPrimitives(b);

  const zero = (at: Coord): ClosestPoints => ({
    mapUnits: 0, meters: 0, onA: at, onB: at, overlapping: true,
  });
  const crossing = firstSegmentCrossing(pa.segments, pb.segments);
  if (crossing) return zero(crossing);
  const contained = firstContainedVertex(pa.rings, pb.vertices)
    ?? firstContainedVertex(pb.rings, pa.vertices);
  if (contained) return zero(contained);

  let best: SegmentClosest | null = null;
  const consider = (cand: SegmentClosest) => { if (!best || cand.dist < best.dist) best = cand; };

  for (const [a1, a2] of pa.segments) {
    for (const [b1, b2] of pb.segments) consider(closestPointsOnSegments(a1, a2, b1, b2));
  }
  for (const p of pa.points) {
    for (const [b1, b2] of pb.segments) {
      const q = closestPointOnSegment(p, b1, b2);
      consider({ dist: dist(p, q), onA: p, onB: q });
    }
    for (const q of pb.points) consider({ dist: dist(p, q), onA: p, onB: q });
  }
  for (const p of pb.points) {
    for (const [a1, a2] of pa.segments) {
      const q = closestPointOnSegment(p, a1, a2);
      consider({ dist: dist(p, q), onA: q, onB: p });
    }
  }

  if (!best) {
    // Nothing comparable (an empty geometry on one side) — centroid fallback.
    const ca = geomCentroid(a);
    const cb = geomCentroid(b);
    const mapUnits = dist(ca, cb);
    return { mapUnits, meters: groundDistance(ca, cb), onA: ca, onB: cb, overlapping: false };
  }
  const closest = best as SegmentClosest;
  return {
    mapUnits: closest.dist,
    meters: groundDistance(closest.onA, closest.onB),
    onA: closest.onA,
    onB: closest.onB,
    overlapping: false,
  };
}

export interface DistanceResult {
  featureA_index: number;
  featureB_index: number;
  /** Ground distance in metres (spherical, same basis as the measure tool). */
  distance_meters: number;
  /** Planar distance in EPSG:3857 map units. */
  distance_map_units: number;
  distance_display: number;
  unit: DistanceUnit;
  /** The closest coordinate on each feature — a far better connector line than
   *  the vertex-average centres the panel used to draw. */
  closest_on_a: Coord;
  closest_on_b: Coord;
  overlapping: boolean;
}

function distanceResult(i: number, j: number, a: GeoGeom, b: GeoGeom, unit: DistanceUnit): DistanceResult {
  const cp = geomClosestPoints(a, b);
  return {
    featureA_index: i,
    featureB_index: j,
    distance_meters: cp.meters,
    distance_map_units: cp.mapUnits,
    distance_display: cp.meters / UNIT_TO_METERS[unit],
    unit,
    closest_on_a: cp.onA,
    closest_on_b: cp.onB,
    overlapping: cp.overlapping,
  };
}

export function computeDistances(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  unit: DistanceUnit
): DistanceResult[] {
  const results: DistanceResult[] = [];
  for (let i = 0; i < layerA.length; i++) {
    if (!layerA[i].geometry) continue;
    for (let j = 0; j < layerB.length; j++) {
      if (!layerB[j].geometry) continue;
      results.push(distanceResult(i, j, layerA[i].geometry!, layerB[j].geometry!, unit));
    }
  }
  return results;
}

/**
 * Distance with progress reporting and cancellation.
 *
 * NOTE: this tool reports the full Cartesian product (|A| × |B| pairs), exactly
 * as before. Stage 2 replaces the default with QGIS's k-nearest / nearest-hub
 * semantics; the index added here already prunes nothing, because every pair is
 * part of the output.
 */
export async function computeDistancesAsync(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  unit: DistanceUnit,
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<DistanceResult[]> {
  const results: DistanceResult[] = [];
  await progressLoop(
    layerA.length,
    progress,
    i => {
      const a = layerA[i].geometry;
      if (!a) return;
      for (let j = 0; j < layerB.length; j++) {
        const b = layerB[j].geometry;
        if (!b) continue;
        results.push(distanceResult(i, j, a, b, unit));
      }
    },
    onProgress,
    'Measuring distances'
  );
  return progress.cancelled ? [] : results;
}

// ---------------------------------------------------------------------------
// GeoJSON ↔ OL Feature conversion helpers
// ---------------------------------------------------------------------------

/** Extract GeoJSON features from an array of OL features. */
export function olFeaturesToGeo(olFeatures: any[]): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of olFeatures) {
    const geom = f.getGeometry?.();
    if (!geom) continue;
    const coords = geom.getCoordinates();
    const type = geom.getType();
    let geometry: GeoGeom | null = null;
    switch (type) {
      case 'Point':
        geometry = { type: 'Point', coordinates: coords };
        break;
      case 'MultiPoint':
        geometry = { type: 'MultiPoint', coordinates: coords };
        break;
      case 'LineString':
        geometry = { type: 'LineString', coordinates: coords };
        break;
      case 'MultiLineString':
        geometry = { type: 'MultiLineString', coordinates: coords };
        break;
      case 'Polygon':
        geometry = { type: 'Polygon', coordinates: coords };
        break;
      case 'MultiPolygon':
        geometry = { type: 'MultiPolygon', coordinates: coords };
        break;
      default:
        continue;
    }
    const props = f.getProperties ? f.getProperties() : {};
    // Remove OL internal properties
    delete props.geometry;
    result.push({ type: 'Feature' as const, geometry, properties: props });
  }
  return result;
}

/** Convert GeoJSON features to a GeoJSON FeatureCollection string. */
export function toGeoJSONString(features: GeoFeature[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

// ---------------------------------------------------------------------------
// Eliminate selected polygons — dissolve selected into neighbors
// ---------------------------------------------------------------------------

/**
 * Check if two polygon rings share at least one edge (two consecutive vertices
 * that are close enough). This is a simplified adjacency check.
 */
function ringsAdjacent(ring1: Ring, ring2: Ring, tolerance: number = MIN_COORD_TOLERANCE): boolean {
  // First check exact vertex matching (fast path for topologically clean data)
  for (let i = 0; i < ring1.length - 1; i++) {
    const a1 = ring1[i];
    const a2 = ring1[i + 1];
    for (let j = 0; j < ring2.length - 1; j++) {
      const b1 = ring2[j];
      const b2 = ring2[j + 1];
      // Check if edges match (in either direction)
      if ((coordsClose(a1, b1, tolerance) && coordsClose(a2, b2, tolerance)) ||
          (coordsClose(a1, b2, tolerance) && coordsClose(a2, b1, tolerance))) {
        return true;
      }
    }
  }
  // Fall back to proximity-based check: if any vertex of ring1 is within
  // tolerance of an edge of ring2 (or vice versa), they are adjacent.
  // This handles near-coincident boundaries from different data sources.
  // 0.5 map units ≈ 0.5 m at the equator and ~1 m at 60° latitude — a coarse
  // heuristic kept for compatibility; Stage 2 replaces it with a noded overlay.
  const proxTol = Math.max(tolerance, 0.5);
  for (let i = 0; i < ring1.length - 1; i++) {
    for (let j = 0; j < ring2.length - 1; j++) {
      if (pointToSegmentDist(ring1[i], ring2[j], ring2[j + 1]) < proxTol) return true;
      if (pointToSegmentDist(ring2[j], ring1[i], ring1[i + 1]) < proxTol) return true;
    }
  }
  return false;
}

/**
 * Check if two geometries are adjacent (share a boundary).
 */
function geometriesAdjacent(
  geom1: GeoGeom,
  geom2: GeoGeom,
  tolerance: number = MIN_COORD_TOLERANCE
): boolean {
  const rings1 = getExteriorRings(geom1);
  const rings2 = getExteriorRings(geom2);

  for (const r1 of rings1) {
    for (const r2 of rings2) {
      if (ringsAdjacent(r1, r2, tolerance)) return true;
    }
  }
  return false;
}

/**
 * A contiguous cyclic run of edge indices, or null when they are fragmented.
 */
function cyclicRun(n: number, indices: Set<number>): { start: number; length: number } | null {
  if (indices.size === 0 || indices.size >= n) return null;
  let start = -1;
  for (const i of indices) {
    if (!indices.has((i - 1 + n) % n)) { start = i; break; }
  }
  if (start < 0) return null;
  let length = 0;
  while (indices.has((start + length) % n)) length++;
  return length === indices.size ? { start, length } : null;
}

/**
 * Walk `ring` from index `from` to index `to` (both inclusive) in increasing
 * index order, refusing to cross any edge in `blocked`. Null when blocked.
 */
function cyclicWalk(ring: Ring, n: number, from: number, to: number, blocked: Set<number>): Coord[] | null {
  const path: Coord[] = [];
  let cur = from;
  for (let step = 0; step <= n; step++) {
    path.push(ring[cur]);
    if (cur === to) return path;
    if (blocked.has(cur)) return null; // edge cur → cur+1 is part of the contact
    cur = (cur + 1) % n;
  }
  return null;
}

function indexOfVertex(ring: Ring, target: Coord, tolerance: number): number {
  for (let i = 0; i < ring.length - 1; i++) {
    if (coordsClose(ring[i], target, tolerance)) return i;
  }
  return -1;
}

/**
 * Dissolve two polygons by removing the boundary they share.
 *
 * Rewritten. The previous version concatenated "poly1 minus the shared edge"
 * with "poly2 minus the shared edge", which discarded the edge's start vertex
 * and jumped straight across the pair: two edge-adjacent 10×10 squares merged
 * into a self-intersecting hexagon of area 150 instead of a 20×10 rectangle of
 * area 200 — a silent 25 % area loss in Dissolve, Union and Eliminate.
 *
 * The correct splice keeps both endpoints of the shared chain: walk poly2 from P
 * to Q along its unshared boundary, then walk poly1 from Q back to P along its
 * unshared boundary.
 *
 * Returns null when the pair is not a clean node-matched planar neighbour (edges
 * traversed in the same direction, more than one separate contact chain, or
 * unmatched chain endpoints), so the caller can fall back to `polygonUnion`.
 */
function dissolveTwoPolygons(poly1: Ring, poly2: Ring, tolerance: number = MIN_COORD_TOLERANCE): Ring | null {
  const n1 = poly1.length - 1;
  const n2 = poly2.length - 1;
  if (n1 < 3 || n2 < 3) return null;

  const shared1 = new Set<number>();
  const shared2 = new Set<number>();
  let opposite = true;
  for (let i = 0; i < n1; i++) {
    const a1 = poly1[i];
    const a2 = poly1[(i + 1) % n1];
    for (let j = 0; j < n2; j++) {
      const b1 = poly2[j];
      const b2 = poly2[(j + 1) % n2];
      const same = coordsClose(a1, b1, tolerance) && coordsClose(a2, b2, tolerance);
      const flipped = coordsClose(a1, b2, tolerance) && coordsClose(a2, b1, tolerance);
      if (!same && !flipped) continue;
      // Neighbours in a planar subdivision traverse a shared edge in opposite
      // directions. Same direction means both polygons lie on the same side of
      // it (overlap or non-noded input) and this splice does not apply.
      if (same) opposite = false;
      shared1.add(i);
      shared2.add(j);
    }
  }
  if (shared1.size === 0 || !opposite) return null;

  const run1 = cyclicRun(n1, shared1);
  const run2 = cyclicRun(n2, shared2);
  if (!run1 || !run2) return null;

  const P = poly1[run1.start];
  const Q = poly1[(run1.start + run1.length) % n1];

  const path1 = cyclicWalk(poly1, n1, (run1.start + run1.length) % n1, run1.start, shared1);
  if (!path1) return null;
  const pIdx = indexOfVertex(poly2, P, tolerance);
  const qIdx = indexOfVertex(poly2, Q, tolerance);
  if (pIdx < 0 || qIdx < 0) return null;
  const path2 = cyclicWalk(poly2, n2, pIdx, qIdx, shared2);
  if (!path2) return null;

  const merged = removeDuplicateConsecutive(closeRing([...path2, ...path1.slice(1)]));
  return merged.length >= 4 ? merged : null;
}

/**
 * Compute the total length of shared boundary between two polygon rings.
 * Sums the lengths of all edges that match (within tolerance) between the two rings.
 */
function computeSharedBoundaryLength(ring1: Ring, ring2: Ring, tolerance: number = MIN_COORD_TOLERANCE): number {
  let totalLen = 0;
  for (let i = 0; i < ring1.length - 1; i++) {
    const a1 = ring1[i];
    const a2 = ring1[i + 1];
    for (let j = 0; j < ring2.length - 1; j++) {
      const b1 = ring2[j];
      const b2 = ring2[j + 1];
      if ((coordsClose(a1, b1, tolerance) && coordsClose(a2, b2, tolerance)) ||
          (coordsClose(a1, b2, tolerance) && coordsClose(a2, b1, tolerance))) {
        totalLen += dist(a1, a2);
        break; // count this edge only once
      }
    }
  }
  return totalLen;
}

export type EliminateStrategy = 'largestArea' | 'smallestArea' | 'largestCommonBoundary';

/**
 * Eliminate selected polygons by dissolving each into an adjacent neighbor.
 *
 * For each selected polygon:
 * 1. Find all adjacent unselected polygons
 * 2. Pick the best neighbor according to `strategy`
 * 3. Dissolve the selected polygon into that neighbor
 * 4. The selected polygon disappears, its geometry is absorbed
 *
 * Returns the resulting features with selected polygons removed and their
 * geometry merged into neighbors.
 */
export interface EliminateResult {
  /** Surviving features, with absorbed geometry merged into neighbours. */
  features: GeoFeature[];
  /**
   * Indices of selected polygons that were removed *without* their area being
   * absorbed — either no adjacent neighbour, or the merge kernel could not splice
   * the boundaries. The panel surfaces these so area never disappears silently.
   * (Stage 2 replaces the single-shared-edge splice with a general union.)
   */
  droppedIndices: number[];
}

interface EliminateEntry {
  feature: GeoFeature;
  eliminated: boolean;
  extent: Extent4;
}

/**
 * Absorb one selected polygon into its best adjacent neighbour.
 * Returns true when the geometry was merged into a neighbour.
 */
function eliminateOne(
  working: EliminateEntry[],
  index: ExtentIndex<number>,
  i: number,
  strategy: EliminateStrategy,
  tolerance: number
): boolean {
  const selected = working[i];
  const selectedGeom = selected.feature.geometry;
  if (!selectedGeom) return false;
  const selectedParts = getPolygonParts(selectedGeom);
  if (selectedParts.length === 0) return false;

  // Candidate neighbours are pruned by extent before the O(rings²) adjacency test.
  interface Candidate { index: number; area: number; sharedBoundary: number }
  const candidates: Candidate[] = [];
  for (const j of index.query(selected.extent)) {
    if (j === i || working[j].eliminated) continue;
    const neighbourGeom = working[j].feature.geometry;
    if (!neighbourGeom) continue;
    if (!geometriesAdjacent(selectedGeom, neighbourGeom, tolerance)) continue;

    const neighbourParts = getPolygonParts(neighbourGeom);
    if (neighbourParts.length === 0) continue;

    let area = 0;
    for (const part of neighbourParts) area += Math.abs(signedArea(part.shell));
    const sharedBoundary = computeSharedBoundaryLength(
      selectedParts[0].shell,
      neighbourParts[0].shell,
      tolerance
    );
    candidates.push({ index: j, area, sharedBoundary });
  }
  if (candidates.length === 0) return false;

  let best = candidates[0];
  for (const c of candidates) {
    const better = strategy === 'smallestArea'
      ? c.area < best.area
      : strategy === 'largestCommonBoundary'
        ? c.sharedBoundary > best.sharedBoundary
        : c.area > best.area;
    if (better) best = c;
  }

  const neighbour = working[best.index];
  const neighbourGeom = neighbour.feature.geometry!;
  const neighbourParts = getPolygonParts(neighbourGeom);
  const merged = dissolveTwoPolygons(
    neighbourParts[0].shell,
    selectedParts[0].shell,
    tolerance
  );
  if (!merged) return false;

  const rings: Ring[] = [merged, ...neighbourParts[0].holes];
  if (neighbourGeom.type === 'Polygon') {
    neighbour.feature = { ...neighbour.feature, geometry: { type: 'Polygon', coordinates: rings } };
  } else if (neighbourGeom.type === 'MultiPolygon') {
    neighbour.feature = {
      ...neighbour.feature,
      geometry: {
        type: 'MultiPolygon',
        coordinates: [rings, ...neighbourGeom.coordinates.slice(1)],
      },
    };
  } else {
    return false;
  }
  neighbour.extent = extentOfCoords(merged);
  return true;
}

function prepareEliminate(allFeatures: GeoFeature[], selectedIndices: Set<number>): EliminateEntry[] {
  return allFeatures.map((f, i) => ({
    feature: { ...f, properties: { ...f.properties } },
    eliminated: selectedIndices.has(i),
    extent: featureExtent(f),
  }));
}

/**
 * Rebuilt per selected polygon: neighbours grow as they absorb, so a stale index
 * would miss candidates for later selections.
 */
function buildEliminateIndex(working: EliminateEntry[]): ExtentIndex<number> {
  const index = new ExtentIndex<number>();
  index.load(working.map(w => w.extent), working.map((_, i) => i));
  return index;
}

/**
 * Eliminate selected polygons by dissolving each into an adjacent neighbor.
 *
 * For each selected polygon:
 * 1. Find all adjacent unselected polygons (extent-pruned)
 * 2. Pick the best neighbor according to `strategy`
 * 3. Dissolve the selected polygon into that neighbor
 * 4. The selected polygon disappears, its geometry is absorbed
 *
 * The detailed variant also reports which selections could not be absorbed.
 */
export function eliminateSelectedPolygonsDetailed(
  allFeatures: GeoFeature[],
  selectedIndices: Set<number>,
  strategy: EliminateStrategy = 'largestArea'
): EliminateResult {
  if (selectedIndices.size === 0) {
    return { features: allFeatures.map(f => ({ ...f })), droppedIndices: [] };
  }
  const tolerance = toleranceForFeatures(allFeatures);
  const working = prepareEliminate(allFeatures, selectedIndices);
  const droppedIndices: number[] = [];
  for (let i = 0; i < working.length; i++) {
    if (!working[i].eliminated) continue;
    if (!eliminateOne(working, buildEliminateIndex(working), i, strategy, tolerance)) {
      droppedIndices.push(i);
    }
  }
  return {
    features: working.filter(w => !w.eliminated).map(w => w.feature),
    droppedIndices,
  };
}

/** Back-compatible entry point returning just the surviving features. */
export function eliminateSelectedPolygons(
  allFeatures: GeoFeature[],
  selectedIndices: Set<number>,
  strategy: EliminateStrategy = 'largestArea'
): GeoFeature[] {
  return eliminateSelectedPolygonsDetailed(allFeatures, selectedIndices, strategy).features;
}

/** Eliminate with progress reporting and cancellation. */
export async function eliminateSelectedPolygonsAsync(
  allFeatures: GeoFeature[],
  selectedIndices: Set<number>,
  strategy: EliminateStrategy = 'largestArea',
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<EliminateResult> {
  if (selectedIndices.size === 0) {
    return { features: allFeatures.map(f => ({ ...f })), droppedIndices: [] };
  }
  const tolerance = toleranceForFeatures(allFeatures);
  const working = prepareEliminate(allFeatures, selectedIndices);
  const droppedIndices: number[] = [];
  const targets: number[] = [];
  for (let i = 0; i < working.length; i++) if (working[i].eliminated) targets.push(i);

  await progressLoop(
    targets.length,
    progress,
    k => {
      const i = targets[k];
      if (!eliminateOne(working, buildEliminateIndex(working), i, strategy, tolerance)) {
        droppedIndices.push(i);
      }
    },
    onProgress,
    'Eliminating'
  );
  if (progress.cancelled) return { features: [], droppedIndices: [] };
  return {
    features: working.filter(w => !w.eliminated).map(w => w.feature),
    droppedIndices,
  };
}

// ---------------------------------------------------------------------------
// Geometry Tools — QGIS-style geometry operations
// ---------------------------------------------------------------------------

// ---- Check Validity -------------------------------------------------------

export interface ValidityResult {
  feature: GeoFeature;
  valid: boolean;
  reason: string;
}

/**
 * Check polygon validity: ring must have ≥4 points, must be closed,
 * must not self-intersect (simple ring check).
 */
function isRingValid(
  ring: Ring,
  tolerance: number = MIN_COORD_TOLERANCE
): { valid: boolean; reason: string } {
  if (ring.length < 4) return { valid: false, reason: 'Ring has fewer than 4 points.' };
  // Closure is tested to within the dataset tolerance: EPSG:3857 coordinates are
  // ~1e7, where a bit-exact comparison flags rings that are closed for any
  // practical purpose.
  if (!isRingClosed(ring, tolerance)) return { valid: false, reason: 'Ring is not closed.' };
  // Simple self-intersection check: no two non-adjacent edges may cross
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent at wrap
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) {
        return { valid: false, reason: 'Ring self-intersects.' };
      }
    }
  }
  return { valid: true, reason: 'Valid.' };
}

function segmentsIntersect(a1: Coord, a2: Coord, b1: Coord, b2: Coord): boolean {
  const d1 = cross2d(b1, b2, a1);
  const d2 = cross2d(b1, b2, a2);
  const d3 = cross2d(a1, a2, b1);
  const d4 = cross2d(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

export function checkValidity(
  features: GeoFeature[],
  tolerance: number = MIN_COORD_TOLERANCE
): ValidityResult[] {
  const results: ValidityResult[] = [];
  for (const f of features) {
    if (!f.geometry) {
      results.push({ feature: f, valid: false, reason: 'Null geometry.' });
      continue;
    }
    const parts = getPolygonParts(f.geometry);
    if (parts.length === 0) {
      // Points and lines have no ring topology to validate.
      // KNOWN LIMITATION (Stage 2): the GEOS error classes are not covered yet —
      // hole outside shell, nested holes, disconnected interior, duplicate rings
      // and NaN coordinates all still report "Valid." here.
      results.push({ feature: f, valid: true, reason: 'Valid.' });
      continue;
    }
    let allValid = true;
    let reason = 'Valid.';
    for (let pi = 0; pi < parts.length && allValid; pi++) {
      const labelled: Array<[string, Ring]> = [['shell', parts[pi].shell]];
      parts[pi].holes.forEach((hole, hi) => labelled.push([`hole ${hi + 1}`, hole]));
      for (const [label, ring] of labelled) {
        const check = isRingValid(ring, tolerance);
        if (!check.valid) {
          allValid = false;
          // Name the offending ring so a multi-part or donut feature is diagnosable.
          reason = parts.length === 1 && label === 'shell'
            ? check.reason
            : `Part ${pi + 1} ${label}: ${check.reason}`;
          break;
        }
      }
    }
    results.push({ feature: f, valid: allValid, reason });
  }
  return results;
}

// ---- Collect Geometries ---------------------------------------------------

/**
 * Merge all features into a single feature with a multi-geometry
 * (MultiPoint, MultiLineString, or MultiPolygon).
 */
export function collectGeometries(features: GeoFeature[]): GeoFeature[] {
  if (features.length === 0) return [];

  const geomTypes = new Set<string>();
  for (const f of features) {
    if (!f.geometry) continue;
    if (f.geometry.type.startsWith('Multi')) {
      geomTypes.add(f.geometry.type);
    } else {
      // Map single → multi
      const multi = 'Multi' + f.geometry.type;
      geomTypes.add(multi);
    }
  }

  if (geomTypes.size === 0) return [];

  // If mixed geometry types, return as-is in a single feature with the dominant type
  // For simplicity, collect by type
  const allPoints: Coord[] = [];
  const allLines: Coord[][] = [];
  const allPolys: Ring[][] = [];

  for (const f of features) {
    if (!f.geometry) continue;
    switch (f.geometry.type) {
      case 'Point': allPoints.push(f.geometry.coordinates); break;
      case 'MultiPoint': allPoints.push(...f.geometry.coordinates); break;
      case 'LineString': allLines.push(f.geometry.coordinates); break;
      case 'MultiLineString': allLines.push(...f.geometry.coordinates); break;
      case 'Polygon': allPolys.push(f.geometry.coordinates); break;
      case 'MultiPolygon': allPolys.push(...f.geometry.coordinates); break;
    }
  }

  const resultGeoms: GeoGeom[] = [];
  if (allPoints.length > 0) {
    resultGeoms.push(allPoints.length === 1
      ? { type: 'Point', coordinates: allPoints[0] }
      : { type: 'MultiPoint', coordinates: allPoints });
  }
  if (allLines.length > 0) {
    resultGeoms.push(allLines.length === 1
      ? { type: 'LineString', coordinates: allLines[0] }
      : { type: 'MultiLineString', coordinates: allLines });
  }
  if (allPolys.length > 0) {
    resultGeoms.push(allPolys.length === 1
      ? { type: 'Polygon', coordinates: allPolys[0] }
      : { type: 'MultiPolygon', coordinates: allPolys });
  }

  if (resultGeoms.length === 1) {
    return [{ type: 'Feature', geometry: resultGeoms[0], properties: {} }];
  }
  return resultGeoms.map(g => ({ type: 'Feature' as const, geometry: g, properties: {} }));
}

// ---- Delaunay Triangulation -----------------------------------------------

/**
 * Simple Bowyer-Watson Delaunay triangulation on input points.
 * Returns triangle polygons.
 */
/**
 * Incremental Bowyer-Watson state.
 *
 * Split out of the one-shot function so the triangulation can be driven in
 * chunks: `delaunayTriangulationAsync` inserts a few points, yields to the event
 * loop, reports progress and stays cancellable.
 */
interface DelaunayState {
  insert(pt: Coord): void;
  /** Triangle polygons, with everything touching the super-triangle removed. */
  finish(): GeoFeature[];
}

/** A seed vertex plus the feature it came from. */
interface SeedPoint {
  point: Coord;
  featureIndex: number;
}

/**
 * Unique vertices of the input, in first-seen order, each remembering its source
 * feature. Voronoi needs the mapping to copy attributes onto cells; Delaunay
 * only wants the coordinates.
 */
function collectSeedPoints(features: GeoFeature[]): SeedPoint[] {
  const seeds: SeedPoint[] = [];
  for (let i = 0; i < features.length; i++) {
    const geom = features[i].geometry;
    if (!geom) continue;
    for (const c of collectCoords(geom)) {
      // Avoid exact duplicates (a snapping tolerance is Stage 2 work).
      if (!seeds.some(s => s.point[0] === c[0] && s.point[1] === c[1])) {
        seeds.push({ point: c, featureIndex: i });
      }
    }
  }
  return seeds;
}

function collectTriangulationPoints(features: GeoFeature[]): Coord[] {
  return collectSeedPoints(features).map(s => s.point);
}

function createDelaunayState(points: Coord[]): DelaunayState | null {
  if (points.length < 3) return null;

  // Super triangle that encompasses all points.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const dmax = Math.max(maxX - minX, maxY - minY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const st: [Coord, Coord, Coord] = [
    [midX - 20 * dmax, midY - dmax],
    [midX, midY + 20 * dmax],
    [midX + 20 * dmax, midY - dmax],
  ];

  let triangles: Triangle[] = [{ a: st[0], b: st[1], c: st[2] }];

  return {
    insert(pt: Coord) {
      const bad: Triangle[] = [];
      for (const t of triangles) if (circumcircleContains(t, pt)) bad.push(t);

      // Boundary edges of the cavity are those used by exactly one bad triangle.
      const edgeCount = new Map<string, { edge: [Coord, Coord]; count: number }>();
      for (const t of bad) {
        const edges: [Coord, Coord][] = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
        for (const e of edges) {
          const key = edgeKey(e[0], e[1]);
          const existing = edgeCount.get(key);
          if (existing) existing.count++;
          else edgeCount.set(key, { edge: e, count: 1 });
        }
      }

      triangles = triangles.filter(t => !bad.includes(t));
      for (const v of Array.from(edgeCount.values())) {
        if (v.count === 1) triangles.push({ a: v.edge[0], b: v.edge[1], c: pt });
      }
    },

    finish(): GeoFeature[] {
      const stSet = new Set(st.map(p => `${p[0]},${p[1]}`));
      const result: GeoFeature[] = [];
      for (const t of triangles) {
        if (stSet.has(`${t.a[0]},${t.a[1]}`) ||
            stSet.has(`${t.b[0]},${t.b[1]}`) ||
            stSet.has(`${t.c[0]},${t.c[1]}`)) continue;
        result.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[t.a, t.b, t.c, t.a]] },
          properties: {},
        });
      }
      return result;
    },
  };
}

type Triangle = { a: Coord; b: Coord; c: Coord };

/** Order-independent key for an undirected edge. */
function edgeKey(a: Coord, b: Coord): string {
  return `${Math.min(a[0], b[0])},${Math.min(a[1], b[1])}-${Math.max(a[0], b[0])},${Math.max(a[1], b[1])}`;
}

function circumcircleContains(t: Triangle, p: Coord): boolean {
  const ax = t.a[0] - p[0], ay = t.a[1] - p[1];
  const bx = t.b[0] - p[0], by = t.b[1] - p[1];
  const cx = t.c[0] - p[0], cy = t.c[1] - p[1];
  const det = (ax * ax + ay * ay) * (bx * cy - cx * by)
            - (bx * bx + by * by) * (ax * cy - cx * ay)
            + (cx * cx + cy * cy) * (ax * by - bx * ay);
  // For CCW triangles, det > 0 means inside.
  const orient = (t.b[0] - t.a[0]) * (t.c[1] - t.a[1]) - (t.b[1] - t.a[1]) * (t.c[0] - t.a[0]);
  return orient > 0 ? det > 0 : det < 0;
}

/**
 * Simple Bowyer-Watson Delaunay triangulation on input points.
 * Returns triangle polygons.
 *
 * KNOWN LIMITATION (Stage 2): no snapping tolerance for near-coincident points
 * (QGIS/PostGIS both expose one) and no "create edges instead of polygons" mode;
 * the floating-point incircle test is also fragile for cocircular points.
 */
export function delaunayTriangulation(features: GeoFeature[]): GeoFeature[] {
  const points = collectTriangulationPoints(features);
  const state = createDelaunayState(points);
  if (!state) return [];
  for (const pt of points) state.insert(pt);
  return state.finish();
}

/** Delaunay with progress reporting and cancellation. */
export async function delaunayTriangulationAsync(
  features: GeoFeature[],
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const points = collectTriangulationPoints(features);
  const state = createDelaunayState(points);
  if (!state) return [];
  const ok = await progressLoop(
    points.length,
    progress,
    i => state.insert(points[i]),
    onProgress,
    'Triangulating'
  );
  return ok ? state.finish() : [];
}

// ---- Densify by Count -----------------------------------------------------

/**
 * Add `count` evenly-spaced vertices along each segment of lines/polygons.
 */
export function densifyByCount(features: GeoFeature[], count: number): GeoFeature[] {
  if (count < 1) return features.map(f => ({ ...f }));

  function densifyRing(ring: Ring): Ring {
    const result: Ring = [];
    for (let i = 0; i < ring.length - 1; i++) {
      result.push(ring[i]);
      for (let j = 1; j <= count; j++) {
        const t = j / (count + 1);
        result.push([
          ring[i][0] + t * (ring[i + 1][0] - ring[i][0]),
          ring[i][1] + t * (ring[i + 1][1] - ring[i][1]),
        ]);
      }
    }
    result.push(ring[ring.length - 1]);
    return result;
  }

  function densifyLine(coords: Coord[]): Coord[] {
    const result: Coord[] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      result.push(coords[i]);
      for (let j = 1; j <= count; j++) {
        const t = j / (count + 1);
        result.push([
          coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
          coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
        ]);
      }
    }
    result.push(coords[coords.length - 1]);
    return result;
  }

  return features.map(f => {
    if (!f.geometry) return f;
    let geometry: GeoGeom;
    switch (f.geometry.type) {
      case 'LineString':
        geometry = { type: 'LineString', coordinates: densifyLine(f.geometry.coordinates) };
        break;
      case 'MultiLineString':
        geometry = { type: 'MultiLineString', coordinates: f.geometry.coordinates.map(densifyLine) };
        break;
      case 'Polygon':
        geometry = {
          type: 'Polygon',
          coordinates: f.geometry.coordinates.map(densifyRing),
        };
        break;
      case 'MultiPolygon':
        geometry = {
          type: 'MultiPolygon',
          coordinates: f.geometry.coordinates.map(poly => poly.map(densifyRing)),
        };
        break;
      default:
        geometry = f.geometry;
    }
    return { type: 'Feature' as const, geometry, properties: { ...f.properties } };
  });
}

// ---- Add Geometry Attributes ----------------------------------------------

export interface GeometryAttrOptions {
  addArea: boolean;
  addLength: boolean;
  addX: boolean;
  addY: boolean;
  addPerimeter: boolean;
}

/**
 * Add geometry-derived attributes (area, length, perimeter, x, y) to features.
 */
export function addGeometryAttributes(
  features: GeoFeature[],
  options: GeometryAttrOptions
): GeoFeature[] {
  return features.map(f => {
    if (!f.geometry) return f;
    const props = { ...f.properties };
    const parts = getPolygonParts(f.geometry);

    if (options.addArea) {
      // Spherical ground area in m² with holes subtracted — the same value the
      // on-map measure tool reports (both trace back to ol/sphere.getArea).
      // Replaces the planar shoelace area divided by cosh²(ȳ) at a single mean
      // latitude, which also *added* hole areas instead of subtracting them.
      props.area = parts.length > 0 ? Math.max(0, groundPolygonArea(parts)) : 0;
    }

    if (options.addLength) {
      if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
        const lines = f.geometry.type === 'LineString'
          ? [f.geometry.coordinates]
          : f.geometry.coordinates;
        props.length = lines.reduce((sum, line) => sum + groundLineLength(line), 0);
      } else if (parts.length > 0) {
        props.length = groundPolygonPerimeter(parts);
      }
    }

    if (options.addPerimeter) {
      props.perimeter = parts.length > 0 ? groundPolygonPerimeter(parts) : 0;
    }

    if (options.addX || options.addY) {
      // KNOWN LIMITATION (Stage 2): x/y are EPSG:3857 metres, not lon/lat as
      // QGIS's Add Geometry Attributes reports for a geographic CRS.
      const c = geomCentroid(f.geometry);
      if (options.addX) props.x = c[0];
      if (options.addY) props.y = c[1];
    }

    return { type: 'Feature' as const, geometry: f.geometry, properties: props };
  });
}

// ---- Extract Vertices -----------------------------------------------------

/**
 * Extract all vertices from line/polygon features as point features.
 */
export function extractVertices(features: GeoFeature[]): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    // Holes are geometry too — their vertices used to be skipped entirely.
    // (QGIS also writes vertex_index / vertex_part attributes; that is Stage 2.)
    const coords = collectCoords(f.geometry, { includeHoles: true });
    for (const c of coords) {
      result.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c },
        properties: { ...f.properties },
      });
    }
  }
  return result;
}

// ---- Multipart to Singleparts ---------------------------------------------

/**
 * Split multi-geometries into individual single-geometry features.
 */
export function multipartToSingleparts(features: GeoFeature[]): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) {
      result.push(f);
      continue;
    }
    switch (f.geometry.type) {
      case 'MultiPoint':
        for (const c of f.geometry.coordinates) {
          result.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { ...f.properties } });
        }
        break;
      case 'MultiLineString':
        for (const line of f.geometry.coordinates) {
          result.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { ...f.properties } });
        }
        break;
      case 'MultiPolygon':
        for (const poly of f.geometry.coordinates) {
          result.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { ...f.properties } });
        }
        break;
      default:
        result.push(f);
    }
  }
  return result;
}

// ---- Polygons to Lines ----------------------------------------------------

/**
 * Convert polygon boundaries to line features.
 */
export function polygonsToLines(features: GeoFeature[]): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const rings = getAllPolygonRings(f.geometry);
    for (const ring of rings) {
      // Remove closing point for LineString
      const line = ring.length > 0 && ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
        ? ring.slice(0, -1)
        : ring;
      result.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: line },
        properties: { ...f.properties },
      });
    }
  }
  return result;
}

// ---- Simplify (Douglas-Peucker) -------------------------------------------

function douglasPeucker(coords: Coord[], tolerance: number): Coord[] {
  if (coords.length <= 2) return coords.slice();

  let maxDist = 0;
  let maxIdx = 0;
  const first = coords[0];
  const last = coords[coords.length - 1];

  for (let i = 1; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(coords[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(coords.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(coords.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/**
 * Simplify geometries using Douglas-Peucker algorithm.
 */
export function simplifyFeatures(features: GeoFeature[], tolerance: number): GeoFeature[] {
  if (tolerance <= 0) return features.map(f => ({ ...f }));

  function simplifyRing(ring: Ring): Ring {
    const simplified = douglasPeucker(ring.slice(0, -1), tolerance);
    if (simplified.length < 3) return ring; // keep original if too few points
    simplified.push(simplified[0]);
    return simplified;
  }

  function simplifyLine(coords: Coord[]): Coord[] {
    return douglasPeucker(coords, tolerance);
  }

  return features.map(f => {
    if (!f.geometry) return f;
    let geometry: GeoGeom;
    switch (f.geometry.type) {
      case 'LineString':
        geometry = { type: 'LineString', coordinates: simplifyLine(f.geometry.coordinates) };
        break;
      case 'MultiLineString':
        geometry = { type: 'MultiLineString', coordinates: f.geometry.coordinates.map(simplifyLine) };
        break;
      case 'Polygon':
        geometry = { type: 'Polygon', coordinates: f.geometry.coordinates.map(simplifyRing) };
        break;
      case 'MultiPolygon':
        geometry = { type: 'MultiPolygon', coordinates: f.geometry.coordinates.map(poly => poly.map(simplifyRing)) };
        break;
      default:
        geometry = f.geometry;
    }
    return { type: 'Feature' as const, geometry, properties: { ...f.properties } };
  });
}

// ---- Voronoi Polygons -----------------------------------------------------

/**
 * Create Voronoi polygons from input points.
 * Uses a simple approach: for each point, compute the intersection of
 * half-planes defined by perpendicular bisectors with all other points.
 * Bounded by the extent of all input points (with padding).
 */
/** Bounding box of the seeds, padded by `padFraction` of its own size per side. */
function voronoiBounds(points: Coord[], padFraction: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const padX = (maxX - minX) * padFraction;
  const padY = (maxY - minY) * padFraction;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

/**
 * One Voronoi cell: the padded bounding box clipped by the half-plane of every
 * perpendicular bisector against the other seeds.
 */
/**
 * @param points   seed coordinates (hoisted out of the caller's loop)
 * @param i        index of this cell's seed
 * @param seed     the seed itself, so its source feature can be looked up
 */
function voronoiCell(
  points: Coord[],
  i: number,
  seed: SeedPoint,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  features: GeoFeature[],
  copyAttributes: boolean
): GeoFeature | null {
  const pi = points[i];
  let cell: Ring = [
    [bounds.minX, bounds.minY], [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY], [bounds.minX, bounds.minY],
  ];

  for (let j = 0; j < points.length; j++) {
    if (i === j) continue;
    const pj = points[j];
    const mx = (pi[0] + pj[0]) / 2;
    const my = (pi[1] + pj[1]) / 2;
    const dx = pj[0] - pi[0];
    const dy = pj[1] - pi[1];
    // Keep pi's side of the bisector: a point p is on pi's side when
    // (p − midpoint) · (dx, dy) < 0, where (dx, dy) points from pi to pj.
    //
    // `clipEdgeByLine` keeps the half-plane where cross(edgeEnd − edgeStart,
    // p − edgeStart) ≥ 0, and cross((dy, −dx), v) = +(dx, dy) · v. The endpoints
    // therefore have to be ordered so the edge direction is (−dy, dx), which
    // negates the dot product. They were the other way round, so every cell was
    // built for the mirror-image seed: symmetric inputs looked right, but an
    // off-centre seed lost its cell and every attribute was attached to the
    // wrong point.
    const edgeStart: Coord = [mx + dy * 1000, my - dx * 1000];
    const edgeEnd: Coord = [mx - dy * 1000, my + dx * 1000];
    cell = clipEdgeByLine(cell, edgeStart, edgeEnd);
    if (cell.length < 3) return null;
  }
  if (cell.length < 4) return null;

  const closed = closeRing(cell);
  // Seeds carry their source feature, so a multi-vertex input feature contributes
  // several cells that all copy the same attributes (QGIS's "Copy attributes from
  // input features"). Deduped seeds must not be mapped by position.
  const source = copyAttributes ? features[seed.featureIndex] : undefined;
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [closed] },
    properties: source ? { ...source.properties } : {},
  };
}

export interface VoronoiOptions {
  /**
   * How far beyond the seeds' extent the cells are allowed to reach, as a
   * fraction of the extent size (0.5 = 50 % padding per side, the historical
   * behaviour). QGIS exposes this as "Buffer region (%)".
   */
  padFraction?: number;
  /**
   * Copy the attributes of the feature each seed came from onto its cell.
   * Off by default to preserve the historical empty-properties output.
   */
  copyAttributes?: boolean;
}

/**
 * Create Voronoi polygons from input points.
 * For each point, the cell is the intersection of the half-planes defined by the
 * perpendicular bisectors with all other points, bounded by the padded extent.
 *
 * KNOWN LIMITATION (Stage 2): O(n²) half-plane clipping rather than the
 * O(n log n) Voronoi-from-Delaunay duality GEOS uses.
 */
export function voronoiPolygons(features: GeoFeature[], options: VoronoiOptions = {}): GeoFeature[] {
  const seeds = collectSeedPoints(features);
  if (seeds.length < 2) return [];
  const points = seeds.map(s => s.point);
  const bounds = voronoiBounds(points, options.padFraction ?? 0.5);
  if (!bounds) return [];
  const result: GeoFeature[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const cell = voronoiCell(points, i, seeds[i], bounds, features, options.copyAttributes === true);
    if (cell) result.push(cell);
  }
  return result;
}

/** Voronoi with progress reporting and cancellation. */
export async function voronoiPolygonsAsync(
  features: GeoFeature[],
  options: VoronoiOptions = {},
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const seeds = collectSeedPoints(features);
  if (seeds.length < 2) return [];
  const points = seeds.map(s => s.point);
  const bounds = voronoiBounds(points, options.padFraction ?? 0.5);
  if (!bounds) return [];
  const result: GeoFeature[] = [];
  const ok = await progressLoop(
    seeds.length,
    progress,
    i => {
      const cell = voronoiCell(points, i, seeds[i], bounds, features, options.copyAttributes === true);
      if (cell) result.push(cell);
    },
    onProgress,
    'Building Voronoi cells'
  );
  return ok ? result : [];
}

// ---- Lines to Polygons ----------------------------------------------------

/**
 * Convert closed line features to polygons.
 * Lines that are not closed (first ≠ last point) are skipped.
 */
export function linesToPolygons(
  features: GeoFeature[],
  tolerance: number = MIN_COORD_TOLERANCE
): GeoFeature[] {
  const result: GeoFeature[] = [];
  const convert = (coords: Coord[], properties: Record<string, any>) => {
    // Open lines are skipped, exactly as QGIS's Lines to polygons does.
    if (coords.length < 4 || !isRingClosed(coords, tolerance)) return;
    result.push({
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [closeRing(coords)] },
      properties: { ...properties },
    });
  };
  for (const f of features) {
    if (!f.geometry) continue;
    if (f.geometry.type === 'LineString') {
      convert(f.geometry.coordinates, f.properties);
    } else if (f.geometry.type === 'MultiLineString') {
      for (const line of f.geometry.coordinates) convert(line, f.properties);
    }
  }
  return result;
}

// ---- Make Valid -----------------------------------------------------------

/**
 * Attempt to fix invalid polygon geometries:
 * - Ensure rings are closed
 * - Ensure outer ring is CCW, holes are CW
 * - Remove degenerate rings (< 4 points)
 * - Remove self-intersections by splitting rings at intersection points
 *   (simplified: just re-order vertices to remove obvious crossings)
 * - Remove duplicate consecutive vertices
 *
 * Non-polygon geometries are passed through unchanged.
 */
export function makeValid(features: GeoFeature[]): GeoFeature[] {
  return features.map(f => {
    if (!f.geometry) return f;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') return f;

    const fixedGeom = fixPolygonGeometry(f.geometry);
    return { type: 'Feature' as const, geometry: fixedGeom, properties: { ...f.properties, was_invalid: true } };
  });
}

function removeDuplicateConsecutive(ring: Ring): Ring {
  if (ring.length < 2) return ring;
  const result: Ring = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const prev = result[result.length - 1];
    const cur = ring[i];
    if (prev[0] !== cur[0] || prev[1] !== cur[1]) {
      result.push(cur);
    }
  }
  // Ensure closed
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      result.push(first);
    }
  }
  return result;
}

function fixRingOrientation(ring: Ring): Ring {
  // Outer ring should be CCW (positive signed area)
  const area = signedArea(ring);
  if (area < 0) return ring.slice().reverse();
  return ring;
}

function fixHoleOrientation(ring: Ring): Ring {
  // Holes should be CW (negative signed area)
  const area = signedArea(ring);
  if (area > 0) return ring.slice().reverse();
  return ring;
}

/**
 * Fix self-intersecting ring by finding intersection points and splitting
 * into multiple simple rings. Falls back to polar-angle sort for star-shaped
 * polygons when no clean split is possible.
 *
 * Returns an array of simple (non-self-intersecting) rings.
 */
function fixSelfIntersectionMulti(ring: Ring): Ring[] {
  const n = ring.length - 1; // exclude closing vertex
  if (n < 4) return [ring];

  // Find all self-intersection points between non-adjacent edges
  interface Intersection {
    seg1: number;
    seg2: number;
    point: Coord;
  }
  const intersections: Intersection[] = [];

  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // Skip adjacent edges (they share a vertex by construction)
      if (i === 0 && j === n - 1) continue;
      const b1 = ring[j], b2 = ring[(j + 1) % n];

      // Compute intersection of segments (a1,a2) and (b1,b2)
      const dax = a2[0] - a1[0], day = a2[1] - a1[1];
      const dbx = b2[0] - b1[0], dby = b2[1] - b1[1];
      const denom = dax * dby - day * dbx;
      if (Math.abs(denom) < 1e-12) continue; // parallel

      const t1 = ((b1[0] - a1[0]) * dby - (b1[1] - a1[1]) * dbx) / denom;
      const t2 = ((b1[0] - a1[0]) * day - (b1[1] - a1[1]) * dax) / denom;

      // Intersection must be strictly interior to both segments
      const EPS = 1e-9;
      if (t1 > EPS && t1 < 1 - EPS && t2 > EPS && t2 < 1 - EPS) {
        intersections.push({
          seg1: i, seg2: j,
          point: [a1[0] + t1 * dax, a1[1] + t1 * day],
        });
      }
    }
  }

  if (intersections.length === 0) {
    // No interior intersections found — ring is already simple
    return [ring];
  }

  // If we have exactly two intersection points, split the ring into two
  // simple sub-rings at those points.
  if (intersections.length === 2) {
    const [iA, iB] = intersections;
    const first = iA.seg1 < iB.seg1 ? iA : iB;
    const second = iA.seg1 < iB.seg1 ? iB : iA;

    // Build ring A: first intersection → along ring → second intersection → close
    const ringA: Ring = [first.point];
    for (let k = first.seg1 + 1; k <= second.seg1; k++) {
      ringA.push(ring[k]);
    }
    ringA.push(second.point);
    ringA.push(first.point); // close

    // Build ring B: second intersection → along ring → first intersection → close
    const ringB: Ring = [second.point];
    for (let k = second.seg1 + 1; k < n; k++) {
      ringB.push(ring[k]);
    }
    for (let k = 0; k <= first.seg1; k++) {
      ringB.push(ring[k]);
    }
    ringB.push(first.point);
    ringB.push(second.point); // close

    const validRings: Ring[] = [];
    for (const r of [ringA, ringB]) {
      if (r.length >= 4 && Math.abs(signedArea(r)) > 1e-10) {
        validRings.push(r);
      }
    }
    if (validRings.length > 0) return validRings;
  }

  // For more complex self-intersections (>2 intersection points),
  // fall back to the polar-angle sort (works for star-shaped polygons)
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += ring[i][0]; cy += ring[i][1]; }
  cx /= n; cy /= n;

  const sorted = ring.slice(0, n).sort((a, b) => {
    const angleA = Math.atan2(a[1] - cy, a[0] - cx);
    const angleB = Math.atan2(b[1] - cy, b[0] - cx);
    return angleA - angleB;
  });
  sorted.push(sorted[0]);
  return [sorted];
}

/**
 * Self-intersection fix: uses multi-ring splitting when possible,
 * falls back to polar-angle sort for star-shaped polygons.
 */
function fixSelfIntersection(ring: Ring): Ring {
  const check = isRingValid(ring);
  if (check.valid) return ring;

  const rings = fixSelfIntersectionMulti(ring);
  // Return the largest ring (by area) as the primary result
  let best = rings[0];
  let bestArea = Math.abs(signedArea(best));
  for (let i = 1; i < rings.length; i++) {
    const a = Math.abs(signedArea(rings[i]));
    if (a > bestArea) { best = rings[i]; bestArea = a; }
  }
  return best;
}

function fixPolygonGeometry(geom: GeoGeom): GeoGeom {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates;
    const fixedRings: Ring[] = [];

    for (let i = 0; i < rings.length; i++) {
      let ring = rings[i];
      ring = removeDuplicateConsecutive(ring);
      if (ring.length < 4) continue; // skip degenerate
      ring = fixSelfIntersection(ring);
      ring = removeDuplicateConsecutive(ring);
      if (ring.length < 4) continue;
      if (i === 0) {
        ring = fixRingOrientation(ring);
      } else {
        ring = fixHoleOrientation(ring);
      }
      fixedRings.push(ring);
    }

    if (fixedRings.length === 0) {
      // Fallback: return original if everything was degenerate
      return geom;
    }
    return { type: 'Polygon', coordinates: fixedRings };
  }

  if (geom.type === 'MultiPolygon') {
    const fixedPolys: Ring[][] = [];
    for (const poly of geom.coordinates) {
      const fixedGeom = fixPolygonGeometry({ type: 'Polygon', coordinates: poly });
      if (fixedGeom.type === 'Polygon') {
        fixedPolys.push(fixedGeom.coordinates);
      }
    }
    if (fixedPolys.length === 0) return geom;
    if (fixedPolys.length === 1) return { type: 'Polygon', coordinates: fixedPolys[0] };
    return { type: 'MultiPolygon', coordinates: fixedPolys };
  }

  return geom;
}

// ---------------------------------------------------------------------------
// Merge Vector Layers — combine multiple layers into one with unified schema
// ---------------------------------------------------------------------------

/**
 * Merge features from multiple layers into a single feature collection.
 * All field names across all layers are collected; features missing a field get
 * an explicit `null` so the output schema stays rectangular (QGIS's Merge
 * behaviour). It used to be `undefined`, which `JSON.stringify` drops outright —
 * the field then vanished from the feature instead of reading as empty.
 */
export function mergeVectorLayers(layerFeatures: GeoFeature[][]): GeoFeature[] {
  if (layerFeatures.length === 0) return [];
  if (layerFeatures.length === 1) return layerFeatures[0].map(f => ({ ...f, properties: { ...f.properties } }));

  // Collect all unique field names across all layers (preserve order of first appearance)
  const allFields: string[] = [];
  const fieldSet = new Set<string>();
  for (const layer of layerFeatures) {
    for (const f of layer) {
      if (!f.properties) continue;
      for (const key of Object.keys(f.properties)) {
        if (!fieldSet.has(key)) {
          fieldSet.add(key);
          allFields.push(key);
        }
      }
    }
  }

  const result: GeoFeature[] = [];
  for (const layer of layerFeatures) {
    for (const f of layer) {
      // Build a properties object with all fields, filling missing ones with undefined
      const unifiedProps: Record<string, any> = {};
      for (const field of allFields) {
        const value = f.properties?.[field];
        unifiedProps[field] = value === undefined ? null : value;
      }
      result.push({
        type: 'Feature' as const,
        geometry: f.geometry ? { ...f.geometry } : null,
        properties: unifiedProps,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Split Vector Layer — split one layer into multiple layers by a unique field
// ---------------------------------------------------------------------------

export interface SplitLayerResult {
  /** Name for the output layer (field value). */
  name: string;
  /** Features belonging to this split group. */
  features: GeoFeature[];
}

/**
 * Split features into groups by the value of a chosen field.
 * Each unique value becomes one output layer.
 * Null/undefined values are grouped under "_no_value_".
 */
export function splitVectorLayer(features: GeoFeature[], fieldName: string): SplitLayerResult[] {
  const groups = new Map<string, GeoFeature[]>();

  for (const f of features) {
    const rawValue = f.properties?.[fieldName];
    let key: string;
    if (rawValue === undefined || rawValue === null) {
      key = '_no_value_';
    } else if (typeof rawValue === 'object') {
      try { key = JSON.stringify(rawValue); } catch { key = String(rawValue); }
    } else {
      key = String(rawValue);
    }

    const existing = groups.get(key);
    if (existing) {
      existing.push({ type: 'Feature' as const, geometry: f.geometry ? { ...f.geometry } : null, properties: { ...f.properties } });
    } else {
      groups.set(key, [{ type: 'Feature' as const, geometry: f.geometry ? { ...f.geometry } : null, properties: { ...f.properties } }]);
    }
  }

  const results: SplitLayerResult[] = [];
  for (const entry of Array.from(groups.entries())) {
    const [name, feats] = entry;
    results.push({ name: name === '_no_value_' ? '(no value)' : name, features: feats });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Remove Selected Features — create a new layer with specified features removed
// ---------------------------------------------------------------------------

/**
 * Return a copy of `features` with the features at the given 0-based indices
 * removed. Used by the "Remove selected feature" tool.
 */
export function removeSelectedFeatures(features: GeoFeature[], indicesToRemove: Set<number>): GeoFeature[] {
  if (indicesToRemove.size === 0) return features.map(f => ({ ...f }));
  return features.filter((_, i) => !indicesToRemove.has(i));
}
