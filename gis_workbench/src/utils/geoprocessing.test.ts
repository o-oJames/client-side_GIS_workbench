/**
 * geoprocessing.test.ts — golden tests for the "Vector Tools" engines.
 *
 * Stage 0 of the QGIS/PostGIS parity work. Every tool's behaviour is pinned here,
 * including the places where it deliberately deviates from GEOS: those tests are
 * prefixed `KNOWN LIMITATION` and are meant to fail loudly (and be updated) when
 * the Stage 2 overlay kernel lands.
 *
 * Fixtures use small map-unit coordinates near the EPSG:3857 origin so planar
 * assertions stay readable; the geodesic ones go through utils/geodesic.
 */
import {
  MIN_COORD_TOLERANCE,
  PROGRESS_CHUNK_MS,
  addGeometryAttributes,
  buildFeatureIndex,
  bufferFeatures,
  bufferGeometry,
  centroidFeatures,
  checkValidity,
  clamp01,
  clipFeatures,
  clipFeaturesAsync,
  closeRing,
  collectGeometries,
  computeDistances,
  computeDistancesAsync,
  computeNearestDistances,
  convexHullFeature,
  convexHullFeatures,
  coordsClose,
  createProgress,
  delaunayTriangulation,
  delaunayTriangulationAsync,
  densifyByCount,
  differenceFeatures,
  dissolveFeatures,
  eliminateSelectedPolygons,
  eliminateSelectedPolygonsAsync,
  eliminateSelectedPolygonsDetailed,
  extractVertices,
  featureExtent,
  featureGroupKey,
  featuresExtent,
  getAllPolygonRings,
  getExteriorRings,
  getPolygonParts,
  geomClosestPoints,
  geometryExtent,
  intersectFeatures,
  intersectFeaturesAsync,
  isRingClosed,
  linesToPolygons,
  makeValid,
  mergeOverlayProperties,
  mergeVectorLayers,
  multipartToSingleparts,
  nearestAttributeFeatures,
  olFeaturesToGeo,
  pointsOnSurface,
  polygonizeFeatures,
  polygonsToLines,
  progressLoop,
  removeSelectedFeatures,
  sanitiseLayerName,
  scaleTolerance,
  symmetricalDifferenceFeatures,
  simplifyFeatures,
  splitVectorLayer,
  toGeoJSONString,
  toMeters,
  toleranceForFeatures,
  unionFeatures,
  validityErrorPoints,
  voronoiPolygons,
  voronoiPolygonsAsync,
  type Coord,
  type GeoFeature,
  type GeoGeom,
  type Ring,
} from './geoprocessing';
import {
  WEB_MERCATOR_RADIUS,
  groundDistance,
  groundLineLength,
  groundPolygonArea,
  groundPolygonPerimeter,
  lonLatToMercator,
} from './geodesic';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function square(x0: number, y0: number, x1: number, y1: number): Ring {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] as Ring;
}

function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    sum += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(sum / 2);
}

/** Sum of |area| of every ring — deliberately naive so hole bugs are visible. */
function geomArea(geom: GeoGeom | null): number {
  if (!geom) return 0;
  if (geom.type === 'Polygon') return geom.coordinates.reduce((a, r) => a + shoelace(r), 0);
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((a, part) => a + part.reduce((b, r) => b + shoelace(r), 0), 0);
  }
  return 0;
}

/** Polygon area with holes subtracted — what the geometry actually covers. */
function coveredArea(geom: GeoGeom | null): number {
  if (!geom) return 0;
  if (geom.type === 'Polygon') {
    const [shell, ...holes] = geom.coordinates;
    return shoelace(shell) - holes.reduce((a, h) => a + shoelace(h), 0);
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((sum, part) => sum + coveredArea({ type: 'Polygon', coordinates: part }), 0);
  }
  return 0;
}

function poly(rings: Ring[], properties: Record<string, any> = {}): GeoFeature {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: rings }, properties };
}

function point(x: number, y: number, properties: Record<string, any> = {}): GeoFeature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] as Coord }, properties };
}

function line(coords: Coord[], properties: Record<string, any> = {}): GeoFeature {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties };
}

const donutRings = (): Ring[] => [square(0, 0, 10, 10), square(3, 3, 7, 7)];

const reversedRing = (ring: Ring): Ring => ring.slice().reverse();

function multipolyFeature(parts: Ring[][], properties: Record<string, any> = {}): GeoFeature {
  return { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: parts }, properties };
}

// ---------------------------------------------------------------------------
// Coordinate tolerance (Stage 1.1)
// ---------------------------------------------------------------------------

