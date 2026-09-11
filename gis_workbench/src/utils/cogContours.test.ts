/**
 * COG contour lines — the QGIS "Contours" renderer as vector geometry.
 *
 * These are the pure decisions behind hooks/useCogContours: which elevations
 * get a line, how the DEM is sampled (QGIS' input downscaling), how the traced
 * pixels become map coordinates, and how the two line symbols — including the
 * optional elevation labels — are built.
 */
import { describe, expect, test } from 'vitest';
import { transformExtent } from 'ol/proj.js';
import type { CogContourConfig } from '../types';
import { DEFAULT_CONTOUR, MAX_CONTOUR_DOWNSCALE } from './cogBands';
import {
  CONTOUR_INDEX_PROPERTY,
  CONTOUR_LEVEL_PROPERTY,
  MAX_CONTOUR_GRID_CELLS,
  MAX_CONTOUR_LEVELS,
  MAX_READ_PIXELS,
  buildContourFeatures,
  contourCapMessage,
  contourDashPattern,
  contourFailureMessage,
  contourLabelFont,
  contourStroke,
  contourStyleFunction,
  createContourLayer,
  gridRange,
  levelGeometries,
  planContourLevels,
  readCogElevationGrid,
  readCogElevationGridDetailed,
  traceCogContours,
  traceCogContoursDetailed,
  type CogContourGrid,
} from './cogContours';

// --- fixtures ---------------------------------------------------------------

/** A stand-in for one geotiff.js image level of a loaded COG. */
function fakeImage(opts: {
  width: number;
  height: number;
  /** Ground extent; defaults to the pixel box. Ignored when `geoKeys` is off. */
  bbox?: number[];
  resolution?: number[];
  samples?: number;
  nodata?: number | null;
  /**
   * Off mimics a GDAL COG's overview IFDs, which carry no ModelTiepoint or
   * ModelPixelScale: geotiff.js throws when their geometry is asked for.
   */
  geoKeys?: boolean;
  /** Elevation at a (fractional) pixel of this level. */
  value: (x: number, y: number) => number;
}) {
  const reads: any[] = [];
  const bbox = opts.bbox ?? [0, 0, opts.width, opts.height];
  const georeferenced = opts.geoKeys !== false;
  const noAffine = (): never => {
    throw new Error('The image does not have an affine transformation.');
  };
  return {
    reads,
    getWidth: () => opts.width,
    getHeight: () => opts.height,
    getBoundingBox: () => (georeferenced ? bbox : noAffine()),
    getResolution: () => (georeferenced ? opts.resolution ?? [1, -1] : noAffine()),
    getSamplesPerPixel: () => opts.samples ?? 1,
    getGDALNoData: () => (opts.nodata === undefined ? null : opts.nodata),
    readRasters: async (read: any) => {
      reads.push(read);
      const [wx0, wy0, wx1, wy1] = read.window;
      const outW = read.width ?? wx1 - wx0;
      const outH = read.height ?? wy1 - wy0;
      const values = new Float32Array(outW * outH);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          // Resample the window the way geotiff.js does: cell centres.
          const px = wx0 + ((x + 0.5) * (wx1 - wx0)) / outW;
          const py = wy0 + ((y + 0.5) * (wy1 - wy0)) / outH;
          values[y * outW + x] = opts.value(px, py);
        }
      }
      return [values];
    },
  };
}

/** A ready `ol/source/GeoTIFF` with the private level list OL keeps. */
function fakeSource(levels: any[][], projection = 'EPSG:3857') {
  return {
    sourceImagery_: levels,
    getProjection: () => ({ getCode: () => projection }),
  };
}

/** A 10x10 grid rising one unit per column, covering 0..90 in both axes. */
function rampGrid(over: Partial<CogContourGrid> = {}): CogContourGrid {
  const field = new Float32Array(100);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) field[y * 10 + x] = x;
  }
  return {
    field,
    width: 10,
    height: 10,
    fileExtent: [0, 0, 90, 90],
    extent: [0, 0, 90, 90],
    projection: null,
    caps: [],
    ...over,
  };
}

// --- levels -----------------------------------------------------------------

