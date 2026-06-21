// cockpitSettingsDb.js — runtime Hub module preferences, persisted in
// mypka-cockpit.db (READ-WRITE, cockpit-owned). NEVER touches mypka.db.
//
// This is the data-access layer behind the Settings page. It mirrors
// plannerDb.js's posture exactly:
//   * Separate FILE only in the sense that it's the cockpit-local DB, not the
//     canonical mirror. It opens the SAME mypka-cockpit.db file plannerDb.js
//     owns — a second WAL connection to one file is safe (WAL allows concurrent
//     readers + a single writer; our writes are tiny, serialized UPSERTs).
//   * The SCHEMA (table module_prefs) is created by migrations/006-cockpit-
//     settings.sql, which plannerDb.js's boot migration runner applies for us
//     (it scans the whole migrations/ dir). We do NOT re-run migrations here —
//     we just assume the table exists after plannerDb has booted. Importing
//     plannerDb first (server.js does) guarantees that ordering; defensively we
//     also CREATE IF NOT EXISTS on open so a standalone import never throws.
//
// CONTRACT: module-toggle persistence is LOCAL UI STATE. It is not vault data,
// it never leaves the machine, and it can be deleted with the rest of
// mypka-cockpit.db at any time with zero loss of canonical content.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COCKPIT_DB_PATH = path.resolve(__dirname, '..', 'mypka-cockpit.db');

