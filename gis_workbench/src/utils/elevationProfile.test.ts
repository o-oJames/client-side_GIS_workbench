/**
 * Elevation profile — reading terrain along a drawn line.
 *
 * The pure half (plan → grid sampling → points → stats → chart geometry →
 * saved attributes) is tested against synthetic grids, so no tile service, no
 * GeoTIFF and no network are involved. The two readers are then exercised once
 * each: the tile reader through a mocked `readTileElevationGrid` (what the
 * profile asks it for is the contract that matters), and the COG reader for
 * real against a faked geotiff.js level — the same stand-in the COG contour
 * suite uses — so the end-to-end path a user takes is covered too.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RasterLayer } from '../types';
import { groundDistance, groundLineLength, lonLatToMercator, mercatorToLonLat } from './geodesic';

// The tile reader is the only part that would need a PNG decoder and a network;
// everything else in the module under test is pure. Mocked at file scope, with
// the rest of the module (buildTileUrl and friends) left intact.
vi.mock('./tileElevation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tileElevation')>();
  return { ...actual, readTileElevationGrid: vi.fn() };
});
import { readTileElevationGrid } from './tileElevation';
const readTiles = vi.mocked(readTileElevationGrid);

import {
  ELEV_PROFILE_DEFAULT_RECT,
  ELEV_PROFILE_GEOMETRY_KEY,
  ELEV_PROFILE_MIN_H,
  ELEV_PROFILE_MIN_W,
  PROFILE_FIELDS,
  PROFILE_MAX_GRID_CELLS,
  PROFILE_MIN_SAMPLES,
  buildProfileChart,
  buildProfilePoints,
  clampElevProfileRect,
  coordinateAtDistance,
  densifyByDistance,
  formatProfileDistanceTick,
  formatProfileElevation,
  formatProfileGrade,
  gridCellSize,
  hasTerrainRenderer,
  loadElevProfileGeometry,
  niceAxisTicks,
  planProfileSampling,
  profileFeatureAttributes,
  profileFailureMessage,
  profileLineGeoJson,
  profilePointAtDistance,
  profilePointRecords,
  profileStats,
  sampleElevationProfile,
  sampleGridBilinear,
  saveElevProfileGeometry,
  sourceHasTileTemplate,
  terrainRendererOf,
  terrainTileSource,
  type ProfileGrid,
  type ProfileGridLike,
  type ProfilePoint,
} from './elevationProfile';

// --- fixtures ---------------------------------------------------------------

/** A 20 km × 10 km box in EPSG:3857 centred on Adelaide (~34.9°S). */
const ORIGIN = lonLatToMercator([138.6, -34.93]);
const EXTENT: number[] = [ORIGIN[0], ORIGIN[1], ORIGIN[0] + 20000, ORIGIN[1] + 10000];
const MID_Y = (EXTENT[1] + EXTENT[3]) / 2;
/** A west→east line across the middle of that box (fx 0.1 → 0.9 of it). */
const LINE: [number, number][] = [
  [EXTENT[0] + 2000, MID_Y],
  [EXTENT[2] - 2000, MID_Y],
];
/** Ground length of that line, measured once. */
const LINE_LENGTH = groundLineLength(LINE);

/** Relative closeness, for distances summed sample by sample. */
function expectCloseRel(actual: number, expected: number, relative = 1e-6) {
  expect(Math.abs(actual - expected)).toBeLessThan(Math.max(1e-9, Math.abs(expected) * relative));
}

/**
 * A synthetic elevation grid. `value` is called with the cell centre as a
 * fraction of the extent (fx east from 0, fy SOUTH from the top edge, the way
 * both real readers lay their rows out).
 */
function syntheticGrid(
  value: (fx: number, fy: number) => number,
  over: Partial<{ width: number; height: number; extent: number[] }> = {},
): ProfileGrid {
  const width = over.width ?? 40;
  const height = over.height ?? 20;
  const extent = over.extent ?? EXTENT;
  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      field[y * width + x] = value((x + 0.5) / width, (y + 0.5) / height);
    }
  }
  const grid: ProfileGridLike = { field, width, height, extent };
  return { ...grid, cellSize: gridCellSize(grid), kind: 'tile' };
}

/** Rises 0 → 400 m from west to east, whatever the row. */
const rampUp = () => syntheticGrid(fx => fx * 400);
/** A valley: 300 m at both ends, 100 m in the middle. */
const valley = () => syntheticGrid(fx => 300 - 200 * (1 - Math.abs(fx * 2 - 1)));
/** The same ramp with a nodata band across its middle third. */
const gappedRamp = () => syntheticGrid(fx => (fx > 0.4 && fx < 0.6 ? NaN : fx * 400));

const TILE_SOURCE = {
  getTileGrid: () => ({ getMinZoom: () => 0, getMaxZoom: () => 18 }),
  getUrls: () => ['https://tiles.example.com/{z}/{x}/{y}.png'],
};

function tileLayer(over: Partial<RasterLayer> = {}): RasterLayer {
  return {
    id: 'r1',
    name: 'Terrarium',
    type: 'xyz',
    url: 'https://tiles.example.com/{z}/{x}/{y}.png',
    tileRender: { mode: 'contour', encoding: 'terrarium' },
    olLayer: { getSource: () => TILE_SOURCE },
    ...over,
  } as RasterLayer;
}

function cogLayer(source: any, over: Partial<RasterLayer> = {}): RasterLayer {
  return {
    id: 'c1',
    name: 'DEM',
    type: 'cog',
    url: 'https://example.com/dem.tif',
    cogRender: { mode: 'hillshade', band: 1 },
    olLayer: { getSource: () => source },
    ...over,
  } as RasterLayer;
}

/** A stand-in for one geotiff.js image level of a loaded COG (as in
 * utils/cogContours.test.ts): 10 m pixels over EXTENT, rising west → east. */
function fakeCogImage(width = 2000, height = 1000, samplesPerPixel = 1) {
  return {
    getWidth: () => width,
    getHeight: () => height,
    getBoundingBox: () => EXTENT,
    getResolution: () => [(EXTENT[2] - EXTENT[0]) / width, -(EXTENT[3] - EXTENT[1]) / height],
    getSamplesPerPixel: () => samplesPerPixel,
    getGDALNoData: () => null,
    readRasters: async (read: any) => {
      const [wx0, wy0, wx1, wy1] = read.window;
      const outW = read.width ?? wx1 - wx0;
      const outH = read.height ?? wy1 - wy0;
      const values = new Float32Array(outW * outH);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const px = wx0 + ((x + 0.5) * (wx1 - wx0)) / outW;
          values[y * outW + x] = 100 + (px / width) * 500;
        }
      }
      return [values];
    },
  };
}

