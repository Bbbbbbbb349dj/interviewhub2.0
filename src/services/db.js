/* =============================================================================
 * InterviewHub document database — a real IndexedDB-backed data engine.
 *
 * Schema (version 1):
 *   · store "documents" — every app record lives here as
 *       { key: string (PK), value: any, updatedAt: number }
 *     with a non-unique index on `updatedAt` for recency scans.
 *   · store "meta" — engine bookkeeping (schema version, migration history).
 *
 * All writes run inside real IndexedDB "readwrite" transactions. Reads used
 * by the app are served from the write-through replica in ./storage.js after
 * boot, keeping every existing call site synchronous and fast.
 * ========================================================================== */

export const DB_NAME = 'interviewhub_db';
export const DB_VERSION = 1;
export const DOC_STORE = 'documents';
export const META_STORE = 'meta';

let dbInstance = null;

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

/** Open (and lazily create/upgrade) the database. Resolves to the IDBDatabase. */
export function openDatabase() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        const store = db.createObjectStore(DOC_STORE, { keyPath: 'key' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onversionchange = () => {
        try { dbInstance.close(); } catch { /* noop */ }
        dbInstance = null;
      };
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error || new Error('Failed to open InterviewHub database'));
  });
}

/** Read every document. Returns an array of { key, value, updatedAt }. */
export async function dbAllDocuments() {
  const db = await openDatabase();
  const tx = db.transaction(DOC_STORE, 'readonly');
  const rows = await asPromise(tx.objectStore(DOC_STORE).getAll());
  await txComplete(tx);
  return rows || [];
}

/**
 * Batch write inside a single transaction.
 * entries: Array<[key, value]> — `undefined` value deletes the key.
 */
export async function dbBulkWrite(entries) {
  if (!entries.length) return;
  const db = await openDatabase();
  const tx = db.transaction(DOC_STORE, 'readwrite');
  const store = tx.objectStore(DOC_STORE);
  const now = Date.now();
  for (const [key, value] of entries) {
    if (value === undefined) store.delete(key);
    else store.put({ key, value, updatedAt: now });
  }
  await txComplete(tx);
}

/** Wipe the documents store (used by "Clear all data"). */
export async function dbClearAll() {
  const db = await openDatabase();
  const tx = db.transaction(DOC_STORE, 'readwrite');
  tx.objectStore(DOC_STORE).clear();
  await txComplete(tx);
}

/** Count documents (shown in Settings → Your data). */
export async function dbCountDocuments() {
  const db = await openDatabase();
  const tx = db.transaction(DOC_STORE, 'readonly');
  const n = await asPromise(tx.objectStore(DOC_STORE).count());
  await txComplete(tx);
  return n;
}

export async function dbPutMeta(key, value) {
  const db = await openDatabase();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put({ key, value });
  await txComplete(tx);
}

export async function dbGetMeta(key) {
  const db = await openDatabase();
  const tx = db.transaction(META_STORE, 'readonly');
  const row = await asPromise(tx.objectStore(META_STORE).get(key));
  await txComplete(tx);
  return row ? row.value : null;
}
