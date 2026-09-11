# JTS Integration and Single-Sided Buffer Implementation Plan

## Overview

This document outlines the plan for integrating the JTS (Java Topology Suite) JavaScript port and implementing single-sided buffer functionality for the Vector Tools panel.

## Part 1: JTS Integration

### What is JTS?

JTS (Java Topology Suite) is a robust geometry library that provides:
- Advanced geometric operations (buffer, union, intersection, etc.)
- Topology validation and repair
- Precision geometry operations
- Single-sided buffers
- And many other GIS operations

The JavaScript port (`jsts`) brings these capabilities to the browser.

### Why Integrate JTS?

Our current hand-written geometry kernel works well for basic operations but has limitations:
1. **Single-sided buffers** - Not currently supported
2. **Complex topology operations** - May have edge cases
3. **Geometry validation** - Could be more robust
4. **Advanced operations** - Things like `isValidDetail`, `ST_Polygonize`, etc.

### Implementation Strategy

#### Phase 1: Add JTS as a Dependency

```bash
npm install jsts --save
```

This adds ~500KB to the bundle size but provides enterprise-grade geometry operations.

#### Phase 2: Create a JTS Bridge Module

Create `src/utils/jstsBridge.ts` to:
1. Convert between our `GeoGeom` types and JTS geometry objects
2. Provide wrapper functions for JTS operations
3. Handle error cases gracefully

```typescript
// Example structure
import jsts from 'jsts';

export function toJSTSGeometry(geom: GeoGeom): jsts.geom.Geometry {
  // Convert our geometry to JTS geometry
}

export function fromJSTSGeometry(geom: jsts.geom.Geometry): GeoGeom {
  // Convert JTS geometry back to our format
}

export function jstsBuffer(geom: GeoGeom, distance: number, options?: BufferOptions): GeoGeom {
  // Use JTS buffer operation
}
```

#### Phase 3: Integrate JTS Buffer

Replace the current buffer implementation with JTS:

```typescript
export function bufferGeometry(geom: GeoGeom, distance: number, options?: BufferOptions): GeoGeom | null {
  // For simple cases, use our fast implementation
  if (isSimpleCase(geom, options)) {
    return currentBufferImplementation(geom, distance, options);
  }
  
  // For complex cases or single-sided buffers, use JTS
  const jstsGeom = toJSTSGeometry(geom);
  const bufferParams = new jsts.operation.buffer.BufferParameters();
  
  // Set buffer parameters
  if (options?.singleSided) {
    bufferParams.setSingleSided(true);
  }
  if (options?.endCapStyle) {
    bufferParams.setEndCapStyle(mapEndCapStyle(options.endCapStyle));
  }
  if (options?.joinStyle) {
    bufferParams.setJoinStyle(mapJoinStyle(options.joinStyle));
  }
  
  const bufferOp = new jsts.operation.buffer.BufferOp(jstsGeom);
  bufferOp.setBufferParameters(bufferParams);
  const result = bufferOp.getResultGeometry(distance);
  
  return fromJSTSGeometry(result);
}
```

#### Phase 4: Add Single-Sided Buffer Support

Update the buffer tool UI to support single-sided buffers:

1. Add a "Side" dropdown to the buffer tool:
   - Both sides (default)
   - Left side only
   - Right side only

2. Pass the side parameter through to the buffer function

3. JTS handles the complex geometry operations automatically

### Benefits of JTS Integration

1. **Robustness** - JTS is battle-tested in production GIS systems
2. **Single-sided buffers** - Native support
3. **Advanced operations** - Access to many more geometry operations
4. **Better validation** - More thorough geometry validation
5. **Future-proof** - Easy to add more JTS operations later

### Trade-offs

1. **Bundle size** - Adds ~500KB to the bundle
2. **Performance** - JTS may be slower for simple cases (mitigated by using our fast path for simple cases)
3. **Complexity** - Need to maintain the bridge between our types and JTS types

### Migration Strategy

