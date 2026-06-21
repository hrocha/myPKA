// connectors/ical.js — the iCal CalendarConnector (Wave 2, Mack).
//
// Polls a SECRET read-only .ics feed URL (CALENDAR_ICAL_URL) and emits
// NormalizedEvent[] for a requested week. One connector covers every provider
// (Google / Apple / Outlook / Fastmail) because they all expose a private iCal
// URL — zero per-provider auth code, no OAuth, no token refresh.
//
// SECRET HANDLING (hard — mirrors the token posture of clickup.js/todoist.js):
//   * CALENDAR_ICAL_URL is read with the narrow single-key .env reader. The whole
//     URL is a secret (anyone with it reads the calendar), so it is masked in every
//     diagnostic (`***<last4>`), NEVER logged in full, NEVER returned in any API
//     response. It lives in this process's memory only.
//   * The emitted NormalizedEvent shape carries NO URL, NO secret — only display data
//     (title/start/end/location/join-link). The join-link `url` is the EVENT's own
//     URL property from the ICS, never the feed URL.
//
// CALM DEGRADE: never throws to the route. No token → {ok:false, reason:'no-token'};
// network/timeout/parse failure → {ok:false, reason:'unreachable'}. The board renders
// a quiet "calendar not connected" placeholder, never a crash.
//
// PARSING: node-ical's parseICS resolves VTIMEZONE into absolute Date instants and
// bundles rrule.js for RRULE expansion. We expand RRULE ONLY across the visible
// 7-day window (never unbounded), apply EXDATE exclusions and RECURRENCE-ID
// overrides, and bucket each instance into day/half by LOCAL Europe/Berlin start
// hour. Multi-day → one card per spanned day in the window. All-day → flagged for a
// header band (half:null).
//
// CACHE: per-week, TTL 5 min (current week) keyed by week; conditional GET via
// ETag / Last-Modified so we don't hammer the provider. Parsing is pure and
// idempotent (stable uids), safe to re-run.

import nodeIcal from 'node-ical';
import {
  bucketHalf, instantToDisplayDay, weekWindow, dayInWeek,
  degraded, ok, DISPLAY_TZ,
} from './types.js';
import { readEnvKey, maskSecret } from './env.js';

const { parseICS } = nodeIcal;

const FETCH_TIMEOUT_MS = 12_000;   // wall-clock budget; matches the task connectors
const MAX_ATTEMPTS = 3;
const TTL_MS = 5 * 60_000;         // 5-minute freshness for the cache entry

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- fetch the .ics with retry + 429 backoff + conditional GET --------------
// Returns { status, text, etag, lastModified } or throws after exhausting retries.
async function fetchIcs(url, conditional, attempt = 1) {
  const headers = { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' };
  if (conditional?.etag) headers['If-None-Match'] = conditional.etag;
  if (conditional?.lastModified) headers['If-Modified-Since'] = conditional.lastModified;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(timer);
    if (attempt >= MAX_ATTEMPTS) throw err;
    await sleep(2 ** attempt * 1000);
    return fetchIcs(url, conditional, attempt + 1);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || '5');
    await sleep(Math.min(retryAfter * 1000, 30_000));
    if (attempt >= MAX_ATTEMPTS) throw new Error('iCal rate limit: retries exhausted');
    return fetchIcs(url, conditional, attempt + 1);
  }
  if (res.status === 304) {
    return { status: 304, text: null, etag: conditional?.etag, lastModified: conditional?.lastModified };
  }
  if (!res.ok) {
    // The error text NEVER contains the feed URL (it's our request, not echoed back);
    // but we keep diagnostics local anyway and surface a generic reason to the route.
    throw new Error(`iCal GET -> HTTP ${res.status}`);
  }
  const text = await res.text();
  return {
    status: 200,
    text,
    etag: res.headers.get('etag') || undefined,
    lastModified: res.headers.get('last-modified') || undefined,
  };
}