describe('coordinate tolerance', () => {
  it('floors at MIN_COORD_TOLERANCE and scales with the dataset span', () => {
    expect(scaleTolerance(0)).toBe(MIN_COORD_TOLERANCE);
    expect(scaleTolerance(-5)).toBe(MIN_COORD_TOLERANCE);
    expect(scaleTolerance(NaN)).toBe(MIN_COORD_TOLERANCE);
    expect(scaleTolerance(1)).toBe(MIN_COORD_TOLERANCE);
    // A 10 000 km dataset gets a 1 cm tolerance, not a 1e-12 one.
    expect(scaleTolerance(1e7)).toBeCloseTo(1e-2, 12);
  });

  it('compares coordinates inclusively', () => {
    expect(coordsClose([0, 0], [1, 1], 1)).toBe(true);
    expect(coordsClose([0, 0], [1.5, 0], 1)).toBe(false);
  });

  /**
   * EPSG:3857 ordinates are ~1.5e7, where the double ULP is ~2e-9: the old
   * bit-exact closure test flagged rings that were closed for any real purpose.
   */
  it('treats a sub-tolerance gap as closed, and a real gap as open', () => {
    const nearClosed = [[0, 0], [10, 0], [10, 10], [0, 1e-8]] as Ring;
    expect(isRingClosed(nearClosed)).toBe(true);
    expect(isRingClosed([[0, 0], [10, 0], [10, 10], [0, 5]] as Ring)).toBe(false);
    expect(isRingClosed([[0, 0]] as Ring)).toBe(false);
  });

  it('closeRing appends the first coordinate only when needed', () => {
    const open = [[0, 0], [1, 0], [1, 1]] as Ring;
    expect(closeRing(open)).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
    const closed = square(0, 0, 1, 1);
    expect(closeRing(closed)).toHaveLength(closed.length);
    expect(closeRing(closed)).not.toBe(closed); // a copy, never the input
    expect(closeRing([] as Ring)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Polygon parts (Stage 1.2)
// ---------------------------------------------------------------------------

describe('polygon parts', () => {
  it('keeps holes with their shell', () => {
    const parts = getPolygonParts({ type: 'Polygon', coordinates: donutRings() });
    expect(parts).toHaveLength(1);
    expect(parts[0].holes).toHaveLength(1);
    expect(shoelace(parts[0].holes[0])).toBe(16);
  });

  it('flattens multipolygons into parts', () => {
    const geom: GeoGeom = {
      type: 'MultiPolygon',
      coordinates: [
        [square(0, 0, 1, 1), square(0.2, 0.2, 0.4, 0.4)],
        [square(10, 10, 11, 11)],
      ],
    };
    const parts = getPolygonParts(geom);
    expect(parts).toHaveLength(2);
    expect(parts[0].holes).toHaveLength(1);
    expect(parts[1].holes).toHaveLength(0);
  });

  it('returns nothing for non-polygonal or null geometry', () => {
    expect(getPolygonParts(null)).toEqual([]);
    expect(getPolygonParts({ type: 'Point', coordinates: [0, 0] as Coord })).toEqual([]);
    expect(getPolygonParts({ type: 'LineString', coordinates: [[0, 0], [1, 1]] as Coord[] })).toEqual([]);
  });

  it('separates shell-only from all-rings views', () => {
    const geom: GeoGeom = { type: 'Polygon', coordinates: donutRings() };
    expect(getExteriorRings(geom)).toHaveLength(1);
    expect(getAllPolygonRings(geom)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Extents & index (Stage 1.3)
// ---------------------------------------------------------------------------

describe('extents and spatial index', () => {
  it('measures geometry extents including holes', () => {
    expect(geometryExtent({ type: 'Polygon', coordinates: donutRings() })).toEqual([0, 0, 10, 10]);
    expect(geometryExtent({ type: 'Point', coordinates: [3, 4] as Coord })).toEqual([3, 4, 3, 4]);
    expect(geometryExtent(null)[0]).toBe(Infinity);
    expect(featureExtent(poly([square(0, 0, 10, 10)]))).toEqual([0, 0, 10, 10]);
    expect(featuresExtent([point(0, 0), point(5, 7)])).toEqual([0, 0, 5, 7]);
    expect(featuresExtent([])[0]).toBe(Infinity);
  });

  it('derives the tolerance from every input set', () => {
    const tol = toleranceForFeatures([poly([square(0, 0, 1000, 1000)])]);
    expect(tol).toBeCloseTo(scaleTolerance(1000), 12);
    expect(tol).toBeGreaterThan(MIN_COORD_TOLERANCE);
  });

  it('indexes features by extent and prunes distant ones', () => {
    const features = [poly([square(0, 0, 10, 10)]), poly([square(1000, 1000, 1010, 1010)])];
    const index = buildFeatureIndex(features);
    expect(index.size).toBe(2);
    expect(index.query([0, 0, 5, 5])).toEqual([0]);
    expect(index.query([999, 999, 1200, 1200])).toEqual([1]);
    expect(index.query([500, 500, 600, 600])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Progress plumbing (Stage 1.5)
// ---------------------------------------------------------------------------

describe('progress and cancellation', () => {
  it('clamps progress to [0, 1]', () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(0.4)).toBeCloseTo(0.4, 12);
  });

  it('createProgress starts uncancelled', () => {
    const p = createProgress('x');
    expect(p).toEqual({ message: 'x', progress: 0, cancelled: false });
  });

  it('runs every index and ends at 100 %', async () => {
    const token = createProgress();
    const seen: number[] = [];
    const reports: number[] = [];
    const ok = await progressLoop(50, token, i => seen.push(i), p => reports.push(p.progress), 'Working');
    expect(ok).toBe(true);
    expect(seen).toHaveLength(50);
    expect(seen[0]).toBe(0);
    expect(token.progress).toBe(1);
    expect(reports[reports.length - 1]).toBe(1);
    expect(token.message).toContain('50/50');
  });

  it('stops as soon as the token is cancelled', async () => {
    const token = createProgress();
    let ran = 0;
    const ok = await progressLoop(1000, token, () => {
      ran++;
      if (ran === 3) token.cancelled = true;
    });
    expect(ok).toBe(false);
    expect(ran).toBeLessThan(1000);
  });

  it('tolerates an empty loop', async () => {
    const token = createProgress();
    expect(await progressLoop(0, token, () => { throw new Error('should not run'); })).toBe(true);
  });

  it('exposes a chunk budget so long runs can yield', () => {
    expect(PROGRESS_CHUNK_MS).toBeGreaterThan(0);
    expect(PROGRESS_CHUNK_MS).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

describe('buffer', () => {
  it('buffers a point into a polygon approximating a circle', () => {
    const geom = bufferGeometry({ type: 'Point', coordinates: [0, 0] as Coord }, 100);
    expect(geom?.type).toBe('Polygon');
    // segments=8 → 32-gon: 0.5·n·r²·sin(2π/n) ≈ 0.9936 of πr²
    const ratio = geomArea(geom) / (Math.PI * 100 * 100);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1);
  });

  it('scales the radius for Web Mercator latitude by sec²(φ)', () => {
    // y at 60° latitude in the spherical Web Mercator definition.
    const y60 = WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + Math.PI / 6));
    const atEquator = bufferGeometry({ type: 'Point', coordinates: [0, 0] as Coord }, 1000);
    const at60 = bufferGeometry({ type: 'Point', coordinates: [0, y60] as Coord }, 1000);
    // Area scales with cosh²(y/R) = sec²(60°) = 4, so a 1 km buffer drawn at
    // 60° covers 4× the projected area it does at the equator.
    expect(geomArea(at60) / geomArea(atEquator)).toBeCloseTo(4, 6);
  });

  it('rejects a negative buffer on points and lines, like GEOS', () => {
    expect(bufferGeometry({ type: 'Point', coordinates: [0, 0] as Coord }, -5)).toBeNull();
    expect(bufferGeometry({ type: 'LineString', coordinates: [[0, 0], [10, 0]] as Coord[] }, -5)).toBeNull();
  });

  it('rounds a 90° corner instead of mitring it', () => {
    // GEOS: 100 + 4·10·1 + π·1² = 143.1416. The 8-segments-per-quarter-circle
    // tessellation lands a hair under it, which is the expected direction.
    const geom = bufferGeometry({ type: 'Polygon', coordinates: [square(0, 0, 10, 10)] }, 1);
    expect(geomArea(geom)).toBeCloseTo(100 + 40 + Math.PI, 1);
    expect(geomArea(geom)).toBeLessThan(144);
    // More segments converges on the true value from below.
    const fine = bufferGeometry({ type: 'Polygon', coordinates: [square(0, 0, 10, 10)] }, 1, { segments: 64 });
    expect(geomArea(fine)).toBeGreaterThan(geomArea(geom));
    expect(geomArea(fine)).toBeLessThan(100 + 40 + Math.PI);
  });

  it('keeps holes and shrinks them when growing the polygon', () => {
    const geom = bufferGeometry({ type: 'Polygon', coordinates: donutRings() }, 1);
    expect(geom?.type).toBe('Polygon');
    if (geom?.type !== 'Polygon') throw new Error('expected a Polygon');
    expect(geom.coordinates).toHaveLength(2);
    expect(shoelace(geom.coordinates[0])).toBeCloseTo(100 + 40 + Math.PI, 1);
    // The 4×4 hole becomes a sharp 2×2 — growing the material into a rectangular
    // void keeps its corners square, and it used to be deleted outright.
    expect(Math.abs(shoelace(geom.coordinates[1]))).toBeCloseTo(4, 6);
  });

  it('widens holes when shrinking the polygon', () => {
    const geom = bufferGeometry({ type: 'Polygon', coordinates: donutRings() }, -1);
    if (geom?.type !== 'Polygon') throw new Error('expected a Polygon');
    expect(geom.coordinates).toHaveLength(2);
    expect(shoelace(geom.coordinates[0])).toBeCloseTo(64, 6); // 8×8 shell, corners stay sharp
    // Eroding the material rounds the void's corners off: a 6×6 square less the
    // four (1 − π/4) corner bites = 36 − (4 − π) ≈ 35.14 — GEOS's answer too.
    expect(Math.abs(shoelace(geom.coordinates[1]))).toBeCloseTo(36 - (4 - Math.PI), 1);
    expect(coveredArea(geom)).toBeCloseTo(64 - (36 - 4 + Math.PI), 1);
  });

  it('drops a polygon that a negative buffer collapses', () => {
    expect(bufferGeometry({ type: 'Polygon', coordinates: [square(0, 0, 1, 1)] }, -10)).toBeNull();
  });

  it('honours end cap styles on lines', () => {
    const geom: GeoGeom = { type: 'LineString', coordinates: [[0, 0], [10, 0]] as Coord[] };
    const flat = bufferGeometry(geom, 1, { endCapStyle: 'flat' });
    const squareCap = bufferGeometry(geom, 1, { endCapStyle: 'square' });
    const round = bufferGeometry(geom, 1, { endCapStyle: 'round' });
    expect(geomArea(flat)).toBeCloseTo(20, 6);            // 10 × 2
    expect(geomArea(squareCap)).toBeCloseTo(24, 6);        // 12 × 2
    // 20 + πr², less ~0.1 % for the 32-gon approximation of the two half discs.
    expect(geomArea(round)).toBeCloseTo(20 + Math.PI, 1);
  });

  it('falls back to a bevel when the miter limit is exceeded', () => {
    const geom: GeoGeom = { type: 'LineString', coordinates: [[0, 0], [10, 0], [12, 8]] as Coord[] };
    const bevel = bufferGeometry(geom, 1, { joinStyle: 'bevel' });
    const shortMiter = bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 1 });
    expect(geomArea(shortMiter)).toBeCloseTo(geomArea(bevel), 6);
    const longMiter = bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 20 });
    expect(geomArea(longMiter)).not.toBeCloseTo(geomArea(bevel), 3);
  });

  /**
   * WAS a KNOWN LIMITATION: at a sharp bend the offset curve crossed the opposite
   * side of the buffer, wound back over itself with the opposite orientation, and
   * the overlap cancelled under the winding rule — so the "repaired" result came
   * back 29 % SMALLER than the buffer and was kept only because the area guard
   * preferred a wrong-but-large ring to a right-but-small one.
   *
   * `bufferGeometry` now rebuilds such a buffer as the union of its Minkowski
   * pieces (slabs + outside-of-bend wedges + caps), which cannot cross itself.
   * See utils/buffer.test.ts for the definition-level oracle and the erosion
   * algebra; this is the golden number that used to be wrong.
   */
  it('a sharp bend is noded, so every join style covers the ground it should', () => {
    const geom: GeoGeom = { type: 'LineString', coordinates: [[0, 0], [10, 0], [12, 8]] as Coord[] };
    const bevel = geomArea(bufferGeometry(geom, 1, { joinStyle: 'bevel' }));
    const longMiter = geomArea(bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 20 }));
    const roundJoin = geomArea(bufferGeometry(geom, 1, { joinStyle: 'round' }));
    // A bevel cuts the corner away, a round join fills it with a sector, a long
    // mitre overshoots past the sector. The old code had mitre < bevel.
    expect(bevel).toBeLessThan(roundJoin);
    expect(roundJoin).toBeLessThan(longMiter);
    // Two 1×L slabs, two round caps and one 76° sector, less the slab overlap on
    // the inside of the bend: 39.5, against the 28.29 the offset curve produced.
    expect(roundJoin).toBeGreaterThan(39);
    expect(roundJoin).toBeLessThan(41);
    for (const g of [
      bufferGeometry(geom, 1, { joinStyle: 'bevel' }),
      bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 20 }),
      bufferGeometry(geom, 1, { joinStyle: 'round' }),
    ]) {
      expect(checkValidity([{ type: 'Feature', geometry: g, properties: {} }])[0].valid).toBe(true);
    }
  });

  it('keeps properties and skips collapsed features', () => {
    const out = bufferFeatures([point(0, 0, { id: 'a' }), poly([square(0, 0, 1, 1)], { id: 'b' })], 5);
    expect(out).toHaveLength(2);
    expect(out[0].properties).toEqual({ id: 'a' });
    expect(bufferFeatures([point(0, 0)], -5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Clip
// ---------------------------------------------------------------------------

describe('clip', () => {
  it('keeps only the part inside a convex cutter', () => {
    const out = clipFeatures([poly([square(0, 0, 10, 10)], { id: 'in' })], [poly([square(5, 5, 15, 15)], { id: 'cutter' })]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(25, 6);
    // The cutter's attributes are discarded, the input's are kept.
    expect(out[0].properties).toEqual({ id: 'in' });
  });

  it('returns nothing when the layers do not overlap', () => {
    expect(clipFeatures([poly([square(0, 0, 1, 1)])], [poly([square(50, 50, 51, 51)])])).toEqual([]);
  });

  it('emits one feature per clip polygon the input touches', () => {
    const out = clipFeatures(
      [poly([square(0, 0, 30, 10)])],
      [poly([square(0, 0, 10, 10)]), poly([square(20, 0, 30, 10)])]
    );
    expect(out).toHaveLength(2);
    expect(out.reduce((a, f) => a + coveredArea(f.geometry), 0)).toBeCloseTo(200, 6);
  });

  it('preserves a hole in the clipped subject', () => {
    const out = clipFeatures(
      [poly([square(0, 0, 10, 10), square(4, 4, 6, 6)])],
      [poly([square(-5, -5, 20, 20)])]
    );
    expect(out).toHaveLength(1);
    if (out[0].geometry?.type !== 'Polygon') throw new Error('expected a Polygon');
    expect(out[0].geometry.coordinates).toHaveLength(2);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(96, 6); // 100 − 4
  });

  it('drops a piece that lies entirely inside a hole of the clip layer', () => {
    expect(clipFeatures([poly([square(4, 4, 6, 6)])], [poly(donutRings())])).toEqual([]);
  });

  it('subtracts a hole of the clip layer from a piece that straddles it', () => {
    // Stage 1 kept the whole piece (100) because it had no difference kernel.
    const out = clipFeatures([poly([square(-5, -5, 15, 15)])], [poly(donutRings())]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(84, 6);
  });

  it('is exact for a concave cutter', () => {
    const lShape: Ring = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]] as Ring;
    expect(shoelace(lShape)).toBeCloseTo(64, 6);
    const out = clipFeatures([poly([square(0, 0, 10, 10)])], [poly([lShape])]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(64, 6);
  });

  it('clips points and lines too, like QGIS', () => {
    const cutter = [poly([square(0, 0, 10, 10)])];
    const points = clipFeatures([point(5, 5), point(50, 50)], cutter);
    expect(points).toHaveLength(1);
    expect(points[0].geometry).toEqual({ type: 'Point', coordinates: [5, 5] });

    const lines = clipFeatures([line([[5, 5], [20, 20]] as Coord[])], cutter);
    expect(lines).toHaveLength(1);
    expect((lines[0].geometry as any).coordinates).toEqual([[5, 5], [10, 10]]);
  });

  it('clips a multipart cutter into several pieces', () => {
    const cutter: GeoFeature = {
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 4, 10)], [square(6, 0, 10, 10)]] },
      properties: {},
    };
    const out = clipFeatures([poly([square(0, 0, 10, 10)])], [cutter]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    expect(coveredArea(out[0].geometry)).toBeCloseTo(80, 6);
  });

  it('the async variant matches the sync one and can be cancelled', async () => {
    const input = [poly([square(0, 0, 10, 10)]), poly([square(5, 5, 20, 20)])];
    const cutter = [poly([square(4, 4, 12, 12)])];
    const sync = clipFeatures(input, cutter);
    const async = await clipFeaturesAsync(input, cutter);
    expect(async).toHaveLength(sync.length);
    expect(async.map(f => coveredArea(f.geometry))).toEqual(sync.map(f => coveredArea(f.geometry)));

    const token = createProgress();
    token.cancelled = true;
    expect(await clipFeaturesAsync(input, cutter, token)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Intersect
// ---------------------------------------------------------------------------

describe('intersect', () => {
  it('emits the overlap with both layers\' attributes', () => {
    const out = intersectFeatures(
      [poly([square(0, 0, 10, 10)], { name: 'A', a: 1 })],
      [poly([square(5, 5, 15, 15)], { name: 'B', b: 2 })]
    );
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(25, 6);
    // Collisions are disambiguated the way QGIS does, instead of B overwriting A.
    expect(out[0].properties).toEqual({ name: 'A', a: 1, name_2: 'B', b: 2 });
  });

  it('returns nothing for disjoint layers', () => {
    expect(intersectFeatures([poly([square(0, 0, 1, 1)])], [poly([square(50, 50, 51, 51)])])).toEqual([]);
  });

  /**
   * The extent index must not change the answer: compare against a brute-force
   * reference over the same kernel.
   */
  it('the extent index prunes without dropping any real overlap', () => {
    const layerA: GeoFeature[] = [];
    const layerB: GeoFeature[] = [];
    for (let gx = 0; gx < 6; gx++) {
      for (let gy = 0; gy < 6; gy++) {
        layerA.push(poly([square(gx * 100, gy * 100, gx * 100 + 60, gy * 100 + 60)], { a: `${gx},${gy}` }));
        layerB.push(poly([square(gx * 100 + 40, gy * 100 + 40, gx * 100 + 140, gy * 100 + 140)], { b: `${gx},${gy}` }));
      }
    }
    const indexed = intersectFeatures(layerA, layerB);
    // Every A cell overlaps its own B cell (20×20) and, except on the last
    // column/row, the next one too.
    // 36 self-pairs at 20×20, 25 diagonal pairs at 40×40, and 60 side pairs
    // at 40×20 — the index must find every one of them.
    expect(indexed.length).toBe(36 + 25 + 30 + 30);
    const totalArea = indexed.reduce((sum, f) => sum + coveredArea(f.geometry), 0);
    expect(totalArea).toBeCloseTo(36 * 400 + 25 * 1600 + 60 * 800, 3);
  });

  it('the async variant matches the sync one', async () => {
    const a = [poly([square(0, 0, 10, 10)]), poly([square(20, 0, 30, 10)])];
    const b = [poly([square(5, 0, 25, 10)])];
    const sync = intersectFeatures(a, b);
    const async = await intersectFeaturesAsync(a, b);
    expect(async.map(f => coveredArea(f.geometry))).toEqual(sync.map(f => coveredArea(f.geometry)));
    const token = createProgress();
    token.cancelled = true;
    expect(await intersectFeaturesAsync(a, b, token)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dissolve & Union
// ---------------------------------------------------------------------------

describe('dissolve', () => {
  it('merges edge-adjacent polygons without losing area', async () => {
    const out = await dissolveFeatures([
      poly([square(0, 0, 10, 10)], { a: 1 }),
      poly([square(10, 0, 20, 10)], { b: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('Polygon');
    // Regression: the old shared-edge splice produced a self-intersecting
    // hexagon of area 150 for this exact input.
    expect(coveredArea(out[0].geometry)).toBeCloseTo(200, 6);
    expect(out[0].properties).toEqual({});
  });

  it('merges a whole row of polygons', async () => {
    const out = await dissolveFeatures([
      poly([square(0, 0, 10, 10)]),
      poly([square(10, 0, 20, 10)]),
      poly([square(20, 0, 30, 10)]),
    ]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(300, 6);
  });

  it('keeps disjoint polygons as multipolygon parts', async () => {
    const out = await dissolveFeatures([poly([square(0, 0, 10, 10)]), poly([square(500, 500, 510, 510)])]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    if (out[0].geometry?.type !== 'MultiPolygon') throw new Error('expected a MultiPolygon');
    expect(out[0].geometry.coordinates).toHaveLength(2);
  });

  it('collects without merging when dissolveOverlap is off', async () => {
    const out = await dissolveFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(10, 0, 20, 10)])],
      { dissolveOverlap: false }
    );
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    expect(geomArea(out[0].geometry)).toBeCloseTo(200, 6);
  });

  it('keeps lines and points as their own features', async () => {
    const out = await dissolveFeatures([
      line([[0, 0], [5, 5]] as Coord[]),
      line([[5, 5], [9, 9]] as Coord[]),
      point(1, 1),
      point(2, 2),
    ]);
    const types = out.map(f => f.geometry?.type).sort();
    expect(types).toEqual(['MultiLineString', 'MultiPoint']);
  });

  it('merges overlapping polygons exactly instead of inflating to their convex hull', async () => {
    // Stage 1 fell back to convexHullOfRings here and reported 200 for 175.
    const out = await dissolveFeatures([poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)])]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(175, 6);
  });

  it('groups by field and keeps the group-by attributes (QGIS Dissolve field(s))', async () => {
    const out = await dissolveFeatures([
      poly([square(0, 0, 10, 10)], { zone: 'a', other: 1 }),
      poly([square(10, 0, 20, 10)], { zone: 'a', other: 2 }),
      poly([square(0, 10, 10, 20)], { zone: 'b', other: 3 }),
    ], { fields: ['zone'] });
    expect(out).toHaveLength(2);
    const a = out.find(f => f.properties.zone === 'a')!;
    const b = out.find(f => f.properties.zone === 'b')!;
    expect(coveredArea(a.geometry)).toBeCloseTo(200, 6);
    expect(coveredArea(b.geometry)).toBeCloseTo(100, 6);
    // Only the dissolve field survives — QGIS's default.
    expect(a.properties).toEqual({ zone: 'a' });
  });

  it('groups by several fields at once', async () => {
    const out = await dissolveFeatures([
      poly([square(0, 0, 10, 10)], { zone: 'a', cls: 1 }),
      poly([square(10, 0, 20, 10)], { zone: 'a', cls: 2 }),
      poly([square(20, 0, 30, 10)], { zone: 'a', cls: 1 }),
    ], { fields: ['zone', 'cls'] });
    expect(out).toHaveLength(2);
    expect(out.map(f => coveredArea(f.geometry)).sort()).toEqual([100, 200]);
  });

  it('keeps disjoint features separate when asked', async () => {
    const out = await dissolveFeatures([
      poly([square(0, 0, 10, 10)]),
      poly([square(10, 0, 20, 10)]),
      poly([square(500, 500, 510, 510)]),
    ], { keepDisjoint: true });
    expect(out).toHaveLength(2);
    expect(out.map(f => coveredArea(f.geometry)).sort((a, b) => a - b)).toEqual([100, 200]);
    // …and merges everything into one multipart feature when not.
    const merged = await dissolveFeatures([
      poly([square(0, 0, 10, 10)]),
      poly([square(500, 500, 510, 510)]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].geometry?.type).toBe('MultiPolygon');
  });

  it('dissolves a layer of scattered parcels without touching the kernel for each one', async () => {
    // Every parcel is its own connected component, so the union is 60 features
    // rather than one noding pass over 60 polygons.
    const features: GeoFeature[] = [];
    for (let i = 0; i < 60; i++) features.push(poly([square(i * 100, 0, i * 100 + 10, 10)]));
    const out = await dissolveFeatures(features, { keepDisjoint: true });
    expect(out).toHaveLength(60);
    expect(out.every(f => coveredArea(f.geometry) === 100)).toBe(true);
  });

  it('reports progress and really honours cancellation', async () => {
    // 40 scattered parcels = 40 connected components = 40 cancellable steps.
    // (One single connected group is one synchronous kernel call, so Cancel
    // lands between components rather than inside the sweep.)
    const features: GeoFeature[] = [];
    for (let i = 0; i < 40; i++) features.push(poly([square(i * 100, 0, i * 100 + 10, 10)]));

    const cancelled = createProgress();
    cancelled.cancelled = true;
    expect(await dissolveFeatures(features, { keepDisjoint: true, progress: cancelled })).toEqual([]);

    // A completed run reports monotonic progress that never exceeds 1 — the old
    // pairs-checked counter could, because the scan restarted after every merge.
    const reports: number[] = [];
    const token = createProgress();
    const out = await dissolveFeatures(features, {
      keepDisjoint: true,
      progress: token,
      onProgress: p => reports.push(p.progress),
    });
    expect(out).toHaveLength(40);
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) expect(r).toBeLessThanOrEqual(1);
    expect(token.progress).toBe(1);
  });

  it('progress stays within [0, 1] on a completed run', async () => {
    const features: GeoFeature[] = [];
    for (let i = 0; i < 12; i++) features.push(poly([square(i * 10, 0, i * 10 + 10, 10)]));
    const token = createProgress();
    const seen: number[] = [];
    const out = await dissolveFeatures(features, { progress: token, onProgress: p => seen.push(p.progress) });
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(1200, 3);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(token.progress).toBe(1);
  });
});

describe('union (QGIS overlay)', () => {
  it('emits the overlap with both tables and each exclusive part with its own', async () => {
    const out = await unionFeatures(
      [poly([square(0, 0, 10, 10)], { name: 'A', a: 1 })],
      [poly([square(5, 5, 15, 15)], { name: 'B', b: 2 })]
    );
    expect(out).toHaveLength(3); // A∩B, A−B, B−A
    const areas = out.map(f => coveredArea(f.geometry)).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(25, 6);
    expect(areas[1]).toBeCloseTo(75, 6);
    expect(areas[2]).toBeCloseTo(75, 6);
    // Total coverage is exactly A ∪ B — nothing doubled, nothing lost.
    expect(areas.reduce((x, y) => x + y, 0)).toBeCloseTo(175, 6);

    const overlap = out.find(f => Math.abs(coveredArea(f.geometry) - 25) < 1e-6)!;
    expect(overlap.properties).toEqual({ name: 'A', a: 1, name_2: 'B', b: 2 });
  });

  it('nulls the other layer\'s fields on the exclusive parts', async () => {
    const out = await unionFeatures(
      [poly([square(0, 0, 10, 10)], { a: 1 })],
      [poly([square(5, 5, 15, 15)], { b: 2 })]
    );
    const onlyA = out.find(f => f.properties.a === 1 && f.properties.b === null);
    const onlyB = out.find(f => f.properties.b === 2 && f.properties.a === null);
    expect(onlyA).toBeDefined();
    expect(onlyB).toBeDefined();
    expect(coveredArea(onlyA!.geometry)).toBeCloseTo(75, 6);
  });

  it('passes non-polygonal features through with the other layer\'s fields nulled', async () => {
    const out = await unionFeatures(
      [point(50, 50, { p: 1 })],
      [poly([square(0, 0, 10, 10)], { b: 2 })]
    );
    expect(out).toHaveLength(2);
    const pt = out.find(f => f.geometry?.type === 'Point')!;
    expect(pt.properties).toEqual({ p: 1, b: null });
    expect(coveredArea(out.find(f => f.geometry?.type === 'Polygon')!.geometry)).toBeCloseTo(100, 6);
  });

  it('merges two touching polygon layers into one covered area, not two', async () => {
    const out = await unionFeatures(
      [poly([square(0, 0, 10, 10)], { a: 1 })],
      [poly([square(10, 0, 20, 10)], { b: 2 })]
    );
    // No overlap: one exclusive part per layer.
    expect(out).toHaveLength(2);
    expect(out.reduce((sum, f) => sum + coveredArea(f.geometry), 0)).toBeCloseTo(200, 6);
  });

  it('honours cancellation', async () => {
    const token = createProgress();
    token.cancelled = true;
    expect(await unionFeatures([poly([square(0, 0, 10, 10)])], [poly([square(5, 5, 15, 15)])], { progress: token })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Difference & Symmetrical difference (new with the overlay kernel)
// ---------------------------------------------------------------------------

describe('difference', () => {
  it('cuts the overlay out of the input and keeps the input attributes', () => {
    const out = differenceFeatures(
      [poly([square(0, 0, 10, 10)], { id: 'a' })],
      [poly([square(5, 0, 15, 10)], { id: 'b' })]
    );
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(50, 6);
    expect(out[0].properties).toEqual({ id: 'a' });
  });

  it('subtracts every overlay feature that reaches the input, in one pass', () => {
    const out = differenceFeatures(
      [poly([square(0, 0, 10, 10)])],
      [poly([square(0, 0, 2, 10)]), poly([square(8, 0, 10, 10)])]
    );
    expect(coveredArea(out[0].geometry)).toBeCloseTo(60, 6);
  });

  it('leaves the input alone when nothing overlaps it', () => {
    const out = differenceFeatures([poly([square(0, 0, 10, 10)])], [poly([square(50, 50, 60, 60)])]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(100, 6);
  });

  it('drops points inside the overlay and cuts lines at its boundary', () => {
    const cutter = [poly([square(0, 0, 10, 10)])];
    expect(differenceFeatures([point(5, 5), point(50, 50)], cutter)).toHaveLength(1);
    const lines = differenceFeatures([line([[-5, 5], [15, 5]] as Coord[])], cutter);
    expect(lines).toHaveLength(1);
    const runs = (lines[0].geometry as any).coordinates;
    expect(runs).toEqual([[[-5, 5], [0, 5]], [[10, 5], [15, 5]]]);
  });
});

describe('symmetrical difference', () => {
  it('keeps both exclusive parts and drops the overlap', async () => {
    const out = await symmetricalDifferenceFeatures(
      [poly([square(0, 0, 10, 10)], { a: 1 })],
      [poly([square(5, 5, 15, 15)], { b: 2 })]
    );
    expect(out).toHaveLength(2);
    expect(out.every(f => coveredArea(f.geometry) === 75)).toBe(true);
    expect(out.map(f => f.properties.source_layer).sort()).toEqual(['input', 'overlay']);
    expect(out.find(f => f.properties.source_layer === 'input')!.properties).toEqual({
      a: 1, b: null, source_layer: 'input',
    });
  });
});

describe('mergeOverlayProperties', () => {
  it('suffixes collisions instead of overwriting', () => {
    expect(mergeOverlayProperties({ name: 'A', x: 1 }, { name: 'B', y: 2 }))
      .toEqual({ name: 'A', x: 1, name_2: 'B', y: 2 });
    expect(mergeOverlayProperties({ name: 'A', name_2: 'kept' }, { name: 'B' }))
      .toEqual({ name: 'A', name_2: 'kept', name_3: 'B' });
  });
});

// ---------------------------------------------------------------------------
// Centroid
// ---------------------------------------------------------------------------

describe('centroid', () => {
  it('uses the area centroid of a polygon', () => {
    const out = centroidFeatures([poly([square(0, 0, 10, 10)])]);
    expect(out[0].geometry).toEqual({ type: 'Point', coordinates: [5, 5] });
  });

  it('subtracts holes, so the centroid moves away from them', () => {
    const withHole = centroidFeatures([poly([square(0, 0, 10, 10), square(6, 6, 9, 9)])]);
    const without = centroidFeatures([poly([square(0, 0, 10, 10)])]);
    const c = (withHole[0].geometry as any).coordinates as Coord;
    const c0 = (without[0].geometry as any).coordinates as Coord;
    expect(c0).toEqual([5, 5]);
    // (5·100 − 7.5·9) / 91 — away from the hole, not the average of the rings.
    expect(c[0]).toBeCloseTo(432.5 / 91, 9);
    expect(c[1]).toBeCloseTo(432.5 / 91, 9);
  });

  it('weights a line by segment length, not by vertex count', () => {
    const out = centroidFeatures([line([[0, 0], [10, 0], [10, 10]] as Coord[])]);
    expect((out[0].geometry as any).coordinates).toEqual([7.5, 2.5]);
  });

  it('averages multipoints and weights multipolygon parts by area', () => {
    const mp = centroidFeatures([{ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[0, 0], [4, 2]] as Coord[] }, properties: {} }]);
    expect((mp[0].geometry as any).coordinates).toEqual([2, 1]);
    const multi = centroidFeatures([{
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 10, 10)], [square(100, 100, 110, 110)]] },
      properties: {},
    }]);
    expect((multi[0].geometry as any).coordinates).toEqual([55, 55]);
  });

  it('copies properties onto every point', () => {
    const out = centroidFeatures([poly([square(0, 0, 1, 1)], { id: 7 })]);
    expect(out[0].properties).toEqual({ id: 7 });
  });
});

// ---------------------------------------------------------------------------
// Convex hull
// ---------------------------------------------------------------------------

describe('convex hull', () => {
  it('encloses every vertex, ignoring interior ones', () => {
    const hull = convexHullFeature([poly([square(0, 0, 10, 10)]), point(5, 5)]);
    expect(hull?.geometry?.type).toBe('Polygon');
    expect(coveredArea(hull?.geometry ?? null)).toBeCloseTo(100, 6);
  });

  it('degrades to a point or a line', () => {
    expect(convexHullFeature([point(1, 2)])?.geometry?.type).toBe('Point');
    const two = convexHullFeature([point(0, 0), point(3, 4)]);
    expect(two?.geometry?.type).toBe('LineString');
    const collinear = convexHullFeature([point(0, 0), point(5, 0), point(10, 0)]);
    expect(collinear?.geometry?.type).toBe('LineString');
    expect(convexHullFeature([])).toBeNull();
  });

  /**
   * `convexHullFeature` is the whole-layer primitive; the tool defaults to
   * `convexHullFeatures` (one hull per feature, QGIS semantics), tested below.
   */
  it('hulls the whole layer and drops attributes when asked to', () => {
    const hull = convexHullFeature([poly([square(0, 0, 1, 1)], { id: 'a' }), poly([square(100, 100, 101, 101)], { id: 'b' })]);
    expect(hull).not.toBeNull();
    expect(coveredArea(hull!.geometry)).toBeCloseTo(201, 6);
    expect(hull!.properties).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

describe('distance', () => {
  it('reports 0 for overlapping polygons instead of a boundary distance', () => {
    const cp = geomClosestPoints(
      { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] },
      { type: 'Polygon', coordinates: [square(5, 5, 15, 15)] }
    );
    expect(cp.overlapping).toBe(true);
    expect(cp.mapUnits).toBe(0);
    expect(cp.meters).toBe(0);
  });

  it('reports 0 for a point inside a polygon', () => {
    const cp = geomClosestPoints(
      { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] },
      { type: 'Point', coordinates: [5, 5] as Coord }
    );
    expect(cp.overlapping).toBe(true);
    expect(cp.mapUnits).toBe(0);
  });

  it('measures point-to-polygon and line-to-line exactly', () => {
    const p2a = geomClosestPoints(
      { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] },
      { type: 'Point', coordinates: [13, 5] as Coord }
    );
    expect(p2a.mapUnits).toBeCloseTo(3, 9);
    expect(p2a.onA).toEqual([10, 5]);
    expect(p2a.onB).toEqual([13, 5]);

    const l2l = geomClosestPoints(
      { type: 'LineString', coordinates: [[0, 0], [10, 0]] as Coord[] },
      { type: 'LineString', coordinates: [[0, 4], [10, 4]] as Coord[] }
    );
    expect(l2l.mapUnits).toBeCloseTo(4, 9);
    expect(l2l.overlapping).toBe(false);
  });

  it('measures a point inside a polygon hole to the hole boundary, not as 0', () => {
    // Regression: containment used a per-ring ray cast, so a point in the middle
    // of a donut hole counted as "inside" and reported distance 0.
    const cp = geomClosestPoints(
      { type: 'Point', coordinates: [5, 5] as Coord },
      { type: 'Polygon', coordinates: donutRings() }
    );
    expect(cp.overlapping).toBe(false);
    // The hole is 3..7, so its edge is 2 units from the centre — not the shell's 5.
    expect(cp.mapUnits).toBeCloseTo(2, 6);
  });

  it('still reports 0 for a point genuinely inside the material', () => {
    const cp = geomClosestPoints(
      { type: 'Point', coordinates: [1, 1] as Coord },
      { type: 'Polygon', coordinates: donutRings() }
    );
    expect(cp.overlapping).toBe(true);
    expect(cp.mapUnits).toBe(0);
  });

  it('measures ground metres, not raw map units', () => {
    const cp = geomClosestPoints(
      { type: 'Point', coordinates: [0, 0] as Coord },
      { type: 'Point', coordinates: [1, 0] as Coord }
    );
    expect(cp.mapUnits).toBe(1);
    // 1 EPSG:3857 unit at the equator is R_mean/R_mercator metres on the ground.
    expect(cp.meters).toBeCloseTo(6371008.8 / 6378137, 9);
  });

  it('reports every pair with the requested display unit', () => {
    const out = computeDistances(
      [point(0, 0), point(1000, 0)],
      [point(10, 0), point(20, 0)],
      'kilometers'
    );
    expect(out).toHaveLength(4);
    expect(out[0].featureA_index).toBe(0);
    expect(out[0].featureB_index).toBe(0);
    expect(out[0].distance_display).toBeCloseTo(out[0].distance_meters / 1000, 9);
    expect(out[0].unit).toBe('kilometers');
    expect(out.map(r => r.distance_map_units)).toEqual([
      expect.closeTo(10, 6), expect.closeTo(20, 6), expect.closeTo(990, 6), expect.closeTo(980, 6),
    ]);
  });

  it('the async variant matches the sync one and cancels', async () => {
    const a = [point(0, 0), point(50, 50)];
    const b = [point(10, 0)];
    const sync = computeDistances(a, b, 'meters');
    const async = await computeDistancesAsync(a, b, 'meters');
    expect(async).toHaveLength(sync.length);
    const token = createProgress();
    token.cancelled = true;
    expect(await computeDistancesAsync(a, b, 'meters', token)).toEqual([]);
  });

  it('converts units', () => {
    expect(toMeters(1, 'kilometers')).toBe(1000);
    expect(toMeters(1, 'miles')).toBeCloseTo(1609.344, 9);
    expect(toMeters(1, 'feet')).toBeCloseTo(0.3048, 9);
  });
});

// ---------------------------------------------------------------------------
// Eliminate selected polygons
// ---------------------------------------------------------------------------

describe('eliminate', () => {
  const row = () => [
    poly([square(0, 0, 10, 10)], { id: 'L' }),
    poly([square(10, 0, 20, 10)], { id: 'M' }),
    poly([square(20, 0, 30, 10)], { id: 'R' }),
  ];

  it('absorbs the selection into a neighbour without losing area', () => {
    const out = eliminateSelectedPolygonsDetailed(row(), new Set([1]), 'largestArea');
    expect(out.droppedIndices).toEqual([]);
    expect(out.features).toHaveLength(2);
    const areas = out.features.map(f => coveredArea(f.geometry)).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(100, 6);
    expect(areas[1]).toBeCloseTo(200, 6); // regression: the old splice gave 150
    expect(out.features.map(f => f.properties.id).sort()).toEqual(['L', 'R']);
  });

  it('follows the chosen neighbour strategy', () => {
    const layers = () => [
      poly([square(0, 0, 10, 10)], { id: 'L' }),      // area 100
      poly([square(10, 0, 20, 10)], { id: 'M' }),     // selected
      poly([square(20, 0, 60, 10)], { id: 'R' }),     // area 400
    ];
    const largest = eliminateSelectedPolygonsDetailed(layers(), new Set([1]), 'largestArea');
    expect(largest.features.find(f => f.properties.id === 'R')!.geometry && coveredArea(largest.features.find(f => f.properties.id === 'R')!.geometry)).toBeCloseTo(500, 6);
    expect(coveredArea(largest.features.find(f => f.properties.id === 'L')!.geometry)).toBeCloseTo(100, 6);

    const smallest = eliminateSelectedPolygonsDetailed(layers(), new Set([1]), 'smallestArea');
    expect(coveredArea(smallest.features.find(f => f.properties.id === 'L')!.geometry)).toBeCloseTo(200, 6);
    expect(coveredArea(smallest.features.find(f => f.properties.id === 'R')!.geometry)).toBeCloseTo(400, 6);
  });

  it('prefers the neighbour sharing the longest boundary', () => {
    // R touches M only at a single vertex-matched edge of length 0 (its left edge
    // runs past M's), so only L shares real boundary — but R is bigger.
    const layers = [
      poly([square(0, 0, 10, 10)], { id: 'L' }),
      poly([square(10, 0, 20, 10)], { id: 'M' }),
      poly([square(20, 0, 30, 20)], { id: 'R' }),
    ];
    const out = eliminateSelectedPolygonsDetailed(layers, new Set([1]), 'largestCommonBoundary');
    expect(out.droppedIndices).toEqual([]);
    expect(coveredArea(out.features.find(f => f.properties.id === 'L')!.geometry)).toBeCloseTo(200, 6);
    expect(coveredArea(out.features.find(f => f.properties.id === 'R')!.geometry)).toBeCloseTo(200, 6);
  });

  it('reports a selection it could not absorb instead of losing it silently', () => {
    const isolated = eliminateSelectedPolygonsDetailed(
      [poly([square(0, 0, 1, 1)], { id: 'a' }), poly([square(500, 500, 501, 501)], { id: 'b' })],
      new Set([0])
    );
    expect(isolated.droppedIndices).toEqual([0]);
    expect(isolated.features).toHaveLength(1);
    expect(isolated.features[0].properties.id).toBe('b');
  });

  it('is a no-op without a selection, and the async variant agrees', async () => {
    expect(eliminateSelectedPolygons(row(), new Set())).toHaveLength(3);
    const async = await eliminateSelectedPolygonsAsync(row(), new Set([1]), 'largestArea');
    const sync = eliminateSelectedPolygonsDetailed(row(), new Set([1]), 'largestArea');
    expect(async.features).toHaveLength(sync.features.length);
    expect(async.droppedIndices).toEqual(sync.droppedIndices);

    const token = createProgress();
    token.cancelled = true;
    const cancelled = await eliminateSelectedPolygonsAsync(row(), new Set([1]), 'largestArea', token);
    expect(cancelled.features).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Check validity
// ---------------------------------------------------------------------------

describe('check validity', () => {
  it('accepts a clean polygon and a point', () => {
    const out = checkValidity([poly([square(0, 0, 10, 10)]), point(1, 1)]);
    expect(out.map(r => [r.valid, r.reason])).toEqual([[true, 'Valid.'], [true, 'Valid.']]);
  });

  it('flags the three ring defects it knows about', () => {
    const out = checkValidity([
      poly([[[0, 0], [10, 0], [10, 10], [0, 10]] as Ring]),              // not closed
      poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]] as Ring]),       // bowtie
      poly([[[0, 0], [1, 0], [0, 0]] as Ring]),                           // too few points
    ]);
    expect(out[0].reason).toBe('Ring is not closed.');
    expect(out[1].reason).toMatch(/Ring self-intersection at 5 5\./);
    expect(out[1].errors[0].location).toEqual([5, 5]);
    expect(out[2].reason).toMatch(/fewer than 4 points/);
    expect(out.every(r => !r.valid)).toBe(true);
  });

  it('tolerates a ring that is closed to within the dataset tolerance', () => {
    const nearClosed = poly([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 1e-9]] as Ring]);
    expect(checkValidity([nearClosed])[0].valid).toBe(true);
  });

  it('names the offending ring of a donut or multipart feature', () => {
    const out = checkValidity([poly([square(0, 0, 10, 10), [[0, 0], [1, 1], [1, 0]] as Ring])]);
    expect(out[0].valid).toBe(false);
    expect(out[0].errors[0]).toMatchObject({ code: 'too-few-points', part: 1, ring: 2 });
    expect(out[0].reason).toMatch(/Inner ring has fewer than 4 points/);
  });

  it('detects the GEOS error classes it used to miss', () => {
    const out = checkValidity([
      poly([square(0, 0, 10, 10), square(100, 100, 110, 110)]),                 // hole outside shell
      poly([square(0, 0, 20, 20), reversedRing(square(2, 2, 18, 18)), reversedRing(square(5, 5, 8, 8))]), // nested holes
      poly([square(0, 0, 10, 10), reversedRing(square(0, 0, 10, 10))]),          // duplicate ring
      poly([[[0, 0], [NaN, 1], [10, 10], [0, 10], [0, 0]] as Ring]),             // NaN coordinate
    ]);
    expect(out.map(r => r.valid)).toEqual([false, false, false, false]);
    expect(out[0].errors.map(e => e.code)).toContain('hole-outside-shell');
    expect(out[1].errors.map(e => e.code)).toContain('nested-holes');
    expect(out[2].errors.map(e => e.code)).toContain('duplicate-ring');
    expect(out[3].errors.map(e => e.code)).toContain('nan-coordinate');
  });

  it('reports every reason for one feature, and can emit them as an error-point layer', () => {
    const out = checkValidity([
      poly([square(0, 0, 10, 10), square(100, 100, 110, 110)]),
      poly([square(0, 0, 1, 1)]),
    ]);
    expect(out[0].errors.length).toBeGreaterThan(0);
    const points = validityErrorPoints(out);
    expect(points.length).toBeGreaterThan(0);
    expect(points.every(f => f.geometry?.type === 'Point')).toBe(true);
    expect(points[0].properties.feature_index).toBe(1);
    expect(typeof points[0].properties.error).toBe('string');
  });

  it('flags null geometry', () => {
    const out = checkValidity([{ type: 'Feature', geometry: null, properties: {} }]);
    expect(out[0]).toMatchObject({ valid: false, reason: 'Null geometry.' });
  });
});

// ---------------------------------------------------------------------------
// Make valid
// ---------------------------------------------------------------------------

describe('make valid', () => {
  it('closes rings, drops duplicates and fixes orientation', () => {
    const open = poly([[[0, 0], [10, 0], [10, 10], [0, 10]] as Ring]);
    const out = makeValid([open]);
    expect(checkValidity(out)[0].valid).toBe(true);
    const rings = (out[0].geometry as any).coordinates as Ring[];
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  it('splits a bowtie into both lobes instead of keeping the largest', () => {
    const bowtie = poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]] as Ring]);
    expect(checkValidity([bowtie])[0].valid).toBe(false);
    const out = makeValid([bowtie]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    expect(coveredArea(out[0].geometry)).toBeCloseTo(50, 6);
    // Two triangles that touch at a point are a valid multipolygon: their
    // interiors are disjoint, which is all the OGC asks.
    expect(checkValidity(out)[0].valid).toBe(true);
  });

  it('passes non-polygonal geometry through untouched', () => {
    const input = point(1, 2, { a: 1 });
    expect(makeValid([input])[0].geometry).toEqual(input.geometry);
  });

  it('promotes a hole that sits outside its shell instead of dropping it', () => {
    const out = makeValid([poly([square(0, 0, 10, 10), square(20, 20, 25, 25)])]);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    expect(coveredArea(out[0].geometry)).toBeCloseTo(125, 6);
    expect(checkValidity(out)[0].valid).toBe(true);
  });

  it('measures was_invalid instead of stamping it on every feature', () => {
    const valid = makeValid([poly([square(0, 0, 1, 1)], { id: 1 })]);
    expect(valid[0].properties).toEqual({ id: 1, was_invalid: false, validity_errors: 0 });

    const bowtie = makeValid([poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]] as Ring])]);
    expect(bowtie[0].properties.was_invalid).toBe(true);
    expect(bowtie[0].properties.validity_errors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Remaining geometry tools
// ---------------------------------------------------------------------------

describe('collect geometries', () => {
  it('merges same-type features into one multipart feature', () => {
    const out = collectGeometries([poly([square(0, 0, 1, 1)], { a: 1 }), poly([square(5, 5, 6, 6)], { b: 2 })]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    expect(out[0].properties).toEqual({});
  });

  it('emits one feature per geometry type when the input is mixed', () => {
    // A single geometry of a type stays singular; only 2+ become a Multi*.
    const out = collectGeometries([point(0, 0), line([[0, 0], [1, 1]] as Coord[]), poly([square(0, 0, 1, 1)])]);
    expect(out.map(f => f.geometry?.type).sort()).toEqual(['LineString', 'Point', 'Polygon']);
    const multi = collectGeometries([point(0, 0), point(1, 1), line([[0, 0], [1, 1]] as Coord[])]);
    expect(multi.map(f => f.geometry?.type).sort()).toEqual(['LineString', 'MultiPoint']);
  });

  it('does not collapse a single geometry to a multi type', () => {
    expect(collectGeometries([point(1, 1)])[0].geometry?.type).toBe('Point');
  });
});

describe('densify by count', () => {
  it('inserts count vertices per segment, splitting it into count+1 parts', () => {
    const out = densifyByCount([line([[0, 0], [10, 0]] as Coord[])], 3);
    expect((out[0].geometry as any).coordinates).toEqual([[0, 0], [2.5, 0], [5, 0], [7.5, 0], [10, 0]]);
  });

  it('densifies every ring of a polygon and keeps properties', () => {
    const out = densifyByCount([poly([square(0, 0, 10, 10)], { id: 1 })], 1);
    const rings = (out[0].geometry as any).coordinates as Ring[];
    expect(rings[0]).toHaveLength(9); // 4 edges × 2 + closing vertex
    expect(out[0].properties).toEqual({ id: 1 });
  });

  it('is a no-op below one vertex per segment', () => {
    const input = line([[0, 0], [10, 0]] as Coord[]);
    expect((densifyByCount([input], 0)[0].geometry as any).coordinates).toHaveLength(2);
  });
});

describe('simplify', () => {
  const zigzag = () => line([[0, 0], [5, 0.4], [10, 0], [15, 0.4], [20, 0]] as Coord[]);

  it('collapses wobble above the tolerance', () => {
    expect((simplifyFeatures([zigzag()], 1)[0].geometry as any).coordinates).toEqual([[0, 0], [20, 0]]);
  });

  it('keeps the shape below the tolerance', () => {
    expect((simplifyFeatures([zigzag()], 0.001)[0].geometry as any).coordinates).toHaveLength(5);
  });

  it('keeps the original ring when simplification would destroy it', () => {
    const out = simplifyFeatures([poly([square(0, 0, 1, 1)])], 100);
    expect((out[0].geometry as any).coordinates[0].length).toBeGreaterThanOrEqual(4);
  });

  /** Raw map units remain the default; `groundUnits` opts into the Mercator scale. */
  it('reads the tolerance as raw map units unless told otherwise', () => {
    const atEquator = simplifyFeatures([zigzag()], 0.5)[0].geometry as any;
    expect(atEquator.coordinates.length).toBe(2);
    const same = simplifyFeatures([zigzag()], 0.5, { groundUnits: true })[0].geometry as any;
    expect(same.coordinates.length).toBe(2); // cosh(0) = 1 at the equator
  });
});

describe('vertices, parts and type conversion', () => {
  it('extracts hole vertices too, tagged with their part and ring', () => {
    // Regression: holes used to be skipped entirely.
    const donut = extractVertices([poly(donutRings())]);
    expect(donut).toHaveLength(10);
    expect(donut[0].properties).toMatchObject({ vertex_index: 0, vertex_part: 1, vertex_ring: 1, vertex_part_index: 0, distance: 0 });
    // The hole's first vertex is index 5, ring 2, and its 90° corners are tagged.
    expect(donut[5].properties).toMatchObject({ vertex_index: 5, vertex_ring: 2, vertex_part_index: 0 });
    expect(donut[1].properties.angle).toBe(90);

    const out = extractVertices([poly([square(0, 0, 1, 1)], { id: 3 })]);
    expect(out.every(f => f.geometry?.type === 'Point')).toBe(true);
    expect(out[0].properties).toMatchObject({ id: 3, vertex_index: 0 });
  });

  it('can skip the duplicated closing vertex and can leave the indices off', () => {
    expect(extractVertices([poly([square(0, 0, 1, 1)])], { skipClosingVertex: true })).toHaveLength(4);
    const plain = extractVertices([poly([square(0, 0, 1, 1)], { id: 3 })], {
      addIndices: false,
      addDistanceAndAngle: false,
    });
    expect(plain[0].properties).toEqual({ id: 3 });
  });

  it('splits multipart features, copying properties onto every part', () => {
    const input: GeoFeature = {
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] },
      properties: { id: 1 },
    };
    const out = multipartToSingleparts([input]);
    expect(out).toHaveLength(2);
    expect(out.every(f => f.geometry?.type === 'Polygon')).toBe(true);
    expect(out[1].properties).toEqual({ id: 1 });
  });

  it('passes single-part and null geometry through', () => {
    const input = point(1, 1, { a: 1 });
    expect(multipartToSingleparts([input])[0].geometry).toEqual(input.geometry);
    const nul: GeoFeature = { type: 'Feature', geometry: null, properties: {} };
    expect(multipartToSingleparts([nul])[0].geometry).toBeNull();
  });

  it('keeps every ring of a feature in one multipart line, like QGIS/ST_Boundary', () => {
    const out = polygonsToLines([poly(donutRings(), { id: 9 })]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiLineString');
    expect((out[0].geometry as any).coordinates).toHaveLength(2);
    expect((out[0].geometry as any).coordinates[0]).toHaveLength(4); // closing vertex dropped
    expect(out[0].properties).toEqual({ id: 9 });
  });

  it('emits one line per ring when asked', () => {
    const out = polygonsToLines([poly(donutRings(), { id: 9 })], { perRing: true });
    expect(out).toHaveLength(2);
    expect(out.every(f => f.geometry?.type === 'LineString')).toBe(true);
    expect(out[1].properties).toEqual({ id: 9 });
  });

  it('converts closed lines and skips open ones', () => {
    expect(linesToPolygons([line([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as Coord[])])).toHaveLength(1);
    expect(linesToPolygons([line([[0, 0], [10, 0], [10, 10], [0, 10]] as Coord[])])).toHaveLength(0);
  });

  it('closes a line that is closed to within tolerance', () => {
    const out = linesToPolygons([line([[0, 0], [10, 0], [10, 10], [0, 10], [0, 1e-9]] as Coord[])]);
    expect(out).toHaveLength(1);
    const ring = (out[0].geometry as any).coordinates[0] as Ring;
    // The sub-tolerance gap is closed exactly, so the ring is bit-exact closed.
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  it('handles each part of a multilinestring', () => {
    const input: GeoFeature = {
      type: 'Feature',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as Coord[],
          [[0, 0], [1, 0], [1, 1]] as Coord[],
        ],
      },
      properties: {},
    };
    expect(linesToPolygons([input])).toHaveLength(1);
  });
});

describe('voronoi', () => {
  /** Ray-casting point-in-polygon, independent of the module under test. */
  function contains(ring: Ring, p: Coord): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const seeds = () => [point(0, 0, { n: 'a' }), point(100, 0, { n: 'b' }), point(0, 100, { n: 'c' }), point(100, 100, { n: 'd' })];

  it('gives each seed the cell that actually contains it', () => {
    const cells = voronoiPolygons(seeds());
    expect(cells).toHaveLength(4);
    const expected = seeds().map(f => (f.geometry as any).coordinates as Coord);
    cells.forEach((cell, i) => {
      const ring = ((cell.geometry as any).coordinates as Ring[])[0];
      // Each cell must contain its own seed and none of the others — this is the
      // attribution the inverted half-plane test used to get wrong.
      expected.forEach((seed, k) => {
        expect(contains(ring, seed)).toBe(k === i);
      });
    });
  });

  it('splits cells around an off-centre seed', () => {
    // Regression: the half-plane test used to be inverted, so an asymmetric seed
    // lost its cell entirely and every other cell belonged to its mirror image.
    const cells = voronoiPolygons([...seeds(), point(50, 50, { n: 'e' })]);
    expect(cells).toHaveLength(5);
    const areas = cells.map(c => coveredArea(c.geometry)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(5000, 6);   // the diamond around the centre seed
    expect(areas[4]).toBeCloseTo(8750, 6);   // each corner keeps 10000 − 1250
  });

  it('honours padFraction and copyAttributes', () => {
    const noPad = voronoiPolygons(seeds(), { padFraction: 0 });
    expect(noPad).toHaveLength(4);
    expect(coveredArea(noPad[0].geometry)).toBeCloseTo(2500, 6);
    expect(voronoiPolygons(seeds())[0].properties).toEqual({});
    expect(voronoiPolygons(seeds(), { copyAttributes: true })[1].properties).toEqual({ n: 'b' });
  });

  it('needs at least two seeds', () => {
    expect(voronoiPolygons([point(0, 0)])).toEqual([]);
  });

  it('the async variant matches the sync one', async () => {
    const sync = voronoiPolygons(seeds());
    const async = await voronoiPolygonsAsync(seeds());
    expect(async).toHaveLength(sync.length);
    const token = createProgress();
    token.cancelled = true;
    expect(await voronoiPolygonsAsync(seeds(), {}, token)).toEqual([]);
  });
});

describe('delaunay', () => {
  it('triangulates a square into two triangles', () => {
    const out = delaunayTriangulation([point(0, 0), point(100, 0), point(0, 100), point(100, 100)]);
    expect(out).toHaveLength(2);
    expect(out.every(f => f.geometry?.type === 'Polygon')).toBe(true);
    const total = out.reduce((a, f) => a + coveredArea(f.geometry), 0);
    expect(total).toBeCloseTo(10000, 6);
  });

  it('uses an interior seed and never emits super-triangle geometry', () => {
    const out = delaunayTriangulation([point(0, 0), point(100, 0), point(0, 100), point(100, 100), point(50, 50)]);
    expect(out).toHaveLength(4);
    const total = out.reduce((a, f) => a + coveredArea(f.geometry), 0);
    expect(total).toBeCloseTo(10000, 6);
    for (const f of out) {
      const ring = (f.geometry as any).coordinates[0] as Ring;
      for (const c of ring) {
        expect(Math.abs(c[0])).toBeLessThan(1e5);
        expect(Math.abs(c[1])).toBeLessThan(1e5);
      }
    }
  });

  it('needs three distinct points', () => {
    expect(delaunayTriangulation([point(0, 0), point(1, 1)])).toEqual([]);
    expect(delaunayTriangulation([point(0, 0), point(0, 0), point(0, 0)])).toEqual([]);
  });

  it('the async variant matches the sync one and cancels', async () => {
    const seeds = [point(0, 0), point(100, 0), point(0, 100), point(100, 100), point(50, 50)];
    expect(await delaunayTriangulationAsync(seeds)).toHaveLength(delaunayTriangulation(seeds).length);
    const token = createProgress();
    token.cancelled = true;
    expect(await delaunayTriangulationAsync(seeds, { progress: token })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Add geometry attributes (geodesic, Stage 1.4)
// ---------------------------------------------------------------------------

describe('add geometry attributes', () => {
  const LON = 138.6;
  const LAT = -34.93;
  const D = 0.01;
  const mercBox = (lon: number, lat: number, d: number): Ring => ([
    [lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat],
  ] as [number, number][]).map(c => lonLatToMercator(c as [number, number]));

  const shell = mercBox(LON, LAT, D);
  const hole = mercBox(LON + 0.003, LAT + 0.003, 0.004);

  it('subtracts holes and measures on the ground, like the measure tool', () => {
    const out = addGeometryAttributes(
      [poly([shell, hole])],
      { addArea: true, addLength: true, addPerimeter: true, addX: false, addY: false }
    );
    const props = out[0].properties;
    expect(props.area).toBeCloseTo(groundPolygonArea([{ shell, holes: [hole] }]), 6);
    expect(props.perimeter).toBeCloseTo(groundPolygonPerimeter([{ shell, holes: [hole] }]), 6);
    expect(props.length).toBeCloseTo(props.perimeter, 6);

    // Regression: the planar shoelace version *added* hole areas and reported
    // EPSG:3857 units as square metres.
    const noHole = addGeometryAttributes([poly([shell])], {
      addArea: true, addLength: false, addPerimeter: false, addX: false, addY: false,
    })[0].properties.area;
    expect(props.area).toBeLessThan(noHole);
    expect(noHole - props.area).toBeCloseTo(groundPolygonArea([{ shell, holes: [] }]) - groundPolygonArea([{ shell, holes: [hole] }]), 6);
    // A 0.01° × 0.01° box at 35° S is ~0.913 km × 1.112 km; minus the 0.004°
    // hole that is ~0.85 km². The planar shoelace over-reported this by sec²(φ)
    // ≈ 1.5× before it was divided out at a single mean latitude.
    expect(props.area).toBeGreaterThan(8.4e5);
    expect(props.area).toBeLessThan(8.7e5);
  });

  it('measures line length along the ground', () => {
    const coords = mercBox(LON, LAT, D).slice(0, 2);
    const out = addGeometryAttributes([line(coords)], {
      addArea: true, addLength: true, addPerimeter: false, addX: false, addY: false,
    });
    expect(out[0].properties.length).toBeCloseTo(groundLineLength(coords), 6);
    expect(out[0].properties.area).toBe(0);
  });

  it('only writes the attributes that were asked for', () => {
    const out = addGeometryAttributes([poly([shell])], {
      addArea: false, addLength: false, addPerimeter: false, addX: true, addY: false,
    });
    expect(Object.keys(out[0].properties)).toEqual(['x']);
  });

  it('reports x/y in degrees by default, like QGIS Add Geometry Attributes', () => {
    const out = addGeometryAttributes([poly([shell])], {
      addArea: false, addLength: false, addPerimeter: false, addX: true, addY: true,
    });
    expect(out[0].properties.x).toBeCloseTo(LON + D / 2, 6);
    // The projected centroid of a Mercator box is not the geographic mid-latitude,
    // but it must land inside the box.
    expect(out[0].properties.y).toBeGreaterThan(LAT);
    expect(out[0].properties.y).toBeLessThan(LAT + D);
  });

  it('keeps map units on request and can add a vertex count', () => {
    const out = addGeometryAttributes([poly([shell, hole])], {
      addArea: false, addLength: false, addPerimeter: false, addX: true, addY: true,
      xyInDegrees: false, addVertexCount: true,
    });
    expect(Math.abs(out[0].properties.x)).toBeGreaterThan(1e6);
    expect(out[0].properties.y).toBeLessThan(0);
    expect(out[0].properties.vertex_count).toBe(10);
  });

  it('keeps existing properties and the geometry', () => {
    const input = poly([shell], { id: 5 });
    const out = addGeometryAttributes([input], {
      addArea: true, addLength: false, addPerimeter: false, addX: false, addY: false,
    });
    expect(out[0].properties.id).toBe(5);
    expect(out[0].geometry).toEqual(input.geometry);
  });
});

// ---------------------------------------------------------------------------
// Manage layers
// ---------------------------------------------------------------------------

describe('merge vector layers', () => {
  it('unions the schema and fills missing fields', () => {
    const out = mergeVectorLayers([
      [point(0, 0, { a: 1, shared: 'x' })],
      [point(1, 1, { b: 2, shared: 'y' })],
    ]);
    expect(out).toHaveLength(2);
    expect(Object.keys(out[0].properties)).toEqual(['a', 'shared', 'b']);
    expect(out[0].properties).toEqual({ a: 1, shared: 'x', b: null });
    expect(out[1].properties).toEqual({ a: null, shared: 'y', b: 2 });
  });

  it('serialises the missing fields as null', () => {
    const out = mergeVectorLayers([[point(0, 0, { a: 1 })], [point(1, 1, { b: 2 })]]);
    expect(JSON.parse(toGeoJSONString(out)).features[0].properties.b).toBeNull();
  });

  it('copies a single layer and tolerates an empty input', () => {
    expect(mergeVectorLayers([])).toEqual([]);
    const single = mergeVectorLayers([[point(0, 0, { a: 1 })]]);
    expect(single[0].properties).toEqual({ a: 1 });
  });

  it('preserves null geometry', () => {
    const out = mergeVectorLayers([[{ type: 'Feature', geometry: null, properties: {} }, point(0, 0)]]);
    expect(out[0].geometry).toBeNull();
  });
});

describe('split vector layer', () => {
  it('groups by field value and names the null group', () => {
    const out = splitVectorLayer([
      point(0, 0, { kind: 'a' }), point(1, 1, { kind: 'b' }), point(2, 2, { kind: 'a' }),
      point(3, 3, { kind: null }), point(4, 4, {}),
    ], 'kind');
    const names = out.map(r => r.name).sort();
    expect(names).toEqual(['(no value)', 'a', 'b']);
    expect(out.find(r => r.name === 'a')!.features).toHaveLength(2);
    expect(out.find(r => r.name === '(no value)')!.features).toHaveLength(2);
  });

  it('stringifies numbers and objects so they group predictably', () => {
    const out = splitVectorLayer([point(0, 0, { v: 1 }), point(1, 1, { v: '1' }), point(2, 2, { v: { k: 1 } })], 'v');
    // The object group is stringified and then sanitised for use as a layer name.
    expect(out.map(r => r.name).sort()).toEqual(['1', '{ k 1}']);
  });

  it('sanitises layer names so a value cannot break the download filename', () => {
    expect(sanitiseLayerName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(sanitiseLayerName('   spaced   ')).toBe('spaced');
    expect(sanitiseLayerName('///')).toBe('(unnamed)');
    expect(sanitiseLayerName('')).toBe('(unnamed)');
    expect(sanitiseLayerName('x'.repeat(200))).toHaveLength(120);
    const out = splitVectorLayer([point(0, 0, { v: 'bad/name' })], 'v');
    expect(out[0].name).toBe('bad name');
  });

  it('groups with the same rule as dissolve', () => {
    expect(featureGroupKey({ a: 1, b: null }, ['a', 'b'])).toBe('1\u0000__null__');
    expect(featureGroupKey({ a: 1 }, [])).toBe('');
  });

  it('copies features rather than aliasing them', () => {
    const input = point(0, 0, { kind: 'a' });
    const out = splitVectorLayer([input], 'kind');
    expect(out[0].features[0]).not.toBe(input);
    expect(out[0].features[0].properties).toEqual(input.properties);
  });
});

describe('remove selected features', () => {
  const layer = () => [point(0, 0, { i: 0 }), point(1, 1, { i: 1 }), point(2, 2, { i: 2 })];

  it('drops exactly the indexed features', () => {
    const out = removeSelectedFeatures(layer(), new Set([1]));
    expect(out.map(f => f.properties.i)).toEqual([0, 2]);
  });

  it('copies the layer when nothing is selected', () => {
    const input = layer();
    const out = removeSelectedFeatures(input, new Set());
    expect(out).toHaveLength(3);
    expect(out[0]).not.toBe(input[0]);
  });

  it('can empty a layer', () => {
    expect(removeSelectedFeatures(layer(), new Set([0, 1, 2]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OL ↔ GeoJSON bridge
// ---------------------------------------------------------------------------

describe('OL feature conversion', () => {
  /** Minimal stand-in for an ol/Feature. */
  function fakeOlFeature(type: string, coordinates: any, props: Record<string, any>) {
    return {
      getGeometry: () => ({ getType: () => type, getCoordinates: () => coordinates }),
      getProperties: () => ({ ...props, geometry: { getType: () => type, getCoordinates: () => coordinates } }),
    };
  }

  it('reads coordinates and strips the internal geometry property', () => {
    const out = olFeaturesToGeo([fakeOlFeature('Point', [1, 2], { name: 'p' })]);
    expect(out).toEqual([{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'p' } }]);
  });

  it('handles every supported geometry type and skips the rest', () => {
    const out = olFeaturesToGeo([
      fakeOlFeature('Polygon', [[[0, 0], [1, 0], [1, 1], [0, 0]]], {}),
      fakeOlFeature('MultiPolygon', [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], {}),
      fakeOlFeature('LineString', [[0, 0], [1, 1]], {}),
      fakeOlFeature('MultiLineString', [[[0, 0], [1, 1]]], {}),
      fakeOlFeature('MultiPoint', [[0, 0], [1, 1]], {}),
      fakeOlFeature('Circle', [0, 0], {}),
      { getGeometry: () => null, getProperties: () => ({}) },
    ]);
    expect(out.map(f => f.geometry?.type)).toEqual(['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'MultiPoint']);
  });

  it('writes a FeatureCollection', () => {
    const json = JSON.parse(toGeoJSONString([point(1, 2, { a: 1 })]));
    expect(json.type).toBe('FeatureCollection');
    expect(json.features).toHaveLength(1);
    expect(json.features[0].properties).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — per-feature convex hull, grouped collect, polygonize, point on
// surface, k-nearest distance, simplify methods, buffer layer options
// ---------------------------------------------------------------------------

describe('convex hull per feature (QGIS semantics)', () => {
  const features = () => [
    poly([square(0, 0, 10, 10)], { id: 'a' }),
    poly([square(100, 100, 110, 110)], { id: 'b' }),
  ];

  it('emits one hull per input feature and keeps its attributes', () => {
    const out = convexHullFeatures(features());
    expect(out).toHaveLength(2);
    expect(out.map(f => f.properties.id)).toEqual(['a', 'b']);
    expect(out.every(f => coveredArea(f.geometry) === 100)).toBe(true);
  });

  it('hulls a concave feature down to its convex envelope', () => {
    // The L's hull is the square minus the 6x6 corner triangle it does not reach.
    const lShape: Ring = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]] as Ring;
    const out = convexHullFeatures([poly([lShape], { id: 1 })]);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(82, 6);
  });

  it('still offers the whole-layer hull as an explicit mode', () => {
    const out = convexHullFeatures(features(), { wholeLayer: true });
    expect(out).toHaveLength(1);
    // One hull spanning both squares: (0,0),(10,0),(110,100),(110,110),(100,110),(0,10).
    expect(coveredArea(out[0].geometry)).toBeCloseTo(2100, 6);
    expect(out[0].properties).toEqual({});
  });

  it('degrades to a point or a line for a single feature', () => {
    expect(convexHullFeatures([point(1, 2)])[0].geometry?.type).toBe('Point');
    expect(convexHullFeatures([line([[0, 0], [5, 5]] as Coord[])])[0].geometry?.type).toBe('LineString');
  });
});

describe('collect geometries by field', () => {
  it('groups by field and keeps those attributes', () => {
    const out = collectGeometries([
      point(0, 0, { kind: 'a', n: 1 }),
      point(1, 1, { kind: 'b', n: 2 }),
      point(2, 2, { kind: 'a', n: 3 }),
    ], { fields: ['kind'] });
    expect(out).toHaveLength(2);
    const a = out.find(f => f.properties.kind === 'a')!;
    expect(a.geometry?.type).toBe('MultiPoint');
    expect((a.geometry as any).coordinates).toHaveLength(2);
    expect(a.properties).toEqual({ kind: 'a' });
  });

  it('still collects everything into one feature without a group field', () => {
    const out = collectGeometries([point(0, 0), point(1, 1)]);
    expect(out).toHaveLength(1);
    expect(out[0].properties).toEqual({});
  });
});

describe('polygonize', () => {
  it('builds the faces a line network encloses', () => {
    const out = polygonizeFeatures([
      line([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as Coord[]),
      line([[0, 5], [10, 5]] as Coord[]),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every(f => f.geometry?.type === 'Polygon')).toBe(true);
    expect(out.reduce((sum, f) => sum + coveredArea(f.geometry), 0)).toBeCloseTo(100, 6);
    expect(out[0].properties.face_index).toBe(1);
  });

  it('returns nothing for an open network', () => {
    expect(polygonizeFeatures([line([[0, 0], [10, 0]] as Coord[])])).toEqual([]);
  });
});

describe('point on surface', () => {
  it('puts the point inside a concave polygon where the centroid would fall out', () => {
    const cShape: Ring = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0]] as Ring;
    const out = pointsOnSurface([poly([cShape], { id: 7 })]);
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('Point');
    const p = (out[0].geometry as any).coordinates as Coord;
    // The centroid of a C is at x≈5, y=5 — outside the shape. The interior point is not.
    const centroidOut = centroidFeatures([poly([cShape])])[0];
    expect(centroidOut.geometry?.type).toBe('Point');
    expect(out[0].properties).toEqual({ id: 7 });
    expect(p[1]).not.toBeCloseTo((centroidOut.geometry as any).coordinates[1], 6);
  });

  it('never lands in a hole', () => {
    const out = pointsOnSurface([poly(donutRings())]);
    const p = (out[0].geometry as any).coordinates as Coord;
    const insideHole = p[0] > 3 && p[0] < 7 && p[1] > 3 && p[1] < 7;
    expect(insideHole).toBe(false);
  });
});

describe('nearest / k-nearest distance', () => {
  const hubs = () => [point(0, 0, { name: 'h1' }), point(1000, 0, { name: 'h2' })];
  const spokes = () => [point(10, 0), point(900, 0), point(500, 0)];

  it('finds the single nearest feature of the other layer', async () => {
    const out = await computeNearestDistances(spokes(), hubs(), 'meters', 1);
    expect(out).toHaveLength(3);
    expect(out.every(r => r.rank === 1)).toBe(true);
    expect(out[0].featureB_index).toBe(0);
    expect(out[1].featureB_index).toBe(1);
    // Ground metres are measured on the sphere (R = 6371008.8) while EPSG:3857
    // units assume R = 6378137, so 10 map units read as ~9.9888 m — the same
    // basis the measure tool uses.
    expect(out[0].distance_map_units).toBeCloseTo(10, 6);
    expect(out[0].distance_meters).toBeCloseTo(groundDistance([0, 0], [10, 0]), 9);
    expect(out[1].distance_map_units).toBeCloseTo(100, 6);
  });

  it('ranks the k nearest and stops early', async () => {
    const out = await computeNearestDistances([point(500, 0)], hubs(), 'meters', 2);
    expect(out).toHaveLength(2);
    expect(out.map(r => r.rank)).toEqual([1, 2]);
    expect(out.map(r => r.distance_map_units)).toEqual([500, 500]);
    expect(out.map(r => r.featureB_index)).toEqual([0, 1]);
  });

  it('writes the hub attributes back onto the input features', async () => {
    const a = spokes();
    const results = await computeNearestDistances(a, hubs(), 'kilometers', 1);
    const out = nearestAttributeFeatures(a, results);
    expect(out).toHaveLength(3);
    expect(out[0].properties).toMatchObject({ nearest_rank: 1, nearest_id: 1, nearest_unit: 'kilometers' });
    expect(out[0].properties.nearest_distance).toBeCloseTo(0.01, 6);
    expect(out[0].geometry).toEqual(a[0].geometry);
  });

  it('reports 0 and overlapping for a feature inside a polygon hub', async () => {
    const out = await computeNearestDistances([point(5, 5)], [poly([square(0, 0, 10, 10)])], 'meters', 1);
    expect(out[0].distance_meters).toBe(0);
    expect(out[0].overlapping).toBe(true);
  });

  it('cancels', async () => {
    const token = createProgress();
    token.cancelled = true;
    expect(await computeNearestDistances(spokes(), hubs(), 'meters', 1, token)).toEqual([]);
  });
});

describe('simplify methods', () => {
  const zigzag = (): Coord[] => {
    const coords: Coord[] = [[0, 0]];
    for (let i = 1; i <= 10; i++) coords.push([i * 10, i % 2 === 0 ? 0 : 1]);
    coords.push([110, 0]);
    return coords;
  };

  it('simplifies with Douglas-Peucker by default', () => {
    const out = simplifyFeatures([line(zigzag())], 2);
    expect((out[0].geometry as any).coordinates).toHaveLength(2);
  });

  it('simplifies with Visvalingam-Whyatt when the area method is chosen', () => {
    // Each zigzag tooth contributes a 20 x 1 / 2 = 10 unit² triangle. A 5 unit²
    // threshold removes nothing; a 100 unit² threshold flattens the whole line.
    const kept = simplifyFeatures([line(zigzag())], 5, { method: 'area' });
    expect((kept[0].geometry as any).coordinates).toHaveLength(zigzag().length);

    const flattened = simplifyFeatures([line(zigzag())], 100, { method: 'area' });
    expect((flattened[0].geometry as any).coordinates).toEqual([[0, 0], [110, 0]]);

    // …and Douglas-Peucker at the same numeric tolerance does something quite
    // different, which is the point of offering both.
    const dp = simplifyFeatures([line(zigzag())], 100)[0];
    expect((dp.geometry as any).coordinates).toHaveLength(2);
  });

  it('keeps the original geometry when simplifying would break topology', () => {
    // At tolerance 80 the shell collapses to a triangle while the thin hole
    // survives, which puts the hole outside its shell and crosses it.
    const shell: Ring = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]] as Ring;
    const hole: Ring = [[10, 50], [90, 45], [90, 55], [10, 60], [10, 50]] as Ring;
    const donut = poly([shell, hole]);

    const unguarded = simplifyFeatures([donut], 80, { preserveTopology: false });
    expect(checkValidity(unguarded)[0].valid).toBe(false);

    const preserved = simplifyFeatures([donut], 80, { preserveTopology: true });
    expect(checkValidity(preserved)[0].valid).toBe(true);
    expect(preserved[0].geometry).toEqual(donut.geometry);
  });

  it('scales a ground-metre tolerance for latitude like buffer does', () => {
    // 6.5 map units of wobble at 4 000 km south: cosh(y/R) ≈ 1.2, so a 6 m
    // ground tolerance is 7.2 map units and removes the wobble, while 6 raw map
    // units does not.
    const y = -4_000_000;
    const far: Coord[] = [[0, y], [1000, y + 6.5], [2000, y]];
    const raw = simplifyFeatures([line(far)], 6)[0];
    const ground = simplifyFeatures([line(far)], 6, { groundUnits: true })[0];
    expect((raw.geometry as any).coordinates).toHaveLength(3);
    expect((ground.geometry as any).coordinates).toHaveLength(2);
  });

  it('is a no-op for a non-positive tolerance', () => {
    expect(simplifyFeatures([line(zigzag())], 0)).toHaveLength(1);
  });
});

describe('buffer layer options', () => {
  it('dissolves the result into one feature', () => {
    const out = bufferFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(12, 0, 22, 10)])],
      5,
      { dissolveResult: true }
    );
    expect(out).toHaveLength(1);
    // Two 10x10 squares 2 apart, buffered by 5, overlap into one blob.
    expect(coveredArea(out[0].geometry)).toBeGreaterThan(400);
    expect(out[0].properties).toEqual({});
  });

  it('splits disjoint parts into separate features, after dissolving', () => {
    const out = bufferFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(500, 500, 510, 510)])],
      1,
      { dissolveResult: true, separateDisjointParts: true }
    );
    // dissolveResult merges first (one multipart feature), then the parts that
    // are still disjoint come back as separate features.
    expect(out).toHaveLength(2);
    expect(out.every(f => f.geometry?.type === 'Polygon')).toBe(true);

    const onlySplit = bufferFeatures(
      [multipolyFeature([[square(0, 0, 10, 10)], [square(500, 500, 510, 510)]])],
      1,
      { separateDisjointParts: true }
    );
    expect(onlySplit).toHaveLength(2);
  });

  it('reads a per-feature distance from a field', () => {
    const out = bufferFeatures(
      [point(0, 0, { d: 1 }), point(100, 100, { d: 10 })],
      999,
      { distanceField: 'd' }
    );
    expect(out).toHaveLength(2);
    const small = coveredArea(out[0].geometry);
    const big = coveredArea(out[1].geometry);
    expect(big / small).toBeGreaterThan(50);
  });

  it('falls back to the constant distance when the field is missing or not a number', () => {
    const out = bufferFeatures([point(0, 0, { d: 'nope' }), point(100, 0)], 5, { distanceField: 'd' });
    expect(out).toHaveLength(2);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(coveredArea(out[1].geometry), 6);
  });

  it('repairs a self-intersecting offset ring instead of emitting it', () => {
    // A very sharp spike buffered with a mitre join crosses itself.
    const spike: Ring = [[0, 0], [100, 1], [0, 2], [0, 0]] as Ring;
    const out = bufferFeatures([poly([spike])], 10, { joinStyle: 'miter', miterLimit: 100 });
    expect(out).toHaveLength(1);
    expect(checkValidity(out)[0].valid).toBe(true);
  });
});

describe('eliminate with the overlay kernel', () => {
  it('absorbs a polygon that only partially shares an edge', () => {
    const all = [
      poly([square(0, 0, 10, 10)], { id: 'keep' }),
      poly([square(10, 2, 14, 6)], { id: 'drop' }),
    ];
    const out = eliminateSelectedPolygonsDetailed(all, new Set([1]), 'largestArea');
    expect(out.droppedIndices).toEqual([]);
    expect(out.features).toHaveLength(1);
    expect(coveredArea(out.features[0].geometry)).toBeCloseTo(116, 6);
    expect(out.features[0].properties).toEqual({ id: 'keep' });
  });

  it('absorbs an overlapping polygon', () => {
    const all = [
      poly([square(0, 0, 10, 10)], { id: 'keep' }),
      poly([square(5, 5, 15, 15)], { id: 'drop' }),
    ];
    const out = eliminateSelectedPolygonsDetailed(all, new Set([1]));
    expect(out.droppedIndices).toEqual([]);
    expect(coveredArea(out.features[0].geometry)).toBeCloseTo(175, 6);
  });

  it('keeps the holes of both polygons', () => {
    const all = [
      poly([square(0, 0, 20, 20), reversedRing(square(2, 2, 4, 4))], { id: 'keep' }),
      poly([square(20, 0, 30, 10), reversedRing(square(24, 2, 26, 4))], { id: 'drop' }),
    ];
    const out = eliminateSelectedPolygonsDetailed(all, new Set([1]));
    expect(out.droppedIndices).toEqual([]);
    expect(coveredArea(out.features[0].geometry)).toBeCloseTo(400 - 4 + 100 - 4, 6);
  });

  it('still reports a selection with no neighbour at all', () => {
    const all = [poly([square(0, 0, 10, 10)]), poly([square(500, 500, 510, 510)])];
    const out = eliminateSelectedPolygonsDetailed(all, new Set([1]));
    expect(out.droppedIndices).toEqual([1]);
    expect(out.features).toHaveLength(1);
  });
});

describe('make valid on non-polygonal geometry', () => {
  it('passes points and lines through and measures them', () => {
    const out = makeValid([point(1, 2, { a: 1 }), line([[0, 0], [5, 5]] as Coord[], { b: 2 })]);
    expect(out[0].properties).toMatchObject({ a: 1, was_invalid: false });
    expect(out[1].properties).toMatchObject({ b: 2, was_invalid: false });
  });

  it('flags a one-point line as invalid', () => {
    const out = makeValid([line([[0, 0]] as Coord[])]);
    expect(out[0].properties.was_invalid).toBe(true);
  });
});
