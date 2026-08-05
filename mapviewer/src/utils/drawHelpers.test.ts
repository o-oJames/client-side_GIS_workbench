import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import { DEFAULT_DRAW_STYLE, DrawStyle } from '../types';
import {
  applyDrawFeatureStyle,
  setDrawFeatureMeasurementsVisible,
  saveDrawSession,
  loadDrawSession,
} from './drawHelpers';

const metric = () => 'metric' as const;

/** Horizontal line with `n` vertices, 100 map-units apart. */
function lineGeom(n: number): LineString {
  return new LineString(Array.from({ length: n }, (_, i) => [150000 + i * 100, -4000000]));
}

/** Fake OL feature capturing the style function set on it. */
function fakeFeature(geom: any): any {
  const f: any = {
    getGeometry: () => geom,
    get: () => undefined, // no labelText
    setStyle: (fn: any) => { f._styleFn = fn; },
  };
  return f;
}

// --- Measurement gating in the per-feature style function --------------------

describe('applyDrawFeatureStyle measurement gating', () => {
  it('adds one chip per segment for a simple line (default visible)', () => {
    const f = fakeFeature(lineGeom(3));
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    const styles = f._styleFn();
    // 1 base style + 2 segment chips.
    expect(styles).toHaveLength(3);
  });

  it('omits chips when the feature is above the vertex threshold', () => {
    const f = fakeFeature(lineGeom(40));
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(f._styleFn()).toHaveLength(1);
  });

  it('honours an explicit _showMeasurements override', () => {
    const dense = fakeFeature(lineGeom(40));
    dense._showMeasurements = true;
    applyDrawFeatureStyle(dense, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(dense._styleFn()).toHaveLength(1 + 39);

    const simple = fakeFeature(lineGeom(3));
    simple._showMeasurements = false;
    applyDrawFeatureStyle(simple, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(simple._styleFn()).toHaveLength(1);
  });

  it('re-evaluates visibility as the geometry changes (auto mode)', () => {
    // Mutable holder so the same fake feature can "grow" vertices.
    let geom: any = lineGeom(3);
    const f: any = {
      getGeometry: () => geom,
      get: () => undefined,
      setStyle: (fn: any) => { f._styleFn = fn; },
    };
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(f._styleFn()).toHaveLength(3); // visible at 3 vertices
    geom = lineGeom(35);
    expect(f._styleFn()).toHaveLength(1); // auto-hidden past the threshold
  });
});

describe('setDrawFeatureMeasurementsVisible', () => {
  it('stores the choice on the feature and restyles it immediately', () => {
    const f = fakeFeature(lineGeom(50));
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(f._styleFn()).toHaveLength(1); // auto-hidden

    setDrawFeatureMeasurementsVisible(f, true, metric);
    expect(f._showMeasurements).toBe(true);
    expect(f._styleFn()).toHaveLength(1 + 49); // user turned labels on

    setDrawFeatureMeasurementsVisible(f, false, metric);
    expect(f._showMeasurements).toBe(false);
    expect(f._styleFn()).toHaveLength(1);
  });

  it('keeps the feature style object when restyling', () => {
    const ds: DrawStyle = { ...DEFAULT_DRAW_STYLE, lineColor: 'rgba(1, 2, 3, 1)' };
    const f = fakeFeature(lineGeom(4));
    applyDrawFeatureStyle(f, ds, metric);
    setDrawFeatureMeasurementsVisible(f, false, metric);
    expect(f._drawStyle.lineColor).toBe('rgba(1, 2, 3, 1)');
  });
});

// --- Session persistence round-trip ------------------------------------------

describe('draw session persistence of the measurements flag', () => {
  beforeEach(() => localStorage.clear());

  function makeSessionFeature(id: string, vertices: number, showMeasurements?: boolean): any {
    const f = new Feature(lineGeom(vertices));
    (f as any)._drawFeatureId = id;
    (f as any)._drawName = 'Line ' + id;
    (f as any)._drawStyle = { ...DEFAULT_DRAW_STYLE };
    if (showMeasurements !== undefined) (f as any)._showMeasurements = showMeasurements;
    return f;
  }

  it('round-trips an explicit choice and leaves auto features untouched', () => {
    const dense = makeSessionFeature('a1', 40, true); // dense but user forced labels on
    const auto = makeSessionFeature('b2', 3); // simple, default visibility

    saveDrawSession({ getFeatures: () => [dense, auto] }, 'default');
    const added: any[] = [];
    const items = loadDrawSession({ addFeature: (f: any) => added.push(f) }, 'default', metric);

    expect(items).toHaveLength(2);
    expect((added[0] as any)._showMeasurements).toBe(true);
    expect((added[1] as any)._showMeasurements).toBeUndefined();
    // The restored explicit choice drives the style function:
    expect(items[0].style).toEqual({ ...DEFAULT_DRAW_STYLE });
  });

  it('persists an explicit off on a simple feature', () => {
    const f = makeSessionFeature('c3', 3, false);
    saveDrawSession({ getFeatures: () => [f] }, 'default');
    const added: any[] = [];
    loadDrawSession({ addFeature: (feat: any) => added.push(feat) }, 'default', metric);
    expect((added[0] as any)._showMeasurements).toBe(false);
  });
});
