import JSZip from 'jszip';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import { exportFeaturesToFile, VECTOR_EXPORT_FORMATS } from './vectorExport';
import { parseShapefile } from './shapefileParser';

// Capture what would have been downloaded instead of hitting the DOM.
let lastBlob: Blob | null = null;
let lastFilename = '';

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

// Plain prototype assignments (not jest.spyOn): CRA's jest config resets
// spies before every test, which would silently drop the implementations.
beforeEach(() => {
  lastBlob = null;
  lastFilename = '';
  (URL as any).createObjectURL = (blob: Blob) => { lastBlob = blob; return 'blob:mock'; };
  (URL as any).revokeObjectURL = () => undefined;
  (HTMLAnchorElement.prototype as any).click = function (this: HTMLAnchorElement) {
    lastFilename = this.download;
  };
});

function makeFeatures() {
  const pt = new Feature({ geometry: new Point(fromLonLat([138.6, -34.93])) });
  pt.set('labelText', 'Adelaide');
  const line = new Feature({
    geometry: new LineString([fromLonLat([138.5, -34.9]), fromLonLat([138.7, -35.0])]),
  });
  const poly = new Feature({
    geometry: new Polygon([[
      fromLonLat([138.5, -34.9]),
      fromLonLat([138.5, -35.0]),
      fromLonLat([138.7, -35.0]),
      fromLonLat([138.7, -34.9]),
      fromLonLat([138.5, -34.9]),
    ]]),
  });
  return [pt, line, poly];
}

describe('exportFeaturesToFile', () => {
  it('offers the four formats in menu order', () => {
    expect(VECTOR_EXPORT_FORMATS.map((f) => f.id)).toEqual(['geojson', 'kml', 'shapefile', 'kmz']);
  });

  it('downloads WGS84 GeoJSON', async () => {
    await exportFeaturesToFile(makeFeatures(), 'My Layer', 'geojson');
    expect(lastFilename).toBe('My_Layer.geojson');
    const text = await blobText(lastBlob!);
    const gj = JSON.parse(text);
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features).toHaveLength(3);
    expect(gj.features[0].geometry.coordinates[0]).toBeCloseTo(138.6, 5);
    expect(gj.features[0].geometry.coordinates[1]).toBeCloseTo(-34.93, 5);
  });

  it('downloads KML', async () => {
    await exportFeaturesToFile(makeFeatures(), 'layer', 'kml');
    expect(lastFilename).toBe('layer.kml');
    const text = await blobText(lastBlob!);
    expect(text).toContain('<kml');
    expect(text).toContain('Placemark');
  });

  it('downloads KMZ as a zip holding doc.kml', async () => {
    await exportFeaturesToFile(makeFeatures(), 'layer', 'kmz');
    expect(lastFilename).toBe('layer.kmz');
    const zip = await JSZip.loadAsync(lastBlob!);
    const entry = zip.file('doc.kml');
    expect(entry).not.toBeNull();
    const kml = await entry!.async('text');
    expect(kml).toContain('<kml');
    expect(kml).toContain('Placemark');
  });

  it('downloads a shapefile zip with a complete per-family set', async () => {
    await exportFeaturesToFile(makeFeatures(), 'layer', 'shapefile');
    expect(lastFilename).toBe('layer.zip');
    const zip = await JSZip.loadAsync(lastBlob!);
    const names = Object.keys(zip.files).sort();
    // Mixed point/line/polygon input splits into three suffixed sets.
    expect(names).toEqual([
      'layer_line.dbf', 'layer_line.prj', 'layer_line.shp', 'layer_line.shx',
      'layer_point.dbf', 'layer_point.prj', 'layer_point.shp', 'layer_point.shx',
      'layer_polygon.dbf', 'layer_polygon.prj', 'layer_polygon.shp', 'layer_polygon.shx',
    ]);

    // The point set round-trips through this app's own shapefile reader,
    // attributes included.
    const shp = await zip.file('layer_point.shp')!.async('arraybuffer');
    const shx = await zip.file('layer_point.shx')!.async('arraybuffer');
    const dbf = await zip.file('layer_point.dbf')!.async('arraybuffer');
    const prj = await zip.file('layer_point.prj')!.async('text');
    const rezipped = new JSZip();
    rezipped.file('layer_point.shp', shp);
    rezipped.file('layer_point.shx', shx);
    rezipped.file('layer_point.dbf', dbf);
    rezipped.file('layer_point.prj', prj);
    const buf = await rezipped.generateAsync({ type: 'arraybuffer' });
    const result = await parseShapefile(new File([buf], 'layer_point.zip'));
    expect(result.features).toHaveLength(1);
    expect(result.features[0].geometry.type).toBe('Point');
    expect(result.features[0].geometry.coordinates[0]).toBeCloseTo(138.6, 5);
    expect(result.features[0].properties.NAME).toBe('Adelaide');
  });

  it('rejects a shapefile export with no exportable geometry', async () => {
    await expect(exportFeaturesToFile([new Feature()], 'empty', 'shapefile'))
      .rejects.toThrow(/No exportable geometries/);
  });
});
