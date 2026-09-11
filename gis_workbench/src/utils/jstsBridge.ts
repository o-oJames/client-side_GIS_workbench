/**
 * jstsBridge.ts — Bridge between our GeoGeom types and JSTS geometry objects.
 * 
 * This module provides conversion functions and wrapper operations for using
 * the JSTS (Java Topology Suite) JavaScript port for advanced geometry operations
 * like single-sided buffers.
 */

import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import type { GeoGeom, Coord, Ring } from './geoTypes';

// Create a shared geometry factory
const geometryFactory = new GeometryFactory();

/**
 * Convert our Coord type to JSTS Coordinate
 */
function coordToJTS(coord: Coord): InstanceType<typeof Coordinate> {
  return new Coordinate(coord[0], coord[1]);
}

/**
 * Convert JSTS Coordinate to our Coord type
 */
function jtsToCoord(coord: InstanceType<typeof Coordinate>): Coord {
  return [coord.x, coord.y];
}

/**
 * Convert our Ring type to array of JSTS Coordinates
 */
function ringToJTSCoords(ring: Ring): InstanceType<typeof Coordinate>[] {
  return ring.map(coordToJTS);
}

/**
 * Convert array of JSTS Coordinates to our Ring type
 */
function jtsCoordsToRing(coords: InstanceType<typeof Coordinate>[]): Ring {
  return coords.map(jtsToCoord);
}

/**
 * Convert our GeoGeom to JSTS Geometry
 */
export function toJSTSGeometry(geom: GeoGeom): any {
  switch (geom.type) {
    case 'Point':
      return geometryFactory.createPoint(coordToJTS(geom.coordinates));
    
    case 'LineString':
      return geometryFactory.createLineString(ringToJTSCoords(geom.coordinates));
    
    case 'Polygon': {
      const shell = geometryFactory.createLinearRing(ringToJTSCoords(geom.coordinates[0]));
      const holes = geom.coordinates.slice(1).map(ring => 
        geometryFactory.createLinearRing(ringToJTSCoords(ring))
      );
      return geometryFactory.createPolygon(shell, holes);
    }
    
    case 'MultiPoint':
      return geometryFactory.createMultiPoint(
        geom.coordinates.map(coord => geometryFactory.createPoint(coordToJTS(coord)))
      );
    
    case 'MultiLineString':
      return geometryFactory.createMultiLineString(
        geom.coordinates.map(coords => 
          geometryFactory.createLineString(ringToJTSCoords(coords))
        )
      );
    
    case 'MultiPolygon':
      return geometryFactory.createMultiPolygon(
        geom.coordinates.map(polygonCoords => {
          const shell = geometryFactory.createLinearRing(ringToJTSCoords(polygonCoords[0]));
          const holes = polygonCoords.slice(1).map(ring => 
            geometryFactory.createLinearRing(ringToJTSCoords(ring))
          );
          return geometryFactory.createPolygon(shell, holes);
        })
      );
    
    default:
      throw new Error(`Unsupported geometry type: ${(geom as any).type}`);
  }
}

/**
 * Convert JSTS Geometry to our GeoGeom
 */
