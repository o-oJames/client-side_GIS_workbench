// ---------------------------------------------------------------------------
// Attribute table support — pure logic shared by the AttributeTableWindow
// component (ArcGIS Online-style table view). No React, no OL rendering:
// attribute extraction, column discovery, sorting, statistics, CSV export,
// row virtualisation math and window-geometry helpers. All OL interaction is
// limited to reading feature properties/geometries passed in as `any`.
// ---------------------------------------------------------------------------

/** One active sort clause; multiple clauses combine in array order. */
export interface AttrTableSortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

/** What subset of the layer's records the table shows (ArcGIS view modes). */
export type AttrTableViewMode = 'all' | 'selected' | 'visible' | 'filtered';

/** Desktop-window geometry of the table panel (px, map-container relative). */
export interface AttrTableWindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Layout constants shared by the component and its tests.
export const ATTR_TABLE_ROW_HEIGHT = 30;   // px per data row (virtualised grid)
export const ATTR_TABLE_HEADER_HEIGHT = 32; // px header strip (column names)
export const ATTR_TABLE_ROWNUM_WIDTH = 64;  // px sticky row-number column
export const ATTR_TABLE_COLUMN_WIDTH = 160; // px default field column width
export const ATTR_TABLE_MIN_W = 380;        // px minimum window size
export const ATTR_TABLE_MIN_H = 220;

// ----- attribute access ------------------------------------------------------

/**
 * A feature's attribute map: every property except the geometry and OL
 * internal keys. Mirrors the metadata extraction used by the feature-info
 * popup so the table shows the same fields.
 */
export function getFeatureAttributes(feature: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!feature || typeof feature.getProperties !== 'function') return out;
  const props = feature.getProperties();
  Object.keys(props).forEach(key => {
    const value = props[key];
    if (key === 'geometry') return;
    // OL geometry objects (any nested geometry) expose getType().
    if (typeof value === 'object' && value !== null && typeof value.getType === 'function') return;
    // Cluster wrapper member list — never a real attribute.
    if (key === 'features' && Array.isArray(value)) return;
    out[key] = value;
  });
  return out;
}

/**
 * Union of attribute keys across the features, in order of first
 * appearance — the table's column set. (ArcGIS uses field aliases; layers
 * here carry raw field names, so the key doubles as the alias.)
 */
