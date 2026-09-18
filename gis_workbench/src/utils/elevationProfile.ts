// ---------------------------------------------------------------------------
// elevationProfile — terrain sampling along a drawn line.
//
// The "Elevation Profile" window (components/ElevationProfilePanel.tsx) lets
// the user pen a polyline over any raster layer whose renderer is a terrain
// one — a COG shown as Hillshade/Contours, or an XYZ tile layer whose RGB
// channels encode elevation — and charts the ground under that line.
//
// The module is deliberately split in two:
//
//   1. PURE maths (grid → points → stats → SVG paths → saved attributes). It
//      knows nothing about where elevations come from: any
//      `{ field, width, height, extent }` grid in EPSG:3857 will do, which is
//      what makes it testable without a network, a tile service or a real
//      GeoTIFF.
//   2. Two thin readers that produce such a grid from the layer the user
//      picked, reusing the machinery the terrain renderers already have:
//      `readTileElevationGrid` (utils/tileElevation.ts) for tile layers and
//      `readCogElevationGridDetailed` (utils/cogContours.ts) for COGs. These
//      are the same reads that draw the contours/hillshade the user is looking
//      at, so a profile always agrees with the terrain on screen — including
//      the tile zoom the map is at and the COG overview that suits the line.
//
// Coordinates are EPSG:3857 throughout (the app's view projection), and every
// distance or elevation shown to the user is a real ground metre measured
// through utils/geodesic — never a planar Mercator unit (AGENTS.md §13).
//
// Framework-agnostic per AGENTS.md §3: plain data in, plain data out.
// ---------------------------------------------------------------------------
import type { RasterLayer, UnitsSystem } from '../types';
import { groundDistance, groundLineLength, mercatorToLonLat, type Pt2 } from './geodesic';
import { formatLength } from './measurement';
import { readTileElevationGrid, type TileElevationGrid } from './tileElevation';
import { readCogElevationGridDetailed, type CogContourGrid, type ContourFailure } from './cogContours';

// --- constants -------------------------------------------------------------

/** Marks the map layer holding the pen-drawn profile lines. */
export const PROFILE_LAYER_PROPERTY = '_isElevationProfileLayer';
/** Feature property carrying the profile record's id. */
export const PROFILE_ID_PROPERTY = '_elevationProfileId';
/** Feature property marking the record the window currently charts. */
export const PROFILE_ACTIVE_PROPERTY = '_elevationProfileActive';
/** Feature property marking the chart-hover marker point. */
export const PROFILE_HOVER_PROPERTY = '_elevationProfileHover';

/** Fewest samples a profile is built from. */
export const PROFILE_MIN_SAMPLES = 16;
/** Most samples one profile may take (keeps the saved attribute sane). */
export const PROFILE_MAX_SAMPLES = 2000;
/** Samples taken when the window does not say otherwise. */
export const PROFILE_DEFAULT_SAMPLES = 240;
/** Fraction of the line's span read on every side of it. */
export const PROFILE_EXTENT_PADDING = 0.2;
/** Even a very short line reads at least this wide a window (ground metres). */
export const PROFILE_MIN_EXTENT_SPAN = 120;
/** Longest grid axis read; a longer line is sampled more coarsely instead. */
export const PROFILE_MAX_GRID_CELLS = 1024;
/** Finest sample spacing allowed, in ground metres. */
const PROFILE_MIN_SPACING = 0.25;
/** Metres per international foot (imperial readouts). */
const METERS_PER_FOOT = 0.3048;

// --- which layers can be profiled ------------------------------------------

export type TerrainRendererKind = 'tile' | 'cog';
export type TerrainRendererMode = 'hillshade' | 'contour';

/** A raster layer's chosen terrain renderer, when it has one. */
export interface TerrainRendererInfo {
  /** Where the elevations come from: tile RGB channels, or a COG's own band. */
  kind: TerrainRendererKind;
  mode: TerrainRendererMode;
  /** The renderer's name in the edit form ("Contours" / "Hillshade"). */
  label: string;
}

const RENDERER_LABELS: Record<TerrainRendererMode, string> = {
  hillshade: 'Hillshade',
  contour: 'Contours',
};

/**
 * The terrain renderer a raster layer is using, or null when it is showing
 * plain imagery. This is the gate for the "Elevation Profile" menu item: a
 * profile needs elevations, and only these two renderers promise the layer
 * actually carries them.
 */
export function terrainRendererOf(layer: RasterLayer | null | undefined): TerrainRendererInfo | null {
  if (!layer) return null;
  if (layer.type === 'cog') {
    const mode = layer.cogRender?.mode;
    if (mode === 'hillshade' || mode === 'contour') {
      return { kind: 'cog', mode, label: RENDERER_LABELS[mode] };
    }
    return null;
  }
  const mode = layer.tileRender?.mode;
  if (mode === 'hillshade' || mode === 'contour') {
    return { kind: 'tile', mode, label: RENDERER_LABELS[mode] };
  }
  return null;
}

/** True when the layer's renderer is a terrain one (hillshade or contours). */
export function hasTerrainRenderer(layer: RasterLayer | null | undefined): boolean {
  return terrainRendererOf(layer) !== null;
}

/**
 * The tile source a terrain tile layer really reads from.
 *
 * Contour mode leaves the plain TileLayer alone, but hillshade mode rebuilds
 * the layer over an `ol/source/Raster` wrapper (the shading runs as an image
 * operation), so `getSource()` there no longer answers `getTileGrid()`.
 * `createTileHillshadeLayer` stashes the source it wrapped on the layer it
 * returns; the guarded walk over a wrapper's inner layers is a fallback so any
 * other wrapper degrades with a message instead of a silent empty profile.
 */
