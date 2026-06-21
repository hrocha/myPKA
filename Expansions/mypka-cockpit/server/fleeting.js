// fleeting.js — Fleeting Notes metadata + whiteboards.
//
// Two cockpit-owned sidecars live INSIDE the Fleeting Notes jail; the markdown
// notes themselves stay frontmatter-free (that is the whole point of the
// surface — see PKM/Fleeting Notes/README.md):
//
//   PKM/Fleeting Notes/_meta.json            per-note cockpit state:
//       { "<slug>": { pinned, status, color } }
//       status: 'capture' (default) | 'working' | 'ready'
//       'ready' is the SIGNAL: the owner marks a note ready for the team to
//       pick up and integrate into the PKM. Agents read it; the cockpit only
//       displays it.
//
//   PKM/Fleeting Notes/_boards/<slug>.json    one whiteboard:
//       { name, area, nodes: [ { id, kind:'doc'|'board'|'section',
//                                slug?, boardSlug?, label?, x, y, w, h, color } ],
//         edges: [ { id, from, to, direction:'one'|'both', note } ] }
//       kind:'doc'     — a fleeting-note card (slug)
//       kind:'board'   — a nested-board card (boardSlug; dangling allowed —
//                        the client renders it as missing)
//       kind:'section' — a board-local frame (label ≤120) drawn behind the
//                        cards; NEVER materialized, excluded from noteCount
//       kind:'sticky'  — LEGACY INPUT ONLY: cleanBoard still accepts it so the
//                        migration below can see it, but boards PERSIST doc-only
//                        (migrateStickyNodes converts each sticky into a real
//                        fleeting note on read and on save)
//       area ties a board to a My Life bucket (the hub counts these):
//       'projects' | 'key_elements' | 'topics' | 'goals' | 'habits' | null
//       edges connect two node ids on the SAME board. Edges whose BOTH
//       endpoints are doc nodes are MATERIALIZED into the notes' markdown as a
//       managed "## Connections" section (see materializeConnections below) —
//       regenerated from the union of doc-doc edges across ALL boards on every
//       board save, via readWorkbenchDoc/saveWorkbenchDoc (never fs directly).
//
// Same security posture as workbench.js: slug whitelist BEFORE any FS call,
// path.relative() jail, atomic temp→rename writes, strict shape validation
// with hard caps. Reads degrade calmly; writes are gated by the same flag +
// session + CSRF stack as the note editor (wired in server.js).
import fs from 'node:fs';
import path from 'node:path';
import {
  NOTES_DIR,
  createWorkbenchDoc,
  listWorkbenchDocs,
  readWorkbenchDoc,
  saveWorkbenchDoc,
} from './workbench.js';

const META_PATH = path.resolve(NOTES_DIR, '_meta.json');
const BOARDS_DIR = path.resolve(NOTES_DIR, '_boards');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const STATUSES = new Set(['capture', 'working', 'ready']);
const AREAS = new Set(['projects', 'key_elements', 'topics', 'goals', 'habits']);
// Sticky palette keys (the client maps them to design tokens). Free-form hex is
// rejected — color is a token name, never injected CSS.
const COLORS = new Set(['sun', 'moss', 'sky', 'plum', 'clay', 'paper']);

const MAX_BOARDS = 100;
const MAX_NODES = 500;
const MAX_STICKY_TEXT = 4000;
const MAX_NAME = 120;
const COORD_LIMIT = 200000;
const MAX_EDGES = 300;
const MAX_EDGE_NOTE = 2000;
// Same charset the client's node ids use (dash-stripped UUID slice).
const NODE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ---- atomic JSON write (temp → rename, same idiom as workbench.js) ----------
function writeJsonAtomic(absPath, value) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.fntmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, absPath);
}

