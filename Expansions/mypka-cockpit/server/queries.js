// queries.js — every aggregation inlined (no SQL VIEW; regen drops views per Silas).
// All queries READ-ONLY. Apple Health source strings carry the device name (e.g.
// "<Name> Apple Watch") with a non-breaking space and a
// curly apostrophe, so we match the substring "Watch" with a LIKE pattern rather
// than exact equality — works for any user's watch (no hard-coded device/owner name).
//
// SCAFFOLD ADAPTATION (2026-06-11): every statement against an OPTIONAL table
// (health_metric / health_sleep / health_mood — absent until the Apple-Health
// ingest is set up) goes through optionalStmt() (see wellnessDb.js): lazy
// prepare in a try/catch, degrade to empty data, never crash the boot.
// Statements against core tables ride the same wrapper for uniformity.
import { optionalStmt } from './wellnessDb.js';

// ---- BODY: latest scalar metrics ------------------------------------------
// Multi-reading metrics (SpO2, HRV, breathing_disturbances) need daily aggregation,
// NOT raw "last row". SpO2 -> MIN per day (nadir). HRV -> AVG per day. (Silas finding 3.)

const latestScalar = optionalStmt(`
  SELECT metric_name, local_date, ROUND(qty, 2) AS value, units, source
  FROM health_metric
  WHERE metric_name = ?
  ORDER BY local_date DESC, recorded_at_utc DESC
  LIMIT 1
`);

// SpO2 nadir: the lowest reading on the most recent day that has SpO2 data.
const spo2Nadir = optionalStmt(`
  WITH latest AS (
    SELECT MAX(local_date) AS d FROM health_metric WHERE metric_name = 'blood_oxygen_saturation'
  )
  SELECT l.d AS local_date,
         ROUND(MIN(m.qty), 0) AS value,
         ROUND(AVG(m.qty), 0) AS avg_value,
         COUNT(*) AS n,
         '%' AS units
  FROM health_metric m, latest l
  WHERE m.metric_name = 'blood_oxygen_saturation' AND m.local_date = l.d
`);

// HRV: average across the most recent day's readings.
const hrvDaily = optionalStmt(`
  WITH latest AS (
    SELECT MAX(local_date) AS d FROM health_metric WHERE metric_name = 'heart_rate_variability'
  )
  SELECT l.d AS local_date, ROUND(AVG(m.qty), 0) AS value, COUNT(*) AS n, 'ms' AS units
  FROM health_metric m, latest l
  WHERE m.metric_name = 'heart_rate_variability' AND m.local_date = l.d
`);

// breathing_disturbances: per-night value (avg if a night has >1 reading).
const breathingDaily = optionalStmt(`
  WITH latest AS (
    SELECT MAX(local_date) AS d FROM health_metric WHERE metric_name = 'breathing_disturbances'
  )
  SELECT l.d AS local_date, ROUND(AVG(m.qty), 1) AS value, COUNT(*) AS n, '/Nacht' AS units
  FROM health_metric m, latest l
  WHERE m.metric_name = 'breathing_disturbances' AND m.local_date = l.d
`);

// resting heart rate: mean over last 30 days (matches health.md "~73 bpm" framing).
const rhr30d = optionalStmt(`
  SELECT ROUND(AVG(qty), 0) AS value, COUNT(*) AS n, 'bpm' AS units,
         MAX(local_date) AS local_date
  FROM health_metric
  WHERE metric_name = 'resting_heart_rate' AND local_date >= date('now', '-30 days')
`);

// ---- Trend / delta vs a prior reference --------------------------------------
// v2: trend arrows + deltas comparing CURRENT vs a PRIOR value, with a
// clearly-labelled comparison window. Two failure modes to avoid:
//   1. Single-night noise. One restless night can swing RHR +5 or SpO2 -3 — that
//      reads as alarm to a health-anxious user when it's just one reading. So for
//      noisy daily metrics (weight, RHR, HRV, breathing, SpO2) BOTH endpoints are
//      smoothed over a +/- window, never two raw single days.
//   2. A fake trend on a slow/sparse metric. BMI/body-fat are measured ~monthly,
//      VO2max moves over months — so they use a wider window and the nearest real
//      reading to the target date (no interpolation, no fabrication).
//
// Direction is +1 (up) / -1 (down) / 0 (flat, |delta| below a per-metric epsilon).
// The CLIENT decides whether up is good or bad — the server only reports the move.

