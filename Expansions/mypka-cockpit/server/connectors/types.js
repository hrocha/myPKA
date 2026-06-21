// connectors/types.js — the source-connector CONTRACT (Wave 2, Mack).
//
// The day-planner board renders TWO card kinds and never special-cases a source.
// Every source the cockpit reads from implements ONE of two connector kinds and
// emits ONE of two normalized, flat, render-ready, SECRET-FREE shapes. The board
// reads `NormalizedEvent[]` / `NormalizedTask[]` and does not know (or care) which
// connector produced them. A new source drops in by adding one connector module +
// one registry line — zero UI change, zero route change.
//
// This file is the documentation-as-code surface for that contract. JS has no
// compile-time types, so the "shapes" below live as JSDoc typedefs + small runtime
// validators/normalizers the connectors call. The TypeScript-shaped field list is
// also mirrored verbatim in CONNECTORS.md and in 01-connector-contract-and-calendar-mack.md.
//
// POSTURE (inherited from every existing cockpit read surface):
//   * Connectors resolve their own secret IN-PROCESS (narrow single-key .env read).
//     The emitted shape carries NO token, NO Authorization header, NO URL secret.
//   * Connectors NEVER throw to the route. On any failure they return a calm
//     degraded ConnectorResult ({ ok:false, reason }). The board renders a quiet
//     per-source placeholder, never a crash — identical to clickupTasks.js today.
//   * Calendar is ALWAYS read-only. Tasks expose `editableFields` describing which
//     fields the EXISTING scope-locked PATCH may touch (per the source tool).

/** @typedef {'AM'|'PM'} Half — one half-day bucket; the board's atomic vertical unit. */

/**
 * @typedef {Object} NormalizedEvent — one meeting card (from a CalendarConnector).
 * @property {'event'}        kind
 * @property {string}         source     connector id, a connector id (UI badge only)
 * @property {string}         uid        stable id from the source — dedupe + idempotency key.
 *                                       Recurring instances get '<base-uid>::<instance-start-iso>'.
 * @property {string}         title
 * @property {string}         description plain-text VEVENT body for the event modal. ALWAYS a string
 *                                       ('' when the event has none). Never a secret (the feed URL is
 *                                       never carried here).
 * @property {string}         start      ISO 8601 instant (UTC 'Z') of the occurrence start
 * @property {string}         end        ISO 8601 instant (UTC 'Z') of the occurrence end
 * @property {boolean}        allDay     all-day / date-only event → renders in a day-header band
 * @property {string}         day        'YYYY-MM-DD' in display tz (Europe/Berlin) — the column key
 * @property {Half|null}      half       'AM' if local start < 12:00 else 'PM'; null only for allDay
 * @property {string|null}    location
 * @property {string|null}    url        join link / event URL, if any
 * @property {boolean}        recurring  true if this instance came from an RRULE expansion
 * @property {boolean}        continues  true if this is a spanned day of a multi-day event (not day 1)
 * @property {true}           readOnly   calendar is ALWAYS read-only in v1
 */

/**
 * @typedef {Object} NormalizedTask — one task card (sidebar, or dragged onto the board).
 * @property {'task'}         kind
 * @property {string}         source     connector id, e.g. connector ids
 * @property {string}         id         source task id — stable key for plan-layout persistence
 * @property {string}         title
 * @property {string}         description plain-text task body for the detail modal. ALWAYS a string
 *                                       ('' when the source has none) so the UI can rely on it. Full
 *                                       text — display/truncation is the UI's job. Never a secret.
 * @property {string|null}    due        'YYYY-MM-DD' in display tz, or null
 * @property {'overdue'|'today'|'upcoming'|'none'} dueBucket
 * @property {number}         priorityRank NORMALIZED 1..5 (1 = highest urgency, 5 = none). Each
 *                                       connector maps its native scheme INTO this single field.
 * @property {string|null}    url
 * @property {string[]}       tags
 * @property {string|null}    status     human label ('in progress' etc.) — display only
 * @property {true}           assignedToMe connectors only emit tasks assigned to the user
 * @property {Array<'due'|'priority'>} editableFields which fields THIS source lets the existing PATCH touch
 */

