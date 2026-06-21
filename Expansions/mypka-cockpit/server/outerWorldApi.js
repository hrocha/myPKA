// outerWorldApi.js — read-only server queries for the OUTER WORLD module
// (DATA-CONTRACT §14). The Outer World is the mymind-style store of everything
// the user SAVES from outside their own head (articles, posts, videos, books,
// ideas, news). This module is the cockpit's read surface over the `outer_world`
// table. NEW file — these queries deliberately live OUTSIDE cockpit.js and
// libraryApi.js (item 10 build contract).
//
// DESIGN
//   * The grid is small, so the common path is the §14.4(a) read: pull the whole
//     (body-less) table once, newest-saved first; facet/filter client-side over
//     the in-memory rows. A by-slug fetch (§14.4(d)) serves the detail-large.
//   * DEGRADES GRACEFULLY on a bare scaffold. The `outer_world` table only exists
//     after `install-extensions.py --with-outer-world` (or a regen that mirrors
//     it). Until then every endpoint returns a calm `{ available: false, items: [] }`
//     envelope — never a 500, never a crash (§14 degrade-gracefully).
//   * READ-ONLY: every statement is a SELECT against the read-only db (db.js opens
//     it readonly + query_only). Markdown is canonical; this never writes.
//
// SECURITY — injection + image posture.
//   * NO table-name interpolation: `outer_world` is a fixed literal in every
//     query; only VALUES are bound (`?` placeholders). There is no user-controlled
//     identifier anywhere in this file.
//   * embed_image / embed_favicon are LOCAL relative paths (§14.2) — note-relative
//     (`_assets/<slug>.png`). The fetcher localized them at capture time; there is
//     NO remote image fetch at render. We resolve them here to a PKM-relative path
//     (joined onto the note's own directory from `file_path`) so the client serves
//     them straight through the existing jailed `/api/cockpit/media` route. The
//     resolved path is normalized + kept inside `PKM/` (any `..` escape or absolute
//     path is dropped → favicon/title fallback), so a malformed frontmatter path
//     can never point the media jail outside the scaffold.
//
// Mounted by server.js via registerOuterWorldRoutes(app, { safe }).
import db from './db.js';

function tableExists(name) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

// Parse a JSON-array TEXT column → string[]; tolerant of NULL / malformed (§14.4).
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
      : [];
  } catch {
    return [];
  }
}

