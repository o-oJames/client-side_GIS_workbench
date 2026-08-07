/**
 * Integration tests: geometry editing of file-imported vector layers.
 *
 * A geojson layer imported from a file (persisted inline, as in environments
 * without IndexedDB) restores on load and becomes editable in place through
 * the edit form's "Edit geometry" button — the same re-edit session drawn
 * layers get. Edits land on the layer's own source, undo/redo keeps the
 * features' data attributes intact, and ending the session flushes the
 * edited geometry + attributes straight to storage.
 *
 * Same synthetic-event recipe as MapPage.vertex.test.tsx (jsdom pointer
 * events dispatched on the OL viewport), including the hit-detection shim.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import CanvasVectorLayerRenderer from 'ol/renderer/canvas/VectorLayer.js';

// --- jsdom hit-detection shim (same as MapPage.vertex.test.tsx) -------------

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

function distanceToGeometry(coord: number[], geom: any): number {
  const type = geom.getType();
  if (type === 'Point') {
    const c = geom.getCoordinates();
    return Math.hypot(coord[0] - c[0], coord[1] - c[1]);
  }
  let rings: number[][][] = [];
  if (type === 'LineString') rings = [geom.getCoordinates()];
  else if (type === 'Polygon') rings = geom.getCoordinates();
  else return Infinity;
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
  if (!this.replayGroup_) return undefined;
  if (!frameState || !frameState.viewState) return undefined;
  const layer = this.getLayer();
  const source = layer && layer.getSource ? layer.getSource() : null;
  const feats: any[] = source && source.getFeatures ? source.getFeatures() : [];
  const resolution = frameState.viewState.resolution as number;
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

// --- synthetic-pointer helpers ----------------------------------------------

const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};

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
const clickAt = (x: number, y: number) => {
  fireEvent(viewport(), ptr('pointerdown', x, y));
  fireEvent(viewport(), ptr('pointerup', x, y, 0));
};

const hintBar = () => document.querySelector('.draw-modify-hint') as HTMLElement | null;

// --- fixture: a file-imported line layer with attributes ---------------------
// View centred on (0,0) at z14 so the map centre pixel (512,384) is the
// EPSG:3857 origin and one pixel is RES map units.
const RES = 156543.03392804097 / Math.pow(2, 14);

function seedFileLineLayer() {
  localStorage.setItem('mapviewer-view', JSON.stringify({ lat: 0, lng: 0, z: 14 }));
  const feature = new Feature({
    geometry: new LineString([[-100 * RES, 0], [100 * RES, 0]]), // pixels (412,384)-(612,384)
    name: 'Test Road',
    lanes: 2,
  });
  const geojson = new GeoJSON().writeFeatures([feature], {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  });
  localStorage.setItem('mapviewer-settings', JSON.stringify({
    // Pinned so the panel stays open while the map receives edit gestures
    // (an unpinned Settings dialog closes on the first outside pointerdown).
    settingsPinned: true,
    vectorLayers: [{ id: 'file1', name: 'Imported', type: 'geojson', visible: true, drawnGeoJson: geojson }],
  }));
}

const savedFileLayer = () => {
  const raw = localStorage.getItem('mapviewer-settings');
  const parsed = raw ? JSON.parse(raw) : null;
  return parsed?.vectorLayers?.find((l: any) => l.id === 'file1') ?? null;
};
const savedFeatures = () => {
  const layer = savedFileLayer();
  expect(layer?.drawnGeoJson).toBeTruthy();
  return new GeoJSON().readFeatures(layer.drawnGeoJson, {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  });
};
const savedCoords = () => (savedFeatures()[0].getGeometry() as LineString).getCoordinates();

/** Open the settings dialog and the layer's edit form (waits for restore). */
async function openEditForm() {
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  // The file layer restores asynchronously; wait for its row to appear.
  for (let i = 0; i < 50 && !screen.queryByText('Imported'); i++) await frame(20);
  expect(screen.getByText('Imported')).toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Edit layer'));
  await tick();
}

beforeEach(() => {
  localStorage.clear();
});

test('file-imported layer: segment-click vertex insert persists with attributes when the session ends', async () => {
  seedFileLineLayer();
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await openEditForm();
  fireEvent.click(screen.getByText('Edit geometry'));
  await tick();

  // The re-edit session is live: the button flips and the edit hint shows.
  expect(screen.getByText('Done editing')).toBeInTheDocument();
  expect(hintBar()).toBeTruthy();

  // Insert a vertex at the segment midpoint (pixel 512,384 = map origin),
  // then place the picked-up vertex with a second click.
  clickAt(512, 384);
  await tick();
  expect(hintBar()?.textContent).toContain('Click to place the vertex');
  clickAt(512, 384);
  await tick();

  // Geometry edits only mutate OL features — nothing re-ran the settings
  // save yet, so storage still holds the original two-vertex line.
  expect(savedCoords()).toHaveLength(2);

  // Ending the session flushes the edited geometry to storage.
  fireEvent.click(screen.getByText('Done editing'));
  await tick();

  const coords = savedCoords();
  expect(coords).toHaveLength(3);
  // The inserted vertex sits at the map origin (within reprojection slop).
  expect(Math.abs(coords[1][0])).toBeLessThan(1);
  expect(Math.abs(coords[1][1])).toBeLessThan(1);

  // Data attributes survived the edit session.
  const props = savedFeatures()[0].getProperties();
  expect(props.name).toBe('Test Road');
  expect(props.lanes).toBe(2);
});

test('file-imported layer: undo restores geometry without dropping attributes', async () => {
  seedFileLineLayer();
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  await openEditForm();
  fireEvent.click(screen.getByText('Edit geometry'));
  await tick();

  clickAt(512, 384);
  await tick();
  clickAt(512, 384);
  await tick();

  // Undo the insertion.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  await tick();

  fireEvent.click(screen.getByText('Done editing'));
  await tick();

  expect(savedCoords()).toHaveLength(2);
  const props = savedFeatures()[0].getProperties();
  expect(props.name).toBe('Test Road');
  expect(props.lanes).toBe(2);
});
