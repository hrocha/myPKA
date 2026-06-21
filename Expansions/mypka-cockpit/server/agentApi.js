// agentApi.js — the "My AI Team" member-detail read surface (DATA-CONTRACT §16).
//
// Three read-only endpoints, all SELECT against the read-only mypka.db handle
// (db.js opens readonly + query_only). Markdown stays canonical; this file
// never writes. They ride the cockpit's standard `safe(handler)` envelope, so
// they inherit the SAME loopback/PIN/CSRF read-gate as every other /api/cockpit
// route (the global /api auth middleware in server.js gates them; this module
// adds no new auth surface).
//
//   GET /api/cockpit/agent/:slug              -> { found, agent }
//       the contract body (AGENTS.md markdown), its frontmatter (as an object),
//       and the roster meta (role/status/owner/folder/avatar).
//   GET /api/cockpit/agent/:slug/journal      -> { available, entries }
//       the agent's durable-insight journal feed, newest-first (date + title +
//       snippet + full body). available:false when the agent_journal table is
//       absent on a leaner mirror.
//   GET /api/cockpit/agent/:slug/connections  -> { outbound, inbound }
//       the AGENTS.md [[wikilinks]] as outbound edges (source_table='agents')
//       and the notes/agents that link AT this agent. Entity targets carry a
//       navigable {type,slug}; SOP/WS/GL/unresolved targets are label chips.
//
// SCHEMA RESILIENCE (deliberate). §16 widens `agents` with contract_body /
// contract_frontmatter and adds the agent_journal table — but a mirror produced
// by an OLDER regen may carry neither (e.g. an `agents.body` column instead of
// `contract_body`, and no agent_journal at all). Every read below PROBES the
// live schema once at module load and degrades to an honest empty/absent state
// rather than throwing a prepare() error. This is the same posture journalFeed
// / graph take.
import db from './db.js';
import { ENTITY_SET, TYPE_LABELS } from './cockpit.js';

