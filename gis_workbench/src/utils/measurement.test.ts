import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import { UnitsSystem } from '../types';
import {
  MEASUREMENT_AUTO_MAX_VERTICES,
  buildAreaChipStyle,
  buildMeasurementStyles,
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

  it('keeps a circle visible despite its 128 vertices (one chip, not 128)', () => {
    // The Circle tool always produces a dense ring, but it only ever carries
    // a single area chip, so the vertex-count rule must not hide it.
    const ring = Array.from({ length: 128 }, (_, i) => {
      const a = (2 * Math.PI * i) / 128;
      return [150000 + 100000 * Math.cos(a), -4000000 + 100000 * Math.sin(a)];
    });
    ring.push(ring[0].slice());
    const circle = fakeFeature(new Polygon([ring]));
    expect(getGeometryVertexCount(circle.getGeometry())).toBeGreaterThan(MEASUREMENT_AUTO_MAX_VERTICES);
    expect(shouldShowFeatureMeasurements(circle)).toBe(false); // plain dense polygon

    circle._circleMode = 'geometric';
    expect(shouldShowFeatureMeasurements(circle)).toBe(true);
    circle._circleMode = 'geodesic';
    expect(shouldShowFeatureMeasurements(circle)).toBe(true);

    // An explicit user choice still wins over the circle default.
    circle._showMeasurements = false;
    expect(shouldShowFeatureMeasurements(circle)).toBe(false);
  });


describe('buildAreaChipStyle', () => {
  const ds = {
    opacity: 100, lineColor: 'rgba(66, 133, 244, 1)', lineWidth: 2,
    fillColor: 'rgba(66, 133, 244, 0.2)', fontColor: 'rgba(0, 0, 0, 1)', fontSize: 14,
  };
  const units: UnitsSystem = 'metric';

  it('offsets the area chip downward for circles so it sits below the centre point', () => {
    // A circle's interior point is its centre, which is also where the centre
    // point feature sits. The area chip must be offset downward so they don't
    // overlap.
    const ring = Array.from({ length: 128 }, (_, i) => {
      const a = (2 * Math.PI * i) / 128;
      return [150000 + 100000 * Math.cos(a), -4000000 + 100000 * Math.sin(a)];
    });
    ring.push(ring[0].slice());
    const circle = new Polygon([ring]);

    const plainChip = buildAreaChipStyle(circle, ds, units, 0);
    expect(plainChip.getText().getOffsetY()).toBe(0);

    const circleChip = buildAreaChipStyle(circle, ds, units, 18);
    expect(circleChip.getText().getOffsetY()).toBe(18);
  });

  it('buildMeasurementStyles passes the circle offset through', () => {
    const ring = Array.from({ length: 128 }, (_, i) => {
      const a = (2 * Math.PI * i) / 128;
      return [150000 + 100000 * Math.cos(a), -4000000 + 100000 * Math.sin(a)];
    });
    ring.push(ring[0].slice());
    const circle = new Polygon([ring]);

    const plainStyles = buildMeasurementStyles(circle, ds, units, { circle: false });
    const plainChip = plainStyles.find((s) => s.getText() && s.getText().getText().includes('m²'));
    expect(plainChip).toBeDefined();
    expect(plainChip!.getText().getOffsetY()).toBe(0);

    const circleStyles = buildMeasurementStyles(circle, ds, units, { circle: true });
    const circleChip = circleStyles.find((s) => s.getText() && s.getText().getText().includes('m²'));
    expect(circleChip).toBeDefined();
    expect(circleChip!.getText().getOffsetY()).toBe(18);
  });
});
});
