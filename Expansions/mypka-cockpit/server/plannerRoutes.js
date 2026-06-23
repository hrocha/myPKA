// plannerRoutes.js — the day-planner API surface (Wave 2, Mack).
//
// Wires two read-only reads and the plan-layout WRITE path onto the cockpit's
// Express app. Persistence is delegated VERBATIM to Silas's plannerDb.js (Wave 1);
// this module re-implements NONE of it — it calls the exact named exports
// (getWeek/assign/reorder/unassign/getSettings/putSettings) and never touches db.js
// or mypka.db.
//
// ENDPOINTS
//   GET    /api/cockpit/calendar?week=YYYY-MM-DD   read-only iCal connector output
//   GET    /api/planner/week?week_start=YYYY-MM-DD read-only plan layout + reconciliation
//   POST   /api/planner/assign                     WRITE — place/move a task card
//   POST   /api/planner/reorder                    WRITE — reorder within a cell
//   DELETE /api/planner/assign                     WRITE — remove a placement
//   PUT    /api/planner/settings                   WRITE — work-hours/workdays/split/tz
//
// WRITE-PATH GUARD (HARD): every /api/planner/* WRITE reuses the cockpit's exact
// write guard stack — requireSession (sessionOrLoopback) → localWriteGuard →
// writeJson (4kb, scoped to the route) → strict scope-locked validator. All writes
// sit behind the PLAN_WRITE_ENABLED env flag (default OFF): when unset, a write
// returns a clean { ok:false, reason:'disabled' } 503 and does NOTHING. Reads stay
// on regardless.
//
// SCOPE BOUNDARY (READ-ONLY CONTRACT, this install): the write path NEVER calls an
// external tool. It writes ONLY to the cockpit-local mypka-cockpit.db. It cannot
// reach the source tools/the calendar feed — the upstream source-write code paths
// (PATCH /api/cockpit/tasks/:id, close-on-complete) are not present in this tree.

import {
  getWeek, assign, reorder, unassign, putSettings,
  getWeeklyGoals, setWeeklyGoal, unsetWeeklyGoal,
  getCompleted, setCompleted, unsetCompleted,
} from './plannerDb.js';
import { calendarConnectors, taskConnectors } from './connectors/registry.js';

// Plan-assignment source allow-list. Plan rows are ONLY task cards — a calendar
// event is never a plan row, so the assign/unassign allow-list is the TASK
// connectors only. This deliberately excludes calendar ids (a connector id),
// keeping the edge validator aligned with plan_assignments.source's DB CHECK
// ('todoist','clickup','another-source'). A calendar id is rejected at the edge with a clean
// 400, never reaching the DB to throw a noisy 500.
function assignableSourceIds() {
  return new Set(taskConnectors().map((c) => c.id));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Plan-write master flag. Dormant until Vex clears the write path. Reads ignore it.
function planWriteEnabled() {
  return process.env.PLAN_WRITE_ENABLED === '1';
}

// ============================================================================
// SOURCE-WRITE path — REMOVED in this install (read-only contract, 2026-06-11).
// ============================================================================
// The upstream planner pack carried a dormant "layer B": closing a completed task
// back on the source tools behind SOURCE_WRITE_ENABLED + the complete_on_source
// setting. This cockpit's contract is harder: the planner VISUALIZES; editing
// happens in the source tool via each task's `url` deep link. So the source-write
// functions (sourceWriteEnabled / completeOnSource) and the todoist.js/clickup.js
// client imports are STRIPPED here, not just gated — POST /api/planner/complete
// below is LOCAL-ONLY by construction (completed_tasks table in mypka-cockpit.db).
// The PUT /api/planner/settings validator still ACCEPTS complete_on_source (the
// migration-004 column exists and older payloads may carry it) but the flag arms
// nothing — there is no code path left for it to fire.

// ---- small shared validators ------------------------------------------------

function isIsoDate(v) {
  return typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));
}

