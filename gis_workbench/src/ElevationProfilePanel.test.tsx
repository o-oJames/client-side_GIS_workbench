/**
 * ElevationProfilePanel — the "Elevation Profile" desktop window.
 *
 * The map is a stub that records the layers and interactions the session adds,
 * so a drawn line is simulated by dispatching OpenLayers' own `drawstart` /
 * `drawend` on the Draw interaction the Pen button armed — the real gesture
 * outcome, without a real map or a tile service. The terrain read itself
 * (`sampleElevationProfile`) is mocked to answer from a synthetic ramp grid
 * built with the module's own pure functions, so everything downstream of the
 * read — chart, stats, tabs, saving, gestures — runs the production path.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import { ElevationProfilePanel } from './App';
import { PROFILE_FIELDS } from './utils/elevationProfile';
import { lonLatToMercator } from './utils/geodesic';
import type { RasterLayer } from './types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// --- the mocked terrain read -------------------------------------------------

/** Shared with the mock factory (which is hoisted above the imports). */
const SAMPLE = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'refuse',
  calls: [] as any[],
}));

vi.mock('./utils/elevationProfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/elevationProfile')>();

  /** A ramp grid (100 → 500 m west → east) covering the drawn line. */
  const gridFor = (coords: number[][]) => {
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const c of coords) {
      minx = Math.min(minx, c[0]);
      maxx = Math.max(maxx, c[0]);
      miny = Math.min(miny, c[1]);
      maxy = Math.max(maxy, c[1]);
    }
    const padX = Math.max((maxx - minx) * 0.2, 500);
    const padY = Math.max((maxy - miny) * 0.2, 500);
    const extent = [minx - padX, miny - padY, maxx + padX, maxy + padY];
    const width = 64;
    const height = 32;
    const field = new Float32Array(width * height);
    for (let x = 0; x < width * height; x++) field[x] = 100 + ((x % width) + 0.5) / width * 400;
    const grid = { field, width, height, extent };
    return { ...grid, cellSize: actual.gridCellSize(grid), kind: 'tile' as const, detail: 'tiles z12' };
  };

  return {
    ...actual,
    sampleElevationProfile: vi.fn(async (options: any) => {
      SAMPLE.calls.push(options);
      if (SAMPLE.mode === 'refuse') {
        return {
          points: [], stats: null, grid: null, plan: null,
          failure: 'no-tiles' as const, detail: 'CORS blocked',
        };
      }
      const grid = gridFor(options.coords);
      const points = actual.buildProfilePoints(options.coords, grid, { samples: options.samples ?? 240 });
      const stats = actual.profileStats(points);
      return { points, stats, grid, plan: null, failure: stats ? null : ('no-values' as const) };
    }),
  };
});

// --- fixtures ----------------------------------------------------------------

const ORIGIN = lonLatToMercator([138.6, -34.93]);
const A: [number, number] = [ORIGIN[0] - 6000, ORIGIN[1] - 1000];
const B: [number, number] = [ORIGIN[0] + 2000, ORIGIN[1] + 2500];
const C: [number, number] = [ORIGIN[0] + 8000, ORIGIN[1] - 500];

/** A minimal OL Map stand-in: records what the session adds to it. */
function stubMap() {
  const layers: any[] = [];
  const interactions: any[] = [];
  return {
    layers,
    interactions,
    addLayer: (l: any) => { layers.push(l); },
    removeLayer: (l: any) => {
      const i = layers.indexOf(l);
      if (i >= 0) layers.splice(i, 1);
    },
    addInteraction: (i: any) => { interactions.push(i); },
    removeInteraction: (i: any) => {
      const k = interactions.indexOf(i);
      if (k >= 0) interactions.splice(k, 1);
    },
    getView: () => ({
      getProjection: () => ({ getCode: () => 'EPSG:3857' }),
      getZoom: () => 12,
    }),
    getInteractions: () => ({ getArray: () => interactions }),
  };
}

