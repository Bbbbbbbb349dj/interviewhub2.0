/* =============================================================================
 * Database sync engine — PostgreSQL (via the InterviewHub API) is the system
 * of record; the on-device IndexedDB replica (storage.js) is the offline
 * cache. This module keeps the two converged:
 *
 *   login ──► pull snapshot ──► merge (collections union-by-id, docs LWW)
 *         ──► push anything the server is missing
 *   local mutation ──► debounced push (new/updated items + deletions)
 *   window focus / tab hide ──► opportunistic pull / keepalive push
 *
 * AI provider keys (aiKeys) are deliberately NEVER synced.
 * ========================================================================== */

import { storage, KEYS, onStorageMutation } from './storage';
import { api, apiConfigured, probeServer, getToken } from './apiClient';

export const COLLECTION_KEYS = [KEYS.interviews, KEYS.coding, KEYS.aptitude, KEYS.comm, KEYS.resumes];
export const DOC_KEYS = [KEYS.achievements, KEYS.settings, KEYS.theme, KEYS.activity];
const META_KEY = '_syncmeta';
const PUSH_DEBOUNCE_MS = 1200;
const PULL_THROTTLE_MS = 30000;

let state = { status: 'local', lastSyncedAt: null, lastError: null };
const listeners = new Set();
let active = false;
let applyingRemote = false;
let pushTimer = null;
let syncing = false;
let lastPullAt = 0;
let subscribed = false;

export function getSyncState() { return state; }
export function subscribeSync(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => { try { fn(state); } catch { /* noop */ } });
}

/* ------------------------------- sync meta ------------------------------- */
function getMeta() {
  return storage.get(META_KEY, null) || { knownIds: {}, docUpdatedAt: {}, docPushedAt: {}, lastPullAt: 0, lastPushAt: 0 };
}
function setMeta(meta) {
  storage.set(META_KEY, meta);
}

