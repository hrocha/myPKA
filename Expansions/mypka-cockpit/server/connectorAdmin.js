// connectorAdmin.js — secure storage of connector credentials + the hub agenda.
//
// THE KEY-VAULT CONTRACT (why this design):
//   * The user pastes an API key ONCE into the cockpit's Connections page. The
//     server upserts it as one line in `Team Knowledge/.env` (mode 0600).
//   * From then on, everything — the cockpit's connectors AND any LLM assistant
//     wiring up a new tool — references the key BY NAME ONLY (readEnvKey('X')).
//     The value never appears in an API response, a log line, an error message,
//     or an LLM context. GET surfaces return only { key, configured: boolean }.
//   * Deleting a key removes the line. No read-back endpoint exists at all.
import fs from 'node:fs';
import path from 'node:path';
import { ENV_PATH, hasEnv } from './connectors/env.js';
import { taskConnectors, calendarConnectors } from './connectors/registry.js';

// Key names: SCREAMING_SNAKE, 3..64 chars, must not collide with the cockpit's
// own operational variables (those are configured at launch, not via the UI).
const KEY_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const PROTECTED_KEYS = new Set([
  'COCKPIT_PIN_HASH', 'COCKPIT_BIND_LAN', 'COCKPIT_USE_TLS',
  'COCKPIT_TLS_CERT', 'COCKPIT_TLS_KEY', 'WORKBENCH_WRITE_ENABLED',
  'PLAN_WRITE_ENABLED', 'SOURCE_WRITE_ENABLED', 'PORT',
]);
const MAX_VALUE_LEN = 4096;

/** Validate a candidate env key name for UI-driven storage. */
export function validKeyName(key) {
  return typeof key === 'string' && KEY_RE.test(key) && !PROTECTED_KEYS.has(key);
}

// Atomic single-line upsert into Team Knowledge/.env. Preserves every other
// line byte-for-byte. Creates the file (0600) when absent. The value is
// validated to be single-line and size-capped; it is NEVER logged.
export function setEnvKey(key, value) {
  if (!validKeyName(key)) return { ok: 'bad-key' };
  if (typeof value !== 'string' || !value.trim()) return { ok: 'bad-value' };
  const v = value.trim();
  if (v.length > MAX_VALUE_LEN || v.includes('\n') || v.includes('\r') || v.includes('\0')) {
    return { ok: 'bad-value' };
  }
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    /* absent — will be created */
  }
  const lines = raw.length ? raw.split('\n') : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && re.test(line)) {
      replaced = true;
      return `${key}=${v}`;
    }
    return line;
  });
  if (!replaced) {
    while (next.length && next[next.length - 1].trim() === '') next.pop();
    next.push(`${key}=${v}`, '');
  }
  const dir = path.dirname(ENV_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.envtmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, next.join('\n'), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best-effort on exotic fs */ }
  // The launch environment may shadow the file; clear any stale process copy so
  // hasEnv/readEnvKey see the new value immediately.
  if (process.env[key] !== undefined) delete process.env[key];
  return { ok: 'saved', key, configured: hasEnv(key) };
}