describe('planContourLevels', () => {
  test('every multiple of the interval inside the range gets a line', () => {
    const { levels, caps } = planContourLevels(3, 27, 10, 50);
    expect(levels.map((l) => l.level)).toEqual([10, 20]);
    expect(levels.every((l) => !l.index)).toBe(true);
    expect(caps).toEqual([]);
  });

  test('multiples of the index interval are flagged as index contours', () => {
    const { levels } = planContourLevels(0, 100, 10, 50);
    expect(levels.filter((l) => l.index).map((l) => l.level)).toEqual([0, 50, 100]);
    expect(levels).toHaveLength(11);
  });

  test('negative terrain is lined up on the interval, not on zero offset', () => {
    const { levels } = planContourLevels(-25, 5, 10, 20);
    expect(levels.map((l) => l.level)).toEqual([-20, -10, 0]);
    expect(levels.map((l) => l.index)).toEqual([true, false, true]);
  });

  test('a flat or nonsensical range traces nothing', () => {
    expect(planContourLevels(50, 50, 10, 50).levels).toEqual([]);
    expect(planContourLevels(80, 20, 10, 50).levels).toEqual([]);
    expect(planContourLevels(0, 100, 0, 50).levels).toEqual([]);
    expect(planContourLevels(NaN, 100, 10, 50).levels).toEqual([]);
  });

  test('an interval far too small is thinned evenly instead of truncated', () => {
    const { levels, caps } = planContourLevels(0, 10_000, 1, 500, MAX_CONTOUR_LEVELS);
    expect(caps).toEqual(['levels']);
    expect(levels.length).toBeLessThanOrEqual(MAX_CONTOUR_LEVELS);
    // Still covers the whole range, and every level keeps its true elevation.
    expect(levels[0].level).toBe(0);
    expect(levels[levels.length - 1].level).toBeGreaterThan(9_900);
  });

  test('a fractional interval does not drift off its multiples', () => {
    const { levels } = planContourLevels(0, 1, 0.1, 0.5);
    expect(levels.map((l) => Number(l.level.toFixed(6)))).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(levels.filter((l) => l.index).map((l) => l.level.toFixed(1))).toEqual(['0.0', '0.5', '1.0']);
  });
});

describe('gridRange', () => {
  test('nodata cells (NaN) are ignored', () => {
    const field = new Float32Array([1, NaN, 5, -3, NaN]);
    expect(gridRange(field)).toEqual({ min: -3, max: 5, samples: 3 });
  });

  test('an all-nodata grid has no range', () => {
    expect(gridRange(new Float32Array([NaN, NaN]))).toBeNull();
  });
});

// --- reading the DEM (QGIS' input downscaling) ------------------------------

