/**
 * overlay.test.ts — golden tests for the planar overlay kernel.
 *
 * Every assertion here is a case the Stage-1 kernels got wrong or could not do
 * at all: concave cutters, holes in the overlay layer, a polygon inside another
 * polygon, N-way union, lossless repair of a self-intersecting ring, clipping
 * points and lines, polygonizing a line network, and the GEOS validity classes.
 */
import {
  clipGeometry,
  connectedComponents,
  differenceFromMany,
  differenceGeometries,
  geometriesAdjacent,
  geometryInteriorPoint,
  intersectGeometries,
  isGeometryValid,
  overlayGeometries,
  overlayTolerance,
  pointInGeometry,
  polygonizeGeometries,
  repairGeometry,
  ringInteriorPoint,
  ringSignedArea,
  sharedBoundaryLength,
  symDifferenceGeometries,
  unionComponents,
  unionGeometries,
  unionMany,
  validateGeometry,
} from './overlay';
import { geometryParts, type Coord, type GeoGeom, type Ring } from './geoTypes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Counter-clockwise square, in the standard mathematical sense. */
function square(x0: number, y0: number, x1: number, y1: number): Ring {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

/** The 10x10 square with its top-right 5x5 quadrant removed. */
function lShape(): Ring {
  return [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0]];
}

function poly(rings: Ring[]): GeoGeom {
  return { type: 'Polygon', coordinates: rings };
}

function multipoly(parts: Ring[][]): GeoGeom {
  return { type: 'MultiPolygon', coordinates: parts };
}

function ls(coords: Coord[]): GeoGeom {
  return { type: 'LineString', coordinates: coords };
}

function reversed(ring: Ring): Ring {
  return ring.slice().reverse();
}

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/** Area the geometry actually covers: shells minus holes, over every part. */
function coveredArea(geom: GeoGeom | null): number {
  if (!geom) return 0;
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates;
    return Math.abs(shoelace(rings[0])) - rings.slice(1).reduce((a, h) => a + Math.abs(shoelace(h)), 0);
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((sum, part) => sum + coveredArea({ type: 'Polygon', coordinates: part }), 0);
  }
  return 0;
}

function partCount(geom: GeoGeom | null): number {
  if (!geom) return 0;
  return geom.type === 'MultiPolygon' ? geom.coordinates.length : 1;
}

function holeCount(geom: GeoGeom | null): number {
  if (!geom) return 0;
  if (geom.type === 'Polygon') return geom.coordinates.length - 1;
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((n, p) => n + p.length - 1, 0);
  return 0;
}

/** Distinct vertices, so collinear nodes left behind by nodling are visible. */
function vertexCount(geom: GeoGeom | null): number {
  if (!geom) return 0;
  if (geom.type === 'Polygon') return geom.coordinates.reduce((n, r) => n + r.length - 1, 0);
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + r.length - 1, 0), 0);
  }
  return 0;
}

/** GeoJSON orientation contract: shells CCW, holes CW. */
function orientationIsCanonical(geom: GeoGeom | null): boolean {
  if (!geom) return false;
  const parts = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return parts.every(part => part.every((ring, i) => (i === 0 ? shoelace(ring) > 0 : shoelace(ring) < 0)));
}

const codes = (errs: { code: string }[]): string[] => errs.map(e => e.code);

// ---------------------------------------------------------------------------

describe('ring orientation helpers', () => {
  it('uses the standard mathematical sign: CCW is positive', () => {
    expect(ringSignedArea(square(0, 0, 10, 10))).toBeCloseTo(100, 9);
    expect(ringSignedArea(reversed(square(0, 0, 10, 10)))).toBeCloseTo(-100, 9);
  });

  it('finds an interior point of a concave ring where the vertex average fails', () => {
    const p = ringInteriorPoint(lShape());
    expect(p).not.toBeNull();
    expect(pointInGeometry(p!, poly([lShape()]))).toBe(true);
  });
});

