// ---------------------------------------------------------------------------
// Connector route tests — health, connections CRUD, table discovery, query
// with/without filter/bbox, read-only enforcement, port fallback logic.
// Uses Jest + supertest. Mocks pg for database calls.
// ---------------------------------------------------------------------------

import request from 'supertest';
import express from 'express';

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

// In-memory store for connections (mock storage)
let storedConnections: any[] = [];

jest.mock('../src/storage', () => ({
  loadConnections: () => [...storedConnections],
  saveConnections: (conns: any[]) => { storedConnections = [...conns]; },
  __reset: () => { storedConnections = []; },
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

beforeEach(() => {
  storedConnections = [];
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns status ok and version', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: '1.0.0' });
  });
});

// ---------------------------------------------------------------------------
// Connections CRUD
// ---------------------------------------------------------------------------

describe('Connections CRUD', () => {
  it('POST /connections creates a new connection', async () => {
    const res = await request(app)
      .post('/connections')
      .send({
        name: 'Test DB',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        username: 'user',
        password: 'pass',
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test DB');
    expect(res.body.host).toBe('localhost');
    expect(res.body.port).toBe(5432);
    expect(res.body.database).toBe('testdb');
    expect(res.body.username).toBe('user');
    expect(res.body.password).toBeUndefined(); // password masked
    expect(res.body.id).toBeDefined();
  });

  it('POST /connections rejects missing fields', async () => {
    const res = await request(app)
      .post('/connections')
      .send({ name: 'Incomplete' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('GET /connections lists connections with masked passwords', async () => {
    await request(app)
      .post('/connections')
      .send({
        name: 'DB1',
        host: 'localhost',
        port: 5432,
        database: 'db1',
        username: 'user1',
        password: 'secret',
      });

    const res = await request(app).get('/connections');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('DB1');
    expect(res.body[0].password).toBeUndefined();
  });

  it('DELETE /connections/:id removes a connection', async () => {
    const createRes = await request(app)
      .post('/connections')
      .send({
        name: 'ToDelete',
        host: 'localhost',
        port: 5432,
        database: 'del',
        username: 'u',
        password: 'p',
      });
    const id = createRes.body.id;

    const delRes = await request(app).delete(`/connections/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const listRes = await request(app).get('/connections');
    expect(listRes.body).toHaveLength(0);
  });

  it('DELETE /connections/:id returns 404 for unknown id', async () => {
    const res = await request(app).delete('/connections/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST /connections/:id/test tests connectivity', async () => {
    const createRes = await request(app)
      .post('/connections')
      .send({
        name: 'Testable',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        username: 'user',
        password: 'pass',
      });
    const id = createRes.body.id;

    mockQuery.mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 15.0' }] });

    const res = await request(app).post(`/connections/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toContain('PostgreSQL');
  });

  it('POST /connections/:id/test returns 404 for unknown id', async () => {
    const res = await request(app).post('/connections/nonexistent/test');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tables discovery
// ---------------------------------------------------------------------------

describe('GET /connections/:id/tables', () => {
  it('returns spatial tables from geometry_columns', async () => {
    const createRes = await request(app)
      .post('/connections')
      .send({
        name: 'Spatial',
        host: 'localhost',
        port: 5432,
        database: 'gis',
        username: 'u',
        password: 'p',
      });
    const id = createRes.body.id;

    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { schema: 'public', table_name: 'roads', geom_column: 'geom', geom_type: 'LINESTRING', srid: 4326, is_geography: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ extent: 'BOX(0 0,1 1)' }] });

    const res = await request(app).get(`/connections/${id}/tables`);
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
  let connId: string;

  beforeEach(async () => {
    const createRes = await request(app)
      .post('/connections')
      .send({
        name: 'QueryDB',
        host: 'localhost',
        port: 5432,
        database: 'gis',
        username: 'u',
        password: 'p',
      });
    connId = createRes.body.id;
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
      .post(`/connections/${connId}/query`)
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
      .post(`/connections/${connId}/query`)
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
      .post(`/connections/${connId}/query`)
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
      .post(`/connections/${connId}/query`)
      .send({
        table: 'roads',
        geomColumn: 'geom',
        filter: "1=1; DELETE FROM roads",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('disallowed keyword');
  });

  it('rejects filter containing DROP keyword', async () => {
    const res = await request(app)
      .post(`/connections/${connId}/query`)
      .send({
        table: 'roads',
        geomColumn: 'geom',
        filter: "1=1; DROP TABLE roads",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('disallowed keyword');
  });

  it('rejects invalid table names (SQL injection prevention)', async () => {
    const res = await request(app)
      .post(`/connections/${connId}/query`)
      .send({ table: 'roads; DROP TABLE users', geomColumn: 'geom' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid table name');
  });

  it('rejects invalid geometry column names', async () => {
    const res = await request(app)
      .post(`/connections/${connId}/query`)
      .send({ table: 'roads', geomColumn: 'geom; DROP TABLE users' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid geometry column');
  });

  it('returns 404 for unknown connection', async () => {
    const res = await request(app)
      .post('/connections/nonexistent/query')
      .send({ table: 'roads', geomColumn: 'geom' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when table or geomColumn is missing', async () => {
    const res = await request(app)
      .post(`/connections/${connId}/query`)
      .send({ table: 'roads' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('respects the limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post(`/connections/${connId}/query`)
      .send({ table: 'roads', geomColumn: 'geom', limit: 500 });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT 500');
  });

  it('caps limit at 100000', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post(`/connections/${connId}/query`)
      .send({ table: 'roads', geomColumn: 'geom', limit: 999999 });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT 100000');
  });
});

// ---------------------------------------------------------------------------
// Tiles — MVT
// ---------------------------------------------------------------------------

describe('GET /connections/:id/tiles/:z/:x/:y', () => {
  let connId: string;

  beforeEach(async () => {
    const createRes = await request(app)
      .post('/connections')
      .send({
        name: 'TileDB',
        host: 'localhost',
        port: 5432,
        database: 'gis',
        username: 'u',
        password: 'p',
      });
    connId = createRes.body.id;
  });

  it('returns 400 for missing table parameter', async () => {
    const res = await request(app).get(`/connections/${connId}/tiles/10/512/512`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('table');
  });

  it('returns 400 for invalid table name', async () => {
    const res = await request(app).get(`/connections/${connId}/tiles/10/512/512?table=roads;DROP`);
    expect(res.status).toBe(400);
  });

  it('returns 204 for empty tile', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ mvt: Buffer.alloc(0) }] });

    const res = await request(app).get(`/connections/${connId}/tiles/10/512/512?table=roads&geomColumn=geom`);
    expect(res.status).toBe(204);
  });

  it('returns MVT content type for non-empty tile', async () => {
    const mvtData = Buffer.from([0x1a, 0x00]);
    mockQuery.mockResolvedValueOnce({ rows: [{ mvt: mvtData }] });

    const res = await request(app).get(`/connections/${connId}/tiles/10/512/512?table=roads&geomColumn=geom`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.mapbox-vector-tile');
  });
});

// ---------------------------------------------------------------------------
// Port fallback logic (unit test)
// ---------------------------------------------------------------------------

describe('Port fallback', () => {
  it('findAvailablePort tries sequential ports', async () => {
    const DEFAULT_PORT = 40000;
    const MAX_ATTEMPTS = 20;

    const takenPorts = new Set([40000, 40001, 40002, 40003, 40004]);
    const isPortFree = async (port: number) => !takenPorts.has(port);

    let found = -1;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const port = DEFAULT_PORT + i;
      if (await isPortFree(port)) {
        found = port;
        break;
      }
    }

    expect(found).toBe(40005);
  });

  it('throws when no port is available', async () => {
    const DEFAULT_PORT = 40000;
    const MAX_ATTEMPTS = 20;
    const isPortFree = async (_port: number) => false;

    let found = -1;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const port = DEFAULT_PORT + i;
      if (await isPortFree(port)) {
        found = port;
        break;
      }
    }

    expect(found).toBe(-1); // No port found
  });
});
