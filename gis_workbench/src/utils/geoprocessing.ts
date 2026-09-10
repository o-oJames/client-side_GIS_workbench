/**
 * geoprocessing.ts — Pure vector geoprocessing engines.
 *
 * All functions work on plain GeoJSON-like structures and never import React.
 * Coordinates are in EPSG:3857 (metres) unless noted.
 *
 * Supported tools:
 *   buffer, clip, intersect, union, difference, symmetricalDifference, dissolve,
 *   centroid, pointOnSurface, convexHull, distance (nearest/k-nearest/all),
 *   eliminate, checkValidity, makeValid, collectGeometries, delaunay, densify,
 *   addGeometryAttributes, extractVertices, multipartToSingleparts,
 *   polygonsToLines, polygonize, simplify, voronoi, linesToPolygons,
 *   mergeVectorLayers, splitVectorLayer, removeSelectedFeatures
 *
 * This module is the FEATURE level: attributes, grouping, per-feature loops,
 * progress and cancellation. Every boolean operation on geometry — clip,
 * intersect, union, difference, dissolve, eliminate's merge, make valid's
 * repair, polygonize, validity — is delegated to `utils/overlay.ts`, the planar
 * overlay kernel, so the tools cannot disagree with each other about what an
 * overlap is.
 *
 * Cross-cutting infrastructure (all engines are expected to use it):
 *   - `utils/overlay.ts` — node → label → select → assemble. Concave cutters,
 *     holes on either side, containment, multipart input and N-way union are all
 *     exact there; nothing in this module re-implements a boolean operation.
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
  mercatorToLonLat,
} from './geodesic';
import {
  ExtentIndex,
  emptyExtent,
  expandExtent,
  extentOfCoords,
  extentSpan,
  unionExtent,
  type Extent4,
} from './geomIndex';
import {
  geometryParts,
  isAreaGeometry,
  isLineGeometry,
  lineSequences,
  partsToGeometry,
  pointCoords,
  type AreaGeom,
  type Coord,
  type GeoFeature,
  type GeoFeatureCollection,
  type GeoGeom,
  type Ring,
} from './geoTypes';
import {
  clipGeometry,
  connectedComponents,
  differenceFromMany,
  differenceGeometry,
  geometriesAdjacent,
  geometryInteriorPoint,
  intersectGeometries,
  polygonizeGeometries,
  repairGeometry,
  sharedBoundaryLength,
  SubjectLocator,
  unionMany,
  validateGeometry,
  type ValidityError,
} from './overlay';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The geometry shapes live in utils/geoTypes.ts so the overlay kernel can share
// them without importing this module. They are re-exported here because every
// caller (and every test) has always imported them from 'utils/geoprocessing'.
export type { Coord, Ring, GeoGeom, GeoFeature, GeoFeatureCollection } from './geoTypes';

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
  /**
   * Buffer a LINE on one side only — GEOS/JTS `BufferParameters.setSingleSided`.
   * A positive distance offsets to the left of the direction of travel, a
   * negative one to the right. Ends are always flat, because a cap would put
   * material on the side that was asked to stay empty. Only the piece-union path
   * implements it, so it bypasses the offset curve.
   */
  singleSided?: boolean;
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

/** Turn from one bearing to the other, normalised to (-π, π]. */
function turnBetween(fromBearing: number, toBearing: number): number {
  let turn = toBearing - fromBearing;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn <= -Math.PI) turn += 2 * Math.PI;
  return turn;
}

/**
 * Which side of the direction of travel the offset curve lies on.
 *
 * `vertex` is the ORIGINAL corner and prevA→prevB is its OFFSET edge, so the
 * vertex sits on the opposite side from the offset: a positive cross product
 * means the offset went to the right.
 */
function offsetIsToLeft(vertex: Coord, prevA: Coord, prevB: Coord): boolean {
  return (prevB[0] - prevA[0]) * (vertex[1] - prevA[1]) - (prevB[1] - prevA[1]) * (vertex[0] - prevA[0]) < 0;
}

/**
 * Is this corner convex as seen from the offset curve?
 *
 * Convex means the material turns AWAY from the offset side, leaving the corner
 * exposed — that is the only case where a round join needs an arc. Where the
 * material turns toward the offset side the two offset edges cross, and their
 * intersection is the correct join (GEOS/JTS do exactly this split; a "bevel" or
 * an arc at a concave corner either leaves a notch or bulges over the material).
 */
function isConvexJoin(
  vertex: Coord,
  prevA: Coord, prevB: Coord,
  nextA: Coord, nextB: Coord
): boolean {
  const turn = turnBetween(
    Math.atan2(prevB[1] - prevA[1], prevB[0] - prevA[0]),
    Math.atan2(nextB[1] - nextA[1], nextB[0] - nextA[0])
  );
  return offsetIsToLeft(vertex, prevA, prevB) ? turn < 0 : turn > 0;
}

/**
 * Append a ROUND join between two consecutive offset edges.
 *
 * Convex corners sweep an arc of `segments` pieces per quarter circle around the
 * vertex, from the direction of the incoming offset point to the outgoing one,
 * turning the same way as the boundary. Concave corners take the mitre
 * intersection.
 *
 * The previous rule — "use the mitre point whenever it lands within 2·r" — mitred
 * every 90° corner, so the round buffer of a 10×10 square by 1 was its 12×12
 * bounding box (144) instead of 100 + 40 + π ≈ 143.14, and the arc that *was*
 * emitted was centred on the segment bearings rather than the radial directions,
 * which put it 90° off.
 */