/** Remove a key's line from .env. */
export function clearEnvKey(key) {
  if (!validKeyName(key)) return { ok: 'bad-key' };
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return { ok: 'cleared', key, configured: false };
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const next = raw.split('\n').filter((line) => !re.test(line));
  const tmp = path.join(path.dirname(ENV_PATH), `.envtmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, next.join('\n'), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  if (process.env[key] !== undefined) delete process.env[key];
  return { ok: 'cleared', key, configured: hasEnv(key) };
}

/**
 * listStoredKeyNames() → key NAMES present in Team Knowledge/.env that are
 * neither cockpit-operational (PROTECTED_KEYS) nor claimed by a registry
 * connector. These are the "stored, awaiting a connector" keys the Connections
 * page surfaces so a half-wired tool stays visible. NAMES ONLY — never values.
 */
export function listStoredKeyNames(registryKeys) {
  const known = new Set(registryKeys || []);
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return [];
  }
  const names = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]{2,63})\s*=/);
    if (!m) continue;
    const k = m[1];
    if (PROTECTED_KEYS.has(k) || known.has(k)) continue;
    names.push(k);
  }
  return names;
}

// ---- Hub agenda ----------------------------------------------------------------
// Today's picture in one read: tasks due today / overdue (from every configured
// task connector) + today's calendar events (from every calendar connector).
// Shapes are the connectors' normalized, secret-free ones, trimmed for the hub.
// PLANNER SEAM: when the planner module is active it may merge the items the
// user explicitly planned for today (see the marked block below).

function displayToday() {
  // Mirrors the connectors' display-timezone bucketing (types.js DISPLAY_TZ).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Monday of the week containing `day` ('YYYY-MM-DD') — fetchWeek's anchor.
function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export async function getAgenda() {
  const today = displayToday();
  const weekStart = mondayOf(today);

  const taskResults = await Promise.all(
    taskConnectors().map((c) => c.fetchWeek(weekStart).catch(() => ({ ok: false, items: [] })))
  );
  const eventResults = await Promise.all(
    calendarConnectors().map((c) => c.fetchWeek(weekStart).catch(() => ({ ok: false, items: [] })))
  );

  const tasks = [];
  for (const r of taskResults) {
    for (const t of r.items || []) {
      if (t.dueBucket === 'today' || t.dueBucket === 'overdue') {
        tasks.push({
          id: t.id, source: t.source, title: t.title,
          due: t.due ?? null, dueBucket: t.dueBucket,
          priorityRank: t.priorityRank ?? 5, url: t.url ?? null,
        });
      }
    }
  }
  tasks.sort((a, b) => (a.dueBucket === b.dueBucket ? a.priorityRank - b.priorityRank
    : a.dueBucket === 'overdue' ? -1 : 1));

  const events = [];
  for (const r of eventResults) {
    for (const e of r.items || []) {
      if (e.day === today) {
        events.push({
          uid: e.uid, source: e.source, title: e.title,
          start: e.start, end: e.end, allDay: !!e.allDay,
          location: e.location ?? null, url: e.url ?? null,
        });
      }
    }
  }
  events.sort((a, b) => Number(!!a.allDay) - Number(!!b.allDay) || a.start.localeCompare(b.start));

  // PLANNER SEAM — when the planner module is wired, merge the user's planned
  // items for `today` here (planned: [{ id, source, title, url }]). The hub
  // renders `planned` above `tasks` when present.
  let planned = [];
  try {
    const planner = await import('./plannerDb.js');
    if (typeof planner.getPlannedForDay === 'function') {
      planned = planner.getPlannedForDay(today) || [];
    }
  } catch {
    /* planner module not installed — agenda works without it */
  }
  // Enrich planned rows with live task data: plan_assignments stores only
  // (source, id, note), so join against the tasks the connectors just fetched
  // to recover real titles + deep links. Unmatched rows keep their note/id.
  if (planned.length) {
    const live = new Map();
    for (const r of taskResults) {
      for (const t of r.items || []) live.set(`${t.source}\u0000${t.id}`, t);
    }
    planned = planned.map((p) => {
      const t = live.get(`${p.source}\u0000${p.id}`);
      return t ? { ...p, title: t.title, url: t.url ?? null, dueBucket: t.dueBucket } : p;
    });
  }

  const sources = {
    tasks: taskResults.map((r) => ({ source: r.source, ok: !!r.ok, reason: r.reason ?? null })),
    calendar: eventResults.map((r) => ({ source: r.source, ok: !!r.ok, reason: r.reason ?? null })),
  };

  return { today, planned, tasks: tasks.slice(0, 20), events: events.slice(0, 20), sources };
}