const TERRAIN_LAYER: RasterLayer = {
  id: 'r1',
  name: 'AWS Terrarium',
  type: 'xyz',
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  tileRender: { mode: 'contour', encoding: 'terrarium' },
} as RasterLayer;

const PLAIN_LAYER: RasterLayer = {
  id: 'r2',
  name: 'OSM',
  type: 'xyz',
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
} as RasterLayer;

function renderPanel(over: Record<string, any> = {}) {
  const map = stubMap();
  const onSaveLayer = vi.fn((_geoJson: string, _name: string): string | null => 'layer-1');
  const onShowAttributeTable = vi.fn();
  const onClose = vi.fn();
  const showToast = vi.fn();
  const utils = render(
    <ElevationProfilePanel
      layer={TERRAIN_LAYER}
      map={map}
      units="metric"
      onSaveLayer={onSaveLayer}
      onShowAttributeTable={onShowAttributeTable}
      onClose={onClose}
      showToast={showToast}
      {...over}
    />,
  );
  return { ...utils, map, onSaveLayer, onShowAttributeTable, onClose, showToast };
}

/** Arm the Pen and return the Draw interaction it created. */
async function armPen(map: ReturnType<typeof stubMap>) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Pen/ }));
  });
  const draw = map.interactions.find((i: any) => typeof i.finishDrawing === 'function');
  expect(draw).toBeTruthy();
  return draw;
}

/**
 * Pen a polyline: drawstart, then drawend with the finished geometry — and the
 * source insert OpenLayers performs immediately after `drawend`.
 */
async function penLine(map: ReturnType<typeof stubMap>, coords: [number, number][]) {
  const draw = await armPen(map);
  await finishSketch(map, draw, coords);
  await waitFor(() => expect(document.querySelector('.ep-chart')).toBeTruthy());
  return draw;
}

const activeDraw = (map: ReturnType<typeof stubMap>) =>
  map.interactions.find((i: any) => typeof i.finishDrawing === 'function');

async function finishSketch(
  map: ReturnType<typeof stubMap>,
  draw: any,
  coordsOrFeature: [number, number][] | Feature,
) {
  const feature = coordsOrFeature instanceof Feature
    ? coordsOrFeature
    : new Feature({ geometry: new LineString(coordsOrFeature) });
  const source = map.layers[0].getSource();
  await act(async () => {
    draw.dispatchEvent({ type: 'drawstart', feature } as any);
    draw.dispatchEvent({ type: 'drawend', feature } as any);
    source.addFeature(feature);
  });
  return feature;
}

const penButton = () => screen.getByRole('button', { name: /^Pen/ });
const yLabels = () => Array.from(document.querySelectorAll('.ep-chart-ylabel'))
  .map(n => parseFloat((n.textContent || '').replace(/[^0-9.\-]/g, '')))
  .filter(v => Number.isFinite(v));
const statValue = (label: string) => {
  const stats = Array.from(document.querySelectorAll('.ep-stat'));
  const stat = stats.find(s => s.querySelector('.ep-stat-label')?.textContent === label);
  return stat?.querySelector('.ep-stat-value')?.textContent ?? null;
};

beforeEach(() => {
  SAMPLE.mode = 'ok';
  SAMPLE.calls.length = 0;
  localStorage.clear();
});

// --- the window itself -------------------------------------------------------

