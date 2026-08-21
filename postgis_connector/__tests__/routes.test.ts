// ---------------------------------------------------------------------------
// Connector route tests — health, storage, registration, migration, table
// discovery, query with/without filter/bbox, read-only enforcement.
// Uses Jest + supertest. Mocks pg for database calls.
// ---------------------------------------------------------------------------

import request from 'supertest';
import express from 'express';
import * as crypto from 'crypto';

// Shared mock query function
const mockQuery = jest.fn();
const mockEnd = jest.fn().mockResolvedValue(undefined);

// Mock pg before importing routes
jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: mockQuery,
      end: mockEnd,
    })),
  };
});

// In-memory store for encrypted blobs and credentials (mock storage)
let storedBlobs: Record<string, string> = {};
let registeredCredentials: any[] = [];
let legacyConnections: any[] | null = null;
const SESSION_KEY = crypto.randomBytes(32).toString('hex');

jest.mock('../src/storage', () => ({
  loadEncryptedBlob: (clientId: string) => storedBlobs[clientId] || null,
  saveEncryptedBlob: (clientId: string, blob: string) => { storedBlobs[clientId] = blob; },
  deleteEncryptedBlob: (clientId: string) => { delete storedBlobs[clientId]; },
  registerCredentials: (creds: any[]) => { registeredCredentials = [...creds]; },
  getCredentials: (id: string) => registeredCredentials.find(c => c.id === id),
  unregisterCredentials: (id: string) => {
    registeredCredentials = registeredCredentials.filter(c => c.id !== id);
  },
  getRegisteredIds: () => registeredCredentials.map(c => c.id),
  clearRegistry: () => { registeredCredentials = []; },
  hasLegacyConnections: () => legacyConnections !== null,
  migrateLegacyConnections: () => {
    const conns = legacyConnections || [];
    legacyConnections = null;
    return conns;
  },
  BOOT_TIME: '2026-01-01T00:00:00Z',
  SESSION_KEY,
  __reset: () => {
    storedBlobs = {};
    registeredCredentials = [];
    legacyConnections = null;
  },
}));

import { healthRouter } from '../src/routes/health';
import { connectionsRouter } from '../src/routes/connections';
import { tablesRouter } from '../src/routes/tables';
import { queryRouter } from '../src/routes/query';
import { tilesRouter } from '../src/routes/tiles';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(healthRouter());
  app.use(connectionsRouter());
  app.use(tablesRouter());
  app.use(queryRouter());
  app.use(tilesRouter());
  return app;
}

const app = createApp();

/**
 * Helper: encrypt credentials with the session key for /register.
 */
function encryptRegistrationPayload(connections: any[]): string {
  const plaintext = JSON.stringify(connections);
  const key = Buffer.from(SESSION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

beforeEach(() => {
  storedBlobs = {};
  registeredCredentials = [];
  legacyConnections = null;
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns status ok, version, bootTime, and sessionKey', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('2.0.0');
    expect(res.body.bootTime).toBeDefined();
    expect(res.body.sessionKey).toBeDefined();
    expect(res.body.sessionKey.length).toBe(64); // 32 bytes = 64 hex chars
  });
});

// ---------------------------------------------------------------------------
// Storage (encrypted blobs)
// ---------------------------------------------------------------------------

