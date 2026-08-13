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
