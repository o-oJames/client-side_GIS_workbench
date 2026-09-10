/**
 * buffer.test.ts — the buffer engine, and in particular its EXACT path.
 *
 * WHY A SEPARATE FILE
 * -------------------
 * `geoprocessing.test.ts` pins the buffer's golden numbers on 10×10 squares,
 * where the offset curve happens to behave. This file exists because it does not
 * behave in general: as soon as the distance is comparable to a segment length,
 * the two offset curves of a line cross and the closed ring self-intersects, so
 * the polygon it bounds counts its overlapping lobes twice. On a real road
 * network that made 68 of 94 buffers invalid and their area 57 % too large.
 *
 * `bufferGeometry` now falls back to the Minkowski decomposition GEOS uses —
 * union the per-segment slabs, the outside-of-bend wedges and the end caps — and
 * the tests here are the ones that would catch it regressing:
 *
 *   1. ANALYTIC AREAS. A round-capped round-joined line buffer is exactly
 *      2·d·L + π·d². That number is not obtainable from an offset curve at a
 *      sharp bend, and it is the headline assertion.
 *   2. A POINT-MEMBERSHIP ORACLE. The buffer of S by d IS the set of points
 *      within d of S, so for a grid of probes, "inside the result" and
 *      "dist(probe, S) ≤ d" must agree everywhere except in the tessellation
 *      band. This tests the union against the DEFINITION rather than against
 *      another implementation of the same idea, and it is what proves the
 *      "outside of the bend only" wedge rule neither leaves a notch nor bulges.
 *   3. EROSION ALGEBRA. S ⊖ d ⊆ S, and the opening (S ⊖ d) ⊕ d ⊆ S. A neck
 *      thinner than 2d must split in two; a polygon smaller than 2d must vanish.
 *   4. MONOTONICITY. A wider buffer must contain the narrower one, point for
 *      point — which self-intersecting rings routinely violate.
 *
 * Every result is also asserted VALID, because "the right area, self-intersecting"
 * is exactly the failure mode this path exists to remove.
 */
import { describe, expect, it } from 'vitest';
import {
  bufferFeature,
  bufferFeatures,
  bufferGeometry,
  type BufferOptions,
} from './geoprocessing';
import { pointInGeometry, validateGeometry } from './overlay';
import { geometryParts, type Coord, type GeoGeom, type Ring } from './geoTypes';

// ---------------------------------------------------------------------------
// Independent helpers — none of these may come from the module under test
// ---------------------------------------------------------------------------

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

/** Signed area of a geometry: shells minus holes. */
function area(geom: GeoGeom | null): number {
  if (!geom) return 0;
  return geometryParts(geom).reduce((sum, part) => {
    const holes = part.slice(1).reduce((a, h) => a + Math.abs(shoelace(h)), 0);
    return sum + Math.abs(shoelace(part[0])) - holes;
  }, 0);
}

function polylineLength(coords: Coord[]): number {
  let len = 0;
  for (let i = 0; i < coords.length - 1; i++) len += Math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]);
  return len;
}

