/**
 * Tests for the box-selection geometry helpers and the extent feature query.
 */
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { intersects as extentsIntersect } from 'ol/extent.js';
import {
  BoxExtent,
  BOX_HANDLES,
  normalizeExtent,
  moveExtent,
  resizeExtent,
  extentToPixelRect,
  clampRectToSize,
  cropCanvasToRect,
  extractFeatureMetadata,
  collectVectorHitsInExtent,
} from './boxSelection';

describe('normalizeExtent', () => {
  test('orders any two corners into [minX, minY, maxX, maxY]', () => {
    expect(normalizeExtent([10, 20], [1, 2])).toEqual([1, 2, 10, 20]);
    expect(normalizeExtent([1, 2], [10, 20])).toEqual([1, 2, 10, 20]);
    expect(normalizeExtent([5, 5], [5, 5])).toEqual([5, 5, 5, 5]);
  });
});

describe('moveExtent', () => {
  test('translates all four edges', () => {
    expect(moveExtent([0, 0, 10, 10], 3, -2)).toEqual([3, -2, 13, 8]);
  });
});

describe('resizeExtent', () => {
  const box: BoxExtent = [0, 0, 10, 10];

  test('edge handles move only their edge', () => {
    expect(resizeExtent(box, 'w', 2, 99)).toEqual([2, 0, 10, 10]);
    expect(resizeExtent(box, 'e', 2, 99)).toEqual([0, 0, 12, 10]);
    expect(resizeExtent(box, 's', 99, 2)).toEqual([0, 2, 10, 10]);
    expect(resizeExtent(box, 'n', 99, 2)).toEqual([0, 0, 10, 12]);
  });

  test('corner handles move both adjacent edges', () => {
    expect(resizeExtent(box, 'nw', -1, 1)).toEqual([-1, 0, 10, 11]);
    expect(resizeExtent(box, 'se', 1, -1)).toEqual([0, -1, 11, 10]);
  });

  test('edges never cross their opposite (minSize clamp)', () => {
    expect(resizeExtent(box, 'w', 50, 0, 1)).toEqual([9, 0, 10, 10]);
    expect(resizeExtent(box, 'e', -50, 0, 1)).toEqual([0, 0, 1, 10]);
    expect(resizeExtent(box, 'n', 0, -50, 1)).toEqual([0, 0, 10, 1]);
    expect(resizeExtent(box, 's', 0, 50, 1)).toEqual([0, 9, 10, 10]);
  });

  test('all eight handles are accepted', () => {
    BOX_HANDLES.forEach((h) => {
      const next = resizeExtent(box, h, 1, 1);
      expect(next).toHaveLength(4);
      expect(next[0]).toBeLessThanOrEqual(next[2]);
      expect(next[1]).toBeLessThanOrEqual(next[3]);
    });
  });
});

describe('extentToPixelRect', () => {
  test('projects extent corners with a y-flipping projection', () => {
    // Mimics map.getPixelFromCoordinate: x unchanged, y flipped at 100px.
    const project = (c: [number, number]): [number, number] => [c[0], 100 - c[1]];
    const rect = extentToPixelRect([10, 20, 40, 70], project);
    expect(rect).toEqual({ left: 10, top: 30, width: 30, height: 50 });
  });
});

