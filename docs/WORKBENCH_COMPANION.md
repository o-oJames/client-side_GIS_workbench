# Workbench Companion — Design Document

## Overview

The **Workbench Companion** is an optional companion server that enables the MapViewer web application to load PostgreSQL/PostGIS tables and queries as vector layers. It bridges the gap between the browser-based frontend (which cannot speak the PostgreSQL wire protocol) and the user's PostgreSQL database.

**Key characteristics:**
- Runs locally on the user's machine
- Downloaded and launched by the user (like Ollama, Jupyter, or VS Code Remote)
- Exposes a REST API over HTTP on `localhost`
- The web app auto-detects it via port probing
- Zero configuration in the common case

---

## Why a Companion Server?

### The Problem

Browsers cannot connect directly to PostgreSQL because:
1. **No raw TCP sockets** — browsers can only make HTTP requests
2. **No binary protocol** — PostgreSQL uses a custom wire protocol over TCP
3. **Credential exposure** — shipping database credentials in client-side JavaScript is a security risk
4. **CORS** — even if a WASM client existed, cross-origin restrictions would apply

### The Solution

A thin local HTTP server that:
- Speaks PostgreSQL on behalf of the browser
- Manages saved connections securely
- Enforces read-only access
- Returns data in formats the web app already understands (GeoJSON, MVT)

### Why Not Use pgAdmin?

pgAdmin is a GUI application, not an API service. Its internal endpoints are undocumented, unstable, and not designed for external consumption. Using pgAdmin as a bridge would be fragile, insecure, and lack spatial awareness.

### Why Not Use PostgREST Directly?

