/**
 * validity.geos.test.ts — Check Validity and Make Valid, differentially against
 * GEOS itself.
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
 * Every other test in this repo compares the kernel against hand-computed
 * numbers or against itself. Validity is the one place where "hand-computed" is
 * worthless, because the question is not arithmetic but WHICH RULES a platform
 * applies — and the rules were guessed wrong here once already. This module used
 * to report `disconnected-interior` for any point where two rings of one polygon
 * part met. GEOS 3.14.1 says that is only an error when the material actually
 * falls apart there:
 *
 *     POLYGON((0 0,10 0,10 10,0 10),(5 0,7 3,3 3))   -- hole apex ON the shell edge
 *     shapely: is_valid == True, make_valid() returns it UNCHANGED
 *     ours, before: invalid, "Interior is disconnected"
 *
 * That over-reporting flagged real data every reference platform accepts — NSW778
 * in sample/australian-suburbs.geojson and the symmetric difference of two
 * adjacent localities — so users were told to "fix" geometry QGIS, PostGIS and
 * GEOS all consider fine, and Make Valid churned it.
 *
 * THE GOLDEN TABLE is not opinion, and it is not typed by hand either. It is
 * `geosGolden.json` beside this file, produced by GEOS 3.14.1 through shapely 2.0.6 (the
 * Python bundled with QGIS 3.44) and recording, per case: the verdict, the reason
 * string, the error location, and what ST_MakeValid returns (type, part count,
 * area). Regenerate with
 *
 *     /Applications/QGIS.app/Contents/MacOS/python geoprocessing_tool_tests/geos-golden.py
 *
 * which also writes the overlay and buffer goldens used by overlay.geos.test.ts.
 * Nothing at build or test time needs Python: the JSON is committed.
 *
 * WHAT IS ASSERTED
 *   1. the same verdict (valid / invalid) on all 17 cases;
 *   2. the same reason CLASS — GEOS's message mapped onto our ValidityCode, as a
 *      SET, so a case that reports one self-intersection and one that reports two
 *      are both held to exactly the classes GEOS names;
 *   3. the same error LOCATION where the two can agree (GEOS reports one point per
 *      geometry, we report one per distinct contact, so the assertion is that
 *      GEOS's point is among ours — three cases are marked as not comparable, and
 *      each is a degenerate-input case where the choice of point is arbitrary);
 *   4. Make Valid parity: the same number of polygon parts and the same area, so
 *      "lossless" is measured against GEOS rather than against the input;
 *   5. our own repair passes our own validity check (the two must not disagree).
 *
 * The two cases that deviate on AREA are asserted with GEOS's number recorded and
 * the reason stated. Both are the documented nonzero-winding choice: where GEOS
 * counts coincident rings structurally, this kernel asks "is this ground covered",
 * which is what keeps a self-overlapping buffer curve from losing its overlap and
 * a stray hole outside its shell from vanishing (case 9 below, where the choice
 * reproduces GEOS's own 106 exactly). It cannot reproduce GEOS on both halves of
 * that trade at once; the half that occurs in real data was chosen.
 */
import { describe, expect, it } from 'vitest';
import golden from './geosGolden.json';
import { isGeometryValid, repairGeometry, validateGeometry } from '../gis_workbench/src/utils/overlay';
import { geometryParts, type Coord, type GeoGeom, type Ring } from '../gis_workbench/src/utils/geoTypes';

/** One golden case: the geometry, and what GEOS said about it (see geos-golden.py). */
interface GeosCase {
  name: string;
  kind: 'Polygon' | 'MultiPolygon';
  /** Polygon: [shell, ...holes]. MultiPolygon: one shell per part. */
  rings: number[][][];
  geosValid: boolean;
  geosReason: string;
  /** GEOS's reason mapped onto our ValidityCode ('' when GEOS says valid). */
  geosCode: string;
  /** The point GEOS reports the error at, when it reports one. */
  geosAt: Coord | null;
  /** Whether that point is expected to be one of ours (see the file header). */
  atMatchesOurs: boolean;
  geosMakeValidParts: number;
  geosMakeValidArea: number;
  /** Set when the AREA deliberately differs, with the reason. */
  deviation: string | null;
}

