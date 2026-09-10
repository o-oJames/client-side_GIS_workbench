# MapViewer Workbench Companion

A **localhost-only companion server** for the MapViewer web app (the client-side GIS workbench in
`../gis_workbench`). The web app is pure frontend — no back-end, no build-time secrets — so anything
a browser structurally cannot do is delegated to this small Node.js/Express process running on the
user's own machine:

- **PostgreSQL / PostGIS** — discover spatial tables and load them (filtered, viewport-windowed) as
  vector layers. Browsers cannot speak the PostgreSQL wire protocol at all.
- **S3 Cloud Optimized GeoTIFFs** — proxy, pre-sign, validate and region-detect COG requests so
  buckets that do not send CORS headers still work.

| | |
|---|---|
| **Version** | `2.1.0` (`package.json`, reported by `GET /health`) |
| **Runtime** | Node.js + Express 4, `pg` 8 (no ORMs, no WASM, no native addons) |
| **Bind address** | `127.0.0.1` only — never `0.0.0.0` |
| **Ports** | `40000`–`40019` (first free port wins) |
| **Capabilities** | `postgis`, `cog-proxy` (advertised by `GET /health`) |
| **License** | Apache-2.0 |

> **Design record:** [`../docs/WORKBENCH_COMPANION.md`](../docs/WORKBENCH_COMPANION.md) holds the
> rationale, the alternatives analysis, the design-decision log and the threat model. This README is
> the canonical merged guide (usage + architecture + full API reference). The two are maintained
> together — **update both in the same change.**

## Contents

