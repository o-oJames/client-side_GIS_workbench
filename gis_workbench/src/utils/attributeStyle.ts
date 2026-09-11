/**
 * Attribute-driven rendering ("smart mapping") for vector layers.
 *
 * A feature's colour or size is computed from one of its attribute values
 * instead of every feature sharing one fixed layer style. The direction and
 * terminology follow ArcGIS Online's smart mapping styles:
 *   - "Types (Unique Symbols)"  -> one colour per distinct category
 *   - "Counts and Amounts (Color)" -> classed colour ramp over a numeric field
 *   - "Counts and Amounts (Size)"  -> proportional symbol size for a numeric field
 *
 * Pure logic + OpenLayers style construction only — no React imports
 * (AGENTS.md §3). Statistics helpers work on any OL features; the legend
 * builder is a pure function of the persisted config so legends stay stable
 * before/after lazy feature loads.
 */
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style.js';
import { AttributeRenderConfig, AttrClassMethod } from '../types';
import { parseColor, rgbaToString } from './colorHelpers';
import { featureProperties } from './featureFilter';

// --- Colour palettes ---------------------------------------------------------

/** One row of a sequential colour ramp (5 stops, low -> high). */
export interface AttributeRamp {
  id: string;
  name: string;
  colors: string[];
}

/**
 * Sequential colour ramps offered for the classed "Color" mode. The first
 * ramp (Yellow-Red) is the default, matching ArcGIS Online's default
 * Counts-and-Amounts colour ramp.
 */
export const ATTRIBUTE_RAMPS: AttributeRamp[] = [
  { id: 'yl-or-rd', name: 'Yellow – Red', colors: ['#ffffcc', '#fed976', '#fd8d3c', '#e31a1c', '#800026'] },
  { id: 'wh-bl', name: 'White – Blue', colors: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'] },
  { id: 'wh-grn', name: 'White – Green', colors: ['#f7fcf5', '#c7e9c0', '#74c476', '#238b45', '#00441b'] },
  { id: 'or-rd', name: 'Orange – Red', colors: ['#fef0d9', '#fdcc8a', '#fc8d59', '#e34a33', '#b30006'] },
  { id: 'rd-pu', name: 'Red – Purple', colors: ['#feebe2', '#fbb4b9', '#f768a1', '#c51b8a', '#7a0177'] },
  { id: 'rd-bu-div', name: 'Red – Blue (diverging)', colors: ['#ca0020', '#f4a582', '#f7f7f7', '#92c5de', '#0571b0'] },
];

export const DEFAULT_RAMP_ID = ATTRIBUTE_RAMPS[0].id;

/** Distinct colours assigned to categories ("Types" mode), in priority order. */
export const ATTRIBUTE_CATEGORY_COLORS = [
  '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628',
  '#f781bf', '#999999', '#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3',
];

/** Neutral colour for features with no usable value (or categories past the palette). */
export const ATTRIBUTE_NO_DATA_COLOR = '#a0a7b0';

/** Max categories that get their own colour; the rest collapse into "Other". */
export const MAX_CATEGORY_COLORS = ATTRIBUTE_CATEGORY_COLORS.length;

export function getRamp(rampId: string | undefined): AttributeRamp {
  return ATTRIBUTE_RAMPS.find(r => r.id === rampId) || ATTRIBUTE_RAMPS[0];
}

// --- Value coercion ------------------------------------------------------------

/** True when an attribute value carries a usable number (number or numeric string). */
export function isNumericAttrValue(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim();
    return t !== '' && Number.isFinite(Number(t));
  }
  return false;
}

/** Coerce an attribute value to a number, or null when it carries none. */
export function toNumericAttrValue(v: any): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// --- Field discovery & statistics ------------------------------------------------

export interface AttributeFieldInfo {
  name: string;
  /** True when >= 80% of the sampled non-null values are numeric. */
  numeric: boolean;
}

/**
 * Discover the attribute fields present on a feature set (union of property
 * keys over a sample). Geometry keys are excluded via featureProperties.
 */
