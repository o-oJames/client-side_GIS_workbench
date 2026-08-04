// ---------------------------------------------------------------------------
// snapOriginalStore — temporary IndexedDB stash of the *original* outline of
// a magic-wand traced polygon. SAM mask outlines are jaggy; the committed
// polygon can be re-simplified at any time while it lives in the draw batch,
// so the as-traced rings are kept here until the batch is saved to a layer
// (or the feature is removed / the toolbar hidden / the workspace deleted).
// ---------------------------------------------------------------------------

import { idbPut, idbGet, idbDelete } from './idb';

/** The stashed original of one traced polygon. */
export interface SnapOriginal {
  /** As-traced polygon rings in map coordinates (EPSG:3857). */
  rings: number[][][];
  /** Map units per SAM encoder pixel at capture time — scales the
   * simplification tolerance of the clean-up slider. */
  meterPerPx: number;
}

export function snapOriginalKey(workspaceId: string, featureId: string): string {
  return `snap-original:${workspaceId}:${featureId}`;
}

export async function saveSnapOriginal(
  workspaceId: string,
  featureId: string,
  original: SnapOriginal,
): Promise<void> {
  try {
    await idbPut(snapOriginalKey(workspaceId, featureId), JSON.stringify(original));
  } catch (e) {
    console.warn('[SnapOriginalStore] failed to stash the original outline:', e);
  }
}

export async function loadSnapOriginal(
  workspaceId: string,
  featureId: string,
): Promise<SnapOriginal | null> {
  try {
    const raw = await idbGet(snapOriginalKey(workspaceId, featureId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rings) || typeof parsed.meterPerPx !== 'number') return null;
    return parsed as SnapOriginal;
  } catch (e) {
    console.warn('[SnapOriginalStore] failed to read the original outline:', e);
    return null;
  }
}

export async function deleteSnapOriginal(workspaceId: string, featureId: string): Promise<void> {
  try {
    await idbDelete(snapOriginalKey(workspaceId, featureId));
  } catch (e) {
    console.warn('[SnapOriginalStore] failed to delete the original outline:', e);
  }
}
