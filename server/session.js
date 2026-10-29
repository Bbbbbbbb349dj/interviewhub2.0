/* Server-side sessions: random opaque token in an httpOnly cookie; only its
 * SHA-256 hash is stored in the DB, so sign-out / password reset can revoke it. */
import { randomBytes, createHash } from 'node:crypto';

export const COOKIE = 'ih_session';
const TTL_MS = 30 * 24 * 3600 * 1000;
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const isProd = () => Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
export const cookieOpts = (extra = {}) => ({ httpOnly: true, secure: isProd(), sameSite: 'lax', path: '/', ...extra });

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function startSession(pool, res, accountId) {
  const token = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  await pool.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
    [sha256hex(token), accountId, new Date(Date.now() + TTL_MS)]);
  res.cookie(COOKIE, token, cookieOpts({ maxAge: TTL_MS }));
}

export async function endSession(pool, req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(token)]);
  res.clearCookie(COOKIE, cookieOpts());
}

export const makeAuth = (pool) => async (req, res, next) => {
  const token = parseCookies(req)[COOKIE];
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.email, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256hex(token)]);
    if (!rows.length) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    req.accountId = rows[0].id; req.email = rows[0].email; req.role = rows[0].role;
    return next();
  } catch (e) {
    console.error('[auth]', e);
    return res.status(500).json({ error: 'Authentication check failed.' });
  }
};

export const requireAdmin = (req, res, next) =>
  req.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access required.' });

/* Small per-instance limiter for credential endpoints (best effort on serverless). */
const hits = new Map();
export const limit = (max = 10, windowMs = 15 * 60 * 1000) => (req, res, next) => {
  const k = `${req.ip}:${req.path}`;
  const now = Date.now();
  const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (h.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  h.push(now); hits.set(k, h);
  if (hits.size > 5000) hits.clear();
  return next();
};
