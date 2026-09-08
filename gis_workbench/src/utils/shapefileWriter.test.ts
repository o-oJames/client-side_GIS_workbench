import JSZip from 'jszip';
import { buildShapefileSets, WGS84_PRJ, ShapefileSet } from './shapefileWriter';
import { parseShapefile } from './shapefileParser';

/** Zip one set the way vectorExport.ts does and feed it back to the parser. */
async function roundTrip(set: ShapefileSet) {
  const zip = new JSZip();
  zip.file(set.baseName + '.shp', set.files.shp);
  zip.file(set.baseName + '.shx', set.files.shx);
  zip.file(set.baseName + '.dbf', set.files.dbf);
  zip.file(set.baseName + '.prj', set.files.prj);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  return parseShapefile(new File([buffer], set.baseName + '.zip'));
}

function feature(geometry: any, properties: Record<string, any> = {}) {
  return { type: 'Feature', geometry, properties };
}

const point = feature({ type: 'Point', coordinates: [138.6, -34.93] }, { labelText: 'Adelaide' });
const line = feature(
  { type: 'LineString', coordinates: [[138.5, -34.9], [138.6, -35.0], [138.7, -34.95]] },
  { name: 'route' }
);
const multiLine = feature({
  type: 'MultiLineString',
  coordinates: [
    [[139.0, -35.0], [139.1, -35.1]],
    [[139.2, -35.2], [139.3, -35.3], [139.4, -35.4]],
  ],
});
// Outer ring is digitised counter-clockwise with a clockwise hole — the
// writer must flip both to match the shapefile winding rules.
const polygonWithHole = feature({
  type: 'Polygon',
  coordinates: [
    [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], // CCW shell
    [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],     // CW hole
  ],
});
const multiPolygon = feature({
  type: 'MultiPolygon',
  coordinates: [
    [[[20, 20], [20, 25], [25, 25], [25, 20], [20, 20]]],
    [[[30, 30], [30, 33], [33, 33], [33, 30], [30, 30]]],
  ],
});

function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