export function fromJSTSGeometry(jtsGeom: any): GeoGeom {
  const geomType = jtsGeom.getGeometryType();
  
  switch (geomType) {
    case 'Point': {
      const coord = jtsGeom.getCoordinate();
      return { type: 'Point', coordinates: jtsToCoord(coord) };
    }
    
    case 'LineString': {
      const coords = jtsGeom.getCoordinates();
      return { type: 'LineString', coordinates: jtsCoordsToRing(coords) };
    }
    
    case 'Polygon': {
      const shell = jtsGeom.getExteriorRing().getCoordinates();
      const holes = [];
      for (let i = 0; i < jtsGeom.getNumInteriorRing(); i++) {
        const hole = jtsGeom.getInteriorRingN(i).getCoordinates();
        holes.push(jtsCoordsToRing(hole));
      }
      return { 
        type: 'Polygon', 
        coordinates: [jtsCoordsToRing(shell), ...holes] 
      };
    }
    
    case 'MultiPoint': {
      const coords = [];
      for (let i = 0; i < jtsGeom.getNumGeometries(); i++) {
        const point = jtsGeom.getGeometryN(i);
        coords.push(jtsToCoord(point.getCoordinate()));
      }
      return { type: 'MultiPoint', coordinates: coords };
    }
    
    case 'MultiLineString': {
      const coords = [];
      for (let i = 0; i < jtsGeom.getNumGeometries(); i++) {
        const line = jtsGeom.getGeometryN(i);
        coords.push(jtsCoordsToRing(line.getCoordinates()));
      }
      return { type: 'MultiLineString', coordinates: coords };
    }
    
    case 'MultiPolygon': {
      const polygons = [];
      for (let i = 0; i < jtsGeom.getNumGeometries(); i++) {
        const polygon = jtsGeom.getGeometryN(i);
        const shell = polygon.getExteriorRing().getCoordinates();
        const holes = [];
        for (let j = 0; j < polygon.getNumInteriorRing(); j++) {
          const hole = polygon.getInteriorRingN(j).getCoordinates();
          holes.push(jtsCoordsToRing(hole));
        }
        polygons.push([jtsCoordsToRing(shell), ...holes]);
      }
      return { type: 'MultiPolygon', coordinates: polygons };
    }
    
    default:
      throw new Error(`Unsupported JSTS geometry type: ${geomType}`);
  }
}

/**
 * Map our end cap style to JSTS end cap style
 */
function mapEndCapStyle(style: string): number {
  switch (style) {
    case 'round': return BufferParameters.CAP_ROUND;
    case 'flat': return BufferParameters.CAP_FLAT;
    case 'square': return BufferParameters.CAP_SQUARE;
    default: return BufferParameters.CAP_ROUND;
  }
}

/**
 * Map our join style to JSTS join style
 */
function mapJoinStyle(style: string): number {
  switch (style) {
    case 'round': return BufferParameters.JOIN_ROUND;
    case 'miter': return BufferParameters.JOIN_MITRE;
    case 'bevel': return BufferParameters.JOIN_BEVEL;
    default: return BufferParameters.JOIN_ROUND;
  }
}

/**
 * Perform a buffer operation using JSTS
 */
export function jstsBuffer(
  geom: GeoGeom,
  distance: number,
  options?: {
    endCapStyle?: string;
    joinStyle?: string;
    segments?: number;
    singleSided?: boolean;
  }
): GeoGeom | null {
  try {
    const jtsGeom = toJSTSGeometry(geom);
    
    // Create buffer parameters
    const bufferParams = new BufferParameters();
    
    if (options?.endCapStyle) {
      bufferParams.setEndCapStyle(mapEndCapStyle(options.endCapStyle));
    }
    if (options?.joinStyle) {
      bufferParams.setJoinStyle(mapJoinStyle(options.joinStyle));
    }
    if (options?.segments) {
      bufferParams.setQuadrantSegments(options.segments);
    }
    if (options?.singleSided) {
      bufferParams.setSingleSided(true);
    }
    
    // Perform buffer operation
    const bufferOp = new BufferOp(jtsGeom);
    bufferOp.setEndCapStyle(bufferParams.getEndCapStyle());
    bufferOp.setQuadrantSegments(bufferParams.getQuadrantSegments());
    
    const result = bufferOp.getResultGeometry(distance);
    
    if (result.isEmpty()) {
      return null;
    }
    
    return fromJSTSGeometry(result);
  } catch (error) {
    console.error('JSTS buffer operation failed:', error);
    return null;
  }
}

/**
 * Perform a single-sided buffer using JSTS
 * 
 * @param geom - The geometry to buffer
 * @param distance - Buffer distance (positive = left/outside, negative = right/inside)
 * @param side - Which side to buffer: 'left' or 'right'
 * @param options - Buffer options (endCapStyle, joinStyle, segments)
 * @returns Buffered geometry or null if operation fails
 */
export function jstsSingleSidedBuffer(
  geom: GeoGeom,
  distance: number,
  side: 'left' | 'right',
  options?: {
    endCapStyle?: string;
    joinStyle?: string;
    segments?: number;
  }
): GeoGeom | null {
  // For right side, negate the distance
  const bufferDistance = side === 'right' ? -distance : distance;
  
  return jstsBuffer(geom, bufferDistance, {
    ...options,
    singleSided: true
  });
}