function appendRoundJoin(
  out: Coord[],
  vertex: Coord,
  prevA: Coord, prevB: Coord,
  nextA: Coord, nextB: Coord,
  radius: number,
  opts: Required<BufferOptions>
): void {
  const joinPt = lineIntersectPt(prevA, prevB, nextA, nextB);
  if (!isConvexJoin(vertex, prevA, prevB, nextA, nextB)) {
    if (joinPt) out.push(joinPt);
    else out.push(prevB, nextA);
    return;
  }
  const from = Math.atan2(prevB[1] - vertex[1], prevB[0] - vertex[0]);
  const to = Math.atan2(nextA[1] - vertex[1], nextA[0] - vertex[0]);
  const turn = turnBetween(
    Math.atan2(prevB[1] - prevA[1], prevB[0] - prevA[0]),
    Math.atan2(nextB[1] - nextA[1], nextB[0] - nextA[0])
  );
  const arc = turn > 0
    ? generateArc(vertex, Math.abs(radius), from, to, opts.segments)
    : generateArcCw(vertex, Math.abs(radius), from, to, opts.segments);
  out.push(...arc);
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
  appendRoundJoin(pts, vertex, prevA, prevB, nextA, nextB, radius, opts);
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
      appendRoundJoin(result, vertex, prevEdge[0], prevEdge[1], nextEdge[0], nextEdge[1], radius, opts);
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
    const inside = heuristicInteriorPoint(bufferedHole);
    if (inside && !pointInRing(inside, shell)) continue;    // hole escaped the shell
    rings.push(ensureCW(closeRing(bufferedHole)));
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Buffer — exact Minkowski decomposition (the GEOS-class path)
// ---------------------------------------------------------------------------

/**
 * Build a buffer as a UNION OF SIMPLE PIECES instead of one offset curve.
 *
 * WHY THE OFFSET CURVE IS NOT ENOUGH
 * ----------------------------------
 * The buffer of a set S by distance d is its Minkowski sum with the disc of
 * radius d: the set of points within d of S. For a coordinate sequence that sum
 * decomposes EXACTLY into
 *
 *   • one rectangle per segment — the ±d slab over it,
 *   • one wedge per bend, on the OUTSIDE of the bend only: a circular sector for
 *     a round join, a mitre quad or a bevel triangle otherwise,
 *   • one cap piece per open end — a half disc, or a d-deep rectangle.
 *
 * "Outside only" is what makes the union equal to the buffer rather than a
 * superset of it. A point within d of the sequence either projects onto the
 * interior of some segment (so it lies in that segment's slab) or its closest
 * point is a vertex, in which case it sits on the outside of the bend at that
 * vertex and lies in the wedge. There is no third case, and the inside of a bend
 * needs nothing because the two adjacent slabs already overlap over it.
 *
 * A single offset curve cannot express that. As soon as d is comparable to a
 * segment length — routine on a real road network, where 50 m is longer than most
 * segments between shape points — the two offset curves cross and the closed ring
 * self-intersects. On sample/roads-seoul.geojson that made 68 of 94 buffers
 * invalid and their reported area 57 % too large, because a self-intersecting
 * ring counts its overlapping lobes twice. Unioning pieces cannot self-intersect:
 * this is what GEOS/JTS do, and it is why the area guard in `repairIfInvalid` is
 * no longer the thing standing between the user and a wrong answer.
 *
 * EROSION IS A DIFFERENCE OF THE SAME PIECES
 * ------------------------------------------
 * A negative buffer is not a union, but S ⊖ d = S ∖ (∂S ⊕ d): removing a band of
 * width d around every ring is exactly the erosion. Unlike the offset curve it
 * cannot invert when the inset exceeds the local width — a neck thinner than 2d
 * splits into two parts, and a polygon smaller than 2d disappears, which is what
 * GEOS returns.
 *
 * COST: one kernel pass per feature, so this path only runs when the offset path
 * produced something invalid (see `bufferGeometry`). Clean input never pays it.
 */

/** A closed ring of non-zero area as a Polygon piece; null when degenerate. */
function bufferPiece(ring: Coord[]): GeoGeom | null {
  if (ring.length < 3) return null;
  const closed = closeRing(ring);
  if (closed.length < 4) return null;
  for (const c of closed) if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  if (signedArea(closed) === 0) return null;
  return { type: 'Polygon', coordinates: [closed] };
}

/** The ±d slab over one segment: a rectangle covering BOTH sides of it. */
function segmentSlabPiece(a: Coord, b: Coord, radius: number): GeoGeom | null {
  const [la, lb] = offsetSegment(a, b, radius);
  const [ra, rb] = offsetSegment(a, b, -radius);
  return bufferPiece([la, lb, rb, ra]);
}

/** The one-sided quad over one segment, for single-sided buffers. */
function segmentSidePiece(a: Coord, b: Coord, offset: number): GeoGeom | null {
  const [oa, ob] = offsetSegment(a, b, offset);
  return bufferPiece([a, b, ob, oa]);
}

/** A tessellated disc: the buffer of a point, and a whole round join. */
function discPiece(p: Coord, radius: number, segments: number): GeoGeom | null {
  if (!(radius > 0)) return null;
  return bufferPiece(bufferPoint(p, radius, segments));
}

/** Unit vector at `from` pointing away from `towards` (i.e. out of the line). */
function awayUnit(from: Coord, towards: Coord): Coord | null {
  const dx = from[0] - towards[0];
  const dy = from[1] - towards[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  return [dx / len, dy / len];
}

/**
 * The wedge that fills the OUTSIDE of one bend, or null when this side is the
 * inside (where the neighbouring slabs already overlap and cover it).
 *
 * The convex/concave test and the mitre-limit fallback are the same ones
 * `addLineJoin` uses for the offset curve, so the two paths agree corner by
 * corner — they differ only in that this one cannot cross itself.
 */
function joinPiece(
  vertex: Coord,
  prevA: Coord, prevB: Coord,
  nextA: Coord, nextB: Coord,
  radius: number,
  opts: Required<BufferOptions>
): GeoGeom | null {
  if (!isConvexJoin(vertex, prevA, prevB, nextA, nextB)) return null;
  const r = Math.abs(radius);
  if (opts.joinStyle === 'round') {
    const from = Math.atan2(prevB[1] - vertex[1], prevB[0] - vertex[0]);
    const to = Math.atan2(nextA[1] - vertex[1], nextA[0] - vertex[0]);
    const turn = turnBetween(
      Math.atan2(prevB[1] - prevA[1], prevB[0] - prevA[0]),
      Math.atan2(nextB[1] - nextA[1], nextB[0] - nextA[0])
    );
    const arc = turn > 0
      ? generateArc(vertex, r, from, to, opts.segments)
      : generateArcCw(vertex, r, from, to, opts.segments);
    return bufferPiece([vertex, ...arc]);
  }
  const mitre = lineIntersectPt(prevA, prevB, nextA, nextB);
  if (opts.joinStyle === 'miter' && mitre && dist(mitre, vertex) <= opts.miterLimit * r) {
    return bufferPiece([vertex, prevB, mitre, nextA]);
  }
  return bufferPiece([vertex, prevB, nextA]); // bevel (and mitre past its limit)
}

/** The cap closing one open end of a line, `outward` pointing out of the line. */
function capPiece(
  vertex: Coord,
  outward: Coord,
  radius: number,
  opts: Required<BufferOptions>
): GeoGeom | null {
  const r = Math.abs(radius);
  const angle = Math.atan2(outward[1], outward[0]);
  if (opts.endCapStyle === 'round') {
    const arc = generateArcCw(vertex, r, angle + Math.PI / 2, angle - Math.PI / 2, opts.segments);
    return bufferPiece([vertex, ...arc]);
  }
  if (opts.endCapStyle === 'flat') return null;
  const tip: Coord = [vertex[0] + r * outward[0], vertex[1] + r * outward[1]];
  const n: Coord = [-outward[1], outward[0]];
  return bufferPiece([
    [vertex[0] + r * n[0], vertex[1] + r * n[1]],
    [tip[0] + r * n[0], tip[1] + r * n[1]],
    [tip[0] - r * n[0], tip[1] - r * n[1]],
    [vertex[0] - r * n[0], vertex[1] - r * n[1]],
  ]);
}

/** The distinct finite vertices of a sequence; `closed` drops the repeat. */
function distinctVertices(coords: Coord[], closed: boolean): Coord[] {
  const out: Coord[] = [];
  for (const c of coords) {
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    out.push(c);
  }
  if (closed && out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
  }
  return out;
}

/**
 * Every piece of the band of width `radius` around one coordinate sequence.
 *
 * `closed` treats the sequence as cyclic (a polygon ring: no caps, and every
 * vertex is a bend). `singleSided` keeps the band on the left for a positive
 * radius and on the right for a negative one.
 */
function boundaryPieces(
  coords: Coord[],
  radius: number,
  opts: Required<BufferOptions>,
  closed: boolean,
  singleSided: boolean
): GeoGeom[] {
  const verts = distinctVertices(coords, closed);
  const n = verts.length;
  const r = Math.abs(radius);
  if (n === 0 || !(r > 0)) return [];
  if (n === 1) {
    if (singleSided) return [];
    const disc = discPiece(verts[0], r, opts.segments);
    return disc ? [disc] : [];
  }

  const pieces: GeoGeom[] = [];
  const at = (i: number) => verts[((i % n) + n) % n];
  const side: 1 | -1 = radius >= 0 ? 1 : -1;
  const sides: number[] = singleSided ? [side] : [1, -1];
  const segCount = closed ? n : n - 1;

  for (let i = 0; i < segCount; i++) {
    const a = at(i);
    const b = at(i + 1);
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const piece = singleSided ? segmentSidePiece(a, b, side * r) : segmentSlabPiece(a, b, r);
    if (piece) pieces.push(piece);
  }

  const joinFrom = closed ? 0 : 1;
  const joinTo = closed ? n : n - 1;
  for (let i = joinFrom; i < joinTo; i++) {
    const prev = at(i - 1);
    const v = at(i);
    const next = at(i + 1);
    for (const s of sides) {
      const [prevA, prevB] = offsetSegment(prev, v, s * r);
      const [nextA, nextB] = offsetSegment(v, next, s * r);
      const piece = joinPiece(v, prevA, prevB, nextA, nextB, s * r, opts);
      if (piece) pieces.push(piece);
    }
  }

  if (!closed && !singleSided) {
    const startOut = awayUnit(verts[0], verts[1]);
    if (startOut) {
      const cap = capPiece(verts[0], startOut, r, opts);
      if (cap) pieces.push(cap);
    }
    const endOut = awayUnit(verts[n - 1], verts[n - 2]);
    if (endOut) {
      const cap = capPiece(verts[n - 1], endOut, r, opts);
      if (cap) pieces.push(cap);
    }
  }

  return pieces;
}

/** Fill in every buffer option, so the two paths share one set of defaults. */
function resolveBufferOptions(options?: BufferOptions): Required<BufferOptions> {
  return {
    segments: Math.max(1, options?.segments ?? 8),
    endCapStyle: options?.endCapStyle ?? 'round',
    joinStyle: options?.joinStyle ?? 'round',
    miterLimit: Math.max(1, options?.miterLimit ?? 5),
    singleSided: options?.singleSided === true,
  };
}

/** Ground metres → EPSG:3857 units at this geometry's latitude. */
function scaledBufferDistance(geom: GeoGeom, distance: number): number {
  return distance * mercatorScaleFactor(geomCenterY(geom));
}

/**
 * The single-sided buffer of ONE coordinate sequence.
 *
 * An open line needs no special handling: the union of its one-sided quads and
 * convex wedges is the band beside it, and GEOS agrees to the last digit
 * (`buffer(d, single_sided=True)` on a 40-unit line at d=100 is 4000.0000 for
 * both, at d=5 it is 200.0000 for both).
 *
 * A CLOSED sequence also has an inside, and one of its two sides IS that inside.
 * There the quads overshoot: a 10-unit square loop buffered 100 to the inside
 * produces four 10×100 quads whose union is a 3700-unit cross sticking out of the
 * loop, where the region between the ring and its inward offset curve — what
 * "single-sided" means, and what GEOS returns — is the 100-unit interior. So the
 * band is clipped by the ring: intersected with it when the offset side is the
 * inside, and differenced against it when the offset side is the outside (usually
 * a no-op, which is why GEOS's outward answer for the same loop, 27410.8386, is
 * exactly the unclipped band).
 */
/** Is a coordinate sequence a closed ring (a LineString that loops back)? */
function sequenceIsClosed(seq: Coord[]): boolean {
  if (seq.length < 4) return false;
  const first = seq[0];
  const last = seq[seq.length - 1];
  return !!first && !!last && first[0] === last[0] && first[1] === last[1];
}

function singleSidedLine(seq: Coord[], distance: number, opts: Required<BufferOptions>): GeoGeom | null {
  const closed = sequenceIsClosed(seq);
  const pieces = boundaryPieces(seq, distance, opts, closed, true);
  const band = pieces.length === 0 ? null : unionMany(pieces);
  if (!band) return null;
  if (!closed) return band;
  const ring = closeRing(seq);
  const polygon: GeoGeom = { type: 'Polygon', coordinates: [ring] };
  // `signedArea` in this module is the surveyor form, so NEGATIVE means
  // counter-clockwise (§13.15) — and the interior of a CCW ring is on the left.
  const ccw = signedArea(ring) < 0;
  const inward = (distance >= 0) === ccw;
  return inward ? intersectGeometries(band, polygon) : differenceFromMany(band, [polygon]);
}

/** The exact buffer of one polygon part (shell plus its holes). */
function bufferPartExact(
  part: PolygonPart,
  distance: number,
  opts: Required<BufferOptions>
): GeoGeom | null {
  const d = Math.abs(distance);
  const shellBand = boundaryPieces(part.shell, d, opts, true, false);

  if (distance > 0) {
    // GROW. The shell region plus the band around its boundary is shell ⊕ d;
    // each hole then loses its own erosion, because growing the material shrinks
    // the void. (buffer(S ∖ H, d) = (S ⊕ d) ∖ (H ⊖ d), and H ⊖ d = H ∖ (∂H ⊕ d).)
    const shellPoly = bufferPiece(part.shell);
    const grown = unionMany(shellPoly ? [shellPoly, ...shellBand] : shellBand);
    if (!grown) return null;
    if (part.holes.length === 0) return grown;
    const eroded: GeoGeom[] = [];
    for (const hole of part.holes) {
      const holePoly = bufferPiece(hole);
      if (!holePoly) continue;
      const band = unionMany(boundaryPieces(hole, d, opts, true, false));
      const left = band ? differenceFromMany(holePoly, [band]) : holePoly;
      if (left) eroded.push(left);
    }
    if (eroded.length === 0) return grown;
    return differenceFromMany(grown, eroded) ?? grown;
  }

  // SHRINK. S ⊖ d = S ∖ (∂S ⊕ d): take a band of width d off EVERY ring, which
  // rounds the void's corners and squares the shell's, exactly as GEOS does.
  const self: GeoGeom = {
    type: 'Polygon',
    coordinates: [closeRing(part.shell), ...part.holes.map(h => closeRing(h))],
  };
  const bands: GeoGeom[] = [];
  const shellUnion = unionMany(shellBand);
  if (shellUnion) bands.push(shellUnion);
  for (const hole of part.holes) {
    const holeUnion = unionMany(boundaryPieces(hole, d, opts, true, false));
    if (holeUnion) bands.push(holeUnion);
  }
  if (bands.length === 0) return self;
  return differenceFromMany(self, bands);
}

/** The exact (piece-union) buffer of any geometry. */
function bufferGeometryExact(
  geom: GeoGeom,
  distance: number,
  opts: Required<BufferOptions>
): GeoGeom | null {
  const d = Math.abs(distance);
  switch (geom.type) {
    case 'Point':
      return distance < 0 ? null : discPiece(geom.coordinates, d, opts.segments);
    case 'MultiPoint': {
      if (distance < 0) return null;
      const discs: GeoGeom[] = [];
      for (const p of geom.coordinates) {
        const disc = discPiece(p, d, opts.segments);
        if (disc) discs.push(disc);
      }
      if (discs.length === 0) return null;
      // Overlapping circles must MERGE: separate parts that overlap are invalid.
      return discs.length === 1 ? discs[0] : unionMany(discs);
    }
    case 'LineString':
    case 'MultiLineString': {
      // A negative distance has no meaning for a two-sided line buffer (GEOS
      // returns empty too), but it is exactly how a single-sided buffer asks for
      // the RIGHT of the direction of travel.
      if (distance < 0 && !opts.singleSided) return null;
      if (opts.singleSided) {
        // Per sequence, because a closed one has to be clipped by its own ring.
        const sided: GeoGeom[] = [];
        for (const seq of lineSequences(geom)) {
          const one = singleSidedLine(seq, distance, opts);
          if (one) sided.push(one);
        }
        if (sided.length === 0) return null;
        return sided.length === 1 ? sided[0] : unionMany(sided);
      }
      const pieces: GeoGeom[] = [];
      // A LineString that loops back on itself is a ring: it has no ends to cap
      // and its closing vertex is a bend like any other, so it is decomposed
      // cyclically. Treating it as open leaves a wedge missing at the closure.
      for (const seq of lineSequences(geom)) {
        pieces.push(...boundaryPieces(seq, distance, opts, sequenceIsClosed(seq), false));
      }
      return pieces.length === 0 ? null : unionMany(pieces);
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const results: GeoGeom[] = [];
      for (const part of getPolygonParts(geom)) {
        const one = bufferPartExact(part, distance, opts);
        if (one) results.push(one);
      }
      if (results.length === 0) return null;
      if (results.length === 1) return results[0];
      // Buffered parts of a MultiPolygon usually overlap, so they are unioned:
      // ST_Buffer of a MultiPolygon is one region, not N overlapping ones.
      return unionMany(results);
    }
    default:
      return null;
  }
}

/** Sum of |shoelace| over every ring — the naive measure, holes included. */
function naiveRingAreaSum(geom: GeoGeom | null): number {
  if (!isAreaGeometry(geom)) return 0;
  let total = 0;
  for (const part of geometryParts(geom)) {
    for (const ring of part) total += Math.abs(signedArea(ring));
  }
  return total;
}

/**
 * Last resort for a buffer whose offset ring crossed itself AND whose exact
 * piece-union rebuild found nothing (`bufferGeometry`).
 *
 * The rule is now simply: if the kernel can make it valid, ship the valid one.
 *
 * It used to compare the naive ring-area sum before and after and keep the
 * original whenever the repair was smaller, on the theory that a mitre spike
 * winding back over itself cancels its own overlap under the winding rule and a
 * smaller rebuild therefore lost ground. Two things made that guard obsolete.
 * Nonzero winding in the kernel's point locator already stops the overlap
 * cancelling — that was the actual fix for the 20 %-short mitre buffer. And the
 * exact decomposition is now the primary answer, so this path is only reached
 * when the piece union itself failed, where the choice is between a repair that
 * passes Check Validity and a ring that does not. Shipping the invalid one to
 * protect a naive area sum that double-counts every overlapping lobe is the wrong
 * trade: it is what made 68 of 94 real road buffers ship both invalid and 57 %
 * too large.
 */
function repairIfInvalid(geom: GeoGeom): GeoGeom {
  if (!isAreaGeometry(geom)) return geom;
  if (validateGeometry(geom).length === 0) return geom;
  const repaired = repairGeometry(geom);
  if (!repaired) return geom;
  if (validateGeometry(repaired).length === 0) return repaired;
  // Neither is valid. Keep whichever covers more ground: a repair that is still
  // broken has already lost something, and the naive sum is the only measure left
  // that can tell the two apart.
  return naiveRingAreaSum(repaired) < naiveRingAreaSum(geom) ? geom : repaired;
}

/**
 * Is an inset (negative buffer) result really |d| inside the source?
 *
 * WHY THIS EXISTS. The offset path guards its inset ring with two tests — "the
 * orientation did not flip" and "the area shrank" — and neither can see the
 * failure that matters. Once the inset exceeds the local width, the offset edges
 * cross each other and what comes back is a SMALL, correctly oriented, valid
 * polygon on the far side of the crossing. A 1×1 square eroded by 0.6 returns the
 * 0.2×0.2 "square" whose corners are 0.4 from the boundary: inside the source,
 * orientation preserved, 96 % smaller, and entirely wrong — the true erosion is
 * EMPTY, because no point of that square is 0.6 away from the boundary. (The same
 * inversion at a larger distance is what the area guard catches; this catches the
 * rest, which the area guard cannot, because the inverted ring is small.)
 *
 * An erosion is defined by a distance, so the guard is a distance: every vertex of
 * the result must lie inside the source AND be at least |d| from its boundary.
 * Only a THRESHOLD is tested, and the segments are pruned by an extent index
 * queried with the |d| box around the vertex — if nothing in that box is closer
 * than |d|, nothing outside it can be — so this is O(V·log n), not a full
 * distance computation.
 */
function erosionIsSound(source: GeoGeom, inset: GeoGeom, insetDistance: number): boolean {
  if (!(insetDistance > 0)) return true;
  if (!isAreaGeometry(inset) || !isAreaGeometry(source)) return true;
  const sourceRings = getAllPolygonRings(source);
  const segs: [Coord, Coord][] = [];
  const boxes: Extent4[] = [];
  for (const ring of sourceRings) {
    const closed = closeRing(ring);
    for (let i = 0; i < closed.length - 1; i++) {
      segs.push([closed[i], closed[i + 1]]);
      boxes.push(extentOfCoords([closed[i], closed[i + 1]]));
    }
  }
  if (segs.length === 0) return false;
  const index = new ExtentIndex<number>();
  index.load(boxes, segs.map((_, i) => i));
  const slack = Math.max(scaleTolerance(extentSpan(geometryExtent(source))), insetDistance * 1e-9);
  // One locator for the whole test: pointInGeometry() would rebuild its ring
  // index per vertex.
  const locator = new SubjectLocator([source], slack);
  const need = insetDistance - slack;
  if (!(need > 0)) return true;
  for (const ring of getAllPolygonRings(inset)) {
    for (const p of ring) {
      if (!locator.contains(0, p)) return false;
      for (const i of index.query([p[0] - need, p[1] - need, p[0] + need, p[1] + need])) {
        if (pointToSegmentDist(p, segs[i][0], segs[i][1]) < need) return false;
      }
    }
  }
  return true;
}

/** Buffer any geometry. Returns a Polygon or MultiPolygon. */
function bufferGeometryRaw(geom: GeoGeom, distance: number, options?: BufferOptions): GeoGeom | null {
  if (distance === 0) return geom;

  // Compensate for Web Mercator distortion: the distance is in ground meters,
  // but we operate in EPSG:3857 projected coordinates. Scale by the local
  // Mercator factor so the buffer radius matches the intended ground distance
  // (`scaledBufferDistance`, shared with the exact path).
  const scaledDistance = scaledBufferDistance(geom, distance);
  const opts = resolveBufferOptions(options);

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

/**
 * Buffer any geometry. Returns a Polygon or MultiPolygon, or null when the
 * buffer is empty (which for a negative distance is a real answer).
 *
 * Two paths, cheapest first:
 *
 *   1. the offset curve (`bufferGeometryRaw`), kept whenever it comes back VALID.
 *      For clean input that is the same tessellated ring GEOS would emit, at a
 *      thousandth of the cost, and every existing golden number is unchanged.
 *   2. the exact piece union (`bufferGeometryExact`), taken whenever path 1
 *      produced something invalid, and always for single-sided buffers.
 *
 * Path 2 is authoritative about emptiness: if the pieces say a negative buffer
 * eroded the geometry away, the feature is gone. Only a POSITIVE distance that
 * path 2 cannot answer is treated as a failure — a non-empty set always has a
 * non-empty buffer — and falls back to the old repair rather than dropping the
 * feature.
 */
export function bufferGeometry(geom: GeoGeom, distance: number, options?: BufferOptions): GeoGeom | null {
  const opts = resolveBufferOptions(options);
  const scaled = scaledBufferDistance(geom, distance);
  if (!opts.singleSided) {
    const raw = bufferGeometryRaw(geom, distance, options);
    const sound = raw !== null
      && validateGeometry(raw).length === 0
      && (scaled > 0 || erosionIsSound(geom, raw, Math.abs(scaled)));
    if (sound) return raw;
  }
  const exact = bufferGeometryExact(geom, scaled, opts);
  if (exact) return exact;
  if (distance < 0) return null;
  const raw = bufferGeometryRaw(geom, distance, options);
  return raw ? repairIfInvalid(raw) : null;
}

export function bufferFeature(feature: GeoFeature, distance: number, options?: BufferOptions): GeoFeature | null {
  if (!feature.geometry) return null;
  const geom = bufferGeometry(feature.geometry, distance, options);
  if (!geom) return null;
  return { type: 'Feature', geometry: geom, properties: { ...feature.properties } };
}

export interface BufferLayerOptions extends BufferOptions {
  /**
   * Union every buffer into one feature — QGIS "Dissolve result". Attributes are
   * dropped, because a dissolved buffer no longer belongs to one input feature.
   */
  dissolveResult?: boolean;
  /**
   * Emit one feature per disjoint part of a multipart buffer — QGIS "Separate
   * disjoint parts (into separate features)".
   */
  separateDisjointParts?: boolean;
  /**
   * Read the distance from this numeric attribute instead of the constant
   * (QGIS's data-defined buffer distance). Features whose value is missing or
   * not a number fall back to the constant distance.
   */
  distanceField?: string;
}

/**
 * Buffer a whole layer.
 *
 * Distance is in ground metres and is scaled for Web Mercator latitude per
 * feature, so a "100 m" buffer really is 100 m on the ground wherever it is.
 */
/** The data-defined field named in the options, or null for the constant. */
function bufferDistanceField(options: BufferLayerOptions): string | null {
  return typeof options.distanceField === 'string' && options.distanceField.length > 0
    ? options.distanceField
    : null;
}

/** Per-feature distance: the field's value when it is a number, else the constant. */
function bufferDistanceFor(feature: GeoFeature, distance: number, field: string | null): number {
  if (!field) return distance;
  const raw = Number(feature.properties?.[field]);
  return Number.isFinite(raw) ? raw : distance;
}

/**
 * Apply the layer-wide options to the per-feature buffers.
 *
 * Dissolve first, then split: the two options have to compose, or a dissolved
 * multipart result could never be broken back into its disjoint pieces.
 */
function finishBufferLayer(buffered: GeoFeature[], options: BufferLayerOptions): GeoFeature[] {
  const stage: GeoFeature[] = options.dissolveResult === true
    ? (() => {
        const merged = unionMany(buffered.map(f => f.geometry));
        return merged ? [{ type: 'Feature' as const, geometry: merged, properties: {} }] : [];
      })()
    : buffered;

  if (options.separateDisjointParts !== true) return stage;
  const split: GeoFeature[] = [];
  for (const f of stage) {
    if (f.geometry?.type !== 'MultiPolygon') { split.push(f); continue; }
    for (const part of f.geometry.coordinates) {
      split.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: part }, properties: { ...f.properties } });
    }
  }
  return split;
}

