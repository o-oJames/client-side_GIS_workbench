// ---------------------------------------------------------------------------
// IndexedDB backing store for bulky file-layer geometry. Large uploads (e.g. a
// KMZ whose KML is tens of MB) serialize to GeoJSON far beyond the ~5 MB
// localStorage quota, which would otherwise abort the whole settings save and
// lose the layer on workspace switch. Geometry lives in IDB (quota ~GB); only a
// small marker key is kept in localStorage. Falls back to inline localStorage
// when IndexedDB is unavailable (e.g. jsdom tests).
// ---------------------------------------------------------------------------

const IDB_NAME = 'mapviewer';
const IDB_STORE = 'layerdata';

export function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.error('[Idb] openIdb error:', req.error); resolve(null); };
    } catch (e) { console.error('[Idb] openIdb threw:', e); resolve(null); }
  });
}

export async function idbPut(key: string, value: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch (e) { console.error('[Idb] idbPut failed:', e); }
  finally { db.close(); }
}

export async function idbGet(key: string): Promise<string | undefined> {
  const db = await openIdb();
  if (!db) return undefined;
  try {
    return await new Promise<string | undefined>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => res(r.result as string | undefined);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { console.error('[Idb] idbGet failed:', e); return undefined; }
  finally { db.close(); }
}

// A save (fire-and-forget) and the remount restore can race when the user
// switches workspace instantly; retry briefly so a just-written blob is found.
export async function idbGetWithRetry(key: string, tries = 5): Promise<string | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await idbGet(key);
    if (v !== undefined) return v;
    await new Promise(r => setTimeout(r, 60));
  }
  return undefined;
}

/** Delete a single key from the IDB layer-data store (e.g. when a layer is removed). */
export async function idbDelete(key: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch (e) { console.error('[Idb] idbDelete failed:', e); }
  finally { db.close(); }
}

export async function idbDeleteWorkspace(workspaceId: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  // Vector geometry blobs, session-only COG file bytes and the magic-wand
  // "original outline" stash are all namespaced by workspace id.
  const prefixes = [`file:${workspaceId}:`, `cog:${workspaceId}:`, `snap-original:${workspaceId}:`];
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const cur = tx.objectStore(IDB_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { if (typeof c.key === 'string' && prefixes.some(pf => (c.key as string).startsWith(pf))) c.delete(); c.continue(); }
        else res();
      };
      cur.onerror = () => rej(cur.error);
      tx.oncomplete = () => res();
    });
  } catch (e) { console.error('[Idb] idbDeleteWorkspace failed:', e); }
  finally { db.close(); }
}

export async function idbCopyWorkspace(sourceId: string, targetId: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  const srcPrefix = `file:${sourceId}:`;
  const dstPrefix = `file:${targetId}:`;
  const entries: Array<[string, string]> = [];
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const cur = tx.objectStore(IDB_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { if (typeof c.key === 'string' && c.key.startsWith(srcPrefix)) entries.push([dstPrefix + c.key.slice(srcPrefix.length), c.value as string]); c.continue(); }
        else res();
      };
      cur.onerror = () => rej(cur.error);
    });
  } catch (e) { console.error('[Idb] idbCopyWorkspace scan failed:', e); }
  finally { db.close(); }
  for (const [k, v] of entries) await idbPut(k, v);
}

/** Dump every key/value pair from the IDB layer-data store (for project export). */
export async function idbGetAll(): Promise<Record<string, string>> {
  const db = await openIdb();
  if (!db) return {};
  const entries: Record<string, string> = {};
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const cur = tx.objectStore(IDB_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          if (typeof c.key === 'string') entries[c.key] = c.value as string;
          c.continue();
        } else res();
      };
      cur.onerror = () => rej(cur.error);
    });
  } catch (e) { console.error('[Idb] idbGetAll failed:', e); }
  finally { db.close(); }
  return entries;
}

/** Restore multiple key/value pairs into the IDB layer-data store (for project import). */
export async function idbPutMany(entries: Record<string, string>): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      for (const [key, value] of Object.entries(entries)) {
        store.put(value, key);
      }
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch (e) { console.error('[Idb] idbPutMany failed:', e); }
  finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Binary (ArrayBuffer) storage for COG file layers
// ---------------------------------------------------------------------------

export async function idbPutBinary(key: string, value: ArrayBuffer): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch (e) { console.error('[Idb] idbPutBinary failed:', e); }
  finally { db.close(); }
}

export async function idbGetBinary(key: string): Promise<ArrayBuffer | undefined> {
  const db = await openIdb();
  if (!db) return undefined;
  try {
    return await new Promise<ArrayBuffer | undefined>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => res(r.result instanceof ArrayBuffer ? r.result : undefined);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { console.error('[Idb] idbGetBinary failed:', e); return undefined; }
  finally { db.close(); }
}

export async function idbGetBinaryWithRetry(key: string, tries = 5): Promise<ArrayBuffer | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await idbGetBinary(key);
    if (v !== undefined) return v;
    await new Promise(r => setTimeout(r, 60));
  }
  return undefined;
}