export function terrainTileSource(olLayer: any): any | null {
  if (!olLayer) return null;
  const stashed = olLayer._terrainTileSource;
  if (stashed && typeof stashed.getTileGrid === 'function') return stashed;
  const source = typeof olLayer.getSource === 'function' ? olLayer.getSource() : null;
  if (!source) return stashed ?? null;
  if (typeof source.getTileGrid === 'function') return source;
  try {
    // ol/source/Raster keeps the sources it wraps as private inner layers.
    const inner = (source as any).layers_;
    if (Array.isArray(inner)) {
      for (const layer of inner) {
        const innerSource = typeof layer?.getSource === 'function' ? layer.getSource() : null;
        if (innerSource && typeof innerSource.getTileGrid === 'function') return innerSource;
      }
    }
  } catch {
    /* untyped internals — fall through to the refusal below */
  }
  return stashed ?? null;
}

/**
 * True when a tile source can produce tile URLs the elevation reader can
 * fetch. XYZ templates (`{z}/{x}/{y}`, `{-y}`, `{q}`) can; a WMS GetMap
 * endpoint or a WMTS KVP/RESTful template cannot, and refusing up front beats
 * fetching a handful of URLs that were never a tile.
 */
export function sourceHasTileTemplate(source: any): boolean {
  if (!source) return false;
  if (typeof source.getTileUrlForCoord === 'function') return true;
  let template: unknown = null;
  try {
    const urls = typeof source.getUrls === 'function' ? source.getUrls() : null;
    template = Array.isArray(urls) ? urls[0] : (typeof source.getUrl === 'function' ? source.getUrl() : urls);
  } catch {
    return false;
  }
  if (typeof template !== 'string') return false;
  return /\{(?:z|x|y|-y|q)\}/.test(template);
}

// --- grids -----------------------------------------------------------------

/** The part of a grid the sampler needs (both readers provide it). */
export interface ProfileGridLike {
  field: ArrayLike<number>;
  width: number;
  height: number;
  /** Area covered in EPSG:3857: [minx, miny, maxx, maxy]. Row 0 is the top. */
  extent: number[];
}

/** An elevation grid a profile is sampled from, with its provenance. */
export interface ProfileGrid extends ProfileGridLike {
  /** Approximate GROUND size of one cell, in metres. */
  cellSize: number;
  /** Which reader produced it — for the status line and the failure text. */
  kind: TerrainRendererKind;
  /** Extra provenance for the status line ("tiles z12", "band 1"). */
  detail?: string;
}

/**
 * Ground size of one grid cell in metres. The planar (Mercator) cell size is
 * scaled by cos(latitude) so the number agrees with the distances measured
 * along the line rather than with the projection's inflated metres.
 */
export function gridCellSize(grid: ProfileGridLike): number {
  const spanX = grid.extent[2] - grid.extent[0];
  const spanY = grid.extent[3] - grid.extent[1];
  if (!(spanX > 0) || !(spanY > 0) || grid.width < 1 || grid.height < 1) return 0;
  const planar = Math.max(spanX / grid.width, spanY / grid.height);
  const midLat = mercatorToLonLat([
    (grid.extent[0] + grid.extent[2]) / 2,
    (grid.extent[1] + grid.extent[3]) / 2,
  ])[1];
  const k = Math.cos((midLat * Math.PI) / 180);
  return planar * (Number.isFinite(k) && k > 0 ? k : 1);
}

function tileGridToProfileGrid(grid: TileElevationGrid, detail?: string): ProfileGrid {
  return {
    field: grid.field,
    width: grid.width,
    height: grid.height,
    extent: grid.extent.slice(),
    cellSize: gridCellSize(grid),
    kind: 'tile',
    detail,
  };
}

function cogGridToProfileGrid(grid: CogContourGrid, detail?: string): ProfileGrid {
  return {
    field: grid.field,
    width: grid.width,
    height: grid.height,
    // The COG reader reports the covered area in the *view* projection, which
    // is EPSG:3857 for every read this module asks for.
    extent: grid.extent.slice(),
    cellSize: gridCellSize(grid),
    kind: 'cog',
    detail,
  };
}

// --- the sampling plan -----------------------------------------------------

/** What to read, and how finely, before a line can be sampled. */
export interface ProfileSamplePlan {
  /** Padded EPSG:3857 extent the grid is read over. */
  extent: number[];
  gridWidth: number;
  gridHeight: number;
  /** Sample points along the line. */
  samples: number;
  /** Target GROUND metres per grid cell. */
  cellSize: number;
  /** Ground length of the line, in metres. */
  length: number;
}

function clampInt(value: number, low: number, high: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : fallback;
}

function finiteCoords(coords: Pt2[] | number[][] | null | undefined): Pt2[] {
  if (!Array.isArray(coords)) return [];
  const out: Pt2[] = [];
  for (const c of coords) {
    if (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      out.push([c[0], c[1]]);
    }
  }
  return out;
}

/** Cosine of the latitude at the centre of an EPSG:3857 extent. */
function mercatorCosLat(extent: number[]): number {
  const lat = mercatorToLonLat([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2])[1];
  const k = Math.cos((lat * Math.PI) / 180);
  return Number.isFinite(k) && k > 0.05 ? k : 0.05;
}

/**
 * Plan a line's elevation read: the window to fetch, how finely to fetch it,
 * and how many points to sample along the line.
 *
 * The grid is aimed at one cell per sample interval so the chart is neither
 * reading a DEM ten times finer than it draws nor inventing detail the source
 * does not have. Returns null when the line cannot be profiled (fewer than two
 * usable vertices).
 */