To minimize risk:
1. Keep the current implementation as a fallback
2. Use JTS only for operations it excels at (single-sided buffers, complex topology)
3. Gradually migrate more operations to JTS as we gain confidence
4. Comprehensive testing with the GEOS golden tests to ensure correctness

---

## Part 2: Single-Sided Buffer Implementation

### What is a Single-Sided Buffer?

A single-sided buffer creates a buffer on only one side of a line or polygon boundary:
- **Left side** - Buffer extends to the left of the line direction
- **Right side** - Buffer extends to the right of the line direction

This is useful for:
- Road widening (add lanes on one side)
- Setback lines (property boundaries)
- River bank analysis (flood zone on one side)
- Building setbacks from property lines

### Current State

Our current buffer implementation:
- ✅ Supports positive and negative distances
- ✅ Supports different end cap styles (round, flat, square)
- ✅ Supports different join styles (round, miter, bevel)
- ✅ Supports dissolve and separate disjoint parts
- ❌ Does NOT support single-sided buffers

### Implementation with JTS

JTS provides native support for single-sided buffers through `BufferParameters.setSingleSided(true)`.

#### Step 1: Update BufferOptions Interface

```typescript
export interface BufferOptions {
  // ... existing options ...
  
  /**
   * Buffer only one side of the geometry.
   * - 'both': Buffer both sides (default)
   * - 'left': Buffer only the left side
   * - 'right': Buffer only the right side
   */
  side?: 'both' | 'left' | 'right';
}
```

#### Step 2: Update Buffer UI

Add a "Side" dropdown to the buffer tool in `GeoProcessingPanel.tsx`:

```tsx
{selectedTool === 'buffer' && (
  <>
    {/* ... existing buffer controls ... */}
    
    <div className="gp-form-row">
      <label className="gp-form-label">Buffer side</label>
      <CustomSelect
        value={bufferSide}
        onChange={setBufferSide}
        options={[
          { value: 'both', label: 'Both sides' },
          { value: 'left', label: 'Left side only' },
          { value: 'right', label: 'Right side only' },
        ]}
      />
      <div className="gp-form-hint">
        {bufferSide === 'both' && 'Buffer extends on both sides of the geometry.'}
        {bufferSide === 'left' && 'Buffer extends only on the left side of lines (or outside of polygons).'}
        {bufferSide === 'right' && 'Buffer extends only on the right side of lines (or inside of polygons).'}
      </div>
    </div>
  </>
)}
```

#### Step 3: Update Buffer Function

```typescript
export function bufferGeometry(geom: GeoGeom, distance: number, options?: BufferOptions): GeoGeom | null {
  const side = options?.side ?? 'both';
  
  // For single-sided buffers, use JTS
  if (side !== 'both') {
    return jstsSingleSidedBuffer(geom, distance, side, options);
  }
  
  // For both sides, use our fast implementation (or JTS for complex cases)
  return currentBufferImplementation(geom, distance, options);
}

function jstsSingleSidedBuffer(
  geom: GeoGeom,
  distance: number,
  side: 'left' | 'right',
  options?: BufferOptions
): GeoGeom | null {
  const jstsGeom = toJSTSGeometry(geom);
  const bufferParams = new jsts.operation.buffer.BufferParameters();
  
  bufferParams.setSingleSided(true);
  
  // Set other parameters
  if (options?.endCapStyle) {
    bufferParams.setEndCapStyle(mapEndCapStyle(options.endCapStyle));
  }
  if (options?.joinStyle) {
    bufferParams.setJoinStyle(mapJoinStyle(options.joinStyle));
  }
  if (options?.segments) {
    bufferParams.setQuadrantSegments(options.segments);
  }
  
  // For right side, negate the distance
  const bufferDistance = side === 'right' ? -distance : distance;
  
  const bufferOp = new jsts.operation.buffer.BufferOp(jstsGeom);
  bufferOp.setBufferParameters(bufferParams);
  const result = bufferOp.getResultGeometry(bufferDistance);
  
  return fromJSTSGeometry(result);
}
```

