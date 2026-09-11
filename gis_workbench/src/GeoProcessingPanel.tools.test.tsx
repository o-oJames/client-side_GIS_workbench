/**
 * GeoProcessingPanel.tools.test.tsx — walk EVERY tool in the DOM.
 *
 * `GeoProcessingPanel.test.tsx` covers the panel's behaviour on a handful of
 * tools. This file is the exhaustive pass: all 28 tools are selected in turn and
 * each one must (a) render a form with a description and a Run button, (b) run
 * without throwing, and (c) produce a result layer, an inline error, a toast or
 * a progress bar — never silence. Then every tool that CAN run on the fixture is
 * actually run, on a polygon, a point and a line layer, because those three
 * geometry types exercise different code paths in the same tool.
 *
 * It also does the one styling check that does not need a browser: every `gp-*`
 * class the panel emits must exist in App.css. AGENTS.md forbids inventing a new
 * visual treatment for a control the app already has, and a class that renders
 * but has no rule is exactly how a panel ends up looking broken — this catches
 * that without a screenshot. (Reading App.css from a test has precedent in
 * MapPage.settingsDraft.test.tsx.)
 *
 * WHY IT EXISTS: Stage 2 added ~15 new controls and 4 new tools to this panel and
 * none of it had been rendered anywhere. A headless-Chrome walkthrough is the
 * better check for layout (jsdom has no layout engine), but this covers the
 * functional half permanently, in CI, on every run.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import { GeoProcessingPanel } from './App';
import type { VectorLayerConfig } from './types';

const ALL_TOOLS = [
  'Centroids', 'Point on Surface', 'Check Validity', 'Make Valid', 'Collect Geometries',
  'Delaunay Triangulation', 'Densify by Count', 'Add Geometry Attributes', 'Extract Vertices',
  'Multipart to Singleparts', 'Polygons to Lines', 'Simplify', 'Voronoi Polygons',
  'Lines to Polygons', 'Polygonize',
  'Buffer', 'Clip', 'Intersect', 'Union', 'Difference', 'Symmetrical Difference', 'Dissolve',
  'Convex Hull', 'Distance', 'Eliminate selected polygons',
  'Merge Vector Layers', 'Split Vector Layer', 'Remove selected features',
];

/** Tools that can produce a result from ONE polygon layer. */
const POLYGON_TOOLS = [
  'Centroids', 'Point on Surface', 'Check Validity', 'Make Valid', 'Collect Geometries',
  'Densify by Count', 'Add Geometry Attributes', 'Extract Vertices', 'Multipart to Singleparts',
  'Polygons to Lines', 'Simplify', 'Buffer', 'Dissolve', 'Convex Hull',
];
// 'Split Vector Layer' is deliberately NOT here: with no field chosen it must
// refuse with an inline error, which the "responds to Run" suite asserts instead.
// 'Merge Vector Layers' needs two layers ticked, and the three selection/overlay
// tools need a second layer or a map to click on.
/** Tools that can produce a result from ONE point layer. */
const POINT_TOOLS = [
  'Centroids', 'Add Geometry Attributes', 'Extract Vertices', 'Buffer', 'Densify by Count',
  'Delaunay Triangulation', 'Voronoi Polygons', 'Collect Geometries', 'Check Validity',
];
/** Tools that can produce a result from ONE line layer. */
const LINE_TOOLS = [
  'Buffer', 'Simplify', 'Densify by Count', 'Extract Vertices', 'Add Geometry Attributes',
  'Lines to Polygons', 'Polygonize', 'Collect Geometries', 'Check Validity',
];

function square(x0: number, y0: number, x1: number, y1: number, props: Record<string, any> = {}) {
  return new Feature({
    geometry: new Polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]),
    ...props,
  });
}

function polygonLayer(): { config: VectorLayerConfig; olLayer: any } {
  const source = new VectorSource({
    features: [
      square(0, 0, 10, 10, { id: 'a', zone: 'north' }),
      square(10, 0, 20, 10, { id: 'b', zone: 'north' }),   // shares an edge with a
      square(40, 40, 55, 50, { id: 'c', zone: 'south' }),
    ],
  });
  return {
    config: { id: 'poly', name: 'Parcels', type: 'geojson', visible: true } as VectorLayerConfig,
    olLayer: { _rawSource: source, getSource: () => source },
  };
}