PostgREST is excellent but limited to **one database per instance**. Supporting multiple databases requires running multiple PostgREST instances behind a reverse proxy, which is complex for end users. The companion server provides a unified interface for managing multiple connections dynamically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  "Add PostgreSQL Layer" dialog                   │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │ Connection: [Production DB ▼]              │  │  │
│  │  │ Table:        [roads ▼]                    │  │  │
│  │  │ Filter:       [status = 'active'        ]  │  │  │
│  │  │ [Add Layer]                                │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
│         │                                               │
│         │ HTTP (localhost:40000)                         │
└─────────┼───────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│  workbench-companion (user's machine)                   │
│                                                         │
│  • Manages saved connections (encrypted)                │
│  • Serves table discovery, GeoJSON queries, MVT tiles   │
│  • Read-only enforcement                                │
│  • Downloaded from the app, run by user                 │
└─────────────────────────────────────────────────────────┘
          │
          │ libpq (TCP)
          ▼
┌─────────────────────────────────────────────────────────┐
│  PostgreSQL + PostGIS (user's database)                 │
└─────────────────────────────────────────────────────────┘
```

---

## User Experience Flow

### 1. First-Time Setup

```
1. User opens the web app (React SPA, runs in browser)

2. User clicks "Add Layer" → "PostgreSQL / PostGIS"

3. App checks: "Is the connector running?"
   → GET http://localhost:40000/health
   
4. Connector not detected → show setup wizard:

   ┌─────────────────────────────────────────┐
   │  PostgreSQL Connector not detected      │
   │                                         │
   │  To connect to PostgreSQL databases,    │
   │  download and run the Connector.        │
   │                                         │
   │  [Download for macOS]  [Windows] [Linux]│
   │                                         │
   │  Or: npm install -g @mapviewer/connector│
   │  Or: docker run ...                     │
   │                                         │
   │  Once running, this dialog will close.  │
   └─────────────────────────────────────────┘

5. User downloads the binary, double-clicks to run

6. Connector starts on http://localhost:40000 (or next available port)

7. App polls GET http://localhost:40000/health → detects it → setup complete
```

### 2. Adding a Connection

```
1. User opens "Add PostgreSQL Layer" dialog

2. Connector is running → dialog shows "Connection Manager"

3. User clicks "New Connection":
   ┌─────────────────────────────────────────┐
   │  New Connection                         │
   │                                         │
   │  Name:        [Production DB        ]   │
   │  Host:        [localhost            ]   │
   │  Port:        [5432                 ]   │
   │  Database:    [gis_prod             ]   │
   │  Username:    [reader               ]   │
   │  Password:    [••••••••             ]   │
   │                                         │
   │  [Test Connection]  [Save]             │
   └─────────────────────────────────────────┘

4. Connector saves credentials (encrypted) to ~/.mapviewer/connections.json

5. User selects "Production DB" from dropdown

6. App calls GET /connections/1/tables → connector queries geometry_columns

7. User picks "roads" table → it becomes a vector layer
```

### 3. Loading a Layer

```
1. User selects table "roads"

2. Optional: user adds a filter (e.g., status = 'active')

3. User clicks "Add Layer"

4. App calls POST /connections/1/query with:
   {
     "table": "roads",
     "filter": "status = 'active'",
     "bbox": [138.5, -35.0, 138.7, -34.8]  // current map extent
   }

5. Connector executes:
   SELECT id, name, status, ST_AsGeoJSON(geom)::json AS geometry
   FROM roads
   WHERE status = 'active'
     AND geom && ST_MakeEnvelope(138.5, -35.0, 138.7, -34.8, 4326)

6. Connector returns GeoJSON FeatureCollection

7. App loads it as a vector layer (reusing existing GeoJSON pipeline)
```

---

## Port Discovery

### Problem

The connector needs a port, but:
- Port 40000 might be taken
- The browser cannot read local files (can't read `~/.mapviewer/connector.port`)
- The browser cannot use Unix sockets (TCP only)

### Solution: Default Port + Fallback Range + Probing

**Connector side:**
```typescript
const DEFAULT_PORT = 40000;
const MAX_ATTEMPTS = 20;  // try 40000..40019

async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = DEFAULT_PORT + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_ATTEMPTS - 1}`);
}

const port = await findAvailablePort();
server.listen(port);

console.log(`✓ MapViewer Connector running on http://localhost:${port}`);
console.log(`  Press Ctrl+C to stop`);
```

**Frontend side:**
```typescript
const BASE_PORT = 40000;
const PORT_RANGE = 20;

export async function findConnector(): Promise<string | null> {
  // Probe all ports in parallel with a short timeout
  const candidates = Array.from({ length: PORT_RANGE }, (_, i) => BASE_PORT + i);
  
  const results = await Promise.all(
    candidates.map(async (port) => {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 500);
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        return res.ok ? port : null;
      } catch {
        return null;
      }
    })
  );
  
  const found = results.find((p) => p !== null);
  return found ? `http://localhost:${found}` : null;
}
```

**Performance:** ~500ms total (parallel probes), not ~10s (sequential).

### Refinements

1. **Cache the discovered port** in `localStorage` to avoid re-probing on every page load
2. **User override** — add a settings field for custom port (edge cases)
3. **Manual paste fallback** — if probing fails, show a text field for manual entry
4. **Port file** — connector writes `~/.mapviewer/connector.port` for CLI tools (not used by browser)

---

## Distribution Options

### 🥇 Option A: Standalone Binary (Recommended)

Compile the Node.js API into a single executable using **Bun**, **pkg**, or **nexe**:

```bash
bun build --compile ./src/server.ts --outfile workbench-companion
```

**Pros:**
- User downloads one file (~30–50 MB)
- Double-click to run (or `./workbench-companion` on Mac/Linux)
- No Node.js, no Docker, no npm required
- Best user experience

**Cons:**
- Requires build tooling to compile
- Larger file size

### 🥈 Option B: npm Package

```bash
npm install -g @mapviewer/workbench-companion
workbench-companion
```

**Pros:**
- Easier to develop and update
- Smaller download

**Cons:**
- Requires Node.js on user's machine
- Worse UX (extra dependency)

### 🥉 Option C: Docker Image

```bash
docker run -p 40000:40000 mapviewer/connector
```

**Pros:**
- Good for technical users, DevOps contexts
- Isolated environment

**Cons:**
- Requires Docker
- More complex setup

### Distribution from the App

The web app should be the distribution point:

```
App → GET https://api.mapviewer.app/connector/latest?os=darwin-arm64
    ← { url: "https://releases.mapviewer.app/connector/v1.2.0/workbench-companion-darwin-arm64", version: "1.2.0" }

