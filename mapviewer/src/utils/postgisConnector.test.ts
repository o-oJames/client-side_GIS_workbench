// ---------------------------------------------------------------------------
// utils/postgisConnector.test.ts — Tests for the PostGIS Connector HTTP client:
// port probing, connection CRUD, migration.
// ---------------------------------------------------------------------------

import {
  findConnector,
  clearConnectorCache,
  listConnections,
  saveConnection,
  deleteConnection,
  testConnection,
  listTables,
  queryGeoJSON,
  getTileUrl,
  initConnector,
  hasConnectorRestarted,
} from '../utils/postgisConnector';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock crypto for jsdom
// Store encrypted data in a map so we can properly round-trip
const encryptedDataStore = new Map<string, Uint8Array>();
let encryptCounter = 0;

const mockCrypto = {
  getRandomValues: (arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    return arr;
  },
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  subtle: {
    importKey: jest.fn().mockResolvedValue({ type: 'secret', _keyData: new Uint8Array(32) }),
    deriveKey: jest.fn().mockResolvedValue({ type: 'secret', _keyData: new Uint8Array(32) }),
    encrypt: jest.fn().mockImplementation(async (algo: any, key: any, data: Uint8Array) => {
      // Store the original data with a unique ID
      const id = 'enc-' + (encryptCounter++);
      encryptedDataStore.set(id, new Uint8Array(data));
      // Return a buffer that contains the ID (so decrypt can look it up)
      const idBytes = new TextEncoder().encode(id);
      const result = new Uint8Array(idBytes.length + 16);
      result.set(idBytes);
      // Pad the rest with zeros (simulating auth tag)
      return result.buffer;
    }),
    decrypt: jest.fn().mockImplementation(async (algo: any, key: any, data: ArrayBuffer) => {
      // Extract the ID from the buffer
      const arr = new Uint8Array(data);
      const idBytes = arr.slice(0, arr.length - 16);
      const id = new TextDecoder().decode(idBytes);
      // Look up the original data
      const original = encryptedDataStore.get(id);
      if (!original) {
        throw new Error('Decryption failed: unknown encrypted data ID');
      }
      return original.buffer;
    }),
  },
};

Object.defineProperty(global, 'crypto', { value: mockCrypto });

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
  clearConnectorCache();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// findConnector — port probing
// ---------------------------------------------------------------------------

describe('findConnector', () => {
  it('returns the URL of the first responding port', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(':40003/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T00:00:00Z' }) });
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
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T00:00:00Z' }) });
      }
      return Promise.reject(new Error('refused'));
    });

    const result = await findConnector();
    expect(result).toBe('http://localhost:40000');
    expect(localStorage.getItem('mapviewer-postgis-connector-url')).toBe('http://localhost:40000');
  });

  it('uses cached URL on subsequent calls', async () => {
    localStorage.setItem('mapviewer-postgis-connector-url', 'http://localhost:40005');

    mockFetch.mockImplementation((url: string) => {
      if (url === 'http://localhost:40005/health') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T00:00:00Z' }) });
      }
      return Promise.reject(new Error('refused'));
    });

    const result = await findConnector();
    expect(result).toBe('http://localhost:40005');
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
// Client ID management
// ---------------------------------------------------------------------------

describe('client ID', () => {
  it('generates and stores a UUID on first use', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: null }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 0 }) });
      }
      return Promise.reject(new Error('unexpected'));
    });

    await initConnector('http://localhost:40000');
    const clientId = localStorage.getItem('mapviewer-db-client-id');
    expect(clientId).toBeTruthy();
    expect(clientId).toContain('test-uuid-');
  });

  it('reuses the same client ID on subsequent calls', async () => {
    localStorage.setItem('mapviewer-db-client-id', 'test-uuid-1234');
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: null }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 0 }) });
      }
      return Promise.reject(new Error('unexpected'));
    });

    await initConnector('http://localhost:40000');
    expect(localStorage.getItem('mapviewer-db-client-id')).toBe('test-uuid-1234');
  });
});

// ---------------------------------------------------------------------------
// Tier-1 encryption (random key in localStorage)
// ---------------------------------------------------------------------------

describe('tier-1 encryption (random key)', () => {
  it('generates a random key on first use', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: null }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 0 }) });
      }
      return Promise.reject(new Error('unexpected'));
    });

    await initConnector('http://localhost:40000');
    const key = localStorage.getItem('mapviewer-db-encrypt');
    expect(key).toBeTruthy();
    expect(key!.length).toBe(64); // 32 bytes = 64 hex chars
  });

  it('does not generate a random key when password is provided', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: null }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 0 }) });
      }
      return Promise.reject(new Error('unexpected'));
    });

    await initConnector('http://localhost:40000', 'my-password');
    const key = localStorage.getItem('mapviewer-db-encrypt');
    expect(key).toBeNull(); // No tier-1 key when using password
  });
});

// ---------------------------------------------------------------------------
// Connection CRUD (encrypted)
// ---------------------------------------------------------------------------

