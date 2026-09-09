/**
 * COG band discovery + band/renderer style construction.
 *
 * These are the pure decisions behind the "Bands" panel of the raster layer
 * edit form: what a file's bands are, which render configs are valid for it,
 * what has to be baked into the GeoTIFF source (and therefore rebuilds the
 * layer) versus what is a free live style change, and the exact WebGL `color`
 * expression each mode produces.
 */
import {
  DEFAULT_COG_RENDER,
  MAX_PALETTE_ENTRIES,
  applyCogRender,
  buildCogColorExpression,
  buildCogRenderStyle,
  cogBakeKey,
  cogBakeRanges,
  cogRenderSummary,
  dataTypeMax,
  dataTypeMin,
  describeCogBands,
  describeCogFile,
  formatRangeValue,
  isDefaultCogRender,
  needsCogRebuild,
  normalizeCogRender,
  paletteGradientStops,
  parseTiffColorMap,
  sampleFormatName,
  suggestedCogRender,
  type CogBandInfo,
} from './cogBands';
import {
  DEFAULT_CONTOUR,
  DEFAULT_HILLSHADE,
  cogElevationWindow,
  computeCogBandRange,
} from './cogBands';
import { COG_COLOR_VARIABLES } from './layerHelpers';
import type { CogRenderConfig } from '../types';
// OpenLayers' internal expression compiler — used by the canary tests below to
// prove the expressions we build are the ones the WebGL tile shader accepts.
import { expressionToGlsl } from 'ol/render/webgl/compileUtil.js';
import { newCompilationContext } from 'ol/expr/gpu.js';
import { ColorType } from 'ol/expr/expression.js';

// --- fixtures ---------------------------------------------------------------

/** A stand-in for the geotiff.js image OpenLayers keeps on a ready source. */
function fakeImage(opts: {
  samplesPerPixel: number;
  bits?: number[];
  sampleFormats?: number[];
  tags?: Record<string, any>;
  metadata?: Array<Record<string, string> | null>;
  nodata?: number | null;
  size?: [number, number];
  rasters?: (read: { window?: number[]; interleave?: boolean }) => Promise<any>;
} ) {
  const tags = opts.tags ?? {};
  return {
    fileDirectory: {
      loadValue: async (tag: string) => tags[tag],
      getValue: (tag: string) => tags[tag],
    },
    getSamplesPerPixel: () => opts.samplesPerPixel,
    getSampleFormat: (i: number) => opts.sampleFormats?.[i] ?? 1,
    getBitsPerSample: (i: number) => opts.bits?.[i] ?? 8,
    getGDALNoData: () => opts.nodata ?? null,
    getGDALMetadata: async (i: number) => opts.metadata?.[i] ?? null,
    getWidth: () => opts.size?.[0] ?? 0,
    getHeight: () => opts.size?.[1] ?? 0,
    readRasters: opts.rasters ?? (async () => { throw new Error('pixels not readable'); }),
  };
}

/** A single-band Float32 DEM, with or without stored GDAL statistics. */
function floatDemInfo(stats?: { min: number; max: number }): CogBandInfo {
  return {
    available: true,
    detailed: true,
    bandCount: 1,
    hasNodataAlpha: false,
    nodataValue: null,
    photometric: 1,
    bands: [{
      band: 1,
      label: 'Band 1 (Float32)',
      dataType: 'Float32',
      sampleFormat: 3,
      bitsPerSample: 32,
      dtypeMin: 1.2e-38,
      dtypeMax: 3.4e38,
      ...(stats ? { statsMin: stats.min, statsMax: stats.max } : {}),
    }],
    colorMap: null,
    fileAlphaBand: null,
  };
}

/** A stand-in for a ready ol/source/GeoTIFF. */
function fakeSource(image: any, over: Record<string, any> = {}) {
  return {
    bandCount: image.getSamplesPerPixel(),
    hasAlpha: false,
    sourceImagery_: [[image]],
    ...over,
  };
}

/** A three-band UInt8 RGB file, the plain aerial-photo case. */
function rgbInfo(over: Partial<CogBandInfo> = {}): CogBandInfo {
  return {
    available: true,
    detailed: true,
    bandCount: 3,
    hasNodataAlpha: false,
    nodataValue: null,
    photometric: 2,
    bands: [1, 2, 3].map((n) => ({
      band: n,
      label: `Band ${n} (UInt8)`,
      dataType: 'UInt8',
      sampleFormat: 1,
      bitsPerSample: 8,
      dtypeMin: 0,
      dtypeMax: 255,
    })),
    colorMap: null,
    fileAlphaBand: null,
    ...over,
  };
}

/** A 12-band multispectral file (Sentinel-2 shaped). */
function multispectralInfo(): CogBandInfo {
  const bands = Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({
    band: n,
    label: `Band ${n} (UInt16)`,
    dataType: 'UInt16',
    sampleFormat: 1,
    bitsPerSample: 16,
    dtypeMin: 0,
    dtypeMax: 65535,
    statsMin: 1,
    statsMax: 9000,
  }));
  return rgbInfo({ bandCount: 12, bands });
}