// Smoothed value over a +/-`half`-day window centred on an anchor date.
// Anchor 'latest' uses MAX(local_date); a numeric `daysAgo` offsets from latest.
function smoothedReference(metricName, { daysAgo, halfWindow, agg }) {
  const fn = agg === 'min' ? 'MIN' : 'AVG';
  // latest available day for this metric
  const latestRow = optionalStmt(`SELECT MAX(local_date) AS d FROM health_metric WHERE metric_name = ?`)
    .get(metricName);
  const latest = latestRow?.d;
  if (!latest) return null;

  // anchor = latest shifted back by daysAgo (0 for the current value)
  const anchorRow = optionalStmt(`SELECT date(?, ?) AS d`).get(latest, `-${daysAgo} days`);
  const anchor = anchorRow?.d;
  if (!anchor) return null;

  // Per-day aggregate first (collapse multi-source / multi-reading days), then
  // average those daily values across the window so a single noisy day can't
  // dominate. Window: [anchor - halfWindow, anchor + halfWindow], but never past latest.
  const row = optionalStmt(
      `SELECT ROUND(AVG(daily), 2) AS value,
              COUNT(*) AS days,
              MIN(local_date) AS from_date,
              MAX(local_date) AS to_date
       FROM (
         SELECT local_date, ${fn}(qty) AS daily
         FROM health_metric
         WHERE metric_name = ?
           AND local_date BETWEEN date(?, ?) AND date(?, ?)
           AND local_date <= ?
         GROUP BY local_date
       )`
    )
    .get(metricName, anchor, `-${halfWindow} days`, anchor, `+${halfWindow} days`, latest);

  if (!row || row.value === null) return null;
  return { value: row.value, days: row.days, from: row.from_date, to: row.to_date, anchor };
}

// Build {current, prior, delta, direction, window} for one metric.
// `epsilon` is the flat-zone: |delta| <= epsilon reads as "stabil" (no arrow).
function buildTrend(metricName, opts) {
  const { priorDaysAgo, halfWindow, agg = 'avg', epsilon, windowLabel, digits = 1 } = opts;
  const current = smoothedReference(metricName, { daysAgo: 0, halfWindow, agg });
  const prior = smoothedReference(metricName, { daysAgo: priorDaysAgo, halfWindow, agg });
  if (!current) return null;
  if (!prior || prior.to === current.to) {
    // No distinct earlier reference (e.g. body-fat with one isolated reading) —
    // be honest: value present, but "no prior value" for the comparison.
    return { current: current.value, prior: null, delta: null, direction: 0, window: windowLabel, hasPrior: false };
  }
  const deltaRaw = current.value - prior.value;
  const delta = Number(deltaRaw.toFixed(digits));
  const direction = Math.abs(delta) <= epsilon ? 0 : delta > 0 ? 1 : -1;
  return {
    current: current.value,
    prior: prior.value,
    delta,
    direction,
    window: windowLabel,
    priorDate: prior.anchor,
    hasPrior: true,
  };
}

// Per-metric window choices (documented for Larry/Vex):
//   weight/RHR/HRV/breathing/SpO2 -> noisy daily series: 7d-smoothed endpoints,
//     30d back. BMI/body-fat -> ~monthly cadence: nearest reading, 30d back, small
//     window. VO2max -> slow mover: 90d back.
const TREND_SPEC = {
  weight:    { metric: 'weight_body_mass',        priorDaysAgo: 30, halfWindow: 7, epsilon: 0.2, windowLabel: 'vs. ~30 days ago', digits: 1 },
  bmi:       { metric: 'body_mass_index',         priorDaysAgo: 30, halfWindow: 7, epsilon: 0.1, windowLabel: 'vs. ~30 days ago', digits: 1 },
  bodyFat:   { metric: 'body_fat_percentage',     priorDaysAgo: 30, halfWindow: 14, epsilon: 0.3, windowLabel: 'vs. ~30 days ago', digits: 1 },
  vo2:       { metric: 'vo2_max',                 priorDaysAgo: 90, halfWindow: 14, epsilon: 0.3, windowLabel: 'vs. ~90 days ago', digits: 1 },
  rhr:       { metric: 'resting_heart_rate',      priorDaysAgo: 30, halfWindow: 7, epsilon: 1,   windowLabel: 'vs. ~30 days ago', digits: 0 },
  hrv:       { metric: 'heart_rate_variability',  priorDaysAgo: 30, halfWindow: 7, epsilon: 2,   windowLabel: 'vs. ~30 days ago', digits: 0 },
  spo2:      { metric: 'blood_oxygen_saturation', priorDaysAgo: 30, halfWindow: 7, epsilon: 1, agg: 'min', windowLabel: 'vs. ~30 days ago', digits: 0 },
  breathing: { metric: 'breathing_disturbances',  priorDaysAgo: 30, halfWindow: 7, epsilon: 1,   windowLabel: 'vs. ~30 days ago', digits: 0 },
};

