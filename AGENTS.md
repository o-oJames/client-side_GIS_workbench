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
│   ├── DrawToolbar.tsx
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
│   │                        #   session persistence, saved-layer re-edit
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
│   ├── measurement.ts       # Geodesic distance/area, label styling
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
│   │                        #   points, and the GEOS validity classes. Read its
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
│   │                        #   the pitfalls in §13 before touching it
│   ├── geodesic.ts          # Pure spherical geodesy over EPSG:3857 input:
│   │                        #   3857↔4326, great-circle distance, spherical-
│   │                        #   excess area (holes subtracted), ground length
│   │                        #   and perimeter. A port of the ol/sphere maths so
│   │                        #   the engines stay measurable without importing OL
│   ├── geomIndex.ts         # Extent helpers plus ExtentIndex, a thin wrapper
│   │                        #   over ol/structs/RBush used to prune the pairwise
│   │                        #   geoprocessing engines (boxes its values — see §13)
│   ├── drawHelpers.ts       # Draw styles, vertex editing helpers, undo/redo
│   │                        #   snapshots, session persistence
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
    ├── SettingsDialog.rasterEdit.test.tsx # Raster layer edit form
    ├── AddRasterLayerForm.test.tsx # Add-raster form: collapses only after a
    │                              #   successful add; failures keep the inputs
    │                              #   and report inline above Add/Cancel
    ├── SettingsDialog.attrRender.test.tsx # Attribute-driven render (smart mapping) UI
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
        ├── drawHelpers.test.ts      # measurement-label gating, snapshot
        │                            #   capture (incl. attribute-only /
        │                            #   null-geometry features), persistence
        ├── middleButtonPan.test.ts  # middle-button drag panning (button
        │                            #   gating, overlay guard, cursor class,
        │                            #   detach)
        ├── livewire.test.ts
        ├── samEngine.test.ts
        ├── boxSelection.test.ts
        ├── mapExport.test.ts
        ├── mapImageOverlays.test.ts
        ├── measurement.test.ts
        ├── overlay.test.ts          # Overlay kernel golden tests: concave and
        │                            #   multipart cutters, holes on either side,
        │                            #   containment, N-way union, bowtie repair,
        │                            #   point/line clipping, polygonize, interior
        │                            #   points, adjacency, validity classes
        ├── geoprocessing.test.ts    # Vector Tools golden tests, including the
        │                            #   remaining KNOWN LIMITATION cases that pin
        │                            #   the deliberate deviations from GEOS/QGIS
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
- **The "Vector Tools" panel runs on a hand-written planar overlay kernel.** `utils/overlay.ts` implements the JTS OverlayNG model in four steps: **node** every segment at every crossing (snapping the results into a shared node table, so two parcels sharing a boundary become ONE edge), **label** each noded edge by sampling a point either side of its midpoint against the *original* subject geometries, **select** the edges whose two sides disagree about membership of the result region and orient them with that region on their left, then **assemble** them into minimal cycles (shells CCW, holes CW) and nest the holes into the shells that contain them. Because labelling asks the original geometries rather than an edge's own parent ring, one pass handles N subjects — which is what makes N-way union (QGIS Dissolve, `ST_Union(geom[])`), "a polygon inside another polygon" and "two polygons that merely touch" all come out right. That kernel backs Clip, Intersect, Union, Difference, Symmetrical Difference, Dissolve, Eliminate, Make Valid, Polygonize and the buffer repair pass, so those tools now agree with each other and with GEOS on concave cutters, holes on either side, containment and multipart input. There is still **no GEOS/JTS/turf/WASM dependency** — the stack stays React + OpenLayers + proj4. Conventions every new or modified engine must follow: (1) **tolerances are scale-derived** — use `toleranceForFeatures(...)` / `scaleTolerance(span)` / `overlayTolerance(...)`, never a bare `1e-9`, since EPSG:3857 ordinates are ~1.5e7 where that sits below the float noise floor; (2) **holes travel with their shell** — take polygons apart with `getPolygonParts()` (or `geometryParts()` in geoTypes); `getAllPolygonRings()` is for boundary-only work and `getExteriorRings()` for tools where holes cannot change the answer; (3) **prune with `ExtentIndex`** before any pairwise loop; (4) **measure on the ground** through `utils/geodesic.ts` — never label a planar shoelace or `dist()` value as metres; (5) **anything that can take seconds is async and cancellable** — accept a `ProgressToken` plus a reporter, drive the loop with `progressLoop`, pass the caller's *own* token object (a copy silently disables Cancel), and split the work into units small enough to cancel *between*: Dissolve works per connected component for exactly this reason; (6) **no silent area loss** — report what could not be processed (`EliminateResult.droppedIndices`), drop degenerate results rather than inventing geometry (`overlayGeometries` returns `null`, never a convex hull), and never let a repair come back smaller than what it was given (`repairIfInvalid`); (7) **declare approximations in the UI** — `approximate:` on a `ToolDef` renders the amber `.gp-form-hint--warning` caveat and `note:` a neutral hint; remove them as an engine reaches parity. What is left is marked `KNOWN LIMITATION` in the engines and pinned by tests that are meant to be **updated, not preserved**.
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
- **COG band rendering lives in `utils/cogBands.ts`, never inline in a component.** OpenLayers maps a GeoTIFF's first bands to RGBA and offers no picker, so multispectral/paletted files need an explicit `color` style expression (`['array', ['band', r], ['band', g], ['band', b], 1]`, `['palette', index, colors]`). Two rules follow from how OL works: (1) band *mapping* is style-only — the source loads every band, so `layer.setStyle()` switches bands live with no requests, and `setStyle()` **replaces** `style.variables`, so the current brightness/contrast/saturation values must be folded back in (see `applyCogRender`); (2) anything that changes pixel *normalisation* (a display stretch, a colour table's index range) must be passed to the GeoTIFF source as per-band `min`/`max` at construction, which is why `createCogLayer` is two-phase and why such a change rebuilds the layer. Keep `color` undefined in `auto` mode so OL's own default mapping is untouched. (3) `hillshade` and `contour` are pure style expressions built from neighbour-pixel reads (`['band', n, dx, dy]`, Horn's 3x3 gradient / an isoline floor-difference test); they recover real-world elevations by scaling the normalised band back through the *elevation window* (explicit stretch, else the file's statistics, else the data-type range), so only their stretch window rebuilds — sun position, intervals and colours apply live.
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
  - `livewire.test.ts` — classical edge pipeline (downsample, blur, Sobel, NMS, chain tracing, simplification)
  - `samEngine.test.ts` — SAM preprocessing/postprocessing pure helpers, static-model payload validation (HTML-fallback impostor guard) and SlimSAM int64 prompt-label conversion
  - `boxSelection.test.ts` — selection-box geometry (extent↔pixels, handles, hit testing)
  - `mapExport.test.ts` — map capture compositing (excluded layers hidden only inside the synchronous capture step, size rejection), PNG blob encoding, tainted-canvas detection
  - `mapImageOverlays.test.ts` — scale bar / legend / north-arrow overlay drawing
  - `measurement.test.ts` — geometry vertex counting & measurement-label visibility default (30-vertex rule) + explicit override
  - `overlay.test.ts` — the overlay kernel: ring orientation, point location, union (adjacent / overlapping / contained / disjoint / N-way / donut), intersection (concave cutter, slot in the clip layer, subject holes, multipart cutter), difference, symmetric difference, the invariants (canonical winding, either input orientation, float-noise duplicates, T-junctions, real 3857 magnitudes), lossless repair (bowtie → both lobes, stray hole → own polygon, spike removal), clipping points and lines, polygonize (grid faces, mid-segment nodling, dangles, nested disjoint cycles), interior points, connected components, adjacency and shared-boundary length, and every GEOS validity class
  - `geoprocessing.test.ts` — golden tests for every Vector Tools engine: scale-derived coordinate tolerance, shell/hole polygon parts, extent indexing, the progress/cancel token, buffer (Mercator radius scaling, rounded 90° corners, cap and join styles, hole preservation, collapse rejection, dissolve/separate-parts/per-feature distance, self-intersection repair), clip and intersect (concave cutters, holes on both sides, points and lines, index-vs-brute-force parity, async/sync agreement, cancellation, attribute-collision suffixing), union / difference / symmetric difference (QGIS overlay semantics, nulled foreign fields, non-polygonal pass-through), dissolve (group by one or many fields, keep disjoint, component-level cancellation), centroid and point-on-surface, per-feature convex hull, nearest and k-nearest distance, eliminate (all three strategies, partial shared edges, overlap, holes, drop reporting), validity (every GEOS class, all reasons, error-point layer), lossless make valid, collect by field, polygonize, Voronoi (cell attribution), Delaunay, densify/simplify (both methods, topology guard, ground units)/vertex and type conversion, geodesic geometry attributes, merge/split/remove-selected, and the OL↔GeoJSON bridge. Cases prefixed `KNOWN LIMITATION` are meant to be **updated, not preserved**, as the engines reach parity
  - `geodesic.test.ts` — 3857↔4326 round trips, great-circle distance, spherical area with holes subtracted, perimeter over every ring, and the sec²(φ) planar-vs-ground ratio, each cross-checked against `ol/sphere`
  - `geomIndex.test.ts` — extent helpers, empty-extent handling, R-tree add/load/query/clear and pruning over a 10 000-cell grid
  - `drawHelpers.test.ts` — measurement-label gating in draw-feature styling, the visibility toggle, draw-session persistence round-trips, session-snapshot tolerance of attribute-only (null-geometry) features, RTree-pruned vertex/segment hit testing, and the undo-history vertex budget
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
  - `SplitScreen.test.tsx` — split-screen comparison UI
  - `MagneticDraw.test.tsx` — magnetic (livewire) draw-mode integration
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
