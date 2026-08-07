import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import { Style } from 'ol/style.js';
import { DEFAULT_DRAW_STYLE, DrawStyle } from '../types';
import {
  applyDrawFeatureStyle,
  setDrawFeatureMeasurementsVisible,
  setFeatureNameLabelVisible,
  shouldShowFeatureNameLabel,
  buildFeatureNameLabelStyle,
  getFeatureNameLabelAnchor,
  captureDrawSnapshot,
  captureFeatureProperties,
  snapshotKey,
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

  function makeSessionFeature(id: string, vertices: number, showMeasurements?: boolean, extra?: { showNameLabel?: boolean; nameCustomized?: boolean }): any {
    const f = new Feature(lineGeom(vertices));
    (f as any)._drawFeatureId = id;
    (f as any)._drawName = 'Line ' + id;
    (f as any)._drawStyle = { ...DEFAULT_DRAW_STYLE };
    if (showMeasurements !== undefined) (f as any)._showMeasurements = showMeasurements;
    if (extra && extra.showNameLabel !== undefined) (f as any)._showNameLabel = extra.showNameLabel;
    if (extra && extra.nameCustomized !== undefined) (f as any)._drawNameCustomized = extra.nameCustomized;
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

  it('round-trips the name-label flag and the user-rename marker', () => {
    const labelled = makeSessionFeature('d4', 3, undefined, { showNameLabel: true, nameCustomized: true });
    const plain = makeSessionFeature('e5', 3);

    saveDrawSession({ getFeatures: () => [labelled, plain] }, 'default');
    const added: any[] = [];
    loadDrawSession({ addFeature: (feat: any) => added.push(feat) }, 'default', metric);

    expect((added[0] as any)._showNameLabel).toBe(true);
    expect((added[0] as any)._drawNameCustomized).toBe(true);
    expect((added[1] as any)._showNameLabel).toBeUndefined();
    expect((added[1] as any)._drawNameCustomized).toBeUndefined();
  });
});


// --- Feature name labels ------------------------------------------------------

/** Square polygon centred on (150000, -4000000), side 200 map units. */
function squareGeom(): Polygon {
  return new Polygon([[
    [149900, -4000100],
    [150100, -4000100],
    [150100, -3999900],
    [149900, -3999900],
    [149900, -4000100],
  ]]);
}

describe('name-label anchoring', () => {
  it('anchors polygons at their interior point, above the area chip', () => {
    const spot = getFeatureNameLabelAnchor(squareGeom());
    expect(spot).not.toBeNull();
    expect(spot!.anchor.getType()).toBe('Point');
    expect(spot!.offsetY).toBe(-18);
    // The interior point of this square is its centre.
    const [x, y] = spot!.anchor.getCoordinates();
    expect(x).toBeCloseTo(150000, 0);
    expect(y).toBeCloseTo(-4000000, 0);
  });

  it('anchors lines at their midpoint, below the segment chips', () => {
    const spot = getFeatureNameLabelAnchor(lineGeom(3));
    expect(spot).not.toBeNull();
    expect(spot!.offsetY).toBe(14);
    expect(spot!.anchor.getCoordinates()).toEqual([150100, -4000000]);
  });

  it('has no anchor for points (their label text is the caption)', () => {
    expect(getFeatureNameLabelAnchor(new Point([150000, -4000000]))).toBeNull();
  });

  it('builds a text style carrying the name, or null without one', () => {
    const style = buildFeatureNameLabelStyle(squareGeom(), 'My shed', { ...DEFAULT_DRAW_STYLE });
    expect(style).not.toBeNull();
    expect(style!.getText()!.getText()).toBe('My shed');
    expect(buildFeatureNameLabelStyle(squareGeom(), '', { ...DEFAULT_DRAW_STYLE })).toBeNull();
    expect(buildFeatureNameLabelStyle(new Point([0, 0]), 'X', { ...DEFAULT_DRAW_STYLE })).toBeNull();
  });
});

