import {
  buildSnapPrimaryName,
  classifySnapPolygon,
  composeSnapName,
  SNAP_CLASS_LABELS,
} from './autoName';

describe('classifySnapPolygon', () => {
  const square = (size: number): number[][][] =>
    [[[0, 0], [size, 0], [size, size], [0, size]]];

  it('classifies a small rectangular footprint as a building', () => {
    // 20×15 m-ish rectangle: rectangularity 1, area well under the cap.
    expect(classifySnapPolygon(square(20), 300)).toBe('building');
  });

  it('classifies a long thin strip as a road', () => {
    // 200×10 strip: aspect 20.
    const strip = [[[0, 0], [200, 0], [200, 10], [0, 10]]];
    expect(classifySnapPolygon([strip[0]], 2000)).toBe('road');
  });

  it('classifies a large blob as an area', () => {
    expect(classifySnapPolygon(square(500), 250000)).toBe('area');
  });

  it('classifies an irregular sprawling shape as an area', () => {
    // Star-like ring: low rectangularity despite a small area.
    const star = [[0, 10], [8, 8], [10, 0], [12, 8], [20, 10], [12, 12], [10, 20], [8, 12]];
    expect(classifySnapPolygon([star], 80)).toBe('area');
  });

  it('falls back to area for degenerate input', () => {
    expect(classifySnapPolygon([], 100)).toBe('area');
    expect(classifySnapPolygon([[[0, 0], [1, 0]]], 100)).toBe('area');
  });
});

describe('buildSnapPrimaryName', () => {
  it('prefers a vector feature attribute when present', () => {
    const primary = buildSnapPrimaryName({
      geometryClass: 'building',
      index: 1,
      layerName: 'Ortho 2024',
      vectorFeatureName: '  Adelaide Hospital  ',
    });
    expect(primary).toBe('Adelaide Hospital');
  });

  it('builds class + index names with optional layer context', () => {
    expect(buildSnapPrimaryName({ geometryClass: 'building', index: 2 }))
      .toBe('Building 2');
    expect(buildSnapPrimaryName({ geometryClass: 'road', index: 1, layerName: 'Ortho 2024' }))
      .toBe('Road 1 (Ortho 2024)');
    expect(buildSnapPrimaryName({ geometryClass: 'area', index: 3, layerName: '   ' }))
      .toBe('Area 3');
  });

  it('exposes a label for every class', () => {
    expect(SNAP_CLASS_LABELS.building).toBe('Building');
    expect(SNAP_CLASS_LABELS.road).toBe('Road');
    expect(SNAP_CLASS_LABELS.area).toBe('Area');
  });
});

describe('composeSnapName', () => {
  it('appends the formatted geodesic area', () => {
    expect(composeSnapName('Building 1', 245.321, 'metric')).toBe('Building 1 \u2014 245.32 m\u00b2');
    expect(composeSnapName('Road 2', 2_500_000, 'metric')).toBe('Road 2 \u2014 2.50 km\u00b2');
    expect(composeSnapName('Area 1', 100, 'imperial')).toBe('Area 1 \u2014 1,076.39 ft\u00b2');
  });
});