// Resolve a note-relative embed path (e.g. `_assets/x.png`, stored verbatim by the
// regen) to the PREFIX-FREE, PKM-relative path the jailed /api/cockpit/media route
// accepts. The note lives at `file_path` (`PKM/Outer World/YYYY/MM/<slug>.md`), so
// the image sits beside it. IMPORTANT CONTRACT: the media route PREPENDS "PKM/" to
// its `path` arg (it resolves against PKM_DIR), so a value carrying a leading
// "PKM/" would 404 (PKM/PKM/…). We therefore return the path RELATIVE TO PKM/ with
// NO "PKM/" prefix (e.g. "Outer World/2026/06/_assets/x.png") — the same convention
// journal_media.file_path uses (cockpit.js `toPkmRelative`). We normalize the join
// and HARD-REJECT anything that escapes PKM/ (a `..` climbing above PKM, or an
// absolute path) → null (the card then falls back to favicon/title, never a broken
// or out-of-jail image). The media route re-jails too (defense in depth); this
// keeps the URL correct + the client honest.
function resolvePkmRelative(filePath, embedPath) {
  if (!embedPath || typeof embedPath !== 'string') return null;
  const raw = embedPath.trim();
  if (!raw) return null;
  // Absolute paths are never note-relative embed assets → reject (out of jail).
  if (raw.startsWith('/')) return null;
  const noteRel = String(filePath || '').replace(/\\/g, '/');
  // Directory of the note (PKM-prefixed, as stored), minus the filename.
  const dir = noteRel.includes('/') ? noteRel.slice(0, noteRel.lastIndexOf('/')) : '';
  // If the embed path is already PKM-rooted, use it as-is; else join onto the note dir.
  const candidate = raw.startsWith('PKM/') ? raw : `${dir}/${raw}`;
  // Normalize . and .. segments without touching the filesystem.
  const segs = [];
  for (const seg of candidate.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return null; // climbs above the root → reject
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  const normalized = segs.join('/');
  // Must resolve INSIDE PKM/ … then strip that single prefix so the media route
  // (which prepends PKM/) lands on the right file. A path that doesn't sit under
  // PKM/ after normalization is out of jail → null.
  if (normalized !== 'PKM' && !normalized.startsWith('PKM/')) return null;
  const prefixFree = normalized.replace(/^PKM\//, '');
  return prefixFree || null;
}

// Shape one grid/detail row per the §14.4 contract: JSON-array cols → arrays;
// NULL scalars stay null (the client renders blank, never 0 / "unknown"); the two
// LOCAL image paths are resolved to PKM-relative (or null on a bad/escaping path).
function shapeRow(row) {
  return {
    slug: row.slug,
    title: row.title ?? null,
    status: row.status ?? null,
    captured_on: row.captured_on ?? null,
    source_url: row.source_url ?? null,
    source_type: row.source_type ?? null,
    source_author: row.source_author ?? null,
    source_published: row.source_published ?? null,
    embed_kind: row.embed_kind ?? null,
    embed_title: row.embed_title ?? null,
    embed_description: row.embed_description ?? null,
    // resolved PKM-relative path (or null) — the client passes it to /api/cockpit/media
    embed_image: resolvePkmRelative(row.file_path, row.embed_image),
    embed_site_name: row.embed_site_name ?? null,
    embed_domain: row.embed_domain ?? null,
    embed_favicon: resolvePkmRelative(row.file_path, row.embed_favicon),
    embed_author: row.embed_author ?? null,
    embed_captured_at: row.embed_captured_at ?? null,
    tom_context: row.tom_context ?? null,
    tags: parseJsonArray(row.tags),
    linked_topics: parseJsonArray(row.linked_topics),
    linked_key_elements: parseJsonArray(row.linked_key_elements),
    linked_projects: parseJsonArray(row.linked_projects),
    linked_people: parseJsonArray(row.linked_people),
    linked_organizations: parseJsonArray(row.linked_organizations),
    file_path: row.file_path ?? null,
  };
}

// ── (a) Enumerate the Outer World library (the card grid) — §14.4(a) ───────────
// Newest-saved first. Projects the embed_* + source + linked_* + tags + tom_context
// per the contract; DROPS the heavy `body` (+ raw_frontmatter) — the detail-large
// by-slug fetch pulls those. Empty / absent table → calm empty envelope.
export function listOuterWorld() {
  if (!tableExists('outer_world')) return { available: false, items: [] };
  const rows = db
    .prepare(
      `SELECT slug, title, status, captured_on,
              source_url, source_type, source_author, source_published,
              embed_kind, embed_title, embed_description, embed_image,
              embed_site_name, embed_domain, embed_favicon, embed_author,
              embed_captured_at, tom_context, tags,
              linked_topics, linked_key_elements, linked_projects,
              linked_people, linked_organizations,
              file_path
       FROM outer_world
       ORDER BY captured_on DESC, title COLLATE NOCASE ASC`,
    )
    .all()
    .map(shapeRow);
  return { available: true, items: rows };
}

// ── (d) One item by slug — the card → detail-LARGE fetch — §14.4(d) ────────────
// Returns the full row INCLUDING `body` (the rendered markdown detail). slug is a
// bound VALUE, never interpolated. {available, found, item}.
export function getOuterWorldItem(itemSlug) {
  if (!tableExists('outer_world')) return { available: false, found: false };
  const row = db
    .prepare(`SELECT * FROM outer_world WHERE slug = ? LIMIT 1`)
    .get(itemSlug);
  if (!row) return { available: true, found: false };
  const shaped = shapeRow(row);
  shaped.body = typeof row.body === 'string' ? row.body : '';
  return { available: true, found: true, item: shaped };
}

// ── Route registration (mirrors registerLibraryRoutes etc.) ────────────────────
// Both are read-only GETs. They inherit the server's global /api auth gate
// (PIN / loopback-convenience / session) and the loopback bind — same posture as
// every other cockpit read endpoint. No CSRF token needed (CSRF guards WRITES;
// these never write).
export function registerOuterWorldRoutes(app, { safe }) {
  // Enumerate the Outer World items (the card grid).
  app.get('/api/cockpit/outer-world', safe(() => listOuterWorld()));
  // One item by slug (card → detail-large: embed header + body + annotation).
  app.get('/api/cockpit/outer-world/item/:slug', safe((req) =>
    getOuterWorldItem(req.params.slug),
  ));
}