/** A paletted land-cover file with a four-entry colour table. */
function palettedInfo(): CogBandInfo {
  return rgbInfo({
    bandCount: 1,
    photometric: 3,
    bands: [{
      band: 1, label: 'Band 1 (UInt8)', dataType: 'UInt8', sampleFormat: 1,
      bitsPerSample: 8, dtypeMin: 0, dtypeMax: 255,
    }],
    colorMap: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
  });
}

// --- data-type ranges -------------------------------------------------------

describe('data type ranges', () => {
  test('integer types span their full signed/unsigned range', () => {
    expect([dataTypeMin(1, 8), dataTypeMax(1, 8)]).toEqual([0, 255]);
    expect([dataTypeMin(1, 16), dataTypeMax(1, 16)]).toEqual([0, 65535]);
    expect([dataTypeMin(2, 16), dataTypeMax(2, 16)]).toEqual([-32768, 32767]);
    expect([dataTypeMin(2, 32), dataTypeMax(2, 32)]).toEqual([-2147483648, 2147483647]);
  });

  test('Float32 mirrors the fallback OpenLayers normalises with', () => {
    // OL's getMinForDataType/getMaxForDataType for Float32Array — matching it
    // keeps the "Full range" button honest about what the source will do.
    expect(dataTypeMin(3, 32)).toBeCloseTo(1.2e-38, 45);
    expect(dataTypeMax(3, 32)).toBeCloseTo(3.4e38, -30);
  });

  test('names follow GDAL conventions', () => {
    expect(sampleFormatName(1, 8)).toBe('UInt8');
    expect(sampleFormatName(1, 16)).toBe('UInt16');
    expect(sampleFormatName(2, 16)).toBe('Int16');
    expect(sampleFormatName(3, 32)).toBe('Float32');
  });
});

// --- colour tables ----------------------------------------------------------

describe('parseTiffColorMap', () => {
  test('reads the three 16-bit runs and scales them to 0-255', () => {
    // Two entries: reds [0, 65535], greens [0, 32767], blues [65535, 0]
    const parsed = parseTiffColorMap([0, 65535, 0, 32767, 65535, 0]);
    expect(parsed).toEqual([[0, 0, 255], [255, 127, 0]]);
  });

  test('accepts typed arrays and returns null for junk', () => {
    expect(parseTiffColorMap(new Uint16Array([0, 0, 0]))).toEqual([[0, 0, 0]]);
    expect(parseTiffColorMap(undefined)).toBeNull();
    expect(parseTiffColorMap([])).toBeNull();
    expect(parseTiffColorMap([1, 2])).toBeNull();
  });
});

describe('paletteGradientStops', () => {
  test('always includes the first and last entry', () => {
    const stops = paletteGradientStops([[0, 0, 0], [10, 20, 30], [255, 255, 255]], 2);
    expect(stops).toEqual(['rgb(0,0,0) 0%', 'rgb(255,255,255) 100%']);
  });

  test('thins long tables and returns nothing for an empty one', () => {
    const big = Array.from({ length: 256 }, (_, i) => [i, 0, 0] as [number, number, number]);
    expect(paletteGradientStops(big, 8)).toHaveLength(8);
    expect(paletteGradientStops([], 8)).toEqual([]);
  });
});

// --- band discovery ---------------------------------------------------------

