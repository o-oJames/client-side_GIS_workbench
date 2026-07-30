/**
 * Shared download driver for vector data export.
 *
 * Both the Drawn Features panel and the vector-layer editor in the settings
 * dialog funnel through exportFeaturesToFile(), so every entry point offers
 * the same four formats: GeoJSON, KML, Shapefile (a zip with the full
 * .shp/.shx/.dbf/.prj set) and KMZ (a zipped KML).
 */
import JSZip from 'jszip';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import { buildShapefileSets, GeoJsonLikeFeature } from './shapefileWriter';

export type VectorExportFormat = 'geojson' | 'kml' | 'shapefile' | 'kmz';

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

// Map data lives in Web Mercator; every export is reprojected to WGS84.
const WRITE_OPTIONS = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' };

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

function writeKml(features: Feature<Geometry>[]): string {
  return new KML({ extractStyles: false }).writeFeatures(features, WRITE_OPTIONS);
}

/**
 * Serialises the features in the requested format and starts a browser
 * download. Throws when there is nothing exportable for the format.
 */
export async function exportFeaturesToFile(
  features: Feature<Geometry>[],
  baseName: string,
  format: VectorExportFormat
): Promise<void> {
  const safeName = sanitizeBaseName(baseName);

  if (format === 'geojson') {
    const content = new GeoJSON().writeFeatures(features, WRITE_OPTIONS);
    triggerDownload(new Blob([content], { type: 'application/geo+json' }), safeName + '.geojson');
    return;
  }

  if (format === 'kml') {
    triggerDownload(
      new Blob([writeKml(features)], { type: 'application/vnd.google-earth.kml+xml' }),
      safeName + '.kml'
    );
    return;
  }

  if (format === 'kmz') {
    // A KMZ is just a zip archive holding the KML document.
    const zip = new JSZip();
    zip.file('doc.kml', writeKml(features));
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      mimeType: 'application/vnd.google-earth.kmz',
    });
    triggerDownload(blob, safeName + '.kmz');
    return;
  }

  // Shapefile: zip up one full .shp/.shx/.dbf/.prj set per geometry family.
  const collection = new GeoJSON().writeFeaturesObject(features, WRITE_OPTIONS) as unknown as {
    features?: GeoJsonLikeFeature[];
  };
  const sets = buildShapefileSets(collection.features || [], safeName);
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