/**
 * A tile read that answers with a synthetic grid sized exactly as asked for,
 * over exactly the window asked for — what the real reader returns, minus the
 * PNG decoding and the network.
 */
function mockTileRead(value: (fx: number, fy: number) => number) {
  readTiles.mockImplementation(async (options: any) => {
    const width = Math.max(2, Math.round(options.viewport.width));
    const height = Math.max(2, Math.round(options.viewport.height));
    const field = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        field[y * width + x] = value((x + 0.5) / width, (y + 0.5) / height);
      }
    }
    return { field, width, height, extent: options.viewExtent.slice() };
  });
}

function fakeCogSource(projection = 'EPSG:3857') {
  return {
    sourceImagery_: [[fakeCogImage()]],
    getProjection: () => ({ getCode: () => projection }),
  };
}

beforeEach(() => {
  readTiles.mockReset();
  localStorage.clear();
});

// --- which layers can be profiled -------------------------------------------

describe('terrain renderer detection', () => {
  test('a COG in hillshade or contour mode is profileable, and says it is a COG', () => {
    for (const mode of ['hillshade', 'contour'] as const) {
      const info = terrainRendererOf({ type: 'cog', cogRender: { mode } } as RasterLayer);
      expect(info).toMatchObject({ kind: 'cog', mode });
      expect(info?.label).toBe(mode === 'contour' ? 'Contours' : 'Hillshade');
    }
  });

  test('a tile layer in hillshade or contour mode is profileable, and says it is tiles', () => {
    for (const mode of ['hillshade', 'contour'] as const) {
      expect(terrainRendererOf({ type: 'xyz', tileRender: { mode, encoding: 'terrarium' } } as RasterLayer))
        .toMatchObject({ kind: 'tile', mode });
    }
  });

  test('plain imagery is not: no renderer, a default tile renderer, or an RGB COG', () => {
    expect(terrainRendererOf(undefined)).toBeNull();
    expect(terrainRendererOf({ type: 'xyz' } as RasterLayer)).toBeNull();
    expect(terrainRendererOf({ type: 'xyz', tileRender: { mode: 'default', encoding: 'terrarium' } } as RasterLayer)).toBeNull();
    expect(terrainRendererOf({ type: 'cog', cogRender: { mode: 'rgb', rgb: [1, 2, 3] } } as RasterLayer)).toBeNull();
    expect(terrainRendererOf({ type: 'cog' } as RasterLayer)).toBeNull();
    expect(hasTerrainRenderer({ type: 'cog', cogRender: { mode: 'contour' } } as RasterLayer)).toBe(true);
    expect(hasTerrainRenderer({ type: 'xyz' } as RasterLayer)).toBe(false);
  });
});

describe('reaching the terrain tiles', () => {
  test('a plain tile layer answers with its own source', () => {
    expect(terrainTileSource({ getSource: () => TILE_SOURCE })).toBe(TILE_SOURCE);
  });

  test('a hillshade layer answers with the source its Raster wrapper shades', () => {
    const wrapper = { getSomethingElse: () => true };
    expect(terrainTileSource({ _terrainTileSource: TILE_SOURCE, getSource: () => wrapper })).toBe(TILE_SOURCE);
    // …and, failing that stash, by walking the wrapper's inner layers.
    const inner = { getSource: () => TILE_SOURCE };
    expect(terrainTileSource({ getSource: () => ({ layers_: [inner] }) })).toBe(TILE_SOURCE);
  });

  test('a source with no tile grid is refused rather than guessed at', () => {
    expect(terrainTileSource(null)).toBeNull();
    expect(terrainTileSource({ getSource: () => ({}) })).toBeNull();
    expect(terrainTileSource({})).toBeNull();
  });

  test('only an XYZ-style URL template can be sampled', () => {
    expect(sourceHasTileTemplate({ getUrls: () => ['https://x/{z}/{x}/{y}.png'] })).toBe(true);
    expect(sourceHasTileTemplate({ getUrl: () => 'https://x/{z}/{x}/{-y}.png' })).toBe(true);
    expect(sourceHasTileTemplate({ getUrls: () => ['https://x/{q}.png'] })).toBe(true);
    expect(sourceHasTileTemplate({ getTileUrlForCoord: () => 'https://x/1/2/3.png' })).toBe(true);
    expect(sourceHasTileTemplate({ getUrls: () => ['https://wms.example.com/geoserver/wms?SERVICE=WMS'] })).toBe(false);
    expect(sourceHasTileTemplate({ getUrls: () => ['https://wmts/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png'] })).toBe(false);
    expect(sourceHasTileTemplate(null)).toBe(false);
  });
});

// --- the sampling plan ------------------------------------------------------

describe('planProfileSampling', () => {
  test('a line shorter than two vertices has nothing to plan', () => {
    expect(planProfileSampling([])).toBeNull();
    expect(planProfileSampling([LINE[0]])).toBeNull();
    expect(planProfileSampling([[NaN, 0], [1, 1]])).toBeNull();
  });

  test('the read window covers the whole line, padded', () => {
    const plan = planProfileSampling(LINE, { samples: 200 })!;
    expect(plan.extent[0]).toBeLessThan(LINE[0][0]);
    expect(plan.extent[2]).toBeGreaterThan(LINE[1][0]);
    expect(plan.extent[1]).toBeLessThan(LINE[0][1]);
    expect(plan.extent[3]).toBeGreaterThan(LINE[0][1]);
    expectCloseRel(plan.length, LINE_LENGTH, 1e-9);
  });

  test('the grid is aimed at one cell per sample interval', () => {
    const plan = planProfileSampling(LINE, { samples: 200 })!;
    expect(plan.samples).toBe(200);
    expect(plan.cellSize).toBeCloseTo(plan.length / 199, 6);
    // A 16 km line at ~34.9°S: planar cells are wider than ground cells by
    // 1/cos(lat), so the grid is coarser in cell count than the planar span
    // divided by the GROUND cell size would suggest — but always ≥ 2 and capped.
    expect(plan.gridWidth).toBeGreaterThanOrEqual(2);
    expect(plan.gridWidth).toBeLessThanOrEqual(PROFILE_MAX_GRID_CELLS);
    expect(plan.gridHeight).toBeGreaterThanOrEqual(2);
    expect(plan.gridHeight).toBeLessThanOrEqual(PROFILE_MAX_GRID_CELLS);
  });

  test('a tiny line gets fewer samples than asked for, not 240 copies of one pixel', () => {
    const near = [[EXTENT[0], EXTENT[1]], [EXTENT[0] + 0.4, EXTENT[1]]]; // ~0.33 m on the ground
    const plan = planProfileSampling(near, { samples: 240 })!;
    expect(plan.samples).toBeLessThan(10);
    expect(plan.samples).toBeGreaterThanOrEqual(2);
  });

  test('the sample count is clamped to the profile limits', () => {
    expect(planProfileSampling(LINE, { samples: 1 })!.samples).toBe(PROFILE_MIN_SAMPLES);
    expect(planProfileSampling(LINE, { samples: 100000 })!.samples).toBeLessThanOrEqual(2000);
    expect(planProfileSampling(LINE, { samples: NaN })!.samples).toBe(240);
  });

  test('a very long line stays inside the grid cap', () => {
    const far: [number, number][] = [
      [EXTENT[0] - 4_000_000, EXTENT[1]],
      [EXTENT[2] + 4_000_000, EXTENT[3]],
    ];
    const plan = planProfileSampling(far, { samples: 1200 })!;
    expect(plan.gridWidth).toBeLessThanOrEqual(PROFILE_MAX_GRID_CELLS);
    expect(plan.gridHeight).toBeLessThanOrEqual(PROFILE_MAX_GRID_CELLS);
  });
});

