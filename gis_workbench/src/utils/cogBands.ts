// ---------------------------------------------------------------------------
// COG band discovery + WebGL band/renderer style construction.
//
// A Cloud Optimized GeoTIFF may hold a single elevation band, a dozen spectral
// bands, or a paletted land-cover classification. OpenLayers' WebGLTile layer
// renders whatever sits in the first four bands as RGBA, which leaves
// multispectral rasters showing the wrong bands (and paletted ones showing raw
// class indices as grayscale) with no way for the user to correct it.
//
// This module reads the band layout out of an already-loaded `ol/source/GeoTIFF`
// and turns a `CogRenderConfig` into the WebGLTile style that displays it:
//
//   auto      keep OpenLayers' default mapping (no `color` expression at all)
//   rgb       any three bands as red / green / blue
//   single    one band as grayscale, optionally stretched to [min, max]
//   colormap  a paletted band drawn through the file's embedded colour table
//
// Two kinds of change, two costs:
// - Band mapping is a pure *style* change. The source always loads every band,
//   so `['band', n]` can address any of them and switching is instant —
//   `layer.setStyle()` re-renders without a single extra request.
// - A *stretch* changes how the source normalises pixel values to 8 bits, so it
//   is baked into the GeoTIFF source (`min`/`max` per band) and needs the layer
//   to be rebuilt. Baking keeps full 8-bit precision across the chosen window
//   instead of quantising the whole data range first.
//
// Framework-agnostic per AGENTS.md §3: plain data in, plain data / OL objects
// out, no React imports.
// ---------------------------------------------------------------------------
import type { CogRenderConfig, CogRenderMode } from '../types';
import { createCogTileStyle, cogColorVariables } from './layerHelpers';

/** Colour-adjustment values as stored on a RasterLayer (0-200, 100 = neutral). */
export interface CogColorAdjustments {
  brightness?: number;
  saturation?: number;
  contrast?: number;
}

/** One band of the file, described well enough to populate a picker. */
export interface CogBandDescriptor {
  /** 1-based band number, matching OpenLayers' `['band', n]` expression. */
  band: number;
  /** Picker label, e.g. `Band 4 — Red (UInt16)`. */
  label: string;
  /** Band name from GDAL metadata (`DESCRIPTION`), when the file carries one. */
  name?: string;
  /** Human-readable sample type, e.g. `UInt16` / `Float32`. */
  dataType: string;
  /** TIFF SampleFormat: 1 = unsigned int, 2 = signed int, 3 = float. */
  sampleFormat: number;
  bitsPerSample: number;
  /** Lowest / highest value the data type itself can hold. */
  dtypeMin: number;
  dtypeMax: number;
  /** Per-band GDAL statistics, when the file was built with them. */
  statsMin?: number;
  statsMax?: number;
  statsMean?: number;
  statsStdDev?: number;
}

/** An RGBA entry of a TIFF colour table, r/g/b in 0-255. */
export type CogPaletteColor = [number, number, number];

/** Everything the band picker needs to know about a loaded COG. */
export interface CogBandInfo {
  /** True when at least the band count could be determined. */
  available: boolean;
  /** True when the TIFF tags themselves were readable (names, types, palette). */
  detailed: boolean;
  /** Number of *data* bands in the file (excludes OpenLayers' nodata alpha). */
  bandCount: number;
  /** True when OpenLayers appended a synthetic alpha band for nodata pixels. */
  hasNodataAlpha: boolean;
  nodataValue: number | null;
  /** TIFF PhotometricInterpretation (2 = RGB, 3 = paletted, ...). */
  photometric: number | null;
  bands: CogBandDescriptor[];
  /** Parsed colour table, or null when the file is not paletted. */
  colorMap: CogPaletteColor[] | null;
  /** 1-based band holding a genuine alpha channel (ExtraSamples), if any. */
  fileAlphaBand: number | null;
  /** Non-fatal note for the UI, e.g. "no statistics — set a manual stretch". */
  warning?: string;
}

