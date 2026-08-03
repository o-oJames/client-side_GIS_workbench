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
- **COG** (Cloud Optimized GeoTIFF) layers — rendered via an OpenLayers `WebGLTile` layer with a `GeoTIFF` source that streams only the tiles/overviews needed for the current view:
  - **HTTP URL** — point at any publicly accessible `.tif` / `.tiff` endpoint
  - **S3 / S3-compatible object storage** — enter bucket, object key, region, and an optional custom endpoint (MinIO, Cloudflare R2, Wasabi, Backblaze B2, etc.); public objects are accessed via plain HTTPS, private objects via browser-native **AWS Signature V4 pre-signed URLs** (no SDK required — HMAC-SHA256 signing runs entirely in the browser with the Web Crypto API); optional session-token support for temporary credentials
  - **Local file upload** — drag-and-drop or browse for a `.tif` / `.tiff` file; the file is validated in-browser (TIFF magic bytes, internal tiling tags, IFD placement) and stored in IndexedDB; classic TIFF and BigTIFF are both supported; non-COG TIFFs over 50 MB are rejected with a `gdal_translate -of COGT` hint
  - Automatic source-projection detection and reprojection to EPSG:3857 (WKT and EPSG authority codes parsed from the GeoTIFF metadata; unknown projections are registered on-the-fly via proj4)
  - Zoom-to-extent reads the bounding box directly from the GeoTIFF IFD when capabilities metadata is unavailable
- **WMS GetFeatureInfo** — per-layer toggle to issue `GetFeatureInfo` requests on map click, inspecting raster attributes in the feature popup (JSON/GeoJSON responses parsed into attribute tables; raw text/HTML/XML surfaced as-is)
- Per-layer colour adjustments — brightness, saturation, contrast, and opacity (CSS-filter based with renderer patching to prevent cross-layer bleed)
- Per-layer tile zoom range clamping (overzoom/underzoom outside the range)
- Layer visibility toggle
- Drag-and-drop layer reordering
- Zoom-to-extent (extracted from WMTS/WMS capabilities metadata or GeoTIFF IFD)
- Add layers from saved "known sources" with one click

### Vector Layers

- **File upload** — GeoJSON, KML, KMZ, and Shapefile (`.zip` with `.shp` + `.dbf` + `.prj`)
- **Drag & drop** files directly onto the map
- **MVT** (Mapbox Vector Tiles) layers via URL
- **WFS** (Web Feature Service) layers — just save the GetCapabilities URL as a known source; the feature-type name is auto-discovered from the capabilities document when the layer is added (a saved type name is used only as a preselect hint)
- **STAC API** layers with collection discovery, automatic pagination, and configurable item limit; also supports **direct STAC Item URLs** — when the URL points at a single static STAC Item JSON document (e.g. an item hosted on S3) rather than a STAC API catalog, the app detects it automatically, wraps the item in a FeatureCollection, and skips the collection/pagination flow
- Per-layer styling — line colour, fill colour, line width, opacity, font colour, font size
- **Point clustering** — a per-layer toggle in the edit menu collapses dense point datasets into count bubbles (via `ol/source/Cluster`), with an adjustable cluster distance; click a bubble to zoom in and expand it. Offered only for point layers
- **Attribute filter** — a per-layer **Filter** toggle pops out a query-expression field; only features matching the expression stay on the map (e.g. `"capture_date" > '2024-01-01'`, `"published" is true`, `"name" like '%park%' and "rating" >= 4`). Comparisons are type-aware (numeric, temporal, string), with `=  !=  <  <=  >  >=`, `IS [NOT] TRUE/FALSE/NULL`, `LIKE`, `IN`, `AND`/`OR`/`NOT` and parentheses; live validation shows the match count before applying. The full dataset is kept intact — clearing the filter restores everything, and the filter persists across reloads. Available for all vector layers except tiled MVT
- Per-feature style overrides within a layer
- Layer visibility toggle
- Drag-and-drop layer reordering
- Zoom-to-extent
- Zoom range (visibility range) per layer
- Export any drawn vector layer via a grouped **Download** menu — **GeoJSON**, **KML**, **Shapefile** (a `.zip` with the full `.shp` + `.shx` + `.dbf` + `.prj` set, split per geometry family for mixed layers) or **KMZ**