describe('describeCogBands', () => {
  test('reads sample types, statistics and band names per band', async () => {
    const source = fakeSource(fakeImage({
      samplesPerPixel: 2,
      bits: [16, 32],
      sampleFormats: [1, 3],
      tags: { PhotometricInterpretation: 2, GDAL_NODATA: '-9999' },
      metadata: [
        { STATISTICS_MINIMUM: '1', STATISTICS_MAXIMUM: '9000', DESCRIPTION: 'Red' },
        null,
      ],
      nodata: -9999,
    }));

    const info = await describeCogBands(source);
    expect(info.available).toBe(true);
    expect(info.detailed).toBe(true);
    expect(info.bandCount).toBe(2);
    expect(info.nodataValue).toBe(-9999);
    expect(info.photometric).toBe(2);
    expect(info.bands[0]).toMatchObject({ band: 1, dataType: 'UInt16', name: 'Red', statsMin: 1, statsMax: 9000 });
    expect(info.bands[0].label).toBe('Band 1 — Red (UInt16)');
    expect(info.bands[1]).toMatchObject({ band: 2, dataType: 'Float32', name: undefined, statsMin: undefined });
    expect(info.bands[1].label).toBe('Band 2 (Float32)');
  });

  test('parses the colour table of a paletted file', async () => {
    const source = fakeSource(fakeImage({
      samplesPerPixel: 1,
      tags: { PhotometricInterpretation: 3, ColorMap: [0, 65535, 0, 65535, 65535, 0] },
    }));
    const info = await describeCogBands(source);
    expect(info.photometric).toBe(3);
    expect(info.colorMap).toEqual([[0, 0, 255], [255, 255, 0]]);
    expect(suggestedCogRender(info)).toEqual({ mode: 'colormap', band: 1 });
  });

  test('excludes the synthetic nodata alpha band from the pickable bands', async () => {
    const source = fakeSource(fakeImage({ samplesPerPixel: 3, nodata: 0 }), {
      bandCount: 4,      // three data bands + OL's alpha
      hasAlpha: true,
    });
    const info = await describeCogBands(source);
    expect(info.bandCount).toBe(3);
    expect(info.hasNodataAlpha).toBe(true);
    expect(info.bands.map((b) => b.band)).toEqual([1, 2, 3]);
  });

  test('treats a 4-sample RGB file as RGBA so custom combos keep transparency', async () => {
    const withTag = await describeCogBands(fakeSource(fakeImage({
      samplesPerPixel: 4, tags: { PhotometricInterpretation: 2, ExtraSamples: [2] },
    })));
    expect(withTag.fileAlphaBand).toBe(4);

    const implicit = await describeCogBands(fakeSource(fakeImage({
      samplesPerPixel: 4, tags: { PhotometricInterpretation: 2 },
    })));
    expect(implicit.fileAlphaBand).toBe(4);

    const noAlpha = await describeCogBands(fakeSource(fakeImage({
      samplesPerPixel: 4, tags: { PhotometricInterpretation: 2, ExtraSamples: [0] },
    })));
    expect(noAlpha.fileAlphaBand).toBeNull();
  });

  test('warns about floating-point bands with no statistics (the all-black case)', async () => {
    const source = fakeSource(fakeImage({
      samplesPerPixel: 1, bits: [32], sampleFormats: [3], tags: { PhotometricInterpretation: 1 },
    }));
    const info = await describeCogBands(source);
    expect(info.warning).toMatch(/floating-point bands without built-in statistics/);
  });

  test('degrades to numbered bands when OpenLayers internals are unavailable', async () => {
    const info = await describeCogBands({ bandCount: 4, hasAlpha: true });
    expect(info.available).toBe(true);
    expect(info.detailed).toBe(false);
    expect(info.bandCount).toBe(3);
    expect(info.bands.map((b) => b.label)).toEqual(['Band 1', 'Band 2', 'Band 3']);
  });

  test('never rejects: a throwing file directory falls back to the band count', async () => {
    const broken = {
      bandCount: 2,
      hasAlpha: false,
      sourceImagery_: [[{
        fileDirectory: { loadValue: () => { throw new Error('boom'); }, getValue: () => { throw new Error('boom'); } },
        getSamplesPerPixel: () => { throw new Error('boom'); },
        getSampleFormat: () => { throw new Error('boom'); },
        getBitsPerSample: () => { throw new Error('boom'); },
        getGDALNoData: () => { throw new Error('boom'); },
        getGDALMetadata: () => { throw new Error('boom'); },
      }]],
    };
    const info = await describeCogBands(broken);
    expect(info.bandCount).toBe(2);
    expect(info.bands).toHaveLength(2);
  });

  test('reports an empty source as unavailable instead of throwing', async () => {
    expect((await describeCogBands(null)).available).toBe(false);
    expect((await describeCogBands(undefined)).bandCount).toBe(0);
  });

  test('refuses a colour table too large for a palette texture', async () => {
    const entries = MAX_PALETTE_ENTRIES + 1;
    const source = fakeSource(fakeImage({
      samplesPerPixel: 1,
      bits: [16],
      tags: {
        PhotometricInterpretation: 3,
        ColorMap: new Array(entries * 3).fill(0).map((_, i) => i % 65536),
      },
    }));
    const info = await describeCogBands(source);
    expect(info.colorMap).toBeNull();
    expect(info.warning).toMatch(/only 2048 can be rendered/);
    // ...so the colormap renderer is not offered for this file
    expect(normalizeCogRender({ mode: 'colormap', band: 1 }, info).mode).not.toBe('colormap');
    expect(suggestedCogRender(info)).toEqual({ mode: 'single', band: 1 });
  });

  test('memoises per source object', async () => {
    const source = fakeSource(fakeImage({ samplesPerPixel: 1 }));
    const first = await describeCogBands(source);
    expect(await describeCogBands(source)).toBe(first);
  });
});

describe('describeCogFile', () => {
  test('summarises bands, type, colour table and nodata', () => {
    expect(describeCogFile(multispectralInfo())).toBe('12 bands · UInt16');
    expect(describeCogFile(palettedInfo())).toContain('4-entry colour table');
    expect(describeCogFile(rgbInfo({ nodataValue: -9999 }))).toContain('nodata -9999');
    expect(describeCogFile(null)).toBe('Band details unavailable');
  });
});

// --- config normalisation ---------------------------------------------------

