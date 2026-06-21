// serendipityApi.js — the Hub's two "serendipity" read layers over mypka.db
// (read-only). Two optional modules, each degrading gracefully to an honest
// empty state when its backing data is absent (mirrors invoicesApi.js posture):
//
//   GET /api/cockpit/quotes/random        -> one random quote (Silas's §8 query)
//   GET /api/cockpit/journal/on-this-day  -> journal entries from the SAME
//                                            calendar day across prior periods
//                                            (Silas's §9 contract), with embeds
//
// Both are pure SELECTs. The `quotes` table is OPTIONAL (added by
// install-extensions.py --with-quotes); `journal`/`journal_media` are core
// boot-required tables, so On This Day never has to guard for their absence —
// but it does guard defensively anyway (foreign mirror tolerance), returning
// `available:false` when the table is unexpectedly missing rather than throwing.
//
// Markdown is canonical; every statement here is a SELECT. The DB connection is
// opened readonly + PRAGMA query_only in db.js.
import db from './db.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function tableExists(name) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`)
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

// Parse a JSON-array TEXT column → string[]; tolerant of NULL / malformed (never
// throws on the Hub). Matches invoicesApi.parseSlugArray semantics.
function parseTags(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// NULL scalar → null (never 0 / '' / 'unknown'). The UI renders blank for null.
function nullable(v) {
  return v === undefined || v === null || v === '' ? null : v;
}

// ===========================================================================
// (a) Random quote — DATA-CONTRACT §8.
// ===========================================================================

export function getRandomQuote() {
  if (!tableExists('quotes')) {
    return { available: false, quote: null };
  }
  // Silas's documented query verbatim — RANDOM() over a tiny table, no index.
  const row = db
    .prepare(
      `SELECT slug, quote_text, author, author_slug, source, quote_year, tags, file_path
       FROM quotes
       ORDER BY RANDOM()
       LIMIT 1`,
    )
    .get();

  if (!row) {
    // Table present, zero rows → available but empty (honest empty state).
    return { available: true, quote: null };
  }

  return {
    available: true,
    quote: {
      slug: row.slug,
      quoteText: nullable(row.quote_text),
      author: nullable(row.author),
      authorSlug: nullable(row.author_slug),
      source: nullable(row.source),
      year: typeof row.quote_year === 'number' ? row.quote_year : null,
      tags: parseTags(row.tags),
      // Root-relative (PKM/Quotes/<slug>.md). The card routes the click to the
      // file reading view, which jails on a PKM/-relative path → strip "PKM/".
      filePath: nullable(row.file_path),
    },
  };
}

// ===========================================================================
// (b) On This Day — DATA-CONTRACT §9. Calendar math in app code (true month
// lengths / leap years), parameterized queries, NO view.
// ===========================================================================

// Format a Date as a local 'YYYY-MM-DD' (no timezone drift — we read the local
// Y/M/D components, never toISOString which is UTC).
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Build the discrete "1 month ago / 6 months ago" period targets, computed with
// real calendar math from `anchor`. `setMonth` rolls the year correctly; we then
// clamp a day overflow (e.g. anchor=31 → a short target month) DOWN to the last
// valid day of the target month so we never silently land in the next month.
function monthsAgo(anchor, months) {
  const targetMonthIndex = anchor.getMonth() - months;
  const d = new Date(anchor.getFullYear(), targetMonthIndex, 1);
  // Last day of the resulting month (day 0 of the next month).
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(anchor.getDate(), lastDay));
  return d;
}

// Fetch a journal entry's embedded media (DATA-CONTRACT §9), in sort order.
// file_path is PKM/-relative — served through /api/cockpit/media on the client.
function mediaForJournal(journalId) {
  if (!tableExists('journal_media')) return [];
  const rows = db
    .prepare(
      `SELECT file_path, media_type, mime_type, caption, sort_order
       FROM journal_media
       WHERE journal_id = ?
       ORDER BY sort_order`,
    )
    .all(journalId);
  return rows.map((r) => ({
    filePath: nullable(r.file_path),
    mediaType: nullable(r.media_type),
    mimeType: nullable(r.mime_type),
    caption: nullable(r.caption),
  }));
}

const selByExactDate = () =>
  db.prepare(
    `SELECT id, slug, title, entry_date, content, file_path
     FROM journal
     WHERE entry_date = ?`,
  );

const selByMonthDayTail = () =>
  // §9(a): every prior year on this month-day, newest-first. We bound it to
  // entries strictly OLDER than (today - 1 year) so the discrete-period queries
  // own "1 year ago / 2 years ago" cleanly and the tail picks up only 3+ years
  // back. (Equivalently: substr month-day match, year < anchorYear - 1.)
  db.prepare(
    `SELECT id, slug, title, entry_date, content, file_path
     FROM journal
     WHERE substr(entry_date, 6, 5) = ?
       AND entry_date < ?
     ORDER BY entry_date DESC`,
  );

