# Web Map Tiles Display

An interactive web map viewer built with **React**, **TypeScript**, and **OpenLayers** for displaying, inspecting, and annotating raster and vector geospatial data from a wide range of OGC and tile-based sources.

## Features

### Basemap

- Multiple built-in basemap presets — OSM Standard, Carto Light, Carto Dark, Esri World Imagery
- Custom basemap via any XYZ tile URL template (`{z}/{x}/{y}` or Bing-style `{q}` quadkey)
- Live three-tile preview when entering a custom basemap URL
- Basemap zoom range clamping (min/max zoom with overzoom/underzoom)
- Toggle basemap visibility on/off

### Raster Layers

- **XYZ** tile layers with `{z}/{x}/{y}`, `{-y}` (TMS), `{q}` (quadkey), and `{s}` (subdomain) template support
- **WMTS** layers with automatic GetCapabilities parsing and layer picker
- **WMS** layers with automatic GetCapabilities parsing and layer picker
- Per-layer colour adjustments — brightness, saturation, contrast, and opacity (CSS-filter based with renderer patching to prevent cross-layer bleed)
- Per-layer tile zoom range clamping (overzoom/underzoom outside the range)
- Layer visibility toggle
- Drag-and-drop layer reordering
- Zoom-to-extent (extracted from WMTS/WMS capabilities metadata)
- Add layers from saved "known sources" with one click

### Vector Layers

- **File upload** — GeoJSON, KML, KMZ, and Shapefile (`.zip` with `.shp` + `.dbf` + `.prj`)
- **Drag & drop** files directly onto the map
- **MVT** (Mapbox Vector Tiles) layers via URL
- **WFS** (Web Feature Service) layers with automatic GetCapabilities feature-type discovery
- **STAC API** layers with collection discovery, automatic pagination, and configurable item limit
- Per-layer styling — line colour, fill colour, line width, opacity, font colour, font size
- Per-feature style overrides within a layer
- Layer visibility toggle
- Drag-and-drop layer reordering
- Zoom-to-extent
- Zoom range (visibility range) per layer
- Export any vector layer to **GeoJSON** or **KML**

### Drawing & Annotation Tools

- Draw **lines**, **polygons**, and **rectangles** on the map
- Add **text labels** with an in-app dialog positioned at the click point
- Global draw-style editor (line colour, fill colour, line width, opacity, font colour, font size)
- Per-feature style customisation (overrides the global style)
- Drawn-features panel — list, rename, restyle, and remove individual features
- **Save** drawn features as a persistent vector layer
- **Export** drawn features to GeoJSON or KML

### Feature Inspection

- Click any vector feature to inspect its attributes in a popup
- Multi-feature popup with collapsible per-feature sections
- "Collapse all" / "Show all" quick actions in the popup footer

### Navigation & Search

- **Go-to bar** with three modes:
  - **ZXY** — jump to a tile coordinate (e.g. `11/1811/1236`)
  - **LatLng** — jump to a latitude/longitude pair
  - **Address** — geocode a place name via the Nominatim API
- Zoom controls, scale line, and attribution display

### Coordinate Display

- Real-time mouse-position coordinate readout
- Switch between **EPSG:4326** (lat/lng) and **EPSG:3857** (web mercator)
- Configurable decimal places

### Projection Support

- **proj4** integration for on-the-fly reprojection
- Automatic WKT projection parsing (both ESRI and GDAL/OGR formats)
- EPSG code lookup from [epsg.io](https://epsg.io)
- Built-in definitions for Australian datums — GDA2020 and GDA94 MGA zones, WGS 84 UTM zones
- Automatic EPSG identification from WKT content when no AUTHORITY tag is present

### Settings & Persistence

- Settings dialog with pin/unpin to keep it open while interacting with the map
- All layer configurations, basemap choice, and UI toggles persisted to **localStorage**
- Drawn-in-app layers serialised (geometry + per-feature styles) and restored across sessions
- Map view (centre + zoom) persisted and also encoded in the URL query string (`?lat=…&lng=…&z=…`) for easy sharing
- **Known Sources** manager — save, edit, and delete frequently used raster (WMTS/WMS/XYZ) and vector (MVT/WFS/STAC) endpoints

### Developer Experience

- **TypeScript** throughout
- **Docker** support for consistent Node.js environments
- **VS Code Dev Container** configuration
- Built with **Create React App**

## Tech Stack

| Technology | Purpose |
|---|---|
| [React 18](https://react.dev/) | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | Type safety |
| [OpenLayers 9](https://openlayers.org/) | Map rendering & geospatial engine |
| [proj4js](http://proj4js.org/) | Coordinate reference system reprojection |
| [JSZip](https://stuk.github.io/jszip/) | Shapefile / KMZ archive parsing |
| [React Router 6](https://reactrouter.com/) | Client-side routing |
| [Create React App](https://create-react-app.dev/) | Build tooling |

## Getting Started

### Prerequisites

- Node.js (see Dockerfile for the version used in CI)

### Install & Run

```bash
cd mapviewer
npm install
npm start
```

The app opens at [http://localhost:3000](http://localhost:3000) and redirects to `/map`.

### Build for Production

```bash
cd mapviewer
npm run build
```

### Docker

A `Dockerfile` is provided at the project root for running the project without worrying about the host Node.js version. A `.devcontainer/devcontainer.json` is also included for VS Code Dev Containers.

## Project Structure

```
├── Dockerfile                  # Node.js container for consistent builds
├── .devcontainer/              # VS Code Dev Container config
├── sample/                     # Sample data files (e.g. KMZ)
└── mapviewer/
    ├── public/                 # Static assets
    ├── build/                  # Production build output
    └── src/
        ├── App.tsx             # Main application (map, layers, UI)
        ├── App.css             # All component styles
        ├── index.tsx           # React entry point
        └── utils/
            ├── projectionHelper.ts   # WKT/EPSG projection registration
            └── shapefileParser.ts    # Binary shapefile (.shp/.dbf/.prj) parser
```