describe('normalizeCogRender', () => {
  test('passes the default through untouched', () => {
    expect(normalizeCogRender(undefined, rgbInfo())).toEqual({ mode: 'auto' });
    expect(normalizeCogRender({ mode: 'auto' }, rgbInfo())).toEqual({ mode: 'auto' });
  });

  test('clamps band numbers into the file', () => {
    expect(normalizeCogRender({ mode: 'single', band: 99 }, rgbInfo())).toEqual({ mode: 'single', band: 3 });
    expect(normalizeCogRender({ mode: 'single', band: 0 }, rgbInfo())).toEqual({ mode: 'single', band: 1 });
    // An out-of-range entry falls back to that channel's default (green = 2).
    expect(normalizeCogRender({ mode: 'rgb', rgb: [9, -2, 3] }, rgbInfo())).toEqual({ mode: 'rgb', rgb: [3, 2, 3] });
  });

  test('fills a missing RGB triple with the first three bands', () => {
    expect(normalizeCogRender({ mode: 'rgb' }, multispectralInfo())).toEqual({ mode: 'rgb', rgb: [1, 2, 3] });
  });

  test('drops a stretch that is not a usable window', () => {
    expect(normalizeCogRender({ mode: 'single', band: 1, stretchMin: 10, stretchMax: 10 }, rgbInfo()))
      .toEqual({ mode: 'single', band: 1 });
    expect(normalizeCogRender({ mode: 'single', band: 1, stretchMin: 50, stretchMax: 10 }, rgbInfo()))
      .toEqual({ mode: 'single', band: 1 });
    expect(normalizeCogRender({ mode: 'single', band: 1, stretchMin: NaN, stretchMax: 10 }, rgbInfo()))
      .toEqual({ mode: 'single', band: 1 });
    expect(normalizeCogRender({ mode: 'single', band: 1, stretchMin: 0, stretchMax: 200 }, rgbInfo()))
      .toEqual({ mode: 'single', band: 1, stretchMin: 0, stretchMax: 200 });
  });

  test('falls back when the file cannot do the requested mode', () => {
    // No colour table -> grayscale (single band file) / RGB (multi band file)
    expect(normalizeCogRender({ mode: 'colormap', band: 1 }, rgbInfo())).toEqual({ mode: 'rgb', rgb: [1, 2, 3] });
    expect(normalizeCogRender({ mode: 'colormap', band: 1 }, rgbInfo({ bandCount: 1, bands: rgbInfo().bands.slice(0, 1) })))
      .toEqual({ mode: 'single', band: 1 });
    // Fewer than three bands -> single band
    expect(normalizeCogRender({ mode: 'rgb', rgb: [1, 2, 3] }, rgbInfo({ bandCount: 1, bands: rgbInfo().bands.slice(0, 1) })))
      .toEqual({ mode: 'single', band: 1 });
  });

  test('survives a missing band description', () => {
    expect(normalizeCogRender({ mode: 'rgb', rgb: [4, 3, 2] }, null)).toEqual({ mode: 'rgb', rgb: [4, 3, 2] });
    expect(normalizeCogRender({ mode: 'single', band: 7, stretchMin: 1, stretchMax: 2 }, null))
      .toEqual({ mode: 'single', band: 7, stretchMin: 1, stretchMax: 2 });
  });
});

describe('suggestedCogRender', () => {
  test('picks the renderer the file actually wants', () => {
    expect(suggestedCogRender(palettedInfo())).toEqual({ mode: 'colormap', band: 1 });
    expect(suggestedCogRender(multispectralInfo())).toEqual({ mode: 'rgb', rgb: [1, 2, 3] });
    expect(suggestedCogRender(rgbInfo({ bandCount: 1, bands: rgbInfo().bands.slice(0, 1) })))
      .toEqual({ mode: 'single', band: 1 });
    expect(suggestedCogRender(null)).toEqual(DEFAULT_COG_RENDER);
  });
});

// --- what needs a rebuild ---------------------------------------------------

