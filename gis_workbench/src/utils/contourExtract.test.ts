import {
  bilinearResize,
  marchingSquaresRings,
  ringSignedArea,
  pointInRing,
  simplifyRing,
  extractMaskPolygon,
  pixelRingToMapCoords,
  nearestPointOnRings,
  Pt,
} from './contourExtract';

/** Build a scalar field from a signed-distance-style predicate. */
function makeField(size: number, predicate: (x: number, y: number) => boolean): Float32Array {
  const field = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      field[y * size + x] = predicate(x, y) ? 1 : -1;
    }
  }
  return field;
}

describe('bilinearResize', () => {
  it('returns a copy for identical dimensions', () => {
    const src = Float32Array.from([1, 2, 3, 4]);
    const out = bilinearResize(src, 2, 2, 2, 2);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(src);
  });

  it('preserves a constant field while upscaling', () => {
    const src = new Float32Array(4 * 4).fill(3.5);
    const out = bilinearResize(src, 4, 4, 8, 8);
    expect(out.length).toBe(64);
    out.forEach((v) => expect(v).toBeCloseTo(3.5, 5));
  });

  it('interpolates intermediate values', () => {
    // 2x1 ramp: 0 → 10; resampling to 3x1 must yield 0, 5, 10.
    const src = Float32Array.from([0, 10]);
    const out = bilinearResize(src, 2, 1, 3, 1);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(5, 5);
    expect(out[2]).toBeCloseTo(10, 5);
  });
});

describe('marchingSquaresRings', () => {
  it('traces one closed ring around a disc', () => {
    const size = 64;
    const cx = 32;
    const cy = 32;
    const r = 20;
    const field = makeField(size, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
    const rings = marchingSquaresRings(field, size, size, 0);
    expect(rings.length).toBe(1);
    const ring = rings[0];
    expect(ring.length).toBeGreaterThan(20);
    // Every traced point sits (approximately) on the circle.
    ring.forEach((p) => {
      const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
      expect(d).toBeGreaterThan(r - 1.5);
      expect(d).toBeLessThan(r + 1.5);
    });
  });

  it('traces outer and inner rings of a donut', () => {
    const size = 64;
    const cx = 32;
    const cy = 32;
    const field = makeField(size, (x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d <= 24 * 24 && d > 10 * 10;
    });
    const rings = marchingSquaresRings(field, size, size, 0);
    expect(rings.length).toBe(2);
  });

  it('returns nothing for an empty field', () => {
    const field = new Float32Array(16 * 16).fill(-1);
    expect(marchingSquaresRings(field, 16, 16, 0)).toEqual([]);
  });
});

describe('ring geometry helpers', () => {
  const square: Pt[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('computes signed area with CCW-positive convention', () => {
    expect(ringSignedArea(square)).toBeCloseTo(100, 5);
    expect(ringSignedArea(square.slice().reverse())).toBeCloseTo(-100, 5);
  });

  it('pointInRing distinguishes inside from outside', () => {
    expect(pointInRing({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInRing({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInRing({ x: -1, y: -1 }, square)).toBe(false);
  });

  it('simplifyRing keeps corners and drops collinear points', () => {
    const withNoise: Pt[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0.01 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
      { x: 5, y: 9.99 },
      { x: 0, y: 10 },
      { x: 0, y: 5 },
    ];
    const simplified = simplifyRing(withNoise, 0.1);
    expect(simplified.length).toBeLessThan(withNoise.length);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
    // Corners survive.
    expect(simplified).toContainEqual({ x: 0, y: 0 });
    expect(simplified).toContainEqual({ x: 10, y: 10 });
  });

  it('simplifyRing never returns fewer than 3 points', () => {
    const tiny: Pt[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(simplifyRing(tiny, 100).length).toBeGreaterThanOrEqual(3);
  });
});

describe('extractMaskPolygon', () => {
  const size = 64;
  const cx = 32;
  const cy = 32;

  it('extracts the disc under the seed point', () => {
    const field = makeField(size, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= 20 * 20);
    const poly = extractMaskPolygon({
      logits: field,
      width: size,
      height: size,
      seed: { x: cx, y: cy },
    });
    expect(poly).not.toBeNull();
    expect(poly!.holes).toEqual([]);
    expect(pointInRing({ x: cx, y: cy }, poly!.outer)).toBe(true);
    const area = Math.abs(ringSignedArea(poly!.outer));
    expect(area).toBeGreaterThan(Math.PI * 16 * 16);
    expect(area).toBeLessThan(Math.PI * 24 * 24);
  });

  it('includes holes of a donut mask', () => {
    const field = makeField(size, (x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d <= 24 * 24 && d > 10 * 10;
    });
    const poly = extractMaskPolygon({
      logits: field,
      width: size,
      height: size,
      seed: { x: cx + 17, y: cy },
    });
    expect(poly).not.toBeNull();
    expect(poly!.holes.length).toBe(1);
    // The hole lies inside the outer ring and does not contain the seed.
    expect(pointInRing(poly!.holes[0][0], poly!.outer)).toBe(true);
    expect(pointInRing({ x: cx + 17, y: cy }, poly!.holes[0])).toBe(false);
  });

  it('respects the vertex budget', () => {
    const field = makeField(size, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= 28 * 28);
    const poly = extractMaskPolygon({
      logits: field,
      width: size,
      height: size,
      seed: { x: cx, y: cy },
      maxPoints: 12,
    });
    expect(poly!.outer.length).toBeLessThanOrEqual(12);
  });

  it('returns null for an empty mask', () => {
    const field = new Float32Array(size * size).fill(-1);
    expect(extractMaskPolygon({ logits: field, width: size, height: size })).toBeNull();
  });
});

describe('nearestPointOnRings', () => {
  const square: Pt[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('snaps to the nearest edge point within tolerance', () => {
    const hit = nearestPointOnRings({ x: 5, y: -3 }, [square], 5);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5, 5);
    expect(hit!.point.y).toBeCloseTo(0, 5);
    expect(hit!.dist).toBeCloseTo(3, 5);
  });

  it('returns null beyond the tolerance', () => {
    expect(nearestPointOnRings({ x: 5, y: -8 }, [square], 5)).toBeNull();
  });

  it('picks the closest ring when several are in range', () => {
    const far: Pt[] = [
      { x: 100, y: 0 },
      { x: 110, y: 0 },
      { x: 110, y: 10 },
      { x: 100, y: 10 },
    ];
    const hit = nearestPointOnRings({ x: 5, y: -2 }, [far, square], 50);
    expect(hit).not.toBeNull();
    expect(hit!.ringIndex).toBe(1);
  });
});

describe('pixelRingToMapCoords', () => {
  it('maps pixel corners onto the snapshot extent', () => {
    const extent: [number, number, number, number] = [0, 0, 1000, 500];
    const ring: Pt[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 25 },
    ];
    const coords = pixelRingToMapCoords(ring, 100, 50, extent);
    expect(coords[0]).toEqual([0, 500]); // top-left
    expect(coords[1]).toEqual([1000, 500]); // top-right
    expect(coords[2]).toEqual([1000, 0]); // bottom-right
    expect(coords[3]).toEqual([500, 250]); // centre
  });
});
