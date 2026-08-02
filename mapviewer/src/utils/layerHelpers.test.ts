/**
 * STAC helpers: direct STAC Item detection/fetching (static items hosted on
 * plain object storage, e.g. the Sentinel-2 COG bucket on S3) and the
 * fetchAllStacItems loader, covering both the API pagination loop and the
 * direct-item mode used when no collection is supplied.
 */
import {
  isStacItem,
  stacItemLabel,
  fetchDirectStacItem,
  probeDirectStacItem,
  fetchAllStacItems,
  COG_COLOR_VARIABLES,
  createCogTileStyle,
  cogColorVariables,
  isWebGlTileLayer,
  applyColorAdjustments,
} from './layerHelpers';

const SAMPLE_ITEM = {
  type: 'Feature',
  stac_version: '1.0.0',
  id: 'S2A_10TES_20220726_0_L2A',
  collection: 'sentinel-2-l2a',
  properties: { title: 'Sentinel-2 tile 10TES' },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  bbox: [0, 0, 1, 1],
  assets: {},
  links: [],
};

/** Minimal Response stand-in (jsdom has no fetch implementation). */
const jsonResponse = (body: any, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

const mockFetch = (impl: (url: string) => any) => {
  (global as any).fetch = jest.fn(async (url: string) => impl(url));
  return (global as any).fetch as jest.Mock;
};

afterEach(() => {
  delete (global as any).fetch;
  jest.restoreAllMocks();
});

describe('isStacItem', () => {
  test('accepts a GeoJSON Feature carrying a stac_version', () => {
    expect(isStacItem(SAMPLE_ITEM)).toBe(true);
  });

  test('rejects plain GeoJSON, catalogs, and non-objects', () => {
    expect(isStacItem({ type: 'Feature', id: 'x' })).toBe(false); // no stac_version
    expect(isStacItem({ type: 'Catalog', stac_version: '1.0.0' })).toBe(false);
    expect(isStacItem({ type: 'FeatureCollection', stac_version: '1.0.0' })).toBe(false);
    expect(isStacItem({ stac_version: '1.0.0' })).toBe(false); // no Feature type
    expect(isStacItem(null)).toBe(false);
    expect(isStacItem('nope')).toBe(false);
  });
});

describe('stacItemLabel', () => {
  test('prefers the item title and appends the collection', () => {
    expect(stacItemLabel(SAMPLE_ITEM)).toBe('Sentinel-2 tile 10TES — sentinel-2-l2a');
  });

  test('falls back to the id, then to a placeholder', () => {
    expect(stacItemLabel({ id: 'abc' })).toBe('abc');
    expect(stacItemLabel({})).toBe('Untitled item');
  });
});

describe('fetchDirectStacItem', () => {
  test('returns the parsed item for a valid STAC Item URL', async () => {
    mockFetch(() => jsonResponse(SAMPLE_ITEM));
    await expect(fetchDirectStacItem('https://example.com/item.json')).resolves.toEqual(SAMPLE_ITEM);
  });

  test('throws on HTTP errors', async () => {
    mockFetch(() => jsonResponse({}, false, 404));
    await expect(fetchDirectStacItem('https://example.com/missing.json')).rejects.toThrow(/HTTP 404/);
  });

  test('throws when the body is not JSON', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));
    await expect(fetchDirectStacItem('https://example.com/not-json')).rejects.toThrow(/not return valid JSON/);
  });

  test('throws when the payload is not a STAC Item', async () => {
    mockFetch(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await expect(fetchDirectStacItem('https://example.com/fc.json')).rejects.toThrow(/not a STAC Item/);
  });
});

describe('probeDirectStacItem', () => {
  test('returns the item when the URL is a direct STAC Item', async () => {
    mockFetch(() => jsonResponse(SAMPLE_ITEM));
    await expect(probeDirectStacItem('https://example.com/item.json')).resolves.toEqual(SAMPLE_ITEM);
  });

  test('returns null (never throws) for unreachable or non-item URLs', async () => {
    mockFetch(() => jsonResponse({}, false, 500));
    await expect(probeDirectStacItem('https://example.com/broken')).resolves.toBeNull();

    mockFetch(() => jsonResponse({ type: 'Catalog', stac_version: '1.0.0' }));
    await expect(probeDirectStacItem('https://example.com/catalog.json')).resolves.toBeNull();
  });
});

describe('fetchAllStacItems — direct STAC Item mode (empty collection)', () => {
  test('fetches the URL itself and wraps the item in a FeatureCollection', async () => {
    const fetchMock = mockFetch(() => jsonResponse(SAMPLE_ITEM));
    const progress = jest.fn();

    const result = await fetchAllStacItems('https://example.com/item.json', '', undefined, progress);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/item.json');
    expect(result).toEqual({ type: 'FeatureCollection', features: [SAMPLE_ITEM] });
    expect(progress).toHaveBeenCalledWith(1);
  });

  test('whitespace-only collection also selects direct mode', async () => {
    mockFetch(() => jsonResponse(SAMPLE_ITEM));
    const result = await fetchAllStacItems('https://example.com/item.json', '   ');
    expect(result.features).toHaveLength(1);
  });

  test('propagates the error when the URL is not a STAC Item', async () => {
    mockFetch(() => jsonResponse({ type: 'Catalog' }));
    await expect(fetchAllStacItems('https://example.com/catalog.json', '')).rejects.toThrow(/not a STAC Item/);
  });
});

