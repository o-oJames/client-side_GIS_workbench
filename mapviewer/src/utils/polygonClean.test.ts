import {
  CLEANUP_TOLERANCE_MAX_PX,
  CLEANUP_TOLERANCE_MIN_PX,
  DEFAULT_CLEANUP_TOLERANCE_PX,
  countPolygonVertices,
  isClosedRing,
  simplifyPolygonRings,
} from './polygonClean';
import { ringSignedArea, Pt } from './contourExtract';

/**
 * Build an axis-aligned square (0,0)-(size,size) whose four edges are
 * zigzagged with small alternating perturbations — the same staircase
 * character as a mask-traced outline. Ring is open (no closing duplicate).
 */
function jaggySquare(size: number, steps: number, amp: number): number[][] {
  const ring: number[][] = [];
  const jitter = (i: number) => (i % 2 === 0 ? 0 : amp);
  // bottom edge, left → right
  for (let i = 0; i <= steps; i++) {
    ring.push([(i / steps) * size, jitter(i)]);
  }
  // right edge, bottom → top
  for (let i = 1; i <= steps; i++) {
    ring.push([size - jitter(i), (i / steps) * size]);
  }
  // top edge, right → left
  for (let i = 1; i <= steps; i++) {
    ring.push([size - (i / steps) * size, size - jitter(i)]);
  }
  // left edge, top → bottom (stop before closing back on vertex 0)
  for (let i = 1; i < steps; i++) {
    ring.push([jitter(i), size - (i / steps) * size]);
  }
  return ring;
}

function shoelace(ring: number[][]): number {
  return Math.abs(ringSignedArea(ring.map((c): Pt => ({ x: c[0], y: c[1] }))));
}

describe('isClosedRing', () => {
  it('detects the closing duplicate', () => {
    expect(isClosedRing([[0, 0], [1, 0], [1, 1], [0, 0]])).toBe(true);
    expect(isClosedRing([[0, 0], [1, 0], [1, 1]])).toBe(false);
  });

  it('never treats short rings as closed', () => {
    expect(isClosedRing([[0, 0]])).toBe(false);
    expect(isClosedRing([])).toBe(false);
  });
});

describe('countPolygonVertices', () => {
  it('counts unique vertices, skipping closing duplicates', () => {
    const open = jaggySquare(10, 8, 0.25);
    const closed = [...open, [open[0][0], open[0][1]]];
    expect(countPolygonVertices([open])).toBe(open.length);
    expect(countPolygonVertices([closed])).toBe(open.length);
  });

  it('sums rings and ignores empty ones', () => {
    expect(countPolygonVertices([[[0, 0], [1, 0], [1, 1]], [], [[2, 2], [3, 2], [3, 3], [2, 3]]])).toBe(7);
    expect(countPolygonVertices([])).toBe(0);
  });
});

describe('simplifyPolygonRings', () => {
  it('removes jaggy vertices while keeping the overall shape', () => {
    const jaggy = jaggySquare(10, 20, 0.1); // 80 unique vertices
    const originalArea = shoelace(jaggy);

    const cleaned = simplifyPolygonRings([jaggy], 1); // tolerance >> amplitude
    expect(countPolygonVertices(cleaned)).toBeLessThan(jaggy.length / 2);
    expect(countPolygonVertices(cleaned)).toBeGreaterThanOrEqual(4);
    // Area survives: straightening 0.1 jaggies on a 10×10 square only
    // recovers the tiny slivers the jaggies cut off (~2%).
    expect(Math.abs(shoelace(cleaned[0]) - originalArea)).toBeLessThan(originalArea * 0.05);
  });

  it('keeps a genuine corner (deflection above the tolerance)', () => {
    // L shape: the concave corner deflects 5 units, far above tolerance 1.
    const lShape = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
    const cleaned = simplifyPolygonRings([lShape], 1);
    expect(countPolygonVertices(cleaned)).toBe(6);
    expect(cleaned[0]).toEqual(lShape);
  });

  it('returns a copy for zero/negative tolerance', () => {
    const rings = [[[0, 0], [1, 0], [1, 1]]];
    const out = simplifyPolygonRings(rings, 0);
    expect(out).toEqual(rings);
    expect(out[0]).not.toBe(rings[0]);
  });

  it('returns [] for an empty polygon', () => {
    expect(simplifyPolygonRings([], 1)).toEqual([]);
  });

  it('preserves the closure form of each ring', () => {
    const open = jaggySquare(10, 12, 0.2);
    const closed = [...open, [open[0][0], open[0][1]]];

    const cleanedOpen = simplifyPolygonRings([open], 1);
    const cleanedClosed = simplifyPolygonRings([closed], 1);

    expect(isClosedRing(cleanedOpen[0])).toBe(false);
    expect(isClosedRing(cleanedClosed[0])).toBe(true);
    // Closed output ends exactly where it starts.
    const cr = cleanedClosed[0];
    expect(cr[cr.length - 1]).toEqual(cr[0]);
  });

  it('drops holes that degenerate but keeps the outer ring', () => {
    const outer = jaggySquare(20, 12, 0.3);
    // A 0.6-wide sliver hole: collapses under tolerance 2.
    const sliverHole = [[9, 9], [11, 9], [11, 9.6], [9, 9.6]];
    const cleaned = simplifyPolygonRings([outer, sliverHole], 2);
    expect(cleaned.length).toBe(1); // hole dropped
    expect(countPolygonVertices(cleaned)).toBeGreaterThanOrEqual(4);
  });

  it('keeps sizeable holes', () => {
    const outer = [[0, 0], [30, 0], [30, 30], [0, 30]];
    const hole = [[10, 10], [20, 10], [20, 20], [10, 20]];
    const cleaned = simplifyPolygonRings([outer, hole], 1);
    expect(cleaned.length).toBe(2);
  });

  it('falls back to the original outer ring when simplification degenerates it', () => {
    // A near-line "polygon": DP at a large tolerance can't keep 3 vertices
    // with real area, so the original must survive untouched.
    const sliver = [[0, 0], [10, 0.01], [20, 0], [10, 0.02]];
    const cleaned = simplifyPolygonRings([sliver], 5);
    expect(cleaned[0]).toEqual(sliver);
  });

  it('exposes sane slider constants', () => {
    expect(DEFAULT_CLEANUP_TOLERANCE_PX).toBeGreaterThanOrEqual(CLEANUP_TOLERANCE_MIN_PX);
    expect(DEFAULT_CLEANUP_TOLERANCE_PX).toBeLessThanOrEqual(CLEANUP_TOLERANCE_MAX_PX);
  });
});