describe('point location', () => {
  it('subtracts holes', () => {
    const donut = poly([square(0, 0, 10, 10), square(3, 3, 7, 7)]);
    expect(pointInGeometry([5, 5], donut)).toBe(false);
    expect(pointInGeometry([1, 1], donut)).toBe(true);
    expect(pointInGeometry([50, 50], donut)).toBe(false);
  });

  it('reports nothing inside for points and lines', () => {
    expect(pointInGeometry([0, 0], { type: 'Point', coordinates: [0, 0] })).toBe(false);
    expect(pointInGeometry([0, 0], null)).toBe(false);
  });
});

describe('union', () => {
  it('merges two edge-adjacent squares into one rectangle of exactly 200', () => {
    const u = unionGeometries([poly([square(0, 0, 10, 10)]), poly([square(10, 0, 20, 10)])]);
    expect(coveredArea(u)).toBeCloseTo(200, 6);
    expect(partCount(u)).toBe(1);
    expect(holeCount(u)).toBe(0);
    // The shared boundary is gone but its two end nodes stay: OverlayNG/GEOS does
    // not re-generalise the ring, so the rectangle reads 6 vertices, not 4.
    expect(vertexCount(u)).toBe(6);
  });

  it('merges overlapping squares without inflating to a convex hull', () => {
    const u = unionGeometries([poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)])]);
    expect(coveredArea(u)).toBeCloseTo(175, 6);
    expect(partCount(u)).toBe(1);
  });

  it('swallows a polygon that lies entirely inside another', () => {
    const u = unionGeometries([poly([square(0, 0, 10, 10)]), poly([square(2, 2, 4, 4)])]);
    expect(coveredArea(u)).toBeCloseTo(100, 6);
    expect(vertexCount(u)).toBe(4);
  });

  it('keeps disjoint polygons as multipolygon parts', () => {
    const u = unionGeometries([poly([square(0, 0, 10, 10)]), poly([square(50, 50, 60, 60)])]);
    expect(coveredArea(u)).toBeCloseTo(200, 6);
    expect(partCount(u)).toBe(2);
  });

  it('unions a whole row of five squares in one pass', () => {
    const geoms = [0, 1, 2, 3, 4].map(i => poly([square(i * 10, 0, i * 10 + 10, 10)]));
    const u = unionGeometries(geoms);
    expect(coveredArea(u)).toBeCloseTo(500, 6);
    expect(partCount(u)).toBe(1);
    // 4 corners + 2 nodes for each of the 4 shared boundaries.
    expect(vertexCount(u)).toBe(12);
  });

  it('preserves a donut unioned with itself', () => {
    const donut = poly([square(0, 0, 10, 10), square(3, 3, 7, 7)]);
    const u = unionGeometries([donut, donut]);
    expect(coveredArea(u)).toBeCloseTo(84, 6);
    expect(holeCount(u)).toBe(1);
  });

  it('closes the hole when a third polygon fills it', () => {
    const u = unionGeometries([
      poly([square(0, 0, 10, 10), square(3, 3, 7, 7)]),
      poly([square(3, 3, 7, 7)]),
    ]);
    expect(coveredArea(u)).toBeCloseTo(100, 6);
    expect(holeCount(u)).toBe(0);
  });

  it('returns a single geometry unchanged and nothing for an empty input', () => {
    expect(coveredArea(unionGeometries([poly([square(0, 0, 10, 10)])]))).toBeCloseTo(100, 6);
    expect(unionGeometries([])).toBeNull();
    expect(unionGeometries([null])).toBeNull();
  });

  it('unions geometries whose boundaries cross four times', () => {
    // |x-5| + |y-5| <= 7 over the 10x10 square: each diamond vertex sticks 2
    // units past one square edge, cutting off a 4x2 triangle (area 4) each.
    const diamond: Ring = [[5, -2], [12, 5], [5, 12], [-2, 5], [5, -2]];
    const i = intersectGeometries(poly([square(0, 0, 10, 10)]), poly([diamond]));
    expect(coveredArea(i)).toBeCloseTo(82, 6);
    const u = unionGeometries([poly([square(0, 0, 10, 10)]), poly([diamond])]);
    expect(coveredArea(u)).toBeCloseTo(116, 6);
    expect(partCount(u)).toBe(1);
  });
});