function readJson(absPath) {
  try {
    const v = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ---- note meta ---------------------------------------------------------------
function readMeta() {
  return readJson(META_PATH) || {};
}

function cleanMetaEntry(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    if (raw.pinned === true) out.pinned = true;
    if (typeof raw.status === 'string' && STATUSES.has(raw.status)) out.status = raw.status;
    if (typeof raw.color === 'string' && COLORS.has(raw.color)) out.color = raw.color;
  }
  return out;
}

/** Merge a partial meta patch for one note slug. Returns the stored entry, or
 *  null on a bad slug / bad patch shape. */
export function patchNoteMeta(slug, patch) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const allowed = new Set(['pinned', 'status', 'color']);
  for (const k of Object.keys(patch)) {
    if (!allowed.has(k)) return null;
  }
  if ('pinned' in patch && typeof patch.pinned !== 'boolean') return null;
  if ('status' in patch && !(typeof patch.status === 'string' && STATUSES.has(patch.status))) return null;
  if ('color' in patch && patch.color !== null
      && !(typeof patch.color === 'string' && COLORS.has(patch.color))) return null;

  const meta = readMeta();
  const next = { ...cleanMetaEntry(meta[slug]) };
  if ('pinned' in patch) { if (patch.pinned) next.pinned = true; else delete next.pinned; }
  if ('status' in patch) { if (patch.status !== 'capture') next.status = patch.status; else delete next.status; }
  if ('color' in patch) { if (patch.color) next.color = patch.color; else delete next.color; }

  if (Object.keys(next).length === 0) delete meta[slug];
  else meta[slug] = next;
  writeJsonAtomic(META_PATH, meta);
  return { slug, pinned: !!next.pinned, status: next.status || 'capture', color: next.color || null };
}

/** Doc list (newest first) with meta merged in: pinned first, then by mtime. */
export function listNotes() {
  const docs = listWorkbenchDocs();
  if (docs === null) return null;
  const meta = readMeta();
  const rows = docs.map((d) => {
    const m = cleanMetaEntry(meta[d.slug]);
    return { ...d, pinned: !!m.pinned, status: m.status || 'capture', color: m.color || null };
  });
  rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.mtime - a.mtime));
  return rows;
}