// ---- ICS → NormalizedEvent[] for a week -------------------------------------
// `parsed` is node-ical's keyed object; `window` is from weekWindow().
function eventsForWeek(parsed, source, window) {
  const out = [];

  // Collect RECURRENCE-ID overrides keyed by base-uid + instant, so an edited
  // single occurrence replaces the generated one rather than doubling it.
  // node-ical attaches `recurrences` (object keyed by date) on the master VEVENT
  // AND/OR emits standalone components carrying `recurrenceid`.
  for (const key of Object.keys(parsed)) {
    const comp = parsed[key];
    if (!comp || comp.type !== 'VEVENT') continue;

    const baseUid = comp.uid || key;

    if (comp.rrule) {
      // Recurring master: expand ONLY within the visible window.
      // rrule.between(after, before, inc=true) returns occurrence START instants.
      let occurrences = [];
      try {
        occurrences = comp.rrule.between(window.startInstant, window.endInstant, true) || [];
      } catch {
        occurrences = [];
      }
      const durationMs = (comp.end && comp.start)
        ? (comp.end.getTime() - comp.start.getTime())
        : 0;

      // EXDATE exclusions: node-ical stores them on comp.exdate keyed by ISO-ish date.
      const exdates = new Set(
        comp.exdate ? Object.values(comp.exdate).map((d) => d.toISOString().slice(0, 10)) : []
      );
      // RECURRENCE-ID overrides: comp.recurrences[<date>] is the replacement VEVENT.
      const overrides = comp.recurrences || {};

      for (const occStart of occurrences) {
        const occDay = occStart.toISOString().slice(0, 10);
        if (exdates.has(occDay)) continue;

        // If this occurrence was individually edited, render the override instead.
        const override = overrides[occDay];
        const effective = override || comp;
        const start = override ? override.start : occStart;
        const end = override
          ? override.end
          : new Date(occStart.getTime() + durationMs);

        pushSpannedDays(out, {
          comp: effective, baseUid, start, end, recurring: true, window, source,
          uidSuffix: `::${occStart.toISOString()}`,
        });
      }
    } else if (comp.recurrenceid) {
      // A standalone override already accounted for via the master's `recurrences`
      // map above — skip to avoid a duplicate card.
      continue;
    } else {
      // Single (non-recurring) event.
      pushSpannedDays(out, {
        comp, baseUid, start: comp.start, end: comp.end || comp.start,
        recurring: false, window, source, uidSuffix: '',
      });
    }
  }

  // Stable order: by day, then all-day-first, then start instant.
  out.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  });
  return out;
}

// Emit one NormalizedEvent per day the (possibly multi-day) event spans WITHIN the
// visible week. All-day events use local date components (floating midnight); timed
// events bucket by Berlin start hour and render all-day on subsequent spanned days.
function pushSpannedDays(out, { comp, baseUid, start, end, recurring, window, source, uidSuffix }) {
  const isAllDay = comp.datetype === 'date';

  if (isAllDay) {
    // All-day: node-ical stores start/end as host-local floating midnight; the
    // local Y-M-D components are the intended calendar dates. DTEND is exclusive.
    const startDay = localDateParts(start);
    const endExclusive = end ? localDateParts(end) : nextDay(startDay);
    let day = startDay;
    let first = true;
    while (day < endExclusive) {
      if (dayInWeek(day, window.startDay, window.endDay)) {
        out.push(makeEvent({
          comp, source, uid: `${baseUid}${uidSuffix}${first ? '' : `::${day}`}`,
          start, end: end || start, allDay: true, day, half: null,
          recurring, continues: !first,
        }));
      }
      day = nextDay(day);
      first = false;
    }
    return;
  }

  // Timed event. Day 1 buckets by Berlin start hour; further spanned days render as
  // all-day "continues" bands. We span by the calendar days the instant range covers
  // in DISPLAY_TZ.
  const startDay = instantToDisplayDay(start, DISPLAY_TZ);
  const endDayInclusive = instantToDisplayDay(
    new Date(Math.max(start.getTime(), end.getTime() - 1)), DISPLAY_TZ
  );
  let day = startDay;
  let first = true;
  while (day <= endDayInclusive) {
    if (dayInWeek(day, window.startDay, window.endDay)) {
      out.push(makeEvent({
        comp, source, uid: `${baseUid}${uidSuffix}${first ? '' : `::${day}`}`,
        start, end,
        allDay: !first,                       // continuation days render as a band
        day,
        half: first ? bucketHalf(start, DISPLAY_TZ) : null,
        recurring, continues: !first,
      }));
    }
    day = nextDay(day);
    first = false;
  }
}

