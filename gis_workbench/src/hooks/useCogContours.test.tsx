/**
 * useCogContours — the companion vector overlay behind the COG Contours
 * renderer. The map here is a stub: what matters is which layers the hook puts
 * on it, when the raster hides underneath, and that symbol-only edits never
 * re-read a byte of the file.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import VectorSource from 'ol/source/Vector.js';
import type { RasterLayer, VectorLayerConfig } from '../types';
import { useCogContours } from './useCogContours';

// --- fakes ------------------------------------------------------------------

/** One geotiff.js level: a 100x100 ramp over a 100x100 unit area. */
function fakeCogImage() {
  const reads: any[] = [];
  return {
    reads,
    getWidth: () => 100,
    getHeight: () => 100,
    getBoundingBox: () => [0, 0, 100, 100],
    getResolution: () => [1, -1],
    getSamplesPerPixel: () => 1,
    getGDALNoData: () => null,
    readRasters: async (read: any) => {
      reads.push(read);
      const outW = read.width ?? 100;
      const outH = read.height ?? 100;
      const values = new Float32Array(outW * outH);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const px = read.window[0] + ((x + 0.5) * (read.window[2] - read.window[0])) / outW;
          values[y * outW + x] = px;
        }
      }
      return [values];
    },
  };
}

function fakeCogSource(broken = false) {
  const image = fakeCogImage();
  if (broken) image.readRasters = async () => { throw new Error('network down'); };
  return { image, sourceImagery_: [[image]], getProjection: () => ({ getCode: () => 'EPSG:3857' }) };
}

/** A file the current view does not touch at all. */
function offFileSource() {
  const image = fakeCogImage();
  image.getBoundingBox = () => [5000, 5000, 5100, 5100];
  return { image, sourceImagery_: [[image]], getProjection: () => ({ getCode: () => 'EPSG:3857' }) };
}

/**
 * A file with no overview small enough for the view: 100 000 pixels across a
 * 100 unit extent, so the window alone is far past the readable limit.
 */
function noOverviewSource() {
  const image = fakeCogImage();
  image.getWidth = () => 100000;
  image.getHeight = () => 90000;
  return { image, sourceImagery_: [[image]], getProjection: () => ({ getCode: () => 'EPSG:3857' }) };
}

/** A source whose metadata has not been parsed yet, and can be completed. */
function lateSource() {
  const source: any = { sourceImagery_: [], getProjection: () => ({ getCode: () => 'EPSG:3857' }) };
  source.arrive = () => { source.sourceImagery_ = [[fakeCogImage()]]; };
  return source;
}

function fakeMap() {
  const layers: any[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const view = {
    getResolution: () => 1,
    calculateExtent: () => [10, 10, 60, 55],
    getProjection: () => ({ getCode: () => 'EPSG:3857' }),
  };
  return {
    layers,
    listeners,
    addLayer: (layer: any) => { layers.push(layer); },
    removeLayer: (layer: any) => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    },
    getLayers: () => ({
      getArray: () => layers.slice(),
      clear: () => { layers.length = 0; },
      push: (layer: any) => { layers.push(layer); },
    }),
    on: (type: string, fn: any) => { (listeners[type] ??= []).push(fn); },
    un: (type: string, fn: any) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire: (type: string) => { (listeners[type] || []).slice().forEach((fn) => fn()); },
    getView: () => view,
    getSize: () => [800, 600],
  };
}

function cogLayer(source: any, mode: 'contour' | 'single' = 'contour'): RasterLayer {
  const state = { visible: true, style: null as any };
  const olLayer = {
    state,
    getSource: () => source,
    setVisible: (v: boolean) => { state.visible = v; },
    getVisible: () => state.visible,
    setStyle: (style: any) => { state.style = style; },
    get: () => undefined,
  };
  return {
    id: 'cog-1',
    name: 'ACT DSM',
    type: 'cog',
    url: 'https://example.com/dsm.tif',
    cogSource: 'http',
    cogRender: mode === 'contour'
      ? { mode: 'contour', band: 1, contour: { interval: 20, indexInterval: 40 } }
      : { mode: 'single', band: 1 },
    olLayer,
  } as RasterLayer;
}

