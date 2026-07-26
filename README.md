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
- **Re-edit drawn features** — vertex-editing tool: drag vertices to reshape a line, polygon or rectangle (or move a label), click a segment to insert a vertex, Alt+click a vertex to remove it; measurement labels update live while editing; saved drawn layers get the same editing in place via the **Re-edit geometry** button in their edit menu
- **Live measurements** while drawing and after completion — per-segment vertex-to-vertex distances on lines, polygons and rectangles, plus geodesic area on polygons and rectangles, always with 2 decimals; total length / area also shown in the drawn-features panel
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
- **Metric / Imperial switch** (Advanced Settings → Measurement Units) — measurement labels flip between m / km / m² / km² and ft / mi / ft² / mi², and the scale line follows; the choice persists across sessions
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

## Pending Features

Features commonly found in map applications (QGIS, ArcGIS Online, Mapbox, Google My Maps, etc.) that are not yet implemented.

### High Priority

| # | Feature | Notes |
|---|---------|-------|
| 1 | **Measurement tools** (distance, area, bearing) | ✅ Partial — drawn lines, polygons and rectangles show live per-segment distances (m/km), and polygons/rectangles also show geodesic area (m²/km²), all with 2-decimal readouts; bearing and ha/acre units are still missing. |
| 2 | **Full-screen mode** | No fullscreen toggle. OpenLayers has a built-in `FullScreen` control. |
| 3 | **Geolocation / "Locate me"** | No browser Geolocation API integration to centre the map on the user's position. |
| 4 | **Export map as image (PNG / PDF)** | No way to save the current map view as a raster image or PDF via canvas capture. |
| 5 | **Map rotation + North arrow** | View is locked to north-up. No rotation gesture, rotation reset button, or north-arrow indicator. |
| 6 | **WMS GetFeatureInfo** | WMS layers are rendered but clicking them doesn't issue a `GetFeatureInfo` request to inspect raster attributes. |

### Medium Priority

| # | Feature | Notes |
|---|---------|-------|
| 7 | **Minimap / Overview map** | No inset overview showing the current extent in broader context. OpenLayers ships an `OverviewMap` control. |
| 8 | **Layer legend / WMS GetLegendGraphic** | No automatic legend. WMS services expose `GetLegendGraphic` for per-layer symbology images. |
| 9 | **Feature search / attribute filter** | No way to search or filter vector features by attribute values (e.g. `status = 'active'`). |
| 10 | **Bookmarks / Saved views** | No named bookmarks. Users can't save multiple named extents (e.g. "Adelaide CBD", "Study Area"). |
| 11 | **Graticule (geographic grid lines)** | Tile-debug grid shows tile boundaries, but no lat/lng graticule overlay with labelled meridians/parallels. |
| 12 | **Undo / Redo for drawing** | No undo/redo stack for drawn features. |
| 13 | **Geometry editing (vertex manipulation)** | ✅ Done — the “Edit vertices” toolbar tool (OpenLayers `Modify`) reshapes drawn lines, polygons and rectangles and moves labels: drag vertices, click a segment to insert one, Alt+click to remove one. Measurements update live. Saved drawn-in-app layers are re-editable in place from the layer edit menu. |
| 14 | **Snapping while drawing** | No snap-to-vertex, snap-to-edge, or snap-to-grid. |
| 15 | **Point clustering** | No clustering for dense point datasets. OpenLayers has `ol/source/Cluster`. |
| 16 | **Keyboard shortcuts** | No hotkeys for tool switching (e.g. `L` = line, `P` = polygon, `Esc` = cancel). |

### Lower Priority

| # | Feature | Notes |
|---|---------|-------|
| 17 | **Temporal / time slider** | No time-based filtering or animation for time-enabled WMS/WFS/STAC data. |
| 18 | **Heatmap rendering** | No heatmap visualisation for point density. OpenLayers has `ol/layer/Heatmap`. |
| 19 | **Layer groups / folders** | No grouping of layers into collapsible folders. |
| 20 | **Print layout** | No composed print output with title, scale bar, legend, and north arrow. |
| 21 | **Offline tile caching** | No service-worker or IndexedDB tile cache for offline use. |
| 22 | **Split-screen / swipe comparison** | No side-by-side or swipe-divider layer comparison. |
| 23 | **Dark mode / UI theme** | No UI theme switching (map basemaps have dark options, but app chrome is always light). |
| 24 | **Mobile-responsive layout** | No `@media` queries or touch-optimised layout; settings dialog is fixed at 480 px. |
| 25 | **Coordinate transformation widget** | No standalone "convert coordinates" tool between arbitrary EPSG codes. |
| 26 | **Project import / export** | No way to export the full project (all layers + styles + view) as a shareable JSON file and re-import it. |
| 27 | **Layer metadata display** | No display of service metadata (abstract, keywords, contact) from WMTS/WMS capabilities documents. |
| 28 | **Routing / directions** | No point-to-point routing (OSRM, GraphHopper, etc.). |
| 29 | **Elevation profile** | No terrain/elevation data support or profile chart along a drawn line. |
| 30 | **Right-click context menu on map** | No context menu on the map (e.g. "copy coordinates", "zoom here", "add label here"). |
