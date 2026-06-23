// plannerLogic.ts — pure planner computations (no React, no DOM, fully testable).
//
//   * week math (Monday-start, weekday 0..6, ISO 'YYYY-MM-DD' day keys)
//   * remainingWorkMinutes — the AM/PM PURE COUNTDOWN (Tom's decision: NO capacity
//     meter, NO per-task estimates — the timer is pure working-time-left). Drives
//     Iris's .planner-timer [data-state=ample|low|elapsed].
//   * settings defaults + normalization
//
// All day/time math uses Europe/Berlin wall-clock via Intl, matching the server's
// DISPLAY_TZ. We never trust the browser's local zone for bucketing.

import type { NormalizedEvent, PlannerSettings, Weekday } from './plannerTypes';

export const DISPLAY_TZ = 'Europe/Berlin';

// ---- unified lane position space (events + tasks) ---------------------------
//
// THE MODEL (2026-06-23, unified ordering fix). One comparable position space per
// lane (weekday + half) spans BOTH events and tasks, so a task can be ordered
// ABOVE an event and that order persists. The scale is "minutes since local
// midnight": an event sits at its local START minute-of-day (0..1439); a task
// floats at its stored REAL `position` in the SAME scale. A task dropped above a
// 10:00 event (eventPosition 600) is stored < 600; below it, > 600.
//
// EVENT_FLOOR (1440) is "below every possible event" (1439 = 23:59). Pre-existing
// tasks were rebased to >= EVENT_FLOOR by migration 008 so the upgrade preserves
// their current below-the-events order; new drops can land anywhere in 0..1439.

// An event sorts BELOW every task that was rebased to the event-floor band but
// ABOVE nothing artificially — all-day events anchor at the very top of the lane.
export const EVENT_FLOOR = 1440;
const ALL_DAY_POSITION = -1; // all-day events pin to the top of their AM lane.