describe('gridCellSize', () => {
  test('planar cells are ground cells scaled by cos(latitude)', () => {
    const atEquator = syntheticGrid(() => 0, {
      width: 10,
      height: 10,
      extent: [0, -5000, 10000, 5000],
    });
    expect(gridCellSize(atEquator)).toBeCloseTo(1000, 3);

    // 60°N: the same planar cell covers half the ground distance.
    const y60 = lonLatToMercator([0, 60])[1];
    const at60 = syntheticGrid(() => 0, { width: 10, height: 10, extent: [0, y60 - 5000, 10000, y60 + 5000] });
    expect(gridCellSize(at60)).toBeCloseTo(500, 0);
  });

  test('a degenerate grid has no cell size', () => {
    expect(gridCellSize({ field: new Float32Array(0), width: 0, height: 0, extent: [0, 0, 0, 0] })).toBe(0);
  });
});

// --- sampling the grid ------------------------------------------------------

describe('sampleGridBilinear', () => {
  const grid = syntheticGrid(fx => fx * 400, { width: 4, height: 2 });

  test('a cell centre returns that cell', () => {
    const spanX = EXTENT[2] - EXTENT[0];
    // Cell (0,0) centre: fx = 0.125 → 50 m.
    expect(sampleGridBilinear(grid, EXTENT[0] + spanX * 0.125, EXTENT[3] - (EXTENT[3] - EXTENT[1]) * 0.25))
      .toBeCloseTo(50, 6);
  });

  test('between two cells it interpolates', () => {
    const spanX = EXTENT[2] - EXTENT[0];
    // Halfway between the centres of cells 0 and 1 (fx 0.125 → 0.375).
    const mid = sampleGridBilinear(grid, EXTENT[0] + spanX * 0.25, (EXTENT[1] + EXTENT[3]) / 2);
    expect(mid).toBeCloseTo(100, 6);
  });

  test('outside the grid there is no elevation', () => {
    expect(Number.isNaN(sampleGridBilinear(grid, EXTENT[0] - 1, EXTENT[1]))).toBe(true);
    expect(Number.isNaN(sampleGridBilinear(grid, EXTENT[2] + 1, EXTENT[1]))).toBe(true);
    expect(Number.isNaN(sampleGridBilinear(grid, EXTENT[0], EXTENT[3] + 1))).toBe(true);
    expect(Number.isNaN(sampleGridBilinear(grid, NaN, EXTENT[1]))).toBe(true);
  });

  test('a nodata neighbour narrows the interpolation instead of punching a hole', () => {
    const holed = syntheticGrid(fx => (fx < 0.5 ? NaN : 10), { width: 4, height: 2 });
    const spanX = EXTENT[2] - EXTENT[0];
    // Between a nodata cell (left) and a 10 m cell (right): the finite one wins.
    expect(sampleGridBilinear(holed, EXTENT[0] + spanX * 0.5, (EXTENT[1] + EXTENT[3]) / 2)).toBeCloseTo(10, 6);
    // All four neighbours nodata → nothing to say.
    const allHoles = syntheticGrid(() => NaN, { width: 4, height: 2 });
    expect(Number.isNaN(sampleGridBilinear(allHoles, EXTENT[0] + spanX * 0.5, (EXTENT[1] + EXTENT[3]) / 2))).toBe(true);
  });

  test('a malformed grid is refused', () => {
    expect(Number.isNaN(sampleGridBilinear({ field: new Float32Array(4), width: 2, height: 2, extent: [0, 0, 0, 0] }, 0, 0))).toBe(true);
    expect(Number.isNaN(sampleGridBilinear({ field: new Float32Array(0), width: 0, height: 0, extent: [0, 0, 1, 1] }, 0.5, 0.5))).toBe(true);
  });
});

describe('densifyByDistance', () => {
  test('the requested number of points, ends exactly on the drawn vertices', () => {
    const out = densifyByDistance(LINE, 50);
    expect(out).toHaveLength(50);
    expect(out[0][0]).toBeCloseTo(LINE[0][0], 6);
    expect(out[0][1]).toBeCloseTo(LINE[0][1], 6);
    expect(out[49][0]).toBeCloseTo(LINE[1][0], 6);
    expect(out[49][1]).toBeCloseTo(LINE[1][1], 6);
  });

  test('spacing is even on the GROUND, not on the Mercator plane', () => {
    const out = densifyByDistance(LINE, 41);
    const steps: number[] = [];
    for (let i = 1; i < out.length; i++) steps.push(groundDistance(out[i - 1], out[i]));
    const expected = LINE_LENGTH / 40;
    for (const step of steps) expectCloseRel(step, expected, 1e-6);
  });

  test('a multi-segment line keeps its bend vertices on the path', () => {
    const bendy: [number, number][] = [
      [EXTENT[0] + 1000, EXTENT[1] + 1000],
      [EXTENT[0] + 6000, EXTENT[1] + 8000],
      [EXTENT[0] + 15000, EXTENT[1] + 2000],
    ];
    const out = densifyByDistance(bendy, 60);
    expect(out).toHaveLength(60);
    // Resampling straightens a corner it does not land exactly on, so the
    // densified line is a hair shorter — bounded by the sample spacing.
    const original = groundLineLength(bendy);
    const spacing = original / 59;
    expect(original - groundLineLength(out)).toBeLessThan(spacing);
    expect(original - groundLineLength(out)).toBeGreaterThan(0);
    // Every densified point lies on one of the two original segments.
    for (const p of out) {
      const onFirst = p[0] >= bendy[0][0] - 1e-6 && p[0] <= bendy[1][0] + 1e-6;
      const onSecond = p[0] >= bendy[1][0] - 1e-6 && p[0] <= bendy[2][0] + 1e-6;
      expect(onFirst || onSecond).toBe(true);
    }
  });

  test('degenerate input is returned rather than invented', () => {
    expect(densifyByDistance([], 10)).toEqual([]);
    expect(densifyByDistance([LINE[0]], 10)).toHaveLength(1);
    const zero = densifyByDistance([[0, 0], [0, 0]], 10);
    expect(zero).toHaveLength(2);
  });
});