function setup(layer: RasterLayer) {
  const map = fakeMap();
  const mapRef = { current: null as any };
  const notices: string[] = [];
  const rasterLayersRef = { current: [layer] };
  const hook = renderHook(
    ({ layers }: { layers: RasterLayer[] }) => useCogContours({
      mapRef,
      rasterLayers: layers,
      vectorLayers: [] as VectorLayerConfig[],
      onNotice: (message) => notices.push(message),
    }),
    { initialProps: { layers: [layer] } },
  );
  mapRef.current = map;
  act(() => { hook.result.current.attach(map as any); });
  return {
    map, hook, notices, rasterLayersRef,
    overlay: () => map.layers.find((l) => l.get('_isCogContourLayer')),
    setLayers: (layers: RasterLayer[]) => act(async () => { hook.rerender({ layers }); }),
    settle: () => waitFor(() => undefined, { timeout: 1500 }),
  };
}

// --- tests ------------------------------------------------------------------

describe('useCogContours', () => {
  test('a Contours layer gets an overlay of traced lines, and the raster hides', async () => {
    const source = fakeCogSource();
    const layer = cogLayer(source);
    const { map, overlay } = setup(layer);

    // The overlay appears at once; its lines arrive with the debounced trace.
    await waitFor(() => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0));
    const lines = overlay();
    expect(lines.getSource()).toBeInstanceOf(VectorSource);
    expect(lines.get('_cogContourParent')).toBe(layer.olLayer);
    // QGIS shows the lines on their own.
    expect(layer.olLayer.state.visible).toBe(false);
    // QGIS' downscaling asked for 800/4 x 600/4 samples, but the buffered view
    // only spans 85 x 80 pixels of this tiny file — never upsample.
    expect(source.image.reads[0]).toMatchObject({ width: 85, height: 80 });
    expect(map.listeners.moveend).toHaveLength(1);
  });

  test('leaving the Contours renderer removes the overlay and shows the raster', async () => {
    const layer = cogLayer(source0());
    const { map, overlay, setLayers } = setup(layer);
    await waitFor(() => expect(overlay()).toBeTruthy());

    const plain = { ...layer, cogRender: { mode: 'single', band: 1 } as RasterLayer['cogRender'] };
    await setLayers([plain]);
    expect(overlay()).toBeUndefined();
    expect(map.layers).not.toContain(layer.olLayer === undefined ? null : undefined);
    expect(layer.olLayer.state.visible).toBe(true);
  });

  test('symbol-only edits restyle in place without re-reading the file', async () => {
    const source = fakeCogSource();
    const layer = cogLayer(source);
    const { overlay, setLayers } = setup(layer);
    await waitFor(() => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0));
    const readsAfterTrace = source.image.reads.length;
    const styleBefore = overlay().style_;

    await setLayers([{
      ...layer,
      cogRender: { mode: 'contour', band: 1, contour: { interval: 20, indexInterval: 40, lineWidth: 4, lineStyle: 'dash' } },
    }]);
    await waitFor(() => expect(overlay().style_).not.toBe(styleBefore));
    expect(source.image.reads.length).toBe(readsAfterTrace);
  });

  test('changing the interval re-traces', async () => {
    const source = fakeCogSource();
    const layer = cogLayer(source);
    const { overlay, setLayers } = setup(layer);
    await waitFor(() => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0));
    const readsAfterTrace = source.image.reads.length;

    await setLayers([{
      ...layer,
      cogRender: { mode: 'contour', band: 1, contour: { interval: 5, indexInterval: 10 } },
    }]);
    await waitFor(() => expect(source.image.reads.length).toBeGreaterThan(readsAfterTrace));
  });

  test('a failed trace keeps the raster visible with a displayable style', async () => {
    const source = fakeCogSource(true);
    const layer = cogLayer(source);
    const { notices, overlay } = setup(layer);

    await waitFor(() => expect(layer.olLayer.state.visible).toBe(true));
    expect(overlay()?.getSource().getFeatures()).toHaveLength(0);
    expect(notices.some((n) => n.includes('could not read elevations'))).toBe(true);
    // The fallback is the suggested renderer, not the black default mapping.
    expect(layer.olLayer.state.style).toBeTruthy();
  });

  test('a settled view inside the traced buffer costs nothing', async () => {
    const source = fakeCogSource();
    const layer = cogLayer(source);
    const { map, overlay } = setup(layer);
    await waitFor(() => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0));
    const readsAfterTrace = source.image.reads.length;

    act(() => { map.fire('moveend'); });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(source.image.reads.length).toBe(readsAfterTrace);
  });

  test('a view off the file clears the lines and says nothing', async () => {
    const source = fakeCogSource();
    const layer = cogLayer(source);
    const { map, overlay, notices } = setup(layer);
    await waitFor(() => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0));

    // Pan somewhere the file does not cover: the lines go, the raster returns,
    // and nothing is reported — being off the edge of a DEM is not an error.
    map.getView().calculateExtent = () => [9000, 9000, 9050, 9045];
    await act(async () => { map.fire('moveend'); });
    await waitFor(() => expect(layer.olLayer.state.visible).toBe(true));
    expect(overlay()?.getSource().getFeatures()).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  test('a file with no overview for this view explains that it needs a closer look', async () => {
    const layer = cogLayer(noOverviewSource());
    const { notices } = setup(layer);
    await waitFor(() => expect(layer.olLayer.state.visible).toBe(true));
    expect(notices.some((n) => /zoom in/i.test(n))).toBe(true);
    expect(notices.some((n) => /overview/i.test(n))).toBe(true);
  });

  test('a source that is still parsing its metadata is retried, not reported', async () => {
    const source = lateSource();
    const layer = cogLayer(source);
    const { overlay, notices } = setup(layer);
    // The file's imagery turns up a moment later (a rebuild, a restore).
    setTimeout(() => { source.arrive(); }, 50);
    await waitFor(
      () => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0),
      { timeout: 3000 },
    );
    expect(layer.olLayer.state.visible).toBe(false);
    expect(notices).toHaveLength(0);
  }, 15000);

  test('a trace that starts working again hides the raster underneath', async () => {
    const source = fakeCogSource(true);
    const layer = cogLayer(source);
    const { hook, overlay } = setup(layer);
    await waitFor(() => expect(layer.olLayer.state.visible).toBe(true));

    // The read starts succeeding (the network came back): the next pass must
    // put the raster back under its lines instead of leaving both on screen.
    source.image.readRasters = fakeCogImage().readRasters;
    await act(async () => { hook.result.current.refresh(true); });
    await waitFor(() => expect(overlay()?.getSource().getFeatures().length).toBeGreaterThan(0));
    expect(layer.olLayer.state.visible).toBe(false);
  });

  test('terrain with no line in it keeps the raster and says why', async () => {
    const source = fakeCogSource();
    // A flat file: every sample the same elevation, so no level crosses it.
    source.image.readRasters = async (read: any) => {
      const outW = read.width ?? 100;
      const outH = read.height ?? 100;
      return [new Float32Array(outW * outH).fill(42)];
    };
    const layer = cogLayer(source);
    const { notices, overlay } = setup(layer);

    await waitFor(() => expect(layer.olLayer.state.visible).toBe(true));
    expect(overlay()?.getSource().getFeatures()).toHaveLength(0);
    expect(notices.some((n) => /no lines in this view/i.test(n))).toBe(true);
  });

  test('a source that never becomes ready says so instead of retrying forever', async () => {
    const layer = cogLayer(lateSource()); // nothing ever arrives
    const { notices } = setup(layer);
    await waitFor(() => expect(notices.some((n) => /still loading/i.test(n))).toBe(true), { timeout: 6000 });
    expect(notices.filter((n) => /still loading/i.test(n))).toHaveLength(1);
    expect(layer.olLayer.state.visible).toBe(true);
  }, 20000);

  test('dispose takes every overlay off the map', async () => {
    const layer = cogLayer(source0());
    const { map, overlay, hook } = setup(layer);
    await waitFor(() => expect(overlay()).toBeTruthy());
    act(() => { hook.result.current.dispose(); });
    expect(overlay()).toBeUndefined();
    expect(map.listeners.moveend).toHaveLength(0);
  });
});

/** A second source instance per test that needs a fresh one. */
function source0() {
  return fakeCogSource();
}