/** TIFF SampleFormat tag values. */
export const SAMPLE_FORMAT_UINT = 1;
export const SAMPLE_FORMAT_INT = 2;
export const SAMPLE_FORMAT_FLOAT = 3;

/** TIFF PhotometricInterpretation tag values. */
export const PHOTOMETRIC_RGB = 2;
export const PHOTOMETRIC_PALETTE = 3;

/**
 * Upper bound on colour-table entries turned into a WebGL palette texture.
 * The texture is one pixel wide per entry, so this stays well inside the
 * 2048 px minimum guaranteed by WebGL. Real paletted GeoTIFFs use 256.
 */
export const MAX_PALETTE_ENTRIES = 2048;

/** The renderer used when a layer carries no explicit choice. */
export const DEFAULT_COG_RENDER: CogRenderConfig = { mode: 'auto' };

// Memoises the (async) tag reads per source object: a band panel that is
// opened repeatedly, or a live-apply right after creation, must not re-parse
// the colour table each time. Keyed by the source, so a rebuilt layer (new
// source) is simply a new entry.
const infoCache = new WeakMap<object, Promise<CogBandInfo>>();

// --- data-type ranges -------------------------------------------------------

/**
 * Lowest value a TIFF sample type can hold. Mirrors the fallback OpenLayers
 * uses when a file carries no GDAL statistics, so the numbers pre-filled into
 * the stretch inputs match what the source will normalise against.
 */
export function dataTypeMin(sampleFormat: number, bitsPerSample: number): number {
  // Float32 mirrors OpenLayers' own fallback (1.2e-38); a Float64 band falls
  // through to 0 there, because geotiff.js hands back a Float64Array which its
  // typed-array switch does not list. Matching it keeps the "full range"
  // button in sync with what the source actually normalises against.
  if (sampleFormat === SAMPLE_FORMAT_FLOAT) return bitsPerSample <= 32 ? 1.2e-38 : 0;
  if (sampleFormat === SAMPLE_FORMAT_INT) {
    if (bitsPerSample <= 8) return -128;
    if (bitsPerSample <= 16) return -32768;
    return -2147483648;
  }
  return 0;
}

/** Highest value a TIFF sample type can hold. */
export function dataTypeMax(sampleFormat: number, bitsPerSample: number): number {
  if (sampleFormat === SAMPLE_FORMAT_FLOAT) return bitsPerSample <= 32 ? 3.4e38 : 255;
  if (sampleFormat === SAMPLE_FORMAT_INT) {
    if (bitsPerSample <= 8) return 127;
    if (bitsPerSample <= 16) return 32767;
    return 2147483647;
  }
  if (bitsPerSample <= 8) return 255;
  if (bitsPerSample <= 16) return 65535;
  return 4294967295;
}

/** Render a sample type the way GDAL names it, e.g. `UInt16` / `Float32`. */
export function sampleFormatName(sampleFormat: number, bitsPerSample: number): string {
  const prefix = sampleFormat === SAMPLE_FORMAT_FLOAT
    ? 'Float'
    : sampleFormat === SAMPLE_FORMAT_INT ? 'Int' : 'UInt';
  return `${prefix}${bitsPerSample}`;
}

/**
 * Parse a TIFF `ColorMap` tag: three consecutive runs of 16-bit values (all
 * reds, then all greens, then all blues) scaled down to 0-255. Returns null
 * when the tag is missing or malformed.
 */
export function parseTiffColorMap(raw: unknown): CogPaletteColor[] | null {
  if (!raw || typeof (raw as any).length !== 'number') return null;
  const values = Array.from(raw as ArrayLike<number>);
  const count = Math.floor(values.length / 3);
  if (count < 1) return null;
  const out: CogPaletteColor[] = [];
  for (let i = 0; i < count; i++) {
    // libtiff/GDAL scale 16-bit colour-table entries by 255/65535 = 1/257.
    const scale = (v: number) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) / 257)));
    out.push([scale(values[i]), scale(values[count + i]), scale(values[2 * count + i])]);
  }
  return out;
}

// --- source introspection ---------------------------------------------------

