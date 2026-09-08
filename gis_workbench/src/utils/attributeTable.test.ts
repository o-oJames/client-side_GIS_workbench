/**
 * Attribute-table pure logic: attribute extraction, column discovery,
 * sorting, statistics, CSV serialisation, row virtualisation and the
 * desktop-window geometry helpers.
 */
import {
  getFeatureAttributes,
  collectColumns,
  compareAttrValues,
  sortFeatures,
  computeFieldStats,
  numericColumns,
  asNumericValue,
  csvEscape,
  featuresToCsv,
  virtualRowRange,
  clampWindowRect,
  defaultWindowRect,
  loadAttrTableGeometry,
  saveAttrTableGeometry,
  ATTR_TABLE_GEOMETRY_KEY,
  ATTR_TABLE_MIN_W,
  ATTR_TABLE_MIN_H,
} from './attributeTable';

/** Minimal feature double: only the property bag the table reads. */
function fakeFeature(props: Record<string, any>): any {
  const geomLike = { getType: () => 'Point' };
  return { getProperties: () => ({ geometry: geomLike, ...props }) };
}

describe('getFeatureAttributes', () => {
  it('strips the geometry and cluster member keys', () => {
    const f = fakeFeature({ name: 'a', members: [1, 2] });
    f.getProperties = () => ({
      geometry: { getType: () => 'Point' },
      features: [fakeFeature({})],
      name: 'a',
      members: [1, 2],
    });
    const attrs = getFeatureAttributes(f);
    expect(attrs).toEqual({ name: 'a', members: [1, 2] });
    expect(attrs.features).toBeUndefined();
    expect(attrs.geometry).toBeUndefined();
  });

  it('tolerates non-features', () => {
    expect(getFeatureAttributes(null)).toEqual({});
    expect(getFeatureAttributes({})).toEqual({});
  });
});

