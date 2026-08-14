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

/** Create a circle polygon around a point. */
function bufferPoint(pt: Coord, radius: number, segments = 32): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    ring.push([pt[0] + radius * Math.cos(angle), pt[1] + radius * Math.sin(angle)]);
  }
  ring.push(ring[0]); // close
  return ring;
}

/** Offset a line segment to one side by `dist`. */
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

/** Buffer a LineString by creating a polygon around it. */
function bufferLineString(coords: Coord[], radius: number, segments = 8): Ring {
  if (coords.length < 2) {
    return coords.length === 1 ? bufferPoint(coords[0], radius, segments) : [];
  }
  const left: Coord[] = [];
  const right: Coord[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [la, lb] = offsetSegment(coords[i], coords[i + 1], radius);
    const [ra, rb] = offsetSegment(coords[i], coords[i + 1], -radius);
    left.push(la, lb);
    right.push(ra, rb);
  }
  // Add semicircle caps at each end
  const startCap = bufferSemicircle(coords[0], coords[1], radius, segments);
  const endCap = bufferSemicircle(coords[coords.length - 1], coords[coords.length - 2], radius, segments);
  const ring: Ring = [...left, ...endCap, ...right.reverse(), ...startCap, left[0]];
  return ring;
}

function bufferSemicircle(center: Coord, ref: Coord, radius: number, segments: number): Coord[] {
  const baseAngle = Math.atan2(center[1] - ref[1], center[0] - ref[0]);
  const pts: Coord[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = baseAngle - Math.PI / 2 + (Math.PI * i) / segments;
    pts.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return pts;
}

/** Buffer a polygon ring by offsetting each edge outward. */
function bufferPolygonRing(ring: Ring, radius: number): Ring {
  if (ring.length < 4) return ring;
  const ccw = ensureCCW(ring);
  const n = ccw.length - 1; // exclude closing point
  const offsetEdges: [Coord, Coord][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    offsetEdges.push(offsetSegment(ccw[i], ccw[j], radius));
  }
  // Intersect consecutive offset edges to get the new vertices
  const result: Ring = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const inter = lineIntersect(
      offsetEdges[i][0], offsetEdges[i][1],
      offsetEdges[j][0], offsetEdges[j][1]
    );
    result.push(inter || offsetEdges[i][1]);
  }
  result.push(result[0]);
  return result;
}

function lineIntersect(a: Coord, b: Coord, c: Coord, d: Coord): Coord | null {
  const denom = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / denom;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Buffer any geometry. Returns a Polygon or MultiPolygon. */
export function bufferGeometry(geom: GeoGeom, distance: number): GeoGeom | null {
  if (distance <= 0) return geom;
  switch (geom.type) {
    case 'Point':
      return { type: 'Polygon', coordinates: [bufferPoint(geom.coordinates, distance)] };
    case 'MultiPoint':
      if (geom.coordinates.length === 0) return null;
      if (geom.coordinates.length === 1) return { type: 'Polygon', coordinates: [bufferPoint(geom.coordinates[0], distance)] };
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map(pt => [bufferPoint(pt, distance)]),
      };
    case 'LineString':
      return { type: 'Polygon', coordinates: [bufferLineString(geom.coordinates, distance)] };
    case 'MultiLineString':
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map(line => [bufferLineString(line, distance)]),
      };
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: [bufferPolygonRing(geom.coordinates[0], distance)],
      };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map(poly => [bufferPolygonRing(poly[0], distance)]),
      };
    default:
      return null;
  }
}

export function bufferFeature(feature: GeoFeature, distance: number): GeoFeature | null {
  if (!feature.geometry) return null;
  const geom = bufferGeometry(feature.geometry, distance);
  if (!geom) return null;
  return { type: 'Feature', geometry: geom, properties: { ...feature.properties } };
}

