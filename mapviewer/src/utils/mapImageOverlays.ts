import OLMap from 'ol/Map.js';
import { toLonLat } from 'ol/proj.js';
import { RasterLayer, VectorLayerConfig, UnitsSystem } from '../types';
import { buildAttributeLegend } from './attributeStyle';

/**
 * Optional map details that can be composited onto captured map images
 * ("Save image as…" / "Copy image" in the map right-click menu). The layer
 * canvases captured by `captureMapCanvas` contain only rendered layers, so
 * these chrome elements are drawn onto the export canvas here.
 */
export interface ImageDetailOptions {
  scaleBar: boolean;
  legend: boolean;
  northArrow: boolean;
}

/** One row of the exported image's legend. */
export interface MapLegendEntry {
  label: string;
  kind: 'raster' | 'vector';
  strokeColor?: string;
  fillColor?: string;
  lineWidth?: number;
  /** Attribute-driven layers: class/category rows rendered under the layer
   * row, so the export shows what each feature looks like given its data. */
  subRows?: Array<{ label: string; color: string; sizePx?: number }>;
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const MARGIN = 16;
const PANEL_BG = 'rgba(255, 255, 255, 0.92)';
const PANEL_BORDER = 'rgba(15, 35, 60, 0.16)';
const INK = '#1f2d3d';
const MUTED = 'rgba(31, 45, 61, 0.55)';
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const LEGEND_MAX_ENTRIES = 12;
const FEET_PER_METER = 3.280839895;
const FEET_PER_MILE = 5280;
const NICE_STEPS = [1, 2, 5];

/* ------------------------------------------------------------------ */
/* Legend entries                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build legend rows from the current layer config: every visible raster
 * layer, then every visible vector layer, in panel (z) order.
 */
export function buildLegendEntries(
  rasterLayers: RasterLayer[],
  vectorLayers: VectorLayerConfig[],
): MapLegendEntry[] {
  const entries: MapLegendEntry[] = [];
  rasterLayers.forEach((layer) => {
    if (layer.visible === false) return;
    entries.push({ label: layer.name || 'Raster layer', kind: 'raster' });
  });
  vectorLayers.forEach((layer) => {
    if (!layer.visible) return;
    const attr = layer.attrRender;
    const subRows = attr && attr.enabled && attr.field
      ? buildAttributeLegend(attr, layer.lineColor).map(r => ({ label: r.label, color: r.color, sizePx: r.sizePx }))
      : undefined;
    entries.push({
      label: layer.name || 'Vector layer',
      kind: 'vector',
      strokeColor: layer.lineColor,
      fillColor: layer.fillColor,
      lineWidth: layer.lineWidth,
      subRows: subRows && subRows.length > 0 ? subRows : undefined,
    });
  });
  return entries;
}

/* ------------------------------------------------------------------ */
/* Scale-bar distance picking (pure, unit-tested)                     */
/* ------------------------------------------------------------------ */

export interface ScaleDistance {
  /** Ground distance the bar represents, in metres. */
  meters: number;
  /** Bar length in pixels at the current resolution. */
  px: number;
  /** Pre-formatted label, e.g. "200 m" or "1.5 mi". */
  label: string;
}

/** Format a number without floating-point noise or trailing zeroes. */
export function formatScaleNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Human label for a ground distance (given in metres) in the given units. */
export function formatScaleLabel(meters: number, units: UnitsSystem): string {
  if (units === 'imperial') {
    // Round away the float noise of the ft -> m -> ft round trip, which can
    // otherwise turn an exact mile into 5279.999999 ft.
    const feet = Math.round(meters * FEET_PER_METER * 1e6) / 1e6;
    if (feet >= FEET_PER_MILE) return `${formatScaleNumber(feet / FEET_PER_MILE)} mi`;
    return `${formatScaleNumber(feet)} ft`;
  }
  if (meters >= 1000) return `${formatScaleNumber(meters / 1000)} km`;
  return `${formatScaleNumber(meters)} m`;
}

/**
 * Choose the largest "round" ground distance whose bar fits within
 * `maxPx` pixels at `metersPerPixel` resolution. Candidates land on
 * 1/2/5 × 10^n in the display unit (metres, feet or miles) so the label is
 * always clean. Returns null for a degenerate resolution.
 */
export function pickScaleDistance(
  metersPerPixel: number,
  maxPx: number,
  units: UnitsSystem,
): ScaleDistance | null {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return null;
  const limit = Math.max(maxPx, 40);

  // Candidate distances (in metres) that label cleanly in the display unit.
  const candidatesMeters: number[] = [];
  if (units === 'imperial') {
    for (let exp = 0; exp <= 6; exp += 1) {
      NICE_STEPS.forEach((s) => candidatesMeters.push((s * 10 ** exp) / FEET_PER_METER));
    }
    for (let exp = 0; exp <= 4; exp += 1) {
      NICE_STEPS.forEach((s) =>
        candidatesMeters.push((s * 10 ** exp * FEET_PER_MILE) / FEET_PER_METER),
      );
    }
  } else {
    for (let exp = -1; exp <= 7; exp += 1) {
      NICE_STEPS.forEach((s) => candidatesMeters.push(s * 10 ** exp));
    }
  }

  let best: ScaleDistance | null = null;
  for (const meters of candidatesMeters) {
    const px = meters / metersPerPixel;
    if (px > limit) continue;
    if (!best || px > best.px) {
      best = { meters, px, label: formatScaleLabel(meters, units) };
    }
  }

  if (!best) {
    // Zoomed in beyond the smallest round distance — fall back to it even
    // though its bar exceeds the preferred width (caller may still reject it
    // if it does not fit the canvas at all).
    const meters = Math.min(...candidatesMeters);
    best = { meters, px: meters / metersPerPixel, label: formatScaleLabel(meters, units) };
  }
  return best;
}

/**
 * Ground metres per CSS pixel at the view centre. The EPSG:3857 resolution
 * is only true at the equator; it is corrected by cos(latitude) so the bar
 * matches the on-screen ScaleLine control at any latitude.
 */
export function metersPerPixelAtCenter(map: OLMap): number {
  const view = map.getView();
  const resolution = view.getResolution();
  const center = view.getCenter();
  if (resolution === undefined || !center) return 0;
  const latDeg = toLonLat(center)[1];
  return resolution * Math.cos((latDeg * Math.PI) / 180);
}

/* ------------------------------------------------------------------ */
/* Canvas drawing helpers                                             */
/* ------------------------------------------------------------------ */

function traceRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Semi-opaque white rounded panel so details stay legible on any imagery. */
function drawPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  traceRoundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = PANEL_BG;
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}\u2026`).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${text.slice(0, lo)}\u2026`;
}

