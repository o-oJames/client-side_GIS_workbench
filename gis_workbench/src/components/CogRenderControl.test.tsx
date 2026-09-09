/**
 * COG band / renderer control (raster layer edit form).
 *
 * The panel reads the band layout out of the live OL source, so these tests
 * stand up a fake `ol/source/GeoTIFF` (public `bandCount`/`hasAlpha` plus the
 * private `sourceImagery_` the app reads TIFF tags from) and drive the real
 * CustomSelect portal menus. The control is fully controlled — like
 * RasterLayerEditForm, the harness feeds every change back in and records it.
 */
import { useMemo, useState } from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { CogRenderControl } from './CogRenderControl';
import type { CogRenderConfig, RasterLayer } from '../types';

// --- fakes ------------------------------------------------------------------

function fakeImage(opts: {
  samplesPerPixel: number;
  bits?: number[];
  sampleFormats?: number[];
  tags?: Record<string, any>;
  metadata?: Array<Record<string, string> | null>;
  nodata?: number | null;
  size?: [number, number];
  rasters?: (read: { window?: number[]; interleave?: boolean }) => Promise<any>;
}) {
  const tags = opts.tags ?? {};
  return {
    fileDirectory: {
      loadValue: async (tag: string) => tags[tag],
      getValue: (tag: string) => tags[tag],
    },
    getSamplesPerPixel: () => opts.samplesPerPixel,
    getSampleFormat: (i: number) => opts.sampleFormats?.[i] ?? 1,
    getBitsPerSample: (i: number) => opts.bits?.[i] ?? 8,
    getGDALNoData: () => opts.nodata ?? null,
    getGDALMetadata: async (i: number) => opts.metadata?.[i] ?? null,
    getWidth: () => opts.size?.[0] ?? 0,
    getHeight: () => opts.size?.[1] ?? 0,
    readRasters: opts.rasters ?? (async () => { throw new Error('pixels not readable'); }),
  };
}

/**
 * A single-band Float32 DEM shaped like the ACT 25 cm DSM: stored statistics
 * of 399.052–910.751 (or none at all), and readable pixel values.
 */
function floatDemSource(withStats: boolean, rasters?: (read: any) => Promise<any>) {
  const image = fakeImage({
    samplesPerPixel: 1,
    sampleFormats: [3],
    bits: [32],
    size: [2, 2],
    metadata: withStats
      ? [{ STATISTICS_MINIMUM: '399.05200195312', STATISTICS_MAXIMUM: '910.7509765625' }]
      : [],
    rasters: rasters ?? (async () => [Float32Array.from([399.052, 500, 700, 910.751])]),
  });
  return { bandCount: 1, hasAlpha: false, sourceImagery_: [[image]] };
}

const actionButton = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll('button'))
    .find((b) => b.textContent === label) as HTMLButtonElement;

/** A 12-band multispectral file with statistics + names on every band. */
function multispectralSource() {
  const image = fakeImage({
    samplesPerPixel: 12,
    bits: new Array(12).fill(16),
    tags: { PhotometricInterpretation: 2 },
    metadata: Array.from({ length: 12 }, (_, i) => ({
      STATISTICS_MINIMUM: '1',
      STATISTICS_MAXIMUM: String(4000 + i),
      DESCRIPTION: ['Coastal', 'Blue', 'Green', 'Red', 'Red edge 1', 'Red edge 2',
        'Red edge 3', 'NIR', 'NIR narrow', 'SWIR 1', 'SWIR 2', 'Scene class'][i],
    })),
  });
  return { bandCount: 12, hasAlpha: false, sourceImagery_: [[image]] };
}

/** A single-band paletted land-cover file with three classes. */
function palettedSource() {
  const image = fakeImage({
    samplesPerPixel: 1,
    tags: {
      PhotometricInterpretation: 3,
      // 16-bit runs: reds, then greens, then blues
      ColorMap: [0, 65535, 0, 0, 0, 65535, 0, 0, 0],
    },
  });
  return { bandCount: 1, hasAlpha: false, sourceImagery_: [[image]] };
}

