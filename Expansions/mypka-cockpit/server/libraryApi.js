// libraryApi.js — read-only server queries for the LIBRARY foundation
// (DATA-CONTRACT §11). A "library" is a curated collection the user browses
// (recipes, films, books, …); the foundation is per-library typed mirror tables
// + a `library_registry` row each. This module is the cockpit's read surface over
// that foundation. NEW file — these queries deliberately live OUTSIDE cockpit.js.
//
// DESIGN
//   * Fully DATA-DRIVEN off `library_registry`: the cockpit asks "what libraries
//     exist and how do I render each?" — no hard-coded recipes/movies. A user's
//     own library appears the moment its registry row lands (§11.1).
//   * DEGRADES GRACEFULLY on a bare scaffold. The library tables only exist after
//     `install-extensions.py --with-libraries` (or a regen that mirrors them);
//     until then `library_registry` is absent. Every endpoint then returns a calm
//     `{ available: false, ... }` envelope — never a 500, never a crash. This is
//     the §11.4 / degrade-gracefully contract.
//   * READ-ONLY: every statement is a SELECT against the read-only db (db.js opens
//     it readonly + query_only). Markdown is canonical; this never writes.
//
// SECURITY — identifier safety. A library's mirror-table name == its
// `library_slug` (§11.1). SQLite can't parameterize an identifier, so the table
// name is interpolated. We never trust the URL slug directly: we look the slug up
// in `library_registry`, take the registry's own `library_slug`, AND re-validate
// it against a strict identifier allow-list (and confirm a real table of that name
// exists) before it ever touches a query string. A request for an unregistered or
// non-identifier slug resolves to "not found", never a raw interpolation.
//
// Pattern mirrors examples/library-module/server-queries.js.snippet (listRecipes
// / listMedia) generalized over the registry. Mounted by server.js via
// registerLibraryRoutes(app, { safe }).
import db from './db.js';

// A SQLite identifier we are willing to interpolate: a table/column name the
// regen + schema produce (kebab is not valid here — slugs that double as table
// names are snake/lowercase ASCII). Anything else is rejected outright.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

function tableExists(name) {
  if (typeof name !== 'string' || !SAFE_IDENT.test(name)) return false;
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

function registryExists() {
  return tableExists('library_registry');
}

// Parse a JSON-array TEXT column → string[]; tolerant of NULL / malformed (§11.4).
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : [];
  } catch {
    return [];
  }
}

// JSON-array TEXT columns the contract defines (parsed to real arrays for the
// client). Any other column passes through verbatim (NULL stays null).
const JSON_ARRAY_COLUMNS = new Set(['tags', 'key_ingredients']);

// ── (a) Enumerate the active libraries (build the Library nav) — §11.4(a) ──────
// Returns [] (not an error) when the registry table is absent — the client then
// renders the empty-state and shows no library nav group.
export function listLibraries() {
  if (!registryExists()) return { available: false, libraries: [] };
  const rows = db
    .prepare(
      `SELECT library_slug, nav_label, nav_icon, pkm_folder, doc_type, sort_order
       FROM library_registry
       ORDER BY sort_order ASC, nav_label COLLATE NOCASE ASC`,
    )
    .all();
  // Only surface libraries whose mirror TABLE actually exists (a registry row
  // without its table would 404 on list — filter it out up front, honest nav).
  const libraries = rows.filter((r) => tableExists(r.library_slug));
  return { available: true, libraries };
}

// Resolve a URL slug → the registry row, with the table-name validated. Returns
// null for an unknown / unregistered / non-identifier slug (caller → not found).
function resolveLibrary(slug) {
  if (!registryExists()) return null;
  const row = db
    .prepare(
      `SELECT library_slug, nav_label, nav_icon, pkm_folder, doc_type, title_field, sort_order
       FROM library_registry WHERE library_slug = ? LIMIT 1`,
    )
    .get(slug);
  if (!row) return null;
  // Defense in depth: the registry's library_slug must be a safe identifier AND a
  // real table before we interpolate it anywhere.
  if (!tableExists(row.library_slug)) return null;
  return row;
}

