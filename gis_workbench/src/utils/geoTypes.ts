/**
 * geoTypes.ts — the plain GeoJSON shapes every vector engine speaks.
 *
 * Extracted from `geoprocessing.ts` so the overlay kernel (`overlay.ts`) and
 * the feature-level engines can share one definition without importing each
 * other. `geoprocessing.ts` re-exports all of them, so existing imports keep
 * working unchanged.
 *
 * Coordinates are EPSG:3857 metres unless a function says otherwise.
 */

export type Coord = [number, number];

/** A closed coordinate list: `ring[0]` equals `ring[ring.length - 1]`. */
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

/** Polygonal members of `GeoGeom`. */
export type AreaGeom = Extract<GeoGeom, { type: 'Polygon' | 'MultiPolygon' }>;

/** Linear members of `GeoGeom`. */
export type LineGeom = Extract<GeoGeom, { type: 'LineString' | 'MultiLineString' }>;

/**
 * Geometry types that have an interior (i.e. can take part in an overlay).
 * A type predicate, so callers get the narrowed geometry after the test.
 */
export function isAreaGeometry(geom: GeoGeom | null): geom is AreaGeom {
  return geom?.type === 'Polygon' || geom?.type === 'MultiPolygon';
}

/** Geometry types made of 1-D coordinate sequences. */
export function isLineGeometry(geom: GeoGeom | null): geom is LineGeom {
  return geom?.type === 'LineString' || geom?.type === 'MultiLineString';
}

/** Every coordinate sequence of a line geometry. */
export function lineSequences(geom: GeoGeom | null): Coord[][] {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/** Every point coordinate of a point geometry. */
export function pointCoords(geom: GeoGeom | null): Coord[] {
  if (!geom) return [];
  if (geom.type === 'Point') return [geom.coordinates];
  if (geom.type === 'MultiPoint') return geom.coordinates;
  return [];
}

/**
 * Build a geometry from a list of polygon parts, choosing Polygon /
 * MultiPolygon by count. `null` when there is nothing to return.
 */
export function partsToGeometry(parts: Ring[][]): GeoGeom | null {
  const usable = parts.filter(rings => rings.length > 0 && rings[0].length >= 4);
  if (usable.length === 0) return null;
  if (usable.length === 1) return { type: 'Polygon', coordinates: usable[0] };
  return { type: 'MultiPolygon', coordinates: usable };
}

/**
 * The polygon parts of a geometry: one entry per part, each `[shell, ...holes]`.
 *
 * A GeoJSON Polygon is a single part whose `coordinates` ARE the ring list, so
 * it has to be wrapped — returning it unwrapped would hand callers rings
 * instead of parts and every ring would be read as a coordinate.
 */
export function geometryParts(geom: GeoGeom | null): Ring[][] {
  if (!geom) return [];
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.filter(r => r && r.length > 0);
    return rings.length > 0 ? [rings] : [];
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.filter(p => p && p.length > 0 && p[0] && p[0].length > 0);
  }
  return [];
}
