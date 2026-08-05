/**
 * Tests for the map-capture helpers (utils/mapExport.ts).
 *
 * jsdom has neither a canvas 2D implementation nor a real OpenLayers render
 * loop, so the map is faked: a viewport div holding per-layer canvases, a
 * `renderSync` that mirrors the compositor's DOM (visible layer → canvas
 * attached, hidden layer → canvas removed) and a `rendercomplete` event that
 * can be delayed to emulate tiles still loading after a pan/zoom.
 */
import OLMap from 'ol/Map.js';
import { captureMapCanvas, canvasToPngBlob, isTaintedCanvasError } from './mapExport';

/* ------------------------------------------------------------------ */
/* Fakes                                                              */
/* ------------------------------------------------------------------ */

/** Minimal 2D-context stub recording what captureMapCanvas composites. */
function makeFakeCtx() {
  const drawImageSources: unknown[] = [];
  const ctx = {
    drawImageSources,
    drawImage: (source: unknown) => {
      drawImageSources.push(source);
    },
    setTransform: () => undefined,
    fillRect: () => undefined,
    globalAlpha: 1,
    fillStyle: '',
    filter: '',
  };
  return ctx as unknown as CanvasRenderingContext2D & { drawImageSources: unknown[] };
}

interface FakeLayer {
  flags: Record<string, boolean>;
  visible: boolean;
  get: (key: string) => unknown;
  getVisible: () => boolean;
  setVisible: (visible: boolean) => void;
}

function makeLayer(
  name: string,
  timeline: string[],
  flags: Record<string, boolean> = {},
  initiallyVisible = true,
): FakeLayer {
  const layer: FakeLayer = {
    flags,
    visible: initiallyVisible,
    get: (key) => layer.flags[key],
    getVisible: () => layer.visible,
    setVisible: (visible) => {
      layer.visible = visible;
      timeline.push(`${visible ? 'show' : 'hide'}:${name}`);
    },
  };
  return layer;
}

function makeLayerCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'ol-layer';
  canvas.width = 100;
  canvas.height = 50;
  return canvas;
}

interface MapEntry {
  layer: FakeLayer;
  canvas: HTMLCanvasElement;
}

/**
 * Fake OL map. `completeDelayMs > 0` emulates a fresh view whose tiles are
 * still loading: `rendercomplete` only fires after the delay, like the real
 * map's tile-queue-driven rendercomplete.
 */
function makeFakeMap(options: {
  size?: [number, number];
  entries?: MapEntry[];
  completeDelayMs?: number;
  timeline?: string[];
}) {
  const size = options.size ?? [800, 600];
  const entries = options.entries ?? [];
  const timeline = options.timeline ?? [];
  const viewport = document.createElement('div');
  let rendercompleteHandler: (() => void) | null = null;
  let completionScheduled = false;

  /** Mirror of the composite renderer: hidden layers leave the DOM. */
  const syncDom = () => {
    entries.forEach(({ layer, canvas }) => {
      const attached = canvas.parentNode === viewport;
      if (layer.getVisible() && !attached) viewport.appendChild(canvas);
      if (!layer.getVisible() && attached) viewport.removeChild(canvas);
    });
  };

  const map = {
    timeline,
    getSize: () => size,
    getViewport: () => viewport,
    getLayers: () => ({ getArray: () => entries.map((entry) => entry.layer) }),
    once: (type: string, handler: () => void) => {
      if (type === 'rendercomplete') rendercompleteHandler = handler;
    },
    renderSync: () => {
      timeline.push('renderSync');
      syncDom();
      if (completionScheduled) return;
      completionScheduled = true;
      const fire = () => {
        timeline.push('rendercomplete');
        const handler = rendercompleteHandler;
        rendercompleteHandler = null;
        if (handler) handler();
      };
      const delay = options.completeDelayMs ?? 0;
      if (delay <= 0) fire();
      else setTimeout(fire, delay);
    },
    render: () => {
      timeline.push('render');
      syncDom();
    },
  };
  return map;
}

/* ------------------------------------------------------------------ */
/* Setup                                                              */
/* ------------------------------------------------------------------ */

let ctxSpy: ReturnType<typeof makeFakeCtx>;

