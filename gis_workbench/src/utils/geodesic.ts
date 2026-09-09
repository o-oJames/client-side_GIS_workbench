/**
 * geodesic.ts — pure spherical geodesy for EPSG:3857 coordinates.
 *
 * The geoprocessing engines work in Web Mercator metres, where planar
 * area/length/distance are stretched by sec(φ) (length) and sec²(φ) (area).
 * Rather than patching planar results with a single `cosh(y/R)` factor taken at
 * one representative latitude, this module ports the maths from `ol/sphere.js`
 * — which `utils/measurement.ts` already uses for the on-map measure tool —
 * into a dependency-free, React-free and OL-free module.
 *
 * Keeping it pure means the geoprocessing utils stay unit-testable and the
 * numbers produced by "Add Geometry Attributes" / "Distance" agree with the
 * measure tool to the last digit. `geodesic.test.ts` cross-checks every
 * function against `ol/sphere` directly.
 *
 * Area reference (same citation as ol/sphere):
 *   Robert G. Chamberlain & William H. Duquette, "Some Algorithms for Polygons
 *   on a Sphere", JPL Publication 07-03, Jet Propulsion Laboratory, 2007.
 */

/** A 2-D coordinate. In `*LonLat` functions it is [lon, lat] in degrees; elsewhere EPSG:3857 metres. */
export type Pt2 = [number, number];

/** A linear ring / coordinate array. */
export type Pt2Ring = Pt2[];

/**
 * Mean Earth radius for the WGS84 ellipsoid, 1/3 × (2a + b).
 * Identical to `DEFAULT_RADIUS` exported by `ol/sphere.js`.
 */
export const MEAN_EARTH_RADIUS = 6371008.8;

/** Sphere radius used by the Web Mercator (EPSG:3857) projection definition. */
export const WEB_MERCATOR_RADIUS = 6378137;

const HALF_SIZE = Math.PI * WEB_MERCATOR_RADIUS;
const MAX_SAFE_Y = WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 2));

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// EPSG:3857 ↔ EPSG:4326
// ---------------------------------------------------------------------------

/**
 * Web Mercator metres → [lon, lat] degrees.
 * Mirrors `toEPSG4326` in `ol/proj/epsg3857.js` exactly (spherical model).
 */
export function mercatorToLonLat(coord: Pt2): Pt2 {
  return [
    (180 * coord[0]) / HALF_SIZE,
    (360 * Math.atan(Math.exp(coord[1] / WEB_MERCATOR_RADIUS))) / Math.PI - 90,
  ];
}

/**
 * [lon, lat] degrees → Web Mercator metres.
 * Mirrors `fromEPSG4326` in `ol/proj/epsg3857.js`, including the MAX_SAFE_Y clamp.
 */
export function lonLatToMercator(coord: Pt2): Pt2 {
  let y = WEB_MERCATOR_RADIUS * Math.log(Math.tan((Math.PI * (+coord[1] + 90)) / 360));
  if (y > MAX_SAFE_Y) y = MAX_SAFE_Y;
  else if (y < -MAX_SAFE_Y) y = -MAX_SAFE_Y;
  return [(HALF_SIZE * coord[0]) / 180, y];
}

/** Convert a whole ring; returns a new array (input is never mutated). */
export function ringToLonLat(ring: Pt2Ring): Pt2Ring {
  const out: Pt2Ring = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = mercatorToLonLat(ring[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/**
 * Great-circle (haversine) distance between two [lon, lat] coordinates, in metres.
 * Identical formulation to `getDistance` in `ol/sphere.js`.
 */
export function greatCircleDistance(a: Pt2, b: Pt2, radius: number = MEAN_EARTH_RADIUS): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const deltaLatBy2 = (lat2 - lat1) / 2;
  const deltaLonBy2 = toRadians(b[0] - a[0]) / 2;
  const h =
    Math.sin(deltaLatBy2) * Math.sin(deltaLatBy2) +
    Math.sin(deltaLonBy2) * Math.sin(deltaLonBy2) * Math.cos(lat1) * Math.cos(lat2);
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Ground distance in metres between two EPSG:3857 coordinates.
 * This is the Mercator-correct replacement for planar `dist()` whenever a
 * result is shown to the user as a distance.
 */
export function groundDistance(a3857: Pt2, b3857: Pt2, radius: number = MEAN_EARTH_RADIUS): number {
  return greatCircleDistance(mercatorToLonLat(a3857), mercatorToLonLat(b3857), radius);
}

/** Ground length in metres of a polyline given in EPSG:3857. */
export function groundLineLength(coords: Pt2Ring, radius: number = MEAN_EARTH_RADIUS): number {
  let length = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    length += groundDistance(coords[i], coords[i + 1], radius);
  }
  return length;
}

// ---------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------

/**
 * Signed spherical area (m²) of a ring given in [lon, lat] degrees.
 * Clockwise rings yield a positive area, counter-clockwise negative — the same
 * convention as `getAreaInternal` in `ol/sphere.js`.
 */
export function sphericalRingAreaLonLat(ring: Pt2Ring, radius: number = MEAN_EARTH_RADIUS): number {
  if (ring.length < 2) return 0;
  let area = 0;
  let x1 = ring[ring.length - 1][0];
  let y1 = ring[ring.length - 1][1];
  for (let i = 0; i < ring.length; i++) {
    const x2 = ring[i][0];
    const y2 = ring[i][1];
    area += toRadians(x2 - x1) * (2 + Math.sin(toRadians(y1)) + Math.sin(toRadians(y2)));
    x1 = x2;
    y1 = y2;
  }
  return (area * radius * radius) / 2.0;
}

/** Absolute spherical area (m²) of a single EPSG:3857 ring. */
export function groundRingArea(ring3857: Pt2Ring, radius: number = MEAN_EARTH_RADIUS): number {
  return Math.abs(sphericalRingAreaLonLat(ringToLonLat(ring3857), radius));
}

/** A polygon expressed as its outer shell plus any inner rings (holes). */
export interface PolygonRings {
  shell: Pt2Ring;
  holes: Pt2Ring[];
}

/**
 * Spherical area (m²) of one or more EPSG:3857 polygons, **holes subtracted**.
 *
 * Matches `ol/sphere.getArea()` for Polygon / MultiPolygon, which is what the
 * measure tool reports — so attribute values and map measurements agree.
 * Can be negative if the holes outweigh the shells (invalid input); callers
 * that need a magnitude should clamp.
 */
export function groundPolygonArea(parts: PolygonRings[], radius: number = MEAN_EARTH_RADIUS): number {
  let area = 0;
  for (const part of parts) {
    area += groundRingArea(part.shell, radius);
    for (const hole of part.holes) area -= groundRingArea(hole, radius);
  }
  return area;
}

/**
 * Spherical perimeter (m²-free: metres) of one or more polygons — the sum of
 * **all** rings, shells and holes alike. Mirrors `ol/sphere.getLength()` for
 * Polygon / MultiPolygon.
 */
export function groundPolygonPerimeter(parts: PolygonRings[], radius: number = MEAN_EARTH_RADIUS): number {
  let length = 0;
  for (const part of parts) {
    length += groundLineLength(part.shell, radius);
    for (const hole of part.holes) length += groundLineLength(hole, radius);
  }
  return length;
}