User clicks "Download" → browser downloads the binary
User runs it → connector starts on localhost:40000
App polls GET http://localhost:40000/health → detects it → setup complete
```

**Benefits:**
- Users find the connector when they need it
- App knows which connector version it's compatible with
- App can check for updates
- App detects user's OS and offers the right binary

---

## Connector Internals

### Project Structure

```
workbench-companion/
├── src/
│   ├── server.ts          # Express/Fastify HTTP server
│   ├── db.ts              # Connection pool manager (one pool per saved connection)
│   ├── routes/
│   │   ├── health.ts      # GET /health
│   │   ├── connections.ts # CRUD for saved connections
│   │   ├── tables.ts      # GET /connections/:id/tables (geometry_columns)
│   │   ├── query.ts       # POST /connections/:id/query → GeoJSON
│   │   └── tiles.ts       # GET /connections/:id/tiles/:z/:x/:y → MVT
│   └── storage.ts         # Persist connections to ~/.mapviewer/connections.json (encrypted)
├── package.json
└── README.md
```

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Check if connector is running |
| `/connections` | GET | List saved connections |
| `/connections` | POST | Save a new connection |
| `/connections/:id` | DELETE | Remove a connection |
| `/connections/:id/test` | POST | Test connection (ping database) |
| `/connections/:id/tables` | GET | List tables with geometry columns |
| `/connections/:id/query` | POST | Execute read-only SQL → GeoJSON |
| `/connections/:id/tiles/:z/:x/:y` | GET | Serve MVT tiles for a table |

### Key Design Decisions

| Concern | Solution |
|---------|----------|
| **Credentials** | Stored in `~/.mapviewer/connections.json`, encrypted with a machine-derived key (or OS keychain via `keytar`) |
| **Read-only** | Require the DB user to be a read-only role; connector also rejects any SQL not starting with `SELECT` |
| **CORS** | Set `Access-Control-Allow-Origin: *` (localhost only, user controls the port) |
| **Auth** | Optional: require a token generated on first run, stored in `~/.mapviewer/token`, entered into the app once |
| **Port** | Default `40000`, auto-increment if taken (see Port Discovery section) |
| **Lifecycle** | Runs in foreground (user sees logs), or `--daemon` mode for background |

### Security Model

1. **Localhost only** — connector listens on `127.0.0.1`, not `0.0.0.0`
2. **Read-only enforcement** — reject any SQL not starting with `SELECT` (case-insensitive, after trimming whitespace)
3. **Credential encryption** — use OS keychain (`keytar`) or machine-derived key
4. **Optional token auth** — generate a random token on first run, require it in requests
5. **No remote access** — connector is not designed to be exposed to the internet

---

## Frontend Integration

### Changes to the Web App

```
gis_workbench/src/
├── types.ts                    # Add PostgisConnection, PostgisLayerConfig
├── utils/
│   └── companion.ts     # NEW: HTTP client for the connector
├── components/
│   ├── SettingsDialog.tsx      # Add "PostGIS" layer type option
│   ├── PostgisConnectionManager.tsx  # NEW: connection CRUD UI
│   └── AddPostgisLayerForm.tsx       # NEW: table picker + query builder
└── App.css                     # Styles for new components
```

### HTTP Client (`companion.ts`)

```typescript
const CONNECTOR_URL = 'http://localhost:40000';  // or discovered port

export async function isConnectorRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${CONNECTOR_URL}/health`);
    return res.ok;
  } catch { return false; }
}

export async function listConnections(): Promise<Connection[]> {
  const res = await fetch(`${CONNECTOR_URL}/connections`);
  return res.json();
}

export async function listTables(connId: number): Promise<TableInfo[]> {
  const res = await fetch(`${CONNECTOR_URL}/connections/${connId}/tables`);
  return res.json();
}

export async function queryGeoJSON(
  connId: number,
  table: string,
  filter?: string,
  bbox?: BBox
): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`${CONNECTOR_URL}/connections/${connId}/query`, {
    method: 'POST',
    body: JSON.stringify({ table, filter, bbox }),
  });
  return res.json();
}
```

### Layer Type Integration

Add `'postgis'` to `VectorLayerConfig['type']` union in `types.ts`:

```typescript
export interface VectorLayerConfig {
  // ... existing fields
  type: 'geojson' | 'kml' | 'shapefile' | 'mvt' | 'wfs' | 'stac' | 'postgis';
  
  // PostGIS-specific fields
  postgisConnectionId?: number;
  postgisTable?: string;
  postgisFilter?: string;
}
```

---

## Performance Considerations

### BBOX Filtering

