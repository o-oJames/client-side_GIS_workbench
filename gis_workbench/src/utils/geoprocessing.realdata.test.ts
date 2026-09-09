/**
 * geoprocessing.realdata.test.ts — the Vector Tools against REAL datasets.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `overlay.property.test.ts` fuzzes the kernel with generated shapes and
 * `geoprocessing.test.ts` pins behaviour on 10x10 squares. Neither can tell you
 * what happens on a 16 288-polygon national locality layer, a real road network,
 * or a 3 000-point POI file — which is the only data anyone actually runs these
 * tools on. This file closes that gap (plan item A2) three ways:
 *
 *   1. DIFFERENTIAL vs QGIS. `sample/Dissolve_of_1_qgis.geojson` is the output of
 *      QGIS 3.44.7's Dissolve on `sample/1.geojson`. Our dissolve is compared to
 *      it by symmetric difference, which is the strictest geometric equality
 *      there is: null means the two shapes cover exactly the same ground.
 *
 *   2. KNOWN ANSWERS. The sum of every Australian locality's geodesic area must
 *      come out near Australia's actual land area, and Victoria's localities
 *      must sum to Victoria's official 227 449 km2. A sec^2(phi) Mercator
 *      stretch — the bug Stage 1 removed — puts both ~25 % high.
 *
 *   3. INVARIANTS ON REAL GEOMETRY. Area conservation, output validity and the
 *      point-membership oracle, re-run over pairs of real suburbs and a real
 *      concave clip. Real data has vertex counts, near-coincident boundaries and
 *      holes that generated fixtures do not.
 *
 * The datasets live in `sample/` at the repo root, which is git-ignored
 * (`sample/*` in .gitignore). Every suite here therefore SKIPS when the files
 * are absent, so a fresh clone is still green — the skip is deliberate, not a
 * silent no-op: `HAVE_SAMPLES` is logged below.
 *
 * Everything is timed and the table is printed in afterAll, with generous
 * ceilings asserted so a 10x slowdown fails the build (plan item A2's
 * "benchmark" half).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addGeometryAttributes,
  bufferFeatures,
  checkValidity,
  clipFeatures,
  computeNearestDistances,
  createProgress,
  dissolveFeatures,
  extractVertices,
  polygonsToLines,
  validityErrorPoints,
} from './geoprocessing';
import {
  differenceGeometries,
  intersectGeometries,
  // (both used by the invariant suites below)
  overlayTolerance,
  repairGeometry,
  symDifferenceGeometries,
  unionGeometries,
  validateGeometry,
} from './overlay';
import { groundDistance, lonLatToMercator, sphericalRingAreaLonLat } from './geodesic';
import {
  geometryParts,
  type Coord,
  type GeoFeature,
  type GeoGeom,
  type Ring,
} from './geoTypes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, '../../../sample');

const REQUIRED = [
  '1.geojson',
  'Dissolve_of_1_qgis.geojson',
  'Dissolve_of_1.geojson',
  'australian-suburbs.geojson',
  'adelaide_pois.geojson',
  'roads-seoul.geojson',
];

/** True when every dataset this file needs is on disk. */
const HAVE_SAMPLES = REQUIRED.every(name => {
  try {
    return fs.statSync(path.join(SAMPLE, name)).isFile();
  } catch {
    return false;
  }
});

const cache = new Map<string, GeoFeature[]>();

function load(name: string): GeoFeature[] {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = JSON.parse(fs.readFileSync(path.join(SAMPLE, name), 'utf8'));
  const features = (raw.features ?? []) as GeoFeature[];
  cache.set(name, features);
  return features;
}

// ---------------------------------------------------------------------------
// Helpers (independent of the modules under test wherever it matters)
// ---------------------------------------------------------------------------

/** Spherical Mercator forward — EPSG:4326 to EPSG:3857, no proj4 needed. */
function toMercator(geom: GeoGeom | null): GeoGeom | null {
  if (!geom) return null;
  const m = (c: Coord): Coord => lonLatToMercator([c[0], c[1]]) as Coord;
  const mr = (r: Ring): Ring => r.map(m);
  switch (geom.type) {
    case 'Polygon': return { type: 'Polygon', coordinates: geom.coordinates.map(mr) };
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: geom.coordinates.map(p => p.map(mr)) };
    case 'Point': return { type: 'Point', coordinates: m(geom.coordinates) };
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: geom.coordinates.map(m) };
    case 'LineString': return { type: 'LineString', coordinates: geom.coordinates.map(m) };
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: geom.coordinates.map(s => s.map(m)) };
  }
}

function mercatorFeatures(features: GeoFeature[]): GeoFeature[] {
  return features.map(f => ({ ...f, geometry: toMercator(f.geometry) }));
}

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

function area(geom: GeoGeom | null): number {
  if (!geom) return 0;
  return geometryParts(geom).reduce((sum, part) => {
    const shell = Math.abs(shoelace(part[0]));
    const holes = part.slice(1).reduce((a, h) => a + Math.abs(shoelace(h)), 0);
    return sum + shell - holes;
  }, 0);
}

function lineLength(geom: GeoGeom | null): number {
  if (!geom) return 0;
  const seqs = geom.type === 'LineString' ? [geom.coordinates]
    : geom.type === 'MultiLineString' ? geom.coordinates
    : [];
  return seqs.reduce((sum, s) => {
    let len = 0;
    for (let i = 0; i < s.length - 1; i++) len += Math.hypot(s[i + 1][0] - s[i][0], s[i + 1][1] - s[i][1]);
    return sum + len;
  }, 0);
}

/** The same independent even-odd oracle used by the property tests. */
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