describe('collectColumns', () => {
  it('unions keys in first-appearance order', () => {
    const cols = collectColumns([
      fakeFeature({ a: 1, b: 2 }),
      fakeFeature({ b: 3, c: 4 }),
      fakeFeature({ a: 5, d: 6 }),
    ]);
    expect(cols).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('compareAttrValues', () => {
  it('sorts missing values last regardless of value', () => {
    expect(compareAttrValues(null, 1)).toBe(1);
    expect(compareAttrValues(1, null)).toBe(-1);
    expect(compareAttrValues('', undefined)).toBe(0);
  });

  it('compares numbers and numeric strings numerically', () => {
    expect(compareAttrValues(2, 10)).toBe(-1);
    expect(compareAttrValues('9', '10')).toBe(-1); // string compare would say otherwise
    expect(compareAttrValues(7, '7')).toBe(0);
  });

  it('orders booleans false before true and compares other strings', () => {
    expect(compareAttrValues(false, true)).toBe(-1);
    expect(compareAttrValues(true, false)).toBe(1);
    expect(compareAttrValues('apple', 'banana')).toBe(-1);
  });
});

describe('sortFeatures', () => {
  const feats = [
    fakeFeature({ town: 'B', pop: 5 }),
    fakeFeature({ town: 'A', pop: 9 }),
    fakeFeature({ town: 'A', pop: 2 }),
  ];

  it('sorts ascending and descending on one field', () => {
    expect(sortFeatures(feats, [{ field: 'pop', dir: 'asc' }]).map(f => getFeatureAttributes(f).pop))
      .toEqual([2, 5, 9]);
    expect(sortFeatures(feats, [{ field: 'pop', dir: 'desc' }]).map(f => getFeatureAttributes(f).pop))
      .toEqual([9, 5, 2]);
  });

  it('combines multiple sort clauses and stays stable on ties', () => {
    const sorted = sortFeatures(feats, [
      { field: 'town', dir: 'asc' },
      { field: 'pop', dir: 'desc' },
    ]);
    expect(sorted.map(f => getFeatureAttributes(f).pop)).toEqual([9, 2, 5]);
  });

  it('does not mutate the input and copies when unsorted', () => {
    const out = sortFeatures(feats, []);
    expect(out).not.toBe(feats);
    expect(out).toEqual(feats);
  });
});

describe('computeFieldStats', () => {
  const feats = [
    fakeFeature({ v: 1 }),
    fakeFeature({ v: 2 }),
    fakeFeature({ v: 3 }),
    fakeFeature({ v: 10 }),
    fakeFeature({ v: null }),
  ];

  it('computes count, min/max, mean, stddev and nulls', () => {
    const st = computeFieldStats(feats, 'v');
    expect(st.count).toBe(4);
    expect(st.nulls).toBe(1);
    expect(st.min).toBe(1);
    expect(st.max).toBe(10);
    expect(st.mean).toBe(4);
    expect(st.stddev).toBeCloseTo(Math.sqrt((9 + 4 + 1 + 36) / 4 - 0), 5);
    expect(st.histogram).toHaveLength(10);
    expect(st.histogram.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('reports zeros for a field with no numeric values', () => {
    const st = computeFieldStats([fakeFeature({ v: 'x' })], 'v');
    expect(st.count).toBe(0);
    expect(st.histogram).toEqual([]);
  });
});

describe('numericColumns / asNumericValue', () => {
  it('keeps only fields with at least one usable number', () => {
    const feats = [fakeFeature({ n: 1, s: 'x', ns: '12' })];
    expect(numericColumns(feats, ['n', 's', 'ns'])).toEqual(['n', 'ns']);
  });

  it('rejects booleans, blanks and NaN', () => {
    expect(asNumericValue(true)).toBeNull();
    expect(asNumericValue('  ')).toBeNull();
    expect(asNumericValue('abc')).toBeNull();
    expect(asNumericValue(NaN)).toBeNull();
    expect(asNumericValue('3.5')).toBe(3.5);
  });
});

describe('CSV export', () => {
  it('escapes quotes, commas and newlines per RFC 4180', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(42)).toBe('42');
  });

  it('writes a header row plus one row per feature', () => {
    const csv = featuresToCsv(
      [fakeFeature({ name: 'A,1', pop: 5 }), fakeFeature({ name: 'B', pop: null })],
      ['name', 'pop']
    );
    expect(csv).toBe('name,pop\r\n"A,1",5\r\nB,');
  });
});

describe('virtualRowRange', () => {
  it('covers the visible band plus overscan', () => {
    const r = virtualRowRange(300, 150, 30, 1000, 5);
    expect(r.start).toBe(5); // row 10 minus overscan
    expect(r.end).toBe(20); // 10 + 5 visible + overscan
  });

  it('clamps at both ends and handles empty grids', () => {
    expect(virtualRowRange(0, 300, 30, 4, 8)).toEqual({ start: 0, end: 4 });
    expect(virtualRowRange(99999, 300, 30, 50, 8)).toEqual({ start: 24, end: 50 });
    expect(virtualRowRange(0, 300, 30, 0)).toEqual({ start: 0, end: 0 });
  });

  it('still yields rows for a zero-height viewport (jsdom)', () => {
    const r = virtualRowRange(0, 0, 30, 100, 8);
    expect(r.start).toBe(0);
    expect(r.end).toBeGreaterThan(0);
  });
});

describe('window geometry helpers', () => {
  it('clamps size to minimums and position into the container', () => {
    expect(clampWindowRect({ x: -50, y: 900, w: 100, h: 100 }, 800, 600))
      .toEqual({ x: 0, y: 600 - ATTR_TABLE_MIN_H, w: ATTR_TABLE_MIN_W, h: ATTR_TABLE_MIN_H });
    expect(clampWindowRect({ x: 10, y: 10, w: 4000, h: 3000 }, 800, 600))
      .toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('docks the default window at the bottom', () => {
    const r = defaultWindowRect(1000, 800);
    expect(r.w).toBe(976);
    expect(r.x).toBe(12);
    expect(r.y + r.h).toBe(800 - 12);
    expect(r.h).toBeGreaterThanOrEqual(ATTR_TABLE_MIN_H);
  });

  it('round-trips the persisted geometry and rejects junk', () => {
    saveAttrTableGeometry({ rect: { x: 1, y: 2, w: 500, h: 300 }, maximized: true });
    expect(loadAttrTableGeometry()).toEqual({ rect: { x: 1, y: 2, w: 500, h: 300 }, maximized: true });
    localStorage.setItem(ATTR_TABLE_GEOMETRY_KEY, '{oops');
    expect(loadAttrTableGeometry()).toBeNull();
    localStorage.setItem(ATTR_TABLE_GEOMETRY_KEY, JSON.stringify({ rect: { x: 'a' } }));
    expect(loadAttrTableGeometry()).toBeNull();
  });
});
