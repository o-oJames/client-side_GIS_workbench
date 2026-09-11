/**
 * geomIndex.ts — extent (bounding-box) helpers plus a thin R-tree wrapper.
 *
 * The geoprocessing engines historically scanned every pair of features
 * (O(n²)–O(n³)) with no spatial pruning at all. This module gives them a
 * shared index built on `ol/structs/RBush.js`, which is already bundled with
 * OpenLayers — so the app gains spatial indexing without a new dependency.
 *
 * Framework-agnostic on purpose: it knows nothing about GeoJSON shapes or
 * React, only `[minX, minY, maxX, maxY]` extents and opaque values.
 */
import RBush from 'ol/structs/RBush.js';

/** OpenLayers-style extent: [minX, minY, maxX, maxY]. */
export type Extent4 = [number, number, number, number];

/** Named-field bounding box, as used inside geoprocessing.ts. */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An extent with no points in it (min > max). */
export const EMPTY_EXTENT: Extent4 = [Infinity, Infinity, -Infinity, -Infinity];

/** A fresh empty extent (never share the `EMPTY_EXTENT` constant by reference). */
export function emptyExtent(): Extent4 {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function bboxToExtent(b: BBox): Extent4 {
  return [b.minX, b.minY, b.maxX, b.maxY];
}

export function extentToBBox(e: Extent4): BBox {
  return { minX: e[0], minY: e[1], maxX: e[2], maxY: e[3] };
}

export function isEmptyExtent(e: Extent4): boolean {
  return !(e[0] <= e[2] && e[1] <= e[3]);
}

/** Do two extents overlap (touching counts as overlapping)? */
export function extentsIntersect(a: Extent4, b: Extent4): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** A copy of `e` grown by `pad` on every side. */
export function expandExtent(e: Extent4, pad: number): Extent4 {
  return [e[0] - pad, e[1] - pad, e[2] + pad, e[3] + pad];
}

/**
 * Largest side of an extent. Used to derive a coordinate tolerance that is
 * meaningful for the dataset's scale (see `scaleTolerance` in geoprocessing.ts):
 * EPSG:3857 ordinates are of order 1e7, where a fixed 1e-9 epsilon sits at or
 * below the double-precision noise floor.
 */
export function extentSpan(e: Extent4): number {
  if (isEmptyExtent(e)) return 0;
  return Math.max(e[2] - e[0], e[3] - e[1]);
}

/** Extent of a coordinate array; `EMPTY_EXTENT` when there are no coordinates. */
export function extentOfCoords(coords: number[][]): Extent4 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const x = coords[i][0];
    const y = coords[i][1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return minX === Infinity ? emptyExtent() : [minX, minY, maxX, maxY];
}

/** Union of two extents (either may be empty). */
export function unionExtent(a: Extent4, b: Extent4): Extent4 {
  if (isEmptyExtent(a)) return [b[0], b[1], b[2], b[3]];
  if (isEmptyExtent(b)) return [a[0], a[1], a[2], a[3]];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * ol's RBush wrapper calls `getUid()` on every value it stores, which writes an
 * `ol_uid` property onto it — so values must be objects and a plain number index
 * throws. Each value is therefore boxed, and unboxed again on query.
 */
interface Boxed<T> { v: T }

/**
 * Minimal R-tree over extents. Values are opaque; the geoprocessing engines
 * store feature/ring indices and resolve them against their own arrays.
 */
export class ExtentIndex<T = number> {
  private tree: RBush<Boxed<T>>;
  private count = 0;

  constructor(maxEntries = 9) {
    this.tree = new RBush<Boxed<T>>(maxEntries);
  }

  add(extent: Extent4, value: T): void {
    if (isEmptyExtent(extent)) return;
    this.tree.insert(extent, { v: value });
    this.count++;
  }

  /** Bulk load — markedly faster than repeated `add` for large inputs. */
  load(extents: Extent4[], values: T[]): void {
    const usableExtents: Extent4[] = [];
    const usableValues: Array<Boxed<T>> = [];
    for (let i = 0; i < extents.length; i++) {
      if (isEmptyExtent(extents[i])) continue;
      usableExtents.push(extents[i]);
      usableValues.push({ v: values[i] });
    }
    if (usableExtents.length === 0) return;
    this.tree.load(usableExtents, usableValues);
    this.count += usableExtents.length;
  }

  /** All values whose extent overlaps `extent`. */
  query(extent: Extent4): T[] {
    if (isEmptyExtent(extent)) return [];
    return this.tree.getInExtent(extent).map(entry => entry.v);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.tree.clear();
    this.count = 0;
  }
}