describe('cogBakeRanges / needsCogRebuild', () => {
  test('band mapping alone bakes nothing, so it can be applied live', () => {
    expect(cogBakeRanges({ mode: 'auto' }, multispectralInfo())).toBeNull();
    expect(cogBakeRanges({ mode: 'rgb', rgb: [4, 3, 2] }, multispectralInfo())).toBeNull();
    expect(cogBakeRanges({ mode: 'single', band: 5 }, multispectralInfo())).toBeNull();
    expect(needsCogRebuild({ mode: 'rgb', rgb: [1, 2, 3] }, { mode: 'rgb', rgb: [4, 3, 2] })).toBe(false);
    expect(needsCogRebuild({ mode: 'auto' }, { mode: 'single', band: 2 })).toBe(false);
  });

  test('a stretch is baked into that band only, leaving the others at their defaults', () => {
    const bake = cogBakeRanges({ mode: 'single', band: 3, stretchMin: 10, stretchMax: 4000 }, multispectralInfo());
    expect(bake).not.toBeNull();
    expect(bake!.min).toEqual([undefined, undefined, 10]);
    expect(bake!.max).toEqual([undefined, undefined, 4000]);
    expect(needsCogRebuild({ mode: 'single', band: 3 }, { mode: 'single', band: 3, stretchMin: 10, stretchMax: 4000 })).toBe(true);
  });

  test('a colour table is baked across the index range', () => {
    const bake = cogBakeRanges({ mode: 'colormap', band: 1 }, palettedInfo());
    expect(bake!.min).toEqual([0]);
    expect(bake!.max).toEqual([3]);
    expect(needsCogRebuild({ mode: 'single', band: 1 }, { mode: 'colormap', band: 1 })).toBe(true);
  });

  test('nothing is baked without a usable colour table or window', () => {
    expect(cogBakeRanges({ mode: 'colormap', band: 1 }, rgbInfo())).toBeNull();
    expect(cogBakeRanges(undefined, rgbInfo())).toBeNull();
    expect(cogBakeKey(undefined)).toBe('');
    expect(cogBakeKey({ mode: 'colormap', band: 2 })).toBe('colormap:2');
    expect(cogBakeKey({ mode: 'single', band: 2, stretchMin: 1, stretchMax: 2 })).toBe('single:2:1:2');
  });
});

// --- style expressions ------------------------------------------------------

describe('buildCogColorExpression', () => {
  test('auto mode leaves OpenLayers\' own mapping in place', () => {
    expect(buildCogColorExpression({ mode: 'auto' }, multispectralInfo())).toBeUndefined();
    expect(buildCogColorExpression(undefined, multispectralInfo())).toBeUndefined();
  });

  test('RGB mode addresses the chosen bands directly', () => {
    expect(buildCogColorExpression({ mode: 'rgb', rgb: [4, 3, 2] }, multispectralInfo()))
      .toEqual(['array', ['band', 4], ['band', 3], ['band', 2], 1]);
  });

  test('RGB mode keeps a genuine alpha channel transparent', () => {
    const info = rgbInfo({ bandCount: 4, fileAlphaBand: 4, bands: [...rgbInfo().bands, { ...rgbInfo().bands[0], band: 4 }] });
    expect(buildCogColorExpression({ mode: 'rgb', rgb: [1, 2, 3] }, info))
      .toEqual(['array', ['band', 1], ['band', 2], ['band', 3], ['band', 4]]);
  });

  test('single band mode repeats the band across RGB', () => {
    const expr = buildCogColorExpression({ mode: 'single', band: 5 }, multispectralInfo());
    expect(expr).toEqual(['array', ['band', 5], ['band', 5], ['band', 5], 1]);
  });

  test('colour map mode scales the normalised band back to a class index', () => {
    const expr = buildCogColorExpression({ mode: 'colormap', band: 1 }, palettedInfo());
    expect(expr[0]).toBe('palette');
    expect(expr[1]).toEqual(['round', ['*', ['band', 1], 3]]);
    // OL's palette operator takes the colour list as its second argument.
    expect(expr[2]).toEqual(['rgba(0,0,0,1)', 'rgba(255,0,0,1)', 'rgba(0,255,0,1)', 'rgba(0,0,255,1)']);
  });

  test('colour map mode falls back to RGB when the file has no table', () => {
    expect(buildCogColorExpression({ mode: 'colormap', band: 1 }, rgbInfo()))
      .toEqual(['array', ['band', 1], ['band', 2], ['band', 3], 1]);
  });

  test('an empty band description yields no expression rather than a broken one', () => {
    expect(buildCogColorExpression({ mode: 'rgb', rgb: [1, 2, 3] }, null)).toBeUndefined();
  });
});

describe('buildCogRenderStyle', () => {
  test('keeps the colour-adjustment variables the sliders write to', () => {
    const style = buildCogRenderStyle({ mode: 'auto' }, rgbInfo());
    expect(style.variables).toEqual({
      [COG_COLOR_VARIABLES.exposure]: 0,
      [COG_COLOR_VARIABLES.contrast]: 0,
      [COG_COLOR_VARIABLES.saturation]: 0,
    });
    expect(style.color).toBeUndefined();
    expect(style.exposure).toEqual(['var', COG_COLOR_VARIABLES.exposure]);
  });

  test('adds the color expression only when a renderer is chosen', () => {
    const style = buildCogRenderStyle({ mode: 'single', band: 2 }, multispectralInfo());
    expect(style.color).toEqual(['array', ['band', 2], ['band', 2], ['band', 2], 1]);
    // The colour variables must survive: setStyle() replaces them wholesale.
    expect(style.variables[COG_COLOR_VARIABLES.contrast]).toBe(0);
  });

  test('a colormap config with no usable table never builds a palette expression', () => {
    // normalizeCogRender demotes the mode (single band -> grayscale), so the
    // shader is never handed a palette lookup it cannot resolve.
    const style = buildCogRenderStyle({ mode: 'colormap', band: 1 }, { ...palettedInfo(), colorMap: null });
    expect(style.color).toEqual(['array', ['band', 1], ['band', 1], ['band', 1], 1]);
    expect(style.color[0]).not.toBe('palette');
  });
});

