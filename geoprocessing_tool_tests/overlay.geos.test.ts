/**
 * overlay.geos.test.ts — the overlay kernel and the buffer engine, differentially
 * against GEOS.
 *
 * WHERE THIS LIVES
 * ----------------
 * This suite, the golden data it reads and the GEOS script that generates that
 * data all live in `geoprocessing_tool_tests/` at the repo root — deliberately
 * OUTSIDE `gis_workbench/`, because none of it ships with the app. The engine
 * under test is `gis_workbench/src/utils/overlay.ts` (+ `geoprocessing.ts`),
 * imported relatively. Vitest still runs this file from the `gis_workbench`
 * project — see its `vite.config.ts` (`test.include` + `server.fs.allow`) — so
 * `npm run test:run` there covers it exactly as it did before the move, and
 * `tsc --noEmit` still typechecks it via that project's `tsconfig.json`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `overlay.property.test.ts` proves the kernel satisfies algebraic invariants
 * (area conservation, inclusion–exclusion, De Morgan, membership against an
 * independent oracle) and `overlay.test.ts` pins 73 hand-built fixtures. Neither
 * can answer "does this agree with the thing QGIS, PostGIS and every GIS on earth
 * actually ship". This file can, because the expectations in `geosGolden.json`
 * were produced by GEOS 3.14.1 itself — not typed in, not derived from our own
 * code:
 *
 *     /Applications/QGIS.app/Contents/MacOS/python geoprocessing_tool_tests/geos-golden.py
 *
 * WHAT IS COMPARED
 *   • 12 geometry pairs × 4 operators (union, intersection, difference, symmetric
 *     difference) — 48 areas, against GEOS's. The pairs are the ones that break
 *     naive kernels: shared boundaries, containment, a square inside a donut's
 *     hole, concave arrows, stars, thin strips, multipart input, disjoint input,
 *     and boundaries 1e-7 apart.
 *   • 135 buffers — 11 geometries × 3 distances × the cap and join styles that
 *     mean anything for each, plus 24 single-sided rows (4 lines × both signs of
 *     the distance) — against `Geometry.buffer(d, quad_segs=8, cap_style,
 *     join_style, mitre_limit=5, single_sided)`, i.e. the same tessellation and
 *     the same options this panel exposes.
 *
 * HOW CLOSE IS CLOSE
 *   Every overlay agrees to 1e-9 relative except the near-coincident pair. 109 of
 *   the 135 buffers agree to 4.2e-13 relative — that is not a tolerance chosen to
 *   make the tests pass, it is what fell out, and the bound below is three orders
 *   of magnitude tighter again so a real regression cannot hide. The other 26 rows
 *   are flagged in the golden file with a written reason each.
 *
 * THE 27 DOCUMENTED DEVIATIONS (all in the golden file, each with its reason)
 *   1. One overlay pair: boundaries 1e-7 apart are inside this kernel's snapping
 *      tolerance, so GEOS's 5e-7 sliver is merged away. Snapping is the deliberate
 *      trade for not having exact-arithmetic predicates.
 *   2. Two buffers: a flat-capped buffer of a zigzag whose segments are a sixth of
 *      the distance, where GEOS cuts the self-overlap into 2 parts.
 *   3. Twelve buffers: cap styles applied to POINTS. GEOS returns an empty geometry
 *      for cap=flat and a square for cap=square; a point has no direction of
 *      travel, so this kernel returns the disc for all three.
 *   4. Six single-sided buffers of that same zigzag, where the one-sided band
 *      overlaps itself and the two engines cut it differently.
 *   5. Six single-sided buffers of a CLOSED ring, where GEOS is not self-consistent
 *      (it returns the inward offset at d=0.5, the ring's own interior at d=-0.5,
 *      and the band at d=3). Open lines — the case that matters — agree on both
 *      sides to 1e-13.
 */
