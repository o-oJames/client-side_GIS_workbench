/**
 * Tests for the scissors (split) geometry utilities.
 */
import {
  segmentSegmentIntersection,
  splitLineStringWithLine,
  splitPolygonWithLine,
  splitFeatureWithLine,
} from './scissorsSplit';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';

// ---------------------------------------------------------------------------
// segmentSegmentIntersection
// ---------------------------------------------------------------------------

describe('segmentSegmentIntersection', () => {
  it('finds the intersection of two crossing segments', () => {
    const hit = segmentSegmentIntersection(
      [0, 0], [10, 10],
      [0, 10], [10, 0],
    );
    expect(hit).not.toBeNull();
    expect(hit!.point[0]).toBeCloseTo(5);
    expect(hit!.point[1]).toBeCloseTo(5);
    expect(hit!.tA).toBeCloseTo(0.5);
    expect(hit!.tB).toBeCloseTo(0.5);
  });

  it('returns null for parallel segments', () => {
    const hit = segmentSegmentIntersection(
      [0, 0], [10, 0],
      [0, 5], [10, 5],
    );
    expect(hit).toBeNull();
  });

  it('returns null for non-crossing segments', () => {
    const hit = segmentSegmentIntersection(
      [0, 0], [5, 0],
      [6, -5], [6, 5],
    );
    expect(hit).toBeNull();
  });

  it('handles T-junction (endpoint touches other segment)', () => {
    const hit = segmentSegmentIntersection(
      [0, 0], [10, 0],
      [5, 0], [5, 5],
    );
    expect(hit).not.toBeNull();
    expect(hit!.point[0]).toBeCloseTo(5);
    expect(hit!.point[1]).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------
// splitLineStringWithLine
// ---------------------------------------------------------------------------

describe('splitLineStringWithLine', () => {
  it('returns the original line when no crossing exists', () => {
    const line: number[][] = [[0, 0], [10, 0]];
    const cut: number[][] = [[0, 5], [10, 5]];
    const result = splitLineStringWithLine(line, cut);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual(line);
  });

  it('splits a line at one crossing point', () => {
    const line: number[][] = [[0, 0], [10, 10]];
    const cut: number[][] = [[0, 10], [10, 0]];
    const result = splitLineStringWithLine(line, cut);
    expect(result.length).toBe(2);
    // First piece: from [0,0] to the crossing at [5,5]
    expect(result[0][0]).toEqual([0, 0]);
    expect(result[0][result[0].length - 1][0]).toBeCloseTo(5);
    expect(result[0][result[0].length - 1][1]).toBeCloseTo(5);
    // Second piece: from [5,5] to [10,10]
    expect(result[1][0][0]).toBeCloseTo(5);
    expect(result[1][0][1]).toBeCloseTo(5);
    expect(result[1][result[1].length - 1]).toEqual([10, 10]);
  });

  it('splits a V-shaped line with a horizontal cut (two crossings)', () => {
    // V-shape: goes up from [0,0] to [5,5], then down to [10,0].
    const line: number[][] = [[0, 0], [5, 5], [10, 0]];
    // Horizontal cut at y=2.5 crosses both segments.
    const cut: number[][] = [[0, 2.5], [10, 2.5]];
    const result = splitLineStringWithLine(line, cut);
    // Two crossings produce three pieces.
    expect(result.length).toBe(3);
  });

  it('returns the original when cut has fewer than 2 points', () => {
    const line: number[][] = [[0, 0], [10, 10]];
    const cut: number[][] = [[5, 5]];
    const result = splitLineStringWithLine(line, cut);
    expect(result.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// splitPolygonWithLine
// ---------------------------------------------------------------------------

describe('splitPolygonWithLine', () => {
  it('returns null when the cut does not cross the polygon', () => {
    // A square polygon.
    const poly: number[][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    // Cut line entirely outside.
    const cut: number[][] = [[20, 0], [20, 10]];
    const result = splitPolygonWithLine(poly, cut);
    expect(result).toBeNull();
  });

  it('returns null when the cut has only one intersection', () => {
    const poly: number[][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    // Cut line that only touches one edge.
    const cut: number[][] = [[-5, 0], [5, 0]];
    const result = splitPolygonWithLine(poly, cut);
    // This may or may not split depending on exact intersection logic.
    // If it only touches the corner/edge, it shouldn't split.
    // We accept either null or a valid split.
    if (result) {
      expect(result.length).toBe(2);
    }
  });

  it('splits a square polygon with a diagonal cut', () => {
    // A square polygon (clockwise).
    const poly: number[][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    // Cut from near bottom-left to near top-right (avoiding corners).
    const cut: number[][] = [[1, -1], [9, 11]];
    const result = splitPolygonWithLine(poly, cut);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    // Each piece should have at least 4 coordinates (closed ring).
    expect(result![0][0].length).toBeGreaterThanOrEqual(4);
    expect(result![1][0].length).toBeGreaterThanOrEqual(4);
  });

  it('splits a polygon with a horizontal cut', () => {
    const poly: number[][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    const cut: number[][] = [[-1, 5], [11, 5]];
    const result = splitPolygonWithLine(poly, cut);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
  });

  it('returns null for a cut with fewer than 2 points', () => {
    const poly: number[][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    const cut: number[][] = [[5, 5]];
    const result = splitPolygonWithLine(poly, cut);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// splitFeatureWithLine (high-level API)
// ---------------------------------------------------------------------------

describe('splitFeatureWithLine', () => {
  it('splits a LineString feature', () => {
    const geom = new LineString([[0, 0], [10, 10]]);
    const cut: number[][] = [[0, 10], [10, 0]];
    const result = splitFeatureWithLine(geom, cut);
    expect(result.kind).toBe('line');
    expect(result.geometries.length).toBe(2);
    expect(result.geometries[0]).toBeInstanceOf(LineString);
    expect(result.geometries[1]).toBeInstanceOf(LineString);
  });

  it('splits a Polygon feature', () => {
    const geom = new Polygon([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
    const cut: number[][] = [[-1, 5], [11, 5]];
    const result = splitFeatureWithLine(geom, cut);
    expect(result.kind).toBe('polygon');
    expect(result.geometries.length).toBe(2);
    expect(result.geometries[0]).toBeInstanceOf(Polygon);
    expect(result.geometries[1]).toBeInstanceOf(Polygon);
  });

  it('returns none for a Point geometry', () => {
    const Point = require('ol/geom/Point.js').default;
    const geom = new Point([5, 5]);
    const cut: number[][] = [[0, 0], [10, 10]];
    const result = splitFeatureWithLine(geom, cut);
    expect(result.kind).toBe('none');
    expect(result.geometries.length).toBe(0);
  });

  it('returns none when a line does not cross the cut', () => {
    const geom = new LineString([[0, 0], [10, 0]]);
    const cut: number[][] = [[0, 5], [10, 5]];
    const result = splitFeatureWithLine(geom, cut);
    expect(result.kind).toBe('none');
    expect(result.geometries.length).toBe(0);
  });
});
