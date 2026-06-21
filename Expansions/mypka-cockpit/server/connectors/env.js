// connectors/env.js — the narrow single-key .env reader, shared by all connectors.
//
// This is the EXACT posture clickup.js (`readEnvKey`) and todoist.js (`resolveToken`)
// already use, factored into one place so every connector resolves its secret the
// same minimal way: env first, then ONE matching line out of `Team Knowledge/.env`.
// We never load the whole .env into process.env — only the one key a connector
// needs ever enters the cockpit process. Values are NEVER logged or echoed.

import fs from 'node:fs';
import path from 'node:path';
// Shared resolver (one dir up from connectors/). See repoRoot.js for the order:
// MYPKA_ROOT env → AGENTS.md+PKM/ fingerprint → 3-up fallback. Anchored to the
// cockpit root, so a connector nested here resolves identically to server/*.js.
import { REPO_ROOT } from '../repoRoot.js';

const ENV_PATH = path.resolve(REPO_ROOT, 'Team Knowledge', '.env');

/**
 * Read a single key. Returns the raw value (quote-trimmed) or null. Reads ONLY the
 * one requested line — never loads the whole file into process.env. Never logs the
 * value. Identical semantics to clickup.js#readEnvKey.
 */
export function readEnvKey(key) {
  if (process.env[key] && String(process.env[key]).trim()) {
    return String(process.env[key]).trim();
  }
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`);
    for (const line of raw.split('\n')) {
      const m = line.match(re);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* .env absent or unreadable — fall through to null */
  }
  return null;
}

/** True iff a key resolves to a non-empty value. The registry's auto-enable test. */
export function hasEnv(key) {
  const v = readEnvKey(key);
  return typeof v === 'string' && v.length > 0;
}

/** Mask a secret for any diagnostic surface: never expose more than the last 4. */
export function maskSecret(s) {
  if (!s) return '<none>';
  return `***${String(s).slice(-4)} (len=${String(s).length})`;
}

export { ENV_PATH };