describe('Elevation Profile window', () => {
  test('renders as a desktop window naming its terrain source, and closes', () => {
    const { onClose } = renderPanel();
    const win = screen.getByTestId('elevation-profile-window');
    expect(win.className).toContain('ep-window');
    expect(win.style.left).toBe('72px');
    expect(win.style.width).toBe('640px');
    expect(screen.getByText('Elevation Profile')).toBeTruthy();
    expect(screen.getByText('AWS Terrarium')).toBeTruthy();
    expect(screen.getByText('Contours')).toBeTruthy();
    expect(document.querySelector('.ep-titlebar')).toBeTruthy();
    // Eight resize handles, like the other floating windows.
    expect(document.querySelectorAll('.ep-resize')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('before any line it explains what to do, and offers the Pen', () => {
    renderPanel();
    expect(screen.getByText('No profile line yet')).toBeTruthy();
    expect(screen.getByText(/Press Pen and draw a line/i)).toBeTruthy();
    expect(document.querySelector('.ep-chart')).toBeNull();
    expect(penButton()).toBeTruthy();
    expect((penButton() as HTMLButtonElement).disabled).toBe(false);
    // Nothing to save or chart yet.
    expect((screen.getByRole('button', { name: 'Save to layer' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Remove/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a layer that is not rendering terrain cannot be penned, and says why', () => {
    renderPanel({ layer: PLAIN_LAYER });
    expect((penButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not using a terrain renderer/i)).toBeTruthy();
    expect(document.querySelector('.ep-titlebar-badge')).toBeNull();
  });

  test('the Pen arms the draw, shows the gesture hint, and Esc puts it down', async () => {
    const { map } = renderPanel();
    expect(document.querySelector('.ep-hintbar')).toBeNull();
    const draw = await armPen(map);
    expect(penButton().className).toContain('ep-toolbtn--active');
    expect(penButton().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/double-click or press Enter to finish/i)).toBeTruthy();
    // The profile lines live on their own map layer, marked so nothing else
    // mistakes it for data.
    expect(map.layers).toHaveLength(1);
    expect(map.layers[0].get(PROFILE_LAYER_FLAG)).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(penButton().className).not.toContain('ep-toolbtn--active');
    expect(map.interactions).not.toContain(draw);
  });

  test('closing the window takes its lines and its read off the map', async () => {
    const { map, unmount } = renderPanel();
    await penLine(map, [A, B]);
    expect(map.layers).toHaveLength(1);
    unmount();
    expect(map.layers).toHaveLength(0);
    expect(map.interactions).toHaveLength(0);
  });
});

// --- drawing a profile -------------------------------------------------------

describe('profiling a penned line', () => {
  test('a finished line is read, charted and summarised', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B, C]);

    // The chart: one unbroken line and its filled area.
    const chart = document.querySelector('.ep-chart')!;
    expect(chart).toBeTruthy();
    expect(chart.querySelectorAll('.ep-chart-line')).toHaveLength(1);
    expect(chart.querySelectorAll('.ep-chart-area')).toHaveLength(1);
    expect(chart.querySelectorAll('.ep-chart-ylabel').length).toBeGreaterThan(1);
    expect(chart.querySelectorAll('.ep-chart-xlabel').length).toBeGreaterThan(1);
    expect(chart.querySelector('.ep-chart-marker--max')).toBeTruthy();
    expect(chart.querySelector('.ep-chart-marker--min')).toBeTruthy();

    // The readouts, in the app's own units and formats.
    expect(statValue('Length')).toMatch(/km$/);
    expect(statValue('Min elev.')).toMatch(/m$/);
    expect(statValue('Max elev.')).toMatch(/m$/);
    expect(parseFloat(statValue('Max elev.')!)).toBeGreaterThan(parseFloat(statValue('Min elev.')!));
    expect(statValue('Ascent')).toMatch(/m$/);
    expect(statValue('Descent')).toMatch(/m$/);
    expect(statValue('Steepest')).toMatch(/%$/);

    // The status bar says where the elevations came from and how finely.
    const status = document.querySelector('.ep-statusbar-text')!.textContent!;
    expect(status).toMatch(/AWS Terrarium/);
    expect(status).toMatch(/Contours/);
    expect(status).toMatch(/tiles z12/);
    expect(status).toMatch(/samples/);
    expect(status).toMatch(/vertical exaggeration/);

    // The line is on the map, dashed, and tagged as this profile's.
    const source = map.layers[0].getSource();
    expect(source.getFeatures()).toHaveLength(1);
    expect(source.getFeatures()[0].getGeometry().getType()).toBe('LineString');
  });

  test('the read is asked for the drawn line in EPSG:3857, at the map zoom', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B, C]);
    expect(SAMPLE.calls).toHaveLength(1);
    const asked = SAMPLE.calls[0];
    expect(asked.layer.id).toBe('r1');
    expect(asked.zoom).toBe(12);
    expect(asked.samples).toBe(240);
    expect(asked.coords).toHaveLength(3);
    expect(asked.coords[0][0]).toBeCloseTo(A[0], 6);
  });

  test('a second line becomes a tab, and tabs select and remove', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B, C]);
    // Put the pen down, then pick it up again for a second line.
    // Put the pen down, then pick it up again for a second line.
    await act(async () => { fireEvent.click(penButton()); });
    await act(async () => { fireEvent.click(penButton()); });
    await finishSketch(map, activeDraw(map), [A, C]);
    await waitFor(() => expect(document.querySelectorAll('.ep-tab')).toHaveLength(2));

    const tabs = () => Array.from(document.querySelectorAll('.ep-tab'));
    expect(tabs()[1].className).toContain('ep-tab--active');
    expect(tabs()[0].textContent).toMatch(/Elevation Profile 1/);
    expect(tabs()[1].textContent).toMatch(/Elevation Profile 2/);
    expect(tabs()[0].textContent).toMatch(/relief/);

    // Selecting the first line charts it instead.
    await act(async () => { fireEvent.click(tabs()[0].querySelector('.ep-tab-body')!); });
    expect(tabs()[0].className).toContain('ep-tab--active');
    expect(document.querySelector('.ep-chart-line')).toBeTruthy();
    expect((screen.getByLabelText('Saved layer name') as HTMLInputElement).value)
      .toBe('Elevation Profile 1');

    // Removing the selected line falls back to the other one.
    await act(async () => { fireEvent.click(tabs()[0].querySelector('.ep-tab-x')!); });
    await waitFor(() => expect(document.querySelectorAll('.ep-tab')).toHaveLength(0));
    expect(map.layers[0].getSource().getFeatures()).toHaveLength(1);
    expect((screen.getByLabelText('Saved layer name') as HTMLInputElement).value)
      .toBe('Elevation Profile 2');

    // "Clear all" empties the window and the map.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear all' })); });
    expect(screen.getByText('No profile line yet')).toBeTruthy();
    expect(map.layers[0].getSource().getFeatures()).toHaveLength(0);
  });

  test('a refused read is reported in plain words and cannot be saved', async () => {
    SAMPLE.mode = 'refuse';
    const { map } = renderPanel();
    const draw = await armPen(map);
    await finishSketch(map, draw, [A, B]);
    await waitFor(() => expect(document.querySelector('.ep-error')).toBeTruthy());
    expect(document.querySelector('.ep-error')!.textContent).toMatch(/No terrain tiles could be read/);
    expect(document.querySelector('.ep-error')!.textContent).toMatch(/CORS blocked/);
    expect((screen.getByRole('button', { name: 'Save to layer' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.ep-chart-line')).toBeNull();
    expect(screen.getByText(/No elevations to chart/)).toBeTruthy();
  });

  test('changing the detail re-reads every line at the new resolution', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B, C]);
    expect(SAMPLE.calls).toHaveLength(1);
    expect(SAMPLE.calls[0].samples).toBe(240);

    await act(async () => { fireEvent.click(document.querySelector('.custom-select-trigger')!); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fine (600 points)' })); });

    await waitFor(() => expect(SAMPLE.calls).toHaveLength(2));
    expect(SAMPLE.calls[1].samples).toBe(600);
    expect(document.querySelector('.ep-chart-line')).toBeTruthy();
  });

  test('the zero-baseline toggle redraws the elevation axis down to sea level', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B, C]);
    const before = Math.min(...yLabels());
    expect(before).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'), {});
    });
    await waitFor(() => expect(Math.min(...yLabels())).toBeLessThanOrEqual(0));
  });

  test('hovering the chart reads a sample out and marks it on the map', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B, C]);
    const chart = document.querySelector('.ep-chart')!;
    expect(document.querySelector('.ep-chart-tooltip')).toBeNull();

    await act(async () => {
      fireEvent.mouseMove(chart, { clientX: 300, clientY: 100 });
    });
    const tooltip = document.querySelector('.ep-chart-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip!.querySelector('.ep-chart-tooltip-dist')!.textContent).toMatch(/m|km/);
    expect(tooltip!.querySelector('.ep-chart-tooltip-elev')!.textContent).toMatch(/m$/);
    expect(document.querySelector('.ep-chart-crosshair')).toBeTruthy();
    expect(document.querySelector('.ep-chart-hoverdot')).toBeTruthy();
    // The crosshair is mirrored on the map as a marker point.
    const points = map.layers[0].getSource().getFeatures()
      .filter((f: any) => f.getGeometry().getType() === 'Point');
    expect(points).toHaveLength(1);

    await act(async () => { fireEvent.mouseLeave(chart); });
    expect(document.querySelector('.ep-chart-tooltip')).toBeNull();
    expect(map.layers[0].getSource().getFeatures().filter((f: any) => f.getGeometry().getType() === 'Point'))
      .toHaveLength(0);
  });
});

