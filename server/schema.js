/* PostgreSQL schema for InterviewHub — single source of truth.
 * The server applies this automatically on boot (idempotent), and the same
 * DDL is mirrored in schema.sql for manual `psql` provisioning. */

export const SCHEMA_SQL = /* sql */ `
-- ───────────────────────────── accounts ─────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  profile       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────── practice collections ───────────────────────
-- Every collection table shares one shape: identity + owner + a few typed,
-- queryable columns + the full record as JSONB payload (source of truth).
CREATE TABLE IF NOT EXISTS interviews (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role          TEXT,
  type          TEXT,
  difficulty    TEXT,
  overall_score NUMERIC,
  happened_at   TIMESTAMPTZ,
  payload       JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interviews_account ON interviews(account_id);

CREATE TABLE IF NOT EXISTS coding_attempts (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  problem_id  TEXT,
  language    TEXT,
  passed      INTEGER,
  total       INTEGER,
  happened_at TIMESTAMPTZ,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coding_account ON coding_attempts(account_id);

CREATE TABLE IF NOT EXISTS aptitude_attempts (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category    TEXT,
  correct     INTEGER,
  total       INTEGER,
  happened_at TIMESTAMPTZ,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aptitude_account ON aptitude_attempts(account_id);

CREATE TABLE IF NOT EXISTS comm_sessions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  prompt        TEXT,
  overall_score NUMERIC,
  happened_at   TIMESTAMPTZ,
  payload       JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_account ON comm_sessions(account_id);

CREATE TABLE IF NOT EXISTS resume_analyses (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name   TEXT,
  target_role TEXT,
  score       NUMERIC,
  happened_at TIMESTAMPTZ,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resume_account ON resume_analyses(account_id);

-- ─────────────────── per-user singleton documents ────────────────────
-- settings, theme, achievements, activityLog — last-write-wins by the
-- client-side updatedAt clock (epoch ms).
CREATE TABLE IF NOT EXISTS user_docs (
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  doc_key           TEXT NOT NULL,
  body              JSONB,
  client_updated_at BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, doc_key)
);
`;
