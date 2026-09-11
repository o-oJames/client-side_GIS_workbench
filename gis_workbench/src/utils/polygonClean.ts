// ---------------------------------------------------------------------------
// polygonClean — clean-up of traced polygons: Douglas–Peucker simplification
// of jaggy outline rings (SAM magic-wand masks) in map coordinate space.
// Pure functions — no React, no OpenLayers.
// ---------------------------------------------------------------------------

import { Pt, ringSignedArea, simplifyRing } from './contourExtract';

/** Default clean-up strength in SAM encoder pixels. The mask resolution is
 * ~4 encoder px (256 mask upscaled to 1024), so 4 px smooths the staircase
 * jaggies without distorting the traced shape. */
export const DEFAULT_CLEANUP_TOLERANCE_PX = 4;

/** Slider bounds for the clean-up control, in encoder pixels. Minimum 0
 * keeps the outline exactly as traced. */
export const CLEANUP_TOLERANCE_MIN_PX = 0;
export const CLEANUP_TOLERANCE_MAX_PX = 10;

function toPt(coord: number[]): Pt {
  return { x: coord[0], y: coord[1] };
}

function toCoord(p: Pt): number[] {
  return [p.x, p.y];
}

/** True when a ring repeats its first coordinate at the end (closed form). */
export function isClosedRing(ring: number[][]): boolean {
  if (ring.length < 2) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

/** Number of unique vertices across a polygon's rings (closing duplicates
 * are not counted). */
export function countPolygonVertices(rings: number[][][]): number {
  return rings.reduce((sum, ring) => {
    if (ring.length === 0) return sum;
    return sum + ring.length - (isClosedRing(ring) ? 1 : 0);
  }, 0);
}

/**
 * Simplify a polygon's rings with Douglas–Peucker. `tolerance` is in the
 * same units as the ring coordinates (map units for traced polygons).
 *
 *  - Each ring keeps its original closure form (open rings stay open).
 *  - Holes that collapse below a triangle — or whose simplified area drops
 *    under half a tolerance square — are dropped silently.
 *  - The outer ring (index 0) always survives: when simplification would
 *    degenerate it, the original ring is kept instead.
 */
export function simplifyPolygonRings(rings: number[][][], tolerance: number): number[][][] {
  if (rings.length === 0) return [];
  if (tolerance <= 0) return rings.map((ring) => ring.map((c) => c.slice()));

  const out: number[][][] = [];
  rings.forEach((ring, ringIndex) => {
    const closed = isClosedRing(ring);
    const open = closed ? ring.slice(0, -1) : ring.slice();

    // Triangles have nothing to clean up.
    if (open.length < 4) {
      if (ringIndex === 0) out.push(ring.map((c) => c.slice()));
      return;
    }

    const simplified = simplifyRing(open.map(toPt), tolerance);
    const area = Math.abs(ringSignedArea(simplified));

    if (simplified.length < 3 || area < (tolerance * tolerance) / 2) {
      // Degenerate result: keep the outer ring as-is, drop degenerate holes.
      if (ringIndex === 0) out.push(ring.map((c) => c.slice()));
      return;
    }

    const coords = simplified.map(toCoord);
    if (closed) coords.push([coords[0][0], coords[0][1]]);
    out.push(coords);
  });

  return out.length > 0 ? out : rings.map((ring) => ring.map((c) => c.slice()));
}
