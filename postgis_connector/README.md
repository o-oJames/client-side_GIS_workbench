# MapViewer PostGIS Connector

A companion server that enables the [MapViewer](../mapviewer/) web application to load PostgreSQL/PostGIS tables and queries as vector layers.

## Why a Connector?

Browsers cannot connect directly to PostgreSQL because they lack raw TCP sockets and the PostgreSQL wire protocol. This thin local HTTP server bridges the gap:

- Speaks PostgreSQL on behalf of the browser
- Manages saved connections securely (encrypted at rest)
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

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Check if connector is running |
| `/connections` | GET | List saved connections |
| `/connections` | POST | Save a new connection |
| `/connections/:id` | DELETE | Remove a connection |
| `/connections/:id/test` | POST | Test connectivity |
| `/connections/:id/tables` | GET | List spatial tables |
| `/connections/:id/query` | POST | Execute query → GeoJSON |
| `/connections/:id/tiles/:z/:x/:y` | GET | Serve MVT tiles |

## Build executable
```bash
bun build --compile ./src/server.ts --outfile mapviewer-connector-macos
bun build --compile --target=bun-windows-x64 ./src/server.ts --outfile mapviewer-connector-windows.exe
```

## Security

- **Listens on 127.0.0.1 only** — not accessible from the network
- **Read-only enforcement** — rejects any SQL containing write operations (INSERT, UPDATE, DELETE, DROP, etc.)
- **Credential encryption** — saved connections are encrypted at rest using AES-256-GCM with a machine-derived key
- **CORS** — `Access-Control-Allow-Origin: *` (safe because localhost-only)

## Configuration

Connections are stored in `~/.mapviewer/connections.json`, encrypted with a key derived from your machine's hostname, username, platform, and architecture.

## Architecture

```
Browser (MapViewer) → HTTP → Connector (this server) → libpq → PostgreSQL/PostGIS
```

The web app auto-detects the connector by probing ports 40000–40019 in parallel.

## License

Apache-2.0
