// RosterView.tsx — the "Team (Roster)" page of the "My AI Team" surface.
//
// SPLIT (2026-06, v3.1.0): the old combined page showed the session-log feed AND
// the roster in one cramped two-column, non-full-height view. It is now split into
// two distinct full-height pages reachable from the sidebar's "My AI Team" fly-out:
//   * Session Log  -> SessionLogView (the history feed, its own page)
//   * Roster       -> THIS view (the team grid + rich member detail)
// RosterView keeps the roster list + the rich member-detail experience; the feed
// moved to views/team/SessionLogFeed.tsx (rendered by SessionLogView).
//
// WHAT THIS PAGE DOES:
//   * The compact roster list — one row per member (avatar + name + role + clamped
//     bio). The whole row is a button → opens the rich member detail. Now a single
//     full-height column (the page fills the viewport; the list scrolls inside its
//     own contained region, not the whole window) — see team.css `.team-solo-*`.
//   * Rich member detail (DATA-CONTRACT §16). Clicking a roster member opens the
//     member like a NOTE PAGE (the large view): the AGENTS.md contract body via the
//     sanitized WikiMarkdown, a metadata panel (role/status/owner/…), a connections
//     canvas at the bottom of the reading column (the agent's [[wikilinks]] →
//     SOPs/WS/GL/docs/agents), and the agent's internal journal/insights feed.
//
// Read-only, loopback/LAN posture like every other view. Avatars load lazily
// from the Team/-jailed /api/cockpit/avatar route; an absent path OR a load
// error both fall back to monogram initials, so the grid never shows a broken
// <img>. Every value is a GL-003 token (verified light + dark); no hardcoded
// colours or sizes; the `truncate` class is never used (a multi-line clamp is).
import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import {
  UsersRound, ArrowLeft, ChevronDown, ChevronUp, ArrowUpRight,
  Info, Share2, Sparkles,
} from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { S } from '../lib/strings';
import { navigate } from '../lib/router';
import { PageHeader } from '../components/PageHeader';
import { WikiMarkdown } from '../components/WikiMarkdown';
import { MiniGraph } from '../components/graph/MiniGraph';
import './team.css';

// ---------------------------------------------------------------------------
// Types — the roster list (GET /api/cockpit/agents) and the member detail
// surfaces (GET /api/cockpit/agent/:slug[/journal|/connections], agentApi.js).
// ---------------------------------------------------------------------------
interface Agent {
  slug: string;
  name: string; // full "Name - Role" string; split on " - " for display
  folder: string;
  agent_status: string;
  bio: string;
  avatar_path: string | null;
  owner: string | null;
}
interface AgentsResponse { agents: Agent[] }

interface AgentDetail {
  slug: string;
  name: string;
  folder: string | null;
  agentStatus: string | null;
  bio: string | null;
  avatarPath: string | null;
  owner: string | null;
  contractBody: string;
  frontmatter: Record<string, unknown>;
}
interface AgentResponse { found: boolean; agent?: AgentDetail }

interface JournalEntry {
  slug: string;
  title: string;
  topic: string | null;
  created: string | null;
  updated: string | null;
  status: string | null;
  tags: string[];
  excerpt: string;
  body: string;
  contentLength: number;
}
interface JournalResponse { available: boolean; entries: JournalEntry[] }