// Snap any date to the Monday of its ISO week (defensive: a mid-week date still
// yields the right window). Returns 'YYYY-MM-DD'. Uses UTC date math on the calendar
// date only — no tz dependency for a pure weekday computation.
function snapToMonday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();           // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7;  // 0 if Monday, 1 if Tuesday, …, 6 if Sunday
  dt.setUTCDate(dt.getUTCDate() - deltaToMonday);
  return dt.toISOString().slice(0, 10);
}

// API uses uppercase 'AM'/'PM' (matches NormalizedEvent.half). The DB CHECK is
// lowercase ('am','pm'). Map at the boundary, both directions.
function halfToDb(h) { return h === 'AM' ? 'am' : h === 'PM' ? 'pm' : null; }
function halfFromDb(h) { return h === 'am' ? 'AM' : h === 'pm' ? 'PM' : null; }

// ---- reconciliation ---------------------------------------------------------
// Read-time, derive-don't-store. Cross-reference each persisted assignment's
// (source, external_task_id) against the source's FULL OPEN-task id set:
//   * present in open set                → 'live'  (still an open/active task)
//   * source fetched ok but task absent  → 'done'  (ACTUALLY completed/closed)
//   * source fetch failed (degraded)     → 'stale' (UNKNOWN — never prune on a blip)
//   * connector can't report open ids    → 'stale' (UNKNOWN — never assume done)
// We NEVER delete here. Stale cards are flagged for the user's manual remove (D7).
//
// COMPLETION-SIGNAL FIX (2026-06-03, Mack): the previous build cross-referenced
// against fetchWeek() — the WEEK-WINDOWED sidebar view, which drops dateless tasks
// and anything not due this week. A genuinely OPEN task outside that window was
// therefore mis-tagged 'done' (struck-through). The completion truth is the source's
// UNFILTERED open-task set (reconcileOpenIds): the source tool's GET /tasks and the source tool's
// include_closed=false both return active tasks regardless of due date. So absence
// from THAT set on an ok fetch is real completion, not a window artifact. A card is
// 'done' ONLY when the source confirms the task is no longer open.
//
// Build the full open-id set per task source (one unfiltered fetch per source).
async function liveTaskSets(weekStart) {
  const connectors = taskConnectors();
  const liveBySource = new Map();
  const sourceOk = new Map();
  await Promise.all(connectors.map(async (c) => {
    let result;
    try {
      // Prefer the completion-truth set. Connectors without it can't confirm
      // completion → mark not-ok so reconciliation degrades to 'stale', never 'done'.
      if (typeof c.reconcileOpenIds === 'function') {
        result = await c.reconcileOpenIds();
      } else {
        result = { ok: false, ids: new Set() };
      }
    } catch {
      result = { ok: false, ids: new Set() };
    }
    sourceOk.set(c.id, !!result.ok);
    liveBySource.set(c.id, result.ids instanceof Set ? result.ids : new Set());
  }));
  return { liveBySource, sourceOk };
}

function reconcileStatus(source, taskId, liveBySource, sourceOk) {
  // Unknown source (connector no longer registered, e.g. key removed) → stale.
  if (!sourceOk.has(source)) return 'stale';
  if (!sourceOk.get(source)) return 'stale';         // fetch degraded → don't judge
  const set = liveBySource.get(source);
  if (set && set.has(String(taskId))) return 'live';
  // Fetched the FULL open set ok and the task is not in it → actually completed.
  return 'done';
}

