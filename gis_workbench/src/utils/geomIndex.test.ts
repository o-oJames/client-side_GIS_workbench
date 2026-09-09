import {
  EMPTY_EXTENT,
  ExtentIndex,
  bboxToExtent,
  emptyExtent,
  expandExtent,
  extentOfCoords,
  extentSpan,
  extentToBBox,
  extentsIntersect,
  isEmptyExtent,
  unionExtent,
  type Extent4,
} from './geomIndex';

const unit: Extent4 = [0, 0, 10, 10];
const far: Extent4 = [100, 100, 110, 110];

describe('extent helpers', () => {
  it('converts between bbox and extent forms', () => {
    expect(bboxToExtent({ minX: 1, minY: 2, maxX: 3, maxY: 4 })).toEqual([1, 2, 3, 4]);
    expect(extentToBBox([1, 2, 3, 4])).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 4 });
  });

  it('detects empty extents and hands out fresh ones', () => {
    expect(isEmptyExtent(EMPTY_EXTENT)).toBe(true);
    expect(isEmptyExtent(unit)).toBe(false);
    const e = emptyExtent();
    e[0] = 5;
    // Mutating a copy must not corrupt the shared constant.
    expect(EMPTY_EXTENT[0]).toBe(Infinity);
  });

  it('measures coords, ignoring non-finite values', () => {
    expect(extentOfCoords([[1, 2], [3, 4], [0, 9]])).toEqual([0, 2, 3, 9]);
    expect(extentOfCoords([])).toEqual(EMPTY_EXTENT);
    expect(extentOfCoords([[NaN, 1], [2, 3]])).toEqual([2, 3, 2, 3]);
  });

  it('treats touching extents as intersecting', () => {
    expect(extentsIntersect(unit, [10, 0, 20, 10])).toBe(true);
    expect(extentsIntersect(unit, far)).toBe(false);
  });

  it('expands, unions and spans', () => {
    expect(expandExtent(unit, 5)).toEqual([-5, -5, 15, 15]);
    expect(unionExtent(unit, far)).toEqual([0, 0, 110, 110]);
    expect(unionExtent(emptyExtent(), unit)).toEqual(unit);
    expect(unionExtent(unit, emptyExtent())).toEqual(unit);
    expect(extentSpan(unit)).toBe(10);
    expect(extentSpan([0, 0, 30, 10])).toBe(30);
    expect(extentSpan(EMPTY_EXTENT)).toBe(0);
  });
});

describe('ExtentIndex', () => {
  it('returns only the values that overlap the query extent', () => {
    const index = new ExtentIndex<number>();
    index.load([unit, far, [-5, -5, 5, 5]], [0, 1, 2]);
    expect(index.size).toBe(3);
    expect(index.query([0, 0, 1, 1]).sort()).toEqual([0, 2]);
    expect(index.query([105, 105, 106, 106])).toEqual([1]);
    expect(index.query([1000, 1000, 1001, 1001])).toEqual([]);
  });

  it('supports incremental add and clear', () => {
    const index = new ExtentIndex<string>();
    index.add(unit, 'a');
    index.add(far, 'b');
    expect(index.size).toBe(2);
    expect(index.query(unit)).toEqual(['a']);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.query(unit)).toEqual([]);
  });

  it('silently skips empty extents so they cannot match everything', () => {
    const index = new ExtentIndex<number>();
    index.load([EMPTY_EXTENT, unit], [0, 1]);
    expect(index.size).toBe(1);
    expect(index.query([-1e9, -1e9, 1e9, 1e9])).toEqual([1]);
    expect(index.query(EMPTY_EXTENT)).toEqual([]);
  });

  /**
   * The engines index tens of thousands of features; this pins the pruning
   * behaviour at a scale where a broken index would be obvious.
   */
  it('prunes a 100×100 grid to the handful of real neighbours', () => {
    const index = new ExtentIndex<number>();
    const extents: Extent4[] = [];
    const values: number[] = [];
    for (let gx = 0; gx < 100; gx++) {
      for (let gy = 0; gy < 100; gy++) {
        extents.push([gx * 10, gy * 10, gx * 10 + 9, gy * 10 + 9]);
        values.push(gx * 100 + gy);
      }
    }
    index.load(extents, values);
    expect(index.size).toBe(10_000);
    const hits = index.query([45, 45, 55, 55]);
    expect(hits.length).toBeLessThanOrEqual(4);
    expect(hits).toContain(4 * 100 + 4);
    expect(hits).toContain(5 * 100 + 5);
  });
});