function pointSegmentDistance(p: Coord, a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distanceToSequence(p: Coord, seq: Coord[]): number {
  let best = Infinity;
  for (let i = 0; i < seq.length - 1; i++) best = Math.min(best, pointSegmentDistance(p, seq[i], seq[i + 1]));
  if (seq.length === 1) best = Math.hypot(p[0] - seq[0][0], p[1] - seq[0][1]);
  return best;
}

/** Even-odd inside one closed ring. */
function ringContains(p: Coord, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i][1] > p[1]) !== (ring[j][1] > p[1])) {
      const xCross = ((ring[j][0] - ring[i][0]) * (p[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0];
      if (p[0] < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Even-odd inside a polygonal geometry (shells minus holes). */
function regionContains(p: Coord, geom: GeoGeom | null): boolean {
  if (!geom) return false;
  if (geom.type === 'Point' || geom.type === 'MultiPoint') return false;
  const seqs = geom.type === 'LineString' || geom.type === 'MultiLineString'
    ? []
    : geometryParts(geom);
  for (const part of seqs) {
    if (!ringContains(p, part[0])) continue;
    if (!part.slice(1).some(h => ringContains(p, h))) return true;
  }
  return false;
}

/**
 * Distance from p to the SET the geometry covers: 0 inside a polygon, otherwise
 * the distance to the nearest boundary segment.
 */
function distanceToSet(p: Coord, geom: GeoGeom | null): number {
  if (!geom) return Infinity;
  switch (geom.type) {
    case 'Point': return Math.hypot(p[0] - geom.coordinates[0], p[1] - geom.coordinates[1]);
    case 'MultiPoint': return Math.min(...geom.coordinates.map(c => Math.hypot(p[0] - c[0], p[1] - c[1])));
    case 'LineString': return distanceToSequence(p, geom.coordinates);
    case 'MultiLineString': return Math.min(...geom.coordinates.map(s => distanceToSequence(p, s)));
    default: {
      if (regionContains(p, geom)) return 0;
      let best = Infinity;
      for (const part of geometryParts(geom)) for (const ring of part) best = Math.min(best, distanceToSequence(p, ring));
      return best;
    }
  }
}

/**
 * How far an inscribed arc of `segments` pieces per quarter circle can sit
 * inside the true circle: the chord midpoint is at r·cos(step/2).
 */
function tessellationSagitta(radius: number, segments: number): number {
  return Math.abs(radius) * (1 - Math.cos(Math.PI / (4 * segments)));
}

/**
 * Compare a buffer against its DEFINITION over a grid of probes.
 *
 * Returns the two disagreement counts. A point further than d must never be
 * inside; a point closer than d minus the tessellation band must never be
 * outside. The band is the only legitimate disagreement, and it shrinks with
 * `segments` — which is asserted separately.
 */
function oracleMismatches(
  source: GeoGeom,
  buffered: GeoGeom | null,
  d: number,
  segments: number,
  box: [number, number, number, number],
  step: number
): { tooFar: number; tooClose: number; probes: number } {
  const sagitta = tessellationSagitta(d, segments);
  let tooFar = 0;
  let tooClose = 0;
  let probes = 0;
  for (let x = box[0]; x <= box[2]; x += step) {
    for (let y = box[1]; y <= box[3]; y += step) {
      const p: Coord = [x, y];
      probes++;
      const dist = distanceToSet(p, source);
      const inside = pointInGeometry(p, buffered, 1e-9);
      if (inside && dist > d + 1e-6) tooFar++;
      if (!inside && dist <= d - sagitta - 1e-6) tooClose++;
    }
  }
  return { tooFar, tooClose, probes };
}

const squareRing = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] as Ring;

/** A zigzag whose segments are an order of magnitude SHORTER than the buffer. */
const TIGHT_ZIGZAG: Coord[] = (() => {
  const pts: Coord[] = [];
  for (let i = 0; i <= 12; i++) pts.push([i * 0.5, i % 2 === 0 ? 0 : 0.6]);
  return pts;
})();

const FINE: BufferOptions = { segments: 96 };

// ---------------------------------------------------------------------------
// 1. Analytic areas
// ---------------------------------------------------------------------------

describe('buffer: exact areas on the piece-union path', () => {
  /**
   * The regression that started this: a three-point line whose bend is sharp
   * enough that the offset curve crossed itself. The offset path returned a
   * repaired MultiPolygon of area 28.29 — 29 % short — because the overlapping
   * lobes cancelled under the winding rule.
   *
   * There is no one-line formula for a bent polyline: the slabs overlap on the
   * inside of the bend, so the area is 2·d·L + π·d² + Σ(join sectors) − Σ(slab
   * overlaps), and only the first three terms are easy to write down. They form
   * an upper bound, which is asserted here; the exact value is pinned by the
   * point-membership oracle in the next describe block, which tests the result
   * against the DEFINITION of a buffer rather than against another formula.
   */
  it('a sharp-bend round buffer covers the ground the offset curve lost', () => {
    const coords: Coord[] = [[0, 0], [10, 0], [12, 8]];
    const d = 1;
    const turn = Math.abs(Math.atan2(8, 2));                    // 75.96° bend
    const upper = 2 * d * polylineLength(coords) + Math.PI * d * d + 0.5 * d * d * turn;
    const coarse = bufferGeometry({ type: 'LineString', coordinates: coords }, d);
    const fine = bufferGeometry({ type: 'LineString', coordinates: coords }, d, FINE);
    // The offset path returned 28.29 here. The lower bound is deliberately loose
    // but an order of magnitude above it: two d×L slabs, the two caps and the
    // join sector, less at most the one slab overlap.
    expect(area(fine)).toBeGreaterThan(39);
    expect(area(fine)).toBeLessThanOrEqual(upper);
    expect(area(fine)).toBeGreaterThan(area(coarse));           // converges from below
    expect(coarse?.type).toBe('Polygon');                       // one region, not a repaired multipart
    expect(validateGeometry(fine)).toEqual([]);
    expect(validateGeometry(coarse)).toEqual([]);
  });

  it('caps add exactly their own area', () => {
    const coords: Coord[] = [[0, 0], [10, 0]];
    const L = 10;
    const flat = bufferGeometry({ type: 'LineString', coordinates: coords }, 1, { endCapStyle: 'flat' });
    const squareCap = bufferGeometry({ type: 'LineString', coordinates: coords }, 1, { endCapStyle: 'square' });
    const round = bufferGeometry({ type: 'LineString', coordinates: coords }, 1, { endCapStyle: 'round', ...FINE });
    // A straight line has no bends, so the slab/cap decomposition is exact:
    // flat = the 2d×L slab, square adds a d-deep 2d-wide block at each end,
    // round adds two half discs.
    expect(area(flat)).toBeCloseTo(2 * L, 6);
    expect(area(squareCap)).toBeCloseTo(2 * L + 4, 6);
    expect(area(round)).toBeCloseTo(2 * L + Math.PI, 2);
    // And the square cap really does reach d past the end, not just look bigger:
    // (10.8, 0.8) is 1.13 from the last vertex — outside the round cap's disc,
    // inside the square cap's block.
    expect(pointInGeometry([10.8, 0.8], squareCap, 1e-9)).toBe(true);
    expect(pointInGeometry([10.8, 0.8], round, 1e-9)).toBe(false);
    expect(pointInGeometry([10.8, 0.8], flat, 1e-9)).toBe(false);
    expect(pointInGeometry([10.5, 0], round, 1e-9)).toBe(true);
    expect(pointInGeometry([10.5, 0], flat, 1e-9)).toBe(false);
  });

  it('join styles order as bevel < round < miter at a bend', () => {
    const coords: Coord[] = [[0, 0], [10, 0], [12, 8]];
    const geom: GeoGeom = { type: 'LineString', coordinates: coords };
    const bevel = area(bufferGeometry(geom, 1, { joinStyle: 'bevel' }));
    const round = area(bufferGeometry(geom, 1, { joinStyle: 'round', ...FINE }));
    const mitre = area(bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 20 }));
    const clipped = area(bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 1 }));
    expect(bevel).toBeLessThan(round);
    expect(round).toBeLessThan(mitre);
    // A mitre limit of 1 forbids every mitre longer than the radius, so the
    // corner falls back to a bevel — the same area as joinStyle: bevel.
    expect(clipped).toBeCloseTo(bevel, 6);
  });

  it('a convex polygon grows by perimeter·d plus a disc', () => {
    const shell = squareRing(0, 0, 10, 10);
    const exact = 100 + 40 + Math.PI;
    const coarse = bufferGeometry({ type: 'Polygon', coordinates: [shell] }, 1);
    const fine = bufferGeometry({ type: 'Polygon', coordinates: [shell] }, 1, FINE);
    expect(area(coarse)).toBeCloseTo(exact, 1);
    expect(area(fine)).toBeGreaterThan(area(coarse));
    expect(area(fine)).toBeLessThan(exact);
  });

  it('clean input never pays for the union: the offset ring ships as built', () => {
    // The offset path tessellates a 90° corner into `segments` arc points, so a
    // square buffered with segments=8 has 4·8 + 1 vertices per corner plus the
    // closing point = 37. The union path nodes the arcs against the slabs and
    // produces more. Asserting the count pins the fast path (and its cost).
    const geom = bufferGeometry({ type: 'Polygon', coordinates: [squareRing(0, 0, 10, 10)] }, 1);
    expect(geom?.type).toBe('Polygon');
    if (geom?.type !== 'Polygon') throw new Error('expected a Polygon');
    expect(geom.coordinates).toHaveLength(1);
    expect(geom.coordinates[0]).toHaveLength(37);
  });
});

