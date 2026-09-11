/**
 * Attribute-driven rendering ("smart mapping") utilities: field discovery,
 * statistics, classification, ramps/palettes, size scaling, legend rows and
 * the per-feature OL style function.
 */
import {
  ATTRIBUTE_RAMPS,
  ATTRIBUTE_CATEGORY_COLORS,
  ATTRIBUTE_NO_DATA_COLOR,
  MAX_CATEGORY_COLORS,
  getRamp,
  isNumericAttrValue,
  toNumericAttrValue,
  collectAttributeFields,
  computeFieldStats,
  computeClassBreaks,
  classifyValue,
  rampColorForClass,
  sizeForValue,
  formatAttrValue,
  buildAttributeLegend,
  buildAttributeStyle,
} from './attributeStyle';
import { buildVectorStyle } from './vectorStyleHelpers';
import { AttributeRenderConfig } from '../types';

// Minimal OL-feature stand-in (featureProperties + geometry type only).
const feat = (props: Record<string, any>, geomType = 'Point') => ({
  getProperties: () => ({ ...props }),
  getGeometryName: () => 'geometry',
  getGeometry: () => ({ getType: () => geomType }),
  get: (k: string) => props[k],
});

// --- value coercion -----------------------------------------------------------

describe('attribute value coercion', () => {
  test('numbers and numeric strings are usable values', () => {
    expect(isNumericAttrValue(3)).toBe(true);
    expect(isNumericAttrValue('3.5')).toBe(true);
    expect(isNumericAttrValue(' 12 ')).toBe(true);
    expect(toNumericAttrValue('3.5')).toBe(3.5);
  });

  test('empty/whitespace strings, booleans and nulls are not', () => {
    expect(isNumericAttrValue('')).toBe(false);
    expect(isNumericAttrValue('   ')).toBe(false);
    expect(isNumericAttrValue(true)).toBe(false);
    expect(isNumericAttrValue(null)).toBe(false);
    expect(toNumericAttrValue('abc')).toBeNull();
    expect(toNumericAttrValue(NaN)).toBeNull();
  });
});

// --- field discovery ------------------------------------------------------------

describe('collectAttributeFields', () => {
  test('unions keys across features and flags numeric fields', () => {
    const feats = [
      feat({ name: 'a', pop: 10, geometry: {} }),
      feat({ name: 'b', pop: '20', extra: 'x' }),
      feat({ name: 'c', pop: 30 }),
    ];
    const fields = collectAttributeFields(feats);
    const names = fields.map(f => f.name);
    expect(names).toEqual(['extra', 'name', 'pop']); // alphabetical, geometry excluded
    expect(fields.find(f => f.name === 'pop')!.numeric).toBe(true);
    expect(fields.find(f => f.name === 'name')!.numeric).toBe(false);
  });

  test('mixed fields count as numeric at >= 80%', () => {
    const feats = [
      feat({ v: 1 }), feat({ v: 2 }), feat({ v: 3 }), feat({ v: 4 }), feat({ v: 'n/a' }),
    ];
    expect(collectAttributeFields(feats)[0].numeric).toBe(true);
  });
});

// --- statistics --------------------------------------------------------------------

describe('computeFieldStats', () => {
  const feats = [
    feat({ v: 5 }), feat({ v: '1' }), feat({ v: 3 }), feat({}), feat({ v: '' }), feat({ v: 5 }),
  ];

  test('range, sorted values and missing count', () => {
    const s = computeFieldStats(feats, 'v');
    expect(s.count).toBe(6);
    expect(s.numericValues).toEqual([1, 3, 5, 5]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.missing).toBe(2); // absent + empty string
  });

  test('distinct values sorted by frequency', () => {
    const s = computeFieldStats(feats, 'v');
    expect(s.distinct[0]).toEqual({ value: '5', count: 2 });
    expect(s.distinctTotal).toBe(3);
  });
});

// --- classification ------------------------------------------------------------------

describe('computeClassBreaks', () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  test('equal interval spans the data', () => {
    expect(computeClassBreaks(values, 'equal-interval', 3)).toEqual([0, 3, 6, 9]);
  });

  test('quantile breaks follow the distribution', () => {
    expect(computeClassBreaks([1, 2, 3, 4, 5, 6, 7, 8], 'quantile', 4))
      .toEqual([1, 2.75, 4.5, 6.25, 8]);
  });

  test('degenerate data (all identical) returns null', () => {
    expect(computeClassBreaks([4, 4, 4], 'equal-interval', 3)).toBeNull();
    expect(computeClassBreaks([], 'equal-interval', 3)).toBeNull();
  });

  test('quantile with heavy ties falls back to equal intervals', () => {
    const tied = [0, 0, 0, 0, 0, 0, 0, 0, 10];
    const breaks = computeClassBreaks(tied, 'quantile', 3);
    expect(breaks).not.toBeNull();
    for (let i = 1; i < breaks!.length; i++) {
      expect(breaks![i]).toBeGreaterThan(breaks![i - 1]);
    }
  });
});