describe('intersection', () => {
  it('cuts two overlapping squares down to their overlap', () => {
    const i = intersectGeometries(poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)]));
    expect(coveredArea(i)).toBeCloseTo(25, 6);
  });

  it('is exact for a CONCAVE cutter — the Sutherland-Hodgman failure', () => {
    expect(coveredArea(intersectGeometries(poly([square(0, 0, 10, 10)]), poly([lShape()])))).toBeCloseTo(75, 6);
    expect(coveredArea(intersectGeometries(poly([square(2, 2, 8, 8)]), poly([lShape()])))).toBeCloseTo(27, 6);
  });

  it('returns nothing when the layers only touch or are apart', () => {
    expect(intersectGeometries(poly([square(0, 0, 10, 10)]), poly([square(10, 0, 20, 10)]))).toBeNull();
    expect(intersectGeometries(poly([square(0, 0, 10, 10)]), poly([square(50, 50, 60, 60)]))).toBeNull();
  });

  it('keeps the inner polygon when one is inside the other', () => {
    expect(coveredArea(intersectGeometries(poly([square(0, 0, 10, 10)]), poly([square(2, 2, 4, 4)])))).toBeCloseTo(4, 6);
  });

  it('SUBTRACTS a slot in the clip layer from a piece that straddles it', () => {
    // Stage 1 dropped the whole piece instead of splitting it.
    const slotted = poly([square(0, 0, 10, 10), square(4, 0, 6, 10)]);
    const i = intersectGeometries(poly([square(2, 2, 8, 8)]), slotted);
    expect(coveredArea(i)).toBeCloseTo(24, 6);
    expect(partCount(i)).toBe(2);
  });

  it('keeps a hole of the subject inside the result', () => {
    const donut = poly([square(0, 0, 10, 10), square(3, 3, 7, 7)]);
    const i = intersectGeometries(donut, poly([square(-5, -5, 20, 20)]));
    expect(coveredArea(i)).toBeCloseTo(84, 6);
    expect(holeCount(i)).toBe(1);
  });

  it('produces two parts when a multipart cutter splits the subject', () => {
    const cutter = multipoly([[square(2, -5, 4, 20)], [square(6, -5, 8, 20)]]);
    const i = intersectGeometries(poly([square(0, 0, 10, 10)]), cutter);
    expect(coveredArea(i)).toBeCloseTo(40, 6);
    expect(partCount(i)).toBe(2);
  });
});

describe('difference', () => {
  it('bites the overlap out of the subject', () => {
    const d = differenceGeometries(poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)]));
    expect(coveredArea(d)).toBeCloseTo(75, 6);
  });

  it('turns a polygon with an inner polygon removed into a donut', () => {
    const d = differenceGeometries(poly([square(0, 0, 10, 10)]), poly([square(3, 3, 7, 7)]));
    expect(coveredArea(d)).toBeCloseTo(84, 6);
    expect(holeCount(d)).toBe(1);
    expect(orientationIsCanonical(d)).toBe(true);
  });

  it('returns the subject untouched when the other geometry is disjoint or touching', () => {
    expect(coveredArea(differenceGeometries(poly([square(0, 0, 10, 10)]), poly([square(50, 50, 60, 60)])))).toBeCloseTo(100, 6);
    const touching = differenceGeometries(poly([square(0, 0, 10, 10)]), poly([square(10, 0, 20, 10)]));
    expect(coveredArea(touching)).toBeCloseTo(100, 6);
    expect(partCount(touching)).toBe(1);
  });

  it('returns nothing when the subject is entirely covered', () => {
    expect(differenceGeometries(poly([square(2, 2, 4, 4)]), poly([square(0, 0, 10, 10)]))).toBeNull();
  });

  it('subtracts several geometries in one pass', () => {
    const d = differenceFromMany(poly([square(0, 0, 10, 10)]), [
      poly([square(0, 0, 5, 10)]),
      poly([square(5, 0, 10, 5)]),
    ]);
    expect(coveredArea(d)).toBeCloseTo(25, 6);
  });
});

