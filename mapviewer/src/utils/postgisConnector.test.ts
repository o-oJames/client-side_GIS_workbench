// ---------------------------------------------------------------------------
// utils/postgisConnector.test.ts — Tests for the PostGIS Connector HTTP client:
// port probing (mock fetch), caching, error handling.
// ---------------------------------------------------------------------------

import { findConnector, clearConnectorCache, listConnections, saveConnection, deleteConnection, testConnection, listTables, queryGeoJSON, getTileUrl } from '../utils/postgisConnector';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
  clearConnectorCache();
});

// ---------------------------------------------------------------------------
// findConnector — port probing
// ---------------------------------------------------------------------------

describe('findConnector', () => {
  it('returns the URL of the first responding port', async () => {
    // Only port 40003 responds
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes(':40003/health')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Connection refused'));
    });

    const result = await findConnector();
    expect(result).toBe('http://localhost:40003');
  });

  it('returns null when no port responds', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await findConnector();
    expect(result).toBeNull();
  });

  it('caches the discovered URL in localStorage', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(':40000/health')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('refused'));
    });

    const result = await findConnector();
    expect(result).toBe('http://localhost:40000');
    expect(localStorage.getItem('mapviewer-postgis-connector-url')).toBe('http://localhost:40000');
  });

  it('uses cached URL on subsequent calls', async () => {
    localStorage.setItem('mapviewer-postgis-connector-url', 'http://localhost:40005');

    // Only the cached URL should be probed
    mockFetch.mockImplementation((url: string) => {
      if (url === 'http://localhost:40005/health') {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('refused'));
    });

    const result = await findConnector();
    expect(result).toBe('http://localhost:40005');
    // Only one fetch call (the cached URL check)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('clears stale cache when cached URL does not respond', async () => {
    localStorage.setItem('mapviewer-postgis-connector-url', 'http://localhost:40005');

    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await findConnector();
    expect(result).toBeNull();
    expect(localStorage.getItem('mapviewer-postgis-connector-url')).toBeNull();
  });

  it('probes all 20 ports in parallel', async () => {
    mockFetch.mockRejectedValue(new Error('refused'));

    await findConnector();

    // Should have tried all 20 ports
    expect(mockFetch).toHaveBeenCalledTimes(20);
  });
});

// ---------------------------------------------------------------------------
// clearConnectorCache
// ---------------------------------------------------------------------------

describe('clearConnectorCache', () => {
  it('removes the cached URL from localStorage', () => {
    localStorage.setItem('mapviewer-postgis-connector-url', 'http://localhost:40000');
    clearConnectorCache();
    expect(localStorage.getItem('mapviewer-postgis-connector-url')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

describe('listConnections', () => {
  it('returns parsed connections', async () => {
    const conns = [{ id: '1', name: 'DB1', host: 'localhost', port: 5432, database: 'db', username: 'u', createdAt: '' }];
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conns) });

    const result = await listConnections('http://localhost:40000');
    expect(result).toEqual(conns);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:40000/connections');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(listConnections('http://localhost:40000')).rejects.toThrow('Failed to list connections');
  });
});

describe('saveConnection', () => {
  it('sends POST with connection data', async () => {
    const newConn = { id: 'new', name: 'DB', host: 'localhost', port: 5432, database: 'db', username: 'u', createdAt: '' };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(newConn) });

    const result = await saveConnection('http://localhost:40000', {
      name: 'DB',
      host: 'localhost',
      port: 5432,
      database: 'db',
      username: 'u',
      password: 'secret',
    });

    expect(result).toEqual(newConn);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:40000/connections', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('throws with server error message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Missing fields' }),
    });

    await expect(saveConnection('http://localhost:40000', {
      name: '', host: '', port: 5432, database: '', username: '', password: '',
    })).rejects.toThrow('Missing fields');
  });
});

describe('deleteConnection', () => {
  it('sends DELETE request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await deleteConnection('http://localhost:40000', 'conn-1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:40000/connections/conn-1', { method: 'DELETE' });
  });
});

describe('testConnection', () => {
  it('returns test result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, version: 'PostgreSQL 15' }),
    });

    const result = await testConnection('http://localhost:40000', 'conn-1');
    expect(result.ok).toBe(true);
    expect(result.version).toContain('PostgreSQL');
  });
});

// ---------------------------------------------------------------------------
// Table discovery
// ---------------------------------------------------------------------------

describe('listTables', () => {
  it('returns table info array', async () => {
    const tables = [
      { schema: 'public', table: 'roads', geomColumn: 'geom', geomType: 'LINESTRING', srid: 4326, isGeography: false, estimatedExtent: null },
    ];
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tables) });

    const result = await listTables('http://localhost:40000', 'conn-1');
    expect(result).toEqual(tables);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:40000/connections/conn-1/tables');
  });
});

// ---------------------------------------------------------------------------
// GeoJSON query
// ---------------------------------------------------------------------------

describe('queryGeoJSON', () => {
  it('sends POST with table, geomColumn, and options', async () => {
    const fc = { type: 'FeatureCollection', features: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(fc) });

    const result = await queryGeoJSON('http://localhost:40000', 'conn-1', 'roads', 'geom', {
      filter: "status = 'active'",
      bbox: [138.5, -35.0, 138.7, -34.8],
      srid: 4326,
      limit: 5000,
    });

    expect(result).toEqual(fc);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.table).toBe('roads');
    expect(body.geomColumn).toBe('geom');
    expect(body.filter).toBe("status = 'active'");
    expect(body.bbox).toEqual([138.5, -35.0, 138.7, -34.8]);
    expect(body.limit).toBe(5000);
  });

  it('throws on query error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'relation does not exist' }),
    });

    await expect(queryGeoJSON('http://localhost:40000', 'conn-1', 'bad_table', 'geom'))
      .rejects.toThrow('relation does not exist');
  });
});

// ---------------------------------------------------------------------------
// Tile URL builder
// ---------------------------------------------------------------------------

describe('getTileUrl', () => {
  it('builds correct MVT tile URL template', () => {
    const url = getTileUrl('http://localhost:40000', 'conn-1', 'roads', 'geom');
    expect(url).toBe('http://localhost:40000/connections/conn-1/tiles/{z}/{x}/{y}?table=roads&geomColumn=geom');
  });

  it('URL-encodes special characters in table/column names', () => {
    const url = getTileUrl('http://localhost:40000', 'conn-1', 'my roads', 'the geom');
    expect(url).toContain('table=my%20roads');
    expect(url).toContain('geomColumn=the%20geom');
  });
});
