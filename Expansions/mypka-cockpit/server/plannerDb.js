// plannerDb.js — opens mypka-cockpit.db READ-WRITE. Cockpit-owned plan state.
//
// This is the cockpit's day-planner write surface. It is wholly separate from
// server/db.js (which opens mypka.db {readonly:true}+query_only). The hard
// invariants (Silas spec, 05-plan-state-persistence, 2026-06-02):
//
//   * Separate FILE, separate CONNECTION. This module does NOT import db.js and
//     never touches mypka.db. The regen pipeline (regen-mypka-db.py) only ever
//     unlinks/rebuilds mypka.db — it has no code path that reaches
//     mypka-cockpit.db, so survival is STRUCTURAL, not guarded.
//   * (source, external_task_id) is the idempotency key. assign() is an UPSERT,
//     never a blind INSERT — re-dragging a task MOVES it, never duplicates.
//   * `position` is ALWAYS server-computed from neighbor ids, never trusted from
//     the client. The neighbor-read + write happen in ONE transaction so two
//     rapid drags can't collide on the same fractional gap.
//   * Migrations are append-only and idempotent (CREATE ... IF NOT EXISTS,
//     INSERT OR IGNORE), applied on boot in schema_version order.
//
// Mounted/consumed by Mack's /api/planner/* endpoints (Wave 2) and Felix's
// board (Wave 3, getWeek output shape). Exported signatures are the API
// contract points — see the doc-block on each exported function.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives at .../mypka-cockpit/server/plannerDb.js → DB at the cockpit root.
const PLANNER_DB_PATH = path.resolve(__dirname, '..', 'mypka-cockpit.db');
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

