/**
 * resolveCogUrl — COG URL resolution per cogSource.
 *
 * File-based COGs are session-only: their blob URL is kept alive in the
 * cogFileRegistry for the document lifetime (this is what lets the layer be
 * rebuilt across workspace switches). When the registry has no entry — e.g.
 * after a page reload — resolution must fail with re-add guidance.
 */
import { resolveCogUrl } from './rasterLayerFactory';
import { registerCogFile, releaseCogFile } from './cogFileRegistry';
import type { RasterLayer } from '../types';

// jsdom does not implement URL.createObjectURL / revokeObjectURL. Mocks are
// (re)installed in beforeEach: CRA's jest config sets resetMocks: true, which
// strips implementations from jest.fn() mocks before every test.
let nextBlobId = 0;
beforeEach(() => {
  (URL as any).createObjectURL = jest.fn(() => `blob:mock-${++nextBlobId}`);
  (URL as any).revokeObjectURL = jest.fn();
});

function cogLayer(over: Partial<RasterLayer> = {}): RasterLayer {
  return {
    id: 'c1',
    name: 'COG',
    type: 'cog',
    url: 'https://example.com/file.tif',
    cogSource: 'http',
    ...over,
  };
}

describe('resolveCogUrl', () => {
  test('http source returns the URL as-is', async () => {
    await expect(resolveCogUrl(cogLayer())).resolves.toBe('https://example.com/file.tif');
  });

  test('file source resolves via the session registry', async () => {
    const url = registerCogFile('file-layer-1', new File(['x'], 'a.tif'));
    // A stale persisted url must be ignored in favour of the live registry URL.
    await expect(resolveCogUrl(cogLayer({ id: 'file-layer-1', cogSource: 'file', url: 'blob:stale' })))
      .resolves.toBe(url);
    releaseCogFile('file-layer-1');
  });

  test('file source with no registry entry rejects (e.g. after reload)', async () => {
    await expect(resolveCogUrl(cogLayer({ id: 'gone', cogSource: 'file', url: '' })))
      .rejects.toThrow(/not persisted/);
  });

  test('file source whose entry was released rejects', async () => {
    registerCogFile('file-layer-2', new File(['x'], 'b.tif'));
    releaseCogFile('file-layer-2');
    await expect(resolveCogUrl(cogLayer({ id: 'file-layer-2', cogSource: 'file', url: '' })))
      .rejects.toThrow(/not persisted/);
  });
});