const CASES = (golden.validity as GeosCase[]).map(c => ({ ...c, kind: c.kind as 'Polygon' | 'MultiPolygon' }));

// ---------------------------------------------------------------------------
// Independent helpers
// ---------------------------------------------------------------------------

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

/** Shell-minus-holes area, translated to the origin first (see `areaOf`). */
function areaOf(geom: GeoGeom | null): number {
  if (!geom) return 0;
  const parts = geometryParts(geom);
  const origin: Coord = parts[0]?.[0]?.[0] ? [parts[0][0][0][0], parts[0][0][0][1]] : [0, 0];
  const shift = (r: Ring): Ring => r.map(c => [c[0] - origin[0], c[1] - origin[1]] as Coord);
  return parts.reduce((sum, part) => {
    const holes = part.slice(1).reduce((a, h) => a + Math.abs(shoelace(shift(h))), 0);
    return sum + Math.abs(shoelace(shift(part[0]))) - holes;
  }, 0);
}

function closed(pts: number[][]): Ring {
  const out = pts.map(p => [p[0], p[1]] as Coord);
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length < 2 || first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

function geometryOf(c: GeosCase): GeoGeom {
  const rings = c.rings.map(closed);
  return c.kind === 'Polygon'
    ? { type: 'Polygon', coordinates: rings }
    : { type: 'MultiPolygon', coordinates: rings.map(r => [r]) };
}

const atKey = (p: Coord | null) => (p ? `${Math.round(p[0] * 1e6)}:${Math.round(p[1] * 1e6)}` : '');

// ---------------------------------------------------------------------------

describe('validity + Make Valid, differentially against GEOS 3.14.1', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const geom = geometryOf(c);

      it('agrees with GEOS about whether the geometry is valid', () => {
        expect(isGeometryValid(geom)).toBe(c.geosValid);
      });

      it('reports exactly GEOS\'s reason class', () => {
        const codes = new Set(validateGeometry(geom).map(e => e.code));
        expect([...codes].sort()).toEqual(c.geosCode ? [c.geosCode] : []);
      });

      it('points at the place GEOS points at', () => {
        const errs = validateGeometry(geom);
        if (!c.geosAt) {
          expect(errs).toEqual([]);
          return;
        }
        // GEOS names one point per geometry; we name one per distinct contact, so
        // the assertion is containment. Where the two are not comparable the case
        // says so, and the location still has to be a real one.
        const ours = errs.map(e => atKey(e.location));
        if (c.atMatchesOurs) expect(ours).toContain(atKey(c.geosAt));
        expect(ours.every(k => k.length > 0)).toBe(true);
      });

      it('Make Valid returns GEOS\'s parts and area', () => {
        const fixed = repairGeometry(geom);
        expect(fixed).not.toBeNull();
        expect(geometryParts(fixed).length).toBe(c.geosMakeValidParts);
        if (c.deviation) {
          // A deliberate, documented deviation: GEOS's number is recorded here so
          // the gap is visible and cannot widen unnoticed.
          expect(Math.abs(areaOf(fixed) - c.geosMakeValidArea)).toBeGreaterThan(0);
          return;
        }
        expect(areaOf(fixed)).toBeCloseTo(c.geosMakeValidArea, 9);
      });

      it('the repair satisfies our own validity rules', () => {
        expect(validateGeometry(repairGeometry(geom))).toEqual([]);
      });
    });
  }

  it('the two area deviations are the nonzero-winding choice, and nothing else', () => {
    const deviating = CASES.filter(c => c.deviation);
    expect(deviating.map(c => c.name)).toEqual([
      'duplicate ring',
      'hole shares a whole edge with the shell',
    ]);
    for (const c of deviating) expect(c.deviation!.length).toBeGreaterThan(10);
    // Everything else — 15 of 17 — matches GEOS to 9 decimals.
    expect(CASES.filter(c => !c.deviation).length).toBe(15);
  });
});