// ---------------------------------------------------------------------------
// 2. The point-membership oracle
// ---------------------------------------------------------------------------

describe('buffer: the result IS the set of points within d', () => {
  it('a tight zigzag whose segments are shorter than the distance', () => {
    const d = 5;
    const source: GeoGeom = { type: 'LineString', coordinates: TIGHT_ZIGZAG };
    for (const joinStyle of ['round', 'bevel', 'miter'] as const) {
      const buffered = bufferGeometry(source, d, { joinStyle, segments: 96, miterLimit: 5 });
      expect(validateGeometry(buffered), joinStyle).toEqual([]);
      const box: [number, number, number, number] = [-8, -8, 14, 9];
      const { tooFar, tooClose, probes } = oracleMismatches(source, buffered, d, 96, box, 0.31);
      expect(probes).toBeGreaterThan(1000);
      // Only the ROUND join is the Minkowski sum with a disc, so only it can be
      // held to "inside ⟺ within d" on both sides. Bevel cuts the outside of a
      // bend away along a chord (so it misses ground that is within d, and never
      // covers ground beyond it); a mitre covers the whole wedge and then some
      // (so it misses nothing, and overshoots past d). Those three signatures are
      // the definition of the join styles, measured against the source.
      if (joinStyle === 'round') {
        expect(tooFar).toBe(0);
        expect(tooClose).toBe(0);
      } else if (joinStyle === 'bevel') {
        expect(tooFar).toBe(0);
        expect(tooClose).toBeGreaterThan(0);
      } else {
        expect(tooClose).toBe(0);
        expect(tooFar).toBeGreaterThan(0);
      }
    }
  });

  it('at a gentle bend the join style is visible: bevel cuts, mitre overshoots', () => {
    // Segments ten times the distance, so the corner is not swallowed by the
    // neighbouring slabs the way the tight zigzag's are.
    const source: GeoGeom = { type: 'LineString', coordinates: [[0, 0], [10, 0], [10, 10]] as Coord[] };
    const d = 1;
    const bevel = bufferGeometry(source, d, { joinStyle: 'bevel' });
    const round = bufferGeometry(source, d, { joinStyle: 'round', ...FINE });
    const mitre = bufferGeometry(source, d, { joinStyle: 'miter', miterLimit: 5 });
    // (10.8, -0.8) is 1.13 from the corner vertex but only 0.8 from each offset
    // edge line: outside the disc-sum, inside the mitre, outside the bevel.
    const corner: Coord = [10 + 0.7, -0.7];   // 0.99 from the vertex, on the outside bisector
    expect(distanceToSet(corner, source)).toBeLessThan(d);
    expect(pointInGeometry(corner, round, 1e-9)).toBe(true);
    expect(pointInGeometry(corner, bevel, 1e-9)).toBe(false);   // the chord cuts it off
    expect(pointInGeometry([10.9, -0.9], mitre, 1e-9)).toBe(true); // the spike keeps it
    expect(distanceToSet([10.9, -0.9] as Coord, source)).toBeGreaterThan(d);
    expect(area(bevel)).toBeLessThan(area(round));
    expect(area(round)).toBeLessThan(area(mitre));
    for (const g of [bevel, round, mitre]) expect(validateGeometry(g)).toEqual([]);
  });

  it('a concave polygon, growing and shrinking', () => {
    // An L: concave at the inner corner, so the offset curve has to node there.
    const lShape: Ring = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]] as Ring;
    const source: GeoGeom = { type: 'Polygon', coordinates: [lShape] };
    const d = 1.5;
    const grown = bufferGeometry(source, d, FINE);
    expect(validateGeometry(grown)).toEqual([]);
    const growCheck = oracleMismatches(source, grown, d, 96, [-4, -4, 14, 14], 0.29);
    expect(growCheck.tooFar).toBe(0);
    expect(growCheck.tooClose).toBe(0);

    // Shrinking: every point of the result must be at least d inside the source,
    // and every point d away from the boundary must be in the result.
    const shrunk = bufferGeometry(source, -d, FINE);
    expect(validateGeometry(shrunk)).toEqual([]);
    expect(area(shrunk)).toBeLessThan(area(source));
    let missing = 0;
    let outside = 0;
    for (let x = -1; x <= 11; x += 0.23) {
      for (let y = -1; y <= 11; y += 0.23) {
        const p: Coord = [x, y];
        const inResult = pointInGeometry(p, shrunk, 1e-9);
        const distBoundary = distanceToSet(p, source) === 0
          ? Math.min(...geometryParts(source).flatMap(part => part.map(r => distanceToSequence(p, r))))
          : 0;
        if (inResult && distBoundary < d - 1e-6) outside++;
        if (!inResult && regionContains(p, source) && distBoundary > d + tessellationSagitta(d, 96) + 1e-6) missing++;
      }
    }
    expect(outside).toBe(0);
    expect(missing).toBe(0);
  });

  it('a donut: the material grows into the void and out of the shell', () => {
    const donut: GeoGeom = { type: 'Polygon', coordinates: [squareRing(0, 0, 10, 10), squareRing(3, 3, 7, 7)] };
    const d = 1;
    const grown = bufferGeometry(donut, d, FINE);
    expect(validateGeometry(grown)).toEqual([]);
    if (grown?.type !== 'Polygon') throw new Error('expected one Polygon');
    expect(grown.coordinates).toHaveLength(2);
    // Covered ground = shell⊕d minus hole⊖d, checked against the definition.
    const check = oracleMismatches(donut, grown, d, 96, [-3, -3, 13, 13], 0.27);
    expect(check.tooFar).toBe(0);
    expect(check.tooClose).toBe(0);
  });

  it('the tessellation band shrinks as segments grow', () => {
    // A closed convex ring, so Steiner applies exactly: A + P·d + π·d². The arc
    // is inscribed, so every tessellation undershoots and the shortfall falls as
    // segments² — measured against the formula AND against the oracle.
    const shell = squareRing(0, 0, 8, 5);
    const source: GeoGeom = { type: 'Polygon', coordinates: [shell] };
    const d = 1;
    const exact = 40 + 26 * d + Math.PI * d * d;
    const counts = [2, 4, 16, 96];
    const areas = counts.map(segments => area(bufferGeometry(source, d, { segments })));
    for (let i = 0; i + 1 < areas.length; i++) expect(areas[i]).toBeLessThan(areas[i + 1]);
    expect(areas[areas.length - 1]).toBeLessThan(exact);
    expect(exact - areas[areas.length - 1]).toBeLessThan(exact * 1e-4);
    // Quadratic convergence: halving the arc step divides the shortfall by four.
    expect(exact - areas[0]).toBeGreaterThan(3 * (exact - areas[1]));
    expect(exact - areas[1]).toBeGreaterThan(3 * (exact - areas[2]));

    // The same undershoot, seen from the membership side: with a coarse arc the
    // chord of a corner sits measurably inside the true circle, so a probe just
    // within d of a corner can fall outside the result.
    const corner = squareRing(0, 0, 8, 5);
    const probe: Coord = [9 - tessellationSagitta(1, 96) / 2, 2.5];   // d − a hair off the right edge
    expect(distanceToSet(probe, { type: 'Polygon', coordinates: [corner] })).toBeLessThan(1);
    expect(pointInGeometry(probe, bufferGeometry(source, 1, { segments: 96 })!, 1e-9)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Erosion
// ---------------------------------------------------------------------------

describe('buffer: negative distances are a real erosion', () => {
  it('the result is inside the source, and opening it stays inside too', () => {
    const lShape: Ring = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]] as Ring;
    const source: GeoGeom = { type: 'Polygon', coordinates: [lShape] };
    const d = 0.8;
    const eroded = bufferGeometry(source, -d, FINE);
    expect(validateGeometry(eroded)).toEqual([]);

    // (S ⊖ d) ⊆ S
    for (let x = -1; x <= 11; x += 0.31) {
      for (let y = -1; y <= 11; y += 0.31) {
        const p: Coord = [x, y];
        if (pointInGeometry(p, eroded, 1e-9)) expect(regionContains(p, source), `leaked at ${p}`).toBe(true);
      }
    }

    // (S ⊖ d) ⊕ d ⊆ S — the opening property, which an inverted offset curve
    // violates spectacularly.
    const reopened = bufferGeometry(eroded!, d, FINE);
    expect(validateGeometry(reopened)).toEqual([]);
    for (let x = -2; x <= 12; x += 0.31) {
      for (let y = -2; y <= 12; y += 0.31) {
        const p: Coord = [x, y];
        if (pointInGeometry(p, reopened, 1e-9)) expect(regionContains(p, source), `opening leaked at ${p}`).toBe(true);
      }
    }
  });

  it('a neck thinner than 2d splits in two, and a sliver vanishes', () => {
    // An hourglass: two 6×6 lobes joined by a 2-wide neck.
    const hourglass: Ring = [
      [0, 0], [6, 0], [6, 2], [8, 2], [8, 0], [14, 0], [14, 6], [8, 6], [8, 4], [6, 4], [6, 6], [0, 6], [0, 0],
    ] as Ring;
    const source: GeoGeom = { type: 'Polygon', coordinates: [hourglass] };
    const barely = bufferGeometry(source, -0.5, FINE);       // neck is 2 wide → survives
    expect(area(barely)).toBeGreaterThan(0);
    const through = bufferGeometry(source, -1.5, FINE);      // neck thinner than 2d
    expect(validateGeometry(through)).toEqual([]);
    expect(geometryParts(through).length).toBe(2);           // cut into two lobes
    expect(area(through)).toBeLessThan(area(barely));

    // Smaller than 2d in every direction → nothing is d away from the boundary.
    expect(bufferGeometry({ type: 'Polygon', coordinates: [squareRing(0, 0, 1, 1)] }, -10)).toBeNull();
    expect(bufferGeometry({ type: 'Polygon', coordinates: [squareRing(0, 0, 1, 1)] }, -0.6, FINE)).toBeNull();
  });

  it('never turns a small polygon inside out', () => {
    // The offset path used to invert a 1×1 square buffered by −10 into a 19×19
    // polygon. The piece path cannot: erosion is a difference, and a difference
    // with everything leaves nothing.
    for (const d of [-0.4, -0.6, -2, -10, -1000]) {
      const out = bufferGeometry({ type: 'Polygon', coordinates: [squareRing(0, 0, 1, 1)] }, d, FINE);
      expect(out === null || area(out) <= 1).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Monotonicity and validity
// ---------------------------------------------------------------------------

describe('buffer: monotonic in the distance', () => {
  it('a wider buffer contains the narrower one, point for point', () => {
    const sources: GeoGeom[] = [
      { type: 'LineString', coordinates: TIGHT_ZIGZAG },
      { type: 'Polygon', coordinates: [squareRing(0, 0, 10, 10), squareRing(3, 3, 7, 7)] },
      { type: 'MultiPoint', coordinates: [[0, 0], [1.2, 0.4], [6, 6]] as Coord[] },
    ];
    for (const source of sources) {
      const rings = [0.5, 1, 2, 4].map(d => bufferGeometry(source, d, FINE));
      rings.forEach((r, i) => expect(validateGeometry(r), `${source.type} d=${[0.5, 1, 2, 4][i]}`).toEqual([]));
      for (let x = -6; x <= 12; x += 0.37) {
        for (let y = -6; y <= 12; y += 0.37) {
          const p: Coord = [x, y];
          for (let i = 0; i + 1 < rings.length; i++) {
            if (pointInGeometry(p, rings[i], 1e-9)) {
              expect(pointInGeometry(p, rings[i + 1], 1e-9), `${source.type} at ${p}`).toBe(true);
            }
          }
        }
      }
      const areas = rings.map(area);
      for (let i = 0; i + 1 < areas.length; i++) expect(areas[i]).toBeLessThan(areas[i + 1]);
    }
  });

  it('every buffer of every geometry type comes back valid', () => {
    const geoms: GeoGeom[] = [
      { type: 'Point', coordinates: [0, 0] },
      { type: 'MultiPoint', coordinates: [[0, 0], [0.3, 0.1], [9, 9]] as Coord[] },
      { type: 'LineString', coordinates: TIGHT_ZIGZAG },
      { type: 'MultiLineString', coordinates: [TIGHT_ZIGZAG, [[0, 3], [6, 3.2], [6, -1]] as Coord[]] },
      { type: 'Polygon', coordinates: [squareRing(0, 0, 10, 10), squareRing(3, 3, 7, 7)] },
      { type: 'MultiPolygon', coordinates: [[squareRing(0, 0, 4, 4)], [squareRing(5, 0, 9, 4)]] },
    ];
    for (const geom of geoms) {
      for (const d of [0.25, 1, 3, 12]) {
        const out = bufferGeometry(geom, d, FINE);
        expect(out, `${geom.type} d=${d}`).not.toBeNull();
        expect(validateGeometry(out), `${geom.type} d=${d}`).toEqual([]);
      }
      for (const d of [-0.1, -1, -3]) {
        const out = bufferGeometry(geom, d, FINE);
        if (out) expect(validateGeometry(out), `${geom.type} d=${d}`).toEqual([]);
      }
    }
  });

  it('overlapping parts of a multipart input merge instead of stacking', () => {
    // Two squares 1 apart, buffered by 3: the buffers overlap, so the result is
    // ONE region. Stacking two overlapping parts is the `overlapping-parts`
    // validity error, which is what the offset path used to emit.
    const geom: GeoGeom = {
      type: 'MultiPolygon',
      coordinates: [[squareRing(0, 0, 4, 4)], [squareRing(5, 0, 9, 4)]],
    };
    const out = bufferGeometry(geom, 3, FINE);
    expect(validateGeometry(out)).toEqual([]);
    expect(area(out)).toBeLessThan(2 * area(bufferGeometry({ type: 'Polygon', coordinates: [squareRing(0, 0, 4, 4)] }, 3, FINE)));
    // And the shared ground is counted once: union of the two separate buffers.
    const one = area(bufferGeometry({ type: 'Polygon', coordinates: [squareRing(0, 0, 4, 4)] }, 3, FINE));
    expect(area(out)).toBeGreaterThan(one);
    expect(area(out)).toBeLessThan(2 * one);

    // MultiPoint: two circles 1 apart at radius 3 are one blob.
    const pts = bufferGeometry({ type: 'MultiPoint', coordinates: [[0, 0], [1, 0]] as Coord[] }, 3, FINE);
    expect(pts?.type).toBe('Polygon');
    expect(validateGeometry(pts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Single-sided
// ---------------------------------------------------------------------------

describe('buffer: single-sided lines', () => {
  it('covers one side of the direction of travel and none of the other', () => {
    const coords: Coord[] = [[0, 0], [10, 0]];
    const left = bufferGeometry({ type: 'LineString', coordinates: coords }, 1, { singleSided: true });
    const right = bufferGeometry({ type: 'LineString', coordinates: coords }, -1, { singleSided: true });
    for (const g of [left, right]) {
      expect(g).not.toBeNull();
      expect(validateGeometry(g)).toEqual([]);
      expect(area(g)).toBeCloseTo(10, 6);   // L × d, no caps
    }
    expect(pointInGeometry([5, 0.5], left, 1e-9)).toBe(true);
    expect(pointInGeometry([5, -0.5], left, 1e-9)).toBe(false);
    expect(pointInGeometry([5, -0.5], right, 1e-9)).toBe(true);
    expect(pointInGeometry([5, 0.5], right, 1e-9)).toBe(false);
    // Flat ends: nothing beyond the last vertex on either side.
    expect(pointInGeometry([10.5, 0.5], left, 1e-9)).toBe(false);
    expect(pointInGeometry([-0.5, 0.5], left, 1e-9)).toBe(false);
  });

  it('follows a bend on the chosen side only', () => {
    const coords: Coord[] = [[0, 0], [10, 0], [10, 10]];
    const left = bufferGeometry({ type: 'LineString', coordinates: coords }, 2, { singleSided: true, ...FINE });
    expect(validateGeometry(left)).toEqual([]);
    // The left of travel is the inside of this bend: the corner square is filled,
    // the outside of the bend is empty.
    expect(pointInGeometry([9, 1], left, 1e-9)).toBe(true);
    expect(pointInGeometry([11.5, 5], left, 1e-9)).toBe(false);
    expect(pointInGeometry([5, -1.5], left, 1e-9)).toBe(false);
    // Area = two 10×2 slabs less the 2×2 they share at the corner, plus the
    // round join wedge on the inside... which the slabs already cover.
    expect(area(left)).toBeCloseTo(2 * 20 - 4, 6);
  });

  it('is exposed per feature and leaves polygons alone', () => {
    const out = bufferFeatures(
      [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] as Coord[] }, properties: { id: 'line' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [squareRing(0, 20, 10, 30)] }, properties: { id: 'poly' } },
      ],
      1,
      { singleSided: true }
    );
    expect(out).toHaveLength(2);
    expect(area(out[0].geometry)).toBeCloseTo(10, 6);       // one side only
    expect(area(out[1].geometry)).toBeGreaterThan(100);     // polygon: unaffected
  });
});

// ---------------------------------------------------------------------------
// 6. Layer level
// ---------------------------------------------------------------------------

describe('buffer: layer level', () => {
  it('keeps attributes and never emits an invalid feature', () => {
    const features = TIGHT_ZIGZAG.length
      ? [
          { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: TIGHT_ZIGZAG }, properties: { id: 'a' } },
          { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [squareRing(0, 0, 3, 3)] }, properties: { id: 'b' } },
        ]
      : [];
    const out = bufferFeatures(features, 5, FINE);
    expect(out).toHaveLength(2);
    expect(out.map(f => f.properties.id)).toEqual(['a', 'b']);
    out.forEach(f => expect(validateGeometry(f.geometry)).toEqual([]));
    expect(bufferFeature(features[0], 5, FINE)?.properties).toEqual({ id: 'a' });
  });

  it('a distance of zero is the identity', () => {
    const geom: GeoGeom = { type: 'Polygon', coordinates: [squareRing(0, 0, 10, 10)] };
    expect(bufferGeometry(geom, 0)).toBe(geom);
  });
});