/** Run a possibly-throwing reader, falling back when a tag is unavailable. */
function safe<T>(read: () => T, fallback: T): T {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Read a TIFF tag, preferring the async loader (some tags are deferred). */
async function readTag(fileDirectory: any, tag: string): Promise<any> {
  if (!fileDirectory) return undefined;
  try {
    if (typeof fileDirectory.loadValue === 'function') {
      return await fileDirectory.loadValue(tag);
    }
  } catch { /* fall through to the sync reader */ }
  return safe(() => fileDirectory.getValue(tag), undefined);
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pull the parsed GeoTIFF image out of a ready `ol/source/GeoTIFF`.
 *
 * OpenLayers keeps the geotiff.js images on a private field; there is no public
 * accessor for the colour table or the per-band sample types. Every read is
 * guarded so an OpenLayers upgrade that renames the field degrades the picker
 * to plain numbered bands instead of breaking layer rendering.
 */
function getCogImage(source: any): any | null {
  const imagery = source?.sourceImagery_;
  if (!Array.isArray(imagery)) return null;
  for (const perSource of imagery) {
    if (Array.isArray(perSource) && perSource.length > 0) return perSource[0];
  }
  return null;
}

/** Placeholder descriptors for when only the band count is known. */
function plainBands(count: number): CogBandDescriptor[] {
  const out: CogBandDescriptor[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      band: i,
      label: `Band ${i}`,
      dataType: 'unknown',
      sampleFormat: SAMPLE_FORMAT_UINT,
      bitsPerSample: 8,
      dtypeMin: 0,
      dtypeMax: 255,
    });
  }
  return out;
}

/**
 * Describe the bands of a loaded GeoTIFF source. The source must be `ready`
 * (its metadata has been read); results are memoised per source object.
 */
export function describeCogBands(source: any): Promise<CogBandInfo> {
  if (!source || typeof source !== 'object') {
    return Promise.resolve(emptyBandInfo());
  }
  const cached = infoCache.get(source);
  if (cached) return cached;
  // Never rejects: an unreadable file directory degrades to numbered bands
  // rather than breaking the layer editor (or the layer itself).
  const pending = readBandInfo(source).catch((error) => {
    console.warn('[COG] Could not read band details:', error);
    infoCache.delete(source);
    return countOnlyBandInfo(source);
  });
  infoCache.set(source, pending);
  return pending;
}

/** Band-count-only description, used when the TIFF tags cannot be read. */
function countOnlyBandInfo(source: any): CogBandInfo {
  const hasNodataAlpha = !!source?.hasAlpha;
  const totalBandCount = typeof source?.bandCount === 'number' ? source.bandCount : 0;
  const count = Math.max(0, totalBandCount - (hasNodataAlpha ? 1 : 0));
  return {
    ...emptyBandInfo(),
    available: count > 0,
    bandCount: count,
    hasNodataAlpha,
    bands: plainBands(count),
  };
}

function emptyBandInfo(): CogBandInfo {
  return {
    available: false,
    detailed: false,
    bandCount: 0,
    hasNodataAlpha: false,
    nodataValue: null,
    photometric: null,
    bands: [],
    colorMap: null,
    fileAlphaBand: null,
  };
}