// ============================================================================
// Route registration. `deps` carries the guard middlewares from server.js so the
// write path reuses the EXACT same stack instances (requireSession, localWriteGuard,
// writeJson) — no re-implementation, no drift.
// ============================================================================
export function registerPlannerRoutes(app, deps) {
  const { requireSession, localWriteGuard, writeJson, safeAsync } = deps;

  // -------------------------------------------------------------------------
  // READ — calendar (iCal connector). Read-only, calm degrade, no write flag.
  //   GET /api/cockpit/calendar?week=YYYY-MM-DD
  // Returns the FIRST calendar connector's ConnectorResult for the week, OR a calm
  // not-connected shape when no calendar source is configured (mirrors the
  // /api/cockpit/tasks ok:false pattern). Multiple calendars merge in v1.1.
  // -------------------------------------------------------------------------
  app.get('/api/cockpit/calendar', safeAsync(async (req) => {
    const raw = String(req.query.week || '');
    if (!isIsoDate(raw)) {
      return { ok: false, source: 'calendar', reason: 'misconfigured',
        message: 'week must be an ISO date YYYY-MM-DD', items: [],
        generatedAt: new Date().toISOString() };
    }
    const weekStart = snapToMonday(raw);
    const connectors = calendarConnectors();
    if (!connectors.length) {
      return { ok: false, source: 'calendar', reason: 'no-token',
        message: 'Calendar is not connected (no iCal URL configured).', items: [],
        weekStart, generatedAt: new Date().toISOString() };
    }
    // v1: single primary calendar. Merge all configured calendars' items.
    const results = await Promise.all(connectors.map((c) => c.fetchWeek(weekStart)));
    const items = results.flatMap((r) => r.items || []);
    const anyOk = results.some((r) => r.ok);
    return {
      ok: anyOk,
      source: connectors.length === 1 ? connectors[0].id : 'calendar',
      weekStart,
      generatedAt: new Date().toISOString(),
      reason: anyOk ? undefined : (results[0]?.reason || 'unreachable'),
      message: anyOk ? undefined : (results[0]?.message || 'Calendar is currently unreachable.'),
      items,
    };
  }));

  // -------------------------------------------------------------------------
  // READ — plan layout for a week + reconciliation. Read-only.
  //   GET /api/planner/week?week_start=YYYY-MM-DD
  // Groups Silas's flat rows into { days: {0:{am:[],pm:[]},…} }, tags each card
  // live/done/stale against the live source caches. NEVER prunes.
  // -------------------------------------------------------------------------
  app.get('/api/planner/week', safeAsync(async (req) => {
    const raw = String(req.query.week_start || '');
    if (!isIsoDate(raw)) {
      return { ok: false, reason: 'misconfigured',
        message: 'week_start must be an ISO date YYYY-MM-DD',
        generatedAt: new Date().toISOString() };
    }
    const weekStart = snapToMonday(raw);
    const { settings, assignments } = getWeek(weekStart);

    // Weekly-goal flag set for the week (planner-local; read-only to the source
    // tools). Build a membership set keyed by `${source} ${external_task_id}`
    // so each card can be tagged isWeeklyGoal in O(1). Highlight is DERIVED:
    // a card is a highlight iff it is a weekly goal AND it is assigned to a day —
    // which, for any card in `assignments`, is true by construction. So
    // isHighlight === isWeeklyGoal for placed cards; unscheduled weekly goals stay
    // weekly goals (they have no plan_assignments row, so they never appear here).
    const weeklyGoals = getWeeklyGoals(weekStart); // [{ source, external_task_id }]
    const goalKey = (source, taskId) => `${source} ${String(taskId)}`;
    const weeklyGoalSet = new Set(weeklyGoals.map((g) => goalKey(g.source, g.external_task_id)));

    // Planner-local completed-task flag set for the week (Iris spec 20 §7). Same
    // O(1)-membership keying. completedLocal is the LOCAL "done" flag; the UI's
    // isDone = source_completed (status==='done' from reconciliation) || completedLocal.
    const completed = getCompleted(weekStart); // [{ source, external_task_id }]
    const completedSet = new Set(completed.map((c) => goalKey(c.source, c.external_task_id)));

    // Live sets for reconciliation (one fetch per task source for this week).
    const { liveBySource, sourceOk } = await liveTaskSets(weekStart);

    // Group into days[weekday] = { am: [], pm: [] }, position-ordered (selWeekStmt
    // already returns weekday→half→position order).
    const days = {};
    for (let wd = 0; wd < 7; wd++) days[wd] = { am: [], pm: [] };
    for (const row of assignments) {
      const lane = row.half === 'am' ? 'am' : 'pm';
      const status = reconcileStatus(row.source, row.external_task_id, liveBySource, sourceOk);
      const bucket = days[row.weekday];
      if (!bucket) continue; // defensive: weekday out of 0..6
      const isWeeklyGoal = weeklyGoalSet.has(goalKey(row.source, row.external_task_id));
      bucket[lane].push({
        id: row.id,
        weekday: row.weekday,
        half: halfFromDb(row.half),
        source: row.source,
        externalTaskId: row.external_task_id,
        position: row.position,
        note: row.note ?? null,
        status,                       // 'live' | 'done' | 'stale'
        // Planner-local completed flag (Iris spec 20 §7). The UI derives
        // isDone = (status === 'done') || completedLocal — i.e. source-confirmed
        // completion OR the user's local check. Distinct from `status`: a card can
        // be completedLocal:true while status is 'live' (checked locally, source
        // still open because complete_on_source/SOURCE_WRITE_ENABLED were off).
        completedLocal: completedSet.has(goalKey(row.source, row.external_task_id)),
        isWeeklyGoal,                 // planner-local weekly-goal flag
        // Derived, never stored: a placed card that is a weekly goal IS a
        // highlight of its day. UI may also derive this itself.
        isHighlight: isWeeklyGoal,    // (isWeeklyGoal && assigned); assigned ≡ in days
      });
    }

    return {
      ok: true,
      weekStart,
      generatedAt: new Date().toISOString(),
      settings: parseSettings(settings),
      days,
      // Full weekly-goal set so the UI can render teal + pin in the Unscheduled
      // sidebar (including goals not yet placed on any day).
      weeklyGoals: weeklyGoals.map((g) => ({ source: g.source, external_task_id: g.external_task_id })),
    };
  }));

  // -------------------------------------------------------------------------
  // WRITE guard helper — the PLAN_WRITE_ENABLED dormancy gate, applied FIRST on
  // every /api/planner/* write (before the guard stack so a disabled write does no
  // session/origin work and reveals nothing).
  // -------------------------------------------------------------------------
  function writeGate(req, res, next) {
    if (!planWriteEnabled()) {
      return res.status(503).json({
        ok: false,
        reason: 'disabled',
        message: 'Plan write path is disabled (PLAN_WRITE_ENABLED unset). Awaiting Vex clearance.',
      });
    }
    return next();
  }

  // The cockpit's standard write guard stack, in order, behind the dormancy gate.
  const WRITE_STACK = [writeGate, requireSession, localWriteGuard, writeJson];

  // POST /api/planner/assign  body { week_start, weekday, half, source, external_task_id, position? }
  // UNIFIED-SPACE CONTRACT (2026-06-23): `position` is the client-computed target in
  // the lane's unified events+tasks position space (a task dropped above an event at
  // time-position P arrives with position < P). Omitted/null → append to the tail.
  app.post('/api/planner/assign', ...WRITE_STACK, (req, res) => {
    const v = validateAssignBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const row = assign({
        weekStart: v.week_start,
        weekday: v.weekday,
        half: halfToDb(v.half),
        source: v.source,
        externalTaskId: v.external_task_id,
        position: v.position,
      });
      return res.json({ ok: true, assignment: shapeRow(row) });
    } catch (err) {
      console.error('[POST /api/planner/assign]', err.message);
      return res.status(500).json({ ok: false, error: 'plan write failed' });
    }
  });

  // POST /api/planner/reorder  body { id, position }
  // Same unified-space `position` contract; same-lane move only (cross-lane → assign).
  app.post('/api/planner/reorder', ...WRITE_STACK, (req, res) => {
    const v = validateReorderBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const row = reorder({ id: v.id, position: v.position });
      if (!row) return res.status(404).json({ ok: false, error: 'assignment not found' });
      return res.json({ ok: true, assignment: shapeRow(row) });
    } catch (err) {
      console.error('[POST /api/planner/reorder]', err.message);
      return res.status(500).json({ ok: false, error: 'plan reorder failed' });
    }
  });

  // DELETE /api/planner/assign  body { source, external_task_id }
  app.delete('/api/planner/assign', ...WRITE_STACK, (req, res) => {
    const v = validateUnassignBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const result = unassign({ source: v.source, externalTaskId: v.external_task_id });
      return res.json({ ok: true, deleted: result.deleted });
    } catch (err) {
      console.error('[DELETE /api/planner/assign]', err.message);
      return res.status(500).json({ ok: false, error: 'plan unassign failed' });
    }
  });

  // POST /api/planner/weekly-goal  body { week_start, source, external_task_id }
  // Mark a source task as a weekly goal for the week. Idempotent.
  app.post('/api/planner/weekly-goal', ...WRITE_STACK, (req, res) => {
    const v = validateWeeklyGoalBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const result = setWeeklyGoal({
        weekStart: v.week_start,
        source: v.source,
        externalTaskId: v.external_task_id,
      });
      return res.json({ ok: true, weekStart: v.week_start, source: v.source,
        externalTaskId: v.external_task_id, inserted: result.inserted });
    } catch (err) {
      console.error('[POST /api/planner/weekly-goal]', err.message);
      return res.status(500).json({ ok: false, error: 'weekly-goal set failed' });
    }
  });

  // DELETE /api/planner/weekly-goal  body { week_start, source, external_task_id }
  // Unmark a weekly goal. Idempotent.
  app.delete('/api/planner/weekly-goal', ...WRITE_STACK, (req, res) => {
    const v = validateWeeklyGoalBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const result = unsetWeeklyGoal({
        weekStart: v.week_start,
        source: v.source,
        externalTaskId: v.external_task_id,
      });
      return res.json({ ok: true, weekStart: v.week_start, source: v.source,
        externalTaskId: v.external_task_id, deleted: result.deleted });
    } catch (err) {
      console.error('[DELETE /api/planner/weekly-goal]', err.message);
      return res.status(500).json({ ok: false, error: 'weekly-goal unset failed' });
    }
  });

  // POST /api/planner/complete  body { weekStart, source, externalTaskId, completed }
  // Iris spec 20 §7 — "complete a task". Same WRITE_STACK guard as every planner write.
  // READ-ONLY CONTRACT (this install): both directions are LOCAL-ONLY — they touch
  // ONLY the completed_tasks table in mypka-cockpit.db. The upstream source-write
  // branch (close the task on the source tools) is REMOVED, not gated — see the
  // "SOURCE-WRITE path — REMOVED" block at the top of this file. Completing a task
  // for real happens in the source tool via the card's `url` deep link.
  app.post('/api/planner/complete', ...WRITE_STACK, (req, res) => {
    const v = validateCompleteBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      if (!v.completed) {
        // Un-complete: LOCAL only. Source-done is sticky — we never re-open a source task.
        const result = unsetCompleted({
          weekStart: v.week_start, source: v.source, externalTaskId: v.external_task_id,
        });
        return res.json({ ok: true, weekStart: v.week_start, source: v.source,
          externalTaskId: v.external_task_id, completed: false, deleted: result.deleted });
      }

      // Complete: LOCAL only (planner-side "done" flag; the source task stays open).
      const result = setCompleted({
        weekStart: v.week_start, source: v.source, externalTaskId: v.external_task_id,
      });

      return res.json({ ok: true, weekStart: v.week_start, source: v.source,
        externalTaskId: v.external_task_id, completed: true, inserted: result.inserted });
    } catch (err) {
      console.error('[POST /api/planner/complete]', err.message);
      return res.status(500).json({ ok: false, error: 'complete write failed' });
    }
  });

  // PUT /api/planner/settings  body { workdays, am_pm_split, work_hours, timezone, lunch_break?, complete_on_source? }
  app.put('/api/planner/settings', ...WRITE_STACK, (req, res) => {
    const v = validateSettingsBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      const row = putSettings({
        workdays: JSON.stringify(v.workdays),
        am_pm_split: v.am_pm_split,
        work_hours: JSON.stringify(v.work_hours),
        timezone: v.timezone,
        lunch_break: JSON.stringify(v.lunch_break),
        complete_on_source: v.complete_on_source, // boolean → plannerDb maps to 0/1
      });
      return res.json({ ok: true, settings: parseSettings(row) });
    } catch (err) {
      console.error('[PUT /api/planner/settings]', err.message);
      return res.status(500).json({ ok: false, error: 'settings write failed' });
    }
  });
}

