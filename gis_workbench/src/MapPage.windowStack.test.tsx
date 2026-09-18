/**
 * Floating-window stacking (click-to-front) end to end on the real MapPage.
 *
 * Opens the three desktop-OS windows side by side — Vector Tools, Elevation
 * Profile and the attribute table — and checks the window manager behaviour
 * the stack (hooks/useWindowStack) gives them: every window renders with its
 * own inline z-index, a mouse press anywhere inside a window (title bar OR
 * body) raises it above the others, a freshly opened window lands on top, and
 * a closed-then-reopened window comes back on top. Plus the rule above all of
 * them: the Advanced Settings overlay's stylesheet z-index clears the whole
 * floating-window range, so that dialog always covers every panel.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App, { FLOATING_WINDOW_BASE_Z } from './App';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// --- harness (same pattern as MapPage.circle / MapPage.fileLayerEdit) --------

/** Let async effects (layer restore, window geometry init) settle in act(). */
const tick = async () => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

/** Size the map container so OL renders a frame. */
function giveMapSize(w = 1024, h = 768) {
  const el = document.getElementById('map') as HTMLElement;
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  // The floating windows measure their parent with clientWidth/clientHeight
  // to initialise and clamp their rects — jsdom reports 0 for both.
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 1200 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 700 });
  el.style.border = '0';
  el.style.padding = '0';
  const vp = document.querySelector('.ol-viewport') as HTMLElement | null;
  if (vp) {
    Object.defineProperty(vp, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }),
    });
  }
}

/** Wait long enough for the ResizeObserver callback + one rAF render frame. */
const frame = async (ms = 80) => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });
};

// --- fixtures ----------------------------------------------------------------

const TERRAIN_LAYER = {
  id: 'r1', name: 'AWS Terrarium', type: 'xyz',
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  tileRender: { mode: 'contour', encoding: 'terrarium' },
};

const PARCELS_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[138.5, -35.0], [138.7, -35.0], [138.7, -34.85], [138.5, -34.85], [138.5, -35.0]]],
    },
    properties: { name: 'Pad 1' },
  }],
});

function seed() {
  localStorage.setItem('mapviewer-settings', JSON.stringify({
    // Pinned so the panel stays open while the windows receive gestures.
    settingsPinned: true,
    rasterLayers: [TERRAIN_LAYER],
    vectorLayers: [{ id: 'v1', name: 'Parcels', type: 'geojson', visible: true, drawnGeoJson: PARCELS_GEOJSON }],
  }));
}

// --- window lookups ------------------------------------------------------------

const win = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const gpWin = () => win('.gp-window');
const epWin = () => win('.ep-window');
const attrWin = () => win('.attr-table-window');
/** The Settings panel stacks through its wrapper (the dialog sits inside the
 *  wrapper's stacking context, so the wrapper carries the inline z-index). */
const settingsWrap = () => win('.map-settings-wrapper');
/** The inline z-index the window stack assigned (its position in the stack). */
const zOf = (el: HTMLElement | null) => Number(el?.style.zIndex);

/** Right-click a settings layer row and return its context menu. */
function openLayerMenu(name: string) {
  const rows = Array.from(document.querySelectorAll('.settings-layer-item'));
  const row = rows.find(r => r.querySelector('.settings-layer-name')?.textContent === name);
  expect(row, `row for ${name}`).toBeTruthy();
  fireEvent.contextMenu(row!, { clientX: 120, clientY: 200 });
  const menu = document.querySelector('.layer-context-menu');
  expect(menu).toBeTruthy();
  return menu as HTMLElement;
}

async function openSettingsAndWaitForLayers() {
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  for (let i = 0; i < 50 && !(screen.queryByText('Parcels') && screen.queryByText('AWS Terrarium')); i++) {
    await frame(20);
  }
  expect(screen.getByText('Parcels')).toBeInTheDocument();
  expect(screen.getByText('AWS Terrarium')).toBeInTheDocument();
}

async function renderApp() {
  seed();
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openSettingsAndWaitForLayers();
}

beforeEach(() => {
  localStorage.clear();
});

// --- tests -----------------------------------------------------------------------

test('each open window gets its own z-index; the newest opens on top', async () => {
  await renderApp();

  // The Settings panel is open (renderApp opened it) and holds the base.
  expect(zOf(settingsWrap())).toBe(FLOATING_WINDOW_BASE_Z);

  // Vector Tools opens over the settings panel it was launched from.
  fireEvent.click(screen.getByLabelText('Geoprocessing'));
  await tick();
  expect(gpWin()).toBeTruthy();
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);

  // The Elevation Profile window opens over both.
  const menu = openLayerMenu('AWS Terrarium');
  fireEvent.click(within(menu).getByText('Elevation Profile'));
  await tick();
  expect(epWin()).toBeTruthy();
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);
  expect(zOf(settingsWrap())).toBe(FLOATING_WINDOW_BASE_Z);
});

