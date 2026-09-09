/**
 * Integration tests for the draw toolbar's Circle tool.
 *
 * Covers the toolbar wiring end to end (the geometry itself is unit-tested in
 * utils/circleDraw.test.ts): the button under the rectangle tool, its
 * right-click submenu (Circle geometry / Geodesic circle), the amber geodesic
 * badge, the on-map hint bar, and the polygon each mode leaves behind —
 * persisted through the draw session with its own auto-name family.
 *
 * jsdom has no PointerEvent constructor, so pointer gestures are synthesised
 * MouseEvents carrying the pointer properties OL reads (see
 * MapPage.draw.test.tsx for the full rationale).
 */
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { CIRCLE_DRAW_SEGMENTS } from './utils/circleDraw';

/** Let async effects (layer restore, session persistence) settle in act(). */
const tick = async () => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

/** Size the map container so OL renders a frame (see MapPage.draw.test.tsx). */
function giveMapSize(w = 1024, h = 768) {
  const el = document.getElementById('map') as HTMLElement;
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
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

function ptr(type: string, x: number, y: number, buttons = 1) {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  Object.defineProperty(ev, 'isPrimary', { value: true });
  return ev;
}

const viewport = () => document.querySelector('.ol-viewport') as HTMLElement;
const down = (x: number, y: number) => fireEvent(viewport(), ptr('pointerdown', x, y));
const move = (x: number, y: number) => fireEvent(viewport(), ptr('pointermove', x, y));
const up = (x: number, y: number) => fireEvent(viewport(), ptr('pointerup', x, y, 0));
/** OL click: down+up at the same pixel (within its 6px click tolerance). */
const clickAt = (x: number, y: number) => {
  down(x, y);
  up(x, y);
};

const storedDraw = () => {
  const raw = localStorage.getItem('mapviewer-draw');
  return raw ? JSON.parse(raw) : null;
};
const storedFeatures = () => {
  const saved = storedDraw();
  return saved ? JSON.parse(saved.geojson).features : [];
};

async function ensureDrawnPanelExpanded() {
  if (!document.querySelector('.drawn-features-panel.expanded')) {
    fireEvent.click(screen.getByText('Drawn Features'));
    await tick();
  }
}

const circleButton = () => screen.getByTitle('Draw Circle', { exact: false });
const circleMenu = () => document.querySelector('.circle-tool-menu') as HTMLElement | null;
/** Menu rows only — the hint bar repeats the mode caption once the tool is on. */
const menuRow = (name: RegExp) => screen.getByRole('menuitemradio', { name });

/** Click the centre, drag the radius out, click again — the OL Circle gesture. */
async function drawCircle(cx = 200, cy = 200, rx = 320, ry = 260) {
  clickAt(cx, cy);
  move(rx, ry);
  clickAt(rx, ry);
  await tick();
}

beforeEach(() => {
  localStorage.clear();
});

test('the Circle tool sits under the rectangle tool and draws a dense polygon', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  // Rendered in the toolbar, right after the rectangle button.
  const buttons = Array.from(document.querySelectorAll('.draw-toolbar .draw-toolbar-button'));
  const rectIndex = buttons.findIndex((b) => (b.getAttribute('title') || '').startsWith('Draw Rectangle'));
  const circleIndex = buttons.findIndex((b) => (b.getAttribute('title') || '').startsWith('Draw Circle'));
  expect(rectIndex).toBeGreaterThan(-1);
  expect(circleIndex).toBe(rectIndex + 1);

  // Left-click arms the tool and the hint bar names the default flavour.
  fireEvent.click(circleButton());
  await tick();
  expect(circleButton().className).toContain('active');
  const hint = document.querySelector('.draw-modify-hint') as HTMLElement;
  expect(hint.textContent).toContain('Circle geometry');
  expect(hint.textContent).toContain('Right-click');
  // Geometric is the default, so no geodesic badge yet.
  expect(document.querySelector('.draw-toolbar-geodesic-badge')).toBeNull();

  await drawCircle();

  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Circle 1')).toBeInTheDocument();

  // Persisted as an ordinary closed polygon ring — never an ol/geom/Circle,
  // which no GeoJSON writer (session, export, saved layer) could serialise.
  const feats = storedFeatures();
  expect(feats).toHaveLength(1);
  expect(feats[0].geometry.type).toBe('Polygon');
  const ring = feats[0].geometry.coordinates[0];
  expect(ring).toHaveLength(CIRCLE_DRAW_SEGMENTS + 1);
  expect(ring[0]).toEqual(ring[ring.length - 1]);
  for (const c of ring) {
    expect(Number.isFinite(c[0])).toBe(true);
    expect(Number.isFinite(c[1])).toBe(true);
  }
  // The flavour rides along with the session so its single area chip survives
  // a reload (a 128-vertex ring would otherwise hide its measurements).
  expect(storedDraw().meta[0].circleMode).toBe('geometric');
  expect(storedDraw().meta[0].name).toBe('Circle 1');
});