// ---- shape helpers ----------------------------------------------------------

function shapeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    weekStart: row.week_start,
    weekday: row.weekday,
    half: halfFromDb(row.half),
    source: row.source,
    externalTaskId: row.external_task_id,
    position: row.position,
    note: row.note ?? null,
  };
}

// Parse the settings singleton's JSON TEXT columns into structured values for the
// client. Tolerant: a malformed JSON column degrades to a safe default rather than
// throwing the read route.
function parseSettings(s) {
  if (!s) return null;
  const safeJson = (v, fallback) => {
    try { return JSON.parse(v); } catch { return fallback; }
  };
  const am_pm_split = s.am_pm_split ?? '12:00';
  return {
    workdays: safeJson(s.workdays, [0, 1, 2, 3, 4]),
    am_pm_split,
    work_hours: safeJson(s.work_hours, {}),
    timezone: s.timezone ?? 'Europe/Berlin',
    // Optional lunch band. Disabled-by-default so the single-divider behaviour is
    // unchanged until the user turns it on. Default start mirrors am_pm_split,
    // end one hour later (13:00). NULL/legacy/malformed rows seed this default.
    lunch_break: mergeLunchBreakDefault(
      safeJson(s.lunch_break, null),
      am_pm_split,
    ),
    // ARM-toggle for the (separately env-gated) source-write path. Stored as
    // INTEGER 0/1 (migration 004); surfaced to the client as a boolean. NULL/legacy
    // rows (pre-004) coerce to false. Distinct from SOURCE_WRITE_ENABLED: this is the
    // user's intent; the env gate is Vex's dormancy lock. BOTH must be on to fire.
    complete_on_source: s.complete_on_source === 1 || s.complete_on_source === true,
  };
}

