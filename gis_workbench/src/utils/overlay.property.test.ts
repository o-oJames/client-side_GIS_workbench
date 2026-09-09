/**
 * overlay.property.test.ts — differential & property tests for the overlay kernel.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `overlay.test.ts` is 73 hand-built golden fixtures: they pin the cases we
 * already know about. They cannot tell us whether the kernel is right on
 * geometry nobody thought to draw. This file attacks that gap the way you would
 * attack any geometry kernel — with *invariants* and with a *differential
 * oracle*:
 *
 *   INVARIANTS   Identities every correct overlay must satisfy, independent of
 *                the algorithm: area conservation (|A∩B| + |A−B| = |A|),
 *                inclusion–exclusion (|A∪B| = |A| + |B| − |A∩B|), idempotence,
 *                commutativity, associativity, De Morgan style rewrites, and
 *                "every result is a valid geometry" (GEOS's own contract).
 *
 *   DIFFERENTIAL Point-set membership. For thousands of sample points, whether a
 *                point lands in the *result* must equal the boolean combination
 *                of whether it lands in the *inputs*. The oracle here is an
 *                independent even-odd ray caster written in this file — NOT the
 *                kernel's own `pointInGeometry`, so a mislabelled edge cannot
 *                agree with itself and hide.
 *
 * Everything is driven by a seeded PRNG (mulberry32) and every assertion names
 * its seed, so a failure is a reproducible fixture rather than a heisenbug.
 *
 * The generators deliberately produce the shapes that break naive kernels:
 * concave star polygons, donuts (holes), parcels sharing exact boundaries,
 * T-junctions, overlapping rectangles, near-coincident duplicates, and the same
 * scenarios re-run at EPSG:3857 magnitudes where ordinates are ~1.5e7 and the
 * double spacing is ~2e-9 (which is why the tolerance is scale-derived).
 */
import {
  clipGeometry,
  connectedComponents,
  hasFiniteCoordinates,
  differenceFromMany,
  differenceGeometries,
  differenceGeometry,
  intersectGeometries,
  isGeometryValid,
  overlayGeometries,
  overlayTolerance,
  pointInGeometry,
  polygonizeGeometries,
  repairGeometry,
  symDifferenceGeometries,
  unionComponents,
  unionGeometries,
  unionMany,
  validateGeometry,
} from './overlay';
import { geometryParts, type Coord, type GeoGeom, type Ring } from './geoTypes';

// ---------------------------------------------------------------------------
// A seeded PRNG, so "random" tests are reproducible
// ---------------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

function intBetween(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Measurement helpers (independent of the kernel)
// ---------------------------------------------------------------------------

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * Area the geometry covers: shells minus holes, summed over every part.
 *
 * `origin` is subtracted before the shoelace. In exact arithmetic that changes
 * nothing (a closed ring's shoelace is translation invariant), but in double
 * arithmetic it is everything: at EPSG:3857 magnitudes the products are ~2e14
 * and the sum cancels back down to ~1e4, so measuring without re-basing carries
 * a relative error of ~1e-5 — a hundred times larger than the kernel's own
 * snapping error. Re-basing stops the MEASUREMENT from becoming the thing under
 * test when a geometry is translated.
 */
function areaRel(geom: GeoGeom | null, origin: Coord = [0, 0]): number {
  if (!geom) return 0;
  const rel = (r: Ring): Ring => r.map(c => [c[0] - origin[0], c[1] - origin[1]] as Coord);
  return geometryParts(geom).reduce((sum, part) => {
    const shell = Math.abs(shoelace(rel(part[0])));
    const holes = part.slice(1).reduce((a, h) => a + Math.abs(shoelace(rel(h))), 0);
    return sum + shell - holes;
  }, 0);
}

function area(geom: GeoGeom | null): number {
  return areaRel(geom);
}

/** Convex hull area by monotone chain — an independent bound on coverage. */
function convexHullArea(points: Coord[]): number {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return 0;
  const cross = (o: Coord, a: Coord, b: Coord) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Coord[] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Coord[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return 0;
  hull.push(hull[0]);
  return Math.abs(shoelace(hull));
}

function allRings(geom: GeoGeom | null): Ring[] {
  if (!geom) return [];
  return geometryParts(geom).flat();
}

function polylineLength(coords: Coord[]): number {
  let len = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    len += Math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]);
  }
  return len;
}

function geomLineLength(geom: GeoGeom | null): number {
  if (!geom) return 0;
  if (geom.type === 'LineString') return polylineLength(geom.coordinates);
  if (geom.type === 'MultiLineString') return geom.coordinates.reduce((a, s) => a + polylineLength(s), 0);
  return 0;
}

