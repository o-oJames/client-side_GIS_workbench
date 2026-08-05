// ---------------------------------------------------------------------------
// Session registry for file-based COG layers.
//
// Local GeoTIFF bytes are never copied into memory or IndexedDB: the OL
// GeoTIFF source fetches the blob URL with HTTP Range requests and streams
// only the IFDs/tiles it needs, so arbitrarily large files work. This
// registry keeps the blob URL (and the originating File reference) alive for
// the whole document lifetime so layers can be rebuilt after workspace
// switches. After a page reload the registry is empty and file COG layers
// cannot be restored — the user must re-add the file.
// ---------------------------------------------------------------------------

interface CogFileEntry {
  file: File;
  url: string;
}

/** Layer-id → live blob URL + originating File. */
const registry = new Map<string, CogFileEntry>();

/**
 * Register a File under a raster-layer id, creating (and returning) a blob
 * URL that reads the file on demand. Re-registering the same id revokes the
 * previous URL first.
 */
export function registerCogFile(layerId: string, file: File): string {
  const existing = registry.get(layerId);
  if (existing) URL.revokeObjectURL(existing.url);
  const url = URL.createObjectURL(file);
  registry.set(layerId, { file, url });
  return url;
}

/** Live blob URL for a registered file COG layer, if any. */
export function getCogFileUrl(layerId: string): string | undefined {
  return registry.get(layerId)?.url;
}

/** Revoke the blob URL and drop the entry (call when the layer is removed). */
export function releaseCogFile(layerId: string): void {
  const entry = registry.get(layerId);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  registry.delete(layerId);
}