const itemStamp = (x) => (x && typeof x === 'object' ? (x.endedAt ?? x.analyzedAt ?? x.ts ?? x.updatedAt ?? 0) : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

/** Union two record arrays by `id`; newer stamp wins; sorted oldest → newest. */
export function mergeCollection(localArr, remoteArr) {
  const byId = new Map();
  [...arr(localArr), ...arr(remoteArr)].forEach((item) => {
    if (!item || item.id == null) return;
    const prev = byId.get(item.id);
    if (!prev || itemStamp(item) >= itemStamp(prev)) byId.set(item.id, item);
  });
  return [...byId.values()].sort((a, b) => itemStamp(a) - itemStamp(b));
}

function mergeArrayDoc(key, localVal, remoteVal) {
  if (key === KEYS.achievements) return mergeCollection(localVal, remoteVal);
  if (key === KEYS.activity) {
    const seen = new Set();
    const merged = [...arr(localVal), ...arr(remoteVal)].filter((e) => {
      const k = `${e?.ts}|${e?.kind}|${e?.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return merged.sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-200);
  }
  return null;
}

/** Resolve one singleton doc: arrays union-merge, everything else is LWW. */
export function mergeDoc(key, localVal, localTs, remote) {
  const remoteTs = remote?.updatedAt || 0;
  const arrayMerged = mergeArrayDoc(key, localVal, remote?.body);
  if (arrayMerged !== null && remote) {
    return { value: arrayMerged, ts: Math.max(localTs || 0, remoteTs), remoteTs };
  }
  if (remote && remoteTs > (localTs || 0)) return { value: remote.body, ts: remoteTs, remoteTs };
  return { value: localVal, ts: localTs || 0, remoteTs };
}

/* ------------------------------ pull + merge ------------------------------ */
async function pullAndMerge() {
  const snapshot = await api.pull();
  const meta = getMeta();
  applyingRemote = true;
  try {
    COLLECTION_KEYS.forEach((key) => {
      const localItems = arr(storage.get(key, []));
      const localIds = new Set(localItems.map((x) => x?.id).filter((id) => id != null));
      // Items we previously synced but deleted locally must NOT be resurrected
      // by the merge — the push that follows will delete them server-side.
      const deletedLocally = new Set((meta.knownIds[key] || []).filter((id) => !localIds.has(id)));
      const remoteItems = arr(snapshot.collections?.[key]).filter((x) => !deletedLocally.has(x?.id));
      const merged = mergeCollection(localItems, remoteItems);
      storage.set(key, merged);
      // knownIds tracks what the SERVER holds, so push can diff against it.
      meta.knownIds[key] = arr(snapshot.collections?.[key]).map((x) => x?.id).filter((id) => id != null);
    });
    DOC_KEYS.forEach((key) => {
      const localTs = meta.docUpdatedAt[key] || 0;
      const res = mergeDoc(key, storage.get(key), localTs, snapshot.docs?.[key]);
      if (res.value !== undefined && res.value !== null) storage.set(key, res.value);
      else if (snapshot.docs?.[key] && snapshot.docs[key].body === null) storage.remove(key);
      meta.docUpdatedAt[key] = res.ts;
      meta.docPushedAt[key] = res.remoteTs; // what the server already has
    });
    meta.lastPullAt = Date.now();
    lastPullAt = meta.lastPullAt;
    setMeta(meta);
  } finally {
    applyingRemote = false;
  }
  return snapshot;
}

/* --------------------------------- push ---------------------------------- */
function buildPushPayload(meta) {
  const payload = { collections: {}, docs: {}, deleted: {} };
  let dirty = false;

  COLLECTION_KEYS.forEach((key) => {
    const items = arr(storage.get(key, []));
    const known = new Set(meta.knownIds[key] || []);
    const fresh = items.filter((x) => x && x.id != null && !known.has(x.id));
    const currentIds = new Set(items.map((x) => x?.id).filter((id) => id != null));
    const gone = [...known].filter((id) => !currentIds.has(id));
    if (fresh.length) { payload.collections[key] = fresh; dirty = true; }
    if (gone.length) { payload.deleted[key] = gone; dirty = true; }
  });

  DOC_KEYS.forEach((key) => {
    const updatedAt = meta.docUpdatedAt[key] || 0;
    if (updatedAt > (meta.docPushedAt[key] || 0)) {
      payload.docs[key] = { body: storage.get(key), updatedAt };
      dirty = true;
    }
  });

  return { payload, dirty };
}

async function pushDirty(keepalive = false) {
  const meta = getMeta();
  const { payload, dirty } = buildPushPayload(meta);
  if (!dirty) return false;
  await api.push(payload, keepalive);
  const after = getMeta();
  COLLECTION_KEYS.forEach((key) => {
    after.knownIds[key] = arr(storage.get(key, [])).map((x) => x?.id).filter((id) => id != null);
  });
  Object.keys(payload.docs).forEach((key) => {
    after.docPushedAt[key] = Math.max(after.docPushedAt[key] || 0, payload.docs[key].updatedAt);
  });
  after.lastPushAt = Date.now();
  setMeta(after);
  return true;
}

/* ------------------------------ session API ------------------------------- */
export async function syncNow({ pull = true, keepalive = false } = {}) {
  if (!active || syncing || !getToken()) return state;
  syncing = true;
  setState({ status: 'syncing', lastError: null });
  try {
    const up = await probeServer(true);
    if (!up) throw new Error('Server unreachable');
    if (pull) await pullAndMerge();
    await pushDirty(keepalive);
    setState({ status: 'synced', lastSyncedAt: Date.now(), lastError: null });
  } catch (e) {
    setState({ status: 'offline', lastError: e.message || 'Sync failed' });
  } finally {
    syncing = false;
  }
  return state;
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { syncNow({ pull: false }); }, PUSH_DEBOUNCE_MS);
}

function onMutation(key) {
  if (!active || applyingRemote) return;
  if (key === META_KEY || key === 'syncConfig' || key === KEYS.session || key === KEYS.accounts || key === 'aiKeys') return;
  const isDoc = DOC_KEYS.includes(key);
  const isCollection = COLLECTION_KEYS.includes(key);
  if (!isDoc && !isCollection) return;
  if (isDoc) {
    const meta = getMeta();
    meta.docUpdatedAt[key] = Date.now();
    setMeta(meta);
  }
  schedulePush();
}

/** Begin syncing for the signed-in server account. Safe to call repeatedly. */
export async function startSyncSession() {
  if (!apiConfigured() || !getToken()) {
    setState({ status: apiConfigured() ? 'offline' : 'local' });
    return state;
  }
  active = true;
  if (!subscribed) {
    onStorageMutation(onMutation);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        if (active && Date.now() - lastPullAt > PULL_THROTTLE_MS) syncNow({ pull: true });
      });
      document.addEventListener('visibilitychange', () => {
        if (active && document.visibilityState === 'hidden') syncNow({ pull: false, keepalive: true });
      });
    }
    subscribed = true;
  }
  return syncNow({ pull: true });
}

export function stopSyncSession() {
  active = false;
  clearTimeout(pushTimer);
  setState({ status: apiConfigured() ? 'offline' : 'local', lastError: null });
}

/** Wipe every synced record server-side (used by "Clear all data"). */
export async function wipeRemoteData() {
  if (apiConfigured() && getToken()) {
    try { await api.wipeSync(); } catch { /* best effort — local wipe still proceeds */ }
  }
  storage.remove(META_KEY);
}