describe('readCogElevationGrid', () => {
  const source = () => fakeSource([[
    fakeImage({ width: 1000, height: 1000, bbox: [0, 0, 1000, 1000], value: (x) => x }),
  ]]);

  test('the grid is the screen size divided by the downscaling factor', async () => {
    const src = source();
    const grid = await readCogElevationGrid(src, [100, 200, 500, 500], 'EPSG:3857', { width: 800, height: 600 }, 1, 4, 2);
    expect(grid).not.toBeNull();
    // QGIS asks its input for (width*oversampling)/downscale x (height*oversampling)/downscale samples.
    expect(src.sourceImagery_[0][0].reads[0]).toMatchObject({ width: 400, height: 300 });
    expect([grid!.width, grid!.height]).toEqual([400, 300]);
    expect(grid!.caps).toEqual([]);
  });

  test('downscaling 1 reads the screen pixel for pixel', async () => {
    const src = source();
    const grid = await readCogElevationGrid(src, [0, 0, 512, 512], 'EPSG:3857', { width: 512, height: 512 }, 1, 1, 1);
    expect([grid!.width, grid!.height]).toEqual([512, 512]);
    expect(src.sourceImagery_[0][0].reads[0].width).toBe(512);
  });

  test('oversampling multiplies the grid before downscaling is applied', async () => {
    const src = source();
    // 800 px viewport, downscale 4, oversampling 2 → (800*2)/4 = 400 cells wide.
    const grid = await readCogElevationGrid(src, [100, 200, 500, 500], 'EPSG:3857', { width: 800, height: 600 }, 1, 4, 2);
    expect([grid!.width, grid!.height]).toEqual([400, 300]);
    // Without oversampling (oversampling=1) the same downscale gives half the grid.
    const src2 = source();
    const grid2 = await readCogElevationGrid(src2, [100, 200, 500, 500], 'EPSG:3857', { width: 800, height: 600 }, 1, 4, 1);
    expect([grid2!.width, grid2!.height]).toEqual([200, 150]);
  });

  test('the window is the view extent in the level\'s own pixels', async () => {
    const src = source();
    await readCogElevationGrid(src, [100, 200, 300, 400], 'EPSG:3857', { width: 200, height: 200 }, 1, 1, 1);
    // Rows run north → south, so the north edge (y=400) is row 600.
    expect(src.sourceImagery_[0][0].reads[0].window).toEqual([100, 600, 300, 800]);
  });

  test('a view outside the file reads nothing', async () => {
    const grid = await readCogElevationGrid(source(), [5000, 5000, 6000, 6000], 'EPSG:3857', { width: 400, height: 400 }, 1, 4, 1);
    expect(grid).toBeNull();
  });

  test('a grid is never upscaled past the pixels that were read', async () => {
    const src = fakeSource([[
      fakeImage({ width: 40, height: 40, bbox: [0, 0, 40, 40], value: (x) => x }),
    ]]);
    const grid = await readCogElevationGrid(src, [0, 0, 40, 40], 'EPSG:3857', { width: 2000, height: 2000 }, 1, 1, 1);
    expect([grid!.width, grid!.height]).toEqual([40, 40]);
  });

  test('an enormous view is read at the grid cap and says so', async () => {
    const src = fakeSource([[
      fakeImage({ width: 2000, height: 2000, bbox: [0, 0, 2000, 2000], value: (x) => x }),
    ]]);
    const grid = await readCogElevationGrid(src, [0, 0, 2000, 2000], 'EPSG:3857', { width: 8000, height: 8000 }, 1, 1, 1);
    expect([grid!.width, grid!.height]).toEqual([MAX_CONTOUR_GRID_CELLS, MAX_CONTOUR_GRID_CELLS]);
    expect(grid!.caps).toContain('grid');
  });

  test('a window geotiff.js would have to materialise whole walks to a coarser level', async () => {
    // geotiff.js allocates the entire window before it resamples, so a view
    // that covers a 64 Mpixel level must not ask for it: the overview is read
    // instead (upsampled), and a file with no overview to fall back on reads
    // nothing rather than throwing a RangeError.
    const coarse = fakeImage({ width: 100, height: 100, bbox: [0, 0, 8000, 8000], resolution: [80, -80], value: (x) => x });
    const fine = fakeImage({ width: 8000, height: 8000, bbox: [0, 0, 8000, 8000], resolution: [1, -1], value: (x) => x });
    const withOverview = await readCogElevationGrid(
      fakeSource([[coarse, fine]]), [0, 0, 8000, 8000], 'EPSG:3857', { width: 800, height: 800 }, 1, 1, 1,
    );
    expect(withOverview).not.toBeNull();
    expect(coarse.reads.length).toBe(1);
    expect(fine.reads.length).toBe(0);

    const noOverview = await readCogElevationGrid(
      fakeSource([[fine]]), [0, 0, 8000, 8000], 'EPSG:3857', { width: 800, height: 800 }, 1, 1, 1,
    );
    expect(noOverview).toBeNull();
    expect(fine.reads.length).toBe(0);
  });

  test('the coarsest overview fine enough for the step is the one read', async () => {
    const coarse = fakeImage({ width: 100, height: 100, bbox: [0, 0, 1000, 1000], resolution: [10, -10], value: (x) => x });
    const mid = fakeImage({ width: 250, height: 250, bbox: [0, 0, 1000, 1000], resolution: [4, -4], value: (x) => x });
    const fine = fakeImage({ width: 1000, height: 1000, bbox: [0, 0, 1000, 1000], resolution: [1, -1], value: (x) => x });
    const src = fakeSource([[coarse, mid, fine]]);
    // 1000 units across a 500 px screen at downscale 5 with oversampling 2 → 200 cells → 5 units per cell:
    // the 4-unit overview is the coarsest fine enough, the 10-unit one is too coarse.
    await readCogElevationGrid(src, [0, 0, 1000, 1000], 'EPSG:3857', { width: 500, height: 500 }, 1, 5, 2);
    expect(coarse.reads).toHaveLength(0);
    expect(mid.reads).toHaveLength(1);
    expect(fine.reads).toHaveLength(0);
  });

  test('nodata values become NaN holes instead of elevations', async () => {
    const src = fakeSource([[
      fakeImage({ width: 100, height: 100, bbox: [0, 0, 100, 100], nodata: -9999, value: (x) => (x < 50 ? -9999 : x) }),
    ]]);
    const grid = await readCogElevationGrid(src, [0, 0, 100, 100], 'EPSG:3857', { width: 100, height: 100 }, 1, 1, 1);
    const holes = Array.from(grid!.field).filter((v) => Number.isNaN(v)).length;
    expect(holes).toBeGreaterThan(0);
    expect(gridRange(grid!.field)!.min).toBeGreaterThanOrEqual(50);
  });

  test('the requested band is the sample that gets read', async () => {
    const src = fakeSource([[
      fakeImage({ width: 100, height: 100, bbox: [0, 0, 100, 100], samples: 3, value: (x) => x }),
    ]]);
    await readCogElevationGrid(src, [0, 0, 100, 100], 'EPSG:3857', { width: 100, height: 100 }, 2, 1, 1);
    expect(src.sourceImagery_[0][0].reads[0].samples).toEqual([1]);
    // A band the file does not have falls back to the last one it does.
    await readCogElevationGrid(src, [0, 0, 100, 100], 'EPSG:3857', { width: 100, height: 100 }, 9, 1, 1);
    expect(src.sourceImagery_[0][0].reads[1].samples).toEqual([2]);
  });

  test('a metre-based file on a degree-based view is read and reported in the view CRS', async () => {
    // The app lets the user switch the view projection, and OL renders vector
    // layers in it without reprojecting — so the traced lines, and the extent
    // the cache compares against, must come out in the view's own CRS.
    const bbox = transformExtent([145, -40, 150, -35], 'EPSG:4326', 'EPSG:3857');
    const src = fakeSource([[
      fakeImage({ width: 300, height: 300, bbox, resolution: [1000, -1000], value: (x) => x }),
    ]]);
    const view = [146, -39, 149, -36]; // degrees
    const grid = await readCogElevationGrid(src, view, 'EPSG:4326', { width: 400, height: 400 }, 1, 4, 1);
    expect(grid).not.toBeNull();
    expect(grid!.projection).toBe('EPSG:3857');
    // The window is in the file's metres...
    const read = src.sourceImagery_[0][0].reads[0];
    expect(read.window[0]).toBeGreaterThan(0);
    expect(read.window[2]).toBeLessThan(300);
    // ...and the reported extent back in the view's degrees.
    expect(grid!.extent[0]).toBeCloseTo(146, 1);
    expect(grid!.extent[2]).toBeCloseTo(149, 1);
  });

  test('traced lines land in the view projection', async () => {
    const bbox = transformExtent([146, -39, 149, -36], 'EPSG:4326', 'EPSG:3857');
    const traced = await traceCogContours({
      source: fakeSource([[fakeImage({ width: 100, height: 100, bbox, resolution: [5000, -5000], value: (x) => x })]]),
      viewExtent: [146, -39, 149, -36],
      viewProjection: 'EPSG:4326',
      viewport: { width: 100, height: 100 },
      band: 1,
      contour: { ...DEFAULT_CONTOUR, interval: 20 },
    });
    expect(traced).not.toBeNull();
    expect(traced!.features.length).toBeGreaterThan(0);
    const [x, y] = traced!.features[0].getGeometry().getCoordinates()[0];
    expect(x).toBeGreaterThan(145);
    expect(x).toBeLessThan(150);
    expect(y).toBeLessThan(-35);
    expect(y).toBeGreaterThan(-40);
  });

  test('a source with no parsed imagery reads nothing', async () => {
    expect(await readCogElevationGrid({ sourceImagery_: [] }, [0, 0, 1, 1], 'EPSG:3857', { width: 10, height: 10 }, 1, 4, 1)).toBeNull();
    expect(await readCogElevationGrid(null, [0, 0, 1, 1], 'EPSG:3857', { width: 10, height: 10 }, 1, 4, 1)).toBeNull();
  });
});