// ---------------------------------------------------------------------------
// One-time live-schema probes (mirrors graph.js's PRAGMA-at-load approach).
// ---------------------------------------------------------------------------
function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name);
}
function columnsOf(table) {
  if (!tableExists(table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

const AGENT_COLS = columnsOf('agents');
// §16 contract body column, with a graceful fallback to the legacy `body` column
// some older mirrors use for the AGENTS.md body.
const BODY_COL = AGENT_COLS.has('contract_body')
  ? 'contract_body'
  : AGENT_COLS.has('body')
    ? 'body'
    : null;
const FM_COL = AGENT_COLS.has('contract_frontmatter')
  ? 'contract_frontmatter'
  : AGENT_COLS.has('raw_frontmatter')
    ? 'raw_frontmatter'
    : null;
const HAS_FOLDER = AGENT_COLS.has('folder');
const HAS_BIO = AGENT_COLS.has('bio');
const HAS_AVATAR = AGENT_COLS.has('avatar_path');
const HAS_OWNER = AGENT_COLS.has('owner');
const HAS_STATUS = AGENT_COLS.has('agent_status');

const HAS_JOURNAL = tableExists('agent_journal');
const HAS_LINKS = tableExists('links');

// ---------------------------------------------------------------------------
// (a) contract body + meta. Built once; only SELECTs the columns the live
// schema actually has (a missing column is selected as NULL so the row shape is
// stable for the shaper).
// ---------------------------------------------------------------------------
const agentStmt = db.prepare(`
  SELECT slug, name,
         ${HAS_FOLDER ? 'folder' : 'NULL AS folder'},
         ${HAS_STATUS ? 'agent_status' : `'active' AS agent_status`},
         ${HAS_BIO ? 'bio' : 'NULL AS bio'},
         ${HAS_AVATAR ? 'avatar_path' : 'NULL AS avatar_path'},
         ${HAS_OWNER ? 'owner' : 'NULL AS owner'},
         ${BODY_COL ? `${BODY_COL} AS contract_body` : 'NULL AS contract_body'},
         ${FM_COL ? `${FM_COL} AS contract_frontmatter` : `'{}' AS contract_frontmatter`}
  FROM agents
  WHERE slug = ?
  LIMIT 1
`);

// Strip a leading YAML frontmatter block if the body column still carries one
// (defensive: §16 says the body is frontmatter-stripped, but a legacy `body`
// column may not be). Only strips a `---`-fenced block at the very top.
function stripLeadingFrontmatter(md) {
  if (typeof md !== 'string') return '';
  const m = md.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

// Parse the frontmatter JSON-object string into a plain object; '{}' / NULL /
// malformed all degrade to {}.
function parseFrontmatter(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function readAgent(slug) {
  const row = agentStmt.get(slug);
  if (!row) return { found: false, slug };
  return {
    found: true,
    agent: {
      slug: row.slug,
      name: row.name || row.slug,
      folder: row.folder || null,
      agentStatus: row.agent_status || null,
      bio: row.bio || null,
      avatarPath: row.avatar_path || null,
      owner: row.owner || null,
      contractBody: stripLeadingFrontmatter(row.contract_body || ''),
      frontmatter: parseFrontmatter(row.contract_frontmatter),
    },
  };
}

// ---------------------------------------------------------------------------
// (b) the journal feed, newest-first (§16.1 query b). EXCERPT_CHARS-trimmed
// snippet, same light markdown strip as journalFeed.js so the teaser reads as
// prose; the full body rides along for in-place unfold via WikiMarkdown.
// ---------------------------------------------------------------------------
const EXCERPT_CHARS = 360;

const journalStmt = HAS_JOURNAL
  ? db.prepare(`
      SELECT slug, title, topic, created, updated, status, tags, body, file_path
      FROM agent_journal
      WHERE agent_slug = ?
      ORDER BY created DESC, title ASC
    `)
  : null;

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

function excerptOf(text, n = EXCERPT_CHARS) {
  if (text.length <= n) return text;
  let cut = text.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > n * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

function parseTags(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function readJournal(slug) {
  if (!journalStmt) return { available: false, entries: [] };
  const rows = journalStmt.all(slug);
  const entries = rows.map((r) => {
    const body = r.body || '';
    return {
      slug: r.slug,
      title: r.title || r.slug,
      topic: r.topic || null,
      created: r.created || null,
      updated: r.updated || null,
      status: r.status || null,
      tags: parseTags(r.tags),
      excerpt: excerptOf(stripMarkdownLight(body)),
      body,
      contentLength: body.length,
    };
  });
  return { available: true, entries };
}

// ---------------------------------------------------------------------------
// (c) the connections (§16.1 queries c + c-optional). Outbound = the AGENTS.md
// [[wikilinks]] (source_table='agents'); inbound = notes/agents linking AT this
// agent. An outbound target that resolves to one of the mirrored entity tables
// carries a navigable {type,slug}; SOP/WS/GL/other/unresolved targets are label
// chips keyed by target_slug / target_raw (§16). Self-edges dropped.
// ---------------------------------------------------------------------------
const outboundStmt = HAS_LINKS
  ? db.prepare(`
      SELECT DISTINCT target_slug, target_raw, target_table, link_type
      FROM links
      WHERE source_table = 'agents' AND source_slug = ?
      ORDER BY target_table IS NULL, target_table, target_slug
    `)
  : null;

const inboundStmt = HAS_LINKS
  ? db.prepare(`
      SELECT DISTINCT source_table, source_slug, link_type
      FROM links
      WHERE target_slug = ? AND target_table = 'agents'
      ORDER BY source_table, source_slug
    `)
  : null;

// A chip's display label. The raw [[target]] text's last path segment is usually
// the most readable (e.g. `SOP-002-convert-…`), EXCEPT for the team's own
// `Team/<Name> - <Role>/AGENTS` links, whose last segment is the generic
// "AGENTS" — there the slug (the agent's name) reads far better. We also reject
// any bare "AGENTS" / "AGENTS.md" last segment and fall back to the slug.
function labelFor(slug, raw) {
  if (raw && typeof raw === 'string' && raw.trim()) {
    const last = raw.split('/').pop().trim().replace(/\.md$/i, '');
    if (last && !/^agents$/i.test(last)) return last;
  }
  if (!slug) return 'link';
  return slug;
}

function readConnections(slug) {
  if (!outboundStmt || !inboundStmt) return { outbound: [], inbound: [] };

  const outbound = [];
  for (const r of outboundStmt.all(slug)) {
    if (!r.target_slug) continue;
    if (r.target_table === 'agents' && r.target_slug === slug) continue; // self
    const isEntity = !!(r.target_table && ENTITY_SET.has(r.target_table) && r.target_slug);
    outbound.push({
      slug: r.target_slug,
      label: labelFor(r.target_slug, r.target_raw),
      // navigable entity target -> {type, typeLabel}; else null (label chip).
      type: isEntity ? r.target_table : null,
      typeLabel: isEntity ? TYPE_LABELS[r.target_table] || r.target_table : null,
      // agents resolve to other team members (not an entity table, but navigable
      // in the team view); flag them so the client can route to the member.
      isAgent: r.target_table === 'agents',
      linkType: r.link_type === 'embed' ? 'embed' : 'wikilink',
    });
  }

  const inbound = [];
  for (const r of inboundStmt.all(slug)) {
    if (r.source_table === 'agents' && r.source_slug === slug) continue; // self
    const isEntity = !!(r.source_table && ENTITY_SET.has(r.source_table) && r.source_slug);
    inbound.push({
      slug: r.source_slug,
      label: r.source_slug,
      type: isEntity ? r.source_table : null,
      typeLabel: isEntity ? TYPE_LABELS[r.source_table] || r.source_table : null,
      isAgent: r.source_table === 'agents',
      linkType: r.link_type === 'embed' ? 'embed' : 'wikilink',
    });
  }

  return { outbound, inbound };
}

// ---------------------------------------------------------------------------
// Route registration — server.js calls registerAgentRoutes(app, { safe }).
// :slug is matched as a single path segment; it is a parameterised SELECT bind
// (never string-concatenated), so a hostile slug cannot inject. An unknown slug
// yields { found:false } (200), matching the note route's calm contract.
// ---------------------------------------------------------------------------
export function registerAgentRoutes(app, { safe }) {
  app.get('/api/cockpit/agent/:slug', safe((req) => readAgent(req.params.slug)));
  app.get('/api/cockpit/agent/:slug/journal', safe((req) => readJournal(req.params.slug)));
  app.get('/api/cockpit/agent/:slug/connections', safe((req) => readConnections(req.params.slug)));
}

export { readAgent, readJournal, readConnections };
