/**
 * Integration tests for the MapPage draw workflow.
 *
 * jsdom has no PointerEvent constructor, so these tests synthesise plain
 * MouseEvents of type 'pointer*' carrying the pointer properties OpenLayers
 * reads (pointerId, pointerType, isPrimary, button/buttons) and dispatch them
 * on the map viewport, where OL's MapBrowserEventHandler listens. Two quick
 * click pairs synthesise a dblclick inside OL, which is how line/polygon
 * drawing finishes.
 *
 * Assertions read the drawn-features panel and the persisted draw session
 * (localStorage 'mapviewer-draw', GeoJSON in EPSG:4326) rather than reaching
 * into the OL map instance.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

/** Let async effects (layer restore, session persistence) settle in act(). */
const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};

/** Give the map container a layout size and let OL render one frame. OL
 * interactions ignore browser events until a frameState exists, and jsdom
 * reports offsetWidth/offsetHeight as 0, so tests size the container
 * explicitly. Must run before the first awaited tick (the ResizeObserver
 * stub callback fires on the next macrotask and reads the size then). */
function giveMapSize(w = 1024, h = 768) {
  const el = document.getElementById('map') as HTMLElement;
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  el.style.border = '0';
  el.style.padding = '0';
  // OL's getEventPixel divides by viewportRect.width / mapSize, so the
  // viewport's bounding box must match the size given to the container
  // (jsdom reports an empty box otherwise, producing infinite pixels).
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
    await new Promise<void>(r => setTimeout(r, ms));
  });
};

function ptr(type: string, x: number, y: number, buttons = 1) {
  const ev = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
    bubbles: true,
    cancelable: true,
    view: window,
  });
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

/** Click "Draw Line" and draw a two-vertex line, finishing with dblclick. */
async function drawTwoVertexLine() {
  fireEvent.click(screen.getByTitle('Draw Line'));
  await tick();
  clickAt(100, 100);
  clickAt(200, 150);
  clickAt(200, 150); // second pair within 250ms → OL synthesises dblclick → finish
  await tick();
}

beforeEach(() => {
  localStorage.clear();
});

test('draws a line with two clicks + double-click finish and persists the session', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();

  // The drawn-features panel lists the completed line.
  expect(screen.getByText('Line 1')).toBeInTheDocument();

  // The session is persisted as a single LineString with finite coordinates.
  const feats = storedFeatures();
  expect(feats).toHaveLength(1);
  expect(feats[0].geometry.type).toBe('LineString');
  expect(feats[0].geometry.coordinates).toHaveLength(2);
  for (const c of feats[0].geometry.coordinates) {
    expect(Number.isFinite(c[0])).toBe(true);
    expect(Number.isFinite(c[1])).toBe(true);
  }
});

test('undo removes the drawn feature and redo brings it back', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  expect(storedFeatures()).toHaveLength(1);

  // Ctrl+Z restores the empty baseline; an empty session clears the key.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  await tick();
  expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
  expect(localStorage.getItem('mapviewer-draw')).toBeNull();

  // Ctrl+Shift+Z redoes the stroke.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  await tick();
  expect(screen.getByText('Line 1')).toBeInTheDocument();
  expect(storedFeatures()).toHaveLength(1);
});

test('modify tool drags a vertex to a new position', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedFeatures()[0].geometry.coordinates;

  // Activate the vertex-edit tool and drag the first vertex (100,100)→(140,120).
  fireEvent.click(screen.getByTitle('Edit vertices — drag to reshape drawn features'));
  await tick();
  down(100, 100);
  move(120, 110);
  move(140, 120);
  up(140, 120);
  await tick();

  const after = storedFeatures()[0].geometry.coordinates;
  expect(after).toHaveLength(2);
  expect(after[0]).not.toEqual(before[0]); // dragged vertex moved
  expect(after[1]).toEqual(before[1]);     // untouched vertex unchanged
});

/** Expand the drawn-features panel if collapsed (clicking its header toggles
 * it). Tools auto-expand the panel on activation, so this is belt and braces
 * for tests that assert on panel contents. */
