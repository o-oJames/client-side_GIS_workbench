/**
 * validateCogBuffer — COG header validation, including the truncated-header
 * mode used for large local files (only the first COG_HEADER_VALIDATION_BYTES
 * are read; `totalSize` carries the real file size).
 */
import { validateCogBuffer, COG_HEADER_VALIDATION_BYTES, MAX_NON_COG_TIFF_SIZE } from './cogHelpers';

/** Build a minimal little-endian classic TIFF with a 2-entry first IFD. */
function classicTiff(ifdOffset: number, tags: number[]): ArrayBuffer {
  const size = ifdOffset + 2 + tags.length * 12 + 4;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); // 'II'
  dv.setUint16(2, 42, true);                  // classic TIFF magic
  dv.setUint32(4, ifdOffset, true);
  dv.setUint16(ifdOffset, tags.length, true);
  tags.forEach((tag, i) => {
    const e = ifdOffset + 2 + i * 12;
    dv.setUint16(e, tag, true);      // tag
    dv.setUint16(e + 2, 3, true);    // SHORT
    dv.setUint32(e + 4, 1, true);    // count
    dv.setUint32(e + 8, 256, true);  // value
  });
  return buf;
}

/** Build a minimal little-endian BigTIFF with a 2-entry first IFD. */
function bigTiff(ifdOffset: number, tags: number[]): ArrayBuffer {
  const size = ifdOffset + 8 + tags.length * 20 + 8;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); // 'II'
  dv.setUint16(2, 43, true);                  // BigTIFF magic
  dv.setUint16(4, 8, true);                   // offset bytesize
  dv.setUint32(8, ifdOffset, true);           // first IFD offset (low 4 bytes)
  dv.setUint32(ifdOffset, tags.length, true); // entry count (low 4 bytes)
  tags.forEach((tag, i) => {
    const e = ifdOffset + 8 + i * 20;
    dv.setUint16(e, tag, true);      // tag
    dv.setUint16(e + 2, 3, true);    // SHORT
    dv.setUint32(e + 4, 1, true);    // count (low 4 bytes)
    dv.setUint32(e + 12, 256, true); // value (first 4 bytes of the 8-byte field)
  });
  return buf;
}

const TILED_TAGS = [322, 323];        // TileWidth + TileLength → COG
const STRIP_TAGS = [278];             // RowsPerStrip → strip-based, not COG

describe('validateCogBuffer', () => {
  test('rejects non-TIFF bytes', () => {
    const v = validateCogBuffer(new ArrayBuffer(64), 'x.bin');
    expect(v.isTiff).toBe(false);
    expect(v.error).toBeTruthy();
  });

  test('detects a tiled classic TIFF as COG (full buffer)', () => {
    const v = validateCogBuffer(classicTiff(8, TILED_TAGS), 'a.tif');
    expect(v.isTiff).toBe(true);
    expect(v.isCog).toBe(true);
    expect(v.fileSize).toBe(8 + 2 + 24 + 4);
  });

  test('detects a tiled BigTIFF as COG (40 GB file, 2 MB header slice)', () => {
    const total = 40 * 1024 * 1024 * 1024; // ~40 GB
    const header = bigTiff(16, TILED_TAGS);
    expect(header.byteLength).toBeLessThan(COG_HEADER_VALIDATION_BYTES);
    const v = validateCogBuffer(header, 'huge.tif', total);
    expect(v.isTiff).toBe(true);
    expect(v.isBigTiff).toBe(true);
    expect(v.isCog).toBe(true);
    expect(v.fileSize).toBe(total);
    expect(v.error).toBeUndefined();
  });

  test('strip-based TIFF over the size limit is rejected with guidance', () => {
    const total = MAX_NON_COG_TIFF_SIZE + 1;
    const v = validateCogBuffer(classicTiff(8, STRIP_TAGS), 'big.tif', total);
    expect(v.isCog).toBe(false);
    expect(v.error).toMatch(/too large to render/i);
  });

  test('IFD beyond the header slice is treated as non-COG', () => {
    // A strip-based TIFF whose IFD sits at the end of the file: the 2 MB
    // slice never reaches it, so COG detection must fail safely.
    const ifdOffset = COG_HEADER_VALIDATION_BYTES + 1024;
    const full = classicTiff(ifdOffset, STRIP_TAGS);
    const slice = full.slice(0, COG_HEADER_VALIDATION_BYTES);
    const total = 4 * 1024 * 1024 * 1024; // > 50 MB → blocking error
    const v = validateCogBuffer(slice, 'far-ifd.tif', total);
    expect(v.isTiff).toBe(true);
    expect(v.isCog).toBe(false);
    expect(v.error).toMatch(/too large to render/i);
  });

  test('IFD offset beyond the real file size is corrupt', () => {
    const buf = classicTiff(8, TILED_TAGS);
    // Real file ends exactly where the IFD claims to start → corrupt.
    const v = validateCogBuffer(buf, 'bad.tif', 8);
    expect(v.isTiff).toBe(true);
    expect(v.isCog).toBe(false);
    expect(v.error).toMatch(/IFD offset exceeds file size/);
  });

  test('small strip-based TIFF reports a warning but is loadable', () => {
    const v = validateCogBuffer(classicTiff(8, STRIP_TAGS), 'small.tif');
    expect(v.isTiff).toBe(true);
    expect(v.isCog).toBe(false);
    expect(v.error).toMatch(/strip-based/i);
  });
});
