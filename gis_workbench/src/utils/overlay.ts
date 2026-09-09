/**
 * overlay.ts — the planar overlay kernel behind the "Vector Tools" panel.
 *
 * WHY THIS EXISTS
 * ---------------
 * Up to Stage 1 every boolean operation in the panel was a bespoke special
 * case: Sutherland–Hodgman half-plane clipping (exact only for convex cutters),
 * a "walk the two rings and hop at the crossings" union that fell back to a
 * convex hull when it got confused, and a shared-edge splice that only worked
 * on node-matched neighbours. Those are the reasons Clip lost concave corners,
 * Dissolve inflated overlapping parcels, and Make Valid threw away 3 of the 4
 * lobes of a self-intersecting polygon.
 *
 * This module replaces all of them with one kernel, modelled on the algorithm
 * JTS OverlayNG (and therefore GEOS/QGIS/PostGIS) uses:
 *
 *   1. NODE     — split every segment at every crossing, at every vertex that
 *                 lands on another segment, and along every collinear overlap,
 *                 then snap the results into a shared node table so coincident
 *                 geometry (two parcels sharing a boundary) becomes ONE edge.
 *   2. LABEL    — sample a point either side of each noded edge's midpoint and
 *                 ask every subject geometry whether it contains that point.
 *                 Those two-sided location labels are what makes "a polygon
 *                 inside another polygon" and "two polygons merely touching"
 *                 both come out right; per-ring clipping can never express
 *                 them because it only knows about the edge's own parent ring.
 *   3. SELECT   — keep an edge only where the two sides disagree about
 *                 membership of the result region, and orient it so the result
 *                 region lies on its LEFT.
 *   4. ASSEMBLE — walk the kept edges into minimal cycles (shells come out CCW,
 *                 holes CW) and nest each hole into the shell that contains it.
 *
 * Because step 2 asks the *original* geometries (through an R-tree of their
 * rings) rather than the parent ring, one pass handles N subjects. That gives
 * N-way union — QGIS "Dissolve", PostGIS `ST_Union(geom[])` — for free, with no
 * cascading and no convex-hull fallback.
 *
 * ROBUSTNESS NOTES
 * ----------------
 * - There is no exact-arithmetic predicate here. Instead the kernel snaps
 *   intersection results into a node table with a tolerance derived from the
 *   data extent (`scaleTolerance`), which is what GEOS's precision-reduction
 *   path does. Below that tolerance the answer is defined to be "the same
 *   point", so coincident boundaries stay coincident.
 * - Sampling distance for the labels is derived per edge from the distance to
 *   the nearest other noded edge, so a label can never be taken from the wrong
 *   side of a nearby boundary.
 * - Ring assembly is guarded: a walk that cannot close (which only happens if
 *   floating point produced a degree imbalance) is abandoned rather than
 *   spinning, and sliver rings below `minRingArea` are dropped.
 * - Degenerate results are dropped, never invented: an empty overlay returns
 *   `null` so callers can report "no result" instead of emitting a phantom.
 */
import {
  ExtentIndex,
  emptyExtent,
  extentOfCoords,
  extentSpan,
  expandExtent,
  unionExtent,
  type Extent4,
} from './geomIndex';
import {
  geometryParts,
  isAreaGeometry,
  lineSequences,
  partsToGeometry,
  pointCoords,
  type Coord,
  type GeoGeom,
  type Ring,
} from './geoTypes';

export type OverlayOp = 'union' | 'intersection' | 'difference' | 'symDifference';

export interface OverlayOptions {
  /**
   * Node-snapping tolerance in map units. Derived from the extent of every
   * subject when omitted — never pass a bare 1e-9 for EPSG:3857 data, where
   * ordinates are ~1.5e7 and the double spacing is ~2e-9.
   */
  tolerance?: number;
  /** Rings smaller than this (map units²) are treated as slivers and dropped. */
  minRingArea?: number;
}

// ---------------------------------------------------------------------------
// Small geometry primitives
// ---------------------------------------------------------------------------

/** Tolerance floor, matching utils/geoprocessing. */
export const OVERLAY_MIN_TOLERANCE = 1e-6;

/** Tolerance as a fraction of the data span (1 mm per 1 000 km). */
const OVERLAY_TOLERANCE_FACTOR = 1e-11;

function dist2(a: Coord, b: Coord): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function dist(a: Coord, b: Coord): number {
  return Math.sqrt(dist2(a, b));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Are two segments indistinguishable from parallel, at this snapping tolerance?
 *
 * `den` is the 2-D cross product of the two direction vectors, so
 * |den| = len1 · len2 · sin θ and `sin θ · min(len1, len2)` is the perpendicular
 * offset the two directions accumulate over the shorter segment. Once that is
 * below the tolerance the pair cannot be told apart from collinear, and solving
 * it as "crossing" divides by a `den` that is nothing but noise.
 *
 * WHY NOT A RELATIVE EPSILON. The obvious test, `|den| > 1e-14 · len1 · len2`,
 * looks scale-free but is not: `den` is built from DIFFERENCES of ordinates. At
 * EPSG:3857 magnitudes (|x| ~ 1.5e7) every difference carries ~2e-9 of
 * cancellation error, so `den` carries ~1e-7 — a thousand times the 1e-14·len²
 * threshold. Exactly-collinear edges then read as "barely not parallel", the
 * solver invents a crossing, and whether a geometry counts as VALID stops
 * depending on its shape and starts depending on where on Earth it sits. A
 * property test caught exactly that: one ring, bit for bit identical, validated
 * clean at (0, 0) and as self-intersecting at (1.5e7, −4e6).
 *
 * The old relative term survives inside the max(), so this can only ever become
 * more conservative about calling a pair "crossing", never less.
 */
function segmentsParallel(den: number, len1: number, len2: number, tolerance: number): boolean {
  return Math.abs(den) <= Math.max(1e-14 * len1 * len2, tolerance * Math.max(len1, len2));
}

/**
 * Signed area with the STANDARD mathematical sign: positive = counter-clockwise.
 *
 * Deliberately not shared with `geoprocessing.ts`, whose historical `signedArea`
 * uses the surveyor form and therefore has the opposite sign (a trap that
 * already inverted every clip half-plane once). Anything in this module that
 * needs an orientation uses this one.
 */
export function ringSignedArea(ring: Ring): number {
  let sum = 0;
  const n = ring.length;
  const last = n > 0 && dist2(ring[0], ring[n - 1]) === 0 ? n - 1 : n;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % last;
    sum += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * A copy of `ring` that ends with its first coordinate, snapping a last vertex
 * that is already within `tolerance` of the first onto it.
 *
 * Without the snap, a ring "closed to within tolerance" contributes a microscopic
 * closing segment whose far end is within tolerance of the ring's first vertex —
 * which the contact scanner then reports as a disconnected interior.
 */
export function closeWithinTolerance(ring: Ring, tolerance: number): Ring {
  if (ring.length === 0) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice();
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= tolerance) {
    return [...ring.slice(0, -1), [first[0], first[1]] as Coord];
  }
  return [...ring, [first[0], first[1]] as Coord];
}

/** A copy of `ring` that ends with its first coordinate. */
export function asClosedRing(ring: Ring): Ring {
  if (ring.length === 0) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, [first[0], first[1]] as Coord];
  return ring.slice();
}

/** Is the ring counter-clockwise (standard mathematical orientation)? */
export function isRingCcw(ring: Ring): boolean {
  return ringSignedArea(ring) > 0;
}

/** Distance from point p to the segment ab. */
function pointSegmentDistance(p: Coord, a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = clamp01(t);
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

/**
 * Winding number of a closed ring around p (positive = the ring turns
 * counter-clockwise around it).
 *
 * Used instead of a plain even-odd crossing count so that a ring which covers the
 * same ground twice (a self-overlapping buffer curve) and a ring whose two lobes
 * wind in opposite directions (a bowtie) are both still "inside".
 */
function windingNumberOfRing(p: Coord, ring: Ring): number {
  let winding = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && cross > 0) winding++;
    } else if (b[1] <= p[1] && cross < 0) {
      winding--;
    }
  }
  return winding;
}