/**
 * @typedef {Object} ConnectorResult
 * @property {boolean}  ok
 * @property {string}   source
 * @property {string}   generatedAt          ISO
 * @property {('no-token'|'unreachable'|'misconfigured')} [reason]  present only when ok:false
 * @property {string}   [message]
 * @property {Array}    items                [] on degrade
 */

// ---- normalization helpers shared by connectors -----------------------------

/** Clamp any value into the normalized priority rank 1..5 (1 = highest, 5 = none). */
export function clampPriorityRank(n) {
  if (n == null || !Number.isFinite(n)) return 5;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/**
 * The display timezone for the whole planner. All `day` / `half` bucketing is
 * computed against this one zone, server-side, exactly once. (Europe/Berlin per the
 * cockpit's existing clickupTasks.js / tasks.js convention.)
 */
export const DISPLAY_TZ = 'Europe/Berlin';

/** A calendar day 'YYYY-MM-DD' for an absolute instant, formatted in DISPLAY_TZ. */
export function instantToDisplayDay(date, tz = DISPLAY_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** The local hour 0..23 of an absolute instant, in DISPLAY_TZ. */
export function instantToDisplayHour(date, tz = DISPLAY_TZ) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }).format(date)
  );
}

/** AM if local start hour < 12, else PM. */
export function bucketHalf(date, tz = DISPLAY_TZ) {
  return instantToDisplayHour(date, tz) < 12 ? 'AM' : 'PM';
}

/**
 * The week window for a Monday weekStart 'YYYY-MM-DD'. Returns the inclusive start
 * and EXCLUSIVE end day strings, plus absolute UTC instants spanning the week in
 * DISPLAY_TZ. Used by both task connectors (due-this-week filter) and the calendar
 * connector (RRULE expansion + instance window).
 *
 * The window is [weekStart 00:00 local, weekStart+7d 00:00 local). We anchor the
 * absolute instants by formatting the local midnight boundaries — robust across DST.
 */
export function weekWindow(weekStart, tz = DISPLAY_TZ) {
  // weekStart is a calendar date; build the two boundary INSTANTS by interpreting
  // local midnight in `tz`. We do this via a small offset probe: midnight UTC of the
  // date, then correct by the zone's offset at that date.
  const startDay = weekStart;
  const endDay = addDays(weekStart, 7);
  return {
    startDay,                 // inclusive 'YYYY-MM-DD'
    endDay,                   // exclusive 'YYYY-MM-DD'
    startInstant: localMidnightInstant(startDay, tz),
    endInstant: localMidnightInstant(endDay, tz),
    days: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
  };
}

/** Add (or subtract) whole days to a 'YYYY-MM-DD' string, returning 'YYYY-MM-DD'. */
export function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * The absolute UTC instant of local midnight on `dayStr` in `tz`. Computed by
 * probing the zone's offset at noon of that day (noon avoids DST-transition edge
 * cases at midnight) and applying it. Returns a Date.
 */
export function localMidnightInstant(dayStr, tz = DISPLAY_TZ) {
  const [y, m, d] = dayStr.split('-').map(Number);
  // Offset of `tz` from UTC at noon-UTC of that day, in minutes.
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMin = tzOffsetMinutes(noonUtc, tz);
  // local-midnight-UTC = UTC-midnight - offset.
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60_000);
}

/** Minutes that `tz` is AHEAD of UTC at the given instant (e.g. +120 for CEST). */
export function tzOffsetMinutes(date, tz) {
  // Format the same instant in `tz` and in UTC, diff the wall-clock readings.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** True if a 'YYYY-MM-DD' day falls within [startDay, endDay) — lexical compare is correct. */
export function dayInWeek(day, startDay, endDay) {
  return !!day && day >= startDay && day < endDay;
}

/** A calm degraded ConnectorResult. Connectors return this instead of throwing. */
export function degraded(source, reason, message) {
  return {
    ok: false,
    source,
    generatedAt: new Date().toISOString(),
    reason,
    message,
    items: [],
  };
}

/** A successful ConnectorResult. */
export function ok(source, items) {
  return { ok: true, source, generatedAt: new Date().toISOString(), items };
}
