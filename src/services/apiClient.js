/* =============================================================================
 * Server API client — talks to the InterviewHub backend (Express + PostgreSQL).
 *
 * The API base URL comes from the build env (VITE_API_URL) or from the
 * user-configured value saved in Settings (`syncConfig` doc). When neither is
 * set the app runs in local-only mode (IndexedDB replica, fully functional).
 * ========================================================================== */

import { storage, KEYS } from './storage';

const ENV_URL = (import.meta.env.VITE_API_URL || '').trim();
const SYNC_CONFIG_KEY = 'syncConfig';
const clean = (u) => String(u || '').trim().replace(/\/+$/, '');

export const envApiUrl = () => ENV_URL;

export function getApiUrl() {
  if (ENV_URL) return clean(ENV_URL);
  return clean(storage.get(SYNC_CONFIG_KEY, {})?.apiUrl);
}

export const apiConfigured = () => Boolean(getApiUrl());

let probeCache = { url: null, ok: false, at: 0 };

export function setApiUrl(url) {
  const next = clean(url);
  if (next) storage.set(SYNC_CONFIG_KEY, { apiUrl: next });
  else storage.remove(SYNC_CONFIG_KEY);
  probeCache = { url: null, ok: false, at: 0 };
}

export function getSession() {
  const s = storage.get(KEYS.session);
  if (!s) return null;
  if (typeof s === 'string') return { mode: 'local', email: s }; // legacy shape
  return s;
}

export function getToken() {
  const s = getSession();
  return s && s.mode === 'server' ? s.token || null : null;
}

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function req(path, { method = 'GET', body, auth = true, timeout = 10000, keepalive = false } = {}) {
  const base = getApiUrl();
  if (!base) throw new ApiError('No server API URL configured.', 0);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      keepalive,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data?.error || `Server error (${res.status}).`, res.status);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError('Server took too long to respond.', 0);
    throw new ApiError('Could not reach the InterviewHub server. Is the API running?', 0);
  } finally {
    clearTimeout(t);
  }
}

/** True when the API answers health and reports its PostgreSQL link up. */
export async function probeServer(force = false) {
  const url = getApiUrl();
  if (!url) return false;
  if (!force && probeCache.url === url && Date.now() - probeCache.at < 20000) return probeCache.ok;
  let ok = false;
  try {
    const h = await req('/api/health', { auth: false, timeout: 3500 });
    ok = Boolean(h && h.ok && h.dbStatus === 'up');
  } catch { ok = false; }
  probeCache = { url, ok, at: Date.now() };
  return ok;
}

export const api = {
  health: () => req('/api/health', { auth: false, timeout: 4000 }),
  register: ({ name, email, password }) => req('/api/auth/register', { method: 'POST', body: { name, email, password }, auth: false }),
  login: ({ email, password }) => req('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  me: () => req('/api/auth/me'),
  updateProfile: (patch) => req('/api/auth/profile', { method: 'PATCH', body: patch }),
  deleteAccount: () => req('/api/auth/me', { method: 'DELETE' }),
  pull: () => req('/api/sync/pull', { timeout: 20000 }),
  push: (payload, keepalive = false) => req('/api/sync/push', { method: 'POST', body: payload, timeout: 20000, keepalive }),
  wipeSync: () => req('/api/sync/all', { method: 'DELETE' }),
};