/** Even-odd ray casting inside a single ring. */
function pointInClosedRing(p: Coord, ring: Ring): boolean {
  let inside = false;
  const n = ring.length - 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is p exactly on any edge of the ring (within tolerance)? */
function pointOnRing(p: Coord, ring: Ring, tolerance: number): boolean {
  for (let i = 0; i < ring.length - 1; i++) {
    if (pointSegmentDistance(p, ring[i], ring[i + 1]) <= tolerance) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Node table — snap-rounding of intersection results
// ---------------------------------------------------------------------------

/**
 * Maps coordinates onto shared node ids.
 *
 * Two coordinates within `tolerance` become the same node, which is what lets
 * the shared boundary of two adjacent parcels collapse into a single edge
 * instead of two edges a float-noise-width apart.
 */
class NodeMap {
  readonly coords: Coord[] = [];
  private cells = new Map<string, number[]>();

  constructor(private tolerance: number) {}

  private cellKey(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  id(p: Coord): number {
    const cell = Math.max(this.tolerance, 1e-12);
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    const tolSq = this.tolerance * this.tolerance;
    let best = -1;
    let bestD = tolSq;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const list = this.cells.get(this.cellKey(ix, iy));
        if (!list) continue;
        for (const id of list) {
          const d = dist2(this.coords[id], p);
          if (d <= bestD) { bestD = d; best = id; }
        }
      }
    }
    if (best >= 0) return best;
    const id = this.coords.length;
    this.coords.push([p[0], p[1]]);
    const key = this.cellKey(cx, cy);
    const list = this.cells.get(key);
    if (list) list.push(id); else this.cells.set(key, [id]);
    return id;
  }
}

// ---------------------------------------------------------------------------
// Point location against a subject geometry
// ---------------------------------------------------------------------------

/** Indexed rings of one geometry, for nonzero-winding point location. */
class RingLocator {
  private rings: Ring[] = [];
  private index = new ExtentIndex<number>();
  readonly extent: Extent4 = emptyExtent();

  constructor(geom: GeoGeom | null, private tolerance: number) {
    const rings: Ring[] = [];
    for (const part of geometryParts(geom)) {
      part.forEach((raw, ri) => {
        const closed = asClosedRing(raw);
        if (closed.length < 4) return;
        const area = ringSignedArea(closed);
        const isShell = ri === 0;
        // Normalise the orientation structurally (ring 0 is the shell, the rest
        // are holes) rather than trusting the source data: GeoJSON says shells
        // are CCW and holes CW, but plenty of real layers do not obey it, and the
        // winding rule below depends on the two disagreeing. A ring whose lobes
        // cancel out (a bowtie, area 0) has no orientation to normalise to and is
        // kept as written — its winding number is still ±1 inside each lobe.
        rings.push(area === 0 || (isShell ? area > 0 : area < 0) ? closed : closed.slice().reverse());
      });
    }
    this.rings = rings;
    if (rings.length > 0) {
      this.index.load(rings.map(r => extentOfCoords(r)), rings.map((_, i) => i));
      let ext = emptyExtent();
      for (const r of rings) ext = unionExtent(ext, extentOfCoords(r));
      this.extent = ext;
    }
  }

  get isEmpty(): boolean {
    return this.rings.length === 0;
  }

  /**
   * Nonzero-winding membership: shells add +1, holes −1.
   *
   * Even-odd would be wrong here. A buffer's offset curve can loop over itself at
   * a sharp mitre, and a Make Valid input can cover the same ground twice; under
   * even-odd that doubly-covered ground reads as OUTSIDE and the repair silently
   * cuts a hole in it (a sharp-bend mitre buffer came back 20 % short). Nonzero
   * winding keeps the coverage, and still cancels a shell against its own hole.
   */
  contains(p: Coord): boolean {
    if (this.rings.length === 0) return false;
    let winding = 0;
    for (const i of this.index.query([p[0], p[1], p[0], p[1]])) {
      winding += windingNumberOfRing(p, this.rings[i]);
    }
    return winding !== 0;
  }

  /** Membership where landing exactly on the boundary counts as inside. */
  containsOrTouches(p: Coord): boolean {
    if (this.contains(p)) return true;
    for (const i of this.index.query([p[0], p[1], p[0], p[1]])) {
      if (pointOnRing(p, this.rings[i], this.tolerance)) return true;
    }
    return false;
  }
}

/**
 * "Which subjects contain this point?" for the whole subject list, pruned by an
 * R-tree of subject extents so labelling an edge costs O(log n + hits) rather
 * than O(n) point-in-polygon tests.
 */
export class SubjectLocator {
  private locators: RingLocator[];
  private index = new ExtentIndex<number>();
  /** Subject ids that contribute area at all. */
  readonly areaSubjects: number[] = [];

  constructor(geoms: (GeoGeom | null)[], tolerance: number) {
    this.locators = geoms.map(g => new RingLocator(isAreaGeometry(g) ? g : null, tolerance));
    const extents: Extent4[] = [];
    const ids: number[] = [];
    this.locators.forEach((loc, i) => {
      if (loc.isEmpty) return;
      this.areaSubjects.push(i);
      extents.push(loc.extent);
      ids.push(i);
    });
    this.index.load(extents, ids);
  }

  subjectsContaining(p: Coord): number[] {
    const out: number[] = [];
    for (const i of this.index.query([p[0], p[1], p[0], p[1]])) {
      if (this.locators[i].contains(p)) out.push(i);
    }
    return out;
  }

  contains(subject: number, p: Coord): boolean {
    return this.locators[subject]?.contains(p) === true;
  }

  containsOrTouches(subject: number, p: Coord): boolean {
    return this.locators[subject]?.containsOrTouches(p) === true;
  }
}

/** Nonzero-winding point location against one geometry (holes subtracted). */
export function pointInGeometry(p: Coord, geom: GeoGeom | null, tolerance = OVERLAY_MIN_TOLERANCE): boolean {
  return new RingLocator(geom, tolerance).contains(p);
}

// ---------------------------------------------------------------------------
// Step 1 — noding
// ---------------------------------------------------------------------------

interface SplitRec { t: number; p: Coord }

interface RawSegment {
  a: Coord;
  b: Coord;
  subject: number;
  area: boolean;
  splits: SplitRec[];
}

interface SubSegment {
  a: Coord;
  b: Coord;
  subject: number;
  area: boolean;
}

/** Collect the segments of every subject: polygon rings (area) + line parts. */
function collectRawSegments(geoms: (GeoGeom | null)[], wantArea: boolean, wantLines: boolean): RawSegment[] {
  const raw: RawSegment[] = [];
  const pushRing = (ring: Ring, subject: number) => {
    const closed = asClosedRing(ring);
    for (let i = 0; i < closed.length - 1; i++) {
      const a = closed[i];
      const b = closed[i + 1];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      raw.push({ a, b, subject, area: true, splits: [] });
    }
  };
  const pushLine = (coords: Coord[], subject: number) => {
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      raw.push({ a, b, subject, area: false, splits: [] });
    }
  };

  geoms.forEach((geom, subject) => {
    if (!geom) return;
    if (wantArea && isAreaGeometry(geom)) {
      for (const part of geometryParts(geom)) for (const ring of part) pushRing(ring, subject);
    }
    if (wantLines) {
      for (const seq of lineSequences(geom)) pushLine(seq, subject);
    }
  });
  return raw;
}

/**
 * Record where two segments cross, pushing the SAME coordinate object onto both
 * segments' split lists so the two halves agree to the last bit.
 */
function intersectPair(s1: RawSegment, s2: RawSegment, tolerance: number): void {
  const d1x = s1.b[0] - s1.a[0];
  const d1y = s1.b[1] - s1.a[1];
  const d2x = s2.b[0] - s2.a[0];
  const d2y = s2.b[1] - s2.a[1];
  const len1 = Math.hypot(d1x, d1y);
  const len2 = Math.hypot(d2x, d2y);
  if (len1 === 0 || len2 === 0) return;

  const rx = s2.a[0] - s1.a[0];
  const ry = s2.a[1] - s1.a[1];
  const den = d1x * d2y - d1y * d2x;

  // Non-parallel: single crossing (proper or T-shaped).
  if (!segmentsParallel(den, len1, len2, tolerance)) {
    const t = (rx * d2y - ry * d2x) / den;
    const u = (rx * d1y - ry * d1x) / den;
    const tTol = Math.min(0.5, tolerance / len1);
    const uTol = Math.min(0.5, tolerance / len2);
    if (t < -tTol || t > 1 + tTol || u < -uTol || u > 1 + uTol) return;
    const tc = clamp01(t);
    const uc = clamp01(u);
    // Average the two ways of computing the point: symmetric, so the split does
    // not depend on which segment was enumerated first.
    const p: Coord = [
      0.5 * (s1.a[0] + tc * d1x + s2.a[0] + uc * d2x),
      0.5 * (s1.a[1] + tc * d1y + s2.a[1] + uc * d2y),
    ];
    if (tc > tTol && tc < 1 - tTol) s1.splits.push({ t: tc, p });
    if (uc > uTol && uc < 1 - uTol) s2.splits.push({ t: uc, p });
    return;
  }

  // Parallel — only collinear overlaps can split anything.
  if (Math.abs(rx * d1y - ry * d1x) > tolerance * len1) return;
  const len1sq = len1 * len1;
  const u1 = ((s2.a[0] - s1.a[0]) * d1x + (s2.a[1] - s1.a[1]) * d1y) / len1sq;
  const u2 = ((s2.b[0] - s1.a[0]) * d1x + (s2.b[1] - s1.a[1]) * d1y) / len1sq;
  const lo = Math.max(0, Math.min(u1, u2));
  const hi = Math.min(1, Math.max(u1, u2));
  if (lo > hi + tolerance / len1) return;
  for (const t of [lo, hi]) {
    const tc = clamp01(t);
    const p: Coord = [s1.a[0] + tc * d1x, s1.a[1] + tc * d1y];
    const len2sq = len2 * len2;
    const u = ((p[0] - s2.a[0]) * d2x + (p[1] - s2.a[1]) * d2y) / len2sq;
    const tTol = Math.min(0.5, tolerance / len1);
    const uTol = Math.min(0.5, tolerance / len2);
    if (tc > tTol && tc < 1 - tTol) s1.splits.push({ t: tc, p });
    if (u > uTol && u < 1 - uTol) s2.splits.push({ t: clamp01(u), p });
  }
}

/** Split one segment at its recorded parameters. */
function splitSegment(seg: RawSegment, tolerance: number): SubSegment[] {
  const out: SubSegment[] = [];
  const push = (a: Coord, b: Coord) => {
    if (dist(a, b) <= tolerance) return;
    out.push({ a, b, subject: seg.subject, area: seg.area });
  };
  if (seg.splits.length === 0) {
    push(seg.a, seg.b);
    return out;
  }
  seg.splits.sort((p, q) => p.t - q.t);
  const chain: Coord[] = [seg.a];
  for (const split of seg.splits) {
    if (dist(chain[chain.length - 1], split.p) <= tolerance) continue;
    chain.push(split.p);
  }
  for (let i = 0; i < chain.length - 1; i++) push(chain[i], chain[i + 1]);
  push(chain[chain.length - 1], seg.b);
  return out;
}

/** One noded edge of the planar graph. */
interface TopoEdge {
  a: number;
  b: number;
  area: boolean;
  /** Subject ids whose AREA boundary this edge belongs to (may be several). */
  areaOwners: number[];
  /** Subject ids whose LINE geometry this edge belongs to (may be several). */
  lineOwners: number[];
  /** Subject ids covering the left side of a→b (filled by `labelEdges`). */
  left: number[];
  /** Subject ids covering the right side of a→b. */
  right: number[];
}

interface Topology {
  nodes: Coord[];
  edges: TopoEdge[];
  tolerance: number;
  extent: Extent4;
}

/** Node every segment of every subject and merge coincident results. */
function buildTopology(
  geoms: (GeoGeom | null)[],
  tolerance: number,
  wantArea: boolean,
  wantLines: boolean
): Topology {
  const raw = collectRawSegments(geoms, wantArea, wantLines);
  const nodes = new NodeMap(tolerance);
  if (raw.length === 0) {
    return { nodes: nodes.coords, edges: [], tolerance, extent: emptyExtent() };
  }

  // Pairwise intersection candidates, pruned by an R-tree of segment boxes.
  const boxes = raw.map(s => extentOfCoords([s.a, s.b]));
  const segIndex = new ExtentIndex<number>();
  segIndex.load(boxes, raw.map((_, i) => i));
  for (let i = 0; i < raw.length; i++) {
    for (const j of segIndex.query(expandExtent(boxes[i], tolerance))) {
      if (j <= i) continue;
      intersectPair(raw[i], raw[j], tolerance);
    }
  }

  const subs: SubSegment[] = [];
  for (const seg of raw) subs.push(...splitSegment(seg, tolerance));

  const edges: TopoEdge[] = [];
  const byKey = new Map<string, TopoEdge>();
  let extent = emptyExtent();
  for (const sub of subs) {
    const a = nodes.id(sub.a);
    const b = nodes.id(sub.b);
    if (a === b) continue; // collapsed by snapping — degenerate
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let edge = byKey.get(key);
    if (!edge) {
      edge = { a, b, area: sub.area, areaOwners: [], lineOwners: [], left: [], right: [] };
      byKey.set(key, edge);
      edges.push(edge);
      extent = unionExtent(extent, extentOfCoords([nodes.coords[a], nodes.coords[b]]));
    }
    if (sub.area) {
      edge.area = true;
      if (!edge.areaOwners.includes(sub.subject)) edge.areaOwners.push(sub.subject);
    } else if (!edge.lineOwners.includes(sub.subject)) {
      edge.lineOwners.push(sub.subject);
    }
  }
  return { nodes: nodes.coords, edges, tolerance, extent };
}

// ---------------------------------------------------------------------------
// Step 2 — labelling
// ---------------------------------------------------------------------------

/**
 * Give every area edge its two-sided location labels.
 *
 * The sample offset is derived from the distance to the nearest OTHER noded
 * edge, so a label can never be read from across a boundary that is closer than
 * the sample. Noding guarantees that distance is non-zero: a noded edge has no
 * node in its interior.
 */
function labelEdges(topo: Topology, locator: SubjectLocator): void {
  const areaEdges = topo.edges.filter(e => e.area);
  if (areaEdges.length === 0) return;
  const index = new ExtentIndex<number>();
  index.load(
    areaEdges.map(e => extentOfCoords([topo.nodes[e.a], topo.nodes[e.b]])),
    areaEdges.map((_, i) => i)
  );

  for (const edge of areaEdges) {
    const na = topo.nodes[edge.a];
    const nb = topo.nodes[edge.b];
    const length = dist(na, nb);
    if (length === 0) continue;
    const mid: Coord = [(na[0] + nb[0]) / 2, (na[1] + nb[1]) / 2];

    let nearest = Infinity;
    const box: Extent4 = [mid[0] - length / 2, mid[1] - length / 2, mid[0] + length / 2, mid[1] + length / 2];
    for (const i of index.query(box)) {
      const other = areaEdges[i];
      if (other === edge) continue;
      const d = pointSegmentDistance(mid, topo.nodes[other.a], topo.nodes[other.b]);
      if (d < nearest) nearest = d;
    }
    let eps = Math.min(length * 0.25, nearest * 0.5);
    // A spike can push `nearest` to ~0; never sample below float noise.
    if (!Number.isFinite(eps) || eps <= length * 1e-9) eps = length * 1e-6;

    // Left normal of a→b.
    const nx = -(nb[1] - na[1]) / length;
    const ny = (nb[0] - na[0]) / length;
    edge.left = locator.subjectsContaining([mid[0] + nx * eps, mid[1] + ny * eps]);
    edge.right = locator.subjectsContaining([mid[0] - nx * eps, mid[1] - ny * eps]);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — selection
// ---------------------------------------------------------------------------

function isMember(set: number[], op: OverlayOp, areaSubjects: number[]): boolean {
  switch (op) {
    case 'union':
      return set.length > 0;
    case 'intersection':
      return areaSubjects.length > 0 && areaSubjects.every(id => set.includes(id));
    case 'difference':
      // In subject 0 and in nothing else.
      return set.length > 0 && set.every(id => id === 0);
    case 'symDifference':
      // Covered an odd number of times — GEOS's ST_SymDifference over a set.
      return set.length % 2 === 1;
  }
}

interface OrientedEdge { a: number; b: number }

/**
 * Keep the edges that bound the result region, oriented with the region on
 * their left. An edge whose two sides agree about membership is interior to the
 * result (or exterior to it) and disappears — that is how the shared boundary
 * of two dissolved parcels is removed.
 */
function selectEdges(topo: Topology, op: OverlayOp, areaSubjects: number[]): OrientedEdge[] {
  const out: OrientedEdge[] = [];
  for (const edge of topo.edges) {
    if (!edge.area) continue;
    const leftIn = isMember(edge.left, op, areaSubjects);
    const rightIn = isMember(edge.right, op, areaSubjects);
    if (leftIn === rightIn) continue;
    out.push(leftIn ? { a: edge.a, b: edge.b } : { a: edge.b, b: edge.a });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 4 — ring assembly
// ---------------------------------------------------------------------------

/**
 * Walk oriented edges into minimal cycles.
 *
 * At each node the next edge is the one that turns furthest LEFT from the
 * incoming direction (the predecessor, in counter-clockwise order, of the
 * reverse-incoming bearing). That traces every face once with its interior on
 * the left, so shells come out CCW and holes CW.
 */
function assembleRings(edges: OrientedEdge[], nodes: Coord[]): Ring[] {
  if (edges.length === 0) return [];
  const bearings = edges.map(e => Math.atan2(nodes[e.b][1] - nodes[e.a][1], nodes[e.b][0] - nodes[e.a][0]));
  const outgoing = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const list = outgoing.get(e.a);
    if (list) list.push(i); else outgoing.set(e.a, [i]);
  });
  for (const list of outgoing.values()) list.sort((i, j) => bearings[i] - bearings[j]);

  const used = new Uint8Array(edges.length);
  const rings: Ring[] = [];
  const TWO_PI = Math.PI * 2;

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const ring: Coord[] = [];
    let current = start;
    let closed = false;
    // A face can never be longer than the whole edge set; the guard turns any
    // floating-point degree imbalance into a dropped ring instead of a hang.
    let guard = edges.length + 2;
    while (guard-- > 0) {
      if (used[current] && current !== start) break;
      used[current] = 1;
      const edge = edges[current];
      ring.push(nodes[edge.a]);
      const back = Math.atan2(nodes[edge.a][1] - nodes[edge.b][1], nodes[edge.a][0] - nodes[edge.b][0]);
      const list = outgoing.get(edge.b);
      if (!list) break;
      let next = -1;
      let bestDelta = Infinity;
      for (const candidate of list) {
        // Predecessor of `back` in CCW order: the largest bearing strictly
        // below it. Ties (a 180° backtrack) sort last, so spikes are not
        // walked into unless there is no alternative.
        let delta = back - bearings[candidate];
        while (delta <= 1e-12) delta += TWO_PI;
        while (delta > TWO_PI) delta -= TWO_PI;
        if (delta < bestDelta) { bestDelta = delta; next = candidate; }
      }
      if (next < 0) break;
      if (next === start) { closed = true; break; }
      current = next;
    }
    if (!closed || ring.length < 3) continue;
    ring.push([ring[0][0], ring[0][1]]);
    rings.push(ring);
  }
  return rings;
}

/**
 * A point strictly inside `ring`, or null.
 *
 * Scanline method (what JTS's InteriorPointArea does): for a horizontal line
 * through one of the ring's own vertices, pair up the crossings and take the
 * middle of the widest inside interval. Unlike "use the centroid" this cannot
 * return a point outside a concave or C-shaped ring.
 */
export function ringInteriorPoint(ring: Ring): Coord | null {
  const closed = asClosedRing(ring);
  if (closed.length < 4) return null;

  // Scan lines are taken strictly BETWEEN distinct vertex y values. Sampling a
  // vertex's own y (the obvious choice) lands the candidate on the boundary of
  // horizontal edges, which is exactly the "interior point" that is not.
  const distinct = Array.from(new Set(closed.slice(0, -1).map(c => c[1]))).sort((a, b) => a - b);
  const bands: number[] = [];
  const step = distinct.length > 65 ? Math.ceil((distinct.length - 1) / 64) : 1;
  for (let i = 0; i + 1 < distinct.length; i += step) {
    bands.push((distinct[i] + distinct[i + 1]) / 2);
  }

  let best: Coord | null = null;
  let bestWidth = 0;
  for (const y of bands) {
    const xs: number[] = [];
    for (let i = 0; i < closed.length - 1; i++) {
      const p1 = closed[i];
      const p2 = closed[i + 1];
      if ((p1[1] > y) === (p2[1] > y)) continue;
      xs.push(p1[0] + ((y - p1[1]) * (p2[0] - p1[0])) / (p2[1] - p1[1]));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1] - xs[i];
      if (width > bestWidth) {
        bestWidth = width;
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    }
  }
  if (best && pointInClosedRing(best, closed)) return best;
  let sx = 0, sy = 0;
  for (let i = 0; i < closed.length - 1; i++) { sx += closed[i][0]; sy += closed[i][1]; }
  const centroid: Coord = [sx / (closed.length - 1), sy / (closed.length - 1)];
  return pointInClosedRing(centroid, closed) ? centroid : best;
}

/**
 * A point guaranteed to lie inside the geometry (holes excluded), or null.
 * This is the "Point on surface" answer: unlike the centroid it can never fall
 * outside a concave polygon or into a hole.
 */
export function geometryInteriorPoint(geom: GeoGeom | null): Coord | null {
  const parts = geometryParts(geom);
  let best: Coord | null = null;
  let bestWidth = 0;

  for (const part of parts) {
    const [shell, ...holes] = part;
    if (!shell) continue;
    const closed = asClosedRing(shell);
    if (closed.length < 4) continue;
    const holeRings = holes.map(asClosedRing).filter(h => h.length >= 4);
    const allRings = [closed, ...holeRings];

    // Scan lines strictly between the distinct vertex y values of the shell AND
    // its holes: a hole can cover the whole widest interval of the shell, and a
    // line through a vertex can land the candidate on a boundary.
    const distinct = Array.from(new Set(allRings.flatMap(r => r.slice(0, -1).map(c => c[1])))).sort((a, b) => a - b);
    const step = distinct.length > 65 ? Math.ceil((distinct.length - 1) / 64) : 1;
    for (let k = 0; k + 1 < distinct.length; k += step) {
      const y = (distinct[k] + distinct[k + 1]) / 2;
      const xs: number[] = [];
      for (const ring of allRings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const p1 = ring[i];
          const p2 = ring[i + 1];
          if ((p1[1] > y) === (p2[1] > y)) continue;
          xs.push(p1[0] + ((y - p1[1]) * (p2[0] - p1[0])) / (p2[1] - p1[1]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      // Even-odd pairing over shell + holes: each pair is a run that is inside
      // the shell and outside every hole.
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const width = xs[i + 1] - xs[i];
        if (width > bestWidth) {
          bestWidth = width;
          best = [(xs[i] + xs[i + 1]) / 2, y];
        }
      }
    }
  }
  if (best) return best;

  // Degenerate or sliver polygons: fall back to anything defensible.
  for (const part of parts) {
    const p = part[0] ? ringInteriorPoint(part[0]) : null;
    if (p) return p;
  }
  const coords = pointCoords(geom);
  if (coords.length > 0) return coords[0];
  for (const seq of lineSequences(geom)) {
    if (seq.length >= 2) return [(seq[0][0] + seq[1][0]) / 2, (seq[0][1] + seq[1][1]) / 2];
    if (seq.length === 1) return seq[0];
  }
  return null;
}

/**
 * Split a ring that visits the same node more than once into its lobes.
 *
 * WHY: a minimal-cycle walk through a planar subdivision cannot tell the
 * difference between "one region" and "two regions that meet at a single point".
 * Where two lobes CROSS, noding gives the shared node four distinct edges and the
 * turn rule splits them naturally. Where they merely TOUCH — two parcels meeting
 * corner to corner, a locality whose shell pinches to a point — the walk goes
 * straight through and returns one figure-eight ring. That ring is invalid
 * (GEOS "Disconnected Interior"), so an overlay of perfectly valid input could
 * come back failing its own Check Validity, and Make Valid could not repair a
 * pinched polygon at all.
 *
 * GEOS/JTS split at these articulation points and emit one part per lobe, which
 * is valid: the OGC allows MultiPolygon parts to meet at a finite number of
 * points. Two real features from sample/australian-suburbs.geojson are the
 * regression fixtures (NSW778's pinched shell, and SA153/SA210005766 whose
 * symmetric difference pinches where the two localities touch).
 *
 * Peeling lobes preserves signed area exactly (the pinch node contributes none),
 * so this can only ever re-partition a result, never resize it. Coordinates come
 * from the node table, so a repeated node is bit-identical and no tolerance is
 * needed to recognise it.
 */
function splitPinchedRing(ring: Ring): Ring[] {
  const closed = asClosedRing(ring);
  let open = closed.slice(0, -1);
  const lobes: Ring[] = [];
  // A ring can pinch at several nodes; peel one lobe off at a time. The guard is
  // a hard stop on pathological input, not an expected iteration count.
  for (let guard = 0; guard < 8192 && open.length >= 3; guard++) {
    const firstSeen = new Map<string, number>();
    let pinchAt = -1;
    let pinchFrom = -1;
    for (let i = 0; i < open.length; i++) {
      const key = `${open[i][0]}|${open[i][1]}`;
      const prev = firstSeen.get(key);
      if (prev !== undefined) {
        pinchFrom = prev;
        pinchAt = i;
        break;
      }
      firstSeen.set(key, i);
    }
    if (pinchAt < 0) break; // no repeated node: the rest of the ring is simple
    // The lobe runs pinchFrom -> pinchAt and is ALREADY closed, because both ends
    // are the same node. The remainder is the other way round the cycle: it starts
    // at the pinch node, walks to the end, wraps to the front and stops just
    // before the pinch node — so the pinch node must be kept exactly ONCE.
    // Keeping it twice (slice(0, pinchFrom + 1) + slice(pinchAt)) makes the next
    // pass find the same pair again, peel a 2-point spike, and never terminate.
    const lobe = open.slice(pinchFrom, pinchAt + 1);
    open = open.slice(0, pinchFrom).concat(open.slice(pinchAt));
    if (lobe.length >= 4 && Math.abs(ringSignedArea(lobe)) > 0) lobes.push(lobe);
    // A spike (out and straight back) is degenerate: dropped above, keep walking.
    if (open.length < 3) {
      open = [];
      break;
    }
  }
  if (open.length >= 3) {
    open.push(open[0]);
    lobes.push(open);
  }
  return lobes.length > 0 ? lobes : [closed];
}

/** Split every pinched ring of a set, preserving order. */
function splitPinchedRings(rings: Ring[]): Ring[] {
  const out: Ring[] = [];
  for (const ring of rings) {
    const lobes = splitPinchedRing(ring);
    if (lobes.length === 1) out.push(ring);
    else out.push(...lobes);
  }
  return out;
}

/**
 * Assemble overlay rings into polygon parts.
 *
 * After selection every kept edge has the result region on its left, so shells
 * come out CCW (positive) and holes CW (negative) and the two classes can be
 * told apart by sign alone.
 *
 * `unassigned` decides what happens to a negative ring no shell contains. In an
 * overlay that can only be a lobe of a self-intersecting input whose winding
 * came out the other way, so it is flipped into a shell — lossless, and what
 * GEOS MakeValid does with a bowtie.
 */
function nestOverlayRings(rings: Ring[], minRingArea: number, unassigned: 'flip' | 'drop'): Ring[][] {
  const usable = rings.filter(r => r.length >= 4 && Math.abs(ringSignedArea(r)) > minRingArea);
  const shells = usable
    .filter(r => ringSignedArea(r) > 0)
    .map(r => ({ ring: r, area: ringSignedArea(r), holes: [] as Ring[] }));
  const holes = usable.filter(r => ringSignedArea(r) < 0);

  if (shells.length === 0) {
    if (unassigned !== 'flip') return [];
    return holes.map(h => [h.slice().reverse()]);
  }

  const shellIndex = new ExtentIndex<number>();
  shellIndex.load(shells.map(s => extentOfCoords(s.ring)), shells.map((_, i) => i));

  const orphans: Ring[] = [];
  for (const hole of holes) {
    const holeArea = Math.abs(ringSignedArea(hole));
    const sample = ringInteriorPoint(hole);
    let host = -1;
    let hostArea = Infinity;
    if (sample) {
      for (const i of shellIndex.query([sample[0], sample[1], sample[0], sample[1]])) {
        const shell = shells[i];
        if (shell.area >= hostArea) continue;
        // A shell can only host a hole it is BIGGER than. Without this the
        // sample point of a hole that encloses an island — a donut whose hole is
        // partly filled by another operand, so the hole ring wraps round a shell
        // of its own — can land inside that island, and the island (smaller than
        // the hole it sits in) would be picked as the hole's parent. The result
        // still sums to the right AREA, because area is shells-minus-holes over
        // every part, but the geometry is invalid and covers ground it should
        // not. JTS's EdgeRing.findEdgeRingContaining skips exactly this case
        // ("if (tryArea <= testArea) continue"), and nestPolygonizeRings below
        // already did.
        if (shell.area <= holeArea) continue;
        if (pointInClosedRing(sample, shell.ring)) { host = i; hostArea = shell.area; }
      }
    }
    if (host >= 0) shells[host].holes.push(hole);
    else orphans.push(hole);
  }

  const parts = shells.map(s => [s.ring, ...s.holes]);
  if (unassigned === 'flip') {
    for (const orphan of orphans) parts.push([orphan.slice().reverse()]);
  }
  return parts;
}

/**
 * Assemble polygonized rings into polygon parts.
 *
 * Bare lines carry no inside/outside information, so the traversal returns one
 * ring per minimal cycle and the unbounded face is just another (negative)
 * cycle. Worse, a face can have several boundary components that are not
 * connected to each other — an inner square drawn inside an outer square is two
 * components, and the annulus between them is bounded by two POSITIVE rings.
 *
 * So: drop every negative ring (the complement of a face, including the
 * unbounded one) and treat every remaining positive ring as the shell of one
 * face, with its immediate contained positive rings as that face's holes. Three
 * concentric squares therefore polygonize into three faces (64 + 32 + 4 = 100),
 * which is what JTS's Polygonizer / GEOS ST_Polygonize returns.
 */
function nestPolygonizeRings(rings: Ring[], minRingArea: number): Ring[][] {
  const positives = rings.filter(r => r.length >= 4 && ringSignedArea(r) > minRingArea);
  if (positives.length === 0) return [];

  const areas = positives.map(r => ringSignedArea(r));
  const samples = positives.map(r => ringInteriorPoint(r));
  const index = new ExtentIndex<number>();
  index.load(positives.map(r => extentOfCoords(r)), positives.map((_, i) => i));

  // Smallest strictly-larger ring that contains this one = its parent face.
  const parents = positives.map((_, i) => {
    const sample = samples[i];
    if (!sample) return -1;
    let parent = -1;
    let parentArea = Infinity;
    for (const j of index.query([sample[0], sample[1], sample[0], sample[1]])) {
      if (j === i || areas[j] <= areas[i] || areas[j] >= parentArea) continue;
      if (pointInClosedRing(sample, positives[j])) { parent = j; parentArea = areas[j]; }
    }
    return parent;
  });

  const parts: Ring[][] = positives.map(ring => [ring]);
  positives.forEach((ring, i) => {
    const parent = parents[i];
    if (parent < 0 || parent === i) return;
    parts[parent].push(ring.slice().reverse()); // holes run the other way
  });
  return parts;
}

// ---------------------------------------------------------------------------
// Public kernel entry points
// ---------------------------------------------------------------------------

/**
 * True when every ordinate of a geometry is a finite number.
 *
 * NaN and Infinity cannot be noded, labelled, oriented or assembled: they
 * poison every comparison they touch (NaN < x is false, NaN > x is false, so a
 * NaN vertex sorts nowhere and lands in no node bucket) and they survive all the
 * way into the output rings. A geometry like that is therefore *refused* — the
 * overlay returns null — rather than being quietly half-processed into a shape
 * with NaN vertices, which is what a downstream JSON.stringify then deletes.
 * "Degenerate results are dropped, never invented" applies to input too.
 *
 * Check Validity reports the offending feature ('nan-coordinate') with its
 * location, so the user is told what happened instead of getting a silent null.
 */
export function hasFiniteCoordinates(geom: GeoGeom | null): boolean {
  if (!geom) return false;
  const finite = (c: Coord) => Number.isFinite(c[0]) && Number.isFinite(c[1]);
  for (const part of geometryParts(geom)) for (const ring of part) if (!ring.every(finite)) return false;
  for (const seq of lineSequences(geom)) if (!seq.every(finite)) return false;
  for (const p of pointCoords(geom)) if (!finite(p)) return false;
  return true;
}

/** Tolerance for a set of subjects, derived from their combined extent. */
export function overlayTolerance(geoms: (GeoGeom | null)[], explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  let extent = emptyExtent();
  for (const g of geoms) {
    for (const part of geometryParts(g)) for (const ring of part) extent = unionExtent(extent, extentOfCoords(ring));
    for (const seq of lineSequences(g)) extent = unionExtent(extent, extentOfCoords(seq));
    for (const p of pointCoords(g)) extent = unionExtent(extent, extentOfCoords([p]));
  }
  const span = extentSpan(extent);
  if (!Number.isFinite(span) || span <= 0) return OVERLAY_MIN_TOLERANCE;
  return Math.max(OVERLAY_MIN_TOLERANCE, span * OVERLAY_TOLERANCE_FACTOR);
}

function minAreaFor(tolerance: number, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  return Math.max(tolerance * tolerance * 4, Number.EPSILON);
}

/**
 * The one kernel: overlay N subject geometries with a boolean operator.
 *
 * Returns a Polygon/MultiPolygon, or `null` when the result is empty.
 */
export function overlayGeometries(
  subjects: (GeoGeom | null)[],
  op: OverlayOp,
  options: OverlayOptions = {}
): GeoGeom | null {
  const present = subjects.filter(g => g !== null && g !== undefined);
  if (present.length === 0) return null;
  // Refuse the whole operation rather than drop one subject: for a two-operand
  // overlay, silently discarding the unreadable operand would turn A∩garbage
  // into A∩∅ or A∪∅ = A, which is a wrong answer dressed up as a result.
  if (!present.every(hasFiniteCoordinates)) return null;
  const usable = present;
  const tolerance = overlayTolerance(usable, options.tolerance);
  const minRingArea = minAreaFor(tolerance, options.minRingArea);
  const topo = buildTopology(usable, tolerance, true, false);
  if (topo.edges.length === 0) return null;
  const locator = new SubjectLocator(usable, tolerance);
  if (locator.areaSubjects.length === 0) return null;
  labelEdges(topo, locator);
  const oriented = selectEdges(topo, op, locator.areaSubjects);
  if (oriented.length === 0) return null;
  const rings = assembleRings(oriented, topo.nodes);
  if (rings.length === 0) return null;
  return partsToGeometry(nestOverlayRings(splitPinchedRings(rings), minRingArea, 'flip'));
}

/** N-way union — QGIS Dissolve / PostGIS `ST_Union(geom[])`. */
export function unionGeometries(geoms: (GeoGeom | null)[], options: OverlayOptions = {}): GeoGeom | null {
  const usable = geoms.filter(isAreaGeometry);
  if (usable.length === 0) return null;
  if (!usable.every(hasFiniteCoordinates)) return null;
  if (usable.length === 1) return cloneGeometry(usable[0]);
  return overlayGeometries(usable, 'union', options);
}

/** Two-geometry intersection — PostGIS `ST_Intersection`. */
export function intersectGeometries(
  a: GeoGeom | null,
  b: GeoGeom | null,
  options: OverlayOptions = {}
): GeoGeom | null {
  if (!isAreaGeometry(a) || !isAreaGeometry(b)) return null;
  return overlayGeometries([a, b], 'intersection', options);
}

/** Two-geometry difference — PostGIS `ST_Difference`. */
export function differenceGeometries(
  a: GeoGeom | null,
  b: GeoGeom | null,
  options: OverlayOptions = {}
): GeoGeom | null {
  if (!isAreaGeometry(a)) return null;
  if (!isAreaGeometry(b)) return cloneGeometry(a);
  return overlayGeometries([a, b], 'difference', options);
}

/** `a` minus every geometry in `others`, in one pass. */
export function differenceFromMany(
  a: GeoGeom | null,
  others: (GeoGeom | null)[],
  options: OverlayOptions = {}
): GeoGeom | null {
  if (!isAreaGeometry(a)) return null;
  const usable = others.filter(isAreaGeometry);
  if (usable.length === 0) return cloneGeometry(a);
  return overlayGeometries([a, ...usable], 'difference', options);
}

/** Two-geometry symmetric difference — PostGIS `ST_SymDifference`. */
export function symDifferenceGeometries(
  a: GeoGeom | null,
  b: GeoGeom | null,
  options: OverlayOptions = {}
): GeoGeom | null {
  if (!isAreaGeometry(a) && !isAreaGeometry(b)) return null;
  if (!isAreaGeometry(a)) return cloneGeometry(b);
  if (!isAreaGeometry(b)) return cloneGeometry(a);
  return overlayGeometries([a, b], 'symDifference', options);
}

/**
 * Rebuild one geometry from its own noded linework: the lossless half of
 * Make Valid, and the `buffer(0)`-style repair GEOS users reach for.
 *
 * A bowtie becomes a MultiPolygon of both lobes (nothing is thrown away), a
 * stray hole outside its shell becomes a polygon of its own, and a valid
 * geometry comes back unchanged.
 */
export function repairGeometry(geom: GeoGeom | null, options: OverlayOptions = {}): GeoGeom | null {
  if (!isAreaGeometry(geom)) return geom ? cloneGeometry(geom) : null;
  if (!hasFiniteCoordinates(geom)) return null;
  return overlayGeometries([geom], 'union', options);
}

function cloneGeometry(geom: GeoGeom | null): GeoGeom | null {
  if (!geom) return null;
  return JSON.parse(JSON.stringify(geom)) as GeoGeom;
}

/**
 * Clip any subject geometry by an area geometry — QGIS Clip, which handles
 * points, lines and polygons alike.
 *
 * Points are kept when they fall inside (boundary counts as inside, matching
 * GEOS's `relate` T****** intersection semantics). Lines are noded against the
 * clip boundary and the inside runs are chained back into sequences. Polygons
 * go through the overlay kernel.
 */
export function clipGeometry(
  subject: GeoGeom | null,
  clip: GeoGeom | null,
  options: OverlayOptions = {}
): GeoGeom | null {
  if (!subject || !isAreaGeometry(clip)) return null;
  if (!hasFiniteCoordinates(subject) || !hasFiniteCoordinates(clip)) return null;
  const tolerance = overlayTolerance([subject, clip], options.tolerance);

  if (subject.type === 'Point' || subject.type === 'MultiPoint') {
    const locator = new SubjectLocator([clip], tolerance);
    if (locator.areaSubjects.length === 0) return null;
    const kept = pointCoords(subject).filter(p => locator.containsOrTouches(0, p));
    if (kept.length === 0) return null;
    if (subject.type === 'Point') return kept.length > 0 ? { type: 'Point', coordinates: kept[0] } : null;
    return { type: 'MultiPoint', coordinates: kept };
  }

  if (subject.type === 'LineString' || subject.type === 'MultiLineString') {
    return clipLines(subject, clip, tolerance, true);
  }

  return intersectGeometries(subject, clip, { ...options, tolerance });
}

/**
 * Cut an area geometry OUT of any subject geometry — QGIS Difference /
 * PostGIS `ST_Difference`, for points, lines and polygons alike.
 */
export function differenceGeometry(
  subject: GeoGeom | null,
  clip: GeoGeom | null,
  options: OverlayOptions = {}
): GeoGeom | null {
  if (!subject) return null;
  if (!hasFiniteCoordinates(subject)) return null;
  if (!isAreaGeometry(clip)) return cloneGeometry(subject);
  if (!hasFiniteCoordinates(clip)) return null;
  const tolerance = overlayTolerance([subject, clip], options.tolerance);

  if (subject.type === 'Point' || subject.type === 'MultiPoint') {
    const locator = new SubjectLocator([clip], tolerance);
    if (locator.areaSubjects.length === 0) return cloneGeometry(subject);
    const kept = pointCoords(subject).filter(p => !locator.containsOrTouches(0, p));
    if (kept.length === 0) return null;
    if (subject.type === 'Point') return { type: 'Point', coordinates: kept[0] };
    return { type: 'MultiPoint', coordinates: kept };
  }

  if (subject.type === 'LineString' || subject.type === 'MultiLineString') {
    return clipLines(subject, clip, tolerance, false);
  }

  return differenceFromMany(subject, [clip], { ...options, tolerance });
}

/**
 * Node the lines against the area boundary and keep the runs on the wanted side.
 * `keepInside` true = Clip, false = Difference.
 */
function clipLines(subject: GeoGeom, clip: GeoGeom, tolerance: number, keepInside: boolean): GeoGeom | null {
  const topo = buildTopology([subject, clip], tolerance, true, true);
  if (topo.edges.length === 0) return null;
  const locator = new SubjectLocator([null, clip], tolerance);
  if (locator.areaSubjects.length === 0) return null;

  const kept: OrientedEdge[] = [];
  for (const edge of topo.edges) {
    if (edge.area || !edge.lineOwners.includes(0)) continue;
    const na = topo.nodes[edge.a];
    const nb = topo.nodes[edge.b];
    const mid: Coord = [(na[0] + nb[0]) / 2, (na[1] + nb[1]) / 2];
    if (locator.containsOrTouches(1, mid) !== keepInside) continue;
    kept.push({ a: edge.a, b: edge.b });
  }
  if (kept.length === 0) return null;
  const chains = chainEdges(kept, topo.nodes);
  if (chains.length === 0) return null;
  if (chains.length === 1 && subject.type === 'LineString') {
    return { type: 'LineString', coordinates: chains[0] };
  }
  return { type: 'MultiLineString', coordinates: chains };
}

/**
 * Join oriented edges into coordinate sequences, always continuing along the
 * straightest available option so a clipped road stays one line.
 */
function chainEdges(edges: OrientedEdge[], nodes: Coord[]): Coord[][] {
  const outgoing = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const list = outgoing.get(e.a);
    if (list) list.push(i); else outgoing.set(e.a, [i]);
  });
  const used = new Uint8Array(edges.length);
  const chains: Coord[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const nodeChain: number[] = [edges[start].a, edges[start].b];
    let guard = edges.length + 2;
    while (guard-- > 0) {
      const tailNode = nodeChain[nodeChain.length - 1];
      const list = outgoing.get(tailNode);
      if (!list) break;
      const prevNode = nodeChain[nodeChain.length - 2];
      const prev = nodes[prevNode];
      const tail = nodes[tailNode];
      const inBearing = Math.atan2(tail[1] - prev[1], tail[0] - prev[0]);
      let next = -1;
      let bestTurn = Infinity;
      for (const candidate of list) {
        if (used[candidate]) continue;
        const nb = nodes[edges[candidate].b];
        const bearing = Math.atan2(nb[1] - tail[1], nb[0] - tail[0]);
        let turn = Math.abs(bearing - inBearing);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < bestTurn) { bestTurn = turn; next = candidate; }
      }
      if (next < 0) break;
      used[next] = 1;
      nodeChain.push(edges[next].b);
    }
    if (nodeChain.length >= 2) chains.push(nodeChain.map(i => [nodes[i][0], nodes[i][1]] as Coord));
  }
  return chains;
}

/**
 * Polygonize a line network — GEOS `ST_Polygonize` / QGIS "Polygonize".
 *
 * Every line is noded against every other, all enclosed faces are built, and
 * the unbounded face (which also comes out as a negative ring) is dropped.
 */
export function polygonizeGeometries(geoms: (GeoGeom | null)[], options: OverlayOptions = {}): GeoGeom[] {
  const tolerance = overlayTolerance(geoms, options.tolerance);
  const minRingArea = minAreaFor(tolerance, options.minRingArea);
  const topo = buildTopology(geoms, tolerance, false, true);
  if (topo.edges.length === 0) return [];
  // Both orientations of every edge: polygonizing has no "inside" to orient by.
  const oriented: OrientedEdge[] = [];
  for (const edge of topo.edges) {
    oriented.push({ a: edge.a, b: edge.b }, { a: edge.b, b: edge.a });
  }
  const rings = assembleRings(oriented, topo.nodes);
  const parts = nestPolygonizeRings(splitPinchedRings(rings), minRingArea);
  return parts.map(rings2 => ({ type: 'Polygon' as const, coordinates: rings2 }));
}

// ---------------------------------------------------------------------------
// Connected components — so a dissolve of scattered parcels stays cheap
// ---------------------------------------------------------------------------

/**
 * Group subject indices into extent-connected components (union-find over an
 * R-tree).
 *
 * A union only ever changes geometry inside a component, so components can be
 * overlaid independently. For the common case — thousands of parcels that do not
 * touch — every component is a singleton and the kernel is never invoked at all.
 */
export function connectedComponents(geoms: (GeoGeom | null)[], tolerance?: number): number[][] {
  const entries: { index: number; extent: Extent4 }[] = [];
  geoms.forEach((geom, index) => {
    if (!isAreaGeometry(geom)) return;
    let extent = emptyExtent();
    for (const part of geometryParts(geom)) for (const ring of part) extent = unionExtent(extent, extentOfCoords(ring));
    if (extent[0] > extent[2]) return;
    entries.push({ index, extent });
  });
  if (entries.length === 0) return [];

  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const index = new ExtentIndex<number>();
  index.load(
    entries.map(e => e.extent),
    entries.map((_, i) => i)
  );
  entries.forEach((entry, i) => {
    for (const j of index.query(expandExtent(entry.extent, tolerance ?? OVERLAY_MIN_TOLERANCE))) {
      if (j > i) join(i, j);
    }
  });

  const groups = new Map<number, number[]>();
  entries.forEach((entry, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(entry.index); else groups.set(root, [entry.index]);
  });
  return Array.from(groups.values());
}

/** Union, returning one geometry per connected component. */
export function unionComponents(geoms: (GeoGeom | null)[], options: OverlayOptions = {}): GeoGeom[] {
  // A single-geometry component is cloned straight through, so this is the one
  // union path that never reaches overlayGeometries' own guard. Without it a
  // NaN coordinate walks out of an N-way union inside an otherwise sane result.
  if (!geoms.every(g => g === null || g === undefined || hasFiniteCoordinates(g))) return [];
  const tolerance = overlayTolerance(geoms.filter(g => g !== null), options.tolerance);
  const out: GeoGeom[] = [];
  for (const component of connectedComponents(geoms, tolerance)) {
    const group = component.map(i => geoms[i]);
    if (group.length === 0) continue;
    if (group.length === 1) {
      const clone = cloneGeometry(group[0]);
      if (clone) out.push(clone);
      continue;
    }
    const merged = overlayGeometries(group, 'union', { ...options, tolerance });
    if (merged) out.push(merged);
  }
  return out;
}

/** Union of everything into a single geometry (MultiPolygon when disjoint). */
export function unionMany(geoms: (GeoGeom | null)[], options: OverlayOptions = {}): GeoGeom | null {
  const components = unionComponents(geoms, options);
  if (components.length === 0) return null;
  if (components.length === 1) return components[0];
  const parts: Ring[][] = [];
  for (const geom of components) parts.push(...geometryParts(geom));
  return partsToGeometry(parts);
}

/**
 * Adjacency between two geometries: do their boundaries meet anywhere at all —
 * along an edge, at a single point, or by overlapping?
 *
 * Exact, via the noder: after nodling both geometries together, adjacency means
 * some node is incident to boundary edges of BOTH subjects. This replaces the old
 * "matching vertices, else anything within 0.5 map units" guess that Eliminate
 * depended on, which missed T-junctions and invented neighbours out of nothing.
 */
export function geometriesAdjacent(a: GeoGeom | null, b: GeoGeom | null, options: OverlayOptions = {}): boolean {
  if (!isAreaGeometry(a) || !isAreaGeometry(b)) return false;
  const tolerance = overlayTolerance([a, b], options.tolerance);
  if (!extentsOverlap(geometryExtentOf(a), geometryExtentOf(b), tolerance)) return false;
  const topo = buildTopology([a, b], tolerance, true, false);
  const owners = new Map<number, Set<number>>();
  for (const edge of topo.edges) {
    if (edge.areaOwners.length === 0) continue;
    for (const node of [edge.a, edge.b]) {
      let set = owners.get(node);
      if (!set) { set = new Set<number>(); owners.set(node, set); }
      for (const id of edge.areaOwners) set.add(id);
    }
  }
  for (const set of owners.values()) if (set.size > 1) return true;
  return false;
}

/**
 * Total length of boundary the two geometries share, in map units.
 *
 * Noded, so a boundary shared only in part (a T-junction, or one long edge
 * against several short ones) is measured correctly — the old vertex-matching
 * version only counted edges whose two endpoints matched exactly.
 */
export function sharedBoundaryLength(a: GeoGeom | null, b: GeoGeom | null, options: OverlayOptions = {}): number {
  if (!isAreaGeometry(a) || !isAreaGeometry(b)) return 0;
  const tolerance = overlayTolerance([a, b], options.tolerance);
  if (!extentsOverlap(geometryExtentOf(a), geometryExtentOf(b), tolerance)) return 0;
  const topo = buildTopology([a, b], tolerance, true, false);
  let total = 0;
  for (const edge of topo.edges) {
    if (edge.areaOwners.length < 2) continue;
    total += dist(topo.nodes[edge.a], topo.nodes[edge.b]);
  }
  return total;
}

function geometryExtentOf(geom: GeoGeom): Extent4 {
  let extent = emptyExtent();
  for (const part of geometryParts(geom)) for (const ring of part) extent = unionExtent(extent, extentOfCoords(ring));
  return extent;
}

function extentsOverlap(a: Extent4, b: Extent4, pad: number): boolean {
  return a[0] - pad <= b[2] && a[2] + pad >= b[0] && a[1] - pad <= b[3] && a[3] + pad >= b[1];
}

// ---------------------------------------------------------------------------
// Validity — the GEOS/QGIS error classes
// ---------------------------------------------------------------------------

export type ValidityCode =
  | 'nan-coordinate'
  | 'too-few-points'
  | 'unclosed-ring'
  | 'self-intersection'
  | 'duplicate-ring'
  | 'hole-outside-shell'
  | 'nested-holes'
  | 'disconnected-interior'
  | 'overlapping-parts';

export interface ValidityError {
  code: ValidityCode;
  /** Human-readable reason, phrased like GEOS/QGIS ("Ring Self-intersection"). */
  message: string;
  /** Where the error is, so it can be drawn as QGIS's error-point layer. */
  location: Coord | null;
  /** 1-based polygon part. */
  part: number;
  /** 1-based ring inside the part (1 = shell). */
  ring: number;
}

/** How two segments meet. */
type ContactKind = 'cross' | 'touch';

/**
 * Where two segments meet, or null when they do not.
 *
 * `cross` = they pass through each other; `touch` = they meet at a point
 * (endpoint to endpoint, or an endpoint on the other's interior). GEOS reports
 * the first as a self-intersection and the second as a disconnected interior.
 */
function segmentContact(a1: Coord, a2: Coord, b1: Coord, b2: Coord, tolerance: number): { kind: ContactKind; point: Coord } | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const len1 = Math.hypot(d1x, d1y);
  const len2 = Math.hypot(d2x, d2y);
  if (len1 === 0 || len2 === 0) return null;
  const rx = b1[0] - a1[0];
  const ry = b1[1] - a1[1];
  const den = d1x * d2y - d1y * d2x;
  const tTol = Math.min(0.5, tolerance / len1);
  const uTol = Math.min(0.5, tolerance / len2);

  if (!segmentsParallel(den, len1, len2, tolerance)) {
    const t = (rx * d2y - ry * d2x) / den;
    const u = (rx * d1y - ry * d1x) / den;
    if (t < -tTol || t > 1 + tTol || u < -uTol || u > 1 + uTol) return null;
    const tc = clamp01(t);
    const uc = clamp01(u);
    const point: Coord = [
      0.5 * (a1[0] + tc * d1x + b1[0] + uc * d2x),
      0.5 * (a1[1] + tc * d1y + b1[1] + uc * d2y),
    ];
    const atEndA = tc <= tTol || tc >= 1 - tTol;
    const atEndB = uc <= uTol || uc >= 1 - uTol;
    return { kind: atEndA && atEndB ? 'touch' : 'cross', point };
  }

  // Collinear: an overlap is a crossing along a line, a shared endpoint a touch.
  if (Math.abs(rx * d1y - ry * d1x) > tolerance * len1) return null;
  const len1sq = len1 * len1;
  const u1 = ((b1[0] - a1[0]) * d1x + (b1[1] - a1[1]) * d1y) / len1sq;
  const u2 = ((b2[0] - a1[0]) * d1x + (b2[1] - a1[1]) * d1y) / len1sq;
  const lo = Math.max(0, Math.min(u1, u2));
  const hi = Math.min(1, Math.max(u1, u2));
  if (lo > hi + tolerance / len1) return null;
  if (hi - lo > Math.max(tTol, uTol)) {
    const mid = (lo + hi) / 2;
    return { kind: 'cross', point: [a1[0] + mid * d1x, a1[1] + mid * d1y] };
  }
  const t = clamp01((lo + hi) / 2);
  return { kind: 'touch', point: [a1[0] + t * d1x, a1[1] + t * d1y] };
}

