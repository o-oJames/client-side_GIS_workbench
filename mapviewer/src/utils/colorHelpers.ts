import type { Rgba } from '../types';

// Parse any CSS color string (hex, rgb, rgba) into RGBA components.
export function parseColor(color: string | undefined, defaultAlpha: number): Rgba {
  const fallback: Rgba = { r: 66, g: 133, b: 244, a: defaultAlpha };
  if (!color) return fallback;
  const c = color.trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    if (hex.length === 6) hex += 'ff';
    if (hex.length < 8) return fallback;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = parseInt(hex.slice(6, 8), 16) / 255;
    if ([r, g, b].some(isNaN)) return fallback;
    return { r, g, b, a: isNaN(a) ? defaultAlpha : a };
  }
  const m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (m) {
    return {
      r: Math.round(parseFloat(m[1])),
      g: Math.round(parseFloat(m[2])),
      b: Math.round(parseFloat(m[3])),
      a: m[4] !== undefined ? parseFloat(m[4]) : defaultAlpha,
    };
  }
  return fallback;
}

export function rgbaToString({ r, g, b, a }: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`;
}

export function rgbaToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

// A random, distinguishable line/fill color pair (same hue, fill is translucent).
// Returning the exact values used for the OL style keeps the color editor in sync
// with what is actually drawn on the map.
export function getRandomVectorColors(): { lineColor: string; fillColor: string } {
  const hue = Math.floor(Math.random() * 360);
  const { r, g, b } = hslToRgb(hue, 70, 50);
  return {
    lineColor: rgbaToString({ r, g, b, a: 1 }),
    fillColor: rgbaToString({ r, g, b, a: 0.3 }),
  };
}

// Normalize an OpenLayers color (CSS string or [r,g,b,a] array, a in 0-1) to an rgba() string.
export function normalizeOlColor(color: any, defaultAlpha: number): string {
  if (color == null) {
    return rgbaToString({ r: 66, g: 133, b: 244, a: defaultAlpha });
  }
  if (Array.isArray(color)) {
    const [r, g, b, a] = color;
    return rgbaToString({
      r: Math.round(r),
      g: Math.round(g),
      b: Math.round(b),
      a: a != null ? a : defaultAlpha,
    });
  }
  return rgbaToString(parseColor(String(color), defaultAlpha));
}
