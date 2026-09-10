# Client-Side GIS Workbench

An entirely client-side GIS workbench built with **React**, **TypeScript**, and **OpenLayers**: it displays and manages raster and vector geospatial data from OGC services, tile servers, Cloud Optimized GeoTIFFs, STAC catalogs, and local files, and pairs them with a full in-browser editing toolkit — workspaces, drawing and AI-assisted annotation, measurement, attribute querying, and map export — with no backend and all data kept locally.

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
  - **S3 / S3-compatible object storage** — enter bucket, object key, region, and an optional custom endpoint (MinIO, Cloudflare R2, Wasabi, Backblaze B2, etc.); public objects are accessed via plain HTTPS, private objects via **AWS Signature V4 pre-signed URLs** (no SDK required — HMAC-SHA256 signing runs in the browser with the Web Crypto API, or server-side through the Workbench Companion); optional session-token support for temporary credentials. When the **Workbench Companion** is running, S3 COG requests are automatically proxied through localhost — bypassing bucket CORS restrictions entirely — and credentials are **encrypted at rest** (AES-256-GCM, same two-tier key model as PostGIS connections) so plain-text access keys never touch localStorage
  - **Local file upload** — drag-and-drop or browse for a `.tif` / `.tiff` file; the file is validated in-browser (TIFF magic bytes, internal tiling tags, IFD placement) and then **streamed, never copied** — only a 2 MB header slice is read up front, the GeoTIFF source fetches the rest with HTTP Range requests on a blob URL created straight from the `File` (multi-GB files work), and the `File` + blob URL are kept in a session registry so the layer survives workspace switches within a session but must be re-added after a page reload; classic TIFF and BigTIFF are both supported; non-COG TIFFs over 50 MB are rejected with a `gdal_translate -of COGT` hint
  - Automatic source-projection detection and reprojection to EPSG:3857 (WKT and EPSG authority codes parsed from the GeoTIFF metadata; unknown projections are registered on-the-fly via proj4)
  - Zoom-to-extent reads the bounding box directly from the GeoTIFF IFD when capabilities metadata is unavailable
  - **Band / renderer control** (edit form → *Bands*) — OpenLayers only ever shows a GeoTIFF's first bands as RGB, so multispectral and paletted files come out wrong by default. The panel reads the file's band layout (count, per-band names from GDAL metadata, sample types, statistics, nodata, embedded colour table) and offers six renderers: **Default**, **RGB** (any three bands as red/green/blue, keeping a genuine alpha channel transparent), **Single band** (grayscale with a min/max display stretch), **Hillshade** (an elevation band as terrain relief with the QGIS sun controls — altitude, azimuth, Z factor, multidirectional blend), **Contours** (QGIS' contour renderer as real vector geometry: the elevation band is sampled at *display ÷ input-downscaling* resolution — QGIS' own Input Downscaling, default 4 — traced with marching squares and drawn as lines with their own width, brush style (solid / dash / dot / dash-dot / dash-dot-dot), colour and optional elevation labels, index contours getting a second symbol; the raster hides underneath and comes back with a grayscale fallback if a trace fails), and **Colour map** (a paletted band drawn through the TIFF colour table, with a ramp preview). Band *mapping* is a pure WebGL style change — it applies live with no extra requests — while a *stretch* is baked into the source's per-band normalisation for full 8-bit precision, so it re-loads the band. Contours are the one renderer outside the shader: a fragment cannot give a line a width, a dash pattern or a label, so they are traced from the file's raw values into a companion vector layer and re-traced when the view settles. The elevations are read from whichever overview of the file suits the current zoom — usually the same level OpenLayers is already rendering, so the read stays small — and when a view cannot be traced at all (a file with no overviews seen from too far out, a view off the edge of the file) the raster comes back and the reason is said in plain words instead of the map going blank. Statistics are read from the full-resolution image (overviews carry no GDAL metadata). Files with no statistics on a floating-point band (which otherwise render all-black) are flagged with a warning, and files the default renderer gets wrong — including float DEMs with statistics, which QGIS would auto-stretch on load — offer a one-click *Use suggested* fix. The choice is stored on the layer and restored with the workspace
  - **The add-layer form only closes once the layer is really on the map** — a failed add (CORS-blocked bucket, unreachable URL, unreadable GeoTIFF, bad region) leaves every field exactly as typed and reports the reason, with the Workbench Companion / bucket-CORS fixes, directly above the **Add** / **Cancel** buttons, so a typo never means filling the whole form in again
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
- **PostGIS Database** — connect to any PostgreSQL/PostGIS database via the companion **MapViewer Workbench Companion** (a small localhost-only Node.js server that bridges the browser to PostgreSQL and proxies S3 COG requests):
  - **Connection management** — save named connections (host, port, database, username, password) via an in-app connection manager; credentials are encrypted in the browser (AES-256-GCM, browser-specific key) and stored as encrypted blobs on disk, so different browser profiles and incognito windows cannot access each other's connections
  - **Table discovery** — pick a saved connection and the app lists every geometry table (schema, table name, geometry type, SRID) from the database's `geometry_columns` view
  - **Layer creation** — select a table, optionally override the geometry column, add a SQL `WHERE` filter, and override the SRID; the layer is added as a live vector layer with full styling, attribute table, filtering and smart-mapping support
  - **MVT tile serving** — once added, the layer fetches vector tiles from the connector's `/tiles/{z}/{x}/{y}` endpoint for efficient rendering at any zoom level
  - **Auto-discovery** — when the app starts it probes ports 40000–40019 for the connector; if it's not running a setup wizard appears with one-line install instructions (npm global, standalone binary, or Docker) and polls until the connector comes up
