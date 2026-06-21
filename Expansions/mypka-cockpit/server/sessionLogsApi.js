// sessionLogsApi.js — the team's session-log history feed (the LEFT column of
// the "My AI Team" page). Read-only; SELECT against the read-only mypka.db
// handle. Rides the cockpit's standard `safe(handler)` envelope, so it inherits
// the SAME loopback/PIN/CSRF read-gate as every other /api/cockpit route.
//
//   GET /api/cockpit/session-logs?before=<ISO-or-date>&limit=20
//       newest-first session-log entries (date + title + summary snippet +
//       full body for in-place unfold). Cursor is the `timestamp` of the oldest
//       loaded row; the page is `timestamp < before`. `available:false` on a
//       leaner mirror with no session_logs table — the column shows a calm
//       empty state, never an error.
//
// The session_logs table (when present) carries: slug, file_path, agent_id,
// session_id, timestamp, type, linked_sops, linked_workstreams,
// linked_guidelines, body, raw_frontmatter. There is no title column — the
// title is the body's H1 (the convention every session log follows); we derive
// it server-side so the feed reads exactly like the Journal feed (date + title
// + snippet).
import db from './db.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const EXCERPT_CHARS = 320;

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name);
}

const HAS_SESSION_LOGS = tableExists('session_logs');

// Newest-first page, strictly OLDER than @before (or from the newest when
// @before is null). NULL timestamps sort last and are excluded from the cursor
// window so they never wedge the feed.
const pageStmt = HAS_SESSION_LOGS
  ? db.prepare(`
      SELECT slug, file_path, agent_id, session_id, timestamp, type,
             linked_sops, linked_workstreams, linked_guidelines, body
      FROM session_logs
      WHERE timestamp IS NOT NULL
        AND (@before IS NULL OR timestamp < @before)
      ORDER BY timestamp DESC, slug DESC
      LIMIT @limit
    `)
  : null;

const olderCountStmt = HAS_SESSION_LOGS
  ? db.prepare(`
      SELECT COUNT(*) AS c FROM session_logs
      WHERE timestamp IS NOT NULL AND timestamp < ?
    `)
  : null;

// Light markdown strip for the teaser (same shape as journalFeed.js).
function stripMarkdownLight(md) {
  if (!md) return '';
  let s = String(md);
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/!\[\[[^\]]*\]\]/g, ' ');
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/\[!\w+\][+-]?\s*/g, '');
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, ' ');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)([^*_\n]+)\1/g, '$2');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// The H1 of the body is the session-log title. Falls back to a humanised slug.
function titleOf(body, slug) {
  if (typeof body === 'string') {
    const m = body.match(/^\s{0,3}#\s+(.+?)\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  return slug || 'Session log';
}

function excerptOf(text, n = EXCERPT_CHARS) {
  if (text.length <= n) return text;
  let cut = text.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > n * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

// timestamp -> YYYY-MM-DD for the feed's date display (the column matches the
// Journal feed's date+title+snippet reading). The stored value may be a full
// ISO timestamp or a date; take the leading 10 chars when they look like a date.
function dateOf(ts) {
  if (typeof ts !== 'string') return null;
  const head = ts.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
}

function shape(row) {
  // Drop the leading H1 from the body teaser so the snippet doesn't repeat the
  // title we already surface.
  const bodyForExcerpt = (row.body || '').replace(/^\s{0,3}#\s+.+?(\r?\n|$)/, '');
  return {
    slug: row.slug,
    title: titleOf(row.body, row.slug),
    agent: row.agent_id || null,
    type: row.type || null,
    timestamp: row.timestamp || null,
    date: dateOf(row.timestamp),
    excerpt: excerptOf(stripMarkdownLight(bodyForExcerpt)),
    body: row.body || '',
    contentLength: (row.body || '').length,
    filePath: row.file_path || null,
  };
}

function readFeed({ before = null, limit = DEFAULT_LIMIT } = {}) {
  if (!HAS_SESSION_LOGS) {
    return { available: false, entries: [], hasMore: false, nextBefore: null };
  }
  const cursor = typeof before === 'string' && before.trim() ? before.trim() : null;
  let cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 1) cap = DEFAULT_LIMIT;
  if (cap > MAX_LIMIT) cap = MAX_LIMIT;

  const rows = pageStmt.all({ before: cursor, limit: cap });
  const entries = rows.map(shape);
  const oldest = rows.length ? rows[rows.length - 1].timestamp : null;
  const hasMore = oldest != null && olderCountStmt.get(oldest).c > 0;
  return {
    available: true,
    entries,
    hasMore,
    nextBefore: hasMore ? oldest : null,
  };
}

export function registerSessionLogsRoutes(app, { safe }) {
  app.get('/api/cockpit/session-logs', safe((req) =>
    readFeed({
      before: typeof req.query.before === 'string' ? req.query.before : null,
      limit: Number(req.query.limit) || DEFAULT_LIMIT,
    }),
  ));
}

export { readFeed };
