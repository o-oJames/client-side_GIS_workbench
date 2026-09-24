/**
 * Integration tests: the vector layer editor's opacity, the "Use in-file
 * style" toggle and Cancel, driven through the real MapPage.
 *
 * These are the three reported defects, pinned end to end (OL layer state,
 * persisted config and the editor's own widgets must all agree):
 *
 *  1. Cancel after an opacity change left the map at the previewed opacity
 *     while the config/slider reverted - the restore callbacks each re-read
 *     the (stale) config and re-applied a full style, undoing the first one.
 *  2. Opacity was bundled with the style payload, so moving the opacity
 *     slider on a layer that renders with its file's own styles replaced
 *     those per-feature styles with the uniform editor style; and switching
 *     the in-file style toggle back on reset the map opacity to 100%.
 *  3. Cancel always restored the in-file styles, even when the layer was in
 *     custom-style mode before the editor opened.
 *
 * The OL map is reached through a spy on `Map.prototype.addLayer` (the only
 * handle on the instance MapPage keeps in a ref), and layers are re-queried
 * after every action because restoring in-file styles rebuilds the layer.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import OLMap from 'ol/Map.js';
import VectorSource from 'ol/source/Vector.js';
import Cluster from 'ol/source/Cluster.js';

// --- helpers ----------------------------------------------------------------

const tick = async () => {
  await act(async () => { await new Promise<void>(r => setTimeout(r, 0)); });
};
const frame = async (ms = 60) => {
  await act(async () => { await new Promise<void>(r => setTimeout(r, ms)); });
};

function giveMapSize(w = 1024, h = 768) {
  const el = document.getElementById('map') as HTMLElement;
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  const vp = document.querySelector('.ol-viewport') as HTMLElement | null;
  if (vp) {
    Object.defineProperty(vp, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: 0 + h, x: 0, y: 0, toJSON() {} }),
    });
  }
}

/** The OL map MapPage created (captured through addLayer's `this`). */
let addLayerSpy: any;
function olMap(): any {
  const instances = addLayerSpy?.mock?.instances ?? [];
  return instances.length ? instances[instances.length - 1] : null;
}

/** The live OL vector layer carrying a feature named `name`. */
function vectorLayerFor(name: string): any {
  const map = olMap();
  if (!map) return null;
  const all = map.getLayers().getArray();
  for (let i = all.length - 1; i >= 0; i--) {
    const l: any = all[i];
    const src = l.getSource?.();
    const raw = src instanceof Cluster ? src.getSource() : src;
    if (!(raw instanceof VectorSource)) continue;
    if (raw.getFeatures().some((f: any) => f.get('name') === name)) return l;
  }
  return null;
}

const rawFeatures = (l: any): any[] => {
  const src = l?.getSource?.();
  const raw = src instanceof Cluster ? src.getSource() : src;
  return raw?.getFeatures?.() ?? [];
};

/** How many of the layer's features still carry their own (in-file) style. */
const inFileStyledFeatureCount = (l: any) =>
  rawFeatures(l).filter((f: any) => f.getStyle() !== undefined && f.getStyle() !== null).length;

const sliderByLabel = (label: string): HTMLInputElement => {
  const rows = Array.from(document.querySelectorAll('.settings-slider-row'));
  const row = rows.find(r => r.querySelector('.settings-slider-label')?.textContent === label);
  const input = row?.querySelector('input[type="range"]') as HTMLInputElement | undefined;
  if (!input) throw new Error(`no slider labelled "${label}"`);
  return input;
};

const inFileToggle = () => screen.getByRole('switch', { name: '' }) as HTMLElement;

const savedLayer = (id: string) => {
  const raw = localStorage.getItem('mapviewer-settings');
  const parsed = raw ? JSON.parse(raw) : null;
  return parsed?.vectorLayers?.find((l: any) => l.id === id) ?? null;
};

async function openEditor(layerTitle: string) {
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  for (let i = 0; i < 50 && !screen.queryByText(layerTitle); i++) await frame(20);
  expect(screen.getByText(layerTitle)).toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Edit layer'));
  await tick();
}

// --- fixtures ---------------------------------------------------------------