interface Connection {
  slug: string;
  label: string;
  type: string | null;      // entity table when navigable, else null (label chip)
  typeLabel: string | null;
  isAgent: boolean;
  linkType: 'wikilink' | 'embed';
}
interface ConnectionsResponse { outbound: Connection[]; inbound: Connection[] }

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function splitName(full: string): { name: string; role: string } {
  const idx = full.indexOf(' - ');
  if (idx === -1) return { name: full, role: '' };
  return { name: full.slice(0, idx), role: full.slice(idx + 3) };
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarSrc(path: string | null): string | null {
  return path ? `/api/cockpit/avatar?path=${encodeURIComponent(path)}` : null;
}

// FIX 1 — dedupe the lead paragraph. When an agent's AGENTS.md carries no `bio`
// frontmatter, the regen falls back to the contract body's first prose paragraph
// and stores THAT as `bio` (regen-mypka-db.py). The member detail then renders it
// twice: once as the header bio, and again as the lead of the WikiMarkdown body.
// We detect that prefix-duplication (whitespace-normalised) and suppress the
// separate header bio, letting the body lead with the paragraph once — mirroring
// WikiMarkdown.dropLeadingH1's "the viewer already shows it, don't double it" rule.
function firstParagraphOf(md: string): string {
  for (const para of md.split(/\n\s*\n/)) {
    const p = para.trim();
    if (p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('-')) return p;
  }
  return '';
}
function normalizeProse(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
// True when the header bio is just a (possibly truncated) copy of the body's lead
// paragraph — so showing it separately would duplicate the contract's opening.
function bioDuplicatesBodyLead(bio: string | null, body: string): boolean {
  if (!bio) return false;
  const b = normalizeProse(bio);
  if (!b) return false;
  const lead = normalizeProse(firstParagraphOf(body));
  if (!lead) return false;
  // The stored bio is the body lead capped at 400 chars (regen), so the lead
  // starts with the bio; treat either-direction prefix as a duplicate.
  return lead.startsWith(b) || b.startsWith(lead);
}

// A YYYY-MM-DD (or ISO) string → a readable day label, with a safe fallback.
function dayLabel(date: string | null): string {
  if (!date) return '';
  const head = date.slice(0, 10);
  try {
    return new Date(`${head}T12:00:00`).toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return head;
  }
}

// ---------------------------------------------------------------------------
// Avatar — degrades to initials on a NULL path or an image load error.
// ---------------------------------------------------------------------------
function Avatar({
  name, avatarPath, size = 'card',
}: {
  name: string;
  avatarPath: string | null;
  size?: 'card' | 'row' | 'lead' | 'detail';
}) {
  const src = avatarSrc(avatarPath);
  const [failed, setFailed] = useState(false);
  const { name: display } = splitName(name);
  const showImg = src && !failed;
  return (
    <span className={`roster-avatar roster-avatar--${size}`} aria-hidden="true">
      {showImg ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="roster-avatar-img"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="roster-avatar-initials">{initialsOf(display)}</span>
      )}
    </span>
  );
}

// ===========================================================================
// THE SESSION-LOG FEED + CARD moved to views/team/SessionLogFeed.tsx (the
// 2026-06 / v3.1.0 split). SessionLogView renders them on their own full-height
// page; this roster page no longer embeds the feed.
// ===========================================================================

// ===========================================================================
// RIGHT COLUMN — the compact roster list (ITEM 3).
// One row per member (avatar + name + role + clamped bio). The whole row is a
// button → opens the rich member detail (the large view). Its own scroll region.
// ===========================================================================
function RosterRow({ agent, onOpen }: { agent: Agent; onOpen: (a: Agent) => void }) {
  const { name, role } = splitName(agent.name);
  return (
    <li className="roster-row-li">
      <button
        type="button"
        className="roster-row"
        onClick={() => onOpen(agent)}
        aria-label={`Open ${name}${role ? `, ${role}` : ''}`}
      >
        <Avatar name={agent.name} avatarPath={agent.avatar_path} size="row" />
        <span className="roster-row-body">
          <span className="roster-row-name">{name}</span>
          {role && <span className="roster-row-role">{role}</span>}
          {agent.bio && <span className="roster-row-bio">{agent.bio}</span>}
        </span>
      </button>
    </li>
  );
}

// ===========================================================================
// MEMBER DETAIL — the large "note page" (ITEM 2 / DATA-CONTRACT §16).
// Contract body (WikiMarkdown) + metadata panel + connections canvas (bottom of
// the reading column) + the agent's journal feed. Each backing read degrades to
// a calm empty state independently.
// ===========================================================================

// Metadata panel — reuses NoteView's .side-panel / .meta-list CSS verbatim.
function AgentMetaPanel({ agent }: { agent: AgentDetail }) {
  const { role } = splitName(agent.name);
  const rows: Array<[string, string]> = [];
  if (role) rows.push(['role', role]);
  if (agent.agentStatus) rows.push(['status', agent.agentStatus]);
  if (agent.owner) rows.push(['owner', agent.owner]);
  // Surface a couple of high-signal contract-frontmatter fields when present
  // (version + compatibility), without dumping the whole YAML.
  const fm = agent.frontmatter;
  const version = typeof fm.agent_version === 'string' ? fm.agent_version : null;
  const compat = typeof fm.agent_compatibility === 'string' ? fm.agent_compatibility : null;
  if (version) rows.push(['version', version]);
  if (compat) rows.push(['compatibility', compat]);
  rows.push(['slug', agent.slug]);
  return (
    <section className="side-panel">
      <h2 className="side-panel-title">
        <Info size={15} strokeWidth={1.5} aria-hidden="true" /> Metadata
      </h2>
      <dl className="meta-list">
        {rows.map(([k, v]) => (
          <div key={k} className="meta-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {agent.folder && <p className="side-filepath font-mono">{agent.folder}</p>}
    </section>
  );
}

// One connection chip (Issue 1 — clickable pills). Entity + sibling-agent targets
// navigate (→ #/note or the roster); SOP/WS/GL/unresolved targets have NO cockpit
// route, so they degrade gracefully to a non-clickable chip carrying a tooltip
// (the same honest fallback the canvas uses for those nodes). The chip never
// produces a dead link.
function ConnChip({ c, dir }: { c: Connection; dir: 'out' | 'in' }) {
  const key = `${dir}-${c.slug}-${c.linkType}`;
  const navTo = c.isAgent
    ? () => navigate({ name: 'roster' }) // sibling agents live on this page
    : c.type
      ? () => navigate({ name: 'note', type: c.type as string, slug: c.slug })
      : null;

  if (navTo) {
    return (
      <button
        type="button"
        key={key}
        className="team-conn-chip team-conn-chip--nav"
        onClick={navTo}
        title={`Open ${c.label}`}
      >
        {c.typeLabel && <span className="team-conn-kind">{c.typeLabel}</span>}
        {c.isAgent && !c.typeLabel && <span className="team-conn-kind">Specialist</span>}
        <span className="team-conn-label">{c.label}</span>
        <ArrowUpRight size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
    );
  }
  // No view for this target (Team-Knowledge SOP/WS/GL): a non-interactive chip
  // with a tooltip that names it and explains it isn't navigable here.
  return (
    <span
      key={key}
      className="team-conn-chip"
      title={`${c.label} — no in-cockpit view yet`}
    >
      <span className="team-conn-label">{c.label}</span>
    </span>
  );
}

// Connections section (DATA-CONTRACT §16). LEADS with the actual ReactFlow
// Knowledge-graph canvas — the SAME <MiniGraph> the note pages use — now that the
// graph endpoint accepts an agent as the focus node (server/graph.js
// getAgentNeighborhood). The canvas carries its own chrome: type-icon nodes,
// in/out degree chips, directed edges, zoom controls, and the expand-to-fullscreen
// button. Clickable nodes navigate (entity → #/note, sibling agent → roster);
// SOP/WS/GL nodes render but aren't clickable (no route yet).
//
// Below the canvas, a COLLAPSIBLE secondary "list" view keeps the clickable pills
// as a text/non-visual fallback (Issue 1) — folded by default so the canvas is the
// primary read, matching the note page's lead-with-the-graph pattern.
//
// The resolved connections list drives (a) the secondary chips and (b) the empty
// state: when an agent has NO connections at all, the whole section renders nothing
// (the canvas self-hides on an empty neighbourhood; we mirror that for the section
// heading + list so there's no empty chrome). The connections data is fetched once
// by AgentLargeView (it also feeds FIX 3's body-wikilink resolvability oracle) and
// passed down here, so the detail view makes a single connections request.
function AgentConnections({ slug, data }: { slug: string; data: ConnectionsResponse | null }) {
  if (!data) return null;
  const { outbound, inbound } = data;
  if (outbound.length === 0 && inbound.length === 0) return null;

  return (
    <section className="team-conn" aria-label="Connections">
      {/* PRIMARY — the ReactFlow canvas (reuses MiniGraph; owns its own heading,
          fullscreen toggle + zoom controls). focusType='agents' routes the fetch
          to the agent-focus graph builder. */}
      <MiniGraph focusType="agents" slug={slug} />

      {/* SECONDARY — the clickable-pill list, folded by default. A plain <details>
          gives keyboard-accessible, zero-JS disclosure; the canvas stays the lead. */}
      <details className="team-conn-list">
        <summary className="team-conn-list-summary">
          <Share2 size={14} strokeWidth={1.5} aria-hidden="true" />
          Connections as a list
        </summary>
        <div className="team-conn-list-body">
          {outbound.length > 0 && (
            <div className="team-conn-group">
              <p className="team-conn-grouplabel">Links to</p>
              <div className="team-conn-chips">
                {outbound.map((c) => <ConnChip key={`out-${c.slug}-${c.linkType}`} c={c} dir="out" />)}
              </div>
            </div>
          )}
          {inbound.length > 0 && (
            <div className="team-conn-group">
              <p className="team-conn-grouplabel">Linked from</p>
              <div className="team-conn-chips">
                {inbound.map((c) => <ConnChip key={`in-${c.slug}-${c.linkType}`} c={c} dir="in" />)}
              </div>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

// The agent's internal journal/insights feed — newest-first, each entry unfolds
// in place (date + title + snippet → full body via WikiMarkdown). Calm empty
// state when the agent has no journal/ folder (or the table is absent).
function AgentJournalFeed({ slug }: { slug: string }) {
  const { data, loading, error } = useFetch<JournalResponse>(
    `/api/cockpit/agent/${encodeURIComponent(slug)}/journal`,
  );

  if (loading) {
    return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  }
  if (error) {
    return <p role="alert" className="jt-foot-error">Could not load insights: {error}</p>;
  }
  // available:false (no table) and an empty feed read the same: a calm note.
  if (!data || !data.available || data.entries.length === 0) {
    return <p className="team-journal-empty">No durable insights captured yet.</p>;
  }

  return (
    <ol className="team-journal-list">
      {data.entries.map((entry) => (
        <li key={entry.slug} className="team-journal-li">
          <AgentJournalCard entry={entry} />
        </li>
      ))}
    </ol>
  );
}

function AgentJournalCard({ entry }: { entry: JournalEntry }) {
  const [open, setOpen] = useState(false);
  const bodyId = `team-insight-${entry.slug}`;
  const date = entry.created || entry.updated;
  return (
    <article className="team-insight">
      <div className="team-insight-meta">
        {date && <time className="team-insight-date" dateTime={date.slice(0, 10)}>{dayLabel(date)}</time>}
        {entry.topic && <span className="team-insight-topic">{entry.topic}</span>}
      </div>
      <h4 className="team-insight-title">{entry.title}</h4>
      {!open && entry.excerpt && <p className="team-insight-excerpt">{entry.excerpt}</p>}
      <div className="collapse-rows" data-open={open} id={bodyId}>
        <div className="collapse-rows-inner">
          <div className="team-insight-full">
            {open && <WikiMarkdown body={entry.body} />}
          </div>
        </div>
      </div>
      {entry.tags.length > 0 && (
        <div className="team-insight-tagrow">
          {entry.tags.map((t) => <span key={t} className="team-insight-tag">{t}</span>)}
        </div>
      )}
      {(entry.body || entry.excerpt) && (
        <button
          type="button"
          className="team-log-unfold"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {open
            ? <><ChevronUp size={14} strokeWidth={1.5} aria-hidden="true" /> Fold</>
            : <><ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /> Unfold</>}
        </button>
      )}
    </article>
  );
}

// FIX 2 — the contract body is long; wrap it in the cockpit's established
// collapse pattern (the `.collapse-rows` grid-rows transition + a `.team-log-unfold`
// toggle, exactly as the session-log and insight cards use). Collapsed by default
// with a short capped preview (the lead paragraph) so the page opens calm; expand
// reveals the full AGENTS.md via WikiMarkdown. FIX 3 — the body's [[wikilinks]] get
// the isResolvable oracle so Team-Knowledge SOP/WS/GL targets degrade instead of
// routing to a "No entry found" page.
function AgentContractBody({
  body,
  isResolvable,
}: {
  body: string;
  isResolvable: (slug: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const preview = useMemo(() => {
    const lead = firstParagraphOf(body);
    return lead.length > 320 ? `${lead.slice(0, 320).trimEnd()}…` : lead;
  }, [body]);
  return (
    <section className="roster-contract" aria-label="Contract">
      {!open && preview && <p className="roster-contract-preview">{preview}</p>}
      <div className="collapse-rows" data-open={open} id={bodyId}>
        <div className="collapse-rows-inner">
          <div className="roster-contract-full">
            {open && <WikiMarkdown body={body} isResolvable={isResolvable} />}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="team-log-unfold"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        {open
          ? <><ChevronUp size={14} strokeWidth={1.5} aria-hidden="true" /> Fold contract</>
          : <><ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /> Read full contract</>}
      </button>
    </section>
  );
}

// The large member-detail view (a note page). Fetches the detail on slug change.
function AgentLargeView({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const { name, role } = splitName(agent.name);
  const topRef = useRef<HTMLDivElement | null>(null);
  const { data, loading, error } = useFetch<AgentResponse>(
    `/api/cockpit/agent/${encodeURIComponent(agent.slug)}`,
  );
  // Connections, fetched once here: they feed the canvas + pill list (passed to
  // AgentConnections) AND build FIX 3's resolvability oracle for the body wikilinks.
  const { data: connData } = useFetch<ConnectionsResponse>(
    `/api/cockpit/agent/${encodeURIComponent(agent.slug)}/connections`,
  );
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, [agent.slug]);

  // The roster row gives us name/role/avatar immediately; the detail fetch adds
  // the contract body + frontmatter. Build a detail object that prefers the
  // fetched values and falls back to the roster row so the header never flickers.
  const detail: AgentDetail = {
    slug: agent.slug,
    name: data?.agent?.name || agent.name,
    folder: data?.agent?.folder ?? agent.folder ?? null,
    agentStatus: data?.agent?.agentStatus ?? agent.agent_status ?? null,
    bio: data?.agent?.bio ?? agent.bio ?? null,
    avatarPath: data?.agent?.avatarPath ?? agent.avatar_path ?? null,
    owner: data?.agent?.owner ?? agent.owner ?? null,
    contractBody: data?.agent?.contractBody ?? '',
    frontmatter: data?.agent?.frontmatter ?? {},
  };

  // FIX 3 — resolvability oracle for in-body [[wikilinks]]. The /connections
  // endpoint is the SAME server classification wave A's pills + graph nodes use:
  // an outbound connection is navigable when it carries an entity {type} OR is a
  // sibling agent; everything else (Team-Knowledge SOP/WS/GL, `AGENTS`,
  // `agent-index`, …) has no cockpit view. We index the navigable target slugs so
  // the body renders the SAME degrade for the SAME targets — consistent, no 404s.
  const resolvableSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const c of connData?.outbound ?? []) {
      if (c.type || c.isAgent) set.add(c.slug);
    }
    return set;
  }, [connData]);
  const isResolvable = useCallback(
    (slug: string): boolean => resolvableSlugs.has(slug),
    [resolvableSlugs],
  );

  // FIX 1 — suppress the header bio when it merely duplicates the contract's lead
  // paragraph (the regen's no-`bio`-frontmatter fallback stores the body lead as
  // the bio). The body then leads with the paragraph exactly once.
  const showBio = detail.bio && !bioDuplicatesBodyLead(detail.bio, detail.contractBody);

  return (
    <article ref={topRef} className="note-view roster-large animate-fade-rise">
      <button type="button" className="back-button" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back to team
      </button>

      <header className="note-header">
        <div className="note-header-row">
          <span className="note-type-pill">{role || 'Specialist'}</span>
        </div>
        <div className="roster-large-titlerow">
          <Avatar name={detail.name} avatarPath={detail.avatarPath} size="detail" />
          <h1 className="note-title">{name}</h1>
        </div>
        {showBio && <p className="roster-large-bio">{detail.bio}</p>}
      </header>

      <div className="note-grid">
        <div className="note-body-col">
          {loading && !data ? (
            <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>
          ) : error ? (
            <p role="alert" className="view-error">Could not load this member: {error}</p>
          ) : detail.contractBody ? (
            <AgentContractBody body={detail.contractBody} isResolvable={isResolvable} />
          ) : (
            <p className="note-empty">No contract on file for this member yet.</p>
          )}

          {/* Connections canvas — bottom of the reading column (§16). */}
          <AgentConnections slug={agent.slug} data={connData ?? null} />

          {/* The agent's internal journal / durable-insight feed (§16). */}
          <section className="team-journal" aria-label="Durable insights">
            <h2 className="mg-title">
              <Sparkles size={15} strokeWidth={1.5} aria-hidden="true" /> Durable insights
            </h2>
            <AgentJournalFeed slug={agent.slug} />
          </section>
        </div>

        <aside className="note-side">
          <AgentMetaPanel agent={detail} />
        </aside>
      </div>
    </article>
  );
}

// ===========================================================================
// THE PAGE.
// ===========================================================================
export function RosterView() {
  const { data, loading, error } = useFetch<AgentsResponse>('/api/cockpit/agents');
  const topRef = useRef<HTMLDivElement | null>(null);
  const [large, setLarge] = useState<Agent | null>(null);
  const rosterHeadingId = useId();
  useEffect(() => { if (!large) topRef.current?.scrollIntoView({ block: 'start' }); }, [large]);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">{S.roster.loadError}: {error}</div>;
  if (!data) return null;

  const agents = data.agents;

  // The large note-page view replaces the two-column list (a focused surface).
  if (large) {
    return <AgentLargeView agent={large} onBack={() => setLarge(null)} />;
  }

  // Empty state — a bare scaffold may have no active agents.
  if (agents.length === 0) {
    return (
      <section ref={topRef} className="roster-view animate-fade-rise">
        <PageHeader title={S.roster.title} icon={UsersRound} />
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <UsersRound size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">No team members yet</p>
          <p className="library-empty-sub">
            Your specialists appear here once your team is set up.
          </p>
        </div>
      </section>
    );
  }

  const lead = agents.find((a) => a.slug === 'larry') ?? null;
  const rest = agents.filter((a) => a.slug !== 'larry');
  const ordered = lead ? [lead, ...rest] : rest;
  const openMember = (a: Agent) => setLarge(a);

  return (
    <section ref={topRef} className="roster-view team-page-view team-solo-view animate-fade-rise">
      <PageHeader title={S.roster.title} icon={UsersRound} subtitle={S.roster.countSub(agents.length)} />

      {/* A single full-height column: the roster list scrolls inside its own
          contained region (.team-solo-scroll) so the page fills the viewport and
          the window itself never scrolls a short floating card — team.css. */}
      <section className="team-solo-col" aria-labelledby={rosterHeadingId}>
        <h2 id={rosterHeadingId} className="team-col-head">
          <UsersRound size={16} strokeWidth={1.5} aria-hidden="true" /> {S.roster.rosterHeading}
        </h2>
        <div className="team-solo-scroll">
          <ul className="roster-rows">
            {ordered.map((a) => (
              <RosterRow key={a.slug} agent={a} onOpen={openMember} />
            ))}
          </ul>
        </div>
      </section>
    </section>
  );
}