// Seed/merge a sane lunch_break default so rows without the key (legacy or
// malformed JSON) return a defined, disabled band rather than null/undefined.
// Felix's gear UI + the band render can always read .enabled/.start/.end.
function mergeLunchBreakDefault(lb, am_pm_split) {
  const fallback = { enabled: false, start: am_pm_split || '12:00', end: '13:00' };
  if (!lb || typeof lb !== 'object' || Array.isArray(lb)) return fallback;
  return {
    enabled: typeof lb.enabled === 'boolean' ? lb.enabled : false,
    start: HHMM.test(lb.start || '') ? lb.start : fallback.start,
    end: HHMM.test(lb.end || '') ? lb.end : fallback.end,
  };
}

// ---- scope-locked body validators (the request-edge twin of the DB CHECKs) ---
// Each returns { error } on any unknown/invalid field, else the cleaned values.

const HALVES = new Set(['AM', 'PM']);

function rejectExtras(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const extras = Object.keys(body).filter((k) => !allowed.has(k));
  if (extras.length) return `unexpected field(s): ${extras.join(', ')}`;
  return null;
}

function validateAssignBody(body) {
  const allowed = new Set(['week_start', 'weekday', 'half', 'source', 'external_task_id', 'position']);
  const extra = rejectExtras(body, allowed);
  if (extra) return { error: extra };

  if (!isIsoDate(body.week_start)) return { error: 'week_start must be an ISO date YYYY-MM-DD' };
  const week_start = snapToMonday(body.week_start);

  if (!Number.isInteger(body.weekday) || body.weekday < 0 || body.weekday > 6) {
    return { error: 'weekday must be an integer 0..6 (0=Mon)' };
  }
  if (!HALVES.has(body.half)) return { error: "half must be 'AM' or 'PM'" };

  const sources = assignableSourceIds();
  if (typeof body.source !== 'string' || !sources.has(body.source)) {
    return { error: 'source must be a registered task connector id' };
  }
  if (typeof body.external_task_id !== 'string' || !body.external_task_id.trim()) {
    return { error: 'external_task_id must be a non-empty string' };
  }
  const position = normalizePosition(body.position);
  if (position === 'invalid') {
    return { error: 'position must be a finite number or omitted' };
  }
  return {
    week_start, weekday: body.weekday, half: body.half,
    source: body.source, external_task_id: body.external_task_id.trim(),
    position,
  };
}