// --- the level list of a real COG -------------------------------------------

/**
 * A GDAL COG writes its geo-referencing once, on the main IFD. Every overview
 * IFD answers `getBoundingBox()` with "The image does not have an affine
 * transformation" — and they are the only levels small enough to read once the
 * view is wider than a few hundred metres, so ignoring them made every
 * zoomed-out contour trace fail.
 */
describe('levelGeometries', () => {
  const FILE_BBOX = [200000, 6087500, 210000, 6100000];
  const main = () => fakeImage({
    width: 2000, height: 2500, bbox: FILE_BBOX, resolution: [5, -5], nodata: -9999, value: (x) => x,
  });
  const overview = (width: number, height: number) => fakeImage({
    width, height, geoKeys: false, value: (x) => x,
  });

  test('overviews with no affine transform are kept and measured against the main image', () => {
    const geometries = levelGeometries([main(), overview(1000, 1250), overview(500, 625)]);
    expect(geometries).toHaveLength(3);
    // Coarsest first — the order `pickLevel` walks.
    expect(geometries.map((g) => g.width)).toEqual([500, 1000, 2000]);
    // An overview covers the same ground, so its pixel size scales by width.
    expect(geometries.map((g) => g.resX)).toEqual([20, 10, 5]);
    for (const geo of geometries) expect(geo.bbox).toEqual(FILE_BBOX);
  });

  test('the order the source keeps its levels in does not matter', () => {
    const finestFirst = levelGeometries([main(), overview(1000, 1250), overview(500, 625)]);
    const coarsestFirst = levelGeometries([overview(500, 625), overview(1000, 1250), main()]);
    expect(coarsestFirst.map((g) => g.width)).toEqual(finestFirst.map((g) => g.width));
    expect(coarsestFirst.map((g) => g.resX)).toEqual(finestFirst.map((g) => g.resX));
  });

  test('nodata is inherited from the main image when a level omits the tag', () => {
    const bare = fakeImage({ width: 1000, height: 1250, geoKeys: false, value: (x) => x });
    const geometries = levelGeometries([main(), bare]);
    expect(geometries.map((g) => g.nodata)).toEqual([-9999, -9999]);
  });

  test('a level that is geo-referenced in its own right keeps its own geometry', () => {
    const own = fakeImage({ width: 1000, height: 1250, bbox: [0, 0, 10000, 12500], value: (x) => x });
    const geometries = levelGeometries([main(), own]);
    expect(geometries.find((g) => g.width === 1000)!.bbox).toEqual([0, 0, 10000, 12500]);
  });

  test('a file with no geo-referencing anywhere has no readable level', () => {
    expect(levelGeometries([overview(500, 625), overview(250, 312)])).toEqual([]);
    expect(levelGeometries([])).toEqual([]);
    expect(levelGeometries([null, undefined])).toEqual([]);
  });

  test('a 1x1 level is dropped, like OpenLayers drops it', () => {
    const geometries = levelGeometries([main(), overview(1, 1)]);
    expect(geometries.map((g) => g.width)).toEqual([2000]);
  });
});

