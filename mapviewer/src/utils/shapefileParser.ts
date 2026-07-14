import JSZip from 'jszip';

interface ShapefileGeometry {
  type: string;
  coordinates: any;
}

interface ShapefileFeature {
  type: 'Feature';
  geometry: ShapefileGeometry;
  properties: Record<string, any>;
}

export async function parseShapefile(file: File): Promise<ShapefileFeature[]> {
  const zip = await JSZip.loadAsync(file);
  
  let shpFile: JSZip.JSZipObject | null = null;
  let dbfFile: JSZip.JSZipObject | null = null;
  
  for (const filename in zip.files) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'shp') shpFile = zip.files[filename];
    if (ext === 'dbf') dbfFile = zip.files[filename];
  }
  
  if (!shpFile || !dbfFile) {
    throw new Error('Invalid shapefile: missing .shp or .dbf file');
  }
  
  const shpBuffer = await shpFile.async('arraybuffer');
  const geometries = parseShp(shpBuffer);
  
  const dbfBuffer = await dbfFile.async('arraybuffer');
  const attributes = parseDbf(dbfBuffer);
  
  const features: ShapefileFeature[] = [];
  for (let i = 0; i < geometries.length; i++) {
    features.push({
      type: 'Feature',
      geometry: geometries[i],
      properties: attributes[i] || {}
    });
  }
  
  return features;
}

function parseShp(buffer: ArrayBuffer): ShapefileGeometry[] {
  const view = new DataView(buffer);
  const geometries: ShapefileGeometry[] = [];
  
  const fileCode = view.getInt32(0, false);
  if (fileCode !== 9994) {
    throw new Error('Invalid shapefile: wrong file code');
  }
  
  const fileLength = view.getInt32(24, false) * 2;
  let offset = 100;
  
  while (offset < fileLength) {
    const contentLength = view.getInt32(offset + 4, false) * 2;
    const shapeType = view.getInt32(offset + 8, true);
    
    offset += 8;
    
    const geometry = readGeometry(view, offset, shapeType);
    geometries.push(geometry);
    
    offset += contentLength;
  }
  
  return geometries;
}

function readGeometry(view: DataView, offset: number, shapeType: number): ShapefileGeometry {
  switch (shapeType) {
    case 0:
      return { type: 'Point', coordinates: [0, 0] };
    case 1:
      return {
        type: 'Point',
        coordinates: [
          view.getFloat64(offset + 4, true),
          view.getFloat64(offset + 12, true)
        ]
      };
    case 3:
    case 5: {
      const numParts = view.getInt32(offset + 40, true);
      const numPoints = view.getInt32(offset + 44, true);
      
      const parts: number[] = [];
      for (let i = 0; i < numParts; i++) {
        parts.push(view.getInt32(offset + 48 + i * 4, true));
      }
      
      const points: number[][] = [];
      const pointsOffset = offset + 48 + numParts * 4;
      for (let i = 0; i < numPoints; i++) {
        points.push([
          view.getFloat64(pointsOffset + i * 16, true),
          view.getFloat64(pointsOffset + i * 16 + 8, true)
        ]);
      }
      
      if (shapeType === 3) {
        if (numParts === 1) {
          return { type: 'LineString', coordinates: points };
        } else {
          const lines: number[][][] = [];
          for (let i = 0; i < numParts; i++) {
            const start = parts[i];
            const end = i < numParts - 1 ? parts[i + 1] : numPoints;
            lines.push(points.slice(start, end));
          }
          return { type: 'MultiLineString', coordinates: lines };
        }
      } else {
        if (numParts === 1) {
          return { type: 'Polygon', coordinates: [points] };
        } else {
          const rings: number[][][] = [];
          for (let i = 0; i < numParts; i++) {
            const start = parts[i];
            const end = i < numParts - 1 ? parts[i + 1] : numPoints;
            rings.push(points.slice(start, end));
          }
          return { type: 'Polygon', coordinates: rings };
        }
      }
    }
    case 8: {
      const numPoints = view.getInt32(offset + 40, true);
      const points: number[][] = [];
      const pointsOffset = offset + 44;
      for (let i = 0; i < numPoints; i++) {
        points.push([
          view.getFloat64(pointsOffset + i * 16, true),
          view.getFloat64(pointsOffset + i * 16 + 8, true)
        ]);
      }
      return { type: 'MultiPoint', coordinates: points };
    }
    case 11:
      return {
        type: 'Point',
        coordinates: [
          view.getFloat64(offset + 4, true),
          view.getFloat64(offset + 12, true),
          view.getFloat64(offset + 20, true)
        ]
      };
    default:
      return { type: 'Point', coordinates: [0, 0] };
  }
}

function parseDbf(buffer: ArrayBuffer): Record<string, any>[] {
  const view = new DataView(buffer);
  const records: Record<string, any>[] = [];
  
  const numRecords = view.getInt32(4, true);
  const headerSize = view.getInt16(8, true);
  const recordSize = view.getInt16(10, true);
  
  const fields: { name: string; type: string; size: number }[] = [];
  let offset = 32;
  while (offset < headerSize - 1) {
    const nameBytes = new Uint8Array(buffer, offset, 11);
    const nameChars: string[] = [];
    for (let i = 0; i < nameBytes.length; i++) {
      nameChars.push(String.fromCharCode(nameBytes[i]));
    }
    const name = nameChars.join('').replace(/\0/g, '').trim();
    const type = String.fromCharCode(view.getUint8(offset + 11));
    const size = view.getUint8(offset + 16);
    
    if (name) {
      fields.push({ name, type, size });
    }
    
    offset += 32;
  }
  
  offset = headerSize;
  for (let i = 0; i < numRecords; i++) {
    const record: Record<string, any> = {};
    const deletionFlag = view.getUint8(offset);
    offset++;
    
    if (deletionFlag !== 0x2A) {
      for (const field of fields) {
        const valueBytes = new Uint8Array(buffer, offset, field.size);
        const valueChars: string[] = [];
        for (let j = 0; j < valueBytes.length; j++) {
          valueChars.push(String.fromCharCode(valueBytes[j]));
        }
        const value = valueChars.join('').trim();
        
        if (field.type === 'N') {
          record[field.name] = parseFloat(value) || 0;
        } else if (field.type === 'L') {
          record[field.name] = value === 'T' || value === 'Y';
        } else {
          record[field.name] = value;
        }
        
        offset += field.size;
      }
      
      records.push(record);
    } else {
      offset += recordSize - 1;
    }
  }
  
  return records;
}