function cogLayer(source: any): RasterLayer {
  return {
    id: 'cog-1',
    name: 'Sentinel-2',
    type: 'cog',
    url: 'https://example.com/scene.tif',
    cogSource: 'http',
    olLayer: { getSource: () => source, setStyle: () => {} },
  };
}

// --- harness ----------------------------------------------------------------

function setup(source: any, initial: CogRenderConfig = { mode: 'auto' }) {
  const changes: CogRenderConfig[] = [];
  function Harness() {
    const [value, setValue] = useState<CogRenderConfig>(initial);
    const layer = useMemo(() => cogLayer(source), [source]);
    return (
      <CogRenderControl
        layer={layer}
        value={value}
        onChange={(next) => { changes.push(next); setValue(next); }}
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, changes };
}

const panel = (container: HTMLElement) =>
  container.querySelector('[data-testid="cog-render-control"]') as HTMLElement;
const toggle = (container: HTMLElement) =>
  panel(container).querySelector('.color-adjust-toggle') as HTMLButtonElement;
const badge = (container: HTMLElement) =>
  panel(container).querySelector('.color-adjust-badge') as HTMLElement;
const body = (container: HTMLElement) =>
  panel(container).querySelector('.color-adjust-body') as HTMLElement | null;

function selectTrigger(container: HTMLElement, label: string): HTMLButtonElement {
  const field = Array.from(container.querySelectorAll<HTMLElement>('.cog-render-field'))
    .find((f) => f.querySelector('.cog-render-field-label')?.textContent === label);
  const trigger = field?.querySelector('.custom-select-trigger') as HTMLButtonElement | undefined;
  if (!trigger) throw new Error(`No select labelled "${label}"`);
  return trigger;
}

async function choose(container: HTMLElement, label: string, optionLabel: string) {
  fireEvent.click(selectTrigger(container, label));
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll<HTMLElement>(
      '.custom-select-menu-portal .custom-select-option',
    )).find((o) => o.textContent?.trim() === optionLabel);
    if (!found) throw new Error(`option "${optionLabel}" not rendered yet`);
    return found;
  });
  fireEvent.click(option);
  return option;
}

/** Open the panel (unless a non-default config already opened it) and wait for the band read. */
async function expand(container: HTMLElement) {
  if (!body(container)) fireEvent.click(toggle(container));
  await waitFor(() => expect(container.querySelector('[data-testid="cog-render-file"]')).toBeTruthy());
}

const input = (container: HTMLElement, id: string) =>
  container.querySelector(`#${id}`) as HTMLInputElement | null;

// --- tests ------------------------------------------------------------------

