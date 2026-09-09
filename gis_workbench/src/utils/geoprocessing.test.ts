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
  convexHullFeature,
  coordsClose,
  createProgress,
  delaunayTriangulation,
  delaunayTriangulationAsync,
  densifyByCount,
  dissolveFeatures,
  eliminateSelectedPolygons,
  eliminateSelectedPolygonsAsync,
  eliminateSelectedPolygonsDetailed,
  extractVertices,
  featureExtent,
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
  mergeVectorLayers,
  multipartToSingleparts,
  olFeaturesToGeo,
  polygonsToLines,
  progressLoop,
  removeSelectedFeatures,
  scaleTolerance,
  simplifyFeatures,
  splitVectorLayer,
  toGeoJSONString,
  toMeters,
  toleranceForFeatures,
  unionFeatures,
  voronoiPolygons,
  voronoiPolygonsAsync,
  type Coord,
  type GeoFeature,
  type GeoGeom,
  type Ring,
} from './geoprocessing';
import {
  WEB_MERCATOR_RADIUS,
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

  /**
   * KNOWN LIMITATION (Stage 2): the "round" join only inserts an arc when the
   * mitre intersection is farther than 2·r, so a 90° corner is mitred and the
   * buffer of a 10×10 square by 1 is exactly the 12×12 bounding box (144) rather
   * than GEOS's 100 + 40 + π ≈ 143.14.
   */
  it('KNOWN LIMITATION: round joins mitre a 90° corner', () => {
    const geom = bufferGeometry({ type: 'Polygon', coordinates: [square(0, 0, 10, 10)] }, 1);
    expect(geomArea(geom)).toBeCloseTo(144, 6);
    expect(geomArea(geom)).toBeGreaterThan(100 + 40 + Math.PI);
  });

  it('keeps holes and shrinks them when growing the polygon', () => {
    const geom = bufferGeometry({ type: 'Polygon', coordinates: donutRings() }, 1);
    expect(geom?.type).toBe('Polygon');
    if (geom?.type !== 'Polygon') throw new Error('expected a Polygon');
    expect(geom.coordinates).toHaveLength(2);
    expect(shoelace(geom.coordinates[0])).toBeCloseTo(144, 6);
    // The 4×4 hole becomes 2×2 — it used to be deleted outright.
    expect(shoelace(geom.coordinates[1])).toBeCloseTo(4, 6);
  });

  it('widens holes when shrinking the polygon', () => {
    const geom = bufferGeometry({ type: 'Polygon', coordinates: donutRings() }, -1);
    if (geom?.type !== 'Polygon') throw new Error('expected a Polygon');
    expect(geom.coordinates).toHaveLength(2);
    expect(shoelace(geom.coordinates[0])).toBeCloseTo(64, 6); // 8×8 shell
    expect(shoelace(geom.coordinates[1])).toBeCloseTo(36, 6); // 6×6 hole
    expect(coveredArea(geom)).toBeCloseTo(28, 6);
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
   * KNOWN LIMITATION (Stage 2): at a sharp bend the mitre spike (and the "round"
   * join, which also takes the mitre intersection whenever it is within 2·r)
   * crosses the opposite side of the buffer. GEOS nodes and unions the offset
   * curves; here the ring is emitted as built, so its |shoelace| area collapses
   * below the bevelled answer even though the spike is longer.
   */
  it('KNOWN LIMITATION: a sharp-bend mitre self-intersects instead of being noded', () => {
    const geom: GeoGeom = { type: 'LineString', coordinates: [[0, 0], [10, 0], [12, 8]] as Coord[] };
    const bevel = geomArea(bufferGeometry(geom, 1, { joinStyle: 'bevel' }));
    const longMiter = geomArea(bufferGeometry(geom, 1, { joinStyle: 'miter', miterLimit: 20 }));
    const roundJoin = geomArea(bufferGeometry(geom, 1, { joinStyle: 'round' }));
    expect(longMiter).toBeLessThan(bevel);
    expect(roundJoin).toBeCloseTo(longMiter, 6);
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

  /**
   * KNOWN LIMITATION (Stage 2): without a difference kernel a piece that merely
   * straddles a clip-layer hole is kept whole, so the hole is filled in. The old
   * code was worse still — it clipped against the hole ring as if it were solid,
   * emitting an extra 16 m² feature on top.
   */
  it('KNOWN LIMITATION: a clip-layer hole is not subtracted from a straddling piece', () => {
    const out = clipFeatures([poly([square(-5, -5, 15, 15)])], [poly(donutRings())]);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(100, 6); // GEOS would give 84
  });

  /**
   * KNOWN LIMITATION (Stage 2): Sutherland-Hodgman is only exact for convex
   * cutter rings. This L-shaped cutter covers 64 of the 100 units of the subject.
   */
  it('KNOWN LIMITATION: a concave cutter is clipped incorrectly', () => {
    const lShape: Ring = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]] as Ring;
    const out = clipFeatures([poly([square(0, 0, 10, 10)])], [poly([lShape])]);
    expect(shoelace(lShape)).toBeCloseTo(64, 6);
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).not.toBeCloseTo(64, 3);
  });

  /** KNOWN LIMITATION (Stage 2): QGIS clips points and lines too. */
  it('KNOWN LIMITATION: non-polygon inputs produce no output', () => {
    const cutter = [poly([square(0, 0, 10, 10)])];
    expect(clipFeatures([point(5, 5)], cutter)).toEqual([]);
    expect(clipFeatures([line([[5, 5], [20, 20]] as Coord[])], cutter)).toEqual([]);
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
    // KNOWN LIMITATION (Stage 2): B overwrites A on a name collision instead of
    // being disambiguated the way QGIS does.
    expect(out[0].properties).toEqual({ name: 'B', a: 1, b: 2 });
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
    const out = await dissolveFeatures(
      [poly([square(0, 0, 10, 10)], { a: 1 }), poly([square(10, 0, 20, 10)], { b: 2 })],
      true
    );
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('Polygon');
    // Regression: the old shared-edge splice produced a self-intersecting
    // hexagon of area 150 for this exact input.
    expect(coveredArea(out[0].geometry)).toBeCloseTo(200, 6);
    expect(out[0].properties).toEqual({});
  });

  it('merges a whole row of polygons', async () => {
    const out = await dissolveFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(10, 0, 20, 10)]), poly([square(20, 0, 30, 10)])],
      true
    );
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(300, 6);
  });

  it('keeps disjoint polygons as multipolygon parts', async () => {
    const out = await dissolveFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(500, 500, 510, 510)])],
      true
    );
    expect(out).toHaveLength(1);
    expect(out[0].geometry?.type).toBe('MultiPolygon');
    if (out[0].geometry?.type !== 'MultiPolygon') throw new Error('expected a MultiPolygon');
    expect(out[0].geometry.coordinates).toHaveLength(2);
  });

  it('collects without merging when dissolveOverlap is off', async () => {
    const out = await dissolveFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(10, 0, 20, 10)])],
      false
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
    ], true);
    const types = out.map(f => f.geometry?.type).sort();
    expect(types).toEqual(['MultiLineString', 'MultiPoint']);
  });

  /**
   * KNOWN LIMITATION (Stage 2): overlapping (not edge-adjacent) polygons fall
   * back to the convex hull of the pair, which over-reports area — here 200
   * instead of the true 175.
   */
  it('KNOWN LIMITATION: an overlapping merge inflates to the convex hull', async () => {
    const out = await dissolveFeatures(
      [poly([square(0, 0, 10, 10)]), poly([square(5, 5, 15, 15)])],
      true
    );
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(200, 6);
    expect(coveredArea(out[0].geometry)).toBeGreaterThan(175);
  });

  it('reports progress and really honours cancellation', async () => {
    const features: GeoFeature[] = [];
    for (let i = 0; i < 40; i++) features.push(poly([square(i * 10, 0, i * 10 + 10, 10)]));
    const reports: number[] = [];
    const token = createProgress();
    const done = dissolveFeatures(features, true, token, p => reports.push(p.progress));
    token.cancelled = true;
    expect(await done).toEqual([]);
    // Progress must never exceed 1 — the old pairs-checked counter could.
    for (const r of reports) expect(r).toBeLessThanOrEqual(1);
  });

  it('progress stays within [0, 1] on a completed run', async () => {
    const features: GeoFeature[] = [];
    for (let i = 0; i < 12; i++) features.push(poly([square(i * 10, 0, i * 10 + 10, 10)]));
    const token = createProgress();
    const seen: number[] = [];
    const out = await dissolveFeatures(features, true, token, p => seen.push(p.progress));
    expect(out).toHaveLength(1);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(1200, 3);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(token.progress).toBe(1);
  });
});