const KML_WITH_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Red Line</name>
    <Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>
    <LineString><coordinates>0,0,0 1,1,0</coordinates></LineString>
  </Placemark>
  <Placemark><name>Green Line</name>
    <Style><LineStyle><color>ff00ff00</color><width>2</width></LineStyle></Style>
    <LineString><coordinates>1,0,0 0,1,0</coordinates></LineString>
  </Placemark>
</Document></kml>`;

const KML_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Red Line' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
    { type: 'Feature', properties: { name: 'Green Line' }, geometry: { type: 'LineString', coordinates: [[1, 0], [0, 1]] } },
  ],
});

const PLAIN_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Plain Road' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ],
});

// A KML with no <Style> element anywhere: the importer records `useCustomStyle:
// false` (it has KML text) but `hasInFileStyle: false`, so the config's uniform
// style is what draws it - the "vector file (no in-file style)" of report #1.
const KML_NO_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Plain Road</name>
    <LineString><coordinates>0,0,0 1,1,0</coordinates></LineString>
  </Placemark>
</Document></kml>`;

const PLAIN_KML_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Plain Road' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ],
});

const stylelessKmlLayer = (over: Record<string, any> = {}) => ({
  id: 'kmlplain', name: 'Plain KML', type: 'kml', visible: true,
  opacity: 100, lineColor: 'rgba(66, 133, 244, 1)', lineWidth: 4, fillColor: 'rgba(66, 133, 244, 0.3)',
  kmlText: KML_NO_STYLES, drawnGeoJson: PLAIN_KML_GEOJSON,
  hasInFileStyle: false, useCustomStyle: false,
  ...over,
});

function seed(layers: any[]) {
  localStorage.setItem('mapviewer-view', JSON.stringify({ lat: 0, lng: 0, z: 6 }));
  localStorage.setItem('mapviewer-settings', JSON.stringify({ settingsPinned: true, vectorLayers: layers }));
}

const styledKmlLayer = (over: Record<string, any> = {}) => ({
  id: 'kml1', name: 'Styled KML', type: 'kml', visible: true,
  opacity: 100, lineColor: 'rgba(255, 0, 0, 1)', lineWidth: 3, fillColor: 'rgba(255, 0, 0, 0.3)',
  kmlText: KML_WITH_STYLES, drawnGeoJson: KML_GEOJSON,
  hasInFileStyle: true, useCustomStyle: false,
  ...over,
});

const plainFileLayer = (over: Record<string, any> = {}) => ({
  id: 'geo1', name: 'Plain File', type: 'geojson', visible: true,
  opacity: 100, lineColor: 'rgba(66, 133, 244, 1)', lineWidth: 2, fillColor: 'rgba(66, 133, 244, 0.3)',
  drawnGeoJson: PLAIN_GEOJSON, hasInFileStyle: false,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  addLayerSpy = vi.spyOn(OLMap.prototype, 'addLayer');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- 1. Cancel restores the map, and the slider mirrors the map -------------

test('cancel after an opacity change puts the map back to the original opacity', async () => {
  seed([plainFileLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Plain File');

  const layer = vectorLayerFor('Plain Road');
  expect(layer).toBeTruthy();
  expect(layer.getOpacity()).toBe(1);

  // Live preview: the map follows the slider.
  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '40' } });
  await tick();
  expect(vectorLayerFor('Plain Road').getOpacity()).toBeCloseTo(0.4, 5);

  // Cancel: map AND config go back to what they were when the editor opened.
  fireEvent.click(screen.getByText('Cancel'));
  await tick();

  const restored = vectorLayerFor('Plain Road');
  expect(restored.getOpacity()).toBe(1);
  expect(savedLayer('geo1')?.opacity).toBe(100);
});

test('after cancel the reopened editor shows the opacity the map is drawing', async () => {
  seed([plainFileLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Plain File');

  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '40' } });
  await tick();
  expect(vectorLayerFor('Plain Road').getOpacity()).toBeCloseTo(0.4, 5);

  fireEvent.click(screen.getByText('Cancel'));
  await tick();
  expect(vectorLayerFor('Plain Road').getOpacity()).toBe(1);

  // The reported symptom was the two disagreeing: the map kept the previewed
  // opacity while the slider snapped back to the original. Reopening the editor
  // must show the value the map is actually drawing.
  fireEvent.click(screen.getByTitle('Edit layer'));
  await tick();
  expect(sliderByLabel('Opacity').value).toBe('100');
  expect(vectorLayerFor('Plain Road').getOpacity()).toBe(1);
  expect(savedLayer('geo1')?.opacity).toBe(100);
});

test('cancel after a colour change puts the map back to the original colour', async () => {
  seed([plainFileLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Plain File');

  // Change the line colour through the style panel (the first colour editor
  // in the expanded body is "Line color").
  fireEvent.click(screen.getByText('Colors & style'));
  await tick();
  const lineEditor = document.querySelector('.ca-editor') as HTMLElement;
  expect(lineEditor.textContent).toContain('Line color');
  fireEvent.change(lineEditor.querySelector('input[type="color"]') as HTMLInputElement, {
    target: { value: '#00ff00' },
  });
  await tick();

  const previewed: any = vectorLayerFor('Plain Road');
  const previewStyle: any = previewed.getStyle()(rawFeatures(previewed)[0], 1);
  expect(String(previewStyle.getStroke().getColor())).toContain('0, 255, 0');

  fireEvent.click(screen.getByText('Cancel'));
  await tick();

  const restored: any = vectorLayerFor('Plain Road');
  const restoredStyle: any = restored.getStyle()(rawFeatures(restored)[0], 1);
  expect(String(restoredStyle.getStroke().getColor())).toContain('66, 133, 244');
  expect(savedLayer('geo1')?.lineColor).toBe('rgba(66, 133, 244, 1)');
});

// --- 2. Opacity is independent of the style source -------------------------

test('opacity applies to a layer rendering with its file styles, without restyling it', async () => {
  seed([styledKmlLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Styled KML');

  const layer = vectorLayerFor('Red Line');
  expect(inFileStyledFeatureCount(layer)).toBe(2); // per-feature KML styles

  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '40' } });
  await tick();

  const after = vectorLayerFor('Red Line');
  expect(after.getOpacity()).toBeCloseTo(0.4, 5);
  // The file's own styles must survive an opacity change.
  expect(inFileStyledFeatureCount(after)).toBe(2);
  expect(savedLayer('kml1')?.useCustomStyle).toBe(false);
  expect(savedLayer('kml1')?.opacity).toBe(40);
});

test('the in-file style toggle keeps the edited opacity on the map and in the slider', async () => {
  seed([styledKmlLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Styled KML');

  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '40' } });
  await tick();

  // Off: the editor's uniform style takes over, at the same opacity.
  const toggle = document.querySelector('.settings-infile-style-switch') as HTMLElement;
  fireEvent.click(toggle);
  await tick();
  const custom = vectorLayerFor('Red Line');
  expect(custom.getOpacity()).toBeCloseTo(0.4, 5);
  expect(inFileStyledFeatureCount(custom)).toBe(0);

  // On again: the file's styles come back and the opacity is still 40%.
  fireEvent.click(document.querySelector('.settings-infile-style-switch') as HTMLElement);
  await tick();
  const inFile = vectorLayerFor('Red Line');
  expect(inFile.getOpacity()).toBeCloseTo(0.4, 5);
  expect(inFileStyledFeatureCount(inFile)).toBe(2);
  expect(sliderByLabel('Opacity').value).toBe('40');
  expect(savedLayer('kml1')?.opacity).toBe(40);
});

// --- 3. Cancel restores whichever style mode the layer was in --------------

test('cancel keeps a layer that was already in custom-style mode in custom-style mode', async () => {
  seed([styledKmlLayer({ useCustomStyle: true, opacity: 70 })]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Styled KML');

  const layer = vectorLayerFor('Red Line');
  expect(inFileStyledFeatureCount(layer)).toBe(0); // custom style: no per-feature styles
  expect(layer.getOpacity()).toBeCloseTo(0.7, 5);

  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '25' } });
  await tick();
  expect(vectorLayerFor('Red Line').getOpacity()).toBeCloseTo(0.25, 5);

  fireEvent.click(screen.getByText('Cancel'));
  await tick();

  const restored = vectorLayerFor('Red Line');
  expect(restored.getOpacity()).toBeCloseTo(0.7, 5);
  expect(inFileStyledFeatureCount(restored)).toBe(0); // still custom style
  expect(savedLayer('kml1')?.useCustomStyle).toBe(true);
  expect(savedLayer('kml1')?.opacity).toBe(70);
});

test('the toggle rebuilds the file styles for a layer that came back in custom mode', async () => {
  // This is the state a styled KML is in after a page reload with the switch
  // off: its features were rebuilt from GeoJSON, so none carries a stashed
  // in-file style and the KML text is the only copy of the file's styles left.
  // Switching the source back on has to rebuild from that text, and carry the
  // opacity in force across rather than resetting it to 100%.
  seed([styledKmlLayer({ useCustomStyle: true, opacity: 55 })]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Styled KML');

  const before = vectorLayerFor('Red Line');
  expect(inFileStyledFeatureCount(before)).toBe(0);
  expect(before.getOpacity()).toBeCloseTo(0.55, 5);

  // Change the opacity first, exactly as the report did, then switch the source.
  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '40' } });
  await tick();
  fireEvent.click(document.querySelector('.settings-infile-style-switch') as HTMLElement);
  await tick();

  const after = vectorLayerFor('Red Line');
  expect(inFileStyledFeatureCount(after)).toBe(2); // the file's own styles are back
  expect(after.getOpacity()).toBeCloseTo(0.4, 5);  // ... at the opacity in force
  expect(sliderByLabel('Opacity').value).toBe('40');
  expect(savedLayer('kml1')?.useCustomStyle).toBe(false);
  expect(savedLayer('kml1')?.opacity).toBe(40);
});

test('cancel restores the in-file styles when the editor opened in in-file mode', async () => {
  seed([styledKmlLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();
  await openEditor('Styled KML');

  // Switch to custom style during the session, then cancel.
  fireEvent.click(document.querySelector('.settings-infile-style-switch') as HTMLElement);
  await tick();
  expect(inFileStyledFeatureCount(vectorLayerFor('Red Line'))).toBe(0);

  fireEvent.click(screen.getByText('Cancel'));
  await tick();

  const restored = vectorLayerFor('Red Line');
  expect(inFileStyledFeatureCount(restored)).toBe(2);
  expect(restored.getOpacity()).toBe(1);
  expect(savedLayer('kml1')?.useCustomStyle).toBe(false);
  expect(savedLayer('kml1')?.opacity).toBe(100);
});

// --- 4. A file with no in-file style of its own (report #1, literally) -------

test('a styleless KML keeps its user colours through a restore, and Cancel returns the opacity', async () => {
  seed([stylelessKmlLayer()]);
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  // Restored with the uniform style from its config - not with the KML defaults
  // OpenLayers' `extractStyles: true` hands a placemark that has no <Style>.
  const layer: any = vectorLayerFor('Plain Road');
  expect(layer).toBeTruthy();
  const restoredStyle: any = layer.getStyle()(rawFeatures(layer)[0], 1);
  expect(String(restoredStyle.getStroke().getColor())).toContain('66, 133, 244');
  expect(layer.getOpacity()).toBe(1);

  await openEditor('Plain KML');

  // There are no file styles to switch to, so the switch is inert and the
  // colour/opacity controls describe what the map is drawing.
  const sw = document.querySelector('.settings-infile-style-switch') as HTMLButtonElement;
  expect(sw).toBeTruthy();
  expect(sw.disabled).toBe(true);

  fireEvent.change(sliderByLabel('Opacity'), { target: { value: '40' } });
  await tick();
  expect(vectorLayerFor('Plain Road').getOpacity()).toBeCloseTo(0.4, 5);

  fireEvent.click(screen.getByText('Cancel'));
  await tick();

  // Map, config and (on reopen) the slider all agree again.
  expect(vectorLayerFor('Plain Road').getOpacity()).toBe(1);
  expect(savedLayer('kmlplain')?.opacity).toBe(100);
  fireEvent.click(screen.getByTitle('Edit layer'));
  await tick();
  expect(sliderByLabel('Opacity').value).toBe('100');
});