// --- saving to the vector layers ---------------------------------------------

describe('saving a profile line', () => {
  test('the line is offered as a layer, with the chart data as its attributes', async () => {
    const { map, onSaveLayer, showToast } = renderPanel();
    await penLine(map, [A, B, C]);

    const nameInput = screen.getByLabelText('Saved layer name') as HTMLInputElement;
    expect(nameInput.value).toBe('Elevation Profile 1');
    fireEvent.change(nameInput, { target: { value: 'Ridge walk' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to layer' }));
    });

    expect(onSaveLayer).toHaveBeenCalledTimes(1);
    const [geoJson, name] = onSaveLayer.mock.calls[0];
    expect(name).toBe('Ridge walk');
    const parsed = JSON.parse(geoJson);
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].geometry.type).toBe('LineString');
    // The drawn vertices, in EPSG:3857.
    expect(parsed.features[0].geometry.coordinates).toHaveLength(3);
    expect(parsed.features[0].geometry.coordinates[0][0]).toBeCloseTo(A[0], 3);

    const props = parsed.features[0].properties;
    expect(props[PROFILE_FIELDS.name]).toBe('Ridge walk');
    expect(props[PROFILE_FIELDS.source]).toBe('AWS Terrarium');
    expect(props[PROFILE_FIELDS.renderer]).toMatch(/Contours/);
    expect(props[PROFILE_FIELDS.length]).toBeGreaterThan(1000);
    expect(props[PROFILE_FIELDS.samples]).toBe(240);
    expect(props[PROFILE_FIELDS.minElevation]).toBeLessThan(props[PROFILE_FIELDS.maxElevation]);
    // The data points behind the chart, one per sample.
    const points = props[PROFILE_FIELDS.points];
    expect(points).toHaveLength(240);
    expect(points[0].distance).toBe(0);
    expect(points[0]).toEqual({ distance: 0, elevation: expect.any(Number), lon: expect.any(Number), lat: expect.any(Number) });
    expect(points[239].distance).toBeCloseTo(props[PROFILE_FIELDS.length], 1);
    expect(points[0].lon).toBeCloseTo(138.6 - 6000 / 90000, 1);
    expect(showToast).toHaveBeenCalled();
    expect(showToast.mock.calls[0][0]).toMatch(/240 profile points/);
  });

  test('after saving, the attribute table of the new layer is one click away', async () => {
    const { map, onShowAttributeTable } = renderPanel();
    await penLine(map, [A, B, C]);
    expect(screen.queryByRole('button', { name: /Attributes/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to layer' }));
    });
    const attributes = screen.getByRole('button', { name: /Attributes/ });
    await act(async () => { fireEvent.click(attributes); });
    expect(onShowAttributeTable).toHaveBeenCalledWith('layer-1');
  });

  test('a save the app refuses is reported, not silently dropped', async () => {
    const { map, showToast } = renderPanel({ onSaveLayer: () => null as string | null });
    await penLine(map, [A, B]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to layer' }));
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Could not save/), 'error');
    expect(screen.queryByRole('button', { name: /Attributes/ })).toBeNull();
  });

  test('removing a profile takes its line off the map', async () => {
    const { map } = renderPanel();
    await penLine(map, [A, B]);
    expect(map.layers[0].getSource().getFeatures()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    });
    expect(map.layers[0].getSource().getFeatures()).toHaveLength(0);
    expect(screen.getByText('No profile line yet')).toBeTruthy();
  });
});