test('right-clicking the Circle tool opens the mode submenu; Escape closes it', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  expect(circleMenu()).toBeNull();
  fireEvent.contextMenu(circleButton());
  await tick();

  const menu = circleMenu();
  expect(menu).not.toBeNull();
  expect(within(menu as HTMLElement).getByText('Draw circle as')).toBeInTheDocument();
  expect(menuRow(/Circle geometry/)).toBeInTheDocument();
  expect(menuRow(/Geodesic circle/)).toBeInTheDocument();
  // Each row explains what its mode means.
  expect(menuRow(/Circle geometry/).textContent).toContain('projected units');
  expect(menuRow(/Geodesic circle/).textContent).toContain('ground radius');
  // The mode in use is ticked.
  expect(menuRow(/Circle geometry/).getAttribute('aria-checked')).toBe('true');
  expect(menuRow(/Geodesic circle/).getAttribute('aria-checked')).toBe('false');
  // The menu is portalled out of the (transformed, scrollable) toolbar.
  expect((menu as HTMLElement).parentElement).toBe(document.body);
  // Opening it does not arm the tool.
  expect(circleButton().className).not.toContain('active');

  fireEvent.keyDown(menu as HTMLElement, { key: 'Escape' });
  await tick();
  expect(circleMenu()).toBeNull();
});

test('picking Geodesic circle arms the tool, badges the button and names the circle', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  fireEvent.contextMenu(circleButton());
  await tick();
  fireEvent.click(menuRow(/Geodesic circle/));
  await tick();

  // The menu closes, the tool switches on (as arming magnetic edges does) and
  // the button carries the amber geodesic badge.
  expect(circleMenu()).toBeNull();
  expect(circleButton().className).toContain('active');
  expect(document.querySelector('.draw-toolbar-geodesic-badge')).not.toBeNull();
  expect(circleButton().getAttribute('title')).toContain('Geodesic circle');
  const hint = document.querySelector('.draw-modify-hint') as HTMLElement;
  expect(hint.textContent).toContain('Geodesic circle');
  expect(hint.textContent).toContain('ground distance');

  await drawCircle();

  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Geodesic Circle 1')).toBeInTheDocument();
  expect(storedDraw().meta[0].circleMode).toBe('geodesic');
  expect(storedFeatures()[0].geometry.coordinates[0]).toHaveLength(CIRCLE_DRAW_SEGMENTS + 1);

  // Switching back to Circle geometry keeps its own counter: the geodesic
  // circle already drawn does not make the next one 'Circle 2'.
  fireEvent.contextMenu(circleButton());
  await tick();
  fireEvent.click(menuRow(/Circle geometry/));
  await tick();
  expect(document.querySelector('.draw-toolbar-geodesic-badge')).toBeNull();

  await drawCircle(500, 400, 600, 470);
  await tick();
  expect(screen.getByText('Circle 1')).toBeInTheDocument();
  const meta = storedDraw().meta;
  expect(meta.map((m: any) => m.name)).toEqual(['Geodesic Circle 1', 'Circle 1']);
  expect(meta.map((m: any) => m.circleMode)).toEqual(['geodesic', 'geometric']);
});

test('the chosen mode survives a tool switch and circles stay out of the polygon counter', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  fireEvent.contextMenu(circleButton());
  await tick();
  fireEvent.click(menuRow(/Geodesic circle/));
  await tick();
  await drawCircle();

  // Switch to the polygon tool: the mode is session state, not per-interaction
  // state, so the badge stays and the submenu still reports the same choice.
  fireEvent.click(screen.getByTitle('Draw Polygon', { exact: false }));
  await tick();
  expect(document.querySelector('.draw-toolbar-geodesic-badge')).not.toBeNull();
  fireEvent.contextMenu(circleButton());
  await tick();
  expect(menuRow(/Geodesic circle/).getAttribute('aria-checked')).toBe('true');
  // Escape closes the submenu without disarming the tool behind it.
  fireEvent.keyDown(circleMenu() as HTMLElement, { key: 'Escape' });
  await tick();
  expect(circleMenu()).toBeNull();
  expect(screen.getByTitle('Draw Polygon', { exact: false }).className).toContain('active');

  // A polygon drawn after the circle is still 'Polygon 1' — circles are
  // polygons, but they belong to their own auto-name family.
  clickAt(150, 500);
  clickAt(280, 520);
  clickAt(240, 620);
  clickAt(240, 620); // second pair within 250ms → OL synthesises dblclick → finish
  await tick();

  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Geodesic Circle 1')).toBeInTheDocument();
  expect(screen.getByText('Polygon 1')).toBeInTheDocument();
});
