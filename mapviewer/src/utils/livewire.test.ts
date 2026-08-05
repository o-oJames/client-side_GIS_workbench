// ---------------------------------------------------------------------------
// Unit tests for the classical (model-free) livewire edge extraction used by
// the magnetic drawing mode.
// ---------------------------------------------------------------------------

import {
  rgbaToLumaDownsampled,
  gaussianBlur3,
  sobelGradient,
  nonMaxSuppress,
  traceEdgeChains,
  simplifyPolyline,
  computeThresholds,
  nearestPointOnPolylines,
  extractEdgePolylines,
  ImageLike,
} from './livewire';

/** Build an RGBA image from a per-pixel luminance callback. */
function makeImage(width: number, height: number, lumaAt: (x: number, y: number) => number): ImageLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = Math.max(0, Math.min(255, Math.round(lumaAt(x, y))));
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('rgbaToLumaDownsampled', () => {
  it('averages greyscale values and reports scale factors', () => {
    // Left half black, right half white; request a working grid half size.
    const img = makeImage(200, 100, (x) => (x < 100 ? 0 : 255));
    const { luma, width, height, scaleX, scaleY } = rgbaToLumaDownsampled(img, 100);
    expect(width).toBe(100);
    expect(height).toBe(50);
    expect(scaleX).toBeCloseTo(2, 5);
    expect(scaleY).toBeCloseTo(2, 5);
    // Deep inside each half the box average matches the source value.
    expect(luma[25 * width + 10]).toBeCloseTo(0, 1);
    expect(luma[25 * width + 90]).toBeCloseTo(255, 1);
  });

  it('does not upscale small images', () => {
    const img = makeImage(8, 6, () => 128);
    const { width, height } = rgbaToLumaDownsampled(img, 720);
    expect(width).toBe(8);
    expect(height).toBe(6);
  });
});

describe('gaussianBlur3 / sobelGradient / nonMaxSuppress', () => {
  it('blur keeps a constant field constant', () => {
    const f = new Float32Array(64).fill(42);
    const out = gaussianBlur3(f, 8, 8);
    out.forEach((v) => expect(v).toBeCloseTo(42, 4));
  });

  it('sobel finds a strong vertical gradient at a vertical edge only', () => {
    const img = makeImage(32, 32, (x) => (x < 16 ? 0 : 255));
    const { luma, width, height } = rgbaToLumaDownsampled(img, 32);
    const { gx, gy, mag } = sobelGradient(luma, width, height);
    const midRow = 16 * width;
    // Strong horizontal gradient at the edge column.
    expect(Math.abs(gx[midRow + 15])).toBeGreaterThan(500);
    expect(mag[midRow + 15]).toBeGreaterThan(500);
    // Far from the edge the gradient vanishes.
    expect(mag[midRow + 3]).toBe(0);
    expect(mag[midRow + 29]).toBe(0);
    // A vertical step edge produces no horizontal gradient component.
    expect(Math.abs(gy[midRow + 15])).toBeLessThan(Math.abs(gx[midRow + 15]));
  });

  it('non-max suppression thins the edge ridge to ~1 pixel', () => {
    const img = makeImage(64, 64, (x) => (x < 32 ? 0 : 255));
    const { luma, width, height } = rgbaToLumaDownsampled(img, 64);
    const blurred = gaussianBlur3(luma, width, height);
    const { gx, gy, mag } = sobelGradient(blurred, width, height);
    const nms = nonMaxSuppress(mag, gx, gy, width, height);
    // Count surviving (nonzero) pixels on a middle row — should be a thin
    // band around the true edge at x=32.
    const row = 32 * width;
    const survivors: number[] = [];
    for (let x = 0; x < width; x++) {
      if (nms[row + x] > 0) survivors.push(x);
    }
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThanOrEqual(2);
    survivors.forEach((x) => expect(Math.abs(x - 32)).toBeLessThanOrEqual(2));
  });
});

describe('traceEdgeChains', () => {
  it('returns nothing on a flat field', () => {
    const nms = new Float32Array(32 * 32);
    expect(traceEdgeChains(nms, 32, 32, 50, 20, 5)).toEqual([]);
  });

  it('walks a synthetic horizontal ridge into one ordered chain', () => {
    const w = 40;
    const h = 20;
    const nms = new Float32Array(w * h);
    for (let x = 2; x < w - 2; x++) nms[10 * w + x] = 100; // strong ridge
    const chains = traceEdgeChains(nms, w, h, 50, 20, 5);
    expect(chains.length).toBe(1);
    const chain = chains[0];
    expect(chain.length).toBe(w - 4);
    // Ordered along the ridge (allow either direction), y fixed on the ridge.
    chain.forEach((p) => expect(p.y).toBe(10));
    const xs = chain.map((p) => p.x);
    const increasing = xs.every((v, i) => i === 0 || v === xs[i - 1] + 1);
    const decreasing = xs.every((v, i) => i === 0 || v === xs[i - 1] - 1);
    expect(increasing || decreasing).toBe(true);
  });
});

describe('simplifyPolyline', () => {
  it('drops collinear points but keeps endpoints and corners', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
    ];
    const out = simplifyPolyline(pts, 0.1);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
    ]);
  });

  it('keeps short polylines untouched', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ];
    expect(simplifyPolyline(pts, 1)).toEqual(pts);
  });
});

