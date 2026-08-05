# AGENTS.md — Contributor Guidelines for AI Agents

This document is the authoritative guideline for AI agents (and human contributors) working on this codebase. Read it in full before making any changes.

---

## 1. Project Overview

**Client-Side GIS Workbench** is a single-page interactive web map viewer. It renders raster tiles (XYZ, WMTS, WMS, COG) and vector data (GeoJSON, KML, KMZ, Shapefile, MVT, WFS, STAC) on an OpenLayers map, with drawing/annotation tools, feature inspection, layer management, workspaces, and an encrypted app-lock vault.

The entire front-end lives in `mapviewer/`. There is no back-end server — all persistence is client-side (localStorage + IndexedDB).

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
| Build tooling | Create React App (`react-scripts`) | 5.x |
| Crypto | Web Crypto API (native) | — |

No state-management library (Redux, Zustand, etc.) is used. All state is React `useState` / `useRef` / `useCallback` hooks, lifted to the appropriate component.
---

## 3. Architecture & File Responsibilities

```
mapviewer/src/
├── App.tsx              # Root: routing (/map), workspace registry, lock state
├── App.css              # ALL styles (single file, no CSS modules, ~6 300 lines)
├── types.ts             # Shared interfaces (RasterLayer, VectorLayerConfig, etc.)
├── constants.ts         # Storage keys, basemap presets, config constants
├── index.tsx            # ReactDOM entry
├── index.css            # Minimal body reset (CRA default)
├── components/          # React components (one file each)
│   ├── MapPage.tsx      # ★ Largest file (~2 800 lines) — OL map init, layer
│   │                    #   lifecycle, all map interactions (draw, modify,
│   │                    #   click, context menu, DnD)
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
│   ├── cogFileRegistry.ts   # Session blob-URL registry for file-based COG
│   │                        #   layers (keeps the File + blob URL alive across
│   │                        #   workspace switches; no bytes are copied)
│   ├── featureFilter.ts     # Attribute-filter expression parser & evaluator
│   ├── colorHelpers.ts      # Colour parsing, RGBA conversion, random palette
│   ├── measurement.ts       # Geodesic distance/area, label styling
│   ├── drawHelpers.ts       # Draw styles, vertex editing helpers, undo/redo
│   │                        #   snapshots, session persistence
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
    ├── SettingsDialog.attrRender.test.tsx # Attribute-driven render (smart mapping) UI
    ├── MapPage.draw.test.tsx      # Draw workflow (line/polygon/rectangle/label,
    │                              #   undo/redo, save/restore session)
    ├── MapPage.vertex.test.tsx    # Vertex editing (insert/remove/pick-up/
    │                              #   translate/label re-edit)
    ├── SettingsDialog.drag.test.tsx # Raster+vector drag-reorder parity
    ├── WandCleanupEditor.test.tsx # (components/) wand clean-up slider + stash
    ├── AttributeTable.test.tsx  # Attribute table window (sort, selection,
    │                            #   view modes, filter bar, CSV, cell edit)
    └── utils/
        ├── featureFilter.test.ts
        ├── layerHelpers.test.ts
        ├── shapefileWriter.test.ts
        ├── vectorExport.test.ts
        ├── contourExtract.test.ts
        ├── drawHelpers.test.ts
        ├── livewire.test.ts
        ├── samEngine.test.ts
        ├── boxSelection.test.ts
        ├── mapExport.test.ts
        ├── mapImageOverlays.test.ts
        ├── measurement.test.ts
        ├── rasterLayerFactory.test.ts
        ├── wmsFeatureInfo.test.ts
        ├── cogHelpers.test.ts       # COG header validation (truncated-header mode)
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
- When creating tile sources, always set `crossOrigin: 'anonymous'` to enable canvas export (image capture).

---

## 6. Adding a New Raster Layer Type

1. Add the type string to `RasterLayer['type']` union in `types.ts`.
2. Add any type-specific fields to `RasterLayer` (prefix them with the type name, e.g. `cogBucket`).
3. Add the add-layer form UI in `SettingsDialog.tsx` (new radio option in `newLayerType`, new form fields, validation, and the `onAdd*` callback).
4. Add the OL layer creation logic in `MapPage.tsx` inside the `addRasterLayer` / layer-rebuild switch.
5. If the type needs a utility module, create it in `utils/` (e.g. `cogHelpers.ts`). Keep it React-free.
6. Update the layer edit menu in `SettingsDialog.tsx` if the type has editable properties.
7. Handle cleanup on layer removal (IndexedDB blobs, event listeners).
8. Update the Known Sources type union in `types.ts` if the type should be saveable.

## 7. Adding a New Vector Layer Type

Same pattern as raster, but:
- Add to `VectorLayerConfig['type']` union.
- Vector layers share styling fields (`lineColor`, `fillColor`, etc.) — reuse them.
- File-based types go in the `FILE_VECTOR_TYPES` array in `types.ts`.
- Large geometry is stored in IndexedDB under a `geometryIdbKey`; small/drawn layers use inline `drawnGeoJson`.

---

## 8. Styling Conventions

- All CSS is in `mapviewer/src/App.css`. No inline `style={}` objects except for truly dynamic values (colours from user input, computed positions).
- Class naming: `componentName-element--modifier` (informal BEM). Examples: `.settings-layer-row`, `.draw-toolbar-btn--active`, `.context-menu-item`.
- The settings dialog is fixed at **480 px** width. The map fills the remaining viewport.
- Colours: the UI uses a light theme. Primary accent is `#4a90e2`. Destructive actions use `#e74c3c` / `#d64545` / `#c53030`.
- Icons are inline SVG React components in `Icons.tsx`. Add new icons there as named exports.

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

