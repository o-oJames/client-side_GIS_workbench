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
      req.onerror = () => { console.error('openIdb error:', req.error); resolve(null); };
    } catch (e) { console.error('openIdb threw:', e); resolve(null); }
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
  } catch (e) { console.error('idbPut failed:', e); }
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
  } catch (e) { console.error('idbGet failed:', e); return undefined; }
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

export async function idbDeleteWorkspace(workspaceId: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  const prefix = `file:${workspaceId}:`;
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const cur = tx.objectStore(IDB_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { if (typeof c.key === 'string' && c.key.startsWith(prefix)) c.delete(); c.continue(); }
        else res();
      };
      cur.onerror = () => rej(cur.error);
      tx.oncomplete = () => res();
    });
  } catch (e) { console.error('idbDeleteWorkspace failed:', e); }
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
  } catch (e) { console.error('idbCopyWorkspace scan failed:', e); }
  finally { db.close(); }
  for (const [k, v] of entries) await idbPut(k, v);
}