async function ensureDrawnPanelExpanded() {
  if (!document.querySelector('.drawn-features-panel.expanded')) {
    fireEvent.click(screen.getByText('Drawn Features'));
    await tick();
  }
}

test('draws a polygon with three clicks + double-click finish and persists a closed ring', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  fireEvent.click(screen.getByTitle('Draw Polygon'));
  await tick();
  clickAt(150, 120);
  clickAt(280, 140);
  clickAt(240, 260);
  clickAt(240, 260); // second pair within 250ms → OL synthesises dblclick → finish
  await tick();

  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Polygon 1')).toBeInTheDocument();

  const feats = storedFeatures();
  expect(feats).toHaveLength(1);
  expect(feats[0].geometry.type).toBe('Polygon');
  const ring = feats[0].geometry.coordinates[0];
  expect(ring.length).toBeGreaterThanOrEqual(4);
  expect(ring[0]).toEqual(ring[ring.length - 1]); // ring is closed
  for (const c of ring) {
    expect(Number.isFinite(c[0])).toBe(true);
    expect(Number.isFinite(c[1])).toBe(true);
  }
});

test('draws a rectangle (click-move-click) and persists it as a polygon', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  fireEvent.click(screen.getByTitle('Draw Rectangle'));
  await tick();
  // OL's box drawing (Draw type 'Circle' + createBox, non-freehand) is
  // click - move - click: the first click sets one corner, the bare move
  // updates the opposite corner, the second click finishes. A press-drag-
  // release gesture is ignored because Draw skips POINTERDRAG events unless
  // freehand mode is active.
  clickAt(100, 100);
  move(220, 180);
  clickAt(220, 180);
  await tick();

  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Rectangle 1')).toBeInTheDocument();

  const feats = storedFeatures();
  expect(feats).toHaveLength(1);
  expect(feats[0].geometry.type).toBe('Polygon');
  const ring = feats[0].geometry.coordinates[0];
  expect(ring).toHaveLength(5); // four corners + closing vertex
  expect(ring[0]).toEqual(ring[ring.length - 1]);
});

test('label tool: Apply persists the label, Cancel discards the next one', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  fireEvent.click(screen.getByTitle('Add Label'));
  await tick();
  clickAt(150, 120);
  await tick();

  // The label dialog appears with a text input; type and apply.
  const input = screen.getByPlaceholderText('Label text...');
  fireEvent.change(input, { target: { value: 'Site A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await tick();

  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Label: Site A')).toBeInTheDocument();

  let saved = storedDraw();
  expect(JSON.parse(saved.geojson).features).toHaveLength(1);
  expect(JSON.parse(saved.geojson).features[0].geometry.type).toBe('Point');
  expect(saved.meta).toHaveLength(1);
  expect(saved.meta[0].labelText).toBe('Site A');
  expect(saved.meta[0].name).toBe('Label: Site A');

  // The label tool stays active — a second map click opens the dialog again.
  // Cancelling discards the new point, leaving only the applied label.
  clickAt(260, 210);
  await tick();
  expect(screen.getByPlaceholderText('Label text...')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await tick();

  expect(screen.queryByPlaceholderText('Label text...')).not.toBeInTheDocument();
  expect(screen.getByText('Label: Site A')).toBeInTheDocument();
  saved = storedDraw();
  expect(JSON.parse(saved.geojson).features).toHaveLength(1);
  expect(saved.meta).toHaveLength(1);
  expect(saved.meta[0].labelText).toBe('Site A');
});

test('undo/redo toolbar buttons and Ctrl+Y redo round-trip a drawn line', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  expect(storedFeatures()).toHaveLength(1);

  // The history buttons show while a draw tool is active.
  const undoBtn = screen.getByTitle('Undo (Ctrl+Z)');
  const redoBtn = screen.getByTitle('Redo (Ctrl+Shift+Z)');
  expect(undoBtn).not.toBeDisabled();

  // Undo via button removes the line and clears the persisted session.
  fireEvent.click(undoBtn);
  await tick();
  expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
  expect(localStorage.getItem('mapviewer-draw')).toBeNull();

  // Redo via button brings it back.
  expect(redoBtn).not.toBeDisabled();
  fireEvent.click(redoBtn);
  await tick();
  expect(screen.getByText('Line 1')).toBeInTheDocument();
  expect(storedFeatures()).toHaveLength(1);

  // Undo again, then redo with the Ctrl+Y keyboard shortcut.
  fireEvent.click(screen.getByTitle('Undo (Ctrl+Z)'));
  await tick();
  expect(screen.queryByText('Line 1')).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
  await tick();
  expect(screen.getByText('Line 1')).toBeInTheDocument();
  expect(storedFeatures()).toHaveLength(1);
});

test('draws two lines and lists and persists both', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  fireEvent.click(screen.getByTitle('Draw Line'));
  await tick();

  // Line 1.
  clickAt(100, 100);
  clickAt(200, 150);
  clickAt(200, 150);
  await tick();
  expect(screen.getByText('Line 1')).toBeInTheDocument();

  // Line 2 — the tool stays active after the first stroke.
  clickAt(300, 220);
  clickAt(420, 280);
  clickAt(420, 280);
  await tick();

  expect(screen.getByText('Line 1')).toBeInTheDocument();
  expect(screen.getByText('Line 2')).toBeInTheDocument();

  const feats = storedFeatures();
  expect(feats).toHaveLength(2);
  expect(feats[0].geometry.type).toBe('LineString');
  expect(feats[1].geometry.type).toBe('LineString');
});

test('removing a drawn feature updates the panel and clears persistence', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  await ensureDrawnPanelExpanded();
  expect(screen.getByText('Line 1')).toBeInTheDocument();

  fireEvent.click(screen.getByTitle('Remove feature'));
  await tick();

  expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
  expect(screen.getByText('No features drawn yet')).toBeInTheDocument();
  expect(localStorage.getItem('mapviewer-draw')).toBeNull();
});