/** Build an RGBA image from a per-pixel RGB callback. */
function makeColorImage(
  width: number,
  height: number,
  rgbAt: (x: number, y: number) => [number, number, number],
): ImageLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = rgbAt(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('colour gradient', () => {
  it('detects an isoluminant colour edge that greyscale would miss', () => {
    // Both halves have identical luminance (~76) — only the colour differs.
    const img = makeColorImage(96, 64, (x) =>
      x < 48 ? [255, 0, 0] : [0, 110, 102],
    );
    const { chains } = extractEdgePolylines(img, { maxDim: 96 });
    expect(chains.length).toBeGreaterThan(0);
    const xs = chains[0].map((p) => p.x);
    xs.forEach((x) => expect(Math.abs(x - 48)).toBeLessThanOrEqual(3));
  });
});

describe('computeThresholds', () => {
  it('places the strong threshold at the top quantile, robust to outliers', () => {
    // 1000 edge pixels at magnitude 100 plus ONE extreme outlier at 10000.
    const nms = new Float32Array(2000);
    for (let i = 0; i < 1000; i++) nms[i] = 100;
    nms[1500] = 10000;
    const { high, low } = computeThresholds(nms, {
      strongRatio: 0.02,
      lowFactor: 0.4,
      minAbsHigh: 14,
    });
    // The outlier alone is only 1/1001 of the non-zero pixels, far below
    // the 2% strong ratio — so `high` must sit near 100, not near 10000.
    expect(high).toBeGreaterThan(50);
    expect(high).toBeLessThan(500);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(0);
  });

  it('returns the noise floor for an empty field', () => {
    const { high } = computeThresholds(new Float32Array(100), {
      strongRatio: 0.02,
      lowFactor: 0.4,
      minAbsHigh: 14,
    });
    expect(high).toBe(14);
  });
});

describe('nearestPointOnPolylines', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it('snaps to the nearest segment point within tolerance', () => {
    const hit = nearestPointOnPolylines({ x: 5, y: 3 }, [line], 5);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5, 5);
    expect(hit!.point.y).toBeCloseTo(0, 5);
    expect(hit!.dist).toBeCloseTo(3, 5);
  });

  it('does not wrap around the ends of an open polyline', () => {
    // A rings-style implementation would connect (10,10) back to (0,0) and
    // report a hit near (2,2); an open polyline must return null here.
    const hit = nearestPointOnPolylines({ x: 2, y: 2 }, [line], 1.5);
    expect(hit).toBeNull();
  });

  it('returns null beyond the tolerance', () => {
    expect(nearestPointOnPolylines({ x: 5, y: 30 }, [line], 5)).toBeNull();
  });

  it('picks the closest of several polylines', () => {
    const other = [
      { x: 0, y: 4 },
      { x: 10, y: 4 },
    ];
    const hit = nearestPointOnPolylines({ x: 5, y: 3 }, [line, other], 10);
    expect(hit).not.toBeNull();
    expect(hit!.lineIndex).toBe(1);
    expect(hit!.point.y).toBeCloseTo(4, 5);
  });
});

describe('extractEdgePolylines', () => {
  it('finds the vertical edge of a half-black/half-white image', () => {
    const img = makeImage(96, 64, (x) => (x < 48 ? 0 : 255));
    const { chains, width, height } = extractEdgePolylines(img, { maxDim: 96 });
    expect(width).toBe(96);
    expect(height).toBe(64);
    expect(chains.length).toBeGreaterThan(0);
    // The longest chain runs vertically along x ≈ 48 covering most rows.
    const longest = chains[0];
    const ys = longest.map((p) => p.y);
    const xs = longest.map((p) => p.x);
    expect(Math.min(...ys)).toBeLessThan(8);
    expect(Math.max(...ys)).toBeGreaterThan(56);
    xs.forEach((x) => expect(Math.abs(x - 48)).toBeLessThanOrEqual(3));
  });

  it('traces the boundary of a bright rectangle on a dark background', () => {
    const img = makeImage(120, 100, (x, y) => (x >= 30 && x < 90 && y >= 25 && y < 75 ? 255 : 0));
    const { chains } = extractEdgePolylines(img, { maxDim: 120 });
    expect(chains.length).toBeGreaterThan(0);
    const pts = chains[0];
    // The chain visits all four sides of the rectangle (±2 px slack).
    expect(pts.some((p) => Math.abs(p.x - 30) <= 2)).toBe(true);
    expect(pts.some((p) => Math.abs(p.x - 89) <= 2)).toBe(true);
    expect(pts.some((p) => Math.abs(p.y - 25) <= 2)).toBe(true);
    expect(pts.some((p) => Math.abs(p.y - 74) <= 2)).toBe(true);
  });

  it('still finds the edge when a single extreme outlier is present', () => {
    const img = makeImage(96, 64, (x, y) => {
      if (x === 80 && y === 5) return 0; // one dark spike (label/glint)
      return x < 48 ? 0 : 255;
    });
    const { chains } = extractEdgePolylines(img, { maxDim: 96 });
    expect(chains.length).toBeGreaterThan(0);
    const xs = chains[0].map((p) => p.x);
    xs.forEach((x) => expect(Math.abs(x - 48)).toBeLessThanOrEqual(3));
  });

  it('returns no chains for a uniform image', () => {
    const img = makeImage(80, 80, () => 128);
    const { chains } = extractEdgePolylines(img, { maxDim: 80 });
    expect(chains).toEqual([]);
  });

  it('respects maxChains and reports snapshot-space dimensions', () => {
    // Several separated vertical edges.
    const img = makeImage(160, 40, (x) => (x % 40 < 20 ? 0 : 255));
    const { chains, width } = extractEdgePolylines(img, { maxDim: 160, maxChains: 2 });
    expect(width).toBe(160);
    expect(chains.length).toBeLessThanOrEqual(2);
  });
});