Always filter by the current map extent to avoid loading the entire table:

```sql
WHERE geom && ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, :srid)
```

### Geometry Simplification

For large tables, simplify geometries server-side based on zoom level:

```sql
SELECT id, ST_Simplify(geom, :tolerance) AS geom
FROM roads
WHERE ...
```

Tolerance can be computed from the current zoom level.

### Pagination

For very large result sets, paginate:

```sql
SELECT ... LIMIT 10000 OFFSET 0
```

The app can request more features as the user pans/zooms.

### MVT Tiles

For tables with >100k features, use MVT tiles instead of GeoJSON:

```
GET /connections/1/tiles/{z}/{x}/{y}?table=roads
```

The connector executes:

```sql
SELECT ST_AsMVT(q, 'roads', 4096, 'geom') FROM (
  SELECT id, name, geom
  FROM roads
  WHERE geom && ST_TileEnvelope(:z, :x, :y)
) AS q
```

---

## Future Enhancements

1. **Query Builder UI** — GUI for building filters (like QGIS's Query Builder)
2. **SQL editor** — power users can write arbitrary read-only SQL
3. **Spatial functions** — expose `ST_Buffer`, `ST_Intersection`, etc. as layer operations
4. **Editing** — allow editing PostGIS tables (requires write access, complex)
5. **Raster support** — load PostGIS rasters as tile layers
6. **Connection pooling** — reuse connections across multiple layers
7. **Caching** — cache query results to reduce database load
8. **Auto-update** — app checks for connector updates and prompts user

---

## Comparison with Alternatives

| Approach | Multi-DB | Dynamic | Read-Only | GeoJSON | MVT | Effort |
|----------|----------|---------|-----------|---------|-----|--------|
| **pgAdmin** | ❌ | ❌ | ❌ | ❌ | ❌ | High, fragile |
| **PostgREST** | ❌ (1 per instance) | ❌ | ✅ | ✅ | ❌ | Low |
| **pg_tileserv** | ❌ (1 per instance) | ❌ | ⚠️ | ❌ | ✅ | Very low |
| **Custom Node API** | ✅ | ✅ | ✅ | ✅ | ✅ | Medium |
| **Companion Server (this doc)** | ✅ | ✅ | ✅ | ✅ | ✅ | Medium |

---

## Summary

The Workbench Companion is a **companion server** that enables the MapViewer web app to load PostgreSQL/PostGIS data as vector layers. It follows the pattern established by Ollama, Jupyter, and VS Code Remote:

- **Runs locally** on the user's machine
- **Downloaded from the app** (or via npm/Docker)
- **Auto-detected** via port probing
- **Zero configuration** in the common case
- **Secure by design** (localhost-only, read-only, encrypted credentials)

This architecture keeps the web app pure frontend while giving users the QGIS-like experience of managing multiple database connections and loading tables/queries as layers.

---

## Implementation Plan

### Phase 1: Connector MVP (1–2 weeks)
- [ ] Basic HTTP server (Express/Fastify)
- [ ] Connection management (save, list, delete, test)
- [ ] Table discovery (`geometry_columns` query)
- [ ] GeoJSON query endpoint (with BBOX filtering)
- [ ] Port auto-detection (default + fallback range)
- [ ] Credential encryption (OS keychain or machine-derived key)

### Phase 2: Frontend Integration (1 week)
- [ ] Port probing logic in `companion.ts`
- [ ] Connection manager UI
- [ ] Table picker UI
- [ ] Layer creation (GeoJSON pipeline)
- [ ] Setup wizard (download prompt)

### Phase 3: Distribution (1 week)
- [ ] Compile to standalone binary (Bun/pkg)
- [ ] Release download page
- [ ] Auto-update check

### Phase 4: Advanced Features (future)
- [ ] MVT tile endpoint
- [ ] Query builder UI
- [ ] SQL editor
- [ ] Geometry simplification
- [ ] Pagination

---

## References

- [QGIS PostGIS connection model](https://docs.qgis.org/latest/en/docs/user_manual/working_with_vector/vector_properties.html#vector-properties)
- [PostgREST documentation](https://postgrest.org/)
- [pg_tileserv](https://github.com/CrunchyData/pg_tileserv)
- [Ollama architecture](https://ollama.ai/)
- [Jupyter server model](https://jupyter.org/)
