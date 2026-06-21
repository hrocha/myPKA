// documentsApi.js — the Documents page's read layer over mypka.db (read-only).
//
// Two routes, registered via registerDocumentsRoutes(app, { safe }):
//   GET /api/cockpit/documents            -> every document row, shaped for cards
//   GET /api/cockpit/documents/search?q=  -> LIKE search over title/doc_type/body/
//                                            raw_frontmatter (mode:'text' — see below)
//
// Shapes (per item): { id, slug, title, doc_type, metadata, pdfPath, date,
//                      filePath, connections }
//   metadata    — raw_frontmatter parsed as a JSON object ({} on bad/empty)
//   pdfPath     — the first frontmatter file field (digital_location > file >
//                 source_file > attachment > scan) whose value ends in .pdf,
//                 normalized PKM-relative so /api/cockpit/file?path= serves it;
//                 null when no PDF is attached
//   connections — distinct outbound wikilink targets + distinct backlink
//                 sources for the doc's slug, titles resolved against the
//                 entity tables (clickable=false when unresolvable)
//
// SEARCH HONESTY: /search is CONTENT search over the note's text + frontmatter
// (SQL LIKE). It does NOT read inside the PDF bytes and is not semantic —
// that needs an extraction + embedding layer. The response carries
// `mode: 'text'` so the UI can label it honestly; the handler is structured
// as a mode dispatch so a future `mode: 'semantic'` slots in without
// reshaping the API.
//
// Follows the cockpit.js SQL patterns (DISTINCT links reads, per-table title
// resolution, frontmatter-as-JSON) but owns its statements — nothing private
// is imported. Markdown is canonical; every statement here is a SELECT.
import db from './db.js';

// Per-table title columns (mirrors Silas's mapping in cockpit.js — documents
// owns its copy so it imports nothing private).
const TITLE_COL = {
  key_elements: 'name',
  topics: 'name',
  habits: 'name',
  people: 'full_name',
  organizations: 'name',
  projects: 'name',
  goals: 'name',
  documents: 'title',
  deliverables: 'title',
  journal: 'title',
};
const ENTITY_SET = new Set(Object.keys(TITLE_COL));

// Frontmatter keys that may carry the real file, in priority order (the same
// list cockpit.js's preview derivation uses).
const FILE_FIELDS = ['digital_location', 'file', 'source_file', 'attachment', 'scan'];

// Frontmatter keys that may carry the document's date, in priority order.
const DATE_FIELDS = ['date', 'created', 'issued', 'issue_date', 'document_date', 'valid_from'];

// ---------------------------------------------------------------------------
// Guards + helpers
// ---------------------------------------------------------------------------

// db.js preflights the contract tables at boot, but this module must degrade
// calmly (-> empty list) when `documents` or `links` is absent — e.g. against
// a partial mirror produced by a foreign generator.
function tableExists(name) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

