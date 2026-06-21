// cockpitTypes.ts — types mirroring the /api/cockpit/* payloads (server/cockpit.js,
// server/serendipity.js). Strict; no `any`.

export type EntityType =
  | 'key_elements' | 'topics' | 'habits' | 'people' | 'organizations'
  | 'projects' | 'goals' | 'documents' | 'deliverables' | 'journal';

export interface NavType {
  type: EntityType;
  label: string;
  count: number;
}

export interface TypeListItem {
  slug: string;
  title: string | null;
  subtitle: string | null;
  date: string | null;
  mood?: string | null;
  energy?: string | null;
  // RECONCILED TO MACK 03 — conversation-provenance fields for the Journal-page
  // extension (unified spec Decision 5). Mack 03 confirms capture.py writes the
  // GL-002 frontmatter fields `entry_type` ('voice' | 'chat') + `tags` on conversation
  // entries (his "Journal payload" hand-off). The names below mirror his exactly. These
  // are surfaced by the cockpit `/api/cockpit/type/journal` route (cockpit.js — Mack's
  // `server/**` lane); the client maps snake_case `entry_type` -> `entryType` at the
  // fetch boundary. Optional + backward-safe: when the API omits them, the journal
  // renders exactly as before. NOTE: the cockpit.js journal-list payload surfacing
  // (separate from chatBridge) is the one OPEN server-side dependency — flagged to Larry.
  /** GL-002 `entry_type` — 'voice' | 'chat' marks a conversation-derived entry. */
  entryType?: string | null;
  /** GL-002 `tags` — e.g. ['voice-reflection','stoic-mentor'] or ['chat-reflection']. */
  tags?: string[] | null;
  /** item-7 — per-type detail columns the columnar list renders beside the title.
   *  Keys are the column aliases echoed in TypeListResponse.columns; values come
   *  straight from the list table (no per-row re-fetch). Absent for types with no
   *  extra columns (e.g. deliverables). */
  cols?: Record<string, string | number | null>;
  /** item-5 / DATA-CONTRACT §15 — RAW JSON string of the {label,url}[] social /
   *  website links (people + organizations only; absent otherwise, and absent on
   *  a pre-§15 regen with no `social_links` column). The client parses + validates
   *  it into SocialLink[] at the render boundary — never trust the shape blindly. */
  socialLinks?: string | null;
}

/** item-5 / DATA-CONTRACT §15 — one parsed social / website chip. */
export interface SocialLink {
  label: string;
  url: string;
}

export interface TypeListResponse {
  type: EntityType;
  label: string;
  items: TypeListItem[];
  total: number;
  /** item-7 — the ordered column aliases present on each row's `cols` map. The
   *  client owns the human header label + width per alias. */
  columns?: string[];
}

// ---------------------------------------------------------------------------
// Global full-text search (DATA-CONTRACT §13) — the ⌘K command palette.
// GET /api/cockpit/search/global?q=…&limit=30 → { available, items }.
// `available:false` means the FTS5 `notes_fts` index hasn't been built by a
// regen yet (the cockpit boots fine without it); the UI shows a calm hint.
// ---------------------------------------------------------------------------
export interface GlobalSearchHit {
  type: EntityType | string;   // source table; an unknown table degrades to a label
  slug: string;
  entityId: number | null;
  title: string;
  /** Body fragment with <mark>…</mark> around the matched tokens (FTS5 snippet). */
  snippet: string;
  /** Human type label (TYPE_LABELS), e.g. "Person", "Journal". */
  label: string;
}

export interface GlobalSearchResponse {
  available: boolean;
  items: GlobalSearchHit[];
}

// An outbound link from a note body. Clickable only when it resolves to one of
// the 10 entity tables; otherwise rendered as a plain, non-clickable label.
export interface OutboundLink {
  raw: string;
  slug: string | null;
  targetType: EntityType | string | null;
  /** DATA-CONTRACT §12 — the target note's resolved human title (people.full_name,
   *  topics.name, journal.title, …), or null for an orphan / non-entity / titleless
   *  target. The in-body wikilink renderer prefers an explicit `[[target|label]]`,
   *  then this title, then the raw slug. */
  title: string | null;
  linkType: 'wikilink' | 'embed';
  clickable: boolean;
}

export interface Backlink {
  sourceType: string;
  slug: string;
  title: string;
  label: string;
  clickable: boolean;
}

export interface JournalMediaImage {
  path: string;
  mediaType: string;
  caption: string | null;
}

