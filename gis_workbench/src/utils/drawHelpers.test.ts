import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import { Style } from 'ol/style.js';
import { CircleDrawMode, DEFAULT_DRAW_STYLE, DrawStyle } from '../types';
import { geometricCircleRing } from './circleDraw';
import {
  applyDrawFeatureStyle,
  isOtherPolygonFamily,
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
  findNearestVertex,
  findNearestSegment,
  trimSnapshotStack,
  countGeometryVertices,
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

  it('tolerates attribute-only features (null geometry) in snapshots and keys', () => {
    // GeoJSON imports may carry rows without a geometry — the session
    // machinery must neither crash on them nor drop them.
    const withGeom = new Feature({ geometry: new Point([1, 2]), name: 'Alpha' });
    const attrOnly = new Feature({ name: 'NoGeom' }); // no geometry
    const snap = captureDrawSnapshot(new VectorSource({ features: [withGeom, attrOnly] }));
    expect(snap.items).toHaveLength(2);
    expect(snap.items[1].geometry).toBeNull();
    expect(snap.items[1].properties).toEqual({ name: 'NoGeom' });
    expect(() => snapshotKey(snap)).not.toThrow();
    // Attribute edits on the geometry-less row still register as steps.
    const before = snapshotKey(snap);
    attrOnly.set('name', 'NoGeom Prime');
    const after = snapshotKey(captureDrawSnapshot(new VectorSource({ features: [withGeom, attrOnly] })));
    expect(after).not.toBe(before);
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

// --- large-layer-safe vertex/segment hit testing ---------------------------

/** Identity-ish map: one pixel = `res` map units, origin at (0,0). */
const fakeMap = (res = 2): any => ({
  getView: () => ({ getResolution: () => res }),
  getCoordinateFromPixel: (px: number[]) => [px[0] * res, px[1] * res],
  getPixelFromCoordinate: (c: number[]) => [c[0] / res, c[1] / res],
});

describe('findNearestVertex / findNearestSegment (RTree-pruned)', () => {
  const line = new Feature({ geometry: new LineString([[100, 100], [200, 100]]) });
  const source = () => new VectorSource({ features: [line] });

  it('finds a vertex within the pixel tolerance in map units', () => {
    const hit = findNearestVertex(fakeMap(2), source(), [50, 50], 12); // coord (100,100)
    expect(hit).toBeTruthy();
    expect(hit!.coord).toEqual([100, 100]);
    expect(hit!.indexPath).toEqual([0]);
  });

  it('returns null when the pointer is far from any vertex', () => {
    expect(findNearestVertex(fakeMap(2), source(), [500, 500], 12)).toBeNull();
  });

  it('skips attribute-only (null geometry) features', () => {
    const src = new VectorSource({ features: [new Feature({ name: 'x' }), line] });
    expect(findNearestVertex(fakeMap(2), src, [50, 50], 12)).toBeTruthy();
  });

  it('works for sources without a spatial index (fallback extent filter)', () => {
    const plain: any = { getFeatures: () => [line] };
    const hit = findNearestVertex(fakeMap(2), plain, [100, 50], 12); // coord (200,100)
    expect(hit).toBeTruthy();
    expect(hit!.coord).toEqual([200, 100]);
  });

  it('findNearestSegment returns the map-space insertion point', () => {
    const hit = findNearestSegment(fakeMap(2), source(), [75, 52], 12); // centre (150,104)
    expect(hit).toBeTruthy();
    expect(hit!.coord[0]).toBeCloseTo(150, 6);
    expect(hit!.coord[1]).toBeCloseTo(100, 6);
    expect(hit!.ringIndex).toBe(-1);
  });

  it('findNearestSegment ignores segments outside the tolerance box', () => {
    expect(findNearestSegment(fakeMap(2), source(), [75, 200], 12)).toBeNull();
  });
});

describe('countGeometryVertices', () => {
  it('counts across geometry types', () => {
    expect(countGeometryVertices(new Point([0, 0]))).toBe(1);
    expect(countGeometryVertices(new LineString([[0, 0], [1, 1], [2, 2]]))).toBe(3);
    expect(countGeometryVertices(new Polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]))).toBe(4);
    expect(countGeometryVertices(null)).toBe(0);
  });
});

describe('trimSnapshotStack (undo memory budget)', () => {
  const step = (vertexCount: number, tag: string) => ({ snap: { items: [], vertexCount } as any, key: tag });

  it('keeps small draw batches at full depth', () => {
    const stack = Array.from({ length: 5 }, (_, i) => step(10, 's' + i));
    trimSnapshotStack(stack);
    expect(stack).toHaveLength(5);
  });

  it('drops oldest steps of vertex-heavy snapshots beyond the budget', () => {
    const stack = [step(400000, 'a'), step(400000, 'b')];
    trimSnapshotStack(stack);
    expect(stack).toHaveLength(1);
    expect(stack[0].key).toBe('b');
    stack.push(step(400000, 'c'));
    trimSnapshotStack(stack);
    expect(stack).toHaveLength(1);
    expect(stack[0].key).toBe('c');
  });

  it('never empties the stack and still honours HISTORY_LIMIT', () => {
    const stack = Array.from({ length: 101 }, (_, i) => step(1, 's' + i));
    trimSnapshotStack(stack);
    expect(stack).toHaveLength(100);
    expect(stack[99].key).toBe('s100');
  });
});

// --- Circle-tool features ----------------------------------------------------

describe('circle features (drawn by the Circle tool)', () => {
  beforeEach(() => localStorage.clear());

  /** A real circle ring, as utils/circleDraw.ts builds it (128 segments). */
  function circleGeom(): Polygon {
    return new Polygon([geometricCircleRing([150000, -4000000], [250000, -4000000])]);
  }

  function circleFeature(mode: CircleDrawMode): any {
    const f = fakeFeature(circleGeom());
    f._circleMode = mode;
    return f;
  }

  it('carries the area chip only — never one chip per edge', () => {
    const f = circleFeature('geometric');
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    // 1 base style + 1 area chip; a plain 128-vertex polygon would instead be
    // hidden entirely (1 style) and a shown one would carry 129 chips.
    expect(f._styleFn()).toHaveLength(2);

    const plain = fakeFeature(circleGeom());
    applyDrawFeatureStyle(plain, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(plain._styleFn()).toHaveLength(1);
  });

  it('still honours an explicit measurements toggle', () => {
    const f = circleFeature('geodesic');
    applyDrawFeatureStyle(f, { ...DEFAULT_DRAW_STYLE }, metric);
    expect(f._styleFn()).toHaveLength(2);
    setDrawFeatureMeasurementsVisible(f, false, metric);
    expect(f._styleFn()).toHaveLength(1);
  });

  it('round-trips the mode through the persisted draw session', () => {
    const f = new Feature(circleGeom());
    (f as any)._drawFeatureId = 'c1';
    (f as any)._drawName = 'Geodesic Circle 1';
    (f as any)._drawStyle = { ...DEFAULT_DRAW_STYLE };
    (f as any)._circleMode = 'geodesic';

    saveDrawSession({ getFeatures: () => [f] }, 'default');
    const added: any[] = [];
    const items = loadDrawSession({ addFeature: (x: any) => added.push(x) }, 'default', metric);

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Geodesic Circle 1');
    expect((added[0] as any)._circleMode).toBe('geodesic');
    // The restored flag keeps the single-chip readout after a reload
    // (loadDrawSession already styled the feature).
    const styles = (added[0] as any).getStyle()(added[0], 1);
    expect(styles).toHaveLength(2);
  });

  it('is captured in undo/redo snapshots', () => {
    const source = new VectorSource();
    const f = new Feature(circleGeom());
    (f as any)._drawFeatureId = 'c1';
    (f as any)._drawName = 'Circle 1';
    (f as any)._circleMode = 'geometric';
    source.addFeature(f);

    const snap = captureDrawSnapshot(source);
    expect(snap.items[0].circleMode).toBe('geometric');
    // Snapshots of ordinary features stay untouched.
    const plain = new VectorSource();
    const g = new Feature(lineGeom(3));
    (g as any)._drawFeatureId = 'l1';
    plain.addFeature(g);
    expect(captureDrawSnapshot(plain).items[0].circleMode).toBeUndefined();
  });
});

describe('isOtherPolygonFamily', () => {
  it('flags rectangle and circle auto-names, not generic polygons', () => {
    expect(isOtherPolygonFamily('Rectangle 1')).toBe(true);
    expect(isOtherPolygonFamily('Circle 2')).toBe(true);
    expect(isOtherPolygonFamily('Geodesic Circle 1')).toBe(true);
    expect(isOtherPolygonFamily('Polygon 3')).toBe(false);
    expect(isOtherPolygonFamily('Site A')).toBe(false);
    expect(isOtherPolygonFamily('')).toBe(false);
  });
});