/* ------------------------------------------------------------------ */
/* Scale bar — bottom-left                                            */
/* ------------------------------------------------------------------ */

export function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  metersPerPixel: number,
  units: UnitsSystem,
): void {
  const maxBarPx = Math.min(150, canvasW - MARGIN * 2 - 24);
  if (maxBarPx < 40) return;
  const scale = pickScaleDistance(metersPerPixel, maxBarPx, units);
  if (!scale || scale.px > canvasW - MARGIN * 2) return;

  ctx.save();
  ctx.font = `600 12px ${FONT_STACK}`;
  const labelW = ctx.measureText(scale.label).width;
  const padX = 10;
  const padY = 8;
  const textH = 13;
  const gap = 5;
  const barH = 6;
  const boxW = Math.max(scale.px, labelW) + padX * 2;
  const boxH = padY + textH + gap + barH + padY;
  const x = MARGIN;
  const y = canvasH - MARGIN - boxH;
  drawPanel(ctx, x, y, boxW, boxH);

  // Distance label centred above the bar.
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(scale.label, x + boxW / 2, y + padY);

  // Alternating black/white bar with end ticks (classic graphic scale bar).
  const barX = x + (boxW - scale.px) / 2;
  const barY = y + padY + textH + gap;
  const half = scale.px / 2;
  ctx.fillStyle = INK;
  ctx.fillRect(barX, barY, half, barH);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(barX + half, barY, scale.px - half, barH);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, scale.px - 1, barH - 1);
  ctx.beginPath();
  ctx.moveTo(barX + 0.5, barY - 3);
  ctx.lineTo(barX + 0.5, barY + barH + 3);
  ctx.moveTo(barX + scale.px - 0.5, barY - 3);
  ctx.lineTo(barX + scale.px - 0.5, barY + barH + 3);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* North arrow — top-right                                            */
/* ------------------------------------------------------------------ */

