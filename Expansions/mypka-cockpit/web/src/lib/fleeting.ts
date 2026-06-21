// fleeting.ts — shared types + fetch helpers for the Fleeting-Notes surface
// (docs with pin/status meta, whiteboards, and the Hub payload).
//
// Server contracts (server/fleeting.js + server.js):
//   GET    /api/cockpit/notes                  -> { ok, docs: FleetingDoc[] }
//   PATCH  /api/cockpit/notes/:slug/meta       -> { ok, slug, pinned, status, color }
//   GET    /api/cockpit/boards                 -> { boards: BoardSummary[] }
//   GET    /api/cockpit/boards/:slug           -> { ok, slug, board: Board }
//   POST   /api/cockpit/boards                 -> { ok, slug, board }
//   PUT    /api/cockpit/boards/:slug           -> { ok, slug, board }
//   DELETE /api/cockpit/boards/:slug           -> { ok, slug }
//   GET    /api/cockpit/hub                    -> HubData
import { cockpitWrite } from './useCockpitWrite';

/** capture = just dropped in; working = pinned WIP being expanded over days;
 *  ready = the SIGNAL — the owner marks it ready for the team to pick up and
 *  integrate into the PKM. */
export type NoteStatus = 'capture' | 'working' | 'ready';

/** Sticky color tokens. The server validates against this exact set; the CSS
 *  maps each to a tinted card (cockpit.css `.tint-*`). */
export type StickyColor = 'sun' | 'moss' | 'sky' | 'plum' | 'clay' | 'paper';
export const STICKY_COLORS: readonly StickyColor[] = ['sun', 'moss', 'sky', 'plum', 'clay', 'paper'];

export interface FleetingDoc {
  slug: string;
  title: string;
  mtime: number;
  bytes: number;
  pinned: boolean;
  status: NoteStatus;
  color: StickyColor | null;
}

export type BoardArea = 'projects' | 'key_elements' | 'topics' | 'goals' | 'habits' | null;

/** Whiteboard v2 node kinds. Boards are notes-only: every card is a doc card.
 *  'board' is a nested-board card (double-click navigates into it; dangling
 *  boardSlug renders as missing). 'section' is a board-local frame drawn
 *  behind the cards (never materialized, excluded from noteCount). 'sticky'
 *  is LEGACY READ-ONLY input: the server migrates each sticky into a real
 *  fleeting note on read/save (when writes are enabled); the client renders a
 *  leftover sticky read-only and passes it through on save so the server can
 *  finish the migration. */
export interface BoardNode {
  id: string;
  kind: 'doc' | 'board' | 'section' | 'sticky';
  slug?: string;      // kind=doc — the fleeting-note slug the card opens
  boardSlug?: string; // kind=board — the nested board the card navigates to
  label?: string;     // kind=section — frame label (≤120, server-clamped)
  text?: string;      // kind=sticky — LEGACY inline text (server migrates it)
  x: number;
  y: number;
  w: number;
  h: number;
  color: StickyColor;
}

/** A Heptabase-style connection between two nodes on the same board. Edges
 *  whose BOTH endpoints are doc nodes are materialized server-side into a
 *  managed "## Connections" wikilink section in each involved note. */
export type EdgeDirection = 'one' | 'both';

export interface BoardEdge {
  id: string;
  from: string;        // node id (must exist on the board)
  to: string;          // node id (must exist on the board, ≠ from)
  direction: EdgeDirection;
  note: string;        // ≤ 2000 chars, trimmed server-side
}

export interface Board {
  name: string;
  area: BoardArea;
  nodes: BoardNode[];
  edges: BoardEdge[];
}

/** Per-save report of the doc-doc edge → "## Connections" projection. */
export interface MaterializeResult {
  updated: string[];   // note slugs whose section changed and saved
  failed: string[];    // note slugs that could not be updated (e.g. deleted)
}

export interface BoardSummary {
  slug: string;
  name: string;
  area: BoardArea;
  noteCount: number;
  mtime: number;
}

export interface HubData {
  types: { type: string; label: string; count: number }[];
  boardsByArea: Record<string, number>;
  boards: BoardSummary[];
  notes: {
    total: number;
    pinned: FleetingDoc[];
    ready: FleetingDoc[];
    recent: FleetingDoc[];
  };
  recentJournal: { slug: string; title: string; date: string | null; mood: string | null }[];
}

// ---- write helpers (all ride the cockpit write envelope: X-Cockpit + JSON) ----

export function patchNoteMeta(
  slug: string,
  patch: Partial<{ pinned: boolean; status: NoteStatus; color: StickyColor | null }>,
) {
  return cockpitWrite<{ ok: true; slug: string; pinned: boolean; status: NoteStatus; color: StickyColor | null }>(
    `/api/cockpit/notes/${encodeURIComponent(slug)}/meta`, 'PATCH', patch,
  );
}

export function createBoard(name: string, area: BoardArea) {
  return cockpitWrite<{ ok: true; slug: string; board: Board }>(
    '/api/cockpit/boards', 'POST', { name, area },
  );
}

export function saveBoard(slug: string, board: Board) {
  return cockpitWrite<{ ok: true; slug: string; board: Board; materialize?: MaterializeResult }>(
    `/api/cockpit/boards/${encodeURIComponent(slug)}`, 'PUT', board,
  );
}

export function deleteBoard(slug: string) {
  return cockpitWrite<{ ok: true; slug: string }>(
    `/api/cockpit/boards/${encodeURIComponent(slug)}`, 'DELETE', undefined,
  );
}

/** DELETE one fleeting note (Feature #10). Path-jailed server-side to
 *  PKM/Fleeting Notes/ ONLY (workbench.deleteWorkbenchDoc). */
export function deleteFleetingNote(slug: string) {
  return cockpitWrite<{ ok: true; slug: string }>(
    `/api/cockpit/fleeting/${encodeURIComponent(slug)}`, 'DELETE', undefined,
  );
}