// --- points and statistics --------------------------------------------------

describe('buildProfilePoints', () => {
  test('samples the ramp under a west→east line, from 0 m to the total length', () => {
    const points = buildProfilePoints(LINE, rampUp(), { samples: 100 });
    expect(points).toHaveLength(100);
    expect(points[0].distance).toBe(0);
    expectCloseRel(points[99].distance, LINE_LENGTH, 1e-6);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].distance).toBeGreaterThan(points[i - 1].distance);
      expect(points[i].elevation).toBeGreaterThan(points[i - 1].elevation);
    }
    // The line spans fx 0.1 → 0.9 of a 0 → 400 m ramp.
    expect(points[0].elevation).toBeCloseTo(40, 0);
    expect(points[99].elevation).toBeCloseTo(360, 0);
  });

  test('every point carries its WGS84 position, consistent with its 3857 one', () => {
    const points = buildProfilePoints(LINE, rampUp(), { samples: 20 });
    for (const p of points) {
      const back = lonLatToMercator([p.lon, p.lat]);
      expect(back[0]).toBeCloseTo(p.x, 3);
      expect(back[1]).toBeCloseTo(p.y, 3);
    }
    const middle = points[10];
    const [lon, lat] = mercatorToLonLat([middle.x, middle.y]);
    expect(lon).toBeCloseTo(middle.lon, 9);
    expect(lat).toBeCloseTo(middle.lat, 9);
  });

  test('nodata under part of the line stays NaN rather than becoming zero', () => {
    const points = buildProfilePoints(LINE, gappedRamp(), { samples: 101 });
    const missing = points.filter(p => !Number.isFinite(p.elevation));
    expect(missing.length).toBeGreaterThan(5);
    expect(points.filter(p => Number.isFinite(p.elevation)).length).toBeGreaterThan(50);
  });

  test('a line that cannot be sampled yields no points', () => {
    expect(buildProfilePoints([], rampUp())).toEqual([]);
    expect(buildProfilePoints([LINE[0]], rampUp())).toEqual([]);
  });
});

describe('profileStats', () => {
  test('a steady climb: all ascent, no descent, extremes at the ends', () => {
    const points = buildProfilePoints(LINE, rampUp(), { samples: 200 });
    const stats = profileStats(points)!;
    expect(stats.sampleCount).toBe(200);
    expect(stats.missingCount).toBe(0);
    expect(stats.longestGap).toBe(0);
    expectCloseRel(stats.totalDistance, LINE_LENGTH, 1e-6);
    expect(stats.ascent).toBeCloseTo(stats.maxElevation - stats.minElevation, 3);
    expect(stats.descent).toBe(0);
    expect(stats.minAt).toBe(0);
    expect(stats.maxAt).toBeCloseTo(stats.totalDistance, 3);
    expect(stats.startElevation).toBeCloseTo(stats.minElevation, 6);
    expect(stats.endElevation).toBeCloseTo(stats.maxElevation, 6);
    expect(stats.meanElevation).toBeCloseTo((stats.minElevation + stats.maxElevation) / 2, 0);
    // ~400 m of rise over 20 km of planar (≈16.4 km ground) line ≈ 2%.
    expect(stats.maxGradePercent).toBeGreaterThan(1);
    expect(stats.maxGradePercent).toBeLessThan(5);
  });

  test('a valley counts the climb down and the climb back up separately', () => {
    const points = buildProfilePoints(LINE, valley(), { samples: 200 });
    const stats = profileStats(points)!;
    expect(stats.descent).toBeGreaterThan(150);
    expect(stats.ascent).toBeGreaterThan(150);
    expectCloseRel(stats.ascent, stats.descent, 1e-3);
    // The lowest ground is in the middle of the line; the highest is at its
    // ends, which this line reaches at fx 0.1 / 0.9 (260 m on this fixture).
    expect(stats.minAt).toBeGreaterThan(stats.totalDistance * 0.4);
    expect(stats.minAt).toBeLessThan(stats.totalDistance * 0.6);
    // 260 m at the ends, 100 m at the bottom (within one sample spacing of
    // the exact valley floor).
    expect(stats.maxElevation).toBeCloseTo(260, 0);
    expect(stats.minElevation).toBeGreaterThan(99);
    expect(stats.minElevation).toBeLessThan(110);
    expectCloseRel(stats.ascent, stats.maxElevation - stats.minElevation, 1e-6);
  });

  test('a nodata gap is measured and reported, not quietly dropped', () => {
    const points = buildProfilePoints(LINE, gappedRamp(), { samples: 200 });
    const stats = profileStats(points)!;
    const whole = profileStats(buildProfilePoints(LINE, rampUp(), { samples: 200 }))!;
    expect(stats.missingCount).toBeGreaterThan(0);
    expect(stats.sampleCount + stats.missingCount).toBe(200);
    // The nodata band is fx 0.4→0.6 of the 20 km grid — a quarter of the
    // 16 km the line covers. Bilinear sampling reaches one cell into it from
    // either side, so the measured gap is that quarter, give or take a cell.
    expect(stats.longestGap).toBeGreaterThan(stats.totalDistance * 0.2);
    expect(stats.longestGap).toBeLessThan(stats.totalDistance * 0.3);
    // The step across a gap is counted ONCE, as the difference of its two ends:
    // a lower bound on what happened in between, and the same total a monotone
    // ramp gives with no gap at all.
    expectCloseRel(stats.ascent, whole.ascent, 1e-3);
    expect(stats.descent).toBeLessThan(1e-6);
  });

  test('terrain hidden inside a gap is not invented', () => {
    // A 900 m spike buried in the nodata band: the totals must not see it,
    // because a profile only ever claims what it read.
    const hidden = syntheticGrid(fx => (fx > 0.4 && fx < 0.6 ? NaN : fx * 400));
    const spiked = syntheticGrid(fx => (fx > 0.4 && fx < 0.6 ? (fx > 0.45 && fx < 0.55 ? 900 : fx * 400) : fx * 400));
    const stats = profileStats(buildProfilePoints(LINE, hidden, { samples: 400 }))!;
    const spiky = profileStats(buildProfilePoints(LINE, spiked, { samples: 400 }))!;
    expect(spiky.maxElevation).toBeGreaterThan(800);
    expect(stats.maxElevation).toBeLessThan(400);
    expect(stats.longestGap).toBeGreaterThan(0);
    expect(spiky.longestGap).toBe(0);
  });

  test('nothing but nodata is no profile at all', () => {
    const points = buildProfilePoints(LINE, syntheticGrid(() => NaN), { samples: 50 });
    expect(profileStats(points)).toBeNull();
    expect(profileStats([])).toBeNull();
  });

  test('flat ground has no ascent, no descent and no gradient', () => {
    const stats = profileStats(buildProfilePoints(LINE, syntheticGrid(() => 123), { samples: 50 }))!;
    // Bilinear weights over a constant field leave float dust, not relief.
    expect(stats.ascent).toBeLessThan(1e-6);
    expect(stats.descent).toBeLessThan(1e-6);
    expect(stats.maxGradePercent).toBeLessThan(1e-6);
    expect(stats.minElevation).toBeCloseTo(123, 6);
    expect(stats.maxElevation).toBeCloseTo(123, 6);
  });
});

