// plannerTypes.ts — client-side mirror of the day-planner server contract.
//
// Source of truth: server/connectors/types.js (NormalizedEvent / NormalizedTask),
// server/plannerRoutes.js (GET /api/cockpit/calendar, GET /api/planner/week, and the
// assign/reorder/unassign/settings write bodies). Strict; no `any`. These types
// describe the WIRE shapes the planner consumes — they are not the persistence
// schema (that lives server-side in plannerDb.js).

export type Half = 'AM' | 'PM';
export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none';

// 0 = Monday … 6 = Sunday. Matches the server's weekday convention (plannerRoutes
// snapToMonday + validateAssignBody: "weekday must be 0..6, 0=Mon").
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// ---- normalized source shapes (from the connectors) -------------------------

// One meeting card, from a CalendarConnector (always read-only).
export interface NormalizedEvent {
  kind: 'event';
  source: string;        // connector id, e.g. 'ical:primary' (UI badge only)
  uid: string;           // stable id; recurring instances are '<base>::<iso>'
  title: string;
  description: string;   // VEVENT body/notes; '' when none (modal body context)
  start: string;         // ISO 8601 instant (UTC 'Z')
  end: string;           // ISO 8601 instant (UTC 'Z')
  allDay: boolean;       // all-day → renders in a day-header band, half:null
  day: string;           // 'YYYY-MM-DD' in Europe/Berlin — the column key
  half: Half | null;     // 'AM'/'PM' by local start hour; null only for allDay
  location: string | null;
  url: string | null;
  recurring: boolean;
  continues: boolean;    // a spanned day of a multi-day event (not day 1)
  readOnly: true;        // calendar is always read-only in v1
}

// One task card, from a TaskConnector (sidebar, or dragged onto the board).
export interface NormalizedTask {
  kind: 'task';
  source: string;        // connector id, e.g. 'todoist' | 'clickup'
  id: string;            // source task id — stable key for plan-layout persistence
  title: string;
  description: string;   // task body/notes; '' when none (modal body context)
  due: string | null;    // 'YYYY-MM-DD' in display tz, or null
  dueBucket: DueBucket;
  priorityRank: number;  // NORMALIZED 1..5 (1 = highest urgency, 5 = none)
  url: string | null;
  tags: string[];
  status: string | null; // human label — display only
  assignedToMe: true;
  editableFields: Array<'due' | 'priority'>;
}

// ---- GET /api/cockpit/sources ------------------------------------------------
// The TOOL-BLIND task feed: one group per ACTIVE task connector (0..N of anything
// — todoist, clickup, email:starred, linear, …). The client renders groups in
// RESPONSE ORDER and takes labels from the response — it never hardcodes a tool.

export interface SourceGroup {
  source: string;            // connector id, e.g. 'todoist' | 'email:starred'
  label: string;             // human label, server-provided (e.g. 'Todoist')
  ok: boolean;
  reason: string | null;     // 'no-token' | 'unreachable' | 'misconfigured' when ok:false
  items: NormalizedTask[];
}
export interface SourcesResponse {
  generatedAt: string;
  sources: SourceGroup[];
}

// ---- GET /api/cockpit/calendar?week=YYYY-MM-DD ------------------------------

export interface CalendarOk {
  ok: true;
  source: string;
  weekStart: string;
  generatedAt: string;
  reason?: undefined;
  message?: undefined;
  items: NormalizedEvent[];
}
export interface CalendarDegraded {
  ok: false;
  source: string;
  weekStart?: string;
  generatedAt: string;
  reason: 'no-token' | 'unreachable' | 'misconfigured';
  message: string;
  items: [];
}
export type CalendarResponse = CalendarOk | CalendarDegraded;

// ---- GET /api/planner/week?week_start=YYYY-MM-DD ----------------------------

// Reconciliation status, derived server-side at read time (never stored).
//   'live'  — still an open task upstream
//   'done'  — source fetched ok but the task is gone (completed/closed)
//   'stale' — source fetch degraded; we don't judge (never prune on a blip)
export type PlanCardStatus = 'live' | 'done' | 'stale';

