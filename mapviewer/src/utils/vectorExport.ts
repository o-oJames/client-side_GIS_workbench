/**
 * Shared download driver for vector data export.
 *
 * Both the Drawn Features panel and the vector-layer editor in the settings
 * dialog funnel through exportFeaturesToFile(), so every entry point offers
 * the same four formats: GeoJSON, KML, Shapefile (a zip with the full
 * .shp/.shx/.dbf/.prj set) and KMZ (a zipped KML).
 *
 * An optional target CRS (EPSG code) can be supplied to reproject features
 * from the map's native EPSG:3857 to any registered projection.
 */
import JSZip from 'jszip';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import { buildShapefileSets, GeoJsonLikeFeature, WGS84_PRJ } from './shapefileWriter';
import { registerProjectionFromEPSGCode } from './projectionHelper';
import proj4 from 'proj4';

import type { VectorExportFormat, ExportOptions } from '../types';
export type { VectorExportFormat, ExportOptions };

/** Menu-ready catalogue of the supported formats, in display order. */
export const VECTOR_EXPORT_FORMATS: ReadonlyArray<{
  id: VectorExportFormat;
  label: string;
  extension: string;
}> = [
  { id: 'geojson', label: 'GeoJSON', extension: '.geojson' },
  { id: 'kml', label: 'KML', extension: '.kml' },
  { id: 'shapefile', label: 'Shapefile', extension: '.zip' },
  { id: 'kmz', label: 'KMZ', extension: '.kmz' },
];

// Map data lives in Web Mercator; default export is reprojected to WGS84.
const DEFAULT_WRITE_OPTIONS = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' };

function sanitizeBaseName(name: string): string {
  const cleaned = (name || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'export';
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build the write options for the given target CRS.
 * When targetCrs is null/undefined or 'EPSG:4326', uses the default WGS84 output.
 * Otherwise ensures the projection is registered and returns options targeting it.
 */
async function resolveWriteOptions(targetCrs?: string | null): Promise<{ dataProjection: string; featureProjection: string }> {
  if (!targetCrs || targetCrs === 'EPSG:4326') {
    return DEFAULT_WRITE_OPTIONS;
  }
  // Ensure the projection is registered with proj4 + OL
  await registerProjectionFromEPSGCode(targetCrs);
  return { dataProjection: targetCrs, featureProjection: 'EPSG:3857' };
}

/**
 * Generate a minimal WKT string for the given EPSG code.
 * Uses proj4 definitions to extract basic projection info.
 * Falls back to a simple GEOGCS for geographic CRS or a minimal PROJCS.
 */
function generatePrjWkt(epsgCode: string): string {
  if (epsgCode === 'EPSG:4326') return WGS84_PRJ;

  // Try to get the proj4 definition object
  const def = proj4.defs(epsgCode);
  if (!def) {
    // Fallback: write a simple WKT with just the EPSG code
    return `GEOGCS["${epsgCode}",DATUM["Unknown",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","${epsgCode.replace('EPSG:', '')}"]]`;
  }

  // Use the proj4 definition object properties
  const projName = (def as any).projName || 'longlat';
  const ellpsName = (def as any).ellps || 'WGS84';
  const projStr = (def as any).projStr || '';

  // Map common ellipsoid names
  const ellpsMap: Record<string, [string, number, number]> = {
    'WGS84': ['WGS_1984', 6378137.0, 298.257223563],
    'GRS80': ['GRS_1980', 6378137.0, 298.257222101],
  };
  const [datumName, semiMajor, invFlat] = ellpsMap[ellpsName] || ['WGS_1984', 6378137.0, 298.257223563];

  if (projName === 'longlat' || projName === 'latlong') {
    return `GEOGCS["${epsgCode}",DATUM["D_${datumName}",SPHEROID["${datumName}",${semiMajor},${invFlat}]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433],AUTHORITY["EPSG","${epsgCode.replace('EPSG:', '')}"]]`;
  }

  // For projected CRS, generate a minimal PROJCS
  const south = projStr.includes('+south');

  return `PROJCS["${epsgCode}",GEOGCS["GCS_${datumName}",DATUM["D_${datumName}",SPHEROID["${datumName}",${semiMajor},${invFlat}]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",0],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",${south ? 10000000 : 0}],UNIT["Meter",1],AUTHORITY["EPSG","${epsgCode.replace('EPSG:', '')}"]]`;
}

function writeKml(features: Feature<Geometry>[], opts: { dataProjection: string; featureProjection: string }): string {
  return new KML({ extractStyles: false }).writeFeatures(features, opts);
}

// ---------------------------------------------------------------------------
// Geometry coercion helpers for export options
// ---------------------------------------------------------------------------

/**
 * Convert a single geometry to the requested target type.
 * Returns null when the conversion is not possible (e.g. Polygon → Point).
 */
function coerceGeometry(
  geom: Geometry | null,
  targetType: string,
  forceMulti: boolean,
  includeZ: boolean,
): Geometry | null {
  if (!geom) return null;

  // Strip or keep Z dimension
  let g = geom;
  if (!includeZ && (g as any).getLayout?.() === 'XYZ') {
    const coords = (g as any).getCoordinates();
    const Ctor = (g as any).constructor;
    try {
      g = new Ctor(coords);
    } catch {
      // Some geometry types need special handling; fall through with original
    }
  }

  if (targetType === 'auto') {
    if (forceMulti) return wrapInMulti(g);
    return g;
  }

  if (targetType === 'None') {
    return null;
  }

  if (targetType === 'GeometryCollection') {
    // Dynamic import to keep bundle size reasonable
    const GeometryCollection = require('ol/geom/GeometryCollection.js').default;
    return new GeometryCollection([g]);
  }

  // For Point / LineString / Polygon: try to extract a representative geometry
  const coerced = extractRepresentative(g, targetType);
  if (!coerced) return null;

  if (forceMulti) return wrapInMulti(coerced);
  return coerced;
}

/**
 * Extract a representative geometry of the requested type from any input.
 */
function extractRepresentative(geom: Geometry, targetType: string): Geometry | null {
  const typeName = geom.getType();
  if (typeName === targetType) return geom;

  const Point = require('ol/geom/Point.js').default;
  const LineString = require('ol/geom/LineString.js').default;
  const Polygon = require('ol/geom/Polygon.js').default;

  if (targetType === 'Point') {
    const coords = getFirstCoordinate(geom);
    if (!coords) return null;
    return new Point(coords.slice(0, 2));
  }

  if (targetType === 'LineString') {
    if (typeName === 'Polygon') {
      const ring = (geom as any).getLinearRing(0);
      return new LineString(ring.getCoordinates());
    }
    if (typeName === 'MultiLineString') {
      const coords = (geom as any).getLineString(0)?.getCoordinates();
      if (!coords) return null;
      return new LineString(coords);
    }
    if (typeName === 'MultiPoint') {
      const coords = (geom as any).getPoints().map((p: any) => p.getCoordinates());
      if (coords.length < 2) return null;
      return new LineString(coords);
    }
    return null;
  }

  if (targetType === 'Polygon') {
    if (typeName === 'LineString') {
      const coords = (geom as any).getCoordinates();
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push(first.slice());
      }
      return new Polygon([coords]);
    }
    if (typeName === 'MultiLineString') {
      const ring = (geom as any).getLineString(0)?.getCoordinates();
      if (!ring) return null;
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push(first.slice());
      }
      return new Polygon([ring]);
    }
    if (typeName === 'Point') {
      const c = (geom as any).getCoordinates();
      const s = 0.0001;
      return new Polygon([[
        [c[0] - s, c[1] - s],
        [c[0] + s, c[1] - s],
        [c[0] + s, c[1] + s],
        [c[0] - s, c[1] + s],
        [c[0] - s, c[1] - s],
      ]]);
    }
    return null;
  }

  return null;
}