describe('locating a point on the line', () => {
  const points = buildProfilePoints(LINE, rampUp(), { samples: 101 });

  test('the nearest sample to a distance is returned', () => {
    const total = points[points.length - 1].distance;
    expect(profilePointAtDistance(points, 0)).toBe(points[0]);
    expect(profilePointAtDistance(points, total)).toBe(points[100]);
    expect(profilePointAtDistance(points, total / 2)).toBe(points[50]);
    expect(profilePointAtDistance(points, total * 0.501)).toBe(points[50]);
    expect(profilePointAtDistance(points, -50)).toBe(points[0]);
    expect(profilePointAtDistance(points, total + 500)).toBe(points[100]);
    expect(profilePointAtDistance([], 10)).toBeNull();
  });

  test('a distance maps back to a coordinate on the drawn line', () => {
    const total = points[points.length - 1].distance;
    const start = coordinateAtDistance(LINE, 0)!;
    expect(start[0]).toBeCloseTo(LINE[0][0], 6);
    const end = coordinateAtDistance(LINE, total)!;
    expect(end[0]).toBeCloseTo(LINE[1][0], 3);
    const half = coordinateAtDistance(LINE, total / 2)!;
    expect(half[0]).toBeCloseTo((LINE[0][0] + LINE[1][0]) / 2, 0);
    expect(coordinateAtDistance(LINE, total * 2)!).toEqual(end);
    expect(coordinateAtDistance([], 5)).toBeNull();
  });

  test('a bend is honoured: halfway along an L is on the second leg', () => {
    const l: [number, number][] = [
      [EXTENT[0], EXTENT[1]],
      [EXTENT[0] + 10000, EXTENT[1]],
      [EXTENT[0] + 10000, EXTENT[1] + 10000],
    ];
    const total = groundLineLength(l);
    const threeQuarters = coordinateAtDistance(l, total * 0.75)!;
    expect(threeQuarters[0]).toBeCloseTo(EXTENT[0] + 10000, 3);
    expect(threeQuarters[1]).toBeGreaterThan(EXTENT[1]);
  });
});

// --- the chart --------------------------------------------------------------