1. [Features](#features)
2. [Why a companion server?](#why-a-companion-server)
3. [Architecture](#architecture)
4. [Quick start](#quick-start)
5. [Usage](#usage)
6. [Discovery, ports and capabilities](#discovery-ports-and-capabilities)
7. [Security model](#security-model)
8. [API reference](#api-reference)
9. [SQL the companion generates](#sql-the-companion-generates)
10. [Data flows](#data-flows)
11. [Performance notes](#performance-notes)
12. [Development](#development)
13. [Building standalone binaries](#building-standalone-binaries)
14. [Status and roadmap](#status-and-roadmap)

---

## Features

| Feature | Description |
|---------|-------------|
| **PostGIS connector** | Save multiple database connections, discover spatial tables, load them as vector layers |
| **Table discovery** | Reads `geometry_columns` **and** `geography_columns`; reports schema, table, geometry column, type, SRID and `ST_EstimatedExtent` |
| **GeoJSON queries** | `ST_AsGeoJSON(ST_Transform(geom, 4326))` feature queries with bbox windowing, attribute filter and row limit |
| **Viewport refresh** | The web app re-queries on `moveend` (300 ms debounce) so panning/zooming streams the visible window only |
| **MVT tiles** | `ST_AsMVT` / `ST_AsMVTGeom` tile endpoint for large tables (server-side ready; see [Status](#status-and-roadmap)) |
| **COG proxy** | Streams S3 COG bytes through localhost with full HTTP `Range` pass-through, bypassing CORS |
| **S3 pre-signing** | AWS Signature V4 pre-signed GET URLs generated server-side (custom endpoints / path-style supported) |
| **Region detection** | Resolves a bucket's region from `x-amz-bucket-region` (works for private buckets — no CORS involved) |
| **COG validation** | `POST /cog/validate` fetches the first 2 MB server-side and checks TIFF/BigTIFF magic + tiling tags (322/323) — endpoint ready; the app still validates in-browser with `utils/cogHelpers.validateCogBuffer` |
| **Encrypted credential store** | PostGIS passwords are encrypted **in the browser** (AES-256-GCM) and kept as opaque blobs on the companion's disk; S3 keys are encrypted the same way and kept on the layer config — the companion never sees either plaintext at rest |
| **In-memory credentials** | Decrypted PostGIS credentials live in a process-memory registry and vanish on restart |
| **Session-key transport** | Registration payloads are encrypted with an ephemeral per-boot session key before they cross localhost HTTP |
| **Capability advertisement** | `GET /health` lists capabilities so the app degrades gracefully against older companions |
| **Restart recovery** | `bootTime` lets the app detect a companion restart (5 s poll) and silently re-register |
| **Legacy migration** | One-time migration of the old machine-key `~/.mapviewer/connections.json` into the client-encrypted format |

---

## Why a companion server?

### The two problems

**PostgreSQL.** A browser cannot connect to PostgreSQL because:

1. **No raw TCP sockets** — browsers only make HTTP(S) requests.
2. **Binary wire protocol** — PostgreSQL speaks its own framed protocol over TCP; there is no
   browser-native client.
3. **Credential exposure** — shipping database passwords inside client-side JavaScript (or
   `localStorage`) is not acceptable.
4. **CORS** — even a hypothetical WASM client would be blocked by cross-origin restrictions.

**S3 COGs.** Reading a Cloud Optimized GeoTIFF means issuing many small HTTP `Range` requests. Most
S3 buckets (and nearly all private ones) do not return `Access-Control-Allow-Origin` for the app's
origin, so `ol/source/GeoTIFF` fails in the browser even though the same URL works from `curl`.

### The solution

A thin local HTTP server that speaks PostgreSQL and S3 on the browser's behalf, holds decrypted
credentials in memory only, enforces read-only queries, and returns data the app already understands
(GeoJSON, MVT, raw TIFF byte ranges). It follows the pattern established by Ollama, Jupyter and
VS Code Remote: **downloaded by the user, run by the user, auto-detected by the web app, zero
configuration in the common case.**

### Why not the existing tools?

| Approach | Multi-DB | Dynamic connections | Read-only | GeoJSON | MVT | COG/CORS proxy | Verdict |
|----------|:--------:|:-------------------:|:---------:|:-------:|:---:|:--------------:|---------|
| **pgAdmin** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | GUI app, not an API; internal endpoints undocumented and unstable |
| **PostgREST** | ❌ (one DB per instance) | ❌ | ✅ | ✅ | ❌ | ❌ | Excellent, but N databases means N instances behind a reverse proxy |
| **pg_tileserv** | ❌ (one DB per instance) | ❌ | ⚠️ | ❌ | ✅ | ❌ | Tiles only, single connection, no COG story |
| **Companion server (this)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | One process, connections managed at runtime from the UI |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Browser — React SPA (gis_workbench)                                         │
│                                                                              │
│   Add Vector Layer ▸ PostGIS          Add Raster Layer ▸ COG (S3)            │
│   ┌────────────────────────────┐      ┌────────────────────────────────┐     │
│   │ PostgisConnectionManager   │      │ resolveCogUrl()                │     │
│   │ AddPostgisLayerForm        │      │  decrypt creds → detect region │     │
│   │  connection ▸ table ▸ geom │      │  → presign → proxy URL         │     │
│   │  filter / SRID / Add Layer │      └────────────────────────────────┘     │
│   └────────────────────────────┘                                             │
│            │ utils/companion.ts — discovery, crypto, HTTP client             │
│            │ (credentials encrypted here; localStorage keys per profile)     │
└────────────┼─────────────────────────────────────────────────────────────────┘
             │ HTTP  http://localhost:40000 … 40019   (CORS: *)
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  workbench-companion  (user's machine, binds 127.0.0.1)                      │
│                                                                              │
│   server.ts     Express app · port scan 40000-40019 · CORS · graceful stop   │
│   storage.ts    session key · in-memory credential registry · blob store     │
│   db.ts         one pg.Pool per connection (max 5, lazy, disposable for test)│
│   routes/       health · connections · tables · query · tiles · cog ·        │
│                 cogCredentials                                               │
│                                                                              │
│   ~/.mapviewer/clients/{clientId}.json                  (PostGIS blob, 0600) │
│   ~/.mapviewer/clients/{clientId}/cog-credentials.json  (S3 blobs,   0600)   │
└───────┬──────────────────────────────────────────────────────┬───────────────┘
        │ libpq / TCP (pg)                                     │ HTTPS + Range
        ▼                                                      ▼
┌───────────────────────────────┐            ┌─────────────────────────────────┐
│ PostgreSQL + PostGIS          │            │ S3 (AWS or compatible endpoint) │
│ geometry_columns, ST_AsGeoJSON│            │ Cloud Optimized GeoTIFF objects │
│ ST_AsMVT, ST_TileEnvelope     │            │                                 │
└───────────────────────────────┘            └─────────────────────────────────┘
```

### Server-side components

| File | Lines | Responsibility |
|------|-------|----------------|
| `src/server.ts` | ~100 | Express app, JSON body parsing, CORS middleware, port scan (`40000`–`40019`), bind `127.0.0.1`, `SIGINT`/`SIGTERM` graceful shutdown (closes HTTP server, ends all pools) |
| `src/storage.ts` | ~215 | Per-boot `SESSION_KEY` (32 random bytes, hex) and `BOOT_TIME`; in-memory credential registry (`register` / `get` / `unregister` / `getRegisteredIds` / `clear`); per-client encrypted-blob file I/O (`0700` dirs, `0600` files, `clientId` sanitised against path traversal); legacy machine-key migration |
| `src/db.ts` | ~75 | `pg.Pool` per connection id, created lazily (`max: 5`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`), `removePool()` on delete, `shutdownAll()` on exit, `testConnection()` on a throwaway pool (`SELECT version()`) |
| `src/routes/health.ts` | ~30 | `GET /health` — `status`, `version`, `bootTime`, `sessionKey`, `capabilities` |
| `src/routes/connections.ts` | ~180 | Encrypted-blob storage, session-key registration, registered-id listing, legacy migration, connection test, unregister |
| `src/routes/tables.ts` | ~90 | Spatial table discovery from `geometry_columns` + `geography_columns` (+ estimated extent per table) |
| `src/routes/query.ts` | ~130 | GeoJSON feature query: identifier validation/quoting, filter keyword blacklist, bbox window, limit cap |
| `src/routes/tiles.ts` | ~90 | MVT tile endpoint (`ST_AsMVT`, 4096 extent, 256 buffer, clipped) |
| `src/routes/cog.ts` | ~490 | AWS SigV4 pre-signing, URL building, streaming proxy with `Range` pass-through, COG header validation (TIFF/BigTIFF + tiling tags), bucket region detection |
| `src/routes/cogCredentials.ts` | ~95 | Opaque per-client COG credential blob store (load / save / delete) |
| `__tests__/routes.test.ts` | ~460 | Jest + supertest route suite (`pg` and `storage` mocked) |

### Frontend counterparts (`../gis_workbench/src`)

| File | Responsibility |
|------|----------------|
| `types.ts` | `PostgisConnection`, `PostgisTableInfo`, `'postgis'` in the `VectorLayerConfig['type']` union plus `postgisConnectionId` / `postgisTable` / `postgisGeomColumn` / `postgisFilter` / `postgisSrid` / `postgisDisconnected` |
| `utils/companion.ts` (~800 lines) | The whole client: port probing + URL cache, `clientId` and two-tier key management, AES-GCM encrypt/decrypt, session-key registration, restart detection, connection CRUD, `listTables`, `queryGeoJSON`, `getTileUrl`, and the COG helpers `resolveCogUrl()` actually uses (`companionDetectS3Region`, `companionPresignS3Url`, `companionProxyUrl`). Also implemented and unit-tested but **with no caller yet**: `companionValidateCog`, `companionSaveCogCredentials` / `…Load…` / `…Delete…`, `reregisterConnections`, `migrateToPasswordKey` |
| `utils/cogCredentials.ts` | Encrypts/decrypts `cogAccessKeyId`, `cogSecretAccessKey`, `cogSessionToken` into the layer config's `cogCredentialsEncrypted` blob (`iv:authTag:ciphertext`) — plaintext keys never reach `localStorage` |
| `utils/rasterLayerFactory.ts` | `resolveCogUrl()` routes S3 COGs through the companion when the `cog-proxy` capability is present, otherwise falls back to browser-side resolution |
| `utils/layerRestore.ts` | Rebuilds `postgis` layers on reload; a layer whose companion is gone is restored empty and flagged `postgisDisconnected: true` |
| `components/MapPage.tsx` | Companion discovery on mount, `initConnector()`, 5 s restart poll, `handleAddPostgisLayer` (bbox query + `moveend` refresh), `handleReconnectPostgisLayer`, listener cleanup on layer removal |
| `components/AddPostgisLayerForm.tsx` | Connection ▸ table ▸ geometry-column pickers, filter, SRID override, layer name, Add Layer |
| `components/PostgisConnectionManager.tsx` | Connection CRUD UI (name/host/port/database/username/password), test, delete-with-confirm |
| `components/AdvancedSettingsDialog.tsx` | "PostGIS Connections" section — manage saved connections outside the add-layer flow |
| `components/PostgisSetupWizard.tsx` | Download / install wizard that polls `findConnector()` every 2 s (built and unit-tested; not yet mounted — see [Status](#status-and-roadmap)) |
| `components/AddVectorLayerForm.tsx` | `postgis` source type; renders the form, or an inline "Workbench Companion not detected" error |
| `components/SettingsDialog.tsx` | `Disconnected` chip + `↻` reconnect button on PostGIS layer rows |
| `App.css` | `.postgis-wizard*`, `.postgis-conn-form-grid`, `.postgis-add-form-*`, `.settings-layer-disconnected`, `.settings-layer-reconnect-btn` |

---

## Quick start

### 1. From source (what this repo supports today)

```bash
cd workbench-companion
npm install
npm run build      # tsc → dist/
npm start          # node dist/server.js → http://localhost:40000

# or, without building:
npm run dev        # ts-node src/server.ts
```

Expected output:

```
✓ MapViewer Workbench Companion running on http://localhost:40000
  Press Ctrl+C to stop
```

### 2. Standalone binary

Compile with Bun (no Node.js required on the target machine):

```bash
bun build --compile ./src/server.ts --outfile workbench-companion
./workbench-companion
```

A prebuilt `workbench-companion-windows.exe` is committed in this directory; rebuild it from the
current `src/` before distributing (see [Building standalone binaries](#building-standalone-binaries)).

### 3. npm / Docker (packaging is defined, publishing is not)

```bash
npm install -g mapviewer-workbench-companion   # package name from package.json — not yet published
workbench-companion

docker run -p 40000:40000 mapviewer/workbench-companion   # image not yet published
```

The in-app setup wizard currently links to `https://github.com/mapviewer/connector/releases` and
quotes `@mapviewer/workbench-companion`; both are placeholders until a release channel exists.

### 4. Verify

```bash
curl -s http://localhost:40000/health
# {"status":"ok","version":"2.1.0","bootTime":"…","sessionKey":"<64 hex>","capabilities":["postgis","cog-proxy"]}
```

### 5. Open the web app

The app probes ports `40000`–`40019` in parallel on mount, caches the winner in
`localStorage["mapviewer-companion-url"]`, loads and decrypts your connection blob, and re-registers
the credentials with the companion. Nothing else to configure.

---

## Usage

### PostGIS

1. **Start the companion** and open the web app.
2. **Add a connection** — either *Add Vector Layer ▸ PostGIS* (the form opens on the connection
   manager) or *Advanced settings ▸ PostGIS Connections*:

   | Field | Notes |
   |-------|-------|
   | Name | Label shown in dropdowns |
   | Host / Port | Defaults `localhost` / `5432` |
   | Database / Username / Password | All required; **Test Connection** runs `SELECT version()` and shows the server version |

   The password is encrypted in the browser (AES-256-GCM) before it is stored; the companion keeps
   the ciphertext on disk and the plaintext in memory only.
3. **Pick a table** — the dropdown is populated from `geometry_columns` + `geography_columns` and
   labels each entry `schema.table (geomType, SRID:4326)`. Selecting a table auto-fills the
   **geometry column** (an editable text field, not a dropdown) and the layer name.
4. **Optionally filter** — a raw SQL `WHERE` fragment, e.g. `status = 'active'`. Write-only keywords
   (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXEC`,
   `EXECUTE`) are rejected; note the check is a word-boundary blacklist, so a literal such as
   `name = 'Delete me'` is refused too.
5. **Optionally override the SRID** — used as the SRID of the bbox envelope sent with the query.
6. **Add Layer** — the app queries the current map extent and adds the result as an ordinary GeoJSON
   vector layer. Panning and zooming re-queries the new extent (`moveend`, 300 ms debounce, up to
   10 000 features per request), so large tables stay responsive.
7. **Reload / companion restart** — PostGIS layers are rebuilt from their saved config. If the
   companion is unavailable the layer row shows a **Disconnected** chip with a **↻** reconnect
   button; clicking it re-runs the query and clears the flag.

### S3 Cloud Optimized GeoTIFFs

Add a raster layer with COG source **S3** and fill in bucket / object key (plus region or a custom
endpoint, and credentials for private buckets). With the companion running:

- the bucket **region is detected** server-side when it was not supplied (`x-amz-bucket-region`);
- the object URL is **pre-signed** server-side (AWS SigV4) when credentials are supplied;
- every tile/Range request is **streamed through `GET /cog/proxy`**, so CORS never applies;
- credentials are **encrypted in the browser** at form-submit time (`cogCredentialsEncrypted` on the
  layer config) and `saveSettings()` strips any plaintext credential fields, so AWS keys never reach
  `localStorage`. Because stripping is not re-encrypting, a pre-encryption legacy layer keeps working
  only until the next save — re-enter the credentials to produce a blob.

The companion additionally offers `POST /cog/validate` (server-side header check: first 2 MB,
TIFF/BigTIFF magic, `TileWidth`/`TileLength`) and a per-client COG credential blob store
(`/cog/credentials`). Both are implemented but the app does not call them yet — header validation
happens in-browser and credentials live only in the encrypted layer config.

Without the companion the app falls back to browser-side resolution, which works for public buckets
that send permissive CORS headers and fails otherwise (the error is rewritten into actionable
guidance by `rasterLayerFactory`).

---

## Discovery, ports and capabilities

### Port selection (server)

`src/server.ts` scans for a free port and binds the first one:

```typescript
const DEFAULT_PORT = 40000;
const MAX_ATTEMPTS = 20;               // 40000 … 40019

async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = DEFAULT_PORT + i;
    if (await isPortFree(port)) return port;   // net.createServer().listen(port, '127.0.0.1')
  }
  throw new Error(`No free port in range ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_ATTEMPTS - 1}`);
}
```

### Port discovery (browser)

`utils/companion.ts` probes all 20 ports **in parallel** with a 500 ms `AbortController` timeout, so
detection costs ~500 ms worst case rather than ~10 s sequentially:

```typescript
const cached = localStorage.getItem('mapviewer-companion-url');   // try the cache first
if (cached && (await fetch(`${cached}/health`, { signal })).ok) return cached;

const results = await Promise.all(
  Array.from({ length: 20 }, (_, i) => 40000 + i)
    .map(async (port) => (await safeFetch(`http://localhost:${port}/health`)) ? port : null)
);
```

A cached URL that stops responding is evicted and the full probe runs again.

### Capabilities

`GET /health` advertises `capabilities: ['postgis', 'cog-proxy']`. The COG path in
`rasterLayerFactory.resolveCogUrl()` only routes through the companion when
`companionHasCapability('cog-proxy')` is true, so an older companion that only speaks PostGIS is
still usable and the app falls back to direct browser fetches for COGs.

### Restart detection

`/health` also returns `bootTime` and a fresh `sessionKey` per process. `MapPage` polls
`hasConnectorRestarted()` every 5 s; when `bootTime` changes it re-runs `initConnector()`, which
re-decrypts the stored blob and re-registers the credentials under the new session key. Requests
that hit an unregistered connection return `404` with the message *"The connector may have restarted
— please reload the app."*

### Lifecycle

The companion runs in the foreground and logs each proxied COG URL and every error. `SIGINT` /
`SIGTERM` close the HTTP server, end all `pg.Pool`s and exit. There is no daemon mode and no PID
file — the user owns the process.

---

## Security model

The guiding rule: **the browser owns the plaintext, the companion owns only ciphertext and
short-lived memory.**

### Two-tier client-side encryption

| Tier | Key source | When |
|------|-----------|------|
| **1** | Random 256-bit key, `localStorage["mapviewer-db-encrypt"]` | Default — no app-lock password set |
| **2** | PBKDF2(app-lock password, salt `mapviewer-db-v1:{clientId}`, 100 000 iterations, SHA-256) → AES-GCM-256 | App-lock password set — used automatically by `initConnector()`/`saveConnection()`. The tier-1 → tier-2 upgrade helper `migrateToPasswordKey()` exists but is **not wired** (see [Known gaps](#known-gaps)) |

Both tiers encrypt with AES-GCM. The at-rest blob is JSON `{ iv, authTag, ciphertext }` (hex); the
registration payload sent to the companion is the compact `iv:authTag:ciphertext` hex string.

Note that **S3 COG credentials currently always use tier 1**: both callers of `getCogEncryptionKey()`
(`AddRasterLayerForm` on submit, `rasterLayerFactory` on load) omit the app-lock password argument,
while the PostGIS paths do pass it.

### Per-client isolation

Each browser profile generates a UUID `clientId` (`localStorage["mapviewer-db-client-id"]`) and gets
its own files on disk, so two profiles — or a profile and an incognito window — never see each
other's connections. `clientId` is sanitised (`[^A-Za-z0-9_-]` stripped) before it is used in a path.

### Session key

`storage.ts` generates a 32-byte random `SESSION_KEY` at boot and publishes it on `/health`. The
browser encrypts the `POST /register` payload with it, so credentials do not travel as plaintext over
localhost HTTP, and a companion restart invalidates every previously registered credential.

### On-disk layout

```
~/.mapviewer/                                     0700
├── clients/                                      0700
│   ├── {clientId}.json                           0600  PostGIS connections, browser-encrypted
│   └── {clientId}/
│       └── cog-credentials.json                  0600  { [layerId]: iv:authTag:ciphertext }
└── connections.json                              legacy (machine-key encrypted) — consumed and
                                                  deleted by GET /migrate on first run
```

Nothing on disk is readable by the companion itself: it stores and returns the blobs verbatim and
never holds the client key.

### Read-only enforcement

There is **no raw-SQL endpoint**. `POST /connections/:id/query` accepts a table name, a geometry
column, an optional filter fragment, bbox, SRID and limit, and defends them as follows:

- **Identifiers** must match `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$` (optional
  `schema.table`) and are then double-quoted with `"` escaping — never interpolated raw.
- **Filters** are rejected if they contain a write/DDL keyword as a whole word (list above).
- **Limits** default to 10 000 and are capped at 100 000 rows.
- **Bbox** values are bound as query parameters (`$1…$5`), not concatenated.

Use a read-only database role for defence in depth — the companion's checks are a guard rail, not a
sandbox.

### Network posture and caveats

- Binds `127.0.0.1`; not reachable from the network. There is **no token auth**: any local process,
  and any web page you visit (via CORS `*`), can call the API. What they can obtain is limited —
  connection *ids*, table metadata, and query results for credentials *your* browser registered in
  this companion session — but treat "companion running" as "local read access to those databases".
- `GET /cog/proxy?url=…` is an **open HTTP(S) proxy** for the local machine: it will stream any
  `http(s)` URL it is given. That is what makes CORS-blocked COGs work, and it is also why the
  listener must stay on loopback.
- `GET /health` exposes the session key by design (the browser needs it to register). It is only
  meaningful for the current boot.
- Encrypted blobs are only as strong as the tier-1 `localStorage` key when no app-lock password is
  set; setting the app-lock password upgrades the store to tier 2.

### Threat model summary

| Protected against | Not protected against |
|-------------------|-----------------------|
| Credentials at rest on disk (AES-256-GCM, browser-held keys) | Another process reading browser `localStorage` (tier 1) |
| Credentials in transit over localhost HTTP (session-key encryption) | Malicious local user/process calling the API while the companion runs |
| Accidental writes / DDL through the query endpoint (identifier + keyword validation, no raw SQL) | Deliberate SQL injection inside a *filter* that only reads data (the filter is passed through as SQL) |
| Cross-profile credential leakage (per-`clientId` storage) | DNS-rebinding / any-origin web pages reaching the loopback API (no token, CORS `*`) |
| COG plaintext keys in `localStorage` (encrypted at form-submit time) | A compromised S3 endpoint or a URL you chose to proxy |

---

## API reference

Base URL: `http://localhost:40000` (or the discovered port). All responses are JSON except MVT tiles
and proxied COG bytes. CORS: `Access-Control-Allow-Origin: *`, methods `GET, POST, DELETE, OPTIONS`,
header `Content-Type`; `OPTIONS` returns `204`.

### Health

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness + capability advertisement |

```jsonc
// 200
{
  "status": "ok",
  "version": "2.1.0",
  "bootTime": "2026-09-10T01:02:03.456Z",   // changes on every restart
  "sessionKey": "<64 hex chars>",           // AES-256 key for POST /register
  "capabilities": ["postgis", "cog-proxy"]
}
```

### Credential storage (opaque, per client)

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /storage?clientId=…` | — | `{ clientId, encryptedBlob: string \| null }` · `400` missing `clientId` |
| `POST /storage` | `{ clientId, encryptedBlob }` | `{ ok: true }` · `400` missing fields |
| `DELETE /storage?clientId=…` | — | `{ ok: true }` · `400` missing `clientId` *(not used by the web app yet)* |

### Registration & migration

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /register` | `{ encryptedPayload }` — `iv:authTag:ciphertext` hex, AES-256-GCM under the session key, plaintext = `ConnectionCredentials[]` | `{ ok: true, registered: n }` · `400` missing field or decryption failure (stale session key ⇒ restart the app) |
| `GET /registered` | — | `{ connectionIds: string[] }` — metadata only, never credentials *(not used by the web app yet)* |
| `GET /migrate` | — | `{ connections: […], migrated: boolean }` — decrypts the legacy machine-key file **once**, returns plaintext for the browser to re-encrypt, then deletes the legacy file |

Registered credential shape (`ConnectionCredentials`): `{ id, name, host, port, database, username,
password, createdAt }`. Entries missing `id`, `host`, `database`, `username` or `password` are
dropped; `port` defaults to `5432`.

### Connections

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `POST /connections/:id/test` | Connectivity check on a throwaway pool (`SELECT version()`) | `{ ok: true, version }` · `400 { ok:false, error }` · `404` not registered |
| `DELETE /connections/:id` | Unregister credentials and end the pool | `{ ok: true }` |

Connection **creation and listing happen in the browser** (encrypt → `POST /storage` →
`POST /register`); there is deliberately no `GET /connections` or `POST /connections`.

### PostGIS data

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /connections/:id/tables` | — | `TableInfo[]` · `404` not registered · `500` DB error |
| `POST /connections/:id/query` | `{ table, geomColumn, filter?, bbox?: [xmin,ymin,xmax,ymax], srid?, limit? }` | GeoJSON `FeatureCollection` · `400` missing/invalid identifier or disallowed keyword · `404` · `500` |
| `GET /connections/:id/tiles/:z/:x/:y` | `?table=…&geomColumn=geom` | `application/vnd.mapbox-vector-tile` bytes · `204` empty tile · `400` bad params · `404` · `500` |

```jsonc
// TableInfo
{
  "schema": "public",
  "table": "roads",
  "geomColumn": "geom",
  "geomType": "MultiLineString",
  "srid": 4326,
  "isGeography": false,
  "estimatedExtent": "BOX(138.4 -35.1,138.8 -34.7)"   // null when ANALYZE has not run
}
```

`POST /query` returns every non-geometry column as a feature property; the generated
`__geojson_geom` helper column and the geometry column itself are stripped.

### COG proxy & S3

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /cog/proxy?url=…` | Absolute `http(s)` URL | Upstream bytes, `Range`/`Accept-Ranges` forwarded upstream and `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, `Cache-Control`, `Expires` forwarded back, plus `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges` · `400` missing/invalid/non-HTTP(S) URL · `502` upstream failure · `504` upstream timeout (60 s) · client disconnect aborts the upstream request |
| `POST /cog/presign` | `{ bucket, objectKey, region?, endpoint?, accessKeyId?, secretAccessKey?, sessionToken?, expiresIn?=3600, method?='GET' }` | `{ url, expiresIn }` · `400` missing `bucket`/`objectKey` · `500` signing failure |
| `POST /cog/validate` *(not used by the web app yet)* | same S3 config (credentials optional — pre-signs when present) | `{ isTiff, isBigTiff, isCog, fileSize, hasTiling }`, or `{ isTiff:false, isCog:false, fileSize, error }` for non-TIFF / too-small input · `4xx` propagated from S3 · `500` |
| `POST /cog/detect-region` | `{ bucket, endpoint? }` | `{ region }` · `{ region: null, error? }` when undetectable or a custom endpoint is given |

`isCog` requires both tiling tags (`322 TileWidth`, `323 TileLength`) in the first IFD **and** an IFD
offset inside the first megabyte. `fileSize` is parsed from the `Content-Range` total.

### COG credential blobs *(endpoints ready; the web app does not call them yet)*

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /cog/credentials?clientId=…` | — | `{ clientId, credentials: { [layerId]: blob } \| null }` · `400` missing `clientId` |
| `POST /cog/credentials` | `{ clientId, credentials }` | `{ ok: true }` · `400` missing fields · `500` write failure |
| `DELETE /cog/credentials?clientId=…` | — | `{ ok: true }` · `400` missing `clientId` |

Stored at `~/.mapviewer/clients/{clientId}/cog-credentials.json` (mode `0600`). The companion never
parses the blobs.

### Error conventions

| Status | Meaning |
|--------|---------|
| `400` | Missing/invalid parameter, rejected filter keyword, undecryptable registration payload |
| `404` | Connection id is not in the in-memory registry — usually a companion restart; reload the app |
| `500` | Database or S3 error; `error` carries the driver message (and `detail` for COG routes) |
| `502` / `504` | COG proxy upstream failure / timeout |

---

## SQL the companion generates

### Table discovery (`GET /connections/:id/tables`)

```sql
SELECT f_table_schema AS schema, f_table_name AS table_name,
       f_geometry_column AS geom_column, type AS geom_type, srid, false AS is_geography
FROM geometry_columns
UNION ALL
SELECT f_table_schema, f_table_name, f_geography_column, type, srid, true
FROM geography_columns
ORDER BY schema, table_name;

-- then, per row (failure tolerated → estimatedExtent: null)
SELECT ST_EstimatedExtent($1, $2, $3)::text AS extent;
```

### GeoJSON query (`POST /connections/:id/query`)

```sql
SELECT *, ST_AsGeoJSON(ST_Transform("<geomColumn>", 4326))::json AS __geojson_geom
FROM "<table>"
WHERE ST_Intersects(
        "<geomColumn>",
        ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, $5), ST_SRID("<geomColumn>"))
      )                     -- only when bbox is supplied; $5 is the envelope SRID (default 4326)
  AND (<filter>)            -- only when a filter is supplied
LIMIT <min(limit ?? 10000, 100000)>;
```

Geometries always come back in EPSG:4326; OpenLayers reprojects them to the map's EPSG:3857 view.

### MVT tile (`GET /connections/:id/tiles/:z/:x/:y`)

```sql
SELECT ST_AsMVT(q, $1, 4096, 'geom') AS mvt
FROM (
  SELECT *,
         ST_AsMVTGeom(ST_Transform("<geomColumn>", 3857),
                      ST_TileEnvelope($2, $3, $4), 4096, 256, true) AS geom
  FROM "<table>"
  WHERE ST_Intersects(ST_Transform("<geomColumn>", 3857), ST_TileEnvelope($2, $3, $4))
) AS q;
```

`$1` = layer name (the table), `$2…$4` = `z/x/y`. Empty results return HTTP `204` so OpenLayers
treats the tile as blank rather than an error.

---

## Data flows

### App start → registered connections

```
1  findConnector()          probe 40000…40019 in parallel (cache first) → baseUrl
2  GET /health              → bootTime, sessionKey, capabilities
3  GET /migrate             → legacy connections? re-encrypt with the client key, POST /storage
4  GET /storage?clientId    → encrypted blob
5  browser                  AES-GCM decrypt with tier-1 or tier-2 key → FullConnection[]
6  POST /register           payload encrypted with the session key → in-memory registry
7  MapPage                  setConnectorUrl(); every 5 s hasConnectorRestarted() → repeat 2, 4-6
```

### Add a PostGIS layer

```
AddVectorLayerForm (type: postgis)
  └─ AddPostgisLayerForm
       ├─ listConnections()            (initConnector → decrypted, passwords stripped)
       ├─ GET /connections/:id/tables  → table + geometry-column dropdowns
       └─ Add Layer
            └─ MapPage.handleAddPostgisLayer
                 ├─ bbox = view extent transformed 3857 → 4326
                 ├─ POST /connections/:id/query { table, geomColumn, filter, bbox, srid, limit:10000 }
                 ├─ GeoJSON → VectorSource → VectorLayer (random palette, lineWidth 2)
                 ├─ layer.postgisMeta = { connectorUrl, connectionId, table, geomColumn, filter, srid, format }
                 └─ map.on('moveend') → 300 ms debounce → re-query → source.clear() + addFeatures()
                      (removed with the layer via layer.postgisCleanup → unlistenByKey)
```

### Reload / reconnect

```
loadSettings() → layerRestore: for each type:'postgis' config
   ├─ companion reachable → queryGeoJSON → rebuild source, postgisDisconnected: false
   └─ companion gone      → empty source, postgisDisconnected: true
                            SettingsDialog shows "Disconnected" + ↻
                            onReconnectPostgisLayer(layerId) → re-query → flag cleared
```

### S3 COG resolution (`rasterLayerFactory.resolveCogUrl`)

```
cogSource === 'file' → session blob URL from cogFileRegistry (never persisted)
cogSource === 's3'   →
   1  decrypt cogCredentialsEncrypted with getCogEncryptionKey()
   2  findConnector() + companionHasCapability('cog-proxy')
   3  no region & no endpoint → POST /cog/detect-region
   4  credentials present     → POST /cog/presign  → GET /cog/proxy?url=<signed>
      public bucket           → buildS3HttpsUrl() → GET /cog/proxy?url=<public>
   5  no companion            → browser-side resolveS3CogUrl() (may fail on CORS)
The resulting URL is handed to ol/source/GeoTIFF, whose Range requests stream through the proxy.
```

---

## Performance notes

- **Always window by bbox.** The app sends the current view extent with every query and re-queries on
  `moveend`, so a 5 M-row table costs one viewport of features, not a full scan. PostGIS uses the
  spatial index via `ST_Intersects`.
- **Row limits.** 10 000 by default, 100 000 hard cap — a runaway filter degrades to a truncated
  layer rather than a hung browser.
- **Connection pools.** One `pg.Pool` per connection (`max: 5`), created on first use, ended when the
  connection is deleted or the process exits.
- **Streaming proxy.** `/cog/proxy` pipes the upstream response instead of buffering it, forwards
  `Range` unchanged, and aborts upstream when the browser disconnects — COG tile loading keeps its
  usual byte-range profile.
- **Estimated extents** are read from the planner statistics (`ST_EstimatedExtent`), which is free
  after `ANALYZE` and returns `null` instead of erroring when statistics are missing.
- **Not yet exploited:** the MVT endpoint (better than GeoJSON above ~100 k features), zoom-dependent
  `ST_Simplify`, keyset pagination, and response caching. See [Status and roadmap](#status-and-roadmap).

---

## Development

### Scripts

```bash
npm run build   # tsc → dist/  (required before npm start)
npm start       # node dist/server.js
npm run dev     # ts-node src/server.ts
npm test        # jest --forceExit --detectOpenHandles
```

`dist/` is git-ignored (`*/dist/` in the root `.gitignore`), so a fresh clone must run
`npm run build` before `npm start`.

### Server tests

`__tests__/routes.test.ts` builds an Express app from the real routers with `pg` and `../src/storage`
mocked, and drives it with supertest:

| Group | Covered |
|-------|---------|
| `GET /health` | status, version, `bootTime`, `sessionKey` |
| Storage | load/save/delete blob, `400` on missing fields, `null` for an unknown client |
| Registration | decrypt-and-store, missing payload, invalid payload, `GET /registered` |
| Migration | empty result when no legacy file exists |
| Connections | test (ok + `404` when unregistered), delete/unregister |
| Tables | discovery rows, `404` for unknown connection |
| Query | GeoJSON result, bbox applied, filter applied, `DELETE` keyword rejected, injection-shaped table name rejected, missing fields, limit respected, limit capped at 100 000 |
| Tiles | `400` missing/invalid table, `204` empty tile, MVT content type |

### Web-app tests (Vitest, in `../gis_workbench`)

| Suite | Covered |
|-------|---------|
| `src/utils/companion.test.ts` | port probing (first responder, none, cache write/read/evict, all 20 ports in parallel), `clientId` generation/reuse, tier-1 vs tier-2 key selection, save/list/delete round-trip, legacy migration, `testConnection`, `listTables`, `queryGeoJSON` (payload + error path), `getTileUrl` (template + URL encoding), `hasConnectorRestarted` (first call / changed / unchanged) |
| `src/PostgisConnector.test.tsx` | `PostgisSetupWizard`: polling, detection callback, close |
| `src/PostgisConnectionManager.test.tsx` | empty state, listing, details, new-connection form, save, delete-with-confirm, test result, select |
| `src/PostgisLayer.test.tsx` | `AddPostgisLayerForm`: manager-first entry, connection dropdown, empty `connectorUrl`, Add Layer button, `listTables` on select, table dropdown, ⚙ back to manager |

### Conventions

- Routers are factories (`healthRouter()`, `cogRouter()`, …) so tests can mount them individually.
- Every route that needs credentials resolves them through `getCredentials(id)` and answers `404`
  with the restart hint when the registry is cold.
- Identifiers are validated with `IDENT_RE` and quoted with `quoteIdent()`; values are always bound
  parameters.
- New capabilities must be added to `CAPABILITIES` in `routes/health.ts` and feature-detected in the
  browser via `companionHasCapability()` — never assumed.

---

## Building standalone binaries

```bash
# host platform
bun build --compile ./src/server.ts --outfile workbench-companion

# cross-targets
bun build --compile --target=bun-windows-x64 ./src/server.ts --outfile workbench-companion-windows.exe
bun build --compile --target=bun-linux-x64   ./src/server.ts --outfile workbench-companion-linux
bun build --compile --target=bun-darwin-arm64 ./src/server.ts --outfile workbench-companion-macos
```

Bun is used instead of `pkg`/`nexe` because it compiles the TypeScript entrypoint directly and
produces a single ~100 MB executable with no Node.js prerequisite. Binaries must be rebuilt from the
current `src/` for every release: the app reads `version` and `capabilities` from `/health`, and a
stale binary silently lacks the COG routes.

Distribution is intended to be **from the web app**: the setup wizard offers macOS / Windows / Linux
downloads and polls `/health` every 2 s until the companion appears. The release URLs and the npm
package name in the wizard are placeholders until a publishing channel exists.

---

## Status and roadmap

### Implemented (v2.1.0)

| Area | State |
|------|-------|
| Express server, localhost bind, port range, graceful shutdown | ✅ |
| Health + capability advertisement, `bootTime` restart detection | ✅ |
| Client-side two-tier encryption, per-client blob storage, session-key registration | ✅ |
| Legacy machine-key migration | ✅ |
| Connection CRUD UI, connectivity test, in-memory registry, pool lifecycle | ✅ |
| Table discovery (geometry **and** geography columns, estimated extent) | ✅ |
| GeoJSON query with bbox, filter, SRID, limit + injection guard rails | ✅ |
| Viewport-driven refresh on `moveend`, restore-on-reload, disconnected state + reconnect | ✅ |
| MVT tile endpoint (`ST_AsMVT`) | ✅ server-side |
| COG proxy with Range streaming, SigV4 pre-signing, region detection | ✅ used by the app |
| COG header validation + per-client COG credential blob store | ✅ server-side · ⬜ no client caller yet |
| Encrypted S3 credential storage in the browser (`cogCredentialsEncrypted` layer blob) | ✅ |
| Route tests (jest/supertest) + client tests (vitest) | ✅ |

### Known gaps

| Gap | Detail |
|-----|--------|
| **Setup wizard not mounted** | `PostgisSetupWizard` is built, styled and unit-tested, but no production component renders it; `AddVectorLayerForm` shows an inline "Workbench Companion not detected" error instead |
| **MVT path unused by the app** | `getTileUrl()` exists and the endpoint works, yet PostGIS layers always load GeoJSON with bbox windowing — no automatic switch for very large tables |
| **Unused endpoints** | `DELETE /storage`, `GET /registered`, `POST /cog/validate` and the `/cog/credentials` trio have no browser caller |
| **COG credentials never use tier 2** | `getCogEncryptionKey()` is called without the app-lock password in both places, so S3 keys stay on the tier-1 `localStorage` key even after a password is set |
| **Tier-1 → tier-2 key migration not wired** | `migrateToPasswordKey()` is built and tested but nothing calls it. Since `initConnector()` derives the tier-2 key whenever an app-lock password exists, setting a password *after* saving connections makes the stored tier-1 blob undecryptable — the failure is logged and an empty list is returned, so connections look lost until they are re-saved |
| **SRID override semantics** | the field feeds the *bbox envelope* SRID while the app always sends a 4326 extent, so a projected-SRID override can misplace the window |
| **Filter blacklist is lexical** | word-boundary keyword matching also rejects legitimate string literals (`name = 'Delete me'`) and is not a SQL parser |
| **No token auth** | any local process or web page can call the loopback API while the companion runs |
| **Open proxy** | `/cog/proxy` will fetch any `http(s)` URL given to it |
| **Publishing** | npm package and Docker image are named but not published; release download URLs are placeholders |
| **`uuid` dependency** | declared in `package.json` but unused (ids come from `crypto.randomUUID()` in the browser) |

### Next

1. Mount the setup wizard, surface companion status in Advanced settings, wire
   `migrateToPasswordKey()` into the app-lock flow (or fall back to the tier-1 key when tier-2
   decryption fails), and either call `/cog/validate` + `/cog/credentials` or remove them.
2. Switch large PostGIS tables to the MVT endpoint, with a feature-count heuristic.
3. Zoom-dependent `ST_Simplify` / `ST_SimplifyPreserveTopology` and keyset pagination.
4. Optional bearer token (`~/.mapviewer/token`, entered once in the app) to close the loopback-API gap.
5. Query builder UI (QGIS-style) and an explicit read-only SQL editor.
6. PostGIS raster support, query result caching, companion auto-update check.
7. Publish the npm package + Docker image and wire real release URLs into the wizard.

---

## License

Apache-2.0 — see [`../LICENSE`](../LICENSE).
