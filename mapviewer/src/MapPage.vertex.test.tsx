/**
 * Integration tests for the MapPage vertex-editing (modify) workflow.
 *
 * These pin down the current behaviour of the vertex-editing code that lives
 * in MapPage.tsx (handleEditClick / handleEditDoubleClick / sticky-vertex
 * handling / the Modify+Translate interactions) so it can be safely extracted
 * into a useVertexEditing hook later.
 *
 * Same synthetic-event recipe as MapPage.draw.test.tsx: jsdom has no
 * PointerEvent constructor, so plain MouseEvents of type 'pointer*' carrying
 * the pointer properties OpenLayers reads (pointerId, pointerType, isPrimary,
 * button/buttons) are dispatched on the map viewport, where OL's
 * MapBrowserEventHandler listens. In jsdom the viewport rect is (0,0), so a
 * pixel is exactly the clientX/clientY that was dispatched.
 *
 * Timing notes (OL 9.x):
 * - A down+up pair at the same pixel synthesises an OL 'click' immediately and
 *   schedules 'singleclick' 250 ms later.
 * - OL Modify's default deleteCondition is altKeyOnly && singleClick, so an
 *   Alt+click removes a vertex only once the delayed 'singleclick' arrives —
 *   tests wait ~400 ms for it.
 * - Two click pairs within 250 ms synthesise 'dblclick' (used to finish
 *   drawing and to re-edit a label's text).
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import CanvasVectorLayerRenderer from 'ol/renderer/canvas/VectorLayer.js';

// ---------------------------------------------------------------------------
// jsdom hit-detection shim (test environment only).
//
// OL resolves "what feature is under this pixel" (Map.forEachFeatureAtPixel /
// hasFeatureAtPixel, used by the Translate interaction and the edit cursor)
// by re-rasterising each feature into a tiny off-screen canvas and reading
// the painted pixels back with getImageData. jsdom cannot rasterise — the
// shared 2D-context mock in setupTests.ts returns blank image data — so pixel
// hit detection can never find anything.
//
// To keep the *application* behaviour under test (Translate owning presses on
// the feature body, the edit cursor, the label dblclick fallback) faithful to
// a real browser, this shim replaces the canvas read-back with the exact
// geometric equivalent: a feature hits when the query coordinate is within
// hitTolerance pixels of its geometry. The public contract (callback /
// matches / distanceSq semantics) mirrors CanvasVectorLayerRenderer exactly.
// ---------------------------------------------------------------------------

function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

/** Minimum distance (map units) from a coordinate to a Point/Line/Polygon. */
function distanceToGeometry(coord: number[], geom: any): number {
  const type = geom.getType();
  if (type === 'Point') {
    const c = geom.getCoordinates();
    return Math.hypot(coord[0] - c[0], coord[1] - c[1]);
  }
  let rings: number[][][] = [];
  if (type === 'LineString') {
    rings = [geom.getCoordinates()];
  } else if (type === 'Polygon') {
    rings = geom.getCoordinates();
  } else {
    return Infinity;
  }
  let best = Infinity;
  rings.forEach((ring) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = Math.sqrt(distSqToSegment(coord[0], coord[1], ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]));
      if (d < best) best = d;
    }
  });
  return best;
}

(CanvasVectorLayerRenderer.prototype as any).forEachFeatureAtCoordinate = function (
  this: any,
  coordinate: number[],
  frameState: any,
  hitTolerance: number,
  callback: (feature: any, layer: any, geometry: any) => any,
  matches: Array<{ feature: any; layer: any; geometry: any; distanceSq: number; callback: any }>,
) {
  // Like the original: nothing to hit-test before the layer rendered once.
  if (!this.replayGroup_) return undefined;
  if (!frameState || !frameState.viewState) return undefined;
  const layer = this.getLayer();
  const source = layer && layer.getSource ? layer.getSource() : null;
  const feats: any[] = source && source.getFeatures ? source.getFeatures() : [];
  const resolution = frameState.viewState.resolution as number;
  // hitTolerance plus ~half the stroke width (lineWidth defaults to 2px) and
  // a pinch of rasterisation slop.
  const tolerancePx = hitTolerance + 2;
  let result: any;
  feats.some((feature: any) => {
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom) return false;
    const dist = distanceToGeometry(coordinate, geom);
    if (!Number.isFinite(dist)) return false;
    const distPx = dist / resolution;
    if (distPx > tolerancePx) return false;
    const distanceSq = distPx * distPx;
    if (distanceSq === 0) {
      result = callback(feature, layer, geom);
      return !!result;
    }
    matches.push({ feature, layer, geometry: geom, distanceSq, callback });
    return false;
  });
  return result;
};

