// journalFeed.js — paginated, excerpt-shaped journal feed for the timeline view.
//
//   GET /api/cockpit/journal-feed?before=<YYYY-MM-DD>&limit=20
//
// Returns journal entries newest-first, strictly OLDER than `before` (or from the
// latest entry when `before` is absent/invalid), each with a lightly markdown-
// stripped ~400-char excerpt and up to 4 image paths from journal_media. Powers
// the JournalView vertical timeline's backwards infinite scroll.
//
// Read-only by construction: every statement is a SELECT against the read-only
// mypka.db handle (db.js opens readonly + query_only). Markdown stays canonical.
//
// Cursor semantics: the cursor is a DATE (the spec's `before=<YYYY-MM-DD>`), so a
// page never splits a same-date group — we extend the page until the boundary
// date changes (otherwise `entry_date < before` on the next request would skip
// the same-date siblings left behind the limit). Bounded extension, see below.
import db from './db.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const EXCERPT_CHARS = 400;
const MAX_IMAGES = 4;
const SAME_DATE_EXTENSION_CAP = 50; // safety bound for the same-date page extension

// ---------------------------------------------------------------------------
// Prepared statements (journal + journal_media are preflight-guaranteed by
// db.js; an EMPTY table simply yields zero rows — every shaping step below
// degrades to [] / null without throwing).
// ---------------------------------------------------------------------------
const pageStmt = db.prepare(`
  SELECT id, slug, title, entry_date, mood, mood_valence, energy, category, content
  FROM journal
  WHERE entry_date IS NOT NULL
    AND (@before IS NULL OR entry_date < @before)
  ORDER BY entry_date DESC, id DESC
  LIMIT @limit
`);

// Count of entries strictly older than a date — drives `hasMore` exactly.
const olderCountStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM journal
  WHERE entry_date IS NOT NULL AND entry_date < ?
`);

// Image-like media only (image/screenshot); audio is the note viewer's concern.
const mediaStmt = db.prepare(`
  SELECT file_path
  FROM journal_media
  WHERE journal_id = ?
    AND media_type IN ('image', 'screenshot')
    AND file_path IS NOT NULL
  ORDER BY sort_order, id
  LIMIT ${MAX_IMAGES}
`);

// ---------------------------------------------------------------------------
// Light markdown strip for the excerpt. NOT a parser — just enough that the
// teaser reads as prose: drops embeds/fences/heading marks, unwraps wikilinks
// and inline links to their labels, removes emphasis markers, collapses
// whitespace. The full entry renders through the client's WikiMarkdown.
// ---------------------------------------------------------------------------
function stripMarkdownLight(md) {
  if (!md) return '';
  let s = String(md);
  s = s.replace(/```[\s\S]*?```/g, ' ');                       // fenced code blocks
  s = s.replace(/!\[\[[^\]]*\]\]/g, ' ');                      // ![[embeds]]
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');         // [[target|alias]] -> alias
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');                    // [[target]] -> target
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                 // ![img](url)
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');               // [text](url) -> text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');                    // heading marks
  s = s.replace(/^\s{0,3}>\s?/gm, '');                         // blockquote marks
  s = s.replace(/\[!\w+\][+-]?\s*/g, '');                      // Obsidian callout markers
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '');               // list markers
  s = s.replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, ' ');          // horizontal rules
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');                    // bold
  s = s.replace(/(\*|_)([^*_\n]+)\1/g, '$2');                  // italic
  s = s.replace(/`([^`]*)`/g, '$1');                           // inline code
  s = s.replace(/\s+/g, ' ').trim();                           // collapse whitespace
  return s;
}

// First ~N chars, cut at a word boundary, with a quiet ellipsis when truncated.
function excerptOf(text, n = EXCERPT_CHARS) {
  if (text.length <= n) return text;
  let cut = text.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > n * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

// journal_media.file_path is stored relative to PKM/ WITHOUT the prefix, but be
// liberal: strip one leading "PKM/" so either convention yields the path the
// /api/cockpit/media route expects (mirrors cockpit.js toPkmRelative).
function toPkmRelative(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  return p.trim().replace(/\\/g, '/').replace(/^PKM\//, '');
}

function shapeEntry(row) {
  const stripped = stripMarkdownLight(row.content || '');
  const images = mediaStmt
    .all(row.id)
    .map((m) => toPkmRelative(m.file_path))
    .filter((p) => p !== null);
  return {
    slug: row.slug,
    title: row.title || row.slug,
    date: row.entry_date,
    mood: row.mood || null,
    moodValence: row.mood_valence ?? null,
    energy: row.energy || null,
    category: row.category || null,
    excerpt: excerptOf(stripped),
    contentLength: (row.content || '').length,
    images,
  };
}

// ---------------------------------------------------------------------------
// The feed read. `before` must look like YYYY-MM-DD; anything else (absent,
// malformed) calmly degrades to "from the latest". Empty journal -> a valid
// empty feed ({ entries: [], hasMore: false, nextBefore: null }).
// ---------------------------------------------------------------------------
function readFeed({ before = null, limit = DEFAULT_LIMIT } = {}) {
  const cursor = typeof before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(before) ? before : null;
  let cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 1) cap = DEFAULT_LIMIT;
  if (cap > MAX_LIMIT) cap = MAX_LIMIT;

  // Fetch the page, then extend it while the boundary would split a same-date
  // group (the date cursor cannot address "page 2 of the same day"). Bounded.
  let rows = pageStmt.all({ before: cursor, limit: cap + 1 });
  let extended = cap;
  while (
    rows.length > extended &&
    rows[extended - 1].entry_date === rows[extended].entry_date &&
    extended < cap + SAME_DATE_EXTENSION_CAP
  ) {
    extended += 1;
    if (rows.length <= extended) {
      rows = pageStmt.all({ before: cursor, limit: extended + 1 });
    }
  }
  const page = rows.slice(0, extended);

  const entries = page.map(shapeEntry);
  const oldest = entries.length ? entries[entries.length - 1].date : null;
  const hasMore = oldest !== null && olderCountStmt.get(oldest).c > 0;
  return {
    entries,
    hasMore,
    // The next request's `before` cursor — the oldest date on this page.
    nextBefore: hasMore ? oldest : null,
  };
}

// ---------------------------------------------------------------------------
// Route registration — server.js calls registerJournalFeed(app, { safe }) so
// the feed rides the same calm catch→500 envelope as every other cockpit read.
// ---------------------------------------------------------------------------
export function registerJournalFeed(app, { safe }) {
  app.get('/api/cockpit/journal-feed', safe((req) =>
    readFeed({
      before: typeof req.query.before === 'string' ? req.query.before : null,
      limit: Number(req.query.limit) || DEFAULT_LIMIT,
    })
  ));
}

export { readFeed };