- Tests use **Jest** + **React Testing Library** (configured by CRA).
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
  - `drawHelpers.test.ts` — measurement-label gating in draw-feature styling, the visibility toggle, and draw-session persistence round-trips
  - `rasterLayerFactory.test.ts` — unified raster layer creation
  - `wmsFeatureInfo.test.ts` — WMS GetFeatureInfo parsing & extent-based requests
  - `cogHelpers.test.ts` — COG header validation (TIFF/BigTIFF magic, tiling tags, truncated-header mode for large files, non-COG size limit)
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
  - `SettingsDialog.drag.test.tsx` — raster/vector drag-reorder parity
  - `SettingsDialog.rasterEdit.test.tsx` — raster layer edit form
  - `SettingsDialog.attrRender.test.tsx` — attribute-driven render toggle (field picker, mode/stats live-apply, legend preview, commit/restore)
  - `WandCleanupEditor.test.tsx` — wand clean-up slider (in `components/`): stash restore & live simplification
  - `AttributeTable.test.tsx` — attribute-table window: header sort, checkbox/Ctrl/Shift
    selection gestures, view modes, map→table focus, filter bar, CSV export,
    cell edit write-through, close & layer switcher
  - `SplitScreen.test.tsx` — split-screen comparison UI
  - `MagneticDraw.test.tsx` — magnetic (livewire) draw-mode integration
  - `Workspace.url.test.tsx` — workspace URL param sync
