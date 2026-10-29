/* Password reset, Google sign-in, AI-key admin endpoints and the AI proxy. */
import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { startSession, sha256hex, parseCookies, cookieOpts, requireAdmin, limit } from './session.js';

const APP_URL = () => (process.env.APP_URL || '').replace(/\/+$/, '');
const RESET_TTL_MS = 60 * 60 * 1000;
const PROVIDERS = ['openai', 'gemini'];
const MODELS = () => ({
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  gemini: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
});
const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && APP_URL());
const mailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM && APP_URL());

/* ---- AES-256-GCM (node:crypto) for provider keys stored at rest ---- */
const encKey = () => (process.env.SETTINGS_ENCRYPTION_KEY
  ? createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY).digest() : null);
function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, ct] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function getKey(pool, provider) {
  if (!encKey()) return null;
  const { rows } = await pool.query('SELECT ciphertext FROM app_secrets WHERE name = $1', [`${provider}_api_key`]);
  if (!rows.length) return null;
  try { return decrypt(rows[0].ciphertext); } catch { return null; }
}

async function sendResetEmail(to, link) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM, to: [to], subject: 'Reset your InterviewHub password',
      text: `Use this link to reset your password (valid for 1 hour, single use):\n\n${link}\n\nIf you did not request this, ignore this email.`,
    }),
  });
  if (!r.ok) throw new Error(`Email provider responded ${r.status}`);
}

function mapUpstream(status, body) {
  let detail = '';
  try { detail = JSON.parse(body)?.error?.message || ''; } catch { detail = String(body || '').slice(0, 160); }
  if (status === 401 || status === 403) return ['AUTH', `The configured AI API key was rejected by the provider. ${detail}`];
  if (status === 429) return ['RATE_LIMIT', `Rate limit reached. Please wait and retry. ${detail}`];
  if (status === 404) return ['MODEL', `Model not found. ${detail}`];
  if (status >= 500) return ['SERVER', `AI provider error (${status}). ${detail}`];
  return ['HTTP', `AI request failed (${status}). ${detail}`];
}

async function callProvider(provider, key, system, user, wantJson) {
  const model = MODELS()[provider];
  let url; let init;
  if (provider === 'openai') {
    const body = { model, temperature: 0.7, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (wantJson) body.response_format = { type: 'json_object' };
    url = 'https://api.openai.com/v1/chat/completions';
    init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) };
  } else {
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096, ...(wantJson ? { responseMimeType: 'application/json' } : {}) },
    };
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) };
  }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(80000) });
  const raw = await res.text();
  if (!res.ok) { const [code, error] = mapUpstream(res.status, raw); return { status: 502, code, error }; }
  const data = JSON.parse(raw);
  const text = provider === 'openai'
    ? data?.choices?.[0]?.message?.content
    : data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) return { status: 502, code: 'BAD_RESPONSE', error: 'The AI provider returned an empty response.' };
  return { status: 200, text };
}

async function activeProvider(pool) {
  for (const p of PROVIDERS) { // OpenAI preferred, as before
    const key = await getKey(pool, p);
    if (key) return { provider: p, key };
  }
  return null;
}