export function planProfileSampling(
  coords: Pt2[] | number[][],
  options?: { samples?: number; paddingRatio?: number; minSpan?: number },
): ProfileSamplePlan | null {
  const clean = finiteCoords(coords);
  if (clean.length < 2) return null;

  const length = groundLineLength(clean);
  const requested = clampInt(
    options?.samples ?? PROFILE_DEFAULT_SAMPLES,
    PROFILE_MIN_SAMPLES,
    PROFILE_MAX_SAMPLES,
    PROFILE_DEFAULT_SAMPLES,
  );
  // A line shorter than the requested spacing gets fewer samples rather than
  // 240 copies of the same pixel.
  const bySpacing = length > 0 ? Math.max(2, Math.ceil(length / PROFILE_MIN_SPACING)) : 2;
  const samples = Math.max(2, Math.min(requested, bySpacing));

  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const c of clean) {
    if (c[0] < minx) minx = c[0];
    if (c[0] > maxx) maxx = c[0];
    if (c[1] < miny) miny = c[1];
    if (c[1] > maxy) maxy = c[1];
  }

  const paddingRatio = Number.isFinite(options?.paddingRatio as number)
    ? Math.max(0, options!.paddingRatio as number)
    : PROFILE_EXTENT_PADDING;
  const minSpan = Number.isFinite(options?.minSpan as number)
    ? Math.max(0, options!.minSpan as number)
    : PROFILE_MIN_EXTENT_SPAN;

  // Ground metres per cell, then the same size in planar Mercator units (which
  // is what the extent below is measured in).
  const cellSize = length > 0 ? Math.max(0.5, length / Math.max(1, samples - 1)) : 1;
  const centre = [(minx + maxx) / 2, (miny + maxy) / 2];
  const probeExtent = [centre[0] - 1, centre[1] - 1, centre[0] + 1, centre[1] + 1];
  const planarCell = cellSize / mercatorCosLat(probeExtent);

  const longest = Math.max(maxx - minx, maxy - miny);
  const pad = Math.max(longest * paddingRatio, minSpan / 2, planarCell * 2);
  const floorSpan = Math.max(minSpan, planarCell * 4) / mercatorCosLat(probeExtent);
  const spanX = Math.max(maxx - minx + 2 * pad, floorSpan);
  const spanY = Math.max(maxy - miny + 2 * pad, floorSpan);

  const gridWidth = clampInt(spanX / planarCell, 2, PROFILE_MAX_GRID_CELLS, 2);
  const gridHeight = clampInt(spanY / planarCell, 2, PROFILE_MAX_GRID_CELLS, 2);

  return {
    extent: [centre[0] - spanX / 2, centre[1] - spanY / 2, centre[0] + spanX / 2, centre[1] + spanY / 2],
    gridWidth,
    gridHeight,
    samples,
    cellSize,
    length,
  };
}

// --- sampling the grid -----------------------------------------------------

/**
 * Bilinear elevation at an EPSG:3857 position, NaN outside the grid.
 *
 * Nodata neighbours are skipped and the remaining weights renormalised, so a
 * single nodata pixel narrows the interpolation instead of punching a hole in
 * an otherwise sound profile.
 */
