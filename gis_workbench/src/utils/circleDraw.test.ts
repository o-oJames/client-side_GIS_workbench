/**
 * Circle draw tool — the two flavours of circle (utils/circleDraw.ts).
 *
 * The defining difference, asserted here at 60°N where Web Mercator stretches
 * by sec(φ) = 2:
 *  - `geometric`  keeps a constant *planar* radius (round on the map, so its
 *    ground radius drifts around the ring);
 *  - `geodesic`   keeps a constant *ground* radius (a true circle on the
 *    earth, so its planar radius drifts around the ring).
 */
import { describe, expect, it } from 'vitest';
import Polygon from 'ol/geom/Polygon.js';
import { CircleDrawMode } from '../types';
import { greatCircleDistance, lonLatToMercator, mercatorToLonLat } from './geodesic';
import {
  CIRCLE_CENTER_SUFFIX, CIRCLE_DRAW_SEGMENTS, CIRCLE_MODES, CIRCLE_NAME_PREFIXES,
  DEFAULT_CIRCLE_MODE, circleCenterName, circleDisplayName, circleModeCaption,
  circleModeInfo, circleNamePrefix, countsAsCircleName,
  createCircleGeometryFunction, geometricCircleRing, geodesicCircleRing,
} from './circleDraw';

const PROJECTION = 'EPSG:3857';
/** Ring coords are [x, y] pairs; the last one repeats the first. */
const planarDistance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Ground distance (m) between two EPSG:3857 coordinates. */
const groundDistance = (a: number[], b: number[]) =>
  greatCircleDistance(mercatorToLonLat(a as [number, number]), mercatorToLonLat(b as [number, number]));

/** Planar distance from the centre to every ring vertex, ignoring the closing
 *  duplicate. */
function planarRadii(ring: number[][], center: number[]): number[] {
  return ring.slice(0, -1).map((c) => planarDistance(center, c));
}
function groundRadii(ring: number[][], center: number[]): number[] {
  return ring.slice(0, -1).map((c) => groundDistance(center, c));
}
/** Relative spread of a set of radii — 0 for a perfectly constant one. */
function spread(values: number[]): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (max - min) / mean;
}

// A big circle at high latitude: where the two modes part company most.
const CENTER_60N = lonLatToMercator([0, 60]);
const PLANAR_RADIUS = 1_500_000; // 1 500 km of Web Mercator units
const HANDLE = [CENTER_60N[0] + PLANAR_RADIUS, CENTER_60N[1]];