describe('clampRectToSize', () => {
  test('returns the rect unchanged when fully inside', () => {
    expect(clampRectToSize({ left: 5, top: 5, width: 10, height: 10 }, 100, 100))
      .toEqual({ left: 5, top: 5, width: 10, height: 10 });
  });

  test('clips the portion outside', () => {
    expect(clampRectToSize({ left: -5, top: 90, width: 20, height: 20 }, 100, 100))
      .toEqual({ left: 0, top: 90, width: 15, height: 10 });
  });

  test('returns null when fully outside', () => {
    expect(clampRectToSize({ left: 200, top: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
    expect(clampRectToSize({ left: 0, top: -30, width: 10, height: 10 }, 100, 100)).toBeNull();
  });
});

describe('cropCanvasToRect', () => {
  test('creates a canvas sized to the rect', () => {
    const source = document.createElement('canvas');
    source.width = 200;
    source.height = 100;
    const cropped = cropCanvasToRect(source, { left: 10.4, top: 20.6, width: 50.4, height: 30.2 });
    expect(cropped.width).toBe(50);
    expect(cropped.height).toBe(30);
  });

  test('never produces a zero-sized canvas', () => {
    const source = document.createElement('canvas');
    const cropped = cropCanvasToRect(source, { left: 0, top: 0, width: 0.4, height: 0.2 });
    expect(cropped.width).toBe(1);
    expect(cropped.height).toBe(1);
  });
});

describe('extractFeatureMetadata', () => {
  test('keeps plain properties, drops geometry and OL objects', () => {
    const feature = new Feature({ geometry: new Point([0, 0]), name: 'A', value: 42 });
    const metadata = extractFeatureMetadata(feature);
    expect(metadata).toEqual({ name: 'A', value: 42 });
  });

  test('returns an empty object for attribute-less features', () => {
    expect(extractFeatureMetadata(new Feature(new Point([0, 0])))).toEqual({});
  });
});

describe('collectVectorHitsInExtent', () => {
  const pointFeature = (coord: [number, number], props: Record<string, any>) => {
    const f = new Feature(new Point(coord));
    f.setProperties(props);
    return f;
  };

  // Fake vector source using a genuine extent intersection test.
  const vectorSource = (features: any[]) => ({
    forEachFeatureIntersectingExtent: (extent: number[], cb: (f: any) => void) => {
      features.forEach((f) => {
        const g = f.getGeometry();
        if (g && extentsIntersect(g.getExtent(), extent)) cb(f);
      });
    },
  });

  const vectorLayer = (features: any[], visible = true) => ({
    getVisible: () => visible,
    getSource: () => vectorSource(features),
  });

  const fakeMap = (layers: any[]) => ({
    getLayers: () => ({ getArray: () => layers }),
  });

  test('collects features intersecting the extent, skipping outside ones', () => {
    const inside = pointFeature([5, 5], { id: 1 });
    const outside = pointFeature([50, 50], { id: 2 });
    const map = fakeMap([vectorLayer([inside, outside])]);

    const { hitsByLayer, totalCount, truncated } = collectVectorHitsInExtent(map, [0, 0, 10, 10]);
    expect(totalCount).toBe(1);
    expect(truncated).toBe(false);
    const layer = Array.from(hitsByLayer.keys())[0];
    expect(hitsByLayer.get(layer)![0].feature).toBe(inside);
    expect(hitsByLayer.get(layer)![0].metadata).toEqual({ id: 1 });
  });

  test('polygon features count when the box overlaps them', () => {
    const poly = new Feature(new Polygon([[[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]]]));
    poly.set('name', 'zone');
    const map = fakeMap([vectorLayer([poly])]);
    const { totalCount } = collectVectorHitsInExtent(map, [5, 5, 20, 20]);
    expect(totalCount).toBe(1);
  });

  test('skips hidden layers and non-vector sources', () => {
    const inside = pointFeature([5, 5], { id: 1 });
    const map = fakeMap([
      vectorLayer([inside], false),
      { getVisible: () => true, getSource: () => ({}) }, // no extent query API
    ]);
    const { totalCount } = collectVectorHitsInExtent(map, [0, 0, 10, 10]);
    expect(totalCount).toBe(0);
  });

  test('expands cluster bubbles into their member features', () => {
    const memberA = pointFeature([5, 5], { id: 'a' });
    const memberB = pointFeature([5, 5], { id: 'b' });
    const cluster = pointFeature([5, 5], {});
    cluster.set('features', [memberA, memberB]);
    const map = fakeMap([vectorLayer([cluster])]);

    const { hitsByLayer, totalCount } = collectVectorHitsInExtent(map, [0, 0, 10, 10]);
    expect(totalCount).toBe(2);
    const entries = Array.from(hitsByLayer.values())[0];
    expect(entries.map((e) => e.metadata.id)).toEqual(['a', 'b']);
  });

  test('supports vector-tile sources via getFeaturesInExtent', () => {
    const inside = pointFeature([5, 5], { id: 'mvt' });
    const layer = {
      getVisible: () => true,
      getSource: () => ({ getFeaturesInExtent: (extent: number[]) => {
        const g = inside.getGeometry();
        return g && extentsIntersect(g.getExtent(), extent) ? [inside] : [];
      } }),
    };
    const { totalCount } = collectVectorHitsInExtent(fakeMap([layer]), [0, 0, 10, 10]);
    expect(totalCount).toBe(1);
  });

  test('dedupes features reported twice', () => {
    const inside = pointFeature([5, 5], { id: 1 });
    const layer = {
      getVisible: () => true,
      getSource: () => ({
        forEachFeatureIntersectingExtent: (_e: number[], cb: (f: any) => void) => {
          cb(inside);
          cb(inside); // style parts can report the same feature twice
        },
      }),
    };
    const { totalCount } = collectVectorHitsInExtent(fakeMap([layer]), [0, 0, 10, 10]);
    expect(totalCount).toBe(1);
  });

  test('caps the hits at maxFeatures and flags truncation', () => {
    const features = Array.from({ length: 10 }, (_, i) => pointFeature([5, 5], { id: i }));
    const map = fakeMap([vectorLayer(features)]);
    const { totalCount, truncated } = collectVectorHitsInExtent(map, [0, 0, 10, 10], 4);
    expect(totalCount).toBe(4);
    expect(truncated).toBe(true);
  });

  test('orders layers topmost-first', () => {
    const bottom = pointFeature([5, 5], { id: 'bottom' });
    const top = pointFeature([5, 5], { id: 'top' });
    const map = fakeMap([vectorLayer([bottom]), vectorLayer([top])]);
    const { hitsByLayer } = collectVectorHitsInExtent(map, [0, 0, 10, 10]);
    const sections = Array.from(hitsByLayer.values());
    expect(sections).toHaveLength(2);
    expect(sections[0][0].metadata.id).toBe('top');
    expect(sections[1][0].metadata.id).toBe('bottom');
  });
});