const db = new Database(COCKPIT_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Defensive bootstrap: plannerDb's migration runner normally creates this (006)
// and adds sort_order (007), but guarantee the full shape exists even if this
// module were imported in isolation. The CREATE carries sort_order so a
// from-scratch table matches the post-007 schema; the ADD COLUMN below repairs a
// table that predates 007 (pre-existing 006-only DB opened by this module first).
db.exec(`
  CREATE TABLE IF NOT EXISTS module_prefs (
    module_key  TEXT    PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sort_order  INTEGER NOT NULL DEFAULT -1,
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
`);
// sort_order may be absent on a 006-era table; add it defensively. ADD COLUMN is
// not idempotent, so guard on the live column list rather than catching a throw.
{
  const cols = db.prepare(`PRAGMA table_info(module_prefs)`).all();
  if (!cols.some((c) => c.name === 'sort_order')) {
    db.exec(`ALTER TABLE module_prefs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT -1`);
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ============================================================================
// KNOWN MODULES — the closed set of toggleable Hub sections. The PUT validator
// rejects any key outside this set, so a stale/hostile client can never write a
// junk row. Order here is the order the Settings page renders them.
//
// `label` / `hint` are English chrome (mirrors strings.ts scope); the Settings
// view imports these so server + client agree on the catalogue in ONE place.
// ============================================================================
export const KNOWN_MODULES = [
  { key: 'open_invoices',     label: 'Open Invoices',            hint: 'Overdue and due-soon invoices, loudest first.' },
  { key: 'recently_scanned',  label: 'Recently Scanned Documents', hint: 'The freshest scans, receipts and invoices.' },
  { key: 'buckets',           label: 'My Life bucket cards',     hint: 'Projects · Key Elements · Topics · Goals · Habits.' },
  { key: 'pinned',            label: 'Pinned fleeting notes',    hint: 'Work-in-progress stickies you keep coming back to.' },
  { key: 'whiteboards',       label: 'Whiteboards',              hint: 'Spatial canvases for deep thinking.' },
  { key: 'latest_documents',  label: 'Latest documents',         hint: 'The newest document notes with their files.' },
  { key: 'latest_journal',    label: 'Latest journal',           hint: 'Your three most recent journal entries.' },
  { key: 'random_quote',      label: 'Random quote',             hint: 'A single quote from your Quotes library, freshly picked.' },
  { key: 'on_this_day',       label: 'On This Day',              hint: 'Journal entries from this calendar day in months and years past.' },
];

const KNOWN_KEYS = new Set(KNOWN_MODULES.map((m) => m.key));
// Canonical catalogue index per key — the default order when no row exists or a
// row's sort_order is the "unset" sentinel (< 0).
const CATALOGUE_INDEX = new Map(KNOWN_MODULES.map((m, i) => [m.key, i]));
const KNOWN_KEY_LIST = KNOWN_MODULES.map((m) => m.key);

export function isKnownModuleKey(k) {
  return typeof k === 'string' && KNOWN_KEYS.has(k);
}

// ---- prepared statements ----------------------------------------------------
const selAllStmt = db.prepare(`SELECT module_key, enabled, sort_order FROM module_prefs`);
// Enable/disable UPSERT — leaves sort_order untouched on conflict (a toggle must
// never reorder). On INSERT, seed sort_order to the "unset" sentinel so the read
// path derives the position from the catalogue index.
const upsertEnabledStmt = db.prepare(`
  INSERT INTO module_prefs (module_key, enabled, sort_order, updated_at)
  VALUES (@module_key, @enabled, -1, @updated_at)
  ON CONFLICT (module_key) DO UPDATE SET
    enabled    = excluded.enabled,
    updated_at = excluded.updated_at
`);
// Order UPSERT — leaves `enabled` untouched on conflict (a reorder must never
// change visibility). On INSERT, seed enabled to the default-on posture.
const upsertOrderStmt = db.prepare(`
  INSERT INTO module_prefs (module_key, enabled, sort_order, updated_at)
  VALUES (@module_key, 1, @sort_order, @updated_at)
  ON CONFLICT (module_key) DO UPDATE SET
    sort_order = excluded.sort_order,
    updated_at = excluded.updated_at
`);

// ============================================================================
// Exported data-access API.
// ============================================================================

/**
 * orderedKnownModules() → string[]
 *   The KNOWN_MODULES keys sorted by the user's saved order. Sort key per module:
 *     - a stored row with sort_order >= 0 → that value (an explicit user order)
 *     - no row, or row with the -1 "unset" sentinel → its catalogue index
 *   Ties (two unset modules, or any equal sort_order) break on catalogue index,
 *   so the result is always a stable, total order over the known set. Unknown
 *   keys lingering in the table are ignored entirely.
 */
function orderedKnownModules() {
  const rows = selAllStmt.all().filter((r) => isKnownModuleKey(r.module_key));
  const orderOf = new Map(); // key → numeric sort key
  for (const r of rows) {
    if (typeof r.sort_order === 'number' && r.sort_order >= 0) orderOf.set(r.module_key, r.sort_order);
  }
  return [...KNOWN_KEY_LIST].sort((a, b) => {
    const sa = orderOf.has(a) ? orderOf.get(a) : CATALOGUE_INDEX.get(a);
    const sb = orderOf.has(b) ? orderOf.get(b) : CATALOGUE_INDEX.get(b);
    if (sa !== sb) return sa - sb;
    return CATALOGUE_INDEX.get(a) - CATALOGUE_INDEX.get(b); // stable tiebreak
  });
}

/**
 * getModuleSettings() → { modules: { [key]: boolean }, order: string[] }
 *   The full, default-filled settings the API returns:
 *     - `modules`: enabled map. Missing row → ENABLED (default-on posture).
 *     - `order`:   the known keys in saved display order (see orderedKnownModules).
 *   Only KNOWN_MODULES surface; stale/unknown rows are dropped.
 */
export function getModuleSettings() {
  const stored = new Map(
    selAllStmt.all().filter((r) => isKnownModuleKey(r.module_key)).map((r) => [r.module_key, r.enabled === 1]),
  );
  const modules = {};
  for (const m of KNOWN_MODULES) {
    modules[m.key] = stored.has(m.key) ? stored.get(m.key) : true; // default ON
  }
  return { modules, order: orderedKnownModules() };
}

/**
 * getModulePrefs() → { [moduleKey]: boolean }
 *   Back-compat enabled-only map (kept for any caller that only needs visibility).
 */
export function getModulePrefs() {
  return getModuleSettings().modules;
}

/**
 * setModulePrefs(patch) → { modules, order }
 *   Idempotent UPSERT of a partial enable/disable map { moduleKey: boolean }.
 *   Leaves sort_order untouched. Unknown keys are IGNORED (defense in depth — the
 *   route validator rejects them first). Returns the full settings after write.
 */
export function setModulePrefs(patch) {
  const ts = nowIso();
  const apply = db.transaction((entries) => {
    for (const [key, enabled] of entries) {
      if (!isKnownModuleKey(key)) continue;
      upsertEnabledStmt.run({ module_key: key, enabled: enabled ? 1 : 0, updated_at: ts });
    }
  });
  apply(Object.entries(patch || {}));
  return getModuleSettings();
}

/**
 * setModuleOrder(order) → { modules, order }
 *   Persists a full display order. `order` MUST be a permutation of the known set
 *   (every key once, no missing/dup/extra) — the route validator enforces this;
 *   this layer assumes it and writes sort_order = the array index for each key.
 *   Leaves `enabled` untouched. Returns the full settings after write.
 */
export function setModuleOrder(order) {
  const ts = nowIso();
  const apply = db.transaction((keys) => {
    keys.forEach((key, i) => {
      if (!isKnownModuleKey(key)) return; // defense in depth
      upsertOrderStmt.run({ module_key: key, sort_order: i, updated_at: ts });
    });
  });
  apply(Array.isArray(order) ? order : []);
  return getModuleSettings();
}

// The closed set of known keys, exported for the route's permutation validator.
export { KNOWN_KEY_LIST };

export default db;
export { COCKPIT_DB_PATH };