// One persisted placement row, as the server shapes it for GET /api/planner/week.
export interface PlanAssignment {
  id: number;                // plan_assignments row id (the reorder/server key)
  weekday: Weekday;
  half: Half;
  source: string;            // connector id
  externalTaskId: string;    // the source task id (NormalizedTask.id)
  position: number;          // server-computed fractional position (display order)
  note: string | null;
  status: PlanCardStatus;
  // Migration 003 (weekly goals): the server tags each PLACED card with the
  // planner-local weekly-goal flag (read-only to the source tools). `isHighlight`
  // is DERIVED server-side as `isWeeklyGoal && placed` — and since every card in
  // `days[]` is placed by construction, isHighlight === isWeeklyGoal here. Both are
  // optional so a transitional payload (pre-003) still type-checks (defaults false).
  isWeeklyGoal?: boolean;
  isHighlight?: boolean;
  // Iris 20 §7 / Mack migration 004 (complete-a-task): the planner-LOCAL completion
  // flag for a placed card, distinct from the source `status` reconciliation. A card is
  // "done" when EITHER `status === 'done'` (the source closed it — STICKY/read-only) OR
  // `completedLocal === true` (the user ticked it here — TOGGLEABLE). Optional so a
  // pre-004 payload still type-checks (defaults false).
  completedLocal?: boolean;
}

// A weekly-goal reference (the top-level `weeklyGoals[]` on GET /api/planner/week).
// The full set for the week, INCLUDING goals not yet placed on any day — those are
// the ones the pinned Unscheduled "Weekly Goals" section renders. Wire shape is
// snake_case `external_task_id` (matches the server's row echo).
export interface WeeklyGoalRef {
  source: string;
  external_task_id: string;
}

// Optional lunch-break band (Iris 14 §B / Mack's planner_settings.lunch_break).
// Disabled by default — when off, the single AM/PM divider renders unchanged. When
// on, the board's divider row grows into a band (start rule · hatch fill · end rule).
// The server always returns a defined band (mergeLunchBreakDefault seeds legacy/NULL
// rows), so the client may treat this as always-present after a settled GET.
export interface LunchBreak {
  enabled: boolean;
  start: string;             // 'HH:MM'
  end: string;               // 'HH:MM' (server validates end > start)
}

export interface PlannerSettings {
  workdays: number[];        // weekday ints 0..6 (0=Mon)
  am_pm_split: string;       // 'HH:MM'
  // work_hours keyed by weekday int → { start, end } in 'HH:MM'.
  work_hours: Record<string, { start: string; end: string }>;
  timezone: string;          // IANA tz, e.g. 'Europe/Berlin'
  lunch_break: LunchBreak;   // optional band; disabled by default (server-seeded)
  // Iris 20 §7 / Mack migration 004: when ON, completing a card here ALSO writes the
  // done state back to the source tool (Todoist/ClickUp). OFF (default) keeps every
  // completion planner-LOCAL. The actual source write is Vex-gated server-side; this
  // flag only expresses intent. Optional so a pre-004 payload still type-checks (false).
  complete_on_source?: boolean;
}

export interface PlannerWeekOk {
  ok: true;
  weekStart: string;
  generatedAt: string;
  settings: PlannerSettings | null;
  // days[0..6] = { am: [...], pm: [...] }, position-ordered.
  days: Record<number, { am: PlanAssignment[]; pm: PlanAssignment[] }>;
  // Migration 003: the FULL weekly-goal set for the week (placed AND unplaced). The
  // pinned Unscheduled "Weekly Goals" section renders the ones NOT placed on a day.
  // Optional so a pre-003 payload still type-checks (treated as []).
  weeklyGoals?: WeeklyGoalRef[];
}
export interface PlannerWeekDegraded {
  ok: false;
  reason: 'misconfigured';
  message: string;
  generatedAt: string;
}
export type PlannerWeekResponse = PlannerWeekOk | PlannerWeekDegraded;

// ---- write request bodies (snake_case — matches plannerRoutes validators) ---
// UNIFIED-SPACE CONTRACT (2026-06-23): the client computes the dropped task's target
// `position` in the lane's unified events+tasks position space and sends it directly.
// This replaces the old before_id/after_id neighbor-id scheme, which could only name
// a PLAN ROW as a neighbor — and an event has no plan row, so a task could never be
// ordered between a task and an event. The client knows every neighbor's position
// (an event's is time-derived via eventPosition; a task's came down on the week
// read), so it midpoints them itself. The server honors the value unless it collides
// within MIN_GAP, then renormalizes the cell and re-derives the same rank.