describe('union', () => {
  it('merges the polygons of both layers and passes other geometries through', async () => {
    const out = await unionFeatures(
      [poly([square(0, 0, 10, 10)], { a: 1 }), point(50, 50, { p: 1 })],
      [poly([square(10, 0, 20, 10)], { b: 2 })]
    );
    expect(out).toHaveLength(2);
    const polys = out.filter(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon');
    expect(coveredArea(polys[0].geometry)).toBeCloseTo(200, 6);
    const pts = out.filter(f => f.geometry?.type === 'Point');
    expect(pts[0].properties).toEqual({ p: 1 });
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
   * KNOWN LIMITATION (Stage 2): QGIS computes one hull per input feature; this
   * computes a single hull for the whole layer and drops all attributes.
   */
  it('KNOWN LIMITATION: one hull for the whole layer, not one per feature', () => {
    const hull = convexHullFeature([poly([square(0, 0, 1, 1)], { id: 'a' }), poly([square(100, 100, 101, 101)], { id: 'b' })]);
    expect(hull).not.toBeNull();
    // One hull spanning both features (area 201), where QGIS would return two
    // features of area 1 each.
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

  /**
   * KNOWN LIMITATION: a point inside a polygon *hole* is measured against the
   * shell only, so it reports 0 while GEOS reports the distance to the hole
   * boundary.
   */
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
    expect(out[1].reason).toBe('Ring self-intersects.');
    expect(out[2].reason).toBe('Ring has fewer than 4 points.');
    expect(out.every(r => !r.valid)).toBe(true);
  });

  it('tolerates a ring that is closed to within the dataset tolerance', () => {
    const nearClosed = poly([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 1e-9]] as Ring]);
    expect(checkValidity([nearClosed])[0].valid).toBe(true);
  });

  it('names the offending ring of a donut or multipart feature', () => {
    const out = checkValidity([poly([square(0, 0, 10, 10), [[0, 0], [1, 1], [1, 0]] as Ring])]);
    expect(out[0].valid).toBe(false);
    expect(out[0].reason).toBe('Part 1 hole 1: Ring has fewer than 4 points.');
  });

  /**
   * KNOWN LIMITATION (Stage 2): only ring-level defects are detected. The GEOS
   * classes — hole outside shell, nested holes, disconnected interior, duplicate
   * rings, NaN coordinates — all still report "Valid.".
   */
  it('KNOWN LIMITATION: a hole outside its shell reports valid', () => {
    const out = checkValidity([poly([square(0, 0, 10, 10), square(100, 100, 110, 110)])]);
    expect(out[0].valid).toBe(true);
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

  it('turns a bowtie into a valid ring', () => {
    const bowtie = poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]] as Ring]);
    expect(checkValidity([bowtie])[0].valid).toBe(false);
    const out = makeValid([bowtie]);
    expect(checkValidity(out)[0].valid).toBe(true);
    expect(coveredArea(out[0].geometry)).toBeGreaterThan(0);
  });

  it('passes non-polygonal geometry through untouched', () => {
    const input = point(1, 2, { a: 1 });
    expect(makeValid([input])[0].geometry).toEqual(input.geometry);
  });

  /**
   * KNOWN LIMITATION (Stage 2): GEOS `ST_MakeValid` never loses vertices — a
   * bowtie becomes two triangles (total area 50 here). This keeps only the
   * largest piece, and the >2-crossing path falls back to a polar-angle sort,
   * which turns the bowtie into its 10×10 bounding square (area 100).
   */
  it('KNOWN LIMITATION: a bowtie is repaired by inflating, not by splitting', () => {
    const out = makeValid([poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]] as Ring])]);
    expect(coveredArea(out[0].geometry)).toBeCloseTo(100, 6);
  });

  /** KNOWN LIMITATION (Stage 2): the flag is stamped on every polygon. */
  it('KNOWN LIMITATION: was_invalid is set even on already-valid input', () => {
    const out = makeValid([poly([square(0, 0, 1, 1)])]);
    expect(out[0].properties.was_invalid).toBe(true);
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

  /** KNOWN LIMITATION (Stage 2): the tolerance is raw EPSG:3857 units. */
  it('KNOWN LIMITATION: tolerance is not latitude-corrected', () => {
    const atEquator = simplifyFeatures([zigzag()], 0.5)[0].geometry as any;
    expect(atEquator.coordinates.length).toBe(2);
  });
});