interface IndexedRing {
  ring: Ring;
  /** 1-based polygon part. */
  partIndex: number;
  /** 1-based ring inside the part (1 = shell). */
  ringIndex: number;
  isHole: boolean;
}

function ringKey(ring: Ring, tolerance: number): string {
  const closed = asClosedRing(ring);
  const pts = closed.slice(0, -1).map(c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`);
  // Rotation/canonicalisation-free key: sorted coordinates identify the same
  // vertex set, which is all a "duplicate ring" check needs.
  void tolerance;
  return pts.slice().sort().join('|');
}

/**
 * Every validity error of a geometry, in the classes GEOS/QGIS report.
 *
 * Unlike a boolean "is it valid", this returns ALL reasons with their locations,
 * which is what QGIS's Check Validity error layer needs and what makes an
 * invalid feature diagnosable instead of merely rejected.
 */
export function validateGeometry(geom: GeoGeom | null, options: OverlayOptions = {}): ValidityError[] {
  const errors: ValidityError[] = [];
  if (!geom) return errors;
  const tolerance = overlayTolerance([geom], options.tolerance);

  const checkFinite = (coords: Coord[], part: number, ring: number) => {
    const finite = (c: Coord) => Number.isFinite(c[0]) && Number.isFinite(c[1]);
    for (let i = 0; i < coords.length; i++) {
      if (finite(coords[i])) continue;
      // A NaN ordinate cannot be plotted, so locate the error at the nearest
      // FINITE vertex (searching backwards first, then forwards). With
      // `location: null` the error is skipped by validityErrorPoints() and the
      // QGIS-style error-point layer comes back empty for exactly the features
      // that need pointing at most: the user is told a feature is broken but has
      // nowhere to click.
      let near: Coord | null = null;
      for (let back = i - 1; back >= 0 && near === null; back--) if (finite(coords[back])) near = coords[back];
      for (let fwd = i + 1; fwd < coords.length && near === null; fwd++) if (finite(coords[fwd])) near = coords[fwd];
      errors.push({
        code: 'nan-coordinate',
        message: `Coordinate ${i + 1} of ${coords.length} is not a finite number.`,
        location: near,
        part,
        ring,
      });
      return;
    }
  };

  if (!isAreaGeometry(geom)) {
    // Points and lines have no ring topology, but they can still be degenerate.
    const sequences = [...lineSequences(geom), ...pointCoords(geom).map(c => [c])];
    sequences.forEach((seq, i) => {
      checkFinite(seq, 1, i + 1);
      if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
        if (seq.length < 2) {
          errors.push({ code: 'too-few-points', message: 'Line has fewer than 2 points.', location: seq[0] ?? null, part: 1, ring: i + 1 });
        }
      }
    });
    return errors;
  }

  const parts = geometryParts(geom);
  const indexed: IndexedRing[] = [];
  parts.forEach((part, pi) => {
    part.forEach((ring, ri) => {
      checkFinite(ring, pi + 1, ri + 1);
      indexed.push({ ring, partIndex: pi + 1, ringIndex: ri + 1, isHole: ri > 0 });
    });
  });

  // --- per-ring checks -----------------------------------------------------
  for (const entry of indexed) {
    const closed = asClosedRing(entry.ring);
    if (entry.ring.length < 4) {
      errors.push({
        code: 'too-few-points',
        message: `${entry.isHole ? 'Inner' : 'Outer'} ring has fewer than 4 points.`,
        location: closed[0] ?? null,
        part: entry.partIndex,
        ring: entry.ringIndex,
      });
      continue;
    }
    // Closure is tested on the ring AS GIVEN — closing it first would make the
    // check vacuous, which is how an open ring used to sail through.
    const rawFirst = entry.ring[0];
    const rawLast = entry.ring[entry.ring.length - 1];
    if (entry.ring.length < 2 || Math.hypot(rawFirst[0] - rawLast[0], rawFirst[1] - rawLast[1]) > tolerance) {
      errors.push({
        code: 'unclosed-ring',
        message: 'Ring is not closed.',
        location: rawLast,
        part: entry.partIndex,
        ring: entry.ringIndex,
      });
    }
    const distinct = new Set(closed.slice(0, -1).map(c => `${c[0]}:${c[1]}`));
    if (distinct.size < 3) {
      errors.push({
        code: 'too-few-points',
        message: 'Too few distinct points in ring.',
        location: closed[0],
        part: entry.partIndex,
        ring: entry.ringIndex,
      });
    }
  }

  // --- duplicate rings ------------------------------------------------------
  const seen = new Map<string, IndexedRing>();
  for (const entry of indexed) {
    const key = ringKey(entry.ring, tolerance);
    const previous = seen.get(key);
    if (previous) {
      errors.push({
        code: 'duplicate-ring',
        message: `Duplicate ring (same as part ${previous.partIndex} ring ${previous.ringIndex}).`,
        location: asClosedRing(entry.ring)[0] ?? null,
        part: entry.partIndex,
        ring: entry.ringIndex,
      });
    } else {
      seen.set(key, entry);
    }
  }

  // --- ring contacts: self-intersections and disconnected interiors ---------
  interface SegRef { entry: IndexedRing; i: number; a: Coord; b: Coord }
  const segs: SegRef[] = [];
  for (const entry of indexed) {
    const closed = closeWithinTolerance(entry.ring, tolerance);
    for (let i = 0; i < closed.length - 1; i++) {
      // A segment shorter than the snap tolerance is below the resolution the
      // kernel claims, and can only制造 false contacts.
      if (Math.hypot(closed[i + 1][0] - closed[i][0], closed[i + 1][1] - closed[i][1]) <= tolerance) continue;
      segs.push({ entry, i, a: closed[i], b: closed[i + 1] });
    }
  }
  if (segs.length > 0) {
    const boxes = segs.map(sg => extentOfCoords([sg.a, sg.b]));
    const segIndex = new ExtentIndex<number>();
    segIndex.load(boxes, segs.map((_, i) => i));
    const reported = new Set<string>();
    for (let i = 0; i < segs.length; i++) {
      for (const j of segIndex.query(expandExtent(boxes[i], tolerance))) {
        if (j <= i) continue;
        const s1 = segs[i];
        const s2 = segs[j];
        const sameRing = s1.entry === s2.entry;
        const adjacent = sameRing && Math.abs(s1.i - s2.i) <= 1;
        const ringSegments = segs.filter(sg => sg.entry === s1.entry).length;
        const wrapAdjacent = sameRing && Math.abs(s1.i - s2.i) === ringSegments - 1;
        if (adjacent || wrapAdjacent) continue;
        const contact = segmentContact(s1.a, s1.b, s2.a, s2.b, tolerance);
        if (!contact) continue;
        // Separate parts of a MultiPolygon may touch at a point: their interiors
        // stay disjoint, which is all the OGC (and GEOS) requires. A pinch inside
        // ONE part — a ring that touches itself, or a hole that touches its shell
        // — is the disconnected interior that is actually invalid.
        if (contact.kind === 'touch' && s1.entry.partIndex !== s2.entry.partIndex) continue;
        // Round to the snap tolerance so one geometric contact reported by
        // several segment pairs is not listed once per pair.
        const q = Math.max(tolerance, 1e-9);
        const key = `${contact.kind}:${Math.round(contact.point[0] / q)}:${Math.round(contact.point[1] / q)}`;
        if (reported.has(key)) continue;
        reported.add(key);
        errors.push(contact.kind === 'cross'
          ? {
              code: 'self-intersection',
              message: sameRing
                ? `Ring self-intersection at ${fmtPoint(contact.point)}.`
                : `Self-intersection between part ${s1.entry.partIndex} ring ${s1.entry.ringIndex} and part ${s2.entry.partIndex} ring ${s2.entry.ringIndex}.`,
              location: contact.point,
              part: s1.entry.partIndex,
              ring: s1.entry.ringIndex,
            }
          : {
              code: 'disconnected-interior',
              message: `Interior is disconnected: rings touch at a single point ${fmtPoint(contact.point)}.`,
              location: contact.point,
              part: s1.entry.partIndex,
              ring: s1.entry.ringIndex,
            });
      }
    }
  }

  // --- hole placement -------------------------------------------------------
  parts.forEach((part, pi) => {
    const [shell, ...holes] = part;
    if (!shell || holes.length === 0) return;
    const shellRing = asClosedRing(shell);
    holes.forEach((hole, hi) => {
      const holeRing = asClosedRing(hole);
      if (holeRing.length < 4) return;
      const sample = ringInteriorPoint(holeRing);
      const probe = sample ?? holeRing[0];
      if (!pointInClosedRing(probe, shellRing)) {
        errors.push({
          code: 'hole-outside-shell',
          message: `Hole ${hi + 1} lies outside its shell.`,
          location: holeRing[0],
          part: pi + 1,
          ring: hi + 2,
        });
        return;
      }
      for (let other = 0; other < holes.length; other++) {
        if (other === hi) continue;
        const otherRing = asClosedRing(holes[other]);
        if (otherRing.length < 4) continue;
        if (pointInClosedRing(probe, otherRing)) {
          errors.push({
            code: 'nested-holes',
            message: `Hole ${hi + 1} is nested inside hole ${other + 1}.`,
            location: holeRing[0],
            part: pi + 1,
            ring: hi + 2,
          });
          break;
        }
      }
    });
  });

  // --- overlapping parts (MultiPolygon only) --------------------------------
  if (geom.type === 'MultiPolygon' && parts.length > 1) {
    const polys: GeoGeom[] = parts.map(rings => ({ type: 'Polygon' as const, coordinates: rings }));
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const overlap = intersectGeometries(polys[i], polys[j], { tolerance });
        if (!overlap) continue;
        const probe = geometryInteriorPoint(overlap);
        errors.push({
          code: 'overlapping-parts',
          message: `Parts ${i + 1} and ${j + 1} overlap.`,
          location: probe,
          part: i + 1,
          ring: 1,
        });
      }
    }
  }

  return errors;
}

function fmtPoint(p: Coord): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `${r(p[0])} ${r(p[1])}`;
}

/** True when the geometry has no validity errors at all. */
export function isGeometryValid(geom: GeoGeom | null, options: OverlayOptions = {}): boolean {
  return validateGeometry(geom, options).length === 0;
}