export interface AssignBody {
  week_start: string;        // ISO date; server snaps to Monday
  weekday: number;           // 0..6 (0=Mon)
  half: Half;
  source: string;            // a registered connector id
  external_task_id: string;
  position?: number | null;  // unified-space target; null/omitted → append to tail
}
export interface ReorderBody {
  id: number;                // the moved plan_assignments row id
  position?: number | null;  // unified-space target; null/omitted → append to tail
}
export interface UnassignBody {
  source: string;
  external_task_id: string;
}
// POST/DELETE /api/planner/weekly-goal — set/unset the planner-local weekly-goal
// flag for a source task in a given week. Idempotent server-side (UNIQUE upsert /
// delete). Behind PLAN_WRITE_ENABLED + the same guard stack as the other writes.
export interface WeeklyGoalBody {
  week_start: string;        // ISO date; server snaps to Monday
  source: string;            // a registered task connector id
  external_task_id: string;
}
export interface SettingsBody {
  workdays: number[];
  am_pm_split: string;       // 'HH:MM'
  work_hours: Record<string, { start: string; end: string }>;
  timezone: string;
  lunch_break: LunchBreak;   // { enabled, start:HH:MM, end:HH:MM }; end > start
  // Iris 20 §7 / migration 004 — mirror completions to the source tool when ON.
  complete_on_source: boolean;
}

// POST /api/planner/complete — set/clear the planner-LOCAL completion flag for a
// placed source task in a given week. `completed:true` marks done; `completed:false`
// un-completes (LOCAL only — the planner never re-opens a SOURCE-done task). Behind
// PLAN_WRITE_ENABLED + the same guard stack as the other writes; idempotent server-side.
export interface CompleteBody {
  weekStart: string;         // ISO date; server snaps to Monday
  source: string;            // a registered task connector id
  externalTaskId: string;    // the source task id (NormalizedTask.id)
  completed: boolean;
}

// The shared write-result envelope. `reason:'disabled'` is the PLAN_WRITE_ENABLED
// dormancy state (503) — handled gracefully by keeping optimistic local state.
export interface WriteOk {
  ok: true;
  assignment?: ServerAssignmentRow | null;
  deleted?: number;
  settings?: PlannerSettings | null;
}
export interface WriteDisabled {
  ok: false;
  reason: 'disabled';
  message: string;
}
export interface WriteError {
  ok: false;
  reason?: undefined;
  error: string;
}
export type WriteResponse = WriteOk | WriteDisabled | WriteError;

// The row the assign/reorder routes echo back (shapeRow in plannerRoutes.js).
export interface ServerAssignmentRow {
  id: number;
  weekStart: string;
  weekday: number;
  half: Half;
  source: string;
  externalTaskId: string;
  position: number;
  note: string | null;
}

// ---- client-only view models ------------------------------------------------

// The unified card the board renders. Both kinds share PlanCard; the only visual
// differences are the source rail (meeting=brass, task=neutral) and draggability.
export type CardKind = 'meeting' | 'task';

// Which source-tool logo a card's meta row leads with (Iris 11 §1). An OPEN
// connector id (the backend is tool-blind; 0..N task connectors of anything).
// SourceMark matches known ids ('todoist', 'clickup', calendar/'ical' prefix,
// 'email' prefix) to brand/Lucide glyphs and falls back to a generic mark for
// any unknown id — so this is a plain string, never a closed union.
export type GlyphSource = string;

// A namespaced cross-source task key: `${source}:${id}` (e.g. 'todoist:123').
// dnd-kit `active.id` for tasks is this string; meeting anchors use 'evt:<uid>'.
export type DraggableId = string;

export function taskKey(source: string, id: string): DraggableId {
  return `${source}:${id}`;
}
export function eventKey(uid: string): DraggableId {
  return `evt:${uid}`;
}
export function isEventKey(id: DraggableId): boolean {
  return id.startsWith('evt:');
}
// Split a task key back into { source, id }. The id may itself contain ':'
// (ClickUp ids do not, Todoist ids do not, but be safe) — split on the FIRST ':'.
export function parseTaskKey(key: DraggableId): { source: string; id: string } {
  const idx = key.indexOf(':');
  if (idx < 0) return { source: '', id: key };
  return { source: key.slice(0, idx), id: key.slice(idx + 1) };
}
