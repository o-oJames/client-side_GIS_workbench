/**
 * Tests for WMS GetFeatureInfo response parsing and the extent-based
 * (box selection) GetFeatureInfo request builder.
 */
import { parseWmsFeatureInfoText, fetchWmsFeatureInfoExtent } from './layerHelpers';

const textResponse = (body: string, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Error',
  text: async () => body,
});

const mockFetch = (impl: (url: string) => any) => {
  (global as any).fetch = jest.fn(async (url: string) => impl(url));
  return (global as any).fetch as jest.Mock;
};

afterEach(() => {
  delete (global as any).fetch;
  jest.restoreAllMocks();
});

describe('parseWmsFeatureInfoText', () => {
  test('empty payload → no features', () => {
    expect(parseWmsFeatureInfoText('')).toEqual({ features: [] });
    expect(parseWmsFeatureInfoText('   ')).toEqual({ features: [] });
  });

  test('GeoJSON FeatureCollection → per-feature attribute objects', () => {
    const payload = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'A' }, geometry: null },
        { type: 'Feature', properties: { name: 'B' }, geometry: null },
      ],
    });
    expect(parseWmsFeatureInfoText(payload)).toEqual({ features: [{ name: 'A' }, { name: 'B' }] });
  });

  test('other JSON is surfaced pretty-printed as text', () => {
    const result = parseWmsFeatureInfoText('{"a":1}');
    expect(result).toEqual({ text: JSON.stringify({ a: 1 }, null, 2) });
  });

  test('non-JSON payload is returned verbatim', () => {
    expect(parseWmsFeatureInfoText('<html>hi</html>')).toEqual({ text: '<html>hi</html>' });
  });
});

describe('fetchWmsFeatureInfoExtent', () => {
  const fakeMap = (resolution = 10) => ({
    getView: () => ({
      getResolution: () => resolution,
      getProjection: () => ({ getCode: () => 'EPSG:3857' }),
    }),
  });

  const fakeLayer = (params: Record<string, any> = {}, urls = ['http://example.com/wms']) => ({
    getSource: () => ({
      getParams: () => params,
      getUrls: () => urls,
    }),
  });

  test('builds a GetFeatureInfo URL whose BBOX matches the extent', async () => {
    const fetchMock = mockFetch(() => textResponse(''));
    const layer = fakeLayer({ LAYERS: 'test:layer' });

    await fetchWmsFeatureInfoExtent(layer, [100, 200, 400, 700], fakeMap(10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('REQUEST')).toBe('GetFeatureInfo');
    expect(url.searchParams.get('LAYERS')).toBe('test:layer');
    expect(url.searchParams.get('QUERY_LAYERS')).toBe('test:layer');
    expect(url.searchParams.get('BBOX')).toBe('100,200,400,700');
    expect(url.searchParams.get('WIDTH')).toBe('30');
    expect(url.searchParams.get('HEIGHT')).toBe('50');
    expect(url.searchParams.get('X')).toBe('15');
    expect(url.searchParams.get('Y')).toBe('25');
    expect(url.searchParams.get('INFO_FORMAT')).toBe('application/json');
    // WMS 1.1.1 default uses SRS.
    expect(url.searchParams.get('SRS')).toBe('EPSG:3857');
    expect(url.searchParams.get('CRS')).toBeNull();
  });

  test('WMS 1.3.0 requests use CRS instead of SRS', async () => {
    const fetchMock = mockFetch(() => textResponse(''));
    const layer = fakeLayer({ LAYERS: 'test:layer', VERSION: '1.3.0' });

    await fetchWmsFeatureInfoExtent(layer, [0, 0, 10, 10], fakeMap(10));

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('CRS')).toBe('EPSG:3857');
    expect(url.searchParams.get('SRS')).toBeNull();
  });

  test('appends with & when the base URL already has a query string', async () => {
    const fetchMock = mockFetch(() => textResponse(''));
    const layer = fakeLayer({ LAYERS: 'l' }, ['http://example.com/wms?token=abc']);

    await fetchWmsFeatureInfoExtent(layer, [0, 0, 10, 10], fakeMap(10));

    const requested = fetchMock.mock.calls[0][0] as string;
    expect(requested).toMatch(/^http:\/\/example\.com\/wms\?token=abc&/);
  });

  test('returns parsed features from a JSON response', async () => {
    mockFetch(() => textResponse(JSON.stringify({
      features: [{ properties: { id: 7 } }],
    })));
    const result = await fetchWmsFeatureInfoExtent(
      fakeLayer({ LAYERS: 'l' }), [0, 0, 10, 10], fakeMap(10),
    );
    expect(result).toEqual({ features: [{ id: 7 }] });
  });

  test('returns null on HTTP failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(() => textResponse('', false, 500));
    const result = await fetchWmsFeatureInfoExtent(
      fakeLayer({ LAYERS: 'l' }), [0, 0, 10, 10], fakeMap(10),
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('returns null when the source lacks layers or url', async () => {
    expect(await fetchWmsFeatureInfoExtent(fakeLayer({}), [0, 0, 10, 10], fakeMap())).toBeNull();
    expect(await fetchWmsFeatureInfoExtent({ getSource: () => null }, [0, 0, 10, 10], fakeMap())).toBeNull();
    expect(await fetchWmsFeatureInfoExtent(fakeLayer({ LAYERS: 'l' }), [0, 0, 10, 10], null)).toBeNull();
  });

  test('WIDTH/HEIGHT never drop below 1 for tiny boxes', async () => {
    const fetchMock = mockFetch(() => textResponse(''));
    await fetchWmsFeatureInfoExtent(
      fakeLayer({ LAYERS: 'l' }), [0, 0, 0.5, 0.5], fakeMap(10),
    );
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('WIDTH')).toBe('1');
    expect(url.searchParams.get('HEIGHT')).toBe('1');
  });
});
