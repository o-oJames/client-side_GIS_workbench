# MapViewer PostGIS Connector

A companion server that enables the [MapViewer](../mapviewer/) web application to load PostgreSQL/PostGIS tables and queries as vector layers.

## Why a Connector?

Browsers cannot connect directly to PostgreSQL because they lack raw TCP sockets and the PostgreSQL wire protocol. This thin local HTTP server bridges the gap:

- Speaks PostgreSQL on behalf of the browser
- Manages saved connections securely (client-side encryption model)
- Enforces read-only access
- Returns data as GeoJSON or MVT tiles

## Quick Start

### Prerequisites

- Node.js 18+
- A running PostgreSQL instance with the PostGIS extension

### Install & Run

```bash
cd postgis_connector
npm install
npm run build
npm start
```

The server starts on `http://localhost:40000` by default. If that port is taken, it automatically tries the next available port up to 40019.

### Development

```bash
npm run dev   # runs with ts-node, auto-reloads
```

## API Endpoints

### Health & Discovery

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Check if connector is running, returns `bootTime` and `sessionKey` |

### Encrypted Blob Storage

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/storage?clientId={id}` | GET | Load encrypted blob for a client |
| `/storage` | POST | Save encrypted blob `{ clientId, encryptedBlob }` |
| `/storage?clientId={id}` | DELETE | Delete encrypted blob for a client |

### Credential Registration

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register credentials in memory (encrypted payload) |
| `/registered` | GET | List registered connection IDs |

### Migration

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/migrate` | GET | One-time migration from legacy connections (returns plaintext, then deletes legacy file) |

### Connection Operations

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/connections/:id/test` | POST | Test connectivity |
| `/connections/:id` | DELETE | Unregister a connection |
| `/connections/:id/tables` | GET | List spatial tables |
| `/connections/:id/query` | POST | Execute query → GeoJSON |
| `/connections/:id/tiles/:z/:x/:y` | GET | Serve MVT tiles |

## Security Model

The connector uses a **client-side encryption model** where the browser handles all encryption/decryption. The connector never decrypts credentials at rest.

### Two-Tier Key Management

- **Tier 1 (default):** Random 256-bit key stored in browser's `localStorage("mapviewer-db-encrypt")`
- **Tier 2 (stronger):** Key derived from app-lock password via PBKDF2 (100,000 iterations, SHA-256)

When the user sets an app-lock password, the system automatically migrates from Tier 1 to Tier 2.

### Browser Isolation

Each browser profile has its own:
- **Client ID** (UUID) stored in `localStorage("mapviewer-db-client-id")`
- **Encryption key** (Tier 1 or Tier 2)

This means:
- Incognito windows cannot access saved connections (empty localStorage)
- Different browser profiles cannot access each other's connections
- Each browser profile is cryptographically isolated

### Encryption Layers

1. **At rest (disk):** Credentials encrypted with browser-specific key, stored in `~/.mapviewer/clients/{clientId}.json`
2. **In transit (localhost):** Registration payloads encrypted with ephemeral session key (AES-256-GCM)
3. **In memory (connector):** Decrypted credentials held only in memory (lost on restart)

### Session Key

The connector generates a random 256-bit session key on startup (returned via `/health`). The browser uses this key to encrypt registration payloads before sending to `/register`. This prevents local packet sniffers from capturing credentials in plaintext.

### Storage Layout

```
~/.mapviewer/
├── clients/
│   ├── {clientId-1}.json    # Encrypted blob (AES-256-GCM)
│   ├── {clientId-2}.json    # Encrypted blob (AES-256-GCM)
│   └── ...
└── connections.json         # Legacy file (auto-migrated on first run)
```

### Migration

On first run, the connector checks for legacy connections (encrypted with machine-derived key). If found:
1. Returns plaintext via `GET /migrate`
2. Browser re-encrypts with browser-specific key
3. Saves to `POST /storage`
4. Deletes legacy file

## Architecture

```
Browser (MapViewer)
  ↓
  1. Load encrypted blob from /storage
  2. Decrypt with browser-specific key
  3. Encrypt credentials with session key
  4. Send to /register (encrypted payload)
  ↓
Connector (this server)
  ↓
  1. Decrypt registration payload with session key
  2. Store credentials in memory
  3. Use credentials for PostgreSQL connections
  ↓
PostgreSQL/PostGIS
```

The web app auto-detects the connector by probing ports 40000–40019 in parallel.

## Build Executable

```bash
bun build --compile ./src/server.ts --outfile mapviewer-connector-macos
bun build --compile --target=bun-windows-x64 ./src/server.ts --outfile mapviewer-connector-windows.exe
```

## Security Features

- **Listens on 127.0.0.1 only** — not accessible from the network
- **Read-only enforcement** — rejects any SQL containing write operations (INSERT, UPDATE, DELETE, DROP, etc.)
- **Client-side encryption** — browser encrypts credentials before sending
- **Browser isolation** — each browser profile has its own encryption key
- **Session key encryption** — registration payloads encrypted with ephemeral key
- **Ephemeral in-memory storage** — credentials lost on connector restart
- **CORS** — `Access-Control-Allow-Origin: *` (safe because localhost-only)

## License

Apache-2.0
