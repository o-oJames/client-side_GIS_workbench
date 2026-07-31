/**
 * Attribute query expressions used by the vector layer Filter toggle.
 *
 * Covers the grammar (comparisons, IS tests, LIKE, IN, boolean logic),
 * type-aware value coercion (numeric, temporal, string), attribute lookup
 * leniency, and the human-readable syntax errors surfaced in the UI.
 */
import {
  compileFeatureFilter,
  checkFeatureFilter,
  featureMatchesFilter,
  featureProperties,
  lookupAttribute,
} from './featureFilter';

const matches = (expr: string, props: Record<string, any>) =>
  compileFeatureFilter(expr).predicate(props);

describe('comparisons', () => {
  test('temporal: "capture_date" > \'2024-01-01\' compares dates, not strings', () => {
    const expr = `"capture_date" > '2024-01-01'`;
    expect(matches(expr, { capture_date: '2024-06-15' })).toBe(true);
    expect(matches(expr, { capture_date: '2023-12-31' })).toBe(false);
    // String comparison would rank '2024-02' below '2024-01-01'... date logic must not:
    expect(matches(expr, { capture_date: '2024-02-01T10:30:00Z' })).toBe(true);
    expect(matches(`"capture_date" <= '2024-01-01'`, { capture_date: '2024-01-01' })).toBe(true);
  });

  test('numeric: numbers and numeric strings compare as numbers', () => {
    expect(matches('"population" >= 100', { population: 250 })).toBe(true);
    expect(matches('"population" >= 100', { population: '99' })).toBe(false);
    expect(matches('"population" >= 100', { population: '100' })).toBe(true);
    expect(matches('"ratio" < 0.5', { ratio: 0.25 })).toBe(true);
    // String comparison would say '9' > '100'; numeric must win.
    expect(matches('"population" > 9', { population: 100 })).toBe(true);
  });

  test('equality: =, ==, !=, <> forms', () => {
    expect(matches(`"status" = 'open'`, { status: 'open' })).toBe(true);
    expect(matches(`"status" == 'open'`, { status: 'open' })).toBe(true);
    expect(matches(`"status" != 'open'`, { status: 'closed' })).toBe(true);
    expect(matches(`"status" <> 'open'`, { status: 'closed' })).toBe(true);
    expect(matches(`"status" = 'open'`, { status: 'closed' })).toBe(false);
    expect(matches('"count" = 3', { count: '3' })).toBe(true);
  });

  test('string ordering falls back to alphabetical', () => {
    expect(matches(`"name" > 'M'`, { name: 'Zebra' })).toBe(true);
    expect(matches(`"name" < 'M'`, { name: 'Zebra' })).toBe(false);
  });

  test('missing attributes fail comparisons but satisfy IS NULL', () => {
    expect(matches(`"nope" > '2024-01-01'`, { other: 1 })).toBe(false);
    expect(matches(`"nope" = 'x'`, { other: 1 })).toBe(false);
    expect(matches(`"nope" != 'x'`, { other: 1 })).toBe(true);
    expect(matches('"nope" is null', { other: 1 })).toBe(true);
    expect(matches('"nope" is not null', { other: 1 })).toBe(false);
    expect(matches('"present" is not null', { present: 0 })).toBe(true);
  });
});

describe('IS tests and truthiness', () => {
  test('"published" is true', () => {
    const expr = '"published" is true';
    expect(matches(expr, { published: true })).toBe(true);
    expect(matches(expr, { published: 'true' })).toBe(true);
    expect(matches(expr, { published: 1 })).toBe(true);
    expect(matches(expr, { published: false })).toBe(false);
    expect(matches(expr, {})).toBe(false);
  });

  test('is false / is not true', () => {
    expect(matches('"published" is false', { published: false })).toBe(true);
    expect(matches('"published" is false', {})).toBe(false);
    expect(matches('"published" is not true', { published: false })).toBe(true);
  });

  test('bare field is a truthiness test', () => {
    expect(matches('"published"', { published: true })).toBe(true);
    expect(matches('"published"', { published: false })).toBe(false);
    expect(matches('"published"', { published: '' })).toBe(false);
    expect(matches('"published"', {})).toBe(false);
  });
});