### Drawing & Annotation Tools

- Draw **lines**, **polygons**, and **rectangles** on the map
- **Re-edit drawn features** — full vertex-editing tool: drag vertices to reshape, drag the feature body to move the whole line / polygon / label, click a vertex to pick it up (click again to place it, **Del** removes it, **Esc** puts it back), click a segment to insert a vertex, double-click a label to rewrite its text, Alt+click a vertex to remove it — with measurement labels updating live; saved drawn layers get the same editing in place via the **Re-edit layer** button in their edit menu — and in that mode the drawing tools add new features straight into the layer, with undo/redo covering everything
- **Undo / redo** for every drawing and editing action — toolbar buttons or **Ctrl+Z** / **Ctrl+Shift+Z** / **Ctrl+Y**, with redo dropped the moment a new action branches off
- **Live measurements** while drawing and after completion — per-segment vertex-to-vertex distances on lines, polygons and rectangles, plus geodesic area on polygons and rectangles, always with 2 decimals; total length / area also shown in the drawn-features panel
- Add **text labels** with an in-app dialog positioned at the click point — label text stays re-editable afterwards (double-click the label in edit mode, or use the pencil on its row in the drawn-features panel)
- Global draw-style editor (line colour, fill colour, line width, opacity, font colour, font size)
- Per-feature style customisation (overrides the global style)
- Drawn-features panel — list, rename, restyle, and remove individual features
- **Save** drawn features as a persistent vector layer
- **Export** drawn features to GeoJSON, KML, Shapefile (`.zip`) or KMZ from one grouped export menu

### Feature Inspection

- Click any vector feature to inspect its attributes in a popup
- **WMS GetFeatureInfo** results appear alongside vector features in the same popup when the layer's toggle is enabled
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

### Right-Click Context Menu