function distToSegment(p: Coord, a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a point to the nearest boundary of any of the given geometries. */
function distToBoundaries(p: Coord, geoms: (GeoGeom | null)[]): number {
  let best = Infinity;
  for (const g of geoms) {
    for (const ring of allRings(g)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const d = distToSegment(p, ring[i], ring[i + 1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// THE ORACLE: an independent even-odd ray caster.
//
// Deliberately not the kernel's `pointInGeometry` (nonzero winding over an
// R-tree). For the *simple* polygons this file generates the two agree by
// definition, so any disagreement between this and an overlay result is a real
// kernel defect, not a semantics debate.
// ---------------------------------------------------------------------------

function ringContainsEvenOdd(p: Coord, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if ((yi > p[1]) !== (yj > p[1])) {
      const xCross = ((ring[j][0] - ring[i][0]) * (p[1] - yi)) / (yj - yi) + ring[i][0];
      if (p[0] < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Inside a shell and not inside any of its holes — the textbook definition. */
function refContains(p: Coord, geom: GeoGeom | null): boolean {
  if (!geom) return false;
  for (const part of geometryParts(geom)) {
    if (!ringContainsEvenOdd(p, part[0])) continue;
    const inHole = part.slice(1).some(h => ringContainsEvenOdd(p, h));
    if (!inHole) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Geometry generators
// ---------------------------------------------------------------------------

/** Axis-aligned rectangle as a CCW ring. */
function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

function poly(rings: Ring[]): GeoGeom {
  return { type: 'Polygon', coordinates: rings };
}

function multipoly(parts: Ring[][]): GeoGeom {
  return { type: 'MultiPolygon', coordinates: parts };
}

/**
 * A star-shaped (radially monotone) polygon: always simple, usually concave.
 * Concavity is what killed the Sutherland–Hodgman clipper, so it is the single
 * most valuable shape to fuzz with.
 */
function starPolygon(rng: Rng, cx: number, cy: number, rMin: number, rMax: number, n?: number): Ring {
  const vertices = n ?? intBetween(rng, 5, 12);
  const radii: number[] = [];
  for (let i = 0; i < vertices; i++) radii.push(between(rng, rMin, rMax));
  const ring: Ring = [];
  for (let i = 0; i < vertices; i++) {
    const angle = (2 * Math.PI * i) / vertices + between(rng, -0.15, 0.15);
    ring.push([cx + radii[i] * Math.cos(angle), cy + radii[i] * Math.sin(angle)]);
  }
  // Guarantee a strictly increasing angle sweep would need sorting; the jitter is
  // small enough (±0.15 rad on a 2π/n ≥ 0.52 rad step) that the ring stays simple.
  ring.push([ring[0][0], ring[0][1]]);
  if (shoelace(ring) < 0) ring.reverse();
  return ring;
}

/** A star polygon with a scaled-down copy of itself as a hole: a donut. */
function donutPolygon(rng: Rng, cx: number, cy: number, r: number): Ring[] {
  const shell = starPolygon(rng, cx, cy, r * 0.7, r);
  const hole = shell.slice(0, -1).map(([x, y]) => [cx + (x - cx) * 0.35, cy + (y - cy) * 0.35] as Coord);
  hole.push([hole[0][0], hole[0][1]]);
  hole.reverse(); // holes run the other way
  return [shell, hole];
}

/** Random overlapping rectangles — the cadastral-parcel case. */
function rectPolygon(rng: Rng, span: number): GeoGeom {
  const w = between(rng, span * 0.2, span * 0.8);
  const h = between(rng, span * 0.2, span * 0.8);
  const x = between(rng, -span * 0.5, span * 0.5);
  const y = between(rng, -span * 0.5, span * 0.5);
  return poly([rect(x, y, x + w, y + h)]);
}

/**
 * A grid of parcels that share boundaries EXACTLY (the case a shared-edge
 * splice used to fumble), with interior vertices jittered so the shared edges
 * are T-junctions rather than clean node matches.
 */
function parcelGrid(rng: Rng, cells: number, size: number, jitter: number): GeoGeom[] {
  // One shared node table, so neighbouring parcels really do share vertices.
  const nodes: Coord[][] = [];
  for (let r = 0; r <= cells; r++) {
    const row: Coord[] = [];
    for (let c = 0; c <= cells; c++) {
      const edge = r === 0 || c === 0 || r === cells || c === cells;
      row.push([
        c * size + (edge ? 0 : between(rng, -jitter, jitter)),
        r * size + (edge ? 0 : between(rng, -jitter, jitter)),
      ]);
    }
    nodes.push(row);
  }
  const out: GeoGeom[] = [];
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const ring: Ring = [nodes[r][c], nodes[r][c + 1], nodes[r + 1][c + 1], nodes[r + 1][c], nodes[r][c]];
      if (shoelace(ring) < 0) ring.reverse();
      out.push(poly([ring]));
    }
  }
  return out;
}

/** Translate a geometry, e.g. onto real EPSG:3857 magnitudes. */
function translate(geom: GeoGeom, dx: number, dy: number): GeoGeom {
  const move = (c: Coord): Coord => [c[0] + dx, c[1] + dy];
  const moveRing = (r: Ring): Ring => r.map(move);
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(moveRing) };
  if (geom.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map(p => p.map(moveRing)) };
  }
  if (geom.type === 'LineString') return { type: 'LineString', coordinates: geom.coordinates.map(move) };
  if (geom.type === 'MultiLineString') {
    return { type: 'MultiLineString', coordinates: geom.coordinates.map(s => s.map(move)) };
  }
  if (geom.type === 'Point') return { type: 'Point', coordinates: move(geom.coordinates) };
  return { type: 'MultiPoint', coordinates: geom.coordinates.map(move) };
}

/** Scale a geometry about the origin — the tolerance model's other axis. */
function scale(geom: GeoGeom, k: number): GeoGeom {
  const mul = (c: Coord): Coord => [c[0] * k, c[1] * k];
  const mulRing = (r: Ring): Ring => r.map(mul);
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(mulRing) };
  if (geom.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map(pt => pt.map(mulRing)) };
  }
  if (geom.type === 'LineString') return { type: 'LineString', coordinates: geom.coordinates.map(mul) };
  if (geom.type === 'MultiLineString') {
    return { type: 'MultiLineString', coordinates: geom.coordinates.map(sq => sq.map(mul)) };
  }
  if (geom.type === 'Point') return { type: 'Point', coordinates: mul(geom.coordinates) };
  return { type: 'MultiPoint', coordinates: geom.coordinates.map(mul) };
}

type ScenarioKind = 'stars' | 'donuts' | 'rects' | 'mixed' | 'parcels' | 'coincident';

/** One reproducible pair (or group) of geometries to run every property over. */
function scenario(seed: number, kind: ScenarioKind, span = 100): GeoGeom[] {
  const rng = mulberry32(seed);
  switch (kind) {
    case 'stars':
      return [
        poly([starPolygon(rng, 0, 0, span * 0.25, span * 0.5)]),
        poly([starPolygon(rng, span * 0.3, span * 0.2, span * 0.2, span * 0.45)]),
      ];
    case 'donuts':
      return [
        poly(donutPolygon(rng, 0, 0, span * 0.5)),
        poly([starPolygon(rng, span * 0.2, 0, span * 0.15, span * 0.35)]),
      ];
    case 'rects':
      return [rectPolygon(rng, span), rectPolygon(rng, span), rectPolygon(rng, span)];
    case 'parcels': {
      const cells = intBetween(rng, 2, 4);
      const grid = parcelGrid(rng, cells, span / cells, (span / cells) * 0.12);
      return grid.slice(0, intBetween(rng, 3, Math.min(9, grid.length)));
    }
    case 'coincident': {
      // Near-duplicate boundaries: the snapping-tolerance stress test.
      const base = poly([starPolygon(rng, 0, 0, span * 0.3, span * 0.5)]);
      const eps = span * 1e-9;
      return [base, translate(base, eps, -eps)];
    }
    case 'mixed':
    default:
      return [
        poly(donutPolygon(rng, 0, 0, span * 0.45)),
        rectPolygon(rng, span),
        poly([starPolygon(rng, span * 0.25, -span * 0.15, span * 0.1, span * 0.3)]),
      ];
  }
}

const KINDS: ScenarioKind[] = ['stars', 'donuts', 'rects', 'mixed', 'parcels', 'coincident'];

/** A spread of reproducible scenarios across every generator. */
function scenarios(count: number, offset = 0): { seed: number; kind: ScenarioKind; geoms: GeoGeom[] }[] {
  const out: { seed: number; kind: ScenarioKind; geoms: GeoGeom[] }[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 1000 + offset + i * 7919;
    const kind = KINDS[i % KINDS.length];
    out.push({ seed, kind, geoms: scenario(seed, kind) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Relative area comparison. Node snapping can move a vertex by up to the
 * tolerance, so an area can drift by ~perimeter × tolerance ≈ 4e-11 × span² for
 * a scale-derived tolerance. 1e-8 relative is therefore ~250x slack on the
 * legitimate error, and still two orders of magnitude tighter than the 25 %
 * area-loss bugs this kernel replaced.
 */
function expectAreaClose(actual: number, expected: number, ctx: string, rel = 1e-8, absFloor = 1e-12): void {
  // absFloor exists because the kernel DROPS rings smaller than minRingArea
  // (4 x tolerance^2). An identity whose true answer is a sub-tolerance sliver
  // therefore legitimately evaluates to 0; callers pass their scenario's floor.
  const eps = Math.max(Math.abs(expected) * rel, absFloor);
  if (Math.abs(actual - expected) > eps) {
    throw new Error(
      `${ctx}: area ${actual} != expected ${expected} (delta ${actual - expected}, allowed ${eps})`
    );
  }
}

function expectValidResult(geom: GeoGeom | null, ctx: string): void {
  if (geom === null) return;
  const errors = validateGeometry(geom);
  if (errors.length > 0) {
    throw new Error(`${ctx}: result is not valid — ${errors.map(e => `${e.code}@${JSON.stringify(e.location)}`).join(', ')}`);
  }
  if (!isGeometryValid(geom)) throw new Error(`${ctx}: isGeometryValid disagreed with validateGeometry`);
  // GeoJSON orientation contract: shells CCW, holes CW
  for (const part of geometryParts(geom)) {
    if (shoelace(part[0]) <= 0) throw new Error(`${ctx}: shell is not CCW`);
    part.slice(1).forEach((h, i) => {
      if (shoelace(h) >= 0) throw new Error(`${ctx}: hole ${i + 1} is not CW`);
    });
  }
  for (const c of allRings(geom).flat()) {
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) throw new Error(`${ctx}: non-finite coordinate`);
  }
}

// ---------------------------------------------------------------------------
// 1. Area conservation & inclusion–exclusion
// ---------------------------------------------------------------------------

describe('property: area conservation', () => {
  it.each(scenarios(24))('|A∩B| + |A−B| = |A| and the inclusion–exclusion identities ($kind, seed $seed)', ({ seed, geoms }) => {
    const [a, b] = geoms;
    const inter = intersectGeometries(a, b);
    const diff = differenceGeometries(a, b);
    const rdiff = differenceGeometries(b, a);
    const union = unionGeometries([a, b]);
    const sym = symDifferenceGeometries(a, b);
    const ctx = `seed ${seed}`;
    const tol = overlayTolerance([a, b]);
    const sliver = 4 * tol * tol;

    expectAreaClose(area(inter) + area(diff), area(a), `${ctx} A∩B + A−B = A`, 1e-8, sliver);
    expectAreaClose(area(inter) + area(rdiff), area(b), `${ctx} A∩B + B−A = B`, 1e-8, sliver);
    expectAreaClose(area(union), area(a) + area(b) - area(inter), `${ctx} |A∪B| = |A|+|B|−|A∩B|`, 1e-8, sliver);
    expectAreaClose(area(union), area(inter) + area(sym), `${ctx} |A∪B| = |A∩B|+|A△B|`, 1e-8, sliver);
    expectAreaClose(area(sym), area(a) + area(b) - 2 * area(inter), `${ctx} |A△B|`, 1e-8, sliver);
    expectAreaClose(area(diff) + area(rdiff), area(sym), `${ctx} A△B = (A−B)+(B−A)`, 1e-8, sliver);
    expectAreaClose(area(union) + area(inter), area(a) + area(b), `${ctx} |A∪B|+|A∩B| = |A|+|B|`, 1e-8, sliver);

    expectValidResult(inter, `${ctx} intersection`);
    expectValidResult(diff, `${ctx} difference`);
    expectValidResult(rdiff, `${ctx} reverse difference`);
    expectValidResult(union, `${ctx} union`);
    expectValidResult(sym, `${ctx} symDifference`);
  });

  it.each(scenarios(18, 500))('N-way union agrees with a pairwise fold ($kind, seed $seed)', ({ seed, geoms }) => {
    const ctx = `seed ${seed}`;
    const nWay = unionMany(geoms);
    // Sequential (cascaded) union — the shape PostGIS `ST_Union(a, ST_Union(b, c))` takes.
    const folded = geoms.reduce<GeoGeom | null>((acc, g) => (acc ? unionGeometries([acc, g]) : g), null);
    expectAreaClose(area(nWay), area(folded), `${ctx} unionMany vs pairwise fold`);
    // Inclusion–exclusion over the whole set, computed the slow independent way:
    // |⋃S| = Σ|part| − Σ|pairwise overlaps| + … is exponential, so instead assert
    // the union covers every input and nothing more: |⋃S| ≥ max|part| and
    // |⋃S| ≤ Σ|part|.
    const total = geoms.reduce((s, g) => s + area(g), 0);
    const largest = Math.max(...geoms.map(g => area(g)));
    expect(area(nWay)).toBeGreaterThanOrEqual(largest - largest * 1e-8);
    expect(area(nWay)).toBeLessThanOrEqual(total + total * 1e-8);
    expectValidResult(nWay, `${ctx} N-way union`);
  });

  it.each(scenarios(12, 900))('difference-from-many equals repeated pairwise difference ($kind, seed $seed)', ({ seed, geoms }) => {
    const ctx = `seed ${seed}`;
    const [a, ...rest] = geoms;
    const onePass = differenceFromMany(a, rest);
    const iterated = rest.reduce<GeoGeom | null>((acc, g) => (acc ? differenceGeometries(acc, g) : acc), a);
    expectAreaClose(area(onePass), area(iterated), `${ctx} differenceFromMany vs iterated`);
    expectValidResult(onePass, `${ctx} differenceFromMany`);
  });
});

// ---------------------------------------------------------------------------
// 2. The differential oracle: point-set membership
// ---------------------------------------------------------------------------

describe('property: point-set membership matches the boolean algebra (independent oracle)', () => {
  /**
   * Sample a jittered grid over the combined extent and check, for every
   * operator, that membership of the RESULT equals the boolean combination of
   * membership of the INPUTS. Points closer than `guard` to any boundary are
   * skipped: on the boundary itself membership is a measure-zero convention, and
   * both GEOS and this kernel are allowed to pick either side.
   */
  function checkMembership(geoms: GeoGeom[], seed: number, samples = 26) {
    const [a, b] = geoms;
    const results: [string, GeoGeom | null, (ina: boolean, inb: boolean) => boolean][] = [
      ['union', unionGeometries([a, b]), (x, y) => x || y],
      ['intersection', intersectGeometries(a, b), (x, y) => x && y],
      ['difference', differenceGeometries(a, b), (x, y) => x && !y],
      ['symDifference', symDifferenceGeometries(a, b), (x, y) => x !== y],
    ];
    // Extent of both inputs, with a margin so we also sample the outside.
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const g of [a, b]) {
      for (const c of allRings(g).flat()) {
        minX = Math.min(minX, c[0]); minY = Math.min(minY, c[1]);
        maxX = Math.max(maxX, c[0]); maxY = Math.max(maxY, c[1]);
      }
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    minX -= span * 0.25; minY -= span * 0.25; maxX += span * 0.25; maxY += span * 0.25;
    const tol = overlayTolerance([a, b]);
    const guard = Math.max(tol * 50, span * 1e-6);
    const rng = mulberry32(seed ^ 0x5eed);

    let checked = 0;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < samples; j++) {
        const p: Coord = [
          minX + ((maxX - minX) * (i + rng())) / samples,
          minY + ((maxY - minY) * (j + rng())) / samples,
        ];
        if (distToBoundaries(p, [a, b, ...results.map(r => r[1])]) < guard) continue;
        checked++;
        const ina = refContains(p, a);
        const inb = refContains(p, b);
        for (const [op, geom, combine] of results) {
          const got = refContains(p, geom);
          const want = combine(ina, inb);
          if (got !== want) {
            throw new Error(
              `seed ${seed}: ${op} membership wrong at [${p[0].toFixed(6)}, ${p[1].toFixed(6)}] — ` +
              `inA=${ina} inB=${inb} expected=${want} got=${got}`
            );
          }
        }
      }
    }
    // Guard against a vacuous pass: the sampling must actually have tested points.
    expect(checked).toBeGreaterThan(samples * samples * 0.2);
  }

  it.each(scenarios(18, 2000))('every operator is point-set correct ($kind, seed $seed)', ({ seed, geoms }) => {
    checkMembership(geoms.slice(0, 2), seed);
  });

  it('is point-set correct at EPSG:3857 magnitudes, where ordinates are ~1.5e7', () => {
    for (const { seed, geoms } of scenarios(8, 3000)) {
      const [a, b] = geoms.map(g => translate(g, 15_000_000, -4_000_000));
      checkMembership([a, b], seed, 20);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Algebraic identities
// ---------------------------------------------------------------------------

describe('property: algebraic identities', () => {
  it.each(scenarios(18, 4000))('idempotence: A∪A = A, A∩A = A, A−A = ∅, A△A = ∅ ($kind, seed $seed)', ({ seed, geoms }) => {
    const a = geoms[0];
    const ctx = `seed ${seed}`;
    expectAreaClose(area(unionGeometries([a, a])), area(a), `${ctx} A∪A`);
    expectAreaClose(area(intersectGeometries(a, a)), area(a), `${ctx} A∩A`);
    expect(area(differenceGeometries(a, a))).toBe(0);
    expect(area(symDifferenceGeometries(a, a))).toBe(0);
    expectAreaClose(area(repairGeometry(a)), area(a), `${ctx} repair of a valid geometry`);
    expectAreaClose(area(repairGeometry(repairGeometry(a))), area(a), `${ctx} repair is idempotent`);
  });

  it.each(scenarios(18, 5000))('commutativity: A∘B = B∘A for the symmetric operators ($kind, seed $seed)', ({ seed, geoms }) => {
    const [a, b] = geoms;
    const ctx = `seed ${seed}`;
    expectAreaClose(area(unionGeometries([a, b])), area(unionGeometries([b, a])), `${ctx} union`);
    expectAreaClose(area(intersectGeometries(a, b)), area(intersectGeometries(b, a)), `${ctx} intersection`);
    expectAreaClose(area(symDifferenceGeometries(a, b)), area(symDifferenceGeometries(b, a)), `${ctx} symDifference`);
  });

  it.each(scenarios(12, 6000))('associativity: (A∪B)∪C = A∪(B∪C) and (A∩B)∩C = A∩(B∩C) ($kind, seed $seed)', ({ seed, geoms }) => {
    if (geoms.length < 3) return; // parcels/coincident scenarios are pairs
    const [a, b, c] = geoms;
    const ctx = `seed ${seed}`;
    const left = unionGeometries([unionGeometries([a, b])!, c]);
    const right = unionGeometries([a, unionGeometries([b, c])!]);
    expectAreaClose(area(left), area(right), `${ctx} union associativity`, 1e-7);
    const ileft = intersectGeometries(intersectGeometries(a, b), c);
    const iright = intersectGeometries(a, intersectGeometries(b, c));
    expectAreaClose(area(ileft), area(iright), `${ctx} intersection associativity`, 1e-7);
  });

  it.each(scenarios(12, 7000))('N-way union is invariant to input order ($kind, seed $seed)', ({ seed, geoms }) => {
    const ctx = `seed ${seed}`;
    const forward = unionMany(geoms);
    const reversed = unionMany(geoms.slice().reverse());
    expectAreaClose(area(forward), area(reversed), `${ctx} order invariance`);
  });

  it('absorbs a perturbation below the snapping tolerance (documented behaviour)', () => {
    // The 'coincident' generator offsets a star polygon by span x 1e-9 = 1e-7,
    // below the kernel's 1e-6 tolerance floor: the two rings are DEFINED to be
    // the same ring. So the symmetric difference is empty and the union is one
    // part of the original area — no 1e-7-wide slivers. That is the point of
    // node snapping, and GEOS's precision-reduction path behaves the same way.
    const geoms = scenario(55595, 'coincident');
    const tol = overlayTolerance(geoms);
    expect(area(symDifferenceGeometries(geoms[0], geoms[1]))).toBeLessThanOrEqual(4 * tol * tol);
    const union = unionGeometries(geoms);
    expectAreaClose(area(union), area(geoms[0]), 'union of near-coincident rings', 1e-8, 4 * tol * tol);
    expectValidResult(union, 'near-coincident union');
  });

  it.each(scenarios(12, 8000))('identity elements: A∪∅ = A, A∩∅ = ∅, A−∅ = A ($kind, seed $seed)', ({ seed, geoms }) => {
    const a = geoms[0];
    const ctx = `seed ${seed}`;
    expectAreaClose(area(unionGeometries([a, null])), area(a), `${ctx} A∪∅`);
    expect(intersectGeometries(a, null)).toBeNull();
    expectAreaClose(area(differenceGeometries(a, null)), area(a), `${ctx} A−∅`);
    expectAreaClose(area(symDifferenceGeometries(a, null)), area(a), `${ctx} A△∅`);
  });
});

// ---------------------------------------------------------------------------
// 4. Connected components / unionComponents partition
// ---------------------------------------------------------------------------

describe('property: connected components partition the input', () => {
  it('every index appears exactly once, and the parts sum to the whole union', () => {
    for (const { seed, geoms } of scenarios(12, 9000)) {
      const sets = [geoms, [...geoms, translate(geoms[0], 10_000, 10_000)]];
      sets.forEach((list, variant) => {
        const components = connectedComponents(list);
        const seen = components.flat().sort((x, y) => x - y);
        expect(seen).toEqual(list.map((_, i) => i)); // partition: each index once
        const parts = unionComponents(list);
        expect(parts.length).toBe(components.length);
        const sumParts = parts.reduce((s, g) => s + area(g), 0);
        expectAreaClose(sumParts, area(unionMany(list)), `seed ${seed} variant ${variant}: Σ parts = union`);
        parts.forEach((p, i) => expectValidResult(p, `seed ${seed} component ${i}`));
      });
    }
  });

  it('disjoint parcels stay separate; a shared-edge grid merges into one', () => {
    const rng = mulberry32(424242);
    const far = [
      poly([rect(0, 0, 10, 10)]),
      poly([rect(1000, 1000, 1010, 1010)]),
      poly([rect(-500, 200, -490, 210)]),
    ];
    expect(connectedComponents(far).length).toBe(3);
    expect(unionComponents(far).length).toBe(3);
    const grid = parcelGrid(rng, 3, 10, 0); // exact shared boundaries, no jitter
    expect(connectedComponents(grid).length).toBe(1);
    expectAreaClose(area(unionMany(grid)), 900, 'a 3x3 grid of 10x10 parcels');
    expectValidResult(unionMany(grid), 'grid union');
  });
});

// ---------------------------------------------------------------------------
// 5. Clip / difference for points and lines (non-polygonal subjects)
// ---------------------------------------------------------------------------

describe('property: clipping points and lines', () => {
  it('keeps exactly the points the oracle says are inside (boundary inclusive)', () => {
    for (const { seed, geoms } of scenarios(12, 11000)) {
      const clip = geoms[0];
      const rng = mulberry32(seed ^ 0xbeef);
      const tol = overlayTolerance([clip]);
      const guard = Math.max(tol * 50, 1e-6);
      let tested = 0;
      for (let i = 0; i < 200; i++) {
        const p: Coord = [between(rng, -80, 80), between(rng, -80, 80)];
        if (distToBoundaries(p, [clip]) < guard) continue;
        tested++;
        const inside = refContains(p, clip);
        const point: GeoGeom = { type: 'Point', coordinates: p };
        expect(clipGeometry(point, clip) !== null).toBe(inside);
        expect(differenceGeometry(point, clip) !== null).toBe(!inside);
      }
      expect(tested).toBeGreaterThan(150);
    }
  });

  it('splits a MultiPoint into the inside and the outside half', () => {
    const clip = poly([rect(0, 0, 10, 10)]);
    const mp: GeoGeom = { type: 'MultiPoint', coordinates: [[5, 5], [50, 50], [2, 8], [-1, -1]] };
    const kept = clipGeometry(mp, clip);
    expect(kept?.type).toBe('MultiPoint');
    expect((kept as any).coordinates).toEqual([[5, 5], [2, 8]]);
    const gone = differenceGeometry(mp, clip);
    expect((gone as any).coordinates).toEqual([[50, 50], [-1, -1]]);
  });

  it('conserves line length: |clip(L,P)| + |L−P| = |L|', () => {
    for (const { seed, geoms } of scenarios(14, 12000)) {
      const clip = geoms[0];
      const rng = mulberry32((seed ^ 0x112358) >>> 0);
      // Random, deliberately non-axis-aligned polylines: a segment lying exactly
      // along a boundary is the one case where "inside" is a convention, so we
      // do not generate it.
      const coords: Coord[] = [];
      const n = intBetween(rng, 2, 5);
      for (let i = 0; i < n; i++) coords.push([between(rng, -70, 70), between(rng, -70, 70)]);
      const line: GeoGeom = { type: 'LineString', coordinates: coords };
      const clipped = clipGeometry(line, clip);
      const rest = differenceGeometry(line, clip);
      const inside = geomLineLength(clipped);
      const outside = geomLineLength(rest);
      const total = polylineLength(coords);
      const eps = Math.max(total * 1e-6, 1e-9);
      if (Math.abs(inside + outside - total) > eps) {
        throw new Error(`seed ${seed}: line length not conserved — clip ${inside} + diff ${outside} != ${total}`);
      }
      // And every piece landed on the right side: clip output strictly inside,
      // difference output strictly outside (boundary vertices skipped — which
      // side of a boundary a node belongs to is a convention, not a fact).
      const guard = Math.max(overlayTolerance([line, clip]) * 50, 1e-6);
      const seqsOf = (g: GeoGeom | null): Coord[][] => {
        if (!g) return [];
        if (g.type === 'LineString') return [g.coordinates];
        if (g.type === 'MultiLineString') return g.coordinates;
        return [];
      };
      for (const [g, wantInside] of [[clipped, true], [rest, false]] as [GeoGeom | null, boolean][]) {
        for (const seq of seqsOf(g)) {
          for (const c of seq) {
            if (distToBoundaries(c, [clip]) < guard) continue;
            if (refContains(c, clip) !== wantInside) {
              throw new Error(
                `seed ${seed}: a ${wantInside ? 'clipped' : 'difference'} vertex [${c[0].toFixed(6)}, ${c[1].toFixed(6)}] is on the wrong side of the clip polygon`
              );
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Repair (lossless Make Valid) & polygonize
// ---------------------------------------------------------------------------

describe('property: repair is lossless and always yields valid geometry', () => {
  it('a bowtie keeps both lobes and comes back valid', () => {
    const bowtie: GeoGeom = poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]);
    expect(validateGeometry(bowtie).length).toBeGreaterThan(0);
    const fixed = repairGeometry(bowtie);
    expectValidResult(fixed, 'bowtie repair');
    // Two triangles of 25 each — nothing thrown away (the old kernel kept only
    // the largest piece, i.e. 25 of the 50).
    expectAreaClose(area(fixed), 50, 'bowtie repair area');
    expect(repairGeometry(fixed)).not.toBeNull();
    expectAreaClose(area(repairGeometry(fixed)), 50, 'repair idempotence on a bowtie');
  });

  it('repair never loses area on random self-intersecting rings', () => {
    for (const { seed } of scenarios(20, 13000)) {
      const rng = mulberry32(seed);
      // A "random walk" ring: frequently self-intersecting, sometimes not.
      const n = intBetween(rng, 5, 10);
      const ring: Ring = [];
      let x = between(rng, -20, 20);
      let y = between(rng, -20, 20);
      for (let i = 0; i < n; i++) {
        ring.push([x, y]);
        x += between(rng, -25, 25);
        y += between(rng, -25, 25);
      }
      ring.push([ring[0][0], ring[0][1]]);
      const geom = poly([ring]);
      const fixed = repairGeometry(geom);
      expectValidResult(fixed, `seed ${seed} walk repair`);
      // A repair can never cover more ground than the convex hull of the ring's
      // own vertices. The naive bound "|shoelace| of the input" is wrong: on a
      // self-intersecting ring the signed sum cancels opposing lobes, so it can
      // be near zero while the lossless repair keeps every lobe.
      const hull = convexHullArea(ring.slice(0, -1));
      expect(area(fixed)).toBeLessThanOrEqual(hull * (1 + 1e-9) + 1e-9);
      if (validateGeometry(geom).length === 0) {
        expectAreaClose(area(fixed), area(geom), `seed ${seed} valid input unchanged by repair`, 1e-7);
      }
    }
  });

  it('polygonizing the boundaries of disjoint polygons returns those polygons', () => {
    const rings = [rect(0, 0, 10, 10), rect(20, 0, 30, 10), rect(0, 20, 10, 30)];
    const lines: GeoGeom[] = rings.map(r => ({ type: 'LineString' as const, coordinates: r }));
    const faces = polygonizeGeometries(lines);
    expect(faces.length).toBe(3);
    expectAreaClose(faces.reduce((s, f) => s + area(f), 0), 300, 'three 10x10 cells');
    faces.forEach((f, i) => expectValidResult(f, `polygonized face ${i}`));

    // A 2x2 line network: four enclosed faces, one shared-boundary union.
    const grid: GeoGeom[] = [];
    for (let i = 0; i <= 2; i++) {
      grid.push({ type: 'LineString', coordinates: [[i * 10, 0], [i * 10, 20]] });
      grid.push({ type: 'LineString', coordinates: [[0, i * 10], [20, i * 10]] });
    }
    const cells = polygonizeGeometries(grid);
    expect(cells.length).toBe(4);
    expectAreaClose(cells.reduce((s, f) => s + area(f), 0), 400, '2x2 grid of 10x10 cells');
  });
});

// ---------------------------------------------------------------------------
// 7. Degenerate & hostile input must never throw, hang, or emit NaN
// ---------------------------------------------------------------------------

describe('property: degenerate input is refused, not invented', () => {
  const degenerates: [string, GeoGeom][] = [
    ['duplicate points', poly([[[0, 0], [0, 0], [10, 10], [10, 10], [0, 0]]])],
    ['a single point ring', poly([[[5, 5], [5, 5], [5, 5], [5, 5]]])],
    ['zero-area sliver', poly([[[0, 0], [10, 0], [20, 0], [0, 0]]])],
    ['unclosed ring', poly([[[0, 0], [10, 0], [10, 10], [0, 10]]])],
    ['NaN coordinate', poly([[[0, 0], [NaN, 0], [10, 10], [0, 0]]])],
    ['empty polygon', { type: 'Polygon', coordinates: [] }],
    ['empty multipolygon', { type: 'MultiPolygon', coordinates: [] }],
  ];

  it.each(degenerates)('survives %s without throwing or emitting NaN', (_label, geom) => {
    const other = poly([rect(-5, -5, 15, 15)]);
    const results = [
      unionGeometries([geom, other]),
      intersectGeometries(geom, other),
      differenceGeometries(geom, other),
      differenceGeometries(other, geom),
      symDifferenceGeometries(geom, other),
      repairGeometry(geom),
      unionMany([geom]),
      clipGeometry(geom, other),
    ];
    for (const r of results) {
      if (r === null) continue;
      for (const c of allRings(r).flat()) {
        expect(Number.isFinite(c[0])).toBe(true);
        expect(Number.isFinite(c[1])).toBe(true);
      }
      expect(area(r)).not.toBeNaN();
    }
    // The NaN input must be *reported*, never silently repaired into a shape.
    if (_label === 'NaN coordinate') {
      expect(validateGeometry(geom).map(e => e.code)).toContain('nan-coordinate');
    }
  });

  it('reports the GEOS validity classes on invalid input', () => {
    const holeOutside: GeoGeom = poly([rect(0, 0, 10, 10), rect(50, 50, 60, 60).slice().reverse()]);
    expect(validateGeometry(holeOutside).map(e => e.code)).toContain('hole-outside-shell');
    const overlappingParts: GeoGeom = multipoly([[rect(0, 0, 10, 10)], [rect(5, 5, 15, 15)]]);
    expect(validateGeometry(overlappingParts).map(e => e.code)).toContain('overlapping-parts');
    // A hole touching its shell at exactly one point disconnects the interior —
    // GEOS's "Disconnected Interior". The kite's apex IS the diamond's apex and
    // the rest of it is strictly inside.
    const diamond: Ring = [[0, 10], [10, 0], [0, -10], [-10, 0], [0, 10]];
    const kite: Coord[] = [[0, 10], [-1, 8], [0, 6], [1, 8], [0, 10]];
    const touchingHole: Ring = kite.reverse();
    expect(validateGeometry(poly([diamond, touchingHole])).map(e => e.code)).toContain('disconnected-interior');
  });

  it('agrees with the OGC that parts touching at a POINT are valid', () => {
    // Two MultiPolygon parts meeting at a single point are simple under the OGC
    // definition: parts may not share interior, and boundaries may meet at a
    // finite number of points. GEOS/QGIS/PostGIS all call this valid, so Check
    // Validity must too — flagging it would be noise on ordinary data (two
    // parcels meeting at a corner), and Make Valid's two-lobed bowtie would come
    // back out of the tool "invalid".
    expect(validateGeometry(multipoly([[rect(0, 0, 10, 10)], [rect(10, 10, 20, 20)]]))).toEqual([]);
  });

  it('flags parts that share a whole EDGE, which the OGC does not allow', () => {
    // OGC Simple Features: the boundaries of two MultiPolygon parts may
    // intersect "only at a finite number of points". A shared edge is infinitely
    // many, so this is reported — as a self-intersection of the boundary, at the
    // shared segment. It is also why ST_Union/Dissolve MERGE adjacent polygons
    // into one part instead of leaving a MultiPolygon with a shared edge: our
    // own Union does the same, asserted below.
    const errs = validateGeometry(multipoly([[rect(0, 0, 10, 10)], [rect(10, 0, 20, 10)]]));
    expect(errs.map(e => e.code)).toContain('self-intersection');
  });

  it('merges edge-sharing parcels into ONE part instead of reporting itself invalid', () => {
    // The corollary of the test above, and a QGIS/PostGIS parity check: unioning
    // adjacent polygons must not produce a MultiPolygon whose parts share an
    // edge, because that output would fail our own Check Validity.
    const a = poly([rect(0, 0, 10, 10)]);
    const b = poly([rect(10, 0, 20, 10)]);
    const merged = unionGeometries([a, b]);
    expect(geometryParts(merged).length).toBe(1);
    expectAreaClose(area(merged), 200, 'two 10x10 squares sharing an edge');
    expectValidResult(merged, 'edge-sharing union');
    // Corner-touching parts stay two parts: they are not one region, and two
    // parts meeting at a point are valid, so there is nothing to merge.
    const corner = unionGeometries([a, poly([rect(10, 10, 20, 20)])]);
    expect(geometryParts(corner).length).toBe(2);
    expectAreaClose(area(corner), 200, 'two 10x10 squares touching at a corner');
    expectValidResult(corner, 'corner-touching union');
  });

  it('every generated scenario is valid input', () => {
    for (const { seed, geoms } of scenarios(6, 14000)) {
      geoms.forEach((g, i) => {
        const errs = validateGeometry(g);
        expect(errs.map(e => e.code), `seed ${seed} geometry ${i} should be valid`).toEqual([]);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Scale: the same answer at EPSG:3857 magnitudes as in a local frame
// ---------------------------------------------------------------------------

describe('property: translation onto real EPSG:3857 magnitudes changes nothing', () => {
  const DX = 15_000_000; // ~longitude 135°E in Web Mercator
  const DY = -4_000_000; // ~latitude -34°S (Adelaide)

  it.each(scenarios(12, 15000))('areas match the local frame ($kind, seed $seed)', ({ seed, geoms }) => {
    const moved = geoms.map(g => translate(g, DX, DY));
    const ctx = `seed ${seed}`;
    // Relative comparison: the magnitudes differ by 12 orders, so absolute
    // deltas are meaningless here.
    const pairs: [string, GeoGeom | null, GeoGeom | null][] = [
      ['union', unionGeometries(geoms), unionGeometries(moved)],
      ['intersection', intersectGeometries(geoms[0], geoms[1]), intersectGeometries(moved[0], moved[1])],
      ['difference', differenceGeometries(geoms[0], geoms[1]), differenceGeometries(moved[0], moved[1])],
      ['symDifference', symDifferenceGeometries(geoms[0], geoms[1]), symDifferenceGeometries(moved[0], moved[1])],
    ];
    for (const [op, local, mercator] of pairs) {
      // Each frame measured about its own origin — see areaRel().
      const la = areaRel(local);
      const ma = areaRel(mercator, [DX, DY]);
      const rel = Math.abs(ma - la) / Math.max(1, Math.abs(la));
      if (rel > 1e-7) throw new Error(`${ctx} ${op}: area drifted by ${rel * 100}% when translated to EPSG:3857`);
      expectValidResult(mercator, `${ctx} ${op} at EPSG:3857`);
    }
  });
});

describe('property: the tolerance model', () => {
  it('is translation invariant — it tracks the extent SPAN, not the magnitude', () => {
    // A common misreading is "ordinates are 1.5e7, so the tolerance must be
    // huge". It is the extent span that sets the tolerance: moving a 100 m
    // parcel layer to Adelaide's Web Mercator coordinates does not change how
    // close its own vertices are to each other.
    for (const { geoms } of scenarios(6, 19000)) {
      const moved = geoms.map(g => translate(g, 15_000_000, -4_000_000));
      expect(overlayTolerance(moved)).toBe(overlayTolerance(geoms));
    }
  });

  it('grows linearly with the data span once the span beats the floor', () => {
    // tolerance = max(1e-6 floor, 1e-11 x extent span). A 100 m parcel layer
    // sits ON the floor (1e-11 x 100 = 1e-9), so scaling it x1000 changes
    // nothing — the honest test is between two spans that both clear it.
    const small = poly([rect(0, 0, 10, 10)]);
    expect(overlayTolerance([small])).toBe(1e-6); // the floor dominates
    const km = poly([rect(0, 0, 1e6, 1e6)]);      // 1 000 km      -> 1e-5
    const global = poly([rect(0, 0, 1e9, 1e9)]);  // 1 000 000 km  -> 1e-2
    expect(overlayTolerance([km])).toBeCloseTo(1e-5, 15);
    expect(overlayTolerance([global])).toBeCloseTo(1e-2, 12);
    expect(overlayTolerance([global]) / overlayTolerance([km])).toBeCloseTo(1000, 6);
    expect(geometryParts(scale(small, 1e5)).length).toBe(1); // scale() is exercised
  });

  it('gives the same verdict wherever on Earth the geometry sits', () => {
    // Regression: `segmentContact` used a dimensionless 1e-14 relative epsilon
    // to decide "parallel", so at EPSG:3857 magnitudes the cancellation error in
    // `den` (~1e-7) swamped the threshold (~1e-10) and exactly-collinear edges
    // read as barely-crossing. One ring — bit for bit identical — validated
    // clean at the origin and as self-intersecting at (1.5e7, -4e6).
    const DX = 15_000_000;
    const DY = -4_000_000;
    for (const { seed, geoms } of scenarios(10, 21000)) {
      const ops: (GeoGeom | null)[] = [
        geoms[0],
        geoms[1],
        unionGeometries(geoms),
        intersectGeometries(geoms[0], geoms[1]),
        differenceGeometries(geoms[0], geoms[1]),
        symDifferenceGeometries(geoms[0], geoms[1]),
      ];
      ops.forEach((local, i) => {
        const moved = local ? translate(local, DX, DY) : null;
        const localErrors = validateGeometry(local).map(e => e.code);
        const movedErrors = validateGeometry(moved).map(e => e.code);
        expect(movedErrors, `seed ${seed} op ${i}: validity changed under translation`).toEqual(localErrors);
      });
    }
  });

  it('stays far above the double spacing of real EPSG:3857 ordinates', () => {
    // The whole reason the tolerance is scale-derived (AGENTS.md pitfall 17):
    // at |y| ~ 4e6..1.5e7 the gap between representable doubles is ~1e-9..2e-9,
    // so a bare 1e-9 or 1e-12 comparison is below the noise floor of the data.
    const moved = scenario(20002, 'parcels').map(g => translate(g, 15_000_000, -4_000_000));
    const ulp = Math.pow(2, Math.floor(Math.log2(15_000_000)) - 52);
    expect(ulp).toBeGreaterThan(1e-9);
    expect(overlayTolerance(moved)).toBeGreaterThan(ulp * 100);
  });
});

// ---------------------------------------------------------------------------
// 8b. Regressions this property suite found — keep these, they are the receipts
// ---------------------------------------------------------------------------

describe('regression: a hole that encloses an island is nested in the right shell', () => {
  /**
   * A donut whose hole is partly filled by the other operand. The symmetrical
   * difference is a big shell with ONE hole (the union of the donut hole and the
   * part of B inside the shell — an L-shaped ring of area 900) plus a small
   * island (B ∩ hole, area 100) sitting INSIDE that hole.
   *
   * The island is therefore enclosed by the hole ring, and a hole-nesting rule
   * of "smallest shell containing an interior point of the hole" picks the
   * island as the hole's parent: a 900 m² hole nested inside a 100 m² shell.
   * The total AREA still came out exactly right (area is shells-minus-holes
   * summed over parts, so mis-nesting cancels), which is why only the point-set
   * oracle caught it. JTS guards this with `if (tryArea <= testArea) continue`;
   * nestOverlayRings now does too.
   */
  function fixture(): { a: GeoGeom; b: GeoGeom } {
    return {
      a: poly([rect(0, 0, 100, 100), rect(40, 40, 60, 60).slice().reverse()]),
      b: poly([rect(50, 50, 80, 70)]),
    };
  }

  it('nests the 900 m2 hole in the 10 000 m2 shell, not in the 100 m2 island', () => {
    const { a, b } = fixture();
    const sym = symDifferenceGeometries(a, b);
    expectValidResult(sym, 'donut triangle rect');
    const parts = geometryParts(sym);
    expect(parts.length).toBe(2);
    const big = parts.find(p => Math.abs(shoelace(p[0])) > 1000)!;
    const island = parts.find(p => Math.abs(shoelace(p[0])) < 1000)!;
    expect(big.length).toBe(2);   // shell + the one L-shaped hole
    expectAreaClose(Math.abs(shoelace(big[0])), 10000, 'big shell');
    expectAreaClose(Math.abs(shoelace(big[1])), 900, 'hole = donut hole 400 + B 600 - overlap 100');
    expect(island.length).toBe(1); // the island has no holes of its own
    expectAreaClose(Math.abs(shoelace(island[0])), 100, 'island = B intersect hole');
    expectAreaClose(area(sym), 9200, '|A△B| = 9600 + 600 - 2x500');
  });

  it('gets the point set right, which is how the bug was found', () => {
    const { a, b } = fixture();
    const sym = symDifferenceGeometries(a, b)!;
    expect(refContains([55, 55], sym)).toBe(true);   // inside B and inside the hole: only in B
    expect(refContains([45, 45], sym)).toBe(false);  // inside the hole, outside B: in neither
    expect(refContains([10, 10], sym)).toBe(true);   // inside A only
    expect(refContains([70, 60], sym)).toBe(false);  // inside A and inside B: in neither
    expect(refContains([150, 150], sym)).toBe(false);
  });

  it('never nests a hole into a shell smaller than itself, on any scenario', () => {
    for (const { seed, geoms } of scenarios(12, 22000)) {
      const results = [
        unionGeometries(geoms),
        intersectGeometries(geoms[0], geoms[1]),
        differenceGeometries(geoms[0], geoms[1]),
        symDifferenceGeometries(geoms[0], geoms[1]),
        repairGeometry(geoms[0]),
      ];
      results.forEach((r, i) => {
        for (const part of geometryParts(r)) {
          if (part.length < 2) continue;
          const shellArea = Math.abs(shoelace(part[0]));
          part.slice(1).forEach((h, j) => {
            const holeArea = Math.abs(shoelace(h));
            if (holeArea > shellArea) {
              throw new Error(
                `seed ${seed} result ${i}: part ${j + 1} has a ${holeArea} hole inside a ${shellArea} shell`
              );
            }
          });
        }
      });
    }
  });
});

describe('regression: non-finite input is refused, never half-processed', () => {
  const nanPoly: GeoGeom = poly([[[0, 0], [NaN, 0], [10, 10], [0, 10], [0, 0]]]);
  const infPoly: GeoGeom = poly([[[0, 0], [Infinity, 0], [10, 10], [0, 10], [0, 0]]]);
  const good: GeoGeom = poly([rect(-5, -5, 15, 15)]);

  it('every overlay entry point returns null rather than emitting NaN vertices', () => {
    expect(hasFiniteCoordinates(good)).toBe(true);
    expect(hasFiniteCoordinates(nanPoly)).toBe(false);
    for (const bad of [nanPoly, infPoly]) {
      const results: (GeoGeom | null)[] = [
        overlayGeometries([bad, good], 'union'),
        overlayGeometries([bad, good], 'intersection'),
        overlayGeometries([good, bad], 'difference'),
        unionGeometries([bad, good]),
        unionGeometries([bad]),          // the single-subject fast path
        unionMany([bad, good]),
        ...unionComponents([bad, good]), // a singleton component is cloned straight through
        intersectGeometries(bad, good),
        differenceGeometries(bad, good),
        differenceGeometries(good, bad),
        differenceFromMany(good, [bad]),
        symDifferenceGeometries(bad, good),
        repairGeometry(bad),
        clipGeometry(bad, good),
        clipGeometry(good, bad),
        differenceGeometry(bad, good),
        differenceGeometry(good, bad),
      ];
      for (const r of results) {
        expect(r, 'a non-finite operand must refuse the operation').toBeNull();
      }
    }
  });

  it('still tells the user which feature is broken, and where', () => {
    const errs = validateGeometry(nanPoly);
    expect(errs.map(e => e.code)).toContain('nan-coordinate');
    expect(errs.some(e => e.location !== null)).toBe(true);
  });
});

describe('regression: a ring that pinches at a node is split into parts', () => {
  /**
   * A minimal-cycle walk cannot tell "one region" from "two regions meeting at a
   * point". Where the lobes CROSS, noding gives the shared node four distinct
   * edges and the turn rule splits them; where they merely TOUCH the walk goes
   * straight through and returns one figure-eight ring, which is invalid (GEOS
   * "Disconnected Interior"). splitPinchedRing() peels the lobes apart, which is
   * what JTS's polygon builder does at an articulation point.
   *
   * Found by the real-data suite: sample locality NSW778, and the symmetric
   * difference of SA153 with SA210005766, both came back as pinched single rings.
   */
  const pinch: Ring = [[0, 0], [5, 0], [5, 5], [10, 5], [10, 10], [5, 10], [5, 5], [0, 5], [0, 0]];

  it('repairing a pinched ring gives two valid 5x5 parts (GEOS ST_MakeValid parity)', () => {
    const geom = poly([pinch]);
    expect(validateGeometry(geom).map(e => e.code)).toContain('disconnected-interior');
    const fixed = repairGeometry(geom);
    expect(geometryParts(fixed).length).toBe(2);
    expectAreaClose(area(fixed), 50, 'two 5x5 lobes');
    geometryParts(fixed).forEach(part => expectAreaClose(Math.abs(shoelace(part[0])), 25, 'one lobe'));
    expectValidResult(fixed, 'pinch repair');
  });

  it('no overlay result ever repeats a node inside one ring', () => {
    // The general invariant behind the fixture above, over every generator.
    for (const { seed, geoms } of scenarios(12, 23000)) {
      const results: [string, GeoGeom | null][] = [
        ['union', unionGeometries(geoms)],
        ['intersection', intersectGeometries(geoms[0], geoms[1])],
        ['difference', differenceGeometries(geoms[0], geoms[1])],
        ['symDifference', symDifferenceGeometries(geoms[0], geoms[1])],
        ['repair', repairGeometry(geoms[0])],
      ];
      for (const [op, geom] of results) {
        for (const part of geometryParts(geom)) {
          for (const ring of part) {
            const keys = ring.slice(0, -1).map(c => `${c[0]}|${c[1]}`);
            if (new Set(keys).size !== keys.length) {
              throw new Error(`seed ${seed} ${op}: a ring visits one node twice (pinched)`);
            }
          }
        }
      }
    }
  });

  it('splitting preserves signed area exactly', () => {
    // Peeling a lobe off at the pinch node adds no area: the node is shared.
    const before = Math.abs(shoelace(pinch));
    const fixed = repairGeometry(poly([pinch]));
    expectAreaClose(area(fixed), before, 'pinch split is area-preserving');
  });
});

// ---------------------------------------------------------------------------
// 9. Determinism
// ---------------------------------------------------------------------------

describe('property: determinism', () => {
  it.each(scenarios(8, 16000))('the same input twice gives byte-identical output ($kind, seed $seed)', ({ geoms }) => {
    const runs = [0, 1].map(() => JSON.stringify(unionGeometries(geoms)));
    expect(runs[0]).toBe(runs[1]);
    const inter = [0, 1].map(() => JSON.stringify(intersectGeometries(geoms[0], geoms[1])));
    expect(inter[0]).toBe(inter[1]);
  });

  it('does not mutate its inputs', () => {
    for (const { geoms } of scenarios(6, 17000)) {
      const before = geoms.map(g => JSON.stringify(g));
      unionGeometries(geoms);
      intersectGeometries(geoms[0], geoms[1]);
      differenceGeometries(geoms[0], geoms[1]);
      repairGeometry(geoms[0]);
      clipGeometry({ type: 'LineString', coordinates: [[-50, -50], [50, 50]] }, geoms[0]);
      polygonizeGeometries(geoms.map(g => ({ type: 'LineString' as const, coordinates: allRings(g)[0] })));
      expect(geoms.map(g => JSON.stringify(g))).toEqual(before);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. The kernel's own point locator must agree with the independent oracle
// ---------------------------------------------------------------------------

describe('property: pointInGeometry agrees with the independent even-odd oracle', () => {
  it('matches on 2000 random points per scenario', () => {
    for (const { seed, geoms } of scenarios(10, 18000)) {
      const rng = mulberry32(seed ^ 0xabc);
      const tol = overlayTolerance(geoms);
      const guard = Math.max(tol * 50, 1e-6);
      let tested = 0;
      for (let i = 0; i < 2000; i++) {
        const p: Coord = [between(rng, -90, 90), between(rng, -90, 90)];
        if (distToBoundaries(p, geoms) < guard) continue;
        tested++;
        for (const g of geoms) {
          if (pointInGeometry(p, g) !== refContains(p, g)) {
            throw new Error(`seed ${seed}: pointInGeometry disagrees with the oracle at ${JSON.stringify(p)}`);
          }
        }
      }
      expect(tested).toBeGreaterThan(1500);
    }
  });
});