export function collectAttributeFields(features: any[], sampleLimit = 300): AttributeFieldInfo[] {
  const counts = new Map<string, { total: number; numeric: number }>();
  const n = Math.min(features.length, sampleLimit);
  for (let i = 0; i < n; i++) {
    const props = featureProperties(features[i]);
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v === undefined || v === null) continue;
      const c = counts.get(key) || { total: 0, numeric: 0 };
      c.total++;
      if (isNumericAttrValue(v)) c.numeric++;
      counts.set(key, c);
    }
  }
  return Array.from(counts.entries())
    .map(([name, c]) => ({ name, numeric: c.numeric / c.total >= 0.8 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AttributeFieldStats {
  /** Features examined. */
  count: number;
  /** Numeric values found, sorted ascending. */
  numericValues: number[];
  min: number;
  max: number;
  /** Distinct values (as strings) with counts, most frequent first. */
  distinct: Array<{ value: string; count: number }>;
  /** Number of distinct values in the dataset (distinct.length is capped). */
  distinctTotal: number;
  /** Features whose value is missing or empty. */
  missing: number;
}

/**
 * Compute the statistics the attribute styles need for one field: numeric
 * range + sorted values (for ramps / size scaling) and the value frequency
 * table (for category assignment). `distinctCap` bounds the frequency table
 * for very high-cardinality fields.
 */
export function computeFieldStats(features: any[], field: string, distinctCap = 4096): AttributeFieldStats {
  const numericValues: number[] = [];
  const freq = new Map<string, number>();
  let missing = 0;
  let capped = false;

  for (const f of features) {
    const v = featureProperties(f)[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      missing++;
      continue;
    }
    const num = toNumericAttrValue(v);
    if (num !== null) numericValues.push(num);
    const key = String(v);
    if (freq.has(key)) {
      freq.set(key, (freq.get(key) || 0) + 1);
    } else if (freq.size < distinctCap) {
      freq.set(key, 1);
    } else {
      capped = true;
    }
  }

  numericValues.sort((a, b) => a - b);
  const distinct = Array.from(freq.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return {
    count: features.length,
    numericValues,
    min: numericValues.length ? numericValues[0] : 0,
    max: numericValues.length ? numericValues[numericValues.length - 1] : 0,
    distinct,
    distinctTotal: freq.size + (capped ? 1 : 0), // +1: at least one value fell past the cap
    missing,
  };
}

// --- Classification --------------------------------------------------------------

/**
 * Compute class boundaries for a numeric mode. Returns `classes + 1`
 * strictly-increasing break values spanning the data, or null when the data
 * is degenerate (no values or all identical). Quantile breaks that collapse
 * onto each other (heavily tied data) fall back to equal intervals.
 */
export function computeClassBreaks(
  sortedValues: number[],
  method: AttrClassMethod,
  classes: number,
): number[] | null {
  if (!sortedValues.length || classes < 1) return null;
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  if (!(max > min)) return null;

  const breaks: number[] = [min];
  if (method === 'quantile') {
    const n = sortedValues.length;
    for (let i = 1; i < classes; i++) {
      const pos = (i / classes) * (n - 1);
      const lo = Math.floor(pos);
      const frac = pos - lo;
      const v = lo + 1 < n
        ? sortedValues[lo] + (sortedValues[lo + 1] - sortedValues[lo]) * frac
        : sortedValues[lo];
      breaks.push(v);
    }
    // Tied data can produce duplicate breaks — fall back to equal intervals.
    for (let i = 1; i < breaks.length; i++) {
      if (!(breaks[i] > breaks[i - 1])) return computeClassBreaks(sortedValues, 'equal-interval', classes);
    }
  } else {
    for (let i = 1; i < classes; i++) {
      breaks.push(min + ((max - min) * i) / classes);
    }
  }
  breaks.push(max);
  return breaks;
}

/** The class index (0 .. breaks.length - 2) a numeric value falls into. */
export function classifyValue(value: number, breaks: number[]): number {
  const last = breaks.length - 2;
  for (let i = 0; i <= last; i++) {
    if (value < breaks[i + 1]) return i;
  }
  return last; // value >= top break (or domain drift) lands in the last class
}

/** The ramp colour for a class, sampling the ramp stops evenly. */
export function rampColorForClass(rampColors: string[], classes: number, classIndex: number): string {
  if (classes <= 1) return rampColors[Math.floor(rampColors.length / 2)];
  const t = classIndex / (classes - 1);
  const idx = Math.round(t * (rampColors.length - 1));
  return rampColors[Math.max(0, Math.min(rampColors.length - 1, idx))];
}

/**
 * Proportional size for a numeric value (square-root scaling, so the symbol
 * AREA grows roughly linearly with the value, like ArcGIS proportional
 * symbols). Values outside the domain are clamped.
 */
export function sizeForValue(value: number, domainMin: number, domainMax: number, sizeMin: number, sizeMax: number): number {
  if (!(domainMax > domainMin)) return (sizeMin + sizeMax) / 2;
  const t = Math.max(0, Math.min(1, (value - domainMin) / (domainMax - domainMin)));
  return sizeMin + (sizeMax - sizeMin) * Math.sqrt(t);
}

// --- Number formatting -----------------------------------------------------------

/** Format an attribute number for legend labels (no float noise, thousands separators). */
export function formatAttrValue(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '\u2013';
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 100) s = String(Math.round(n));
  else {
    s = n.toFixed(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    if (s === '-0') s = '0';
  }
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [int, dec] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (dec !== undefined ? '.' + dec : '');
}

// --- Legend ------------------------------------------------------------------------

export interface AttributeLegendRow {
  label: string;
  color: string;   // swatch colour (hex)
  sizePx?: number; // 'size' mode: representative radius in px
  kind: 'class' | 'category' | 'other';
}

/**
 * Build the legend rows for an attribute render config — pure function of
 * the persisted config (no features needed), so legends are stable across
 * lazy loads and reloads. `baseColor` tints the size-mode rows (size mode
 * keeps the layer's own colour).
 */
export function buildAttributeLegend(
  attr: AttributeRenderConfig,
  baseColor?: string,
): AttributeLegendRow[] {
  if (!attr.enabled || !attr.field) return [];

  if (attr.mode === 'color') {
    const breaks = attr.classBreaks;
    if (!breaks || breaks.length < 2) return [];
    const ramp = getRamp(attr.rampId);
    const classes = breaks.length - 1;
    const rows: AttributeLegendRow[] = [];
    for (let i = 0; i < classes; i++) {
      rows.push({
        label: `${formatAttrValue(breaks[i])} \u2013 ${formatAttrValue(breaks[i + 1])}`,
        color: rampColorForClass(ramp.colors, classes, i),
        kind: 'class',
      });
    }
    if (attr.missingCount && attr.missingCount > 0) {
      rows.push({ label: 'No data', color: ATTRIBUTE_NO_DATA_COLOR, kind: 'other' });
    }
    return rows;
  }

  if (attr.mode === 'size') {
    const color = baseColor && baseColor.trim() ? baseColor : '#4a90e2';
    const sizeMin = attr.sizeMin ?? 4;
    const sizeMax = attr.sizeMax ?? 20;
    const lo = attr.domainMin;
    const hi = attr.domainMax;
    if (lo === undefined || hi === undefined) return [];
    const mid = (lo + hi) / 2;
    const rows: AttributeLegendRow[] = [
      { label: formatAttrValue(hi), color, sizePx: sizeMax, kind: 'class' },
      { label: formatAttrValue(mid), color, sizePx: sizeForValue(mid, lo, hi, sizeMin, sizeMax), kind: 'class' },
      { label: formatAttrValue(lo), color, sizePx: sizeMin, kind: 'class' },
    ];
    if (attr.missingCount && attr.missingCount > 0) {
      rows.push({ label: 'No data', color: ATTRIBUTE_NO_DATA_COLOR, sizePx: sizeMin, kind: 'other' });
    }
    return rows;
  }

  // 'types' mode
  const cats = attr.categories || [];
  const rows: AttributeLegendRow[] = cats.map(c => ({
    label: c.value,
    color: ATTRIBUTE_CATEGORY_COLORS[c.colorIndex % ATTRIBUTE_CATEGORY_COLORS.length],
    kind: 'category' as const,
  }));
  const extra = (attr.distinctCount ?? cats.length) > cats.length || (attr.missingCount ?? 0) > 0;
  if (extra) {
    rows.push({ label: 'Other / no data', color: ATTRIBUTE_NO_DATA_COLOR, kind: 'other' });
  }
  return rows;
}

// --- Style construction --------------------------------------------------------------

export interface AttributeStyleBase {
  lineColor?: string;
  lineWidth?: number;
  fillColor?: string;
  fontColor?: string;
  fontSize?: number;
}

/** Darken a hex colour by scaling its channels (polygon outlines). */
function darkenHex(hex: string, factor: number): string {
  const c = parseColor(hex, 1);
  return rgbaToString({
    r: Math.round(c.r * factor),
    g: Math.round(c.g * factor),
    b: Math.round(c.b * factor),
    a: 1,
  });
}

/**
 * Build the per-feature OL style function for an attribute render config.
 * Returns null when the config is incomplete (toggle on but no field yet,
 * degenerate stats…) — the caller then falls back to the plain layer style.
 *
 * Styling per geometry type:
 *   - Point:   circle symbol — class colour ('color'/'types') or scaled
 *              radius ('size'); white outline for readability.
 *   - Line:    stroke colour from the class/category; 'size' scales the
 *              stroke width instead.
 *   - Polygon: fill from the class/category (alpha floored at 0.7 so
 *              choropleths read clearly; the layer opacity slider still
 *              fades the whole layer); thin darker outline of the same hue.
 *              'size' mode leaves polygons on the base layer style.
 * Features without a usable value render in a neutral grey ("No data").
 */
export function buildAttributeStyle(
  base: AttributeStyleBase,
  attr: AttributeRenderConfig,
): ((feature: any) => Style) | null {
  if (!attr.enabled || !attr.field) return null;
  const field = attr.field;

  const line = parseColor(base.lineColor, 1);
  const lineStr = rgbaToString(line);
  const lineWidth = base.lineWidth ?? 2;
  const fill = parseColor(base.fillColor, 0.3);
  const baseFillStr = rgbaToString(fill);
  const fillAlpha = Math.max(fill.a, 0.7);

  // Pre-compute the value -> style inputs per mode.
  let classColors: string[] | null = null;
  let breaks: number[] | null = null;
  if (attr.mode === 'color') {
    if (!attr.classBreaks || attr.classBreaks.length < 2) return null;
    breaks = attr.classBreaks;
    const ramp = getRamp(attr.rampId);
    const classes = breaks.length - 1;
    classColors = [];
    for (let i = 0; i < classes; i++) classColors.push(rampColorForClass(ramp.colors, classes, i));
  }

  const sizeMin = attr.sizeMin ?? 4;
  const sizeMax = attr.sizeMax ?? 20;
  const domainMin = attr.domainMin;
  const domainMax = attr.domainMax;
  if (attr.mode === 'size' && (domainMin === undefined || domainMax === undefined)) return null;

  let categoryColor: Map<string, string> | null = null;
  if (attr.mode === 'types') {
    categoryColor = new Map();
    for (const c of attr.categories || []) {
      categoryColor.set(c.value, ATTRIBUTE_CATEGORY_COLORS[c.colorIndex % ATTRIBUTE_CATEGORY_COLORS.length]);
    }
  }

  // Styles are keyed by bucket (class index / quantised size / category
  // colour) and cached — style functions run for every feature every frame.
  const cache = new Map<string, Style>();
  const cached = (key: string, make: () => Style): Style => {
    let s = cache.get(key);
    if (!s) {
      if (cache.size > 512) cache.clear();
      s = make();
      cache.set(key, s);
    }
    return s;
  };

  const noDataStyle = (geomType: string): Style => {
    if (geomType === 'LineString') {
      return new Style({ stroke: new Stroke({ color: ATTRIBUTE_NO_DATA_COLOR, width: Math.max(1, lineWidth * 0.75) }) });
    }
    if (geomType === 'Polygon') {
      return new Style({
        fill: new Fill({ color: rgbaToString({ r: 160, g: 167, b: 176, a: Math.max(fill.a, 0.4) }) }),
        stroke: new Stroke({ color: darkenHex(ATTRIBUTE_NO_DATA_COLOR, 0.7), width: 1 }),
      });
    }
    return new Style({
      image: new CircleStyle({
        radius: 5,
        fill: new Fill({ color: ATTRIBUTE_NO_DATA_COLOR }),
        stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }),
      }),
    });
  };

  return (feature: any): Style => {
    const geom = feature && feature.getGeometry ? feature.getGeometry() : null;
    const geomTypeRaw: string = geom && geom.getType ? geom.getType() : 'Point';
    // Normalise Multi* to their single counterparts for styling purposes.
    const geomType = geomTypeRaw.startsWith('Multi') ? geomTypeRaw.slice(5) : geomTypeRaw;

    const raw = featureProperties(feature)[field];
    const hasValue = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '');
    const num = hasValue ? toNumericAttrValue(raw) : null;

    if (attr.mode === 'color') {
      if (num === null) return cached('nd:' + geomType, () => noDataStyle(geomType));
      const idx = classifyValue(num, breaks!);
      const color = classColors![idx];
      return cached('c' + idx + ':' + geomType, () => makeColorStyle(geomType, color, lineWidth, fillAlpha));
    }

    if (attr.mode === 'size') {
      if (num === null) {
        return cached('nds:' + geomType, () => {
          if (geomType === 'LineString') {
            return new Style({ stroke: new Stroke({ color: ATTRIBUTE_NO_DATA_COLOR, width: Math.max(1, sizeMin * 0.75) }) });
          }
          if (geomType === 'Polygon') {
            return new Style({ fill: new Fill({ color: baseFillStr }), stroke: new Stroke({ color: lineStr, width: Math.max(1, lineWidth * 0.75) }) });
          }
          return new Style({
            image: new CircleStyle({
              radius: Math.max(2, sizeMin * 0.75),
              fill: new Fill({ color: ATTRIBUTE_NO_DATA_COLOR }),
              stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }),
            }),
          });
        });
      }
      const px = sizeForValue(num, domainMin!, domainMax!, sizeMin, sizeMax);
      const bucket = Math.round(px * 2) / 2; // quantise to half-pixels
      return cached('s' + bucket + ':' + geomType, () => {
        if (geomType === 'LineString') {
          return new Style({ stroke: new Stroke({ color: lineStr, width: Math.max(0.5, bucket) }) });
        }
        if (geomType === 'Polygon') {
          // Size mode has no natural polygon expression — keep the base style.
          return new Style({ fill: new Fill({ color: baseFillStr }), stroke: new Stroke({ color: lineStr, width: lineWidth }) });
        }
        return new Style({
          image: new CircleStyle({
            radius: Math.max(1.5, bucket),
            fill: new Fill({ color: lineStr }),
            stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }),
          }),
        });
      });
    }

    // 'types' mode
    if (!hasValue) return cached('nd:' + geomType, () => noDataStyle(geomType));
    const key = String(raw);
    const color = categoryColor!.get(key);
    if (!color) return cached('ot:' + geomType, () => noDataStyle(geomType));
    const ci = ATTRIBUTE_CATEGORY_COLORS.indexOf(color);
    return cached('t' + ci + ':' + geomType, () => makeColorStyle(geomType, color, lineWidth, fillAlpha));
  };
}

/** Style for a resolved class/category colour, per geometry type. */
function makeColorStyle(
  geomType: string,
  color: string,
  lineWidth: number,
  fillAlpha: number,
): Style {
  if (geomType === 'LineString') {
    return new Style({ stroke: new Stroke({ color, width: Math.max(1, lineWidth) }) });
  }
  if (geomType === 'Polygon') {
    const c = parseColor(color, 1);
    return new Style({
      fill: new Fill({ color: rgbaToString({ r: c.r, g: c.g, b: c.b, a: fillAlpha }) }),
      stroke: new Stroke({ color: darkenHex(color, 0.6), width: Math.min(Math.max(1, lineWidth), 1.5) }),
    });
  }
  // Point / anything else: circle symbol in the class colour.
  return new Style({
    image: new CircleStyle({
      radius: 6,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }),
    }),
  });
}
