// ---------------------------------------------------------------------------
// autoName — automatic naming/labelling of drawn features from their
// geometry + layer context. Used by the magic wand ("Snap") commit path:
// the traced polygon is classified from its shape (building / road / area),
// or named from an existing vector feature's attributes when one sits under
// the polygon. Pure functions — no React, no OpenLayers.
// ---------------------------------------------------------------------------

import { UnitsSystem } from '../types';
import { formatArea } from './measurement';

/** Best-effort shape classes derived from a traced polygon's geometry. */
export type SnapGeometryClass = 'building' | 'road' | 'area';

/** Display label per class — used as the name prefix ("Building 1", …). */
export const SNAP_CLASS_LABELS: Record<SnapGeometryClass, string> = {
  building: 'Building',
  road: 'Road',
  area: 'Area',
};

/** A traced strip at least this elongated (bbox aspect) reads as a road. */
const ROAD_ASPECT_RATIO = 5;
/** Buildings are small-ish footprints… */
const BUILDING_MAX_AREA_SQM = 10000;
/** …that fill most of their bounding box (walls are rectilinear). */
const BUILDING_MIN_RECTANGULARITY = 0.65;

/**
 * Classify a traced polygon from its geometry (best effort — the shape
 * signals available without an AI classifier):
 *
 *  - long thin strips (bbox aspect >= 5)          → road
 *  - small (<= 10 000 m²) and fairly rectangular  → building
 *  - everything else                              → area
 *
 * `rings` are the polygon rings in map coordinates; `areaSqM` is the
 * geodesic area in square metres.
 */
export function classifySnapPolygon(rings: number[][][], areaSqM: number): SnapGeometryClass {
  const outer = rings && rings[0];
  if (!outer || outer.length < 3) return 'area';

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let shoelace = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    if (a[0] < minX) minX = a[0];
    if (a[0] > maxX) maxX = a[0];
    if (a[1] < minY) minY = a[1];
    if (a[1] > maxY) maxY = a[1];
    shoelace += a[0] * b[1] - b[0] * a[1];
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return 'area';

  const aspect = Math.max(w, h) / Math.min(w, h);
  if (aspect >= ROAD_ASPECT_RATIO) return 'road';

  const planarArea = Math.abs(shoelace) / 2;
  const rectangularity = planarArea / (w * h);
  if (areaSqM <= BUILDING_MAX_AREA_SQM && rectangularity >= BUILDING_MIN_RECTANGULARITY) {
    return 'building';
  }
  return 'area';
}

export interface SnapPrimaryNameInput {
  geometryClass: SnapGeometryClass;
  /** 1-based index of this polygon among features of the same class. */
  index: number;
  /** Layer context: the layer being re-edited, or (for the draw batch) the
   * topmost visible raster layer the object was traced from. */
  layerName?: string;
  /** A name-like attribute of an existing vector feature found under the
   * polygon — wins over the class-based name when present. */
  vectorFeatureName?: string;
}

/**
 * Build the primary (context-free) part of a snap feature's name:
 * the vector attribute when one was found ("Adelaide Hospital"), otherwise
 * class + index + optional layer context ("Building 2 (Ortho 2024)").
 */
export function buildSnapPrimaryName({
  geometryClass,
  index,
  layerName,
  vectorFeatureName,
}: SnapPrimaryNameInput): string {
  if (vectorFeatureName && vectorFeatureName.trim()) return vectorFeatureName.trim();
  const context = layerName && layerName.trim() ? ' (' + layerName.trim() + ')' : '';
  return SNAP_CLASS_LABELS[geometryClass] + ' ' + index + context;
}

/** Compose the full display name / on-map label: `Building 1 — 245.32 m²`. */
export function composeSnapName(primary: string, areaSqM: number, units: UnitsSystem): string {
  return primary + ' \u2014 ' + formatArea(areaSqM, units);
}