describe('reading a real COG layout', () => {
  const FILE_BBOX = [200000, 6087500, 210000, 6100000];
  /** 5 Mpixel main image: too large to read whole, so an overview must do. */
  const cogLevels = () => {
    const main = fakeImage({
      width: 2000, height: 2500, bbox: FILE_BBOX, resolution: [5, -5], nodata: -9999,
      value: (x, y) => 700 + 300 * Math.sin(x / 220) * Math.cos(y / 180),
    });
    const half = fakeImage({
      width: 1000, height: 1250, geoKeys: false, nodata: -9999,
      value: (x, y) => 700 + 300 * Math.sin(x / 110) * Math.cos(y / 90),
    });
    const quarter = fakeImage({
      width: 500, height: 625, geoKeys: false, nodata: -9999,
      value: (x, y) => 700 + 300 * Math.sin(x / 55) * Math.cos(y / 45),
    });
    return { main, half, quarter, source: fakeSource([[quarter, half, main]]) };
  };

  test('a whole-file view reads an overview instead of refusing', async () => {
    const { main, half, quarter, source } = cogLevels();
    expect(main.getWidth() * main.getHeight()).toBeGreaterThan(MAX_READ_PIXELS);
    const grid = await readCogElevationGrid(source, FILE_BBOX, 'EPSG:3857', { width: 1000, height: 800 }, 1, 4, 1);
    expect(grid).not.toBeNull();
    expect(main.reads).toHaveLength(0);
    expect(half.reads.length + quarter.reads.length).toBe(1);
    expect(grid!.width).toBeGreaterThan(1);
    const range = gridRange(grid!.field);
    expect(range!.min).toBeLessThan(range!.max);
  });

  test('the whole pass draws lines from a whole-file view', async () => {
    const { source } = cogLevels();
    const attempt = await traceCogContoursDetailed({
      source, viewExtent: FILE_BBOX, viewProjection: 'EPSG:3857',
      viewport: { width: 1000, height: 800 }, band: 1,
      contour: { ...DEFAULT_CONTOUR, interval: 50 },
    });
    expect(attempt.failure).toBeNull();
    expect(attempt.trace!.features.length).toBeGreaterThan(0);
  });

  test('a single-level file explains that this view is too wide to read', async () => {
    const main = fakeImage({ width: 2000, height: 2500, bbox: FILE_BBOX, resolution: [5, -5], value: (x) => x });
    const attempt = await readCogElevationGridDetailed(
      fakeSource([[main]]), FILE_BBOX, 'EPSG:3857', { width: 1000, height: 800 }, 1, 4, 1,
    );
    expect(attempt.grid).toBeNull();
    expect(attempt.failure).toBe('too-large');
    expect(attempt.detail).toMatch(/2000\u00d72500|limit/);
    expect(main.reads).toHaveLength(0);
  });

  test('the same file traces happily once the view is small enough', async () => {
    const main = fakeImage({ width: 2000, height: 2500, bbox: FILE_BBOX, resolution: [5, -5], value: (x) => x });
    const attempt = await readCogElevationGridDetailed(
      fakeSource([[main]]), [204000, 6093000, 205000, 6094000], 'EPSG:3857', { width: 1000, height: 800 }, 1, 4, 1,
    );
    expect(attempt.failure).toBeNull();
    expect(attempt.grid).not.toBeNull();
  });
});

// --- why nothing was drawn ----------------------------------------------------

