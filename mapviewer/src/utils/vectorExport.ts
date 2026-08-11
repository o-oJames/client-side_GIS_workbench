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

import type { VectorExportFormat } from '../types';
export type { VectorExportFormat };

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

/**
 * Serialises the features in the requested format and starts a browser
 * download. Throws when there is nothing exportable for the format.
 *
 * @param targetCrs Optional EPSG code (e.g. "EPSG:4326", "EPSG:32655") to
 *   reproject features into before writing. Defaults to EPSG:4326 (WGS 84).
 */
export async function exportFeaturesToFile(
  features: Feature<Geometry>[],
  baseName: string,
  format: VectorExportFormat,
  targetCrs?: string | null
): Promise<void> {
  const safeName = sanitizeBaseName(baseName);
  const writeOpts = await resolveWriteOptions(targetCrs);
  const isCustomCrs = writeOpts.dataProjection !== 'EPSG:4326';
  const prjWkt = isCustomCrs ? generatePrjWkt(writeOpts.dataProjection) : WGS84_PRJ;

  if (format === 'geojson') {
    const content = new GeoJSON().writeFeatures(features, writeOpts);
    triggerDownload(new Blob([content], { type: 'application/geo+json' }), safeName + '.geojson');
    return;
  }

  if (format === 'kml') {
    triggerDownload(
      new Blob([writeKml(features, writeOpts)], { type: 'application/vnd.google-earth.kml+xml' }),
      safeName + '.kml'
    );
    return;
  }

  if (format === 'kmz') {
    const zip = new JSZip();
    zip.file('doc.kml', writeKml(features, writeOpts));
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      mimeType: 'application/vnd.google-earth.kmz',
    });
    triggerDownload(blob, safeName + '.kmz');
    return;
  }

  // Shapefile: zip up one full .shp/.shx/.dbf/.prj set per geometry family.
  const collection = new GeoJSON().writeFeaturesObject(features, writeOpts) as unknown as {
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