describe('symmetrical difference', () => {
  it('keeps everything except the overlap', () => {
    const s = symDifferenceGeometries(poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)]));
    expect(coveredArea(s)).toBeCloseTo(150, 6);
    expect(partCount(s)).toBe(2);
  });

  it('is empty for identical geometries', () => {
    const a = poly([square(0, 0, 10, 10)]);
    expect(symDifferenceGeometries(a, a)).toBeNull();
  });

  it('falls back to the other geometry when one side is not a polygon', () => {
    expect(coveredArea(symDifferenceGeometries(poly([square(0, 0, 10, 10)]), null))).toBeCloseTo(100, 6);
  });
});

describe('overlay invariants', () => {
  it('never emits an inverted ring: shells CCW, holes CW', () => {
    const d = differenceGeometries(poly([square(0, 0, 10, 10)]), poly([square(3, 3, 7, 7)]));
    expect(orientationIsCanonical(d)).toBe(true);
    const u = unionGeometries([poly([square(0, 0, 10, 10), reversed(square(3, 3, 7, 7))])]);
    expect(orientationIsCanonical(u)).toBe(true);
    expect(coveredArea(u)).toBeCloseTo(84, 6);
  });

  it('accepts rings written in either orientation', () => {
    const cw = reversed(square(0, 0, 10, 10));
    const u = unionGeometries([poly([cw]), poly([square(5, 5, 15, 15)])]);
    expect(coveredArea(u)).toBeCloseTo(175, 6);
  });

  it('is stable when a boundary is duplicated to within float noise', () => {
    const a = poly([square(0, 0, 10, 10)]);
    const b = poly([square(10 + 1e-9, 0, 20, 10)]);
    const u = unionGeometries([a, b]);
    expect(coveredArea(u)).toBeCloseTo(200, 3);
    expect(partCount(u)).toBe(1);
  });

  it('handles a T-junction where a vertex lands mid-edge', () => {
    const u = unionGeometries([poly([square(0, 0, 10, 10)]), poly([square(10, 5, 20, 15)])]);
    expect(coveredArea(u)).toBeCloseTo(200, 6);
    expect(partCount(u)).toBe(1);
  });

  it('works on real EPSG:3857 magnitudes', () => {
    const x = 15000000;
    const y = -4000000;
    const a = poly([square(x, y, x + 1000, y + 1000)]);
    const b = poly([square(x + 500, y + 500, x + 1500, y + 1500)]);
    expect(coveredArea(intersectGeometries(a, b))).toBeCloseTo(250000, 0);
    expect(coveredArea(unionGeometries([a, b]))).toBeCloseTo(1750000, 0);
  });

  it('derives a tolerance from the data extent and honours an explicit one', () => {
    expect(overlayTolerance([poly([square(0, 0, 10, 10)])])).toBeGreaterThan(0);
    expect(overlayTolerance([null])).toBe(1e-6);
    expect(overlayTolerance([poly([square(0, 0, 10, 10)])], 0.5)).toBe(0.5);
  });

  it('survives an empty subject list and non-polygonal subjects', () => {
    expect(overlayGeometries([], 'union')).toBeNull();
    expect(overlayGeometries([{ type: 'Point', coordinates: [0, 0] }], 'union')).toBeNull();
  });
});