describe('applyCogRender', () => {
  test('sets the style and folds the current colour adjustments back in', () => {
    const setStyle = vi.fn();
    const applied = applyCogRender({ setStyle }, { mode: 'rgb', rgb: [4, 3, 2] }, multispectralInfo(), {
      brightness: 150, contrast: 100, saturation: 50,
    });
    expect(applied).toBe(true);
    expect(setStyle).toHaveBeenCalledTimes(1);
    const style = setStyle.mock.calls[0][0];
    expect(style.color).toEqual(['array', ['band', 4], ['band', 3], ['band', 2], 1]);
    expect(style.variables[COG_COLOR_VARIABLES.exposure]).toBeCloseTo(0.5);
    expect(style.variables[COG_COLOR_VARIABLES.saturation]).toBeCloseTo(-0.5);
  });

  test('is a no-op on a layer that cannot take a style', () => {
    expect(applyCogRender(null, { mode: 'auto' }, rgbInfo())).toBe(false);
    expect(applyCogRender({}, { mode: 'auto' }, rgbInfo())).toBe(false);
  });
});

// --- UI text ----------------------------------------------------------------

describe('summaries and formatting', () => {
  test('the badge reads as a short description of the choice', () => {
    expect(cogRenderSummary({ mode: 'auto' }, rgbInfo())).toBe('default');
    expect(cogRenderSummary({ mode: 'rgb', rgb: [1, 2, 3] }, multispectralInfo())).toBe('RGB 1·2·3');
    expect(cogRenderSummary({ mode: 'rgb', rgb: [4, 3, 2] }, multispectralInfo())).toBe('RGB 4·3·2');
    expect(cogRenderSummary({ mode: 'single', band: 5 }, multispectralInfo())).toBe('Band 5');
    expect(cogRenderSummary({ mode: 'single', band: 1, stretchMin: 0, stretchMax: 4000 }, multispectralInfo()))
      .toBe('Band 1 · 0–4000');
    expect(cogRenderSummary({ mode: 'colormap', band: 1 }, palettedInfo())).toBe('Colour map');
  });

  test('isDefaultCogRender only trusts a missing or auto config', () => {
    expect(isDefaultCogRender(undefined)).toBe(true);
    expect(isDefaultCogRender({ mode: 'auto' })).toBe(true);
    expect(isDefaultCogRender({ mode: 'single', band: 1 })).toBe(false);
  });

  test('range values stay readable across magnitudes', () => {
    expect(formatRangeValue(0)).toBe('0');
    expect(formatRangeValue(-9999)).toBe('-9999');
    expect(formatRangeValue(2.5)).toBe('2.5');
    expect(formatRangeValue(0.0001)).toBe('1.00e-4');
    expect(formatRangeValue(12345678)).toBe('1.23e+7');
    expect(formatRangeValue(NaN)).toBe('—');
  });
});

// --- GDAL statistics discovery ----------------------------------------------

describe('GDAL statistics discovery', () => {
  test('reads statistics from the full-resolution image when overviews carry none', async () => {
    // OpenLayers stores levels coarsest-first; GDAL writes STATISTICS_* only
    // into the main image, so the coarsest level (the old read point) has none.
    const overview = fakeImage({ samplesPerPixel: 1, sampleFormats: [3], bits: [32] });
    const full = fakeImage({
      samplesPerPixel: 1,
      sampleFormats: [3],
      bits: [32],
      metadata: [{
        STATISTICS_MINIMUM: '399.05200195312',
        STATISTICS_MAXIMUM: '910.7509765625',
        STATISTICS_MEAN: '628.97391258989',
      }],
    });
    const source = { bandCount: 1, hasAlpha: false, sourceImagery_: [[overview, full]] };
    const info = await describeCogBands(source);
    expect(info.bands[0].statsMin).toBeCloseTo(399.052, 3);
    expect(info.bands[0].statsMax).toBeCloseTo(910.751, 3);
    expect(info.bands[0].statsMean).toBeCloseTo(628.974, 3);
    expect(info.warning).toBeUndefined();
  });
});

// --- measuring min/max from the pixels --------------------------------------