function shapeEntry(row, bucketKey, bucketLabel) {
  return {
    bucketKey,
    bucketLabel,
    slug: row.slug,
    title: nullable(row.title) || row.slug,
    entryDate: nullable(row.entry_date),
    // Body returned in full; the UI truncates. (Truncation is a UI choice, not a
    // schema one — DATA-CONTRACT §9.)
    content: nullable(row.content) || '',
    filePath: nullable(row.file_path),
    media: mediaForJournal(row.id),
  };
}

export function getOnThisDay(todayStr) {
  if (!tableExists('journal')) {
    return { available: false, anchorDate: todayStr ?? null, buckets: [] };
  }

  // Anchor = today (local). Accept an optional override (testing / future
  // "what about this day in…"); validate the shape, else fall back to now.
  let anchor;
  if (typeof todayStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayStr)) {
    const [y, m, d] = todayStr.split('-').map(Number);
    anchor = new Date(y, m - 1, d);
  } else {
    anchor = new Date();
  }
  const anchorYmd = ymd(anchor);
  const monthDay = anchorYmd.slice(5); // 'MM-DD'

  // Discrete periods, near → far, computed in app code (real calendar math).
  // 1 month, 6 months, then 1 year and 2 years ago. The per-year TAIL (§9a)
  // covers 3+ years back so we never hardcode an upper bound.
  const oneYearAgoYmd = ymd(new Date(anchor.getFullYear() - 1, anchor.getMonth(), anchor.getDate()));
  const periods = [
    { key: 'm1', label: '1 month ago', date: ymd(monthsAgo(anchor, 1)) },
    { key: 'm6', label: '6 months ago', date: ymd(monthsAgo(anchor, 6)) },
    { key: 'y1', label: '1 year ago', date: ymd(new Date(anchor.getFullYear() - 1, anchor.getMonth(), anchor.getDate())) },
    { key: 'y2', label: '2 years ago', date: ymd(new Date(anchor.getFullYear() - 2, anchor.getMonth(), anchor.getDate())) },
  ];

  const byDate = selByExactDate();
  const buckets = [];
  const seenIds = new Set(); // de-dupe: an entry must surface in ONE bucket only

  for (const p of periods) {
    // Guard: never show a future/today date (e.g. a 6-months-ago that math'd
    // forward is impossible here, but anchor==entry_date would be "today").
    if (p.date >= anchorYmd) continue;
    const rows = byDate.all(p.date);
    const entries = [];
    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      entries.push(shapeEntry(row, p.key, p.label));
    }
    if (entries.length > 0) {
      buckets.push({ key: p.key, label: p.label, date: p.date, entries });
    }
  }

  // §9(a) tail — every prior year on this month-day, 3+ years back (strictly
  // older than 1 year ago, so the discrete y1/y2 buckets above aren't double-
  // counted). Group each entry under its own "N years ago" label.
  const tailRows = selByMonthDayTail().all(monthDay, oneYearAgoYmd);
  const tailByYearsAgo = new Map(); // yearsAgo → entries[]
  for (const row of tailRows) {
    if (seenIds.has(row.id)) continue;
    const entryDate = String(row.entry_date || '');
    const yr = Number(entryDate.slice(0, 4));
    if (!Number.isFinite(yr)) continue;
    const yearsAgo = anchor.getFullYear() - yr;
    if (yearsAgo < 3) continue; // y1/y2 owned by the discrete buckets
    seenIds.add(row.id);
    const key = `y${yearsAgo}`;
    const label = `${yearsAgo} years ago`;
    if (!tailByYearsAgo.has(yearsAgo)) tailByYearsAgo.set(yearsAgo, { key, label, entries: [] });
    tailByYearsAgo.get(yearsAgo).entries.push(shapeEntry(row, key, label));
  }
  // Append tail buckets newest-first (smallest yearsAgo first → continues the
  // near→far ordering of the discrete periods).
  for (const yearsAgo of [...tailByYearsAgo.keys()].sort((a, b) => a - b)) {
    const b = tailByYearsAgo.get(yearsAgo);
    buckets.push({ key: b.key, label: b.label, date: null, entries: b.entries });
  }

  return { available: true, anchorDate: anchorYmd, buckets };
}

// ---------------------------------------------------------------------------
// Route registration. server.js calls this once with its `safe()` wrapper so
// both routes get the identical try/catch → 500 envelope and sit behind the
// same /api auth middleware as every other cockpit read.
// ---------------------------------------------------------------------------
export function registerSerendipityRoutes(app, { safe }) {
  app.get('/api/cockpit/quotes/random', safe(() => getRandomQuote()));
  // Optional ?today=YYYY-MM-DD anchor override (defaults to the server's local today).
  app.get(
    '/api/cockpit/journal/on-this-day',
    safe((req) => getOnThisDay(typeof req.query.today === 'string' ? req.query.today : undefined)),
  );
}