describe('Storage API', () => {
  it('GET /storage returns null blob for unknown client', async () => {
    const res = await request(app).get('/storage?clientId=test-client');
    expect(res.status).toBe(200);
    expect(res.body.encryptedBlob).toBeNull();
  });

  it('POST /storage saves an encrypted blob', async () => {
    const res = await request(app)
      .post('/storage')
      .send({ clientId: 'test-client', encryptedBlob: 'encrypted-data-hex' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it was saved
    const getRes = await request(app).get('/storage?clientId=test-client');
    expect(getRes.body.encryptedBlob).toBe('encrypted-data-hex');
  });

  it('POST /storage rejects missing fields', async () => {
    const res = await request(app).post('/storage').send({ clientId: 'test' });
    expect(res.status).toBe(400);
  });

  it('DELETE /storage removes a blob', async () => {
    await request(app)
      .post('/storage')
      .send({ clientId: 'test-client', encryptedBlob: 'data' });

    const delRes = await request(app).delete('/storage?clientId=test-client');
    expect(delRes.status).toBe(200);

    const getRes = await request(app).get('/storage?clientId=test-client');
    expect(getRes.body.encryptedBlob).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registration (encrypted payload)
// ---------------------------------------------------------------------------

describe('Registration API', () => {
  it('POST /register decrypts and stores credentials', async () => {
    const connections = [
      { id: 'conn-1', name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', password: 'p' },
      { id: 'conn-2', name: 'DB2', host: 'localhost', port: 5432, database: 'db2', username: 'u', password: 'p' },
    ];
    const encryptedPayload = encryptRegistrationPayload(connections);

    const res = await request(app)
      .post('/register')
      .send({ encryptedPayload });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registered).toBe(2);
  });

  it('POST /register rejects missing encryptedPayload', async () => {
    const res = await request(app).post('/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('encryptedPayload');
  });

  it('POST /register rejects invalid encrypted payload', async () => {
    const res = await request(app)
      .post('/register')
      .send({ encryptedPayload: 'invalid:data' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('decrypt');
  });

  it('GET /registered lists registered connection IDs', async () => {
    const connections = [
      { id: 'conn-1', name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', password: 'p' },
    ];
    const encryptedPayload = encryptRegistrationPayload(connections);

    await request(app).post('/register').send({ encryptedPayload });

    const res = await request(app).get('/registered');
    expect(res.status).toBe(200);
    expect(res.body.connectionIds).toContain('conn-1');
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('Migration API', () => {
  it('GET /migrate returns empty when no legacy connections', async () => {
    const res = await request(app).get('/migrate');
    expect(res.status).toBe(200);
    expect(res.body.migrated).toBe(false);
    expect(res.body.connections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Connection test & delete (uses in-memory credentials)
// ---------------------------------------------------------------------------

describe('Connection test & delete', () => {
  beforeEach(async () => {
    // Register a connection in memory
    const connections = [
      { id: 'conn-1', name: 'TestDB', host: 'localhost', port: 5432, database: 'testdb', username: 'u', password: 'p' },
    ];
    const encryptedPayload = encryptRegistrationPayload(connections);
    await request(app).post('/register').send({ encryptedPayload });
  });

  it('POST /connections/:id/test tests connectivity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 15.0' }] });

    const res = await request(app).post('/connections/conn-1/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toContain('PostgreSQL');
  });

  it('POST /connections/:id/test returns 404 for unregistered connection', async () => {
    const res = await request(app).post('/connections/nonexistent/test');
    expect(res.status).toBe(404);
  });

  it('DELETE /connections/:id unregisters a connection', async () => {
    const delRes = await request(app).delete('/connections/conn-1');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Verify it's gone
    const testRes = await request(app).post('/connections/conn-1/test');
    expect(testRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tables discovery
// ---------------------------------------------------------------------------

describe('GET /connections/:id/tables', () => {
  beforeEach(async () => {
    const connections = [
      { id: 'conn-1', name: 'Spatial', host: 'localhost', port: 5432, database: 'gis', username: 'u', password: 'p' },
    ];
    const encryptedPayload = encryptRegistrationPayload(connections);
    await request(app).post('/register').send({ encryptedPayload });
  });

  it('returns spatial tables from geometry_columns', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { schema: 'public', table_name: 'roads', geom_column: 'geom', geom_type: 'LINESTRING', srid: 4326, is_geography: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ extent: 'BOX(0 0,1 1)' }] });

    const res = await request(app).get('/connections/conn-1/tables');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].table).toBe('roads');
    expect(res.body[0].geomColumn).toBe('geom');
    expect(res.body[0].geomType).toBe('LINESTRING');
    expect(res.body[0].srid).toBe(4326);
  });

  it('returns 404 for unknown connection', async () => {
    const res = await request(app).get('/connections/nonexistent/tables');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Query — GeoJSON
// ---------------------------------------------------------------------------

describe('POST /connections/:id/query', () => {
  beforeEach(async () => {
    const connections = [
      { id: 'conn-1', name: 'QueryDB', host: 'localhost', port: 5432, database: 'gis', username: 'u', password: 'p' },
    ];
    const encryptedPayload = encryptRegistrationPayload(connections);
    await request(app).post('/register').send({ encryptedPayload });
  });

  it('returns GeoJSON FeatureCollection for a table', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: 'Main St',
          geom: 'binary-data',
          __geojson_geom: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
        },
      ],
    });

    const res = await request(app)
      .post('/connections/conn-1/query')
      .send({ table: 'roads', geomColumn: 'geom' });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('FeatureCollection');
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0].geometry.type).toBe('LineString');
    expect(res.body.features[0].properties.name).toBe('Main St');
  });

  it('applies bbox filter when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/connections/conn-1/query')
      .send({
        table: 'roads',
        geomColumn: 'geom',
        bbox: [138.5, -35.0, 138.7, -34.8],
      });

    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ST_Intersects');
    expect(sql).toContain('ST_MakeEnvelope');
  });

  it('applies user filter when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/connections/conn-1/query')
      .send({
        table: 'roads',
        geomColumn: 'geom',
        filter: "status = 'active'",
      });

    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'active'");
  });

  it('rejects filter containing DELETE keyword', async () => {
    const res = await request(app)
      .post('/connections/conn-1/query')
      .send({
        table: 'roads',
        geomColumn: 'geom',
        filter: "1=1; DELETE FROM roads",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('disallowed keyword');
  });

  it('rejects invalid table names (SQL injection prevention)', async () => {
    const res = await request(app)
      .post('/connections/conn-1/query')
      .send({ table: 'roads; DROP TABLE users', geomColumn: 'geom' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid table name');
  });

  it('returns 404 for unknown connection', async () => {
    const res = await request(app)
      .post('/connections/nonexistent/query')
      .send({ table: 'roads', geomColumn: 'geom' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when table or geomColumn is missing', async () => {
    const res = await request(app)
      .post('/connections/conn-1/query')
      .send({ table: 'roads' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('respects the limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/connections/conn-1/query')
      .send({ table: 'roads', geomColumn: 'geom', limit: 500 });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT 500');
  });

  it('caps limit at 100000', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/connections/conn-1/query')
      .send({ table: 'roads', geomColumn: 'geom', limit: 999999 });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT 100000');
  });
});

// ---------------------------------------------------------------------------
// Tiles — MVT
// ---------------------------------------------------------------------------

describe('GET /connections/:id/tiles/:z/:x/:y', () => {
  beforeEach(async () => {
    const connections = [
      { id: 'conn-1', name: 'TileDB', host: 'localhost', port: 5432, database: 'gis', username: 'u', password: 'p' },
    ];
    const encryptedPayload = encryptRegistrationPayload(connections);
    await request(app).post('/register').send({ encryptedPayload });
  });

  it('returns 400 for missing table parameter', async () => {
    const res = await request(app).get('/connections/conn-1/tiles/10/512/512');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('table');
  });

  it('returns 400 for invalid table name', async () => {
    const res = await request(app).get('/connections/conn-1/tiles/10/512/512?table=roads;DROP');
    expect(res.status).toBe(400);
  });

  it('returns 204 for empty tile', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ mvt: Buffer.alloc(0) }] });

    const res = await request(app).get('/connections/conn-1/tiles/10/512/512?table=roads&geomColumn=geom');
    expect(res.status).toBe(204);
  });

  it('returns MVT content type for non-empty tile', async () => {
    const mvtData = Buffer.from([0x1a, 0x00]);
    mockQuery.mockResolvedValueOnce({ rows: [{ mvt: mvtData }] });

    const res = await request(app).get('/connections/conn-1/tiles/10/512/512?table=roads&geomColumn=geom');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.mapbox-vector-tile');
  });
});