function getFirstCoordinate(geom: Geometry): number[] | null {
  const typeName = geom.getType();
  if (typeName === 'Point') return (geom as any).getCoordinates();
  if (typeName === 'LineString') {
    const coords = (geom as any).getCoordinates();
    return coords.length > 0 ? coords[0] : null;
  }
  if (typeName === 'Polygon') {
    const ring = (geom as any).getLinearRing(0);
    const coords = ring?.getCoordinates();
    return coords?.length > 0 ? coords[0] : null;
  }
  if (typeName === 'MultiPoint') {
    const pts = (geom as any).getPoints();
    return pts.length > 0 ? pts[0].getCoordinates() : null;
  }
  if (typeName === 'MultiLineString') {
    const line = (geom as any).getLineString(0);
    const coords = line?.getCoordinates();
    return coords?.length > 0 ? coords[0] : null;
  }
  if (typeName === 'MultiPolygon') {
    const poly = (geom as any).getPolygon(0);
    const ring = poly?.getLinearRing(0);
    const coords = ring?.getCoordinates();
    return coords?.length > 0 ? coords[0] : null;
  }
  return null;
}

function wrapInMulti(geom: Geometry): Geometry {
  const typeName = geom.getType();
  const MultiPoint = require('ol/geom/MultiPoint.js').default;
  const MultiLineString = require('ol/geom/MultiLineString.js').default;
  const MultiPolygon = require('ol/geom/MultiPolygon.js').default;

  if (typeName === 'Point') return new MultiPoint([(geom as any).getCoordinates()]);
  if (typeName === 'LineString') return new MultiLineString([(geom as any).getCoordinates()]);
  if (typeName === 'Polygon') return new MultiPolygon([(geom as any).getCoordinates()]);
  // Already a multi type or GeometryCollection — return as-is
  return geom;
}