describe('vertices, parts and type conversion', () => {
  it('extracts hole vertices too', () => {
    // Regression: holes used to be skipped entirely.
    expect(extractVertices([poly(donutRings())])).toHaveLength(10);
    const out = extractVertices([poly([square(0, 0, 1, 1)], { id: 3 })]);
    expect(out.every(f => f.geometry?.type === 'Point')).toBe(true);
    expect(out[0].properties).toEqual({ id: 3 });
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

  it('turns every ring of a polygon into a line, dropping the closing vertex', () => {
    const out = polygonsToLines([poly(donutRings(), { id: 9 })]);
    expect(out).toHaveLength(2);
    expect(out.every(f => f.geometry?.type === 'LineString')).toBe(true);
    expect((out[0].geometry as any).coordinates).toHaveLength(4);
    expect(out[0].properties).toEqual({ id: 9 });
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
    expect(await delaunayTriangulationAsync(seeds, token)).toEqual([]);
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

  /** KNOWN LIMITATION (Stage 2): x/y stay in EPSG:3857, not lon/lat. */
  it('KNOWN LIMITATION: x and y are map units, not degrees', () => {
    const out = addGeometryAttributes([poly([shell])], {
      addArea: false, addLength: false, addPerimeter: false, addX: true, addY: true,
    });
    expect(Math.abs(out[0].properties.x)).toBeGreaterThan(1e6);
    expect(out[0].properties.y).toBeLessThan(0);
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
    expect(out.map(r => r.name).sort()).toEqual(['1', '{"k":1}']);
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
