/**
 * Binary ESRI shapefile writer.
 *
 * Produces the four mandatory members of a shapefile set (.shp, .shx, .dbf,
 * .prj) from GeoJSON features in WGS84 lon/lat coordinates. A shapefile can
 * only hold a single geometry family, so mixed input is split into one set
 * per family (point / multipoint / line / polygon); the caller zips the sets
 * together for download.
 *
 * The output is readable by QGIS, ArcGIS, ogr2ogr and this app's own
 * shapefileParser (see shapefileWriter.test.ts for a round-trip check).
 */

export interface ShapefileSet {
  /** File basename without extension, e.g. "my_layer_line". */
  baseName: string;
  files: {
    shp: Uint8Array;
    shx: Uint8Array;
    dbf: Uint8Array;
    prj: string;
  };
}

export interface GeoJsonLikeFeature {
  type?: string;
  geometry?: { type: string; coordinates?: any; geometries?: any[] } | null;
  properties?: Record<string, any> | null;
}

/** WGS84 .prj WKT, the CRS every export is written in. */
export const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

// Shapefile shape-type codes (2D variants only).
const SHP_POINT = 1;
const SHP_POLYLINE = 3;
const SHP_POLYGON = 5;
const SHP_MULTIPOINT = 8;

type Family = 'point' | 'multipoint' | 'line' | 'polygon';

type Coord = [number, number];
type Ring = Coord[];

const FAMILY_SUFFIX: Record<Family, string> = {
  point: '_point',
  multipoint: '_mpoint',
  line: '_line',
  polygon: '_polygon',
};

interface Bucket {
  shapeType: number;
  names: string[];
  /** SHP_POINT only: one coordinate per record. */
  points: Coord[];
  /** SHP_MULTIPOINT only: one coordinate list per record. */
  multiPoints: Coord[][];
  /** SHP_POLYLINE / SHP_POLYGON: parts (lines or rings) per record. */
  parts: Ring[][];
}

function newBucket(shapeType: number): Bucket {
  return { shapeType, names: [], points: [], multiPoints: [], parts: [] };
}

/** GeometryCollection members are exported as standalone shapes. */
function flattenGeometries(geom: GeoJsonLikeFeature['geometry']): Array<{ type: string; coordinates: any }> {
  if (!geom) return [];
  if (geom.type === 'GeometryCollection') {
    return (geom.geometries || []).flatMap((g: any) => flattenGeometries(g));
  }
  if (!geom.coordinates) return [];
  return [{ type: geom.type, coordinates: geom.coordinates }];
}

function familyFor(geomType: string): Family | null {
  switch (geomType) {
    case 'Point': return 'point';
    case 'MultiPoint': return 'multipoint';
    case 'LineString':
    case 'MultiLineString': return 'line';
    case 'Polygon':
    case 'MultiPolygon': return 'polygon';
    default: return null;
  }
}