function validateReorderBody(body) {
  const allowed = new Set(['id', 'position']);
  const extra = rejectExtras(body, allowed);
  if (extra) return { error: extra };
  if (!Number.isInteger(body.id) || body.id <= 0) return { error: 'id must be a positive integer' };
  const position = normalizePosition(body.position);
  if (position === 'invalid') {
    return { error: 'position must be a finite number or omitted' };
  }
  return { id: body.id, position };
}

function validateUnassignBody(body) {
  const allowed = new Set(['source', 'external_task_id']);
  const extra = rejectExtras(body, allowed);
  if (extra) return { error: extra };
  const sources = assignableSourceIds();
  if (typeof body.source !== 'string' || !sources.has(body.source)) {
    return { error: 'source must be a registered task connector id' };
  }
  if (typeof body.external_task_id !== 'string' || !body.external_task_id.trim()) {
    return { error: 'external_task_id must be a non-empty string' };
  }
  return { source: body.source, external_task_id: body.external_task_id.trim() };
}

// weekly-goal body: { week_start (ISO date), source (registered task connector),
// external_task_id (non-empty) }. Scope-locked — unknown keys rejected.
function validateWeeklyGoalBody(body) {
  const allowed = new Set(['week_start', 'source', 'external_task_id']);
  const extra = rejectExtras(body, allowed);
  if (extra) return { error: extra };

  if (!isIsoDate(body.week_start)) return { error: 'week_start must be an ISO date YYYY-MM-DD' };
  const week_start = snapToMonday(body.week_start);

  const sources = assignableSourceIds();
  if (typeof body.source !== 'string' || !sources.has(body.source)) {
    return { error: 'source must be a registered task connector id' };
  }
  if (typeof body.external_task_id !== 'string' || !body.external_task_id.trim()) {
    return { error: 'external_task_id must be a non-empty string' };
  }
  return { week_start, source: body.source, external_task_id: body.external_task_id.trim() };
}