beforeEach(() => {
  ctxSpy = makeFakeCtx();
  jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => ctxSpy as unknown as RenderingContext);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* captureMapCanvas                                                   */
/* ------------------------------------------------------------------ */

describe('captureMapCanvas', () => {
  it('keeps excluded layers visible while waiting for tiles to finish loading', async () => {
    const timeline: string[] = [];
    const drawLayer = makeLayer('draw', timeline, { _isDrawLayer: true });
    const baseLayer = makeLayer('base', timeline);
    const drawCanvas = makeLayerCanvas();
    const baseCanvas = makeLayerCanvas();
    const map = makeFakeMap({
      entries: [
        { layer: baseLayer, canvas: baseCanvas },
        { layer: drawLayer, canvas: drawCanvas },
      ],
      completeDelayMs: 25,
      timeline,
    });

    const promise = captureMapCanvas(map as unknown as OLMap, (layer: FakeLayer) =>
      Boolean(layer.get('_isDrawLayer')),
    );

    // While the "tiles" are still loading nothing is hidden and nothing is
    // composited yet — drawn features must stay on screen.
    expect(timeline).toEqual(['renderSync']);
    expect(drawLayer.getVisible()).toBe(true);
    expect(ctxSpy.drawImageSources).toHaveLength(0);

    await promise;

    // Hidden only inside the synchronous capture step, restored right after.
    expect(timeline).toEqual([
      'renderSync',
      'rendercomplete',
      'hide:draw',
      'renderSync',
      'show:draw',
      'render',
    ]);
    expect(drawLayer.getVisible()).toBe(true);
    // The hidden layer's canvas stayed out of the composite.
    expect(ctxSpy.drawImageSources).toEqual([baseCanvas]);
  });

  it('composites every layer when no exclusion predicate is given', async () => {
    const timeline: string[] = [];
    const layerA = makeLayer('a', timeline);
    const layerB = makeLayer('b', timeline);
    const canvasA = makeLayerCanvas();
    const canvasB = makeLayerCanvas();
    const map = makeFakeMap({
      entries: [
        { layer: layerA, canvas: canvasA },
        { layer: layerB, canvas: canvasB },
      ],
      timeline,
    });

    const canvas = await captureMapCanvas(map as unknown as OLMap);

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(ctxSpy.drawImageSources).toEqual([canvasA, canvasB]);
    expect(layerA.getVisible()).toBe(true);
    expect(layerB.getVisible()).toBe(true);
    expect(timeline.filter((e) => e.startsWith('hide') || e.startsWith('show'))).toHaveLength(0);
  });

  it('leaves already-hidden excluded layers hidden', async () => {
    const timeline: string[] = [];
    const drawLayer = makeLayer('draw', timeline, { _isDrawLayer: true }, false);
    const baseLayer = makeLayer('base', timeline);
    const drawCanvas = makeLayerCanvas();
    const baseCanvas = makeLayerCanvas();
    const map = makeFakeMap({
      entries: [
        { layer: baseLayer, canvas: baseCanvas },
        { layer: drawLayer, canvas: drawCanvas },
      ],
      timeline,
    });

    await captureMapCanvas(map as unknown as OLMap, (layer: FakeLayer) =>
      Boolean(layer.get('_isDrawLayer')),
    );

    // Never toggled: it was hidden before and stays hidden afterwards.
    expect(drawLayer.getVisible()).toBe(false);
    expect(timeline.filter((e) => e.includes('draw'))).toHaveLength(0);
    expect(ctxSpy.drawImageSources).toEqual([baseCanvas]);
  });

  it('rejects when the map has no rendered size', async () => {
    const map = makeFakeMap({ size: [0, 0], entries: [] });
    await expect(captureMapCanvas(map as unknown as OLMap)).rejects.toThrow(
      'Map has no rendered size',
    );
  });
});

/* ------------------------------------------------------------------ */
/* canvasToPngBlob                                                    */
/* ------------------------------------------------------------------ */

describe('canvasToPngBlob', () => {
  it('resolves the blob produced by canvas.toBlob', async () => {
    const canvas = document.createElement('canvas');
    const blob = new Blob(['x'], { type: 'image/png' });
    (canvas as HTMLCanvasElement & { toBlob: (cb: (b: Blob | null) => void) => void }).toBlob = (cb) =>
      cb(blob);
    await expect(canvasToPngBlob(canvas)).resolves.toBe(blob);
  });

  it('rejects when toBlob yields no blob', async () => {
    const canvas = document.createElement('canvas');
    (canvas as HTMLCanvasElement & { toBlob: (cb: (b: Blob | null) => void) => void }).toBlob = (cb) =>
      cb(null);
    await expect(canvasToPngBlob(canvas)).rejects.toThrow('Could not encode the map image');
  });
});

/* ------------------------------------------------------------------ */
/* isTaintedCanvasError                                               */
/* ------------------------------------------------------------------ */

describe('isTaintedCanvasError', () => {
  it('detects SecurityError and tainted-canvas messages', () => {
    expect(isTaintedCanvasError(Object.assign(new Error('blocked'), { name: 'SecurityError' }))).toBe(true);
    expect(isTaintedCanvasError(new Error('The canvas has been tainted by cross-origin data'))).toBe(true);
    expect(isTaintedCanvasError(new Error('tainted canvas'))).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isTaintedCanvasError(new Error('boom'))).toBe(false);
    expect(isTaintedCanvasError(null)).toBe(false);
    expect(isTaintedCanvasError('SecurityError')).toBe(false);
  });
});
