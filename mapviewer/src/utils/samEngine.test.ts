import {
  MIN_MODEL_BYTES,
  normalizeRgbToChw,
  pickBestMaskIndex,
  promptLabelsToInt64,
  validateStaticPayload,
} from './samEngine';
import { SamPromptPoint } from './samModels';

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

describe('validateStaticPayload', () => {
  it('rejects an SPA-fallback HTML page served with 200', () => {
    expect(validateStaticPayload('encoder', 'text/html', 5000)).toMatch(/HTML fallback/);
    expect(validateStaticPayload('decoder', 'text/html; charset=utf-8', 5000)).toMatch(/HTML fallback/);
    expect(validateStaticPayload('encoder', 'TEXT/HTML', 5000)).toMatch(/HTML fallback/);
  });

  it('rejects implausibly small payloads (e.g. Git-LFS pointer stubs)', () => {
    expect(validateStaticPayload('encoder', 'application/octet-stream', 130)).toMatch(/implausibly small/);
    expect(validateStaticPayload('decoder', '', MIN_MODEL_BYTES - 1)).toMatch(/implausibly small/);
  });

  it('accepts a real-sized binary payload', () => {
    expect(validateStaticPayload('encoder', 'application/octet-stream', 23_276_014)).toBeNull();
    expect(validateStaticPayload('decoder', '', MIN_MODEL_BYTES)).toBeNull();
  });
});

describe('promptLabelsToInt64', () => {
  const pt = (label: 0 | 1): SamPromptPoint => ({ x: 0, y: 0, label });

  it('maps SAM prompt labels to int64 (1 = foreground, 0 = background)', () => {
    const out = promptLabelsToInt64([pt(1), pt(0), pt(1)]);
    expect(out).toBeInstanceOf(BigInt64Array);
    expect(Array.from(out)).toEqual([BigInt(1), BigInt(0), BigInt(1)]);
  });

  it('returns an empty array for no points', () => {
    expect(promptLabelsToInt64([]).length).toBe(0);
  });
});