function pointLayer(): { config: VectorLayerConfig; olLayer: any } {
  const source = new VectorSource({
    features: [
      new Feature({ geometry: new Point([0, 0]), name: 'p1' }),
      new Feature({ geometry: new Point([100, 0]), name: 'p2' }),
      new Feature({ geometry: new Point([0, 100]), name: 'p3' }),
      new Feature({ geometry: new Point([100, 100]), name: 'p4' }),
      new Feature({ geometry: new Point([50, 50]), name: 'p5' }),
    ],
  });
  return {
    config: { id: 'pts', name: 'POIs', type: 'geojson', visible: true } as VectorLayerConfig,
    olLayer: { _rawSource: source, getSource: () => source },
  };
}

function lineLayer(): { config: VectorLayerConfig; olLayer: any } {
  const source = new VectorSource({
    features: [
      new Feature({ geometry: new LineString([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), name: 'loop' }),
      new Feature({ geometry: new LineString([[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]), name: 'loop2' }),
      new Feature({ geometry: new LineString([[0, 20], [40, 20]]), name: 'cross' }),
    ],
  });
  return {
    config: { id: 'lns', name: 'Roads', type: 'geojson', visible: true } as VectorLayerConfig,
    olLayer: { _rawSource: source, getSource: () => source },
  };
}

function renderPanel(layers: { config: VectorLayerConfig; olLayer: any }[]) {
  const byId = new Map(layers.map(l => [l.config.id, l.olLayer]));
  const onAddResultLayer = vi.fn();
  const showToast = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <GeoProcessingPanel
      vectorLayers={layers.map(l => l.config)}
      map={null}
      getOlLayer={(id: string) => byId.get(id) ?? null}
      onAddResultLayer={onAddResultLayer}
      onClose={onClose}
      showToast={showToast}
    />
  );
  return { ...utils, onAddResultLayer, showToast, onClose };
}

function selectTool(name: string) {
  const button = screen.getByRole('button', { name });
  fireEvent.click(button);
  return button;
}

/** Every class name currently in the panel, flattened. */
function classesIn(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  container.querySelectorAll('[class]').forEach(el => {
    String(el.getAttribute('class')).split(/\s+/).forEach(c => c && out.add(c));
  });
  return out;
}

const cssPath = join(__dirname, 'App.css');
const APP_CSS = readFileSync(cssPath, 'utf8');

describe('Vector Tools: every tool renders', () => {
  it('all 28 tools show a description, a Run button and a named output', () => {
    const { container } = renderPanel([polygonLayer(), pointLayer(), lineLayer()]);
    expect(ALL_TOOLS).toHaveLength(28);
    for (const tool of ALL_TOOLS) {
      selectTool(tool);
      const description = container.querySelector('.gp-form-description');
      expect(description, `${tool}: no description rendered`).toBeTruthy();
      expect((description!.textContent || '').length, `${tool}: empty description`).toBeGreaterThan(20);
      const run = container.querySelector('.gp-run-button') as HTMLButtonElement | null;
      expect(run, `${tool}: no Run button`).toBeTruthy();
      expect(run!.disabled, `${tool}: Run is disabled with an input layer selected`).toBe(false);
      const output = container.querySelector('input[placeholder="Result layer name"]') as HTMLInputElement | null;
      expect(output, `${tool}: no output-name field`).toBeTruthy();
      expect(output!.value, `${tool}: output name not defaulted`).toContain(tool.split(' ')[0]);
    }
  });

  it('invents no CSS: every gp-* class the panel renders is defined in App.css', () => {
    const { container } = renderPanel([polygonLayer(), pointLayer(), lineLayer()]);
    const used = new Set<string>();
    for (const tool of ALL_TOOLS) {
      selectTool(tool);
      classesIn(container).forEach(c => used.add(c));
    }
    const gpClasses = [...used].filter(c => c.startsWith('gp-'));
    expect(gpClasses.length).toBeGreaterThan(40);
    const undefinedClasses = gpClasses.filter(c => !APP_CSS.includes(`.${c}`));
    expect(undefinedClasses, 'gp-* classes with no rule in App.css').toEqual([]);
  });

  it('has the window chrome: 8 resize handles, a close button, a searchable rail', () => {
    const { container } = renderPanel([polygonLayer()]);
    expect(container.querySelectorAll('.gp-resize')).toHaveLength(8);
    expect(container.querySelector('.gp-titlebar-close')).toBeTruthy();
    expect(container.querySelector('.gp-rail-search-input')).toBeTruthy();
    expect(container.querySelectorAll('.gp-rail-tool')).toHaveLength(28);
    expect(container.querySelectorAll('.gp-rail-category')).toHaveLength(3);
  });

  it('warns in amber only where a tool declares itself approximate', () => {
    const { container } = renderPanel([polygonLayer(), pointLayer()]);
    const warnings: string[] = [];
    const notes: string[] = [];
    for (const tool of ALL_TOOLS) {
      selectTool(tool);
      const amber = container.querySelector('.gp-form-hint--warning');
      if (amber) warnings.push(tool);
      // A neutral note is the same element without the warning modifier.
      const plain = [...container.querySelectorAll('.gp-form-hint')]
        .filter(e => !e.className.includes('gp-form-hint--warning'));
      if (plain.length) notes.push(tool);
    }
    // Delaunay is the one tool still flagged approximate after the kernel landed.
    expect(warnings).toEqual(['Delaunay Triangulation']);
    // Buffer, Voronoi, Dissolve and Eliminate carry honest neutral notes.
    expect(notes).toContain('Buffer');
    expect(notes).toContain('Voronoi Polygons');
    expect(notes).toContain('Dissolve');
    expect(notes).toContain('Eliminate selected polygons');
  });
});

describe('Vector Tools: every tool responds to Run', () => {
  /**
   * No tool may fail silently. Each one must either add a result layer, show a
   * toast, render an inline error, or start the progress bar.
   */
  async function expectResponse(tool: string, ctx: {
    onAddResultLayer: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
    container: HTMLElement;
  }) {
    selectTool(tool);
    ctx.onAddResultLayer.mockClear();
    ctx.showToast.mockClear();
    fireEvent.click(ctx.container.querySelector('.gp-run-button')!);
    await waitFor(() => {
      const responded = ctx.onAddResultLayer.mock.calls.length > 0
        || ctx.showToast.mock.calls.length > 0
        || !!ctx.container.querySelector('.gp-error')
        || !!ctx.container.querySelector('.gp-progress');
      expect(responded, `${tool}: Run produced nothing at all`).toBe(true);
    }, { timeout: 8000 });
  }

  it('on a polygon layer', async () => {
    const ctx = renderPanel([polygonLayer(), pointLayer()]);
    for (const tool of ALL_TOOLS) await expectResponse(tool, ctx);
  }, 120000);

  it('on a point layer', async () => {
    const ctx = renderPanel([pointLayer(), polygonLayer()]);
    for (const tool of ALL_TOOLS) await expectResponse(tool, ctx);
  }, 120000);

  it('on a line layer', async () => {
    const ctx = renderPanel([lineLayer(), polygonLayer()]);
    for (const tool of ALL_TOOLS) await expectResponse(tool, ctx);
  }, 120000);
});

describe('Vector Tools: the tools that can run, do run', () => {
  async function runExpectingResult(tool: string, ctx: ReturnType<typeof renderPanel>) {
    selectTool(tool);
    ctx.onAddResultLayer.mockClear();
    fireEvent.click(ctx.container.querySelector('.gp-run-button')!);
    await waitFor(() => {
      expect(ctx.onAddResultLayer.mock.calls.length, `${tool}: expected a result layer`).toBeGreaterThan(0);
    }, { timeout: 10000 });
    const [geoJsonStr, name] = ctx.onAddResultLayer.mock.calls[0];
    expect(typeof geoJsonStr).toBe('string');
    expect(geoJsonStr.length).toBeGreaterThan(20);
    expect(String(name).length).toBeGreaterThan(0);
    // Whatever came back must parse as a FeatureCollection with features.
    const parsed = JSON.parse(geoJsonStr);
    expect(parsed.type).toBe('FeatureCollection');
    expect(Array.isArray(parsed.features)).toBe(true);
    expect(parsed.features.length, `${tool}: result has no features`).toBeGreaterThan(0);
    return parsed;
  }

  it('polygon tools produce real FeatureCollections', async () => {
    const ctx = renderPanel([polygonLayer()]);
    for (const tool of POLYGON_TOOLS) {
      const result = await runExpectingResult(tool, ctx);
      expect(result.features.every((f: any) => f.type === 'Feature')).toBe(true);
    }
  }, 120000);

  it('point tools produce real FeatureCollections', async () => {
    const ctx = renderPanel([pointLayer()]);
    for (const tool of POINT_TOOLS) {
      const result = await runExpectingResult(tool, ctx);
      expect(result.features.every((f: any) => f.type === 'Feature')).toBe(true);
    }
  }, 120000);

  it('line tools produce real FeatureCollections', async () => {
    const ctx = renderPanel([lineLayer()]);
    for (const tool of LINE_TOOLS) {
      const result = await runExpectingResult(tool, ctx);
      expect(result.features.every((f: any) => f.type === 'Feature')).toBe(true);
    }
  }, 120000);

  it('sanity-checks a few results geometrically, not just structurally', async () => {
    const ctx = renderPanel([polygonLayer()]);

    // Buffer by 0 keeps the area; a real buffer grows it.
    selectTool('Buffer');
    ctx.onAddResultLayer.mockClear();
    fireEvent.click(ctx.container.querySelector('.gp-run-button')!);
    await waitFor(() => expect(ctx.onAddResultLayer.mock.calls.length).toBeGreaterThan(0), { timeout: 10000 });
    const buffered = JSON.parse(ctx.onAddResultLayer.mock.calls[0][0] as string);
    expect(buffered.features.length).toBe(3);
    // A buffered square is round-cornered: its shell has one vertex per arc
    // segment, not the four the input had. (Ring COUNT would be 1 — that is the
    // number of holes plus one, not the tessellation.)
    const shellVertices = (f: any) => (f.geometry.type === 'Polygon'
      ? f.geometry.coordinates[0].length
      : f.geometry.coordinates[0][0].length);
    expect(shellVertices(buffered.features[0])).toBeGreaterThan(8);

    // Dissolve merges the two edge-sharing squares into one feature.
    const dissolved = await (async () => {
      selectTool('Dissolve');
      ctx.onAddResultLayer.mockClear();
      fireEvent.click(ctx.container.querySelector('.gp-run-button')!);
      await waitFor(() => expect(ctx.onAddResultLayer.mock.calls.length).toBeGreaterThan(0), { timeout: 10000 });
      return JSON.parse(ctx.onAddResultLayer.mock.calls[0][0] as string);
    })();
    expect(dissolved.features.length).toBe(1);

    // Check Validity adds the result AND the error-point layer.
    selectTool('Check Validity');
    ctx.onAddResultLayer.mockClear();
    fireEvent.click(ctx.container.querySelector('.gp-run-button')!);
    await waitFor(() => expect(ctx.onAddResultLayer.mock.calls.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
  }, 120000);

  it('the single-sided checkbox really buffers a line on one side only', async () => {
    const ctx = renderPanel([lineLayer()]);
    selectTool('Buffer');
    const run = async () => {
      ctx.onAddResultLayer.mockClear();
      fireEvent.click(ctx.container.querySelector('.gp-run-button')!);
      await waitFor(() => expect(ctx.onAddResultLayer.mock.calls.length).toBeGreaterThan(0), { timeout: 10000 });
      return JSON.parse(ctx.onAddResultLayer.mock.calls[0][0] as string);
    };
    const area = (fc: any) => fc.features.reduce((sum: number, f: any) => {
      const parts = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      return sum + parts.reduce((p: number, rings: number[][][]) => p + rings.reduce(
        (a: number, ring: number[][], i: number) => {
          let twice = 0;
          for (let i2 = 0; i2 < ring.length - 1; i2++) twice += ring[i2][0] * ring[i2 + 1][1] - ring[i2 + 1][0] * ring[i2][1];
          return a + (i === 0 ? 1 : -1) * Math.abs(twice / 2);
        }, 0), 0);
    }, 0);

    const bothSides = await run();
    const singleSided = screen.getByLabelText(/Single-sided/i) as HTMLInputElement;
    expect(singleSided.checked).toBe(false);
    fireEvent.click(singleSided);
    expect(singleSided.checked).toBe(true);
    const oneSide = await run();

    expect(bothSides.features.length).toBe(3);
    expect(oneSide.features.length).toBe(3);
    // The fixture is two closed 10x10 counter-clockwise loops and one straight
    // 40-unit line, at the panel's default 100 m. Per feature, at y ~ 0 the
    // Mercator scale is 1, so the numbers are exact:
    //   • the straight line: one side only = L x d = 40 x 100 = 4000, flat ends;
    //   • a closed loop: its left side IS its inside, so the band clipped by the
    //     ring is the 100-unit interior (GEOS's `buffer(d, single_sided=True)`
    //     agrees; see utils/overlay.geos.test.ts).
    const twoSided = bothSides.features.map((f: any) => area({ features: [f] } as any));
    const oneSided = oneSide.features.map((f: any) => area({ features: [f] } as any));
    expect(oneSided[0]).toBeCloseTo(100, 6);
    expect(oneSided[1]).toBeCloseTo(100, 6);
    expect(oneSided[2]).toBeCloseTo(4000, 6);
    // Two-sided, the same line is 2·d·L + π·d² less the tessellation of its two
    // round caps (8 segments per quarter circle undershoots a disc by ~0.6 %).
    const exactLine = 2 * 100 * 40 + Math.PI * 100 * 100;
    expect(twoSided[2]).toBeGreaterThan(exactLine * 0.99);
    expect(twoSided[2]).toBeLessThan(exactLine);
    expect(area(oneSide)).toBeLessThan(area(bothSides) * 0.1);
    // Unticking goes back to the two-sided answer, so the control is wired both ways.
    fireEvent.click(singleSided);
    expect(area(await run())).toBeCloseTo(area(bothSides), 6);
  }, 120000);
});