describe('shouldShowFeatureNameLabel defaults', () => {
  it('is off for ordinary drawn features, on for snap polygons', () => {
    expect(shouldShowFeatureNameLabel(fakeFeature(lineGeom(3)))).toBe(false);
    const snap = fakeFeature(squareGeom());
    snap._snapClass = 'building';
    expect(shouldShowFeatureNameLabel(snap)).toBe(true);
  });

  it('honours an explicit _showNameLabel override', () => {
    const on = fakeFeature(lineGeom(3));
    on._showNameLabel = true;
    expect(shouldShowFeatureNameLabel(on)).toBe(true);
    const off = fakeFeature(squareGeom());
    off._snapClass = 'building';
    off._showNameLabel = false;
    expect(shouldShowFeatureNameLabel(off)).toBe(false);
  });
});

describe('applyDrawFeatureStyle name-label gating', () => {
  it('adds a name label only when the flag is on', () => {
    const f = fakeFeature(lineGeom(3));
    f._drawName = 'Fence line';
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    // Base + 2 segment chips, no name label by default.
    expect(f._styleFn()).toHaveLength(3);

    f._showNameLabel = true;
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    const styles = f._styleFn();
    expect(styles).toHaveLength(4);
    const nameStyles = styles.filter((st: any) => st.getText() && st.getText().getText() === 'Fence line');
    expect(nameStyles).toHaveLength(1);
  });

  it('snap polygons render their name through labelText and never twice', () => {
    const snap: any = {
      getGeometry: () => squareGeom(),
      get: (k: string) => (k === 'labelText' ? 'Building 1' : undefined),
      setStyle: (fn: any) => { snap._styleFn = fn; },
      _snapClass: 'building',
      _drawName: 'Building 1',
    };
    applyDrawFeatureStyle(snap, { ...DEFAULT_DRAW_STYLE }, metric);
    const defaultStyles = snap._styleFn();
    // The base style carries the labelText caption.
    expect(defaultStyles[0].getText().getText()).toBe('Building 1');
    // No extra name-label style is stacked on top.
    expect(defaultStyles.filter((st: any) => st.getText && st.getText() && st.getText().getText() === 'Building 1')).toHaveLength(1);

    // Toggling the name label off suppresses the auto caption.
    snap._showNameLabel = false;
    applyDrawFeatureStyle(snap, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(snap._styleFn()[0].getText()).toBeFalsy();
  });

  it('skips the name label for features that already carry a labelText', () => {
    const labelled: any = {
      getGeometry: () => squareGeom(),
      get: (k: string) => (k === 'labelText' ? 'Some caption' : undefined),
      setStyle: (fn: any) => { labelled._styleFn = fn; },
      _showNameLabel: true,
      _drawName: 'Polygon 1',
    };
    applyDrawFeatureStyle(labelled, { ...DEFAULT_DRAW_STYLE }, metric);
    const texts = labelled._styleFn()
      .map((st: any) => (st.getText && st.getText() ? st.getText().getText() : null))
      .filter(Boolean);
    // The caption renders, but no second style carries the feature's name.
    expect(texts).toContain('Some caption');
    expect(texts).not.toContain('Polygon 1');
  });
});

describe('setFeatureNameLabelVisible', () => {
  it('stores the choice on the feature and restyles it immediately', () => {
    const f = fakeFeature(lineGeom(3));
    f._drawName = 'Line 1';
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(f._styleFn()).toHaveLength(3);

    setFeatureNameLabelVisible(f, true, metric);
    expect(f._showNameLabel).toBe(true);
    expect(f._styleFn()).toHaveLength(4);

    setFeatureNameLabelVisible(f, false, metric);
    expect(f._showNameLabel).toBe(false);
    expect(f._styleFn()).toHaveLength(3);
  });
});

describe('undo snapshots carry the name-label flags', () => {
  it('captures showNameLabel and nameCustomized, and keys differ with the flag', () => {
    const f = new Feature(lineGeom(3));
    (f as any)._drawFeatureId = 'x1';
    (f as any)._drawName = 'Line 1';
    (f as any)._drawStyle = { ...DEFAULT_DRAW_STYLE };
    (f as any)._showNameLabel = true;
    (f as any)._drawNameCustomized = true;
    const source = { getFeatures: () => [f] };

    const snap = captureDrawSnapshot(source);
    expect(snap.items[0].showNameLabel).toBe(true);
    expect(snap.items[0].nameCustomized).toBe(true);

    const keyWith = snapshotKey(snap);
    (f as any)._showNameLabel = false;
    const keyWithout = snapshotKey(captureDrawSnapshot(source));
    expect(keyWith).not.toEqual(keyWithout);
  });
});


// --- Attribute capture in undo/redo snapshots (file-imported layers) ---------
// Layers imported from GeoJSON/KML/Shapefile carry real data attributes on
// their features. Geometry re-editing shares the draw session's undo/redo
// history, so snapshots must carry those attributes — an undo must never
// wipe them.

describe('captureFeatureProperties', () => {
  it('captures data attributes, skipping geometry and labelText', () => {
    const f = new Feature({ geometry: new Point([0, 0]), name: 'Alpha', pop: 5 });
    f.set('labelText', 'chip text');
    (f as any)._drawStyle = { lineWidth: 9 }; // underscore keys are not OL properties
    expect(captureFeatureProperties(f)).toEqual({ name: 'Alpha', pop: 5 });
  });

  it('returns undefined for features without attributes', () => {
    expect(captureFeatureProperties(new Feature(new Point([0, 0])))).toBeUndefined();
    expect(captureFeatureProperties(null)).toBeUndefined();
    expect(captureFeatureProperties({})).toBeUndefined();
  });
});

describe('captureDrawSnapshot of attributed (file-imported) features', () => {
  const attributedSource = () => {
    const a = new Feature({ geometry: new Point([100, 200]), name: 'Alpha', pop: 5 });
    a.setId('fid-1');
    const b = new Feature({ geometry: new Point([300, 400]), name: 'Beta', pop: 1 });
    return new VectorSource({ features: [a, b] });
  };

  it('preserves attributes and OL feature ids', () => {
    const snap = captureDrawSnapshot(attributedSource());
    expect(snap.items).toHaveLength(2);
    expect(snap.items[0].properties).toEqual({ name: 'Alpha', pop: 5 });
    expect(snap.items[0].featureId).toBe('fid-1');
    expect(snap.items[1].properties).toEqual({ name: 'Beta', pop: 1 });
    expect(snap.items[1].featureId).toBeUndefined();
  });

  it('keeps drawn-batch snapshots attribute-free', () => {
    const plain = new Feature(new Point([0, 0]));
    const snap = captureDrawSnapshot(new VectorSource({ features: [plain] }));
    expect(snap.items[0].properties).toBeUndefined();
  });

  it('snapshotKey distinguishes attribute edits from geometry-only steps', () => {
    const source = attributedSource();
    const before = snapshotKey(captureDrawSnapshot(source));
    (source.getFeatures()[0] as Feature).set('name', 'Alpha Prime');
    const after = snapshotKey(captureDrawSnapshot(source));
    expect(after).not.toBe(before);
  });

  it('snapshotKey ignores attribute-less features exactly as before', () => {
    const f = new Feature(new Point([7, 8]));
    const key = snapshotKey(captureDrawSnapshot(new VectorSource({ features: [f] })));
    expect(key).toContain('"properties":null');
  });
});


describe('snapshot style handling for file-imported features', () => {
  it('leaves the draw style undefined and captures the feature\'s own style', () => {
    const f = new Feature(new Point([0, 0]));
    const ownStyle = new Style();
    f.setStyle(ownStyle); // e.g. a KML-extracted style
    const snap = captureDrawSnapshot(new VectorSource({ features: [f] }));
    expect(snap.items[0].style).toBeUndefined();
    expect(snap.items[0].featureStyle).toBe(ownStyle);
  });

  it('draw-styled features capture the draw style and no foreign style', () => {
    const f = new Feature(new Point([0, 0]));
    (f as any)._drawStyle = { ...DEFAULT_DRAW_STYLE };
    f.setStyle(() => undefined);
    const snap = captureDrawSnapshot(new VectorSource({ features: [f] }));
    expect(snap.items[0].style).toEqual(DEFAULT_DRAW_STYLE);
    expect(snap.items[0].featureStyle).toBeUndefined();
  });

  it('unstyled file features capture neither', () => {
    const f = new Feature(new Point([0, 0]));
    const snap = captureDrawSnapshot(new VectorSource({ features: [f] }));
    expect(snap.items[0].style).toBeUndefined();
    expect(snap.items[0].featureStyle).toBeUndefined();
  });
});