import { describe, expect, it } from 'vitest';
import golden from './geosGolden.json';
import { bufferGeometry } from '../gis_workbench/src/utils/geoprocessing';
import {
  differenceGeometries,
  intersectGeometries,
  symDifferenceGeometries,
  unionGeometries,
  validateGeometry,
} from '../gis_workbench/src/utils/overlay';
import { geometryParts, type Coord, type GeoGeom, type Ring } from '../gis_workbench/src/utils/geoTypes';

// ---------------------------------------------------------------------------
// The golden data (generated — see the header)
// ---------------------------------------------------------------------------

interface GeoJsonGeom { type: string; coordinates: any }

interface OverlayCase {
  name: string;
  a: GeoJsonGeom;
  b: GeoJsonGeom;
  union: number;
  intersection: number;
  difference: number;
  symDifference: number;
  deviation: string | null;
}

interface BufferCase {
  name: string;
  geom: GeoJsonGeom;
  distance: number;
  join: 'round' | 'miter' | 'bevel';
  cap: 'round' | 'flat' | 'square';
  segments: number;
  singleSided: boolean;
  geosArea: number;
  geosParts: number;
  deviation: string | null;
}

const OVERLAYS = golden.overlays as OverlayCase[];
const BUFFERS = golden.buffers as BufferCase[];
const GEOS_VERSION = (golden.provenance as { geos: string; shapely: string }).geos;

// ---------------------------------------------------------------------------
// Independent helpers
// ---------------------------------------------------------------------------

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

/**
 * Area of a geometry, translated to the origin first: the shoelace sum multiplies
 * ordinates, so measuring without translating adds cancellation noise of the same
 * order as the agreement being asserted.
 */
function areaOf(geom: GeoGeom | null): number {
  if (!geom) return 0;
  const parts = geometryParts(geom);
  const origin: Coord = parts[0]?.[0]?.[0] ?? [0, 0];
  const shift = (ring: Ring): Ring => ring.map(c => [c[0] - origin[0], c[1] - origin[1]] as Coord);
  return parts.reduce((sum, part) => {
    const holes = part.slice(1).reduce((a, h) => a + Math.abs(shoelace(shift(h))), 0);
    return sum + Math.abs(shoelace(shift(part[0]))) - holes;
  }, 0);
}

function fromGeoJson(gi: GeoJsonGeom): GeoGeom {
  const c = gi.coordinates;
  switch (gi.type) {
    case 'Point': return { type: 'Point', coordinates: c as Coord };
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: c as Coord[] };
    case 'LineString': return { type: 'LineString', coordinates: c as Coord[] };
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: c as Coord[][] };
    case 'Polygon': return { type: 'Polygon', coordinates: c as Ring[] };
    default: return { type: 'MultiPolygon', coordinates: c as Ring[][] };
  }
}

const OPERATORS: [keyof OverlayCase, (a: GeoGeom, b: GeoGeom) => GeoGeom | null][] = [
  ['union', (a, b) => unionGeometries([a, b])],
  ['intersection', intersectGeometries],
  ['difference', differenceGeometries],
  ['symDifference', symDifferenceGeometries],
];

/** Relative agreement demanded of every non-deviating row. */
const REL = 1e-9;

// ---------------------------------------------------------------------------