async function readBandInfo(source: any): Promise<CogBandInfo> {
  const hasNodataAlpha = !!source.hasAlpha;
  const totalBandCount = typeof source.bandCount === 'number' ? source.bandCount : 0;
  const fallbackCount = Math.max(0, totalBandCount - (hasNodataAlpha ? 1 : 0));

  const image = getCogImage(source);
  if (!image) {
    // The band count is public on the source; everything else is unknown.
    return countOnlyBandInfo(source);
  }

  const fd = image.fileDirectory;
  const samplesPerPixel = safe(() => image.getSamplesPerPixel(), 0) || fallbackCount;
  const photometric = toNumber(await readTag(fd, 'PhotometricInterpretation')) ?? null;
  const extraSamplesRaw = await readTag(fd, 'ExtraSamples');
  const colorMapRaw = await readTag(fd, 'ColorMap');
  const nodataRaw = safe(() => image.getGDALNoData(), null);
  const nodataValue = nodataRaw === null || nodataRaw === undefined
    ? toNumber(await readTag(fd, 'GDAL_NODATA')) ?? null
    : Number(nodataRaw);

  const colorMap = photometric === PHOTOMETRIC_PALETTE ? parseTiffColorMap(colorMapRaw) : null;

  // A 4-sample RGB file is treated as RGBA by OpenLayers' default shader; keep
  // that alpha when the user picks a custom RGB combination.
  const extraSamples = Array.isArray(extraSamplesRaw) ? extraSamplesRaw : (extraSamplesRaw === undefined || extraSamplesRaw === null ? [] : [extraSamplesRaw]);
  // ExtraSamples describes the trailing samples beyond the first; 1 = alpha
  // (associated), 2 = alpha (unassociated). A 4-sample RGB file without the tag
  // is RGBA by convention — which is how OpenLayers' default shader reads it.
  const alphaSamples = extraSamples.filter((v: any) => Number(v) === 1 || Number(v) === 2).length;
  const fileAlphaBand = alphaSamples > 0
    ? samplesPerPixel - extraSamples.length + 1
    : (extraSamples.length === 0 && samplesPerPixel === 4 && photometric === PHOTOMETRIC_RGB
      ? samplesPerPixel
      : null);

  const bands: CogBandDescriptor[] = [];
  let floatWithoutStats = false;
  for (let i = 0; i < samplesPerPixel; i++) {
    const sampleFormat = safe(() => image.getSampleFormat(i), SAMPLE_FORMAT_UINT);
    const bitsPerSample = safe(() => image.getBitsPerSample(i), 8);
    const stats = await readGdalStats(image, i);
    const isFloat = sampleFormat === SAMPLE_FORMAT_FLOAT;
    const hasStats = stats.min !== undefined && stats.max !== undefined;
    if (isFloat && !hasStats) floatWithoutStats = true;
    const name = stats.description;
    const dataType = sampleFormatName(sampleFormat, bitsPerSample);
    bands.push({
      band: i + 1,
      label: name ? `Band ${i + 1} — ${name} (${dataType})` : `Band ${i + 1} (${dataType})`,
      name,
      dataType,
      sampleFormat,
      bitsPerSample,
      dtypeMin: dataTypeMin(sampleFormat, bitsPerSample),
      dtypeMax: dataTypeMax(sampleFormat, bitsPerSample),
      statsMin: stats.min,
      statsMax: stats.max,
      statsMean: stats.mean,
      statsStdDev: stats.stdDev,
    });
  }

  return {
    available: bands.length > 0,
    detailed: true,
    bandCount: bands.length,
    hasNodataAlpha,
    nodataValue: Number.isFinite(nodataValue) ? nodataValue : null,
    photometric,
    bands,
    colorMap: colorMap && colorMap.length <= MAX_PALETTE_ENTRIES ? colorMap : null,
    fileAlphaBand: fileAlphaBand && fileAlphaBand >= 1 && fileAlphaBand <= samplesPerPixel ? fileAlphaBand : null,
    warning: colorMap && colorMap.length > MAX_PALETTE_ENTRIES
      ? `The colour table has ${colorMap.length} entries; only ${MAX_PALETTE_ENTRIES} can be rendered.`
      : floatWithoutStats
        ? 'This file has floating-point bands without built-in statistics, so the default stretch may look all-black. Set a manual min/max.'
        : undefined,
  };
}

interface BandStats {
  min?: number;
  max?: number;
  mean?: number;
  stdDev?: number;
  description?: string;
}