describe('classifyValue', () => {
  const breaks = [0, 3, 6, 9];
  test('interior values', () => {
    expect(classifyValue(1, breaks)).toBe(0);
    expect(classifyValue(3, breaks)).toBe(1); // boundary goes to the upper class
    expect(classifyValue(5.9, breaks)).toBe(1);
    expect(classifyValue(8, breaks)).toBe(2);
  });
  test('out-of-domain values clamp to the end classes', () => {
    expect(classifyValue(9, breaks)).toBe(2);
    expect(classifyValue(100, breaks)).toBe(2);
    expect(classifyValue(-5, breaks)).toBe(0);
  });
});

// --- ramps & sizes ---------------------------------------------------------------------

describe('ramp and size helpers', () => {
  test('ramp sampling hits the end stops and stays in range', () => {
    const ramp = ATTRIBUTE_RAMPS[0].colors;
    expect(rampColorForClass(ramp, 5, 0)).toBe(ramp[0]);
    expect(rampColorForClass(ramp, 5, 4)).toBe(ramp[4]);
    expect(rampColorForClass(ramp, 1, 0)).toBe(ramp[2]); // single class = middle stop
    expect(getRamp('nope').id).toBe(ATTRIBUTE_RAMPS[0].id);
  });

  test('size uses sqrt scaling and clamps outside the domain', () => {
    expect(sizeForValue(0, 0, 100, 4, 20)).toBe(4);
    expect(sizeForValue(100, 0, 100, 4, 20)).toBe(20);
    // sqrt(0.5) ~ 0.7071 -> 4 + 16 * 0.7071 ~ 15.31
    expect(sizeForValue(50, 0, 100, 4, 20)).toBeCloseTo(4 + 16 * Math.SQRT1_2, 5);
    expect(sizeForValue(500, 0, 100, 4, 20)).toBe(20);
    expect(sizeForValue(-9, 0, 100, 4, 20)).toBe(4);
    expect(sizeForValue(5, 5, 5, 4, 20)).toBe(12); // degenerate domain -> midpoint
  });
});

// --- formatting ------------------------------------------------------------------------

describe('formatAttrValue', () => {
  test('integers get thousands separators', () => {
    expect(formatAttrValue(1234567)).toBe('1,234,567');
    expect(formatAttrValue(1234.5)).toBe('1,235');
    expect(formatAttrValue(-1234)).toBe('-1,234');
  });
  test('small numbers keep two tidy decimals', () => {
    expect(formatAttrValue(12.345)).toBe('12.35');
    expect(formatAttrValue(0.5)).toBe('0.5');
    expect(formatAttrValue(99.999)).toBe('100');
    expect(formatAttrValue(-0.001)).toBe('0');
  });
  test('missing values render an en dash', () => {
    expect(formatAttrValue(undefined)).toBe('\u2013');
    expect(formatAttrValue(NaN)).toBe('\u2013');
  });
});

// --- legend rows -------------------------------------------------------------------------

const colorAttr = (over: Partial<AttributeRenderConfig> = {}): AttributeRenderConfig => ({
  enabled: true,
  field: 'pop',
  mode: 'color',
  method: 'equal-interval',
  classes: 3,
  rampId: ATTRIBUTE_RAMPS[0].id,
  classBreaks: [0, 10, 20, 30],
  ...over,
});