export function bufferFeatures(
  features: GeoFeature[],
  distance: number,
  options: BufferLayerOptions = {}
): GeoFeature[] {
  const field = bufferDistanceField(options);
  const buffered: GeoFeature[] = [];
  for (const f of features) {
    const one = bufferFeature(f, bufferDistanceFor(f, distance, field), options);
    if (one?.geometry) buffered.push(one);
  }
  return finishBufferLayer(buffered, options);
}

/**
 * Buffer with progress reporting and cancellation — the interactive variant the
 * panel runs.
 *
 * Buffering is usually the cheapest tool in the panel, but a feature whose offset
 * curve self-intersects falls back to the exact piece union (`bufferGeometry`),
 * which is a kernel pass: a 1 km buffer over 138 real suburb polygons went from
 * milliseconds to ~4 s when it started answering correctly instead of emitting
 * self-intersecting rings. That must stay cancellable.
 */
export async function bufferFeaturesAsync(
  features: GeoFeature[],
  distance: number,
  options: BufferLayerOptions = {},
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const field = bufferDistanceField(options);
  const buffered: GeoFeature[] = [];
  const ok = await progressLoop(
    features.length,
    progress,
    i => {
      const one = bufferFeature(features[i], bufferDistanceFor(features[i], distance, field), options);
      if (one?.geometry) buffered.push(one);
    },
    onProgress,
    'Buffering'
  );
  if (!ok) return [];
  if (options.dissolveResult === true && buffered.length > 1) {
    progress.message = 'Merging buffers…';
    progress.progress = 1;
    if (onProgress) onProgress(progress);
    await yieldToUI();
    if (progress.cancelled) return [];
  }
  return finishBufferLayer(buffered, options);
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
 * Clip a subject polygon ring by a clip polygon ring (Sutherland–Hodgman).
 *
 * DEPRECATED for clipping: the panel's Clip/Intersect tools now go through the
 * planar overlay kernel (utils/overlay.ts), which is exact for concave cutters,
 * holes, points and lines. This function survives only because Voronoi's
 * half-plane cell construction uses the same primitive on convex cutters, where
 * Sutherland–Hodgman is exact and much cheaper.
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
// Clip / Intersect — driven by the planar overlay kernel
// ---------------------------------------------------------------------------

/** One polygonal feature of the overlay layer, prepared once per call. */
interface OverlayOperand {
  /** Index into the overlay layer, so its attributes can be merged back. */
  featureIndex: number;
  geometry: AreaGeom;
  extent: Extent4;
}

interface OverlayContext {
  operands: OverlayOperand[];
  index: ExtentIndex<number>;
  /** Coordinate tolerance for the whole overlay, derived from its extent. */
  tolerance: number;
}

/**
 * Index the polygonal features of an overlay layer.
 *
 * Non-polygonal features are skipped rather than treated as zero-width cutters:
 * an overlay with no interior cannot clip anything.
 */
function prepareOverlay(overlayLayer: GeoFeature[]): OverlayContext | null {
  const operands: OverlayOperand[] = [];
  for (let i = 0; i < overlayLayer.length; i++) {
    const geometry = overlayLayer[i].geometry;
    if (!isAreaGeometry(geometry)) continue;
    operands.push({ featureIndex: i, geometry, extent: geometryExtent(geometry) });
  }
  if (operands.length === 0) return null;
  const index = new ExtentIndex<number>();
  index.load(operands.map(o => o.extent), operands.map((_, i) => i));
  return { operands, index, tolerance: toleranceForFeatures(overlayLayer) };
}

/** The overlay polygons whose extent reaches `geometry`. */
function overlayHits(geometry: GeoGeom, ctx: OverlayContext): OverlayOperand[] {
  return ctx.index.query(geometryExtent(geometry)).map(i => ctx.operands[i]);
}

/**
 * Overlay one input feature against every overlay polygon it reaches.
 *
 * Points, lines and polygons all take the same path (`clipGeometry` dispatches on
 * type), so Clip now behaves like QGIS's, which clips all three geometry types.
 * Concave cutters, donut cutters and multipart cutters are all exact now — the
 * convex-only Sutherland–Hodgman kernel and its "drop a piece that straddles a
 * hole" workaround are gone.
 *
 * One output feature per (input, overlay) pair, as in QGIS: an overlay layer that
 * overlaps itself therefore duplicates the input area.
 */
function clipOneFeature(feature: GeoFeature, ctx: OverlayContext): GeoFeature[] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  const results: GeoFeature[] = [];
  for (const operand of overlayHits(geometry, ctx)) {
    const clipped = clipGeometry(geometry, operand.geometry, { tolerance: ctx.tolerance });
    if (!clipped) continue;
    results.push({ type: 'Feature', geometry: clipped, properties: { ...feature.properties } });
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
  const ok = await progressLoop(
    input.length,
    progress,
    i => results.push(...clipOneFeature(input[i], ctx)),
    onProgress,
    'Clipping'
  );
  return ok ? results : [];
}

/**
 * Merge two overlay attribute tables the way QGIS does.
 *
 * On a name collision the input layer keeps the field and the overlay's copy is
 * suffixed (`NAME`, `NAME_2`), instead of the overlay silently overwriting it:
 * losing a field is worse than renaming one.
 */
export function mergeOverlayProperties(
  a: Record<string, any>,
  b: Record<string, any>
): Record<string, any> {
  const out: Record<string, any> = { ...(a ?? {}) };
  for (const key of Object.keys(b ?? {})) {
    if (!(key in out)) {
      out[key] = b[key];
      continue;
    }
    let n = 2;
    let candidate = `${key}_${n}`;
    while (candidate in out) {
      n++;
      candidate = `${key}_${n}`;
    }
    out[candidate] = b[key];
  }
  return out;
}

/** Every field name used anywhere in a layer, in first-seen order. */
export function collectFieldNames(features: GeoFeature[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    for (const key of Object.keys(f.properties ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

/** `properties` padded with explicit nulls for every field of the other layer. */
function padProperties(
  properties: Record<string, any>,
  otherFields: string[]
): Record<string, any> {
  const out: Record<string, any> = { ...properties };
  for (const field of otherFields) {
    if (!(field in out)) out[field] = null;
  }
  return out;
}

/**
 * Intersect one A feature against the indexed B layer.
 *
 * Same kernel as Clip, so it inherits exact concave/hole/point/line handling,
 * and it disambiguates colliding field names instead of letting B overwrite A.
 */
function intersectOneFeature(a: GeoFeature, ctx: OverlayContext, layerB: GeoFeature[]): GeoFeature[] {
  const geometry = a.geometry;
  if (!geometry) return [];
  const results: GeoFeature[] = [];
  for (const operand of overlayHits(geometry, ctx)) {
    const piece = clipGeometry(geometry, operand.geometry, { tolerance: ctx.tolerance });
    if (!piece) continue;
    results.push({
      type: 'Feature',
      geometry: piece,
      properties: mergeOverlayProperties(a.properties, layerB[operand.featureIndex].properties),
    });
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
  const ok = await progressLoop(
    layerA.length,
    progress,
    i => results.push(...intersectOneFeature(layerA[i], ctx, layerB)),
    onProgress,
    'Intersecting'
  );
  return ok ? results : [];
}

// ---------------------------------------------------------------------------
// Union / Difference / Symmetrical difference — QGIS-style overlays
// ---------------------------------------------------------------------------

export interface OverlayRunOptions {
  /** Caller-owned progress/cancellation token (see `ProgressToken`). */
  progress?: ProgressToken;
  onProgress?: ProgressReporter;
}

/**
 * Subtract every geometry in `hits` from `geometry`, whatever type it is.
 *
 * Polygons go through the N-way kernel in one pass; points and lines are cut
 * feature by feature (a point inside the overlay disappears, a line keeps only
 * its outside runs), so a Union or Difference never silently drops the
 * non-polygonal half of a mixed layer.
 */
function subtractAll(geometry: GeoGeom, hits: GeoGeom[], tolerance: number): GeoGeom | null {
  if (hits.length === 0) return geometry;
  if (isAreaGeometry(geometry)) return differenceFromMany(geometry, hits, { tolerance });
  return hits.reduce<GeoGeom | null>(
    (acc, hit) => (acc ? differenceGeometry(acc, hit, { tolerance }) : null),
    geometry
  );
}

/** One unit of work for the two-layer overlay tools. */
interface OverlayTask {
  source: 'input' | 'overlay';
  index: number;
}

function overlayTasks(layerA: GeoFeature[], layerB: GeoFeature[]): OverlayTask[] {
  const tasks: OverlayTask[] = [];
  layerA.forEach((_, index) => tasks.push({ source: 'input', index }));
  layerB.forEach((_, index) => tasks.push({ source: 'overlay', index }));
  return tasks;
}

/**
 * QGIS-style Union of two layers.
 *
 * The old implementation was a dissolve of both layers: it merged everything that
 * touched and threw away every attribute. QGIS's Union is an overlay that emits
 *
 *   - A ∩ B, with both attribute tables merged (collisions suffixed `_2`),
 *   - A − B, with A's attributes and nulls for B's fields,
 *   - B − A, with B's attributes and nulls for A's fields,
 *
 * so nothing is lost and every output feature says where it came from. The
 * intersection is emitted only from the input pass — doing it from both passes
 * would duplicate every overlap.
 */
export async function unionFeatures(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  options: OverlayRunOptions = {}
): Promise<GeoFeature[]> {
  const progress = options.progress ?? createProgress();
  const ctxA = prepareOverlay(layerA);
  const ctxB = prepareOverlay(layerB);
  const fieldsA = collectFieldNames(layerA);
  const fieldsB = collectFieldNames(layerB);
  const tolerance = toleranceForFeatures(layerA, layerB);
  const results: GeoFeature[] = [];

  const ok = await progressLoop(
    overlayTasks(layerA, layerB).length,
    progress,
    t => {
      const task = overlayTasks(layerA, layerB)[t];
      const fromInput = task.source === 'input';
      const layer = fromInput ? layerA : layerB;
      const otherLayer = fromInput ? layerB : layerA;
      const ctx = fromInput ? ctxB : ctxA;
      const otherFields = fromInput ? fieldsB : fieldsA;
      const feature = layer[task.index];
      const geometry = feature.geometry;
      if (!geometry) return;

      if (!ctx) {
        results.push({ type: 'Feature', geometry, properties: padProperties(feature.properties, otherFields) });
        return;
      }

      const hits: AreaGeom[] = [];
      for (const operand of overlayHits(geometry, ctx)) {
        hits.push(operand.geometry);
        if (!fromInput) continue; // the input pass already emitted every overlap
        const piece = clipGeometry(geometry, operand.geometry, { tolerance });
        if (!piece) continue;
        results.push({
          type: 'Feature',
          geometry: piece,
          properties: mergeOverlayProperties(feature.properties, otherLayer[operand.featureIndex].properties),
        });
      }
      const rest = subtractAll(geometry, hits, tolerance);
      if (rest) {
        results.push({ type: 'Feature', geometry: rest, properties: padProperties(feature.properties, otherFields) });
      }
    },
    options.onProgress,
    'Unioning'
  );
  return ok ? results : [];
}

/**
 * Difference: the parts of `layerA` that `layerB` does not cover.
 *
 * Attributes come from A only, exactly as in QGIS. Points and lines are handled
 * too (QGIS Difference is not polygon-only): a point inside the overlay is
 * dropped, a line is cut and only its outside runs survive.
 */
function differenceOneFeature(a: GeoFeature, ctx: OverlayContext | null, tolerance: number): GeoFeature[] {
  const geometry = a.geometry;
  if (!geometry) return [];
  if (!ctx) return [{ type: 'Feature', geometry, properties: { ...a.properties } }];
  const hits = overlayHits(geometry, ctx).map(o => o.geometry as GeoGeom);
  const rest = subtractAll(geometry, hits, tolerance);
  if (!rest) return [];
  return [{ type: 'Feature', geometry: rest, properties: { ...a.properties } }];
}

export function differenceFeatures(layerA: GeoFeature[], layerB: GeoFeature[]): GeoFeature[] {
  const ctx = prepareOverlay(layerB);
  const tolerance = toleranceForFeatures(layerA, layerB);
  const results: GeoFeature[] = [];
  for (const a of layerA) results.push(...differenceOneFeature(a, ctx, tolerance));
  return results;
}

/** Difference with progress reporting and cancellation. */
export async function differenceFeaturesAsync(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<GeoFeature[]> {
  const ctx = prepareOverlay(layerB);
  const tolerance = toleranceForFeatures(layerA, layerB);
  const results: GeoFeature[] = [];
  const ok = await progressLoop(
    layerA.length,
    progress,
    i => results.push(...differenceOneFeature(layerA[i], ctx, tolerance)),
    onProgress,
    'Computing difference'
  );
  return ok ? results : [];
}

/**
 * Symmetrical difference: the parts of either layer the other does not cover.
 *
 * Geometric `ST_SymDifference` semantics — the overlap is NOT emitted. Each
 * output feature carries its own layer's attributes plus `source_layer`
 * (`input` / `overlay`) and nulls for the other layer's fields. QGIS's tool of
 * the same name also emits the intersection with merged attributes; that is what
 * Union does here.
 */
function symDiffOneFeature(
  feature: GeoFeature,
  source: 'input' | 'overlay',
  ctx: OverlayContext | null,
  otherFields: string[],
  tolerance: number
): GeoFeature[] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  const properties = { ...padProperties(feature.properties, otherFields), source_layer: source };
  if (!ctx) return [{ type: 'Feature', geometry, properties }];
  const hits = overlayHits(geometry, ctx).map(o => o.geometry as GeoGeom);
  const rest = subtractAll(geometry, hits, tolerance);
  if (!rest) return [];
  return [{ type: 'Feature', geometry: rest, properties }];
}

export async function symmetricalDifferenceFeatures(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  options: OverlayRunOptions = {}
): Promise<GeoFeature[]> {
  const progress = options.progress ?? createProgress();
  const ctxA = prepareOverlay(layerA);
  const ctxB = prepareOverlay(layerB);
  const fieldsA = collectFieldNames(layerA);
  const fieldsB = collectFieldNames(layerB);
  const tolerance = toleranceForFeatures(layerA, layerB);
  const tasks = overlayTasks(layerA, layerB);
  const results: GeoFeature[] = [];

  const ok = await progressLoop(
    tasks.length,
    progress,
    t => {
      const task = tasks[t];
      const fromInput = task.source === 'input';
      results.push(...symDiffOneFeature(
        (fromInput ? layerA : layerB)[task.index],
        task.source,
        fromInput ? ctxB : ctxA,
        fromInput ? fieldsB : fieldsA,
        tolerance
      ));
    },
    options.onProgress,
    'Computing symmetrical difference'
  );
  return ok ? results : [];
}

// ---------------------------------------------------------------------------
// Dissolve — merge features, optionally grouped by field values
// ---------------------------------------------------------------------------

/** Group key used for null/undefined attribute values. */
export const NULL_GROUP_KEY = '__null__';

/** Stable string form of an attribute value, for group-by keys. */
function groupValueKey(value: any): string {
  if (value === undefined || value === null) return NULL_GROUP_KEY;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/**
 * Group key of a feature over `fields` (empty string when dissolving everything).
 * Shared with Split Vector Layer so both tools group identically.
 */
export function featureGroupKey(properties: Record<string, any> | null | undefined, fields: string[]): string {
  if (!fields || fields.length === 0) return '';
  return fields.map(field => groupValueKey(properties?.[field])).join('\u0000');
}

export interface DissolveOptions {
  /**
   * Group-by field(s) — QGIS "Dissolve field(s)". Empty (the default) dissolves
   * the whole layer into one feature.
   */
  fields?: string[];
  /**
   * Keep parts that do not touch as separate output features — QGIS "Keep disjoint
   * features separate". Off by default, which yields one (possibly multipart)
   * feature per group.
   */
  keepDisjoint?: boolean;
  /**
   * Legacy switch. `false` collects the geometries into a multipart feature
   * without merging shared boundaries (the old "Merge overlapping geometries"
   * checkbox, unchecked).
   */
  dissolveOverlap?: boolean;
  progress?: ProgressToken;
  onProgress?: ProgressReporter;
}

/** One connected component of one dissolve group — the unit of cancellable work. */
interface DissolveTask {
  groupIndex: number;
  geometries: AreaGeom[];
}

/**
 * Dissolve features, optionally by field value.
 *
 * The merge itself is the overlay kernel: no more restart-from-scratch fixpoint
 * loop, and no more "could not splice the shared edge, fall back to the convex
 * hull of the two shapes" that silently inflated area.
 *
 * Work is split into *connected components* (utils/overlay.ts), which is both
 * the fast path and the cancellation granularity: a layer of scattered parcels
 * never enters the kernel at all, and a Cancel lands between components rather
 * than never. Without components, one dissolve group would be a single
 * uninterruptible synchronous call.
 *
 * Output attributes are the dissolve field(s) only — QGIS's default. Non-polygonal
 * geometries in a group are collected into one multipart feature each.
 */
export async function dissolveFeatures(
  features: GeoFeature[],
  options: DissolveOptions = {}
): Promise<GeoFeature[]> {
  const progress = options.progress ?? createProgress();
  const fields = (options.fields ?? []).filter(f => typeof f === 'string' && f.length > 0);
  const keepDisjoint = options.keepDisjoint === true;
  const merge = options.dissolveOverlap !== false;
  if (features.length === 0) return [];

  // ---- group -------------------------------------------------------------
  const groups = new Map<string, GeoFeature[]>();
  for (const f of features) {
    const key = featureGroupKey(f.properties, fields);
    const list = groups.get(key);
    if (list) list.push(f); else groups.set(key, [f]);
  }
  const groupList = Array.from(groups.values());

  // ---- split each group into components, lines and points (all cheap) ------
  const attributesPerGroup: Record<string, any>[] = [];
  const linesPerGroup: Coord[][][] = [];
  const pointsPerGroup: Coord[][] = [];
  const polysPerGroup: AreaGeom[][] = [];
  groupList.forEach(group => {
    const attributes: Record<string, any> = {};
    for (const field of fields) attributes[field] = group[0].properties?.[field] ?? null;
    attributesPerGroup.push(attributes);

    const polygons: AreaGeom[] = [];
    const lines: Coord[][] = [];
    const points: Coord[] = [];
    for (const f of group) {
      const g = f.geometry;
      if (!g) continue;
      if (isAreaGeometry(g)) polygons.push(g);
      else if (isLineGeometry(g)) lines.push(...lineSequences(g));
      else points.push(...pointCoords(g));
    }
    polysPerGroup.push(polygons);
    linesPerGroup.push(lines);
    pointsPerGroup.push(points);
  });

  const tasks: DissolveTask[] = [];
  const componentsPerGroup: AreaGeom[][][] = merge
    ? polysPerGroup.map((polygons, gi) =>
        polygons.length > 0 ? connectedComponents(polygons).map(component => component.map(i => polygons[i])) : [])
    : polysPerGroup.map(polygons => (polygons.length > 0 ? [polygons] : []));
  componentsPerGroup.forEach((components, groupIndex) => {
    components.forEach(geometries => tasks.push({ groupIndex, geometries }));
  });

  // ---- run the kernel, one component at a time ---------------------------
  const mergedPerGroup: GeoGeom[][] = groupList.map(() => []);
  const ok = await progressLoop(
    tasks.length,
    progress,
    t => {
      const task = tasks[t];
      const geometries = task.geometries;
      if (geometries.length === 0) return;
      const merged = geometries.length === 1 ? geometries[0] : unionMany(geometries);
      if (merged) mergedPerGroup[task.groupIndex].push(merged);
    },
    options.onProgress,
    'Dissolving'
  );
  if (!ok) return [];

  // ---- assemble the output ----------------------------------------------
  const results: GeoFeature[] = [];
  groupList.forEach((_, gi) => {
    const attributes = attributesPerGroup[gi];
    const merged = mergedPerGroup[gi];
    if (merged.length > 0) {
      if (!merge) {
        // Legacy "collect without merging": boundaries stay exactly as drawn.
        const geom = partsToGeometry(polysPerGroup[gi].flatMap(g => geometryParts(g)));
        if (geom) results.push({ type: 'Feature', geometry: geom, properties: attributes });
      } else if (keepDisjoint) {
        for (const geom of merged) results.push({ type: 'Feature', geometry: geom, properties: attributes });
      } else {
        const geom = merged.length === 1
          ? merged[0]
          : partsToGeometry(merged.flatMap(g => geometryParts(g)));
        if (geom) results.push({ type: 'Feature', geometry: geom, properties: attributes });
      }
    }
    const lines = linesPerGroup[gi];
    if (lines.length > 0) {
      results.push({
        type: 'Feature',
        geometry: lines.length === 1
          ? { type: 'LineString', coordinates: lines[0] }
          : { type: 'MultiLineString', coordinates: lines },
        properties: attributes,
      });
    }
    const points = pointsPerGroup[gi];
    if (points.length > 0) {
      results.push({
        type: 'Feature',
        geometry: points.length === 1
          ? { type: 'Point', coordinates: points[0] }
          : { type: 'MultiPoint', coordinates: points },
        properties: attributes,
      });
    }
  });
  return results;
}

// ---------------------------------------------------------------------------
// Shared low-level helpers (kept for the buffer, centroid and distance engines)
// ---------------------------------------------------------------------------

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
 * A point representative of a ring's interior, or null when none was found.
 *
 * The cheap heuristic used by the buffer engine to decide whether a buffered hole
 * is still inside its shell. Not the rigorous scanline interior point in
 * utils/overlay.ts (`ringInteriorPoint` / `geometryInteriorPoint`), which is what
 * the overlay kernel and the Point-on-surface tool use.
 */
function heuristicInteriorPoint(ring: Ring): Coord | null {
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

/**
 * Convex hull of a whole feature list — one hull for everything.
 *
 * This is the "whole layer" mode; QGIS's Convex hull tool defaults to one hull
 * per input feature, which is `convexHullFeatures`.
 */
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

export interface ConvexHullOptions {
  /**
   * `false` (the default) gives one hull per input feature with that feature's
   * attributes — QGIS's Convex hull semantics. `true` gives a single hull of the
   * whole layer, which is what this tool used to do unconditionally.
   */
  wholeLayer?: boolean;
}

/**
 * Convex hulls of the input, one per feature (QGIS) or one for the whole layer.
 *
 * A feature with a single vertex hulls to a Point and one with two collinear
 * vertices to a LineString, exactly as GEOS's `ST_ConvexHull` does.
 */
export function convexHullFeatures(features: GeoFeature[], options: ConvexHullOptions = {}): GeoFeature[] {
  if (options.wholeLayer === true) {
    const hull = convexHullFeature(features);
    return hull ? [hull] : [];
  }
  const results: GeoFeature[] = [];
  for (const f of features) {
    const hull = convexHullFeature([f]);
    if (!hull || !hull.geometry) continue;
    results.push({ type: 'Feature', geometry: hull.geometry, properties: { ...f.properties } });
  }
  return results;
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
  /**
   * Boundary segments of lines and of EVERY polygon ring — holes are boundary
   * too. Excluding them made the distance from a point inside a donut hole measure
   * to the shell (5 units away) instead of to the hole's own edge (2).
   */
  segments: Array<[Coord, Coord]>;
}

function geomPrimitives(geom: GeoGeom): GeomPrimitives {
  const points: Coord[] = [];
  const vertices: Coord[] = [];
  const segments: Array<[Coord, Coord]> = [];
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
        pushLine(part.shell);
        for (const hole of part.holes) pushLine(hole);
      }
      break;
  }
  return { points, vertices, segments };
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

/**
 * First vertex of `vertices` that lies inside `geom`, or null.
 *
 * Containment goes through the kernel's locator, so a vertex sitting in a polygon
 * *hole* is correctly NOT contained — the old per-ring ray cast reported distance
 * 0 for a point in the middle of a donut hole, where GEOS reports the distance to
 * the hole's boundary.
 */
function firstContainedVertex(
  geom: GeoGeom,
  vertices: Coord[],
  locator: SubjectLocator,
  subject: number
): Coord | null {
  for (const v of vertices) {
    if (locator.contains(subject, v)) return v;
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
  const locator = new SubjectLocator([a, b], MIN_COORD_TOLERANCE);
  const contained = firstContainedVertex(a, pb.vertices, locator, 0)
    ?? firstContainedVertex(b, pa.vertices, locator, 1);
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
// Distance — nearest / k-nearest (QGIS "Distance matrix" & "Join by nearest")
// ---------------------------------------------------------------------------

/** Gap between two extents in map units (0 when they overlap or touch). */
function extentGap(a: Extent4, b: Extent4): number {
  const dx = Math.max(b[0] - a[2], a[0] - b[2], 0);
  const dy = Math.max(b[1] - a[3], a[1] - b[3], 0);
  return Math.hypot(dx, dy);
}

/**
 * Largest Web Mercator scale factor across two extents.
 *
 * Dividing a map-unit gap by it gives a LOWER bound for the ground distance, so
 * extent-based pruning can never discard a candidate that is really nearer.
 */
function mercatorBound(a: Extent4, b: Extent4): number {
  const ys = [a[1], a[3], b[1], b[3]].filter(Number.isFinite).map(Math.abs);
  return mercatorScaleFactor(ys.length > 0 ? Math.max(...ys) : 0);
}

export interface NearestDistanceResult {
  featureA_index: number;
  featureB_index: number;
  /** 1 = nearest, 2 = second nearest, … */
  rank: number;
  distance_meters: number;
  distance_map_units: number;
  distance_display: number;
  unit: DistanceUnit;
  closest_on_a: Coord;
  closest_on_b: Coord;
  overlapping: boolean;
}

/**
 * The k nearest features of `layerB` for every feature of `layerA`.
 *
 * This is the default QGIS distance behaviour (Distance matrix / Join attributes
 * by nearest) and it replaces the N×M all-pairs product, which for two 1 000-feature
 * layers is a million results nobody asked for. Candidates come from an R-tree and
 * are visited in order of their extent-gap lower bound, so the exact (expensive)
 * distance is only computed until the k-th best is provably nearer than anything
 * left in the queue.
 */
export async function computeNearestDistances(
  layerA: GeoFeature[],
  layerB: GeoFeature[],
  unit: DistanceUnit,
  k: number = 1,
  progress: ProgressToken = createProgress(),
  onProgress?: ProgressReporter
): Promise<NearestDistanceResult[]> {
  const wanted = Math.max(1, Math.floor(k) || 1);
  if (layerA.length === 0 || layerB.length === 0) return [];
  const index = buildFeatureIndex(layerB);
  const bExtents = layerB.map(f => featureExtent(f));
  const allB = featuresExtent(layerB);
  const span = extentSpan(allB) || 1;
  const results: NearestDistanceResult[] = [];

  await progressLoop(
    layerA.length,
    progress,
    i => {
      const a = layerA[i].geometry;
      if (!a) return;
      const aExtent = geometryExtent(a);
      const scale = mercatorBound(aExtent, allB);

      // Grow the query box until it holds enough candidates to choose from.
      let pad = 0;
      let candidates: number[] = [];
      for (let attempt = 0; attempt < 40; attempt++) {
        candidates = index.query(pad === 0 ? aExtent : expandExtent(aExtent, pad));
        if (candidates.length >= wanted || pad > span * 16) break;
        pad = pad === 0 ? Math.max(span / 64, 1) : pad * 4;
      }

      const ordered = candidates
        .map(j => ({ j, lower: extentGap(aExtent, bExtents[j]) / scale }))
        .sort((x, y) => x.lower - y.lower);

      const best: DistanceResult[] = [];
      for (const candidate of ordered) {
        const b = layerB[candidate.j].geometry;
        if (!b) continue;
        if (best.length >= wanted && candidate.lower > best[best.length - 1].distance_meters) break;
        best.push(distanceResult(i, candidate.j, a, b, unit));
        best.sort((x, y) => x.distance_meters - y.distance_meters);
        if (best.length > wanted) best.pop();
      }
      best.forEach((entry, rank) => results.push({ ...entry, rank: rank + 1 }));
    },
    onProgress,
    'Finding nearest'
  );
  return progress.cancelled ? [] : results;
}

/**
 * Copies of the input features carrying their nearest-neighbour attributes —
 * what QGIS's "Join attributes by nearest" writes back onto the input.
 */
export function nearestAttributeFeatures(
  layerA: GeoFeature[],
  results: NearestDistanceResult[]
): GeoFeature[] {
  const out: GeoFeature[] = [];
  for (const r of results) {
    const a = layerA[r.featureA_index];
    if (!a) continue;
    out.push({
      type: 'Feature',
      geometry: a.geometry,
      properties: {
        ...a.properties,
        nearest_rank: r.rank,
        nearest_id: r.featureB_index + 1,
        nearest_distance: Math.round(r.distance_display * 1000) / 1000,
        nearest_unit: r.unit,
        nearest_x: r.closest_on_b[0],
        nearest_y: r.closest_on_b[1],
        overlapping: r.overlapping,
      },
    });
  }
  return out;
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

export type EliminateStrategy = 'largestArea' | 'smallestArea' | 'largestCommonBoundary';

/**
 * Eliminate selected polygons by dissolving each into an adjacent neighbour.
 *
 * For each selected polygon:
 * 1. find every unselected polygon that touches it (exact, via the kernel),
 * 2. pick the best neighbour according to `strategy`,
 * 3. union the two geometries exactly,
 * 4. the selected polygon disappears, its area absorbed.
 */
export interface EliminateResult {
  /** Surviving features, with absorbed geometry merged into neighbours. */
  features: GeoFeature[];
  /**
   * Indices of selected polygons that were removed *without* their area being
   * absorbed — only possible now when there is no adjacent neighbour at all,
   * since the merge itself is exact. The panel surfaces these by toast so area
   * never disappears silently.
   */
  droppedIndices: number[];
}

interface EliminateEntry {
  feature: GeoFeature;
  eliminated: boolean;
  extent: Extent4;
}

/** Planar area a polygon geometry covers, holes subtracted (map units²). */
function polygonCoveredArea(geom: GeoGeom | null): number {
  let total = 0;
  for (const part of getPolygonParts(geom)) {
    const shell = Math.abs(signedArea(part.shell));
    const holes = part.holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
    total += shell - holes;
  }
  return Math.max(0, total);
}

/**
 * Absorb one selected polygon into its best adjacent neighbour.
 *
 * Adjacency and the merge itself both go through the overlay kernel now:
 * `geometriesAdjacent` sees a shared node anywhere along the boundary (a partial
 * overlap, a T-junction, a corner touch), where the old test needed two matching
 * vertices or fell back to "anything within 0.5 map units"; and `unionMany`
 * merges the pair exactly instead of splicing one shared edge chain and giving
 * up on everything else.
 *
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
  if (!isAreaGeometry(selectedGeom)) return false;

  interface Candidate { index: number; area: number; sharedBoundary: number }
  const candidates: Candidate[] = [];
  for (const j of index.query(selected.extent)) {
    if (j === i || working[j].eliminated) continue;
    const neighbourGeom = working[j].feature.geometry;
    if (!isAreaGeometry(neighbourGeom)) continue;
    if (!geometriesAdjacent(selectedGeom, neighbourGeom, { tolerance })) continue;
    candidates.push({
      index: j,
      area: polygonCoveredArea(neighbourGeom),
      sharedBoundary: sharedBoundaryLength(selectedGeom, neighbourGeom, { tolerance }),
    });
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
  const merged = unionMany([neighbour.feature.geometry, selectedGeom], { tolerance });
  if (!merged) return false;
  neighbour.feature = { ...neighbour.feature, geometry: merged };
  neighbour.extent = geometryExtent(merged);
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
  /** Every reason, joined — kept for the panel's one-line summary. */
  reason: string;
  /** Every reason separately, each with its location (GEOS/QGIS error classes). */
  errors: ValidityError[];
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

/**
 * Check validity of every feature, reporting ALL reasons per feature.
 *
 * The checks themselves live in utils/overlay.ts (`validateGeometry`) and cover
 * the GEOS/QGIS classes: ring self-intersection, hole outside shell, nested
 * holes, disconnected interior (rings that touch at a single point), duplicate
 * rings, unclosed rings, too few distinct points, non-finite coordinates and —
 * for multipolygons — overlapping parts.
 */
export function checkValidity(
  features: GeoFeature[],
  tolerance?: number
): ValidityResult[] {
  return features.map(feature => {
    if (!feature.geometry) {
      const error: ValidityError = {
        code: 'too-few-points',
        message: 'Null geometry.',
        location: null,
        part: 0,
        ring: 0,
      };
      return { feature, valid: false, reason: error.message, errors: [error] };
    }
    const errors = validateGeometry(feature.geometry, tolerance === undefined ? {} : { tolerance });
    return {
      feature,
      valid: errors.length === 0,
      reason: errors.length === 0 ? 'Valid.' : errors.map(e => e.message).join(' '),
      errors,
    };
  });
}

/**
 * QGIS's "error output" layer: one point per located validity error, carrying the
 * reason and the index of the feature it came from.
 */
export function validityErrorPoints(results: ValidityResult[]): GeoFeature[] {
  const points: GeoFeature[] = [];
  results.forEach((result, featureIndex) => {
    for (const error of result.errors) {
      if (!error.location) continue;
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: error.location },
        properties: {
          feature_index: featureIndex + 1,
          error_code: error.code,
          error: error.message,
          part: error.part,
          ring: error.ring,
        },
      });
    }
  });
  return points;
}

// ---- Collect Geometries ---------------------------------------------------

export interface CollectGeometriesOptions {
  /**
   * Group-by field(s) — QGIS "Collect geometries" has the same option. Groups
   * keep those attributes; without it every feature lands in one collection and
   * the attributes cannot be kept (they would disagree).
   */
  fields?: string[];
}

/** Collect the geometries of one group into multi-geometry features. */
function collectGroup(features: GeoFeature[], properties: Record<string, any>): GeoFeature[] {
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
      case 'Polygon': allPolys.push(...geometryParts(f.geometry)); break;
      case 'MultiPolygon': allPolys.push(...geometryParts(f.geometry)); break;
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
  return resultGeoms.map(g => ({ type: 'Feature' as const, geometry: g, properties: { ...properties } }));
}

/**
 * Merge features into multi-geometry features, optionally grouped by field value.
 *
 * A group whose members are all the same type yields ONE multipart feature; a
 * mixed group yields one feature per geometry type (a GeoJSON feature cannot hold
 * points and polygons at once).
 */
export function collectGeometries(features: GeoFeature[], options: CollectGeometriesOptions = {}): GeoFeature[] {
  if (features.length === 0) return [];
  const fields = (options.fields ?? []).filter(f => typeof f === 'string' && f.length > 0);
  if (fields.length === 0) return collectGroup(features, {});

  const groups = new Map<string, GeoFeature[]>();
  for (const f of features) {
    const key = featureGroupKey(f.properties, fields);
    const list = groups.get(key);
    if (list) list.push(f); else groups.set(key, [f]);
  }
  const results: GeoFeature[] = [];
  for (const group of groups.values()) {
    const attributes: Record<string, any> = {};
    for (const field of fields) attributes[field] = group[0].properties?.[field] ?? null;
    results.push(...collectGroup(group, attributes));
  }
  return results;
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
 *
 * With `tolerance` > 0 the coordinates are quantised onto that grid first, so
 * near-coincident vertices collapse into one seed — Bowyer-Watson's incircle test
 * is badly conditioned for duplicates, which is why QGIS and PostGIS both expose
 * a snapping tolerance here. (The duplicate scan is a hash set now, not an
 * O(n²) `some()` over the seeds collected so far.)
 */
function collectSeedPoints(features: GeoFeature[], tolerance = 0): SeedPoint[] {
  const seeds: SeedPoint[] = [];
  const seen = new Set<string>();
  const snap = tolerance > 0 ? tolerance : 0;
  for (let i = 0; i < features.length; i++) {
    const geom = features[i].geometry;
    if (!geom) continue;
    for (const c of collectCoords(geom)) {
      const point: Coord = snap > 0
        ? [Math.round(c[0] / snap) * snap, Math.round(c[1] / snap) * snap]
        : c;
      const key = `${point[0]}:${point[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ point, featureIndex: i });
    }
  }
  return seeds;
}

function collectTriangulationPoints(features: GeoFeature[], tolerance = 0): Coord[] {
  return collectSeedPoints(features, tolerance).map(s => s.point);
}

/** Unique triangle edges as line features — QGIS "Create edges instead of polygons". */
function trianglesToEdges(triangles: GeoFeature[]): GeoFeature[] {
  const seen = new Set<string>();
  const edges: GeoFeature[] = [];
  for (const t of triangles) {
    if (t.geometry?.type !== 'Polygon') continue;
    const ring = t.geometry.coordinates[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const key = edgeKey(ring[i], ring[i + 1]);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [ring[i], ring[i + 1]] },
        properties: {},
      });
    }
  }
  return edges;
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

export interface DelaunayOptions {
  /** Snap seeds closer than this together first (map units). 0 = off. */
  tolerance?: number;
  /** Emit the triangulation as edges instead of triangles. */
  outputEdges?: boolean;
  progress?: ProgressToken;
  onProgress?: ProgressReporter;
}

/**
 * Bowyer-Watson Delaunay triangulation of the input vertices.
 *
 * The floating-point incircle test is still fragile for exactly cocircular seeds
 * (four corners of a square, say); `tolerance` is the practical answer, and it is
 * what QGIS/PostGIS expose for the same reason.
 */
export function delaunayTriangulation(features: GeoFeature[], options: DelaunayOptions = {}): GeoFeature[] {
  const points = collectTriangulationPoints(features, options.tolerance ?? 0);
  const state = createDelaunayState(points);
  if (!state) return [];
  for (const pt of points) state.insert(pt);
  const triangles = state.finish();
  return options.outputEdges === true ? trianglesToEdges(triangles) : triangles;
}

/** Delaunay with progress reporting and cancellation. */
export async function delaunayTriangulationAsync(
  features: GeoFeature[],
  options: DelaunayOptions = {}
): Promise<GeoFeature[]> {
  const progress = options.progress ?? createProgress();
  const points = collectTriangulationPoints(features, options.tolerance ?? 0);
  const state = createDelaunayState(points);
  if (!state) return [];
  const ok = await progressLoop(
    points.length,
    progress,
    i => state.insert(points[i]),
    options.onProgress,
    'Triangulating'
  );
  if (!ok) return [];
  const triangles = state.finish();
  return options.outputEdges === true ? trianglesToEdges(triangles) : triangles;
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
  /**
   * Write x/y in degrees (EPSG:4326 lon/lat) rather than EPSG:3857 metres.
   * Default true: that is what QGIS's Add Geometry Attributes reports, and it is
   * the only form that is meaningful across a web-Mercator map.
   */
  xyInDegrees?: boolean;
  /** Also write the number of vertices in the geometry. */
  addVertexCount?: boolean;
}

/**
 * Add geometry-derived attributes (area, length, perimeter, x, y, vertex_count).
 *
 * Areas and lengths are true ground metres/measured on the ellipsoid-ish sphere
 * (utils/geodesic.ts), so they agree with the on-map measure tool instead of being
 * stretched Web Mercator units. x/y default to lon/lat degrees.
 */
export function addGeometryAttributes(
  features: GeoFeature[],
  options: GeometryAttrOptions
): GeoFeature[] {
  const degrees = options.xyInDegrees !== false;
  return features.map(f => {
    if (!f.geometry) return f;
    const props = { ...f.properties };
    const parts = getPolygonParts(f.geometry);

    if (options.addArea) {
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
      const c = geomCentroid(f.geometry);
      const out = degrees ? mercatorToLonLat(c) : c;
      if (options.addX) props.x = out[0];
      if (options.addY) props.y = out[1];
    }

    if (options.addVertexCount) {
      props.vertex_count = collectCoords(f.geometry, { includeHoles: true }).length;
    }

    return { type: 'Feature' as const, geometry: f.geometry, properties: props };
  });
}

// ---- Extract Vertices -----------------------------------------------------

export interface ExtractVerticesOptions {
  /**
   * Write `vertex_index` (per feature), `vertex_part`, `vertex_part_index` and
   * `vertex_ring` — QGIS parity. On by default.
   */
  addIndices?: boolean;
  /**
   * Write `distance` (cumulative map-unit distance along the ring/line) and
   * `angle` (the turn at the vertex, in degrees; 0 = straight through, positive =
   * turning left). On by default.
   */
  addDistanceAndAngle?: boolean;
  /**
   * Skip the duplicated closing vertex of each ring. Off by default, matching
   * QGIS, which emits it with its own index.
   */
  skipClosingVertex?: boolean;
}

interface VertexSequence {
  /** 1-based part (polygon part, line part, or point index). */
  part: number;
  /** 1-based ring within the part (polygons only; 1 for lines and points). */
  ring: number;
  coords: Coord[];
}

/** Every coordinate sequence of a geometry, tagged with its part and ring. */
function vertexSequences(geom: GeoGeom, skipClosingVertex: boolean): VertexSequence[] {
  const trim = (coords: Coord[], closed: boolean): Coord[] => {
    if (!closed || !skipClosingVertex || coords.length < 2) return coords;
    const first = coords[0];
    const last = coords[coords.length - 1];
    return first[0] === last[0] && first[1] === last[1] ? coords.slice(0, -1) : coords;
  };
  const out: VertexSequence[] = [];
  switch (geom.type) {
    case 'Point':
      out.push({ part: 1, ring: 1, coords: [geom.coordinates] });
      break;
    case 'MultiPoint':
      geom.coordinates.forEach((c, i) => out.push({ part: i + 1, ring: 1, coords: [c] }));
      break;
    case 'LineString':
      out.push({ part: 1, ring: 1, coords: trim(geom.coordinates, false) });
      break;
    case 'MultiLineString':
      geom.coordinates.forEach((line, i) => out.push({ part: i + 1, ring: 1, coords: trim(line, false) }));
      break;
    case 'Polygon':
      geom.coordinates.forEach((ring, i) => out.push({ part: 1, ring: i + 1, coords: trim(ring, true) }));
      break;
    case 'MultiPolygon':
      geom.coordinates.forEach((part, pi) => {
        part.forEach((ring, ri) => out.push({ part: pi + 1, ring: ri + 1, coords: trim(ring, true) }));
      });
      break;
  }
  return out.filter(seq => seq.coords.length > 0);
}

/** Turn at `coords[i]` in degrees, or null at a sequence end. */
function turnAngleAt(coords: Coord[], i: number): number | null {
  if (i <= 0 || i >= coords.length - 1) return null;
  const a = coords[i - 1];
  const b = coords[i];
  const c = coords[i + 1];
  const inBearing = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const outBearing = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let turn = ((outBearing - inBearing) * 180) / Math.PI;
  while (turn > 180) turn -= 360;
  while (turn <= -180) turn += 360;
  return Math.round(turn * 1e6) / 1e6;
}

/**
 * Extract every vertex of every feature as a point feature.
 *
 * Holes are geometry too, so their vertices are included (they used to be
 * skipped), and each point now carries the index/part/distance/angle attributes
 * QGIS writes, which is what makes the output usable for vertex-level analysis
 * instead of just a dot cloud.
 */
export function extractVertices(features: GeoFeature[], options: ExtractVerticesOptions = {}): GeoFeature[] {
  const addIndices = options.addIndices !== false;
  const addMetrics = options.addDistanceAndAngle !== false;
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    let vertexIndex = 0;
    for (const seq of vertexSequences(f.geometry, options.skipClosingVertex === true)) {
      let cumulative = 0;
      for (let i = 0; i < seq.coords.length; i++) {
        if (i > 0) cumulative += dist(seq.coords[i - 1], seq.coords[i]);
        const props: Record<string, any> = { ...f.properties };
        if (addIndices) {
          props.vertex_index = vertexIndex;
          props.vertex_part = seq.part;
          props.vertex_part_index = i;
          props.vertex_ring = seq.ring;
        }
        if (addMetrics) {
          props.distance = cumulative;
          const angle = turnAngleAt(seq.coords, i);
          if (angle !== null) props.angle = angle;
        }
        result.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: seq.coords[i] },
          properties: props,
        });
        vertexIndex++;
      }
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

export interface PolygonsToLinesOptions {
  /**
   * Emit one line per ring instead of one multipart line per feature. Off by
   * default: QGIS "Polygons to lines" (and PostGIS `ST_Boundary`) keep a
   * feature's rings together as one MultiLineString.
   */
  perRing?: boolean;
}

/** Drop the closing duplicate so a ring can be used as a LineString. */
function ringAsLine(ring: Ring): Coord[] {
  if (ring.length === 0) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring.slice();
}

/**
 * Convert polygon boundaries to lines — one multipart line per input feature by
 * default (QGIS/`ST_Boundary` parity), or one line per ring with `perRing`.
 */
export function polygonsToLines(features: GeoFeature[], options: PolygonsToLinesOptions = {}): GeoFeature[] {
  const perRing = options.perRing === true;
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const lines = getAllPolygonRings(f.geometry).map(ringAsLine).filter(line => line.length >= 2);
    if (lines.length === 0) continue;
    if (perRing) {
      for (const line of lines) {
        result.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: line },
          properties: { ...f.properties },
        });
      }
      continue;
    }
    result.push({
      type: 'Feature',
      geometry: lines.length === 1
        ? { type: 'LineString', coordinates: lines[0] }
        : { type: 'MultiLineString', coordinates: lines },
      properties: { ...f.properties },
    });
  }
  return result;
}

// ---- Simplify (Douglas-Peucker / Visvalingam-Whyatt) ----------------------

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

function triangleArea(a: Coord, b: Coord, c: Coord): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/**
 * Visvalingam-Whyatt: repeatedly drop the vertex whose removal changes the shape
 * least (smallest triangle area) until every remaining vertex matters more than
 * `minArea`.
 *
 * Where Douglas-Peucker measures perpendicular distance, VW measures the area a
 * vertex contributes, which is why QGIS/PostGIS offer it as the "area" method:
 * it keeps the silhouette of dense coastlines better at the same tolerance.
 */
function visvalingamWhyatt(coords: Coord[], minArea: number): Coord[] {
  const pts = coords.slice();
  if (pts.length <= 3 || minArea <= 0) return pts;
  // Stops at two points: for a line that is the correct end state, and a ring
  // that gets this far is handed back unchanged by the caller's own guard.
  let guard = pts.length * pts.length + 8;
  while (pts.length > 2 && guard-- > 0) {
    let minIdx = -1;
    let minValue = Infinity;
    for (let i = 1; i < pts.length - 1; i++) {
      const area = triangleArea(pts[i - 1], pts[i], pts[i + 1]);
      if (area < minValue) { minValue = area; minIdx = i; }
    }
    if (minIdx < 0 || minValue >= minArea) break;
    pts.splice(minIdx, 1);
  }
  return pts;
}

export type SimplifyMethod = 'distance' | 'area';

export interface SimplifyOptions {
  /**
   * `distance` (default) = Douglas-Peucker, tolerance is a perpendicular distance
   * in map units. `area` = Visvalingam-Whyatt, tolerance is the minimum triangle
   * area a vertex may contribute, in map units² (QGIS's "Area" method).
   */
  method?: SimplifyMethod;
  /**
   * Reject a simplification that breaks the geometry and keep the original ring
   * instead (default true) — QGIS's "Preserve topology" / JTS's
   * TopologyPreservingSimplifier. Simplifying a ring can easily make it
   * self-intersect, and an invalid output is worse than a less simple one.
   */
  preserveTopology?: boolean;
  /**
   * Read the tolerance as ground metres and scale it for Web Mercator latitude,
   * the way Buffer reads its distance (default false = raw map units).
   */
  groundUnits?: boolean;
}

/**
 * Simplify geometries.
 *
 * Lines are simplified directly. Polygon rings keep their closure and at least
 * three distinct vertices, and — with `preserveTopology` — any ring that would
 * come out self-intersecting is left exactly as it was.
 */
export function simplifyFeatures(
  features: GeoFeature[],
  tolerance: number,
  options: SimplifyOptions = {}
): GeoFeature[] {
  if (!(tolerance > 0)) return features.map(f => ({ ...f }));
  const method = options.method === 'area' ? 'area' : 'distance';
  const preserve = options.preserveTopology !== false;

  // For the area method the tolerance is the minimum triangle area (map units²);
  // for the distance method it is a perpendicular distance (map units).
  const simplifyCoords = (coords: Coord[], tol: number): Coord[] =>
    method === 'area' ? visvalingamWhyatt(coords, tol) : douglasPeucker(coords, tol);

  function simplifyRing(ring: Ring, tol: number): Ring {
    const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
    const simplified = simplifyCoords(open, tol);
    if (simplified.length < 3) return ring; // keep the original rather than collapse it
    const closed = closeRing(simplified);
    if (preserve && Math.abs(signedArea(closed)) <= 0) return ring;
    return closed;
  }

  return features.map(f => {
    if (!f.geometry) return f;
    const tol = options.groundUnits === true
      ? tolerance * mercatorScaleFactor(geomCenterY(f.geometry))
      : tolerance;

    let geometry: GeoGeom;
    switch (f.geometry.type) {
      case 'LineString':
        geometry = { type: 'LineString', coordinates: simplifyCoords(f.geometry.coordinates, tol) };
        break;
      case 'MultiLineString':
        geometry = { type: 'MultiLineString', coordinates: f.geometry.coordinates.map(c => simplifyCoords(c, tol)) };
        break;
      case 'Polygon':
        geometry = { type: 'Polygon', coordinates: f.geometry.coordinates.map(r => simplifyRing(r, tol)) };
        break;
      case 'MultiPolygon':
        geometry = { type: 'MultiPolygon', coordinates: f.geometry.coordinates.map(part => part.map(r => simplifyRing(r, tol))) };
        break;
      default:
        geometry = f.geometry;
    }

    // Preserve topology: if simplifying produced an invalid polygon, hand back the
    // original geometry for that feature instead of a bowtie.
    if (preserve && isAreaGeometry(geometry) && validateGeometry(geometry).length > 0) {
      return { type: 'Feature' as const, geometry: f.geometry, properties: { ...f.properties }, simplified: false };
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

  // Seeds are visited nearest-first and the loop breaks as soon as one is more
  // than twice the current cell radius away: the cell is contained in the disc of
  // radius R around its own seed, and a bisector at distance d/2 > R cannot cut
  // it. Same answer as clipping against every seed, far fewer half-plane passes.
  const order = points
    .map((_, j) => j)
    .filter(j => j !== i)
    .sort((a, b) => dist2(pi, points[a]) - dist2(pi, points[b]));

  for (const j of order) {
    const pj = points[j];
    let radius = 0;
    for (const v of cell) radius = Math.max(radius, dist(pi, v));
    if (radius > 0 && dist(pi, pj) > 2 * radius) break;
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
 * Each cell is the padded bounding box clipped by the half-plane of every other
 * seed's perpendicular bisector. Seeds are visited nearest-first and the loop
 * breaks once one is more than twice the current cell radius away — its bisector
 * can no longer cut the cell — so a uniform point set costs O(n·k) rather than
 * O(n²) half-plane passes. GEOS gets there via the Delaunay duality instead;
 * the answers are the same, and this one has no incircle predicate to be
 * fragile about.
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

// ---- Polygonize -----------------------------------------------------------

/**
 * Build every enclosed face of a line network — GEOS `ST_Polygonize` / the QGIS
 * "Polygonize" tool.
 *
 * Unlike Lines to polygons, the input does not have to be a set of already-closed
 * rings: the lines are noded against each other first, so a parcel boundary stored
 * as separate arcs (or a road network) yields every polygon it encloses, with
 * dangles and open ends ignored.
 */
export function polygonizeFeatures(features: GeoFeature[]): GeoFeature[] {
  const geoms = features.map(f => f.geometry).filter((g): g is GeoGeom => g !== null);
  if (geoms.length === 0) return [];
  return polygonizeGeometries(geoms).map((geometry, i) => ({
    type: 'Feature' as const,
    geometry,
    properties: { face_index: i + 1 },
  }));
}

// ---- Point on Surface -----------------------------------------------------

/**
 * A point guaranteed to lie INSIDE each feature — QGIS "Point on surface" /
 * GEOS `ST_PointOnSurface`.
 *
 * The centroid of a concave polygon (a C, a crescent, a donut) can fall outside
 * it or in its hole, which makes centroid labels unusable; this scans for the
 * widest horizontal run inside the shell and outside every hole instead.
 */
export function pointsOnSurface(features: GeoFeature[]): GeoFeature[] {
  const out: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const point = geometryInteriorPoint(f.geometry);
    if (!point) continue;
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: point },
      properties: { ...f.properties },
    });
  }
  return out;
}

// ---- Make Valid -----------------------------------------------------------

/** Drop vertices that are not finite numbers (they would poison the kernel). */
function stripNonFinite(geom: GeoGeom): GeoGeom {
  const clean = (coords: Coord[]): Coord[] => coords.filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  switch (geom.type) {
    case 'Point':
      return Number.isFinite(geom.coordinates[0]) && Number.isFinite(geom.coordinates[1]) ? geom : { type: 'Point', coordinates: [0, 0] };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: clean(geom.coordinates) };
    case 'LineString':
      return { type: 'LineString', coordinates: clean(geom.coordinates) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geom.coordinates.map(clean) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: geom.coordinates.map(r => closeRing(clean(r))).filter(r => r.length >= 4) };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates
          .map(part => part.map(r => closeRing(clean(r))).filter(r => r.length >= 4))
          .filter(part => part.length > 0),
      };
  }
}

/**
 * Repair invalid geometries without losing any of them.
 *
 * The repair is the overlay kernel applied to a geometry's own noded linework
 * (`repairGeometry`), which is what GEOS `MakeValid`/QGIS "Fix geometries" does:
 * a bowtie becomes a MultiPolygon of BOTH lobes instead of the largest one, a
 * hole outside its shell becomes a polygon of its own, ring orientation and
 * closure are fixed, duplicate vertices are removed, and a geometry that was
 * already valid comes back unchanged.
 *
 * `was_invalid` is now measured (it used to be stamped `true` on every feature,
 * valid or not), and `validity_errors` says how many problems were repaired.
 */
export function makeValid(features: GeoFeature[]): GeoFeature[] {
  const results: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) {
      results.push(f);
      continue;
    }
    const cleaned = stripNonFinite(f.geometry);
    const errors = validateGeometry(cleaned);
    if (errors.length === 0) {
      results.push({
        type: 'Feature',
        geometry: cleaned,
        properties: { ...f.properties, was_invalid: false, validity_errors: 0 },
      });
      continue;
    }
    const repaired = isAreaGeometry(cleaned) ? repairGeometry(cleaned) : cleaned;
    if (!repaired) continue; // nothing salvageable — better dropped than invented
    results.push({
      type: 'Feature',
      geometry: repaired,
      properties: { ...f.properties, was_invalid: true, validity_errors: errors.length },
    });
  }
  return results;
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

/**
 * Make a field value safe to use as a layer/file name.
 *
 * Split used to name a layer with the raw attribute value, so a value containing
 * `/`, `\\` or a control character produced a layer name that broke the download
 * filename and the workspace UI.
 */
export function sanitiseLayerName(name: string): string {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : '(unnamed)';
}

export interface SplitLayerResult {
  /** Name for the output layer (sanitised field value). */
  name: string;
  /** Features belonging to this split group. */
  features: GeoFeature[];
}

/**
 * Split features into groups by the value of a chosen field.
 * Each unique value becomes one output layer.
 * Null/undefined values form their own group, named "(no value)".
 */
export function splitVectorLayer(features: GeoFeature[], fieldName: string): SplitLayerResult[] {
  const groups = new Map<string, GeoFeature[]>();

  for (const f of features) {
    // Same grouping rule as Dissolve, so the two tools never disagree about
    // what "the same value" means.
    const key = featureGroupKey(f.properties, [fieldName]);

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
    results.push({
      name: name === NULL_GROUP_KEY ? '(no value)' : sanitiseLayerName(name),
      features: feats,
    });
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
