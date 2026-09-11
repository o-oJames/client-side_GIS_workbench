import { describe, it, expect } from 'vitest';
import { toJSTSGeometry, fromJSTSGeometry, jstsBuffer, jstsSingleSidedBuffer } from './jstsBridge';
import type { GeoGeom } from './geoTypes';

describe('jstsBridge', () => {
  describe('geometry conversion', () => {
    it('converts Point to JSTS and back', () => {
      const point: GeoGeom = { type: 'Point', coordinates: [10, 20] };
      const jstsGeom = toJSTSGeometry(point);
      const result = fromJSTSGeometry(jstsGeom);
      expect(result).toEqual(point);
    });

    it('converts LineString to JSTS and back', () => {
      const line: GeoGeom = { 
        type: 'LineString', 
        coordinates: [[0, 0], [10, 0], [10, 10]] 
      };
      const jstsGeom = toJSTSGeometry(line);
      const result = fromJSTSGeometry(jstsGeom);
      expect(result).toEqual(line);
    });

    it('converts Polygon to JSTS and back', () => {
      const polygon: GeoGeom = { 
        type: 'Polygon', 
        coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] 
      };
      const jstsGeom = toJSTSGeometry(polygon);
      const result = fromJSTSGeometry(jstsGeom);
      expect(result.type).toBe('Polygon');
      if (result.type === 'Polygon') {
        expect(result.coordinates[0].length).toBe(5);
      }
    });
  });

  describe('buffer operations', () => {
    it('performs a regular buffer on a point', () => {
      const point: GeoGeom = { type: 'Point', coordinates: [0, 0] };
      const result = jstsBuffer(point, 5);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('Polygon');
    });

    it('performs a single-sided buffer on a line (left side)', () => {
      const line: GeoGeom = { 
        type: 'LineString', 
        coordinates: [[0, 0], [10, 0]] 
      };
      const result = jstsSingleSidedBuffer(line, 5, 'left');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('Polygon');
      
      // Left side buffer should be above the line (positive y)
      if (result?.type === 'Polygon') {
        const coords = result.coordinates[0];
        const hasPositiveY = coords.some(([x, y]) => y > 0);
        expect(hasPositiveY).toBe(true);
      }
    });

    it('performs a single-sided buffer on a line (right side)', () => {
      const line: GeoGeom = { 
        type: 'LineString', 
        coordinates: [[0, 0], [10, 0]] 
      };
      const result = jstsSingleSidedBuffer(line, 5, 'right');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('Polygon');
      
      // Right side buffer should be below the line (negative y)
      if (result?.type === 'Polygon') {
        const coords = result.coordinates[0];
        const hasNegativeY = coords.some(([x, y]) => y < 0);
        expect(hasNegativeY).toBe(true);
      }
    });
  });
});