export function bufferFeatures(features: GeoFeature[], distance: number): GeoFeature[] {
  const result: GeoFeature[] = [];
  for (const f of features) {
    const buffered = bufferFeature(f, distance);
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

export function unionFeatures(layerA: GeoFeature[], layerB: GeoFeature[]): GeoFeature[] {
  return [...layerA, ...layerB].map(f => ({
    type: 'Feature' as const,
    geometry: f.geometry,
    properties: { ...f.properties },
  }));
}

// ---------------------------------------------------------------------------
// Dissolve — merge all features into a single feature
// ---------------------------------------------------------------------------

export function dissolveFeatures(features: GeoFeature[]): GeoFeature[] {
  if (features.length === 0) return [];
  if (features.length === 1) return [{ ...features[0], properties: {} }];

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
    resultGeoms.push(allPolyRings.length === 1
      ? { type: 'Polygon', coordinates: allPolyRings[0] }
      : { type: 'MultiPolygon', coordinates: allPolyRings });
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

  if (resultGeoms.length === 1) {
    return [{ type: 'Feature', geometry: resultGeoms[0], properties: {} }];
  }
  // Mixed geometry types → return as separate features
  return resultGeoms.map(g => ({ type: 'Feature' as const, geometry: g, properties: {} }));
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
      let sx = 0, sy = 0;
      for (const c of geom.coordinates) { sx += c[0]; sy += c[1]; }
      return [sx / geom.coordinates.length, sy / geom.coordinates.length];
    }
    case 'MultiLineString': {
      let sx = 0, sy = 0, n = 0;
      for (const line of geom.coordinates) {
        for (const c of line) { sx += c[0]; sy += c[1]; n++; }
      }
      return n > 0 ? [sx / n, sy / n] : [0, 0];
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

function cross2d(o: Coord, a: Coord, b: Coord): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

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
  // Sample-based approximation for segment-segment distance
  const N = 8;
  let minD = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const pa: Coord = [a1[0] + t * (a2[0] - a1[0]), a1[1] + t * (a2[1] - a1[1])];
    const d1 = pointToSegmentDist(pa, b1, b2);
    if (d1 < minD) minD = d1;
  }
  for (let j = 0; j <= N; j++) {
    const t = j / N;
    const pb: Coord = [b1[0] + t * (b2[0] - b1[0]), b1[1] + t * (b2[1] - b1[1])];
    const d2 = pointToSegmentDist(pb, a1, a2);
    if (d2 < minD) minD = d2;
  }
  return minD;
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
  // Check if any edge from ring1 matches an edge from ring2
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
 * Eliminate selected polygons by dissolving each into an adjacent neighbor.
 * 
 * For each selected polygon:
 * 1. Find an adjacent unselected polygon
 * 2. Dissolve the selected polygon into the neighbor
 * 3. The selected polygon disappears, its geometry is absorbed
 * 
 * Returns the resulting features with selected polygons removed and their
 * geometry merged into neighbors.
 */
export function eliminateSelectedPolygons(
  allFeatures: GeoFeature[],
  selectedIndices: Set<number>
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
    
    // Find an adjacent unselected polygon
    for (let j = 0; j < working.length; j++) {
      if (i === j || working[j].eliminated) continue;
      if (!working[j].feature.geometry) continue;
      
      if (geometriesAdjacent(selectedGeom, working[j].feature.geometry!)) {
        // Dissolve selected into this neighbor
        const selectedRings = getPolygonRings(selectedGeom);
        const neighborRings = getPolygonRings(working[j].feature.geometry!);
        
        if (selectedRings.length > 0 && neighborRings.length > 0) {
          // Try to dissolve the outer rings
          const merged = dissolveTwoPolygons(neighborRings[0], selectedRings[0]);
          if (merged) {
            // Update the neighbor's geometry
            const neighborGeom = working[j].feature.geometry!;
            if (neighborGeom.type === 'Polygon') {
              working[j].feature.geometry = {
                type: 'Polygon',
                coordinates: [merged],
              };
            } else if (neighborGeom.type === 'MultiPolygon') {
              // For multipolygon, replace the first polygon with the merged one
              working[j].feature.geometry = {
                type: 'MultiPolygon',
                coordinates: [[merged], ...neighborGeom.coordinates.slice(1)],
              };
            }
            dissolved = true;
            break;
          }
        }
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
        totalArea += Math.abs(signedArea(ring));
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
            totalLen += dist(line[i], line[i + 1]);
          }
        }
        props.length = totalLen;
      } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
        // Perimeter for polygons
        const rings = getPolygonRings(f.geometry);
        let totalPerim = 0;
        for (const ring of rings) {
          for (let i = 0; i < ring.length - 1; i++) {
            totalPerim += dist(ring[i], ring[i + 1]);
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
          totalPerim += dist(ring[i], ring[i + 1]);
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
 * Simplified self-intersection fix: if a ring self-intersects,
 * try to reorder vertices by sorting by polar angle around centroid.
 * This works for simple star-shaped polygons but not all cases.
 */
function fixSelfIntersection(ring: Ring): Ring {
  const check = isRingValid(ring);
  if (check.valid) return ring;

  // Compute centroid
  let cx = 0, cy = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) { cx += ring[i][0]; cy += ring[i][1]; }
  cx /= n; cy /= n;

  // Sort by polar angle around centroid
  const sorted = ring.slice(0, n).sort((a, b) => {
    const angleA = Math.atan2(a[1] - cy, a[0] - cx);
    const angleB = Math.atan2(b[1] - cy, b[0] - cx);
    return angleA - angleB;
  });

  sorted.push(sorted[0]); // close
  return sorted;
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
