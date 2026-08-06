/**
 * Tests for utils/layerRestore.
 *
 * Focus: sortRestoredVectorLayers - the helper that puts restored vector
 * layers back into the persisted config order after the per-type restore
 * buckets (MVT / WFS / STAC / drawn / file) have been collected.
 */
import { sortRestoredVectorLayers } from './layerRestore';
import type { VectorLayerConfig } from '../types';

/** Minimal config fixture (only the fields the sort reads matter). */
const cfg = (id: string, extra: Partial<VectorLayerConfig> = {}): VectorLayerConfig => ({
  id,
  name: id,
  type: 'geojson',
  visible: true,
  ...extra,
});

describe('sortRestoredVectorLayers', () => {
  it('keeps a drawn layer dragged below a file layer below it (regression)', () => {
    // Persisted order after the drag: drawn, file, drawn. The type buckets
    // restore both drawn layers first and the file layer last - the sort
    // must restore the persisted stacking, not the bucket stacking.
    const persisted = [cfg('drawn-1', { isDrawnInApp: true }), cfg('file-1', { geometryIdbKey: 'k1' }), cfg('drawn-2', { isDrawnInApp: true })];
    const restored = [
      cfg('drawn-1', { isDrawnInApp: true, olLayer: 'OL-d1' }),
      cfg('drawn-2', { isDrawnInApp: true, olLayer: 'OL-d2' }),
      cfg('file-1', { geometryIdbKey: 'k1', olLayer: 'OL-f1' }),
    ];
    const sorted = sortRestoredVectorLayers(restored, persisted);
    expect(sorted.map(l => l.id)).toEqual(['drawn-1', 'file-1', 'drawn-2']);
    // The SAME config objects (with their olLayer refs) come back.
    expect(sorted[1]).toBe(restored[2]);
  });

  it('preserves an arbitrary interleaving across all five type buckets', () => {
    const persisted = [
      cfg('file-a', { geometryIdbKey: 'ka' }),
      cfg('mvt-a', { type: 'mvt' }),
      cfg('drawn-a', { isDrawnInApp: true }),
      cfg('wfs-a', { type: 'wfs' }),
      cfg('file-b', { geometryIdbKey: 'kb' }),
      cfg('stac-a', { type: 'stac' }),
      cfg('mvt-b', { type: 'mvt' }),
    ];
    // Bucket order: mvt, wfs, stac, drawn, file.
    const restored = [
      persisted[1], persisted[6], // mvt-a, mvt-b
      persisted[3],               // wfs-a
      persisted[5],               // stac-a
      persisted[2],               // drawn-a
      persisted[0], persisted[4], // file-a, file-b
    ];
    const sorted = sortRestoredVectorLayers(restored, persisted);
    expect(sorted.map(l => l.id)).toEqual(['file-a', 'mvt-a', 'drawn-a', 'wfs-a', 'file-b', 'stac-a', 'mvt-b']);
  });

  it('skips persisted configs that failed to restore', () => {
    const persisted = [cfg('a'), cfg('b', { geometryIdbKey: 'gone' }), cfg('c')];
    const restored = [cfg('c'), cfg('a')]; // 'b' had no IDB geometry
    const sorted = sortRestoredVectorLayers(restored, persisted);
    expect(sorted.map(l => l.id)).toEqual(['a', 'c']);
  });

  it('appends restored layers missing from the persisted configs, keeping their relative order', () => {
    const persisted = [cfg('a')];
    const restored = [cfg('x'), cfg('a'), cfg('y')];
    const sorted = sortRestoredVectorLayers(restored, persisted);
    expect(sorted.map(l => l.id)).toEqual(['a', 'x', 'y']);
  });

  it('handles empty inputs', () => {
    expect(sortRestoredVectorLayers([], [])).toEqual([]);
    expect(sortRestoredVectorLayers([cfg('a')], [])).toEqual([expect.objectContaining({ id: 'a' })]);
    expect(sortRestoredVectorLayers([], [cfg('a')])).toEqual([]);
  });
});
