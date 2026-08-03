/**
 * resolveCogUrl — COG URL resolution per cogSource.
 *
 * File-based COGs are session-only: within the session the blob URL created
 * when the file was added is still valid and must be reused (this is the
 * path exercised when a file COG layer is edited and recreated). Only when
 * neither the blob URL nor the IndexedDB byte copy is available may it fail.
 */
import { resolveCogUrl } from './rasterLayerFactory';
import type { RasterLayer } from '../types';

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

  test('file source reuses the live blob URL', async () => {
    const blobUrl = 'blob:http://localhost:3000/12345';
    await expect(resolveCogUrl(cogLayer({ cogSource: 'file', url: blobUrl }))).resolves.toBe(blobUrl);
  });

  test('file source without blob URL or IDB bytes rejects', async () => {
    await expect(resolveCogUrl(cogLayer({ cogSource: 'file', url: '' })))
      .rejects.toThrow(/not persisted/);
  });

  test('file source with an IDB key but no stored bytes rejects', async () => {
    // jsdom has no IndexedDB, so the byte lookup comes back empty (after
    // retries) and the resolution must fail with the re-add guidance.
    await expect(resolveCogUrl(cogLayer({ cogSource: 'file', url: '', cogIdbKey: 'cog:ws:1:f.tif' })))
      .rejects.toThrow(/not persisted/);
  });
});
