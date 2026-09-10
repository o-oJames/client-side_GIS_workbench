// ---------------------------------------------------------------------------
// COG contour lines — QGIS' "Contours" raster renderer, as vector geometry.
//
// A fragment shader can decide whether *one pixel* sits on an isoline, but it
// cannot give that line a width, a dash pattern (dashes need a distance along
// the line, and OpenLayers' expression language exposes no fragment
// coordinate), or QGIS' "Input Downscaling" — which coarsens the DEM the lines
// are traced from. So the Contours renderer leaves the shader:
//
//   1. the elevation band is read straight out of the file, in its own units,
//      resampled to (display pixels / downscale) exactly the way QGIS requests
//      its input block,
//   2. marching squares traces every level between the sampled min and max
//      (open chains included — a contour that leaves the view is a polyline,
//      not a ring),
//   3. the lines go into a companion `ol/layer/Vector` with a QGIS-style line
//      symbol: width, brush style, and a separate symbol for index contours.
//
// The raster layer itself is hidden while this is on screen, so the map shows
// lines over the basemap just like QGIS does. Tracing is per view: the hook in
// hooks/useCogContours.ts re-runs it when the view settles and keeps a
// buffered grid so small pans cost nothing.
//
// Framework-agnostic per AGENTS.md §3: plain data in, OL objects out.
// ---------------------------------------------------------------------------
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import Text from 'ol/style/Text.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { getTransform, transformExtent } from 'ol/proj.js';
import type { CogContourConfig, CogLineStyle } from '../types';
import { DEFAULT_CONTOUR, cogSourceImages, formatRangeValue } from './cogBands';
import { marchingSquaresPaths, simplifyPath, type Pt } from './contourExtract';

/** Marks the companion layer so `reorderLayers` keeps it with its raster. */
export const CONTOUR_LAYER_PROPERTY = '_isCogContourLayer';
/** The raster OL layer a contour overlay belongs to. */
export const CONTOUR_PARENT_PROPERTY = '_cogContourParent';
/** Feature property carrying the line's elevation, in the file's units. */
export const CONTOUR_LEVEL_PROPERTY = 'cogContourLevel';
/** Feature property marking an index (accent) contour. */
export const CONTOUR_INDEX_PROPERTY = 'cogContourIndex';

/** Longest grid axis traced; bigger views are read coarser instead. */
export const MAX_CONTOUR_GRID_CELLS = 1024;
/**
 * Largest window geotiff.js may be asked to materialise before it resamples
 * (it allocates the whole window up front): 4 M pixels ≈ 16 MB per band.
 */
export const MAX_READ_PIXELS = 4_000_000;
/** Levels above this are thinned evenly rather than traced (a silly interval). */
export const MAX_CONTOUR_LEVELS = 300;
/** Vertex budget for one trace; hitting it stops the walk. */
export const MAX_CONTOUR_VERTICES = 250_000;
/** Halo behind a contour label, so it stays readable over any basemap. */
export const CONTOUR_LABEL_HALO = 'rgba(255,255,255,0.85)';
/** Douglas-Peucker tolerance in grid pixels (sub-pixel: keeps lines smooth). */
export const CONTOUR_SIMPLIFY_PIXELS = 0.35;

/** A safety cap that changed what was drawn, for the UI to explain. */
export type ContourCap = 'grid' | 'levels' | 'vertices';

/**
 * Why a trace produced no lines. Reported instead of a single opaque failure
 * because the useful answer differs: "still loading" wants a retry, "the view
 * is off the file" is not an error at all, and "no level small enough to read"
 * is a limitation of the file the user should be told about in plain words.
 */
export type ContourFailure =
  | 'source-not-ready' // the GeoTIFF source has not parsed its imagery yet
  | 'bad-extent'       // the caller passed an unusable view extent/projection
  | 'no-georeference'  // no level of the file carries an affine transform
  | 'no-transform'     // the file's CRS cannot be transformed into the view's
  | 'no-overlap'       // the view does not (meaningfully) touch the file
  | 'too-large'        // every level needs a bigger read than MAX_READ_PIXELS
  | 'read-error'       // geotiff.js refused the read
  | 'no-values';       // every sampled pixel was nodata

