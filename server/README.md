# InterviewHub API — PostgreSQL backend

InterviewHub's database of record is **PostgreSQL**. Browsers cannot speak
the PostgreSQL/MySQL/MongoDB wire protocols directly, so (exactly like every
production web app) the web client talks to this small REST API, and the API
talks to PostgreSQL.

The client is *offline-first*: it keeps an IndexedDB replica so the app is
fully usable before/without the server, and automatically syncs with
PostgreSQL (pull → merge → push) whenever the API is reachable. Nothing is
lost offline; nothing is duplicated — collections merge by record id and
singleton docs by last-write-wins timestamps.

## Quick start (Docker — recommended)

From the repo root:

```bash
docker compose up --build
```

This starts:

| Service | URL / Port | Notes |
|---|---|---|
| PostgreSQL 16 | `localhost:5432` | db/user/pass: `interviewhub` |
| API (Express) | `http://localhost:4000` | auto-migrates the schema on boot |

Then connect the web app — either:

- open the app → **Settings → Your data → Server database** → set API URL to
  `http://localhost:4000`, or
- build the app with `VITE_API_URL=http://localhost:4000 npm run build`.

Register an account in the app — it is created in PostgreSQL (bcrypt-hashed
password), and all interviews, coding attempts, aptitude tests, speaking
sessions and resume analyses sync into their tables.

## Quick start (manual)

```bash
# 1. Create the database (any local/remote Postgres 13+)
createdb interviewhub

# 2. Configure + run the API
cd server
cp .env.example .env     # edit DATABASE_URL / APP_URL / SETTINGS_ENCRYPTION_KEY
npm install
npm start                # → listening on :4000, schema auto-migrated
```

The schema is applied idempotently on every boot from `schema.js`
(`schema.sql` mirrors it for manual `psql` provisioning).

## Data model

| Table | Contents |
|---|---|
| `accounts` | users — bcrypt `password_hash`, `profile` JSONB |
| `interviews` | AI interview records (typed score/role columns + JSONB payload) |
| `coding_attempts` | coding arena submissions |
| `aptitude_attempts` | aptitude test results |
| `comm_sessions` | communication-coach sessions |
| `resume_analyses` | resume ATS analyses |
| `user_docs` | singleton docs: `settings`, `theme`, `achievements`, `activityLog` |

All user rows reference `accounts(id) ON DELETE CASCADE`.

## API

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/health` | — | liveness + DB connectivity |
| `POST /api/auth/register` | — | `{name,email,password}` → `{user}` + session cookie |
| `POST /api/auth/login` | — | `{email,password}` → `{user}` + session cookie |
| `POST /api/auth/logout` | cookie | revoke session |
| `POST /api/auth/forgot` / `reset` | — | password reset |
| `GET /api/auth/google/start` / `callback` | — | Google sign-in |
| `GET/PUT/DELETE /api/admin/ai[/:provider]` | admin | manage AI keys |
| `GET /api/ai/status`, `POST /api/ai/ask` | cookie | server-side AI proxy |
| `GET /api/auth/me` | cookie | current account |
| `PATCH /api/auth/profile` | cookie | update name/profile |
| `DELETE /api/auth/me` | cookie | delete account + all data |
| `GET /api/sync/pull` | cookie | full user snapshot |
| `POST /api/sync/push` | cookie | upsert collections/docs + deletions |
| `DELETE /api/sync/all` | cookie | wipe synced data, keep account |

## Notes

- AI keys are set by an admin, encrypted (AES-256-GCM) in PostgreSQL, and only used server-side.
- Swap the database later (MySQL/MongoDB) by reimplementing `db.js` +
  `schema.js` — the REST contract stays identical.

## Authentication, Google, password reset, admin

Sessions are httpOnly, `SameSite=Lax` cookies (`Secure` on Vercel / `NODE_ENV=production`); only a hash of the session token is stored. Run `npm install` in `server/` after pulling (adds `google-auth-library`, removes `jsonwebtoken`). The schema migrates automatically on boot (new tables `sessions`, `password_reset_tokens`, `app_secrets`; new `accounts.google_id`, `accounts.role`).

**Environment variables (Vercel → server project):** `DATABASE_URL`, `APP_URL` (`https://interviewhub20.vercel.app`), `SETTINGS_ENCRYPTION_KEY`, `RESEND_API_KEY` + `MAIL_FROM` (password-reset email via Resend; a verified sender is required), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `JWT_SECRET` is no longer used. Optional: `OPENAI_MODEL`, `GEMINI_MODEL`, `CORS_ORIGIN` (local dev only).

**Google setup:** Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application). Authorized redirect URI: `<APP_URL>/api/auth/google/callback` (also add `http://localhost:4000/api/auth/google/callback` for local dev). Configure the consent screen, then set the two `GOOGLE_*` variables. The button appears only when they are set.

**Create the first admin** (no public admin signup exists). Register or sign in once, then in PostgreSQL:
```sql
UPDATE accounts SET role = 'admin' WHERE email = 'you@example.com';
```
Open **Admin** from the account menu to add/replace/remove the OpenAI and Gemini keys.

Old device-local (IndexedDB) accounts are not migrated; users must register again.

**Neon:** use the connection string from the Neon dashboard as `DATABASE_URL` (the pooled `-pooler` host is recommended on Vercel; keep `?sslmode=require`). Migrations run automatically on first request. Run the admin `UPDATE` in the Neon SQL Editor.