// ---------------------------------------------------------------------------
// Synthetic-pointer helpers (same recipe as MapPage.draw.test.tsx)
// ---------------------------------------------------------------------------

/** Let async effects (layer restore, session persistence) settle in act(). */
const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};

/** Give the map container a layout size and let OL render one frame. Must run
 * right after render, before the first awaited tick (the ResizeObserver stub
 * callback fires on the next macrotask and reads the size then). */
function giveMapSize(w = 1024, h = 768) {
  const el = document.getElementById('map') as HTMLElement;
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  el.style.border = '0';
  el.style.padding = '0';
  // OL's getEventPixel divides by viewportRect.width / mapSize, so the
  // viewport's bounding box must match the size given to the container.
  const vp = document.querySelector('.ol-viewport') as HTMLElement | null;
  if (vp) {
    Object.defineProperty(vp, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }),
    });
  }
}

/** Wait long enough for the ResizeObserver callback + rAF render frames, and
 * for OL's delayed 'singleclick' when ms > 250. */
const frame = async (ms = 80) => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, ms));
  });
};

function ptr(type: string, x: number, y: number, buttons = 1, altKey = false) {
  const ev = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
    altKey,
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
const down = (x: number, y: number, altKey = false) => fireEvent(viewport(), ptr('pointerdown', x, y, 1, altKey));
const move = (x: number, y: number) => fireEvent(viewport(), ptr('pointermove', x, y));
const up = (x: number, y: number, altKey = false) => fireEvent(viewport(), ptr('pointerup', x, y, 0, altKey));
/** OL click: down+up at the same pixel (within its 6px click tolerance). */
const clickAt = (x: number, y: number) => {
  down(x, y);
  up(x, y);
};
/** Alt+click: owned by OL Modify's deleteCondition (altKeyOnly && singleClick). */
const altClickAt = (x: number, y: number) => {
  down(x, y, true);
  up(x, y, true);
};

const storedDraw = () => {
  const raw = localStorage.getItem('mapviewer-draw');
  return raw ? JSON.parse(raw) : null;
};
const storedFeatures = () => {
  const saved = storedDraw();
  return saved ? JSON.parse(saved.geojson).features : [];
};
/** Persisted coordinate list of the first drawn feature. */
const storedCoords = () => storedFeatures()[0].geometry.coordinates;

/** The modify tool button's exact title (DrawToolbar.tsx). */
const MODIFY_TOOL = 'Edit vertices \u2014 drag to reshape drawn features';

/** Click "Draw Line" and draw a two-vertex line, finishing with dblclick. */
async function drawTwoVertexLine() {
  fireEvent.click(screen.getByTitle('Draw Line', { exact: false }));
  await tick();
  clickAt(100, 100);
  clickAt(200, 150);
  clickAt(200, 150); // second pair within 250ms -> OL synthesises dblclick -> finish
  await tick();
}

/** Switch on the vertex-edit tool. */
async function activateModify() {
  fireEvent.click(screen.getByTitle(MODIFY_TOOL));
  await tick();
}

/** The modify hint bar (rendered whenever an edit session is active). */
const hintBar = () => document.querySelector('.draw-modify-hint') as HTMLElement | null;

beforeEach(() => {
  localStorage.clear();
});

test('segment click inserts a vertex between the endpoints', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedCoords();
  expect(before).toHaveLength(2);

  await activateModify();

  // Single click at the segment midpoint (100,100)-(200,150) -> (150,125).
  clickAt(150, 125);
  await tick();

  const after = storedCoords();
  expect(after).toHaveLength(3);
  // The fresh vertex sits strictly between the original endpoints in both
  // lon and lat (the pixel->coordinate mapping is monotonic per axis).
  const inserted = after[1];
  expect(after[0]).toEqual(before[0]);
  expect(after[2]).toEqual(before[1]);
  expect(inserted[0]).toBeGreaterThan(Math.min(before[0][0], before[1][0]));
  expect(inserted[0]).toBeLessThan(Math.max(before[0][0], before[1][0]));
  expect(inserted[1]).toBeGreaterThan(Math.min(before[0][1], before[1][1]));
  expect(inserted[1]).toBeLessThan(Math.max(before[0][1], before[1][1]));

  // The inserted vertex is picked up immediately ("sticky"): the hint bar
  // says how to place it. A plain click puts it down again unchanged.
  expect(hintBar()?.textContent).toContain('Click to place the vertex');
  clickAt(150, 125);
  await tick();
  expect(hintBar()?.textContent).not.toContain('Click to place the vertex');
  expect(storedCoords()).toHaveLength(3);
});