describe('buildAttributeLegend', () => {
  test('colour mode: one row per class with ramp colours', () => {
    const rows = buildAttributeLegend(colorAttr());
    expect(rows).toHaveLength(3);
    expect(rows[0].label).toBe('0 \u2013 10');
    expect(rows[2].label).toBe('20 \u2013 30');
    expect(rows[0].color).toBe(ATTRIBUTE_RAMPS[0].colors[0]);
    expect(rows[2].color).toBe(ATTRIBUTE_RAMPS[0].colors[4]);
  });

  test('colour mode adds a No data row when features are missing values', () => {
    const rows = buildAttributeLegend(colorAttr({ missingCount: 4 }));
    expect(rows[rows.length - 1]).toEqual({ label: 'No data', color: ATTRIBUTE_NO_DATA_COLOR, kind: 'other' });
  });

  test('size mode: max/mid/min rows with radii in the base colour', () => {
    const rows = buildAttributeLegend({
      enabled: true, field: 'mag', mode: 'size', domainMin: 0, domainMax: 10, sizeMin: 4, sizeMax: 20,
    }, '#ff0000');
    expect(rows.map(r => r.label)).toEqual(['10', '5', '0']);
    expect(rows[0].sizePx).toBe(20);
    expect(rows[2].sizePx).toBe(4);
    expect(rows.every(r => r.color === '#ff0000')).toBe(true);
  });

  test('types mode: category rows plus Other when values overflow the palette', () => {
    const cats = ['school', 'hospital', 'park'].map((value, i) => ({ value, colorIndex: i }));
    const rows = buildAttributeLegend({ enabled: true, field: 'kind', mode: 'types', categories: cats, distinctCount: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[1].color).toBe(ATTRIBUTE_CATEGORY_COLORS[1]);
    const overflow = buildAttributeLegend({ enabled: true, field: 'kind', mode: 'types', categories: cats, distinctCount: 99 });
    expect(overflow[overflow.length - 1].label).toBe('Other / no data');
  });

  test('incomplete config yields no rows', () => {
    expect(buildAttributeLegend({ enabled: false, mode: 'types' })).toEqual([]);
    expect(buildAttributeLegend({ enabled: true, mode: 'types' })).toEqual([]);
    expect(buildAttributeLegend(colorAttr({ field: undefined }))).toEqual([]);
    expect(buildAttributeLegend({ enabled: true, field: 'x', mode: 'size' })).toEqual([]); // no domain
  });
});

// --- style function --------------------------------------------------------------------------

describe('buildAttributeStyle', () => {
  test('returns null for incomplete configs', () => {
    expect(buildAttributeStyle({}, { enabled: false, mode: 'types' })).toBeNull();
    expect(buildAttributeStyle({}, { enabled: true, mode: 'types' })).toBeNull(); // no field
    expect(buildAttributeStyle({}, { enabled: true, field: 'v', mode: 'color' })).toBeNull(); // no breaks
    expect(buildAttributeStyle({}, { enabled: true, field: 'v', mode: 'size' })).toBeNull(); // no domain
  });

  test('colour mode paints points by class and grey for missing values', () => {
    const style = buildAttributeStyle({}, colorAttr())!;
    const low: any = style(feat({ pop: 2 }));
    const high: any = style(feat({ pop: 28 }));
    const nodata: any = style(feat({}));
    const lowColor = low.getImage().getFill().getColor();
    const highColor = high.getImage().getFill().getColor();
    expect(lowColor).toBe(ATTRIBUTE_RAMPS[0].colors[0]);
    expect(highColor).toBe(ATTRIBUTE_RAMPS[0].colors[4]);
    expect(lowColor).not.toBe(highColor);
    expect(nodata.getImage().getFill().getColor()).toBe(ATTRIBUTE_NO_DATA_COLOR);
  });

  test('colour mode strokes lines with the class colour', () => {
    const style = buildAttributeStyle({ lineWidth: 3 }, colorAttr())!;
    const s: any = style(feat({ pop: 15 }, 'LineString'));
    // class 1 of 3 samples the 5-stop ramp at its middle
    expect(s.getStroke().getColor()).toBe(ATTRIBUTE_RAMPS[0].colors[2]);
    expect(s.getStroke().getWidth()).toBe(3);
  });

  test('colour mode fills polygons with alpha floored at 0.7', () => {
    const style = buildAttributeStyle({ fillColor: 'rgba(66, 133, 244, 0.3)' }, colorAttr())!;
    const s: any = style(feat({ pop: 15 }, 'Polygon'));
    expect(s.getFill().getColor()).toMatch(/, 0\.7\)$/); // floor applied over the 0.3 base
    const outline = s.getStroke().getColor();
    expect(outline).not.toBe(ATTRIBUTE_RAMPS[0].colors[2]); // darker variant of the class colour
  });

  test('size mode scales point radius and line width', () => {
    const attr: AttributeRenderConfig = {
      enabled: true, field: 'mag', mode: 'size', domainMin: 0, domainMax: 10, sizeMin: 4, sizeMax: 20,
    };
    const style = buildAttributeStyle({ lineColor: 'rgba(10, 20, 30, 1)' }, attr)!;
    const small: any = style(feat({ mag: 0 }));
    const big: any = style(feat({ mag: 10 }));
    expect(small.getImage().getRadius()).toBe(4);
    expect(big.getImage().getRadius()).toBe(20);
    const line: any = style(feat({ mag: 10 }, 'LineString'));
    expect(line.getStroke().getWidth()).toBe(20);
    const nodata: any = style(feat({}));
    expect(nodata.getImage().getFill().getColor()).toBe(ATTRIBUTE_NO_DATA_COLOR);
  });

  test('types mode assigns palette colours per category and grey for the rest', () => {
    const attr: AttributeRenderConfig = {
      enabled: true,
      field: 'kind',
      mode: 'types',
      categories: [
        { value: 'school', colorIndex: 0 },
        { value: 'hospital', colorIndex: 1 },
      ],
      distinctCount: 2,
    };
    const style = buildAttributeStyle({}, attr)!;
    expect((style(feat({ kind: 'school' })) as any).getImage().getFill().getColor()).toBe(ATTRIBUTE_CATEGORY_COLORS[0]);
    expect((style(feat({ kind: 'hospital' }, 'LineString')) as any).getStroke().getColor()).toBe(ATTRIBUTE_CATEGORY_COLORS[1]);
    expect((style(feat({ kind: 'unknown' })) as any).getImage().getFill().getColor()).toBe(ATTRIBUTE_NO_DATA_COLOR);
    expect((style(feat({})) as any).getImage().getFill().getColor()).toBe(ATTRIBUTE_NO_DATA_COLOR);
  });

  test('numeric strings are styled like numbers; Multi* geometries normalise', () => {
    const style = buildAttributeStyle({}, colorAttr())!;
    const fromString: any = style(feat({ pop: '28' }));
    expect(fromString.getImage().getFill().getColor()).toBe(ATTRIBUTE_RAMPS[0].colors[4]);
    const multi: any = style(feat({ pop: 2 }, 'MultiPoint'));
    expect(multi.getImage().getFill().getColor()).toBe(ATTRIBUTE_RAMPS[0].colors[0]);
  });

  test('styles are cached per bucket', () => {
    const style = buildAttributeStyle({}, colorAttr())!;
    expect(style(feat({ pop: 1 }))).toBe(style(feat({ pop: 2 }))); // same class -> same Style
    expect(style(feat({ pop: 1 }))).not.toBe(style(feat({ pop: 25 })));
  });

  test('category palette wraps past MAX_CATEGORY_COLORS without crashing', () => {
    const attr: AttributeRenderConfig = {
      enabled: true,
      field: 'k',
      mode: 'types',
      categories: [{ value: 'x', colorIndex: MAX_CATEGORY_COLORS + 2 }],
    };
    const style = buildAttributeStyle({}, attr)!;
    expect((style(feat({ k: 'x' })) as any).getImage().getFill().getColor())
      .toBe(ATTRIBUTE_CATEGORY_COLORS[2 % ATTRIBUTE_CATEGORY_COLORS.length]);
  });
});