- Right-clicking the map opens an **in-app menu** (replacing the browser's native context menu) with three actions:
  - **Copy coordinates** — copies the clicked point to the clipboard using the same projection (EPSG:4326 / EPSG:3857) and decimal-places setting as the on-screen readout; the exact value is previewed live in the menu before you copy it
  - **Save image as…** — composites the current map view (every visible layer) into a single PNG and downloads it
  - **Copy image** — copies that same PNG to the clipboard, ready to paste into another app
  - Under an **Include details** heading, three checkboxes choose which chrome is composited onto the captured image: **Scale bar** (a classic alternating black/white bar labelled with a round distance that honours the metric/imperial units setting), **Legend** (every visible raster/vector layer with a colour swatch) and **North arrow** — the selection applies to both *Save image as…* and *Copy image* and is kept for the session
- **Right-click the settings (gear) button** for a shortcut menu: **Lock app** (locks immediately when the password is in memory, otherwise confirms or sets it first) and **Reset password…** appear whenever a password exists, followed by a **Display** section with quick on/off toggles for **Basemap**, **Show grid**, **Drawing tool** and **Show coordinates** — the same switches as the top of the settings dialog, applied without opening it
- The menu is fully keyboard-navigable (arrow keys, Home/End, Enter, Esc), flips its anchor corner to stay on-screen near the map edges, and dismisses on any other interaction (click elsewhere, scroll-wheel zoom, resize)
- Right-clicks on controls, popups, panels and text inputs keep their native browser menu
- Image capture needs tiles loaded with CORS: the bundled basemaps and XYZ layers are requested with `crossOrigin: 'anonymous'`, and a clear toast explains things if a layer still blocks capture

### Projection Support

- **proj4** integration for on-the-fly reprojection
- Automatic WKT projection parsing (both ESRI and GDAL/OGR formats)
- EPSG code lookup from [epsg.io](https://epsg.io)
- Built-in definitions for Australian datums — GDA2020 and GDA94 MGA zones, WGS 84 UTM zones
- Automatic EPSG identification from WKT content when no AUTHORITY tag is present

### Layer Groups (Folders)

- Organise **raster and vector layers into named groups** directly from the settings panel — a "+ New group" button sits beside each section title
- **Expandable / collapsible group headers** (chevron) reveal or hide the layers inside the cluster, with a live member count badge
- **Group visibility toggle with per-layer memory** — the tri-state eye on the header hides every layer in the cluster at once, and switching it back on restores each layer's *own* remembered visibility (individually-hidden layers stay hidden); the remembered states persist across reloads. A partially-visible group shows an amber dash
- Inline **group rename** (double-click the name or use the pencil), and removing a group keeps its layers — they simply become ungrouped
- Assign a layer via the **folder button on its row** (pick a group, leave the group, or create one on the spot), or by drag & drop:
  - Drop a layer **onto a group header** to slot it in *above* that group (ungrouped) — the dragged layer takes the group's place. Hold the hover for ~300ms and a collapsed group expands; dropping right after that adds the layer to the *end* of the folder, or keep dragging into the revealed members for a precise drop before/after any member row
  - Drag onto a **row** to place before/after it (top/bottom half, previewed with a blue bar) and release to drop — onto a grouped row this joins that group at the pointer position. Joining or leaving a group commits on **drop** (not live), so you can drag a layer *past* a group's members without it being pulled in
  - Drag a grouped layer away and it leaves its group; drop onto the **section title** to move it to the top of the list, or onto the **end-of-list strip** to move it below everything (the way to place a layer under a group that is last in the list)
- **Drag whole groups to reorder and interleave with individual layers** — grab a group header and drop it onto another group or a layer row (top half = before, bottom half = after), the section title (moves to top) or the drop strip (moves to the end); groups move as one atomic block and can sit anywhere among the individual layers. Empty groups keep a persisted anchor position, so they stay where you put them and are draggable too
- Drag a grouped layer onto the section title to ungroup it; dropping a layer onto another row adopts that row's group
- Groups, membership, and expanded state **persist across sessions** in localStorage

### Workspaces

- **Multiple independent workspaces** — each workspace keeps its own layer stack, layer groups, basemap, UI toggles and saved map view, so you can maintain separate setups (e.g. "Field Survey", "Planning") side by side in the one app
- The **workspace switcher** sits in the bottom-left corner of the Settings dialog footer, on the same row as *Advanced Settings*: a compact trigger showing the active workspace's name opens an upward popover menu
- **Create** a workspace from the dashed "+ New workspace" row — type a name and press **Enter** or click **Apply**; it starts from the app defaults
- **Switch** by clicking any workspace row — the map reloads with that workspace's saved layers, groups and view
- **Rename** (pencil), **duplicate** (copy icon — a full copy of the workspace's layers and settings, named "<name> copy") and **delete** (trash icon with an inline "Sure?" confirmation; the last remaining workspace cannot be deleted)
- Everything persists in localStorage: the workspace registry lives under `mapviewer-workspaces`, and each workspace's settings and view under namespaced keys. Existing installations are migrated automatically — the pre-workspaces setup becomes the "Default" workspace
- **The URL always reflects the active workspace** via a `?ws=<id>` query parameter — switching, creating or deleting workspaces updates the address bar immediately, so copying the URL deep-links straight back to the same workspace (an unknown id in a shared link falls back to your own active workspace)
- **Split-screen comparison (swipe)** — the split-screen button in the Settings panel (next to the lock button) — left-click enters the comparison instantly, and **right-click opens a picker to choose exactly which two workspaces** to compare (pick a left and a right one, then **Apply**, or dismiss the menu with its ✕) — overlays *two workspaces* on the same whole-window extent, each clipped at the divider: the geography is continuous across it, so dragging the divider over a building shows workspace A's data on one side and workspace B's at the very same spot on the other. Both sides share one extent and zoom — pan or zoom either side and both follow, and **scrolling while hovering the divider zooms too** (the divider never swallows the mouse wheel) — and the divider position persists. The coordinate readout stays at the middle-bottom of the screen exactly like the normal view, regardless of the divider position. Settings are grouped into a single panel docked bottom-left, with the gear icon at exactly the same spot as the normal view with **two full-width tabs, one per side**, each labelled with its workspace; workspace selection is integrated into the panel — each tab carries a workspace dropdown for its side (the other side's workspace is disabled) — and switching tabs never closes and reopens the panel. Layer lists toggle freely per side, the **Drawing Tool toggle is greyed out** in split mode, the **lock button** sits in the footer just like the normal view, the **pin button** works too (one shared pin state for the whole panel — pinned keeps it open while you click the maps, and the preference persists for split mode without touching any workspace's own settings), and **Advanced Settings is replaced by Exit Split Mode**. The panel's base settings (basemap / grid / show-coordinates) are **isolated to the split view** — never inherited from or written back to any workspace — defaulting to basemap and coordinates on, and are carried in the URL (`?basemap=…&grid=…&show_coord=…`) so a refresh restores them; the normal view's own settings are untouched. Pick any workspace for either side from the dropdown on its tab's right edge, and close a pane's ✕ to return to normal mode with the *other* pane's workspace as the active one. If only one workspace exists, a blank comparison workspace is created automatically. The URL carries the state (`?split-screen=true&workspaces=<left>,<right>`) so a refresh restores the comparison

### Settings & Persistence

- Settings dialog with pin/unpin to keep it open while interacting with the map
- All persisted settings are **scoped per workspace** — switching workspaces swaps the whole configuration (see [Workspaces](#workspaces))
- **Metric / Imperial switch** (Advanced Settings → Measurement Units) — measurement labels flip between m / km / m² / km² and ft / mi / ft² / mi², and the scale line follows; the choice persists across sessions
- All layer configurations, basemap choice, and UI toggles persisted to **localStorage**
- Drawn-in-app layers serialised (geometry + per-feature styles) and restored across sessions
- Map view (centre + zoom) persisted and also encoded in the URL query string alongside the active workspace (`?ws=…&lat=…&lng=…&z=…`) for easy sharing
- **Known Sources** manager — save, edit, and delete frequently used raster (WMTS/WMS/XYZ) and vector (MVT/WFS/STAC) endpoints

### App Lock

- **Lock the app behind a password** — the padlock button in the Settings dialog footer (bottom-left, next to the workspace switcher) encrypts everything the app persists — workspace registry, per-workspace settings and views, known sources — into a single vault in localStorage, and a full-window lock screen with the app heavily blurred behind it stays centred until the right password is entered
- **First lock sets the password** — a setup dialog (with a live strength meter) appears the first time, because no password is ever stored: it only derives the encryption key (PBKDF2-SHA256, 310,000 iterations → AES-256-GCM via the Web Crypto API; the GCM auth tag doubles as the password check)
- **Set once, lock instantly** — the password is established a single time; every later lock (same session or after unlocking a reloaded page) reuses it and locks immediately without re-asking
- **Right-click the padlock for password options** — a small context menu appears above the lock button: **Reset Password** once a password exists (it asks for the current password first, then a new one with the strength meter, and re-encrypts any active vault in place), or **Set Password** when none has been defined yet (stores a password for future locks without locking right away)
- **Unlocking** restores every key to localStorage verbatim and reloads the map with the previous workspaces, layers and view; a wrong password shows an inline error (with a shake) and leaves the vault untouched
- **"Start fresh"** — a link at the bottom-right of the lock screen (with an inline confirmation) erases the vault and all persisted data and reboots the app clean; it is the only recovery path for a forgotten password
- The password is kept in memory for the session, so re-locking from the Settings footer never asks for it again; reloading the page while locked boots straight into the lock screen

### Project Import / Export

- **Export the full project** as a single shareable binary file (`.mapviewer`) — captures every workspace's layers, styles, layer groups, basemap settings, UI toggles, saved map views, and all IndexedDB-stored geometry blobs (large uploaded files)
- **Password-protected exports** — when the app has a lock password set, the exported file is encrypted with AES-256-GCM (PBKDF2-SHA256, 310,000 iterations), so importing it on another device or browser requires the same password; without a password the export is plain (unencrypted)
- **Import** a `.mapviewer` file to restore the full project — the file header is inspected first; if it is encrypted a password prompt appears before decryption; on success all app state is replaced and the page reloads with the imported workspaces, layers and view
- Binary container format: `MVPX` magic bytes → version → flags → payload (JSON or AES-GCM ciphertext), keeping files compact and tamper-evident
- Located in **Advanced Settings → Project Import / Export**

### Developer Experience

- **TypeScript** throughout
- **Modular architecture** — the large page components (`MapPage`, `SettingsDialog`) are orchestrators over focused form components and React-free `utils/` modules
- **Docker** support for consistent Node.js environments
- **VS Code Dev Container** configuration
- Built with **Create React App**

## Tech Stack

| Technology | Purpose |
|---|---|
| [React 18](https://react.dev/) | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | Type safety |
| [OpenLayers 9](https://openlayers.org/) | Map rendering & geospatial engine |
| [ol/source/GeoTIFF](https://openlayers.org/en/latest/apidoc/module-ol_source_GeoTIFF.html) | Cloud Optimized GeoTIFF streaming (WebGLTile) |
| [proj4js](http://proj4js.org/) | Coordinate reference system reprojection |
| [JSZip](https://stuk.github.io/jszip/) | Shapefile / KMZ archive parsing & writing |
| [React Router 6](https://reactrouter.com/) | Client-side routing |
| [Create React App](https://create-react-app.dev/) | Build tooling |
| [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) | PBKDF2 / AES-256-GCM encryption & AWS Sig V4 signing |

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

### Running Tests

```bash
cd mapviewer
npm test                                  # watch mode
npx react-scripts test --watchAll=false   # single CI run (14 suites, 184 tests)
npx react-scripts test --watchAll=false --coverage  # coverage report → coverage/lcov-report/index.html
```

### Docker

A `Dockerfile` is provided at the project root for running the project without worrying about the host Node.js version. A `.devcontainer/devcontainer.json` is also included for VS Code Dev Containers.

## Project Structure

```
├── Dockerfile                  # Node.js container for consistent builds
├── .devcontainer/              # VS Code Dev Container config
├── sample/                     # Sample data files (e.g. KMZ, GeoJSON, Shapefile)
└── mapviewer/
    ├── public/                 # Static assets
    ├── build/                  # Production build output
    ├── tsconfig.json           # TypeScript configuration
    └── src/
        ├── App.tsx             # Root component (routing, workspace & lock state)
        ├── App.css             # All component styles
        ├── types.ts            # Shared interfaces & type aliases
        ├── constants.ts        # Storage keys, presets, config values
        ├── index.tsx           # React entry point
        ├── hooks/
        │   ├── useDrawSession.ts        # Draw session: tools, features, history, re-edit
        │   ├── useVertexEditing.ts      # Sticky-vertex editing state machine
        │   └── useLayerDragReorder.ts   # Settings dialog drag-and-drop reorder
        ├── components/
        │   ├── MapPage.tsx               # Main map page (OL map, layers, interactions)
        │   ├── SettingsDialog.tsx        # Layer management & settings panel
        │   ├── AdvancedSettingsDialog.tsx # Basemap, known sources, units, project transfer
        │   ├── LayerPanel.tsx            # Layer list DnD, group management helpers
        │   ├── WorkspaceSelector.tsx     # Workspace switcher popover
        │   ├── DrawToolbar.tsx           # Drawing tools, style editor, label dialog
        │   ├── DrawnFeaturesPanel.tsx    # Drawn features list & per-feature styling
        │   ├── GoToBar.tsx              # ZXY / LatLng / Address navigation
        │   ├── MouseCoordinateDisplay.tsx # Real-time cursor coordinate readout
        │   ├── MapContextMenu.tsx        # Right-click context menu (copy coords, image capture)
        │   ├── ColorAlphaEditor.tsx      # RGB color picker + opacity slider
        │   ├── CustomSelect.tsx          # Accessible custom dropdown
        │   ├── TileZoomRangeControl.tsx  # Min/max zoom range inputs
        │   ├── SliderRow.tsx            # Reusable labelled range-slider row
        │   ├── LoadingIndicator.tsx     # Spinner + message row for async operations
        │   ├── MapToast.tsx             # Transient success/error notification
        │   ├── LayerErrorBanner.tsx     # Layer load/render error banner
        │   ├── AddRasterLayerForm.tsx   # Add-raster-layer form (XYZ/WMTS/WMS/COG)
        │   ├── AddVectorLayerForm.tsx   # Add-vector-layer form (file & URL types)
        │   ├── RasterLayerEditForm.tsx  # Raster layer edit menu (colour/zoom controls)
        │   ├── VectorLayerEditForm.tsx  # Vector layer edit menu (style/filter/cluster/export)
        │   ├── Icons.tsx                # SVG icon components
        │   └── AppLock.tsx             # Password setup dialog & lock screen
        └── utils/
            ├── tileHelpers.ts          # XYZ/WMTS/WMS source creation & extent parsing
            ├── layerHelpers.ts         # Layer rendering, WFS/STAC, WMS GetFeatureInfo
            ├── cogHelpers.ts           # COG validation, S3 URL building, AWS Sig V4 pre-signing
            ├── colorHelpers.ts         # Color parsing, conversion, random palette
            ├── measurement.ts          # Geodesic measurement & label styling
            ├── drawHelpers.ts          # Draw styles, vertex editing, undo/redo snapshots
            ├── featureFilter.ts        # Attribute-filter expression parser & evaluator
            ├── workspaceStorage.ts     # Settings & workspace persistence (localStorage)
            ├── idb.ts                  # IndexedDB for large geometry & COG blobs
            ├── projectTransfer.ts     # Project binary export/import (.mapviewer)
            ├── knownSources.ts         # Known-sources CRUD (localStorage)
            ├── appLock.ts             # Password vault (PBKDF2 + AES-256-GCM)
            ├── mapExport.ts           # Map canvas compositing for PNG image capture
            ├── projectionHelper.ts    # WKT/EPSG projection registration
            ├── shapefileParser.ts     # Binary shapefile (.shp/.dbf/.prj) parser
            ├── shapefileWriter.ts     # Binary shapefile (.shp/.shx/.dbf/.prj) writer
            ├── vectorExport.ts        # Shared GeoJSON/KML/Shapefile/KMZ download driver
            ├── vectorStyleHelpers.ts  # Vector style building, style/clustering application
            ├── popupHtml.ts           # Feature-info popup HTML builders
            ├── rasterLayerFactory.ts  # Unified WMTS/WMS/COG/XYZ OL layer creation
            └── layerRestore.ts        # Vector layer restore from storage (MVT/WFS/STAC/drawn/file)
```

## Pending Features

Features commonly found in map applications (QGIS, ArcGIS Online, Mapbox, Google My Maps, etc.) that are not yet implemented.

### High Priority

| # | Feature | Notes |
|---|---------|-------|
| 1 | **Measurement tools** (distance, area, bearing) | ✅ Partial — drawn lines, polygons and rectangles show live per-segment distances (m/km), and polygons/rectangles also show geodesic area (m²/km²), all with 2-decimal readouts; bearing and ha/acre units are still missing. |
| 2 | **Full-screen mode** | No fullscreen toggle. OpenLayers has a built-in `FullScreen` control. |
| 3 | **Geolocation / "Locate me"** | No browser Geolocation API integration to centre the map on the user's position. |
| 4 | **Export map as image (PNG / PDF)** | ✅ Partial — right-click the map and choose **Save image as…** or **Copy image** to capture the current view as a PNG via canvas compositing; the **Include details** checkboxes optionally composite a scale bar, layer legend and north arrow onto the image. A composed PDF export is still missing. |
| 5 | **Map rotation + North arrow** | View is locked to north-up. No rotation gesture or rotation reset button; a north-arrow indicator exists only as an optional overlay on exported images (**Include details** in the map right-click menu), not on the live map. |
| 6 | **WMS GetFeatureInfo** | ✅ Done — per-layer toggle issues `GetFeatureInfo` on map click; JSON/GeoJSON responses are parsed into attribute tables in the popup, raw text/HTML/XML is surfaced as-is. |

### Medium Priority

| # | Feature | Notes |
|---|---------|-------|
| 7 | **Minimap / Overview map** | No inset overview showing the current extent in broader context. OpenLayers ships an `OverviewMap` control. |
| 8 | **Layer legend / WMS GetLegendGraphic** | ✅ Partial — exported images can include an automatic legend listing every visible raster/vector layer with a colour swatch (**Include details** in the map right-click menu); there is still no on-screen legend panel, and WMS `GetLegendGraphic` symbology images are unused. |
| 9 | **Feature search / attribute filter** | ✅ Done — per-layer **Filter** toggle with a full query-expression language (comparisons, `LIKE`, `IN`, `IS NULL`, `AND`/`OR`/`NOT`, parentheses); live match-count validation; persists across reloads. See [Vector Layers](#vector-layers) above. |
| 10 | **Bookmarks / Saved views** | No named bookmarks. Users can't save multiple named extents (e.g. "Adelaide CBD", "Study Area"). |
| 11 | **Graticule (geographic grid lines)** | Tile-debug grid shows tile boundaries, but no lat/lng graticule overlay with labelled meridians/parallels. |
| 12 | **Undo / Redo for drawing** | ✅ Done — snapshot-based undo/redo covers strokes, deletions, vertex drags, whole-feature moves, vertex insert/remove and label text edits; available from the toolbar buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. |
| 13 | **Geometry editing (vertex manipulation)** | ✅ Done — the "Edit vertices" toolbar tool (OpenLayers `Modify` + `Translate`): drag vertices to reshape, drag the feature body to move the whole feature, click a vertex to pick it up (click to place, Del removes, Esc cancels), click a segment to insert, Alt+click to remove. Measurements update live. Saved drawn-in-app layers are re-editable in place from the layer edit menu ("Re-edit layer"), where drawing tools also add new features straight into the layer. |
| 14 | **Snapping while drawing** | No snap-to-vertex, snap-to-edge, or snap-to-grid. |
| 15 | **Point clustering** | ✅ Done — a "Point clustering" checkbox in the vector layer edit menu wraps point layers in `ol/source/Cluster`, with a configurable cluster distance, count-bubble styling, click-to-zoom-to-expand, and per-layer persistence. Only offered for point datasets. |
| 16 | **Keyboard shortcuts** | ✅ Partial — undo/redo hotkeys (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) are wired; tool-switching hotkeys (e.g. `L` = line, `P` = polygon) are still missing. |

### Lower Priority

| # | Feature | Notes |
|---|---------|-------|
| 17 | **Temporal / time slider** | No time-based filtering or animation for time-enabled WMS/WFS/STAC data. |
| 18 | **Heatmap rendering** | No heatmap visualisation for point density. OpenLayers has `ol/layer/Heatmap`. |
| 19 | **Layer groups / folders** | ✅ Done — raster and vector layers can be organised into named, collapsible groups with tri-state visibility, drag-and-drop assignment and reordering, and full session persistence. See [Layer Groups (Folders)](#layer-groups-folders) above. |
| 20 | **Print layout** | No composed print output with a title block; PNG export can already include a scale bar, legend and north arrow (**Include details**), but a titled print layout / PDF remains missing. |
| 21 | **Offline tile caching** | No service-worker or IndexedDB tile cache for offline use. |
| 22 | **Split-screen / swipe comparison** | ✅ Done — swipe-style comparison of two **workspaces** on one shared whole-window extent with a draggable divider (continuous geography across the divider), per-side workspace choice, auto-created second workspace and URL-persisted state (see [Workspaces](#workspaces)). A swipe between individual *layers* within one workspace remains future work. |
| 23 | **Dark mode / UI theme** | No UI theme switching (map basemaps have dark options, but app chrome is always light). |
| 24 | **Mobile-responsive layout** | No `@media` queries or touch-optimised layout; settings dialog is fixed at 480 px. |
| 25 | **Coordinate transformation widget** | No standalone "convert coordinates" tool between arbitrary EPSG codes. |
| 26 | **Project import / export** | ✅ Done — full project export/import as a shareable `.mapviewer` binary file (all workspaces, layers, styles, views and IndexedDB geometry); encrypted with the app's lock password when one is set. See [Project Import / Export](#project-import--export) above. |
| 27 | **Layer metadata display** | No display of service metadata (abstract, keywords, contact) from WMTS/WMS capabilities documents. |
| 28 | **Routing / directions** | No point-to-point routing (OSRM, GraphHopper, etc.). |
| 29 | **Elevation profile** | No terrain/elevation data support or profile chart along a drawn line. |
| 30 | **Right-click context menu on map** | ✅ Done — right-clicking the map opens an in-app menu with **Copy coordinates** (matching the readout's projection/decimals), **Save image as…** and **Copy image**, plus an **Include details** subsection (scale bar / legend / north arrow toggles for the captured image). Right-clicking the settings gear opens a second in-app menu with **Lock app** / **Reset password…** shortcuts (when a password exists) and quick toggles for **Basemap**, **Show grid**, **Drawing tool** and **Show coordinates**. |
