/* =============================================================================
 * InterviewHub API — Express + PostgreSQL.
 *
 * PostgreSQL is the system of record. The web client keeps an offline-first
 * IndexedDB replica and syncs with this API (pull → merge → push), so the
 * app works without the server and converges with the database when it is
 * reachable — the same architecture production offline-first apps use.
 *
 * Endpoints
 *   GET    /api/health            liveness + database connectivity
 *   POST   /api/auth/register     { name, email, password } → { token, user }
 *   POST   /api/auth/login        { email, password }       → { token, user }
 *   GET    /api/auth/me           current account                  (auth)
 *   PATCH  /api/auth/profile      { name?, profile? }              (auth)
 *   DELETE /api/auth/me           delete account + all user data   (auth)
 *   GET    /api/sync/pull         full user snapshot               (auth)
 *   POST   /api/sync/push         upsert collections/docs/deletes  (auth)
 *   DELETE /api/sync/all          wipe synced data, keep account   (auth)
 * ========================================================================== */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { createPool, migrate, waitForDatabase } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'interviewhub-dev-secret-change-me';
const JWT_TTL = '30d';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toDate = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms) : null);
/* JSONB values usually arrive pre-parsed from pg; some drivers return text.
 * Only JSON-looking strings are parsed — scalar bodies like the theme
 * string "dark" must pass through untouched. */
const asObject = (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t); } catch { return v; }
  }
  return v;
};

/* Client collection key → table + typed-column extractor.
 * `payload` (JSONB) always stores the full original record. */
export const COLLECTIONS = {
  interviews: {
    table: 'interviews',
    extract: (p) => ({
      role: p.role ?? null, type: p.type ?? null, difficulty: p.difficulty ?? null,
      overall_score: p.average?.overall ?? null, happened_at: toDate(p.endedAt),
    }),
  },
  codingAttempts: {
    table: 'coding_attempts',
    extract: (p) => ({
      problem_id: p.problemId ?? null, language: p.language ?? null,
      passed: p.passed ?? null, total: p.total ?? null, happened_at: toDate(p.ts),
    }),
  },
  aptitudeAttempts: {
    table: 'aptitude_attempts',
    extract: (p) => ({
      category: p.cat ?? null, correct: p.correct ?? null, total: p.total ?? null,
      happened_at: toDate(p.ts),
    }),
  },
  commSessions: {
    table: 'comm_sessions',
    extract: (p) => ({
      prompt: p.prompt ?? null, overall_score: p.scores?.overall ?? null,
      happened_at: toDate(p.ts),
    }),
  },
  resumeAnalyses: {
    table: 'resume_analyses',
    extract: (p) => ({
      file_name: p.fileName ?? null, target_role: p.targetRole ?? null,
      score: p.analysis?.score ?? null, happened_at: toDate(p.analyzedAt),
    }),
  },
};

/** Singleton docs allowed in user_docs. */
const DOC_KEYS = new Set(['settings', 'theme', 'achievements', 'activityLog']);