describe('CogRenderControl', () => {
  test('starts collapsed with a "default" badge for an untouched layer', () => {
    const { container } = setup(multispectralSource());
    expect(body(container)).toBeNull();
    expect(badge(container).textContent).toBe('default');
    expect(badge(container).className).not.toContain('custom');
  });

  test('starts expanded when the layer already carries a renderer choice', () => {
    const { container } = setup(multispectralSource(), { mode: 'rgb', rgb: [4, 3, 2] });
    expect(badge(container).textContent).toBe('RGB 4·3·2');
    expect(badge(container).className).toContain('custom');
    expect(body(container)).toBeTruthy();
  });

  test('reads the band layout from the live source on expand', async () => {
    const { container } = setup(multispectralSource());
    fireEvent.click(toggle(container));
    await expand(container);
    expect(container.querySelector('[data-testid="cog-render-file"]')!.textContent).toContain('12 bands');
    // Band labels carry the file's own GDAL band names
    await choose(container, 'Renderer', 'Single band (grayscale)');
    fireEvent.click(selectTrigger(container, 'Band'));
    const labels = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.custom-select-menu-portal .custom-select-option'))
        .map((o) => o.textContent || '');
      if (found.length < 12) throw new Error('band list not rendered yet');
      return found;
    });
    expect(labels[3]).toBe('Band 4 — Red (UInt16)');
  });

  test('offers a fix for files the default renderer gets wrong', async () => {
    const { container, changes } = setup(multispectralSource());
    await expand(container);
    expect(container.textContent).toContain('this file has 12');
    const suggest = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Use suggested') as HTMLButtonElement;
    fireEvent.click(suggest);
    expect(changes).toEqual([{ mode: 'rgb', rgb: [1, 2, 3] }]);
    // ...and the suggestion goes away once a renderer is chosen
    await waitFor(() => expect(container.textContent).not.toContain('Use suggested'));
  });

  test("switching to single band seeds the stretch from that band's statistics", async () => {
    const { container, changes } = setup(multispectralSource());
    await expand(container);
    await choose(container, 'Renderer', 'Single band (grayscale)');
    expect(changes).toEqual([{ mode: 'single', band: 1, stretchMin: 1, stretchMax: 4000 }]);
    await waitFor(() => expect(input(container, 'cog-render-min')?.value).toBe('1'));
    expect(input(container, 'cog-render-max')?.value).toBe('4000');
    expect(container.textContent).toContain('Stored statistics: 1 to 4000');
  });

  test('picking an RGB combination reports the three bands', async () => {
    const { container, changes } = setup(multispectralSource(), { mode: 'rgb', rgb: [1, 2, 3] });
    await expand(container);
    await choose(container, 'Red', 'Band 4 — Red (UInt16)');
    expect(changes[changes.length - 1]).toEqual({ mode: 'rgb', rgb: [4, 2, 3] });
    await choose(container, 'Green', 'Band 3 — Green (UInt16)');
    expect(changes[changes.length - 1]).toEqual({ mode: 'rgb', rgb: [4, 3, 3] });
    expect(badge(container).textContent).toBe('RGB 4·3·3');
  });

  test('a stretch commits on Enter, not on every keystroke', async () => {
    const { container, changes } = setup(multispectralSource(), { mode: 'single', band: 5 });
    await expand(container);
    fireEvent.change(input(container, 'cog-render-min')!, { target: { value: '1' } });
    fireEvent.change(input(container, 'cog-render-min')!, { target: { value: '10' } });
    fireEvent.change(input(container, 'cog-render-max')!, { target: { value: '3500' } });
    expect(changes).toEqual([]);
    fireEvent.keyDown(input(container, 'cog-render-max')!, { key: 'Enter' });
    expect(changes).toEqual([{ mode: 'single', band: 5, stretchMin: 10, stretchMax: 3500 }]);
    expect(badge(container).textContent).toBe('Band 5 · 10–3500');
  });

  test('an inverted stretch is refused with a hint instead of applied', async () => {
    const { container, changes } = setup(multispectralSource(), { mode: 'single', band: 1 });
    await expand(container);
    fireEvent.change(input(container, 'cog-render-min')!, { target: { value: '500' } });
    fireEvent.change(input(container, 'cog-render-max')!, { target: { value: '10' } });
    fireEvent.blur(input(container, 'cog-render-max')!);
    expect(changes).toEqual([]);
    expect(body(container)!.textContent).toContain('Enter a minimum below the maximum');
  });

  test('the Auto button drops the stretch back to the file range', async () => {
    const { container, changes } = setup(
      multispectralSource(),
      { mode: 'single', band: 2, stretchMin: 1, stretchMax: 4001 },
    );
    await expand(container);
    const auto = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Auto') as HTMLButtonElement;
    expect(auto.disabled).toBe(false);
    fireEvent.click(auto);
    expect(changes).toEqual([{ mode: 'single', band: 2 }]);
    await waitFor(() => expect(input(container, 'cog-render-min')?.value).toBe(''));
  });

  test('paletted files can be drawn through their colour table', async () => {
    const { container, changes } = setup(palettedSource());
    await expand(container);
    expect(container.querySelector('[data-testid="cog-render-file"]')!.textContent)
      .toContain('3-entry colour table');
    await choose(container, 'Renderer', 'Colour map (paletted)');
    expect(changes).toEqual([{ mode: 'colormap', band: 1 }]);
    const ramp = await waitFor(() => {
      const found = container.querySelector('[data-testid="cog-render-ramp"]') as HTMLElement | null;
      if (!found) throw new Error('ramp not rendered');
      return found;
    });
    expect(ramp.style.background).toContain('linear-gradient');
    expect(container.textContent).toContain('3 classes · index 0–2');
    expect(badge(container).textContent).toBe('Colour map');
  });

  test('the colour map option is disabled when the file has no colour table', async () => {
    const { container } = setup(multispectralSource());
    await expand(container);
    const option = await choose(container, 'Renderer', 'Colour map (paletted)');
    expect(option.className).toContain('custom-select-option-disabled');
    expect(option).toHaveProperty('disabled', true);
  });

  test('From layer data measures the raster and stretches to it', async () => {
    const { container, changes } = setup(floatDemSource(false));
    await expand(container);
    await choose(container, 'Renderer', 'Single band (grayscale)');
    // No stored statistics: the stretch starts empty and the button is live.
    expect(changes).toEqual([{ mode: 'single', band: 1 }]);
    fireEvent.click(actionButton(container, 'From layer data'));
    // The pixels round-trip through a Float32Array, so expect float32 values.
    await waitFor(() => expect(changes[changes.length - 1]).toEqual({
      mode: 'single', band: 1, stretchMin: 399.052001953125, stretchMax: 910.7509765625,
    }));
    await waitFor(() => expect(input(container, 'cog-render-min')?.value).toBe('399.052001953125'));
  });

  test('a failed pixel read reports a hint instead of stretching', async () => {
    const { container, changes } = setup(floatDemSource(false, async () => { throw new Error('boom'); }));
    await expand(container);
    await choose(container, 'Renderer', 'Single band (grayscale)');
    fireEvent.click(actionButton(container, 'From layer data'));
    await waitFor(() => expect(body(container)!.textContent)
      .toContain('Could not read pixel values for this band.'));
    expect(changes).toEqual([{ mode: 'single', band: 1 }]);
  });

  test('offers a QGIS-style stretch for a floating-point DEM with statistics', async () => {
    const { container, changes } = setup(floatDemSource(true));
    await expand(container);
    expect(container.textContent).toContain('Floating-point bands render all-black');
    fireEvent.click(actionButton(container, 'Use suggested'));
    expect(changes).toEqual([{
      mode: 'single', band: 1, stretchMin: 399.05200195312, stretchMax: 910.7509765625,
    }]);
  });

  test('hillshade exposes the QGIS sun controls with its defaults', async () => {
    const { container, changes } = setup(floatDemSource(true), { mode: 'hillshade', band: 1 });
    await expand(container);
    expect(badge(container).textContent).toBe('Hillshade 1');
    expect(input(container, 'cog-render-altitude')?.value).toBe('45');
    expect(input(container, 'cog-render-azimuth')?.value).toBe('315');
    expect(input(container, 'cog-render-zfactor')?.value).toBe('1');
    // The elevation window (stretch row) is shared with single-band mode.
    expect(input(container, 'cog-render-min')).not.toBeNull();
    fireEvent.change(input(container, 'cog-render-altitude')!, { target: { value: '60' } });
    expect(changes[changes.length - 1].hillshade).toMatchObject({ altitude: 60 });
    fireEvent.click(input(container, 'cog-render-multidirectional')!);
    expect(changes[changes.length - 1].hillshade).toMatchObject({ multidirectional: true });
  });

  test('contour exposes interval, index interval and line colours', async () => {
    const { container, changes } = setup(floatDemSource(true), { mode: 'contour', band: 1 });
    await expand(container);
    expect(badge(container).textContent).toBe('Contours 10');
    expect(input(container, 'cog-render-interval')?.value).toBe('10');
    expect(input(container, 'cog-render-index-interval')?.value).toBe('50');
    expect(container.textContent).toContain('Contour colour');
    expect(container.textContent).toContain('Index contour colour');
    fireEvent.change(input(container, 'cog-render-interval')!, { target: { value: '25' } });
    expect(changes[changes.length - 1]).toMatchObject({ mode: 'contour', contour: { interval: 25 } });
  });

  test('explains itself when the layer is not on the map yet', () => {
    const { container } = render(
      <CogRenderControl
        layer={{ id: 'c', name: 'x', type: 'cog', url: '', cogSource: 'http' } as RasterLayer}
        value={{ mode: 'auto' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(toggle(container));
    expect(body(container)!.textContent).toContain('once the layer is on the map');
  });
});