describe('LIKE and IN', () => {
  test('LIKE is case-insensitive with % and _ wildcards', () => {
    expect(matches(`"name" like '%park%'`, { name: 'National PARK Reserve' })).toBe(true);
    expect(matches(`"name" like 'trail _'`, { name: 'Trail 7' })).toBe(true);
    expect(matches(`"name" like 'trail _'`, { name: 'Trail 77' })).toBe(false);
    expect(matches(`"name" not like '%park%'`, { name: 'Beach' })).toBe(true);
    // Regex metacharacters in the pattern are literal.
    expect(matches(`"code" like 'a.b'`, { code: 'a.b' })).toBe(true);
    expect(matches(`"code" like 'a.b'`, { code: 'axb' })).toBe(false);
  });

  test('IN matches any listed literal', () => {
    const expr = `"type" in ('trail', 'reserve')`;
    expect(matches(expr, { type: 'trail' })).toBe(true);
    expect(matches(expr, { type: 'reserve' })).toBe(true);
    expect(matches(expr, { type: 'road' })).toBe(false);
    expect(matches(`"zone" not in (1, 2)`, { zone: 3 })).toBe(true);
    expect(matches(`"zone" in (1, 2)`, { zone: '2' })).toBe(true);
  });
});

describe('boolean logic', () => {
  const props = { type: 'trail', length_km: 12, published: true };

  test('AND / OR / NOT / parentheses', () => {
    expect(matches(`"type" = 'trail' and "length_km" > 10`, props)).toBe(true);
    expect(matches(`"type" = 'trail' and "length_km" > 20`, props)).toBe(false);
    expect(matches(`"type" = 'road' or "length_km" > 10`, props)).toBe(true);
    expect(matches(`not "type" = 'road'`, props)).toBe(true);
    expect(matches(`("type" = 'road' or "type" = 'trail') and "published" is true`, props)).toBe(true);
    expect(matches(`"type" = 'road' or "type" = 'trail' and "published" is false`, props)).toBe(false); // AND binds tighter
  });
});

describe('identifier and literal leniency', () => {
  test('bare and quoted identifiers, typographic quotes', () => {
    expect(matches(`capture_date > '2024-01-01'`, { capture_date: '2024-05-05' })).toBe(true);
    // Curly quotes pasted from a document are straightened automatically.
    expect(matches('\u201Ccapture_date\u201D > \u20182024-01-01\u2019', { capture_date: '2024-05-05' })).toBe(true);
  });

  test('attribute lookup is case-insensitive as a fallback', () => {
    expect(lookupAttribute({ Capture_Date: 'x' }, 'capture_date')).toBe('x');
    expect(lookupAttribute({ capture_date: 'x' }, 'capture_date')).toBe('x');
    expect(lookupAttribute({ a: 1 }, 'b')).toBeUndefined();
  });

  test('double quotes denote field names, single quotes strings', () => {
    // "yes" is a FIELD here, not a string - missing field, so no match.
    expect(matches(`"status" = "yes"`, { status: 'yes' })).toBe(false);
    expect(matches(`"status" = 'yes'`, { status: 'yes' })).toBe(true);
  });
});

describe('feature glue', () => {
  test('featureProperties strips the geometry and passes plain objects through', () => {
    const geom = { getType: () => 'Point' };
    const feature = {
      getProperties: () => ({ name: 'A', geometry: geom }),
      getGeometryName: () => 'geometry',
    };
    expect(featureProperties(feature)).toEqual({ name: 'A' });
    expect(featureProperties({ name: 'B' })).toEqual({ name: 'B' });
  });

  test('featureMatchesFilter works against OL-like features', () => {
    const compiled = compileFeatureFilter(`"capture_date" > '2024-01-01'`);
    const feature = {
      getProperties: () => ({ capture_date: '2024-03-01', geometry: {} }),
      getGeometryName: () => 'geometry',
    };
    expect(featureMatchesFilter(compiled, feature)).toBe(true);
  });
});

describe('syntax errors', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /empty/i],
    ['"a" >', /ends unexpectedly|expected/i],
    ['"a" > )', /unexpected/i],
    ["\"a\" = 'x", /[Uu]nterminated/],
    ['("a" = 1', /closing "\)"/],
    ['"a" = 1 "b" = 2', /unexpected|expected/i],
    ['"a" is maybe', /TRUE, FALSE, or NULL/i],
    ['"a" like 5', /pattern/i],
    ['"a" in (b)', /value/i],
    ['"a" === 1', /unexpected/i],
    ['@', /unexpected character/i],
  ];

  test.each(cases)('rejects %j', (expr, pattern) => {
    expect(() => compileFeatureFilter(expr)).toThrow(pattern);
    const check = checkFeatureFilter(expr);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(pattern);
  });

  test('accepts valid expressions', () => {
    expect(checkFeatureFilter(`"a" = 1 and "b" is not null`).ok).toBe(true);
  });
});