function parseFrontmatter(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

// Normalize a frontmatter path to the PKM-relative form the guarded
// /api/cockpit/file route serves (it resolves against PKM/, so a leading
// "PKM/" must be stripped — same quirk cockpit.js documents for media).
function toPkmRelative(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  return p.trim().replace(/\\/g, '/').replace(/^PKM\//, '');
}

// First file-field value ending in .pdf -> servable PKM-relative path, else null.
function derivePdfPath(metadata) {
  for (const key of FILE_FIELDS) {
    const v = metadata[key];
    const candidate = Array.isArray(v) ? v.find((x) => typeof x === 'string') : v;
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const rel = candidate.trim();
    if (!/\.pdf$/i.test(rel)) continue;
    // Absolute / traversal / URL paths can never pass the file route's jail.
    if (rel.startsWith('/') || rel.includes('..') || /^[a-z]+:\/\//i.test(rel)) return null;
    return toPkmRelative(rel);
  }
  return null;
}

// Best-effort document date (ISO-leading string) for newest-first ordering.
function deriveDate(metadata) {
  for (const key of DATE_FIELDS) {
    const v = metadata[key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) {
      return v.trim().slice(0, 10);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connections — one batched pass, never per-document N+1.
//   outbound:  links FROM documents (DISTINCT targets, entity-resolved)
//   backlinks: links INTO any document slug (DISTINCT sources)
// Titles resolve per entity table with one IN(...) SELECT each.
// ---------------------------------------------------------------------------
function buildConnectionsIndex() {
  if (!tableExists('links')) return new Map();

  const outbound = db
    .prepare(
      `SELECT DISTINCT source_slug, target_slug, target_table
       FROM links
       WHERE source_table = 'documents' AND target_slug IS NOT NULL
       ORDER BY target_slug`
    )
    .all();
  const backlinks = db
    .prepare(
      `SELECT DISTINCT target_slug, source_table, source_slug
       FROM links
       WHERE target_slug IN (SELECT slug FROM documents)
       ORDER BY source_table, source_slug`
    )
    .all();

  // Collect every (table, slug) pair we must resolve to a human title.
  const wanted = new Map(); // table -> Set<slug>
  const want = (table, slug) => {
    if (!table || !slug || !ENTITY_SET.has(table)) return;
    if (!wanted.has(table)) wanted.set(table, new Set());
    wanted.get(table).add(slug);
  };
  for (const r of outbound) want(r.target_table, r.target_slug);
  for (const r of backlinks) want(r.source_table, r.source_slug);

  const titles = new Map(); // `${table}/${slug}` -> title
  for (const [table, slugs] of wanted) {
    const list = [...slugs];
    const placeholders = list.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT slug, ${TITLE_COL[table]} AS title FROM ${table} WHERE slug IN (${placeholders})`)
      .all(...list);
    for (const r of rows) titles.set(`${table}/${r.slug}`, r.title);
  }

  // docSlug -> connection[]; dedupe on (type, slug), self excluded.
  const index = new Map();
  const push = (docSlug, conn) => {
    if (conn.type === 'documents' && conn.slug === docSlug) return; // self
    if (!index.has(docSlug)) index.set(docSlug, { list: [], seen: new Set() });
    const bucket = index.get(docSlug);
    const key = `${conn.type ?? ''}/${conn.slug}`;
    if (bucket.seen.has(key)) return;
    bucket.seen.add(key);
    bucket.list.push(conn);
  };

  for (const r of outbound) {
    const clickable = !!(r.target_table && ENTITY_SET.has(r.target_table));
    push(r.source_slug, {
      slug: r.target_slug,
      type: clickable ? r.target_table : null,
      title: (clickable && titles.get(`${r.target_table}/${r.target_slug}`)) || r.target_slug,
      direction: 'outbound',
      clickable,
    });
  }
  for (const r of backlinks) {
    const clickable = ENTITY_SET.has(r.source_table);
    push(r.target_slug, {
      slug: r.source_slug,
      type: clickable ? r.source_table : null,
      title: (clickable && titles.get(`${r.source_table}/${r.source_slug}`)) || r.source_slug,
      direction: 'backlink',
      clickable,
    });
  }

  const out = new Map();
  for (const [slug, bucket] of index) out.set(slug, bucket.list);
  return out;
}

function shapeRow(row, connectionsIndex) {
  const metadata = parseFrontmatter(row.raw_frontmatter);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title || row.slug,
    doc_type: row.doc_type || null,
    metadata,
    pdfPath: derivePdfPath(metadata),
    date: deriveDate(metadata),
    filePath: row.file_path || null,
    connections: connectionsIndex.get(row.slug) || [],
  };
}

// Newest first: metadata date DESC (undated last), then file order (id DESC).
function newestFirst(a, b) {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  return b.id - a.id;
}

// ---------------------------------------------------------------------------
// Route bodies
// ---------------------------------------------------------------------------
export function listDocuments() {
  if (!tableExists('documents')) return { items: [], total: 0 };
  const rows = db
    .prepare(`SELECT id, slug, title, doc_type, file_path, raw_frontmatter FROM documents`)
    .all();
  const connections = buildConnectionsIndex();
  const items = rows.map((r) => shapeRow(r, connections)).sort(newestFirst);
  return { items, total: items.length };
}

// mode dispatch — 'text' today; a future 'semantic' (PDF-text extraction +
// embeddings) registers here without changing the route or response shape.
const SEARCH_MODES = {
  text: textSearch,
};

export function searchDocuments(q, { mode = 'text', limit = 200 } = {}) {
  const run = SEARCH_MODES[mode] || SEARCH_MODES.text;
  return run(String(q ?? '').trim(), limit);
}

function textSearch(q, limit) {
  if (!tableExists('documents')) return { mode: 'text', q, items: [], total: 0 };
  if (!q) {
    // Empty query degrades to the full list (the UI does this client-side
    // too; keeping the server consistent costs nothing).
    return { mode: 'text', q, ...listDocuments() };
  }
  // LIKE with an explicit ESCAPE so user-typed % and _ match literally.
  const needle = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .prepare(
      `SELECT id, slug, title, doc_type, file_path, raw_frontmatter
       FROM documents
       WHERE title           LIKE ? ESCAPE '\\'
          OR doc_type        LIKE ? ESCAPE '\\'
          OR body            LIKE ? ESCAPE '\\'
          OR raw_frontmatter LIKE ? ESCAPE '\\'
       LIMIT ?`
    )
    .all(needle, needle, needle, needle, Math.max(1, Math.min(500, limit)));
  const connections = buildConnectionsIndex();
  const items = rows.map((r) => shapeRow(r, connections)).sort(newestFirst);
  return { mode: 'text', q, items, total: items.length };
}

// ---------------------------------------------------------------------------
// Registration — server.js calls this once with its own safe() wrapper, so
// these routes get the identical try/catch -> 500 envelope and sit behind the
// same /api auth middleware as every other cockpit read.
// ---------------------------------------------------------------------------
export function registerDocumentsRoutes(app, { safe }) {
  app.get('/api/cockpit/documents', safe(() => listDocuments()));
  app.get('/api/cockpit/documents/search', safe((req) =>
    searchDocuments(String(req.query.q ?? ''), {
      mode: String(req.query.mode || 'text'),
      limit: Number(req.query.limit) || 200,
    })
  ));
}
