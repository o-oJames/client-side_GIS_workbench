/**
 * cogFileRegistry — session blob-URL registry for file-based COG layers.
 */
import { registerCogFile, getCogFileUrl, releaseCogFile } from './cogFileRegistry';

// jsdom does not implement URL.createObjectURL / revokeObjectURL. Mocks are
// (re)installed in beforeEach: CRA's jest config sets resetMocks: true, which
// strips implementations from jest.fn() mocks before every test.
let nextBlobId = 0;
beforeEach(() => {
  (URL as any).createObjectURL = jest.fn(() => `blob:mock-${++nextBlobId}`);
  (URL as any).revokeObjectURL = jest.fn();
});

describe('cogFileRegistry', () => {
  test('register returns a blob URL that getCogFileUrl resolves', () => {
    const url = registerCogFile('layer-1', new File(['x'], 'a.tif'));
    expect(url).toMatch(/^blob:/);
    expect(getCogFileUrl('layer-1')).toBe(url);
    releaseCogFile('layer-1');
  });

  test('re-registering the same id revokes the previous URL', () => {
    const first = registerCogFile('layer-2', new File(['x'], 'a.tif'));
    const second = registerCogFile('layer-2', new File(['y'], 'b.tif'));
    expect(second).not.toBe(first);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(getCogFileUrl('layer-2')).toBe(second);
    releaseCogFile('layer-2');
  });

  test('releaseCogFile revokes the URL and drops the entry', () => {
    const url = registerCogFile('layer-3', new File(['x'], 'a.tif'));
    releaseCogFile('layer-3');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    expect(getCogFileUrl('layer-3')).toBeUndefined();
  });

  test('unknown ids are harmless', () => {
    expect(getCogFileUrl('never-registered')).toBeUndefined();
    expect(() => releaseCogFile('never-registered')).not.toThrow();
  });
});