export function collectColumns(features: any[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const f of features) {
    const attrs = getFeatureAttributes(f);
    for (const key of Object.keys(attrs)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

// ----- sorting ----------------------------------------------------------------

/**
 * Compare two attribute values ascending, SQL-style: missing values
 * (null/undefined/empty string) always sort last, numbers numerically
 * (numeric strings included), booleans false < true, everything else as
 * locale-ordered strings. Returns -1 / 0 / 1.
 */
export function compareAttrValues(a: any, b: any): number {
  const aMissing = a === undefined || a === null || a === '';
  const bMissing = b === undefined || b === null || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }

  const aNum = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN;
  const bNum = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN;
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
    return aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
  }
  const cmp = String(a).localeCompare(String(b));
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0;
}

/**
 * Stable multi-column sort. Returns a new array; the input is not mutated.
 * An empty sort list returns a shallow copy in input order.
 */
export function sortFeatures(features: any[], sorts: AttrTableSortSpec[]): any[] {
  if (!sorts.length) return features.slice();
  const indexed = features.map((feature, i) => ({ feature, i }));
  indexed.sort((ra, rb) => {
    for (const spec of sorts) {
      const cmp = compareAttrValues(
        getFeatureAttributes(ra.feature)[spec.field],
        getFeatureAttributes(rb.feature)[spec.field]
      );
      if (cmp !== 0) return spec.dir === 'desc' ? -cmp : cmp;
    }
    return ra.i - rb.i; // tie-break: keep natural order stable
  });
  return indexed.map(r => r.feature);
}

// ----- statistics ---------------------------------------------------------------

export interface AttrFieldStats {
  field: string;
  count: number;      // features with a usable numeric value
  nulls: number;      // features without one
  min: number;
  max: number;
  mean: number;
  stddev: number;
  /** 10-bin histogram over [min, max]; empty when count === 0. */
  histogram: number[];
}

/** Coerce an attribute value to a finite number, or null when it isn't one. */
export function asNumericValue(value: any): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Min/max/mean/stddev/histogram for one field over the given features —
 * the table's Statistics panel (ArcGIS reports the same five numbers).
 */
export function computeFieldStats(features: any[], field: string): AttrFieldStats {
  let count = 0;
  let nulls = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  const values: number[] = [];

  for (const f of features) {
    const v = asNumericValue(getFeatureAttributes(f)[field]);
    if (v === null) {
      nulls += 1;
      continue;
    }
    values.push(v);
    count += 1;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }

  if (count === 0) {
    return { field, count: 0, nulls, min: 0, max: 0, mean: 0, stddev: 0, histogram: [] };
  }

  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const histogram = new Array<number>(10).fill(0);
  const span = max - min;
  for (const v of values) {
    const bin = span === 0 ? 0 : Math.min(9, Math.floor(((v - min) / span) * 10));
    histogram[bin] += 1;
  }
  return { field, count, nulls, min, max, mean, stddev: Math.sqrt(variance), histogram };
}

/** Fields with at least one numeric value — the statistics candidates. */
export function numericColumns(features: any[], columns: string[]): string[] {
  return columns.filter(col =>
    features.some(f => asNumericValue(getFeatureAttributes(f)[col]) !== null)
  );
}

// ----- CSV export -----------------------------------------------------------------

/** RFC-4180 cell escaping: quote when the value contains " , CR or LF. */
export function csvEscape(value: any): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Serialise the features (in the given order) into CSV text using `columns`
 * as the header row. This exports exactly what the table shows.
 */
export function featuresToCsv(features: any[], columns: string[]): string {
  const lines: string[] = [columns.map(csvEscape).join(',')];
  for (const f of features) {
    const attrs = getFeatureAttributes(f);
    lines.push(columns.map(col => csvEscape(attrs[col])).join(','));
  }
  return lines.join('\r\n');
}

/** Trigger a browser download of CSV text (UTF-8 with BOM for Excel). */
export function downloadCsv(csv: string, baseName: string): void {
  const cleaned = (baseName || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = cleaned + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ----- row virtualisation --------------------------------------------------------

/**
 * Which slice of rows a virtualised grid must render for a given scroll
 * position. `end` is exclusive; the range is clamped to [0, total] and padded
 * by `overscan` rows on both sides. A zero-height viewport (jsdom) still
 * yields the overscan window from the top so tests see real rows.
 */
export function virtualRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 8
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  // The rendered band is the visible window padded by overscan on both
  // sides, sliding along the row list and clamped at either end (so an
  // overshot scroll position still renders a full band hugging the bottom).
  const bandSize = Math.min(total, visible + overscan * 2);
  const start = Math.max(0, Math.min(first - overscan, total - bandSize));
  const end = Math.min(total, start + bandSize);
  return { start, end };
}

// ----- window geometry -------------------------------------------------------------

/**
 * Clamp a window rect into the container: sizes are floored at the minimums
 * and capped at the container, then the position is pulled back so the whole
 * window stays inside (top-left wins when the window outgrows the container).
 */
export function clampWindowRect(
  rect: AttrTableWindowRect,
  containerW: number,
  containerH: number
): AttrTableWindowRect {
  const w = Math.max(ATTR_TABLE_MIN_W, Math.min(rect.w, Math.max(containerW, ATTR_TABLE_MIN_W)));
  const h = Math.max(ATTR_TABLE_MIN_H, Math.min(rect.h, Math.max(containerH, ATTR_TABLE_MIN_H)));
  const x = Math.max(0, Math.min(rect.x, Math.max(0, containerW - w)));
  const y = Math.max(0, Math.min(rect.y, Math.max(0, containerH - h)));
  return { x, y, w, h };
}

/** ArcGIS-like default: a bottom-docked panel spanning the map width. */
export function defaultWindowRect(containerW: number, containerH: number): AttrTableWindowRect {
  const margin = 12;
  const h = Math.max(ATTR_TABLE_MIN_H, Math.min(360, Math.round(containerH * 0.45)));
  const w = Math.max(ATTR_TABLE_MIN_W, containerW - margin * 2);
  return { x: margin, y: Math.max(margin, containerH - h - margin), w, h };
}

// ----- persisted window geometry (localStorage) -------------------------------------

/** Storage key — the mapviewer- prefix keeps it inside the app-lock vault. */
export const ATTR_TABLE_GEOMETRY_KEY = 'mapviewer-attr-table-geometry';

export interface AttrTableGeometry {
  rect: AttrTableWindowRect;
  maximized: boolean;
}

/** Load the persisted window geometry; null when absent/invalid. */
export function loadAttrTableGeometry(): AttrTableGeometry | null {
  try {
    const raw = localStorage.getItem(ATTR_TABLE_GEOMETRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const r = parsed?.rect;
    if (!r || [r.x, r.y, r.w, r.h].some((v: any) => typeof v !== 'number' || !isFinite(v))) return null;
    return { rect: { x: r.x, y: r.y, w: r.w, h: r.h }, maximized: !!parsed.maximized };
  } catch (e) {
    console.warn('[AttributeTable] Failed to load window geometry:', e);
    return null;
  }
}

/** Persist the window geometry (debounced by the caller). */
export function saveAttrTableGeometry(geometry: AttrTableGeometry): void {
  try {
    localStorage.setItem(ATTR_TABLE_GEOMETRY_KEY, JSON.stringify(geometry));
  } catch (e) {
    console.warn('[AttributeTable] Failed to save window geometry:', e);
  }
}