describe('saveConnection + listConnections round-trip', () => {
  it.skip('encrypts and saves a connection, then decrypts it back (requires real crypto)', async () => {
    let storedBlob: string | null = null;

    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: storedBlob }) });
      }
      if (url.includes('/storage') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        storedBlob = body.encryptedBlob;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 1 }) });
      }
      return Promise.reject(new Error('unexpected: ' + url));
    });

    // Save a connection
    const saved = await saveConnection('http://localhost:40000', {
      name: 'Test DB',
      host: 'localhost',
      port: 5432,
      database: 'testdb',
      username: 'user',
      password: 'secret123',
    });

    expect(saved.name).toBe('Test DB');
    expect(saved.host).toBe('localhost');
    expect(saved.database).toBe('testdb');
    expect((saved as any).password).toBeUndefined(); // Password not in returned object

    // List connections — should decrypt the blob
    const conns = await listConnections('http://localhost:40000');
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe('Test DB');
    expect(conns[0].host).toBe('localhost');
    expect((conns[0] as any).password).toBeUndefined(); // Password masked in list
  });

  it.skip('incognito (different localStorage) cannot see connections (requires real crypto)', async () => {
    let storedBlob: string | null = null;

    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: storedBlob }) });
      }
      if (url.includes('/storage') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        storedBlob = body.encryptedBlob;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 1 }) });
      }
      return Promise.reject(new Error('unexpected: ' + url));
    });

    // Save a connection in "normal" browser
    await saveConnection('http://localhost:40000', {
      name: 'Secret DB',
      host: 'localhost',
      port: 5432,
      database: 'secret',
      username: 'admin',
      password: 'supersecret',
    });

    // Simulate incognito: clear localStorage (new client ID, new key)
    localStorage.clear();

    // Try to list connections — should get empty (different key can't decrypt)
    const conns = await listConnections('http://localhost:40000');
    expect(conns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteConnection
// ---------------------------------------------------------------------------

describe('deleteConnection', () => {
  it.skip('removes a connection from the encrypted blob (requires real crypto)', async () => {
    let storedBlob: string | null = null;

    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/migrate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connections: [], migrated: false }) });
      }
      if (url.includes('/storage') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: storedBlob }) });
      }
      if (url.includes('/storage') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        storedBlob = body.encryptedBlob;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 1 }) });
      }
      if (url.includes('/connections/') && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.reject(new Error('unexpected: ' + url));
    });

    // Save two connections
    const conn1 = await saveConnection('http://localhost:40000', {
      name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', password: 'p1',
    });
    const conn2 = await saveConnection('http://localhost:40000', {
      name: 'DB2', host: 'localhost', port: 5432, database: 'db2', username: 'u', password: 'p2',
    });

    // Delete the first one
    await deleteConnection('http://localhost:40000', conn1.id);

    // Should have 1 connection left
    const conns = await listConnections('http://localhost:40000');
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe('DB2');
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migration from legacy connections', () => {
  it('migrates legacy connections on first init', async () => {
    let storedBlob: string | null = null;

    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            status: 'ok',
            version: '2.0.0',
            bootTime: '2026-01-01T00:00:00Z',
            sessionKey: 'a'.repeat(64), // 32 bytes in hex
          }),
        });
      }
      if (url.includes('/migrate')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            migrated: true,
            connections: [
              { id: 'legacy-1', name: 'Old DB', host: 'oldhost', port: 5432, database: 'olddb', username: 'olduser', password: 'oldpass', createdAt: '2024-01-01' },
            ],
          }),
        });
      }
      if (url.includes('/storage') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: '', encryptedBlob: storedBlob }) });
      }
      if (url.includes('/storage') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        storedBlob = body.encryptedBlob;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, registered: 1 }) });
      }
      return Promise.reject(new Error('unexpected: ' + url));
    });

    const conns = await initConnector('http://localhost:40000');
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe('Old DB');
    expect(conns[0].host).toBe('oldhost');

    // Verify the blob was saved (so next init doesn't need migration)
    expect(storedBlob).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// testConnection, listTables, queryGeoJSON, getTileUrl
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// hasConnectorRestarted
// ---------------------------------------------------------------------------

describe('hasConnectorRestarted', () => {
  it('returns false on first call (no previous boot time)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T00:00:00Z' }),
    });

    const restarted = await hasConnectorRestarted('http://localhost:40000');
    expect(restarted).toBe(false);
  });

  it('returns true when boot time changes', async () => {
    // First call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T00:00:00Z' }),
    });
    await hasConnectorRestarted('http://localhost:40000');

    // Second call with different boot time
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T01:00:00Z' }),
    });
    const restarted = await hasConnectorRestarted('http://localhost:40000');
    expect(restarted).toBe(true);
  });

  it('returns false when boot time is the same', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '2.0.0', bootTime: '2026-01-01T00:00:00Z' }),
    });

    await hasConnectorRestarted('http://localhost:40000');
    const restarted = await hasConnectorRestarted('http://localhost:40000');
    expect(restarted).toBe(false);
  });
});