describe('niceAxisTicks', () => {
  test('steps are 1/2/2.5/5 × 10ⁿ and cover the range', () => {
    expect(niceAxisTicks(0, 1000, 5)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceAxisTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    const ticks = niceAxisTicks(137, 812, 5);
    expect(ticks[0]).toBeGreaterThanOrEqual(137);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(812);
    const steps = ticks.slice(1).map((t, i) => Number((t - ticks[i]).toPrecision(6)));
    expect(new Set(steps).size).toBe(1);
  });

  test('negative and flat ranges behave', () => {
    const negative = niceAxisTicks(-200, -50, 5);
    expect(negative[0]).toBeGreaterThanOrEqual(-200);
    expect(negative[negative.length - 1]).toBeLessThanOrEqual(-50);
    expect(niceAxisTicks(5, 5, 5)).toEqual([5]);
    expect(niceAxisTicks(NaN, 5, 5)).toEqual([]);
  });
});

/**
 * A well-formed SVG move/line path. Chrome rejects a malformed `d` outright
 * (and logs "attribute d: Expected number"), so the chart would silently draw
 * nothing while every number behind it stayed correct — hence the grammar
 * check rather than a substring one.
 */
const SEGMENT_RE = /^M -?[\d.]+,-?[\d.]+( L -?[\d.]+,-?[\d.]+)*$/;
const AREA_RE = /^M -?[\d.]+,-?[\d.]+( L -?[\d.]+,-?[\d.]+)+ Z$/;

function expectValidPaths(chart: { segments: string[]; areas: string[] }) {
  for (const d of chart.segments) {
    expect(d).toMatch(SEGMENT_RE);
    expect(d).not.toMatch(/L L/);
    expect(d).not.toMatch(/NaN|undefined/);
  }
  for (const d of chart.areas) {
    expect(d).toMatch(AREA_RE);
    expect(d).not.toMatch(/L L/);
    expect(d).not.toMatch(/NaN|undefined/);
  }
}

describe('buildProfileChart', () => {
  const box = { width: 600, height: 240 };

  test('a ramp becomes one line and one closed area', () => {
    const chart = buildProfileChart(buildProfilePoints(LINE, rampUp(), { samples: 100 }), box)!;
    expect(chart.segments).toHaveLength(1);
    expect(chart.areas).toHaveLength(1);
    expectValidPaths(chart);
    // The area is the line closed down to the baseline: two extra commands.
    expect(chart.areas[0].split(' L ').length).toBe(chart.segments[0].split(' L ').length + 2);
    expect(chart.areas[0].endsWith(' Z')).toBe(true);
    expect(chart.plot.w).toBeLessThan(box.width);
    expect(chart.plot.h).toBeLessThan(box.height);
  });

  test('a nodata gap splits the line, and is not drawn as a plunge to zero', () => {
    const chart = buildProfileChart(buildProfilePoints(LINE, gappedRamp(), { samples: 100 }), box)!;
    expect(chart.segments.length).toBe(2);
    expect(chart.areas.length).toBe(2);
    expectValidPaths(chart);
  });

  test('screen coordinates run the way SVG does, and invert', () => {
    const points = buildProfilePoints(LINE, valley(), { samples: 100 });
    const chart = buildProfileChart(points, box)!;
    expectValidPaths(chart);
    expect(chart.yFor(chart.maxElevation)).toBeLessThan(chart.yFor(chart.minElevation));
    expect(chart.xFor(0)).toBeCloseTo(chart.plot.x, 6);
    expect(chart.xFor(chart.maxDistance)).toBeCloseTo(chart.plot.x + chart.plot.w, 6);
    const total = points[points.length - 1].distance;
    expect(chart.distanceAtX(chart.xFor(total * 0.4))).toBeCloseTo(total * 0.4, 6);
    expect(chart.distanceAtX(chart.plot.x - 500)).toBe(0);
    expect(chart.distanceAtX(chart.plot.x + chart.plot.w + 500)).toBeCloseTo(chart.maxDistance, 6);
    expect(chart.elevationAtY(chart.yFor(200))).toBeCloseTo(200, 6);
  });

  test('the elevation axis pads the data, or starts at zero when asked', () => {
    const points = buildProfilePoints(LINE, rampUp(), { samples: 50 });
    const auto = buildProfileChart(points, box)!;
    expect(auto.minElevation).toBeLessThan(40);
    expect(auto.maxElevation).toBeGreaterThan(360);
    const zero = buildProfileChart(points, { ...box, zeroBaseline: true })!;
    expect(zero.minElevation).toBeLessThanOrEqual(0);
    expect(zero.yFor(0)).toBeLessThanOrEqual(zero.plot.y + zero.plot.h + 1e-6);
  });

  test('ticks carry the labels the caller asked for', () => {
    const chart = buildProfileChart(buildProfilePoints(LINE, rampUp(), { samples: 50 }), {
      ...box,
      labelDistance: m => `${Math.round(m)} METRES`,
      labelElevation: m => `${Math.round(m)} M`,
    })!;
    expect(chart.xTicks.length).toBeGreaterThan(1);
    expect(chart.xTicks[0].label).toMatch(/METRES$/);
    expect(chart.xTicks[0].value).toBe(0);
    expect(chart.yTicks.every(t => /M$/.test(t.label))).toBe(true);
    for (const tick of chart.xTicks) {
      expect(tick.at).toBeGreaterThanOrEqual(chart.plot.x - 1e-6);
      expect(tick.at).toBeLessThanOrEqual(chart.plot.x + chart.plot.w + 1e-6);
    }
  });

  test('the drawing is vertically exaggerated, and says by how much', () => {
    const chart = buildProfileChart(buildProfilePoints(LINE, rampUp(), { samples: 50 }), box)!;
    // 320 m of relief over 16 km, drawn into 600×240 px: hugely exaggerated.
    expect(chart.exaggeration).toBeGreaterThan(10);
    const flat = buildProfileChart(buildProfilePoints(LINE, syntheticGrid(() => 100), { samples: 50 }), box)!;
    expect(flat.exaggeration).toBeGreaterThan(0);
  });

  test('nothing to chart yields null rather than an empty drawing', () => {
    expect(buildProfileChart([], box)).toBeNull();
    expect(buildProfileChart(buildProfilePoints(LINE, rampUp(), { samples: 4 }).slice(0, 1), box)).toBeNull();
    expect(buildProfileChart(buildProfilePoints(LINE, syntheticGrid(() => NaN), { samples: 50 }), box)).toBeNull();
    expect(buildProfileChart(buildProfilePoints(LINE, rampUp(), { samples: 50 }), { width: 0, height: 240 })).toBeNull();
  });
});

// --- what a saved line carries ----------------------------------------------

describe('saving a profile to a vector layer', () => {
  const points = buildProfilePoints(LINE, rampUp(), { samples: 60 });
  const stats = profileStats(points)!;

  test('the points ride along as an attribute, rounded but complete', () => {
    const records = profilePointRecords(points);
    expect(records).toHaveLength(points.length);
    expect(records[0]).toEqual({
      distance: 0,
      elevation: expect.any(Number),
      lon: expect.any(Number),
      lat: expect.any(Number),
    });
    expect(records[0].lon).toBeCloseTo(points[0].lon, 6);
    // Rounded for storage: no more than 2 dp of distance, 3 dp of elevation.
    for (const r of records) {
      expectCloseRel(r.distance * 100, Math.round(r.distance * 100), 1e-9);
      if (r.elevation !== null) expectCloseRel(r.elevation * 1000, Math.round(r.elevation * 1000), 1e-9);
    }
  });

  test('nodata stays null in the saved points', () => {
    const gapped = profilePointRecords(buildProfilePoints(LINE, gappedRamp(), { samples: 60 }));
    expect(gapped.some(r => r.elevation === null)).toBe(true);
  });

  test('the feature attributes carry the summary and the points', () => {
    const attrs = profileFeatureAttributes({
      name: 'Elevation Profile 1',
      sourceLayer: 'Terrarium',
      renderer: 'Contours · terrain tiles',
      stats,
      points,
    });
    expect(attrs[PROFILE_FIELDS.name]).toBe('Elevation Profile 1');
    expect(attrs[PROFILE_FIELDS.source]).toBe('Terrarium');
    expect(attrs[PROFILE_FIELDS.renderer]).toBe('Contours · terrain tiles');
    expect(attrs[PROFILE_FIELDS.length]).toBeCloseTo(stats.totalDistance, 2);
    expect(attrs[PROFILE_FIELDS.samples]).toBe(stats.sampleCount);
    expect(attrs[PROFILE_FIELDS.minElevation]).toBeCloseTo(stats.minElevation, 3);
    expect(attrs[PROFILE_FIELDS.maxElevation]).toBeCloseTo(stats.maxElevation, 3);
    expect(attrs[PROFILE_FIELDS.ascent]).toBeCloseTo(stats.ascent, 3);
    expect(attrs[PROFILE_FIELDS.descent]).toBe(0);
    expect(attrs[PROFILE_FIELDS.points]).toHaveLength(points.length);
    // Every field name is a plain, table-friendly identifier.
    for (const key of Object.keys(attrs)) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test('the GeoJSON is one LineString in EPSG:3857 with those properties', () => {
    const geoJson = profileLineGeoJson(LINE, { a: 1 });
    const parsed = JSON.parse(geoJson);
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].geometry.type).toBe('LineString');
    expect(parsed.features[0].geometry.coordinates).toHaveLength(2);
    expect(parsed.features[0].geometry.coordinates[0][0]).toBeCloseTo(LINE[0][0], 3);
    expect(parsed.features[0].properties).toEqual({ a: 1 });
    expect(geoJson).not.toMatch(/NaN/);
  });

  test('a saved profile line can be read straight back into a chart', () => {
    const attrs = profileFeatureAttributes({ name: 'p', sourceLayer: 's', renderer: 'r', stats, points });
    const parsed = JSON.parse(profileLineGeoJson(LINE, attrs));
    const saved = parsed.features[0].properties[PROFILE_FIELDS.points] as ProfilePoint[];
    // The stored records hold distance + elevation, which is all a re-plot needs.
    const replotted = saved.map((r: any) => ({ ...r, x: 0, y: 0 })) as ProfilePoint[];
    const chart = buildProfileChart(replotted, { width: 600, height: 240 })!;
    expect(chart.segments).toHaveLength(1);
    expect(chart.maxDistance).toBeCloseTo(stats.totalDistance, 1);
  });
});

// --- failures and formatting ------------------------------------------------

describe('profileFailureMessage', () => {
  test('every refusal says something useful, naming the layer', () => {
    const failures = [
      'no-terrain', 'no-source', 'no-tile-template', 'no-tiles', 'bad-line',
      'source-not-ready', 'bad-extent', 'no-georeference', 'no-transform',
      'no-overlap', 'too-large', 'read-error', 'no-values',
    ] as const;
    for (const failure of failures) {
      const message = profileFailureMessage(failure, 'Terrarium');
      expect(message, failure).toBeTruthy();
      expect(message!.length).toBeGreaterThan(15);
    }
    expect(profileFailureMessage('no-terrain', 'Terrarium')).toMatch(/Terrarium/);
    expect(profileFailureMessage('no-terrain', 'Terrarium')).toMatch(/Hillshade|Contours/);
    expect(profileFailureMessage('no-tiles', 'Terrarium', 'CORS')).toMatch(/CORS/);
    expect(profileFailureMessage('too-large', 'DEM')).toMatch(/zoom in|shorter/i);
  });

  test('a superseded read and no failure at all are silent', () => {
    expect(profileFailureMessage('cancelled', 'x')).toBeNull();
    expect(profileFailureMessage(null, 'x')).toBeNull();
    expect(profileFailureMessage(undefined, 'x')).toBeNull();
  });

  test('a layer with no name is still described', () => {
    expect(profileFailureMessage('no-values', '')).toMatch(/this layer/);
  });
});

describe('readouts', () => {
  test('elevations follow the app units', () => {
    expect(formatProfileElevation(1234.56, 'metric')).toMatch(/1,234\.6 m$/);
    expect(formatProfileElevation(1000, 'imperial')).toMatch(/ft$/);
    expect(Number(formatProfileElevation(1000, 'imperial')!.replace(/[^0-9.]/g, ''))).toBeCloseTo(3280.8, 0);
    expect(formatProfileElevation(NaN, 'metric')).toBe('—');
  });

  test('axis labels stay compact and switch units early', () => {
    expect(formatProfileDistanceTick(0, 'metric')).toBe('0 m');
    expect(formatProfileDistanceTick(250, 'metric')).toBe('250 m');
    expect(formatProfileDistanceTick(1500, 'metric')).toBe('1.5 km');
    expect(formatProfileDistanceTick(1600, 'imperial')).toMatch(/ft$/);
    expect(formatProfileDistanceTick(1700, 'imperial')).toMatch(/mi$/);
    expect(formatProfileDistanceTick(300, 'imperial')).toMatch(/ft$/);
    expect(formatProfileGrade(12.34)).toBe('12.3%');
    expect(formatProfileGrade(NaN)).toBe('—');
  });
});

// --- the window's geometry --------------------------------------------------

describe('window geometry', () => {
  test('a saved rect comes back exactly', () => {
    expect(loadElevProfileGeometry()).toBeNull();
    saveElevProfileGeometry({ x: 40, y: 30, w: 700, h: 500 });
    expect(loadElevProfileGeometry()).toEqual({ x: 40, y: 30, w: 700, h: 500 });
    expect(localStorage.getItem(ELEV_PROFILE_GEOMETRY_KEY)).toBeTruthy();
  });

  test('garbage in storage is ignored', () => {
    localStorage.setItem(ELEV_PROFILE_GEOMETRY_KEY, 'not json');
    expect(loadElevProfileGeometry()).toBeNull();
    localStorage.setItem(ELEV_PROFILE_GEOMETRY_KEY, JSON.stringify({ x: 1, y: 2, w: 'wide', h: 4 }));
    expect(loadElevProfileGeometry()).toBeNull();
  });

  test('clamping keeps the window inside its container and at least its minimum size', () => {
    expect(clampElevProfileRect({ x: -500, y: -500, w: 100, h: 100 }, 1200, 800))
      .toEqual({ x: 0, y: 0, w: ELEV_PROFILE_MIN_W, h: ELEV_PROFILE_MIN_H });
    expect(clampElevProfileRect({ x: 5000, y: 5000, w: 4000, h: 4000 }, 1200, 800))
      .toEqual({ x: 0, y: 0, w: 1200, h: 800 });
    const inside = clampElevProfileRect({ x: 900, y: 600, w: 500, h: 400 }, 1200, 800);
    expect(inside.x + inside.w).toBeLessThanOrEqual(1200);
    expect(inside.y + inside.h).toBeLessThanOrEqual(800);
    expect(ELEV_PROFILE_DEFAULT_RECT.w).toBeGreaterThanOrEqual(ELEV_PROFILE_MIN_W);
    expect(ELEV_PROFILE_DEFAULT_RECT.h).toBeGreaterThanOrEqual(ELEV_PROFILE_MIN_H);
  });
});

// --- the readers ------------------------------------------------------------

describe('sampleElevationProfile — refusals', () => {
  test('a layer that is not rendering terrain is refused before anything is read', async () => {
    const result = await sampleElevationProfile({
      layer: tileLayer({ tileRender: { mode: 'default', encoding: 'terrarium' } }),
      coords: LINE,
    });
    expect(result.failure).toBe('no-terrain');
    expect(result.points).toEqual([]);
    expect(readTiles).not.toHaveBeenCalled();
  });

  test('a line with fewer than two vertices is refused', async () => {
    const result = await sampleElevationProfile({ layer: tileLayer(), coords: [LINE[0]] });
    expect(result.failure).toBe('bad-line');
  });

  test('a layer that is not on the map yet is refused', async () => {
    const result = await sampleElevationProfile({ layer: tileLayer({ olLayer: undefined }), coords: LINE });
    expect(result.failure).toBe('no-source');
    expect(profileFailureMessage(result.failure, 'Terrarium')).toMatch(/not on the map/);
  });

  test('a source whose tiles are not an XYZ template is refused with the reason', async () => {
    const wms = { getTileGrid: () => ({}), getUrls: () => ['https://wms.example.com/wms?SERVICE=WMS'] };
    const result = await sampleElevationProfile({
      layer: tileLayer({ olLayer: { getSource: () => wms } }),
      coords: LINE,
    });
    expect(result.failure).toBe('no-tile-template');
    expect(profileFailureMessage(result.failure, 'Terrarium')).toMatch(/XYZ/);
    expect(readTiles).not.toHaveBeenCalled();
  });

  test('an already-aborted read never starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await sampleElevationProfile({ layer: tileLayer(), coords: LINE, signal: controller.signal });
    expect(result.failure).toBe('cancelled');
    expect(readTiles).not.toHaveBeenCalled();
  });

  test('a COG whose imagery has not parsed yet says so', async () => {
    const result = await sampleElevationProfile({ layer: cogLayer({ sourceImagery_: [] }), coords: LINE });
    expect(result.failure).toBe('source-not-ready');
    expect(profileFailureMessage(result.failure, 'DEM')).toMatch(/still loading/);
  });

  test('a tile read that produces no grid is reported as unreadable tiles', async () => {
    readTiles.mockResolvedValue(null);
    const result = await sampleElevationProfile({ layer: tileLayer(), coords: LINE });
    expect(result.failure).toBe('no-tiles');
    expect(result.plan).not.toBeNull();
  });
});

