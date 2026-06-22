// teamKnowledgeApi.js — read-only list endpoints for the three Team-Knowledge
// doc families surfaced on the "My AI Team" fly-out: Workstreams, SOPs,
// Guidelines. Mirrors sessionLogsApi.js: SELECTs against the read-only mypka.db
// handle, rides the cockpit's standard `safe(handler)` envelope (so it inherits
// the SAME loopback/PIN/CSRF read-gate as every other /api/cockpit route), and
// degrades to a calm { available:false } envelope when the backing table is
// absent on a leaner mirror (a scaffold whose regen predates these tables).
//
//   GET /api/cockpit/team-knowledge/:family   (family ∈ workstreams|sops|guidelines)
//       { available, family, items } — items newest/id-ordered with the fields the
//       generic list view renders: slug, doc_id, title, status, owner, summary,
//       version, triggered_by, file_path.
//
// The three tables share an IDENTICAL column shape (see scripts/regen-mypka-db.py
// §"workstreams / sops / guidelines"): slug, doc_id, title, status, owner,
// doc_type, summary, version, triggered_by, tags, body, file_path,
// raw_frontmatter. One generic reader serves all three — only the table name
// (validated against an allow-list, never interpolated from raw input) varies.
import db from './db.js';

// The only three table names this module will ever touch. The :family route
// param is mapped through THIS map, so the table name in the SQL is a fixed
// literal from our own code — never a value derived from the request. (No SQL
// identifier interpolation of user input.)
const FAMILY_TABLE = {
  workstreams: 'workstreams',
  sops: 'sops',
  guidelines: 'guidelines',
};

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name);
}

// Prepare one list statement per existing family table at module load (the same
// load-time prepare idiom the rest of the server uses). A family whose table is
// absent maps to null and the reader returns { available:false } for it.
//
// Ordering: by the formal doc number when present (WS-001 < WS-002 < …), with
// the un-numbered docs (NULL doc_id — e.g. the task SOPs) after the numbered run,
// then by title. `doc_id` is a string like 'WS-12'; a plain string sort would put
// 'WS-12' before 'WS-2', so we sort on the numeric tail extracted from doc_id.
const STMTS = Object.fromEntries(
  Object.entries(FAMILY_TABLE).map(([family, table]) => {
    if (!tableExists(table)) return [family, null];
    return [
      family,
      db.prepare(`
        SELECT slug, doc_id, title, status, owner, summary, version,
               triggered_by, file_path
        FROM ${table}
        ORDER BY
          CASE WHEN doc_id IS NULL THEN 1 ELSE 0 END,
          CAST(
            COALESCE(
              NULLIF(REPLACE(REPLACE(REPLACE(UPPER(COALESCE(doc_id, '')),
                'WS-', ''), 'SOP-', ''), 'GL-', ''), ''),
              '999999'
            ) AS INTEGER
          ),
          title COLLATE NOCASE
      `),
    ];
  }),
);

function shape(row) {
  return {
    slug: row.slug,
    docId: row.doc_id || null,
    title: row.title || row.slug,
    status: row.status || null,
    owner: row.owner || null,
    summary: row.summary || null,
    version: row.version || null,
    triggeredBy: row.triggered_by || null,
    filePath: row.file_path || null,
  };
}

function readFamily(family) {
  const stmt = STMTS[family];
  if (!stmt) return { available: false, family, items: [] };
  const items = stmt.all().map(shape);
  return { available: true, family, items };
}

export function registerTeamKnowledgeRoutes(app, { safe }) {
  app.get('/api/cockpit/team-knowledge/:family', safe((req) => {
    const family = String(req.params.family || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FAMILY_TABLE, family)) {
      // Unknown family — same calm absent envelope rather than a 500/404, so the
      // client renders the empty state instead of an error.
      return { available: false, family, items: [] };
    }
    return readFamily(family);
  }));
}

export { readFamily };