// --- integration with buildVectorStyle ---------------------------------------------------------

describe('buildVectorStyle with attrRender', () => {
  test('attribute style overrides the fixed layer colours', () => {
    const fn = buildVectorStyle({
      lineColor: 'rgba(1, 2, 3, 1)',
      fillColor: 'rgba(1, 2, 3, 0.3)',
      attrRender: colorAttr(),
    });
    const s: any = fn(feat({ pop: 28 }));
    expect(s.getImage().getFill().getColor()).toBe(ATTRIBUTE_RAMPS[0].colors[4]);
  });

  test('features without the attribute fall back to grey, labels keep their text', () => {
    const fn = buildVectorStyle({
      lineColor: 'rgba(1, 2, 3, 1)',
      attrRender: colorAttr(),
    });
    const plain: any = fn(feat({}));
    expect(plain.getImage().getFill().getColor()).toBe(ATTRIBUTE_NO_DATA_COLOR);
    // Labelled (drawn) features keep the base style + text path.
    const labelled: any = fn(feat({ labelText: 'hi' }));
    expect(labelled.getText().getText()).toBe('hi');
    expect(labelled.getImage().getFill().getColor()).toBe('rgba(1, 2, 3, 1)');
  });

  test('disabled attribute rendering keeps the plain layer style', () => {
    const fn = buildVectorStyle({
      lineColor: 'rgba(9, 8, 7, 1)',
      attrRender: colorAttr({ enabled: false }),
    });
    const s: any = fn(feat({ pop: 28 }));
    expect(s.getImage().getFill().getColor()).toBe('rgba(9, 8, 7, 1)');
  });
});
