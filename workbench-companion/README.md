# MapViewer Workbench Companion

A localhost-only companion server that bridges the MapViewer web app to:
- **PostgreSQL/PostGIS databases** — load tables and queries as vector layers
- **S3 Cloud Optimized GeoTIFFs** — proxy COG requests to bypass CORS restrictions

## Why?

Web browsers enforce CORS (Cross-Origin Resource Sharing) policies that prevent direct access to many S3 buckets and other external services. The Workbench Companion runs on your machine and proxies these requests, bypassing CORS entirely.

### Features

| Feature | Description |
|---------|-------------|
| **PostGIS Connector** | Connect to PostgreSQL/PostGIS databases, discover tables, load vector layers |
| **COG Proxy** | Stream Cloud Optimized GeoTIFF data through localhost, bypassing CORS |
| **S3 Pre-signing** | Generate pre-signed S3 URLs server-side (no CORS issues during signing) |
| **Region Detection** | Auto-detect S3 bucket regions via HEAD requests (works for private buckets) |
| **COG Validation** | Validate COG headers server-side (fetch first 2MB without CORS) |

## Architecture

```
Browser ──HTTP──▶ Companion (localhost:40000) ──HTTPS──▶ S3 / PostgreSQL
  │                    │
  │ CORS blocked!      │ No CORS issues (localhost)
  │                    │ Streams range requests
  ▼                    ▼
```

## Installation

### Standalone binary (recommended)

Download from [GitHub Releases](https://github.com/mapviewer/connector/releases):
- macOS: `workbench-companion-macos`
- Windows: `workbench-companion-windows.exe`
- Linux: `workbench-companion-linux`

### npm

```bash
npm install -g @mapviewer/workbench-companion
workbench-companion
```

### Docker

```bash
docker run -p 40000:40000 mapviewer/workbench-companion
```

### From source

```bash
cd workbench-companion
npm install
npm run build
npm start
```

## Usage

1. Start the companion (it will listen on `localhost:40000`)
2. Open the MapViewer web app
3. The app will automatically detect the companion

### For S3 COGs

When loading an S3 Cloud Optimized GeoTIFF:
- The companion auto-detects the correct bucket region
- Pre-signs URLs server-side (if credentials provided)
- Proxies tile requests through localhost (bypasses CORS)

### For PostGIS

1. Add a PostgreSQL connection in the MapViewer UI
2. The companion stores credentials in memory only (encrypted at rest)
3. Discover tables and load them as vector layers

## API Endpoints

### Health
- `GET /health` — Returns status, version, capabilities

### PostGIS
- `GET /storage?clientId=xxx` — Load encrypted connection blob
- `POST /storage` — Save encrypted connection blob
- `POST /register` — Register credentials (encrypted with session key)
- `GET /connections/:id/tables` — List tables for a connection
- `POST /connections/:id/query` — Query GeoJSON from a table
- `GET /connections/:id/tiles/{z}/{x}/{y}` — MVT tile endpoint

### COG Proxy
- `GET /cog/proxy?url=...` — Stream COG data through localhost
- `POST /cog/presign` — Generate pre-signed S3 URL
- `POST /cog/validate` — Validate COG header (fetch first 2MB)
- `POST /cog/detect-region` — Detect S3 bucket region

## Security

- **localhost only** — binds to `127.0.0.1`, not accessible from the network
- **Encrypted credentials** — stored encrypted on disk, decrypted in memory only
- **Session key** — generated on startup, used to encrypt registration payloads
- **Two-tier encryption** — random key or PBKDF2-derived from app-lock password

## Port Range

The companion tries ports `40000` through `40019` and uses the first available port.

## Building the standalone binary

```bash
bun build --compile ./src/server.ts --outfile workbench-companion
```

## License

Apache-2.0