describe('contour failures', () => {
  const level = (over: { nodata?: number | null; value?: (x: number, y: number) => number } = {}) => fakeImage({
    width: 100, height: 100, bbox: [0, 0, 100, 100], nodata: -9999,
    value: over.value ?? ((x) => x),
  });
  const trace = (source: any, viewExtent: number[]) => traceCogContoursDetailed({
    source, viewExtent, viewProjection: 'EPSG:3857',
    viewport: { width: 400, height: 400 }, band: 1, contour: DEFAULT_CONTOUR,
  });

  test('a view off the file is not an error, and says nothing', async () => {
    const attempt = await trace(fakeSource([[level()]]), [5000, 5000, 6000, 6000]);
    expect(attempt.trace).toBeNull();
    expect(attempt.failure).toBe('no-overlap');
    expect(contourFailureMessage(attempt.failure, 'DEM')).toBeNull();
  });

  test('a source that has not parsed its imagery yet is worth a retry', async () => {
    const attempt = await trace({ sourceImagery_: [] }, [0, 0, 10, 10]);
    expect(attempt.failure).toBe('source-not-ready');
    expect(contourFailureMessage(attempt.failure, 'DEM')).toBeNull();
  });

  test('a file with no affine transform anywhere says so', async () => {
    const bare = fakeImage({ width: 100, height: 100, geoKeys: false, value: (x) => x });
    const attempt = await trace(fakeSource([[bare]]), [0, 0, 10, 10]);
    expect(attempt.failure).toBe('no-georeference');
    expect(contourFailureMessage(attempt.failure, 'DEM')).toMatch(/geo-referencing/);
  });

  test('a view of nothing but nodata says so', async () => {
    const attempt = await trace(fakeSource([[level({ value: () => -9999 })]]), [0, 0, 100, 100]);
    expect(attempt.failure).toBe('no-values');
    expect(contourFailureMessage(attempt.failure, 'DEM')).toMatch(/nodata/);
  });

  test('a refused read carries the reason it was refused', async () => {
    const broken = {
      ...level(),
      readRasters: async () => { throw new Error('Invalid sample index'); },
    };
    const attempt = await trace(fakeSource([[broken]]), [0, 0, 100, 100]);
    expect(attempt.failure).toBe('read-error');
    expect(attempt.detail).toBe('Invalid sample index');
    expect(contourFailureMessage(attempt.failure, 'DEM', attempt.detail)).toMatch(/Invalid sample index/);
  });

  test('a missing coordinate transform names the pair it could not cross', async () => {
    const attempt = await traceCogContoursDetailed({
      source: fakeSource([[level()]], 'EPSG:9999'),
      viewExtent: [0, 0, 100, 100],
      viewProjection: 'EPSG:3857',
      viewport: { width: 400, height: 400 },
      band: 1,
      contour: DEFAULT_CONTOUR,
    });
    expect(attempt.failure).toBe('no-transform');
    expect(attempt.detail).toMatch(/EPSG:9999/);
    expect(contourFailureMessage(attempt.failure, 'DEM', attempt.detail)).toMatch(/transform/);
  });

  test('every failure the tracer can report has a message or is deliberately silent', () => {
    const silent = ['no-overlap', 'source-not-ready'] as const;
    const spoken = ['no-georeference', 'no-transform', 'too-large', 'read-error', 'no-values', 'bad-extent'] as const;
    for (const failure of silent) expect(contourFailureMessage(failure, 'DEM')).toBeNull();
    for (const failure of spoken) expect(contourFailureMessage(failure, 'DEM')).toMatch(/Contours:/);
    expect(contourFailureMessage(null, 'DEM')).toBeNull();
  });
});

// --- tracing ----------------------------------------------------------------

describe('buildContourFeatures', () => {
  test('a ramp gives one straight line per level, in map coordinates', () => {
    const { features } = buildContourFeatures(rampGrid(), [
      { level: 2.5, index: false },
      { level: 5.5, index: true },
    ]);
    expect(features).toHaveLength(2);
    const first = features[0].getGeometry();
    const coords = first.getCoordinates();
    // Cell 2.5 of a 10-column grid over 0..90 → x = 25, running north to south.
    expect(coords[0][0]).toBeCloseTo(25, 6);
    expect(coords[coords.length - 1][0]).toBeCloseTo(25, 6);
    expect(Math.abs(coords[0][1])).toBe(90);
    // A straight line simplifies down to its two ends.
    expect(coords).toHaveLength(2);
  });

  test('each feature carries its elevation and whether it is an index contour', () => {
    const { features } = buildContourFeatures(rampGrid(), [
      { level: 2.5, index: false },
      { level: 5.5, index: true },
    ]);
    expect(features[0].get(CONTOUR_LEVEL_PROPERTY)).toBe(2.5);
    expect(features[0].get(CONTOUR_INDEX_PROPERTY)).toBe(false);
    expect(features[1].get(CONTOUR_LEVEL_PROPERTY)).toBe(5.5);
    expect(features[1].get(CONTOUR_INDEX_PROPERTY)).toBe(true);
  });

  test('a line clipped by the grid edge survives as an open polyline', () => {
    // The ramp's lines run off the top and bottom of the window, which is
    // exactly the case the mask tracer throws away.
    const { features } = buildContourFeatures(rampGrid(), [{ level: 2.5, index: false }]);
    expect(features).toHaveLength(1);
    const coords = features[0].getGeometry().getCoordinates();
    const ys = coords.map((c: number[]) => c[1]).sort((a: number, b: number) => a - b);
    expect(ys[0]).toBe(0);
    expect(ys[ys.length - 1]).toBe(90);
  });

  test('nodata holes are skipped rather than outlined', () => {
    const grid = rampGrid();
    for (let i = 0; i < grid.field.length; i++) {
      if (i % 10 >= 4 && i % 10 <= 6) grid.field[i] = NaN;
    }
    const { features } = buildContourFeatures(grid, [{ level: 5, index: false }]);
    // Level 5 sits inside the hole, so nothing is traced at all — and the
    // hole's own edge is not mistaken for a contour.
    expect(features).toHaveLength(0);
  });

  test('a peak produces closed rings', () => {
    const field = new Float32Array(25);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        field[y * 5 + x] = 4 - Math.max(Math.abs(x - 2), Math.abs(y - 2));
      }
    }
    const grid = rampGrid({ field, width: 5, height: 5, fileExtent: [0, 0, 40, 40], extent: [0, 0, 40, 40] });
    const { features } = buildContourFeatures(grid, [{ level: 2.5, index: false }]);
    expect(features.length).toBeGreaterThan(0);
    const coords = features[0].getGeometry().getCoordinates();
    expect(coords[0]).toEqual(coords[coords.length - 1]);
  });

  test('the vertex budget stops the walk and reports it', () => {
    const levels = Array.from({ length: 9 }, (_, i) => ({ level: i + 0.5, index: false }));
    const { features, caps } = buildContourFeatures(rampGrid(), levels, { maxVertices: 4 });
    expect(caps).toEqual(['vertices']);
    expect(features.length).toBeLessThan(levels.length);
  });

  test('a projection transform is applied to every vertex', () => {
    const { features } = buildContourFeatures(rampGrid(), [{ level: 2.5, index: false }], {
      toMap: ([x, y]) => [x + 1000, y * 2],
    });
    const coords = features[0].getGeometry().getCoordinates();
    expect(coords[0][0]).toBeCloseTo(1025, 6);
  });
});

