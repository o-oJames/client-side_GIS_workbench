import { describe, it, expect } from 'vitest';
import { orientation, incircle, areCollinear, areCocircular } from './exactPredicates';
import type { Coord } from './geoTypes';

describe('exactPredicates', () => {
  describe('orientation', () => {
    it('detects counter-clockwise turn', () => {
      const a: Coord = [0, 0];
      const b: Coord = [1, 0];
      const c: Coord = [0, 1];
      expect(orientation(a, b, c)).toBe(1);
    });

    it('detects clockwise turn', () => {
      const a: Coord = [0, 0];
      const b: Coord = [0, 1];
      const c: Coord = [1, 0];
      expect(orientation(a, b, c)).toBe(-1);
    });

    it('handles collinear points with symbolic perturbation', () => {
      const a: Coord = [0, 0];
      const b: Coord = [1, 1];
      const c: Coord = [2, 2];
      // Collinear, but perturbation gives a deterministic result.
      const result = orientation(a, b, c, 0, 1, 2);
      expect(result === 1 || result === -1).toBe(true);
    });

    it('is order-independent for collinear points', () => {
      const a: Coord = [0, 0];
      const b: Coord = [1, 1];
      const c: Coord = [2, 2];
      // Different orderings should give consistent results based on indices.
      const r1 = orientation(a, b, c, 0, 1, 2);
      const r2 = orientation(b, a, c, 1, 0, 2);
      // The sign should flip when we swap two vertices.
      expect(r1).toBe(-r2);
    });
  });

  describe('incircle', () => {
    it('detects point inside circumcircle', () => {
      const a: Coord = [0, 0];
      const b: Coord = [10, 0];
      const c: Coord = [5, 10];
      const d: Coord = [5, 3]; // Inside the circumcircle
      expect(incircle(a, b, c, d)).toBe(1);
    });

    it('detects point outside circumcircle', () => {
      const a: Coord = [0, 0];
      const b: Coord = [10, 0];
      const c: Coord = [5, 10];
      const d: Coord = [5, 20]; // Outside the circumcircle
      expect(incircle(a, b, c, d)).toBe(-1);
    });

    it('handles cocircular points with symbolic perturbation', () => {
      // Four points on a circle.
      const a: Coord = [0, 0];
      const b: Coord = [10, 0];
      const c: Coord = [10, 10];
      const d: Coord = [0, 10];
      // Cocircular, but perturbation gives a deterministic result.
      const result = incircle(a, b, c, d, 0, 1, 2, 3);
      expect(result === 1 || result === -1).toBe(true);
    });
  });

  describe('areCollinear', () => {
    it('detects collinear points', () => {
      const a: Coord = [0, 0];
      const b: Coord = [1, 1];
      const c: Coord = [2, 2];
      expect(areCollinear(a, b, c)).toBe(true);
    });

    it('detects non-collinear points', () => {
      const a: Coord = [0, 0];
      const b: Coord = [1, 0];
      const c: Coord = [0, 1];
      expect(areCollinear(a, b, c)).toBe(false);
    });

    it('handles tolerance', () => {
      const a: Coord = [0, 0];
      const b: Coord = [1, 0];
      const c: Coord = [2, 1e-10]; // Nearly collinear
      // With no tolerance, the error bound is ~3ε × 1e-10 ≈ 6e-26, so 1e-10 is not collinear.
      expect(areCollinear(a, b, c, 0)).toBe(false);
      // With tolerance 1e-6, the threshold is 1e-10 × 1e-6 = 1e-16, still not collinear.
      // We need a much larger tolerance to consider this collinear.
      expect(areCollinear(a, b, c, 1)).toBe(true); // 1e-10 × 1 = 1e-10, which equals |det|
    });
  });

  describe('areCocircular', () => {
    it('detects cocircular points', () => {
      const a: Coord = [0, 0];
      const b: Coord = [10, 0];
      const c: Coord = [10, 10];
      const d: Coord = [0, 10];
      expect(areCocircular(a, b, c, d)).toBe(true);
    });

    it('detects non-cocircular points', () => {
      const a: Coord = [0, 0];
      const b: Coord = [10, 0];
      const c: Coord = [5, 10];
      const d: Coord = [5, 3];
      expect(areCocircular(a, b, c, d)).toBe(false);
    });
  });
});