function makeEvent({ comp, source, uid, start, end, allDay, day, half, recurring, continues }) {
  return {
    kind: 'event',
    source,
    uid,
    title: cleanText(comp.summary) || '(no title)',
    // VEVENT DESCRIPTION → plain-text event-modal body. node-ical exposes it as
    // comp.description (string or {params,val}); cleanText coerces. Always a string.
    description: (cleanText(comp.description) || '').replace(/\s+$/, ''),
    start: start.toISOString(),
    end: (end || start).toISOString(),
    allDay,
    day,
    half,
    location: cleanText(comp.location) || null,
    url: cleanText(comp.url) || null,
    recurring,
    continues,
    readOnly: true,
  };
}

// node-ical sometimes returns {params, val} objects for properties; coerce to string.
function cleanText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && 'val' in v) return String(v.val).trim();
  return String(v).trim();
}

// Local-host Y-M-D of a floating-midnight all-day Date, as 'YYYY-MM-DD'.
function localDateParts(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextDay(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// ---- factory ----------------------------------------------------------------
/**
 * makeICalConnector({ envKey, id, label }) → CalendarConnector
 *   envKey: the .env key holding the secret feed URL (default CALENDAR_ICAL_URL).
 *   id:     connector id used as the `source` badge (default 'ical:primary').
 */
export function makeICalConnector(opts = {}) {
  const envKey = opts.envKey || 'CALENDAR_ICAL_URL';
  const id = opts.id || 'ical:primary';
  const label = opts.label || 'Calendar';

  // Per-week cache: week → { events, etag, lastModified, fetchedAt }.
  const cache = new Map();

  return {
    id,
    kind: 'calendar',
    label,

    /** Safe fingerprint for diagnostics — never the full URL. */
    sourceFingerprint() {
      return maskSecret(readEnvKey(envKey));
    },

    /**
     * fetchWeek(weekStart) → ConnectorResult<NormalizedEvent>
     *   weekStart = Monday 'YYYY-MM-DD' (display tz). Never throws.
     */
    async fetchWeek(weekStart) {
      const rawUrl = readEnvKey(envKey);
      if (!rawUrl) {
        return degraded(id, 'no-token', 'Calendar is not connected (no iCal URL configured).');
      }

      // Scheme constraint (plan §2.1): only fetch over https. webcal:// is the common
      // iCal subscribe scheme and is byte-for-byte equivalent to https — transparently
      // rewrite a leading 'webcal://' to 'https://' BEFORE the check. Anything else
      // (http://, file://, ftp://, …) is refused and the slot degrades calmly rather
      // than fetching an attacker-controllable or local-file URL. We parse with URL()
      // so a malformed value also degrades instead of throwing into the fetch path.
      let url;
      try {
        const candidate = /^webcal:\/\//i.test(rawUrl)
          ? rawUrl.replace(/^webcal:\/\//i, 'https://')
          : rawUrl;
        const u = new URL(candidate);
        if (u.protocol !== 'https:') {
          return degraded(id, 'misconfigured',
            'Calendar iCal URL must use https (webcal is accepted and upgraded). Refusing to fetch.');
        }
        url = u.toString();
      } catch {
        return degraded(id, 'misconfigured', 'Calendar iCal URL is not a valid URL.');
      }

      const cached = cache.get(weekStart);
      const fresh = cached && (Date.now() - cached.fetchedAt) < TTL_MS;
      if (fresh) {
        return ok(id, cached.events);
      }

      let fetched;
      try {
        fetched = await fetchIcs(url, cached ? { etag: cached.etag, lastModified: cached.lastModified } : null);
      } catch {
        // Network/timeout/non-2xx. If we have a stale cache, serve it (calmer than a
        // blank board on a transient blip); else degrade.
        if (cached) return ok(id, cached.events);
        return degraded(id, 'unreachable', 'Calendar is currently unreachable.');
      }

      if (fetched.status === 304 && cached) {
        // Not modified — refresh TTL, reuse parsed events.
        cache.set(weekStart, { ...cached, fetchedAt: Date.now() });
        return ok(id, cached.events);
      }

      let parsed;
      try {
        parsed = parseICS(fetched.text || '');
      } catch {
        if (cached) return ok(id, cached.events);
        return degraded(id, 'unreachable', 'Calendar feed could not be parsed.');
      }

      const window = weekWindow(weekStart, DISPLAY_TZ);
      const events = eventsForWeek(parsed, id, window);
      cache.set(weekStart, {
        events,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        fetchedAt: Date.now(),
      });
      return ok(id, events);
    },
  };
}

export default makeICalConnector;
