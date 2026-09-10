/**
 * circleDraw.ts — the draw toolbar's Circle tool.
 *
 * Two flavours of circle, both driven by an OL `Draw` interaction of type
 * 'Circle' (click the centre, move, click again to set the radius) and both
 * handed to the rest of the app as an ordinary **Polygon**:
 *
 *  - `geometric` — the circle of the *map projection*: every vertex sits at
 *    the same planar distance from the centre in EPSG:3857 units, so it is a
 *    perfect circle on screen. On the ground it is not — Web Mercator
 *    stretches lengths by sec(φ), so its true radius grows with latitude
 *    (AGENTS.md gotcha 19).
 *  - `geodesic` — the circle of the *earth*: every vertex sits at the same
 *    great-circle distance from the centre, built with `ol/geom/Polygon`'s
 *    `circular()` exactly like OpenLayers' own draw-shapes example. Exact on
 *    the ground, slightly squashed on screen away from the equator.
 *
 * Why polygons and not `ol/geom/Circle`: a Circle geometry cannot be written
 * to GeoJSON (the draw session, saved-layer persistence and every export
 * format are GeoJSON), has no vertices for the edit tool to grab, and is not
 * understood by the measurement, geoprocessing or attribute-table code. The
 * rectangle tool already sets the precedent — OL's own `createBox()` turns the
 * Circle sketch into a Polygon.
 *
 * A ring does not contain its own centre, though, and that is the coordinate a
 * circle is drawn from and measured against — so the draw session also drops a
 * **centre point** beside every circle it finishes. This module owns that
 * pairing's vocabulary: the geometry function reports the centre it built the
 * ring around, and the naming helpers here keep the point's name ('Circle 1
 * Center') derived from its circle's without letting it into the circle
 * counters.
 *
 * Framework-agnostic: no React, no map instance — coordinates in, a ring out.
 */
import Polygon, { circular } from 'ol/geom/Polygon.js';
import { fromUserCoordinate, getUserProjection, toUserCoordinate, transform } from 'ol/proj.js';
import { CircleDrawMode } from '../types';
import { greatCircleDistance } from './geodesic';

/**
 * Vertices around the circle. 128 matches OpenLayers' own geodesic-circle
 * example and stays smooth when zoomed in. The resulting polygon is dense, so
 * its on-map measurement labels show the area only — see
 * `buildMeasurementStyles(..., { circle: true })` in utils/measurement.ts.
 */
export const CIRCLE_DRAW_SEGMENTS = 128;

/** Projection the map view uses; also the fallback for direct calls. */
const DEFAULT_PROJECTION = 'EPSG:3857';

export interface CircleModeInfo {
  id: CircleDrawMode;
  /** Label in the tool's right-click submenu. */
  label: string;
  /** One-line explanation under that label. */
  description: string;
  /** Auto-name family for features drawn in this mode ('Circle 1', …). Kept
   *  distinct per mode so the two counters never collide. */
  namePrefix: string;
}

/**
 * The two modes, in submenu order. `namePrefix` values must not be prefixes of
 * one another — `circleDisplayName` counts existing names with `startsWith`.
 */
export const CIRCLE_MODES: CircleModeInfo[] = [
  {
    id: 'geometric',
    label: 'Circle geometry',
    description: 'Perfect circle on the map — radius in projected units',
    namePrefix: 'Circle',
  },
  {
    id: 'geodesic',
    label: 'Geodesic circle',
    description: 'True ground radius — follows the curvature of the earth',
    namePrefix: 'Geodesic Circle',
  },
];

/** Mode the Circle tool starts in. */
export const DEFAULT_CIRCLE_MODE: CircleDrawMode = 'geometric';

/** Every auto-name prefix the Circle tool can produce. */
export const CIRCLE_NAME_PREFIXES: string[] = CIRCLE_MODES.map((m) => m.namePrefix);

export function circleModeInfo(mode: CircleDrawMode): CircleModeInfo {
  return CIRCLE_MODES.find((m) => m.id === mode) || CIRCLE_MODES[0];
}

/** 'Circle' / 'Geodesic Circle' — used for counting and naming. */
export function circleNamePrefix(mode: CircleDrawMode): string {
  return circleModeInfo(mode).namePrefix;
}

/** Auto-name for a finished circle: 'Circle 3', 'Geodesic Circle 1'. */
export function circleDisplayName(mode: CircleDrawMode, count: number): string {
  return `${circleNamePrefix(mode)} ${count}`;
}