// complete body: { weekStart (ISO date), source (registered task connector),
// externalTaskId (non-empty), completed (boolean) }. Scope-locked — unknown keys
// rejected. Uses the camelCase field names from Iris spec 20 §7; normalizes to the
// snake_case internals the rest of the module passes around.
function validateCompleteBody(body) {
  const allowed = new Set(['weekStart', 'source', 'externalTaskId', 'completed']);
  const extra = rejectExtras(body, allowed);
  if (extra) return { error: extra };

  if (!isIsoDate(body.weekStart)) return { error: 'weekStart must be an ISO date YYYY-MM-DD' };
  const week_start = snapToMonday(body.weekStart);

  const sources = assignableSourceIds();
  if (typeof body.source !== 'string' || !sources.has(body.source)) {
    return { error: 'source must be a registered task connector id' };
  }
  if (typeof body.externalTaskId !== 'string' || !body.externalTaskId.trim()) {
    return { error: 'externalTaskId must be a non-empty string' };
  }
  if (typeof body.completed !== 'boolean') {
    return { error: 'completed must be a boolean' };
  }
  return {
    week_start, source: body.source,
    external_task_id: body.externalTaskId.trim(), completed: body.completed,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateSettingsBody(body) {
  const allowed = new Set(['workdays', 'am_pm_split', 'work_hours', 'timezone', 'lunch_break', 'complete_on_source']);
  const extra = rejectExtras(body, allowed);
  if (extra) return { error: extra };

  // workdays: array of weekday ints 0..6, unique-ish, length 0..7.
  if (!Array.isArray(body.workdays) || body.workdays.length > 7 ||
      !body.workdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return { error: 'workdays must be an array of weekday integers 0..6' };
  }
  if (typeof body.am_pm_split !== 'string' || !HHMM.test(body.am_pm_split)) {
    return { error: 'am_pm_split must be an HH:MM string' };
  }
  // work_hours: object keyed by weekday int → { start:HH:MM, end:HH:MM }.
  if (body.work_hours === null || typeof body.work_hours !== 'object' || Array.isArray(body.work_hours)) {
    return { error: 'work_hours must be an object keyed by weekday' };
  }
  for (const [k, v] of Object.entries(body.work_hours)) {
    const wd = Number(k);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { error: `work_hours key ${k} must be 0..6` };
    if (!v || typeof v !== 'object' || !HHMM.test(v.start || '') || !HHMM.test(v.end || '')) {
      return { error: `work_hours[${k}] must be { start:HH:MM, end:HH:MM }` };
    }
  }
  if (typeof body.timezone !== 'string' || !body.timezone.trim() || body.timezone.length > 64) {
    return { error: 'timezone must be a non-empty IANA tz string' };
  }
  // Validate the tz against Intl (rejects garbage like 'Mars/Phobos').
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
  } catch {
    return { error: 'timezone is not a valid IANA timezone' };
  }

  // lunch_break: optional. When omitted, default to a DISABLED band whose start
  // mirrors the submitted am_pm_split and end is one hour later (13:00) — so an
  // older client that doesn't send the key leaves the single-divider behaviour
  // unchanged. When present, enforce { enabled:boolean, start:HH:MM, end:HH:MM }
  // with end > start. Same scope-locked strictness as the rest of the body:
  // unknown sub-keys are rejected.
  let lunch_break;
  if (body.lunch_break === undefined) {
    lunch_break = { enabled: false, start: body.am_pm_split, end: '13:00' };
  } else {
    const lb = body.lunch_break;
    if (lb === null || typeof lb !== 'object' || Array.isArray(lb)) {
      return { error: 'lunch_break must be { enabled:boolean, start:HH:MM, end:HH:MM }' };
    }
    const lbExtras = Object.keys(lb).filter((k) => !['enabled', 'start', 'end'].includes(k));
    if (lbExtras.length) return { error: `lunch_break unexpected field(s): ${lbExtras.join(', ')}` };
    if (typeof lb.enabled !== 'boolean') return { error: 'lunch_break.enabled must be a boolean' };
    if (typeof lb.start !== 'string' || !HHMM.test(lb.start)) {
      return { error: 'lunch_break.start must be an HH:MM string' };
    }
    if (typeof lb.end !== 'string' || !HHMM.test(lb.end)) {
      return { error: 'lunch_break.end must be an HH:MM string' };
    }
    if (lb.end <= lb.start) return { error: 'lunch_break.end must be after lunch_break.start' };
    lunch_break = { enabled: lb.enabled, start: lb.start, end: lb.end };
  }

  // complete_on_source: optional boolean (migration-004 additive). Omitted →
  // default false (dormant posture preserved for older clients). When present,
  // must be a strict boolean — same scope-locked strictness as the rest of the body.
  let complete_on_source = false;
  if (body.complete_on_source !== undefined) {
    if (typeof body.complete_on_source !== 'boolean') {
      return { error: 'complete_on_source must be a boolean' };
    }
    complete_on_source = body.complete_on_source;
  }

  return {
    workdays: body.workdays,
    am_pm_split: body.am_pm_split,
    work_hours: body.work_hours,
    timezone: body.timezone.trim(),
    lunch_break,
    complete_on_source,
  };
}

// Unified-space target position: a finite number (the client's computed slot in
// the lane's events+tasks position space), or null/undefined for an append-to-tail
// drop. Returns the number, null, or the sentinel 'invalid'. The server (plannerDb
// resolveUnifiedPosition) is the precision backstop, so we only reject NON-finite
// junk here — any finite value (including a fractional position below an event's
// time-position, e.g. 599.5) is legitimate.
function normalizePosition(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 'invalid';
}