export interface NoteJournalMeta {
  entryDate: string | null;
  mood: string | null;
  /** GL-002 v1.4 sprachneutral 1–5 valence; carried by getNote (cockpit.js). */
  moodValence?: number | null;
  energy: string | null;
  category: string | null;
  entryType: string | null;
  /** DATA-CONTRACT §10. 'raw' = user-entered, not yet woven into the graph;
   *  'integrated' = Penn rewrote the body and preserved the original. NULL in
   *  the mirror is normalized to 'raw' server-side. */
  integrationStatus?: 'raw' | 'integrated';
  /** The user's verbatim original text, set ONCE by Penn at integration. Only
   *  present when integrationStatus === 'integrated'. Powers "unfold original". */
  originalBody?: string | null;
  /** 1 = came from the cockpit's manual-add flow. */
  manuallyAdded?: boolean;
}

// v3 #4 — an in-app file preview derived from a document note's frontmatter
// (digital_location → Documents/_files/foo.pdf). previewable=true means a native
// <iframe>/<embed> can render it (PDF/image/txt) through the guarded /file route.
export interface NotePreview {
  path: string;
  kind: 'pdf' | 'image' | 'text' | 'other' | 'external';
  mime: string | null;
  previewable: boolean;
  field: string;
  ext?: string;
}

export interface CockpitNote {
  /** Entity type, or 'fleeting' — the resolve route's filesystem fallback for
   *  Workbench docs (intentionally absent from mypka.db, server/cockpit.js). */
  type: EntityType | 'fleeting';
  slug: string;
  title: string;
  typeLabel: string;
  body: string;
  filePath: string | null;
  metadata: Record<string, unknown>;
  preview?: NotePreview | null;
  outbound: OutboundLink[];
  backlinks: Backlink[];
  journal?: NoteJournalMeta;
  media?: {
    images: JournalMediaImage[];
    audioCount: number;
    /** Voice-reflection audio (Stoic-Mentor §8.11.3.4). Server derives this from
     *  the journal `source:` frontmatter and ALREADY strips the leading `PKM/` +
     *  builds the route-correct same-origin /file URL — the client plays `url`
     *  verbatim (zero prefix-quirk knowledge on the frontend). null when none. */
    audio?: { path: string; url: string } | null;
  };
}

// ---------------------------------------------------------------------------
// Library foundation (DATA-CONTRACT §11; server/libraryApi.js). The library nav
// is data-driven off `library_registry`; each library is a typed mirror table.
// All payloads carry `available` so the client degrades gracefully when the
// library tables aren't installed yet (bare scaffold → available:false).
// ---------------------------------------------------------------------------

/** One enumerated library from the registry (§11.4(a)). */
export interface LibrarySummary {
  library_slug: string;
  nav_label: string | null;
  nav_icon: string | null;
  pkm_folder: string | null;
  doc_type: string | null;
  sort_order: number | null;
}

export interface LibrariesResponse {
  available: boolean;
  libraries: LibrarySummary[];
}

/** A library's own header echoed back on list/item responses. */
export interface LibraryHeader {
  slug: string;
  navLabel: string | null;
  navIcon: string | null;
  docType: string | null;
}

/** A library item ROW (§11.4(b)). The invariant columns are typed; per-library
 *  axis columns vary, so the index signature carries them (string | number |
 *  string[] | null) without an `any`. */
export interface LibraryItem {
  slug: string;
  title: string | null;
  status: string | null;
  tags: string[];
  file_path: string | null;
  [column: string]: string | number | string[] | null | undefined;
}

export interface LibraryListResponse {
  available: boolean;
  found: boolean;
  library?: LibraryHeader;
  items?: LibraryItem[];
}

/** One item by slug, including `body` + `raw_frontmatter` for the detail-large
 *  view (§11.4(d)). */
export interface LibraryItemDetail extends LibraryItem {
  body?: string | null;
  raw_frontmatter?: string | null;
}

export interface LibraryItemResponse {
  available: boolean;
  found: boolean;
  library?: LibraryHeader;
  item?: LibraryItemDetail;
}

export interface SecondaryMatch {
  type: EntityType;
  slug: string;
  title: string | null;
  label: string;
}

export interface ResolveResponse {
  found: boolean;
  slug: string;
  note?: CockpitNote;
  secondary?: SecondaryMatch[];
}

export interface Resonance {
  slug: string;
  entryDate: string;
  ageDays: number;
  ageYears: number;
  title: string;
  mood: string | null;
  energy: string | null;
  category: string | null;
  snippet: string;
  matchedThemes: string[];
  score: number;
}

export interface SerendipityResponse {
  depth: number;
  depthLabel: string;
  focus: string[];
  focusNote: string;
  resonances: Resonance[];
}