// --- window gestures ---------------------------------------------------------

describe('window gestures', () => {
  test('the title bar drags the window, and the position is remembered', async () => {
    renderPanel();
    const win = screen.getByTestId('elevation-profile-window');
    const bar = document.querySelector('.ep-titlebar')!;
    await act(async () => {
      fireEvent.mouseDown(bar, { button: 0, clientX: 200, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 260, clientY: 140 });
      fireEvent.mouseUp(window);
    });
    expect(win.style.left).toBe('132px');
    expect(win.style.top).toBe('104px');
    expect(JSON.parse(localStorage.getItem('mapviewer-elev-profile-geometry')!))
      .toMatchObject({ x: 132, y: 104 });
  });

  test('dragging a button in the title bar does not move the window', async () => {
    renderPanel();
    const win = screen.getByTestId('elevation-profile-window');
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Close' }), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(window, { clientX: 200, clientY: 200 });
      fireEvent.mouseUp(window);
    });
    expect(win.style.left).toBe('72px');
  });

  test('a corner handle resizes it, and the size is remembered', async () => {
    renderPanel();
    const win = screen.getByTestId('elevation-profile-window');
    await act(async () => {
      fireEvent.mouseDown(document.querySelector('.ep-resize-se')!, { button: 0, clientX: 400, clientY: 300 });
      fireEvent.mouseMove(window, { clientX: 520, clientY: 380 });
      fireEvent.mouseUp(window);
    });
    expect(win.style.width).toBe('760px');
    expect(win.style.height).toBe('510px');
    expect(JSON.parse(localStorage.getItem('mapviewer-elev-profile-geometry')!))
      .toMatchObject({ w: 760, h: 510 });
  });

  test('a saved geometry is restored on the next open', () => {
    localStorage.setItem('mapviewer-elev-profile-geometry', JSON.stringify({ x: 30, y: 40, w: 700, h: 480 }));
    renderPanel();
    const win = screen.getByTestId('elevation-profile-window');
    expect(win.style.left).toBe('30px');
    expect(win.style.top).toBe('40px');
    expect(win.style.width).toBe('700px');
    expect(win.style.height).toBe('480px');
  });

  test('the right mouse button does not start a gesture', async () => {
    renderPanel();
    const win = screen.getByTestId('elevation-profile-window');
    await act(async () => {
      fireEvent.mouseDown(document.querySelector('.ep-titlebar')!, { button: 2, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
      fireEvent.mouseUp(window);
    });
    expect(win.style.left).toBe('72px');
  });
});

// --- styling contract --------------------------------------------------------

const PROFILE_LAYER_FLAG = '_isElevationProfileLayer';

describe('styling contract', () => {
  test('every ep-* class the window emits exists in App.css', () => {
    const { map } = renderPanel();
    const css = readFileSync(resolve(__dirname, 'App.css'), 'utf8');
    const used = new Set<string>();
    const collect = (root: ParentNode) => {
      root.querySelectorAll('*').forEach(el => {
        (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).forEach(cls => {
          if (cls.startsWith('ep-') || cls.startsWith('custom-select')) used.add(cls);
        });
      });
    };
    collect(document);
    // A drawn line adds the chart, the tabs and the save row's extra button.
    return penLine(map, [A, B, C]).then(() => {
      collect(document);
      expect(used.size).toBeGreaterThan(20);
      const missing = Array.from(used).filter(cls => !css.includes(`.${cls}`));
      expect(missing).toEqual([]);
    });
  });
});
