// graph.js — the cockpit knowledge-graph neighborhood layer (read-only).
//
// Implements Silas's Mode-A contract for the mini-graph:
//   GET /api/cockpit/graph/neighborhood/:type/:slug?depth=2&cap=12
//   -> a focus note's 2-hop neighborhood as a {focus, nodes, edges, stats} graph.
//
// Read-only against mypka.db; no writes, no schema changes. Every statement is a
// SELECT. Reuses cockpit.js's ENTITY map / TYPE_LABELS / ENTITY_SET so the title
// column is resolved correctly per type (people->full_name, journal/documents/
// deliverables->title, everything else->name) — hardcoding `name` would return
// nulls for half the tables.
import db from './db.js';
import { ENTITY, TYPE_LABELS, ENTITY_SET, ENTITY_TABLES } from './cockpit.js';

// Renderable nodes = ONLY the 10 entity tables. Every edge is filtered so a
// non-entity source/target (agents, sops, guidelines, workstreams, news, media,
// raw_inputs, session_logs, claude_* …) is dropped — the same gate as cockpit.js's
// `clickable` rule, applied to BOTH endpoints of every edge.
//
// Per-table guards. `tags` exists on every entity table EXCEPT deliverables;
// `entry_date` exists only on journal. We probe the live schema once at module
// load so a future schema change can't silently break the SELECT.
const HAS_TAGS = new Set();
const HAS_ENTRY_DATE = new Set();
for (const t of ENTITY_TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (cols.includes('tags')) HAS_TAGS.add(t);
  if (cols.includes('entry_date')) HAS_ENTRY_DATE.add(t);
}

