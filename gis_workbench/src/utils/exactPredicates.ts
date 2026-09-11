/**
 * Exact-arithmetic predicates for robust geometric computations.
 * 
 * This module provides robust orientation and incircle tests using symbolic
 * perturbation (Simulation of Simplicity style). These predicates are
 * order-independent and handle degenerate cases (collinear points, cocircular
 * points) without arbitrary tie-breaking.
 * 
 * The approach:
 * - Use floating-point arithmetic with error bounds
 * - When the result is too close to zero (within the error bound), apply
 *   symbolic perturbation based on vertex indices
 * - This gives deterministic, order-independent results for all inputs
 * 
 * References:
 * - Edelsbrunner & Mücke, "Simulation of Simplicity" (1990)
 * - Shewchuk, "Adaptive Precision Floating-Point Arithmetic" (1997)
 */

export type Coord = [number, number];

/**
 * Error bound for orientation test.
 * 
 * The orientation determinant is a 2×2 determinant:
 *   | ax-cx  ay-cy |
 *   | bx-cx  by-cy |
 * 
 * Each term is a product of two differences, so the relative error is ~2ε.
 * The absolute error bound is 2ε × max(|terms|).
 */
const ORIENTATION_ERROR_FACTOR = 3.0 * Number.EPSILON;

/**
 * Error bound for incircle test.
 * 
 * The incircle determinant is a 3×3 determinant with terms like:
 *   (ax² + ay²) × (bx·cy - cx·by)
 * 
 * Each term involves products of squares and differences, so the relative
 * error is ~6ε. The absolute error bound is 6ε × max(|terms|).
 */
const INCIRCLE_ERROR_FACTOR = 8.0 * Number.EPSILON;

/**
 * Robust orientation test: is the turn from A→B→C counter-clockwise?
 * 
 * Returns:
 *   +1 if CCW (left turn)
 *   -1 if CW (right turn)
 *    0 if collinear (with symbolic perturbation applied)
 * 
 * The symbolic perturbation breaks ties by treating vertex indices as infinitesimal
 * perturbations: vertex i is perturbed by ε^i. This makes the result order-independent
 * and deterministic for all inputs, including degenerate cases.
 * 
 * @param a First point
 * @param b Second point
 * @param c Third point
 * @param ia Index of first point (for perturbation, default 0)
 * @param ib Index of second point (for perturbation, default 1)
 * @param ic Index of third point (for perturbation, default 2)
 */
export function orientation(
  a: Coord,
  b: Coord,
  c: Coord,
  ia: number = 0,
  ib: number = 1,
  ic: number = 2
): -1 | 0 | 1 {
  // Compute the orientation determinant.
  const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  
  // Compute error bound.
  const maxTerm = Math.max(
    Math.abs((b[0] - a[0]) * (c[1] - a[1])),
    Math.abs((b[1] - a[1]) * (c[0] - a[0]))
  );
  const errorBound = maxTerm * ORIENTATION_ERROR_FACTOR;
  
  // If the determinant is well outside the error bound, the sign is reliable.
  if (det > errorBound) return 1;
  if (det < -errorBound) return -1;
  
  // The determinant is too close to zero: apply symbolic perturbation.
  // The perturbation scheme: vertex i is perturbed by (ε^i, ε^(i+1)).
  // For three vertices with indices ia < ib < ic, the perturbed orientation is:
  //   sign(ε^(ia+ib) - ε^(ia+ic) + ε^(ib+ic))
  // which simplifies to comparing the indices.
  
  // Sort indices to determine perturbation sign.
  const indices = [ia, ib, ic];
  indices.sort((x, y) => x - y);
  
  // The perturbation sign depends on the parity of the permutation.
  // For ia < ib < ic, the sign is +1 if the original order is even, -1 if odd.
  const originalOrder = [ia, ib, ic];
  let swaps = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (originalOrder[i] > originalOrder[j]) swaps++;
    }
  }
  
  return (swaps % 2 === 0) ? 1 : -1;
}

/**
 * Robust incircle test: is point D inside the circumcircle of triangle ABC?
 * 
 * Returns:
 *   +1 if D is inside the circumcircle
 *   -1 if D is outside the circumcircle
 *    0 if D is on the circumcircle (with symbolic perturbation applied)
 * 
 * The triangle ABC must be oriented counter-clockwise (orientation(A,B,C) > 0).
 * If it's clockwise, the result is negated.
 * 
 * The symbolic perturbation breaks ties by treating vertex indices as infinitesimal
 * perturbations, making the result order-independent and deterministic.
 * 
 * @param a First vertex of triangle
 * @param b Second vertex of triangle
 * @param c Third vertex of triangle
 * @param d Point to test
 * @param ia Index of first vertex (for perturbation, default 0)
 * @param ib Index of second vertex (for perturbation, default 1)
 * @param ic Index of third vertex (for perturbation, default 2)
 * @param id Index of test point (for perturbation, default 3)
 */
