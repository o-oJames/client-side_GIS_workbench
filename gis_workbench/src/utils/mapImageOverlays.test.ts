import OLMap from 'ol/Map.js';
import {
  buildLegendEntries,
  drawMapDetails,
  formatScaleLabel,
  formatScaleNumber,
  ImageDetailOptions,
  pickScaleDistance,
} from './mapImageOverlays';
import { RasterLayer, VectorLayerConfig } from '../types';

/* ------------------------------------------------------------------ */
/* Fakes                                                              */
/* ------------------------------------------------------------------ */

/** Minimal 2D-context stub that records calls instead of rasterising. */
function makeFakeCtx() {
  const calls: string[] = [];
  const record = (name: string) => (..._args: unknown[]) => {
    calls.push(name);
  };
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    arcTo: record('arcTo'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    measureText: (text: string) => ({ width: text.length * 7 }),
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
  } as unknown as CanvasRenderingContext2D & { calls: string[] };
}

function makeFakeMap(resolution = 10, center: [number, number] = [0, 0]): OLMap {
  return {
    getView: () => ({
      getResolution: () => resolution,
      getCenter: () => center,
    }),
  } as unknown as OLMap;
}

function makeFakeCanvas(ctx: unknown, width = 800, height = 600): HTMLCanvasElement {
  return {
    width,
    height,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

const ALL_OFF: ImageDetailOptions = { scaleBar: false, legend: false, northArrow: false };

function raster(overrides: Partial<RasterLayer> = {}): RasterLayer {
  return { id: 'r1', name: 'Raster', type: 'xyz', url: 'http://x/{z}/{x}/{y}.png', ...overrides };
}

function vector(overrides: Partial<VectorLayerConfig> = {}): VectorLayerConfig {
  return { id: 'v1', name: 'Vector', type: 'geojson', visible: true, ...overrides };
}

/* ------------------------------------------------------------------ */
/* buildLegendEntries                                                 */
/* ------------------------------------------------------------------ */

describe('buildLegendEntries', () => {
  it('lists visible raster layers then visible vector layers', () => {
    const entries = buildLegendEntries(
      [raster({ name: 'Topo' }), raster({ name: 'Hidden', visible: false })],
      [vector({ name: 'Parks' }), vector({ name: 'Off', visible: false })],
    );
    expect(entries.map((e) => e.label)).toEqual(['Topo', 'Parks']);
    expect(entries[0].kind).toBe('raster');
    expect(entries[1].kind).toBe('vector');
  });

  it('treats a raster layer with undefined visible as shown', () => {
    const entries = buildLegendEntries([raster()], []);
    expect(entries).toHaveLength(1);
  });

  it('carries vector styling through for the swatch', () => {
    const entries = buildLegendEntries(
      [],
      [vector({ lineColor: 'rgba(1, 2, 3, 1)', fillColor: 'rgba(1, 2, 3, 0.2)', lineWidth: 4 })],
    );
    expect(entries[0]).toMatchObject({
      strokeColor: 'rgba(1, 2, 3, 1)',
      fillColor: 'rgba(1, 2, 3, 0.2)',
      lineWidth: 4,
    });
  });

  it('falls back to generic names when a layer has none', () => {
    const entries = buildLegendEntries([raster({ name: '' })], [vector({ name: '' })]);
    expect(entries.map((e) => e.label)).toEqual(['Raster layer', 'Vector layer']);
  });
});

/* ------------------------------------------------------------------ */
/* Scale labels and distance picking                                  */
/* ------------------------------------------------------------------ */

describe('formatScaleNumber / formatScaleLabel', () => {
  it('strips floating point noise', () => {
    expect(formatScaleNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatScaleNumber(1500 / 5280 * 5280)).toBe('1500');
  });

  it('formats metric distances', () => {
    expect(formatScaleLabel(200, 'metric')).toBe('200 m');
    expect(formatScaleLabel(1000, 'metric')).toBe('1 km');
    expect(formatScaleLabel(2500, 'metric')).toBe('2.5 km');
  });

  it('formats imperial distances', () => {
    expect(formatScaleLabel(60.96, 'imperial')).toBe('200 ft'); // 200 ft in metres
    expect(formatScaleLabel(1609.344, 'imperial')).toBe('1 mi');
    expect(formatScaleLabel(8046.72, 'imperial')).toBe('5 mi');
  });
});

describe('pickScaleDistance', () => {
  it('picks the largest round metric distance that fits', () => {
    // 1 m/px, 140 px budget -> 100 m bar (100 px), not 200 m (200 px).
    const d = pickScaleDistance(1, 140, 'metric');
    expect(d).not.toBeNull();
    expect(d!.meters).toBe(100);
    expect(d!.px).toBe(100);
    expect(d!.label).toBe('100 m');
  });

  it('labels kilometre distances', () => {
    const d = pickScaleDistance(10, 140, 'metric');
    expect(d!.meters).toBe(1000);
    expect(d!.label).toBe('1 km');
    expect(d!.px).toBe(100);
  });

  it('uses round feet below a mile and round miles beyond', () => {
    const feetCase = pickScaleDistance(1, 140, 'imperial');
    expect(feetCase!.label).toBe('200 ft');
    // 100 m/px -> best fit is 5 miles.
    const mileCase = pickScaleDistance(100, 140, 'imperial');
    expect(mileCase!.label).toBe('5 mi');
    expect(mileCase!.meters).toBeCloseTo(8046.72, 0);
  });

  it('returns null for a degenerate resolution', () => {
    expect(pickScaleDistance(0, 140, 'metric')).toBeNull();
    expect(pickScaleDistance(-5, 140, 'metric')).toBeNull();
    expect(pickScaleDistance(NaN, 140, 'metric')).toBeNull();
  });

  it('falls back to the smallest round distance when extremely zoomed in', () => {
    // 0.1 m is the smallest metric candidate; at 0.1 mm/px it overshoots the
    // preferred width but still returns a valid (if long) bar.
    const d = pickScaleDistance(0.0001, 140, 'metric');
    expect(d!.meters).toBe(0.1);
    expect(d!.label).toBe('0.1 m');
    expect(d!.px).toBeGreaterThan(140);
  });
});

/* ------------------------------------------------------------------ */
/* drawMapDetails (compositing entry point)                           */
/* ------------------------------------------------------------------ */

describe('drawMapDetails', () => {
  it('does nothing when every detail is disabled', () => {
    const ctx = makeFakeCtx();
    const canvas = makeFakeCanvas(ctx);
    let contextRequested = false;
    const spyCanvas = {
      ...canvas,
      getContext: () => {
        contextRequested = true;
        return ctx;
      },
    } as unknown as HTMLCanvasElement;
    drawMapDetails(spyCanvas, makeFakeMap(), ALL_OFF, 'metric', []);
    expect(contextRequested).toBe(false);
    expect(ctx.calls).toHaveLength(0);
  });

  it('draws the north arrow when enabled', () => {
    const ctx = makeFakeCtx();
    drawMapDetails(
      makeFakeCanvas(ctx),
      makeFakeMap(),
      { ...ALL_OFF, northArrow: true },
      'metric',
      [],
    );
    expect(ctx.calls).toContain('arc'); // arrow background disc
    expect(ctx.calls).toContain('fillText'); // the "N" label
  });

  it('draws the scale bar when enabled', () => {
    const ctx = makeFakeCtx();
    drawMapDetails(
      makeFakeCanvas(ctx),
      makeFakeMap(10), // 10 m/px at the equator -> 1 km bar
      { ...ALL_OFF, scaleBar: true },
      'metric',
      [],
    );
    expect(ctx.calls).toContain('fillRect'); // bar segments
    expect(ctx.calls).toContain('strokeRect'); // bar outline
  });

  it('draws legend rows for the given entries', () => {
    const ctx = makeFakeCtx();
    drawMapDetails(
      makeFakeCanvas(ctx),
      makeFakeMap(),
      { ...ALL_OFF, legend: true },
      'metric',
      [
        { label: 'Topo', kind: 'raster' },
        { label: 'Parks', kind: 'vector', strokeColor: 'rgba(0,0,0,1)' },
      ],
    );
    // Two swatches + panel = at least three traced rounded rects.
    expect(ctx.calls.filter((c) => c === 'fill').length).toBeGreaterThanOrEqual(3);
  });

  it('skips the legend when there are no entries', () => {
    const ctx = makeFakeCtx();
    drawMapDetails(
      makeFakeCanvas(ctx),
      makeFakeMap(),
      { ...ALL_OFF, legend: true },
      'metric',
      [],
    );
    expect(ctx.calls).toHaveLength(0);
  });

  it('tolerates a missing 2D context', () => {
    const canvas = { width: 100, height: 100, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() =>
      drawMapDetails(canvas, makeFakeMap(), { ...ALL_OFF, northArrow: true }, 'metric', []),
    ).not.toThrow();
  });
});