- Run tests: `cd mapviewer && npm test` (watch mode) or `npx react-scripts test --watchAll=false` (CI).
- The `jest.transformIgnorePatterns` in `package.json` is configured to transpile ESM-only dependencies: `ol`, `rbush`, `quickselect`, `pbf`, `earcut`, `geotiff`, `lerc`, `quick-lru`, `@petamoriken`, `color-parse`, `color-rgba`, `color-space`, `color-name`. If you add a new ESM-only dependency, add it to that pattern.
- Prefer testing **utils/** functions (pure logic) for new logic. Component tests require mocking the OL map and browser APIs, which is complex — but they exist for the major UI flows and should be kept passing.
- When testing functions that use `crypto.subtle` (appLock, cogHelpers), note that jsdom does not provide it — mock or polyfill as needed.
- **Coverage report:** `CI=true npx react-scripts test --watchAll=false --coverage` writes HTML to `coverage/lcov-report/index.html` plus machine-readable `coverage/lcov.info`. As of 2026-08-05 (38 suites, 468 tests) overall line coverage is ~56%: the pure parsers/writers (`featureFilter`, `shapefileWriter`, `shapefileParser`, `vectorExport`, `boxSelection`, `mapImageOverlays`, `livewire`, `contourExtract`, `attributeTable`) and app-lock code are 80–100%, the extracted hooks are well covered (`useLayerDragReorder` ~90%, `useVertexEditing` ~84%, `useDrawSession` ~61%, `useMagneticDraw` ~63%), and `AttributeTableWindow` sits at ~66%; remaining gaps are MapPage init/popup/context-menu paths, `AdvancedSettingsDialog` (0%), the OL/DOM-heavy hooks `useBoxSelection` (~17%) and `useSamTools` (~30%), and OL/browser-coupled utils like `idb`/`tileHelpers`/`projectionHelper`/`rasterLayerFactory`/`samEngine`/`projectTransfer`. Add tests in those areas before refactoring them.

---

## 11. Build & Dev Commands

```bash
cd mapviewer

# Development server (hot reload, port 3000)
npm start

# Production build → mapviewer/build/
npm run build

# Run tests (watch mode)
npm test

# Run tests once (CI)
npx react-scripts test --watchAll=false

# Type-check without emitting
npx tsc --noEmit

# Test coverage report (HTML in coverage/lcov-report/)
CI=true npx react-scripts test --watchAll=false --coverage
```

---

## 12. Git Conventions

- Commit messages are short imperative summaries: `"COG as layer, from http, s3, local file source"`, `"fix refresh web password reset"`.
- No branch naming convention is enforced. Feature branches are merged via PR.
- The `sample/` directory is gitignored — do not commit sample data files.

---

## 13. Common Pitfalls & Gotchas

1. **MapPage.tsx is ~2 800 lines.** Search before adding. Many helpers already exist. Use `grep -n` to find the relevant section.
2. **OL layer lifecycle.** Layers are created in `MapPage` and passed up as config objects. Never create an OL layer inside `SettingsDialog` — it only handles UI forms and calls `onAdd*` / `onUpdate*` callbacks.
3. **CSS filter bleed.** Brightness/saturation/contrast on raster layers are applied via CSS filters on the OL layer's canvas element. A renderer patch in `layerHelpers.ts` (`patchLayerRenderer`) prevents the filter from bleeding to other layers. COG (WebGLTile) layers use a different path (`applyColorAdjustments` / `cogColorVariables`). If you add new visual effects, follow the same pattern.
4. **IndexedDB is async.** All IDB reads/writes return Promises. Layer rebuild (on workspace switch, import, etc.) is an `async` function — be careful with stale closures over state.
5. **COG layers need WebGL.** `ol/layer/WebGLTile` will throw on browsers without WebGL. The error is caught and surfaced as a toast.
6. **File-based COG layers stream — the bytes are never copied.** Only a small header slice (`COG_HEADER_VALIDATION_BYTES`, 2 MB) is read for validation; the OL GeoTIFF source then streams the rest via HTTP Range requests on a blob URL created directly from the `File` (so multi-GB files work without `NotReadableError` / OOM). The blob URL + `File` are kept in `cogFileRegistry.ts` for the document lifetime, and the layer *config* is persisted to workspace settings (with the blob URL stripped), so file COG layers **survive workspace switches** within a session. After a page reload the registry is empty and the layer cannot be restored — the user must re-add the file (a toast explains this on restore). Never read a local COG with `file.arrayBuffer()` or store its bytes in IndexedDB. HTTP and S3 COG sources persist normally.
7. **S3 pre-signed URLs expire.** The default TTL is 1 hour. If a COG S3 layer stops loading after sitting idle, the URL needs re-signing. The layer rebuild path calls `resolveS3CogUrl()` which re-signs automatically.
8. **proj4 definitions are global.** Once registered, a projection persists for the page lifetime. This is fine for a SPA but be aware in tests.
9. **The attribute filter parser** (`featureFilter.ts`) is a hand-written recursive-descent parser. It has its own test suite. If you extend the grammar, add tests for every new token/production.
10. **Shapefile writing** splits mixed-geometry layers into separate `.shp` files per geometry family (point, line, polygon). The writer is binary-level — be very careful with byte offsets and padding.
11. **App lock encrypts everything.** When adding new localStorage keys, make sure they are prefixed with `mapviewer` so they are picked up by `collectAppStorage()` / `restoreAppStorage()` in `appLock.ts`, or they will survive a lock/unlock cycle unencrypted.
12. **SAM tools are session-only; the models are not.** Nothing SAM-related persists in workspace settings, but whichever model payload loads does persist — in IndexedDB (SAM 2.1: `sam21:encoder:repaired:v1` / `sam21:decoder:v1`; SlimSAM: `slimsam77:encoder:v1` / `slimsam77:decoder:v1` keys of the `mapviewer` DB), so it never re-fetches on refresh. Candidate order (`SAM_MODEL_PRIORITY` in `samModels.ts`): SAM 2.1 Tiny, then SlimSAM-77; each is tried via its IDB cache, then its bundled static copy (`public/models/sam2.1/` — the repaired, If-node-folded export, see the README in that folder before touching those files — and `public/models/slimsam/`, whose fp32 files fit Cloudflare's 25 MiB static-asset limit). There is **no remote download any more**: Hugging Face no longer serves `resolve/main` with a permissive CORS header, and its zip contains the upstream encoder that ORT >= 1.2x rejects anyway. Every payload is validated by actually creating the inference sessions before it is accepted/cached, and the static loader rejects HTML impostors (`validateStaticPayload`) — Cloudflare's SPA fallback answers 200 + `text/html` for the excluded SAM 2.1 paths. The deploy config (`wrangler.jsonc`) excludes `models/sam2.1/**` because the ~104 MiB encoder exceeds the 25 MiB per-file asset limit; hosted visitors therefore run SlimSAM while local dev keeps SAM 2.1. The two exports use different tensor contracts (`SamModelKind`); `encode()`/`predict()` in `samEngine.ts` branch on `engine.kind`. The onnxruntime-web runtime itself loads from the jsDelivr CDN. WebGPU is strongly preferred, WASM fallback is slow. The SAM overlay layers carry `_isSamLayer` so `captureMapCanvas` excludes them from snapshots and `reorderLayers` keeps them above drawings.
13. **SAM snapshots need readable pixels.** `captureMapCanvas` composites layer canvases and reads them back — any tile layer served without CORS taints the canvas and blocks the AI tools (surfaced as a toast). The snapshot is tied to the exact view: any pan/zoom invalidates the encoder embedding (wand sessions cancel). The model-free magnetic edge guide (`useMagneticDraw`) is likewise view-tied — it re-extracts edges automatically after each pan/zoom.
14. **Never access the deployed site when checking or verifying issues.** Do not fetch, curl, or browse the production deployment (or any hosted URL) to reproduce, confirm, or validate a bug. The deployed site reflects whatever was last deployed — not the current working tree — and may be stale, cached, or masked by the Cloudflare SPA fallback (200 + `index.html` for arbitrary paths), so remote checks give misleading results. Verify locally instead: run the test suite (`npx react-scripts test --watchAll=false`), type-check (`npx tsc --noEmit`), and when a running app is required, build (`npm run build`) and serve the local build, or use the dev server (`npm start`), then hit `localhost` only.

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
- [ ] Existing tests pass (`npx react-scripts test --watchAll=false`)
- [ ] New pure-logic code has unit tests in `utils/`
- [ ] New persisted fields are added to `types.ts`, `workspaceStorage.ts`, and (if applicable) `appLock.ts` storage collection
- [ ] New layer types handle cleanup on removal (IDB blobs, OL layer disposal)
- [ ] CSS additions are in `App.css` with a section comment
- [ ] No OL objects leaked into serialisable config state
- [ ] Verification used local artifacts only (tests / type-check / local build or dev server); the deployed site was not accessed
- [ ] The README "Pending Features" table is updated if a feature is completed