describe('repair (the lossless Make Valid core)', () => {
  it('splits a bowtie into both lobes instead of keeping the largest', () => {
    const bowtie: Ring = [[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]];
    const fixed = repairGeometry(poly([bowtie]));
    expect(partCount(fixed)).toBe(2);
    expect(coveredArea(fixed)).toBeCloseTo(50, 6);
    expect(orientationIsCanonical(fixed)).toBe(true);
  });

  it('keeps a valid geometry exactly as it was', () => {
    const donut = poly([square(0, 0, 10, 10), reversed(square(3, 3, 7, 7))]);
    const fixed = repairGeometry(donut);
    expect(coveredArea(fixed)).toBeCloseTo(84, 6);
    expect(holeCount(fixed)).toBe(1);
    expect(partCount(fixed)).toBe(1);
  });

  it('promotes a hole that sits outside its shell to a polygon of its own', () => {
    const fixed = repairGeometry(poly([square(0, 0, 10, 10), square(20, 20, 25, 25)]));
    expect(partCount(fixed)).toBe(2);
    expect(coveredArea(fixed)).toBeCloseTo(125, 6);
  });

  it('removes the spike a self-overlapping ring creates', () => {
    const spike: Ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 5], [-5, 5], [0, 5], [0, 0]];
    expect(coveredArea(repairGeometry(poly([spike])))).toBeCloseTo(100, 6);
  });

  it('passes points and lines through', () => {
    const pt: GeoGeom = { type: 'Point', coordinates: [1, 2] };
    expect(repairGeometry(pt)).toEqual(pt);
    expect(repairGeometry(null)).toBeNull();
  });
});

describe('clip geometry by type', () => {
  it('clips a polygon by a concave cutter', () => {
    expect(coveredArea(clipGeometry(poly([square(0, 0, 10, 10)]), poly([lShape()])))).toBeCloseTo(75, 6);
  });

  it('keeps the points that fall inside, including on the boundary', () => {
    const pts: GeoGeom = { type: 'MultiPoint', coordinates: [[5, 5], [25, 25], [0, 0], [7, 7]] };
    const c = clipGeometry(pts, poly([square(0, 0, 10, 10)]));
    expect(c?.type).toBe('MultiPoint');
    expect((c as any).coordinates.length).toBe(3);
  });

  it('returns nothing when no point survives', () => {
    expect(clipGeometry({ type: 'Point', coordinates: [99, 99] }, poly([square(0, 0, 10, 10)]))).toBeNull();
  });

  it('cuts a line at the clip boundary and keeps the inside run', () => {
    const c = clipGeometry(ls([[-5, 5], [15, 5]]), poly([square(0, 0, 10, 10)]));
    expect(c?.type).toBe('LineString');
    expect((c as any).coordinates).toEqual([[0, 5], [10, 5]]);
  });

  it('keeps a line that turns inside the clip as one connected run', () => {
    const c = clipGeometry(ls([[-5, 2], [5, 2], [5, 8], [15, 8]]), poly([square(0, 0, 10, 10)]));
    expect(c?.type).toBe('LineString');
    expect((c as any).coordinates).toEqual([[0, 2], [5, 2], [5, 8], [10, 8]]);
  });

  it('splits a line that leaves and re-enters into a multilinestring', () => {
    const c = clipGeometry(ls([[-5, 2], [15, 2], [15, 8], [-5, 8]]), poly([square(0, 0, 10, 10)]));
    expect(c?.type).toBe('MultiLineString');
    const runs: Coord[][] = (c as any).coordinates;
    expect(runs.length).toBe(2);
    expect(runs.every(seq => seq.length === 2)).toBe(true);
    const total = runs.reduce((sum, seq) => sum + Math.hypot(seq[1][0] - seq[0][0], seq[1][1] - seq[0][1]), 0);
    expect(total).toBeCloseTo(20, 6);
  });

  it('drops a line that never enters', () => {
    expect(clipGeometry(ls([[50, 50], [60, 60]]), poly([square(0, 0, 10, 10)]))).toBeNull();
  });

  it('returns null when the clip layer is not a polygon', () => {
    expect(clipGeometry(poly([square(0, 0, 10, 10)]), { type: 'Point', coordinates: [0, 0] })).toBeNull();
  });
});

