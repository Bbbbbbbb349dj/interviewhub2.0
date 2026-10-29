import pg from 'pg';
import { SCHEMA_SQL } from './schema.js';

/** Create a PostgreSQL connection pool from a DATABASE_URL. */
export function createPool(connectionString) {
  return new pg.Pool({ connectionString, max: process.env.VERCEL ? 3 : 10, idleTimeoutMillis: 30000 });
}

/** Apply the schema (idempotent — safe on every boot). */
export async function migrate(pool) {
  await pool.query(SCHEMA_SQL);
}

/** Wait until Postgres accepts connections (docker compose startup race). */
export async function waitForDatabase(pool, attempts = 30, delayMs = 1000) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      lastError = e;
      console.log(`[interviewhub-api] waiting for PostgreSQL… (${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError || new Error('PostgreSQL never became ready');
}