/** Shoelace signed area: positive = counter-clockwise in a y-up plane. */
function signedArea(ring: Coord[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function ensureClosed(ring: Coord[]): Coord[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [first[0], first[1]] as Coord];
}

/**
 * Shapefile spec: outer rings wind clockwise, holes counter-clockwise
 * (screen coordinates, y up). Readers use the winding to tell holes from
 * islands, so enforce it regardless of how the geometry was digitised.
 */
function orientRing(ring: Coord[], isHole: boolean): Coord[] {
  const closed = ensureClosed(ring);
  const area = signedArea(closed);
  if (area === 0) return closed;
  const ccw = area > 0;
  return ccw === isHole ? closed : closed.slice().reverse();
}

/** Rings of one polygon: first ring is the shell, the rest are holes. */
function polygonRings(rings: Coord[][]): Ring[] {
  return rings
    .filter((r) => r && r.length >= 3)
    .map((r, i) => orientRing(r, i > 0));
}

/** Best-effort human-readable name for the DBF NAME column. */
function featureName(props: Record<string, any> | null | undefined, index: number): string {
  const p = props || {};
  const raw = p.labelText ?? p.name ?? p.Name ?? p.NAME ?? p.title ?? p.Title;
  const s = raw == null ? '' : String(raw).trim();
  return s || 'Feature ' + (index + 1);
}

function sanitizeBaseName(name: string): string {
  const cleaned = (name || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Long basenames are legal in zips but painful in 8.3-era tooling; keep
  // room for the family suffix plus a 4-char extension.
  return (cleaned || 'export').slice(0, 24);
}

/* ------------------------------------------------------------------ */
/* Binary builders                                                     */
/* ------------------------------------------------------------------ */

function writeMainHeader(view: DataView, fileLengthBytes: number, shapeType: number, bbox: number[]): void {
  view.setInt32(0, 9994, false); // file code (big-endian)
  // words 4..23 stay zero (unused)
  view.setInt32(24, fileLengthBytes / 2, false); // file length in 16-bit words
  view.setInt32(28, 1000, true); // version (little-endian)
  view.setInt32(32, shapeType, true);
  view.setFloat64(36, bbox[0], true); // xmin
  view.setFloat64(44, bbox[1], true); // ymin
  view.setFloat64(52, bbox[2], true); // xmax
  view.setFloat64(60, bbox[3], true); // ymax
  // z/m ranges (68..99) stay zero for 2D shapes
}

function boundsOf(coords: Coord[]): number[] {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of coords) {
    if (x < xmin) xmin = x;
    if (y < ymin) ymin = y;
    if (x > xmax) xmax = x;
    if (y > ymax) ymax = y;
  }
  return [xmin, ymin, xmax, ymax];
}

function pointContent(coord: Coord): Uint8Array {
  const content = new Uint8Array(20);
  const view = new DataView(content.buffer);
  view.setInt32(0, SHP_POINT, true);
  view.setFloat64(4, coord[0], true);
  view.setFloat64(12, coord[1], true);
  return content;
}

function multiPointContent(coords: Coord[]): Uint8Array {
  const content = new Uint8Array(40 + coords.length * 16);
  const view = new DataView(content.buffer);
  view.setInt32(0, SHP_MULTIPOINT, true);
  const bbox = boundsOf(coords);
  view.setFloat64(4, bbox[0], true);
  view.setFloat64(12, bbox[1], true);
  view.setFloat64(20, bbox[2], true);
  view.setFloat64(28, bbox[3], true);
  view.setInt32(36, coords.length, true);
  coords.forEach(([x, y], i) => {
    view.setFloat64(40 + i * 16, x, true);
    view.setFloat64(48 + i * 16, y, true);
  });
  return content;
}

/** PolyLine / Polygon share the same part-based layout. */
function partsContent(shapeType: number, parts: Ring[]): Uint8Array {
  const numPoints = parts.reduce((n, r) => n + r.length, 0);
  const content = new Uint8Array(44 + parts.length * 4 + numPoints * 16);
  const view = new DataView(content.buffer);
  view.setInt32(0, shapeType, true);
  const bbox = boundsOf(parts.flat());
  view.setFloat64(4, bbox[0], true);
  view.setFloat64(12, bbox[1], true);
  view.setFloat64(20, bbox[2], true);
  view.setFloat64(28, bbox[3], true);
  view.setInt32(36, parts.length, true);
  view.setInt32(40, numPoints, true);
  let pointIndex = 0;
  parts.forEach((ring, i) => {
    view.setInt32(44 + i * 4, pointIndex, true);
    ring.forEach(([x, y]) => {
      const off = 44 + parts.length * 4 + pointIndex * 16;
      view.setFloat64(off, x, true);
      view.setFloat64(off + 8, y, true);
      pointIndex++;
    });
  });
  return content;
}

function bucketContents(bucket: Bucket): Uint8Array[] {
  if (bucket.shapeType === SHP_POINT) return bucket.points.map(pointContent);
  if (bucket.shapeType === SHP_MULTIPOINT) return bucket.multiPoints.map(multiPointContent);
  return bucket.parts.map((parts) => partsContent(bucket.shapeType, parts));
}

function allCoords(bucket: Bucket): Coord[] {
  if (bucket.shapeType === SHP_POINT) return bucket.points;
  if (bucket.shapeType === SHP_MULTIPOINT) return bucket.multiPoints.flat();
  return bucket.parts.flat(2);
}

/** Builds the paired .shp / .shx files for one bucket. */
function buildShpShx(bucket: Bucket): { shp: Uint8Array; shx: Uint8Array } {
  const contents = bucketContents(bucket);
  const bbox = boundsOf(allCoords(bucket));
  const contentBytes = contents.reduce((n, c) => n + 8 + c.length, 0);

  const shp = new Uint8Array(100 + contentBytes);
  const shpView = new DataView(shp.buffer);
  writeMainHeader(shpView, shp.length, bucket.shapeType, bbox);
  let offset = 100;
  contents.forEach((content, i) => {
    shpView.setInt32(offset, i + 1, false); // record numbers are 1-based
    shpView.setInt32(offset + 4, content.length / 2, false);
    shp.set(content, offset + 8);
    offset += 8 + content.length;
  });

  const shx = new Uint8Array(100 + contents.length * 8);
  const shxView = new DataView(shx.buffer);
  writeMainHeader(shxView, shx.length, bucket.shapeType, bbox);
  let recordOffset = 50; // first record starts right after the 100-byte header
  contents.forEach((content, i) => {
    shxView.setInt32(100 + i * 8, recordOffset, false);
    shxView.setInt32(100 + i * 8 + 4, content.length / 2, false);
    recordOffset += 4 + content.length / 2;
  });

  return { shp, shx };
}

/* ------------------------------------------------------------------ */
/* DBF                                                                 */
/* ------------------------------------------------------------------ */

/** Encode as single-byte text; anything outside Latin-1 becomes "?". */
function toDbfChars(value: string, length: number, padLeft: boolean): Uint8Array {
  const out = new Uint8Array(length).fill(0x20);
  const chars: number[] = [];
  for (let i = 0; i < value.length && chars.length < length; i++) {
    const code = value.charCodeAt(i);
    chars.push(code > 0xff || code < 0x20 ? 0x3f : code);
  }
  const start = padLeft ? length - chars.length : 0;
  chars.forEach((c, i) => { out[start + i] = c; });
  return out;
}

function buildDbf(names: string[]): Uint8Array {
  const fields = [
    { name: 'ID', type: 'N', length: 10, decimals: 0 },
    { name: 'NAME', type: 'C', length: 80, decimals: 0 },
  ];
  const headerSize = 32 + fields.length * 32 + 1;
  const recordSize = 1 + fields.reduce((n, f) => n + f.length, 0);
  const dbf = new Uint8Array(headerSize + names.length * recordSize + 1);
  const view = new DataView(dbf.buffer);

  const now = new Date();
  dbf[0] = 0x03; // dBASE III, no memo
  dbf[1] = now.getFullYear() - 1900;
  dbf[2] = now.getMonth() + 1;
  dbf[3] = now.getDate();
  view.setInt32(4, names.length, true);
  view.setInt16(8, headerSize, true);
  view.setInt16(10, recordSize, true);
  // bytes 12..31 reserved

  fields.forEach((field, i) => {
    const off = 32 + i * 32;
    for (let j = 0; j < 11 && j < field.name.length; j++) {
      dbf[off + j] = field.name.charCodeAt(j);
    }
    dbf[off + 11] = field.type.charCodeAt(0);
    dbf[off + 16] = field.length;
    dbf[off + 17] = field.decimals;
  });
  dbf[headerSize - 1] = 0x0d; // header terminator

  names.forEach((name, i) => {
    const off = headerSize + i * recordSize;
    dbf[off] = 0x20; // record valid (not deleted)
    dbf.set(toDbfChars(String(i + 1), fields[0].length, true), off + 1);
    dbf.set(toDbfChars(name, fields[1].length, false), off + 1 + fields[0].length);
  });
  dbf[dbf.length - 1] = 0x1a; // end-of-file marker

  return dbf;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Splits GeoJSON features into one shapefile set per geometry family.
 * Returns [] when nothing exportable is found (the caller surfaces that).
 */
export function buildShapefileSets(features: GeoJsonLikeFeature[], baseName: string): ShapefileSet[] {
  const buckets: Record<Family, Bucket> = {
    point: newBucket(SHP_POINT),
    multipoint: newBucket(SHP_MULTIPOINT),
    line: newBucket(SHP_POLYLINE),
    polygon: newBucket(SHP_POLYGON),
  };

  features.forEach((feature, index) => {
    const name = featureName(feature.properties, index);
    for (const geom of flattenGeometries(feature.geometry)) {
      const family = familyFor(geom.type);
      if (!family) continue;
      const bucket = buckets[family];
      bucket.names.push(name);
      if (family === 'point') {
        bucket.points.push([geom.coordinates[0], geom.coordinates[1]]);
      } else if (family === 'multipoint') {
        bucket.multiPoints.push(geom.coordinates.map((c: number[]) => [c[0], c[1]] as Coord));
      } else if (family === 'line') {
        const lines: Coord[][] = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
        bucket.parts.push(lines.filter((l) => l && l.length >= 2).map((l) => l.map((c: number[]) => [c[0], c[1]] as Coord)));
      } else {
        const polygons: Coord[][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        const rings = polygons.flatMap((rings) => polygonRings(rings));
        if (rings.length > 0) bucket.parts.push(rings);
      }
    }
  });

  const populated = (Object.keys(buckets) as Family[]).filter((family) => {
    const b = buckets[family];
    return b.points.length > 0 || b.multiPoints.length > 0 || b.parts.length > 0;
  });
  if (populated.length === 0) return [];

  const cleanBase = sanitizeBaseName(baseName);
  const suffixed = populated.length > 1;

  return populated.map((family) => {
    const bucket = buckets[family];
    const { shp, shx } = buildShpShx(bucket);
    return {
      baseName: suffixed ? cleanBase + FAMILY_SUFFIX[family] : cleanBase,
      files: { shp, shx, dbf: buildDbf(bucket.names), prj: WGS84_PRJ },
    };
  });
}