describe('circle rings', () => {
  it('builds a closed 128-segment ring', () => {
    const ring = geometricCircleRing(CENTER_60N, HANDLE);
    expect(ring).toHaveLength(CIRCLE_DRAW_SEGMENTS + 1);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    ring.forEach((c) => {
      expect(Number.isFinite(c[0])).toBe(true);
      expect(Number.isFinite(c[1])).toBe(true);
    });
  });

  it('geometric: every vertex is exactly the drawn planar radius from the centre', () => {
    const ring = geometricCircleRing(CENTER_60N, HANDLE);
    planarRadii(ring, CENTER_60N).forEach((r) => {
      expect(r).toBeCloseTo(PLANAR_RADIUS, 3);
    });
    // …so its ground radius is NOT constant: the Mercator scale changes over
    // the extent (the north side is squeezed, the south side stretched).
    expect(spread(groundRadii(ring, CENTER_60N))).toBeGreaterThan(0.1);
  });

  it('geometric: the first vertex points at the radius handle', () => {
    const ring = geometricCircleRing(CENTER_60N, HANDLE);
    expect(ring[0][0]).toBeCloseTo(HANDLE[0], 3);
    expect(ring[0][1]).toBeCloseTo(HANDLE[1], 3);
  });

  it('geometric: at the equator planar and ground radius agree (scale factor 1)', () => {
    const center = lonLatToMercator([0, 0]);
    const radius = 100_000;
    const ring = geometricCircleRing(center, [center[0] + radius, center[1]]);
    groundRadii(ring, center).forEach((r) => {
      expect(Math.abs(r - radius) / radius).toBeLessThan(0.01);
    });
  });

  it('geodesic: every vertex is the same ground distance from the centre', () => {
    const ring = geodesicCircleRing(CENTER_60N, HANDLE, PROJECTION);
    expect(ring).toHaveLength(CIRCLE_DRAW_SEGMENTS + 1);
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    const radii = groundRadii(ring, CENTER_60N);
    const expected = groundDistance(CENTER_60N, HANDLE);
    // At 60°N a 1 500 km planar drag is only ~750 km on the ground.
    expect(expected).toBeLessThan(PLANAR_RADIUS * 0.55);
    expect(expected).toBeGreaterThan(PLANAR_RADIUS * 0.45);
    radii.forEach((r) => {
      expect(Math.abs(r - expected) / expected).toBeLessThan(0.01);
    });
    expect(spread(radii)).toBeLessThan(0.01);
  });

  it('geodesic: its planar radius drifts around the ring away from the equator', () => {
    const ring = geodesicCircleRing(CENTER_60N, HANDLE, PROJECTION);
    // The shape is stretched toward the pole (larger Mercator scale) and
    // squeezed toward the equator — unlike the geometric circle, which is
    // round on screen.
    expect(spread(planarRadii(ring, CENTER_60N))).toBeGreaterThan(0.1);
  });

  it('geodesic: at the equator it is round on screen too (both modes agree)', () => {
    const center = lonLatToMercator([0, 0]);
    const radius = 100_000;
    const geo = geometricCircleRing(center, [center[0] + radius, center[1]]);
    const geod = geodesicCircleRing(center, [center[0] + radius, center[1]], PROJECTION);
    expect(spread(planarRadii(geod, center))).toBeLessThan(0.01);
    // Same handle, same circle (to well within a percent).
    planarRadii(geod, center).forEach((r) => {
      expect(Math.abs(r - planarDistance(center, geo[0])) / radius).toBeLessThan(0.01);
    });
  });

  it('survives a zero-radius drag (centre clicked twice)', () => {
    const flat = geometricCircleRing(CENTER_60N, CENTER_60N);
    expect(flat).toHaveLength(CIRCLE_DRAW_SEGMENTS + 1);
    planarRadii(flat, CENTER_60N).forEach((r) => expect(r).toBe(0));

    const geod = geodesicCircleRing(CENTER_60N, CENTER_60N, PROJECTION);
    expect(geod).toHaveLength(CIRCLE_DRAW_SEGMENTS + 1);
    groundRadii(geod, CENTER_60N).forEach((r) => expect(r).toBeLessThan(1));
  });

  it('honours an explicit segment count', () => {
    expect(geometricCircleRing(CENTER_60N, HANDLE, 24)).toHaveLength(25);
    expect(geodesicCircleRing(CENTER_60N, HANDLE, PROJECTION, 24)).toHaveLength(25);
  });
});

describe('createCircleGeometryFunction', () => {
  const coords = [CENTER_60N, HANDLE];

  it('returns a Polygon ring matching the geometric builder', () => {
    const fn = createCircleGeometryFunction('geometric');
    const geom = fn(coords, undefined, PROJECTION);
    expect(geom).toBeInstanceOf(Polygon);
    expect(geom.getType()).toBe('Polygon');
    expect(geom.getCoordinates()[0]).toEqual(geometricCircleRing(CENTER_60N, HANDLE));
  });

  it('returns a Polygon ring matching the geodesic builder', () => {
    const fn = createCircleGeometryFunction('geodesic');
    const geom = fn(coords, undefined, PROJECTION);
    expect(geom.getCoordinates()[0]).toEqual(geodesicCircleRing(CENTER_60N, HANDLE, PROJECTION));
  });

  it('updates the geometry it is handed, in place (OL Draw reuse)', () => {
    const fn = createCircleGeometryFunction('geometric');
    const first = fn(coords, undefined, PROJECTION);
    const grown = fn([CENTER_60N, [CENTER_60N[0] + PLANAR_RADIUS * 2, CENTER_60N[1]]], first, PROJECTION);
    expect(grown).toBe(first);
    planarRadii(grown.getCoordinates()[0], CENTER_60N).forEach((r) => {
      expect(r).toBeCloseTo(PLANAR_RADIUS * 2, 3);
    });
  });

  it('reports the centre it built the ring around, from the first call on', () => {
    // OL calls the geometry function at drawstart with [centre, centre] and
    // then on every pointer move; drawend reads whatever was reported last.
    const seen: number[][] = [];
    const fn = createCircleGeometryFunction('geometric', CIRCLE_DRAW_SEGMENTS, (info) => {
      seen.push(info.center);
    });
    // drawstart: the radius handle is still on the centre.
    fn([CENTER_60N, CENTER_60N], undefined, PROJECTION);
    // two pointer moves out to the radius
    fn([CENTER_60N, [CENTER_60N[0] + 10, CENTER_60N[1]]], undefined, PROJECTION);
    fn(coords, undefined, PROJECTION);
    expect(seen).toHaveLength(3);
    seen.forEach((c) => {
      expect(c[0]).toBeCloseTo(CENTER_60N[0], 6);
      expect(c[1]).toBeCloseTo(CENTER_60N[1], 6);
    });
  });

  it('reports a copy of the centre, and the mode it drew in', () => {
    let info: any = null;
    const fn = createCircleGeometryFunction('geodesic', CIRCLE_DRAW_SEGMENTS, (i) => { info = i; });
    const start = CENTER_60N.slice();
    const sketch = [start, HANDLE.slice()];
    fn(sketch, undefined, PROJECTION);
    // OL keeps mutating the arrays it hands in (a dragged handle, a popped
    // vertex) — the reported centre must not move with them.
    start[0] += 1e6;
    sketch[1] = [0, 0];
    expect(info.center).toEqual(CENTER_60N);
    expect(info.radiusHandle).toEqual(HANDLE);
    expect(info.mode).toBe('geodesic');
  });

  it('reads the mode live, so a submenu switch applies to the next sketch', () => {
    let mode: CircleDrawMode = 'geometric';
    const fn = createCircleGeometryFunction(() => mode);
    expect(fn(coords, undefined, PROJECTION).getCoordinates()[0])
      .toEqual(geometricCircleRing(CENTER_60N, HANDLE));
    mode = 'geodesic';
    expect(fn(coords, undefined, PROJECTION).getCoordinates()[0])
      .toEqual(geodesicCircleRing(CENTER_60N, HANDLE, PROJECTION));
  });
});

