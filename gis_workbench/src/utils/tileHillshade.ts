// ---------------------------------------------------------------------------
// tileHillshade — terrain relief shading for XYZ/WMTS/WMS tile layers.
//
// Unlike COG hillshade (which runs as a WebGL expression over the GeoTIFF
// source's raw band values), tile layers serve pre-rendered images. We use
// OpenLayers' RasterSource with an `operation` to:
//   1. read the tile's RGB pixels,
//   2. decode them into elevations (terrarium/mapbox/grayscale encoding),
//   3. compute Horn's 3×3 gradient for hillshade,
//   4. output the shaded intensity as grayscale RGBA.
//
// The operation function is created fresh each time parameters change, with
// the encoding baked in as constants — this avoids the worker serialization
// problem (closures don't survive structured clone).
// ---------------------------------------------------------------------------
import RasterSource from 'ol/source/Raster.js';
import ImageLayer from 'ol/layer/Image.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import type { TileRenderConfig } from '../types';
import { DEFAULT_HILLSHADE } from './cogBands';

/**
 * Build a hillshade operation function with parameters baked in.
 *
 * The returned function is self-contained (no closure over external state),
 * so it survives the structured-clone serialization RasterSource uses to
 * ship it to the worker thread.
 */
function buildHillshadeOperation(
  altitude: number,
  azimuth: number,
  zFactor: number,
  encoding: number, // 0=terrarium, 1=mapbox, 2=grayscale
  gMin: number,
  gMax: number,
  multiDir: boolean,
): (images: ImageData[]) => ImageData {
  // We generate the function as a string with parameters inlined, then eval it.
  // This is the standard pattern for OL RasterSource operations that need
  // parameters — the function body is serialized to the worker, and closures
  // don't survive that trip.
  const fnBody = `
    return function hillshadeOp(images) {
      // With operationType: 'image', OL passes an array of ImageData (one per source)
      var imageData = images[0];
      var width = imageData.width;
      var height = imageData.height;
      var input = imageData.data;
      var output = new Uint8ClampedArray(input.length);
      var ALT = ${altitude};
      var AZ = ${azimuth};
      var ZF = ${zFactor};
      var ENC = ${encoding};
      var GMIN = ${gMin};
      var GMAX = ${gMax};
      var MULTI = ${multiDir};
      var PI = Math.PI;

      function decode(idx) {
        var r = input[idx], g = input[idx + 1], b = input[idx + 2];
        if (ENC === 0) return r * 256 + g + b / 256 - 32768;
        if (ENC === 1) return (r * 65536 + g * 256 + b) * 0.1 - 10000;
        return GMIN + (r / 255) * (GMAX - GMIN);
      }

      function shade(dzdx, dzdy, azimuth) {
        var zenith = (90 - ALT) * PI / 180;
        var azRad = azimuth * PI / 180;
        var slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        var aspect = Math.atan2(dzdy, -dzdx);
        return Math.cos(zenith) * Math.cos(slope)
          + Math.sin(zenith) * Math.sin(slope) * Math.cos(azRad - aspect);
      }

      // Build elevation grid
      var elev = new Float32Array(width * height);
      for (var i = 0; i < width * height; i++) {
        elev[i] = decode(i * 4) * ZF;
      }

      // Compute hillshade with Horn's 3x3 gradient
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          var x0 = Math.max(0, x - 1);
          var x1 = Math.min(width - 1, x + 1);
          var y0 = Math.max(0, y - 1);
          var y1 = Math.min(height - 1, y + 1);

          var a = elev[y0 * width + x0];
          var b2 = elev[y0 * width + x];
          var c = elev[y0 * width + x1];
          var d = elev[y * width + x0];
          var f = elev[y * width + x1];
          var g = elev[y1 * width + x0];
          var h = elev[y1 * width + x];
          var iv = elev[y1 * width + x1];

          var dzdx = ((c + 2 * f + iv) - (a + 2 * d + g)) / 8;
          var dzdy = ((g + 2 * h + iv) - (a + 2 * b2 + c)) / 8;

          var s;
          if (MULTI) {
            s = (shade(dzdx, dzdy, 225) + shade(dzdx, dzdy, 270)
               + shade(dzdx, dzdy, 315) + shade(dzdx, dzdy, 360)) / 4;
          } else {
            s = shade(dzdx, dzdy, AZ);
          }

          var value = Math.max(0, Math.min(255, Math.round(s * 255)));
          var outIdx = (y * width + x) * 4;
          output[outIdx] = value;
          output[outIdx + 1] = value;
          output[outIdx + 2] = value;
          output[outIdx + 3] = 255;
        }
      }

      return new ImageData(output, width, height);
    };
  `;
  
  // eslint-disable-next-line no-new-func
  return new Function(fnBody)() as (images: ImageData[]) => ImageData;
}

/**
 * Create a hillshade TileLayer from an existing tile source.
 *
 * Wraps the source in a RasterSource that applies the hillshade operation
 * to each tile image. Returns a new TileLayer with the processed output.
 */
export function createTileHillshadeLayer(
  originalSource: any,
  render: TileRenderConfig,
): ImageLayer<any> {
  const hs = render.hillshade ?? {};
  const altitude = hs.altitude ?? DEFAULT_HILLSHADE.altitude;
  const azimuth = hs.azimuth ?? DEFAULT_HILLSHADE.azimuth;
  const zFactor = hs.zFactor ?? DEFAULT_HILLSHADE.zFactor;
  const multiDir = hs.multidirectional ?? false;
  
  const encodingCode = render.encoding === 'mapbox' ? 1 : render.encoding === 'grayscale' ? 2 : 0;
  const gMin = render.grayscaleRange?.min ?? 0;
  const gMax = render.grayscaleRange?.max ?? 255;

  const operation = buildHillshadeOperation(
    altitude, azimuth, zFactor, encodingCode, gMin, gMax, multiDir,
  );

  const hillshadeSource = new RasterSource({
    sources: [originalSource],
    operationType: 'image',
    operation: operation as any,
  });

  const layer = new ImageLayer({ source: hillshadeSource });
  return layer;
}

/**
 * Update an existing hillshade layer's parameters.
 *
 * Since the operation function has parameters baked in, we need to create
 * a new RasterSource with the updated operation. The caller should replace
 * the layer's source with the returned one.
 */
export function updateTileHillshadeSource(
  originalSource: any,
  render: TileRenderConfig,
): RasterSource {
  const hs = render.hillshade ?? {};
  const altitude = hs.altitude ?? DEFAULT_HILLSHADE.altitude;
  const azimuth = hs.azimuth ?? DEFAULT_HILLSHADE.azimuth;
  const zFactor = hs.zFactor ?? DEFAULT_HILLSHADE.zFactor;
  const multiDir = hs.multidirectional ?? false;
  
  const encodingCode = render.encoding === 'mapbox' ? 1 : render.encoding === 'grayscale' ? 2 : 0;
  const gMin = render.grayscaleRange?.min ?? 0;
  const gMax = render.grayscaleRange?.max ?? 255;

  const operation = buildHillshadeOperation(
    altitude, azimuth, zFactor, encodingCode, gMin, gMax, multiDir,
  );

  return new RasterSource({
    sources: [originalSource],
    operationType: 'image',
    operation: operation as any,
  });
}