test('clicking a lower window raises it above the one covering it', async () => {
  await renderApp();

  fireEvent.click(screen.getByLabelText('Geoprocessing'));
  await tick();
  const menu = openLayerMenu('AWS Terrarium');
  fireEvent.click(within(menu).getByText('Elevation Profile'));
  await tick();
  // Elevation Profile opened last → on top of Vector Tools (and settings).
  expect(zOf(epWin())).toBeGreaterThan(zOf(gpWin()!));

  // A press on the Vector Tools TITLE BAR pulls it back over the profile.
  fireEvent.mouseDown(within(gpWin()!).getByText('Vector Tools'));
  await tick();
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);

  // And a press deep in the profile window's BODY (not its title bar) raises
  // it again — the whole window is a click-to-front surface.
  fireEvent.mouseDown(within(epWin()!).getByText('Elevation Profile'));
  await tick();
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);

  // Pressing an input inside Vector Tools (its search box) works too.
  fireEvent.mouseDown(within(gpWin()!).getByPlaceholderText('Search tools…'));
  await tick();
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);
});

test('the attribute table joins the stack on top and returns on top after a close/reopen', async () => {
  await renderApp();

  fireEvent.click(screen.getByLabelText('Geoprocessing'));
  await tick();
  const rasterMenu = openLayerMenu('AWS Terrarium');
  fireEvent.click(within(rasterMenu).getByText('Elevation Profile'));
  await tick();

  // Opening the table puts it above both existing windows.
  const vectorMenu = openLayerMenu('Parcels');
  fireEvent.click(within(vectorMenu).getByText('Open Attribute Table'));
  for (let i = 0; i < 25 && !attrWin(); i++) await frame(20);
  expect(attrWin()).toBeTruthy();
  expect(zOf(attrWin())).toBe(FLOATING_WINDOW_BASE_Z + 3);

  // Clicking Vector Tools demotes the table without closing it.
  fireEvent.mouseDown(within(gpWin()!).getByText('Vector Tools'));
  await tick();
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 3);
  expect(zOf(attrWin())).toBeLessThan(zOf(gpWin()!));

  // Closing the table leaves the stack; reopening brings it back ON TOP
  // (not into the position it held before it was closed).
  fireEvent.click(screen.getByLabelText('Close attribute table'));
  await tick();
  expect(attrWin()).toBeNull();

  const reopenMenu = openLayerMenu('Parcels');
  fireEvent.click(within(reopenMenu).getByText('Open Attribute Table'));
  for (let i = 0; i < 25 && !attrWin(); i++) await frame(20);
  expect(zOf(attrWin())).toBe(FLOATING_WINDOW_BASE_Z + 3);
  // The survivors keep the order the earlier raise gave them: Vector Tools
  // was pulled over the profile before the table closed, and stays there.
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);
  expect(zOf(settingsWrap())).toBe(FLOATING_WINDOW_BASE_Z);
});

test('clicking the Settings panel raises it above the windows; closing drops it below', async () => {
  await renderApp();

  fireEvent.click(screen.getByLabelText('Geoprocessing'));
  await tick();
  const menu = openLayerMenu('AWS Terrarium');
  fireEvent.click(within(menu).getByText('Elevation Profile'));
  await tick();
  // Both windows opened from the settings panel and landed above it.
  expect(zOf(settingsWrap())).toBe(FLOATING_WINDOW_BASE_Z);
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);

  // A press inside the settings dialog pulls the whole panel back on top.
  fireEvent.mouseDown(win('.settings-dialog')!);
  await tick();
  expect(zOf(settingsWrap())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z);
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);

  // …and the windows can still raise themselves back over it.
  fireEvent.mouseDown(within(gpWin()!).getByText('Vector Tools'));
  await tick();
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 2);
  expect(zOf(settingsWrap())).toBe(FLOATING_WINDOW_BASE_Z + 1);

  // Closing the panel leaves the stack: the wrapper's inline level goes away
  // and the CSS resting z-index (below every window) applies again.
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  expect(settingsWrap()!.style.zIndex).toBe('');
  expect(win('.settings-dialog')).toHaveClass('settings-dialog--hidden');
  expect(zOf(gpWin())).toBe(FLOATING_WINDOW_BASE_Z + 1);
  expect(zOf(epWin())).toBe(FLOATING_WINDOW_BASE_Z);
});

test('the Advanced Settings overlay stacks above every floating window', async () => {
  await renderApp();

  // Two windows open and stacked at the top of the inline range…
  fireEvent.click(screen.getByLabelText('Geoprocessing'));
  await tick();
  const menu = openLayerMenu('AWS Terrarium');
  fireEvent.click(within(menu).getByText('Elevation Profile'));
  await tick();
  const topWindowZ = Math.max(zOf(gpWin()!), zOf(epWin()!));

  // …opening Advanced Settings covers them. jsdom does not apply App.css, so
  // the overlay's level is asserted from the stylesheet itself: it must clear
  // the whole floating-window range (base + one step per window kind) while
  // staying under the dialogs that can open from it (set-password 1600,
  // confirm 1700, app lock 2000).
  fireEvent.click(screen.getByText('Advanced Settings'));
  await tick();
  expect(win('.advanced-settings-overlay')).toBeTruthy();

  const css = readFileSync(resolve(__dirname, 'App.css'), 'utf8');
  const overlayZ = Number(
    /\.advanced-settings-overlay\s*\{[^}]*?z-index:\s*(\d+)/s.exec(css)?.[1],
  );
  expect(Number.isFinite(overlayZ)).toBe(true);
  expect(overlayZ).toBeGreaterThan(topWindowZ);
  // Headroom for the full stack: three windows + the settings panel.
  expect(overlayZ).toBeGreaterThan(FLOATING_WINDOW_BASE_Z + 4);
  expect(overlayZ).toBeLessThan(1600);
});