describe('traceCogContours', () => {
  const rampSource = () => fakeSource([[
    fakeImage({ width: 100, height: 100, bbox: [0, 0, 100, 100], value: (x) => x }),
  ]]);

  test('reads, plans and traces in one pass', async () => {
    const traced = await traceCogContours({
      source: rampSource(),
      viewExtent: [0, 0, 100, 100],
      viewProjection: 'EPSG:3857',
      viewport: { width: 100, height: 100 },
      band: 1,
      contour: { ...DEFAULT_CONTOUR, interval: 20, indexInterval: 40 },
    });
    expect(traced).not.toBeNull();
    expect(traced!.range!.min).toBeLessThan(traced!.range!.max);
    expect(traced!.levels.map((l) => l.level)).toEqual(traced!.levels.map((l) => l.level).sort((a, b) => a - b));
    expect(traced!.features.length).toBeGreaterThan(0);
    const indexFeatures = traced!.features.filter((f: any) => f.get(CONTOUR_INDEX_PROPERTY));
    expect(indexFeatures.length).toBeGreaterThan(0);
    expect(traced!.caps).toEqual([]);
  });

  test('an unreadable source traces nothing', async () => {
    expect(await traceCogContours({
      source: { sourceImagery_: [] },
      viewExtent: [0, 0, 10, 10],
      viewProjection: 'EPSG:3857',
      viewport: { width: 100, height: 100 },
      band: 1,
      contour: DEFAULT_CONTOUR,
    })).toBeNull();
  });

  test('flat terrain has no lines but is not a failure', async () => {
    const traced = await traceCogContours({
      source: fakeSource([[fakeImage({ width: 50, height: 50, bbox: [0, 0, 50, 50], value: () => 100 })]]),
      viewExtent: [0, 0, 50, 50],
      viewProjection: 'EPSG:3857',
      viewport: { width: 50, height: 50 },
      band: 1,
      contour: DEFAULT_CONTOUR,
    });
    expect(traced).not.toBeNull();
    expect(traced!.features).toEqual([]);
    // 50 px of view at downscale 4 with oversampling 2 -> a 25x25 sample grid.
    expect(traced!.range).toEqual({ min: 100, max: 100, samples: 25 * 25 });
  });
});

// --- symbols ----------------------------------------------------------------

