# AGENTS.md — Contributor Guidelines for AI Agents

This document is the authoritative guideline for AI agents (and human contributors) working on this codebase. Read it in full before making any changes.

> **⚠️ IMPORTANT: Do NOT automatically run `git add`, `git commit`, or `git push` on this repository. Only perform git operations if the user explicitly asks for them.**

---

## 1. Project Overview

**Client-Side GIS Workbench** is a single-page interactive web map viewer. It renders raster tiles (XYZ, WMTS, WMS, COG) and vector data (GeoJSON, KML, KMZ, Shapefile, MVT, WFS, STAC) on an OpenLayers map, with drawing/annotation tools, feature inspection, layer management, workspaces, and an encrypted app-lock vault.

The entire front-end lives in `gis_workbench/`. There is no back-end server — all persistence is client-side (localStorage + IndexedDB).

---

## 2. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| UI framework | React | 18 |
| Language | TypeScript | 4.9 |
| Map engine | OpenLayers (`ol`) | 9.x |
| CRS reprojection | proj4js | 2.x |
| Archive I/O | JSZip | 3.x |
| Routing | React Router DOM | 6.x |
| Build tooling | Vite | 8.x |
| Crypto | Web Crypto API (native) | — |

No state-management library (Redux, Zustand, etc.) is used. All state is React `useState` / `useRef` / `useCallback` hooks, lifted to the appropriate component.
---

## 3. Architecture & File Responsibilities