// The deterministic position for an event in the unified lane space: its local
// start minute-of-day (0..1439). All-day events return a sentinel that sorts first.
// Stable across reloads (pure function of the event's start instant + tz).
export function eventPosition(e: NormalizedEvent, tz: string = DISPLAY_TZ): number {
  if (e.allDay) return ALL_DAY_POSITION;
  return tzMinutesOfDay(new Date(e.start), tz);
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAY_FULL = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

// ---- week math --------------------------------------------------------------

// 'YYYY-MM-DD' Monday of the ISO week containing the given date (default: today
// in display tz). Mirrors plannerRoutes.snapToMonday exactly (UTC date math).
export function mondayOf(dayStr: string): string {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();          // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7; // 0 if Mon … 6 if Sun
  dt.setUTCDate(dt.getUTCDate() - deltaToMonday);
  return dt.toISOString().slice(0, 10);
}

// Today's calendar day 'YYYY-MM-DD' in the display tz.
export function todayInTz(now: Date = new Date(), tz: string = DISPLAY_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// Add whole days to a 'YYYY-MM-DD' string.
export function addDays(dayStr: string, n: number): string {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// The 7 day strings of a Monday-start week.
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// A short human label for a week, e.g. "2–8 Jun" or "30 Jun–6 Jul". Used in the
// week-nav button when the active week is not the current week.
export function weekDaysLabelFor(weekStart: string, tz: string = DISPLAY_TZ): string {
  const end = addDays(weekStart, 6);
  const fmt = (day: string, withMonth: boolean) => {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: 'numeric', ...(withMonth ? { month: 'short' } : {}),
    }).format(dt);
  };
  const sameMonth = weekStart.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${fmt(weekStart, false)}–${fmt(end, true)}` : `${fmt(weekStart, true)}–${fmt(end, true)}`;
}

// A long-month + numeric-day label for a 'YYYY-MM-DD', e.g. "June 1" — the date
// line under the weekday name (Iris 15 §1). Formatted in the display tz (noon-anchored
// to dodge any DST midnight edge) so it agrees with how the board buckets days.
export function monthDayLabel(dayStr: string, tz: string = DISPLAY_TZ): string {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'long', day: 'numeric',
  }).format(dt);
}

// weekday index 0..6 (0=Mon) for a 'YYYY-MM-DD'.
export function weekdayOf(dayStr: string): Weekday {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return (((dow + 6) % 7) as Weekday);
}

// Day-relative classification against "today" in the display tz. Lexical compare
// on 'YYYY-MM-DD' is correct.
export function dayRelation(dayStr: string, today: string): 'past' | 'today' | 'future' {
  if (dayStr < today) return 'past';
  if (dayStr > today) return 'future';
  return 'today';
}

// ---- HH:MM helpers ----------------------------------------------------------

export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Minutes since local midnight, in the display tz, for an absolute instant.
export function tzMinutesOfDay(now: Date, tz: string = DISPLAY_TZ): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const hour = get('hour');
  // Intl can emit '24' at midnight in some engines — fold to 0.
  return (hour === 24 ? 0 : hour) * 60 + get('minute');
}

// ---- settings ---------------------------------------------------------------

// The default work-hours window applied to every workday when none is configured.
export const DEFAULT_DAY_HOURS = { start: '09:00', end: '18:00' };

// Workweek Mon–Fri default, weekend opt-in (D2). 12:00 AM/PM split. Lunch band
// disabled by default (Iris 14 §B) so the single divider is the out-of-the-box look.
export function defaultSettings(): PlannerSettings {
  const work_hours: Record<string, { start: string; end: string }> = {};
  for (let wd = 0; wd <= 4; wd++) work_hours[String(wd)] = { ...DEFAULT_DAY_HOURS };
  return {
    workdays: [0, 1, 2, 3, 4],
    am_pm_split: '12:00',
    work_hours,
    timezone: DISPLAY_TZ,
    lunch_break: { enabled: false, start: '12:00', end: '13:00' },
    // Iris 20 §7 — default OFF: completions stay planner-local until Tom opts in.
    complete_on_source: false,
  };
}

// Iris 14 §A — which half of the day is "live" right now, against the AM/PM split.
// Felix stamps data-current-half on TODAY's matching daybox so the brass top-edge
// caps the AM box before the split and the PM box at/after it. Compared on minutes-
// of-day in the planner's display tz (NOT the browser's local zone) so the flip
// happens on the timezone the board buckets meetings by. Recomputed on the board's
// per-minute `now` tick, so the brass crosses to PM the minute the clock passes the
// split — no reload. Exactly one half is ever returned, holding the single-brass
// doctrine by construction.
export function currentHalf(
  now: Date, settings: PlannerSettings,
): 'am' | 'pm' {
  const tz = settings.timezone || DISPLAY_TZ;
  const nowMin = tzMinutesOfDay(now, tz);
  const splitMin = hhmmToMinutes(settings.am_pm_split);
  return nowMin < splitMin ? 'am' : 'pm';
}

// Resolve the configured hours for a weekday, falling back to the default window
// (so a workday with no explicit hours still produces a sensible timer/lane).
export function hoursForWeekday(
  settings: PlannerSettings, wd: Weekday,
): { start: string; end: string } {
  return settings.work_hours[String(wd)] ?? DEFAULT_DAY_HOURS;
}

export function isWorkday(settings: PlannerSettings, wd: Weekday): boolean {
  return settings.workdays.includes(wd);
}

// ---- AM/PM PURE COUNTDOWN ---------------------------------------------------
// remainingWorkMinutes — minutes of WORKING TIME left in a given half today.
// Tom's decision (README "Capacity = stack length"): this is a PURE countdown of
// configured working time. There is NO capacity meter and NO per-task estimate —
// the LENGTH of the card stack is the capacity signal, not this number.
//
//   * not a workday               → 0 (the lane shows no timer signal)
//   * future day                  → the half's FULL capacity (a budget, not a clock)
//   * past day                    → 0 (the block has closed)
//   * today                       → clamp now into [from,to]; minutes left to `to`

export type TimerState = 'ample' | 'low' | 'elapsed';

// Single low-time threshold (Iris C.5: one threshold, no escalation — escalation
// is the anxious pattern). 30 min reads as "winding down" without alarm.
export const LOW_TIME_MINUTES = 30;

export function halfWindow(
  half: 'AM' | 'PM', settings: PlannerSettings, wd: Weekday,
): { fromMin: number; toMin: number } {
  const { start, end } = hoursForWeekday(settings, wd);
  const split = settings.am_pm_split;
  const startMin = hhmmToMinutes(start);
  const endMin = hhmmToMinutes(end);
  const splitMin = Math.min(Math.max(hhmmToMinutes(split), startMin), endMin);
  return half === 'AM'
    ? { fromMin: startMin, toMin: splitMin }
    : { fromMin: splitMin, toMin: endMin };
}

// FIX 2 — where a half sits relative to NOW, so EXACTLY ONE box on the board (today's
// current half) shows a live countdown:
//   * 'past'    — entirely before now (any past day, OR an earlier half of today that
//                 the clock has already passed). The chip shows "done".
//   * 'active'  — TODAY and now falls within [from,to] of this half. The live "Xh Ym
//                 left" countdown — the only box that shows one.
//   * 'future'  — after now (every future day's halves AND today's not-yet-started
//                 half). NO countdown — just the plain AM/PM label. Never show a
//                 countdown for time that hasn't arrived.
// Compared on minutes-of-day in the display tz, same `today` as dayRelation, so the
// classification agrees with the temporal tier + the brass live-half by construction.
export type HalfRelation = 'past' | 'active' | 'future';

export function halfRelation(
  half: 'AM' | 'PM',
  dayStr: string,
  now: Date,
  settings: PlannerSettings,
  today: string = todayInTz(now, settings.timezone || DISPLAY_TZ),
): HalfRelation {
  const rel = dayRelation(dayStr, today);
  if (rel === 'past') return 'past';
  if (rel === 'future') return 'future';
  // today: place now-of-day against this half's window.
  const wd = weekdayOf(dayStr);
  const { fromMin, toMin } = halfWindow(half, settings, wd);
  const nowMin = tzMinutesOfDay(now, settings.timezone || DISPLAY_TZ);
  if (nowMin >= toMin) return 'past';     // today's earlier half, already elapsed
  if (nowMin < fromMin) return 'future';  // today's later half, not started yet
  return 'active';                        // now is inside this half
}

export function remainingWorkMinutes(
  half: 'AM' | 'PM',
  dayStr: string,
  now: Date,
  settings: PlannerSettings,
  today: string = todayInTz(now, settings.timezone || DISPLAY_TZ),
): number {
  const wd = weekdayOf(dayStr);
  if (!isWorkday(settings, wd)) return 0;
  const { fromMin, toMin } = halfWindow(half, settings, wd);
  const capacity = Math.max(0, toMin - fromMin);
  const rel = dayRelation(dayStr, today);
  if (rel === 'future') return capacity;
  if (rel === 'past') return 0;
  // today: clamp now-of-day into [fromMin, toMin]
  const nowMin = tzMinutesOfDay(now, settings.timezone || DISPLAY_TZ);
  const cursor = Math.min(Math.max(nowMin, fromMin), toMin);
  return Math.max(0, toMin - cursor);
}

// Map remaining minutes → the calm three-state used by Iris's [data-state].
// elapsed: 0 left on a workday today/past. low: ≤ threshold. ample: otherwise.
export function timerState(
  half: 'AM' | 'PM',
  dayStr: string,
  now: Date,
  settings: PlannerSettings,
  today?: string,
): TimerState {
  const remaining = remainingWorkMinutes(half, dayStr, now, settings, today);
  const wd = weekdayOf(dayStr);
  if (!isWorkday(settings, wd)) return 'elapsed';
  if (remaining <= 0) return 'elapsed';
  if (remaining <= LOW_TIME_MINUTES) return 'low';
  return 'ample';
}

// Human-readable "2h 10m left" / "45m left" — and for a past/elapsed half, a calm
// "AM done" / "PM done" (NEVER "0m · done": the "0m ·" reads as a fail-state count;
// a finished half is not a failure, it's just behind us). `half` is optional so
// existing call sites without it degrade to a bare "done".
export function formatRemaining(minutes: number, state: TimerState, half?: 'AM' | 'PM'): string {
  if (state === 'elapsed') return half ? `${half} done` : 'done';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const core = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `${core} left`;
}
