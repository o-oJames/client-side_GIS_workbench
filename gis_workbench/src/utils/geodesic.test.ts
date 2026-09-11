import { getArea, getLength, getDistance } from 'ol/sphere.js';
import Polygon from 'ol/geom/Polygon.js';
import LineString from 'ol/geom/LineString.js';
import {
  MEAN_EARTH_RADIUS,
  WEB_MERCATOR_RADIUS,
  mercatorToLonLat,
  lonLatToMercator,
  greatCircleDistance,
  groundDistance,
  groundLineLength,
  sphericalRingAreaLonLat,
  groundRingArea,
  groundPolygonArea,
  groundPolygonPerimeter,
  toRadians,
  toDegrees,
  type Pt2,
} from './geodesic';

// A ~1.1 km box near Adelaide, plus a hole inside it.
const LON = 138.6;
const LAT = -34.93;
const D = 0.01;

const shellLonLat: Pt2[] = [
  [LON, LAT], [LON + D, LAT], [LON + D, LAT + D], [LON, LAT + D], [LON, LAT],
];
const holeLonLat: Pt2[] = [
  [LON + 0.003, LAT + 0.003], [LON + 0.007, LAT + 0.003],
  [LON + 0.007, LAT + 0.007], [LON + 0.003, LAT + 0.007], [LON + 0.003, LAT + 0.003],
];
const shell3857 = shellLonLat.map(lonLatToMercator);
const hole3857 = holeLonLat.map(lonLatToMercator);

/** Planar shoelace area — what the engines used to report as "square metres". */
function planarArea(ring: Pt2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    sum += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(sum / 2);
}

describe('projection round trip', () => {
  it('matches the constants ol uses', () => {
    expect(MEAN_EARTH_RADIUS).toBe(6371008.8);
    expect(WEB_MERCATOR_RADIUS).toBe(6378137);
  });

  it('mercator → lonlat → mercator is stable', () => {
    const back = lonLatToMercator(mercatorToLonLat(shell3857[2]));
    expect(back[0]).toBeCloseTo(shell3857[2][0], 6);
    expect(back[1]).toBeCloseTo(shell3857[2][1], 6);
  });

  it('lonlat → mercator matches the EPSG:3857 definition', () => {
    const [x, y] = lonLatToMercator([0, 0]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    // Half the world east is exactly π·R.
    expect(lonLatToMercator([180, 0])[0]).toBeCloseTo(Math.PI * WEB_MERCATOR_RADIUS, 3);
  });

  it('converts degrees and radians both ways', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 12);
    expect(toDegrees(Math.PI)).toBeCloseTo(180, 12);
  });
});

describe('distance', () => {
  it('greatCircleDistance matches ol/sphere.getDistance', () => {
    const a: Pt2 = [138.6, -34.93];
    const b: Pt2 = [138.72, -34.86];
    expect(greatCircleDistance(a, b)).toBeCloseTo(getDistance(a, b), 6);
  });

  it('groundDistance measures EPSG:3857 pairs as ol does on their lon/lat', () => {
    const a = lonLatToMercator([138.6, -34.93]);
    const b = lonLatToMercator([138.72, -34.86]);
    expect(groundDistance(a, b)).toBeCloseTo(getDistance([138.6, -34.93], [138.72, -34.86]), 6);
  });

  it('is ~111 km per degree of latitude', () => {
    const d = groundDistance(lonLatToMercator([0, 0]), lonLatToMercator([0, 1]));
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_500);
  });

  it('groundLineLength matches ol/sphere.getLength', () => {
    const line = shell3857;
    expect(groundLineLength(line)).toBeCloseTo(getLength(new LineString(line)), 6);
  });
});

describe('area', () => {
  it('sphericalRingAreaLonLat is clockwise-positive, like ol', () => {
    expect(sphericalRingAreaLonLat(shellLonLat)).toBeLessThan(0);
    expect(sphericalRingAreaLonLat(shellLonLat.slice().reverse())).toBeGreaterThan(0);
  });

  it('groundRingArea matches ol/sphere.getArea for a simple polygon', () => {
    const expected = getArea(new Polygon([shell3857]));
    expect(groundRingArea(shell3857)).toBeCloseTo(expected, 3);
  });

  it('groundPolygonArea matches ol for a polygon (no holes)', () => {
    const expected = getArea(new Polygon([shell3857]));
    expect(groundPolygonArea([{ shell: shell3857, holes: [] }])).toBeCloseTo(expected, 3);
  });

  it('subtracts holes exactly the way ol/sphere.getArea does', () => {
    const expected = getArea(new Polygon([shell3857, hole3857]));
    const actual = groundPolygonArea([{ shell: shell3857, holes: [hole3857] }]);
    expect(actual).toBeCloseTo(expected, 3);
    // …and the hole really is removed, not added.
    const noHole = groundPolygonArea([{ shell: shell3857, holes: [] }]);
    expect(actual).toBeLessThan(noHole);
    expect(noHole - actual).toBeCloseTo(groundRingArea(hole3857), 3);
  });

  it('sums multipolygon parts', () => {
    const parts = [
      { shell: shell3857, holes: [] },
      { shell: shell3857.map(c => [c[0] + 20000, c[1]] as Pt2), holes: [] },
    ];
    expect(groundPolygonArea(parts)).toBeCloseTo(2 * groundRingArea(shell3857), 3);
  });

  it('groundPolygonPerimeter counts every ring, like ol/sphere.getLength', () => {
    const expected = getLength(new Polygon([shell3857, hole3857]));
    expect(groundPolygonPerimeter([{ shell: shell3857, holes: [hole3857] }]))
      .toBeCloseTo(expected, 3);
  });

  /**
   * Regression guard for the reason this module exists: the planar shoelace area
   * of an EPSG:3857 ring over-reports ground area by sec²(φ). At 60° that is a
   * factor of four — which is what "Add Geometry Attributes" used to divide out
   * with a single mean-latitude cosh² correction.
   */
  it('planar 3857 area over-reports ground area by ~sec²(latitude)', () => {
    const src: Pt2[] = [[0, 60], [0.01, 60], [0.01, 60.01], [0, 60.01], [0, 60]];
    const lat60 = src.map(lonLatToMercator);
    const planar = planarArea(lat60);
    const ground = groundRingArea(lat60);
    const ratio = planar / ground;
    // sec²(60.005°) ≈ 4.0007
    expect(ratio).toBeGreaterThan(3.9);
    expect(ratio).toBeLessThan(4.1);
  });

  /**
   * At the equator the latitude distortion is gone, but planar EPSG:3857 area
   * still differs from spherical ground area by the ratio of the two radii the
   * two models use: Web Mercator projects onto the WGS84 semi-major axis
   * (6378137 m) while ol/sphere measures with the mean Earth radius
   * (6371008.8 m). The residual is a constant ~0.22 %, not a bug.
   */
  it('planar 3857 area at the equator differs only by the sphere-radius ratio', () => {
    const src: Pt2[] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];
    const equator = src.map(lonLatToMercator);
    const ratio = planarArea(equator) / groundRingArea(equator);
    const radiusRatio = (WEB_MERCATOR_RADIUS / MEAN_EARTH_RADIUS) ** 2;
    expect(radiusRatio).toBeCloseTo(1.00224, 4);
    expect(ratio).toBeCloseTo(radiusRatio, 5);
  });
});