```
gis_workbench/src/
├── App.tsx              # Root: routing (/map), workspace registry, lock state
├── App.css              # ALL styles (single file, no CSS modules, ~7 400 lines)
├── types.ts             # Shared interfaces (RasterLayer, VectorLayerConfig, etc.)
├── constants.ts         # Storage keys, basemap presets, config constants
├── index.tsx            # ReactDOM entry
├── index.css            # Minimal body reset
├── components/          # React components (one file each)
│   ├── MapPage.tsx      # ★ Largest file (~3 000 lines) — OL map init, layer
│   │                    #   lifecycle, all map interactions (draw, modify,
│   │                    #   click, context menu, DnD, middle-button pan)
│   ├── SettingsDialog.tsx # ★ Layer management UI (~1 050 lines) — layer CRUD UI,
│   │                    #   add-layer forms, layer edit menus, group
│   │                    #   management, DnD reorder
│   ├── AdvancedSettingsDialog.tsx  # Basemap config, known sources, units,
│   │                    #   project import/export
│   ├── LayerPanel.tsx   # Generic drag-and-drop panel model, group visibility
│   │                    #   toggle, reorder helpers (used by SettingsDialog)
│   ├── WorkspaceSelector.tsx
│   ├── SplitScreen.tsx      # Side-by-side swipe comparison of two workspaces
│   │                    #   (draggable divider, right-click workspace
│   │                    #   picker, per-pane workspace select)
│   ├── SplitTabWorkspaceDropdown.tsx # Per-side workspace dropdown used in
│   │                    #   the split-view panel tabs
│   ├── DrawToolbar.tsx      # Draw-tool buttons (box select, line, polygon,
│   │                        #   rectangle, circle, wand, label, edit vertices,
│   │                        #   scissors, undo/redo) plus the reusable draw
│   │                        #   style editor / per-feature style rows. The
│   │                        #   line/polygon buttons right-click-toggle
│   │                        #   magnetic edges; the circle button right-clicks
│   │                        #   open CircleToolMenu
│   ├── CircleToolMenu.tsx   # Right-click submenu of the Circle tool: pick
│   │                        #   "Circle geometry" (round on the map) or
│   │                        #   "Geodesic circle" (a true ground radius).
│   │                        #   Follows the .map-context-menu-* pattern and is
│   │                        #   portalled to document.body, because the toolbar
│   │                        #   is transformed + scrollable and would clip and
│   │                        #   mis-position a fixed child
│   ├── DrawnFeaturesPanel.tsx
│   ├── GeoProcessingPanel.tsx # ★ "Vector Tools" — floating desktop-OS window
│   │                    #   holding 28 vector tools in three categories
│   │                    #   (Geometry Tool / Geoprocessing Tool / Manage
│   │                    #   Layers): searchable tool rail, input + overlay
│   │                    #   layer pickers, per-tool parameters, click-to-select
│   │                    #   on the map (Eliminate, Remove selected features),
│   │                    #   one shared progress bar with a working Cancel, and
│   │                    #   results added as new GeoJSON layers. Follows the
│   │                    #   AttributeTableWindow gesture model; all geometry
│   │                    #   lives in utils/geoprocessing.ts, and every boolean
│   │                    #   operation goes through utils/overlay.ts
│   ├── GoToBar.tsx
│   ├── MouseCoordinateDisplay.tsx
│   ├── MapContextMenu.tsx
│   ├── BoxContextMenu.tsx   # Selection-box right-click menu (features query,
│   │                    #   copy/save box-region image, delete box)
│   ├── SettingsContextMenu.tsx # Settings-gear right-click menu (lock app,
│   │                    #   reset password, quick display toggles)
│   ├── ColorAlphaEditor.tsx
│   ├── CustomSelect.tsx
│   ├── TileZoomRangeControl.tsx
│   ├── SliderRow.tsx        # Reusable labelled range-slider row (SettingsDialog)
│   ├── LoadingIndicator.tsx # Spinner + message row for async operations
│   ├── MapToast.tsx         # Transient success/error notification (MapPage)
│   ├── LayerErrorBanner.tsx # Layer load/render error banner (MapPage)
│   ├── AddRasterLayerForm.tsx # Self-contained add-raster-layer form (SettingsDialog)
│   ├── AddVectorLayerForm.tsx # Self-contained add-vector-layer form (SettingsDialog)
│   ├── RasterLayerEditForm.tsx # Raster layer edit form with colour/zoom controls
│   ├── CogRenderControl.tsx   # COG band/renderer picker inside the raster edit
│   │                        #   form: renderer mode (default / RGB / single
│   │                        #   band / hillshade / contours / colour map),
│   │                        #   band pickers fed from the
│   │                        #   file's own metadata, single-band min/max
│   │                        #   stretch, colour-table ramp preview
│   ├── VectorLayerEditForm.tsx # Vector layer edit form (style/attribute-render/filter/cluster/export)
│   ├── AttrLegendPanel.tsx    # Floating on-map legend for attribute-driven (smart-mapped) layers
│   ├── AttributeTableWindow.tsx # ArcGIS Online-style attribute table as a floating
│   │                    # desktop-OS window: draggable/resizable/maximizable,
│   │                    # virtualised grid, multi-column sort, checkbox
│   │                    # selection (Ctrl/Shift) with two-way map sync,
│   │                    # Show all/selected/visible/filtered view modes,
│   │                    # filter bar, columns panel, statistics, CSV export,
│   │                    # in-place cell editing
│   ├── WandCleanupEditor.tsx  # Clean-up slider in a drawn feature's editor (wand)
│   ├── Icons.tsx
│   └── AppLock.tsx      # LockScreen, SetPasswordDialog, ResetPasswordDialog,
│                        #   ConfirmPasswordDialog
├── hooks/               # Custom React hooks (may use React freely)
│   ├── useDrawSession.ts    # Draw-toolbar session: tools, drawn features,
│   │                        #   styles, label dialog, undo/redo history,
│   │                        #   session persistence, saved-layer re-edit, and
│   │                        #   the Circle tool's mode (geometric/geodesic,
│   │                        #   read live by the OL geometryFunction)
│   ├── useVertexEditing.ts  # Sticky-vertex pick-up/place state machine +
│   │                        #   Modify/Translate interaction pairs
│   ├── useBoxSelection.ts   # Box-selection tool: two-click dashed box, move/
│   │                        #   resize gestures, DOM overlay kept view-synced
│   ├── useSamTools.ts       # SAM 2.1 AI tool: magic-wand object tracing
│   │                        #   (click → polygon). Edge snapping for
│   │                        #   line/polygon moved to useMagneticDraw
│   ├── useMagneticDraw.ts   # Model-free magnetic edge snapping for the
│   │                        #   line/polygon tools (livewire): captures the
│   │                        #   view, runs classical edge detection and
│   │                        #   Shift-gates an OL Snap interaction fed by
│   │                        #   the detected edge polylines (+ guide layer)
│   ├── useCogContours.ts    # The COG Contours renderer's companion vector
│   │                        #   overlay: created/removed with the renderer,
│   │                        #   re-traced when the view settles, hides the
│   │                        #   raster underneath, restyles symbol-only edits
│   └── useLayerDragReorder.ts # SettingsDialog drag-and-drop reorder
│                            #   (kind-parameterised raster/vector logic)
├── utils/               # Pure logic (no React imports except types)
│   ├── tileHelpers.ts       # XYZ/WMTS/WMS OL source factories, extent parsing
│   ├── layerHelpers.ts      # Renderer patching, colour adjustments, COG tile
│   │                        #   style, WFS/STAC fetch, WMS GetFeatureInfo,
│   │                        #   vector zoom-range, attribute filter application,
│   │                        #   layer reordering
│   ├── cogHelpers.ts        # COG validation (TIFF/BigTIFF magic, tiling tags),
│   │                        #   S3 HTTPS URL building, AWS Sig V4 pre-signing,
│   │                        #   S3 URL parsing
│   ├── cogBands.ts          # COG band discovery (reads the loaded GeoTIFF
│   │                        #   source: band count/names, sample types, GDAL
│   │                        #   statistics, nodata, TIFF colour table) and the
│   │                        #   WebGLTile band/renderer style builder: config
│   │                        #   normalisation, what must be baked into the
│   │                        #   source (`min`/`max`) vs. applied live as a
│   │                        #   `color` expression, palette + RGB + grayscale
│   │                        #   expressions, UI summaries
│   ├── cogFileRegistry.ts   # Session blob-URL registry for file-based COG
│   │                        #   layers (keeps the File + blob URL alive across
│   │                        #   workspace switches; no bytes are copied)
│   ├── featureFilter.ts     # Attribute-filter expression parser & evaluator
│   ├── colorHelpers.ts      # Colour parsing, RGBA conversion, random palette
│   ├── measurement.ts       # Geodesic distance/area, label styling (circles
│   │                        #   get their area chip alone — see circleDraw)
│   ├── geoTypes.ts          # The plain GeoJSON shapes every vector engine
│   │                        #   speaks (Coord/Ring/GeoGeom/GeoFeature) plus the
│   │                        #   part/sequence readers. Kept apart from both
│   │                        #   engines so overlay.ts and geoprocessing.ts share
│   │                        #   one definition without importing each other;
│   │                        #   geoprocessing.ts re-exports them
│   ├── overlay.ts           # ★ The planar overlay kernel — node → label →
│   │                        #   select → assemble, modelled on JTS OverlayNG.
│   │                        #   N-way union, intersection, difference, symmetric
│   │                        #   difference, lossless repair (MakeValid /
│   │                        #   buffer(0)), clip-by-type for points/lines/
│   │                        #   polygons, polygonize, connected components, exact
│   │                        #   adjacency + shared-boundary length, interior
│   │                        #   points, and the GEOS validity classes (including
│   │                        #   the interior-connectedness test GEOS actually
│   │                        #   applies). Snap-rounding is transitive and
│   │                        #   canonical, so an overlay's output does not depend
│   │                        #   on the order its subjects were listed. Read its
│   │                        #   header comment before touching it
│   ├── geoprocessing.ts     # The 28 "Vector Tools" engines: buffer, clip,
│   │                        #   intersect, union, difference, symmetric
│   │                        #   difference, dissolve (by field / keep disjoint),
│   │                        #   centroid, point on surface, convex hull, nearest
│   │                        #   + all-pairs distance, eliminate, check validity,
│   │                        #   make valid, collect geometries, Delaunay,
│   │                        #   densify, add geometry attributes, extract
│   │                        #   vertices, multipart→singleparts, polygons↔lines,
│   │                        #   polygonize, simplify (Douglas-Peucker /
│   │                        #   Visvalingam), Voronoi, merge/split layers, remove
│   │                        #   selected features. Feature-level glue over
│   │                        #   utils/overlay.ts — read the conventions in §3 and
│   │                        #   the pitfalls in §13 before touching it. Buffer
│   │                        #   has two paths: an offset curve, kept when it comes
│   │                        #   back valid, and the exact Minkowski piece union
│   │                        #   GEOS uses when it does not (see §13.30)
│   ├── geodesic.ts          # Pure spherical geodesy over EPSG:3857 input:
│   │                        #   3857↔4326, great-circle distance, spherical-
│   │                        #   excess area (holes subtracted), ground length
│   │                        #   and perimeter. A port of the ol/sphere maths so
│   │                        #   the engines stay measurable without importing OL
│   ├── geomIndex.ts         # Extent helpers plus ExtentIndex, a thin wrapper
│   │                        #   over ol/structs/RBush used to prune the pairwise
│   │                        #   geoprocessing engines (boxes its values — see §13)
│   ├── geosGolden.json      # GENERATED, committed: what GEOS 3.14.1 says about
│   │                        #   17 validity cases, 12 overlay pairs and 81
│   │                        #   buffers. Written by tools/geos-golden.py, read by
│   │                        #   validity.geos.test.ts and overlay.geos.test.ts.
│   │                        #   Never edit it by hand
│   ├── drawHelpers.ts       # Draw styles, vertex editing helpers, undo/redo
│   │                        #   snapshots, session persistence, auto-name
│   │                        #   family test (isOtherPolygonFamily)
│   ├── circleDraw.ts        # The Circle tool's geometry: the two modes
│   │                        #   ('geometric' = a constant planar radius in the
│   │                        #   map projection, 'geodesic' = a constant
│   │                        #   great-circle radius built with ol/geom/Polygon's
│   │                        #   circular()), the OL Draw geometryFunction that
│   │                        #   reads the mode live, and the per-mode auto-name
│   │                        #   family. Both modes deliver an ordinary 128-vertex
│   │                        #   Polygon — an ol/geom/Circle cannot be written to
│   │                        #   GeoJSON, vertex-edited, measured or fed to the
│   │                        #   Vector Tools, exactly as the rectangle tool
│   │                        #   already converts its Circle sketch via createBox()
│   ├── middleButtonPan.ts   # Middle-button drag panning on the map viewport
│   │                        #   (works in geometry-edit mode too — OL ignores
│   │                        #   non-primary button presses entirely)
│   ├── workspaceStorage.ts  # localStorage read/write, workspace CRUD, settings
│   │                        #   load/save, URL view-param sync
│   ├── idb.ts               # IndexedDB wrapper (geometry blobs, SAM model bytes)
│   ├── projectTransfer.ts   # .mapviewer binary export/import (optionally
│   │                        #   AES-256-GCM encrypted)
│   ├── knownSources.ts      # Known-sources CRUD
│   ├── appLock.ts           # PBKDF2 + AES-256-GCM vault, password hash,
│   │                        #   storage collection/restoration
│   ├── mapExport.ts         # Canvas compositing for PNG capture
│   ├── mapImageOverlays.ts  # Scale bar / legend / north-arrow chrome drawn
│                            #   onto captured map images ("Include details")
│   ├── projectionHelper.ts  # WKT/EPSG registration via proj4
│   ├── shapefileParser.ts   # Binary .shp/.dbf/.prj reader
│   ├── shapefileWriter.ts   # Binary .shp/.shx/.dbf/.prj writer
│   ├── vectorExport.ts      # GeoJSON/KML/Shapefile/KMZ download driver
│   ├── vectorStyleHelpers.ts # Vector style construction, layer style/clustering application
│   ├── attributeTable.ts    # Attribute-table pure logic: attribute extraction,
│   │                        #   column discovery, multi-column sort, field
│   │                        #   statistics, CSV serialisation, virtualised
│   │                        #   row-range math, window-rect clamping +
│   │                        #   persisted window geometry
│   ├── attributeStyle.ts    # Attribute-driven rendering ("smart mapping"): field stats,
│   │                        #   equal-interval/quantile classification, colour ramps &
│   │                        #   category palettes, size scaling, legend rows, OL styles
│   ├── popupHtml.ts         # Feature-info popup HTML builders (pure string functions)
│   ├── rasterLayerFactory.ts # Unified WMTS/WMS/COG/XYZ OL layer creation + COG helpers
│   ├── layerRestore.ts      # Vector layer restore from localStorage (MVT/WFS/STAC/drawn/file)
│   ├── samModels.ts         # SAM model defs (SAM 2.1 Tiny + SlimSAM-77), constants,
│   │                        #   status types (no remote URLs — models are local-only)
│   ├── samEngine.ts         # SAM ONNX Runtime Web engine: IDB/static model sourcing,
│   │                        #   dual export contract (sam2/slimsam) encode/predict
│   ├── contourExtract.ts    # Marching squares mask→ring tracing, Douglas-Peucker
│                            #   simplification, pixel→map coordinate mapping
│   ├── cogContours.ts       # QGIS' Contours renderer as vector geometry:
│                            #   downscaled DEM reads (input downscaling),
│                            #   overview levels derived from the main image
│                            #   (COG overviews carry no geo-keys), why a read
│                            #   was refused, marching-squares iso-lines (open
│                            #   chains too), line symbols (width/brush/labels)
│                            #   per index
│   ├── livewire.ts          # Classical edge detection for magnetic drawing:
│   │                        #   downsample, blur, per-channel Sobel (colour
│   │                        #   gradient), non-max suppression, percentile
│   │                        #   thresholds, hysteresis chain tracing (no AI)
│   ├── polygonClean.ts      # Douglas–Peucker clean-up of jaggy traced polygon
│   │                        #   rings (magic-wand clean-up slider)
│   ├── autoName.ts          # Auto-naming/labelling of drawn features: shape
│   │                        #   classification (building/road/area) + vector
│   │                        #   attribute + layer context
│   ├── snapOriginalStore.ts # IndexedDB stash of as-traced wand outlines until
│   │                        #   the batch is saved to a layer
│   └── boxSelection.ts      # Selection-box geometry: extent↔pixel conversion,
│                            #   resize handles, hit testing (pure DOM logic)
└── (test files)
    ├── App.test.tsx
    ├── AppLock.test.tsx
    ├── SettingsDialog.clustering.test.tsx
    ├── SettingsDialog.filter.test.tsx
    ├── SettingsDialog.groups.test.tsx
    ├── Workspace.persistence.test.tsx
    ├── Workspace.test.tsx
    ├── Workspace.url.test.tsx       # Workspace URL param (?ws=) sync
    ├── SplitScreen.test.tsx         # Split-screen comparison UI
    ├── MagneticDraw.test.tsx        # Magnetic (livewire) draw-mode integration
    ├── useCogContours.test.tsx      # Contours overlay lifecycle (create/refresh/
    │                                #   hide-raster/symbol-only/failure fallback,
    │                                #   off-file views stay silent, not-ready
    │                                #   sources are retried)
    ├── SettingsDialog.rasterEdit.test.tsx # Raster layer edit form
    ├── AddRasterLayerForm.test.tsx # Add-raster form: collapses only after a
    │                              #   successful add; failures keep the inputs
    │                              #   and report inline above Add/Cancel
    ├── SettingsDialog.attrRender.test.tsx # Attribute-driven render (smart mapping) UI
    ├── MapPage.circle.test.tsx    # Circle tool: button position under the
    │                              #   rectangle tool, the click-centre/click-edge
    │                              #   gesture persisted as a 128-vertex polygon,
    │                              #   the right-click mode submenu (rows,
    │                              #   descriptions, ticked mode, portal target,
    │                              #   Escape), geodesic badge + hint bar +
    │                              #   'Geodesic Circle N' naming, separate
    │                              #   per-mode counters, the mode surviving a
    │                              #   tool switch, and circles staying out of the
    │                              #   generic 'Polygon N' counter
    ├── MapPage.draw.test.tsx      # Draw workflow (line/polygon/rectangle/label,
    │                              #   undo/redo, save/restore session)
    ├── MapPage.vertex.test.tsx    # Vertex editing (insert/remove/pick-up/
    │                              #   translate/label re-edit)
    ├── MapPage.fileLayerEdit.test.tsx # File-imported layer geometry re-edit
    │                              #   (insert/undo, attribute preservation,
    │                              #   persistence flush) end-to-end; toolbar
    │                              #   edit-vertices ↔ Edit geometry hook;
    │                              #   panel re-open editor restore; null-
    │                              #   geometry feature regression
    ├── MapPage.settingsDraft.test.tsx # Closed-but-kept Settings panel: pending
    │                              #   add-layer form content (typed values,
    │                              #   chosen source type) survives close +
    │                              #   reopen; portalled menus dismissed on
    │                              #   hide; workspace switch starts clean
    ├── SettingsDialog.fileEdit.test.tsx # Edit-form entry points: geometry
    │                              #   edit + download for file layers, drawn
    │                              #   parity, remote layers excluded, editor
    │                              #   section auto-restore while a session
    │                              #   is live
    ├── SettingsDialog.drag.test.tsx # Raster+vector drag-reorder parity
    ├── WandCleanupEditor.test.tsx # (components/) wand clean-up slider + stash
    ├── CogRenderControl.test.tsx # (components/) COG band/renderer panel against
    │                            #   a faked GeoTIFF source: band discovery on
    │                            #   expand, suggested-renderer fix, RGB combo,
    │                            #   stretch seeded from statistics, Enter-to-
    │                            #   commit, invalid window refused, colour table
    ├── GeoProcessingPanel.tools.test.tsx # Walks ALL 28 tools in the DOM: each
    │                            #   renders a form + Run button, each responds to
    │                            #   Run (result / error / toast / progress, never
    │                            #   silence), the runnable ones really produce a
    │                            #   FeatureCollection on polygon, point AND line
    │                            #   input, and every gp-* class emitted exists in
    │                            #   App.css (no invented styling)
    ├── GeoProcessingPanel.test.tsx # "Vector Tools" window: tool rail + search,
    │                            #   category grouping, per-tool second-layer
    │                            #   pickers, which tools still carry an
    │                            #   approximate-kernel caveat, default output
    │                            #   name, run → new result layer, difference /
    │                            #   validity-error-layer / nearest-distance /
    │                            #   polygonize runs, dissolve grouping UI, inline
    │                            #   parameter errors, empty/MVT-excluded state,
    │                            #   map-picker arming, close
    ├── AttributeTable.test.tsx  # Attribute table window (sort, selection,
    │                            #   view modes, filter bar, CSV, cell edit)
    └── utils/
        ├── featureFilter.test.ts
        ├── layerHelpers.test.ts
        ├── shapefileWriter.test.ts
        ├── vectorExport.test.ts
        ├── contourExtract.test.ts
        ├── cogContours.test.ts
        ├── circleDraw.test.ts       # Circle tool geometry: closed 128-segment
        │                            #   rings, constant planar radius
        │                            #   (geometric) vs. constant ground radius
        │                            #   (geodesic) at 60°N, equator agreement,
        │                            #   zero-radius drag, in-place geometry reuse,
        │                            #   the live mode getter, name prefixes
        ├── drawHelpers.test.ts      # measurement-label gating (incl. the
        │                            #   circle single-chip rule), snapshot
        │                            #   capture (incl. attribute-only /
        │                            #   null-geometry features, circleMode),
        │                            #   persistence
        ├── middleButtonPan.test.ts  # middle-button drag panning (button
        │                            #   gating, overlay guard, cursor class,
        │                            #   detach)
        ├── livewire.test.ts
        ├── samEngine.test.ts
        ├── boxSelection.test.ts
        ├── mapExport.test.ts
        ├── mapImageOverlays.test.ts
        ├── measurement.test.ts      # vertex counting, the 30-vertex visibility
        │                            #   default + override, circles exempt
        ├── overlay.test.ts          # Overlay kernel golden tests: concave and
        │                            #   multipart cutters, holes on either side,
        │                            #   containment, N-way union, bowtie repair,
        │                            #   point/line clipping, polygonize, interior
        ├── overlay.property.test.ts # Kernel invariants + a differential oracle:
        │                            #   area conservation, inclusion-exclusion,
        │                            #   idempotence/commutativity/associativity,
        │                            #   point-set membership against an independent
        │                            #   even-odd ray caster, degenerate input,
        │                            #   EPSG:3857 magnitudes — all seeded & reproducible
        ├── geoprocessing.realdata.test.ts # The tools on the real datasets in ../sample
        │                            #   (git-ignored, so the suite SKIPS without them):
        │                            #   dissolve diffed against a QGIS 3.44 output,
        │                            #   geodesy against Australia's and Victoria's real
        │                            #   areas, overlay invariants on 16 288 localities,
        │                            #   a validity census, and a benchmark table
        │                            #   points, adjacency, validity classes
        ├── geoprocessing.test.ts    # Vector Tools golden tests, including the
        │                            #   remaining KNOWN LIMITATION cases that pin
        │                            #   the deliberate deviations from GEOS/QGIS
        ├── buffer.test.ts           # The buffer engine and its exact path:
        │                            #   analytic areas, a point-membership oracle
        │                            #   against the DEFINITION of a buffer, the
        │                            #   erosion algebra (S⊖d ⊆ S, the opening
        │                            #   (S⊖d)⊕d ⊆ S, necks splitting, slivers
        │                            #   vanishing), monotonicity, single-sided
        ├── validity.geos.test.ts    # Check Validity + Make Valid differentially
        │                            #   against GEOS 3.14.1 (geosGolden.json):
        │                            #   verdict, reason class, error location,
        │                            #   and MakeValid's part count and area
        ├── overlay.geos.test.ts     # The four overlay operators and 81 buffers
        │                            #   against GEOS's areas, to 1e-9 relative,
        │                            #   with the 15 deviations named and reasoned
        ├── geodesic.test.ts         # Cross-checked against ol/sphere
        ├── geomIndex.test.ts        # Extent helpers + R-tree pruning
        ├── rasterLayerFactory.test.ts
        ├── wmsFeatureInfo.test.ts
        ├── cogHelpers.test.ts       # COG header validation (truncated-header mode)
        ├── cogBands.test.ts         # COG band discovery, render-config
        │                            #   normalisation, bake-vs-live decisions,
        │                            #   style expressions (+ an OpenLayers
        │                            #   canary that compiles them to GLSL)
        ├── cogFileRegistry.test.ts  # File-COG blob-URL registry
        ├── autoName.test.ts         # Wand polygon classification & naming
        ├── polygonClean.test.ts     # Ring simplification & vertex counts
        ├── attributeStyle.test.ts   # Smart mapping: stats, classification, legend, styles
        ├── attributeTable.test.ts   # Attribute table: sort, stats, CSV, virtualisation,
        │                            #   window geometry
        ├── mapExport.test.ts        # Canvas compositing / map capture
        └── workspaceStorage.fileCog.test.ts # File-COG config survives workspace switch
```

