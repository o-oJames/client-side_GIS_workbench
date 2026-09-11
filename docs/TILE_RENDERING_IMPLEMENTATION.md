# Tile Layer Terrain Rendering Implementation

## Overview

Extended the COG (Cloud Optimized GeoTIFF) terrain rendering capabilities to XYZ/WMTS/WMS tile layers. Users can now display contour lines and hillshade from tile services that encode elevation data in their RGB channels, such as AWS's terrarium tiles.

## Example Usage

Add the XYZ service: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

Then in the layer editor, select:
- **Hillshade** renderer to display terrain relief shading
- **Contours** renderer to display elevation isolines

## Architecture

### New Files

1. **`utils/tileElevation.ts`** - Reads elevation data from tile images
   - Fetches tiles covering the view extent
   - Decodes RGB pixels into elevation values using the selected encoding
   - Composites into a single elevation grid
   - Supports three encodings:
     - `terrarium`: R*256 + G + B/256 - 32768 (AWS terrain tiles)
     - `mapbox`: (R*256² + G*256 + B) * 0.1 - 10000 (Mapbox Terrain-RGB)
     - `grayscale`: single band mapped to a user-defined range

2. **`utils/tileHillshade.ts`** - Terrain relief shading for tile layers
   - Wraps the tile source in a RasterSource
   - Applies Horn's 3×3 gradient operation per-pixel
   - Supports QGIS-style sun position (altitude/azimuth)
   - Multidirectional shading (blends 4 light directions)
   - Z-factor for vertical exaggeration

3. **`hooks/useTileContours.ts`** - Companion vector overlay for contour lines
   - Mirrors `useCogContours` architecture
   - Creates one overlay per tile layer in contour mode
   - Re-traces when the view settles (debounced)
   - Hides the raster underneath (like QGIS)
   - Symbol-only edits restyle without re-reading tiles

4. **`components/TileRenderControl.tsx`** - UI for tile terrain rendering
   - Renderer mode selector (default/hillshade/contour)
   - Tile encoding selector
   - Hillshade parameters (altitude, azimuth, Z-factor, multidirectional)
   - Contour parameters (interval, index interval, line styles, colors, labels)
   - Downscaling and oversampling controls

### Modified Files

1. **`types.ts`**
   - Added `TileElevationEncoding` type
   - Added `TileRenderConfig` interface
   - Added `tileRender?: TileRenderConfig` to `RasterLayer`
   - Added `onApplyTileRender` to `SettingsDialogProps`

2. **`components/RasterLayerEditForm.tsx`**
   - Integrated `TileRenderControl` for non-COG layers
   - Added state management for tile render config
   - Added `onApplyTileRender` prop and handler
   - Persists tile render config with the layer

3. **`components/SettingsDialog.tsx`**
   - Passes `onApplyTileRender` through to `RasterLayerEditForm`

4. **`components/MapPage.tsx`**
   - Integrated `useTileContours` hook
   - Added `handleApplyTileRender` handler
   - Attaches/disposes tile contours with the map
   - Passes handler to SettingsDialog

5. **`utils/rasterLayerFactory.ts`**
   - Wraps tile sources in RasterSource for hillshade mode
   - Handles both XYZ and WMTS layers

## How It Works

### Contour Lines

1. User selects "Contours" renderer in the layer editor
2. `useTileContours` hook creates a companion vector overlay
3. On view change (debounced), the hook:
   - Fetches tiles covering the buffered view extent
   - Decodes RGB pixels into elevations using the selected encoding
   - Builds an elevation grid
   - Traces contour lines using marching squares (reuses `utils/contourExtract.ts`)
   - Renders lines as vector features with QGIS-style symbols
4. The raster layer is hidden underneath (like QGIS)
5. Symbol-only edits (color, width, labels) restyle without re-reading tiles

### Hillshade

1. User selects "Hillshade" renderer in the layer editor
2. `rasterLayerFactory` wraps the tile source in a RasterSource
3. The RasterSource applies a per-pixel operation that:
   - Decodes RGB pixels into elevations
   - Computes Horn's 3×3 gradient
   - Calculates shade from sun position
   - Outputs grayscale intensity
4. The operation runs in a web worker for performance
5. Parameters are baked into the operation function (no closure serialization issues)

## Tile Encoding

The terrarium format encodes a single elevation band across the RGB channels of a PNG tile:

```
elevation = R * 256 + G + B / 256 - 32768  (metres)
```

This is not multiple bands - it's one band (elevation) packed into RGB for storage efficiency. The decoder combines the channels to recover the elevation value.

## Limitations

- **CORS**: Tile servers must allow cross-origin requests for elevation data to be readable
- **Performance**: Contour tracing fetches and decodes tiles on every view change (debounced)
- **Resolution**: Contour quality depends on tile resolution and downscaling factor
- **Encoding**: Only terrarium, mapbox, and grayscale encodings are supported

## Testing

To test with the AWS terrarium tiles:

1. Add XYZ layer: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
2. Open layer editor
3. Expand "Terrain renderer" panel
4. Select "Contours" or "Hillshade"
5. Verify encoding is set to "Terrarium (AWS terrain)"
6. Adjust parameters as needed

## Future Enhancements

- Support for additional tile encodings
- Caching decoded elevation grids to reduce redundant tile fetches
- GPU-accelerated contour tracing (WebGL compute shaders)
- Integration with other terrain analysis tools (slope, aspect, etc.)
