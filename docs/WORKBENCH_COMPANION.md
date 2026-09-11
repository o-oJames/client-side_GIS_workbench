# Workbench Companion — Design Document

> **Status: implemented and shipping** — companion `v2.1.0` (`workbench-companion/package.json`,
> echoed by `GET /health`).
>
> This is the **design record**: the problem, the alternatives that were rejected, the decisions that
> were taken and why, the credential lifecycle, the threat model, and what is still open.
> The **canonical merged guide** — quick start, usage, full API reference with request/response
> shapes, generated SQL, data flows, development and roadmap — lives in
> [`workbench-companion/README.md`](../workbench-companion/README.md). This document and that README
> are two views of the same system and are **updated together in the same change**.
>
> This revision supersedes the original design draft, which described a "PostGIS Connector" with
> server-side connection CRUD (`GET`/`POST /connections`), machine-derived credential encryption and
> a single PostGIS job. What shipped differs in three important ways: credentials are encrypted by
> the **browser** and held in the companion's **memory** only; connections are CRUD-ed client-side
> through an opaque blob store plus a session-key registration call; and the companion gained a
> second job — an **S3 COG proxy** — which is why it was renamed.

## Contents

1. [Overview](#1-overview)
2. [Problem statement](#2-problem-statement)
3. [Alternatives considered](#3-alternatives-considered)
4. [Design decisions](#4-design-decisions)
5. [Architecture](#5-architecture)
6. [Interface summary](#6-interface-summary)
7. [Credential lifecycle](#7-credential-lifecycle)
8. [Threat model](#8-threat-model)
9. [Read-only enforcement](#9-read-only-enforcement)
10. [Data flows](#10-data-flows)
11. [Performance strategy](#11-performance-strategy)
12. [Frontend integration](#12-frontend-integration)
13. [Testing strategy](#13-testing-strategy)
14. [Distribution strategy](#14-distribution-strategy)
15. [Implementation status vs. the original plan](#15-implementation-status-vs-the-original-plan)
16. [Known limitations and roadmap](#16-known-limitations-and-roadmap)
17. [References](#17-references)

---

## 1. Overview

The **Workbench Companion** is an optional companion server for the MapViewer web app. The app is a
pure client-side SPA (React + OpenLayers, persistence in `localStorage`/IndexedDB, no back-end), so
anything a browser structurally cannot do is delegated to a small Express process that the user
downloads and runs on their own machine.

It has two jobs:

| Job | Why the browser cannot do it | Companion endpoints |
|-----|------------------------------|---------------------|
| **PostgreSQL / PostGIS as vector layers** | No raw TCP sockets, no PostgreSQL wire protocol, and database passwords must not live in client-side JavaScript | `/storage`, `/register`, `/connections/:id/{test,tables,query,tiles/…}` |
| **S3 Cloud Optimized GeoTIFFs** | COG rendering needs many small HTTP `Range` requests; most buckets do not send `Access-Control-Allow-Origin` for the app's origin | `/cog/{proxy,presign,validate,detect-region}`, `/cog/credentials` |

Key characteristics, unchanged from the original design intent:

- runs **locally**, owned by the user (like Ollama, Jupyter, or VS Code Remote);
- exposes a **REST API over HTTP on loopback**, bound to `127.0.0.1`;
- is **auto-detected** by the web app through parallel port probing (`40000`–`40019`);
- needs **zero configuration** in the common case;
- is **secure by construction** — localhost-only, read-only queries, browser-held encryption keys,
  memory-only plaintext credentials;
- **advertises capabilities** (`postgis`, `cog-proxy`) so the app degrades gracefully instead of
  assuming a version.

---

## 2. Problem statement

### 2.1 PostgreSQL

1. **No raw TCP sockets.** Browsers only issue HTTP(S) requests; the PostgreSQL protocol is a framed
   binary protocol over TCP.
2. **No browser client.** A WASM libpq would still need a socket, and would still be blocked by
   CORS.
3. **Credential exposure.** A SPA has no secret store. Anything shipped to the browser is public;
   anything persisted in `localStorage` is readable by any script on the origin.
4. **Multi-database reality.** GIS users routinely hold several databases (prod, staging, a
   colleague's open-data instance). A bridge that supports exactly one database per instance pushes
   process management onto the user.

### 2.2 S3 COGs

Reading a Cloud Optimized GeoTIFF means fetching the header, the IFDs, and then a few hundred
byte-range requests for the tiles the current view needs. Two things break in the browser:

- **CORS.** Unless the bucket is configured with a permissive `Access-Control-Allow-Origin`, the
  fetch fails even though the same URL works from `curl`. Private buckets effectively never allow it.
- **Signing.** AWS SigV4 pre-signing in the browser means holding the secret access key in
  JavaScript, and the signing request itself is subject to CORS.

A loopback proxy fixes both: same-origin-ish requests to `http://localhost:40000/cog/proxy?url=…`
carry no CORS preflight problems, and the signing can happen server-side from credentials the
browser encrypts.

---

## 3. Alternatives considered

| Approach | Multi-DB | Dynamic connections | Read-only | GeoJSON | MVT | COG/CORS | Verdict |
|----------|:--------:|:-------------------:|:---------:|:-------:|:---:|:--------:|---------|
| **pgAdmin** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | A GUI application, not an API service. Its internal endpoints are undocumented, unstable and not designed for external consumption; bridging through them would be fragile, insecure and spatially unaware |
| **PostgREST** | ❌ (one DB per instance) | ❌ | ✅ | ✅ | ❌ | ❌ | Excellent technology, wrong shape: N databases means N instances behind a reverse proxy, which is too much machinery for an end user, and there is no COG story |
| **pg_tileserv** | ❌ (one DB per instance) | ❌ | ⚠️ | ❌ | ✅ | ❌ | Tiles only, single static connection, no GeoJSON feature queries, no COG story |
| **Browser-side WASM Postgres** | — | — | ❌ | ✅ | ❌ | ❌ | Blocked by the absence of TCP sockets; also puts credentials in the page |
| **Companion server (this design)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | One process, connections managed at runtime from the UI, and a natural home for the COG proxy |

The decisive argument is **dynamic multi-connection management plus a second, unrelated job (COG
proxying)**. Once a local helper process was required for COGs anyway, using it for PostGIS as well
cost almost nothing and removed a whole category of CORS bug reports.

---

## 4. Design decisions

| # | Decision | Choice | Rationale / what was rejected |
|---|----------|--------|-------------------------------|
| D1 | Where encryption happens | **In the browser** (Web Crypto AES-256-GCM); the companion stores opaque blobs | The original draft encrypted on the server with a machine-derived key (`hostname\|user\|platform\|arch\|cpu` → PBKDF2). That key is guessable by any process running as the same user and offers no real protection. Client-side encryption means the companion — and anyone who copies `~/.mapviewer` — never learns a password. The machine-key path survives only as a **migration reader** |
| D2 | Where plaintext credentials live | **Companion process memory only** (`storage.ts` registry), lost on restart | Writing decrypted credentials to disk, even `0600`, would recreate the problem D1 solves. Memory-only costs one re-registration per restart, which the app performs automatically |
| D3 | Connection CRUD ownership | **Browser-side**: encrypt → `POST /storage` → `POST /register`. No `GET`/`POST /connections` | A server-side CRUD API would have to accept plaintext passwords over HTTP and store them itself. The blob + registration split keeps the server stateless about secrets |
| D4 | Transport protection on loopback | **Ephemeral session key** published on `/health`, used to encrypt `/register` payloads | Loopback traffic is not encrypted; a plaintext JSON password in a POST body would be visible to any local packet capture or proxy. A per-boot random key also makes registrations self-invalidating across restarts. Rejected: TLS on localhost (certificate distribution pain), and a static token file (does not rotate, still needs a first-run exchange) |
| D5 | Per-profile isolation | **`clientId` UUID in `localStorage`**, one file tree per client | Two browser profiles (or a profile and an incognito window) must not share database credentials. `clientId` is sanitised before it becomes a path component |
| D6 | Key hierarchy | **Two tiers**: random key in `localStorage`, upgraded to PBKDF2 from the app-lock password | Tier 1 keeps zero-config usable; tier 2 gives users who set an app-lock password real protection for the at-rest blob. `migrateToPasswordKey()` re-encrypts and deletes the tier-1 key. **Gap:** nothing calls it yet (see §7.2), so the upgrade path is not live |
| D7 | PostGIS data format | **GeoJSON first**, MVT endpoint built but not yet wired | The app already has a complete GeoJSON vector pipeline (styling, filtering, attribute table, geoprocessing). Reusing it made PostGIS layers first-class in a day. MVT is the right answer above ~100 k features and is implemented server-side, awaiting a client-side switch |
| D8 | Windowing | **bbox from the current view extent + `moveend` re-query** (300 ms debounce) | Loading a whole table into the browser is how GIS clients crash. Windowing keeps memory bounded and uses the spatial index |
| D9 | Read-only enforcement | **No raw-SQL endpoint**; identifier allow-list regex + quoting, keyword blacklist on the filter, bound parameters for bbox, hard row cap | The draft's "reject any SQL not starting with `SELECT`" is meaningless once the API takes a table and a filter instead of SQL. The filter is still SQL passed through, so the docs tell users to prefer a read-only database role |
| D10 | Port strategy | **Default `40000`, scan to `40019`, parallel probe in the browser, cache the winner** | A fixed port collides; a random port cannot be discovered (the browser cannot read `~/.mapviewer/connector.port` or use a Unix socket). Parallel probing costs ~500 ms, not ~10 s |
| D11 | Versioning | **`version` + `capabilities[]` on `/health`** | The app feature-detects (`companionHasCapability('cog-proxy')`) instead of assuming, so an old companion still serves PostGIS and a new one unlocks COGs |
| D12 | Restart handling | **`bootTime` + 5 s poll → automatic re-registration**; unregistered access returns `404` with an explicit hint; restored layers show a **Disconnected** chip with a reconnect button | Silent failure is the worst outcome for a local helper the user may have stopped. Every layer keeps its config, so recovery is one click or one poll |
| D13 | COG proxy shape | **Streaming pass-through** of `Range`/`Accept-Ranges`, selected response headers forwarded, upstream aborted when the client disconnects | Buffering would destroy COG performance and balloon memory. Exposing `Content-Range`/`Content-Length`/`Accept-Ranges` to the browser is required by `ol/source/GeoTIFF` |
| D14 | COG credentials | **Encrypted at form-submit time in the browser** (`cogCredentialsEncrypted` on the layer config), optional mirrored blob store per client | Plaintext AWS keys in `localStorage` were the original behaviour; the blob format matches the PostGIS one (`iv:authTag:ciphertext`) so both use one key and one code path. **Gap:** the COG callers never pass the app-lock password, so S3 keys are always tier-1 encrypted, and the mirrored blob store is unwired (see §7.3) |
| D15 | Stack | **Express 4 + `pg` 8 + Node `crypto`/`https`** | No framework churn, no native addons (which would break single-file Bun compilation), and SigV4 is ~80 lines of HMAC-SHA256 |

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Browser — React SPA (gis_workbench)                                         │
│                                                                              │
│   utils/companion.ts      discovery · clientId · two-tier keys · AES-GCM     │
│                           session-key registration · CRUD · queries · COG    │
│   utils/cogCredentials.ts S3 credential blobs on layer configs               │
│   utils/rasterLayerFactory.ts  resolveCogUrl() → companion or direct         │
│   components/…            AddPostgisLayerForm · PostgisConnectionManager     │
│                           PostgisSetupWizard · AdvancedSettingsDialog        │
│   localStorage            mapviewer-companion-url · mapviewer-db-client-id   │
│                           mapviewer-db-encrypt                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │ HTTP  localhost:40000…40019   (CORS: *, no auth token)
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  workbench-companion (Express, binds 127.0.0.1)                              │
│                                                                              │
│  server.ts    app assembly · CORS · port scan · SIGINT/SIGTERM shutdown       │
│  storage.ts   SESSION_KEY · BOOT_TIME · in-memory registry · blob files       │
│               · legacy machine-key migration                                  │
│  db.ts        pg.Pool per connection (max 5) · testConnection · shutdownAll   │
│  routes/      health · connections · tables · query · tiles · cog ·           │
│               cogCredentials                                                  │
│                                                                              │
│  ~/.mapviewer/clients/{clientId}.json                  (0600, opaque blob)   │
│  ~/.mapviewer/clients/{clientId}/cog-credentials.json  (0600, opaque blobs)  │
└──────┬─────────────────────────────────────────────────────────┬─────────────┘
       │ libpq / TCP                                             │ HTTPS + Range
       ▼                                                         ▼
  PostgreSQL + PostGIS                                    S3 (AWS or compatible)
  geometry_columns · geography_columns                    Cloud Optimized GeoTIFFs
  ST_AsGeoJSON · ST_AsMVT · ST_TileEnvelope
```

**Trust boundaries.** The browser is the only component that ever sees plaintext credentials. The
companion sees plaintext only (a) transiently in memory after a `/register` call it just decrypted
with the session key, and (b) as S3 credentials inside a `/cog/presign` request body. PostgreSQL and
S3 see ordinary client connections from the user's machine.

---

## 6. Interface summary

Full request/response shapes, error codes and the generated SQL are in the
[README API reference](../workbench-companion/README.md#api-reference).

| Group | Endpoint | Purpose | Used by the app |
|-------|----------|---------|:---------------:|
| Health | `GET /health` | liveness, `version`, `bootTime`, `sessionKey`, `capabilities` | ✅ |
| Storage | `GET /storage?clientId=` | load the browser-encrypted connection blob | ✅ |
| | `POST /storage` | save it | ✅ |
| | `DELETE /storage?clientId=` | delete it | ⬜ not yet |
| Registration | `POST /register` | load credentials into memory (session-key encrypted) | ✅ |
| | `GET /registered` | list registered connection ids | ⬜ not yet |
| | `GET /migrate` | one-time legacy migration (returns plaintext, deletes the old file) | ✅ |
| Connections | `POST /connections/:id/test` | `SELECT version()` on a throwaway pool | ✅ |
| | `DELETE /connections/:id` | unregister + end pool | ✅ |
| PostGIS data | `GET /connections/:id/tables` | `geometry_columns` + `geography_columns` + estimated extent | ✅ |
| | `POST /connections/:id/query` | GeoJSON features (bbox, filter, srid, limit) | ✅ |
| | `GET /connections/:id/tiles/:z/:x/:y` | MVT tile (`ST_AsMVT`) | ⬜ server-ready, client not wired |
| COG | `GET /cog/proxy?url=` | streaming Range pass-through (CORS bypass) | ✅ |
| | `POST /cog/presign` | AWS SigV4 pre-signed GET URL | ✅ |
| | `POST /cog/validate` | first-2 MB TIFF/BigTIFF + tiling-tag check | ⬜ server-ready; the app validates in-browser |
| | `POST /cog/detect-region` | `x-amz-bucket-region` lookup | ✅ |
| COG credentials | `GET`/`POST`/`DELETE /cog/credentials` | per-client opaque S3 credential blobs | ⬜ not yet |

---

## 7. Credential lifecycle

### 7.1 Keys

| Item | Where | Value |
|------|-------|-------|
| `clientId` | `localStorage["mapviewer-db-client-id"]` | UUID, generated once per browser profile |
| Tier-1 key | `localStorage["mapviewer-db-encrypt"]` | random 256-bit, hex; created on first use, deleted on tier-2 migration |
| Tier-2 key | derived, never stored | PBKDF2(app-lock password, salt `mapviewer-db-v1:{clientId}`, 100 000, SHA-256) → AES-GCM-256 |
| Session key | companion memory, published on `/health` | 32 random bytes per boot, hex |

### 7.2 PostGIS connection, end to end

```
create   form → saveConnection() → AES-GCM encrypt all connections with the client key
         → POST /storage (blob written 0600) → encrypt with session key → POST /register
         → companion registry holds plaintext in memory → pg.Pool created lazily on first query

use      every data route resolves getCredentials(id) from memory; a cold registry answers 404
         "The connector may have restarted — please reload the app."

restart  companion reboots → new sessionKey + bootTime → app's 5 s poll notices → initConnector()
         → re-decrypt blob → re-register → pools rebuilt on demand

delete   deleteConnection() → re-encrypt the remaining list → POST /storage
         → DELETE /connections/:id → registry entry dropped + pool ended

upgrade  migrateToPasswordKey() was written for exactly this — re-encrypt with the tier-2 key,
         POST /storage, delete the tier-1 key — but NOTHING CALLS IT YET. Because initConnector()
         derives the tier-2 key whenever an app-lock password exists, setting a password after
         connections were saved under tier 1 leaves the stored blob undecryptable: the failure is
         logged, an empty list is returned, and the connections look lost until they are re-saved.

migrate  legacy ~/.mapviewer/connections.json (machine-key AES-GCM or plaintext array)
         → GET /migrate decrypts once and deletes the file → browser re-encrypts with the client
         key → POST /storage → POST /register
```

### 7.3 S3 COG credentials

Plaintext `cogAccessKeyId` / `cogSecretAccessKey` / `cogSessionToken` exist only between the form
submit and `encryptCogCredentials()` in `AddRasterLayerForm`; the persisted layer config carries
`cogCredentialsEncrypted: "iv:authTag:ciphertext"` instead, and `saveSettings()` runs
`stripCogCredentials()` over every raster layer so plaintext fields never reach `localStorage`.
`resolveCogUrl()` decrypts transiently in memory when the layer loads.

Two caveats worth knowing:

- **COG credentials are always tier 1 today.** Both callers invoke `getCogEncryptionKey()` with no
  argument, so the app-lock password is never used for S3 keys even when it is set (the PostGIS paths
  do pass `getLockPassword()`).
- **Stripping is not re-encrypting.** A legacy layer that still carries plaintext fields keeps
  working through the `resolveCogUrl()` fallback, but the next `saveSettings()` drops those fields
  without producing a blob, so the credentials must be re-entered.

The companion also offers a per-client blob store for the same material (`/cog/credentials`, with
matching `companionSave/Load/DeleteCogCredentials` helpers) that would let S3 credentials survive a
browser-profile reset — implemented and unit-tested, **not wired**.

### 7.4 On-disk layout

```
~/.mapviewer/                              0700
├── clients/                               0700
│   ├── {clientId}.json                    0600   browser-encrypted PostGIS connections
│   └── {clientId}/cog-credentials.json    0600   { [layerId]: iv:authTag:ciphertext }
└── connections.json                       legacy; consumed and deleted by GET /migrate
```

`clientId` is sanitised to `[A-Za-z0-9_-]` before being used in a path, so a hostile client id cannot
traverse outside `clients/`.

---

## 8. Threat model

| Threat | Mitigation | Residual risk |
|--------|-----------|---------------|
| Someone copies `~/.mapviewer` | AES-256-GCM blobs whose keys live in the browser | Tier-1 keys sit in `localStorage`, so an attacker with the browser profile can decrypt; tier 2 (app-lock password) removes this |
| Passwords observed on loopback HTTP | `/register` payload encrypted with the per-boot session key | `POST /cog/presign` still carries S3 credentials in a JSON body over loopback |
| Companion restart leaves a stale app | `bootTime` poll → automatic re-registration; `404` with an explicit hint; **Disconnected** chip + reconnect | A stopped companion means PostGIS layers stay empty until it returns |
| Cross-profile credential leakage | per-`clientId` file tree and key | None known |
| Accidental writes / DDL through the API | no raw-SQL endpoint; identifier allow-list + quoting; keyword blacklist; bound bbox parameters; row cap | The `filter` field is SQL passed through to PostGIS — a *read* injection is still possible, so a read-only DB role is recommended |
| Another local process or a visited web page calling the API | loopback bind only | **No token auth and CORS `*`**: any local process, and any origin in the browser, can list registered ids, read table metadata and run queries with the credentials *this* session registered. Accepted for now; a bearer token is on the roadmap |
| `/cog/proxy` abused as a general proxy | loopback bind; `http(s)`-only URL validation | It will stream any URL it is given — an open proxy for the local machine. Documented, not restricted |
| SQL injection via table/column names | `IDENT_RE` allow-list (`schema.table`), then `quoteIdent()` double-quoting | None known |
| Legacy machine-key file left behind | `GET /migrate` decrypts once and deletes the file (also on parse failure) | The migration response is plaintext over loopback, once |

**Explicitly out of scope:** multi-user servers, remote/network exposure, and any form of write
access to the database. The companion is a single-user desktop helper.

---

## 9. Read-only enforcement

The API never accepts SQL as such. `POST /connections/:id/query` takes
`{ table, geomColumn, filter?, bbox?, srid?, limit? }` and applies four layers:

1. **Identifier allow-list** — `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$`, then
   `quoteIdent()` wraps each part in double quotes with `"` doubled. Anything else → `400`.
2. **Filter keyword blacklist** — whole-word, case-insensitive rejection of `INSERT`, `UPDATE`,
   `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXEC`, `EXECUTE`. The
   surviving filter is wrapped in parentheses and ANDed with the bbox predicate.
3. **Bound parameters** — the bbox envelope uses `$1…$5`, never string concatenation.
4. **Row cap** — `min(limit ?? 10000, 100000)`.

The same identifier rules guard the MVT route. Known blunt edges: the blacklist is lexical, so a
legitimate literal such as `name = 'Delete me'` is refused, and it does not attempt to understand
SQL semantics beyond the keyword list.

---

## 10. Data flows

Detailed, annotated versions (with the exact call sequence and the SQL text) are in the README's
[Data flows](../workbench-companion/README.md#data-flows) and
[SQL](../workbench-companion/README.md#sql-the-companion-generates) sections.

**App start.** probe ports → `/health` (session key, capabilities, boot time) → `/migrate` →
`/storage` → decrypt in the browser → `/register`; then a 5 s restart poll.

**Add a PostGIS layer.** connection dropdown → `/tables` → pick table (geometry column and layer name
auto-fill) → optional filter + SRID override → the app converts the current view extent from
EPSG:3857 to EPSG:4326 and calls `/query` → GeoJSON is read into a `VectorSource` with
`featureProjection: 'EPSG:3857'` → the OL layer stores `postgisMeta` and a `moveend` listener
(300 ms debounce) that re-queries and swaps the feature set → the config object stores
`postgisConnectionId/Table/GeomColumn/Filter/Srid` for reloads.

**Reload / reconnect.** `layerRestore` re-runs the query for every `type: 'postgis'` config; on
failure the layer is restored empty with `postgisDisconnected: true`, which renders a **Disconnected**
chip and a **↻** reconnect button that calls `onReconnectPostgisLayer(layerId)`.

**S3 COG.** decrypt credentials → confirm the `cog-proxy` capability → detect region if unknown →
pre-sign if credentials exist → wrap the URL in `/cog/proxy?url=…` → hand it to
`ol/source/GeoTIFF`, whose byte-range requests stream through the proxy. Without the companion the
app falls back to browser-side resolution (works only for CORS-permissive public buckets).

---

## 11. Performance strategy

- **Window, never scan.** Every query carries the current view extent and PostGIS uses the spatial
  index (`ST_Intersects` against a transformed `ST_MakeEnvelope`).
- **Bounded payloads.** 10 000 features per request by default, 100 000 hard cap; a bad filter
  degrades into a truncated layer instead of a hung tab.
- **Debounced refresh.** `moveend` re-queries are debounced 300 ms so a drag does not fire a request
  per pixel; the pending timer and the OL listener are removed with the layer (`postgisCleanup`).
- **Pools, not connections.** One `pg.Pool` per saved connection (`max: 5`, 30 s idle timeout, 10 s
  connect timeout), created lazily, ended on delete and on shutdown; `testConnection` uses a
  disposable pool so a failed test does not poison the cache.
- **Cheap statistics.** `ST_EstimatedExtent` reads planner statistics rather than scanning; failure
  (no `ANALYZE` yet) yields `null` instead of an error.
- **Streaming COG proxy.** The proxy pipes rather than buffers, forwards `Range` untouched, exposes
  `Content-Range`/`Content-Length`/`Accept-Ranges` to the browser and aborts upstream when the client
  goes away — so COG access keeps its normal byte-range profile.
- **Deferred:** zoom-dependent `ST_Simplify`, keyset pagination, MVT for large tables, and result
  caching (see §16).

---

## 12. Frontend integration

```
gis_workbench/src/
├── types.ts                       PostgisConnection, PostgisTableInfo,
│                                  VectorLayerConfig.type += 'postgis',
│                                  postgis{ConnectionId,Table,GeomColumn,Filter,Srid,Disconnected},
│                                  SettingsDialog props onAddPostgisLayer / onReconnectPostgisLayer
├── utils/
│   ├── companion.ts               the entire client (discovery, crypto, CRUD, queries, tiles, COG)
│   ├── cogCredentials.ts          S3 credential encrypt/decrypt for layer configs
│   ├── rasterLayerFactory.ts      resolveCogUrl() — companion-first COG resolution
│   └── layerRestore.ts            rebuild + disconnected marking for postgis layers
├── components/
│   ├── MapPage.tsx                discovery on mount, restart poll, add/reconnect/cleanup handlers
│   ├── AddVectorLayerForm.tsx     'postgis' source type; inline error when not detected
│   ├── AddPostgisLayerForm.tsx    connection ▸ table ▸ geom column ▸ filter ▸ SRID ▸ Add Layer
│   ├── PostgisConnectionManager.tsx  connection CRUD + test + delete-confirm
│   ├── PostgisSetupWizard.tsx     download wizard with 2 s health polling (not yet mounted)
│   ├── AdvancedSettingsDialog.tsx "PostGIS Connections" section
│   └── SettingsDialog.tsx         Disconnected chip + ↻ reconnect on layer rows
├── App.css                        .postgis-wizard*, .postgis-conn-form-grid, .postgis-add-form-*,
│                                  .settings-layer-disconnected, .settings-layer-reconnect-btn
└── App.tsx                        re-exports findConnector, listConnections, saveConnection,
                                   deleteConnection, testConnection, listTables, queryGeoJSON,
                                   getTileUrl, clearConnectorCache, initConnector,
                                   hasConnectorRestarted, migrateToPasswordKey, PostgisSetupWizard
```

Conventions the integration follows, consistent with the rest of the repo:

- the companion client is a **`utils/` module** (no React), so it is unit-testable in isolation;
- OL objects stay in refs and only **serialisable config** is persisted — `postgisMeta` and
  `postgisCleanup` hang off the OL layer, never off the config;
- capability checks instead of version sniffing;
- errors surface through the existing toast / inline-error channels rather than `alert()` (the one
  remaining `alert()` is the "companion not running" guard in `handleAddPostgisLayer`).

---

## 13. Testing strategy

**Companion (`workbench-companion`, Jest + ts-jest + supertest).** `__tests__/routes.test.ts` mounts
the real routers on a throwaway Express app with `pg` and `../src/storage` mocked, then covers:
health; blob load/save/delete and their `400`s; registration (decrypt-and-store, missing payload,
invalid payload, `/registered`); migration when no legacy file exists; connection test (ok and `404`)
and delete; table discovery; and the query route — GeoJSON shape, bbox applied, filter applied,
`DELETE` keyword rejected, injection-shaped table name rejected, missing fields, limit respected,
limit capped at 100 000 — plus the tile route's `400`s, `204` empty tile and MVT content type.

**Web app (`gis_workbench`, Vitest).** `utils/companion.test.ts` covers discovery (first responder,
none responding, cache write/read/eviction, all 20 ports probed in parallel), `clientId`
generation/reuse, tier-1 vs tier-2 key selection, save/list/delete round-trips, legacy migration,
`testConnection`, `listTables`, `queryGeoJSON` payload and error path, `getTileUrl` templating and
encoding, and `hasConnectorRestarted` across first-call/changed/unchanged boot times.
`PostgisConnector.test.tsx` exercises the setup wizard; `PostgisConnectionManager.test.tsx` the CRUD
UI; `PostgisLayer.test.tsx` the add-layer form. `setupTests.ts` provides the `crypto.subtle`
implementations the encryption paths need under jsdom.

**Gap:** there is no end-to-end test against a real PostGIS instance, and the COG routes
(`cog.ts`, `cogCredentials.ts`) are not covered by the companion suite — SigV4 signing, the streaming
proxy, header validation and region detection are currently verified manually.

---

## 14. Distribution strategy

| Channel | State | Notes |
|---------|-------|-------|
| **From source** | ✅ works today | `npm install && npm run build && npm start` (or `npm run dev` via ts-node). `dist/` is git-ignored, so a fresh clone must build |
| **Standalone binary** | ✅ reproducible | `bun build --compile ./src/server.ts --outfile workbench-companion`; cross-targets for `bun-windows-x64`, `bun-linux-x64`, `bun-darwin-arm64`. Bun was chosen over `pkg`/`nexe` because it compiles the TS entrypoint directly into one executable with no Node.js prerequisite. A prebuilt `workbench-companion-windows.exe` is committed in the package directory; rebuild it from current `src/` before distributing, since the app reads `version` and `capabilities` from `/health` |
| **npm** | ⬜ named, not published | package name is `mapviewer-workbench-companion`; the wizard quotes `@mapviewer/workbench-companion` — reconcile before publishing |
| **Docker** | ⬜ named, not published | `mapviewer/workbench-companion`; note a container needs network access to the host's PostgreSQL (`host.docker.internal`) |
| **In-app downloads** | ⬜ placeholders | the setup wizard links `https://github.com/mapviewer/connector/releases` |

The intended model is unchanged from the original design: **the web app is the distribution point** —
it detects the user's OS, offers the right binary, knows which companion versions it is compatible
with (via `version` + `capabilities`), and can later check for updates. The missing piece is a real
release channel; until then, building from source or with Bun is the supported path.

---

## 15. Implementation status vs. the original plan

**Phase 1 — Connector MVP.** ✅ complete, and beyond the draft:
HTTP server; connection management (save/list/delete/test); table discovery (geometry **and**
geography columns, plus estimated extents); GeoJSON query with bbox filtering; port auto-detection;
credential encryption — **moved from a machine-derived key on the server to client-side two-tier
encryption with memory-only plaintext**, which also added `/storage`, `/register`, `/registered`,
`/migrate` and the session-key mechanism.

**Phase 2 — Frontend integration.** ✅ mostly complete:
port probing and caching in `companion.ts`; connection manager UI (both in the add-layer flow and in
Advanced settings); table picker; layer creation through the existing GeoJSON pipeline; restore on
reload with a disconnected state and reconnect action. ⬜ the **setup wizard is built and tested but
not mounted** — the add-vector form shows an inline error instead.

**Phase 3 — Distribution.** ⬜ partial: Bun compilation works and a Windows binary is committed;
there is no release page, no published npm package or Docker image, and no auto-update check.

**Phase 4 — Advanced features.** ◐ partial:
MVT tile endpoint ✅ (server-side) but unused by the client; geometry simplification ⬜; pagination
⬜ (row cap only); query builder UI ⬜; SQL editor ⬜.

**Not in the original plan, now shipped:** the entire S3 COG side — streaming proxy, SigV4
pre-signing, header validation, region detection, encrypted COG credential storage — plus capability
advertisement, restart detection and legacy migration.

---

## 16. Known limitations and roadmap

### Limitations

| Area | Limitation |
|------|-----------|
| Client | Setup wizard not mounted; MVT path unused; COG credentials always use the tier-1 key (`getCogEncryptionKey()` is called without the app-lock password); `DELETE /storage`, `GET /registered`, `POST /cog/validate` and `/cog/credentials` have no caller; the tier-1 → tier-2 key migration (`migrateToPasswordKey`) is never invoked, so setting an app-lock password after saving connections strands the existing blob |
| Query semantics | The SRID override feeds the **bbox envelope** SRID while the app always sends a 4326 extent, so a projected override can misplace the window; the filter blacklist rejects legitimate literals; no `ST_Simplify`, no pagination beyond the row cap |
| Security | No token auth on the loopback API; CORS `*`; `/cog/proxy` is an open proxy; `/cog/presign` carries S3 credentials in a plaintext loopback body |
| Packaging | npm/Docker names unpublished; release URLs and the wizard's package name are placeholders; `uuid` is a declared but unused dependency |
| Tests | No integration test against a real PostGIS; COG routes uncovered |

### Roadmap (ordered)

1. **Mount the setup wizard** and surface companion status (version, capabilities, port, registered
   connections) in Advanced settings. In the same pass, wire `migrateToPasswordKey()` into the
   app-lock flow (or make `initConnector` fall back to the tier-1 key when tier-2 decryption fails),
   and either call `/cog/validate` + `/cog/credentials` or remove them.
2. **Close the loopback gap** — optional bearer token written to `~/.mapviewer/token` on first run,
   entered once in the app and required on every request; consider restricting `/cog/proxy` to
   known S3/COG hosts.
3. **MVT for large tables** — feature-count heuristic, then `getTileUrl()` → `ol/source/VectorTile`
   with the existing styling pipeline.
4. **Zoom-dependent simplification and keyset pagination** in `/query`.
5. **Query builder UI** (QGIS-style field/operator/value rows) and an explicit, clearly-labelled
   read-only SQL editor.
6. **Fix SRID semantics** — separate "geometry SRID" from "bbox SRID", or always send a 4326 envelope
   and let PostGIS transform.
7. **COG route tests** (SigV4 vectors, proxy header/Range behaviour, TIFF validation fixtures) and a
   docker-compose PostGIS integration test.
8. **Publish** the npm package and Docker image, wire real release URLs, add an auto-update check.
9. **Later:** PostGIS raster support, query result caching, spatial operations pushed down to
   PostGIS (`ST_Buffer`, `ST_Intersection`), and table editing behind an explicit opt-in.

---

## 17. References

- [QGIS — PostGIS connection model](https://docs.qgis.org/latest/en/docs/user_manual/working_with_vector/vector_properties.html#vector-properties)
- [PostgREST](https://postgrest.org/)
- [pg_tileserv](https://github.com/CrunchyData/pg_tileserv)
- [PostGIS `ST_AsMVT` / `ST_TileEnvelope`](https://postgis.net/docs/ST_AsMVT.html)
- [AWS Signature V4 (pre-signing)](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html)
- [Cloud Optimized GeoTIFF](https://www.cogeo.org/)
- [Ollama](https://ollama.ai/) and [Jupyter Server](https://jupyter.org/) — the local-helper UX pattern this follows
- [`workbench-companion/README.md`](../workbench-companion/README.md) — canonical merged guide
- [`../README.md`](../README.md) — the web app's own documentation (see *Workbench Companion (optional)*)