// Read-write (no readonly flag). WAL + FK on, mirroring the cockpit's pragma posture.
const db = new Database(PLANNER_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- ISO-8601 UTC timestamp, app-side ---------------------------------------
// We compute timestamps in JS rather than leaning only on SQLite's strftime
// default so updated_at on an UPSERT/UPDATE is explicit and consistent.
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ============================================================================
// Boot migration runner — idempotent, append-only, schema_version-ordered.
// ============================================================================
//
// planner_meta is created HERE, not inside a versioned migration: the runner
// must read schema_version to decide what to apply, so the version table has to
// exist before any migration runs. Bootstrapping it inside a versioned file
// would be circular. Feature schema lives in migrations/*.sql; the meta table
// is the runner's own bookkeeping.

// Module-level identity markers, populated by migrate() on boot. These let the
// server announce which schema this process is actually running against, so a
// stale instance (old code, old DB) is detectable by comparing /api/health
// across ports. Read-only after boot.
let SCHEMA_VERSION = 0;       // the DB's schema_version AFTER the boot migration run
let HIGHEST_KNOWN_MIGRATION = 0; // the highest NNN-*.sql this code build ships

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS planner_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const getVersion = () => {
    const row = database
      .prepare(`SELECT value FROM planner_meta WHERE key = 'schema_version'`)
      .get();
    return row ? parseInt(row.value, 10) : 0;
  };
  const setVersion = (v) =>
    database
      .prepare(
        `INSERT INTO planner_meta (key, value) VALUES ('schema_version', @v)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run({ v: String(v) });

  // Discover migrations: NNN-*.sql, applied in ascending numeric order. The
  // leading integer IS the target schema_version a file brings the DB up to.
  let files = [];
  try {
    files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+-.*\.sql$/.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  } catch (err) {
    throw new Error(`plannerDb: cannot read migrations dir ${MIGRATIONS_DIR}: ${err.message}`);
  }

  // The highest schema_version this CODE build knows how to produce — the max
  // leading integer across the migration files on disk. Captured before the
  // apply loop so we can compare it against the DB's recorded version below.
  HIGHEST_KNOWN_MIGRATION = files.reduce((max, f) => Math.max(max, parseInt(f, 10)), 0);

  for (const file of files) {
    const version = parseInt(file, 10);
    if (version <= getVersion()) continue; // already applied — no-op

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration + its version stamp lands in ONE transaction. If the SQL
    // throws, the version is not bumped and the partial work rolls back.
    const apply = database.transaction(() => {
      database.exec(sql);
      setVersion(version);
    });
    apply();
  }

  // Record the post-run DB version for the health/identity surface.
  SCHEMA_VERSION = getVersion();

  // STALE-CODE DETECTION: if the DB sits at a HIGHER schema_version than the
  // highest migration this build ships, we are running OLDER code against a
  // newer DB (the classic "it 404s / won't save" footgun — a pre-edit process
  // lingering on a non-default port). Migrations are append-only, so this is
  // never legitimate. Log it LOUD; the runner does not (and must not) attempt a
  // down-migration — the fix is to restart on the current build.
  if (SCHEMA_VERSION > HIGHEST_KNOWN_MIGRATION) {
    console.warn(
      `\n  ⚠ STALE CODE: planner DB is at schema v${SCHEMA_VERSION}, but this build ` +
      `only knows up to v${HIGHEST_KNOWN_MIGRATION}.\n` +
      `  This process is running OLDER code than the database. Restart on the ` +
      `current build (a forgotten instance is likely still bound to another port).\n`
    );
  }
}

migrate(db);

// ============================================================================
// Position — UNIFIED LANE SPACE (migration 008). Client-computed, server-guarded.
// ============================================================================
//
// THE NEW CONTRACT (2026-06-23, unified events+tasks ordering). There is ONE
// comparable position space per lane (week_start, weekday, half) spanning BOTH
// events (deterministic, time-derived, NEVER stored — read-only calendar anchors)
// and tasks (this stored REAL `position`). Events are positioned at their local
// start minute-of-day (0..1439); tasks float in the SAME numeric space.
//
// WHY THE CLIENT SENDS THE POSITION NOW (not before_id/after_id). The old
// neighbor-id scheme could only name a PLAN ROW as a neighbor — and an event has
// no plan row, so it could never be a neighbor. That is the exact reason a task
// could not be ordered between a task and an event. The client already knows
// every neighbor's position in the unified space (an event's time-derived
// position is computed client-side; a task's stored position came down on the
// week read), so it computes the dropped task's target numeric position directly
// and sends it. The server keeps O(1): validate a finite number, write it.
//
// SERVER GUARD (the precision backstop survives). The client's target may collide
// with an existing row to within MIN_GAP (two very close fractional midpoints).
// When that happens for THIS task's destination cell, the server renormalizes the
// cell to clean stride-1 ranks, then re-derives a safe position from the client's
// INTENT (where it wanted to sit relative to its neighbors). The client also sends
// the optional neighbor positions (before_pos / after_pos) it used, purely so the
// server can re-find that slot after a renormalize. They are advisory hints, never
// trusted as ids — there is no DB lookup on them.

const MIN_GAP = 1e-6; // below this, renormalize the cell rather than trust the value.
const EVENT_FLOOR = 1440.0; // positions >= this are "below every event" (1439 = 23:59).
// (The old neighbor-id position reader was retired with the unified-space contract:
// positions are now client-computed, so the server never resolves a neighbor row's
// position by id. cellMaxStmt / cellPositionsStmt below cover the guard's needs.)

// Clamp/validate a client-sent unified position to a finite REAL. Returns the
// number, or null when it is not a usable finite value.
function sanitizePosition(p) {
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

// All current positions in a cell, ascending (for collision + renormalize math).
const cellPositionsStmt = db.prepare(`
  SELECT id, position FROM plan_assignments
  WHERE week_start = @week_start AND weekday = @weekday AND half = @half
  ORDER BY position, id
`);

// Decide the final stored position for a unified-space drop.
//   target   = the client's computed position in the unified lane space.
//   excludeId= the moving row's own id (so a same-cell move ignores itself when
//              checking for a collision); null for a brand-new placement.
// Returns { position } to write, possibly AFTER renormalizing the cell. If the
// target lands cleanly (no neighbor within MIN_GAP) we honor it verbatim — that
// is the whole point: a position BELOW an event's time-position (e.g. 599.5 under
// a 10:00 event at 600) persists exactly as the client intended.
function resolveUnifiedPosition(database, cellKey, target, excludeId) {
  const safe = sanitizePosition(target);
  if (safe == null) {
    // No usable target: append below everything (tail of the event-floor band).
    const max = cellMaxStmt.get(cellKey)?.maxpos;
    return { position: (max != null ? Math.max(max, EVENT_FLOOR) : EVENT_FLOOR) + 1.0 };
  }
  const rows = cellPositionsStmt.all(cellKey).filter((r) => r.id !== excludeId);
  // Collision check: is any OTHER row within MIN_GAP of the target? If not, the
  // fractional space is healthy and we store the client's value as-is.
  const tooClose = rows.some((r) => Math.abs(r.position - safe) < MIN_GAP);
  if (!tooClose) return { position: safe };

  // Precision backstop: the cell's fractional gaps collapsed around the target.
  // Capture the intended RANK from the ORIGINAL positions FIRST (how many OTHER rows
  // sit strictly below the client's target). `rows` is ascending and already excludes
  // the moving row, so `below` is the 0-based slot the task wants among the others.
  const below = rows.filter((r) => r.position < safe).length;
  // Now renormalize the whole cell to clean stride-1 ranks (1.0, 2.0, 3.0…) in
  // current order — this rebuilds EVERY row's number, including the moving row if it
  // already lives here, but PRESERVES their relative order. We then re-read the cell
  // (excluding the moving row again) and slot the task at the SAME rank index, so the
  // move's meaning ("between these two neighbours") survives the renumber.
  const ts = nowIso();
  renormalizeCell(database, cellKey, ts);
  const after = cellPositionsStmt.all(cellKey).filter((r) => r.id !== excludeId);
  const idx = Math.min(below, after.length);
  const prev = idx > 0 ? after[idx - 1].position : null;
  const next = idx < after.length ? after[idx].position : null;
  if (prev != null && next != null) return { position: (prev + next) / 2.0 };
  if (prev != null) return { position: prev + 0.5 };
  if (next != null) return { position: next - 0.5 };
  return { position: 1.0 };
}

// Rewrite every row in a (week_start, weekday, half) cell to clean 1.0,2.0,3.0…
// in current position order. The §2.3 precision backstop — rare, single-cell.
const renormCellStmt = db.prepare(`
  SELECT id FROM plan_assignments
  WHERE week_start = @week_start AND weekday = @weekday AND half = @half
  ORDER BY position
`);
const setPositionStmt = db.prepare(
  `UPDATE plan_assignments SET position = @position, updated_at = @updated_at WHERE id = @id`
);
function renormalizeCell(database, { week_start, weekday, half }, ts) {
  const ids = renormCellStmt.all({ week_start, weekday, half });
  ids.forEach((row, i) => {
    setPositionStmt.run({ id: row.id, position: (i + 1) * 1.0, updated_at: ts });
  });
}

// Current max(position) for a cell (NULL when empty).
const cellMaxStmt = db.prepare(`
  SELECT MAX(position) AS maxpos FROM plan_assignments
  WHERE week_start = @week_start AND weekday = @weekday AND half = @half
`);

// ============================================================================
// Prepared statements — the operations Mack's endpoints wrap verbatim (§3).
// ============================================================================

const selWeekStmt = db.prepare(`
  SELECT id, week_start, weekday, half, source, external_task_id, position, note
  FROM plan_assignments
  WHERE week_start = @week_start
  ORDER BY weekday, half, position
`);

const selSettingsStmt = db.prepare(
  `SELECT workdays, am_pm_split, work_hours, timezone, lunch_break, complete_on_source FROM planner_settings WHERE id = 1`
);

const upsertAssignStmt = db.prepare(`
  INSERT INTO plan_assignments
    (week_start, weekday, half, source, external_task_id, position, updated_at)
  VALUES
    (@week_start, @weekday, @half, @source, @external_task_id, @position, @updated_at)
  ON CONFLICT (source, external_task_id) DO UPDATE SET
    week_start = excluded.week_start,
    weekday    = excluded.weekday,
    half       = excluded.half,
    position   = excluded.position,
    updated_at = excluded.updated_at
`);

const reorderStmt = db.prepare(`
  UPDATE plan_assignments
  SET position = @position, updated_at = @updated_at
  WHERE id = @id
`);

const selByIdStmt = db.prepare(`
  SELECT id, week_start, weekday, half, source, external_task_id, position, note
  FROM plan_assignments WHERE id = @id
`);

const selByNaturalKeyStmt = db.prepare(`
  SELECT id, week_start, weekday, half, source, external_task_id, position, note
  FROM plan_assignments WHERE source = @source AND external_task_id = @external_task_id
`);

const unassignStmt = db.prepare(
  `DELETE FROM plan_assignments WHERE source = @source AND external_task_id = @external_task_id`
);

const putSettingsStmt = db.prepare(`
  UPDATE planner_settings
  SET workdays = @workdays, am_pm_split = @am_pm_split,
      work_hours = @work_hours, timezone = @timezone,
      lunch_break = @lunch_break, complete_on_source = @complete_on_source,
      updated_at = @updated_at
  WHERE id = 1
`);

// ---- weekly goals (migration 003) ------------------------------------------
// Planner-local flags. READ-ONLY w.r.t. the source task tools — nothing here is
// written back to the source tools; (source, external_task_id) is the opaque link
// only. (week_start, source, external_task_id) is the idempotency key.

const selWeeklyGoalsStmt = db.prepare(`
  SELECT source, external_task_id
  FROM weekly_goals
  WHERE week_start = @week_start
  ORDER BY created_at, id
`);

const setWeeklyGoalStmt = db.prepare(`
  INSERT INTO weekly_goals (week_start, source, external_task_id, created_at)
  VALUES (@week_start, @source, @external_task_id, @created_at)
  ON CONFLICT (week_start, source, external_task_id) DO NOTHING
`);

const unsetWeeklyGoalStmt = db.prepare(`
  DELETE FROM weekly_goals
  WHERE week_start = @week_start AND source = @source AND external_task_id = @external_task_id
`);

// ---- completed tasks (migration 004) ---------------------------------------
// Planner-LOCAL completion flag (Iris spec 20 §7). READ-ONLY w.r.t. the source
// task tools — setCompleted/unsetCompleted touch ONLY this table; the source-side
// close (the source tools) is a separately-gated runtime call in the route layer,
// never here. (week_start, source, external_task_id) is the idempotency key.

const selCompletedStmt = db.prepare(`
  SELECT source, external_task_id
  FROM completed_tasks
  WHERE week_start = @week_start
  ORDER BY completed_at, id
`);

const setCompletedStmt = db.prepare(`
  INSERT INTO completed_tasks (week_start, source, external_task_id, completed_at)
  VALUES (@week_start, @source, @external_task_id, @completed_at)
  ON CONFLICT (week_start, source, external_task_id) DO NOTHING
`);

const unsetCompletedStmt = db.prepare(`
  DELETE FROM completed_tasks
  WHERE week_start = @week_start AND source = @source AND external_task_id = @external_task_id
`);

// ============================================================================
// Exported data-access API.  ── CONTRACT POINTS Mack must match ──
// ============================================================================

/**
 * getWeek(weekStart) → { settings, assignments }
 *   weekStart: ISO Monday 'YYYY-MM-DD'.
 *   Returns the raw rows for the week (flat, ordered weekday→half→position) plus
 *   the settings singleton. The endpoint layer groups into
 *   { days: { 0:{am:[],pm:[]}, … } } and runs §4.1 reconciliation; this layer
 *   stays a pure data read so Felix consumes a stable shape.
 *
 *   @returns {{ settings: {workdays,am_pm_split,work_hours,timezone,lunch_break}|null,
 *               assignments: Array<{id,week_start,weekday,half,source,
 *                 external_task_id,position,note}> }}
 */
export function getWeek(weekStart) {
  return {
    settings: selSettingsStmt.get({ week_start: weekStart }) ?? selSettingsStmt.get() ?? null,
    assignments: selWeekStmt.all({ week_start: weekStart }),
  };
}

/**
 * assign({ weekStart, weekday, half, source, externalTaskId, position })
 *   UPSERT on (source, external_task_id). `position` is the client-computed target
 *   in the UNIFIED lane space (events@time-pos + tasks@stored-pos). The server
 *   honors it verbatim unless it collides with an existing row within MIN_GAP, in
 *   which case it renormalizes the destination cell and re-derives a safe slot at
 *   the same rank (all inside ONE transaction). Idempotent: re-assigning the same
 *   task MOVES it (re-laning + repositioning), never duplicates.
 *
 *   position = a finite REAL; a task dropped ABOVE an event at time-position P is
 *              sent with a position < P, below it with a position > P. May be
 *              null/omitted for an append-to-tail drop (server picks the tail).
 *
 *   @returns the resulting row (post-upsert).
 */
export function assign({ weekStart, weekday, half, source, externalTaskId, position }) {
  const txn = db.transaction(() => {
    const ts = nowIso();
    const cellKey = { week_start: weekStart, weekday, half };
    // A cross-lane move's old row still carries the natural key; exclude it from the
    // destination-cell collision scan (it is not yet in this cell, but be safe — the
    // exclude is a no-op when the row lives in another cell).
    const existing = selByNaturalKeyStmt.get({ source, external_task_id: externalTaskId });
    const { position: finalPosition } =
      resolveUnifiedPosition(db, cellKey, position, existing?.id ?? null);
    upsertAssignStmt.run({
      week_start: weekStart,
      weekday,
      half,
      source,
      external_task_id: externalTaskId,
      position: finalPosition,
      updated_at: ts,
    });
    return selByNaturalKeyStmt.get({ source, external_task_id: externalTaskId });
  });
  return txn();
}

/**
 * reorder({ id, position })
 *   Single-row position UPDATE within the row's existing cell. `position` is the
 *   client-computed target in the UNIFIED lane space; the server honors it verbatim
 *   unless it collides within MIN_GAP, in which case it renormalizes the cell and
 *   re-derives a safe slot at the same rank (all inside ONE transaction). Used for a
 *   SAME-LANE move (cross-lane moves route through assign, which re-lanes).
 *
 *   @returns the updated row.
 */
export function reorder({ id, position }) {
  const txn = db.transaction(() => {
    const ts = nowIso();
    const row = selByIdStmt.get({ id });
    if (!row) return null; // nothing to reorder
    const cellKey = { week_start: row.week_start, weekday: row.weekday, half: row.half };
    const { position: finalPosition } = resolveUnifiedPosition(db, cellKey, position, id);
    reorderStmt.run({ id, position: finalPosition, updated_at: ts });
    return selByIdStmt.get({ id });
  });
  return txn();
}

/**
 * unassign({ source, externalTaskId })
 *   Idempotent hard delete. Deleting an already-gone card affects 0 rows and
 *   returns cleanly.
 *
 *   @returns { deleted: number } rows affected (0 or 1).
 */
export function unassign({ source, externalTaskId }) {
  const info = unassignStmt.run({ source, external_task_id: externalTaskId });
  return { deleted: info.changes };
}

/**
 * getSettings() → the singleton settings row
 *   { workdays, am_pm_split, work_hours, timezone, lunch_break }.
 *   JSON columns (workdays, work_hours, lunch_break) are returned as raw strings;
 *   the endpoint layer parses. lunch_break may be NULL on rows that predate
 *   migration 002 — the endpoint's parseSettings seeds a disabled default.
 */
export function getSettings() {
  return selSettingsStmt.get() ?? null;
}

/**
 * putSettings({ workdays, am_pm_split, work_hours, timezone, lunch_break, complete_on_source })
 *   Overwrites the singleton (id=1). Caller is responsible for JSON-stringifying
 *   workdays/work_hours/lunch_break before passing (they are TEXT columns).
 *   complete_on_source is an INTEGER 0/1 column (no native bool in SQLite) — the
 *   route validator maps the JS boolean ↔ 0/1. Defaults to 0 if omitted (additive,
 *   migration-004 column; older callers that don't send it leave it OFF).
 *   Returns the updated row.
 */
export function putSettings({ workdays, am_pm_split, work_hours, timezone, lunch_break, complete_on_source }) {
  putSettingsStmt.run({
    workdays,
    am_pm_split,
    work_hours,
    timezone,
    lunch_break,
    complete_on_source: complete_on_source ? 1 : 0,
    updated_at: nowIso(),
  });
  return getSettings();
}

/**
 * getCompleted(weekStart) → Array<{ source, external_task_id }>
 *   The planner-local completed-task set for the week. Pure data read — the
 *   endpoint layer tags cards (completedLocal) and the UI derives isDone =
 *   source_completed || completedLocal. READ-ONLY to the source tools.
 *   weekStart: ISO Monday 'YYYY-MM-DD'.
 */
export function getCompleted(weekStart) {
  return selCompletedStmt.all({ week_start: weekStart });
}

/**
 * setCompleted({ weekStart, source, externalTaskId })
 *   Idempotent UPSERT on (week_start, source, external_task_id). Re-completing an
 *   already-completed task is a no-op (0 rows), never a duplicate. LOCAL ONLY —
 *   the source-side close is a separate, separately-gated route-layer call.
 *   @returns { inserted: number } rows added (0 or 1).
 */
export function setCompleted({ weekStart, source, externalTaskId }) {
  const info = setCompletedStmt.run({
    week_start: weekStart,
    source,
    external_task_id: externalTaskId,
    completed_at: nowIso(),
  });
  return { inserted: info.changes };
}

/**
 * unsetCompleted({ weekStart, source, externalTaskId })
 *   Idempotent DELETE. Un-completing an already-gone flag affects 0 rows and
 *   returns cleanly. LOCAL ONLY — un-checking NEVER touches the source (source-done
 *   is sticky per Iris spec 20 §7).
 *   @returns { deleted: number } rows affected (0 or 1).
 */
export function unsetCompleted({ weekStart, source, externalTaskId }) {
  const info = unsetCompletedStmt.run({
    week_start: weekStart,
    source,
    external_task_id: externalTaskId,
  });
  return { deleted: info.changes };
}

/**
 * getWeeklyGoals(weekStart) → Array<{ source, external_task_id }>
 *   The weekly-goal flag set for the week. Pure data read — the endpoint layer
 *   tags cards (isWeeklyGoal) and the UI derives highlights
 *   (isWeeklyGoal && assigned-to-a-day). READ-ONLY to the source tools.
 *   weekStart: ISO Monday 'YYYY-MM-DD'.
 */
export function getWeeklyGoals(weekStart) {
  return selWeeklyGoalsStmt.all({ week_start: weekStart });
}

/**
 * setWeeklyGoal({ weekStart, source, externalTaskId })
 *   Idempotent UPSERT on (week_start, source, external_task_id). Re-marking an
 *   already-flagged task is a no-op (0 rows), never a duplicate.
 *   @returns { inserted: number } rows added (0 or 1).
 */
export function setWeeklyGoal({ weekStart, source, externalTaskId }) {
  const info = setWeeklyGoalStmt.run({
    week_start: weekStart,
    source,
    external_task_id: externalTaskId,
    created_at: nowIso(),
  });
  return { inserted: info.changes };
}

/**
 * unsetWeeklyGoal({ weekStart, source, externalTaskId })
 *   Idempotent DELETE. Unmarking an already-gone flag affects 0 rows and returns
 *   cleanly.
 *   @returns { deleted: number } rows affected (0 or 1).
 */
export function unsetWeeklyGoal({ weekStart, source, externalTaskId }) {
  const info = unsetWeeklyGoalStmt.run({
    week_start: weekStart,
    source,
    external_task_id: externalTaskId,
  });
  return { deleted: info.changes };
}

// Identity accessor for the health/boot surface. Returns the planner DB's
// schema_version (post-boot-migration) and the highest migration this build
// ships — equal in a fresh process, divergent when stale code meets a newer DB.
export function getSchemaIdentity() {
  return { schemaVersion: SCHEMA_VERSION, highestKnownMigration: HIGHEST_KNOWN_MIGRATION };
}

// ---- agenda seam (connectorAdmin.getAgenda) ----------------------------------
// getPlannedForDay(day) → Array<{ id, source, title, url }>
//   The items the user has PLANNED onto a specific calendar day ('YYYY-MM-DD'),
//   derived from plan_assignments (week_start = the day's Monday, weekday = the
//   day's offset). Cheap, read-only, one indexed SELECT — consumed by the hub's
//   /api/cockpit/agenda "PLANNER SEAM" via dynamic import.
//
//   Shape notes: plan_assignments stores no task title or url (the source tools
//   own those; reconciliation happens at /api/planner/week read time). `title`
//   therefore falls back to the row's `note` (the last-known-title scratch the
//   planner writes there) or null; `url` is always null — the agenda renders the
//   id/source pair calmly when no title is known.
const selDayStmt = db.prepare(`
  SELECT external_task_id, source, note FROM plan_assignments
  WHERE week_start = @week_start AND weekday = @weekday
  ORDER BY half, position
`);

export function getPlannedForDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const weekday = (d.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun (matches plan_assignments)
  d.setUTCDate(d.getUTCDate() - weekday);
  const weekStart = d.toISOString().slice(0, 10);
  return selDayStmt.all({ week_start: weekStart, weekday }).map((row) => ({
    id: row.external_task_id,
    source: row.source,
    title: row.note && row.note.trim() ? row.note.trim() : null,
    url: null,
  }));
}

export default db;
export { PLANNER_DB_PATH, migrate };
