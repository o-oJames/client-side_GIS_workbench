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
import React from 'react';
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