describe('contour symbols', () => {
  test('brush styles become canvas dash patterns scaled by the pen width', () => {
    expect(contourDashPattern('solid', 2)).toBeUndefined();
    expect(contourDashPattern('dash', 2)).toEqual([12, 8]);
    expect(contourDashPattern('dot', 1)).toEqual([1, 2]);
    expect(contourDashPattern('dash-dot', 1)).toEqual([6, 3, 1, 3]);
    expect(contourDashPattern('dash-dot-dot', 1)).toEqual([6, 3, 1, 3, 1, 3]);
    // A hairline still dashes visibly.
    expect(contourDashPattern('dash', 0.5)).toEqual([3, 2]);
    expect(contourDashPattern(undefined, 1)).toBeUndefined();
  });

  test('the two symbols keep their own width, colour and brush style', () => {
    const config: CogContourConfig = {
      color: 'rgba(10,20,30,1)', indexColor: 'rgba(200,0,0,1)',
      lineWidth: 1, lineStyle: 'dot', indexLineWidth: 3, indexLineStyle: 'dash',
    };
    const regular = contourStroke(config, false);
    const accent = contourStroke(config, true);
    expect(regular.getWidth()).toBe(1);
    expect(regular.getColor()).toBe('rgba(10,20,30,1)');
    expect(regular.getLineDash()).toEqual([1, 2]);
    expect(accent.getWidth()).toBe(3);
    expect(accent.getColor()).toBe('rgba(200,0,0,1)');
    expect(accent.getLineDash()).toEqual([18, 12]);
  });

  test('missing symbol fields fall back to the QGIS-like defaults', () => {
    const stroke = contourStroke(undefined, true);
    expect(stroke.getWidth()).toBe(DEFAULT_CONTOUR.indexLineWidth);
    expect(stroke.getColor()).toBe(DEFAULT_CONTOUR.indexColor);
    expect(stroke.getLineDash()).toBeNull();
  });

  test('labels print the elevation along the line, index contours bolder', () => {
    const feature = (level: number, index: boolean) => ({
      get: (key: string) => (key === CONTOUR_LEVEL_PROPERTY ? level
        : key === CONTOUR_INDEX_PROPERTY ? index : undefined),
    });
    const style = contourStyleFunction({ ...DEFAULT_CONTOUR, showLabel: true });
    const text = style(feature(1234, false)).getText();
    expect(text!.getText()).toBe('1234');
    expect(text!.getPlacement()).toBe('line');
    expect(text!.getFont()).toBe(contourLabelFont(false));
    expect(text!.getFill()!.getColor()).toBe(DEFAULT_CONTOUR.color);
    expect(style(feature(1250, true)).getText()!.getFont()).toBe(contourLabelFont(true));
    expect(style(feature(1250, true)).getText()!.getFill()!.getColor()).toBe(DEFAULT_CONTOUR.indexColor);
  });

  test('labels can be switched off without touching the lines', () => {
    const feature = { get: (key: string) => (key === CONTOUR_LEVEL_PROPERTY ? 50 : false) };
    expect(contourStyleFunction({ ...DEFAULT_CONTOUR, showLabel: false })(feature).getText()).toBeNull();
    expect(contourStyleFunction({ ...DEFAULT_CONTOUR, showLabel: true })(feature).getText()).toBeTruthy();
    // Labels are on unless they were explicitly switched off.
    expect(contourStyleFunction({})(feature).getText()).toBeTruthy();
  });

  test('styles are cached per elevation so rendering does not churn', () => {
    const style = contourStyleFunction(DEFAULT_CONTOUR);
    const feature = { get: (key: string) => (key === CONTOUR_LEVEL_PROPERTY ? 50 : false) };
    expect(style(feature)).toBe(style(feature));
  });

  test('the overlay layer is marked as belonging to its raster layer', () => {
    const parent = { id: 'raster' };
    const layer = createContourLayer(parent, DEFAULT_CONTOUR);
    expect(layer.get('_isCogContourLayer')).toBe(true);
    expect(layer.get('_cogContourParent')).toBe(parent);
    expect(layer.getDeclutter()).toBeTruthy();
    expect(typeof layer.getSource().addFeatures).toBe('function');
  });
});

// --- cap messages -----------------------------------------------------------

describe('contourCapMessage', () => {
  test('each cap explains itself, and no cap says nothing', () => {
    expect(contourCapMessage([])).toBeNull();
    expect(contourCapMessage(undefined)).toBeNull();
    expect(contourCapMessage(['vertices'])).toMatch(/zoom in|interval/i);
    expect(contourCapMessage(['levels'])).toMatch(/interval/i);
    expect(contourCapMessage(['grid'])).toMatch(/coarsel/i);
    // The most useful explanation wins when several caps fired.
    expect(contourCapMessage(['grid', 'vertices'])).toBe(contourCapMessage(['vertices']));
  });
});

describe('contour defaults', () => {
  test('they match the QGIS contour renderer', () => {
    expect(DEFAULT_CONTOUR.interval).toBe(10);
    expect(DEFAULT_CONTOUR.indexInterval).toBe(50);
    expect(DEFAULT_CONTOUR.inputDownscale).toBe(4);
    expect(DEFAULT_CONTOUR.lineWidth).toBe(1);
    expect(DEFAULT_CONTOUR.indexLineWidth).toBe(2);
    expect(DEFAULT_CONTOUR.lineStyle).toBe('solid');
    expect(DEFAULT_CONTOUR.showLabel).toBe(true);
    expect(MAX_CONTOUR_DOWNSCALE).toBeGreaterThanOrEqual(32);
  });
});