describe('sampleElevationProfile — terrain tiles', () => {
  test('the tile reader is asked for exactly the planned window, at the map zoom', async () => {
    mockTileRead(fx => fx * 400);
    const layer = tileLayer({ tileRender: { mode: 'hillshade', encoding: 'mapbox', grayscaleRange: { min: 0, max: 900 } } });
    const result = await sampleElevationProfile({ layer, coords: LINE, samples: 120, zoom: 13 });

    expect(result.failure).toBeNull();
    expect(readTiles).toHaveBeenCalledTimes(1);
    const asked = readTiles.mock.calls[0][0] as any;
    expect(asked.viewProjection).toBe('EPSG:3857');
    expect(asked.viewExtent).toEqual(result.plan!.extent);
    expect(asked.viewport).toEqual({ width: result.plan!.gridWidth, height: result.plan!.gridHeight });
    expect(asked.encoding).toBe('mapbox');
    expect(asked.grayscaleRange).toEqual({ min: 0, max: 900 });
    // downscale 1: a profile wants the grid it planned, not QGIS' contour
    // input downscaling.
    expect(asked.downscale).toBe(1);
    expect(asked.zoom).toBe(13);
    expect(asked.source).toBe(TILE_SOURCE);

    expect(result.grid?.kind).toBe('tile');
    expect(result.grid?.detail).toBe('tiles z13');
    expect(result.grid?.cellSize).toBeGreaterThan(0);
    expect(result.stats!.sampleCount).toBe(result.plan!.samples);
    expect(result.stats!.ascent).toBeGreaterThan(0);
    expect(result.stats!.descent).toBe(0);
    expect(result.points).toHaveLength(result.plan!.samples);
    // The read window is padded, so the line covers the middle of the ramp.
    expect(result.stats!.maxElevation).toBeLessThan(400);
    expect(result.stats!.minElevation).toBeGreaterThan(0);
  });

  test('a hillshade layer is read through the source its wrapper shades', async () => {
    mockTileRead(fx => fx * 400);
    const wrapper = { layers_: [{ getSource: () => TILE_SOURCE }] };
    const result = await sampleElevationProfile({
      layer: tileLayer({
        tileRender: { mode: 'hillshade', encoding: 'terrarium' },
        olLayer: { getSource: () => wrapper },
      }),
      coords: LINE,
    });
    expect(result.failure).toBeNull();
    expect((readTiles.mock.calls[0][0] as any).source).toBe(TILE_SOURCE);
  });

  test('the map zoom is optional', async () => {
    mockTileRead(fx => fx * 400);
    const result = await sampleElevationProfile({ layer: tileLayer(), coords: LINE });
    expect(result.failure).toBeNull();
    expect((readTiles.mock.calls[0][0] as any).zoom).toBeUndefined();
    expect(result.grid?.detail).toBe('tiles');
  });
});