export function getTrendDeltas() {
  const out = {};
  for (const [key, spec] of Object.entries(TREND_SPEC)) {
    const { metric, ...opts } = spec;
    out[key] = buildTrend(metric, opts);
  }
  return out;
}

export function getBodyMetrics() {
  const weight = latestScalar.get('weight_body_mass');
  const bmi = latestScalar.get('body_mass_index');
  const bodyFat = latestScalar.get('body_fat_percentage');
  const vo2 = latestScalar.get('vo2_max');
  const rhr = rhr30d.get();
  const hrv = hrvDaily.get();
  const spo2 = spo2Nadir.get();
  const breathing = breathingDaily.get();
  const trends = getTrendDeltas();

  return { weight, bmi, bodyFat, vo2, rhr, hrv, spo2, breathing, trends };
}

// ---- WEIGHT HISTORY + Trends ----------------------------------------------

// Weight 180d. Aggregates across sources (a day may carry a high-res + legacy daily row);
// AVG per day collapses cleanly and avoids step artifacts.
const weightTrend = optionalStmt(`
  SELECT local_date, ROUND(AVG(qty), 2) AS kg
  FROM health_metric
  WHERE metric_name = 'weight_body_mass'
    AND local_date >= date('now', '-180 days')
  GROUP BY local_date
  ORDER BY local_date
`);

// Steps 30d — Apple-Watch-derived only. The merged "Watch|iPhone" source IS the
// Apple-Watch daily figure (iPhone-only days are excluded). Per day we take the
// MAX across sources so we never sum two overlapping sources (double-count guard).
const stepsTrend = optionalStmt(`
  SELECT local_date, ROUND(MAX(per_source), 0) AS steps
  FROM (
    SELECT local_date, source, SUM(qty) AS per_source
    FROM health_metric
    WHERE metric_name = 'step_count'
      AND local_date >= date('now', '-30 days')
      AND (source LIKE '%Watch%')   -- watch-only or watch|iphone merged
    GROUP BY local_date, source
  )
  GROUP BY local_date
  ORDER BY local_date
`);

// Sleep 30d — Apple Watch only (other/legacy sleep sources are less reliable).
const sleepTrend = optionalStmt(`
  SELECT local_date,
         ROUND(total_sleep_hr, 2) AS total_hr,
         ROUND(deep_hr, 2)        AS deep_hr,
         ROUND(rem_hr, 2)         AS rem_hr
  FROM health_sleep
  WHERE source LIKE '%Watch%'
    AND local_date >= date('now', '-30 days')
  ORDER BY local_date
`);

export function getTrends() {
  return {
    weight: weightTrend.all(),
    steps: stepsTrend.all(),
    sleep: sleepTrend.all(),
  };
}

// ---- MIND -----------------------------------------------------------------