function parseTags(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-type fetch of the renderable node fields: title (per-table column),
// subtitle (best-effort), tags (JSON-array TEXT, deliverables has none),
// entry_date (journal only, used for the Gen-2 cap tiebreak), and id (the
// numeric rowid, used as the final cap tiebreak). One prepared statement per
// table, built once. NULL columns stay NULL — honest signals, never coerced.
// ---------------------------------------------------------------------------
const nodeRowStmt = {};
for (const t of ENTITY_TABLES) {
  const m = ENTITY[t];
  const sub = m.sub ? m.sub : 'NULL';
  const tags = HAS_TAGS.has(t) ? 'tags' : 'NULL AS tags';
  const entryDate = HAS_ENTRY_DATE.has(t) ? 'entry_date' : 'NULL AS entry_date';
  nodeRowStmt[t] = db.prepare(
    `SELECT id, slug, ${m.title} AS title, ${sub} AS subtitle, ${tags}, ${entryDate}
     FROM ${t} WHERE slug = ? LIMIT 1`
  );
}

export function fetchNodeRow(type, slug) {
  const stmt = nodeRowStmt[type];
  if (!stmt) return null;
  return stmt.get(slug) || null;
}

// ---------------------------------------------------------------------------
// Outbound edges FROM a note: reuse cockpit.js's outbound shape (idx_links_source).
// Backlink node sources INTO a note: a collision-safe DISTINCT pull on
// idx_links_target (Silas verified both index-served). target_table is NOT carried
// on the backlink statement — backlinks point AT us, and the source IS the node.
// ---------------------------------------------------------------------------
const outboundStmt = db.prepare(
  `SELECT DISTINCT target_raw, target_slug, target_table, link_type
   FROM links
   WHERE source_table = ? AND source_slug = ?
   ORDER BY link_type, target_raw`
);

const backlinkNodesStmt = db.prepare(
  `SELECT DISTINCT source_table, source_slug, link_type
   FROM links WHERE target_slug = ? ORDER BY source_table, source_slug`
);

// ---------------------------------------------------------------------------
// Neighbors of ONE node, as {type, slug, direction, linkType} candidates,
// entity-filtered on BOTH endpoints. Dangling outbound links (target_table NULL,
// or a non-entity target) are reported via the danglingOut counter, never become
// nodes. Self-edges are dropped.
// ---------------------------------------------------------------------------
function neighborsOf(type, slug) {
  const out = [];
  let danglingOut = 0;

  // direction 'out' — links FROM this node.
  for (const r of outboundStmt.all(type, slug)) {
    const ok = !!(r.target_table && ENTITY_SET.has(r.target_table) && r.target_slug);
    if (!ok) {
      // target_table NULL (unresolved) or a non-entity table (session_logs, news,
      // agents…) — a dangling link, counted, never a node.
      danglingOut += 1;
      continue;
    }
    if (r.target_table === type && r.target_slug === slug) continue; // self
    out.push({
      type: r.target_table,
      slug: r.target_slug,
      direction: 'out',
      linkType: r.link_type === 'embed' ? 'embed' : 'wikilink',
    });
  }

  // direction 'back' — links INTO this node. The source IS the candidate node.
  for (const r of backlinkNodesStmt.all(slug)) {
    if (!ENTITY_SET.has(r.source_table)) continue; // non-entity backlink source dropped
    if (r.source_table === type && r.source_slug === slug) continue; // self
    out.push({
      type: r.source_table,
      slug: r.source_slug,
      direction: 'back',
      linkType: r.link_type === 'embed' ? 'embed' : 'wikilink',
    });
  }

  return { neighbors: out, danglingOut };
}

// ---------------------------------------------------------------------------
// Batched degree (Silas: both covering-index served).
//   inDegree:  COUNT links WHERE target_slug IN (...)            GROUP BY target_slug
//   outDegree: COUNT links WHERE source_slug IN (...)            GROUP BY source_table, source_slug
// inDegree keys on slug (target_table is unreliable / NULL on the links row); a
// slug collision (7 exist) over-counts inDegree slightly — acceptable for a sizing
// signal and matches the index shape. outDegree keys on (table, slug) — exact.
// IN-lists are built from collected slugs with positional placeholders.
// ---------------------------------------------------------------------------
export function batchedDegree(nodes) {
  const inDeg = new Map(); // slug -> count
  const outDeg = new Map(); // `${table}/${slug}` -> count
  if (nodes.length === 0) return { inDeg, outDeg };

  const slugs = [...new Set(nodes.map((n) => n.slug))];
  const ph = slugs.map(() => '?').join(',');

  for (const r of db
    .prepare(`SELECT target_slug AS slug, COUNT(*) AS c FROM links WHERE target_slug IN (${ph}) GROUP BY target_slug`)
    .all(...slugs)) {
    inDeg.set(r.slug, r.c);
  }
  for (const r of db
    .prepare(
      `SELECT source_table AS t, source_slug AS slug, COUNT(*) AS c
       FROM links WHERE source_slug IN (${ph}) GROUP BY source_table, source_slug`
    )
    .all(...slugs)) {
    outDeg.set(`${r.t}/${r.slug}`, r.c);
  }
  return { inDeg, outDeg };
}

// ---------------------------------------------------------------------------
// The neighborhood walk.
//   Gen-0: the focus note.
//   Gen-1: focus's entity neighbors (out + back), deduped to type/slug.
//   Gen-2: each Gen-1 node's neighbors, minus anything in Gen-0/1, capped per
//          Gen-1 node (default 12) ranked degree DESC, journal entry_date DESC,
//          id DESC. Overflow -> stats.capped[gen1Id] = N.
// Edges are collected for every traversed relation (entity-filtered) and deduped
// on `${source}->${target}:${linkType}` regardless of gen.
// ---------------------------------------------------------------------------
export function getNeighborhood(type, slug, { depth = 2, cap = 12 } = {}) {
  // Agent focus (§16, 2026-06). `agents` is NOT one of the 10 entity tables, so
  // the entity-only walk below can't render it. Delegate to the agent-focused
  // builder, which produces the SAME { focus, nodes, edges, stats } shape so the
  // ONE MiniGraph / MiniGraphCanvas renders it unchanged (no second graph).
  if (type === 'agents') return getAgentNeighborhood(slug, { cap });
  if (!ENTITY_SET.has(type)) return { found: false, type, slug };
  const focusRow = fetchNodeRow(type, slug);
  if (!focusRow) return { found: false, type, slug };

  const nodeId = (t, s) => `${t}/${s}`;
  const focusId = nodeId(type, slug);

  // node-id -> assembled node record (without degree, filled at the end).
  const nodes = new Map();
  const addNode = (t, s, gen, row) => {
    const id = nodeId(t, s);
    if (nodes.has(id)) return nodes.get(id);
    const rec = {
      id,
      type: t,
      typeLabel: TYPE_LABELS[t] || t,
      slug: s,
      title: (row && row.title) || s,
      subtitle: (row && row.subtitle) || null,
      tags: row ? parseTags(row.tags) : [],
      gen,
      _entryDate: row ? row.entry_date || null : null,
      _id: row ? row.id : 0,
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      clickable: true,
    };
    nodes.set(id, rec);
    return rec;
  };

  // edge dedupe.
  const edgeSeen = new Set();
  const edges = [];
  const addEdge = (source, target, direction, linkType) => {
    const key = `${source}->${target}:${linkType}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ id: key, source, target, direction, linkType });
  };

  const stats = { gen1: 0, gen2: 0, capped: {}, dangling: 0 };

  // --- Gen-0 ---------------------------------------------------------------
  addNode(type, slug, 0, focusRow);

  // --- Gen-1 ---------------------------------------------------------------
  const { neighbors: g1raw, danglingOut: g1dangling } = neighborsOf(type, slug);
  stats.dangling += g1dangling;

  const gen1Ids = [];
  for (const nb of g1raw) {
    const id = nodeId(nb.type, nb.slug);
    // Edge orientation: an 'out' link is focus->neighbor; a 'back' link is
    // neighbor->focus. direction is preserved verbatim for the renderer.
    if (nb.direction === 'out') addEdge(focusId, id, 'out', nb.linkType);
    else addEdge(id, focusId, 'back', nb.linkType);

    if (id === focusId) continue;
    if (!nodes.has(id)) {
      const row = fetchNodeRow(nb.type, nb.slug);
      // A link can point at a slug with no live row (e.g. a renamed note). It is
      // not a dangling *link* (the link resolved a table) but there is no node to
      // render — skip it and count it as dangling.
      if (!row) {
        stats.dangling += 1;
        continue;
      }
      addNode(nb.type, nb.slug, 1, row);
      gen1Ids.push(id);
    }
  }
  stats.gen1 = gen1Ids.length;

  // --- Gen-2 ---------------------------------------------------------------
  if (depth >= 2) {
    for (const g1id of gen1Ids) {
      const g1 = nodes.get(g1id);
      const { neighbors: g2raw, danglingOut } = neighborsOf(g1.type, g1.slug);
      stats.dangling += danglingOut;

      // Candidate Gen-2 nodes: new relative to Gen-0/1 AND new within this Gen-1's
      // own batch. We still record EVERY edge (even to an already-placed node), so
      // a Gen-1<->Gen-1 cross-link is drawn. Cap applies only to NEW Gen-2 nodes.
      const candidates = [];
      const candSeen = new Set();
      for (const nb of g2raw) {
        const id = nodeId(nb.type, nb.slug);
        if (nb.direction === 'out') addEdge(g1id, id, 'out', nb.linkType);
        else addEdge(id, g1id, 'back', nb.linkType);

        if (nodes.has(id)) continue;        // already Gen-0/1/earlier-Gen-2
        if (candSeen.has(id)) continue;     // dedup within this Gen-1's candidates
        const row = fetchNodeRow(nb.type, nb.slug);
        if (!row) { stats.dangling += 1; continue; }
        candSeen.add(id);
        candidates.push({ nb, id, row });
      }

      // Rank candidates: degree DESC, journal entry_date DESC (NULLs last),
      // id DESC. degree here uses the row's own batched degree — but we don't have
      // it yet (degree is computed at the end over the final node set). For the cap
      // ranking we need a per-candidate degree NOW, so we compute it for the
      // candidate slugs in one batched pass.
      const { inDeg, outDeg } = batchedDegree(candidates.map((c) => ({ slug: c.nb.slug })));
      const degOf = (c) =>
        (inDeg.get(c.nb.slug) || 0) + (outDeg.get(`${c.nb.type}/${c.nb.slug}`) || 0);
      // attach for sort
      for (const c of candidates) c._deg = degOf({ nb: c.nb });
      candidates.sort((a, b) => {
        if (b._deg !== a._deg) return b._deg - a._deg;
        const ad = a.row.entry_date || '';
        const bd = b.row.entry_date || '';
        if (bd !== ad) return bd < ad ? -1 : 1; // entry_date DESC, '' (null) last
        return (b.row.id || 0) - (a.row.id || 0); // id DESC
      });

      const keep = candidates.slice(0, cap);
      const overflow = candidates.length - keep.length;
      if (overflow > 0) stats.capped[g1id] = overflow;

      for (const c of keep) {
        addNode(c.nb.type, c.nb.slug, 2, c.row);
      }
    }
    stats.gen2 = [...nodes.values()].filter((n) => n.gen === 2).length;
  }

  // --- Degree over the FINAL node set (Silas: degree = inDegree + outDegree) --
  const allNodes = [...nodes.values()];
  const { inDeg, outDeg } = batchedDegree(allNodes);
  for (const n of allNodes) {
    n.inDegree = inDeg.get(n.slug) || 0;
    n.outDegree = outDeg.get(`${n.type}/${n.slug}`) || 0;
    n.degree = n.inDegree + n.outDegree;
  }

  // Strip the cap-only scratch fields before returning the public shape.
  const publicNodes = allNodes.map(({ _entryDate, _id, _deg, ...rest }) => rest);

  const focus = {
    id: focusId,
    type,
    slug,
    title: focusRow.title || slug,
    typeLabel: TYPE_LABELS[type] || type,
  };

  return { focus, nodes: publicNodes, edges, stats };
}

// ===========================================================================
// AGENT FOCUS (§16, 2026-06). `agents` is not an entity table, so the entity-only
// walk above can't center on it. This builder produces the SAME public shape
// ({ focus, nodes, edges, stats }) for an agent focus, so the ONE MiniGraph /
// MiniGraphCanvas renders it without a second graph.
//
// What's renderable here is WIDER than the note graph: an agent's links are
// overwhelmingly Team-Knowledge (SOPs, Workstreams, Guidelines) and sibling
// AGENTS — almost none are entity tables. Dropping all of those (the note-graph
// rule) would leave a near-empty canvas, which is exactly the failure Tom hit
// with the chip list. So this builder renders FOUR node kinds beyond the 10
// entity tables — agents, sops, workstreams, guidelines — and marks each
// node `clickable` HONESTLY by whether the cockpit has a view for it:
//   - entity targets  -> clickable (→ #/note/:type/:slug)
//   - sibling agents  -> clickable (→ the team roster member)
//   - sops/ws/gl      -> NOT clickable (no cockpit route yet); degrades to a
//                        non-navigable node with its resolved title as a tooltip.
//
// Every node is Gen-1 (the agent's direct connections). No Gen-2 walk — an agent
// links to ~1000 rows in the demo, and a 2-hop expansion off a hub agent would
// be illegible. Per-kind caps keep the canvas readable; overflow is surfaced via
// the same stats.capped "+N more" affordance the note graph uses.
// ---------------------------------------------------------------------------

// Title-column map for the Team-Knowledge tables an agent links to. Each is a
// fixed allow-list key (never attacker-controlled), so the interpolated table /
// column identifiers are safe. NULL row / empty title falls back to the slug.
const TK_TITLE = {
  sops: 'title',
  workstreams: 'title',
  guidelines: 'title',
};
const tkTitleStmt = {};
for (const t of Object.keys(TK_TITLE)) {
  try {
    db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); // probe existence
    tkTitleStmt[t] = db.prepare(`SELECT ${TK_TITLE[t]} AS title FROM ${t} WHERE slug = ? LIMIT 1`);
  } catch {
    tkTitleStmt[t] = null;
  }
}
function tkTitle(table, slug) {
  const stmt = tkTitleStmt[table];
  if (!stmt || !slug) return null;
  const row = stmt.get(slug);
  const t = row && typeof row.title === 'string' ? row.title.trim() : '';
  return t || null;
}

// Display labels for the non-entity node kinds an agent graph renders.
const AGENT_TYPE_LABELS = {
  agents: 'Specialist',
  sops: 'SOP',
  workstreams: 'Workstream',
  guidelines: 'Guideline',
};
function typeLabelFor(table) {
  return TYPE_LABELS[table] || AGENT_TYPE_LABELS[table] || table;
}

// The set of node kinds the agent graph renders (entities + TK + agents). A link
// whose endpoint is outside this set (navigation, news, session_logs, raw_inputs,
// an unresolved NULL table…) is dropped and counted as dangling, exactly like the
// note graph drops non-entity edges.
const AGENT_RENDERABLE = new Set([
  ...ENTITY_TABLES,
  'agents',
  'sops',
  'workstreams',
  'guidelines',
]);

// A node is clickable (has a cockpit view) when it's an entity table (→ #/note)
// or another agent (→ the roster member). SOP/WS/GL have no route yet → not
// clickable; the canvas renders them with a tooltip and a "not navigable" a11y
// hint (the same `clickable:false` path the note graph already supports).
function agentNodeClickable(table) {
  return ENTITY_SET.has(table) || table === 'agents';
}

// Resolve a node's display title per kind: entity tables via fetchNodeRow (the
// per-table title column), TK tables via tkTitle, agents via the agents.name
// (full "Name - Role"); falls back to the slug.
const agentNameStmt = db.prepare('SELECT name FROM agents WHERE slug = ? LIMIT 1');
function agentDisplayName(slug) {
  const row = agentNameStmt.get(slug);
  if (!row || typeof row.name !== 'string') return slug;
  // The roster splits "Name - Role" on " - "; the graph node shows just the name.
  const idx = row.name.indexOf(' - ');
  return idx === -1 ? row.name : row.name.slice(0, idx);
}
function nodeTitleFor(table, slug) {
  if (table === 'agents') return agentDisplayName(slug);
  if (ENTITY_SET.has(table)) {
    const r = fetchNodeRow(table, slug);
    return (r && r.title) || slug;
  }
  if (table in TK_TITLE) return tkTitle(table, slug) || slug;
  return slug;
}

// The agent→agent OUTBOUND quirk: those rows carry target_slug === the SOURCE
// slug (a self-pointer) and the REAL sibling in target_raw (e.g. "Pax -
// Researcher/AGENTS"). Resolve the sibling's true slug from target_raw's first
// path segment's first name, matched against the live agents table. INBOUND
// agent links are correct (source_slug IS the sibling), so they skip this.
const agentSlugByName = new Map(); // lowercased first name -> slug
for (const r of db.prepare('SELECT slug, name FROM agents').all()) {
  if (typeof r.name === 'string') {
    const first = r.name.split(/[\s-]/)[0].trim().toLowerCase();
    if (first) agentSlugByName.set(first, r.slug);
  }
  // The slug itself is usually the lowercased first name — index it too.
  if (r.slug) agentSlugByName.set(String(r.slug).toLowerCase(), r.slug);
}
function siblingSlugFromRaw(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // "Pax - Researcher/AGENTS" -> "pax"; "Team/Felix - …/AGENTS" -> "felix".
  const seg = raw.split('/').filter(Boolean);
  const namePart = seg.length >= 2 ? seg[seg.length - 2] : seg[0] || raw;
  const first = namePart.split(/[\s-]/)[0].trim().toLowerCase();
  return agentSlugByName.get(first) || null;
}

// Per-kind cap for the agent graph (entity targets are rare and high-signal, so
// they're never capped; TK + sibling-agent rings can be large, so they're
// capped). Overflow is surfaced through stats.capped (the "+N more" affordance).
const AGENT_KIND_CAP = {
  agents: 16,
  sops: 12,
  workstreams: 10,
  guidelines: 12,
};

export function getAgentNeighborhood(slug, { cap = 12 } = {}) {
  const focusRow = agentNameStmt.get(slug);
  if (!focusRow) return { found: false, type: 'agents', slug };

  const focusId = `agents/${slug}`;
  const nodeId = (t, s) => `${t}/${s}`;

  // node-id -> record. Gen-1 only (the agent's direct connections).
  const nodes = new Map();
  const addNode = (table, s, title) => {
    const id = nodeId(table, s);
    if (nodes.has(id)) return nodes.get(id);
    const clickable = agentNodeClickable(table);
    const rec = {
      id,
      type: table,
      typeLabel: typeLabelFor(table),
      slug: s,
      title: title || s,
      subtitle: null,
      tags: [],
      gen: 1,
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      clickable,
    };
    nodes.set(id, rec);
    return rec;
  };

  // Gen-0 focus.
  nodes.set(focusId, {
    id: focusId,
    type: 'agents',
    typeLabel: 'Specialist',
    slug,
    title: agentDisplayName(slug),
    subtitle: focusRow.name && focusRow.name.includes(' - ')
      ? focusRow.name.slice(focusRow.name.indexOf(' - ') + 3)
      : null,
    tags: [],
    gen: 0,
    inDegree: 0,
    outDegree: 0,
    degree: 0,
    clickable: true,
  });

  const edgeSeen = new Set();
  const edges = [];
  const addEdge = (source, target, direction, linkType) => {
    const key = `${source}->${target}:${linkType}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ id: key, source, target, direction, linkType });
  };

  const stats = { gen1: 0, gen2: 0, capped: {}, dangling: 0 };

  // Per-kind candidate buckets so the per-kind cap can be applied independently.
  const buckets = new Map(); // table -> [{ table, slug, title, direction, linkType }]
  const pushCandidate = (table, s, title, direction, linkType) => {
    if (!buckets.has(table)) buckets.set(table, []);
    buckets.get(table).push({ table, slug: s, title, direction, linkType });
  };

  // OUTBOUND — links FROM this agent (source_table='agents'). The agent→agent
  // rows carry the quirk; everything else carries a real (table, slug).
  for (const r of outboundStmt.all('agents', slug)) {
    const lt = r.link_type === 'embed' ? 'embed' : 'wikilink';
    if (r.target_table === 'agents') {
      const sib = siblingSlugFromRaw(r.target_raw);
      if (!sib || sib === slug) { stats.dangling += 1; continue; }
      pushCandidate('agents', sib, agentDisplayName(sib), 'out', lt);
      continue;
    }
    if (!r.target_table || !AGENT_RENDERABLE.has(r.target_table) || !r.target_slug) {
      stats.dangling += 1;
      continue;
    }
    pushCandidate(r.target_table, r.target_slug, nodeTitleFor(r.target_table, r.target_slug), 'out', lt);
  }

  // INBOUND — links INTO this agent (target_table='agents'). The source IS the
  // neighbor; source_table/source_slug are correct (no quirk). Only renderable
  // sources become nodes.
  for (const r of backlinkNodesStmt.all(slug)) {
    if (r.source_table === 'agents' && r.source_slug === slug) continue; // self
    if (!AGENT_RENDERABLE.has(r.source_table) || !r.source_slug) {
      stats.dangling += 1;
      continue;
    }
    const lt = r.link_type === 'embed' ? 'embed' : 'wikilink';
    pushCandidate(r.source_table, r.source_slug, nodeTitleFor(r.source_table, r.source_slug), 'back', lt);
  }

  // Apply per-kind caps, dedupe within a kind on slug (keep the first direction
  // seen), add the kept nodes + their edges, and tally overflow. The canvas's
  // overflow affordance attaches a "+N more" node to a HUB node id (it draws a
  // synthetic hub→overflow edge), so the capped key MUST be a real node id. The
  // only stable hub here is the focus, and stats.capped keys must be unique — so
  // we aggregate every kind's overflow into ONE count under the focus id. The
  // canvas then draws a single honest "+N more" off the agent, and expanding it
  // re-fetches at the higher cap (MiniGraph's EXPANDED_CAP bump) so the hidden
  // ring members appear.
  let overflowTotal = 0;
  for (const [table, cands] of buckets) {
    const seen = new Set();
    const deduped = [];
    for (const c of cands) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug);
      deduped.push(c);
    }
    // Stable, deterministic order: title ASC (locale-naive), then slug.
    deduped.sort((a, b) => {
      const at = (a.title || a.slug).toLowerCase();
      const bt = (b.title || b.slug).toLowerCase();
      if (at !== bt) return at < bt ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    // When the user expands (MiniGraph bumps cap to EXPANDED_CAP=50), honor the
    // higher of the per-kind cap and the requested cap so the bump actually
    // reveals more of every ring.
    const kindCap = Math.max(AGENT_KIND_CAP[table] ?? cap, cap);
    const keep = deduped.slice(0, kindCap);
    overflowTotal += deduped.length - keep.length;
    for (const c of keep) {
      addNode(c.table, c.slug, c.title);
      const id = nodeId(c.table, c.slug);
      if (c.direction === 'out') addEdge(focusId, id, 'out', c.linkType);
      else addEdge(id, focusId, 'back', c.linkType);
    }
  }
  if (overflowTotal > 0) stats.capped[focusId] = overflowTotal;

  stats.gen1 = [...nodes.values()].filter((n) => n.gen === 1).length;

  // Degree over the final node set (incoming/outgoing within this neighborhood,
  // computed off the collected edges so the chip reflects what's drawn).
  for (const e of edges) {
    const sNode = nodes.get(e.source);
    const tNode = nodes.get(e.target);
    if (sNode) sNode.outDegree += 1;
    if (tNode) tNode.inDegree += 1;
  }
  for (const n of nodes.values()) n.degree = n.inDegree + n.outDegree;

  const focus = {
    id: focusId,
    type: 'agents',
    slug,
    title: agentDisplayName(slug),
    typeLabel: 'Specialist',
  };

  return { focus, nodes: [...nodes.values()], edges, stats };
}