function publicUser(row) {
  return {
    id: row.id, name: row.name, email: row.email,
    profile: asObject(row.profile) || { targetRole: '', skills: [], education: '', bio: '' },
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

async function upsertItem(pool, cfg, accountId, item) {
  const typed = cfg.extract(item || {});
  const cols = ['id', 'account_id', 'payload', ...Object.keys(typed)];
  const vals = [String(item.id), accountId, JSON.stringify(item), ...Object.values(typed)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.slice(2).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await pool.query(
    `INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at = now()`,
    vals,
  );
}

export function createApp(pool) {
  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
  app.use(express.json({ limit: '8mb' }));

  const auth = (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Missing auth token.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.accountId = decoded.sub;
      req.email = decoded.email;
      return next();
    } catch {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
  };

  const sign = (user) => jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_TTL });

  /* ------------------------------ health ------------------------------ */
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, service: 'interviewhub-api', database: 'postgresql', dbStatus: 'up', time: Date.now() });
    } catch (e) {
      res.json({ ok: false, service: 'interviewhub-api', database: 'postgresql', dbStatus: 'down', error: e.message, time: Date.now() });
    }
  });

  /* ------------------------------- auth -------------------------------- */
  app.post('/api/auth/register', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      const existing = await pool.query('SELECT id FROM accounts WHERE email = $1', [email]);
      if (existing.rows.length) return res.status(409).json({ error: 'An account with this email already exists.' });

      const id = randomUUID();
      const passwordHash = await bcrypt.hash(password, 10);
      const profile = { targetRole: '', skills: [], education: '', bio: '' };
      const { rows } = await pool.query(
        'INSERT INTO accounts (id, name, email, password_hash, profile) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [id, name, email, passwordHash, JSON.stringify(profile)],
      );
      const user = publicUser(rows[0]);
      return res.status(201).json({ token: sign(user), user });
    } catch (e) {
      console.error('[auth/register]', e);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const { rows } = await pool.query('SELECT * FROM accounts WHERE email = $1', [email]);
      if (!rows.length) return res.status(404).json({ error: 'No account found with this email.' });
      const ok = await bcrypt.compare(password, rows[0].password_hash);
      if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
      const user = publicUser(rows[0]);
      return res.json({ token: sign(user), user });
    } catch (e) {
      console.error('[auth/login]', e);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  });

  app.get('/api/auth/me', auth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.accountId]);
    if (!rows.length) return res.status(404).json({ error: 'Account no longer exists.' });
    return res.json({ user: publicUser(rows[0]) });
  });

  app.patch('/api/auth/profile', auth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.accountId]);
      if (!rows.length) return res.status(404).json({ error: 'Account no longer exists.' });
      const current = rows[0];
      const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : current.name;
      const profile = { ...(asObject(current.profile) || {}), ...(req.body?.profile || {}) };
      const { rows: updated } = await pool.query(
        'UPDATE accounts SET name = $1, profile = $2, updated_at = now() WHERE id = $3 RETURNING *',
        [name, JSON.stringify(profile), req.accountId],
      );
      return res.json({ user: publicUser(updated[0]) });
    } catch (e) {
      console.error('[auth/profile]', e);
      return res.status(500).json({ error: 'Profile update failed.' });
    }
  });

  app.delete('/api/auth/me', auth, async (req, res) => {
    await pool.query('DELETE FROM accounts WHERE id = $1', [req.accountId]); // cascades to all user data
    return res.json({ ok: true });
  });

  /* ------------------------------- sync -------------------------------- */
  app.get('/api/sync/pull', auth, async (req, res) => {
    try {
      const collections = {};
      for (const [key, cfg] of Object.entries(COLLECTIONS)) {
        const { rows } = await pool.query(
          `SELECT payload FROM ${cfg.table} WHERE account_id = $1 ORDER BY happened_at ASC NULLS LAST, updated_at ASC`,
          [req.accountId],
        );
        collections[key] = rows.map((r) => asObject(r.payload));
      }
      const { rows: docRows } = await pool.query(
        'SELECT doc_key, body, client_updated_at FROM user_docs WHERE account_id = $1',
        [req.accountId],
      );
      const docs = {};
      docRows.forEach((r) => {
        docs[r.doc_key] = { body: asObject(r.body), updatedAt: Number(r.client_updated_at) || 0 };
      });
      return res.json({ collections, docs, serverTime: Date.now() });
    } catch (e) {
      console.error('[sync/pull]', e);
      return res.status(500).json({ error: 'Pull failed.' });
    }
  });

  app.post('/api/sync/push', auth, async (req, res) => {
    const body = req.body || {};
    const collections = body.collections || {};
    const docs = body.docs || {};
    const deleted = body.deleted || {};
    try {
      for (const [key, items] of Object.entries(collections)) {
        const cfg = COLLECTIONS[key];
        if (!cfg || !Array.isArray(items)) continue;
        for (const item of items) {
          if (item && item.id != null) await upsertItem(pool, cfg, req.accountId, item);
        }
      }
      for (const [key, ids] of Object.entries(deleted)) {
        const cfg = COLLECTIONS[key];
        if (!cfg || !Array.isArray(ids)) continue;
        for (const id of ids) {
          await pool.query(`DELETE FROM ${cfg.table} WHERE account_id = $1 AND id = $2`, [req.accountId, String(id)]);
        }
      }
      for (const [key, doc] of Object.entries(docs)) {
        if (!DOC_KEYS.has(key) || !doc) continue;
        const updatedAt = Number(doc.updatedAt) || Date.now();
        await pool.query(
          `INSERT INTO user_docs (account_id, doc_key, body, client_updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, doc_key)
           DO UPDATE SET body = EXCLUDED.body, client_updated_at = EXCLUDED.client_updated_at, updated_at = now()
           WHERE EXCLUDED.client_updated_at >= user_docs.client_updated_at`,
          [req.accountId, key, doc.body === undefined ? null : JSON.stringify(doc.body), updatedAt],
        );
      }
      return res.json({ ok: true, serverTime: Date.now() });
    } catch (e) {
      console.error('[sync/push]', e);
      return res.status(500).json({ error: 'Push failed.' });
    }
  });

  app.delete('/api/sync/all', auth, async (req, res) => {
    try {
      for (const cfg of Object.values(COLLECTIONS)) {
        await pool.query(`DELETE FROM ${cfg.table} WHERE account_id = $1`, [req.accountId]);
      }
      await pool.query('DELETE FROM user_docs WHERE account_id = $1', [req.accountId]);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[sync/all]', e);
      return res.status(500).json({ error: 'Wipe failed.' });
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}

/* ------------------------------ main boot ----------------------------- */
/* -------------------------- server startup -------------------------- */

import { fileURLToPath } from 'node:url';

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === process.argv[1];

let pool;
let appPromise;

async function getApp() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is missing.');
  }

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is missing.');
  }

  if (!appPromise) {
    appPromise = (async () => {
      pool = createPool(process.env.DATABASE_URL);

      await waitForDatabase(pool);
      await migrate(pool);

      console.log(
        '[interviewhub-api] PostgreSQL connected and schema migrated'
      );

      return createApp(pool);
    })().catch((error) => {
      appPromise = null;

      if (pool) {
        pool.end().catch(() => {});
        pool = null;
      }

      throw error;
    });
  }

  return appPromise;
}

/* Vercel serverless function handler */
export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error('[interviewhub-api] initialization failed:', error);

    if (!res.headersSent) {
      return res.status(503).json({
        ok: false,
        error: 'API initialization failed. Check server logs.',
      });
    }
  }
}

/* Local development: npm start */
if (isMain && process.env.VERCEL !== '1') {
  const port = Number(process.env.PORT || 4000);

  getApp()
    .then((app) => {
      app.listen(port, () => {
        console.log(
          `[interviewhub-api] listening on :${port}`
        );
      });
    })
    .catch((error) => {
      console.error(
        '[interviewhub-api] failed to start:',
        error
      );
      process.exitCode = 1;
    });
}