#### Step 4: Add Tests

Create comprehensive tests for single-sided buffers:

```typescript
describe('single-sided buffer', () => {
  it('buffers a line on the left side only', () => {
    const line = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
    const result = bufferGeometry(line, 2, { side: 'left' });
    
    // Result should be a polygon above the line (left side when going from (0,0) to (10,0))
    expect(result?.type).toBe('Polygon');
    const coords = (result as any).coordinates[0];
    expect(coords.every(([x, y]) => y >= 0)).toBe(true);
  });
  
  it('buffers a line on the right side only', () => {
    const line = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
    const result = bufferGeometry(line, 2, { side: 'right' });
    
    // Result should be a polygon below the line (right side)
    expect(result?.type).toBe('Polygon');
    const coords = (result as any).coordinates[0];
    expect(coords.every(([x, y]) => y <= 0)).toBe(true);
  });
  
  it('buffers a polygon on the outside (left side)', () => {
    const polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    const result = bufferGeometry(polygon, 2, { side: 'left' });
    
    // For polygons, left side means outside
    expect(result?.type).toBe('Polygon');
    // Result should be larger than the original
    const originalArea = polygonArea(polygon);
    const resultArea = polygonArea(result!);
    expect(resultArea).toBeGreaterThan(originalArea);
  });
  
  it('buffers a polygon on the inside (right side)', () => {
    const polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    const result = bufferGeometry(polygon, 2, { side: 'right' });
    
    // For polygons, right side means inside
    expect(result?.type).toBe('Polygon');
    // Result should be smaller than the original
    const originalArea = polygonArea(polygon);
    const resultArea = polygonArea(result!);
    expect(resultArea).toBeLessThan(originalArea);
  });
});
```

### Implementation Order

1. **Add JTS dependency** - `npm install jsts`
2. **Create JTS bridge module** - `src/utils/jstsBridge.ts`
3. **Add JTS buffer function** - Implement `jstsBuffer` and `jstsSingleSidedBuffer`
4. **Update BufferOptions** - Add `side` parameter
5. **Update buffer UI** - Add side dropdown
6. **Update buffer function** - Route to JTS for single-sided buffers
7. **Add tests** - Comprehensive test coverage
8. **Update documentation** - Update AGENTS.md and README.md

### Testing Strategy

1. **Unit tests** - Test single-sided buffer with various geometries
2. **GEOS golden tests** - Compare JTS output with GEOS/QGIS output
3. **Integration tests** - Test the full buffer workflow in the UI
4. **Performance tests** - Ensure JTS doesn't significantly slow down common operations

### Risk Mitigation

1. **Fallback** - Keep the current implementation as a fallback for simple cases
2. **Gradual rollout** - Start with single-sided buffers only, then expand
3. **Comprehensive testing** - Use GEOS golden tests to verify correctness
4. **Performance monitoring** - Monitor bundle size and performance impact

---

## Summary

### JTS Integration
- **What**: Add JTS library for advanced geometry operations
- **Why**: Robustness, single-sided buffers, advanced operations
- **How**: Create bridge module, integrate buffer operations, gradual migration
- **Impact**: +500KB bundle size, better correctness, more features

### Single-Sided Buffer
- **What**: Buffer only one side of a geometry
- **Why**: Useful for road widening, setbacks, bank analysis
- **How**: Use JTS `setSingleSided(true)`, add UI control
- **Impact**: New feature, requires JTS integration

### Next Steps

1. Review and approve this plan
2. Install JTS dependency
3. Implement JTS bridge module
4. Add single-sided buffer support
5. Test thoroughly with GEOS golden tests
6. Update documentation

---

## Questions for Consideration

1. **Bundle size**: Is 500KB acceptable for the added functionality?
2. **Performance**: Should we keep the fast path for simple cases?
3. **Scope**: Should we integrate more JTS operations beyond buffer?
4. **Timeline**: Should we implement this incrementally or all at once?

Please review this plan and let me know if you'd like to proceed with the implementation or if you have any questions or concerns.