test('Alt+click removes a vertex but a two-vertex line never degenerates', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  await activateModify();

  // Insert a vertex so the line has three, then put the picked-up vertex down.
  clickAt(150, 125);
  await tick();
  expect(storedCoords()).toHaveLength(3);
  clickAt(150, 125); // place the sticky inserted vertex where it already is
  await tick();
  expect(storedCoords()).toHaveLength(3);
  // Let the place-click's delayed 'singleclick' expire so the Alt+click below
  // starts a fresh click sequence (two clicks within 250ms = dblclick).
  await frame(300);

  // Alt+click the middle vertex -> removed after OL's singleclick arrives.
  move(150, 125);
  altClickAt(150, 125);
  await frame(400);

  const afterRemove = storedCoords();
  expect(afterRemove).toHaveLength(2);

  // A 2-vertex line refuses to degenerate: Alt+click a remaining vertex and
  // the geometry is untouched.
  move(100, 100);
  altClickAt(100, 100);
  await frame(400);
  expect(storedCoords()).toHaveLength(2);
  expect(storedCoords()).toEqual(afterRemove);
});

test('clicking a vertex picks it up, it follows the pointer, next click places it', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedCoords();
  await activateModify();

  // Click directly ON the first vertex without dragging -> sticky pick-up.
  clickAt(100, 100);
  await tick();
  expect(hintBar()?.textContent).toContain('Click to place the vertex');

  // The picked-up vertex follows the pointer on hover moves.
  move(140, 90);
  await tick();

  // Click to place it at the new position.
  clickAt(140, 90);
  await tick();

  const after = storedCoords();
  expect(after).toHaveLength(2);
  expect(after[0]).not.toEqual(before[0]); // moved vertex changed
  expect(after[1]).toEqual(before[1]);     // untouched vertex unchanged
  // The sticky session is over: the placement hint is gone.
  expect(hintBar()?.textContent).not.toContain('Click to place the vertex');
});

test('Delete removes the picked-up vertex', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  // Three-vertex line: (100,100) (200,150) (300,100) + dblclick finish.
  fireEvent.click(screen.getByTitle('Draw Line', { exact: false }));
  await tick();
  clickAt(100, 100);
  clickAt(200, 150);
  clickAt(300, 100);
  clickAt(300, 100);
  await tick();
  const before = storedCoords();
  expect(before).toHaveLength(3);

  await activateModify();

  // Pick up the middle vertex with a click (no drag).
  clickAt(200, 150);
  await tick();
  expect(hintBar()?.textContent).toContain('Click to place the vertex');

  fireEvent.keyDown(window, { key: 'Delete' });
  await tick();

  const after = storedCoords();
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]).toEqual(before[2]);
  expect(hintBar()?.textContent).not.toContain('Click to place the vertex');
});

test('Escape puts the picked-up vertex back where it was', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedCoords();
  await activateModify();

  // Pick up the first vertex, drag the pointer away (the vertex follows)...
  clickAt(100, 100);
  await tick();
  move(160, 130);
  await tick();

  // ...then Escape restores the original geometry.
  fireEvent.keyDown(window, { key: 'Escape' });
  await tick();

  expect(storedCoords()).toEqual(before);
  expect(hintBar()?.textContent).not.toContain('Click to place the vertex');
});

