import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import {
  MEASUREMENT_AUTO_MAX_VERTICES,
  getGeometryVertexCount,
  shouldShowFeatureMeasurements,
} from './measurement';

// --- Vertex counting --------------------------------------------------------

describe('getGeometryVertexCount', () => {
  it('counts a point as one vertex', () => {
    expect(getGeometryVertexCount(new Point([0, 0]))).toBe(1);
  });

  it('counts every line vertex', () => {
    const coords = Array.from({ length: 12 }, (_, i) => [i, i]);
    expect(getGeometryVertexCount(new LineString(coords))).toBe(12);
  });

  it('excludes the ring-closing duplicate of a polygon', () => {
    // Closed ring: 4 unique corners + repeated first vertex.
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(getGeometryVertexCount(new Polygon([ring]))).toBe(4);
  });

  it('sums every ring of a polygon with holes', () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]; // 4 unique
    const hole = [[5, 5], [8, 5], [8, 8], [5, 5]]; // 3 unique
    expect(getGeometryVertexCount(new Polygon([outer, hole]))).toBe(7);
  });

  it('returns 0 for null/undefined/non-geometry input', () => {
    expect(getGeometryVertexCount(null)).toBe(0);
    expect(getGeometryVertexCount(undefined)).toBe(0);
    expect(getGeometryVertexCount({})).toBe(0);
  });
});

// --- Measurement visibility default + explicit override ----------------------

/** Minimal fake of an OL feature carrying a drawn-feature flag. */
function fakeFeature(geom: any, showMeasurements?: boolean): any {
  const f: any = { getGeometry: () => geom };
  if (showMeasurements !== undefined) f._showMeasurements = showMeasurements;
  return f;
}

/** Horizontal line with `n` vertices (1 unit apart in map units). */
function lineWith(n: number): LineString {
  return new LineString(Array.from({ length: n }, (_, i) => [i * 100, 0]));
}

describe('shouldShowFeatureMeasurements', () => {
  it('defaults to visible at or below the vertex threshold', () => {
    expect(shouldShowFeatureMeasurements(fakeFeature(lineWith(MEASUREMENT_AUTO_MAX_VERTICES)))).toBe(true);
    expect(shouldShowFeatureMeasurements(fakeFeature(lineWith(3)))).toBe(true);
  });

  it('defaults to hidden above the vertex threshold', () => {
    expect(shouldShowFeatureMeasurements(fakeFeature(lineWith(MEASUREMENT_AUTO_MAX_VERTICES + 1)))).toBe(false);
    expect(shouldShowFeatureMeasurements(fakeFeature(lineWith(250)))).toBe(false);
  });

  it('counts polygon vertices without the closing duplicate', () => {
    // 31 unique vertices + closing duplicate → hidden by default.
    const ring = Array.from({ length: 31 }, (_, i) => [i * 10, (i % 5) * 10]);
    ring.push(ring[0].slice());
    expect(shouldShowFeatureMeasurements(fakeFeature(new Polygon([ring])))).toBe(false);
  });

  it('lets an explicit user choice override the default', () => {
    // Dense feature the user switched on:
    expect(shouldShowFeatureMeasurements(fakeFeature(lineWith(120), true))).toBe(true);
    // Simple feature the user switched off:
    expect(shouldShowFeatureMeasurements(fakeFeature(lineWith(4), false))).toBe(false);
  });

  it('treats a feature without geometry as visible (nothing to count)', () => {
    expect(shouldShowFeatureMeasurements(fakeFeature(null))).toBe(true);
  });
});