describe('computeCogBandRange', () => {
  test('measures the true range, skipping nodata and non-finite pixels', async () => {
    const image = fakeImage({
      samplesPerPixel: 1,
      sampleFormats: [3],
      bits: [32],
      nodata: -9999,
      size: [2, 2],
      rasters: async () => [Float32Array.from([10, -9999, NaN, 42])],
    });
    const source = { bandCount: 1, hasAlpha: false, sourceImagery_: [[image]] };
    expect(await computeCogBandRange(source, 1))
      .toEqual({ min: 10, max: 42, samples: 2, estimated: false });
  });

  test('maps a band across concatenated sources', async () => {
    const read: string[] = [];
    const first = fakeImage({
      samplesPerPixel: 1, size: [1, 1],
      rasters: async () => { read.push('first'); return [Float32Array.from([1])]; },
    });
    const second = fakeImage({
      samplesPerPixel: 1, size: [1, 1],
      rasters: async () => { read.push('second'); return [Float32Array.from([7])]; },
    });
    const source = { bandCount: 2, hasAlpha: false, sourceImagery_: [[first], [second]] };
    expect(await computeCogBandRange(source, 2)).toMatchObject({ min: 7, max: 7 });
    expect(read).toEqual(['second']);
  });

  test('samples a raster too big to read whole through scattered windows', async () => {
    const windows: number[][] = [];
    const big = fakeImage({
      samplesPerPixel: 1,
      size: [4096, 4096],
      rasters: async (readOpts) => {
        const [x0, y0, x1, y1] = readOpts.window!;
        windows.push([x0, y0, x1, y1]);
        const w = x1 - x0;
        const h = y1 - y0;
        return [Float32Array.from({ length: w * h }, (_, i) => x0 + (i % w) + y0)];
      },
    });
    const source = { bandCount: 1, hasAlpha: false, sourceImagery_: [[big]] };
    const range = await computeCogBandRange(source, 1);
    expect(windows).toHaveLength(16);
    for (const [x0, y0, x1, y1] of windows) {
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(4096);
      expect(y1).toBeLessThanOrEqual(4096);
    }
    expect(range).toMatchObject({ min: 0, max: 3840 + 255 + 3840, estimated: true });
  });

  test('resolves null without imagery or beyond the band count', async () => {
    expect(await computeCogBandRange({ bandCount: 1, hasAlpha: false }, 1)).toBeNull();
    const image = fakeImage({ samplesPerPixel: 1, size: [1, 1], rasters: async () => [Float32Array.from([5])] });
    const source = { bandCount: 1, hasAlpha: false, sourceImagery_: [[image]] };
    expect(await computeCogBandRange(source, 2)).toBeNull();
  });
});

// --- hillshade / contour config handling ------------------------------------

describe('hillshade and contour renderers', () => {
  test('the suggested renderer stretches a lone float band like QGIS on load', () => {
    expect(suggestedCogRender(floatDemInfo({ min: 399.052, max: 910.751 })))
      .toEqual({ mode: 'single', band: 1, stretchMin: 399.052, stretchMax: 910.751 });
    expect(suggestedCogRender(floatDemInfo())).toEqual({ mode: 'single', band: 1 });
  });

  test('hillshade parameters are sanitised into the QGIS default range', () => {
    const normalised = normalizeCogRender(
      { mode: 'hillshade', hillshade: { altitude: 200, azimuth: -45, zFactor: -2, multidirectional: 'yes' as any } },
      floatDemInfo(),
    );
    expect(normalised).toEqual({
      mode: 'hillshade',
      band: 1,
      hillshade: { altitude: 90, azimuth: 315, zFactor: 1, multidirectional: true },
    });
    expect(normalizeCogRender({ mode: 'hillshade' }, floatDemInfo()).hillshade)
      .toEqual(DEFAULT_HILLSHADE);
  });

  test('contour parameters fall back to sane intervals and colours', () => {
    const normalised = normalizeCogRender(
      { mode: 'contour', contour: { interval: -5, indexInterval: 0 } },
      floatDemInfo(),
    );
    expect(normalised.contour).toEqual(DEFAULT_CONTOUR);
    const kept = normalizeCogRender(
      { mode: 'contour', contour: { interval: 25, indexInterval: 100, color: 'rgba(1,2,3,1)' } },
      floatDemInfo(),
    );
    expect(kept.contour).toEqual({
      interval: 25, indexInterval: 100, color: 'rgba(1,2,3,1)', indexColor: DEFAULT_CONTOUR.indexColor,
    });
  });

  test('only an explicit stretch window bakes a rebuild', () => {
    expect(cogBakeKey({ mode: 'hillshade', band: 1, stretchMin: 0, stretchMax: 100 }))
      .toBe('hillshade:1:0:100');
    expect(cogBakeKey({ mode: 'hillshade', band: 1, hillshade: { altitude: 60 } })).toBe('');
    expect(cogBakeKey({ mode: 'contour', band: 1, contour: { interval: 25 } })).toBe('');
    expect(cogBakeKey({ mode: 'contour', band: 1, stretchMin: 399, stretchMax: 910 }))
      .toBe('contour:1:399:910');
  });

  test('the elevation window prefers stretch, then statistics, then data type', () => {
    const info = floatDemInfo({ min: 399, max: 910 });
    expect(cogElevationWindow({ mode: 'hillshade', band: 1, stretchMin: 0, stretchMax: 500 }, info))
      .toEqual({ min: 0, max: 500, fromStretch: true, fromDataType: false });
    expect(cogElevationWindow({ mode: 'hillshade', band: 1 }, info))
      .toEqual({ min: 399, max: 910, fromStretch: false, fromDataType: false });
    expect(cogElevationWindow({ mode: 'contour', band: 1 }, floatDemInfo()))
      .toEqual({ min: 1.2e-38, max: 3.4e38, fromStretch: false, fromDataType: true });
  });
});