test('dragging the feature body (away from vertices) translates the whole feature', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedCoords();
  await activateModify();

  // What actually happens on a segment press (MapPage ~L2276-2316 + OL 9.2):
  // interactions are offered events last-added-first, so the whole-feature
  // Translate (added after Modify) sees the pointerdown first. Its condition
  // refuses pixels within 12px of any vertex — the segment midpoint
  // (150,125) is ~56px from either endpoint — and then grabs the feature via
  // Map.forEachFeatureAtPixel (hitTolerance 6). Translate.stopDown stops the
  // event, so Modify never sees the press, and because the pointer MOVES, OL
  // synthesises no 'click' — handleEditClick never runs and nothing is
  // inserted. Net effect: the whole feature translates.
  down(150, 125);
  move(180, 145);
  up(180, 145);
  await tick();

  const after = storedCoords();
  expect(after).toHaveLength(2);
  const d0 = [after[0][0] - before[0][0], after[0][1] - before[0][1]];
  const d1 = [after[1][0] - before[1][0], after[1][1] - before[1][1]];
  // Something moved, in the direction of the drag (right + screen-down =
  // east + south: longitude grows, latitude shrinks).
  expect(d0[0]).toBeGreaterThan(0);
  expect(d0[1]).toBeLessThan(0);
  // Whole-feature translate: every vertex shifts by the same delta. Longitude
  // is linear in Web Mercator x, so the two x-deltas are equal; latitude
  // shares the sign and a comparable magnitude (Mercator's y-scale varies
  // with latitude, and the two vertices sit at different latitudes).
  expect(d0[0]).toBeCloseTo(d1[0], 9);
  expect(Math.sign(d0[1])).toBe(Math.sign(d1[1]));
  expect(d0[1] / d1[1]).toBeGreaterThan(0.8);
  expect(d0[1] / d1[1]).toBeLessThan(1.2);
});

test('double-clicking a label reopens the text dialog prefilled', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  // Draw a label: Add Label tool -> click map -> dialog -> 'Site A' -> Apply.
  fireEvent.click(screen.getByTitle('Add Label'));
  await tick();
  clickAt(300, 200);
  await tick();
  fireEvent.change(screen.getByPlaceholderText('Label text...'), { target: { value: 'Site A' } });
  fireEvent.click(document.querySelector('.label-input-dialog-btn-apply') as HTMLElement);
  await tick();
  expect(screen.getByText('Label: Site A')).toBeInTheDocument();
  let saved = storedDraw();
  expect(saved.meta[0].labelText).toBe('Site A');
  // Drain the label click's delayed singleclick before the next gesture.
  await frame(300);

  await activateModify();

  // Double-click the label point: the first click picks the point vertex up,
  // the second puts it straight back down, and the dblclick reopens the
  // dialog with the current text.
  clickAt(300, 200);
  clickAt(300, 200);
  await tick();

  const input = screen.getByPlaceholderText('Label text...') as HTMLInputElement;
  expect(input.value).toBe('Site A');

  fireEvent.change(input, { target: { value: 'Site B' } });
  fireEvent.click(document.querySelector('.label-input-dialog-btn-apply') as HTMLElement);
  await tick();

  expect(screen.getByText('Label: Site B')).toBeInTheDocument();
  expect(screen.queryByText('Label: Site A')).not.toBeInTheDocument();
  saved = storedDraw();
  expect(saved.meta[0].labelText).toBe('Site B');
  expect(saved.meta[0].name).toBe('Label: Site B');
});

test('Ctrl+Z undoes a vertex drag back to the pre-edit coordinates', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedCoords();
  await activateModify();

  // Drag the first vertex to a new position (Modify).
  down(100, 100);
  move(120, 110);
  move(140, 120);
  up(140, 120);
  await tick();
  expect(storedCoords()[0]).not.toEqual(before[0]);

  // Undo restores the pre-edit geometry.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  await tick();
  expect(storedCoords()).toEqual(before);

  // Redo brings the drag back.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  await tick();
  expect(storedCoords()[0]).not.toEqual(before[0]);
});

test('Escape with a picked-up vertex: first puts it back, second exits the modify tool', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await drawTwoVertexLine();
  const before = storedCoords();
  await activateModify();

  const modifyBtn = screen.getByTitle(MODIFY_TOOL);
  expect(modifyBtn.className).toContain('active');

  // Pick up the first vertex with a click (no drag).
  clickAt(100, 100);
  await tick();
  expect(hintBar()?.textContent).toContain('Click to place the vertex');

  // First Escape puts the vertex back where it was and keeps the tool armed.
  fireEvent.keyDown(window, { key: 'Escape' });
  await tick();
  expect(storedCoords()).toEqual(before);
  expect(hintBar()?.textContent).not.toContain('Click to place the vertex');
  expect(modifyBtn.className).toContain('active');

  // Second Escape exits the modify tool.
  fireEvent.keyDown(window, { key: 'Escape' });
  await tick();
  expect(modifyBtn.className).not.toContain('active');
  expect(hintBar()).toBeNull();
});
