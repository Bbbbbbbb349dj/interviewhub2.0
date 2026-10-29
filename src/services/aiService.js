/* AI service — all provider calls are made by the server (/api/ai/*) using
 * keys an administrator configured. No AI key ever reaches the browser. */

import { api } from './apiClient';

let status = { configured: false, provider: null, model: null };

/** Fetch whether AI is configured (no secrets are returned). */
export async function refreshAIStatus(reset = false) {
  if (reset) { status = { configured: false, provider: null, model: null }; return status; }
  try { status = await api.aiStatus(); } catch { status = { configured: false, provider: null, model: null }; }
  return status;
}

export function getAIConfig() {
  return status.configured ? { provider: status.provider, model: status.model } : null;
}

export const aiConfigured = () => status.configured;
export const aiProviderLabel = () => {
  const c = getAIConfig();
  if (!c) return null;
  return c.provider === 'openai' ? `OpenAI · ${c.model}` : `Gemini · ${c.model}`;
};

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* Tolerant JSON extraction: strips code fences, finds the outermost object. */
export function extractJSON(text) {
  if (!text) throw new AIError('BAD_RESPONSE', 'Empty AI response.');
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AIError('BAD_RESPONSE', 'AI did not return valid JSON.');
  }
  let candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      candidate = candidate.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(candidate);
    } catch {
      throw new AIError('BAD_RESPONSE', 'AI returned malformed JSON.');
    }
  }
}

/** ask(system, user, {json}) → object|string. Throws AIError on failure. */
export async function ask(system, user, { json = true } = {}) {
  let raw;
  try {
    ({ text: raw } = await api.aiAsk({ system, user, json }));
  } catch (e) {
    if (e.status === 401) throw new AIError('AUTH_SESSION', 'Your session expired. Please sign in again.');
    if (e.code) throw new AIError(e.code, e.message);
    throw new AIError('NETWORK', e.message || 'Could not reach the server.');
  }
  return json ? extractJSON(raw) : raw;
}

/** Ask with one automatic retry that demands corrected JSON. */
export async function askJSON(system, user) {
  try {
    return await ask(system, user, { json: true });
  } catch (e) {
    if (e.code === 'BAD_RESPONSE') {
      return ask(system, user + '\n\nIMPORTANT: respond with a single valid JSON object and nothing else.', { json: true });
    }
    throw e;
  }
}

/* ---------- Shared score normalisation ---------- */
export const clamp = (n, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, Number.isFinite(+n) ? Math.round(+n) : 0));

export const SCORE_DIMS = [
  'technicalKnowledge', 'communication', 'confidence', 'accuracy',
  'completeness', 'problemSolving', 'grammar',
];

export function normalizeScores(raw = {}) {
  const out = {};
  SCORE_DIMS.forEach((d) => { out[d] = clamp(raw[d] ?? raw.overall ?? 0, 1, 10); });
  out.overall = clamp(
    raw.overall ?? Math.round(SCORE_DIMS.reduce((a, d) => a + out[d], 0) / SCORE_DIMS.length),
    1, 10,
  );
  return out;
}

export function friendlyAIError(e) {
  if (!(e instanceof AIError)) return 'Something went wrong while contacting the AI.';
  switch (e.code) {
    case 'NO_KEY': return 'AI is not configured yet. An administrator must add a provider key.';
    case 'AUTH': return 'The configured AI API key was rejected. Ask an administrator to update it.';
    case 'RATE_LIMIT': return 'Rate limit reached — wait a moment and retry.';
    case 'NETWORK': return 'Network error contacting the AI provider.';
    case 'TIMEOUT': return 'The AI timed out. Please retry.';
    default: return e.message;
  }
}