// ---- boards --------------------------------------------------------------------
function containedBoardPath(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const abs = path.resolve(BOARDS_DIR, `${slug}.json`);
  const rel = path.relative(BOARDS_DIR, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function num(v, min, max, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Validate + clamp a client-supplied board document. Returns the clean board
 *  or null when the shape is hostile/unusable. */
export function cleanBoard(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, MAX_NAME) : 'Untitled board';
  const area = typeof raw.area === 'string' && AREAS.has(raw.area) ? raw.area : null;
  const nodesIn = Array.isArray(raw.nodes) ? raw.nodes.slice(0, MAX_NODES) : [];
  const nodes = [];
  const seen = new Set();
  for (const n of nodesIn) {
    if (n === null || typeof n !== 'object') continue;
    const id = typeof n.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(n.id) ? n.id : null;
    if (!id || seen.has(id)) continue;
    // 'sticky' is accepted as INPUT only (legacy boards / pass-through from an
    // old client) so migrateStickyNodes can convert it; unknown kinds fall back
    // to 'sticky' too (matching the pre-v2 behavior) and ride the same path.
    const kind = n.kind === 'doc' ? 'doc'
      : n.kind === 'board' ? 'board'
      : n.kind === 'section' ? 'section'
      : 'sticky';
    const node = {
      id,
      kind,
      x: num(n.x, -COORD_LIMIT, COORD_LIMIT),
      y: num(n.y, -COORD_LIMIT, COORD_LIMIT),
      w: num(n.w, 120, 1600, 260),
      h: num(n.h, 80, 1200, 180),
      color: typeof n.color === 'string' && COLORS.has(n.color) ? n.color : 'paper',
    };
    if (kind === 'doc') {
      if (typeof n.slug !== 'string' || !SLUG_RE.test(n.slug)) continue;
      node.slug = n.slug;
    } else if (kind === 'board') {
      // Must be SHAPED like a board slug; existence is NOT required (a deleted
      // target board leaves a dangling card the client renders as missing).
      if (typeof n.boardSlug !== 'string' || !SLUG_RE.test(n.boardSlug)) continue;
      node.boardSlug = n.boardSlug;
    } else if (kind === 'section') {
      node.label = typeof n.label === 'string' ? n.label.trim().slice(0, MAX_NAME) : '';
    } else {
      node.text = typeof n.text === 'string' ? n.text.slice(0, MAX_STICKY_TEXT) : '';
    }
    seen.add(id);
    nodes.push(node);
  }

  // Edges: id charset + dedupe, endpoints must reference existing node ids and
  // differ, direction enum (default 'one'), trimmed note ≤ MAX_EDGE_NOTE, hard
  // cap MAX_EDGES. Self-loops, dangling endpoints, and duplicate UNORDERED
  // pairs (keep first) are dropped silently — the board stays usable.
  const edgesIn = Array.isArray(raw.edges) ? raw.edges.slice(0, MAX_EDGES) : [];
  const edges = [];
  const seenEdgeIds = new Set();
  const seenPairs = new Set();
  for (const e of edgesIn) {
    if (e === null || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' && NODE_ID_RE.test(e.id) ? e.id : null;
    if (!id || seenEdgeIds.has(id)) continue;
    const from = typeof e.from === 'string' && seen.has(e.from) ? e.from : null;
    const to = typeof e.to === 'string' && seen.has(e.to) ? e.to : null;
    if (!from || !to || from === to) continue;
    const pair = from < to ? `${from} ${to}` : `${to} ${from}`;
    if (seenPairs.has(pair)) continue;
    seenEdgeIds.add(id);
    seenPairs.add(pair);
    edges.push({
      id,
      from,
      to,
      direction: e.direction === 'both' ? 'both' : 'one',
      note: typeof e.note === 'string' ? e.note.trim().slice(0, MAX_EDGE_NOTE) : '',
    });
  }

  return { name, area, nodes, edges };
}

// ---- legacy-sticky migration ---------------------------------------------------
// Whiteboard v2 is notes-only: every card is a fleeting-note doc card. Any
// kind:'sticky' node still found in a board document (legacy JSON, or an old
// client PUTting through) is migrated IN PLACE: its text becomes a real
// fleeting note (first non-empty line → title, full text → body, via the same
// jailed createWorkbenchDoc the editor uses; slug collision → timestamp
// suffix) and the node is rewritten to kind:'doc' with the new slug.
//
// Guarantees: IDEMPOTENT (doc/board/section nodes pass through untouched),
// NEVER THROWS (a per-node failure keeps that sticky as-is — it is retried on
// the next read/save), and respects the write gate: when
// WORKBENCH_WRITE_ENABLED is not '1' the migration is a no-op, so a read-only
// deployment never writes note files from a GET. Returns true when any node
// was migrated (the caller persists the rewritten board JSON).
function migrateStickyNodes(board) {
  if (!board || process.env.WORKBENCH_WRITE_ENABLED !== '1') return false;
  let changed = false;
  for (const node of board.nodes) {
    if (node.kind !== 'sticky') continue;
    try {
      const text = typeof node.text === 'string' ? node.text : '';
      const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      const baseTitle = firstLine.slice(0, MAX_NAME) || 'Untitled sticky';
      let created = createWorkbenchDoc(baseTitle, text);
      if (created.ok === 'bad-title' || created.ok === 'reserved' || created.ok === 'collision') {
        // One retry with a uniquifying suffix (timestamp keeps it readable).
        created = createWorkbenchDoc(`${baseTitle} ${Date.now()}`, text);
      }
      if (created.ok !== 'created') continue; // keep the sticky as-is
      node.kind = 'doc';
      node.slug = created.slug;
      delete node.text;
      changed = true;
    } catch (err) {
      // Note-create failure (I/O, jail refusal) — keep the sticky untouched.
      console.error('[fleeting migrate-sticky]', err.message);
    }
  }
  return changed;
}

export function listBoards() {
  if (!fs.existsSync(BOARDS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(BOARDS_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const slug = f.slice(0, -5);
    if (!SLUG_RE.test(slug)) continue;
    const board = cleanBoard(readJson(path.join(BOARDS_DIR, f)));
    if (!board) continue;
    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(path.join(BOARDS_DIR, f)).mtimeMs); } catch { /* listed anyway */ }
    // Sections are board-local chrome, never notes — excluded from the count.
    out.push({
      slug,
      name: board.name,
      area: board.area,
      noteCount: board.nodes.filter((n) => n.kind !== 'section').length,
      mtime,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function readBoard(slug) {
  const abs = containedBoardPath(slug);
  if (!abs) return { ok: 'bad' };
  if (!fs.existsSync(abs)) return { ok: 'missing' };
  const board = cleanBoard(readJson(abs));
  if (!board) return { ok: 'missing' };
  // Legacy-sticky migration on READ: convert + persist, best-effort. The read
  // itself never fails because of it (a failed persist just retries next time).
  try {
    if (migrateStickyNodes(board)) writeJsonAtomic(abs, board);
  } catch (err) {
    console.error('[fleeting migrate-sticky] persist failed:', err.message);
  }
  return { ok: 'found', slug, board };
}

/** Create a new board. Slug derived from the name (same derivation as docs). */
export function createBoard(name, area) {
  const base = String(name || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!base || !SLUG_RE.test(base)) return { ok: 'bad-name' };
  if (listBoards().length >= MAX_BOARDS) return { ok: 'too-many' };
  const abs = containedBoardPath(base);
  if (!abs) return { ok: 'bad-name' };
  if (fs.existsSync(abs)) return { ok: 'collision', slug: base };
  const board = cleanBoard({ name, area, nodes: [] });
  writeJsonAtomic(abs, board);
  return { ok: 'created', slug: base, board };
}

export function saveBoard(slug, raw) {
  const abs = containedBoardPath(slug);
  if (!abs) return { ok: 'bad' };
  if (!fs.existsSync(abs)) return { ok: 'missing' };
  const board = cleanBoard(raw);
  if (!board) return { ok: 'bad' };
  // Save-clean migration: an old client may still PUT sticky nodes; boards
  // PERSIST doc-only. Never throws; an unmigratable sticky is kept as-is.
  try {
    migrateStickyNodes(board);
  } catch (err) {
    console.error('[fleeting migrate-sticky] save-clean failed:', err.message);
  }
  // Capture the slugs the PREVIOUS revision linked, so removed edges clean up
  // their notes' Connections sections even when no current edge touches them.
  const prevSlugs = docEdgeSlugsOfBoard(cleanBoard(readJson(abs)));
  writeJsonAtomic(abs, board);
  const materialize = materializeConnections(prevSlugs);
  return { ok: 'saved', slug, board, materialize };
}

export function deleteBoard(slug) {
  const abs = containedBoardPath(slug);
  if (!abs) return { ok: 'bad' };
  if (!fs.existsSync(abs)) return { ok: 'missing' };
  const prevSlugs = docEdgeSlugsOfBoard(cleanBoard(readJson(abs)));
  fs.unlinkSync(abs); // boards are cockpit layout state, not vault content
  // Deleting a board deletes its edges — their materialized sections must
  // clean up too. Best-effort; deletion itself already succeeded.
  if (prevSlugs.size > 0) materializeConnections(prevSlugs);
  return { ok: 'deleted', slug };
}

// ---- wikilink materialization --------------------------------------------------
// Edges whose BOTH endpoints are doc nodes become a MANAGED "## Connections"
// section in each involved note's markdown:
//
//   ## Connections
//
//   - → [[target-slug]] — connection note     (one-way, in the FROM note)
//   - ← [[source-slug]] — connection note     (one-way, in the TO note)
//   - ↔ [[other-slug]] — connection note      (direction 'both', in BOTH notes)
//
// The " — note" tail is omitted when the note is empty. The section is fully
// REGENERATED from the union of doc-doc edges across ALL boards each time any
// board is saved (the board JSON is the source of truth; the section is a
// projection — never parsed back). Notes are touched ONLY through
// readWorkbenchDoc/saveWorkbenchDoc (jailed, atomic, audited); baseMtime is
// omitted deliberately (last-write-wins — the projection is regenerable).
// The heading + blank line + plain bullets are CANONICAL editor markdown, so
// the outliner's round-trip (workbenchMarkdown.ts) preserves the section
// byte-for-byte and the editor and the materializer never fight.

const CONNECTIONS_HEADING_RE = /^##\s+Connections\s*$/;

/** Doc slugs referenced by a board's doc-doc edges (cleanup candidates). */
function docEdgeSlugsOfBoard(board) {
  const out = new Set();
  if (!board) return out;
  const docByNodeId = new Map();
  for (const n of board.nodes) if (n.kind === 'doc') docByNodeId.set(n.id, n.slug);
  for (const e of board.edges) {
    const a = docByNodeId.get(e.from);
    const b = docByNodeId.get(e.to);
    if (!a || !b || a === b) continue; // sticky endpoint or self-link via two cards
    out.add(a);
    out.add(b);
  }
  return out;
}

/** The full desired line set per note slug, from the union of doc-doc edges
 *  across ALL boards. Returns Map<slug, string[]> (deduped, deterministic). */
function collectDesiredLines() {
  // slug -> Map<line, sortKey> (Map keys dedupe identical lines across boards)
  const perNote = new Map();
  const add = (slug, arrow, target, note) => {
    const tail = note ? ` — ${note.replace(/\s*[\r\n]+\s*/g, ' ')}` : '';
    const line = `- ${arrow} [[${target}]]${tail}`;
    if (!perNote.has(slug)) perNote.set(slug, new Map());
    perNote.get(slug).set(line, `${target} ${arrow} ${note}`);
  };
  for (const { slug } of listBoards()) {
    const r = readBoard(slug);
    if (r.ok !== 'found') continue;
    const docByNodeId = new Map();
    for (const n of r.board.nodes) if (n.kind === 'doc') docByNodeId.set(n.id, n.slug);
    for (const e of r.board.edges) {
      const a = docByNodeId.get(e.from);
      const b = docByNodeId.get(e.to);
      if (!a || !b || a === b) continue;
      if (e.direction === 'both') {
        add(a, '↔', b, e.note);
        add(b, '↔', a, e.note);
      } else {
        add(a, '→', b, e.note);
        add(b, '←', a, e.note);
      }
    }
  }
  const out = new Map();
  for (const [slug, lines] of perNote) {
    const sorted = [...lines.entries()]
      .sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
      .map(([line]) => line);
    out.set(slug, sorted);
  }
  return out;
}

/** Replace / append / remove the managed "## Connections" section in one
 *  note's markdown. Everything outside the section is preserved byte-for-byte
 *  (the section spans its heading to the next `## ` heading or EOF). Returns
 *  the new markdown, or null when nothing changes. */
function applyConnectionsSection(markdown, lines) {
  const rows = markdown.split('\n');
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    if (CONNECTIONS_HEADING_RE.test(rows[i])) { start = i; break; }
  }

  if (start === -1) {
    if (lines.length === 0) return null; // nothing to add, nothing to remove
    // Append at end of file: one blank line of separation, canonical shape,
    // trailing newline.
    let base = markdown;
    if (base !== '' && !base.endsWith('\n')) base += '\n';
    if (base !== '' && !base.endsWith('\n\n')) base += '\n';
    const next = `${base}## Connections\n\n${lines.join('\n')}\n`;
    return next === markdown ? null : next;
  }

  // The section runs from its heading to the next `## ` heading or EOF.
  let end = rows.length;
  for (let i = start + 1; i < rows.length; i++) {
    if (/^##\s/.test(rows[i])) { end = i; break; }
  }

  let replacement;
  if (lines.length === 0) {
    replacement = [];
    // Swallow ONE preceding blank line so removal doesn't leave a double blank
    // (or a trailing blank when the section sat at EOF).
    if (start > 0 && rows[start - 1].trim() === '') start -= 1;
  } else {
    // Canonical shape: heading, blank, bullets — plus one trailing blank as
    // separator (when followed by another section) or the file's final
    // newline (split/join: a trailing '' re-creates the trailing '\n').
    replacement = ['## Connections', '', ...lines, ''];
  }

  const next = [...rows.slice(0, start), ...replacement, ...rows.slice(end)].join('\n');
  return next === markdown ? null : next;
}

/** Regenerate the Connections section of every candidate note. Never throws —
 *  per-note failures are collected and reported. */
function materializeConnections(extraCandidateSlugs) {
  const updated = [];
  const failed = [];
  try {
    const desired = collectDesiredLines();
    const candidates = new Set([...desired.keys(), ...(extraCandidateSlugs || [])]);
    for (const slug of candidates) {
      const lines = desired.get(slug) || [];
      try {
        const doc = readWorkbenchDoc(slug);
        if (typeof doc.markdown !== 'string') {
          // Note missing/renamed/deleted. Nothing to clean up; only a problem
          // when there ARE lines that want a home.
          if (lines.length > 0) failed.push(slug);
          continue;
        }
        const next = applyConnectionsSection(doc.markdown, lines);
        if (next === null) continue; // section already correct — don't touch
        const res = saveWorkbenchDoc(slug, next); // no baseMtime: last-write-wins
        if (res.ok === 'saved') updated.push(slug);
        else failed.push(slug);
      } catch (err) {
        console.error(`[fleeting materialize] ${slug}:`, err.message);
        failed.push(slug);
      }
    }
  } catch (err) {
    console.error('[fleeting materialize] sweep failed:', err.message);
  }
  return { updated, failed };
}
