/**
 * geoprocessing.ts — Pure vector geoprocessing engines.
 *
 * All functions work on plain GeoJSON-like structures (no React, no OL imports).
 * Coordinates are in EPSG:3857 (metres) unless noted.
 *
 * Supported tools:
 *   buffer, clip, intersect, union, dissolve, centroid, convexHull, distance
 */

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
    endCap.push(...generateArc(lastSeg, Math.abs(radius), leftEndAngle, rightEndAngle, opts.segments));
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
    startCap.push(...generateArc(firstSeg, Math.abs(radius), rightStartAngle, leftStartAngle, opts.segments));
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

  // Check orientation — for negative buffer, a collapsed polygon flips orientation
  const area = signedArea(result);
  if (radius >= 0 && area < 0) return null; // should not happen for positive
  if (radius < 0 && area < 0) return null;  // collapsed
  return result;
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
      const buffered = bufferPolygonRing(geom.coordinates[0], scaledDistance, opts);
      if (!buffered) return null;
      return { type: 'Polygon', coordinates: [buffered] };
    }
    case 'MultiPolygon': {
      const results: Ring[][] = [];
      for (const poly of geom.coordinates) {
        const buffered = bufferPolygonRing(poly[0], scaledDistance, opts);
        if (buffered) results.push([buffered]);
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

/** Clip subject polygon by clip polygon using Sutherland-Hodgman. */
export function clipPolygon(subject: Ring, clip: Ring): Ring | null {
  if (subject.length < 4 || clip.length < 4) return null;
  const clipCCW = ensureCCW(clip);
  let output = subject.slice();
  for (let i = 0; i < clipCCW.length - 1; i++) {
    if (output.length === 0) return null;
    output = clipEdgeByLine(output, clipCCW[i], clipCCW[i + 1]);
  }
  if (output.length < 3) return null;
  output.push(output[0]);
  return output;
}

// ---------------------------------------------------------------------------
// Clip — clip input layer features by clip layer polygons
// ---------------------------------------------------------------------------

function getPolygonRings(geom: GeoGeom): Ring[] {
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flatMap(p => p);
  return [];
}

function getAllClipRings(features: GeoFeature[]): Ring[] {
  const rings: Ring[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    rings.push(...getPolygonRings(f.geometry));
  }
  return rings;
}

function clipFeatureByRings(feature: GeoFeature, clipRings: Ring[]): GeoFeature[] {
  if (!feature.geometry) return [];
  const subjectRings = getPolygonRings(feature.geometry);
  if (subjectRings.length === 0) return [];
  const results: GeoFeature[] = [];
  for (const sr of subjectRings) {
    for (const cr of clipRings) {
      const clipped = clipPolygon(sr, cr);
      if (clipped && clipped.length >= 4) {
        results.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [clipped] },
          properties: { ...feature.properties },
        });
      }
    }
  }
  return results;
}

export function clipFeatures(input: GeoFeature[], clipLayer: GeoFeature[]): GeoFeature[] {
  const clipRings = getAllClipRings(clipLayer);
  if (clipRings.length === 0) return [];
  return input.flatMap(f => clipFeatureByRings(f, clipRings));
}

// ---------------------------------------------------------------------------
// Intersect — pairwise intersection of two polygon layers
// ---------------------------------------------------------------------------