// ---------------------------------------------------------------------------
// Knowledge-graph mini-graph (server/graph.js — getNeighborhood).
//   GET /api/cockpit/graph/neighborhood/:type/:slug?depth=2&cap=12
// Success: { focus, nodes, edges, stats }. Not-found: { found:false, type, slug }.
// `id` = `${type}/${slug}`. Mirrors GL-003 §8.9 + the Flow LOCKED BUILD SPEC.
// ---------------------------------------------------------------------------
// A graph node's type. The note graph emits only the 10 entity tables; the agent
// graph (focusType='agents') additionally emits sibling agents + the three
// Team-Knowledge kinds. Navigability is carried by `clickable`, never inferred
// from the type — SOP/WS/GL render as nodes but are not clickable (no route yet).
export type GraphNodeType =
  | EntityType
  | 'agents'
  | 'sops'
  | 'workstreams'
  | 'guidelines';

export interface GraphFocus {
  id: string;
  type: GraphNodeType;
  slug: string;
  title: string;
  typeLabel: string;
}

export interface GraphNode {
  id: string;                     // `${type}/${slug}`
  type: GraphNodeType;
  typeLabel: string;
  slug: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  gen: 0 | 1 | 2;
  inDegree: number;
  outDegree: number;
  degree: number;
  clickable: boolean;
}

export interface GraphEdge {
  id: string;                     // `${source}->${target}:${linkType}`
  source: string;                 // node id
  target: string;                 // node id
  direction: 'out' | 'back';      // out = focus→neighbor; back = neighbor→focus
  linkType: 'wikilink' | 'embed';
}

export interface GraphStats {
  gen1: number;
  gen2: number;
  capped: Record<string, number>; // gen1 node id -> N hidden grandchildren
  dangling: number;
}