export function drawNorthArrow(ctx: CanvasRenderingContext2D, canvasW: number): void {
  const r = 23;
  const cx = canvasW - MARGIN - r;
  const cy = MARGIN + r;

  ctx.save();
  // Background disc.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = PANEL_BG;
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Classic split arrow: left half solid, right half outlined. North is up
  // (EPSG:3857 grid north ≈ true north for this app's purposes).
  const tipY = cy - 11;
  const baseY = cy + 5;
  const halfW = 6.5;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx - halfW, baseY);
  ctx.lineTo(cx, baseY - 3.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx + halfW, baseY);
  ctx.lineTo(cx, baseY - 3.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.font = `700 10px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('N', cx, baseY + 2);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Legend — bottom-right                                              */
/* ------------------------------------------------------------------ */

function drawSwatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  entry: MapLegendEntry,
): void {
  if (entry.kind === 'raster') {
    // Neutral tile with diagonal strokes suggesting imagery.
    traceRoundRect(ctx, x, y, w, h, 3);
    ctx.fillStyle = '#d9e0e8';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = '#aab6c2';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + h - 2);
    ctx.lineTo(x + w * 0.45, y + 2);
    ctx.moveTo(x + w * 0.55, y + h - 2);
    ctx.lineTo(x + w - 2, y + 2);
    ctx.stroke();
    ctx.restore();
    traceRoundRect(ctx, x, y, w, h, 3);
    ctx.strokeStyle = '#8b98a5';
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  traceRoundRect(ctx, x, y, w, h, 3);
  ctx.fillStyle = entry.fillColor || 'rgba(74, 144, 226, 0.3)';
  ctx.fill();
  ctx.strokeStyle = entry.strokeColor || '#4a90e2';
  ctx.lineWidth = Math.min(Math.max(entry.lineWidth || 2, 1), 3);
  ctx.stroke();
}

const LEGEND_MAX_SUBROWS = 8;

/** Flat render list for drawLegend: layer rows plus indented attribute rows. */
type LegendRenderRow =
  | { kind: 'main'; entry: MapLegendEntry; label: string }
  | { kind: 'sub'; label: string; color: string; sizePx?: number };

export function drawLegend(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  entries: MapLegendEntry[],
): void {
  if (!entries.length) return;

  ctx.save();
  ctx.font = `12px ${FONT_STACK}`;
  const shown = entries.slice(0, LEGEND_MAX_ENTRIES);
  const overflow = entries.length - shown.length;
  const padX = 10;
  const padY = 8;
  const rowH = 20;
  const subRowH = 17;
  const swatchW = 22;
  const swatchH = 12;
  const gap = 8;
  const maxLabelPx = 150;
  const subIndent = 10; // sub-row swatches sit slightly right of layer swatches

  // Flatten: one main row per entry, then its attribute class/category rows.
  const rows: LegendRenderRow[] = [];
  shown.forEach((entry) => {
    rows.push({ kind: 'main', entry, label: truncateText(ctx, entry.label, maxLabelPx) });
    if (entry.subRows && entry.subRows.length > 0) {
      const subs = entry.subRows.slice(0, LEGEND_MAX_SUBROWS);
      subs.forEach((sr) => rows.push({ kind: 'sub', label: truncateText(ctx, sr.label, maxLabelPx), color: sr.color, sizePx: sr.sizePx }));
      if (entry.subRows.length > subs.length) {
        rows.push({ kind: 'sub', label: `+ ${entry.subRows.length - subs.length} more`, color: '' });
      }
    }
  });

  let labelW = 40;
  rows.forEach((row) => {
    const extra = row.kind === 'sub' ? subIndent : 0;
    labelW = Math.max(labelW, ctx.measureText(row.label).width + extra);
  });

  const boxW = padX + swatchW + gap + labelW + padX;
  const rowsHeight = rows.reduce((h, r) => h + (r.kind === 'sub' ? subRowH : rowH), 0);
  const boxH = padY * 2 + rowsHeight + (overflow > 0 ? rowH : 0);
  const x = canvasW - MARGIN - boxW;
  const y = canvasH - MARGIN - boxH;
  drawPanel(ctx, x, y, boxW, boxH);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let cursorY = y + padY;
  rows.forEach((row) => {
    const h = row.kind === 'sub' ? subRowH : rowH;
    const centerY = cursorY + h / 2;
    if (row.kind === 'main') {
      drawSwatch(ctx, x + padX, centerY - swatchH / 2, swatchW, swatchH, row.entry);
      ctx.fillStyle = INK;
      ctx.fillText(row.label, x + padX + swatchW + gap, centerY + 0.5);
    } else if (row.color) {
      // Attribute sub-row: a circle scaled by sizePx (size mode) or a slim
      // colour chip (colour / types modes).
      if (row.sizePx !== undefined) {
        const d = Math.max(4, Math.min(swatchH, row.sizePx));
        ctx.beginPath();
        ctx.arc(x + padX + subIndent + (swatchW - subIndent) / 2, centerY, d / 2, 0, Math.PI * 2);
        ctx.fillStyle = row.color;
        ctx.fill();
      } else {
        traceRoundRect(ctx, x + padX + subIndent, centerY - 4, swatchW - subIndent, 8, 2);
        ctx.fillStyle = row.color;
        ctx.fill();
      }
      ctx.fillStyle = INK;
      ctx.fillText(row.label, x + padX + swatchW + gap, centerY + 0.5);
    } else {
      // "+ N more" overflow note for truncated sub-row lists
      ctx.fillStyle = MUTED;
      ctx.fillText(row.label, x + padX + swatchW + gap, centerY + 0.5);
    }
    cursorY += h;
  });
  if (overflow > 0) {
    const centerY = cursorY + rowH / 2;
    ctx.fillStyle = MUTED;
    ctx.fillText(`+ ${overflow} more`, x + padX, centerY + 0.5);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

/**
 * Composite the requested details onto a captured map canvas (in place).
 * Call after `captureMapCanvas`; a no-op when nothing is enabled.
 */
export function drawMapDetails(
  canvas: HTMLCanvasElement,
  map: OLMap,
  options: ImageDetailOptions,
  units: UnitsSystem,
  legendEntries: MapLegendEntry[],
): void {
  if (!options.scaleBar && !options.legend && !options.northArrow) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  if (options.northArrow) drawNorthArrow(ctx, w);
  if (options.scaleBar) drawScaleBar(ctx, w, h, metersPerPixelAtCenter(map), units);
  if (options.legend) drawLegend(ctx, w, h, legendEntries);
}
