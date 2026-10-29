/* =============================================================================
 * Persistent storage facade — backed by the IndexedDB document database.
 *
 * This module REPLACES the old localStorage implementation. The public API is
 * intentionally identical, so every page and service keeps working unchanged:
 *
 *   · Reads are served synchronously from an in-memory replica.
 *   · Every mutation is written through to IndexedDB inside a real
 *     transaction (debounced into small batches, flushed on tab hide/close).
 *   · One-time migration moves any legacy `ihub:*` localStorage keys into the
 *     database, then removes them from localStorage entirely.
 *
 * Boot: `await initStorage()` runs once in main.tsx before the app renders.
 * If IndexedDB is unavailable (rare private-mode cases), the app degrades to
 * an ephemeral in-memory store instead of crashing.
 * ========================================================================== */

import {
  DB_NAME, openDatabase, dbAllDocuments, dbBulkWrite,
  dbClearAll, dbCountDocuments, dbPutMeta, dbGetMeta,
} from './db';

const PREFIX = 'ihub:';
const FLUSH_DELAY = 40;

const cache = new Map();
const writeQueue = new Map(); // key → value (`undefined` = delete)
let flushTimer = null;
let engine = 'boot';
let bootPromise = null;

/* ----------------------------- boot & migration ---------------------------- */

export function initStorage() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      await openDatabase();
      engine = 'indexeddb';
      const rows = await dbAllDocuments();
      rows.forEach((r) => { if (r && typeof r.key === 'string') cache.set(r.key, r.value); });
      await migrateLegacyLocalStorage();
    } catch (e) {
      engine = 'memory';
      console.warn('[InterviewHub] IndexedDB unavailable — falling back to in-memory storage.', e);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', flushNow);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow();
      });
    }
    try {
      await dbPutMeta('lastBootAt', Date.now());
    } catch { /* memory mode */ }
  })();
  return bootPromise;
}

/** Move legacy localStorage data into the database exactly once, then purge it. */
async function migrateLegacyLocalStorage() {
  const legacyKeys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) legacyKeys.push(k);
    }
  } catch { return; /* localStorage itself may be blocked — nothing to migrate */ }
  if (!legacyKeys.length) return;

  const migrated = [];
  legacyKeys.forEach((full) => {
    const key = full.slice(PREFIX.length);
    if (cache.has(key)) return; // the database is the source of truth
    try {
      const raw = localStorage.getItem(full);
      if (raw !== null) {
        const value = JSON.parse(raw);
        cache.set(key, value);
        migrated.push([key, value]);
      }
    } catch { /* skip malformed legacy value */ }
  });

  try {
    if (migrated.length) await dbBulkWrite(migrated);
    await dbPutMeta('migratedFromLocalStorage', { at: Date.now(), keys: migrated.map(([k]) => k) });
  } catch (e) {
    console.error('[InterviewHub] legacy migration write failed', e);
  }
  legacyKeys.forEach((k) => { try { localStorage.removeItem(k); } catch { /* noop */ } });
}

/* ------------------------- write-through persistence ----------------------- */

function schedulePersist(key) {
  writeQueue.set(key, cache.has(key) ? cache.get(key) : undefined);
  if (engine !== 'indexeddb') return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, FLUSH_DELAY);
}

function flushNow() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (engine !== 'indexeddb' || !writeQueue.size) return;
  const batch = [...writeQueue.entries()];
  writeQueue.clear();
  dbBulkWrite(batch).catch((e) => {
    console.error('[InterviewHub] database write failed — batch re-queued', e);
    batch.forEach(([k, v]) => { if (!writeQueue.has(k)) writeQueue.set(k, v); });
  });
}

/** Engine/status info for Settings → Your data. */
export async function dbInfo() {
  if (engine !== 'indexeddb') return { engine: 'memory', dbName: null, documents: 0, migration: null };
  const [documents, migration] = await Promise.all([
    dbCountDocuments().catch(() => 0),
    dbGetMeta('migratedFromLocalStorage').catch(() => null),
  ]);
  return { engine: 'indexeddb', dbName: DB_NAME, documents, migration };
}

/* ------------------------------ public facade ------------------------------ */

/** Mutation listeners — the server sync engine (dbSync.js) subscribes here so
 *  it can push changes to PostgreSQL without storage.js importing it. */
const mutationListeners = new Set();
export function onStorageMutation(fn) {
  mutationListeners.add(fn);
  return () => mutationListeners.delete(fn);
}
function notifyMutation(key) {
  mutationListeners.forEach((fn) => { try { fn(key); } catch { /* listener errors never break storage */ } });
}

export const storage = {
  get(key, fallback = null) {
    return cache.has(key) ? cache.get(key) : fallback;
  },
  set(key, value) {
    cache.set(key, value);
    schedulePersist(key);
    notifyMutation(key);
    return true;
  },
  remove(key) {
    cache.delete(key);
    schedulePersist(key);
    notifyMutation(key);
  },
  update(key, updater, fallback = []) {
    const current = storage.get(key, fallback);
    const next = updater(current);
    storage.set(key, next);
    return next;
  },
  push(key, item, fallback = []) {
    return storage.update(key, (arr) => [...(Array.isArray(arr) ? arr : fallback), item], fallback);
  },
  clearAll() {
    cache.clear();
    writeQueue.clear();
    if (engine === 'indexeddb') {
      dbClearAll().catch((e) => console.error('[InterviewHub] failed to clear database', e));
    }
    notifyMutation('*');
  },
};

export const KEYS = {
  theme: 'theme',
  interviews: 'interviews',
  coding: 'codingAttempts',
  aptitude: 'aptitudeAttempts',
  comm: 'commSessions',
  resumes: 'resumeAnalyses',
  achievements: 'achievements',
  settings: 'settings',
  activity: 'activityLog',
};

export function logActivity(kind, label) {
  storage.push(KEYS.activity, { kind, label, ts: Date.now() });
}

export function exportAllData() {
  const out = { app: 'interviewhub', version: 2, engine, exportedAt: new Date().toISOString(), data: {} };
  Object.values(KEYS).forEach((k) => {
    out.data[k] = storage.get(k);
  });
  return out;
}

export function importAllData(payload) {
  if (!payload || payload.app !== 'interviewhub' || typeof payload.data !== 'object') {
    throw new Error('Invalid InterviewHub export file.');
  }
  Object.values(KEYS).forEach((k) => {
    if (payload.data[k] !== undefined) storage.set(k, payload.data[k]);
  });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