// Success-shape neighborhood response.
export interface GraphNeighborhood {
  focus: GraphFocus;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

// The route returns the success shape OR { found:false } on a miss. The success
// shape has no `found` field, so we discriminate on presence of `focus`.
export type GraphResponse =
  | GraphNeighborhood
  | { found: false; type: string; slug: string };

// ---------------------------------------------------------------------------
// Global "My Life" graph (server/mylife.js — the Resonances surface).
// The corrected doctrine: Key Elements are the pinned radial spine; Goals are a
// KE's operating layer (anchor edges); each Goal is carried by a Project OR a
// Habit (carry edges); Topics are outer satellites with a promotion arrow → KE;
// resonance edges are cross-bucket wikilinks (the full /edges list).
//   GET /api/cockpit/graph/mylife/anchors          -> { anchors, stats }
//   GET /api/cockpit/graph/mylife/anchor/:slug/members -> { anchor, goals, edges, stats }
//   GET /api/cockpit/graph/mylife/topics           -> { topics, edges, stats }
//   GET /api/cockpit/graph/mylife/degrees          -> { degrees, stats }
//   GET /api/cockpit/graph/mylife/edges            -> { edges, stats }
// node id = `${type}/${slug}`, matching the mini-graph contract exactly.
// ---------------------------------------------------------------------------

// The "spatial layer" a global-graph node belongs to (server-stamped). Drives the
// radial band the node lays out on, NEVER a hue (§9.5).
export type MyLifeLayer = 'ke' | 'goal' | 'carrier' | 'topic' | 'connection';

// A renderable node in the global graph. Mirrors mylife.js makeNode() + the
// per-route stamps. `degree` is the link-graph degree (in+out).
export interface MyLifeNode {
  id: string;                 // `${type}/${slug}`
  type: EntityType;
  typeLabel: string;
  slug: string;
  title: string;
  subtitle: string | null;
  layer: MyLifeLayer;
  isAnchor: boolean;          // true only for KEs
  degree: number;
  clickable: boolean;
  resolved: boolean;
  // anchor-only stamps (Q1)
  status?: string | null;     // 'archived' fades the KE (§8.9.14)
  memberCount?: number;       // persistent Goal-count chip (§8.9.10)
  // goal-only stamps (Q2)
  carrierKind?: 'single' | 'dual' | 'unfilled';
  carriers?: MyLifeNode[];
  // carrier-only stamp (Q2)
  carrierType?: 'project' | 'habit';
  // topic-only stamps (Q3)
  keyElement?: string | null; // anchor KE slug, or null (floating satellite)
  lifecycle?: string | null;
  promotedTo?: string | null;
}

// The four typed doctrine edges (§8.9.11). Tellable apart by weight + dash +
// arrowhead + direction — never hue.
export type MyLifeEdgeKind = 'anchor' | 'carry' | 'promotion' | 'resonance';

export interface MyLifeEdge {
  id: string;
  source: string;             // node id
  target: string;             // node id
  kind: MyLifeEdgeKind;
}

export interface MyLifeAnchorsResponse {
  anchors: MyLifeNode[];
  stats: { keCount: number; withGoals: number; archivedCount: number };
}

export interface MyLifeMembersResponse {
  found: true;
  anchor: MyLifeNode;
  goals: MyLifeNode[];        // each carries carrierKind + carriers[]
  edges: MyLifeEdge[];        // anchor (KE→Goal) + carry (Goal→carrier)
  stats: {
    goalCount: number;
    carrierCount: number;
    singleCarrier: number;
    dualCarrier: number;      // doctrine smell — surfaced, not hidden
    unfilled: number;         // unfilled carrier slot
  };
}

export type MyLifeMembersResult =
  | MyLifeMembersResponse
  | { found: false; slug: string };

export interface MyLifeTopicsResponse {
  topics: MyLifeNode[];
  edges: MyLifeEdge[];        // promotion (Topic→KE), only where promoted_to set
  stats: {
    topicCount: number;
    withKeyElement: number;
    floating: number;
    promotedCount: number;
  };
}

export interface MyLifeDegreesResponse {
  degrees: Record<string, number>;   // node id -> degree
  stats: { nodeCount: number; maxDegree: number; maxNode: string | null };
}

export interface MyLifeEdgesResponse {
  edges: MyLifeEdge[];               // ~4,870 resolved cross-bucket edges
  stats: { edgeCount: number; droppedDangling: number };
}

// ---------------------------------------------------------------------------
// Type-first drill-down EXPLORER (server/mylife.js — getMyLifeBucket).
// The corrected model (2026-06-03, Tom's review): 5 fixed "concept type" nodes
// across the top (Key Elements · Projects · Goals · Topics · Habits). Click a
// type → its members fan DOWN; click a member → its neighborhood (reuses the
// /graph/neighborhood/:type/:slug contract). Deterministic incremental layout;
// placed nodes never move.
//   GET /api/cockpit/graph/bucket/:type   (:type ∈ key_elements|projects|goals|topics|habits)
//   -> { type, typeLabel, nodes:[{ id, type, slug, title, layer:'member',
//                                  degree, memberCount? }], stats:{ count } }
// ---------------------------------------------------------------------------

// The 5 explorer concept-type buckets, in row order (left→right). These are
// synthetic TYPE nodes — the My Life framework shown literally, NOT DB entities.
export const EXPLORER_BUCKETS = [
  'key_elements',
  'projects',
  'goals',
  'topics',
  'habits',
] as const;
export type ExplorerBucket = (typeof EXPLORER_BUCKETS)[number];

// Success-shape bucket response (a type's members as graph nodes).
export interface MyLifeBucketResponse {
  type: ExplorerBucket;
  typeLabel: string;
  nodes: MyLifeNode[];               // each layer:'member', id = `${type}/${slug}`
  stats: { count: number };
}

// The route returns the success shape OR { found:false } on an invalid :type.
export type MyLifeBucketResult =
  | MyLifeBucketResponse
  | { found: false; type: string };

// ---------------------------------------------------------------------------
// Outer World module (DATA-CONTRACT §14) — the mymind-style saved-content store.
// Mirrors server/outerWorldApi.js. The grid row drops `body`; the detail row adds
// it. embed_image / embed_favicon arrive as PKM-relative paths the client serves
// through /api/cockpit/media (or null on a missing/escaping path → favicon/title
// fallback). NULL scalars stay null (render blank, never 0 / "unknown").
// ---------------------------------------------------------------------------
export interface OuterWorldItem {
  slug: string;
  title: string | null;
  status: string | null;
  captured_on: string | null;
  source_url: string | null;
  source_type: string | null;
  source_author: string | null;
  source_published: string | null;
  embed_kind: string | null;
  embed_title: string | null;
  embed_description: string | null;
  /** PKM-relative local path for /api/cockpit/media (null → favicon/title fallback). */
  embed_image: string | null;
  embed_site_name: string | null;
  embed_domain: string | null;
  /** PKM-relative local path for /api/cockpit/media (null → no chrome favicon). */
  embed_favicon: string | null;
  embed_author: string | null;
  embed_captured_at: string | null;
  tom_context: string | null;
  tags: string[];
  linked_topics: string[];
  linked_key_elements: string[];
  linked_projects: string[];
  linked_people: string[];
  linked_organizations: string[];
  file_path: string | null;
}

/** The detail-large row adds the full markdown body. */
export interface OuterWorldItemDetail extends OuterWorldItem {
  body: string;
}

/** GET /api/cockpit/outer-world — the card grid (newest-saved first, body-less). */
export interface OuterWorldListResponse {
  available: boolean;
  items: OuterWorldItem[];
}

/** GET /api/cockpit/outer-world/item/:slug — one item (detail-large). */
export interface OuterWorldItemResponse {
  available: boolean;
  found: boolean;
  item?: OuterWorldItemDetail;
}