describe('polygonize', () => {
  it('builds the four faces of a square grid', () => {
    const faces = polygonizeGeometries([
      ls([[0, 0], [10, 0]]),
      ls([[10, 0], [10, 10]]),
      ls([[10, 10], [0, 10]]),
      ls([[0, 10], [0, 0]]),
      ls([[5, 0], [5, 10]]),
      ls([[0, 5], [10, 5]]),
    ]);
    expect(faces.length).toBe(4);
    expect(faces.reduce((s, f) => s + coveredArea(f), 0)).toBeCloseTo(100, 6);
    expect(faces.every(f => coveredArea(f) === 25)).toBe(true);
  });

  it('nodes lines that cross mid-segment', () => {
    const faces = polygonizeGeometries([
      ls([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
      ls([[0, 5], [10, 5]]),
    ]);
    expect(faces.length).toBe(2);
    expect(faces.every(f => coveredArea(f) === 50)).toBe(true);
  });

  it('ignores dangles and open networks', () => {
    expect(polygonizeGeometries([ls([[0, 0], [10, 0]]), ls([[10, 0], [10, 10]])])).toEqual([]);
  });

  it('turns a square inside a square into an annulus plus the inner face', () => {
    // The two cycles are not even connected, so the annulus is bounded by two
    // POSITIVE rings: containment, not orientation, decides which is the hole.
    const faces = polygonizeGeometries([
      ls([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
      ls([[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]),
    ]);
    expect(faces.length).toBe(2);
    const annulus = faces.find(f => holeCount(f) === 1);
    expect(annulus).toBeDefined();
    expect(coveredArea(annulus!)).toBeCloseTo(84, 6);
    expect(faces.reduce((sum, f) => sum + coveredArea(f), 0)).toBeCloseTo(100, 6);
  });

  it('nests three concentric squares into three faces that still total 100', () => {
    const faces = polygonizeGeometries([
      ls([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
      ls([[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]),
      ls([[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]),
    ]);
    expect(faces.length).toBe(3);
    expect(faces.reduce((sum, f) => sum + coveredArea(f), 0)).toBeCloseTo(100, 6);
    expect(faces.map(f => coveredArea(f)).sort((a, b) => a - b)).toEqual([4, 32, 64]);
  });
});

describe('geometryInteriorPoint', () => {
  it('returns a point inside a C-shaped polygon where the centroid is outside', () => {
    const cShape: Ring = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0]];
    const p = geometryInteriorPoint(poly([cShape]));
    expect(p).not.toBeNull();
    expect(pointInGeometry(p!, poly([cShape]))).toBe(true);
  });

  it('never lands in a hole, even when the hole covers the widest scanline', () => {
    const donut = poly([square(0, 0, 10, 10), square(2, 2, 8, 8)]);
    const p = geometryInteriorPoint(donut);
    expect(p).not.toBeNull();
    expect(pointInGeometry(p!, donut)).toBe(true);
  });

  it('falls back to a coordinate for points and lines', () => {
    expect(geometryInteriorPoint({ type: 'Point', coordinates: [3, 4] })).toEqual([3, 4]);
    expect(geometryInteriorPoint(null)).toBeNull();
  });
});

describe('connected components', () => {
  it('groups touching geometries and leaves scattered ones alone', () => {
    const comps = connectedComponents([
      poly([square(0, 0, 10, 10)]),
      poly([square(10, 0, 20, 10)]),
      poly([square(100, 100, 110, 110)]),
    ]);
    expect(comps.length).toBe(2);
    expect(comps.map(c => c.length).sort()).toEqual([1, 2]);
  });

  it('returns one geometry per component and merges them for a whole-layer union', () => {
    const geoms = [
      poly([square(0, 0, 10, 10)]),
      poly([square(10, 0, 20, 10)]),
      poly([square(100, 100, 110, 110)]),
    ];
    const comps = unionComponents(geoms);
    expect(comps.length).toBe(2);
    expect(comps.reduce((s, g) => s + coveredArea(g), 0)).toBeCloseTo(300, 6);
    expect(partCount(unionMany(geoms))).toBe(2);
    expect(coveredArea(unionMany(geoms))).toBeCloseTo(300, 6);
  });

  it('ignores null and non-polygonal entries', () => {
    expect(connectedComponents([null, { type: 'Point', coordinates: [0, 0] }])).toEqual([]);
  });
});

describe('adjacency', () => {
  it('sees a node-matched shared edge and measures it', () => {
    const a = poly([square(0, 0, 10, 10)]);
    const b = poly([square(10, 0, 20, 10)]);
    expect(geometriesAdjacent(a, b)).toBe(true);
    expect(sharedBoundaryLength(a, b)).toBeCloseTo(10, 6);
  });

  it('sees a partial shared edge the vertex-matching test missed', () => {
    const a = poly([square(0, 0, 10, 10)]);
    const b = poly([square(10, 2, 20, 6)]);
    expect(geometriesAdjacent(a, b)).toBe(true);
    expect(sharedBoundaryLength(a, b)).toBeCloseTo(4, 6);
  });

  it('sees an overlap and a point touch, and rejects what is far away', () => {
    expect(geometriesAdjacent(poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)]))).toBe(true);
    const corner = poly([square(10, 10, 20, 20)]);
    expect(geometriesAdjacent(poly([square(0, 0, 10, 10)]), corner)).toBe(true);
    expect(sharedBoundaryLength(poly([square(0, 0, 10, 10)]), corner)).toBeCloseTo(0, 6);
    expect(geometriesAdjacent(poly([square(0, 0, 10, 10)]), poly([square(50, 50, 60, 60)]))).toBe(false);
  });
});

describe('validateGeometry — the GEOS/QGIS error classes', () => {
  it('accepts a clean square and a clean donut', () => {
    expect(validateGeometry(poly([square(0, 0, 10, 10)]))).toEqual([]);
    expect(validateGeometry(poly([square(0, 0, 10, 10), reversed(square(3, 3, 7, 7))]))).toEqual([]);
    expect(isGeometryValid(poly([square(0, 0, 10, 10)]))).toBe(true);
  });

  it('locates a ring self-intersection', () => {
    const bowtie: Ring = [[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]];
    const errs = validateGeometry(poly([bowtie]));
    expect(codes(errs)).toContain('self-intersection');
    expect(errs[0].location).toEqual([5, 5]);
    expect(isGeometryValid(poly([bowtie]))).toBe(false);
  });

  it('flags a hole that lies outside its shell', () => {
    expect(codes(validateGeometry(poly([square(0, 0, 10, 10), square(20, 20, 25, 25)])))).toContain('hole-outside-shell');
  });

  it('flags nested holes', () => {
    const errs = validateGeometry(poly([
      square(0, 0, 20, 20),
      reversed(square(2, 2, 18, 18)),
      reversed(square(5, 5, 8, 8)),
    ]));
    expect(codes(errs)).toContain('nested-holes');
  });

  it('flags ONE ring that pinches to a point as a ring self-intersection', () => {
    // The ring visits (5,5) twice, so the two lobes only touch at that point.
    // GEOS 3.14.1: is_valid == false, "Ring Self-intersection[5 5]" — one ring
    // revisiting a node is a self-intersection, not a disconnected interior.
    const pinch: Ring = [[0, 0], [5, 0], [5, 5], [10, 5], [10, 10], [5, 10], [5, 5], [0, 5], [0, 0]];
    const errs = validateGeometry(poly([pinch]));
    expect(codes(errs)).toEqual(['self-intersection']);
    expect(errs[0].location).toEqual([5, 5]);
  });

  it('accepts a hole that touches its shell at ONE point', () => {
    // GEOS 3.14.1: is_valid == true, make_valid() returns this unchanged. The
    // material walks around the hole, so the interior is connected; reporting it
    // anyway used to flag real layers QGIS and PostGIS both accept.
    const errs = validateGeometry(poly([
      square(0, 0, 10, 10),
      reversed([[5, 0], [7, 3], [3, 3], [5, 0]] as Ring),   // apex on the shell's bottom edge
    ]));
    expect(errs).toEqual([]);
  });

  it('flags a hole that meets its shell at TWO points as a disconnected interior', () => {
    // The dart encloses a strip of material that reaches the rest only through the
    // two boundary points. GEOS 3.14.1: "Interior is disconnected[3 0]", and
    // make_valid() cuts it into a MULTIPOLYGON of 2 with area 96.
    const errs = validateGeometry(poly([
      square(0, 0, 10, 10),
      reversed([[3, 0], [5, 3], [7, 0], [5, 1], [3, 0]] as Ring),
    ]));
    expect(codes(errs)).toEqual(['disconnected-interior']);
    expect(errs[0].location).toEqual([3, 0]);
  });

  it('accepts two parts of a multipolygon that only touch at a point', () => {
    // Their interiors stay disjoint, which is all the OGC (and GEOS) requires —
    // so Make Valid's two-lobed bowtie comes out valid, as it should.
    const errs = validateGeometry(multipoly([[square(0, 0, 10, 10)], [square(10, 10, 20, 20)]]));
    expect(codes(errs)).not.toContain('disconnected-interior');
    expect(errs).toEqual([]);
  });

  it('flags a hole that lies outside its shell even when it touches it', () => {
    // The hole is outside the shell and merely touches it at (10,10). GEOS 3.14.1:
    // "Hole lies outside shell[10 10]", make_valid() -> MULTIPOLYGON of 2, area
    // 116 — the stray hole becomes a polygon of its own, which is what our repair
    // does too (nonzero winding keeps the ground rather than dropping it).
    const errs = validateGeometry(poly([
      square(0, 0, 10, 10),
      reversed(square(10, 10, 14, 14)),   // touches the shell only at (10,10)
    ]));
    expect(codes(errs)).toEqual(['hole-outside-shell']);
    expect(errs[0].location).toEqual([10, 10]);
    const fixed = repairGeometry(poly([square(0, 0, 10, 10), reversed(square(10, 10, 14, 14))]));
    expect(geometryParts(fixed).length).toBe(2);
  });

  it('flags duplicate rings, short rings, open rings and NaN coordinates', () => {
    expect(codes(validateGeometry(poly([square(0, 0, 10, 10), reversed(square(0, 0, 10, 10))])))).toContain('duplicate-ring');
    expect(codes(validateGeometry(poly([[[0, 0], [1, 1], [0, 0]]])))).toContain('too-few-points');
    expect(codes(validateGeometry(poly([[[0, 0], [10, 0], [10, 10], [0, 10]]])))).toContain('unclosed-ring');
    expect(codes(validateGeometry(poly([[[0, 0], [NaN, 0], [10, 10], [0, 10], [0, 0]]])))).toContain('nan-coordinate');
  });

  it('flags overlapping parts of a multipolygon', () => {
    const errs = validateGeometry(multipoly([[square(0, 0, 10, 10)], [square(5, 5, 15, 15)]]));
    expect(codes(errs)).toContain('overlapping-parts');
  });

  it('reports EVERY reason for one feature, each with a part and ring', () => {
    const errs = validateGeometry(poly([
      square(0, 0, 10, 10),
      square(20, 20, 25, 25),
      reversed(square(20, 20, 25, 25)),
    ]));
    expect(errs.length).toBeGreaterThan(1);
    expect(errs.every(e => e.message.length > 0)).toBe(true);
    expect(errs.every(e => typeof e.part === 'number' && typeof e.ring === 'number')).toBe(true);
  });

  it('checks lines and points without ring topology', () => {
    expect(validateGeometry(ls([[0, 0], [1, 1]]))).toEqual([]);
    expect(codes(validateGeometry(ls([[0, 0]])))).toContain('too-few-points');
    expect(validateGeometry(null)).toEqual([]);
  });
});
