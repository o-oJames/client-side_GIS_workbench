# Elevation Profile — implementation notes

The **Elevation Profile** window reads the terrain under a line the user pens on
the map and charts it: ground distance on x, elevation on y. It is offered from
the right-click menu of any raster layer whose renderer is a terrain one — a COG
shown as **Hillshade** or **Contours**, or an XYZ/WMTS tile layer whose RGB
channels encode elevation — because those are exactly the layers that already
read elevations.

## Where the code lives

| File | Responsibility |
|------|----------------|
| `src/utils/elevationProfile.ts` | All of the maths, framework-free: renderer detection, the sampling plan, nodata-tolerant bilinear grid reads, ground-distance densification, statistics, SVG chart geometry, the saved line's attribute record, window-geometry persistence, and the two grid readers |
| `src/hooks/useElevationProfile.ts` | The map side: the dashed profile-line layer, the OL `Draw` interaction behind the Pen button, sampling runs (abortable, superseded reads dropped), the record list, the chart-hover marker |
| `src/components/ElevationProfilePanel.tsx` | The window: chrome, Pen button, chart, stats, tabs, save row, status bar |
| `src/components/SettingsDialog.tsx` | The layer menu entry (`onShowElevationProfile`), gated on `terrainRendererOf` |
| `src/components/MapPage.tsx` | Which layer's window is open (`elevationProfileLayerId`, persisted per workspace), the save-to-layer handler, closing the window when its layer goes away or stops rendering terrain |

## Decisions worth knowing

**One coordinate space.** A drawn line arrives in the view projection (OL never
reprojects vector layers), so each record keeps both: `coords` for the map
feature and `mercator` for everything measured — sampling, distances, the saved
layer — which are all defined in EPSG:3857. Distances are spherical ground
metres through `utils/geodesic`, never planar Mercator units; the reported grid
cell size is the planar cell scaled by cos(latitude) so it agrees with them.

**The readers are the renderers' readers.** Tile layers go through
`readTileElevationGrid` (`utils/tileElevation.ts`) — the same PNG-bytes decoder
the contours and hillshade use, so no sRGB gamma corruption — at the tile zoom
the map is at, over the line's padded extent. COGs go through
`readCogElevationGridDetailed` (`utils/cogContours.ts`) on the renderer's band,
with input-downscaling/oversampling forced to 1: a profile wants the grid it
planned, not QGIS' contour-tracing aesthetic. A profile therefore always agrees
with the terrain on screen, and a layer whose tiles cannot be sampled at all
(WMS KVP, WMTS RESTful templates — no `{z}/{x}/{y}`) is refused with a plain
sentence instead of a silent empty chart.

**Hillshade wraps its source.** In hillshade mode the tile layer is rebuilt over
an `ol/source/Raster`, whose `getSource()` has no tile grid. `createTileHillshadeLayer`
stashes the source it wrapped on the layer (`_terrainTileSource`), and
`terrainTileSource()` falls back to walking a wrapper's inner layers, so the
profile reads the real tiles either way.

**Nodata is reported, never invented.** `sampleGridBilinear` renormalises over
the finite neighbours of a cell, so one nodata pixel narrows the interpolation
instead of punching a hole; a run of nodata splits the chart's line (the area
closes per run) and is counted in `missingCount` / `longestGap`. Cumulative
ascent/descent counts the step *across* a gap once — the difference of its two
ends, a lower bound on what happened in between — rather than dropping it (which
would under-report) or filling it (which would invent terrain).

**Saving keeps the chart's data.** *Save to layer* writes the drawn vertices as
an ordinary GeoJSON `LineString` feature; its attributes carry the summary
(`profile_length_m`, `profile_min_elev_m`, `profile_max_elev_m`,
`profile_ascent_m`, `profile_descent_m`, `profile_max_grade_pct`,
`profile_samples`, `profile_source_layer`, `profile_renderer`) and every sample
in `profile_points` (`distance`, `elevation`, `lon`, `lat`, nodata as `null`), so
the attribute table shows exactly what the chart was built from and a re-plot
needs nothing else. The layer persists like every other `geojson` layer (the
workspace save moves its geometry to IndexedDB).

**Window behaviour** follows the attribute table and Vector Tools windows:
title-bar drag, eight resize handles, close top-right, geometry remembered in
`mapviewer-elev-profile-geometry`, open layer remembered per workspace in
`StoredSettings.elevationProfileLayerId`. The Pen stays armed after a line so
several lines can be drawn in a row; each becomes a tab, and the active one is
the charted/highlighted line.

## Verification

- `utils/elevationProfile.test.ts` — synthetic grids for the plan → points →
  stats → chart → attributes maths, plus the COG reader end to end against a
  faked geotiff.js level (band selection included) and the tile reader through a
  mocked `readTileElevationGrid` asserting exactly what the profile asks for.
- `ElevationProfilePanel.test.tsx` — the window with a stub map: the Pen arms a
  real OL `Draw` and the test dispatches `drawstart`/`drawend` on it, so chart,
  stats, tabs, crosshair, save and gestures run the production path.
- `SettingsDialog.elevationProfile.test.tsx` — the menu entry's gating.
- A browser harness (not committed) served the production build alongside a
  synthetic **terrarium** tile service whose DEM is a known tilted plane
  (`elev = 500 + 0.02·dx + 0.01·dy` metres in EPSG:3857). Drawing a line and
  saving it confirmed the stored `profile_points` match the encoded DEM at their
  own positions to within 0.232 m over 240 samples, in both themes, with the
  contour renderer switched on afterwards.
