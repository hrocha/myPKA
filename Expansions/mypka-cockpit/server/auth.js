// auth.js — PIN-gated session auth for the cockpit's LAN mode.
//
// WHY THIS EXISTS
//   The cockpit is loopback-only and read-only by default. To reach it from
//   the user's phone on the home Wi-Fi, the server can bind the LAN (0.0.0.0) — but
//   ONLY behind a PIN. This module is the whole auth surface: it resolves the
//   PIN hash from the canonical gitignored secret store, verifies a submitted
//   PIN in constant time, mints/validates session cookies, and rate-limits the
//   login route. No new dependencies — Node builtin `crypto` only.
//
// THREAT MODEL (Vex spec, 2026-06-02)
//   The LAN is a trusted WPA2/WPA3 home network. The PIN is the gate against a
//   curious housemate / a phone left unlocked / a device that joined the WLAN.
//   It is NOT a defense against a determined attacker already on the LAN with a
//   packet sniffer (HTTP is plaintext — accepted Vex tradeoff for the home WLAN;
//   the `USE_TLS` flag makes a later TLS upgrade a one-line change).
//
// SECRET HYGIENE (hard rule — never the cleartext PIN anywhere)
//   The PIN is stored ONLY as a scrypt hash in `Team Knowledge/.env` as
//   COCKPIT_PIN_HASH=scrypt$N$r$p$<saltHex>$<hashHex>. The cleartext PIN never
//   touches the repo, the .env, the process memory beyond the verify call, or any
//   log line. We parse exactly that one key out of .env (same single-key-parse
//   pattern the connectors use for their keys) — we do NOT load the whole file into
//   process.env, to keep the blast radius minimal.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// Shared resolver — see repoRoot.js for the MYPKA_ROOT → fingerprint → fallback order.
import { REPO_ROOT } from './repoRoot.js';

const ENV_PATH = path.resolve(REPO_ROOT, 'Team Knowledge', '.env');

// scrypt parameters. N=16384 (2^14) is the Node default cost; r=8, p=1 are the
// classic scrypt tunables. Kept in the hash string so a future cost bump stays
// backward-compatible (old hashes still verify against their own embedded params).
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEYLEN = 32; // 256-bit derived key
const SALT_BYTES = 16;

// Minimum PIN strength (Vex spec): at least 6 digits.
export const MIN_PIN_LENGTH = 6;

// ---------------------------------------------------------------------------
// Hash format helpers — `scrypt$N$r$p$<saltHex>$<hashHex>`
// ---------------------------------------------------------------------------

/** Hash a cleartext PIN into the storable string. Used by set-pin.js only. */
export function hashPin(pin) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(pin, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Parse a stored hash string into its parts, or null if malformed. */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[4], 'hex');
    hash = Buffer.from(parts[5], 'hex');
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r, p, salt, hash };
}

/**
 * Constant-time verify of a submitted PIN against a stored scrypt hash.
 * Re-derives with the SALT + PARAMS embedded in the stored hash, then compares
 * with crypto.timingSafeEqual. Returns false on any malformed input — never
 * throws to the caller, never logs the PIN.
 */
export function verifyPin(pin, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (typeof pin !== 'string' || pin.length === 0) return false;
  let derived;
  try {
    derived = crypto.scryptSync(pin, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
  } catch {
    return false;
  }
  // Lengths are equal by construction (we derived to parsed.hash.length), so
  // timingSafeEqual is safe to call directly.
  if (derived.length !== parsed.hash.length) return false;
  return crypto.timingSafeEqual(derived, parsed.hash);
}

// ---------------------------------------------------------------------------
// PIN-hash resolution — env first, then the single .env line (NEVER whole file)
// ---------------------------------------------------------------------------

/** Returns the stored COCKPIT_PIN_HASH string, or null if none configured. */
export function resolvePinHash() {
  if (process.env.COCKPIT_PIN_HASH && process.env.COCKPIT_PIN_HASH.trim()) {
    return process.env.COCKPIT_PIN_HASH.trim();
  }
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*COCKPIT_PIN_HASH\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* .env absent or unreadable — fall through to null */
  }
  return null;
}

/** True iff a usable (well-formed) PIN hash is configured. */
export function isPinConfigured() {
  const stored = resolvePinHash();
  return stored != null && parseHash(stored) != null;
}

export { ENV_PATH, parseHash };

// ---------------------------------------------------------------------------
// Session store — in-memory Map, sessionId -> { created, lastSeen }.
// Restart wipes all sessions (acceptable: single user). 32-byte random hex ids.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'cockpit_sid';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

const sessions = new Map();

export function createSession() {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { created: now, lastSeen: now });
  return id;
}

/** Validate a session id; refresh lastSeen on a hit. Expired sessions are evicted. */
export function isValidSession(id) {
  if (!id || typeof id !== 'string') return false;
  const s = sessions.get(id);
  if (!s) return false;
  const now = Date.now();
  if (now - s.created > SESSION_TTL_MS) {
    sessions.delete(id);
    return false;
  }
  s.lastSeen = now;
  return true;
}

export function destroySession(id) {
  if (id) sessions.delete(id);
}

// Parse the session id out of a Cookie header without a cookie-parser dep.
export function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === SESSION_COOKIE) return part.slice(idx + 1).trim();
  }
  return null;
}

// Build the Set-Cookie value. `secure` toggles with USE_TLS so a later HTTPS
// switch is a one-flag change (Vex spec point 4).
export function buildSessionCookie(id, { secure }) {
  const attrs = [
    `${SESSION_COOKIE}=${id}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearCookie({ secure }) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// ---------------------------------------------------------------------------
// Brute-force throttle on the login route (Vex spec point 3).
//   - global failure counter (single user, so global == per-user)
//   - 5 failures -> 15-minute lockout (immediate 429 during the window)
//   - artificial 200..500ms delay on EVERY attempt (success or fail) so an
//     attacker can't time-distinguish a near-miss, and can't machine-gun guesses
//   - success resets the counter
// ---------------------------------------------------------------------------

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

const throttle = { failures: 0, lockedUntil: 0 };

/** If locked, returns { locked: true, retryAfterMs }. Else { locked: false }. */
export function checkLock() {
  const now = Date.now();
  if (throttle.lockedUntil > now) {
    return { locked: true, retryAfterMs: throttle.lockedUntil - now };
  }
  // Window elapsed — clear a stale lock so a fresh round of attempts is allowed.
  if (throttle.lockedUntil && throttle.lockedUntil <= now) {
    throttle.lockedUntil = 0;
    throttle.failures = 0;
  }
  return { locked: false };
}

export function recordFailure() {
  throttle.failures += 1;
  if (throttle.failures >= MAX_FAILURES) {
    throttle.lockedUntil = Date.now() + LOCKOUT_MS;
  }
}

export function recordSuccess() {
  throttle.failures = 0;
  throttle.lockedUntil = 0;
}

/** Random 200..500ms delay applied to every login attempt. */
export function loginDelay() {
  const ms = 200 + Math.floor(Math.random() * 301); // [200,500]
  return new Promise((r) => setTimeout(r, ms));
}

// Test-only reset hook (not used in production paths).
export function _resetThrottleForTest() {
  throttle.failures = 0;
  throttle.lockedUntil = 0;
}