- Per-layer styling — line colour, fill colour, line width, opacity, font colour, font size
- **Attribute-driven Render (smart mapping)** — a per-layer toggle in the edit menu that styles each feature from one of its attribute values, ArcGIS Online style: **Types** (one colour per distinct value, most frequent first), **Color** (classed ramp over a numeric field — six ramps, 3–7 classes, equal-interval or quantile breaks) or **Size** (proportional point radius / line width, square-root scaled). A live legend preview in the edit menu and a floating on-map legend panel show exactly what each feature looks like given its data (class ranges, categories or sizes, plus a *No data* bucket), and the exported-image legend (**Include details**) lists the classes too. The computed statistics persist with the layer, so legends survive reloads and lazy feature loads. Available for all vector layers except tiled MVT
- **Point clustering** — a per-layer toggle in the edit menu collapses dense point datasets into count bubbles (via `ol/source/Cluster`), with an adjustable cluster distance; click a bubble to zoom in and expand it. Offered only for point layers
- **Attribute filter** — a per-layer **Filter** toggle pops out a query-expression field; only features matching the expression stay on the map (e.g. `"capture_date" > '2024-01-01'`, `"published" is true`, `"name" like '%park%' and "rating" >= 4`). Comparisons are type-aware (numeric, temporal, string), with `=  !=  <  <=  >  >=`, `IS [NOT] TRUE/FALSE/NULL`, `LIKE`, `IN`, `AND`/`OR`/`NOT` and parentheses; live validation shows the match count before applying. The full dataset is kept intact — clearing the filter restores everything, and the filter persists across reloads. Available for all vector layers except tiled MVT
- Per-feature style overrides within a layer
- Layer visibility toggle
- Drag-and-drop layer reordering
- Zoom-to-extent
- Zoom range (visibility range) per layer
- **Attribute table** — spreadsheet view of a layer's features in a movable/resizable window: sorting, selection synced with the map, view modes, statistics, CSV export and cell editing (see [Attribute Table](#attribute-table))
- Export any drawn vector layer via a grouped **Download** menu — **GeoJSON**, **KML**, **Shapefile** (a `.zip` with the full `.shp` + `.shx` + `.dbf` + `.prj` set, split per geometry family for mixed layers) or **KMZ**
- **Geometry re-editing for file-imported layers** — layers added from GeoJSON / KML / KMZ / Shapefile can be re-edited in place via the **Edit geometry** button in their edit menu, with full vertex editing and attribute preservation (see [Drawing & Annotation Tools](#drawing--annotation-tools))

### Drawing & Annotation Tools

- **Box selection** — the first toolbar button. Click two corners on the map to span a dashed selection box (a live preview follows the pointer between clicks); click-drag still pans the map while the tool is active. The finished box can be **moved** (drag its body) and **resized** (drag any of its eight handles), stays glued to the ground through pan/zoom, and right-clicking it opens a dedicated menu: **Features** (inspect everything inside the box), **Copy selection as image**, **Save selection image as…** and **Delete selection** (removes the box so a new one can be drawn). **Esc** clears the box or cancels a pending corner
- Draw **lines**, **polygons**, **rectangles** and **circles** on the map
- **Circle tool with two circle types** — the button under the rectangle tool draws a circle with two clicks (**click the centre, then click where the radius ends**, with a live preview and area readout in between). **Right-click** the button for its submenu and choose which circle you mean: **Circle geometry** builds a perfect circle *in the map projection* (a constant radius in projected units, so it stays round on screen at any latitude, while its true ground radius grows toward the poles), or **Geodesic circle** builds a circle *on the earth* (every point at the same great-circle distance from the centre, via OpenLayers' `circular()` — a true ground radius, which looks slightly egg-shaped in Web Mercator away from the equator). The chosen type is ticked in the submenu, badges the toolbar button in amber, names the feature (`Circle 1` / `Geodesic Circle 1`, each with its own counter) and is remembered for the session, so switching tools and coming back keeps it. Both land as ordinary 128-vertex polygons, so circles export, persist, measure, vertex-edit and feed the Vector Tools like any other drawn polygon. **Every circle also drops a point on its centre** — the coordinate it was struck from, which its own ring does not contain — listed directly under it as `Circle 1 Center` / `Geodesic Circle 1 Center` with a small *centre* badge. It is an ordinary point feature (styled, saved, exported, vertex-editable, and useful as the start of a radius or bearing measure), but it belongs to its circle: it follows the circle's rename, arrives and leaves in the same undo step, and is removed when the circle is removed — while still being deletable on its own if only the point is unwanted
- **Snap to object (AI magic wand)** — the wand tool (6th toolbar button) runs a **SAM model entirely in your browser** (ONNX Runtime Web, WebGPU with CPU/WASM fallback) — the best available: **SAM 2.1 Tiny** where its ~104 MiB encoder can ship (local/dev builds), otherwise **SlimSAM-77**, a distilled SAM small enough for hosted deployments: click any object (building, road, paddock…) and its outline is traced into a live polygon preview; **click again to refine**, **Shift+click to exclude** parts ("intelligent scissors"), **right-click a marker to remove** that refine/exclude point (**Backspace** removes the most recent one), **Enter** or **double-click** commits the polygon to your drawings, **Esc** cancels. Committed polygons are **auto-named and labelled from their geometry + layer context**: the shape is classified (`Building 2 — 245.32 m²`, `Road 1 — …`, `Area 3 — …`, optionally with the layer traced from), and when an existing vector feature with a name-like attribute sits under the polygon the name is inherited instead (e.g. `Adelaide Hospital — 1.20 km²`). Because mask outlines are jaggy, the **as-traced outline is stashed in IndexedDB** and a **Clean up outline** slider appears in the feature's editor: drag it back and forth to tune the vertex count (Douglas–Peucker) with the polygon updating live on the map — any time before **Save to Layers**, which finalises the shape and drops the stash (undo restores the pre-gesture shape). Model sourcing is resilient and fully offline: candidates are tried best-first (SAM 2.1 Tiny, then SlimSAM-77), each via its **IndexedDB** cache, then its bundled copy under `public/models/` — the SAM 2.1 copy is the *repaired* If-node-folded export, and the SlimSAM fp32 files fit Cloudflare's 25 MiB static-asset limit so they ship with every deployment. Every payload is validated by actually creating the inference sessions before it is accepted and cached, so nothing re-fetches on refresh
- **Magnetic edge snapping for lines/polygons (livewire)** — right-click the line or polygon tool button to arm magnetic mode (blue badge): a classical, model-free edge detector (per-channel Sobel gradient → non-maximum suppression → hysteresis chain tracing — the classic "intelligent scissors" front end) scans the current map image and shows the detected edges as a faint dashed guide. While drawing, **hold Shift** and the pointer snaps to the nearest detected edge (vertex + edge snapping with a live marker) — vertices can be placed while Shift is held, so rooftops, roads and boundaries in raster imagery are traced without any AI model. Detection is colour-aware (chroma-only edges are found too) and honours per-layer brightness/saturation/contrast adjustments; edges re-extract automatically as you pan/zoom. Right-click the tool again to turn it off
- **Re-edit drawn features** — full vertex-editing tool: drag vertices to reshape, drag the feature body to move the whole line / polygon / label, click a vertex to pick it up (click again to place it, **Del** removes it, **Esc** puts it back), click a segment to insert a vertex, double-click a label to rewrite its text, Alt+click a vertex to remove it — with measurement labels updating live; saved drawn layers get the same editing in place via the **Re-edit layer** button in their edit menu — and in that mode the drawing tools add new features straight into the layer, with undo/redo covering everything. **File-imported layers** (GeoJSON / KML / KMZ / Shapefile) get the identical session from the **Edit geometry** button in their edit menu, with every attribute preserved through gestures, undo steps and the persistence flush. While a session is live the toolbar's edit-vertices tool shows active, and clicking it off ends the session exactly like **Done editing**; reopening the settings panel mid-session restores the editor section and scrolls its button into view. Vertex/segment picking is pruned by the source's spatial index and computed in map units, so layers with tens of thousands of imported features stay responsive under the pointer, and the undo stack is additionally bounded by a total vertex budget so huge layers can't exhaust the tab's memory
- **Undo / redo** for every drawing and editing action — toolbar buttons or **Ctrl+Z** / **Ctrl+Shift+Z** / **Ctrl+Y**, with redo dropped the moment a new action branches off
- **Live measurements** while drawing and after completion — per-segment vertex-to-vertex distances on lines, polygons and rectangles, plus geodesic area on polygons, rectangles and circles, always with 2 decimals; total length / area also shown in the drawn-features panel. On-map labels are toggled per feature from its editor (drawn-features panel or the saved layer's edit menu): shown by default, but hidden by default once a feature has more than 30 vertices (the user's choice always wins and persists) — circles are the exception, since their 128-vertex ring only ever carries the single area chip
- **Feature name labels** — each drawn line or polygon can show its name on the map via a **Show name label** toggle in the feature's editor (drawn-features panel or saved layer's edit menu): polygons anchor the label on their interior point above the area chip (always inside the ring, even when concave), lines on their midpoint below the distance chips. Wand-traced polygons show their auto-name by default; the explicit choice rides along with the feature through the draw session, undo/redo and saved-layer persistence. Renaming is inline — click a feature's name in the drawn-features panel (**Enter** commits, **Esc** cancels) — and a manual rename is never overridden by auto-naming
- Add **text labels** with an in-app dialog positioned at the click point — label text stays re-editable afterwards (double-click the label in edit mode, or use the pencil on its row in the drawn-features panel)
- Global draw-style editor (line colour, fill colour, line width, opacity, font colour, font size)
- Per-feature style customisation (overrides the global style)
- Drawn-features panel — list, restyle, and remove individual features, with inline rename (click a feature's name to edit it)
- **Save** drawn features as a persistent vector layer
- **Export** drawn features to GeoJSON, KML, Shapefile (`.zip`) or KMZ from one grouped export menu

### Feature Inspection

- Click any vector feature to inspect its attributes in a popup
- **Box selection queries** — the box-selection tool's **Features** action shows the same popup for everything intersecting the box: vector features across all visible layers (clusters expanded, topmost layer first) plus WMS `GetFeatureInfo` results queried with the box as the bounding box
- **WMS GetFeatureInfo** results appear alongside vector features in the same popup when the layer's toggle is enabled
- Multi-feature popup with collapsible per-feature sections
- "Collapse all" / "Show all" quick actions in the popup footer

### Attribute Table

- **ArcGIS Online-style attribute table** for vector layers — open it from the table button on a layer's row in the settings panel (every vector type except tiled MVT): columns are the layer's attribute fields, rows are its features, and row numbers identify the *feature* (they stay with the record through sorting, like an FID)
- **A floating desktop-OS window** — drag it by the title bar, resize from any edge or corner, maximize/restore, close from the top-right button; the window's position, size and open layer are remembered, so the table comes back where you left it after a reload (per workspace)
- **Virtualised grid** — only the visible band of rows exists in the DOM while records stream from the layer's live feature source, so hundred-thousand-feature layers scroll smoothly; dataset changes (WFS/STAC loads, filter swaps, cell edits) propagate automatically
- **Sorting** — click a column header to sort ascending, click again to flip descending (arrow indicator on the active column); **Shift-click** additional headers to combine multiple sort columns, with numbered badges showing sort precedence; a toolbar chip summarises the active sort and clears it in one click
- **Selection with two-way map sync** — row checkboxes, **Ctrl/Cmd-click** to toggle, **Shift-click** for ranges, header checkbox to select/deselect everything in view. Selected rows glow **cyan on the map** (points, lines and polygons) and **Zoom to** fits them in the frame; conversely, clicking a feature on the map selects its row and scrolls the table to it (Ctrl-click adds), and map selection from box-style workflows shows up as checked rows
- **View modes** — one dropdown switches what the table shows: **Show all** (every record), **Show selected** (checked rows only), **Show visible** (features in the current map extent — re-queried as you pan/zoom) and **Show filtered** (features matching the layer's attribute filter). The toolbar always reports *shown of total* records plus active filter/sort state
- **Filter by attribute expression** — the options menu's *Filter by attribute…* opens an inline bar for the same query language as the layer filter (e.g. `"pop" > 100000 and "klass" like '%city%'`), with inline validation errors, an applied-filter chip, and one-click clear
- **Options menu** — *Show / hide columns* (per-field visibility), *Statistics…* (count, min, max, mean, standard deviation and a 10-bin histogram for every numeric field in the current view), *Export to CSV* (exactly the rows and columns on screen — RFC-4180 escaping, UTF-8 with BOM so Excel opens it cleanly), plus clear-sorting / clear-selection shortcuts
- **Direct cell editing** — double-click a cell to type a new value (**Enter** commits, **Esc** cancels); numeric fields are type-checked, the write lands on the feature immediately (the map restyles/restylers live, attribute-filter and smart-mapping included) and is persisted to the workspace straight away

### Vector Tools (Geoprocessing)

- **A QGIS-style processing window** — open it from the geoprocessing button on the settings panel toolbar: a floating desktop-OS window (drag by the title bar, resize from any edge or corner) with a searchable tool rail on the left and the selected tool's form on the right. **28 tools in three categories**, each with a plain-language description and an auto-suggested output name (`<Tool> of <layer>`)
- **Geometry Tool** — Centroids, Point on Surface (a point guaranteed to be inside, unlike the centroid of a C-shape or a donut), Check Validity (the GEOS/QGIS error classes, every reason per feature, plus an optional error-point layer), Make Valid (lossless: a bowtie keeps both lobes), Collect Geometries (optionally grouped by field), Delaunay Triangulation (snapping tolerance, triangles or edges), Densify by Count, Add Geometry Attributes (ground area/length/perimeter, lon-lat or map-unit x/y, vertex count), Extract Vertices (with `vertex_index`, `vertex_part`, `distance` and turn `angle`), Multipart to Singleparts, Polygons to Lines, Simplify (Douglas-Peucker or Visvalingam-Whyatt, preserve-topology guard, ground-metre tolerance), Voronoi Polygons (buffer region %, copy attributes), Lines to Polygons, Polygonize
- **Geoprocessing Tool** — Buffer (ground-metre distance and units, per-feature distance from a field, segments, round/flat/square end caps, round/miter/bevel joins with a miter limit, single-sided line buffers, negative distances to inset, dissolve result, separate disjoint parts), Clip, Intersect, Union, Difference, Symmetrical Difference, Dissolve (by field, keep disjoint features separate), Convex Hull (per feature or whole layer), Distance (nearest, k-nearest, or every pair), Eliminate Selected Polygons (largest area / smallest area / largest common boundary)
- **Manage Layers** — Merge Vector Layers (unified schema across the chosen layers), Split Vector Layer (one output layer per unique value of a chosen field, with names sanitised for the download), Remove Selected Features
- **A real overlay kernel** — every boolean operation runs through a hand-written planar overlay engine modelled on JTS OverlayNG (node the segments → label both sides of each edge → keep the edges where the two sides disagree → walk them into rings). That is what makes Clip exact for concave and donut cutters *and* able to clip points and lines, Intersect keep both attribute tables (colliding field names suffixed `_2` instead of overwritten), Union behave like the QGIS overlay (the intersection with both tables, plus each layer's exclusive parts with the foreign fields nulled), Dissolve merge N polygons in one pass with no convex-hull fallback, Make Valid keep every lobe of a self-intersecting polygon, and Eliminate absorb a selection across any shared boundary — including a partial one
- **Non-destructive** — every tool writes a **new** vector layer (random colours, auto-fitted in the view); the input layers are never modified
- **Click-to-select on the map** — Eliminate and Remove Selected Features arm a picker that toggles features of the input layer on click; Remove Selected Features also highlights the picks in red on the map
- **Real measurements** — areas, lengths and distances are computed on the sphere (the same maths as the measure tool), so they are true ground metres with polygon holes subtracted, not stretched Web Mercator units
- **Progress and Cancel** — the heavy tools (clip, intersect, union, difference, dissolve, distance, Delaunay, Voronoi, eliminate) run in time-sliced chunks with a progress bar and a Cancel button that really stops the run; dissolve is chunked per connected component so a layer of scattered parcels never blocks the UI
- **Honest about its limits** — the kernel is hand-written TypeScript rather than GEOS/JTS/WASM (the stack stays React + OpenLayers + proj4), and the places where it still deviates are flagged in the UI with an amber caveat rather than left to surprise you: Delaunay's floating-point incircle test is fragile for exactly cocircular or near-duplicate seeds (which is what its snapping tolerance is for). Neutral implementation notes — arc tessellation, Voronoi's half-plane construction — are shown as ordinary hints
- **Verified, not just tested** — five suites back the tools. `overlay.property.test.ts` fuzzes the kernel with seeded generators (concave stars, donuts, jittered parcel grids, near-coincident duplicates) and checks the invariants every correct overlay must satisfy — area conservation, inclusion–exclusion, idempotence, commutativity, associativity, and byte-identical output under any subject order — plus a point-membership oracle written independently of the kernel, so a mislabelled edge cannot agree with itself; the same scenarios are re-run at Web Mercator magnitudes. `validity.geos.test.ts` and `overlay.geos.test.ts` are **differential tests against GEOS itself**: `geos-golden.py` asks the GEOS 3.14.1 that ships with QGIS for the verdict, the reason, the error location, the `ST_MakeValid` result, 48 overlay areas and 135 buffer areas, and writes them to a committed JSON the tests read. That harness — the generator, the golden JSON and both suites — lives in [`geoprocessing_tool_tests/`](geoprocessing_tool_tests/) at the repo root rather than inside the app package, because none of it ships; it still runs as part of `gis_workbench`'s suite. Check Validity now agrees with GEOS on every one of 17 rule-probing cases and on all 16 288 real localities, Make Valid returns GEOS's part count *and* area on 15 of them, and 109 of the 135 buffers plus all 48 overlays match GEOS to better than 1e-9 relative — most to 1e-13 — with the 27 exceptions each carrying a written reason in the golden file. `geoprocessing.realdata.test.ts` runs the tools on the real datasets in `sample/`: dissolve is diffed against a checked-in **QGIS 3.44.7** output by symmetric difference (identical, to the last vertex), geodesic areas are checked against Victoria's official 227 449 km² and an independent spherical-excess integral, and road buffers are checked against the *definition* of a buffer — every probe point within the distance is inside, none beyond it. `GeoProcessingPanel.tools.test.tsx` walks all 28 tools in the DOM on polygon, point and line input. Those suites found and fixed a dozen defects, among them: a hole nested into an island smaller than itself, NaN ordinates leaking into results, validity that changed when the same ring was moved to a different part of the map, pinched rings returned as one invalid figure-eight, 68 of 94 real road buffers invalid and 57 % too large, an erosion that inverted into a small valid-looking polygon on the wrong side of the crossing, three squares whose union returned *nothing at all* in one input order, and a validity rule that flagged data QGIS and PostGIS both accept
- **Where it still falls short** — every one of these is pinned by a test that names it, so none can widen unnoticed. (1) *No exact-arithmetic predicates*: the kernel snaps coordinates instead, so boundaries closer than the snapping tolerance (1 µm on a local layer, 0.3 mm at global extent) are merged where GEOS keeps its 5e-7 sliver — that is the trade for having no GEOS. (2) *Nonzero winding*: ground covered twice by one geometry counts as covered, which is what keeps a self-overlapping buffer curve and a stray hole outside its shell from losing area, and costs agreement with GEOS on two pathological inputs (a duplicated hole, a hole whose base lies on the shell boundary). (3) *Cap styles on points* are ignored — GEOS returns an empty geometry for a flat-capped point buffer, which is a bug-compatibility this app does not want. (4) *A flat-capped or single-sided buffer of a line whose segments are far shorter than the distance* disagrees with GEOS about how to cut through a self-overlap (round, mitre and bevel agree to 1e-13 on the same input, and single-sided open lines agree on both signs). GEOS's own single-sided buffer of a *closed* ring is not self-consistent — it returns the inward offset at one distance and the ring's own interior at another — so there this kernel keeps to the definition: the band on the requested side, clipped by the ring. (5) *No Web Worker*: one connected component is one synchronous kernel call, so dissolving a single 50 000-parcel blob that all touches blocks the tab until it finishes — Cancel lands between components, which is most real layers. (6) *Delaunay's incircle test* is floating-point, hence its snapping tolerance

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
- Right-clicking a **selection box** (box-selection tool) opens its own menu with **Features**, **Copy selection as image**, **Save selection image as…** (both capture only the boxed region of the composited map) and **Delete selection**
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
- **Closing the panel never loses what you were typing** — an unpinned panel closes on any outside click (or its ✕), but it only *hides*: a half-filled **Add Raster Layer** / **Add Vector Layer** form (typed names and URLs, the chosen source type, a picked file, discovered WMTS/WMS/WFS/STAC lists) and any open layer edit form are exactly as you left them when you reopen the panel. Pending content is cleared only by **Cancel**, a successful **Add**, or switching workspace (a lock/unlock cycle or a page reload starts fresh too)
- All persisted settings are **scoped per workspace** — switching workspaces swaps the whole configuration (see [Workspaces](#workspaces))
- **Metric / Imperial switch** (Advanced Settings → Measurement Units) — measurement labels flip between m / km / m² / km² and ft / mi / ft² / mi², and the scale line follows; the choice persists across sessions
- All layer configurations, basemap choice, and UI toggles persisted to **localStorage**
- Drawn-in-app layers serialised (geometry + per-feature styles) and restored across sessions
- Map view (centre + zoom) persisted and also encoded in the URL query string alongside the active workspace (`?ws=…&lat=…&lng=…&z=…`) for easy sharing
- **Known Sources** manager — save, edit, and delete frequently used raster (WMTS/WMS/XYZ) and vector (MVT/WFS/STAC) endpoints
- **Attribute table state** — the open table's layer persists per workspace and its window geometry (position/size/maximized) globally, so the table reopens in place after a reload

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
- Built with **Vite**

## Tech Stack

| Technology | Purpose |
|---|---|
| [React 18](https://react.dev/) | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | Type safety |
| [OpenLayers 10](https://openlayers.org/) | Map rendering & geospatial engine |
| [ol/source/GeoTIFF](https://openlayers.org/en/latest/apidoc/module-ol_source_GeoTIFF.html) | Cloud Optimized GeoTIFF streaming (WebGLTile) |
| [proj4js](http://proj4js.org/) | Coordinate reference system reprojection |
| [JSZip](https://stuk.github.io/jszip/) | Shapefile / KMZ archive parsing & writing |
| [React Router 6](https://reactrouter.com/) | Client-side routing |
| [Vite](https://vitejs.dev/) | Build tooling (fast HMR, native ESM) |
| [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) | PBKDF2 / AES-256-GCM encryption & AWS Sig V4 signing |

## Getting Started

### Prerequisites

- Node.js (see Dockerfile for the version used in CI)

### Install & Run

```bash
cd gis_workbench
npm install
npm start
```

The app opens at [http://localhost:3000](http://localhost:3000) and redirects to `/map`.

### Build for Production

```bash
cd gis_workbench
npm run build
```

### Running Tests

```bash
cd gis_workbench
npm test                                  # watch mode
npx vitest run                            # single CI run (66 suites, 1 599 tests)
npm run test:geos                         # only the differential GEOS suites
npx vitest run --coverage                 # coverage report → coverage/index.html
```

The run includes `../geoprocessing_tool_tests/`, which lives outside the app
package but belongs to the same vitest project. Three of those tests skip unless
the git-ignored `sample/` datasets are present.

Regenerating the GEOS golden data is a manual step, only needed when the case list
or an engine *rule* changes (requires a Python with `shapely`):

```bash
/Applications/QGIS.app/Contents/MacOS/python geoprocessing_tool_tests/geos-golden.py
```

### Workbench Companion (optional)

The Workbench Companion is a small companion server that lets the web app query PostgreSQL/PostGIS databases **and** proxy S3 Cloud Optimized GeoTIFF requests (bypassing CORS). It runs on `localhost` only and uses a client-side encryption model for maximum security.

```bash
# Option A — npm global install
npm install -g mapviewer-workbench-companion
workbench-companion

# Option B — run from source
cd workbench-companion
npm install
npm start          # listens on http://localhost:40000

# Option C — standalone binary (macOS / Windows / Linux)
# Download from https://github.com/mapviewer/connector/releases
```

The connector auto-increments its port (40000–40019) if the default is taken. The web app probes these ports on startup and shows a setup wizard if none respond.

**Security model:**
- **Client-side encryption** — the browser encrypts credentials (PostGIS passwords and S3 access keys) with a browser-specific key before sending to the companion
- **Two-tier key management** — Tier 1: random 256-bit key in localStorage; Tier 2: password-derived key via PBKDF2 (when app-lock password is set)
- **Browser isolation** — each browser profile has its own encryption key, so incognito windows and different profiles cannot access each other's connections
- **Encrypted storage** — the companion stores only encrypted blobs (`~/.mapviewer/clients/{clientId}.json` for PostGIS connections, `~/.mapviewer/clients/{clientId}/cog-credentials.json` for S3 keys); it never decrypts credentials at rest
- **S3 COG credentials encrypted at rest** — plain-text AWS access keys are never written to localStorage; they are encrypted (AES-256-GCM) at form-submission time and only decrypted transiently in memory when a COG layer loads
- **Session key encryption** — registration payloads are encrypted with an ephemeral session key (generated on companion startup) before transmission
- **In-memory credentials** — decrypted PostGIS credentials are held in memory only (lost on companion restart)
- **Automatic migration** — legacy connections (encrypted with machine-derived key) are automatically migrated to the new format on first run

Full documentation: [`workbench-companion/README.md`](workbench-companion/README.md) (guide + complete API reference) and [`docs/WORKBENCH_COMPANION.md`](docs/WORKBENCH_COMPANION.md) (design record: rationale, decisions, threat model, status).

### Docker

A `Dockerfile` is provided at the project root for running the project without worrying about the host Node.js version. A `.devcontainer/devcontainer.json` is also included for VS Code Dev Containers.

## Project Structure

```
├── Dockerfile                  # Node.js container for consistent builds
├── .devcontainer/              # VS Code Dev Container config
├── sample/                     # Sample data files (e.g. KMZ, GeoJSON, Shapefile)
├── workbench-companion/        # Companion server for PostgreSQL/PostGIS queries and S3 COG proxy
├── geoprocessing_tool_tests/   # Test-only harness for the Vector Tools panel: the
│   ├── geos-golden.py          #   GEOS oracle script, the golden JSON it generates
│   ├── geosGolden.json         #   (committed), and the two differential suites that
│   ├── validity.geos.test.ts   #   read it. Outside gis_workbench/ because none of it
│   └── overlay.geos.test.ts    #   ships — but still run by its vitest project
└── gis_workbench/
    ├── public/                 # Static assets
    ├── dist/                  # Production build output
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
        │   ├── useBoxSelection.ts       # Box-selection tool (two-click box, move/resize)
        │   ├── useSamTools.ts           # SAM 2.1 AI magic-wand object tracing
        │   ├── useMagneticDraw.ts       # Model-free magnetic edge snapping (livewire)
        │   ├── useCogContours.ts        # COG Contours renderer: companion vector overlay
        │   │                            #   (create/refresh on view settle, hide the raster,
        │   │                            #   symbol-only edits restyle in place)
        │   └── useLayerDragReorder.ts   # Settings dialog drag-and-drop reorder
        ├── components/
        │   ├── MapPage.tsx               # Main map page (OL map, layers, interactions)
        │   ├── SettingsDialog.tsx        # Layer management & settings panel
        │   ├── AdvancedSettingsDialog.tsx # Basemap, known sources, units, project transfer
        │   ├── LayerPanel.tsx            # Layer list DnD, group management helpers
        │   ├── WorkspaceSelector.tsx     # Workspace switcher popover
        │   ├── SplitScreen.tsx           # Split-screen swipe comparison of two workspaces
        │   ├── SplitTabWorkspaceDropdown.tsx # Per-side workspace dropdown for split tabs
        │   ├── DrawToolbar.tsx           # Drawing tools, style editor, label dialog
        │   ├── DrawnFeaturesPanel.tsx    # Drawn features list & per-feature styling
        │   ├── GoToBar.tsx              # ZXY / LatLng / Address navigation
        │   ├── MouseCoordinateDisplay.tsx # Real-time cursor coordinate readout
        │   ├── MapContextMenu.tsx        # Right-click context menu (copy coords, image capture)
        │   ├── BoxContextMenu.tsx        # Selection-box right-click menu
        │   ├── SettingsContextMenu.tsx   # Settings-gear right-click menu
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
        │   ├── CogRenderControl.tsx     # COG band/renderer picker (RGB combo, single-band
        │   │                            #   stretch, hillshade, contours, colour table)
        │   │                            #   inside the edit form
        │   ├── VectorLayerEditForm.tsx  # Vector layer edit menu (style/attribute-render/filter/cluster/export)
        │   ├── AttrLegendPanel.tsx      # Floating on-map legend for attribute-driven layers
        │   ├── AttributeTableWindow.tsx # Attribute table: floating window, virtualised grid,
        │   │                            #   sorting, selection, view modes, stats, CSV, cell edit
        │   ├── GeoProcessingPanel.tsx   # "Vector Tools": 28-tool geoprocessing window
        │   ├── WandCleanupEditor.tsx    # Clean-up slider in a drawn feature's editor (wand)
        │   ├── PostgisSetupWizard.tsx    # Connector download/setup wizard (auto-polls /health)
        │   ├── PostgisConnectionManager.tsx # CRUD UI for saved PostGIS connections
        │   ├── AddPostgisLayerForm.tsx   # Connection picker, table browser, add-layer form
        │   ├── Icons.tsx                # SVG icon components
        │   └── AppLock.tsx             # Password setup dialog & lock screen
        └── utils/
            ├── tileHelpers.ts          # XYZ/WMTS/WMS source creation & extent parsing
            ├── layerHelpers.ts         # Layer rendering, WFS/STAC, WMS GetFeatureInfo
            ├── cogHelpers.ts           # COG validation, S3 URL building, AWS Sig V4 pre-signing
            ├── cogCredentials.ts      # AES-256-GCM encrypt/decrypt for S3 COG credentials at rest
            ├── cogFileRegistry.ts      # Session blob-URL registry for file-based COG layers
            ├── cogBands.ts             # COG band discovery + WebGL band/renderer style builder
            ├── cogContours.ts          # QGIS-style contour tracing: downscaled DEM reads
            │                           #   (from the file's own overviews), marching-squares
            │                           #   lines, line symbols + labels, why a read was refused
            ├── colorHelpers.ts         # Color parsing, conversion, random palette
            ├── measurement.ts          # Geodesic measurement & label styling
            ├── geoTypes.ts             # Shared GeoJSON shapes for the vector engines
            ├── overlay.ts              # Planar overlay kernel (OverlayNG-style): union,
            │                           #   intersection, difference, repair, clip, polygonize,
            │                           #   validity, adjacency, interior points
            ├── geoprocessing.ts        # Vector Tools engines (buffer, clip, intersect, union,
            │                           #   difference, dissolve, centroid, hull, distance,
            │                           #   eliminate, validity, Delaunay, Voronoi, simplify…)
            ├── geodesic.ts             # Pure spherical measures over EPSG:3857 (area/length/distance)
            ├── geomIndex.ts            # Extent helpers + R-tree index for the pairwise engines
            ├── drawHelpers.ts          # Draw styles, vertex editing, undo/redo snapshots
            ├── featureFilter.ts        # Attribute-filter expression parser & evaluator
            ├── workspaceStorage.ts     # Settings & workspace persistence (localStorage)
            ├── idb.ts                  # IndexedDB for large geometry blobs & SAM model bytes
            ├── projectTransfer.ts     # Project binary export/import (.mapviewer)
            ├── knownSources.ts         # Known-sources CRUD (localStorage)
            ├── appLock.ts             # Password vault (PBKDF2 + AES-256-GCM)
            ├── mapExport.ts           # Map canvas compositing for PNG image capture
            ├── mapImageOverlays.ts    # Scale bar / legend / north arrow for captured images
            ├── projectionHelper.ts    # WKT/EPSG projection registration
            ├── shapefileParser.ts     # Binary shapefile (.shp/.dbf/.prj) parser
            ├── shapefileWriter.ts     # Binary shapefile (.shp/.shx/.dbf/.prj) writer
            ├── vectorExport.ts        # Shared GeoJSON/KML/Shapefile/KMZ download driver
            ├── vectorStyleHelpers.ts  # Vector style building, style/clustering application
            ├── attributeTable.ts      # Attribute table: columns, sorting, statistics, CSV,
            │                          #   virtualised row ranges, window-geometry persistence
            ├── attributeStyle.ts      # Attribute-driven rendering (smart mapping): stats,
            │                          #   classification, ramps/palettes, legend, OL styles
            ├── popupHtml.ts           # Feature-info popup HTML builders
            ├── rasterLayerFactory.ts  # Unified WMTS/WMS/COG/XYZ OL layer creation
            ├── layerRestore.ts        # Vector layer restore from storage (MVT/WFS/STAC/drawn/file)
            ├── samModels.ts           # SAM model defs (SAM 2.1 + SlimSAM), constants & status types
            ├── samEngine.ts           # SAM ONNX Runtime engine (model sourcing, encode/predict)
            ├── contourExtract.ts      # Marching-squares mask→polygon tracing & simplification
            ├── polygonClean.ts        # Douglas–Peucker clean-up of jaggy traced polygons
            ├── autoName.ts            # Auto-naming/label of drawn features (geometry + layer)
            ├── snapOriginalStore.ts   # IndexedDB stash of as-traced wand outlines (clean-up)
            ├── livewire.ts            # Classical edge detection for magnetic drawing
            ├── boxSelection.ts        # Selection-box geometry (extent↔pixels, handles)
            └── companion.ts    # HTTP client for the Workbench Companion (port probe, CRUD, tiles)

workbench-companion/
├── src/
│   ├── server.ts            # Express HTTP server (localhost, port 40000–40019)
│   ├── storage.ts           # Encrypted blob store + in-memory credential registry (session key)
│   └── routes/
│       ├── health.ts        # GET /health — liveness probe + capability advertisement
│       ├── connections.ts   # Connection CRUD (list, create, delete, test)
│       ├── tables.ts        # GET /connections/:id/tables — geometry_columns discovery
│       ├── query.ts         # POST /connections/:id/query — GeoJSON feature queries
│       ├── tiles.ts         # GET /connections/:id/tiles/{z}/{x}/{y} — MVT tile serving
│       ├── cog.ts           # S3 COG proxy, pre-sign, validate, region detection
│       └── cogCredentials.ts # Encrypted S3 credential blob storage per client
├── __tests__/               # Server integration tests (supertest)
├── dist/                    # Compiled output
└── package.json
```

## Pending Features

Features commonly found in map applications (QGIS, ArcGIS Online, Mapbox, Google My Maps, etc.) that are not yet implemented.

### High Priority

| # | Feature | Notes |
|---|---------|-------|
| 1 | **Measurement tools** (distance, area, bearing) | ✅ Partial — drawn lines, polygons and rectangles show live per-segment distances (m/km), and polygons/rectangles/circles also show geodesic area (m²/km²), all with 2-decimal readouts; bearing and ha/acre units are still missing. |
| 2 | **Full-screen mode** | No fullscreen toggle. OpenLayers has a built-in `FullScreen` control. |
| 3 | **Geolocation / "Locate me"** | No browser Geolocation API integration to centre the map on the user's position. |
| 4 | **Export map as image (PNG / PDF)** | ✅ Partial — right-click the map and choose **Save image as…** or **Copy image** to capture the current view as a PNG via canvas compositing; the **Include details** checkboxes optionally composite a scale bar, layer legend and north arrow onto the image. A composed PDF export is still missing. |
| 5 | **Map rotation + North arrow** | View is locked to north-up. No rotation gesture or rotation reset button; a north-arrow indicator exists only as an optional overlay on exported images (**Include details** in the map right-click menu), not on the live map. |
| 6 | **WMS GetFeatureInfo** | ✅ Done — per-layer toggle issues `GetFeatureInfo` on map click; JSON/GeoJSON responses are parsed into attribute tables in the popup, raw text/HTML/XML is surfaced as-is. |

### Medium Priority

| # | Feature | Notes |
|---|---------|-------|
| 7 | **Minimap / Overview map** | No inset overview showing the current extent in broader context. OpenLayers ships an `OverviewMap` control. |
| 8 | **Layer legend / WMS GetLegendGraphic** | ✅ Partial — exported images can include an automatic legend listing every visible raster/vector layer with a colour swatch (**Include details** in the map right-click menu), and an on-screen legend panel now appears automatically for layers using **Attribute-driven Render** (class ranges / categories / sizes); a general on-screen legend for plain-styled layers and WMS `GetLegendGraphic` symbology images are still unused. |
| 9 | **Feature search / attribute filter** | ✅ Done — per-layer **Filter** toggle with a full query-expression language (comparisons, `LIKE`, `IN`, `IS NULL`, `AND`/`OR`/`NOT`, parentheses); live match-count validation; persists across reloads. See [Vector Layers](#vector-layers) above. |
| 10 | **Bookmarks / Saved views** | No named bookmarks. Users can't save multiple named extents (e.g. "Adelaide CBD", "Study Area"). |
| 11 | **Graticule (geographic grid lines)** | Tile-debug grid shows tile boundaries, but no lat/lng graticule overlay with labelled meridians/parallels. |
| 12 | **Undo / Redo for drawing** | ✅ Done — snapshot-based undo/redo covers strokes, deletions, vertex drags, whole-feature moves, vertex insert/remove and label text edits; available from the toolbar buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. |
| 13 | **Geometry editing (vertex manipulation)** | ✅ Done — the "Edit vertices" toolbar tool (OpenLayers `Modify` + `Translate`): drag vertices to reshape, drag the feature body to move the whole feature, click a vertex to pick it up (click to place, Del removes, Esc cancels), click a segment to insert, Alt+click to remove. Measurements update live. Saved drawn-in-app layers are re-editable in place from the layer edit menu ("Re-edit layer"), where drawing tools also add new features straight into the layer; file-imported layers get the same session via "Edit geometry" with attributes preserved. The toolbar tool mirrors an active session (clicking it off ends the session like "Done editing"), and spatial-index-pruned picking keeps large imported layers responsive. |
| 14 | **Snapping while drawing** | ✅ Partial — magnetic edges (livewire): right-click the line/polygon tool and a classical edge detector (no AI model) extracts the current map image's edges; holding Shift while drawing then snaps vertices onto those edges (OpenLayers Snap interaction fed by the detected edge polylines). Classic snap-to-existing-feature-vertex and snap-to-grid are still missing. |
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

## License

Licensed under the **Apache License, Version 2.0** — see [LICENSE](LICENSE) for the full text.

```
Copyright 2026 o-oJames

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### Third-party assets

Bundled third-party assets keep their own licenses:

- **SAM 2.1 Tiny weights** (`gis_workbench/public/models/sam2.1/`) — © Meta Platforms, Inc., [Apache-2.0](https://github.com/facebookresearch/sam2/blob/main/LICENSE).
- **SlimSAM-77 weights** (`gis_workbench/public/models/slimsam/`) — Apache-2.0, sourced from [Xenova/slimsam-77-uniform](https://huggingface.co/Xenova/slimsam-77-uniform).
- **Sample data** (`sample/`) — test fixtures for local use only; check the respective data providers' terms before redistributing.