// --- canary: the expressions really compile in OpenLayers -------------------

/**
 * Compile a `color` expression the way `ol/layer/WebGLTile` does internally.
 * These are OL private modules on purpose: if an upgrade moves them the import
 * fails loudly, which is the signal to re-verify COG band rendering.
 */
function compileColorGlsl(expr: any, bandCount: number): { glsl: string; paletteTextures: number } {
  const context: any = { ...newCompilationContext(), bandCount };
  const glsl = expressionToGlsl(context, expr, ColorType);
  return { glsl, paletteTextures: context.paletteTextures?.length ?? 0 };
}

describe('OpenLayers WebGL compilation of the generated expressions', () => {
  test('an RGB combination addresses exactly the chosen bands', () => {
    const { glsl } = compileColorGlsl(
      buildCogColorExpression({ mode: 'rgb', rgb: [4, 3, 2] }, multispectralInfo()), 12,
    );
    expect(glsl).toMatch(/^vec4\(/);
    expect(glsl).toContain('getBandValue(4.0');
    expect(glsl).toContain('getBandValue(3.0');
    expect(glsl).toContain('getBandValue(2.0');
  });

  test('hillshade compiles: Horn gradient over neighbour pixels', () => {
    const { glsl } = compileColorGlsl(
      buildCogColorExpression({ mode: 'hillshade', band: 1 }, floatDemInfo({ min: 0, max: 100 })), 1,
    );
    expect(glsl).toContain('getBandValue(1.0, -1.0, -1.0)');
    expect(glsl).toContain('getBandValue(1.0, 1.0, 1.0)');
    expect(glsl).toMatch(/atan\(/);
    expect(glsl).toMatch(/cos\(/);
    const multi = compileColorGlsl(
      buildCogColorExpression({ mode: 'hillshade', band: 1, hillshade: { multidirectional: true } },
        floatDemInfo({ min: 0, max: 100 })), 1,
    );
    expect(multi.glsl).toMatch(/atan\(/);
  });

  test('contours compile: isoline test against the right and bottom neighbour', () => {
    const { glsl } = compileColorGlsl(
      buildCogColorExpression({ mode: 'contour', band: 1 }, floatDemInfo({ min: 0, max: 100 })), 1,
    );
    expect(glsl).toMatch(/floor\(/);
    expect(glsl).toContain('getBandValue(1.0, 1.0, 0.0)');
    expect(glsl).toContain('getBandValue(1.0, 0.0, 1.0)');
  });

  test('a single band is repeated into all three colour channels', () => {
    const { glsl } = compileColorGlsl(
      buildCogColorExpression({ mode: 'single', band: 5 }, multispectralInfo()), 12,
    );
    expect(glsl).toContain('getBandValue(5.0');
    expect(glsl.match(/getBandValue\(5\.0/g)).toHaveLength(3);
  });

  test('a two-band file resolves band 1 through the luminance channel', () => {
    // bandCount 2 is uploaded as LUMINANCE_ALPHA, where band 2 is the alpha;
    // the compiled lookup has to reflect that layout.
    const { glsl } = compileColorGlsl(
      buildCogColorExpression({ mode: 'single', band: 1 }, rgbInfo({ bandCount: 2, hasNodataAlpha: true })), 2,
    );
    expect(glsl).toContain('getBandValue(1.0');
  });

  test('a colour table becomes a palette texture lookup on the class index', () => {
    const { glsl, paletteTextures } = compileColorGlsl(
      buildCogColorExpression({ mode: 'colormap', band: 1 }, palettedInfo()), 1,
    );
    expect(paletteTextures).toBe(1);
    expect(glsl).toContain('u_paletteTextures[0]');
    // index = round(normalised band * last index), sampled at the texel centre
    expect(glsl).toContain('getBandValue(1.0');
    expect(glsl).toContain('* 3.0');
    expect(glsl).toContain('floor(');
  });

  test('a genuine alpha band is wired into the fourth component', () => {
    const info = rgbInfo({
      bandCount: 4,
      fileAlphaBand: 4,
      bands: [...rgbInfo().bands, { ...rgbInfo().bands[0], band: 4 }],
    });
    const { glsl } = compileColorGlsl(buildCogColorExpression({ mode: 'rgb', rgb: [1, 2, 3] }, info), 4);
    expect(glsl).toContain('getBandValue(4.0');
    expect(glsl).toMatch(/getBandValue\(4\.0, 0\.0, 0\.0\)\)$/);
  });
});