describe('buildShapefileSets', () => {
  it('returns nothing for empty or unsupported input', () => {
    expect(buildShapefileSets([], 'x')).toEqual([]);
    expect(buildShapefileSets([feature(null)], 'x')).toEqual([]);
  });

  it('keeps a single family under the plain base name', () => {
    const sets = buildShapefileSets([point], 'My Layer!');
    expect(sets).toHaveLength(1);
    expect(sets[0].baseName).toBe('My_Layer');
    expect(Object.keys(sets[0].files).sort()).toEqual(['dbf', 'prj', 'shp', 'shx']);
  });

  it('splits mixed geometries into suffixed per-family sets', () => {
    const sets = buildShapefileSets([point, line, polygonWithHole], 'mixed');
    const names = sets.map((s) => s.baseName).sort();
    expect(names).toEqual(['mixed_line', 'mixed_point', 'mixed_polygon']);
  });

  it('round-trips points with their DBF attributes', async () => {
    const [set] = buildShapefileSets([point], 'pts');
    const result = await roundTrip(set);
    expect(result.projectionWKT).toBe(WGS84_PRJ);
    expect(result.features).toHaveLength(1);
    expect(result.features[0].geometry.type).toBe('Point');
    expect(result.features[0].geometry.coordinates[0]).toBeCloseTo(138.6, 10);
    expect(result.features[0].geometry.coordinates[1]).toBeCloseTo(-34.93, 10);
    expect(result.features[0].properties.ID).toBe(1);
    expect(result.features[0].properties.NAME).toBe('Adelaide');
  });

  it('round-trips lines and multi-part lines', async () => {
    const [set] = buildShapefileSets([line, multiLine], 'roads');
    const result = await roundTrip(set);
    expect(result.features).toHaveLength(2);
    const [a, b] = result.features.map((f) => f.geometry);
    expect(a.type).toBe('LineString');
    expect(a.coordinates).toHaveLength(3);
    expect(a.coordinates[1][0]).toBeCloseTo(138.6, 10);
    expect(b.type).toBe('MultiLineString');
    expect(b.coordinates).toHaveLength(2);
    expect(b.coordinates[1]).toHaveLength(3);
  });

  it('enforces shapefile ring winding and closes rings', async () => {
    const [set] = buildShapefileSets([polygonWithHole], 'zone');
    const result = await roundTrip(set);
    expect(result.features).toHaveLength(1);
    const geom = result.features[0].geometry;
    expect(geom.type).toBe('Polygon');
    expect(geom.coordinates).toHaveLength(2);
    const [shell, hole] = geom.coordinates;
    // Shell clockwise (negative signed area), hole counter-clockwise.
    expect(signedArea(shell)).toBeLessThan(0);
    expect(signedArea(hole)).toBeGreaterThan(0);
    // Rings are closed and keep every vertex.
    expect(shell[0]).toEqual(shell[shell.length - 1]);
    expect(shell).toHaveLength(5);
    expect(hole).toHaveLength(5);
  });

  it('flattens multi-polygons into one record per polygon ring set', async () => {
    const [set] = buildShapefileSets([multiPolygon], 'islands');
    const result = await roundTrip(set);
    expect(result.features).toHaveLength(1);
    // Both member polygons become parts of a single polygon record.
    expect(result.features[0].geometry.coordinates).toHaveLength(2);
  });

  it('flattens GeometryCollection members into their families', () => {
    const gc = feature({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2] },
        { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      ],
    });
    const sets = buildShapefileSets([gc], 'gc');
    expect(sets.map((s) => s.baseName).sort()).toEqual(['gc_line', 'gc_point']);
  });

  it('writes structurally consistent .shp/.shx pairs', () => {
    const sets = buildShapefileSets([point, line, polygonWithHole, multiPolygon], 'struct');
    expect(sets.map((x) => x.baseName)).toContain('struct_point'); // multi-family suffixing
    for (const s of sets) {
      const shp = new DataView(s.files.shp.buffer, s.files.shp.byteOffset, s.files.shp.byteLength);
      const shx = new DataView(s.files.shx.buffer, s.files.shx.byteOffset, s.files.shx.byteLength);

      expect(shp.getInt32(0, false)).toBe(9994);
      expect(shp.getInt32(28, true)).toBe(1000);
      expect(shp.getInt32(32, true)).toBe(shx.getInt32(32, true)); // same shape type
      expect(shp.getInt32(24, false) * 2).toBe(s.files.shp.byteLength);
      expect(shx.getInt32(24, false) * 2).toBe(s.files.shx.byteLength);

      const recordCount = (s.files.shx.byteLength - 100) / 8;
      let expectedOffset = 50; // first record sits right after the 100-byte header
      for (let i = 0; i < recordCount; i++) {
        expect(shx.getInt32(100 + i * 8, false)).toBe(expectedOffset);
        const contentWords = shx.getInt32(100 + i * 8 + 4, false);
        // Record numbers are 1-based and sequential in the .shp.
        expect(shp.getInt32(expectedOffset * 2, false)).toBe(i + 1);
        expect(shp.getInt32(expectedOffset * 2 + 4, false)).toBe(contentWords);
        expectedOffset += 4 + contentWords;
      }
      expect(expectedOffset * 2).toBe(s.files.shp.byteLength);
    }
  });

  it('sanitises DBF text to single-byte characters', async () => {
    const weird = feature({ type: 'Point', coordinates: [0, 0] }, { name: 'Café ☕ 咖啡' });
    const [set] = buildShapefileSets([weird], 'weird');
    const result = await roundTrip(set);
    const name = result.features[0].properties.NAME as string;
    expect(name).toBe('Café ? ??');
    expect(name.length).toBeLessThanOrEqual(80);
  });
});