describe('fetchAllStacItems — STAC API mode (collection supplied)', () => {
  test('requests the items endpoint and follows rel=next pagination', async () => {
    const page1 = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 'a', geometry: null, properties: {} }],
      links: [{ rel: 'next', href: 'https://api.example.com/items?token=2' }],
    };
    const page2 = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 'b', geometry: null, properties: {} }],
      links: [],
    };
    const fetchMock = mockFetch((url) => jsonResponse(url.includes('token=2') ? page2 : page1));
    const progress = jest.fn();

    const result = await fetchAllStacItems('https://api.example.com', 'sentinel-2-l2a', undefined, progress);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/collections/sentinel-2-l2a/items');
    expect(result.features.map((f: any) => f.id)).toEqual(['a', 'b']);
    expect(progress).toHaveBeenLastCalledWith(2);
  });

  test('trims results to maxItems', async () => {
    const page = {
      type: 'FeatureCollection',
      features: [1, 2, 3, 4, 5].map((i) => ({ type: 'Feature', id: String(i), geometry: null, properties: {} })),
      links: [{ rel: 'next', href: 'https://api.example.com/items?token=2' }],
    };
    const fetchMock = mockFetch(() => jsonResponse(page));

    const result = await fetchAllStacItems('https://api.example.com', 'col', 3);

    expect(result.features).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1); // stops before the next page
  });
});


describe('COG colour adjustments (WebGLTile layers)', () => {
  test('cogColorVariables maps the 0-200 app scale to the -1..1 GL range', () => {
    // 100 is neutral (0); 0 -> -1; 200 -> +1
    expect(cogColorVariables({ brightness: 100, contrast: 100, saturation: 100 })).toEqual({
      [COG_COLOR_VARIABLES.exposure]: 0,
      [COG_COLOR_VARIABLES.contrast]: 0,
      [COG_COLOR_VARIABLES.saturation]: 0,
    });
    expect(cogColorVariables({ brightness: 0, contrast: 200, saturation: 50 })).toEqual({
      [COG_COLOR_VARIABLES.exposure]: -1,
      [COG_COLOR_VARIABLES.contrast]: 1,
      [COG_COLOR_VARIABLES.saturation]: -0.5,
    });
    // Missing values default to neutral
    expect(cogColorVariables({})).toEqual({
      [COG_COLOR_VARIABLES.exposure]: 0,
      [COG_COLOR_VARIABLES.contrast]: 0,
      [COG_COLOR_VARIABLES.saturation]: 0,
    });
  });

  test('createCogTileStyle declares every variable its expressions reference', () => {
    const style: any = createCogTileStyle();
    expect(style.variables[COG_COLOR_VARIABLES.exposure]).toBe(0);
    expect(style.variables[COG_COLOR_VARIABLES.contrast]).toBe(0);
    expect(style.variables[COG_COLOR_VARIABLES.saturation]).toBe(0);
    expect(style.exposure).toEqual(['var', COG_COLOR_VARIABLES.exposure]);
    expect(style.contrast).toEqual(['var', COG_COLOR_VARIABLES.contrast]);
    expect(style.saturation).toEqual(['var', COG_COLOR_VARIABLES.saturation]);
  });

  test('isWebGlTileLayer detects layers exposing updateStyleVariables', () => {
    expect(isWebGlTileLayer({ updateStyleVariables: () => {} })).toBe(true);
    expect(isWebGlTileLayer({ setOpacity: () => {} })).toBe(false);
    expect(isWebGlTileLayer(null)).toBe(false);
  });

  test('applyColorAdjustments drives shader variables on WebGL layers', () => {
    const updateStyleVariables = jest.fn();
    const setOpacity = jest.fn();
    const getRenderer = jest.fn();
    const changed = jest.fn();
    const layer = { updateStyleVariables, setOpacity, getRenderer, changed };

    applyColorAdjustments(layer, { brightness: 150, saturation: 50, contrast: 125, opacity: 80 });

    expect(setOpacity).toHaveBeenCalledWith(0.8);
    expect(updateStyleVariables).toHaveBeenCalledWith({
      [COG_COLOR_VARIABLES.exposure]: 0.5,
      [COG_COLOR_VARIABLES.contrast]: 0.25,
      [COG_COLOR_VARIABLES.saturation]: -0.5,
    });
    // The CSS-filter/renderer patching path must not run for WebGL layers
    expect(getRenderer).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  test('applyColorAdjustments still uses CSS filters on canvas layers', () => {
    const setOpacity = jest.fn();
    const changed = jest.fn();
    const renderer: any = { useContainer: () => {} };
    const layer = { setOpacity, changed, getRenderer: () => renderer };

    applyColorAdjustments(layer, { brightness: 150, saturation: 100, contrast: 100, opacity: 100 });

    expect(setOpacity).toHaveBeenCalledWith(1);
    expect(renderer._colorFilter).toBe('brightness(150%) saturate(100%) contrast(100%)');
    expect(changed).toHaveBeenCalled();
  });
});