/**
 * Apply export options to a list of features, returning new features with
 * coerced geometries. Features whose geometry becomes null are kept with
 * null geometry (useful for attribute-only export).
 */
function applyExportOptions(
  features: Feature<Geometry>[],
  opts: ExportOptions | undefined,
): Feature<Geometry>[] {
  if (!opts) return features;
  const { geometryType, forceMulti, includeZ } = opts;
  if (geometryType === 'auto' && !forceMulti && includeZ) return features;

  return features.map((feature) => {
    const geom = feature.getGeometry();
    const newGeom = coerceGeometry(geom ?? null, geometryType, forceMulti, includeZ);
    const clone = feature.clone();
    if (newGeom === null) {
      clone.setGeometry(null as any);
    } else {
      clone.setGeometry(newGeom);
    }
    return clone;
  });
}

/** Recursively flatten nested coordinate arrays into [x, y] pairs. */
function flattenCoords(coords: any): number[][] {
  if (typeof coords[0] === 'number') {
    return [coords.slice(0, 2)];
  }
  const result: number[][] = [];
  for (const c of coords) {
    result.push(...flattenCoords(c));
  }
  return result;
}

/**
 * Serialises the features in the requested format and starts a browser
 * download. Throws when there is nothing exportable for the format.
 *
 * @param targetCrs Optional EPSG code (e.g. "EPSG:4326", "EPSG:32655") to
 *   reproject features into before writing. Defaults to EPSG:4326 (WGS 84).
 * @param exportOpts Optional geometry / GeoJSON layer options from the export popup.
 */
export async function exportFeaturesToFile(
  features: Feature<Geometry>[],
  baseName: string,
  format: VectorExportFormat,
  targetCrs?: string | null,
  exportOpts?: ExportOptions,
): Promise<void> {
  const safeName = sanitizeBaseName(baseName);
  const writeOpts = await resolveWriteOptions(targetCrs);
  const isCustomCrs = writeOpts.dataProjection !== 'EPSG:4326';
  const prjWkt = isCustomCrs ? generatePrjWkt(writeOpts.dataProjection) : WGS84_PRJ;

  // Apply geometry coercion / multi-wrap / z-dimension options
  const processedFeatures = applyExportOptions(features, exportOpts);

  if (format === 'geojson') {
    // Build GeoJSON write options with layer-level metadata
    const geoJsonWriteOpts: any = { ...writeOpts };
    if (exportOpts) {
      if (exportOpts.coordinatePrecision !== undefined && exportOpts.coordinatePrecision !== 15) {
        geoJsonWriteOpts.decimals = exportOpts.coordinatePrecision;
      }
      if (exportOpts.rfc7946) {
        geoJsonWriteOpts.rightHanded = false;
      }
    }
    const content = new GeoJSON().writeFeatures(processedFeatures, geoJsonWriteOpts);
    // Post-process: add bbox if requested
    let finalContent = content;
    if (exportOpts?.writeBbox) {
      try {
        const parsed = JSON.parse(content);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const f of parsed.features || []) {
          if (f.geometry && f.geometry.coordinates) {
            const flat = flattenCoords(f.geometry.coordinates);
            for (const [x, y] of flat) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (minX !== Infinity) {
          parsed.bbox = [minX, minY, maxX, maxY];
        }
        finalContent = JSON.stringify(parsed);
      } catch {
        // If parsing fails, use original content
      }
    }
    triggerDownload(new Blob([finalContent], { type: 'application/geo+json' }), safeName + '.geojson');
    return;
  }

  if (format === 'kml') {
    triggerDownload(
      new Blob([writeKml(processedFeatures, writeOpts)], { type: 'application/vnd.google-earth.kml+xml' }),
      safeName + '.kml',
    );
    return;
  }

  if (format === 'kmz') {
    const zip = new JSZip();
    zip.file('doc.kml', writeKml(processedFeatures, writeOpts));
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      mimeType: 'application/vnd.google-earth.kmz',
    });
    triggerDownload(blob, safeName + '.kmz');
    return;
  }

  // Shapefile: zip up one full .shp/.shx/.dbf/.prj set per geometry family.
  const collection = new GeoJSON().writeFeaturesObject(processedFeatures, writeOpts) as unknown as {
    features?: GeoJsonLikeFeature[];
  };
  const sets = buildShapefileSets(collection.features || [], safeName, prjWkt);
  if (sets.length === 0) {
    throw new Error('No exportable geometries for a shapefile (needs points, lines or polygons).');
  }
  const zip = new JSZip();
  for (const set of sets) {
    zip.file(set.baseName + '.shp', set.files.shp);
    zip.file(set.baseName + '.shx', set.files.shx);
    zip.file(set.baseName + '.dbf', set.files.dbf);
    zip.file(set.baseName + '.prj', set.files.prj);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/zip' });
  triggerDownload(blob, safeName + '.zip');
}