/** Short caption for the on-map hint bar while the tool is active. */
export function circleModeCaption(mode: CircleDrawMode): string {
  return mode === 'geodesic' ? 'Geodesic circle' : 'Circle geometry';
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Suffix of the auto-name given to the centre point the Circle tool drops
 *  next to its circle: 'Circle 1' → 'Circle 1 Center'. */
export const CIRCLE_CENTER_SUFFIX = 'Center';

/**
 * Auto-name for a circle's centre point, derived from the circle's own name so
 * the pair always reads together in the drawn-features list.
 */
export function circleCenterName(circleName: string): string {
  return `${circleName} ${CIRCLE_CENTER_SUFFIX}`;
}

/**
 * Counter predicate for the per-mode circle auto-names: 'Circle 3' counts for
 * `geometric`, 'Geodesic Circle 3' for `geodesic`, nothing else. A plain
 * `startsWith(prefix)` is no longer enough — the centre point dropped with a
 * circle is named after it ('Circle 3 Center'), so it would be counted as a
 * circle of its own and the next one would skip a number.
 */
export function countsAsCircleName(name: string, mode: CircleDrawMode): boolean {
  if (!name) return false;
  const prefix = circleNamePrefix(mode);
  if (!name.startsWith(prefix)) return false;
  return /^ \d+$/.test(name.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

/**
 * Planar ("circle geometry") ring: `segments` vertices at a constant distance
 * from the centre in the projection's own units, the first one pointing at the
 * radius handle — the same convention as OL's `createRegularPolygon()`.
 * Coordinates are in the map projection; the ring is closed.
 */
export function geometricCircleRing(
  center: number[],
  end: number[],
  segments: number = CIRCLE_DRAW_SEGMENTS,
): number[][] {
  const dx = end[0] - center[0];
  const dy = end[1] - center[1];
  const radius = Math.sqrt(dx * dx + dy * dy);
  const startAngle = Math.atan2(dy, dx);
  const sides = Math.max(3, Math.round(segments));
  const ring: number[][] = [];
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (2 * Math.PI * i) / sides;
    ring.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  ring.push(ring[0].slice());
  return ring;
}

/**
 * Ground-true ("geodesic circle") ring: `segments` vertices at a constant
 * great-circle distance from the centre, built by `circular()` in EPSG:4326 and
 * reprojected into the map projection (OpenLayers' own example does the same).
 * The radius is measured on the sphere through utils/geodesic.ts, never as a
 * planar Mercator distance.
 */
export function geodesicCircleRing(
  center: number[],
  end: number[],
  projection: any = DEFAULT_PROJECTION,
  segments: number = CIRCLE_DRAW_SEGMENTS,
): number[][] {
  const center4326 = transform(center as [number, number], projection, 'EPSG:4326') as [number, number];
  const end4326 = transform(end as [number, number], projection, 'EPSG:4326') as [number, number];
  const radius = greatCircleDistance(center4326, end4326);
  const circle = circular(center4326, radius, Math.max(3, Math.round(segments)));
  circle.transform('EPSG:4326', projection);
  return circle.getCoordinates()[0] as number[][];
}

// ---------------------------------------------------------------------------
// OL Draw wiring
// ---------------------------------------------------------------------------

/** The mode can be passed fixed, or read live so a submenu switch applies to
 *  the very next sketch without rebuilding the Draw interaction. */
export type CircleModeGetter = CircleDrawMode | (() => CircleDrawMode);

/**
 * What the geometry function last saw. `center` is the point the sketch was
 * struck from — the one coordinate of a circle that its finished ring does not
 * contain — reported so the draw session can drop a centre point next to the
 * circle. Both coordinates are in the same space as the returned geometry (the
 * user projection when one is set), and are copies: OL owns the arrays it hands
 * in and keeps mutating them while the sketch is live.
 */
export interface CircleSketchInfo {
  center: number[];
  radiusHandle: number[];
  mode: CircleDrawMode;
}

/**
 * `geometryFunction` for an OL `Draw` of type 'Circle'. Structurally the same
 * contract as OL's `createBox()` / `createRegularPolygon()`: build (or update
 * in place) a Polygon from the centre plus the current radius handle, honouring
 * a user projection when one is set.
 *
 * `onSketch` is called on every invocation — from OL's `drawstart` (centre
 * clicked, radius still zero) to the click that finishes the circle — with the
 * centre in map coordinates. OL does not call the geometry function again in
 * `finishDrawing()` for a Circle sketch, so the last report before `drawend` is
 * the finished circle's centre.
 */
export function createCircleGeometryFunction(
  getMode: CircleModeGetter,
  segments: number = CIRCLE_DRAW_SEGMENTS,
  onSketch?: (info: CircleSketchInfo) => void,
) {
  return function circleGeometryFunction(coordinates: any, geometry: any, projection?: any): Polygon {
    const mode = typeof getMode === 'function' ? getMode() : getMode;
    const proj = projection || DEFAULT_PROJECTION;
    // OL 10 hands the geometryFunction coordinates in the *user* projection
    // when one is set (this app never sets one) — mirror the built-ins.
    const center = fromUserCoordinate(coordinates[0], proj);
    const end = fromUserCoordinate(coordinates[coordinates.length - 1], proj);
    const ring = mode === 'geodesic'
      ? geodesicCircleRing(center, end, proj, segments)
      : geometricCircleRing(center, end, segments);
    const polygon: Polygon = geometry || new Polygon([]);
    polygon.setCoordinates([ring]);
    const userProjection = getUserProjection();
    if (userProjection) polygon.transform(proj, userProjection);
    if (onSketch) {
      onSketch({
        center: toUserCoordinate(center, proj).slice(),
        radiusHandle: toUserCoordinate(end, proj).slice(),
        mode,
      });
    }
    return polygon;
  };
}