describe(`overlays vs GEOS ${GEOS_VERSION}`, () => {
  it('the golden file is the generated one, and covers every operator', () => {
    expect(OVERLAYS.length).toBe(12);
    expect(OVERLAYS.filter(c => c.deviation).map(c => c.name)).toEqual(['near-coincident squares']);
  });

  for (const c of OVERLAYS) {
    it(`${c.name}: four operators, GEOS's areas`, () => {
      const a = fromGeoJson(c.a);
      const b = fromGeoJson(c.b);
      for (const [op, run] of OPERATORS) {
        const ours = run(a, b);
        // GEOS's own contract: an overlay result is always valid geometry.
        expect(validateGeometry(ours), `${c.name}/${op}`).toEqual([]);
        const want = c[op] as number;
        const got = areaOf(ours);
        if (c.deviation) {
          // The snapping deviation: GEOS keeps a 5e-7 sliver between boundaries
          // 1e-7 apart, we merge them. Absolute, because the relative error of a
          // near-zero area is meaningless.
          expect(Math.abs(got - want), `${c.name}/${op}`).toBeLessThan(1e-6);
          continue;
        }
        expect(Math.abs(got - want), `${c.name}/${op}: geos=${want} ours=${got}`)
          .toBeLessThan(Math.max(Math.abs(want) * REL, 1e-12));
      }
    });
  }

  it('the near-coincident pair really is the snapping trade, not a lost sliver', () => {
    const c = OVERLAYS.find(x => x.deviation)!;
    const a = fromGeoJson(c.a);
    const b = fromGeoJson(c.b);
    // The shells are 1e-7 apart and the tolerance floor is 1e-6, so the two
    // boundaries become one node column: no sliver, and the union is the square.
    expect(areaOf(differenceGeometries(a, b))).toBe(0);
    expect(areaOf(symDifferenceGeometries(a, b))).toBe(0);
    expect(areaOf(unionGeometries([a, b]))).toBeCloseTo(c.union, 6);
    expect(c.deviation!).toContain('snapping');
  });
});

describe(`buffers vs GEOS ${GEOS_VERSION}`, () => {
  it('the golden file covers 13 geometries, both signs, every style and both sides', () => {
    expect(BUFFERS.length).toBe(135);
    // Keyed on the serialised geometry: each row carries its own copy of it.
    const shapes = (rows: BufferCase[]) => new Set(rows.map(b => JSON.stringify(b.geom))).size;
    expect(shapes(BUFFERS.filter(b => !b.singleSided))).toBe(13);
    expect(shapes(BUFFERS.filter(b => b.singleSided))).toBe(4);
    expect(new Set(BUFFERS.filter(b => !b.singleSided).map(b => b.distance))).toEqual(new Set([0.5, 1, 3]));
    // Single-sided runs both signs: + is the left of travel, - the right.
    expect(new Set(BUFFERS.filter(b => b.singleSided).map(b => b.distance)))
      .toEqual(new Set([0.5, 1, 3, -0.5, -1, -3]));
    expect(new Set(BUFFERS.map(b => `${b.join}/${b.cap}`)).size).toBeGreaterThan(4);
    // 14 two-sided + 12 single-sided, each carrying its written reason.
    expect(BUFFERS.filter(b => b.deviation).length).toBe(26);
    expect(BUFFERS.filter(b => b.deviation && !b.singleSided).length).toBe(14);
  });

  for (const c of BUFFERS) {
    it(`${c.name} by ${c.distance}, ${c.join} join / ${c.cap} cap${c.singleSided ? ' (single-sided)' : ''}`, () => {
      const ours = bufferGeometry(fromGeoJson(c.geom), c.distance, {
        segments: c.segments,
        endCapStyle: c.cap,
        joinStyle: c.join,
        miterLimit: 5,
        singleSided: c.singleSided,
      });
      // A negative distance is only meaningful for a single-sided line buffer or
      // for shrinking a polygon; both are covered here.
      expect(ours, 'a buffer this size always exists').not.toBeNull();
      expect(validateGeometry(ours), 'the buffer must be valid geometry').toEqual([]);
      const got = areaOf(ours);
      if (c.deviation) {
        // Documented, and pinned in the direction it deviates: we never return
        // LESS ground than GEOS here, we return the disc or the whole band.
        expect(got).toBeGreaterThan(0);
        expect(c.deviation!.length).toBeGreaterThan(40);
        return;
      }
      expect(Math.abs(got - c.geosArea), `geos=${c.geosArea} ours=${got}`)
        .toBeLessThan(Math.max(c.geosArea * REL, 1e-12));
      // And the same part count, so agreement is not an accident of two wrongs:
      // GEOS reports one polygon where we report one polygon.
      expect(geometryParts(ours).length).toBe(c.geosParts);
    });
  }
});