test('saving drawn features creates a drawn-in-app vector layer and clears the session', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  await ensureDrawnPanelExpanded();

  fireEvent.change(screen.getByPlaceholderText('Layer name (optional)'), {
    target: { value: 'My Sketches' },
  });
  fireEvent.click(screen.getByTitle('Add to vector layers'));
  await tick();

  // The draw session is cleared — panel empty, storage key removed.
  expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
  expect(localStorage.getItem('mapviewer-draw')).toBeNull();

  // The settings persist a drawn-in-app vector layer carrying the geometry.
  // (Drawn layers are stored as type 'geojson' + isDrawnInApp: true.)
  const settings = JSON.parse(localStorage.getItem('mapviewer-settings') || '{}');
  expect(Array.isArray(settings.vectorLayers)).toBe(true);
  expect(settings.vectorLayers).toHaveLength(1);
  const layer = settings.vectorLayers[0];
  expect(layer.isDrawnInApp).toBe(true);
  expect(layer.name).toBe('My Sketches');
  const feats = JSON.parse(layer.drawnGeoJson).features;
  expect(feats).toHaveLength(1);
  expect(feats[0].geometry.type).toBe('LineString');
});

test('restores a persisted draw session on load', async () => {
  // Seed the exact persistence shape written by saveDrawSession(): GeoJSON
  // (EPSG:4326) + parallel meta array with id/name/customized/style.
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [[138.6, -34.93], [138.62, -34.9]],
        },
      },
    ],
  });
  localStorage.setItem('mapviewer-draw', JSON.stringify({
    geojson,
    meta: [
      {
        id: 'seed01',
        name: 'Line 1',
        customized: false,
        style: {
          opacity: 100,
          lineColor: 'rgba(255, 204, 51, 1)',
          lineWidth: 2,
          fillColor: 'rgba(255, 204, 51, 0.2)',
          fontColor: 'rgba(0, 0, 0, 1)',
          fontSize: 14,
        },
      },
    ],
  }));

  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  // Activating a draw tool reveals the drawn-features panel.
  fireEvent.click(screen.getByTitle('Draw Line'));
  await tick();
  await ensureDrawnPanelExpanded();

  expect(screen.getByText('Line 1')).toBeInTheDocument();
});