/** Read a single band's GDAL metadata items (statistics + description). */
async function readGdalStats(image: any, sampleIndex: number): Promise<BandStats> {
  let meta: any = null;
  try {
    meta = typeof image.getGDALMetadata === 'function'
      ? await image.getGDALMetadata(sampleIndex)
      : null;
  } catch {
    meta = null;
  }
  if (!meta) return {};
  return {
    min: toNumber(meta.STATISTICS_MINIMUM),
    max: toNumber(meta.STATISTICS_MAXIMUM),
    mean: toNumber(meta.STATISTICS_MEAN),
    stdDev: toNumber(meta.STATISTICS_STDDEV),
    description: typeof meta.DESCRIPTION === 'string' && meta.DESCRIPTION.trim()
      ? meta.DESCRIPTION.trim()
      : undefined,
  };
}

// --- render-config normalisation -------------------------------------------

/** Clamp a band number into the range the file actually has. */
function clampBand(band: number | undefined, bandCount: number, fallback: number): number {
  const n = Math.round(Number(band));
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, Math.max(1, bandCount));
  return Math.min(Math.max(1, n), Math.max(1, bandCount));
}

/**
 * Coerce a persisted/edited render config into one that is valid for `info`:
 * band numbers inside range, three entries for RGB, a usable stretch, and a
 * fallback when the chosen mode is impossible for this file (e.g. `colormap`
 * on a file with no colour table).
 */
export function normalizeCogRender(
  render: CogRenderConfig | null | undefined,
  info: CogBandInfo | null | undefined,
): CogRenderConfig {
  const base: CogRenderConfig = render && typeof render === 'object' ? { ...render } : { ...DEFAULT_COG_RENDER };
  const mode: CogRenderMode = base.mode || 'auto';
  const count = info?.bandCount ?? 0;
  // Without a band description there is nothing to validate against, so the
  // config is passed through as-is rather than clamped into nonsense.
  if (!count) return { ...base, mode };

  if (mode === 'colormap') {
    if (!info?.colorMap || info.colorMap.length < 2) {
      return { mode: count >= 3 ? 'rgb' : 'single', ...(count >= 3 ? { rgb: sanitiseRgb(base.rgb, count) } : { band: clampBand(base.band, count, 1) }) };
    }
    return { mode: 'colormap', band: clampBand(base.band, count, 1) };
  }

  if (mode === 'rgb') {
    if (count < 3) {
      return { mode: 'single', band: clampBand(base.band ?? base.rgb?.[0], count, 1) };
    }
    return { mode: 'rgb', rgb: sanitiseRgb(base.rgb, count) };
  }

  if (mode === 'single') {
    const band = clampBand(base.band, count, 1);
    const min = toNumber(base.stretchMin);
    const max = toNumber(base.stretchMax);
    const stretched = min !== undefined && max !== undefined && min < max;
    return stretched
      ? { mode: 'single', band, stretchMin: min, stretchMax: max }
      : { mode: 'single', band };
  }

  return { mode: 'auto' };
}

function sanitiseRgb(rgb: number[] | undefined, count: number): number[] {
  const source = Array.isArray(rgb) ? rgb : [];
  const fallback = [1, 2, 3];
  return fallback.map((f, i) => clampBand(source[i] ?? f, count, f));
}

/**
 * The renderer this file most likely wants: paletted files get their colour
 * table, three-plus-band files get true colour, everything else is grayscale.
 */
export function suggestedCogRender(info: CogBandInfo | null | undefined): CogRenderConfig {
  if (!info?.available) return { ...DEFAULT_COG_RENDER };
  if (info.colorMap && info.colorMap.length >= 2) return { mode: 'colormap', band: 1 };
  if (info.bandCount >= 3) return { mode: 'rgb', rgb: [1, 2, 3] };
  return { mode: 'single', band: 1 };
}

/** True when the config changes nothing relative to OpenLayers' default. */
export function isDefaultCogRender(render: CogRenderConfig | null | undefined): boolean {
  return !render || !render.mode || render.mode === 'auto';
}

/**
 * Stable key of everything that is baked into the GeoTIFF source (i.e. that
 * changes how pixel values are normalised). When two configs share a key the
 * change is style-only and can be applied live without rebuilding the layer.
 */