describe('sampleElevationProfile — a COG DEM', () => {
  test('reads the elevation band for real and charts the ramp under the line', async () => {
    const source = fakeCogSource();
    const result = await sampleElevationProfile({ layer: cogLayer(source), coords: LINE, samples: 150 });

    expect(result.failure).toBeNull();
    expect(result.grid?.kind).toBe('cog');
    expect(result.grid?.detail).toBe('band 1');
    expect(result.points.length).toBeGreaterThan(50);
    for (let i = 1; i < result.points.length; i++) {
      expect(result.points[i].elevation).toBeGreaterThanOrEqual(result.points[i - 1].elevation - 1e-3);
    }
    // The fake file rises 100 → 600 m west to east; the line covers 10% → 90%.
    expect(result.stats!.minElevation).toBeGreaterThan(120);
    expect(result.stats!.minElevation).toBeLessThan(180);
    expect(result.stats!.maxElevation).toBeGreaterThan(520);
    expect(result.stats!.maxElevation).toBeLessThan(580);
    expect(result.stats!.descent).toBe(0);
    expect(result.stats!.totalDistance).toBeCloseTo(groundLineLength(LINE), 0);
    // The chart the window draws from it.
    const chart = buildProfileChart(result.points, { width: 600, height: 240 })!;
    expect(chart.segments).toHaveLength(1);
  });

  test('a line off the file is reported, not silently empty', async () => {
    const elsewhere: [number, number][] = [
      [EXTENT[0] + 900000, EXTENT[1] + 900000],
      [EXTENT[0] + 910000, EXTENT[1] + 900000],
    ];
    const result = await sampleElevationProfile({ layer: cogLayer(fakeCogSource()), coords: elsewhere });
    expect(result.failure).toBe('no-overlap');
    expect(profileFailureMessage(result.failure, 'DEM')).toMatch(/outside/i);
  });

  test('the band the renderer reads is the band the profile reads', async () => {
    const reads: any[] = [];
    const image = fakeCogImage(2000, 1000, 3);
    const original = image.readRasters;
    image.readRasters = async (read: any) => { reads.push(read); return original(read); };
    const source = { sourceImagery_: [[image]], getProjection: () => ({ getCode: () => 'EPSG:3857' }) };
    await sampleElevationProfile({
      layer: cogLayer(source, { cogRender: { mode: 'contour', band: 3 } }),
      coords: LINE,
    });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0].samples).toEqual([2]);
  });
});