/** One read attempt: the grid, or the reason there is none. */
export interface CogGridAttempt {
  grid: CogContourGrid | null;
  failure: ContourFailure | null;
  /** Extra detail for the console and the toast (a message, a CRS pair). */
  detail?: string;
}

/** One elevation a line is drawn at. */
export interface ContourLevel {
  level: number;
  /** True for the accent lines that repeat every index interval. */
  index: boolean;
}

/** A downscaled elevation sample of the area being traced. */
export interface CogContourGrid {
  /** Elevations in the file's own units; NaN where nodata or unreadable. */
  field: Float32Array;
  width: number;
  height: number;
  /** Area covered, in the file's own CRS: [minx, miny, maxx, maxy]. */
  fileExtent: number[];
  /** The same area in the *view* projection — what the map and cache work in. */
  extent: number[];
  /** EPSG code of the file, or null when it is already the view projection. */
  projection: string | null;
  /** Caps hit while reading (`grid` = read coarser than asked for). */
  caps: ContourCap[];
}

// --- small guarded readers --------------------------------------------------

/** Run a possibly-throwing reader against untyped geotiff.js objects. */
function safe<T>(read: () => T, fallback: T): T {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function clampInt(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/** The EPSG code a GeoTIFF source reads its data in (null when unknown). */
export function cogSourceProjection(source: any): string | null {
  const projection = safe(() => source?.getProjection?.(), null);
  if (!projection) return null;
  const code = typeof (projection as any).getCode === 'function'
    ? (projection as any).getCode()
    : String(projection);
  return typeof code === 'string' && code ? code : null;
}

function transformExtentSafe(extent: number[], from: string, to: string): number[] | null {
  try {
    const out = transformExtent(extent, from, to);
    return out && out.length === 4 && out.every(Number.isFinite) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Per-vertex transform out of the file's own CRS, or null when the file is
 * already in the projection the map is displaying. The view projection is not
 * always EPSG:3857 — this app lets the user switch it — and OL renders vector
 * layers in the view projection without reprojecting, so the traced
 * coordinates have to arrive in exactly that CRS.
 */
export function projectionPointTransform(
  from: string | null,
  to: string,
): ((xy: number[]) => number[]) | null {
  if (!from || from === to) return null;
  try {
    return getTransform(from, to);
  } catch (error) {
    console.warn('[COG contours] No transform from', from, 'to', to, error);
    return null;
  }
}

// --- levels -----------------------------------------------------------------

/** True when a level is a multiple of the index interval. */
function isIndexLevel(level: number, indexInterval: number): boolean {
  if (!(indexInterval > 0) || !Number.isFinite(indexInterval)) return false;
  const ratio = level / indexInterval;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

/**
 * Every elevation a line should be drawn at between `min` and `max` — QGIS
 * traces the multiples of the interval inside the sampled range and marks the
 * multiples of the index interval as index contours.
 *
 * An interval far too small for the range (centimetres over kilometres) would
 * ask for millions of lines, so the list is thinned by an even stride instead
 * of tracing only the bottom of the terrain: the lines still cover the whole
 * range, and each feature carries its true elevation.
 */
export function planContourLevels(
  min: number,
  max: number,
  interval: number,
  indexInterval: number,
  maxLevels = MAX_CONTOUR_LEVELS,
): { levels: ContourLevel[]; caps: ContourCap[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(interval > 0) || !(max > min)) {
    return { levels: [], caps: [] };
  }
  const first = Math.ceil(min / interval - 1e-9) * interval;
  const count = Math.floor((max - first) / interval + 1e-9) + 1;
  if (!(count > 0)) return { levels: [], caps: [] };
  const stride = count > maxLevels ? Math.ceil(count / maxLevels) : 1;
  const levels: ContourLevel[] = [];
  for (let i = 0; i < count; i += stride) {
    const level = first + i * interval;
    levels.push({ level, index: isIndexLevel(level, indexInterval) });
  }
  return { levels, caps: stride > 1 ? ['levels'] : [] };
}

/** Lowest/highest finite value of a grid, ignoring nodata (NaN) cells. */
export function gridRange(field: Float32Array): { min: number; max: number; samples: number } | null {
  let min = Infinity;
  let max = -Infinity;
  let samples = 0;
  for (let i = 0; i < field.length; i++) {
    const value = field[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    samples++;
  }
  return samples > 0 ? { min, max, samples } : null;
}

// --- symbols ----------------------------------------------------------------

/**
 * OpenLayers `lineDash` for a QGIS brush style, in pixels and scaled with the
 * pen width the way QGIS scales its dash patterns with the symbol width. A
 * round cap turns the short "dot" dashes into visible dots.
 */
export function contourDashPattern(style: CogLineStyle | undefined, width: number): number[] | undefined {
  const w = Math.max(0.5, Number.isFinite(width) ? width : 1);
  const round = (n: number) => Math.round(n * 100) / 100;
  switch (style) {
    case 'dash': return [round(6 * w), round(4 * w)];
    case 'dot': return [round(w), round(2 * w)];
    case 'dash-dot': return [round(6 * w), round(3 * w), round(w), round(3 * w)];
    case 'dash-dot-dot': return [round(6 * w), round(3 * w), round(w), round(3 * w), round(w), round(3 * w)];
    case 'solid':
    default: return undefined;
  }
}

/** The stroke of one of the two contour symbols (regular or index). */
export function contourStroke(config: CogContourConfig | undefined, index: boolean): Stroke {
  const ct = config ?? {};
  const width = (index ? ct.indexLineWidth : ct.lineWidth) ?? (index ? DEFAULT_CONTOUR.indexLineWidth : DEFAULT_CONTOUR.lineWidth);
  const style = (index ? ct.indexLineStyle : ct.lineStyle) ?? (index ? DEFAULT_CONTOUR.indexLineStyle : DEFAULT_CONTOUR.lineStyle);
  const color = (index ? ct.indexColor : ct.color) ?? (index ? DEFAULT_CONTOUR.indexColor : DEFAULT_CONTOUR.color);
  return new Stroke({
    color,
    width,
    lineDash: contourDashPattern(style, width),
    lineCap: 'round',
    lineJoin: 'round',
  });
}

/** Font of the elevation printed along a line (index contours are bolder). */
export function contourLabelFont(index: boolean): string {
  return index ? 'bold 11px Arial' : '11px Arial';
}

/**
 * The elevation printed along a contour line: the level in the file's own
 * units, in the line's own colour, with a light halo so it stays readable over
 * any basemap. `placement: 'line'` bends the text along the geometry, and the
 * layer's `declutter` drops the labels that would collide.
 */
export function contourLabel(level: number, index: boolean, color: string): Text {
  return new Text({
    text: formatRangeValue(level),
    font: contourLabelFont(index),
    placement: 'line',
    fill: new Fill({ color }),
    stroke: new Stroke({ color: CONTOUR_LABEL_HALO, width: 2.5 }),
    // Let a label run past the end of a short line instead of dropping it.
    overflow: true,
    maxAngle: Math.PI / 2,
  });
}

/** Style function picking the index symbol — and the label — per feature. */
export function contourStyleFunction(config: CogContourConfig | undefined): (feature: any) => Style {
  const ct = config ?? {};
  const regularStroke = contourStroke(ct, false);
  const accentStroke = contourStroke(ct, true);
  const regularColor = ct.color ?? DEFAULT_CONTOUR.color;
  const indexColor = ct.indexColor ?? DEFAULT_CONTOUR.indexColor;
  const labelled = (ct.showLabel ?? DEFAULT_CONTOUR.showLabel) !== false;
  // The label text depends on the feature's elevation, so styles are cached per
  // (symbol, level) instead of being rebuilt for every feature on every render.
  const cache = new Map<string, Style>();
  return (feature: any) => {
    const index = !!feature?.get?.(CONTOUR_INDEX_PROPERTY);
    const level = Number(feature?.get?.(CONTOUR_LEVEL_PROPERTY));
    const text = labelled && Number.isFinite(level) ? level : null;
    const key = `${index ? 'i' : 'r'}:${text === null ? '' : text}`;
    let style = cache.get(key);
    if (!style) {
      style = new Style({
        stroke: index ? accentStroke : regularStroke,
        text: text === null ? undefined : contourLabel(text, index, index ? indexColor : regularColor),
      });
      cache.set(key, style);
    }
    return style;
  };
}

/**
 * The companion vector layer a COG's contours are drawn into. Carries the
 * markers `reorderLayers` uses to keep it immediately above its raster layer
 * (which is hidden while contours are on screen).
 */
export function createContourLayer(parent: any, config: CogContourConfig | undefined): any {
  const source = new VectorSource({ wrapX: false });
  const layer = new VectorLayer({
    source,
    style: contourStyleFunction(config),
    // Labels are the only thing worth decluttering: colliding elevations are
    // dropped rather than printed over each other. Lines are never decluttered.
    declutter: true,
    // Contours are static between traces: no need to re-render mid-gesture.
    updateWhileAnimating: false,
    updateWhileInteracting: false,
    properties: {
      [CONTOUR_LAYER_PROPERTY]: true,
      [CONTOUR_PARENT_PROPERTY]: parent ?? null,
    },
  });
  return layer;
}

// --- reading the DEM --------------------------------------------------------

/** One readable level: its image, size, ground extent, pixel size, nodata. */
interface LevelGeometry {
  image: any;
  width: number;
  height: number;
  bbox: number[];
  /** Ground size of one pixel of this level, in the file's units. */
  resX: number;
  /** This level's nodata, or the reference level's when it carries none. */
  nodata: number | null;
}

/** A level's own geo-transform, or null when its IFD carries none. */
function ownExtent(image: any): { bbox: number[]; resX: number } | null {
  const bbox = safe(() => image.getBoundingBox(), null) as number[] | null;
  const width = safe(() => image.getWidth(), 0);
  if (!Array.isArray(bbox) || bbox.length !== 4 || !(width > 0)) return null;
  const spanX = bbox[2] - bbox[0];
  const spanY = bbox[3] - bbox[1];
  if (!(spanX > 0) || !(spanY > 0)) return null;
  return { bbox, resX: spanX / width };
}

/** The GDAL nodata value a level carries, or null when it carries none. */
function nodataOf(image: any): number | null {
  const raw = safe(() => image.getGDALNoData(), null);
  const value = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every readable level of a GeoTIFF source, **coarsest first**.
 *
 * In a GDAL COG only the *main* IFD is geo-referenced: the overview IFDs carry
 * no ModelTiepoint/ModelPixelScale, so geotiff.js throws ("The image does not
 * have an affine transformation") when their bounding box is asked for. They
 * are still perfectly readable — OpenLayers renders every zoomed-out tile from
 * them — so their geometry is derived the way OpenLayers derives their
 * resolution (`getResolutions(image, reference)` in ol/source/GeoTIFF): an
 * overview covers exactly the ground its parent covers, so its extent is the
 * reference extent and its pixel size is the reference's scaled by the width
 * ratio. nodata is inherited the same way when a level omits the tag.
 *
 * Taking only the levels that can answer for themselves — as an earlier
 * version did — leaves nothing but the full-resolution level, whose window is
 * far too large to read once the view is wider than a few hundred metres, so
 * every zoomed-out contour trace failed with "could not read elevations".
 *
 * The result is sorted here rather than trusted from the source: OpenLayers
 * keeps its level list coarsest-first today, but that is an implementation
 * detail of a private field.
 */
export function levelGeometries(levels: any[]): LevelGeometry[] {
  const candidates: {
    image: any;
    width: number;
    height: number;
    own: { bbox: number[]; resX: number } | null;
    nodata: number | null;
  }[] = [];
  for (const image of levels ?? []) {
    if (!image) continue;
    const width = safe(() => image.getWidth(), 0);
    const height = safe(() => image.getHeight(), 0);
    if (!(width > 1) || !(height > 1)) continue;
    candidates.push({ image, width, height, own: ownExtent(image), nodata: nodataOf(image) });
  }
  // The reference is the largest level that carries its own geo-transform —
  // in a COG that is the main image, which is also the finest.
  let reference: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (!candidate.own) continue;
    if (!reference || candidate.width * candidate.height > reference.width * reference.height) {
      reference = candidate;
    }
  }
  if (!reference || !reference.own) return [];
  const refBbox = reference.own.bbox;
  const geometries = candidates.map((candidate) => ({
    image: candidate.image,
    width: candidate.width,
    height: candidate.height,
    bbox: candidate.own ? candidate.own.bbox : refBbox.slice(),
    resX: candidate.own
      ? candidate.own.resX
      : (reference!.own!.resX * reference!.width) / candidate.width,
    nodata: candidate.nodata ?? reference!.nodata,
  }));
  geometries.sort((a, b) => b.resX - a.resX);
  return geometries;
}

/** The clamped pixel window of `readExtent` in one level, or null when empty. */
function windowOf(geo: LevelGeometry, readExtent: number[]): number[] | null {
  const spanX = geo.bbox[2] - geo.bbox[0];
  const spanY = geo.bbox[3] - geo.bbox[1];
  const toCol = (x: number) => ((x - geo.bbox[0]) / spanX) * geo.width;
  const toRow = (y: number) => ((geo.bbox[3] - y) / spanY) * geo.height; // rows run north → south
  const wx0 = clampInt(Math.floor(toCol(readExtent[0])), 0, geo.width);
  const wx1 = clampInt(Math.ceil(toCol(readExtent[2])), 0, geo.width);
  const wy0 = clampInt(Math.floor(toRow(readExtent[3])), 0, geo.height);
  const wy1 = clampInt(Math.ceil(toRow(readExtent[1])), 0, geo.height);
  if (wx1 - wx0 < 2 || wy1 - wy0 < 2) return null;
  return [wx0, wy0, wx1, wy1];
}

function windowPixels(geo: LevelGeometry, readExtent: number[]): number {
  const window = windowOf(geo, readExtent);
  return window ? (window[2] - window[0]) * (window[3] - window[1]) : 0;
}

/**
 * The smallest window any level would need for `readExtent` — what the read
 * would cost if the file had the overviews it does not have. 0 = no overlap.
 */
function smallestWindow(geometries: LevelGeometry[], readExtent: number[]): { width: number; height: number; pixels: number } {
  let best = { width: 0, height: 0, pixels: 0 };
  for (const geo of geometries) {
    const window = windowOf(geo, readExtent);
    if (!window) continue;
    const width = window[2] - window[0];
    const height = window[3] - window[1];
    const pixels = width * height;
    if (best.pixels === 0 || pixels < best.pixels) best = { width, height, pixels };
  }
  return best;
}

/**
 * The level to read, from a **coarsest-first** list: the coarsest one still
 * finer than the sampling step (so the read never upsamples and never
 * downloads more than it needs), walked back towards coarser levels when the
 * window at that step would be so large that geotiff.js — which allocates the
 * whole window before it resamples — would try to materialise billions of
 * pixels. Returns null when even the coarsest level is too big, i.e. when the
 * file has no overview small enough for this view.
 */
function pickLevel(geometries: LevelGeometry[], readExtent: number[], targetCellSize: number): LevelGeometry | null {
  if (geometries.length === 0) return null;
  let index = targetCellSize > 0
    ? geometries.findIndex((geo) => geo.resX <= targetCellSize)
    : -1;
  if (index < 0) index = geometries.length - 1; // zoomed past native resolution
  while (index > 0 && windowPixels(geometries[index], readExtent) > MAX_READ_PIXELS) index -= 1;
  if (windowPixels(geometries[index], readExtent) > MAX_READ_PIXELS) return null;
  return geometries[index];
}

/** The first band of a geotiff.js `readRasters` result (array or bare array). */
function firstBandArray(rasters: any): ArrayLike<number> | null {
  if (Array.isArray(rasters)) return rasters[0] ?? null;
  if (rasters && typeof rasters.length === 'number') return rasters;
  return null;
}

/**
 * Read the elevation band over `viewExtent` as a downscaled grid, reporting
 * *why* when there is nothing to read — a blank "could not read elevations"
 * hides the difference between "still loading", "the view is off the file" and
 * "this zoom needs a bigger read than a browser can do".
 *
 * The grid is sized from the display, not from the file: QGIS asks its input
 * for `width / downscale` x `height / downscale` samples of the extent it is
 * rendering, and that is exactly what happens here — the window is read from
 * the overview closest to that step and resampled to it. Nodata becomes NaN so
 * holes are skipped instead of being outlined at every level.
 */
export async function readCogElevationGridDetailed(
  source: any,
  viewExtent: number[],
  viewProjection: string,
  viewport: { width: number; height: number },
  band: number,
  downscale: number,
): Promise<CogGridAttempt> {
  const levels = cogSourceImages(source)[0];
  if (!levels || levels.length === 0) {
    return { grid: null, failure: 'source-not-ready' };
  }
  if (!Array.isArray(viewExtent) || viewExtent.length !== 4 || !viewExtent.every(Number.isFinite) || !viewProjection) {
    return { grid: null, failure: 'bad-extent' };
  }

  const caps: ContourCap[] = [];
  const projection = cogSourceProjection(source);
  const reproject = projection !== null && projection !== viewProjection;
  const readExtent = reproject
    ? transformExtentSafe(viewExtent, viewProjection, projection as string)
    : viewExtent.slice();
  if (!readExtent) {
    return { grid: null, failure: 'no-transform', detail: `${projection ?? '?'} → ${viewProjection}` };
  }

  // QGIS' input downscaling: sample the screen this many times coarser.
  const factor = Math.max(1, Number.isFinite(downscale) ? downscale : DEFAULT_CONTOUR.inputDownscale);
  const viewportWidth = Number.isFinite(viewport?.width) && viewport.width > 0 ? viewport.width : 512;
  const viewportHeight = Number.isFinite(viewport?.height) && viewport.height > 0 ? viewport.height : 512;
  let outW = Math.round(viewportWidth / factor);
  let outH = Math.round(viewportHeight / factor);

  const spanX = readExtent[2] - readExtent[0];
  const geometries = levelGeometries(levels);
  if (geometries.length === 0) return { grid: null, failure: 'no-georeference' };
  const geo = pickLevel(geometries, readExtent, spanX > 0 && outW > 0 ? spanX / outW : Infinity);
  if (!geo) {
    const wanted = smallestWindow(geometries, readExtent);
    return {
      grid: null,
      failure: wanted.pixels > 0 ? 'too-large' : 'no-overlap',
      detail: wanted.pixels > 0
        ? `this view covers ${wanted.width}×${wanted.height} pixels of the file and the readable limit is ${MAX_READ_PIXELS.toLocaleString('en-US')}`
        : undefined,
    };
  }
  const { image, width, height, bbox } = geo;
  const window = windowOf(geo, readExtent);
  if (!window) return { grid: null, failure: 'no-overlap' };
  const [wx0, wy0, wx1, wy1] = window;
  const winW = wx1 - wx0;
  const winH = wy1 - wy0;

  // Never upsample, never trace an unbounded grid.
  outW = Math.min(outW, winW);
  outH = Math.min(outH, winH);
  if (outW > MAX_CONTOUR_GRID_CELLS || outH > MAX_CONTOUR_GRID_CELLS) {
    caps.push('grid');
    outW = Math.min(outW, MAX_CONTOUR_GRID_CELLS);
    outH = Math.min(outH, MAX_CONTOUR_GRID_CELLS);
  }
  if (outW < 2 || outH < 2) return { grid: null, failure: 'no-overlap' };

  const samplesPerPixel = Math.max(1, safe(() => image.getSamplesPerPixel(), 1) || 1);
  const sampleIndex = clampInt(Math.round(Number(band) || 1) - 1, 0, samplesPerPixel - 1);
  let raw: any = null;
  try {
    raw = await image.readRasters({
      window: [wx0, wy0, wx1, wy1],
      samples: [sampleIndex],
      width: outW,
      height: outH,
      interleave: false,
    });
  } catch (error) {
    console.warn('[COG contours] Could not read elevations:', error);
    return { grid: null, failure: 'read-error', detail: (error as any)?.message ?? String(error) };
  }
  const values = firstBandArray(raw);
  if (!values || values.length < outW * outH) {
    return { grid: null, failure: 'read-error', detail: `band ${sampleIndex + 1} returned no pixels` };
  }

  const nodata = geo.nodata;
  const field = new Float32Array(outW * outH);
  for (let i = 0; i < field.length; i++) {
    const value = Number(values[i]);
    field[i] = Number.isFinite(value) && (nodata === null || value !== nodata) ? value : NaN;
  }

  const bboxSpanX = bbox[2] - bbox[0];
  const bboxSpanY = bbox[3] - bbox[1];
  const fileExtent = [
    bbox[0] + (wx0 / width) * bboxSpanX,
    bbox[3] - (wy1 / height) * bboxSpanY,
    bbox[0] + (wx1 / width) * bboxSpanX,
    bbox[3] - (wy0 / height) * bboxSpanY,
  ];
  const extent = reproject
    ? transformExtentSafe(fileExtent, projection as string, viewProjection)
    : fileExtent.slice();
  if (!extent) {
    return { grid: null, failure: 'no-transform', detail: `${projection ?? '?'} → ${viewProjection}` };
  }

  return { grid: { field, width: outW, height: outH, fileExtent, extent, projection, caps }, failure: null };
}

/**
 * Read the elevation band over `viewExtent` as a downscaled grid, or null when
 * there is nothing to read (`readCogElevationGridDetailed` says why).
 */
export async function readCogElevationGrid(
  source: any,
  viewExtent: number[],
  viewProjection: string,
  viewport: { width: number; height: number },
  band: number,
  downscale: number,
): Promise<CogContourGrid | null> {
  return (await readCogElevationGridDetailed(
    source, viewExtent, viewProjection, viewport, band, downscale,
  )).grid;
}

// --- tracing ----------------------------------------------------------------

export interface ContourFeatureResult {
  features: any[];
  caps: ContourCap[];
}

/**
 * Trace every level of a grid into LineString features in EPSG:3857.
 *
 * Lines are simplified in grid space (a fraction of a cell) before they are
 * projected, which keeps the vertex count — and therefore any reprojection —
 * down without visibly changing the shapes.
 */
export function buildContourFeatures(
  grid: CogContourGrid,
  levels: ContourLevel[],
  options?: {
    toMap?: ((xy: number[]) => number[]) | null;
    simplify?: number;
    maxVertices?: number;
  },
): ContourFeatureResult {
  const features: any[] = [];
  const caps: ContourCap[] = [];
  if (!grid || !levels || levels.length === 0) return { features, caps };
  const [fx0, fy0, fx1, fy1] = grid.fileExtent;
  const cellW = (fx1 - fx0) / Math.max(1, grid.width - 1);
  const cellH = (fy1 - fy0) / Math.max(1, grid.height - 1);
  if (!(cellW > 0) || !(cellH > 0)) return { features, caps };
  const tolerance = options?.simplify ?? CONTOUR_SIMPLIFY_PIXELS;
  const maxVertices = options?.maxVertices ?? MAX_CONTOUR_VERTICES;
  const toMap = options?.toMap ?? null;
  let vertices = 0;
  let stopped = false;

  for (const { level, index } of levels) {
    const paths = marchingSquaresPaths(grid.field, grid.width, grid.height, level);
    for (const path of paths) {
      const points: Pt[] = tolerance > 0 ? simplifyPath(path.points, tolerance) : path.points;
      if (!points || points.length < 2) continue;
      const coords: number[][] = new Array(points.length);
      for (let i = 0; i < points.length; i++) {
        const x = fx0 + points[i].x * cellW;
        const y = fy1 - points[i].y * cellH;
        const mapped = toMap ? toMap([x, y]) : [x, y];
        coords[i] = [mapped[0], mapped[1]];
      }
      // A closed ring comes back without its duplicated closing point; put it
      // on the LineString or the contour shows a gap where it closes.
      if (path.closed && coords.length > 2) coords.push(coords[0].slice());
      vertices += coords.length;
      if (vertices > maxVertices) {
        stopped = true;
        break;
      }
      features.push(new Feature({
        geometry: new LineString(coords),
        [CONTOUR_LEVEL_PROPERTY]: level,
        [CONTOUR_INDEX_PROPERTY]: index,
      }));
    }
    if (stopped) break;
  }
  if (stopped) caps.push('vertices');
  return { features, caps };
}

export interface CogContourTraceOptions {
  /** The ready `ol/source/GeoTIFF` of the COG layer. */
  source: any;
  /** Area to cover in the view projection — usually the buffered view extent. */
  viewExtent: number[];
  /** EPSG code the map is displaying in; traced lines are built in it. */
  viewProjection: string;
  /** Display size in CSS pixels; QGIS sizes its input block from it too. */
  viewport: { width: number; height: number };
  /** 1-based file band holding the elevations. */
  band: number;
  /** Contour parameters (already normalised by `normalizeCogRender`). */
  contour?: CogContourConfig;
}

export interface CogContourTrace {
  features: any[];
  levels: ContourLevel[];
  grid: CogContourGrid;
  caps: ContourCap[];
  range: { min: number; max: number; samples: number };
}

/** One Contours pass: the lines, or why there are none. */
export interface CogContourAttempt {
  trace: CogContourTrace | null;
  failure: ContourFailure | null;
  /** Extra detail for the console and the toast (a message, a CRS pair). */
  detail?: string;
}

/**
 * Read + trace in one call: the whole Contours renderer pass for one view,
 * reporting why when it produced nothing (source not ready, view off the file,
 * no level small enough to read, unreadable band, nothing but nodata).
 */
export async function traceCogContoursDetailed(options: CogContourTraceOptions): Promise<CogContourAttempt> {
  const contour = options.contour ?? {};
  const interval = contour.interval ?? DEFAULT_CONTOUR.interval;
  const indexInterval = contour.indexInterval ?? DEFAULT_CONTOUR.indexInterval;
  const downscale = contour.inputDownscale ?? DEFAULT_CONTOUR.inputDownscale;

  const attempt = await readCogElevationGridDetailed(
    options.source, options.viewExtent, options.viewProjection, options.viewport, options.band, downscale,
  );
  const grid = attempt.grid;
  if (!grid) return { trace: null, failure: attempt.failure ?? 'read-error', detail: attempt.detail };
  const range = gridRange(grid.field);
  if (!range) return { trace: null, failure: 'no-values' };

  const planned = planContourLevels(range.min, range.max, interval, indexInterval);
  const caps: ContourCap[] = [...grid.caps, ...planned.caps];
  if (planned.levels.length === 0) {
    return { trace: { features: [], levels: [], grid, caps, range }, failure: null };
  }
  const built = buildContourFeatures(grid, planned.levels, {
    toMap: projectionPointTransform(grid.projection, options.viewProjection),
  });
  for (const cap of built.caps) if (!caps.includes(cap)) caps.push(cap);
  return {
    trace: { features: built.features, levels: planned.levels, grid, caps, range },
    failure: null,
  };
}

/**
 * Read + trace in one call, returning null when nothing could be drawn —
 * callers keep the raster visible in that case
 * (`traceCogContoursDetailed` reports why).
 */
export async function traceCogContours(options: CogContourTraceOptions): Promise<CogContourTrace | null> {
  return (await traceCogContoursDetailed(options)).trace;
}

/**
 * Why no contour lines were drawn, in plain words — null for the outcomes that
 * are not the user's problem to hear about (the view is simply off the file,
 * or the file's metadata has not been parsed yet and a retry is on its way).
 */
export function contourFailureMessage(
  failure: ContourFailure | null | undefined,
  layerName: string,
  detail?: string,
): string | null {
  const name = layerName || 'this layer';
  switch (failure) {
    case 'no-georeference':
      return `Contours: "${name}" carries no geo-referencing, so its elevations cannot be placed on the map.`;
    case 'no-transform':
      return `Contours: no coordinate transform for "${name}"${detail ? ` (${detail})` : ''} — its CRS may not be registered.`;
    case 'too-large':
      return `Contours: "${name}" has no smaller overview for this view${detail ? ` (${detail})` : ''} — zoom in to trace its contours.`;
    case 'read-error':
      return `Contours: could not read elevations from "${name}"${detail ? ` (${detail})` : ''}.`;
    case 'no-values':
      return `Contours: every elevation in view is nodata in "${name}".`;
    case 'bad-extent':
      return 'Contours: the current view could not be measured.';
    case 'source-not-ready':
    case 'no-overlap':
    case null:
    case undefined:
      return null;
    default:
      return `Contours: could not read elevations from "${name}".`;
  }
}

/** Why a trace came out coarser or shorter than asked for, in plain words. */
export function contourCapMessage(caps: ContourCap[] | undefined): string | null {
  if (!caps || caps.length === 0) return null;
  if (caps.includes('vertices')) {
    return 'Too many contour lines for this view — zoom in or increase the interval.';
  }
  if (caps.includes('levels')) {
    return 'The interval is very small for this range, so only every few contours were drawn — increase the interval or zoom in.';
  }
  if (caps.includes('grid')) {
    return 'The terrain was sampled more coarsely than requested to keep tracing fast.';
  }
  return null;
}