export function sampleGridBilinear(grid: ProfileGridLike, x: number, y: number): number {
  const { width: w, height: h, extent } = grid;
  if (!grid.field || w < 1 || h < 1 || !Array.isArray(extent) || extent.length !== 4) return NaN;
  const spanX = extent[2] - extent[0];
  const spanY = extent[3] - extent[1];
  if (!(spanX > 0) || !(spanY > 0)) return NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
  if (x < extent[0] || x > extent[2] || y < extent[1] || y > extent[3]) return NaN;

  // Cell centres sit at (i + 0.5) / n, hence the half-cell shift.
  const fx = Math.min(w - 1, Math.max(0, ((x - extent[0]) / spanX) * w - 0.5));
  const fy = Math.min(h - 1, Math.max(0, ((extent[3] - y) / spanY) * h - 0.5));
  const x0 = Math.min(w - 1, Math.floor(fx));
  const y0 = Math.min(h - 1, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;

  let sum = 0;
  let weight = 0;
  for (let dy = 0; dy <= 1; dy++) {
    const yi = Math.min(h - 1, Math.max(0, y0 + dy));
    const wy = dy === 0 ? 1 - ty : ty;
    for (let dx = 0; dx <= 1; dx++) {
      const xi = Math.min(w - 1, Math.max(0, x0 + dx));
      const wx = dx === 0 ? 1 - tx : tx;
      const wgt = wx * wy;
      if (!(wgt > 0)) continue;
      const value = Number(grid.field[yi * w + xi]);
      if (!Number.isFinite(value)) continue;
      sum += value * wgt;
      weight += wgt;
    }
  }
  return weight > 0 ? sum / weight : NaN;
}

/**
 * Split a polyline into `samples` points spaced evenly along the GROUND (not
 * along the Mercator plane), interpolating within each segment. The first and
 * last input vertices are preserved exactly, so a profile always starts and
 * ends where the user drew it.
 */
export function densifyByDistance(coords: Pt2[] | number[][], samples: number): Pt2[] {
  const clean = finiteCoords(coords);
  if (clean.length < 2) return clean.slice();
  const count = Math.max(2, Math.round(Number.isFinite(samples) ? samples : PROFILE_DEFAULT_SAMPLES));

  const segLengths: number[] = [];
  let total = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const d = groundDistance(clean[i], clean[i + 1]);
    segLengths.push(d > 0 ? d : 0);
    total += d > 0 ? d : 0;
  }
  if (!(total > 0)) return [clean[0], clean[clean.length - 1]];

  const out: Pt2[] = [];
  const step = total / (count - 1);
  let seg = 0;
  let segStart = 0;
  for (let i = 0; i < count; i++) {
    const target = i === count - 1 ? total : i * step;
    while (seg < segLengths.length - 1 && segStart + segLengths[seg] < target) {
      segStart += segLengths[seg];
      seg++;
    }
    const segLen = segLengths[seg];
    const t = segLen > 0 ? Math.min(1, Math.max(0, (target - segStart) / segLen)) : 0;
    const a = clean[seg];
    const b = clean[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** One chart data point: where along the line, how high, and where on Earth. */
export interface ProfilePoint {
  /** Cumulative GROUND distance from the line's start, in metres. */
  distance: number;
  /** Elevation in metres; NaN where the source had no data. */
  elevation: number;
  /** EPSG:3857 position. */
  x: number;
  y: number;
  /** WGS84 position (what the saved attribute and the tooltip show). */
  lon: number;
  lat: number;
}

/**
 * Sample a grid along a line: densify to `samples` evenly spaced ground
 * positions, then read the elevation under each one.
 */
export function buildProfilePoints(
  coords: Pt2[] | number[][],
  grid: ProfileGridLike,
  options?: { samples?: number },
): ProfilePoint[] {
  const clean = finiteCoords(coords);
  if (clean.length < 2) return [];
  const densified = densifyByDistance(clean, options?.samples ?? PROFILE_DEFAULT_SAMPLES);
  const points: ProfilePoint[] = [];
  let distance = 0;
  for (let i = 0; i < densified.length; i++) {
    const c = densified[i];
    if (i > 0) distance += groundDistance(densified[i - 1], c);
    const [lon, lat] = mercatorToLonLat(c);
    points.push({
      distance,
      elevation: sampleGridBilinear(grid, c[0], c[1]),
      x: c[0],
      y: c[1],
      lon,
      lat,
    });
  }
  return points;
}

// --- statistics ------------------------------------------------------------

/** What the window's readout row shows about one profile. */
export interface ProfileStats {
  /** Samples with a real elevation. */
  sampleCount: number;
  /** Samples the source had no data for. */
  missingCount: number;
  /** Ground length of the line, in metres. */
  totalDistance: number;
  minElevation: number;
  maxElevation: number;
  meanElevation: number;
  /** Distance along the line where the minimum / maximum occurs. */
  minAt: number;
  maxAt: number;
  startElevation: number;
  endElevation: number;
  /** Cumulative uphill / downhill, in metres. */
  ascent: number;
  descent: number;
  /** Steepest sample-to-sample gradient, in percent. */
  maxGradePercent: number;
  /** Longest run of missing samples, in metres (0 when the line is complete). */
  longestGap: number;
}

/**
 * Summarise a profile. Returns null when nothing under the line had an
 * elevation at all — the caller then says so instead of charting zeros.
 */
export function profileStats(points: ProfilePoint[]): ProfileStats | null {
  if (!Array.isArray(points) || points.length === 0) return null;

  let count = 0;
  let missing = 0;
  let min = Infinity;
  let max = -Infinity;
  let minAt = 0;
  let maxAt = 0;
  let sum = 0;
  let ascent = 0;
  let descent = 0;
  let maxGrade = 0;
  let first: ProfilePoint | null = null;
  let last: ProfilePoint | null = null;
  let gapStart: number | null = null;
  let longestGap = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const elev = Number(p.elevation);
    if (!Number.isFinite(elev)) {
      missing++;
      if (gapStart === null) gapStart = i > 0 ? points[i - 1].distance : 0;
      continue;
    }
    if (gapStart !== null) {
      longestGap = Math.max(longestGap, p.distance - gapStart);
      gapStart = null;
    }
    if (!first) first = p;
    last = p;
    count++;
    sum += elev;
    if (elev < min) { min = elev; minAt = p.distance; }
    if (elev > max) { max = elev; maxAt = p.distance; }
    if (count > 1) {
      const prev = previousFinite(points, i);
      if (prev) {
        const dz = elev - prev.elevation;
        const dd = p.distance - prev.distance;
        if (dz > 0) ascent += dz;
        else if (dz < 0) descent -= dz;
        if (dd > 0) maxGrade = Math.max(maxGrade, Math.abs(dz / dd) * 100);
      }
    }
  }
  if (gapStart !== null) {
    longestGap = Math.max(longestGap, points[points.length - 1].distance - gapStart);
  }
  if (count === 0 || !first || !last) return null;

  return {
    sampleCount: count,
    missingCount: missing,
    totalDistance: points[points.length - 1].distance,
    minElevation: min,
    maxElevation: max,
    meanElevation: sum / count,
    minAt,
    maxAt,
    startElevation: first.elevation,
    endElevation: last.elevation,
    ascent,
    descent,
    maxGradePercent: maxGrade,
    longestGap,
  };
}

/** The nearest sample before index i that has a real elevation. */
function previousFinite(points: ProfilePoint[], i: number): ProfilePoint | null {
  for (let j = i - 1; j >= 0; j--) {
    if (Number.isFinite(points[j].elevation)) return points[j];
  }
  return null;
}

/**
 * The profile point at (or nearest to) a distance along the line — what the
 * chart's crosshair and the map's hover marker both snap to, so the two always
 * agree on an actual sample.
 */
export function profilePointAtDistance(points: ProfilePoint[], distance: number): ProfilePoint | null {
  if (!Array.isArray(points) || points.length === 0 || !Number.isFinite(distance)) return null;
  let best = points[0];
  let bestDelta = Math.abs(points[0].distance - distance);
  for (let i = 1; i < points.length; i++) {
    const delta = Math.abs(points[i].distance - distance);
    if (delta < bestDelta) {
      best = points[i];
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Position a fraction of the way along a line, in the line's own coordinates.
 * Used to place the hover marker on the map (view-projection coordinates, so
 * the caller passes the feature's own geometry coordinates).
 */
export function coordinateAtDistance(coords: Pt2[] | number[][], distance: number): Pt2 | null {
  const clean = finiteCoords(coords);
  if (clean.length === 0) return null;
  if (clean.length === 1 || !(distance > 0)) return clean[0];
  let walked = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const segLen = groundDistance(clean[i], clean[i + 1]);
    if (walked + segLen >= distance) {
      const t = segLen > 0 ? (distance - walked) / segLen : 0;
      const a = clean[i];
      const b = clean[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += segLen;
  }
  return clean[clean.length - 1];
}

// --- the chart -------------------------------------------------------------

/** "Nice" axis values (1/2/2.5/5 × 10ⁿ) covering [min, max]. */
export function niceAxisTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    return Number.isFinite(min) ? [min] : [];
  }
  const wanted = Math.max(2, Math.round(count));
  const rawStep = (max - min) / (wanted - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const startIndex = Math.ceil(min / step - 1e-9);
  const endIndex = Math.floor(max / step + 1e-9);
  const ticks: number[] = [];
  for (let i = startIndex; i <= endIndex && ticks.length < 64; i++) {
    ticks.push(Number((i * step).toPrecision(12)));
  }
  return ticks;
}

export interface ProfileChartOptions {
  width: number;
  height: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** Extend the elevation axis down to zero instead of the line's own range. */
  zeroBaseline?: boolean;
  /** Head/foot room on the elevation axis, as a fraction of its range. */
  yPadRatio?: number;
  xTickCount?: number;
  yTickCount?: number;
  /** Axis label formatters (supplied by the window, so units stay its choice). */
  labelDistance?: (metres: number) => string;
  labelElevation?: (metres: number) => string;
}

export interface ProfileChartTick {
  value: number;
  /** Pixel position along the axis (x for distance, y for elevation). */
  at: number;
  label: string;
}

/** Everything the window needs to draw the chart, and to hit-test it. */
export interface ProfileChart {
  width: number;
  height: number;
  /** The plotting rectangle inside the padding. */
  plot: { x: number; y: number; w: number; h: number };
  minDistance: number;
  maxDistance: number;
  minElevation: number;
  maxElevation: number;
  /** One SVG path per unbroken run of samples — nodata gaps split the line. */
  segments: string[];
  /** The same runs closed down to the baseline, for the area fill. */
  areas: string[];
  xTicks: ProfileChartTick[];
  yTicks: ProfileChartTick[];
  /** Vertical exaggeration of the drawing (1 would be true scale). */
  exaggeration: number;
  xFor(distance: number): number;
  yFor(elevation: number): number;
  distanceAtX(px: number): number;
  elevationAtY(px: number): number;
}

/**
 * Build the SVG geometry of a profile chart. Pure: the window renders the
 * returned paths and ticks, and uses `distanceAtX` to turn a pointer position
 * into the crosshair reading.
 */
export function buildProfileChart(
  points: ProfilePoint[],
  options: ProfileChartOptions,
): ProfileChart | null {
  const list = Array.isArray(points) ? points.filter(p => p && Number.isFinite(p.distance)) : [];
  if (list.length < 2) return null;
  const width = Number(options.width);
  const height = Number(options.height);
  if (!(width > 0) || !(height > 0)) return null;

  const padTop = options.paddingTop ?? 12;
  const padRight = options.paddingRight ?? 12;
  const padBottom = options.paddingBottom ?? 26;
  const padLeft = options.paddingLeft ?? 52;
  const plot = {
    x: Math.min(padLeft, width - 1),
    y: Math.min(padTop, height - 1),
    w: Math.max(1, width - padLeft - padRight),
    h: Math.max(1, height - padTop - padBottom),
  };

  const maxDistance = Math.max(list[list.length - 1].distance, 0);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of list) {
    if (!Number.isFinite(p.elevation)) continue;
    if (p.elevation < lo) lo = p.elevation;
    if (p.elevation > hi) hi = p.elevation;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (options.zeroBaseline) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const span = hi - lo;
  const pad = span > 0 ? span * (options.yPadRatio ?? 0.08) : Math.max(1, Math.abs(hi) * 0.1 || 1);
  const minElevation = lo - pad;
  const maxElevation = hi + pad;

  const distSpan = maxDistance > 0 ? maxDistance : 1;
  const elevSpan = maxElevation - minElevation || 1;
  const xFor = (distance: number) => plot.x + (Math.min(Math.max(distance, 0), distSpan) / distSpan) * plot.w;
  const yFor = (elevation: number) =>
    plot.y + (1 - (Math.min(Math.max(elevation, minElevation), maxElevation) - minElevation) / elevSpan) * plot.h;
  const distanceAtX = (px: number) =>
    Math.min(Math.max(((px - plot.x) / plot.w) * distSpan, 0), distSpan);
  const elevationAtY = (px: number) =>
    minElevation + (1 - (px - plot.y) / plot.h) * elevSpan;

  // One path per unbroken run: a nodata gap is drawn as a gap, never as a
  // plunge to zero (which would invent a cliff the source knows nothing about).
  const segments: string[] = [];
  const areas: string[] = [];
  const baseline = plot.y + plot.h;
  let run: string[] = [];
  let runStartX = 0;
  let runEndX = 0;
  const flush = () => {
    if (run.length === 0) return;
    // run[0] is "M x,y" and every later entry is already "L x,y".
    const line = run.join(' ');
    segments.push(line);
    areas.push(
      `M ${fmt(runStartX)},${fmt(baseline)} L ${line.slice(2)} L ${fmt(runEndX)},${fmt(baseline)} Z`,
    );
    run = [];
  };
  for (const p of list) {
    if (!Number.isFinite(p.elevation)) {
      flush();
      continue;
    }
    const x = xFor(p.distance);
    const y = yFor(p.elevation);
    if (run.length === 0) {
      runStartX = x;
      run.push(`M ${fmt(x)},${fmt(y)}`);
    } else {
      run.push(`L ${fmt(x)},${fmt(y)}`);
    }
    runEndX = x;
  }
  flush();

  const labelDistance = options.labelDistance ?? ((m: number) => `${Math.round(m)} m`);
  const labelElevation = options.labelElevation ?? ((m: number) => `${Math.round(m)} m`);
  const xTicks = niceAxisTicks(0, distSpan, options.xTickCount ?? 5).map(value => ({
    value,
    at: xFor(value),
    label: labelDistance(value),
  }));
  const yTicks = niceAxisTicks(minElevation, maxElevation, options.yTickCount ?? 5).map(value => ({
    value,
    at: yFor(value),
    label: labelElevation(value),
  }));

  // Vertical exaggeration: how many times steeper the drawing is than the ground.
  const metresPerPixelY = elevSpan / plot.h;
  const metresPerPixelX = distSpan / plot.w;
  const exaggeration = metresPerPixelX > 0 ? metresPerPixelY > 0 ? metresPerPixelX / metresPerPixelY : Infinity : 0;

  return {
    width,
    height,
    plot,
    minDistance: 0,
    maxDistance: distSpan,
    minElevation,
    maxElevation,
    segments,
    areas,
    xTicks,
    yTicks,
    exaggeration,
    xFor,
    yFor,
    distanceAtX,
    elevationAtY,
  };
}

/** Two-decimal SVG coordinate, without trailing zeros. */
function fmt(value: number): string {
  return Number(value.toFixed(2)).toString();
}

// --- formatting ------------------------------------------------------------

/** Elevation readout: metres, or feet when the app is in imperial units. */
export function formatProfileElevation(metres: number, units: UnitsSystem = 'metric'): string {
  if (!Number.isFinite(metres)) return '—';
  const opts: Intl.NumberFormatOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (units === 'imperial') {
    return `${(metres / METERS_PER_FOOT).toLocaleString('en-AU', opts)} ft`;
  }
  return `${metres.toLocaleString('en-AU', opts)} m`;
}

/** Distance readout — the same m/km (ft/mi) rule the map's labels use. */
export function formatProfileDistance(metres: number, units: UnitsSystem = 'metric'): string {
  if (!Number.isFinite(metres)) return '—';
  return formatLength(metres, units);
}

/**
 * Compact axis label: distances need to fit in ~40 px, so the tick drops to
 * whole units and switches to km/mi earlier than the readout does.
 */
export function formatProfileDistanceTick(metres: number, units: UnitsSystem = 'metric'): string {
  if (!Number.isFinite(metres)) return '';
  if (units === 'imperial') {
    if (metres >= METERS_PER_FOOT * 5280) return `${trim(metres / (METERS_PER_FOOT * 5280))} mi`;
    return `${trim(metres / METERS_PER_FOOT)} ft`;
  }
  if (metres >= 1000) return `${trim(metres / 1000)} km`;
  return `${trim(metres)} m`;
}

/** Elevation axis label: whole units, with the unit on every tick. */
export function formatProfileElevationTick(metres: number, units: UnitsSystem = 'metric'): string {
  if (!Number.isFinite(metres)) return '';
  if (units === 'imperial') return `${trim(metres / METERS_PER_FOOT)} ft`;
  return `${trim(metres)} m`;
}

/** A gradient in percent, signed by the caller's convention. */
export function formatProfileGrade(percent: number): string {
  if (!Number.isFinite(percent)) return '—';
  return `${percent.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// --- what a saved profile line carries -------------------------------------

/**
 * Attribute field names written onto a saved profile line. The points array is
 * the chart's own data, so the attribute table shows exactly what was drawn
 * (and a re-plot from the attribute alone needs nothing else).
 */
export const PROFILE_FIELDS = {
  name: 'profile_name',
  source: 'profile_source_layer',
  renderer: 'profile_renderer',
  length: 'profile_length_m',
  samples: 'profile_samples',
  minElevation: 'profile_min_elev_m',
  maxElevation: 'profile_max_elev_m',
  ascent: 'profile_ascent_m',
  descent: 'profile_descent_m',
  maxGrade: 'profile_max_grade_pct',
  points: 'profile_points',
} as const;

/** One saved sample: distance along the line, elevation, and where it is. */
export interface ProfilePointRecord {
  distance: number;
  elevation: number | null;
  lon: number;
  lat: number;
}

function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/** The chart's data points, rounded for storage (nodata stays null). */
export function profilePointRecords(points: ProfilePoint[]): ProfilePointRecord[] {
  return (points ?? []).map(p => ({
    distance: round(p.distance, 2),
    elevation: Number.isFinite(p.elevation) ? round(p.elevation, 3) : null,
    lon: round(p.lon, 6),
    lat: round(p.lat, 6),
  }));
}

export interface ProfileAttributeInput {
  name: string;
  /** Name of the raster layer the elevations were read from. */
  sourceLayer: string;
  /** Terrain renderer used ("Contours" / "Hillshade"). */
  renderer: string;
  stats: ProfileStats;
  points: ProfilePoint[];
}

/**
 * The attribute record written onto a saved profile line: the summary numbers
 * as their own fields (so they sort and filter in the attribute table) plus
 * every data point behind the chart in `profile_points`.
 */
export function profileFeatureAttributes(input: ProfileAttributeInput): Record<string, any> {
  const { stats } = input;
  return {
    [PROFILE_FIELDS.name]: input.name,
    [PROFILE_FIELDS.source]: input.sourceLayer,
    [PROFILE_FIELDS.renderer]: input.renderer,
    [PROFILE_FIELDS.length]: round(stats.totalDistance, 2),
    [PROFILE_FIELDS.samples]: stats.sampleCount,
    [PROFILE_FIELDS.minElevation]: round(stats.minElevation, 3),
    [PROFILE_FIELDS.maxElevation]: round(stats.maxElevation, 3),
    [PROFILE_FIELDS.ascent]: round(stats.ascent, 3),
    [PROFILE_FIELDS.descent]: round(stats.descent, 3),
    [PROFILE_FIELDS.maxGrade]: round(stats.maxGradePercent, 2),
    [PROFILE_FIELDS.points]: profilePointRecords(input.points),
  };
}

/**
 * A saved profile line as GeoJSON in EPSG:3857 — the shape MapPage's
 * add-result-layer path expects (ordinates rounded to millimetres, which keeps
 * a 240-point line's attribute string from dwarfing its geometry).
 */
export function profileLineGeoJson(coords: Pt2[] | number[][], attributes: Record<string, any>): string {
  const clean = finiteCoords(coords);
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: attributes ?? {},
      geometry: {
        type: 'LineString',
        coordinates: clean.map(c => [round(c[0], 3), round(c[1], 3)]),
      },
    }],
  });
}

// --- failures --------------------------------------------------------------

/**
 * Why a profile could not be sampled. The COG reader's own reasons are reused
 * verbatim so a file that refuses to trace contours says the same thing here;
 * the rest are specific to reading along a line.
 */
export type ProfileFailure =
  | 'no-terrain'        // the layer is not using a terrain renderer
  | 'no-source'         // no readable source is on the map for the layer
  | 'no-tile-template'  // the source's tiles are not an XYZ-style URL template
  | 'no-tiles'          // the tile read produced nothing (CORS, offline, …)
  | 'bad-line'          // fewer than two usable vertices
  | 'cancelled'         // superseded by a newer read (never shown)
  | ContourFailure;

/** The failure in plain words, or null when there is nothing to tell the user. */
export function profileFailureMessage(
  failure: ProfileFailure | null | undefined,
  layerName?: string,
  detail?: string,
): string | null {
  const name = layerName && layerName.trim() ? layerName.trim() : 'this layer';
  switch (failure) {
    case 'no-terrain':
      return `"${name}" is not using a terrain renderer. Choose Hillshade or Contours in its edit form, then draw the line again.`;
    case 'no-source':
      return `Could not read terrain data from "${name}" — the layer is not on the map yet.`;
    case 'no-tile-template':
      return `"${name}" does not serve tiles from an XYZ-style URL template, so its elevations cannot be read here. Profile an XYZ terrain-tile layer or a COG DEM instead.`;
    case 'no-tiles':
      return `No terrain tiles could be read for "${name}"${detail ? ` (${detail})` : ''}. The service may block cross-origin reads, or its tiles may not encode elevation.`;
    case 'bad-line':
      return 'Draw a line with at least two vertices.';
    case 'source-not-ready':
      return `"${name}" is still loading — try the line again in a moment.`;
    case 'bad-extent':
      return 'The line could not be measured.';
    case 'no-georeference':
      return `"${name}" carries no geo-referencing, so its elevations cannot be placed on the map.`;
    case 'no-transform':
      return `No coordinate transform for "${name}"${detail ? ` (${detail})` : ''} — its CRS may not be registered.`;
    case 'no-overlap':
      return `The line is outside the area "${name}" covers.`;
    case 'too-large':
      return `"${name}" has no smaller overview for a line this long${detail ? ` (${detail})` : ''}. Zoom in, or draw a shorter line.`;
    case 'read-error':
      return `Could not read elevations from "${name}"${detail ? ` (${detail})` : ''}.`;
    case 'no-values':
      return `Every elevation under the line is nodata in "${name}".`;
    case 'cancelled':
    case null:
    case undefined:
      return null;
    default:
      return `Could not read elevations from "${name}".`;
  }
}

// --- reading the grid ------------------------------------------------------

/** One grid read: the grid, or the reason there is none. */
interface GridAttempt {
  grid: ProfileGrid | null;
  failure: ProfileFailure | null;
  detail?: string;
}

async function readTileProfileGrid(
  layer: RasterLayer,
  plan: ProfileSamplePlan,
  zoom: number | undefined,
  signal: AbortSignal | undefined,
): Promise<GridAttempt> {
  const source = terrainTileSource(layer.olLayer);
  if (!source || typeof source.getTileGrid !== 'function') {
    return { grid: null, failure: 'no-source' };
  }
  if (!sourceHasTileTemplate(source)) {
    return { grid: null, failure: 'no-tile-template' };
  }
  const tileGrid = source.getTileGrid();
  if (!tileGrid) return { grid: null, failure: 'no-source', detail: 'no tile grid' };
  const render = layer.tileRender;
  if (!render) return { grid: null, failure: 'no-terrain' };

  const grid = await readTileElevationGrid({
    source,
    tileGrid,
    viewExtent: plan.extent,
    viewProjection: 'EPSG:3857',
    viewport: { width: plan.gridWidth, height: plan.gridHeight },
    encoding: render.encoding,
    grayscaleRange: render.grayscaleRange,
    downscale: 1,
    ...(zoom !== undefined && Number.isFinite(zoom) ? { zoom } : {}),
  }, signal);
  if (!grid) return { grid: null, failure: 'no-tiles' };
  const usedZoom = zoom !== undefined && Number.isFinite(zoom) ? Math.round(zoom) : undefined;
  return {
    grid: tileGridToProfileGrid(grid, usedZoom !== undefined ? `tiles z${usedZoom}` : 'tiles'),
    failure: null,
  };
}

async function readCogProfileGrid(
  layer: RasterLayer,
  plan: ProfileSamplePlan,
  signal: AbortSignal | undefined,
): Promise<GridAttempt> {
  const source = typeof layer.olLayer?.getSource === 'function' ? layer.olLayer.getSource() : null;
  if (!source) return { grid: null, failure: 'no-source' };
  const band = Number(layer.cogRender?.band) >= 1 ? Number(layer.cogRender?.band) : 1;
  // The contour renderer's QGIS "input downscaling"/oversampling exist to make
  // traced lines look right; a profile wants the grid it planned, so both are 1.
  const attempt = await readCogElevationGridDetailed(
    source,
    plan.extent,
    'EPSG:3857',
    { width: plan.gridWidth, height: plan.gridHeight },
    band,
    1,
    1,
  );
  // geotiff.js reads are not cancellable, so the abort is honoured as soon as
  // the read lands: a superseded profile is dropped rather than drawn.
  if (signal?.aborted) return { grid: null, failure: 'cancelled' };
  if (!attempt.grid) return { grid: null, failure: attempt.failure ?? 'read-error', detail: attempt.detail };
  return { grid: cogGridToProfileGrid(attempt.grid, `band ${band}`), failure: null };
}

export interface ProfileSampleOptions {
  /** The raster layer being profiled (its config carries the renderer + olLayer). */
  layer: RasterLayer;
  /** The line, in EPSG:3857. */
  coords: Pt2[] | number[][];
  /** Requested sample count (clamped to the profile limits). */
  samples?: number;
  /** Current map zoom — picks the tile level, the way the contours do. */
  zoom?: number;
  signal?: AbortSignal;
}

export interface ProfileSampleResult {
  points: ProfilePoint[];
  stats: ProfileStats | null;
  grid: ProfileGrid | null;
  plan: ProfileSamplePlan | null;
  failure: ProfileFailure | null;
  detail?: string;
}

/**
 * Sample the terrain under a line: plan the read, fetch the grid from the
 * layer's own reader, build the profile points and summarise them. Never
 * throws — a refusal comes back as `failure` + `detail` for the window to say
 * in plain words.
 */
export async function sampleElevationProfile(options: ProfileSampleOptions): Promise<ProfileSampleResult> {
  const { layer, coords, samples, zoom, signal } = options;
  const refused = (
    failure: ProfileFailure,
    plan: ProfileSamplePlan | null = null,
    detail?: string,
  ): ProfileSampleResult => ({ points: [], stats: null, grid: null, plan, failure, detail });

  if (signal?.aborted) return refused('cancelled');
  if (!terrainRendererOf(layer)) return refused('no-terrain');
  const plan = planProfileSampling(coords, { samples });
  if (!plan) return refused('bad-line');

  const attempt = terrainRendererOf(layer)!.kind === 'cog'
    ? await readCogProfileGrid(layer, plan, signal)
    : await readTileProfileGrid(layer, plan, zoom, signal);
  if (signal?.aborted) return refused('cancelled', plan);
  if (!attempt.grid) return refused(attempt.failure ?? 'read-error', plan, attempt.detail);

  const points = buildProfilePoints(coords, attempt.grid, { samples: plan.samples });
  const stats = profileStats(points);
  if (!stats) return { ...refused('no-values', plan), points, grid: attempt.grid };
  return { points, stats, grid: attempt.grid, plan, failure: null };
}

// --- the window's geometry (desktop-OS behaviour) --------------------------

/** Storage key — the `mapviewer` prefix keeps it inside the app-lock vault. */
export const ELEV_PROFILE_GEOMETRY_KEY = 'mapviewer-elev-profile-geometry';

/** Desktop-window geometry of the profile panel (px, map-container relative). */
export interface ElevProfileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ELEV_PROFILE_MIN_W = 460;
export const ELEV_PROFILE_MIN_H = 300;
export const ELEV_PROFILE_DEFAULT_RECT: ElevProfileRect = { x: 72, y: 64, w: 640, h: 430 };

/** Keep the window inside its container and at least its minimum size. */
export function clampElevProfileRect(rect: ElevProfileRect, containerW: number, containerH: number): ElevProfileRect {
  const w = Math.max(ELEV_PROFILE_MIN_W, Math.min(rect.w, Math.max(containerW, ELEV_PROFILE_MIN_W)));
  const h = Math.max(ELEV_PROFILE_MIN_H, Math.min(rect.h, Math.max(containerH, ELEV_PROFILE_MIN_H)));
  const x = Math.max(0, Math.min(rect.x, Math.max(0, containerW - w)));
  const y = Math.max(0, Math.min(rect.y, Math.max(0, containerH - h)));
  return { x, y, w, h };
}

/** Load the persisted window geometry; null when absent or invalid. */
export function loadElevProfileGeometry(): ElevProfileRect | null {
  try {
    const raw = localStorage.getItem(ELEV_PROFILE_GEOMETRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || [parsed.x, parsed.y, parsed.w, parsed.h].some((v: any) => typeof v !== 'number' || !isFinite(v))) {
      return null;
    }
    return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
  } catch (e) {
    console.warn('[ElevationProfile] Failed to load window geometry:', e);
    return null;
  }
}

/** Persist the window geometry (called when a move/resize gesture ends). */
export function saveElevProfileGeometry(rect: ElevProfileRect): void {
  try {
    localStorage.setItem(ELEV_PROFILE_GEOMETRY_KEY, JSON.stringify(rect));
  } catch (e) {
    console.warn('[ElevationProfile] Failed to save window geometry:', e);
  }
}