export function cogBakeKey(render: CogRenderConfig | null | undefined): string {
  if (!render) return '';
  if (render.mode === 'colormap') return `colormap:${render.band ?? 1}`;
  if (render.mode === 'single') {
    // Only an actual stretch is baked; picking a band on its own is a style
    // change and must not force a rebuild.
    const min = toNumber(render.stretchMin);
    const max = toNumber(render.stretchMax);
    if (min === undefined || max === undefined || !(min < max)) return '';
    return `single:${render.band ?? 1}:${min}:${max}`;
  }
  return '';
}

/** True when switching from `prev` to `next` needs a new GeoTIFF source. */
export function needsCogRebuild(
  prev: CogRenderConfig | null | undefined,
  next: CogRenderConfig | null | undefined,
): boolean {
  return cogBakeKey(prev) !== cogBakeKey(next);
}

/**
 * Per-band `min`/`max` to hand the GeoTIFF source so its 8-bit normalisation
 * covers exactly the window the user asked for. Arrays are indexed by *file*
 * band; holes are left `undefined` so untouched bands keep OpenLayers' default.
 * Returns null when nothing needs baking.
 */
export function cogBakeRanges(
  render: CogRenderConfig | null | undefined,
  info: CogBandInfo | null | undefined,
): { min: (number | undefined)[]; max: (number | undefined)[] } | null {
  if (!render) return null;
  const count = Math.max(1, info?.bandCount ?? 0);

  if (render.mode === 'colormap') {
    const entries = info?.colorMap?.length ?? 0;
    if (entries < 2) return null;
    const band = clampBand(render.band, count, 1);
    return bakeAt(band, 0, entries - 1);
  }

  if (render.mode === 'single') {
    const min = toNumber(render.stretchMin);
    const max = toNumber(render.stretchMax);
    if (min === undefined || max === undefined || !(min < max)) return null;
    const band = clampBand(render.band, count, 1);
    return bakeAt(band, min, max);
  }

  return null;
}

/**
 * Build the sparse per-band `min`/`max` arrays. They only need to reach the
 * band being baked: OpenLayers reads `source.min[bandIndex]` per band and an
 * out-of-range index yields `undefined`, which keeps that band's default.
 */
function bakeAt(
  band: number,
  min: number,
  max: number,
): { min: (number | undefined)[]; max: (number | undefined)[] } {
  const length = Math.max(1, band);
  const mins: (number | undefined)[] = new Array(length).fill(undefined);
  const maxs: (number | undefined)[] = new Array(length).fill(undefined);
  mins[band - 1] = min;
  maxs[band - 1] = max;
  return { min: mins, max: maxs };
}

// --- style construction ----------------------------------------------------

/**
 * Build the OpenLayers WebGLTile `color` expression for a render config, or
 * `undefined` to keep the library default. Band numbers are 1-based file
 * bands; `['band', n]` reads the normalised (0-1) value of band n.
 */
export function buildCogColorExpression(
  render: CogRenderConfig | null | undefined,
  info: CogBandInfo | null | undefined,
): any | undefined {
  const effective = normalizeCogRender(render, info);
  const count = info?.bandCount ?? 0;
  if (!count) return undefined;

  switch (effective.mode) {
    case 'rgb': {
      const [r, g, b] = effective.rgb || [1, 2, 3];
      // Keep a genuine alpha channel (ExtraSamples / 4-band RGBA) transparent.
      const alpha = info?.fileAlphaBand && info.fileAlphaBand !== r && info.fileAlphaBand !== g && info.fileAlphaBand !== b
        ? ['band', info.fileAlphaBand]
        : 1;
      return ['array', ['band', r], ['band', g], ['band', b], alpha];
    }
    case 'single': {
      const band = effective.band ?? 1;
      const value = ['band', band];
      return ['array', value, value, value, 1];
    }
    case 'colormap': {
      const palette = info?.colorMap;
      if (!palette || palette.length < 2) return undefined;
      const band = effective.band ?? 1;
      const last = palette.length - 1;
      // cogBakeRanges normalises the band across [0, last], so scaling back up
      // recovers the exact class index; rounding guards float precision.
      const index = ['round', ['*', ['band', band], last]];
      return ['palette', index, palette.map(([r, g, b]) => `rgba(${r},${g},${b},1)`)];
    }
    default:
      return undefined;
  }
}