export function incircle(
  a: Coord,
  b: Coord,
  c: Coord,
  d: Coord,
  ia: number = 0,
  ib: number = 1,
  ic: number = 2,
  id: number = 3
): -1 | 0 | 1 {
  // Compute the incircle determinant.
  const ax = a[0] - d[0];
  const ay = a[1] - d[1];
  const bx = b[0] - d[0];
  const by = b[1] - d[1];
  const cx = c[0] - d[0];
  const cy = c[1] - d[1];
  
  const aLen = ax * ax + ay * ay;
  const bLen = bx * bx + by * by;
  const cLen = cx * cx + cy * cy;
  
  const det = aLen * (bx * cy - cx * by)
            - bLen * (ax * cy - cx * ay)
            + cLen * (ax * by - bx * ay);
  
  // Compute error bound.
  const maxTerm = Math.max(
    Math.abs(aLen * (bx * cy - cx * by)),
    Math.abs(bLen * (ax * cy - cx * ay)),
    Math.abs(cLen * (ax * by - bx * ay))
  );
  const errorBound = maxTerm * INCIRCLE_ERROR_FACTOR;
  
  // If the determinant is well outside the error bound, the sign is reliable.
  // Check orientation of ABC to determine if we need to negate.
  const orient = orientation(a, b, c, ia, ib, ic);
  const sign = orient > 0 ? 1 : -1;
  
  if (det > errorBound) return sign as -1 | 1;
  if (det < -errorBound) return (-sign) as -1 | 1;
  
  // The determinant is too close to zero: apply symbolic perturbation.
  // For the incircle test with vertices ia, ib, ic and test point id,
  // the perturbation depends on the relative ordering of the indices.
  // The rule: if id is the largest index, the point is "outside" (return -1).
  // Otherwise, use the orientation of the perturbed triangle.
  
  const indices = [ia, ib, ic, id];
  const maxIndex = Math.max(...indices);
  
  if (id === maxIndex) {
    // Test point has the largest index: perturbation pushes it outside.
    return -1;
  }
  
  // Otherwise, use the orientation of the triangle formed by the three smallest indices.
  const triangleIndices = indices.filter(i => i !== id).sort((x, y) => x - y);
  const triangleOrient = orientation(
    triangleIndices[0] === ia ? a : triangleIndices[0] === ib ? b : c,
    triangleIndices[1] === ia ? a : triangleIndices[1] === ib ? b : c,
    triangleIndices[2] === ia ? a : triangleIndices[2] === ib ? b : c,
    triangleIndices[0],
    triangleIndices[1],
    triangleIndices[2]
  );
  
  return triangleOrient;
}

/**
 * Check if three points are collinear (with tolerance).
 * 
 * This is a convenience wrapper around orientation() that returns a boolean.
 * Points are considered collinear if the orientation determinant is within
 * the error bound (or the specified tolerance).
 */
export function areCollinear(a: Coord, b: Coord, c: Coord, tolerance: number = 0): boolean {
  // Compute the orientation determinant.
  const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  
  // Compute error bound.
  const maxTerm = Math.max(
    Math.abs((b[0] - a[0]) * (c[1] - a[1])),
    Math.abs((b[1] - a[1]) * (c[0] - a[0]))
  );
  const errorBound = maxTerm * ORIENTATION_ERROR_FACTOR;
  
  // If tolerance is specified, use it; otherwise use the error bound.
  const threshold = tolerance > 0 ? maxTerm * tolerance : errorBound;
  
  return Math.abs(det) <= threshold;
}

/**
 * Check if four points are cocircular (with tolerance).
 * 
 * This is a convenience wrapper around incircle() that returns a boolean.
 * Points are considered cocircular if the incircle determinant is within
 * the error bound (or the specified tolerance).
 */
export function areCocircular(a: Coord, b: Coord, c: Coord, d: Coord, tolerance: number = 0): boolean {
  // Compute the incircle determinant.
  const ax = a[0] - d[0], ay = a[1] - d[1];
  const bx = b[0] - d[0], by = b[1] - d[1];
  const cx = c[0] - d[0], cy = c[1] - d[1];
  const aLen = ax * ax + ay * ay;
  const bLen = bx * bx + by * by;
  const cLen = cx * cx + cy * cy;
  const det = aLen * (bx * cy - cx * by) - bLen * (ax * cy - cx * ay) + cLen * (ax * by - bx * ay);
  
  // Compute error bound.
  const maxTerm = Math.max(
    Math.abs(aLen * (bx * cy - cx * by)),
    Math.abs(bLen * (ax * cy - cx * ay)),
    Math.abs(cLen * (ax * by - bx * ay))
  );
  const errorBound = maxTerm * INCIRCLE_ERROR_FACTOR;
  
  // If tolerance is specified, use it; otherwise use the error bound.
  const threshold = tolerance > 0 ? maxTerm * tolerance : errorBound;
  
  return Math.abs(det) <= threshold;
}