### Key architectural notes

- **Keep files neat and readable.** `MapPage.tsx` and `SettingsDialog.tsx` are the two largest files, but they should not become catch-alls. When adding a new feature, extract its logic into a dedicated `utils/` helper and its UI into a separate `components/` file. The main page components should remain high-level orchestrators — wiring together small, focused modules — not monoliths that grow with every feature. If an existing section of `MapPage` or `SettingsDialog` is self-contained enough (e.g. a dialog, a panel, a toolbar), prefer splitting it out into its own component file.
- **App.css** is the single stylesheet (~6 300 lines). All class names are flat (no BEM nesting, no CSS modules). Add new styles at the bottom of the file, grouped by component with a comment header.
- **hooks/** holds reusable custom hooks (`useDrawSession`, `useVertexEditing`, `useBoxSelection`, `useSamTools`, `useMagneticDraw`, `useLayerDragReorder`). Large page components should stay orchestrators: when a page component accumulates a self-contained bundle of state + handlers (a session, a gesture model, a DnD model), extract it into a hook here.
- **utils/** files are framework-agnostic. They must not import React. They receive plain data and return plain data (or OL objects). This keeps them testable in isolation.
- **types.ts** is the single source of truth for shared interfaces. When adding fields to `RasterLayer` or `VectorLayerConfig`, add them here and update the persistence layer (`workspaceStorage.ts`) and the relevant component forms.
- **The Settings panel is never unmounted once it has been opened.** `MapPage` keeps the dialog mounted and toggles `panelHidden` (`.settings-dialog--hidden`, `visibility: hidden`) when it closes — an unpinned panel closes on any outside click, and that must not throw away a half-filled *Add Raster/Vector Layer* form (typed URLs, chosen source type, a picked `File`, discovered capabilities) or an open layer edit form. Consequences to respect: (1) tests assert on the hidden class rather than on the DOM being gone; (2) anything the panel renders through a portal on `document.body` (lock/split/layer context menus, download menu, export popup) is anchored to the viewport, not to the dialog, so it is dismissed the moment the panel hides — new portalled overlays must join that cleanup effect in `SettingsDialog`; (3) the slide-up animation is keyed off the *visible* state so it replays on every open, since mount now happens only once — **except in split mode**, where the two side tabs share one panel and a workspace swap remounts a pane with the panel already showing: `SplitScreen` flags a genuine open (`splitSettingsReveal`) and `MapPage` adds `.settings-dialog--no-reveal` otherwise, so switching the Left/Right tab or changing a side's workspace swaps the content in place instead of looking like a close/reopen; (4) `visibility` is inherited **and** transitionable, so descendants with `transition: all …` (Add/Cancel/Apply buttons, the dashed add-layer buttons) would stay visible for the whole transition after the panel hides — the `.settings-dialog--hidden, .settings-dialog--hidden *` rule switches transitions/animations off inside the hidden panel to keep hiding instant; do not remove it.
- **The "Vector Tools" panel runs on a hand-written planar overlay kernel.** `utils/overlay.ts` implements the JTS OverlayNG model in four steps: **node** every segment at every crossing (snapping the results into a shared node table, so two parcels sharing a boundary become ONE edge), **label** each noded edge by sampling a point either side of its midpoint against the *original* subject geometries, **select** the edges whose two sides disagree about membership of the result region and orient them with that region on their left, then **assemble** them into minimal cycles (shells CCW, holes CW) and nest the holes into the shells that contain them. Because labelling asks the original geometries rather than an edge's own parent ring, one pass handles N subjects — which is what makes N-way union (QGIS Dissolve, `ST_Union(geom[])`), "a polygon inside another polygon" and "two polygons that merely touch" all come out right. That kernel backs Clip, Intersect, Union, Difference, Symmetrical Difference, Dissolve, Eliminate, Make Valid, Polygonize and the buffer repair pass, so those tools now agree with each other and with GEOS on concave cutters, holes on either side, containment and multipart input. There is still **no GEOS/JTS/turf/WASM dependency** — the stack stays React + OpenLayers + proj4. Conventions every new or modified engine must follow: (1) **tolerances are scale-derived** — use `toleranceForFeatures(...)` / `scaleTolerance(span)` / `overlayTolerance(...)`, never a bare `1e-9`, since EPSG:3857 ordinates are ~1.5e7 where that sits below the float noise floor; (2) **holes travel with their shell** — take polygons apart with `getPolygonParts()` (or `geometryParts()` in geoTypes); `getAllPolygonRings()` is for boundary-only work and `getExteriorRings()` for tools where holes cannot change the answer; (3) **prune with `ExtentIndex`** before any pairwise loop; (4) **measure on the ground** through `utils/geodesic.ts` — never label a planar shoelace or `dist()` value as metres; (5) **anything that can take seconds is async and cancellable** — accept a `ProgressToken` plus a reporter, drive the loop with `progressLoop`, pass the caller's *own* token object (a copy silently disables Cancel), and split the work into units small enough to cancel *between*: Dissolve works per connected component for exactly this reason; (6) **no silent area loss** — report what could not be processed (`EliminateResult.droppedIndices`), drop degenerate results rather than inventing geometry (`overlayGeometries` returns `null`, never a convex hull), and prefer a repair that passes Check Validity over one that merely covers more naive ring area (`repairIfInvalid`); (7) **declare approximations in the UI** — `approximate:` on a `ToolDef` renders the amber `.gp-form-hint--warning` caveat and `note:` a neutral hint; remove them as an engine reaches parity. What is left is marked `KNOWN LIMITATION` in the engines and pinned by tests that are meant to be **updated, not preserved**. (8) **The answer is a function of the input SET, not of the order it was listed** — node clustering is transitive and canonical (`NodeTable`), every edge is stored low-node-first and the edge list is sorted, and the two ways of computing an intersection are averaged in value order. Union, intersection and symmetric difference are byte-identical under any permutation of their subjects, and `overlay.property.test.ts` asserts exactly that with no epsilon. (9) **GEOS is the oracle, and it is a runnable one** — `tools/geos-golden.py` asks the GEOS that ships with QGIS (`/Applications/QGIS.app/Contents/MacOS/python`) for validity verdicts, reasons and locations, `ST_MakeValid` results, 48 overlay areas and 135 buffer areas (both signs of the distance, every cap and join style, single-sided included), and writes `src/utils/geosGolden.json`, which the two `*.geos.test.ts` suites read. Nothing needs Python at build or test time. Before changing a *rule* (what counts as valid, what a buffer means, what Make Valid keeps), run the case through that script first: the shell-touching-its-own-hole "fix" was planned as a part-splitting feature until GEOS said the input was valid and the real bug was our over-reporting.
- **App.tsx re-exports** several symbols (components, helpers, constants) for test compatibility — tests import them from `'./App'`. When adding a new component or helper that tests need, add a re-export there.

---

## 4. State Management Patterns

There is no global store. State flows top-down:

```
App.tsx
  ├── workspace registry (localStorage)
  ├── lock state (in-memory password, vault in localStorage)
  └── MapPage.tsx
        ├── OL Map instance (useRef — never put in useState)
        ├── rasterLayers / vectorLayers (useState arrays of config objects)
        ├── layer groups (useState arrays)
        ├── basemap settings (useState)
        ├── draw session features (useRef array + useState counter for re-render)
        └── SettingsDialog.tsx (receives layers + callbacks as props)
```

### Rules

1. **OL objects go in `useRef`, not `useState`.** The `ol/Map`, `ol/layer/*`, and `ol/source/*` instances are mutable and must not trigger React re-renders. Store them in refs; store the *config* objects (plain TS interfaces) in state.
2. **Config objects are serialisable.** Every field on `RasterLayer` and `VectorLayerConfig` must be JSON-safe (no OL objects, no functions). The `olLayer` field is the one exception — it is marked optional and is stripped before persistence.
3. **Persistence is synchronous localStorage** (via `workspaceStorage.ts`) for settings, and **async IndexedDB** (via `idb.ts`) for large blobs (uploaded file geometry, SAM model bytes). Always `await` IDB operations.
4. **Workspace scoping.** Every storage key is prefixed with the workspace ID. When adding a new persisted setting, add it to `StoredSettings` in `types.ts` and wire it through `workspaceStorage.ts`.

---

## 5. OpenLayers Conventions

- Import from the `ol` package using ESM paths: `import TileLayer from 'ol/layer/Tile.js'`, `import GeoTIFFSource from 'ol/source/GeoTIFF.js'`, etc. Always include the `.js` extension.
- The map projection is always **EPSG:3857** (Web Mercator). User-facing coordinates are converted to/from EPSG:4326 for display.
- Custom projections are registered at runtime via `projectionHelper.ts` (proj4 + `ol/proj`). Always call `registerProjection()` before creating a source that uses a non-standard CRS.
- Layer z-ordering is managed by array index in the `rasterLayers` / `vectorLayers` state arrays. The map renders layers in array order (index 0 = bottom). Drag-and-drop reordering mutates the array and calls `layer.setZIndex()`. The `reorderLayers()` helper in `layerHelpers.ts` synchronises OL z-indices from the config arrays.
- COG layers use `ol/layer/WebGLTile` + `ol/source/GeoTIFF` (not `TileLayer`). They require a WebGL-capable browser.
- **COG band rendering lives in `utils/cogBands.ts`, never inline in a component.** OpenLayers maps a GeoTIFF's first bands to RGBA and offers no picker, so multispectral/paletted files need an explicit `color` style expression (`['array', ['band', r], ['band', g], ['band', b], 1]`, `['palette', index, colors]`). Two rules follow from how OL works: (1) band *mapping* is style-only — the source loads every band, so `layer.setStyle()` switches bands live with no requests, and `setStyle()` **replaces** `style.variables`, so the current brightness/contrast/saturation values must be folded back in (see `applyCogRender`); (2) anything that changes pixel *normalisation* (a display stretch, a colour table's index range) must be passed to the GeoTIFF source as per-band `min`/`max` at construction, which is why `createCogLayer` is two-phase and why such a change rebuilds the layer. Keep `color` undefined in `auto` mode so OL's own default mapping is untouched. (3) `hillshade` is a pure style expression built from neighbour-pixel reads (`['band', n, dx, dy]`, Horn's 3x3 gradient); it recovers real-world elevations by scaling the normalised band back through the *elevation window* (explicit stretch, else the file's statistics, else the data-type range), so only its stretch window rebuilds — sun position applies live. `contour` is the exception that left the shader entirely: a fragment cannot give a line a width, a dash pattern or a label, so `utils/cogContours.ts` traces real LineStrings from the file's raw values and `hooks/useCogContours.ts` draws them in a companion vector layer (see pitfall 23).
- When creating tile sources, always set `crossOrigin: 'anonymous'` to enable canvas export (image capture).

---

## 6. Adding a New Raster Layer Type

1. Add the type string to `RasterLayer['type']` union in `types.ts`.
2. Add any type-specific fields to `RasterLayer` (prefix them with the type name, e.g. `cogBucket`).
3. Add the add-layer form UI in `components/AddRasterLayerForm.tsx` (new entry in the `newLayerType` select, new form fields, validation, and the config build in `handleAddLayer`).
4. Add the OL layer creation logic in `utils/rasterLayerFactory.ts` (`createRasterOlLayer`), which `MapPage.handleAddRasterLayer` calls.
5. If the type needs a utility module, create it in `utils/` (e.g. `cogHelpers.ts`). Keep it React-free.
6. Update the layer edit menu in `SettingsDialog.tsx` if the type has editable properties.
7. Handle cleanup on layer removal (IndexedDB blobs, event listeners).
8. Update the Known Sources type union in `types.ts` if the type should be saveable.
9. Honour the add-form error contract: `handleAddRasterLayer` (MapPage) must **reject** when the layer could not be put on the map, and `AddRasterLayerForm` collapses / clears its inputs **only** after that promise resolves. On failure every field stays as typed and the message is rendered above the Add/Cancel buttons via `setAddFormError(...)` (validation failures included), so a typo never costs the user the whole form.

## 7. Adding a New Vector Layer Type

Same pattern as raster, but:
- Add to `VectorLayerConfig['type']` union.
- Vector layers share styling fields (`lineColor`, `fillColor`, etc.) — reuse them.
- File-based types go in the `FILE_VECTOR_TYPES` array in `types.ts`.
- Large geometry is stored in IndexedDB under a `geometryIdbKey`; small/drawn layers use inline `drawnGeoJson`.

---

## 8. Styling Conventions

- All CSS is in `gis_workbench/src/App.css`. No inline `style={}` objects except for truly dynamic values (colours from user input, computed positions).
- Class naming: `componentName-element--modifier` (informal BEM). Examples: `.settings-layer-row`, `.draw-toolbar-btn--active`, `.context-menu-item`.
- The settings dialog is fixed at **480 px** width. The map fills the remaining viewport.
- Colours: the UI uses a light theme. Primary accent is `#4a90e2`. Destructive actions use `#e74c3c` / `#d64545` / `#c53030`.
- Icons are inline SVG React components in `Icons.tsx`. Add new icons there as named exports.

### Reuse existing UI patterns — match the in-app style

**Whenever you create a new element or component, it must look and behave like the app's existing UI.** Before writing any new markup or CSS, grep `App.css` and the `components/` folder for an existing equivalent and reuse or extend it. Never invent a fresh visual treatment for a control type the app already has. Canonical patterns to follow:

- **Dropdowns / selectors** — use the `CustomSelect` component (`components/CustomSelect.tsx`, `.custom-select-*` classes, portal menu, chevron, optional filter box). Do not use raw `<select>` elements or hand-roll new listbox UI. Contextual variants already exist (`.settings-select`, `.goto-select`, `.mouse-coordinate-select`) — add a variant class rather than new base styles.
- **Right-click / context menus** — follow the established menu pattern used by `MapContextMenu` / `BoxContextMenu` (`.map-context-menu-*`) and the settings-gear menu (`.lock-context-menu-*`): floating white card, rounded corners + shadow, icon+label item rows, hover/focus highlight in the accent colour, separators, and the same pop-in animation. New menus should mirror these classes almost verbatim.
- **Toasts** — surface transient messages through `MapToast` (`.map-toast-*`).
- **Async/loading rows** — use `LoadingIndicator`.
- **Labelled range sliders** — use `SliderRow`.
- **Dialogs & forms** — follow the `.settings-dialog` family (480 px panel, section headings, input/button styles already defined in `App.css`).
- **Buttons & inputs** — reuse the existing button/text-field classes found in `App.css` before creating new ones.

Rules of thumb:

1. `grep -n` `App.css` for the control you are about to build (`context-menu`, `custom-select`, `btn`, `dialog`, …). If a similar class exists, extend it with a modifier/variant instead of duplicating it.
2. New styles must match the light theme: same palette (accent `#4a90e2`), border radii, shadows, fonts, spacing, hover states, and animation curves as the surrounding UI.
3. Append new CSS at the bottom of `App.css` under a component comment header (see above), not scattered mid-file.
4. If you genuinely need a new pattern, model it on the closest existing one so the result is indistinguishable in style from the rest of the app.

---

## 9. Persistence & Storage Keys

| Key pattern | Storage | Content |
|-------------|---------|---------|
| `mapviewer-workspaces` | localStorage | Workspace registry (list + active ID) |
| `mapviewer-settings` | localStorage | Default workspace settings (legacy) |
| `mapviewer-settings:{wsId}` | localStorage | Per-workspace `StoredSettings` JSON |
| `mapviewer-view:{wsId}` | localStorage | Saved map centre + zoom |
| `mapviewer-known-sources` | localStorage | Known sources array |
| `mapviewer-draw:{wsId}` | localStorage | Draw session (unsaved drawn features) |
| `mapviewer-split-divider` | localStorage | Split-screen divider position (left-pane %) |
| `mapviewer-split-settings-pinned` | localStorage | Split-view settings panel pin state |
| `mapviewer-attr-table-geometry` | localStorage | Attribute-table window rect + maximized flag |
| `mapviewer-locked-vault` | localStorage | Encrypted app-lock vault (AES-256-GCM) |
| `mapviewer-lock-hash` | localStorage | SHA-256 password hash (for verification) |
| `mapviewer` (database), `layerdata` (store) | IndexedDB | Large geometry blobs, SAM model bytes |

When the app lock is active, all localStorage keys prefixed with `mapviewer` are encrypted into the vault and removed from plain storage. Unlocking restores them verbatim. The vault and hash keys themselves are excluded from collection.

---

## 10. Testing

- Tests use **Vitest** + **React Testing Library** (configured in vite.config.ts).
- **Utils tests** live alongside their source in `utils/`:
  - `featureFilter.test.ts` — parser & evaluator for the attribute-filter grammar
  - `layerHelpers.test.ts` — layer utility functions
  - `shapefileWriter.test.ts` — binary shapefile output
  - `vectorExport.test.ts` — export driver
  - `contourExtract.test.ts` — marching-squares mask→polygon tracing & simplification
  - `cogContours.test.ts` — QGIS contour tracing: level planning (index flags, stride cap), the level list of a real COG (overview IFDs carry no affine transform, so their extent/pixel size/nodata are derived from the main image and the list is sorted coarsest-first here rather than trusted from OpenLayers), downscaled DEM reads (window/overview/cap/nodata/reprojection), why a read was refused (`too-large` / `no-overlap` / `no-georeference` / `no-transform` / `no-values` / `source-not-ready` and their messages), line geometry (open chains, closed rings, vertex budget), line symbols & labels, cap messages
  - `livewire.test.ts` — classical edge pipeline (downsample, blur, Sobel, NMS, chain tracing, simplification)
  - `samEngine.test.ts` — SAM preprocessing/postprocessing pure helpers, static-model payload validation (HTML-fallback impostor guard) and SlimSAM int64 prompt-label conversion
  - `boxSelection.test.ts` — selection-box geometry (extent↔pixels, handles, hit testing)
  - `mapExport.test.ts` — map capture compositing (excluded layers hidden only inside the synchronous capture step, size rejection), PNG blob encoding, tainted-canvas detection
  - `mapImageOverlays.test.ts` — scale bar / legend / north-arrow overlay drawing
  - `measurement.test.ts` — geometry vertex counting & measurement-label visibility default (30-vertex rule) + explicit override, with circle-tool features exempt from the vertex rule (they carry a single area chip)
  - `circleDraw.test.ts` — the Circle tool's two geometries: closed 128-segment rings, a constant *planar* radius for `geometric` vs. a constant *ground* radius for `geodesic` (asserted at 60°N, where the two part company), agreement at the equator, a zero-radius drag, the OL geometryFunction's in-place geometry reuse and live mode getter, and the per-mode auto-name prefixes
  - `overlay.test.ts` — the overlay kernel: ring orientation, point location, union (adjacent / overlapping / contained / disjoint / N-way / donut), intersection (concave cutter, slot in the clip layer, subject holes, multipart cutter), difference, symmetric difference, the invariants (canonical winding, either input orientation, float-noise duplicates, T-junctions, real 3857 magnitudes), lossless repair (bowtie → both lobes, stray hole → own polygon, spike removal), clipping points and lines, polygonize (grid faces, mid-segment nodling, dangles, nested disjoint cycles), interior points, connected components, adjacency and shared-boundary length, and every GEOS validity class
  - `geoprocessing.test.ts` — golden tests for every Vector Tools engine: scale-derived coordinate tolerance, shell/hole polygon parts, extent indexing, the progress/cancel token, buffer (Mercator radius scaling, rounded 90° corners, cap and join styles, hole preservation, collapse rejection, dissolve/separate-parts/per-feature distance, self-intersection repair), clip and intersect (concave cutters, holes on both sides, points and lines, index-vs-brute-force parity, async/sync agreement, cancellation, attribute-collision suffixing), union / difference / symmetric difference (QGIS overlay semantics, nulled foreign fields, non-polygonal pass-through), dissolve (group by one or many fields, keep disjoint, component-level cancellation), centroid and point-on-surface, per-feature convex hull, nearest and k-nearest distance, eliminate (all three strategies, partial shared edges, overlap, holes, drop reporting), validity (every GEOS class, all reasons, error-point layer), lossless make valid, collect by field, polygonize, Voronoi (cell attribution), Delaunay, densify/simplify (both methods, topology guard, ground units)/vertex and type conversion, geodesic geometry attributes, merge/split/remove-selected, and the OL↔GeoJSON bridge. Cases prefixed `KNOWN LIMITATION` are meant to be **updated, not preserved**, as the engines reach parity
  - `buffer.test.ts` — the buffer engine, and specifically its exact (piece-union) path: analytic areas for caps and joins, a point-membership oracle that checks the result against the *definition* of a buffer (inside ⟺ within d, outside the tessellation band) for round/bevel/mitre, the erosion algebra (`S ⊖ d ⊆ S`, the opening `(S ⊖ d) ⊕ d ⊆ S`, a neck thinner than 2d splitting in two, a sliver vanishing rather than inverting), monotonicity in the distance, multipart inputs merging instead of stacking, single-sided line buffers on the correct side of travel, and a pin on the offset fast path so clean input never pays for the union
  - `validity.geos.test.ts` / `overlay.geos.test.ts` — **differential tests against GEOS 3.14.1**, driven by `src/utils/geosGolden.json` (generated, committed — see `tools/geos-golden.py`). Validity: 17 rule-probing cases × verdict, reason class, error location, Make Valid's part count and area, plus "the repair satisfies our own rules". Overlay: 12 geometry pairs × 4 operators, and 135 buffers (13 geometries × 3 distances × cap and join styles, plus 24 single-sided rows at both signs) — 109 of them within 4.2e-13 relative of GEOS, and the 26 the golden file flags with a written reason are asserted to be exactly those rows
  - `overlay.property.test.ts` — the kernel as a *property* suite rather than a
    fixture suite: seeded generators (concave stars, donuts, overlapping
    rectangles, jittered parcel grids with shared boundaries, near-coincident
    duplicates) run through area conservation, inclusion–exclusion, idempotence,
    commutativity, associativity, order invariance, connected-component
    partitioning, line-length conservation under clipping, repair losslessness
    bounded by the convex hull, degenerate/NaN input, determinism, non-mutation
    of inputs, and the same scenarios re-run at EPSG:3857 magnitudes. The
    point-set membership oracle is an INDEPENDENT even-odd ray caster, so a
    mislabelled edge cannot agree with itself. It found four real defects: a hole
    nested into an island smaller than itself (area still summed right, geometry
    wrong), NaN ordinates leaking into results, validity that depended on where
    on Earth the data sat, and rings that pinch at a node coming back as one
    invalid figure-eight instead of two valid parts.
  - `geoprocessing.realdata.test.ts` — the same tools on the real datasets in
    `sample/` (git-ignored: every suite here SKIPS when the files are absent, so a
    fresh clone stays green). Dissolve of `1.geojson` is compared to the checked-in
    QGIS 3.44.7 output by symmetric difference (null = identical); geodesic areas
    are checked against an independent spherical-excess integral and against
    Victoria's official 227 449 km²; overlay invariants run on 40 seeded pairs of
    the 16 288 ASGS localities; Check Validity is a golden census of that layer
    (25 broken: 21 null geometries + 4 real); k-nearest distances are diffed
    against a haversine; and the KNOWN LIMITATION buffer numbers are pinned.
    `afterAll` prints the benchmark table (dissolve 16 267 real localities ≈ 1.2 s,
    Check Validity ×16 288 ≈ 0.15 s, k-nearest 3 000×3 000 ≈ 40 ms warm).
  - `geodesic.test.ts` — 3857↔4326 round trips, great-circle distance, spherical area with holes subtracted, perimeter over every ring, and the sec²(φ) planar-vs-ground ratio, each cross-checked against `ol/sphere`
  - `geomIndex.test.ts` — extent helpers, empty-extent handling, R-tree add/load/query/clear and pruning over a 10 000-cell grid
  - `drawHelpers.test.ts` — measurement-label gating in draw-feature styling (including the circle single-chip rule and its `_circleMode` round-trip through the session and snapshots), the visibility toggle, draw-session persistence round-trips, session-snapshot tolerance of attribute-only (null-geometry) features, auto-name families (`isOtherPolygonFamily`), RTree-pruned vertex/segment hit testing, and the undo-history vertex budget
  - `middleButtonPan.test.ts` — middle-button drag panning: middle-button-only gating, touch and overlay guards, grabbing-cursor viewport class, multi-button release edge cases, and detach cleanup
  - `rasterLayerFactory.test.ts` — unified raster layer creation
  - `wmsFeatureInfo.test.ts` — WMS GetFeatureInfo parsing & extent-based requests
  - `cogHelpers.test.ts` — COG header validation (TIFF/BigTIFF magic, tiling tags, truncated-header mode for large files, non-COG size limit)
  - `cogBands.test.ts` — COG band rendering: data-type ranges, TIFF colour-table parsing, band discovery from a faked GeoTIFF source (names/statistics/nodata/alpha, statistics read from the full-resolution image when overviews carry none, plus graceful degradation when OL's internals or a tag read fail), measuring a band's true min/max from its pixels (`computeCogBandRange`: nodata/NaN skipping, multi-source band mapping, scattered-window sampling of huge rasters), render-config normalisation and mode fallbacks (incl. hillshade/contour parameter sanitising), the bake-vs-live decision (`needsCogRebuild`), sparse per-band `min`/`max` baking, the RGB/grayscale/palette/hillshade/contour expressions, style-variable preservation, and a canary that compiles every expression through OpenLayers' own WebGL expression compiler
  - `cogFileRegistry.test.ts` — session blob-URL registry for file-based COG layers
  - `autoName.test.ts` — wand polygon shape classification & auto-name composition
  - `polygonClean.test.ts` — Douglas–Peucker ring simplification, vertex counting, ring validation
  - `attributeStyle.test.ts` — smart-mapping field stats, equal-interval/quantile classification, ramp/size/legend helpers and the per-feature OL style function
  - `attributeTable.test.ts` — attribute-table sort comparator, field statistics, CSV
    escaping, virtualised row ranges and window-geometry persistence
  - `mapExport.test.ts` — map canvas compositing & PNG capture (faked OL viewport)
  - `workspaceStorage.fileCog.test.ts` — file-COG layer config persists across workspace switch with the blob URL stripped
- **Component / integration tests** live in `src/`:
  - `App.test.tsx` — smoke test
  - `AppLock.test.tsx` — lock/unlock/password flows
  - `SettingsDialog.clustering.test.tsx` — point-clustering UI
  - `SettingsDialog.filter.test.tsx` — attribute-filter UI
  - `SettingsDialog.groups.test.tsx` — layer group management UI
  - `Workspace.test.tsx` — workspace selector UI
  - `Workspace.persistence.test.tsx` — workspace storage round-trips
  - `MapPage.draw.test.tsx` — draw workflow integration (synthesised OL pointer gestures)
  - `MapPage.circle.test.tsx` — Circle tool integration: button placement under the rectangle tool, the centre/radius gesture persisted as a 128-vertex polygon with its mode in the session meta, the right-click submenu (rows, descriptions, ticked mode, `document.body` portal, Escape without disarming the tool), geodesic badge/hint/naming, separate per-mode counters, the mode surviving a tool switch, and circles staying out of the generic polygon counter
  - `MapPage.vertex.test.tsx` — vertex-editing gestures (insert/remove/pick-up/translate)
  - `MapPage.fileLayerEdit.test.tsx` — file-imported layer geometry re-edit end-to-end: session start/end from the edit form, vertex insert + undo on the live source, attributes preserved through snapshots, geometry/attribute persistence flush; the toolbar edit-vertices tool mirrors the session (activates on Edit geometry, deactivating it ends the session like Done editing); reopening the settings panel mid-session restores the editor section; null-geometry features no longer crash session start
  - `MapPage.settingsDraft.test.tsx` — the Settings panel stays mounted when closed: a half-filled Add Raster / Add Vector Layer form (typed values, chosen source type) is intact after an outside click or ✕ and a reopen, viewport-anchored menus portalled to `document.body` are dismissed on hide instead of floating over the map, and a workspace switch rebuilds a clean panel
  - `SettingsDialog.fileEdit.test.tsx` — edit-form entry points: "Edit geometry" + Download for file layers, "Re-edit layer" + per-feature section for drawn, none for remote (mvt/wfs/stac); an active session restores the editor section on panel open
  - `SettingsDialog.drag.test.tsx` — raster/vector drag-reorder parity
  - `SettingsDialog.rasterEdit.test.tsx` — raster layer edit form; the COG band panel is offered for COG layers only, a band choice is pushed live through `onApplyCogRender` without closing the editor, Apply commits `cogRender` alongside the rest of the edit, and Cancel reverts a live band change
  - `AddRasterLayerForm.test.tsx` — add-raster-layer form: a rejected add (e.g. a CORS-blocked COG) keeps the form open with every input preserved and renders the failure above the Add/Cancel buttons, missing-input validation is reported there without touching the map, switching layer type or cancelling clears the message, and a successful add (or a retry after fixing a typo) collapses and resets the form
  - `SettingsDialog.attrRender.test.tsx` — attribute-driven render toggle (field picker, mode/stats live-apply, legend preview, commit/restore)
  - `WandCleanupEditor.test.tsx` — wand clean-up slider (in `components/`): stash restore & live simplification
  - `CogRenderControl.test.tsx` — COG band/renderer panel (in `components/`): collapsed-by-default with a summary badge, band layout read from the live source on expand, the *Use suggested* fix for files the default renderer gets wrong (incl. the QGIS-style auto-stretch offered for float DEMs with statistics), RGB band pickers, single-band mode seeded from GDAL statistics, *From layer data* measuring the stretch from the raster pixels (and reporting a hint when the read fails), stretch committed on Enter/blur (not per keystroke), inverted windows refused with a hint, hillshade sun controls and contour interval/colour controls, colour-table ramp, and the panel's behaviour before the layer is on the map
  - `AttributeTable.test.tsx` — attribute-table window: header sort, checkbox/Ctrl/Shift
    selection gestures, view modes, map→table focus, filter bar, CSV export,
    cell edit write-through, close & layer switcher
  - `GeoProcessingPanel.test.tsx` — the "Vector Tools" window: all 28 tools present
    in their three categories, rail search filtering, second-layer pickers that
    appear only for the tools that need one (and are labelled Clip / Overlay /
    Second layer), which tools still carry the amber `approximate` caveat (only
    Delaunay now — Clip/Intersect/Union/Dissolve/Make Valid/Eliminate are exact)
    and which carry a neutral `note`, the `<Tool> of <layer>` default output name,
    a Centroids run producing a point FeatureCollection through
    `onAddResultLayer` + toast, a Clip run going through the progress path and
    clearing the bar afterwards, a Difference run keeping the input attributes, a
    Check Validity run adding its error-point layer alongside, a nearest-distance
    run writing the hub attributes back onto the input geometry, a Polygonize run,
    the dissolve field picker, inline validation
    errors that add nothing, the empty and MVT-only states, and arming the
    click-to-select pickers
  - `GeoProcessingPanel.tools.test.tsx` — the exhaustive panel walk: all 28 tools
    render a description, a Run button and a defaulted output name; every tool
    responds to Run with a result, an inline error, a toast or a progress bar
    (never silence) on a polygon, a point and a line layer; the tools that can run
    on one layer really produce a parseable FeatureCollection; only Delaunay
    carries the amber `approximate` caveat; and every `gp-*` class the panel emits
    is defined in App.css, which is the layout check that does not need a browser.
  - `SplitScreen.test.tsx` — split-screen comparison UI
  - `MagneticDraw.test.tsx` — magnetic (livewire) draw-mode integration
  - `useCogContours.test.tsx` — the Contours renderer's overlay lifecycle against a stub map: overlay created with traced lines while the raster hides, removed when the renderer changes, symbol-only edits restyle without re-reading, interval changes re-trace, a failed trace restores the raster with a fallback style (and a trace that starts working hides it again), stale lines are cleared rather than left next to a visible raster, a view off the file is silent, terrain with no line in it keeps the raster and says why, a source still parsing its metadata is retried, dispose cleans up
  - `Workspace.url.test.tsx` — workspace URL param sync
- Run tests: `cd gis_workbench && npm test` (watch mode) or `npx vitest run` (CI).
- ESM-only dependencies (`ol`, `rbush`, `quickselect`, `pbf`, `earcut`, `geotiff`, `lerc`, `quick-lru`, `@petamoriken`, `color-parse`, `color-rgba`, `color-space`, `color-name`) are configured in `vite.config.ts` under `test.deps.optimizer.web.include`. If you add a new ESM-only dependency, add it to that list.
- Prefer testing **utils/** functions (pure logic) for new logic. Component tests require mocking the OL map and browser APIs, which is complex — but they exist for the major UI flows and should be kept passing.
- When testing functions that use `crypto.subtle` (appLock, cogHelpers), note that jsdom does not provide it — mock or polyfill as needed.
- **Coverage report:** `npx vitest run --coverage` writes HTML to `coverage/lcov-report/index.html` plus machine-readable `coverage/lcov.info`. As of 2026-08-07 (41 suites, 512 tests) overall line coverage is ~56%: the pure parsers/writers (`featureFilter`, `shapefileWriter`, `shapefileParser`, `vectorExport`, `boxSelection`, `mapImageOverlays`, `livewire`, `contourExtract`, `attributeTable`) and app-lock code are 80–100%, the extracted hooks are well covered (`useLayerDragReorder` ~90%, `useVertexEditing` ~84%, `useDrawSession` ~61%, `useMagneticDraw` ~63%), and `AttributeTableWindow` sits at ~66%; remaining gaps are MapPage init/popup/context-menu paths, `AdvancedSettingsDialog` (0%), the OL/DOM-heavy hooks `useBoxSelection` (~17%) and `useSamTools` (~30%), and OL/browser-coupled utils like `idb`/`tileHelpers`/`projectionHelper`/`rasterLayerFactory`/`samEngine`/`projectTransfer`. Add tests in those areas before refactoring them.

---

## 11. Build & Dev Commands

```bash
cd gis_workbench

# Development server (hot reload, port 3000)
npm start

# Production build → gis_workbench/build/
npm run build

# Run tests (watch mode)
npm test

# Run tests once (CI)
npx vitest run

# Type-check without emitting
npx tsc --noEmit

# Test coverage report (HTML in coverage/lcov-report/)
npx vitest run --coverage
```

---

## 12. Git Conventions

- Commit messages are short imperative summaries: `"COG as layer, from http, s3, local file source"`, `"fix refresh web password reset"`.
- No branch naming convention is enforced. Feature branches are merged via PR.
- The `sample/` directory is gitignored — do not commit sample data files.

---

## 13. Common Pitfalls & Gotchas

1. **MapPage.tsx is ~3 000 lines.** Search before adding. Many helpers already exist. Use `grep -n` to find the relevant section.
2. **OL layer lifecycle.** Layers are created in `MapPage` and passed up as config objects. Never create an OL layer inside `SettingsDialog` — it only handles UI forms and calls `onAdd*` / `onUpdate*` callbacks.
3. **CSS filter bleed.** Brightness/saturation/contrast on raster layers are applied via CSS filters on the OL layer's canvas element. A renderer patch in `layerHelpers.ts` (`patchLayerRenderer`) prevents the filter from bleeding to other layers. COG (WebGLTile) layers use a different path (`applyColorAdjustments` / `cogColorVariables`). If you add new visual effects, follow the same pattern.
4. **IndexedDB is async.** All IDB reads/writes return Promises. Layer rebuild (on workspace switch, import, etc.) is an `async` function — be careful with stale closures over state.
5. **COG layers need WebGL.** `ol/layer/WebGLTile` will throw on browsers without WebGL. The error is caught and surfaced as a toast.
6. **File-based COG layers stream — the bytes are never copied.** Only a small header slice (`COG_HEADER_VALIDATION_BYTES`, 2 MB) is read for validation; the OL GeoTIFF source then streams the rest via HTTP Range requests on a blob URL created directly from the `File` (so multi-GB files work without `NotReadableError` / OOM). The blob URL + `File` are kept in `cogFileRegistry.ts` for the document lifetime, and the layer *config* is persisted to workspace settings (with the blob URL stripped), so file COG layers **survive workspace switches** within a session. After a page reload the registry is empty and the layer cannot be restored — the user must re-add the file (a toast explains this on restore). Never read a local COG with `file.arrayBuffer()` or store its bytes in IndexedDB. HTTP and S3 COG sources persist normally.
7. **COG band metadata comes from a private OpenLayers field.** `utils/cogBands.ts` reads the parsed geotiff.js images off the ready source (`sourceImagery_`) because OL exposes no public accessor for the colour table or per-band sample types. Every read is guarded and `describeCogBands()` never rejects — if an OL upgrade renames the field, the picker degrades to plain numbered bands instead of breaking the layer. Don't widen that dependency: `bandCount` / `hasAlpha` are public, everything else is best-effort. Results are memoised per source object, so a rebuilt layer simply reads again. GDAL statistics live in the *full-resolution* image's `GDAL_METADATA` tag — overviews carry none — so `readBandInfo` walks the level list fine-to-coarse; reading only `sourceImagery_[s][0]` (the coarsest overview) silently loses statistics that QGIS shows.
8. **S3 pre-signed URLs expire.** The default TTL is 1 hour. If a COG S3 layer stops loading after sitting idle, the URL needs re-signing. The layer rebuild path calls `resolveS3CogUrl()` which re-signs automatically.
9. **proj4 definitions are global.** Once registered, a projection persists for the page lifetime. This is fine for a SPA but be aware in tests.
10. **The attribute filter parser** (`featureFilter.ts`) is a hand-written recursive-descent parser. It has its own test suite. If you extend the grammar, add tests for every new token/production.
11. **Shapefile writing** splits mixed-geometry layers into separate `.shp` files per geometry family (point, line, polygon). The writer is binary-level — be very careful with byte offsets and padding.
12. **App lock encrypts everything.** When adding new localStorage keys, make sure they are prefixed with `mapviewer` so they are picked up by `collectAppStorage()` / `restoreAppStorage()` in `appLock.ts`, or they will survive a lock/unlock cycle unencrypted.
13. **SAM tools are session-only; the models are not.** Nothing SAM-related persists in workspace settings, but whichever model payload loads does persist — in IndexedDB (SAM 2.1: `sam21:encoder:repaired:v1` / `sam21:decoder:v1`; SlimSAM: `slimsam77:encoder:v1` / `slimsam77:decoder:v1` keys of the `mapviewer` DB), so it never re-fetches on refresh. Candidate order (`SAM_MODEL_PRIORITY` in `samModels.ts`): SAM 2.1 Tiny, then SlimSAM-77; each is tried via its IDB cache, then its bundled static copy (`public/models/sam2.1/` — the repaired, If-node-folded export, see the README in that folder before touching those files — and `public/models/slimsam/`, whose fp32 files fit Cloudflare's 25 MiB static-asset limit). There is **no remote download any more**: Hugging Face no longer serves `resolve/main` with a permissive CORS header, and its zip contains the upstream encoder that ORT >= 1.2x rejects anyway. Every payload is validated by actually creating the inference sessions before it is accepted/cached, and the static loader rejects HTML impostors (`validateStaticPayload`) — Cloudflare's SPA fallback answers 200 + `text/html` for the excluded SAM 2.1 paths. The deploy config (`wrangler.jsonc`) excludes `models/sam2.1/**` because the ~104 MiB encoder exceeds the 25 MiB per-file asset limit; hosted visitors therefore run SlimSAM while local dev keeps SAM 2.1. The two exports use different tensor contracts (`SamModelKind`); `encode()`/`predict()` in `samEngine.ts` branch on `engine.kind`. The onnxruntime-web runtime itself loads from the jsDelivr CDN. WebGPU is strongly preferred, WASM fallback is slow. The SAM overlay layers carry `_isSamLayer` so `captureMapCanvas` excludes them from snapshots and `reorderLayers` keeps them above drawings.
14. **SAM snapshots need readable pixels.** `captureMapCanvas` composites layer canvases and reads them back — any tile layer served without CORS taints the canvas and blocks the AI tools (surfaced as a toast). The snapshot is tied to the exact view: any pan/zoom invalidates the encoder embedding (wand sessions cancel). The model-free magnetic edge guide (`useMagneticDraw`) is likewise view-tied — it re-extracts edges automatically after each pan/zoom.
15. **`signedArea` in `geoprocessing.ts` uses the surveyor form, so its sign is the opposite of the usual shoelace convention.** A standard counter-clockwise ring has a *negative* `signedArea`, which means `ensureCCW()` actually returns a clockwise ring and `ensureCW()` a counter-clockwise one. Anything mixing these helpers with an outside convention (a new clipper, a GeoJSON writer, a winding check) must re-derive orientation instead of trusting the names. This bit twice already: `clipPolygon` normalised its cutter with `ensureCCW` while `clipEdgeByLine` keeps the *left* half-plane, so Clip and Intersect silently returned no features at all. **Two conventions now live in the same folder:** `utils/overlay.ts` deliberately defines its own `ringSignedArea()` / `isRingCcw()` with the *standard* mathematical sign (positive = CCW, as GeoJSON RFC 7946 wants it). Pass rings across that boundary, never an orientation judgement, and do not "unify" the two helpers without re-running both test suites.
16. **`ol/structs/RBush` stamps a `getUid()` property on every value it stores**, so values must be objects — inserting a plain number index throws `Cannot create property 'ol_uid' on number '0'`. `ExtentIndex` (`utils/geomIndex.ts`) boxes and unboxes values for you; use it instead of `RBush` directly.
17. **The overlay kernel labels region membership by NONZERO WINDING, not even-odd.** `RingLocator` normalises each ring structurally (ring 0 of a part is the shell → CCW, the rest are holes → CW, whatever the source data says, because plenty of real layers ignore the GeoJSON winding rule) and sums winding numbers, so a shell cancels its own hole. Even-odd would be wrong twice over: a buffer's offset curve can loop back over itself at a sharp mitre and a Make Valid input can cover the same ground twice, and under even-odd that doubly-covered ground reads as OUTSIDE — the sharp-bend mitre buffer came back 20 % short before this was fixed. A ring whose lobes cancel out (a bowtie has area 0) has no orientation to normalise to and is left exactly as written, so each lobe still reads as inside and `repairGeometry` returns both of them.
18. **`GeoProcessingPanel`'s overlay layer must never default to the input layer.** On first mount the input id is still `''` when the second-layer effect runs, so a "pick the first layer that is not the input" fallback picks the layer the input is about to become — and if the effect only re-runs when the stored id disappears from the list, nothing ever re-picks it. Clip / Intersect / Union / Difference then silently run a layer against itself (Difference returns nothing at all) while the select, which filters the input out of its options, shows a placeholder. The effect now re-picks whenever `secondLayerId === inputLayerId`, and `handleRun` refuses to run a two-layer tool in that state.
19. **Web Mercator is not a measuring CRS.** Planar lengths are stretched by sec(φ) and areas by sec²(φ) — at 60° latitude a planar area is 4× the ground truth. Buffer radii are scaled up by `cosh(y/R)`, and every reported area, length and distance goes through `utils/geodesic.ts` (the same maths `ol/sphere` and the on-map measure tool use, so the numbers agree). Note the residual: spherical measures use the mean Earth radius (6371008.8 m) while the projection uses the WGS84 semi-major axis (6378137 m), so a planar 3857 area still differs from a ground area by a constant ~0.22 % at the equator. That is expected, not a bug.
20. **A tool that cannot be exact must say so in the UI.** `ToolDef.approximate` renders the amber warning and `ToolDef.note` a neutral hint; both are asserted by `GeoProcessingPanel.test.tsx`, which walks the tools that used to be approximate and requires the warning to be *gone*. When an engine reaches parity, delete the caveat and convert its `KNOWN LIMITATION` test into a real assertion in the same change — the two must never drift apart.
21. **Never access the deployed site when checking or verifying issues.** Do not fetch, curl, or browse the production deployment (or any hosted URL) to reproduce, confirm, or validate a bug. The deployed site reflects whatever was last deployed — not the current working tree — and may be stale, cached, or masked by the Cloudflare SPA fallback (200 + `index.html` for arbitrary paths), so remote checks give misleading results. Verify locally instead: run the test suite (`npx vitest run`), type-check (`npx tsc --noEmit`), and when a running app is required, build (`npm run build`) and serve the local build, or use the dev server (`npm start`), then hit `localhost` only.
22. **WebGL expressions have no boolean arithmetic, and a shader that fails to compile freezes the whole map.** OpenLayers' expression parser does not type-check: `['!=', a, b]` compiles to `(a != b)` and is dropped verbatim into whatever surrounds it, so `['+', ['!=', a, b], c]` emits `(a != b) + c`. GLSL rejects arithmetic on booleans, `ol/webgl/Helper` throws on the failed compile, and that throw lands inside the map's render frame — the frame loop dies, so *every* layer (basemap included) stops drawing while panning still moves the view. The first version of the contour renderer did exactly this. Booleans are only legal in a condition slot (`case` conditions, `any` / `all` / `!` operands); write a 0/1 flag with numbers instead — `['clamp', ['abs', ['-', a, b]], 0, 1]` means "a and b differ" when both sides are `floor()` results, and the expression language has no `min`/`max`, so sum-then-clamp is the way to OR two flags. `utils/cogBands.ts` runs every generated `color` expression through `expressionHasBooleanArithmetic()` and drops it (console error + OpenLayers' default style) rather than shipping an uncompilable shader; the GLSL canaries in `cogBands.test.ts` compile each renderer through OpenLayers' own compiler and assert the output contains no comparison operator.

23. **A hole must never be nested into a shell smaller than itself.** `nestOverlayRings` picks the smallest shell containing an interior point of the hole — and when the hole *encloses* an island (a donut whose hole is partly filled by the other operand, so the island shell sits inside the hole ring), that interior point can land inside the island. The area still comes out exactly right, because area is shells-minus-holes summed over every part and mis-nesting cancels, so only a point-set oracle catches it. JTS's `EdgeRing.findEdgeRingContaining` guards with `if (tryArea <= testArea) continue`; `nestOverlayRings` and `nestPolygonizeRings` both do now. Any new containment-based nesting needs the same guard.
24. **"Are these segments parallel?" must be answered with the snapping tolerance, never with a relative epsilon.** `|den|` is `len1·len2·sin θ` and is built from DIFFERENCES of ordinates, so at EPSG:3857 magnitudes it carries ~1e-7 of cancellation error while `1e-14·len1·len2` is ~1e-10. Exactly-collinear edges then read as barely-crossing, the solver invents an intersection, and whether a geometry is VALID starts to depend on where on Earth it sits rather than on its shape: one ring, bit for bit identical, validated clean at (0, 0) and as self-intersecting at (1.5e7, −4e6). `segmentsParallel()` in `utils/overlay.ts` is the single answer (`|den| <= max(1e-14·len1·len2, tolerance·max(len1, len2))`); both the noder and the validator use it. Add any new parallelism/collinearity test there, not inline.
25. **Non-finite coordinates are refused, never half-processed.** A NaN ordinate poisons every comparison it touches (NaN < x and NaN > x are both false, so it sorts nowhere and lands in no node bucket) and survives into the output rings, where `JSON.stringify` then silently deletes it. `hasFiniteCoordinates()` gates every overlay entry point — including `unionGeometries`' single-subject fast path and `unionComponents`' clone-through, which is how one leaked — and the operation returns `null` rather than dropping just the bad operand (for a two-operand overlay, dropping it would turn A∩garbage into A∩∅). Check Validity reports the feature and, since the NaN itself cannot be plotted, locates the error at the nearest finite vertex so the error-point layer is not empty.
26. **A ring that visits one node twice is two regions, not one.** A minimal-cycle walk cannot tell "one region" from "two regions meeting at a point": where lobes CROSS, noding gives the node four distinct edges and the turn rule splits them, but where they merely TOUCH the walk goes straight through and returns a figure-eight, which is invalid (GEOS "Disconnected Interior") — so an overlay of valid input could fail its own Check Validity, and Make Valid could not repair a pinched polygon at all. `splitPinchedRing()` peels the lobes apart (JTS splits at the same articulation points) and preserves signed area exactly. GEOS names this **"Ring Self-intersection"**, not "Disconnected Interior", and so does `validateGeometry` — see §13.32 for the two-rings case that *is* a disconnected interior.
27. **The real-data suite depends on `sample/`, which is git-ignored.** `geoprocessing.realdata.test.ts` resolves `../../../sample` and every suite in it is `describe.skipIf(!HAVE_SAMPLES)`, so a fresh clone skips rather than fails. Do not "fix" a skip by committing the 30 MB of sample data or by weakening an assertion: if you have the data, the suite must pass; if you do not, it must skip. The QGIS reference output in there (`sample/Dissolve_of_1_qgis.geojson`, written by QGIS 3.44.7) is a fixture, not scratch data. It is no longer the only external oracle: `tools/geos-golden.py` asks the GEOS 3.14.1 bundled with the local QGIS install for validity, Make Valid, overlay and buffer answers and commits them as `src/utils/geosGolden.json`, so the differential suites run without Python, without QGIS and without `sample/`.

28. **geotiff.js allocates the whole read window before it resamples, and the Contours renderer reads raw DEM windows.** `readRasters({ window, width, height })` materialises `window` at the level's own resolution first, so asking a 25 cm DSM for the window a wide view covers tries `new Float32Array(2e10)` and throws a RangeError. `utils/cogContours.ts` therefore picks the overview level by the *window's pixel count* (`MAX_READ_PIXELS`), walking coarser — accepting upsampling — until the window fits, and refuses the read (with a reason) when even the coarsest level is too big. **A GDAL COG geo-references its main IFD only:** every overview IFD answers `getBoundingBox()`/`getResolution()` with *"The image does not have an affine transformation"*, so a level list built by asking each image where it is keeps nothing but the full-resolution level — which is exactly the level whose window does not fit, so every zoomed-out contour trace failed with a bare "could not read elevations". `levelGeometries()` derives the overviews the way `ol/source/GeoTIFF` derives their resolutions: same extent as the largest geo-referenced level, pixel size scaled by the width ratio, nodata inherited, and the list sorted coarsest-first here instead of being trusted from OpenLayers' private field. Never filter levels by whether they can answer for themselves, and never report a refused read without its reason (`ContourFailure` + `contourFailureMessage`) — "still loading", "the view is off the file" and "no overview small enough for this zoom" need three different responses. The traced lines go into a companion vector layer (`hooks/useCogContours.ts`) carrying `_isCogContourLayer` + `_cogContourParent`, which is what `reorderLayers` uses to keep the overlay immediately above its raster; the raster hides underneath (QGIS draws contour lines alone) and returns with the suggested grayscale style if a trace fails, so a failed read never leaves a blank or all-black map. Traced coordinates are built in the **view** projection — OL does not reproject vector layers — so never assume EPSG:3857 in that path.
29. **Every draw tool must land as a GeoJSON-writable geometry.** Whatever a draw tool produces is persisted as GeoJSON (the draw session, a saved layer's `drawnGeoJson`, every export format), snapshot-cloned for undo/redo, vertex-edited and fed to the Vector Tools — so an `ol/geom/Circle` may never leave a `Draw` interaction. The rectangle tool converts its Circle sketch with OL's `createBox()`, the Circle tool with `utils/circleDraw.ts` (128-vertex rings, geometric or geodesic). Dense rings are fine, but then measurement labels need a policy: a circle carries its **area chip alone** (`_circleMode` → `buildMeasurementStyles(..., { circle: true })`, and `shouldShowFeatureMeasurements` exempts it from the 30-vertex rule). That flag must ride *every* persistence path — session snapshot, `saveDrawSession` meta and the saved-layer `drawnFeatureMeta` — or the readout silently disappears after a reload/undo.

30. **Buffer has two paths, and the exact one is the fallback — do not "simplify" them into one.** `bufferGeometry` first walks the offset curve (`bufferGeometryRaw`, one ring per side joined at the corners) and keeps it when `validateGeometry` says it is clean: for tidy input that is the same tessellated ring GEOS emits at a thousandth of the cost, and every golden number in the tests comes from it. When the offset curve crosses itself — routine as soon as the distance approaches a segment length — the exact path takes over (`bufferGeometryExact`): the buffer of S by d is the Minkowski sum with a disc, which for a coordinate sequence decomposes *exactly* into one ±d slab per segment, one wedge per bend **on the outside of the bend only**, and one cap piece per open end. "Outside only" is what makes the union equal to the buffer rather than a superset: a point within d either projects into a segment's interior (so it is in that slab) or its closest point is a vertex, in which case it lies in the exterior wedge there. Negative distances cannot be a union, so erosion is a *difference* of the same pieces (`S ⊖ d = S ∖ (∂S ⊕ d)`), which splits a neck thinner than 2d instead of inverting it. Measured effect on `sample/roads-seoul.geojson` at 50 m: 68 of 94 invalid buffers and 57 % too much area became 0 invalid and the correct 5.31e6 m². Cost: one kernel pass per feature, which is why `bufferFeaturesAsync` exists and why the panel buffers through a progress token. A LineString that loops back on itself is decomposed *cyclically* (no caps, and the closing vertex is a bend like any other), and a single-sided buffer of one is clipped by its own ring, because one of its two sides IS its inside: GEOS's `buffer(d, single_sided=True)` on an open line agrees with this to 1e-13 on both signs, while on a closed ring it is not self-consistent — the golden file records both.
31. **An inset ring can be small, valid, correctly oriented — and on the wrong side of the crossing.** `bufferPolygonRing` guards a negative buffer with "the orientation did not flip" and "the area shrank", and neither can see the failure that matters: once the inset exceeds the local width the offset edges cross and what comes back is a tiny, perfectly well-formed polygon. A 1×1 square eroded by 0.6 returns the 0.2×0.2 "square" whose corners are 0.4 from the boundary — the true erosion is EMPTY. `erosionIsSound()` therefore tests the definition instead: every vertex of the result must be inside the source AND at least |d| from its boundary, pruned by an extent index and tested as a threshold (query the |d| box; if nothing in it is closer than |d|, nothing outside can be). Any new negative-distance path needs the same guard, because no orientation or area test can replace it.
32. **Validity is a predicate, snapping is a policy, and they need different tolerances.** `overlayTolerance` answers "how close is close enough to call two coordinates the same node" and keeps a 1e-6 floor, which in EPSG:3857 metres is a micrometre — the same number read in DEGREES is 0.11 m, coarser than the data it judges. SA274 in `sample/australian-suburbs.geojson` has two boundary segments passing 4e-7° (4 cm) apart beside a vertex; at a 1e-6° floor they "touch", so a locality GEOS calls valid was reported as a ring self-intersection. `predicateTolerance()` derives the contact tolerance from the ordinates' own magnitude (a few hundred ULP) instead, which is as close to GEOS's exact predicates as a float kernel gets, while snapping stays coarse so near-coincident real boundaries still dissolve into one edge. Related: an endpoint landing on another segment's interior is a **touch, never a crossing** — with one end pinned, the rest of the segment lies on one side only. Calling that a crossing is what made a hole whose apex sits on the shell's edge read as a self-intersection.
33. **A point where two rings of one part meet is not an error; a part falling apart there is.** GEOS 3.14.1 says `POLYGON((0 0,10 0,10 10,0 10),(5 0,7 3,3 3))` — a hole whose apex touches the shell's edge — is VALID, that two holes touching at a corner are VALID, and that `make_valid` returns both unchanged: the material walks around the hole, so the interior is connected. Disconnection needs TWO meeting points, which is the dart case (`POLYGON(...,(3 0,5 3,7 0,5 1))` → "Interior is disconnected[3 0]", MakeValid → 2 parts). This module used to report every point touch as a disconnection, which flagged real data every reference platform accepts — NSW778, and the symmetric difference of two adjacent localities, and 2 of the 4 "broken" features in the 16 288-locality census. `interiorRegions()` now measures the definition: the touch points are boundary, so the interior is disconnected exactly when the material falls apart once they are removed — subtract a disc of ε = 8×tolerance around each and count the parts. One kernel call, only for a part that actually has a touch, and skipped entirely for a part that already failed a structural check (a hole outside its shell makes the winding-number region the test measures meaningless). ε is 8× and not 1000× because on degree-based data 1000× the tolerance floor is a 111 m bite out of a suburb.
34. **Node snapping must be transitive, and its representative must not depend on who arrived first.** The old table resolved each coordinate as it came — nearest existing node within tolerance, else insert — which is order-dependent twice over. Not transitive: three squares whose left edges sit 0.6·tolerance apart in a chain (A~B, B~C within tolerance, A~C at 1.2·tolerance) became one node in one order and three nodes with a sliver edge between two of them in another, and `unionGeometries` returned the correct 32-unit polygon for `[A,B,C]` and **null** for `[C,B,A]`. And the representative was the first coordinate inserted, so `A △ B` and `B △ A` differed byte for byte on 32 of 40 random pairs — for an operator that is symmetric by definition. `NodeTable` now registers every candidate, clusters with a union-find over the "within tolerance" relation (whose transitive closure is a property of the point set), prefers an INPUT vertex as the cluster representative (so an overlay never moves a boundary it was given), numbers the clusters lexicographically, and `buildTopology` stores edges low-node-first and sorts them. Intersection points are averaged in value order too, because floating-point addition is commutative but not associative — that alone was worth ~1 ULP of output drift. One residual: a single mislabelled edge in a crowd of near-coincident ones (a piece-union buffer produces ~11 000) leaves one node with a surplus departure and another with a surplus arrival, no walk can close, and the whole overlay returns null; `closeSelectionGap()` re-adds that one edge when — and only when — exactly one such pair exists and the topology already contains the edge between them.

---

## 14. Code Style

- **TypeScript strict mode** is enabled. No `any` unless interfacing with untyped OL internals (use `any` sparingly and add a comment explaining why).
- **Functional components only.** No class components.
- **Hooks order matters.** Keep `useState` / `useRef` / `useEffect` / `useCallback` declarations at the top of the component, grouped logically. Never call hooks conditionally.
- **Prefer `useCallback`** for functions passed as props to child components, to avoid unnecessary re-renders.
- **Comments:** use `// ---` section dividers in large files. Document non-obvious logic with `/** ... */` JSDoc blocks. Keep comments accurate — update them when changing the code they describe.
- **No default exports** for components. Use named exports: `export function MapPage()`, `export const SettingsDialog = ...`.
- **String literals:** use single quotes for JS/TS strings. Use template literals for interpolation.
- **No unused imports or variables.** Remove imports and locals that stop being used in the same change that orphans them. Verify with `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` (must stay clean). With the automatic JSX runtime (`jsx: react-jsx`), `import React` is only needed when `React.*` types/values are referenced.
- **Error handling:** wrap async operations in try/catch. Surface user-facing errors via `window.alert()` or toast messages (search for existing patterns). Log technical errors to `console.warn` / `console.error` with a `[ComponentName]` prefix.

---

## 15. Feature Checklist for PRs

Before submitting changes, verify:

Verification is **local-only** — never access the deployed/hosted site to check issues (see Gotcha 14).

- [ ] TypeScript compiles cleanly (`npx tsc --noEmit`)
- [ ] No unused imports/variables (`npx tsc --noEmit --noUnusedLocals --noUnusedParameters`)
- [ ] Existing tests pass (`npx vitest run`)
- [ ] New pure-logic code has unit tests in `utils/`
- [ ] New persisted fields are added to `types.ts`, `workspaceStorage.ts`, and (if applicable) `appLock.ts` storage collection
- [ ] New layer types handle cleanup on removal (IDB blobs, OL layer disposal)
- [ ] CSS additions are in `App.css` with a section comment
- [ ] No OL objects leaked into serialisable config state
- [ ] Verification used local artifacts only (tests / type-check / local build or dev server); the deployed site was not accessed
- [ ] The README "Pending Features" table is updated if a feature is completed