/**
 * Full WebGLTile style for a COG: the shared exposure/contrast/saturation
 * variables plus the band `color` expression (omitted in `auto` mode so
 * OpenLayers' own default mapping is used untouched).
 */
export function buildCogRenderStyle(
  render: CogRenderConfig | null | undefined,
  info: CogBandInfo | null | undefined,
): any {
  const style = createCogTileStyle();
  const color = buildCogColorExpression(render, info);
  return color ? { ...style, color } : style;
}

/**
 * Apply a band/renderer change to a live COG layer without touching its source.
 *
 * `setStyle()` replaces the layer's style *variables* wholesale, so the current
 * brightness/contrast/saturation values are folded back in — otherwise moving a
 * band slider would silently reset the Colors panel.
 *
 * @returns true when the change could be applied live.
 */
export function applyCogRender(
  olLayer: any,
  render: CogRenderConfig | null | undefined,
  info: CogBandInfo | null | undefined,
  adjustments?: CogColorAdjustments | null,
): boolean {
  if (!olLayer || typeof olLayer.setStyle !== 'function') return false;
  const style = buildCogRenderStyle(render, info);
  if (adjustments) {
    Object.assign(style.variables, cogColorVariables(adjustments));
  }
  olLayer.setStyle(style);
  return true;
}

// --- UI helpers -------------------------------------------------------------

/** Short badge text for the collapsed panel header. */
export function cogRenderSummary(
  render: CogRenderConfig | null | undefined,
  info: CogBandInfo | null | undefined,
): string {
  const effective = normalizeCogRender(render, info);
  switch (effective.mode) {
    case 'rgb': {
      const [r, g, b] = effective.rgb || [1, 2, 3];
      const isDefaultOrder = r === 1 && g === 2 && b === 3;
      return isDefaultOrder ? 'RGB 1·2·3' : `RGB ${r}·${g}·${b}`;
    }
    case 'single': {
      const band = effective.band ?? 1;
      return effective.stretchMin !== undefined && effective.stretchMax !== undefined
        ? `Band ${band} · ${formatRangeValue(effective.stretchMin)}–${formatRangeValue(effective.stretchMax)}`
        : `Band ${band}`;
    }
    case 'colormap':
      return 'Colour map';
    default:
      return 'default';
  }
}

/** Compact number formatting for stretch readouts (`34000` not `34000.000`). */
export function formatRangeValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(2);
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 1 : 3;
  return String(Number(value.toFixed(decimals)));
}

/** One-line description of the file for the panel header. */
export function describeCogFile(info: CogBandInfo | null | undefined): string {
  if (!info?.available) return 'Band details unavailable';
  const type = info.bands[0]?.dataType;
  const parts = [`${info.bandCount} band${info.bandCount === 1 ? '' : 's'}`];
  if (type && type !== 'unknown') parts.push(type);
  if (info.colorMap) parts.push(`${info.colorMap.length}-entry colour table`);
  if (info.nodataValue !== null && info.nodataValue !== undefined) parts.push(`nodata ${formatRangeValue(info.nodataValue)}`);
  if (info.hasNodataAlpha) parts.push('nodata masked');
  return parts.join(' · ');
}

/**
 * Sample a colour table into CSS gradient stops for the panel's ramp preview.
 * Long tables are thinned evenly so the style string stays small; the first and
 * last entries are always included.
 */
export function paletteGradientStops(
  colorMap: CogPaletteColor[],
  maxStops = 24,
): string[] {
  const count = colorMap.length;
  if (!count) return [];
  const stops = Math.max(2, Math.min(maxStops, count));
  const out: string[] = [];
  for (let i = 0; i < stops; i++) {
    const index = Math.round((i * (count - 1)) / (stops - 1));
    const [r, g, b] = colorMap[index];
    const position = Math.round((i / (stops - 1)) * 100);
    out.push(`rgb(${r},${g},${b}) ${position}%`);
  }
  return out;
}