export function intersectFeatures(layerA: GeoFeature[], layerB: GeoFeature[]): GeoFeature[] {
  const results: GeoFeature[] = [];
  for (const a of layerA) {
    if (!a.geometry) continue;
    const aRings = getPolygonRings(a.geometry);
    for (const b of layerB) {
      if (!b.geometry) continue;
      const bRings = getPolygonRings(b.geometry);
      for (const ar of aRings) {
        for (const br of bRings) {
          const clipped = clipPolygon(ar, br);
          if (clipped && clipped.length >= 4) {
            results.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [clipped] },
              properties: { ...a.properties, ...b.properties },
            });
          }
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Union — combine all features from two layers into one collection
// ---------------------------------------------------------------------------

export async function unionFeatures(layerA: GeoFeature[], layerB: GeoFeature[]): Promise<GeoFeature[]> {
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
  const dissolved = await dissolveFeatures(polyFeatures, true);

  return [...dissolved, ...otherFeatures.map(f => ({
    type: 'Feature' as const,
    geometry: f.geometry,
    properties: { ...f.properties },
  }))];
}

// ---------------------------------------------------------------------------
// Dissolve — merge all features into a single feature
// ---------------------------------------------------------------------------

export interface DissolveProgress {
  /** Current step description */
  message: string;
  /** Progress from 0 to 1 */
  progress: number;
  /** Set to true to cancel the operation */
  cancelled: boolean;
}

/**
 * Yield to the event loop to keep the UI responsive.
 * Call this periodically during long-running operations.
 */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export async function dissolveFeatures(
  features: GeoFeature[],
  dissolveOverlap: boolean = false,
  onProgress?: (p: DissolveProgress) => void
): Promise<GeoFeature[]> {
  const progress: DissolveProgress = { message: '', progress: 0, cancelled: false };
  const report = (message: string, p: number) => {
    progress.message = message;
    progress.progress = p;
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
      const mergedRings = await dissolveAdjacentRingsAsync(allPolyRings, progress);
      
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
 * Uses spatial indexing for performance with large datasets.
 * Async version that yields to UI to prevent freezing.
 * Each input is a polygon (array of rings: [outer, ...holes]).
 * Returns the resulting array of polygons after all possible merges.
 */
async function dissolveAdjacentRingsAsync(
  polys: Ring[][],
  progress: DissolveProgress
): Promise<Ring[][]> {
  if (polys.length === 0) return [];
  if (polys.length === 1) return polys;

  // Build spatial index (bounding box grid) for fast neighbor lookup
  interface BBox { minX: number; minY: number; maxX: number; maxY: number; }
  const bboxes: BBox[] = polys.map(p => {
    const ring = p[0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const x = ring[i][0], y = ring[i][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  });

  // Working copy with active flags
  const working = polys.map((p, i) => ({ rings: p, bbox: bboxes[i], active: true }));
  const totalPairs = (working.length * (working.length - 1)) / 2;
  let pairsChecked = 0;

  // Check if two bounding boxes overlap
  function bboxOverlap(a: BBox, b: BBox): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX &&
           a.minY <= b.maxY && a.maxY >= b.minY;
  }

  // Iteratively merge overlapping/adjacent polygons
  let changed = true;
  let maxIterations = working.length * 2; // safety limit
  let iteration = 0;
  
  while (changed && maxIterations > 0) {
    changed = false;
    maxIterations--;
    iteration++;
    
    // Yield every few iterations to keep UI responsive
    if (iteration % 5 === 0) {
      await yieldToUI();
      if (progress.cancelled) return working.filter(w => w.active).map(w => w.rings);
    }
    
    outer: for (let i = 0; i < working.length; i++) {
      if (!working[i].active) continue;
      
      for (let j = i + 1; j < working.length; j++) {
        if (!working[j].active) continue;
        pairsChecked++;
        
        // Quick bbox check
        if (!bboxOverlap(working[i].bbox, working[j].bbox)) continue;
        
        // Try to union the two polygons
        const ring1 = working[i].rings[0];
        const ring2 = working[j].rings[0];
        
        // First try edge-adjacent merge (fast path)
        let merged: Ring | null = null;
        if (ringsAdjacent(ring1, ring2)) {
          merged = dissolveTwoPolygons(ring1, ring2);
        }
        
        // If that failed, try proper polygon union (handles overlaps)
        if (!merged) {
          merged = polygonUnion(ring1, ring2);
        }
        
        if (merged) {
          // Merge succeeded - update polygon i, deactivate polygon j
          const mergedHoles = [...working[i].rings.slice(1), ...working[j].rings.slice(1)];
          working[i].rings = [merged, ...mergedHoles];
          
          // Update bounding box
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let k = 0; k < merged.length - 1; k++) {
            const x = merged[k][0], y = merged[k][1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
          working[i].bbox = { minX, minY, maxX, maxY };
          working[j].active = false;
          
          const activeCount = working.filter(w => w.active).length;
          progress.message = `Dissolving... ${activeCount} polygons remaining`;
          progress.progress = 0.1 + 0.8 * (pairsChecked / Math.max(totalPairs, 1));
          
          changed = true;
          break outer; // restart from beginning
        }
      }
    }
  }
  
  // Return only active polygons
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
    case 'Polygon':
      return ringCentroid(geom.coordinates[0]);
    case 'MultiPolygon': {
      // Weighted centroid by area
      let totalArea = 0, cx = 0, cy = 0;
      for (const poly of geom.coordinates) {
        const c = ringCentroid(poly[0]);
        const a = Math.abs(signedArea(poly[0]));
        cx += c[0] * a;
        cy += c[1] * a;
        totalArea += a;
      }
      return totalArea > 0 ? [cx / totalArea, cy / totalArea] : [0, 0];
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

function collectCoords(geom: GeoGeom): Coord[] {
  switch (geom.type) {
    case 'Point': return [geom.coordinates];
    case 'MultiPoint': return geom.coordinates;
    case 'LineString': return geom.coordinates;
    case 'MultiLineString': return geom.coordinates.flat();
    case 'Polygon': return geom.coordinates[0];
    case 'MultiPolygon': return geom.coordinates.map(p => p[0]).flat();
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

function pointToSegmentDist(p: Coord, a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
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

function segmentToSegmentDist(a1: Coord, a2: Coord, b1: Coord, b2: Coord): number {
  // Exact analytical closest-point-on-two-segments algorithm.
  // Parameterise: P(s) = a1 + s*(a2-a1), Q(t) = b1 + t*(b2-b1), s,t ∈ [0,1].
  // Minimise |P(s) - Q(t)|² over the unit square.
  const dax = a2[0] - a1[0], day = a2[1] - a1[1];
  const dbx = b2[0] - b1[0], dby = b2[1] - b1[1];
  const rx = a1[0] - b1[0], ry = a1[1] - b1[1];

  const aa = dax * dax + day * day;   // |d_a|²
  const bb = dbx * dbx + dby * dby;   // |d_b|²
  const ab = dax * dbx + day * dby;   // d_a · d_b
  const a_r = dax * rx + day * ry;    // d_a · (a1-b1)
  const b_r = dbx * rx + dby * ry;    // d_b · (a1-b1)

  // Degenerate cases: one or both segments are zero-length
  const EPS = 1e-12;
  if (aa < EPS && bb < EPS) return dist(a1, b1);
  if (aa < EPS) return pointToSegmentDist(a1, b1, b2);
  if (bb < EPS) return pointToSegmentDist(b1, a1, a2);

  const denom = aa * bb - ab * ab; // always ≥ 0 (Cauchy–Schwarz)

  let s: number, t: number;
  if (Math.abs(denom) < EPS) {
    // Segments are parallel — fix s=0 and solve for t
    s = 0;
    t = Math.max(0, Math.min(1, b_r / bb));
  } else {
    // Interior critical point
    s = (ab * b_r - bb * a_r) / denom;
    t = (aa * b_r - ab * a_r) / denom;

    // If outside [0,1]², solve constrained edge problems
    if (s < 0 || s > 1 || t < 0 || t > 1) {
      let bestDist = Infinity;
      let bestS = 0, bestT = 0;

      // Edge s=0: minimise |a1 - Q(t)|²
      { const tc = Math.max(0, Math.min(1, b_r / bb));
        const qx = b1[0] + tc * dbx, qy = b1[1] + tc * dby;
        const dd = (a1[0] - qx) ** 2 + (a1[1] - qy) ** 2;
        if (dd < bestDist) { bestDist = dd; bestS = 0; bestT = tc; } }

      // Edge s=1: minimise |a2 - Q(t)|²
      { const a2rx = a2[0] - b1[0], a2ry = a2[1] - b1[1];
        const b_r2 = dbx * a2rx + dby * a2ry;
        const tc = Math.max(0, Math.min(1, b_r2 / bb));
        const qx = b1[0] + tc * dbx, qy = b1[1] + tc * dby;
        const dd = (a2[0] - qx) ** 2 + (a2[1] - qy) ** 2;
        if (dd < bestDist) { bestDist = dd; bestS = 1; bestT = tc; } }

      // Edge t=0: minimise |P(s) - b1|²
      { const sc = Math.max(0, Math.min(1, a_r / aa));
        const px = a1[0] + sc * dax, py = a1[1] + sc * day;
        const dd = (px - b1[0]) ** 2 + (py - b1[1]) ** 2;
        if (dd < bestDist) { bestDist = dd; bestS = sc; bestT = 0; } }

      // Edge t=1: minimise |P(s) - b2|²
      { const a1rx = a1[0] - b2[0], a1ry = a1[1] - b2[1];
        const a_r2 = dax * a1rx + day * a1ry;
        const sc = Math.max(0, Math.min(1, a_r2 / aa));
        const px = a1[0] + sc * dax, py = a1[1] + sc * day;
        const dd = (px - b2[0]) ** 2 + (py - b2[1]) ** 2;
        if (dd < bestDist) { bestDist = dd; bestS = sc; bestT = 1; } }

      return Math.sqrt(bestDist);
    }
  }

  // Both s,t are interior — compute distance at the critical point
  const px = a1[0] + s * dax - (b1[0] + t * dbx);
  const py = a1[1] + s * day - (b1[1] + t * dby);
  return Math.sqrt(px * px + py * py);
}

function geomMinDist(a: GeoGeom, b: GeoGeom): number {
  const aRings = getPolygonRings(a);
  const bRings = getPolygonRings(b);
  if (aRings.length > 0 && bRings.length > 0) {
    let minD = Infinity;
    for (const ar of aRings) {
      for (const br of bRings) {
        const d = ringMinDist(ar, br);
        if (d < minD) minD = d;
      }
    }
    return minD;
  }
  // Fallback: centroid distance
  return dist(geomCentroid(a), geomCentroid(b));
}

export interface DistanceResult {
  featureA_index: number;
  featureB_index: number;
  distance_meters: number;
  distance_display: number;
  unit: DistanceUnit;
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
      const dMeters = geomMinDist(layerA[i].geometry!, layerB[j].geometry!);
      results.push({
        featureA_index: i,
        featureB_index: j,
        distance_meters: dMeters,
        distance_display: dMeters / UNIT_TO_METERS[unit],
        unit,
      });
    }
  }
  return results;
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
function ringsAdjacent(ring1: Ring, ring2: Ring, tolerance: number = 1e-6): boolean {
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
  const proxTol = Math.max(tolerance, 0.5); // at least 0.5 map units
  for (let i = 0; i < ring1.length - 1; i++) {
    for (let j = 0; j < ring2.length - 1; j++) {
      if (pointToSegmentDist(ring1[i], ring2[j], ring2[j + 1]) < proxTol) return true;
      if (pointToSegmentDist(ring2[j], ring1[i], ring1[i + 1]) < proxTol) return true;
    }
  }
  return false;
}

function coordsClose(a: Coord, b: Coord, tolerance: number): boolean {
  return Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance;
}

/**
 * Check if two geometries are adjacent (share a boundary).
 */
function geometriesAdjacent(geom1: GeoGeom, geom2: GeoGeom): boolean {
  const rings1 = getPolygonRings(geom1);
  const rings2 = getPolygonRings(geom2);
  
  for (const r1 of rings1) {
    for (const r2 of rings2) {
      if (ringsAdjacent(r1, r2)) return true;
    }
  }
  return false;
}

/**
 * Dissolve two polygons by merging their boundaries. This is a simplified
 * implementation that works for simple cases where polygons share an edge.
 * Returns the merged polygon ring, or null if dissolution fails.
 */
function dissolveTwoPolygons(poly1: Ring, poly2: Ring): Ring | null {
  // Find shared edges
  const sharedEdges: Array<{ i1: number; i2: number }> = [];
  
  for (let i = 0; i < poly1.length - 1; i++) {
    const a1 = poly1[i];
    const a2 = poly1[i + 1];
    for (let j = 0; j < poly2.length - 1; j++) {
      const b1 = poly2[j];
      const b2 = poly2[j + 1];
      if ((coordsClose(a1, b1, 1e-6) && coordsClose(a2, b2, 1e-6)) ||
          (coordsClose(a1, b2, 1e-6) && coordsClose(a2, b1, 1e-6))) {
        sharedEdges.push({ i1: i, i2: j });
      }
    }
  }
  
  if (sharedEdges.length === 0) return null;
  
  // For simplicity, take the first shared edge and build the merged ring
  // by walking around poly1, skipping the shared edge, then walking around poly2
  const { i1, i2 } = sharedEdges[0];
  const n1 = poly1.length - 1;
  const n2 = poly2.length - 1;
  
  // Determine direction of traversal for poly2
  const a1 = poly1[i1];
  const a2 = poly1[i1 + 1];
  const b1 = poly2[i2];
  const b2 = poly2[i2 + 1];
  
  const forward = coordsClose(a1, b1, 1e-6) && coordsClose(a2, b2, 1e-6);
  
  const result: Ring = [];
  
  // Walk around poly1, skipping the shared edge
  for (let k = 0; k < n1; k++) {
    if (k === i1) continue;
    result.push(poly1[k]);
  }
  
  // Walk around poly2, skipping the shared edge
  if (forward) {
    for (let k = 0; k < n2; k++) {
      if (k === i2) continue;
      result.push(poly2[k]);
    }
  } else {
    // Reverse direction
    for (let k = n2 - 1; k >= 0; k--) {
      if (k === i2) continue;
      result.push(poly2[k]);
    }
  }
  
  if (result.length < 3) return null;
  result.push(result[0]); // close the ring
  return result;
}

/**
 * Compute the total length of shared boundary between two polygon rings.
 * Sums the lengths of all edges that match (within tolerance) between the two rings.
 */
function computeSharedBoundaryLength(ring1: Ring, ring2: Ring, tolerance: number = 1e-6): number {
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
export function eliminateSelectedPolygons(
  allFeatures: GeoFeature[],
  selectedIndices: Set<number>,
  strategy: EliminateStrategy = 'largestArea'
): GeoFeature[] {
  if (selectedIndices.size === 0) return allFeatures.map(f => ({ ...f }));
  
  // Work with a mutable copy
  const working = allFeatures.map((f, i) => ({
    feature: { ...f, properties: { ...f.properties } },
    originalIndex: i,
    eliminated: selectedIndices.has(i),
  }));
  
  // For each selected polygon, find an adjacent unselected neighbor and dissolve
  for (let i = 0; i < working.length; i++) {
    if (!working[i].eliminated) continue;
    if (!working[i].feature.geometry) continue;
    
    const selectedGeom = working[i].feature.geometry!;
    let dissolved = false;
    
    // Find all adjacent unselected neighbors and score them
    interface NeighborCandidate {
      index: number;
      area: number;
      sharedBoundary: number;
    }
    const candidates: NeighborCandidate[] = [];
    for (let j = 0; j < working.length; j++) {
      if (i === j || working[j].eliminated) continue;
      if (!working[j].feature.geometry) continue;
      if (!geometriesAdjacent(selectedGeom, working[j].feature.geometry!)) continue;
      
      const neighborRings = getPolygonRings(working[j].feature.geometry!);
      if (neighborRings.length === 0) continue;
      
      // Compute neighbor area (sum of outer ring areas)
      let area = 0;
      for (const ring of neighborRings) {
        area += Math.abs(signedArea(ring));
      }
      
      // Compute shared boundary length
      const selectedRings = getPolygonRings(selectedGeom);
      let sharedLen = 0;
      if (selectedRings.length > 0) {
        sharedLen = computeSharedBoundaryLength(selectedRings[0], neighborRings[0]);
      }
      
      candidates.push({ index: j, area, sharedBoundary: sharedLen });
    }
    
    if (candidates.length === 0) continue; // no neighbor found — polygon is just removed
    
    // Pick the best candidate based on strategy
    let bestIdx = 0;
    if (strategy === 'largestArea') {
      for (let k = 1; k < candidates.length; k++) {
        if (candidates[k].area > candidates[bestIdx].area) bestIdx = k;
      }
    } else if (strategy === 'smallestArea') {
      for (let k = 1; k < candidates.length; k++) {
        if (candidates[k].area < candidates[bestIdx].area) bestIdx = k;
      }
    } else { // largestCommonBoundary
      for (let k = 1; k < candidates.length; k++) {
        if (candidates[k].sharedBoundary > candidates[bestIdx].sharedBoundary) bestIdx = k;
      }
    }
    
    const chosen = candidates[bestIdx];
    const neighborGeom = working[chosen.index].feature.geometry!;
    const selectedRings = getPolygonRings(selectedGeom);
    const neighborRings = getPolygonRings(neighborGeom);
    
    if (selectedRings.length > 0 && neighborRings.length > 0) {
      const merged = dissolveTwoPolygons(neighborRings[0], selectedRings[0]);
      if (merged) {
        if (neighborGeom.type === 'Polygon') {
          working[chosen.index].feature.geometry = {
            type: 'Polygon',
            coordinates: [merged],
          };
        } else if (neighborGeom.type === 'MultiPolygon') {
          working[chosen.index].feature.geometry = {
            type: 'MultiPolygon',
            coordinates: [[merged], ...neighborGeom.coordinates.slice(1)],
          };
        }
        dissolved = true;
      }
    }
    
    // If no adjacent neighbor found, the selected polygon is just removed
    // (its geometry is lost)
  }
  
  // Return only uneliminated features
  return working
    .filter(w => !w.eliminated)
    .map(w => w.feature);
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
function isRingValid(ring: Ring): { valid: boolean; reason: string } {
  if (ring.length < 4) return { valid: false, reason: 'Ring has fewer than 4 points.' };
  const last = ring[ring.length - 1];
  const first = ring[0];
  if (last[0] !== first[0] || last[1] !== first[1]) return { valid: false, reason: 'Ring is not closed.' };
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

export function checkValidity(features: GeoFeature[]): ValidityResult[] {
  const results: ValidityResult[] = [];
  for (const f of features) {
    if (!f.geometry) {
      results.push({ feature: f, valid: false, reason: 'Null geometry.' });
      continue;
    }
    const rings = getPolygonRings(f.geometry);
    if (rings.length === 0 && f.geometry.type !== 'Point' && f.geometry.type !== 'MultiPoint' &&
        f.geometry.type !== 'LineString' && f.geometry.type !== 'MultiLineString') {
      results.push({ feature: f, valid: false, reason: 'No polygon rings found.' });
      continue;
    }
    if (rings.length > 0) {
      let allValid = true;
      let reason = 'Valid.';
      for (const ring of rings) {
        const r = isRingValid(ring);
        if (!r.valid) { allValid = false; reason = r.reason; break; }
      }
      results.push({ feature: f, valid: allValid, reason });
    } else {
      results.push({ feature: f, valid: true, reason: 'Valid.' });
    }
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
export function delaunayTriangulation(features: GeoFeature[]): GeoFeature[] {
  // Collect all unique points
  const points: Coord[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const coords = collectCoords(f.geometry);
    for (const c of coords) {
      // Avoid exact duplicates
      if (!points.some(p => p[0] === c[0] && p[1] === c[1])) {
        points.push(c);
      }
    }
  }
  if (points.length < 3) return [];

  // Super triangle that encompasses all points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const st: [Coord, Coord, Coord] = [
    [midX - 20 * dmax, midY - dmax],
    [midX, midY + 20 * dmax],
    [midX + 20 * dmax, midY - dmax],
  ];

  type Triangle = { a: Coord; b: Coord; c: Coord };
  let triangles: Triangle[] = [{ a: st[0], b: st[1], c: st[2] }];

  function circumcircleContains(t: Triangle, p: Coord): boolean {
    const ax = t.a[0] - p[0], ay = t.a[1] - p[1];
    const bx = t.b[0] - p[0], by = t.b[1] - p[1];
    const cx = t.c[0] - p[0], cy = t.c[1] - p[1];
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by)
              - (bx * bx + by * by) * (ax * cy - cx * ay)
              + (cx * cx + cy * cy) * (ax * by - bx * ay);
    // For CCW triangles, det > 0 means inside
    const orient = (t.b[0] - t.a[0]) * (t.c[1] - t.a[1]) - (t.b[1] - t.a[1]) * (t.c[0] - t.a[0]);
    return orient > 0 ? det > 0 : det < 0;
  }

  for (const pt of points) {
    const bad: Triangle[] = [];
    for (const t of triangles) {
      if (circumcircleContains(t, pt)) bad.push(t);
    }

    // Find boundary edges of the bad triangles
    const edgeCount = new Map<string, { edge: [Coord, Coord]; count: number }>();
    for (const t of bad) {
      const edges: [Coord, Coord][] = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
      for (const e of edges) {
        const key = `${Math.min(e[0][0], e[1][0])},${Math.min(e[0][1], e[1][1])}-${Math.max(e[0][0], e[1][0])},${Math.max(e[0][1], e[1][1])}`;
        const existing = edgeCount.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeCount.set(key, { edge: e, count: 1 });
        }
      }
    }

    // Remove bad triangles
    triangles = triangles.filter(t => !bad.includes(t));

    // Add new triangles from boundary edges to the new point
    for (const v of Array.from(edgeCount.values())) {
      if (v.count === 1) {
        triangles.push({ a: v.edge[0], b: v.edge[1], c: pt });
      }
    }
  }

  // Remove triangles that share vertices with the super triangle
  const stSet = new Set(st.map(p => `${p[0]},${p[1]}`));
  const result: GeoFeature[] = [];
  for (const t of triangles) {
    if (stSet.has(`${t.a[0]},${t.a[1]}`) || stSet.has(`${t.b[0]},${t.b[1]}`) || stSet.has(`${t.c[0]},${t.c[1]}`)) continue;
    result.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[t.a, t.b, t.c, t.a]] },
      properties: {},
    });
  }
  return result;
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

    if (options.addArea) {
      const rings = getPolygonRings(f.geometry);
      let totalArea = 0;
      for (const ring of rings) {
        // Compute area in EPSG:3857 projected units
        const projArea = Math.abs(signedArea(ring));
        // Apply Mercator distortion correction using the ring's centroid y.
        // Area in EPSG:3857 is stretched by cosh²(y/R), so divide by that
        // to get true ground square meters.
        let ringCy = 0;
        const rn = ring.length - 1;
        for (let k = 0; k < rn; k++) ringCy += ring[k][1];
        ringCy /= rn;
        const sf = mercatorScaleFactor(ringCy);
        totalArea += projArea / (sf * sf);
      }
      props.area = totalArea;
    }

    if (options.addLength) {
      if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
        let totalLen = 0;
        const lines = f.geometry.type === 'LineString'
          ? [f.geometry.coordinates]
          : f.geometry.coordinates;
        for (const line of lines) {
          for (let i = 0; i < line.length - 1; i++) {
            // Per-segment Mercator correction: use average y of endpoints
            const avgY = (line[i][1] + line[i + 1][1]) / 2;
            const segLen = dist(line[i], line[i + 1]);
            totalLen += segLen / mercatorScaleFactor(avgY);
          }
        }
        props.length = totalLen;
      } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
        // Perimeter for polygons
        const rings = getPolygonRings(f.geometry);
        let totalPerim = 0;
        for (const ring of rings) {
          for (let i = 0; i < ring.length - 1; i++) {
            const avgY = (ring[i][1] + ring[i + 1][1]) / 2;
            const segLen = dist(ring[i], ring[i + 1]);
            totalPerim += segLen / mercatorScaleFactor(avgY);
          }
        }
        props.length = totalPerim;
      }
    }

    if (options.addPerimeter) {
      const rings = getPolygonRings(f.geometry);
      let totalPerim = 0;
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const avgY = (ring[i][1] + ring[i + 1][1]) / 2;
          const segLen = dist(ring[i], ring[i + 1]);
          totalPerim += segLen / mercatorScaleFactor(avgY);
        }
      }
      props.perimeter = totalPerim;
    }

    if (options.addX || options.addY) {
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
    const coords = collectCoords(f.geometry);
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
    const rings = getPolygonRings(f.geometry);
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
export function voronoiPolygons(features: GeoFeature[]): GeoFeature[] {
  const points: Coord[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const coords = collectCoords(f.geometry);
    for (const c of coords) {
      if (!points.some(p => p[0] === c[0] && p[1] === c[1])) {
        points.push(c);
      }
    }
  }
  if (points.length < 2) return [];

  // Compute bounding box with padding
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const padX = (maxX - minX) * 0.5;
  const padY = (maxY - minY) * 0.5;
  minX -= padX; minY -= padY; maxX += padX; maxY += padY;

  const result: GeoFeature[] = [];
  for (let i = 0; i < points.length; i++) {
    const pi = points[i];
    // Start with bounding box
    let cell: Ring = [
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
    ];

    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const pj = points[j];
      // Perpendicular bisector between pi and pj
      const mx = (pi[0] + pj[0]) / 2;
      const my = (pi[1] + pj[1]) / 2;
      const dx = pj[0] - pi[0];
      const dy = pj[1] - pi[1];
      // Half-plane: keep points on pi's side
      // The bisector line passes through (mx, my) with normal (dx, dy)
      // Point p is on pi's side if (p - midpoint) · normal < 0
      const edgeStart: Coord = [mx - dy * 1000, my + dx * 1000];
      const edgeEnd: Coord = [mx + dy * 1000, my - dx * 1000];
      cell = clipEdgeByLine(cell, edgeStart, edgeEnd);
      if (cell.length < 3) break;
    }

    if (cell.length >= 4) {
      // Ensure closed
      if (cell[cell.length - 1][0] !== cell[0][0] || cell[cell.length - 1][1] !== cell[0][1]) {
        cell.push(cell[0]);
      }
      result.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [cell] },
        properties: {},
      });
    }
  }
  return result;
}

// ---- Lines to Polygons ----------------------------------------------------

/**
 * Convert closed line features to polygons.
 * Lines that are not closed (first ≠ last point) are skipped.
 */
export function linesToPolygons(features: GeoFeature[]): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    if (f.geometry.type === 'LineString') {
      const coords = f.geometry.coordinates;
      if (coords.length >= 4 &&
          coords[0][0] === coords[coords.length - 1][0] &&
          coords[0][1] === coords[coords.length - 1][1]) {
        result.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: { ...f.properties },
        });
      }
    } else if (f.geometry.type === 'MultiLineString') {
      for (const line of f.geometry.coordinates) {
        if (line.length >= 4 &&
            line[0][0] === line[line.length - 1][0] &&
            line[0][1] === line[line.length - 1][1]) {
          result.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [line] },
            properties: { ...f.properties },
          });
        }
      }
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
 * All field names across all layers are collected; features missing a field
 * get `undefined` for that field (serialized as null in JSON).
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
        unifiedProps[field] = f.properties?.[field];
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