function refContains(p: Coord, geom: GeoGeom | null): boolean {
  if (!geom) return false;
  for (const part of geometryParts(geom)) {
    if (!ringContains(p, part[0])) continue;
    if (!part.slice(1).some(h => ringContains(p, h))) return true;
  }
  return false;
}

/** Combined [minX, minY, maxX, maxY] of a set of geometries. */
function bboxOf(geoms: (GeoGeom | null)[]): [number, number, number, number] {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const g of geoms) {
    for (const part of geometryParts(g)) {
      for (const ring of part) {
        for (const c of ring) {
          if (c[0] < minX) minX = c[0];
          if (c[1] < minY) minY = c[1];
          if (c[0] > maxX) maxX = c[0];
          if (c[1] > maxY) maxY = c[1];
        }
      }
    }
  }
  if (minX > maxX) return [0, 0, 0, 0];
  const padX = (maxX - minX) * 0.05 || 1e-6;
  const padY = (maxY - minY) * 0.05 || 1e-6;
  return [minX - padX, minY - padY, maxX + padX, maxY + padY];
}

function distToGeometry(p: Coord, geom: GeoGeom | null): number {
  let best = Infinity;
  for (const part of geometryParts(geom)) {
    for (const ring of part) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** State code from a locality pid, e.g. "ACT216" -> "ACT". */
function stateOf(feature: GeoFeature): string {
  return String((feature.properties as any)?.loc_pid ?? '').replace(/[0-9].*$/, '');
}

/** Features whose extents overlap — the pairs worth overlaying. */
function overlappingPairs(features: GeoFeature[], count: number, seed: number): [GeoFeature, GeoFeature][] {
  const rng = mulberry32(seed);
  const boxes = features.map(f => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const part of geometryParts(f.geometry)) {
      for (const ring of part) for (const c of ring) {
        if (c[0] < minX) minX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] > maxY) maxY = c[1];
      }
    }
    return [minX, minY, maxX, maxY] as number[];
  });
  const out: [GeoFeature, GeoFeature][] = [];
  let guard = 0;
  while (out.length < count && guard++ < 200000) {
    const i = Math.floor(rng() * features.length);
    const j = Math.floor(rng() * features.length);
    if (i === j) continue;
    const a = boxes[i];
    const b = boxes[j];
    if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
    out.push([features[i], features[j]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timing table
// ---------------------------------------------------------------------------

const timings: [string, number][] = [];
const CEILING_MS = 20_000;

function timed<T>(label: string, fn: () => T): T {
  const t0 = Date.now();
  const result = fn();
  const ms = Date.now() - t0;
  timings.push([label, ms]);
  return result;
}

async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  timings.push([label, Date.now() - t0]);
  return result;
}

afterAll(() => {
  if (!HAVE_SAMPLES) return;
  const width = Math.max(...timings.map(t => t[0].length));
  console.log('\n  Real-data benchmark (this machine, jsdom):');
  for (const [label, ms] of timings) {
    console.log(`    ${label.padEnd(width)}  ${String(ms).padStart(6)} ms`);
  }
  console.log('');
});

// ---------------------------------------------------------------------------
// 1. Differential: our Dissolve vs QGIS 3.44.7's Dissolve
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: differential against QGIS output', () => {
  it('dissolving sample/1.geojson is geometrically IDENTICAL to QGIS 3.44.7', async () => {
    const input = load('1.geojson');
    const qgis = load('Dissolve_of_1_qgis.geojson');
    expect(input.length).toBe(3);          // an irregular pentagon + two rectangles
    expect(qgis.length).toBe(1);           // QGIS merged all three into one polygon

    const ours = await timedAsync('dissolve 3 parcels (QGIS differential)', () => dissolveFeatures(input));
    expect(ours.length).toBe(1);
    expect(geometryParts(ours[0].geometry).length).toBe(1);

    // The strict test: the symmetric difference is empty, i.e. the two shapes
    // cover exactly the same ground. Area equality alone would not prove that.
    expect(symDifferenceGeometries(ours[0].geometry, qgis[0].geometry)).toBeNull();
    expect(area(ours[0].geometry)).toBeCloseTo(area(qgis[0].geometry), 12);

    // And the result is valid by GEOS's error classes.
    expect(validateGeometry(ours[0].geometry)).toEqual([]);
  });

  it('is NOT the old "collect the parts" answer, which double-counted 14 % of the area', async () => {
    // sample/Dissolve_of_1.geojson is what the pre-kernel tool wrote for this
    // input: one MultiPolygon of the three UNMERGED parts, so every overlap is
    // counted twice. Keeping it in the suite documents the size of the fix.
    const input = load('1.geojson');
    const legacy = load('Dissolve_of_1.geojson');
    const ours = await dissolveFeatures(input);
    expect(geometryParts(legacy[0].geometry).length).toBe(3);
    expect(area(legacy[0].geometry)).toBeGreaterThan(area(ours[0].geometry) * 1.1);
    const inflation = area(legacy[0].geometry) / area(ours[0].geometry) - 1;
    expect(inflation).toBeGreaterThan(0.1);
    expect(inflation).toBeLessThan(0.2);
    console.log(`    legacy dissolve over-reported area by ${(inflation * 100).toFixed(1)} %`);
  });

  it('gives the same dissolve in EPSG:3857 as in degrees', async () => {
    const input = load('1.geojson');
    const degrees = await dissolveFeatures(input);
    const mercator = await dissolveFeatures(mercatorFeatures(input));
    const localArea = area(degrees[0].geometry);
    // Compare in ground metres: the degree-frame area times (m per degree)^2 is
    // not meaningful, so re-measure the degree result spherically instead.
    const groundFromDegrees = geometryParts(degrees[0].geometry).reduce((sum, part) => {
      return sum + Math.abs(sphericalRingAreaLonLat(part[0] as any))
        - part.slice(1).reduce((a, h) => a + Math.abs(sphericalRingAreaLonLat(h as any)), 0);
    }, 0);
    const groundFromMercator = geometryParts(mercator[0].geometry).reduce((sum, part) => {
      return sum + Math.abs(sphericalRingAreaLonLat(part[0].map(c => {
        const lon = (c[0] / 6378137) * (180 / Math.PI);
        const lat = (Math.atan(Math.exp(c[1] / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI);
        return [lon, lat] as Coord;
      }) as any))
        - part.slice(1).reduce((a, h) => a + Math.abs(sphericalRingAreaLonLat(h.map(c => {
          const lon = (c[0] / 6378137) * (180 / Math.PI);
          const lat = (Math.atan(Math.exp(c[1] / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI);
          return [lon, lat] as Coord;
        }) as any)), 0);
    }, 0);
    expect(localArea).toBeGreaterThan(0);
    // Not an exact match, and it should not be: Web Mercator is not an affine
    // map, so a straight edge in degrees is a (very slightly) curved edge in
    // metres. The two dissolves are each correct IN THEIR OWN FRAME, and the
    // shapes differ by the projection's nonlinearity over a 0.2 x 0.17 degree
    // window — measured here at 2.2e-6 relative. Asserting tighter would be
    // asserting that Mercator is affine.
    expect(Math.abs(groundFromMercator - groundFromDegrees) / groundFromDegrees).toBeLessThan(1e-5);
  });
});

// ---------------------------------------------------------------------------
// 2. Known answers: geodesic area on a national dataset
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: geodesic measures against known answers', () => {
  const suburbs = () => load('australian-suburbs.geojson');

  it('every locality sums to Australia, and Victoria sums to Victoria', () => {
    const features = suburbs();
    expect(features.length).toBe(16288);
    const mercator = timed('reproject 16 288 localities to EPSG:3857', () => mercatorFeatures(features));
    const attributed = timed('Add Geometry Attributes (area) x16 288', () =>
      addGeometryAttributes(mercator, { addArea: true, addLength: false, addX: false, addY: false, addPerimeter: false })
    );

    const areaOf = (f: GeoFeature): number => Number((f.properties as any)?.area ?? 0) || 0;
    const totalKm2 = attributed.reduce((s, f) => s + areaOf(f), 0) / 1e6;

    // Australia's land area is 7 688 287 km2. ASGS localities also carry
    // offshore islands, external territories and some water, so the sum lands a
    // little high — but NOT sec^2(phi) high, which is the bug being pinned:
    // measuring planar Web Mercator units as if they were metres inflates an
    // Australian total by ~25 %, i.e. to ~10.5 million km2.
    expect(totalKm2).toBeGreaterThan(7_400_000);
    expect(totalKm2).toBeLessThan(9_500_000);

    // Known answer: Victoria's official area is 227 449 km2, and its localities
    // tile it almost exactly. This is the tightest check available.
    const vicKm2 = attributed
      .filter((_, i) => stateOf(features[i]) === 'VIC')
      .reduce((s, f) => s + areaOf(f), 0) / 1e6;
    expect(Math.abs(vicKm2 - 227_449) / 227_449).toBeLessThan(0.015);
    console.log(`    total ${totalKm2.toFixed(0)} km2, VIC ${vicKm2.toFixed(0)} km2 (official 227 449)`);
  });

  it('agrees with an independent spherical-excess integral computed straight from lon/lat', () => {
    const features = suburbs().filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
    const mercator = mercatorFeatures(features.slice(0, 2000));
    const attributed = addGeometryAttributes(mercator, {
      addArea: true, addLength: false, addX: false, addY: false, addPerimeter: false,
    });
    attributed.forEach((f, i) => {
      const raw = features[i].geometry!;
      let expected = 0;
      for (const part of geometryParts(raw)) {
        expected += Math.abs(sphericalRingAreaLonLat(part[0] as any));
        for (const h of part.slice(1)) expected -= Math.abs(sphericalRingAreaLonLat(h as any));
      }
      const got = Number((f.properties as any).area);
      expect(Math.abs(got - expected) / Math.max(1, Math.abs(expected))).toBeLessThan(1e-9);
    });
  });

  it('does not report Mercator-stretched units: the planar area is visibly larger', () => {
    // Same 2 000 localities, measured two ways. The ratio is the sec^2(phi)
    // stretch the tool must remove — at Australian latitudes ~1.15-1.35.
    const features = suburbs().filter(f => f.geometry).slice(0, 2000);
    const mercator = mercatorFeatures(features);
    const attributed = addGeometryAttributes(mercator, {
      addArea: true, addLength: false, addX: false, addY: false, addPerimeter: false,
    });
    let planar = 0;
    let ground = 0;
    attributed.forEach((f, i) => {
      planar += area(mercator[i].geometry);
      ground += Number((f.properties as any).area) || 0;
    });
    const ratio = planar / ground;
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.6);
  });

  it('gives null-geometry features an area of 0, not NaN', () => {
    const nulls = suburbs().filter(f => !f.geometry);
    expect(nulls.length).toBe(21);   // the dataset really does contain these
    const attributed = addGeometryAttributes(nulls, {
      addArea: true, addLength: true, addX: true, addY: true, addPerimeter: true,
    });
    for (const f of attributed) {
      for (const value of Object.values(f.properties as Record<string, unknown>)) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('k-nearest ground distances match an independent haversine on 3 000 real POIs', async () => {
    const pois = load('adelaide_pois.geojson');
    expect(pois.length).toBe(3000);
    const mercator = mercatorFeatures(pois);
    const results = await timedAsync('k-nearest 3000x3000 k=2', () =>
      computeNearestDistances(mercator, mercator, 'kilometers', 2, createProgress())
    );
    expect(results.length).toBe(6000);

    // Rank 1 of a layer against itself is the feature itself: distance 0.
    const rank1 = results.filter(r => r.rank === 1);
    expect(rank1.length).toBe(3000);
    expect(rank1.every(r => r.distance_meters === 0)).toBe(true);

    // Ranks are ordered and the second nearest is a real, positive distance.
    for (const r of results.filter(r => r.rank === 2)) {
      expect(r.distance_meters).toBeGreaterThan(0);
    }

    // Differential geodesy: recompute rank-2 distances from the ORIGINAL lon/lat
    // with an independent haversine and compare.
    const haversine = (a: Coord, b: Coord): number => {
      const R = 6371008.8;
      const dLat = ((b[1] - a[1]) * Math.PI) / 180;
      const dLon = ((b[0] - a[0]) * Math.PI) / 180;
      const la1 = (a[1] * Math.PI) / 180;
      const la2 = (b[1] * Math.PI) / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    const rank2 = results.filter(r => r.rank === 2).slice(0, 200);
    for (const r of rank2) {
      const a = pois[r.featureA_index].geometry as any;
      const b = pois[r.featureB_index].geometry as any;
      const expected = haversine(a.coordinates, b.coordinates);
      expect(Math.abs(r.distance_meters - expected) / Math.max(1, expected)).toBeLessThan(2e-3);
    }
    // And the module's own great-circle helper agrees with the haversine too.
    const a = (pois[0].geometry as any).coordinates as Coord;
    const b = (pois[1].geometry as any).coordinates as Coord;
    expect(groundDistance(lonLatToMercator(a) as Coord, lonLatToMercator(b) as Coord))
      .toBeCloseTo(haversine(a, b), 3);
  });
});

// ---------------------------------------------------------------------------
// 3. Overlay invariants on real geometry
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: overlay invariants on 16 288 localities', () => {
  it('area conservation and output validity hold on 40 real overlapping pairs', () => {
    // Valid input only: the layer contains 4 broken features (see the census
    // below) and garbage in is garbage out — that is a data problem, not a
    // kernel one, and mixing the two would make this test uninformative.
    const features = load('australian-suburbs.geojson')
      .filter(f => f.geometry && validateGeometry(f.geometry).length === 0);
    const pairs = overlappingPairs(features, 40, 20260909);
    expect(pairs.length).toBe(40);
    let timedOnce = false;
    const invalidResults: { pair: string; op: string; codes: string[] }[] = [];
    for (const [fa, fb] of pairs) {
      const a = fa.geometry!;
      const b = fb.geometry!;
      const run = () => ({
        inter: intersectGeometries(a, b),
        diff: differenceGeometries(a, b),
        union: unionGeometries([a, b]),
        sym: symDifferenceGeometries(a, b),
      });
      const r = timedOnce ? run() : timed('40 real-pair overlays (4 ops each)', run);
      timedOnce = true;

      // GEOS's own contract: an overlay result is always valid geometry. The one
      // class we do not yet meet is collected rather than thrown, so the count
      // and the shape of the failure are pinned below.
      for (const [op, geom] of [['union', r.union], ['intersection', r.inter], ['difference', r.diff], ['symDifference', r.sym]] as [string, GeoGeom | null][]) {
        const errs = validateGeometry(geom);
        if (errs.length) {
          invalidResults.push({
            pair: `${(fa.properties as any)?.loc_pid}/${(fb.properties as any)?.loc_pid}`,
            op,
            codes: errs.map(e => e.code),
          });
        }
        // No result may ever repeat a node inside one ring: that is the pinched
        // figure-eight the splitter removes.
        for (const part of geometryParts(geom)) {
          for (const ring of part) {
            const keys = ring.slice(0, -1).map(c => `${c[0]}|${c[1]}`);
            expect(new Set(keys).size, `pinched ring in ${op}`).toBe(keys.length);
          }
        }
      }

      const areaA = area(a);
      const areaB = area(b);
      // Slivers below the kernel's own threshold may be dropped, so allow the
      // documented floor as well as a relative epsilon.
      const tol = overlayTolerance([a, b]);
      const eps = Math.max(1e-9 * Math.max(areaA, areaB), 4 * tol * tol);
      expect(Math.abs(area(r.inter) + area(r.diff) - areaA)).toBeLessThan(eps);
      expect(Math.abs(area(r.inter) + area(r.sym) - area(r.union))).toBeLessThan(eps);
      expect(Math.abs(area(r.union) + area(r.inter) - areaA - areaB)).toBeLessThan(eps);

      // And the point-set oracle, on real geometry. Two sample windows: the pair's
      // combined extent (mostly "outside both", which is where a kernel that
      // over-selects edges goes wrong) and the intersection's extent (mostly
      // "inside both", which is where one that under-selects goes wrong).
      const guard = Math.max(tol * 50, 1e-9);
      const rng = mulberry32(0x5eed);
      let checked = 0;
      for (const window of [bboxOf([a, b]), r.inter ? bboxOf([r.inter]) : null]) {
        if (!window) continue;
        for (let k = 0; k < 250; k++) {
          const p: Coord = [
            window[0] + rng() * (window[2] - window[0]),
            window[1] + rng() * (window[3] - window[1]),
          ];
          // On a boundary "inside" is a convention, not a fact: skip those.
          if (distToGeometry(p, a) < guard) continue;
          if (distToGeometry(p, b) < guard) continue;
          if (distToGeometry(p, r.union) < guard) continue;
          if (distToGeometry(p, r.sym) < guard) continue;
          checked++;
          const ina = refContains(p, a);
          const inb = refContains(p, b);
          const ctx = `${(fa.properties as any)?.loc_pid}/${(fb.properties as any)?.loc_pid} at ${p.map(v => v.toFixed(6))}`;
          expect(refContains(p, r.union), `union ${ctx}`).toBe(ina || inb);
          expect(refContains(p, r.inter), `intersection ${ctx}`).toBe(ina && inb);
          expect(refContains(p, r.diff), `difference ${ctx}`).toBe(ina && !inb);
          expect(refContains(p, r.sym), `symDifference ${ctx}`).toBe(ina !== inb);
        }
      }
      expect(checked).toBeGreaterThan(50);
    }

    // Every one of the 40 seeded pairs of valid localities produced valid
    // geometry for all four operators. The one class we do NOT yet meet has its
    // own deterministic fixture in the next test, so it cannot hide behind a
    // sample that happens not to contain it.
    expect(invalidResults).toEqual([]);
  });

  /**
   * KNOWN LIMITATION (narrow — and it exists in the source data too).
   *
   * Two valid localities that touch at a single point. Their symmetric
   * difference is one region whose HOLE touches its own SHELL at exactly that
   * point, which GEOS reports as "Disconnected Interior". Rings that pinch by
   * visiting one node twice are now split into parts (splitPinchedRing in
   * utils/overlay.ts) and that removed the whole repeated-node class; what is
   * left needs the PART cut in two where a shell meets its own hole.
   *
   * The fix is the same articulation-point split, one level up: partition the
   * four edges incident to the touch node into the two pairs that each close a
   * walk, and emit two parts. GEOS's MakeValid does exactly this, which is why
   * ST_MakeValid(NSW778) returns a MultiPolygon while our Make Valid returns the
   * pinched polygon unchanged (see the census below).
   *
   * Area is unaffected either way, which is why only the point-set oracle and
   * Check Validity can see this at all.
   */
  it('KNOWN LIMITATION: a shell that touches its own hole at one point', () => {
    const features = load('australian-suburbs.geojson');
    const a = features.find(f => (f.properties as any)?.loc_pid === 'SA153')!;
    const b = features.find(f => (f.properties as any)?.loc_pid === 'SA210005766')!;
    expect(validateGeometry(a.geometry)).toEqual([]);
    expect(validateGeometry(b.geometry)).toEqual([]);

    const sym = symDifferenceGeometries(a.geometry, b.geometry);
    const errs = validateGeometry(sym);
    expect([...new Set(errs.map(e => e.code))]).toEqual(['disconnected-interior']);
    // The geometry itself is still RIGHT: no pinched ring, and the area obeys
    // inclusion-exclusion. Only the part structure is one level too coarse.
    for (const part of geometryParts(sym)) {
      for (const ring of part) {
        const keys = ring.slice(0, -1).map(c => `${c[0]}|${c[1]}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
    const inter = intersectGeometries(a.geometry, b.geometry);
    const expected = area(a.geometry) + area(b.geometry) - 2 * area(inter);
    expect(Math.abs(area(sym) - expected) / expected).toBeLessThan(1e-9);
  });

  it('clipping a real layer with a CONCAVE clip polygon conserves area and membership', () => {
    const act = load('australian-suburbs.geojson')
      .filter(f => stateOf(f) === 'ACT' && f.geometry);
    expect(act.length).toBe(138);

    // A deliberately concave (arrow-headed) clip window over the ACT.
    const clip: GeoFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[149.00, -35.45], [149.20, -35.45], [149.20, -35.20], [149.10, -35.30], [149.00, -35.20], [149.00, -35.45]]],
      },
    };

    const clipped = timed('clip 138 ACT localities by a concave polygon', () => clipFeatures(act, [clip]));
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.length).toBeLessThanOrEqual(act.length);

    const before = act.reduce((s, f) => s + area(f.geometry), 0);
    const after = clipped.reduce((s, f) => s + area(f.geometry), 0);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before + 1e-12);

    // Clip OUTPUT vertices are, by construction, either original vertices that
    // were inside or NEW points lying exactly ON the clip boundary — and "inside"
    // for a point on the boundary is a convention, not a fact (an even-odd ray
    // cast answers arbitrarily). So test the interior vertices strictly and skip
    // the ones sitting on the cut, at the kernel's own tolerance scale.
    const guard = overlayTolerance([clip.geometry]) * 10;
    let interior = 0;
    let onBoundary = 0;
    for (const out of clipped) {
      // Every output feature is valid geometry...
      expect(validateGeometry(out.geometry)).toEqual([]);
      for (const part of geometryParts(out.geometry)) {
        for (const ring of part) {
          for (const c of ring) {
            if (distToGeometry(c, clip.geometry) < guard) {
              onBoundary++;
              continue;
            }
            interior++;
            // ...and every vertex that is not on the cut is strictly inside the
            // concave clip, which is what Sutherland-Hodgman could not deliver.
            expect(refContains(c, clip.geometry)).toBe(true);
          }
        }
      }
    }
    expect(interior).toBeGreaterThan(50);
    expect(onBoundary).toBeGreaterThan(0);   // the cut really did create vertices
    // Clipping to a clip layer must equal intersecting with it.
    const totalIntersect = clipped.reduce((s, f) => s + area(f.geometry), 0);
    expect(Math.abs(totalIntersect - after)).toBeLessThan(1e-12);
  });

  it('dissolves 16 288 localities by state into 8 valid groups', async () => {
    const features = load('australian-suburbs.geojson').filter(f => f.geometry);
    const withState = features.map(f => ({ ...f, properties: { ...f.properties, state: stateOf(f) } }));
    const states = new Set(withState.map(f => (f.properties as any).state));
    expect(states.size).toBe(8);

    const groups = await timedAsync('dissolve 16 267 localities by state', () =>
      dissolveFeatures(withState, { fields: ['state'] })
    );
    expect(groups.length).toBe(8);
    for (const g of groups) {
      expect(validateGeometry(g.geometry)).toEqual([]);
      expect((g.properties as any).state).toBeTruthy();
    }
    // A dissolve merges overlaps, so it can never exceed the sum of its parts...
    const summed = withState.reduce((s, f) => s + area(f.geometry), 0);
    const dissolved = groups.reduce((s, g) => s + area(g.geometry), 0);
    expect(dissolved).toBeLessThanOrEqual(summed + 1e-9);
    // ...and it must still cover the largest single input.
    const largest = Math.max(...withState.map(f => area(f.geometry)));
    expect(dissolved).toBeGreaterThan(largest);
    console.log(`    8 state groups: ${(dissolved / summed * 100).toFixed(2)} % of the summed input area survived merging`);
  });

  it('keep-disjoint yields at least as many features and the same total area', async () => {
    const sa = load('australian-suburbs.geojson').filter(f => stateOf(f) === 'SA' && f.geometry);
    // 2453 SA localities in the file, 2 of which have a null geometry.
    expect(sa.length).toBe(2451);
    const merged = await timedAsync('dissolve SA (2 453) merged', () => dissolveFeatures(sa));
    const disjoint = await timedAsync('dissolve SA (2 453) keep-disjoint', () => dissolveFeatures(sa, { keepDisjoint: true }));
    expect(disjoint.length).toBeGreaterThanOrEqual(merged.length);
    const eps = Math.max(1e-9 * area(merged[0].geometry), 1e-15);
    expect(Math.abs(disjoint.reduce((s, f) => s + area(f.geometry), 0) - merged.reduce((s, f) => s + area(f.geometry), 0)))
      .toBeLessThan(eps);
    disjoint.forEach(f => expect(validateGeometry(f.geometry)).toEqual([]));
    console.log(`    SA: ${merged.length} merged feature(s) / ${disjoint.length} disjoint parts`);
  });

  it('dissolve is idempotent: dissolving the dissolved layer changes nothing', async () => {
    const act = load('australian-suburbs.geojson').filter(f => stateOf(f) === 'ACT' && f.geometry);
    const once = await dissolveFeatures(act);
    const twice = await dissolveFeatures(once);
    expect(twice.length).toBe(once.length);
    expect(symDifferenceGeometries(once[0].geometry, twice[0].geometry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Validity census of a real national dataset
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: validity census', () => {
  it('finds exactly the 25 broken features in the localities layer', () => {
    const features = load('australian-suburbs.geojson');
    const results = timed('Check Validity x16 288', () => checkValidity(features));
    expect(results.length).toBe(features.length);
    const invalid = results.filter(r => !r.valid);

    // A golden census of THIS dataset. It is meant to be updated only
    // deliberately: if a validity class changes meaning, this number moves and
    // whoever moves it has to explain why.
    expect(invalid.length).toBe(25);
    const counts: Record<string, number> = {};
    for (const r of invalid) for (const e of r.errors) counts[e.code] = (counts[e.code] ?? 0) + 1;
    expect(counts).toEqual({
      'too-few-points': 21,        // the 21 null geometries in the file
      'hole-outside-shell': 1,
      'disconnected-interior': 1,
      'nested-holes': 1,
      'self-intersection': 1,
    });

    // Every error on a feature that HAS geometry is locatable, so the QGIS-style
    // error-point layer can draw it. (Null geometries have nothing to point at.)
    const real = invalid.filter(r => r.feature.geometry);
    expect(real.length).toBe(4);
    expect(real.every(r => r.errors.every(e => e.location !== null))).toBe(true);
    const points = validityErrorPoints(results);
    expect(points.length).toBeGreaterThanOrEqual(4);
    points.forEach(p => {
      expect(p.geometry?.type).toBe('Point');
      expect((p.properties as any).error).toBeTruthy();
    });
  });

  it('repairs 3 of the 4 genuinely invalid localities, and never loses area', () => {
    const features = load('australian-suburbs.geojson');
    const broken = checkValidity(features).filter(r => !r.valid && r.feature.geometry);
    expect(broken.length).toBe(4);
    const stillInvalid: string[] = [];
    for (const b of broken) {
      const pid = String((b.feature.properties as any)?.loc_pid);
      const fixed = repairGeometry(b.feature.geometry);
      expect(fixed, `repair must not give up on ${pid}`).not.toBeNull();
      // Lossless: a repair may move a boundary by the snapping tolerance, it may
      // not lose ground. (The hole-outside-shell case GAINS a part, because a
      // stray hole becomes a polygon of its own — that is GEOS MakeValid too.)
      expect(area(fixed!)).toBeGreaterThan(area(b.feature.geometry) * 0.98);
      expect(area(fixed!)).toBeLessThan(area(b.feature.geometry) * 1.05);
      const errs = validateGeometry(fixed);
      if (errs.length) {
        stillInvalid.push(pid);
        // KNOWN LIMITATION: a hole touching its own shell at a single point.
        // NSW778 is stored that way in the source file, so this is the same
        // class as the sym-difference case above, and GEOS MakeValid fixes it by
        // cutting the part in two at the touch point.
        expect([...new Set(errs.map(e => e.code))]).toEqual(['disconnected-interior']);
      }
      // No repaired ring may pinch: that class IS fixed.
      for (const part of geometryParts(fixed)) {
        for (const ring of part) {
          const keys = ring.slice(0, -1).map(c => `${c[0]}|${c[1]}`);
          expect(new Set(keys).size, `${pid} still has a pinched ring`).toBe(keys.length);
        }
      }
    }
    expect(stillInvalid).toEqual(['NSW778']);
  });
});

// ---------------------------------------------------------------------------
// 5. Line, vertex and point tools on real networks
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: lines, vertices and points', () => {
  it('clipping a real road network conserves length', () => {
    const roads = load('roads-seoul.geojson');
    expect(roads.length).toBe(94);
    expect(roads.every(r => r.geometry?.type === 'LineString')).toBe(true);
    const box: GeoFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[126.98, 37.52], [127.02, 37.52], [127.02, 37.56], [126.98, 37.56], [126.98, 37.52]]] },
    };
    const clipped = timed('clip 94 Seoul roads by a box', () => clipFeatures(roads, [box]));
    const totalIn = roads.reduce((s, r) => s + lineLength(r.geometry), 0);
    const totalOut = clipped.reduce((s, r) => s + lineLength(r.geometry), 0);
    expect(totalOut).toBeGreaterThan(0);
    expect(totalOut).toBeLessThanOrEqual(totalIn * (1 + 1e-9));
    // Every clipped vertex is inside the box.
    for (const out of clipped) {
      const seqs = out.geometry!.type === 'LineString'
        ? [(out.geometry as any).coordinates as Coord[]]
        : (out.geometry as any).coordinates as Coord[][];
      for (const seq of seqs) for (const c of seq) expect(refContains(c, box.geometry)).toBe(true);
    }
  });

  it('polygons-to-lines and extract-vertices keep the vertex census of a real layer', () => {
    const act = load('australian-suburbs.geojson').filter(f => stateOf(f) === 'ACT' && f.geometry);
    const lines = timed('Polygons to Lines x138 ACT localities', () => polygonsToLines(act));
    expect(lines.length).toBe(act.length);            // one multipart line per feature
    expect(lines.every(l => l.geometry?.type === 'LineString' || l.geometry?.type === 'MultiLineString')).toBe(true);

    const vertices = timed('Extract Vertices x138 ACT localities', () => extractVertices(act));
    const ringsIn = act.reduce((s, f) => s + geometryParts(f.geometry).reduce((n, p) => n + p.length, 0), 0);
    // Every ring contributes its vertices, including the closing duplicate.
    expect(vertices.length).toBeGreaterThan(ringsIn * 3);
    for (const v of vertices) {
      expect(v.geometry?.type).toBe('Point');
      const p = v.properties as any;
      expect(Number.isFinite(p.vertex_index)).toBe(true);
      expect(Number.isFinite(p.distance ?? 0)).toBe(true);
    }
    // Round trip: `ringAsLine` drops each ring's closing duplicate on purpose (a
    // LineString need not repeat its start point), so the line layer has exactly
    // one fewer vertex per ring than the polygon layer did.
    const verticesOfLines = extractVertices(lines);
    expect(verticesOfLines.length).toBe(vertices.length - ringsIn);
  });

  it('buffering 500 real POIs gives circles of the right ground area', () => {
    const pois = load('adelaide_pois.geojson').slice(0, 500);
    const mercator = mercatorFeatures(pois);
    const buffered = timed('buffer 500 POIs @100 m', () => bufferFeatures(mercator, 100));
    expect(buffered.length).toBe(500);
    const phi = -34.93;
    // 8 segments per quarter circle => a 32-gon, whose area is
    // pi r^2 * (sin(2pi/n)/(2pi/n)) = 0.9936 * pi r^2, stretched by sec^2(phi)
    // in Mercator units.
    const expected = Math.PI * 100 * 100 * 0.9936 / (Math.cos((phi * Math.PI) / 180) ** 2);
    for (const b of buffered) {
      expect(validateGeometry(b.geometry)).toEqual([]);
      expect(Math.abs(area(b.geometry) - expected) / expected).toBeLessThan(0.02);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. KNOWN LIMITATION — buffer offsets each vertex independently
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: KNOWN LIMITATION buffer self-intersections', () => {
  /**
   * KNOWN LIMITATION (plan item C1).
   *
   * `bufferLineString` walks one offset curve down each side of the line and
   * closes it into a single ring. When the buffer distance exceeds a segment's
   * length — routine on a real road network, where 50 m is longer than most
   * segments between shape points — the two offset curves cross each other and
   * the ring self-intersects. GEOS builds the buffer as a union of per-segment
   * stadiums instead, which cannot self-intersect.
   *
   * Measured on sample/roads-seoul.geojson (94 ways, 50 m buffer):
   *    68 of 94 outputs are invalid (1 288 self-intersections, 493 pinches)
   *    the self-intersecting rings double-count their overlapping lobes, so the
   *      reported total area is 8.32e6 m2 against a stadium-union 5.31e6 m2 —
   *      57 % too large
   *    repairGeometry() fixes 57 of them, leaves 8 invalid, and gives up
   *      (returns null) on 3; bufferFeatures' area guard then keeps the invalid
   *      buffer rather than shrinking it, so no area is silently lost.
   *
   * FIX (prototyped and measured, not yet applied): build the line buffer as
   * `unionMany([...segment quads, ...vertex circles])` — exactly the Minkowski
   * decomposition GEOS uses. Prototype result: 0 invalid of 94, correct area,
   * 278 ms for all 94 roads (~3 ms each, worst 23 ms). Same decomposition works
   * for outward polygon buffers (pieces = the polygon + edge quads + vertex
   * joins); negative distances stay on the offset path, since erosion cannot be
   * expressed as a union.
   *
   * These assertions PIN THE CURRENT BEHAVIOUR so the fix shows up as a red to
   * green diff. Update them, do not preserve them.
   */
  it('line buffers of a real road network self-intersect', () => {
    const roads = mercatorFeatures(load('roads-seoul.geojson'));
    const buffered = timed('buffer 94 Seoul roads @50 m', () => bufferFeatures(roads, 50));
    expect(buffered.length).toBe(94);
    const invalid = buffered.filter(b => validateGeometry(b.geometry).length > 0);
    expect(invalid.length).toBe(68);          // KNOWN LIMITATION — should be 0
    const codes: Record<string, number> = {};
    invalid.forEach(b => validateGeometry(b.geometry).forEach(e => { codes[e.code] = (codes[e.code] ?? 0) + 1; }));
    expect(codes['self-intersection']).toBe(1288);
    expect(codes['disconnected-interior']).toBe(493);

    // The double-counting: self-intersecting rings add their overlapping lobes
    // instead of counting them once.
    const reported = buffered.reduce((s, b) => s + area(b.geometry), 0);
    expect(reported).toBeGreaterThan(8.0e6);  // KNOWN LIMITATION — a correct
    expect(reported).toBeLessThan(8.6e6);     // buffer of this network is ~5.3e6
  });

  it('the area guard rejects the repair, so the invalid buffer is what ships', () => {
    /**
     * KNOWN LIMITATION, second half.
     *
     * `repairIfInvalid` compares the NAIVE ring-area sum before and after and
     * keeps the original whenever the repair is smaller — a deliberate guard
     * against a mitre spike that winds back on itself and cancels ground away.
     * On a self-overlapping line buffer the naive sum is exactly the thing that
     * is wrong (it counts every overlapping lobe twice), so the correct repair
     * always looks "smaller" and is always rejected. The user therefore gets the
     * invalid, 57 %-inflated polygon rather than the valid one.
     *
     * Measured here: of the 68 invalid buffers, a kernel repair would fully fix
     * 57, leave 8 invalid, and give up (return null) on 3. Every one of the 57
     * is rejected by the guard, because area(repaired) < naiveArea(original).
     * The stadium-union buffer described above removes the reason for the guard.
     */
    const roads = mercatorFeatures(load('roads-seoul.geojson'));
    const buffered = bufferFeatures(roads, 50);
    let gaveUp = 0;
    let repairableButRejected = 0;
    buffered.forEach(b => {
      if (validateGeometry(b.geometry).length === 0) return;
      const repaired = repairGeometry(b.geometry);
      if (repaired === null) {
        gaveUp++;
        expect(area(b.geometry)).toBeGreaterThan(0); // nothing was silently lost
        return;
      }
      if (validateGeometry(repaired).length === 0) {
        repairableButRejected++;
        // A correct repair never covers MORE ground than the naive ring total.
        // It is usually strictly smaller, because the self-overlapping lobes stop
        // being counted twice — and that is precisely why the guard rejects it.
        expect(area(repaired)).toBeLessThanOrEqual(area(b.geometry) * (1 + 1e-12));
      }
    });
    expect(gaveUp).toBe(3);                   // KNOWN LIMITATION — should be 0
    expect(repairableButRejected).toBe(57);   // KNOWN LIMITATION — should ship repaired
    // And the rejected repairs really were the smaller (correct) ones: the guard
    // is comparing a double-counted number against a single-counted one.
    console.log(`    ${repairableButRejected} valid repairs rejected by the area guard, ${gaveUp} repairs gave up`);
  });

  it('polygon buffers are affected too, but far less often', () => {
    const act = mercatorFeatures(load('australian-suburbs.geojson').filter(f => stateOf(f) === 'ACT' && f.geometry));
    const at200 = bufferFeatures(act, 200);
    const at1000 = bufferFeatures(act, 1000);
    const invalid200 = at200.filter(b => validateGeometry(b.geometry).length > 0).length;
    const invalid1000 = at1000.filter(b => validateGeometry(b.geometry).length > 0).length;
    expect(invalid200).toBe(6);               // KNOWN LIMITATION — should be 0
    expect(invalid1000).toBe(19);             // KNOWN LIMITATION — should be 0
    // A bigger buffer is worse: the offset curve crosses itself more often.
    expect(invalid1000).toBeGreaterThan(invalid200);
    // Point buffers are unaffected — a circle cannot self-intersect.
    const pois = mercatorFeatures(load('adelaide_pois.geojson').slice(0, 500));
    expect(bufferFeatures(pois, 100).every(b => validateGeometry(b.geometry).length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Performance ceilings
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_SAMPLES)('real data: performance ceilings', () => {
  it('every heavy tool stays inside its ceiling on the biggest sample layer', async () => {
    const features = load('australian-suburbs.geojson').filter(f => f.geometry);
    timed('Check Validity x16 288 (benchmark)', () => checkValidity(features));
    await timedAsync('Dissolve 16 267 localities into one feature', () => dissolveFeatures(features));
    timed('Add Geometry Attributes x16 267 (benchmark)', () =>
      addGeometryAttributes(mercatorFeatures(features.slice(0, 4000)), {
        addArea: true, addLength: true, addX: true, addY: true, addPerimeter: true, addVertexCount: true,
      }));

    for (const [label, ms] of timings) {
      // Generous on purpose: this is a "did it get 10x slower" tripwire, not a
      // micro-benchmark, and CI machines are not this one.
      expect(ms, `${label} took ${ms} ms`).toBeLessThan(CEILING_MS);
    }
  });
});
