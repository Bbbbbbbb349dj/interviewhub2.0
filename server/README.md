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
cp .env.example .env     # edit DATABASE_URL / JWT_SECRET
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
| `POST /api/auth/register` | — | `{name,email,password}` → `{token,user}` |
| `POST /api/auth/login` | — | `{email,password}` → `{token,user}` |
| `GET /api/auth/me` | Bearer | current account |
| `PATCH /api/auth/profile` | Bearer | update name/profile |
| `DELETE /api/auth/me` | Bearer | delete account + all data |
| `GET /api/sync/pull` | Bearer | full user snapshot |
| `POST /api/sync/push` | Bearer | upsert collections/docs + deletions |
| `DELETE /api/sync/all` | Bearer | wipe synced data, keep account |

## Notes

- **AI API keys (BYOK) are never synced to the server** — they stay in the
  device's local database only and are sent directly to OpenAI/Gemini.
- Set a strong `JWT_SECRET` in production; restrict `CORS_ORIGIN` to your
  app's origin when deploying publicly.
- Swap the database later (MySQL/MongoDB) by reimplementing `db.js` +
  `schema.js` — the REST contract stays identical.
