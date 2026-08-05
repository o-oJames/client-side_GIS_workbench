import { normalizeRgbToChw, pickBestMaskIndex } from './samEngine';

describe('normalizeRgbToChw', () => {
  it('normalises pure red into CHW planes with ImageNet stats', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255]);
    const out = normalizeRgbToChw(rgba, 1, 1);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(out[1]).toBeCloseTo((0 - 0.456) / 0.224, 5);
    expect(out[2]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });

  it('lays pixels out plane by plane', () => {
    // Two pixels: white then black.
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const out = normalizeRgbToChw(rgba, 2, 1);
    expect(out.length).toBe(6);
    // R plane: [white, black]
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(out[1]).toBeCloseTo((0 - 0.485) / 0.229, 5);
    // G plane: [white, black]
    expect(out[2]).toBeCloseTo((1 - 0.456) / 0.224, 5);
    expect(out[3]).toBeCloseTo((0 - 0.456) / 0.224, 5);
    // B plane: [white, black]
    expect(out[4]).toBeCloseTo((1 - 0.406) / 0.225, 5);
    expect(out[5]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });
});

describe('pickBestMaskIndex', () => {
  it('returns the index of the highest IoU', () => {
    expect(pickBestMaskIndex([0.1, 0.9, 0.5])).toBe(1);
    expect(pickBestMaskIndex([0.8, 0.2, 0.3])).toBe(0);
    expect(pickBestMaskIndex([0.2, 0.3, 0.95])).toBe(2);
  });

  it('defaults to the first candidate on ties', () => {
    expect(pickBestMaskIndex([0.5, 0.5, 0.5])).toBe(0);
  });
});