// Real, ordered column list of a library's mirror table (from PRAGMA, not from
// user input). Used to build an explicit column projection (no `SELECT *` over an
// interpolated name) and to know which columns to JSON-parse.
function tableColumns(table) {
  // `table` already validated by tableExists() before we get here.
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Shape one DB row per the §11.4(b) contract: JSON-array cols → arrays; NULL
// scalars stay null (client renders blank, never 0 / "unknown").
function shapeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_ARRAY_COLUMNS.has(k)) out[k] = parseJsonArray(v);
    else out[k] = v === undefined ? null : v;
  }
  return out;
}

// Natural sort per library type (§11.4(b)): movies most-recently-watched first,
// everything else alpha by title. Built only from real, validated column names.
function orderClause(cols) {
  if (cols.includes('date_watched')) {
    return 'ORDER BY date_watched IS NULL, date_watched DESC, title COLLATE NOCASE ASC';
  }
  if (cols.includes('title')) return 'ORDER BY title COLLATE NOCASE ASC';
  return 'ORDER BY slug COLLATE NOCASE ASC';
}

// ── (b) List a library (the card grid) — §11.4(b) ─────────────────────────────
export function listLibraryItems(slug) {
  const lib = resolveLibrary(slug);
  if (!lib) return { available: false, found: false };
  const table = lib.library_slug;
  const cols = tableColumns(table);
  // Project every contract column EXCEPT the bulky body/raw_frontmatter (the list
  // doesn't need them — the detail-large fetch pulls them by slug). Keeps the grid
  // payload small even for a large library.
  const projected = cols.filter((c) => c !== 'body' && c !== 'raw_frontmatter' && c !== 'id');
  const projection = projected.join(', ');
  const rows = db
    .prepare(`SELECT ${projection} FROM ${table} ${orderClause(cols)}`)
    .all()
    .map(shapeRow);
  return {
    available: true,
    found: true,
    library: {
      slug: lib.library_slug,
      navLabel: lib.nav_label,
      navIcon: lib.nav_icon,
      docType: lib.doc_type,
    },
    items: rows,
  };
}

// ── (d) One item by slug — the clickable-card → detail-LARGE fetch — §11.4(d) ──
// No new endpoint shape was strictly required (§11.4 says reuse the note read or
// `SELECT * WHERE slug=:slug`); we expose the latter as the structured-header +
// body source so the large view needs nothing from cockpit.js. Returns the full
// row INCLUDING `body` (the rendered markdown detail) + `raw_frontmatter`.
export function getLibraryItem(slug, itemSlug) {
  const lib = resolveLibrary(slug);
  if (!lib) return { available: false, found: false };
  const table = lib.library_slug;
  const row = db.prepare(`SELECT * FROM ${table} WHERE slug = ? LIMIT 1`).get(itemSlug);
  if (!row) return { available: true, found: false };
  return {
    available: true,
    found: true,
    library: {
      slug: lib.library_slug,
      navLabel: lib.nav_label,
      navIcon: lib.nav_icon,
      docType: lib.doc_type,
    },
    item: shapeRow(row),
  };
}

// ── Route registration (mirrors registerInvoicesRoutes etc.) ──────────────────
// All three are read-only GETs. They inherit the server's global /api auth gate
// (PIN / loopback-convenience / session) and the loopback bind — same posture as
// every other cockpit read endpoint. No CSRF token needed (CSRF guards WRITES;
// these never write).
export function registerLibraryRoutes(app, { safe }) {
  // Enumerate the libraries (nav group).
  app.get('/api/cockpit/libraries', safe(() => listLibraries()));
  // List one library's items (card grid).
  app.get('/api/cockpit/library/:slug', safe((req) => listLibraryItems(req.params.slug)));
  // One item by slug (card → detail-large: structured header + body).
  app.get('/api/cockpit/library/:slug/item/:itemSlug', safe((req) =>
    getLibraryItem(req.params.slug, req.params.itemSlug),
  ));
}