describe('circle mode metadata', () => {
  it('offers both modes, geometric first and by default', () => {
    expect(CIRCLE_MODES.map((m) => m.id)).toEqual(['geometric', 'geodesic']);
    expect(DEFAULT_CIRCLE_MODE).toBe('geometric');
    expect(circleModeInfo('geodesic').label).toBe('Geodesic circle');
    expect(circleModeCaption('geometric')).toBe('Circle geometry');
    expect(circleModeCaption('geodesic')).toBe('Geodesic circle');
  });

  it('auto-names each mode separately', () => {
    expect(circleDisplayName('geometric', 1)).toBe('Circle 1');
    expect(circleDisplayName('geodesic', 2)).toBe('Geodesic Circle 2');
    expect(circleNamePrefix('geodesic')).toBe('Geodesic Circle');
  });

  it('keeps the name prefixes distinguishable by startsWith', () => {
    expect(CIRCLE_NAME_PREFIXES).toEqual(['Circle', 'Geodesic Circle']);
    // A geodesic circle must never be counted as a plain 'Circle N'.
    expect('Geodesic Circle 1'.startsWith(circleNamePrefix('geometric'))).toBe(false);
    expect('Circle 1'.startsWith(circleNamePrefix('geodesic'))).toBe(false);
  });
});

describe('circle centre points', () => {
  it('names the centre after its circle', () => {
    expect(CIRCLE_CENTER_SUFFIX).toBe('Center');
    expect(circleCenterName(circleDisplayName('geometric', 1))).toBe('Circle 1 Center');
    expect(circleCenterName(circleDisplayName('geodesic', 2))).toBe('Geodesic Circle 2 Center');
    // A rename follows the same rule.
    expect(circleCenterName('Irrigation pivot 4')).toBe('Irrigation pivot 4 Center');
  });

  it('counts circles without counting the centre points dropped with them', () => {
    // A centre point shares its circle's name as a prefix, so the counters
    // must match the auto-name exactly rather than with startsWith.
    expect(countsAsCircleName('Circle 3', 'geometric')).toBe(true);
    expect(countsAsCircleName('Circle 3 Center', 'geometric')).toBe(false);
    expect(countsAsCircleName('Geodesic Circle 3', 'geodesic')).toBe(true);
    expect(countsAsCircleName('Geodesic Circle 3 Center', 'geodesic')).toBe(false);
    // Each mode counts only its own family.
    expect(countsAsCircleName('Geodesic Circle 3', 'geometric')).toBe(false);
    expect(countsAsCircleName('Circle 3', 'geodesic')).toBe(false);
    // Neither a renamed circle nor an unrelated name joins the sequence.
    expect(countsAsCircleName('Irrigation pivot', 'geometric')).toBe(false);
    expect(countsAsCircleName('Circle of life', 'geometric')).toBe(false);
    expect(countsAsCircleName('Rectangle 1', 'geometric')).toBe(false);
    expect(countsAsCircleName('', 'geometric')).toBe(false);
  });

  it('keeps a centre point out of the polygon family too', () => {
    // isOtherPolygonFamily() gates the generic 'Polygon N' counter on the
    // circle prefixes; a centre point is a Point, so the counter never sees
    // it — but the prefix rule must not claim the centre as a circle either.
    expect(circleNamePrefix('geometric')).toBe('Circle');
    expect(countsAsCircleName('Polygon 1', 'geometric')).toBe(false);
  });
});