// Pattern Topics (SSOT bodies). Render the "What I think about here" lead.
//
// EMPTY BY DEFAULT. These are the Topic slugs the Mind section spotlights. The
// cockpit author's real pattern-note slugs have been removed — point this at your
// own via the MIND_TOPIC_SLUGS env var (comma-separated slugs). Unset → the Mind
// "patterns" section is empty (calm), not populated with someone else's notes.
const mindTopicSlugs = (process.env.MIND_TOPIC_SLUGS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const topicBySlug = optionalStmt(`
  SELECT slug, name, body FROM topics WHERE slug = ?
`);

export function getMindTopics() {
  // Misses are FILTERED OUT (calm empty section) rather than rendered as "missing"
  // placeholder cards — so an unset MIND_TOPIC_SLUGS, or a slug that doesn't exist
  // in this mirror, simply yields no card.
  return mindTopicSlugs
    .map((slug) => {
      const row = topicBySlug.get(slug);
      if (!row) return { slug, name: slug, lead: null, full: null, missing: true };
      // lead = the short scannable card preview (unchanged).
      // full = readable blocks for the click-to-expand Sheet (v2): nothing is
      // permanently cut — the whole "What I think about here" thinking is here.
      return {
        slug,
        name: row.name,
        lead: extractLead(row.body),
        full: toReadableBlocks(extractSection(row.body, 'What I think about here') ?? row.body),
        missing: false,
      };
    })
    .filter((t) => !t.missing);
}

// psyche.md body (stub -> "profile in progress").
const psycheKE = optionalStmt(`
  SELECT name, body FROM key_elements WHERE slug = 'psyche'
`);

export function getPsyche() {
  const row = psycheKE.get();
  if (!row) return { present: false };
  // Stub detection: all synthesis sections still say "Noch leer".
  // The 'Noch leer' marker matches the German-language stub placeholder used in the
  // reference psyche.md; adapt it if your psyche.md uses a different stub marker.
  const isStub = (row.body.match(/Noch leer/g) || []).length >= 4;
  return { present: true, isStub, name: row.name };
}

// recent journal mood/energy — last 14, free-text (NOT a numeric trend, per Silas).
// mood_valence (1..5 integer, language-neutral — Silas added it; 836 set / 3 NULL)
// is the PRIMARY colour signal for the mood label. The free-text `mood` word stays
// the visible label; valence just decides the calm tone (low/neutral/good). NULL
// valence falls back to the German word-matcher on the client.
const recentJournal = optionalStmt(`
  SELECT entry_date, mood, mood_valence, energy, title
  FROM journal
  WHERE (mood IS NOT NULL AND mood != '')
     OR (energy IS NOT NULL AND energy != '')
  ORDER BY entry_date DESC, id DESC
  LIMIT 14
`);

// optional: health_mood valence sparkline (sparse; ends 2025-08 — render honestly).
const moodValence = optionalStmt(`
  SELECT local_date, ROUND(valence, 3) AS valence, valence_class, kind
  FROM health_mood
  ORDER BY local_date
`);

export function getMindMood() {
  return {
    journal: recentJournal.all(),
    valence: moodValence.all(),
  };
}

// ---- PLANNED: habits ------------------------------------------------------
const habitBySlug = optionalStmt(`
  SELECT slug, name, cadence, started_on, status, body FROM habits WHERE slug = ?
`);

// Habit slugs the Planned section spotlights. EMPTY BY DEFAULT — set HABIT_SLUGS
// (comma-separated) to your own habit-note slugs. The cockpit author's real slugs
// have been removed; unset → an empty habit list (calm), not someone else's habits.
const habitSlugs = (process.env.HABIT_SLUGS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function getHabits() {
  // Misses are filtered out (calm empty state) — a fresh mirror without these
  // notes shows an empty habit list, not stubs.
  return habitSlugs
    .map((slug) => {
      const row = habitBySlug.get(slug);
      if (!row) return { slug, name: slug, lead: null, missing: true };
      return {
        slug,
        name: row.name,
        cadence: row.cadence,
        started: row.started_on,
        status: row.status,
        lead: extractWhy(row.body),
        full: toReadableBlocks(extractSection(row.body, 'Why this habit') ?? row.body),
        missing: false,
      };
    })
    .filter((h) => !h.missing);
}

// ---- helpers --------------------------------------------------------------

// First substantive paragraph under "## What I think about here".
function extractLead(content) {
  if (!content) return null;
  const m = content.match(/##\s+What I think about here\s*\n+([\s\S]*?)(\n##\s|\n---|\s*$)/);
  if (!m) return firstParagraph(content);
  return firstParagraph(m[1]);
}

// First substantive paragraph under "## Why this habit".
function extractWhy(content) {
  if (!content) return null;
  const m = content.match(/##\s+Why this habit\s*\n+([\s\S]*?)(\n##\s|\n>\s|\n---|\s*$)/);
  if (!m) return firstParagraph(content);
  return firstParagraph(m[1]);
}

function firstParagraph(text) {
  if (!text) return null;
  const para = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('>') && !p.startsWith('#'));
  return para ? stripInlineMd(para.replace(/\s+/g, ' ').trim()) : null;
}

// Strip markdown emphasis + wikilinks to plain prose for card leads.
function stripInlineMd(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[target|alias]] -> alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[target]] -> target
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *italic* -> italic
    .replace(/`([^`]+)`/g, '$1') // `code` -> code
    .replace(/\s+/g, ' ')
    .trim();
}

// Inline-strip but KEEP **bold** as a marker the client renders as emphasis —
// breaking walls of text into paragraphs + bullets + emphasized key lines (v2 #3).
function stripKeepBold(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull a full "## Heading" section body (everything up to the next "## " / "---").
function extractSection(content, heading) {
  if (!content) return null;
  const re = new RegExp(
    `##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|\\n---|\\s*$)`
  );
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

// Convert a markdown chunk into an ordered array of readable blocks the client
// can render with air: { type: 'p' | 'ul' | 'h', text? , items? }. This is what
// makes the Sheet scannable instead of one dense paragraph.
function toReadableBlocks(md) {
  if (!md) return [];
  const lines = md.split('\n');
  const blocks = [];
  let para = [];
  let list = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', text: stripKeepBold(para.join(' ')) });
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: 'ul', items: list.map((i) => stripKeepBold(i)) });
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', text: stripKeepBold(heading[1]) });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      if (quote[1]) blocks.push({ type: 'quote', text: stripKeepBold(quote[1]) });
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