export function mountExtraRoutes(app, pool, auth) {

  /* ------------------------ which sign-in options exist ------------------------ */
  app.get('/api/auth/providers', (req, res) => res.json({ google: googleConfigured() }));

  /* ------------------------------ password reset ------------------------------ */
  app.post('/api/auth/forgot', limit(5), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!mailConfigured()) {
      return res.status(503).json({ error: 'Password reset email is not configured on this server. Contact the administrator.' });
    }
    const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
    try {
      const { rows } = await pool.query('SELECT id FROM accounts WHERE email = $1', [email]);
      if (rows.length) {
        const token = randomBytes(32).toString('base64url');
        await pool.query('DELETE FROM password_reset_tokens WHERE account_id = $1', [rows[0].id]);
        await pool.query('INSERT INTO password_reset_tokens (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
          [sha256hex(token), rows[0].id, new Date(Date.now() + RESET_TTL_MS)]);
        await sendResetEmail(email, `${APP_URL()}/#/auth?mode=reset&token=${token}`);
      }
    } catch (e) { console.error('[auth/forgot]', e.message); }
    return res.json(generic);
  });

  app.post('/api/auth/reset', limit(10), async (req, res) => {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      const { rows } = await pool.query(
        `UPDATE password_reset_tokens SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING account_id`, [sha256hex(token)]);
      if (!rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
      await pool.query('UPDATE accounts SET password_hash = $1, updated_at = now() WHERE id = $2',
        [await bcrypt.hash(password, 10), rows[0].account_id]);
      await pool.query('DELETE FROM sessions WHERE account_id = $1', [rows[0].account_id]); // sign out everywhere
      return res.json({ ok: true });
    } catch (e) {
      console.error('[auth/reset]', e);
      return res.status(500).json({ error: 'Password reset failed. Please try again.' });
    }
  });

  /* ------------------------------ Google OAuth ------------------------------ */
  const googleClient = () => new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${APP_URL()}/api/auth/google/callback`,
  });
  const OAUTH_COOKIE = 'ih_oauth';
  const oauthCookie = (extra = {}) => cookieOpts({ path: '/api/auth/google', ...extra });
  const back = (res, err) => res.redirect(`${APP_URL()}/#/auth${err ? `?error=${err}` : ''}`);

  app.get('/api/auth/google/start', async (req, res) => {
    if (!googleConfigured()) return res.status(503).json({ error: 'Google sign-in is not configured.' });
    try {
      const client = googleClient();
      const state = randomBytes(24).toString('base64url');
      const nonce = randomBytes(24).toString('base64url');
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      res.cookie(OAUTH_COOKIE, `${state}.${nonce}.${codeVerifier}`, oauthCookie({ maxAge: 10 * 60 * 1000 }));
      return res.redirect(client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'], state, nonce, prompt: 'select_account',
        code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
      }));
    } catch (e) {
      console.error('[google/start]', e.message);
      return back(res, 'google_failed');
    }
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    if (!googleConfigured()) return back(res, 'google_unavailable');
    const saved = (parseCookies(req)[OAUTH_COOKIE] || '').split('.');
    res.clearCookie(OAUTH_COOKIE, oauthCookie());
    if (req.query.error) return back(res, req.query.error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    try {
      const [state, nonce, verifier] = saved;
      const got = Buffer.from(String(req.query.state || ''));
      const want = Buffer.from(state || '');
      if (!state || got.length !== want.length || !timingSafeEqual(got, want) || !req.query.code) return back(res, 'google_failed');
      const client = googleClient();
      const { tokens } = await client.getToken({ code: String(req.query.code), codeVerifier: verifier });
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (!p || p.nonce !== nonce || !p.email || !p.email_verified) return back(res, 'google_failed');
      const email = p.email.toLowerCase();

      let { rows } = await pool.query('SELECT * FROM accounts WHERE google_id = $1', [p.sub]);
      if (!rows.length) {
        ({ rows } = await pool.query('SELECT * FROM accounts WHERE email = $1', [email]));
        if (rows.length) {
          if (rows[0].google_id && rows[0].google_id !== p.sub) return back(res, 'google_failed');
          await pool.query('UPDATE accounts SET google_id = $1, updated_at = now() WHERE id = $2', [p.sub, rows[0].id]); // Google-verified email → safe to link
        } else {
          ({ rows } = await pool.query(
            `INSERT INTO accounts (id, name, email, password_hash, google_id, profile) VALUES ($1, $2, $3, NULL, $4, $5) RETURNING *`,
            [randomUUID(), String(p.name || email.split('@')[0]).slice(0, 100), email, p.sub,
              JSON.stringify({ targetRole: '', skills: [], education: '', bio: '' })]));
        }
      }
      await startSession(pool, res, rows[0].id);
      return res.redirect(`${APP_URL()}/#/dashboard`);
    } catch (e) {
      console.error('[google/callback]', e.message);
      return back(res, 'google_failed');
    }
  });

  /* ------------------------- admin: AI provider keys ------------------------- */
  const status = async () => {
    const out = {};
    const { rows } = await pool.query("SELECT name, last4, updated_at FROM app_secrets WHERE name LIKE '%\\_api\\_key'");
    for (const p of PROVIDERS) {
      const r = rows.find((x) => x.name === `${p}_api_key`);
      out[p] = { configured: Boolean(r), hint: r ? `••••${r.last4}` : null, updatedAt: r ? r.updated_at : null, model: MODELS()[p] };
    }
    return { providers: out, encryptionReady: Boolean(encKey()) };
  };

  app.get('/api/admin/ai', auth, requireAdmin, async (req, res) => {
    try { return res.json(await status()); } catch (e) { console.error(e); return res.status(500).json({ error: 'Could not load settings.' }); }
  });

  app.put('/api/admin/ai/:provider', auth, requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider.' });
    if (!encKey()) return res.status(503).json({ error: 'Set SETTINGS_ENCRYPTION_KEY on the server before saving API keys.' });
    const key = String(req.body?.key || '').trim();
    if (key.length < 8 || key.length > 500 || /\s/.test(key)) return res.status(400).json({ error: 'Enter a valid API key (no spaces).' });
    try {
      await pool.query(
        `INSERT INTO app_secrets (name, ciphertext, last4, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [`${provider}_api_key`, encrypt(key), key.slice(-4), req.accountId]);
      return res.json(await status());
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Could not save the key.' }); }
  });

  app.delete('/api/admin/ai/:provider', auth, requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider.' });
    try {
      await pool.query('DELETE FROM app_secrets WHERE name = $1', [`${provider}_api_key`]);
      return res.json(await status());
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Could not remove the key.' }); }
  });

  /* ----------------- AI proxy: provider keys never reach the browser ----------------- */
  app.get('/api/ai/status', auth, async (req, res) => {
    try {
      const a = await activeProvider(pool);
      return res.json({ configured: Boolean(a), provider: a?.provider || null, model: a ? MODELS()[a.provider] : null });
    } catch { return res.json({ configured: false, provider: null, model: null }); }
  });

  app.post('/api/ai/ask', auth, async (req, res) => {
    const system = String(req.body?.system || '');
    const user = String(req.body?.user || '');
    if (!user || system.length + user.length > 300000) return res.status(400).json({ code: 'HTTP', error: 'Invalid AI request.' });
    try {
      const a = await activeProvider(pool);
      if (!a) return res.status(503).json({ code: 'NO_KEY', error: 'AI is not configured yet. An administrator must add a provider key.' });
      const r = await callProvider(a.provider, a.key, system, user, req.body?.json !== false);
      return res.status(r.status).json(r.text ? { text: r.text } : { code: r.code, error: r.error });
    } catch (e) {
      console.error('[ai/ask]', e.message);
      return res.status(502).json({ code: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', error: 'The AI provider could not be reached.' });
    }
  });
}
