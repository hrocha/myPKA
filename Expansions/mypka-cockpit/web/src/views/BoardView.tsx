// BoardView.tsx — the Fleeting-Notes whiteboard v2 (#/board/:slug).
//
// A full-bleed @xyflow/react v12 canvas over the persisted board document.
// NOTES-ONLY: every card is a fleeting-note doc card ("+ Note" creates a real
// note via POST /api/cockpit/notes and drops its card; double-click a card to
// edit the note INLINE with the real outliner). Two structural node kinds sit
// beside the doc cards: 'board' (a nested-board card — double-click navigates
// into it, dropping selected cards onto it MOVES them across boards) and
// 'section' (a labeled frame behind the cards that drags its contents along).
// Legacy 'sticky' nodes are migrated server-side into real notes on read/save;
// a leftover sticky (read-only deployments) renders as a passive text card and
// is passed through on save so the server can finish the migration.
//
// Persistence is whole-document: any change (drag stop, add/remove, recolor,
// rename, section label) debounces ~800ms and PUTs the FULL board back through
// saveBoard(); a quiet save-state indicator reports saved / saving / read-only
// (the 503 'disabled' WriteResult flips the surface into a calm read-only mode
// rather than erroring). Note CONTENT rides its own channel: the in-card
// editor autosaves through useWorkbenchSave (PUT /api/cockpit/notes/:slug)
// exactly like WorkbenchDocView.
//
// ReactFlow discipline (Flow contract): custom nodes are React.memo'd and
// registered in a module-scope nodeTypes object; node dimensions are pre-set
// from the stored w/h (no measurement cycle); the xyflow stylesheet is
// imported HERE inside the lazy chunk and every override in board.css is
// scoped behind `.fnb-canvas` so library styles never bleed. OutlinerEditor
// (TipTap) is lazy-imported so the heavy editor chunk loads only when a card
// actually enters edit mode.
//
// GROUP-DRAG CHOICE (sections): manual containment-at-dragstart rather than
// ReactFlow parentNode/subflows. Subflows switch children to parent-relative
// coordinates, which would leak into the persisted board JSON (the document
// stays layout-free, absolute coords only) and force re-parenting bookkeeping
// on every drag across a frame edge. Instead, onNodeDragStart on a section
// snapshots the nodes fully inside its rect; onNodeDrag translates them by the
// section's delta. Membership is purely geometric and recomputed per drag.
import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeMouseHandler,
  type IsValidConnection,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  Maximize2,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  FileText,
  Frame,
  LayoutDashboard,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { Route } from '../lib/router';
import { hrefFor, navigate } from '../lib/router';
import { WikilinkContextPanel } from '../components/workbench/ContextPanel';
import { useFetch } from '../lib/useCockpit';
import { createWorkbenchDoc } from '../lib/useCockpitWrite';
import { useWorkbenchSave } from '../lib/useWorkbenchSave';
import {
  STICKY_COLORS,
  createBoard,
  deleteBoard,
  saveBoard,
  type Board,
  type BoardEdge,
  type BoardNode,
  type BoardSummary,
  type EdgeDirection,
  type FleetingDoc,
  type StickyColor,
} from '../lib/fleeting';
import './board.css';

// The real note composer, lazy so TipTap/ProseMirror never enter the board
// chunk — it loads the first time a card enters edit mode (same chunk the
// WorkbenchDocView route already shares).
const OutlinerEditorLazy = lazy(() =>
  import('../components/workbench/OutlinerEditor').then((m) => ({ default: m.OutlinerEditor })),
);

interface BoardResponse { ok: boolean; slug: string; board: Board }
interface NotesResponse { ok: boolean; docs: FleetingDoc[] }
interface BoardsResponse { boards: BoardSummary[] }
interface WorkbenchDocResponse { slug: string; title: string; markdown: string; mtime: number }

// ---- node typing ------------------------------------------------------------
// `type` aliases (not interfaces) so the data shapes satisfy the
// Record<string, unknown> constraint on Node<>. No callbacks live in data —
// edit/drop state flows through BoardContext, and nodes mutate themselves via
// useReactFlow().updateNodeData (v12 routes that through onNodesChange as a
// 'replace' change, so the controlled state stays the single source of truth).
type DocData = { slug: string; title: string; color: StickyColor };
type BoardCardData = { boardSlug: string; color: StickyColor };
type SectionData = { label: string; color: StickyColor };
type LegacyStickyData = { text: string; color: StickyColor };
type DocFlowNode = Node<DocData, 'doc'>;
type BoardFlowNode = Node<BoardCardData, 'board'>;
type SectionFlowNode = Node<SectionData, 'section'>;
type StickyFlowNode = Node<LegacyStickyData, 'sticky'>;
type FlowNode = DocFlowNode | BoardFlowNode | SectionFlowNode | StickyFlowNode;

const DEFAULT_SIZE = {
  doc: { w: 220, h: 110 },
  board: { w: 220, h: 120 },
  section: { w: 480, h: 320 },
  sticky: { w: 200, h: 160 },
} as const;

// Server clamps (mirrored here so the NodeResizer never fights the round-trip).
const MIN_W = 120, MIN_H = 80, MAX_W = 1600, MAX_H = 1200;
const MAX_NODES = 500;
const MAX_EDGES = 300;
const MAX_EDGE_NOTE = 2000;
const MAX_SECTION_LABEL = 120;
const EDGE_LABEL_MAX = 40;
const SAVE_DEBOUNCE_MS = 800;
// A doc card grows to at least this when it enters inline-edit mode (the
// editor needs room to be usable; the grown size persists — the board
// remembers the size you worked at; the editor body scrolls beyond it).
const EDIT_MIN_W = 380, EDIT_MIN_H = 300;

// Node ids must satisfy /^[a-zA-Z0-9_-]{1,64}$/ — a dash-stripped UUID does.
function newNodeId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

/** Mirror of the server's deriveTitle: first non-empty line, markers stripped.
 *  Used to live-update a card's title while its note is edited in place. */
function firstLineTitle(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const stripped = t
      .replace(/^[-*+]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/^#+\s+/, '')
      .trim();
    if (stripped) return stripped;
  }
  return '';
}

/** Effective size of a node: pre-set w/h, else v12 measured, else kind default. */
function nodeSize(n: Node): { w: number; h: number } {
  const fallback = DEFAULT_SIZE[(n.type ?? 'doc') as keyof typeof DEFAULT_SIZE] ?? DEFAULT_SIZE.doc;
  return {
    w: n.width ?? n.measured?.width ?? fallback.w,
    h: n.height ?? n.measured?.height ?? fallback.h,
  };
}

// ---- BoardNode <-> FlowNode -------------------------------------------------

function toFlowNodes(boardNodes: BoardNode[]): FlowNode[] {
  return boardNodes.map((bn): FlowNode => {
    const base = {
      id: bn.id,
      position: { x: bn.x, y: bn.y },
      width: bn.w,
      height: bn.h,
    };
    if (bn.kind === 'board') {
      return { ...base, type: 'board', data: { boardSlug: bn.boardSlug ?? '', color: bn.color } };
    }
    if (bn.kind === 'section') {
      // zIndex -1 keeps the frame BEHIND every card (elevateNodesOnSelect is
      // off on the canvas so selecting a section never raises it over cards).
      return { ...base, type: 'section', zIndex: -1, data: { label: bn.label ?? '', color: bn.color } };
    }
    if (bn.kind === 'sticky') {
      // Legacy leftover (write path dormant, so the server could not migrate
      // it yet) — rendered read-only, passed through on save.
      return { ...base, type: 'sticky', data: { text: bn.text ?? '', color: bn.color } };
    }
    return {
      ...base,
      type: 'doc',
      data: { slug: bn.slug ?? '', title: bn.slug ?? 'Untitled', color: bn.color },
    };
  });
}

function toBoardNodes(nodes: FlowNode[]): BoardNode[] {
  return nodes.map((n): BoardNode => {
    const { w, h } = nodeSize(n);
    const common = {
      id: n.id,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      w: Math.round(w),
      h: Math.round(h),
      color: n.data.color,
    };
    switch (n.type) {
      case 'board':
        return { ...common, kind: 'board', boardSlug: (n.data as BoardCardData).boardSlug };
      case 'section':
        return { ...common, kind: 'section', label: (n.data as SectionData).label };
      case 'sticky':
        // Pass-through: the server's save-clean migrates it into a real note.
        return { ...common, kind: 'sticky', text: (n.data as LegacyStickyData).text };
      default:
        return { ...common, kind: 'doc', slug: (n.data as DocData).slug };
    }
  });
}

// ---- BoardEdge -> ReactFlow Edge ---------------------------------------------
// Edges persist only { id, from, to, direction, note } — no handle ids. The
// anchor sides are DERIVED from the two nodes' relative positions at render
// time (Heptabase-style: the edge leaves the nearest side and re-anchors as
// cards move), so the stored document stays layout-free. Edges may touch
// board/section nodes visually; only doc-doc edges materialize into notes
// (the server's materializer ignores everything else).

// Arrowheads inherit their brass tint from board.css (no color here — a CSS
// var() inside a marker id would not survive the url('#…') reference).
const EDGE_MARKER = { type: MarkerType.ArrowClosed, width: 15, height: 15 } as const;

function truncateNote(note: string): string {
  const oneLine = note.replace(/\s*[\r\n]+\s*/g, ' ');
  return oneLine.length > EDGE_LABEL_MAX ? `${oneLine.slice(0, EDGE_LABEL_MAX - 1)}…` : oneLine;
}

/** Pick facing handle sides from the relative position of two node centers. */
function anchorSides(
  a: { x: number; y: number },
  b: { x: number; y: number },
): [string, string] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

// ---- board context --------------------------------------------------------------
// Edit/drop/read-only state shared with the memo'd custom nodes WITHOUT putting
// callbacks into node data (keeps the serialized signature pure). The provider
// value is memoized; it only changes on real state transitions (enter/leave a
// drop target, begin/end edit, read-only flip), so node re-renders stay rare.
interface BoardCtx {
  readOnly: boolean;
  /** The ONE card currently in inline-edit mode (null = none). */
  editingId: string | null;
  beginEdit: (id: string) => void;
  endEdit: () => void;
  /** slug -> name for every existing board (nested-board cards resolve their
   *  title here; a slug not in the map renders as a missing board). */
  boardNames: ReadonlyMap<string, string>;
  /** The board-card node currently hovered by a drag (drop-to-move affordance). */
  dropTargetId: string | null;
  /** Cmd/Ctrl+click on a doc-card head: show this note in the docked context panel. */
  openPreview: (slug: string) => void;
}

const BoardContext = createContext<BoardCtx>({
  readOnly: true,
  editingId: null,
  beginEdit: () => {},
  endEdit: () => {},
  boardNames: new Map(),
  dropTargetId: null,
  openPreview: () => {},
});

// ---- connection handles --------------------------------------------------------
// Four source-type handles per node (ConnectionMode.Loose lets a drag start
// and end on any of them — no overlapping source/target pairs needed). Small
// dots at the side midpoints, revealed on hover/selection via board.css, so
// the card surface itself stays a pure drag target.
const HANDLE_SIDES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
] as const;

const BoardHandles = memo(function BoardHandles({ connectable }: { connectable: boolean }) {
  return (
    <>
      {HANDLE_SIDES.map((h) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={h.position}
          className={connectable ? 'fnb-handle' : 'fnb-handle fnb-handle--off'}
          isConnectable={connectable}
        />
      ))}
    </>
  );
});

// ---- custom nodes -------------------------------------------------------------

// Resize affordance (hit-target fix): NodeResizer renders one positioned div
// per edge ('line' controls) and per corner ('handle' controls). The visible
// affordance stays subtle, but the INTERACTIVE target is widened far past the
// 1px library default via board.css — the `lineClassName`/`handleClassName`
// hooks let .fnb-resize-line / .fnb-resize-handle own a forgiving ~10px grab
// band (edges) and a ~24px corner target (two-axis), with the correct
// per-zone cursor inherited from xyflow's base rules (ns/ew/nwse/nesw-resize).
// Behavior (min/max clamps, the resize delta, persistence through the board
// store) is unchanged — this is purely a hit-area + grip-affordance change.
const resizerProps = {
  minWidth: MIN_W,
  minHeight: MIN_H,
  maxWidth: MAX_W,
  maxHeight: MAX_H,
  lineClassName: 'fnb-resize-line',
  handleClassName: 'fnb-resize-handle',
} as const;

const sectionResizerProps = {
  minWidth: 160,
  minHeight: 120,
  maxWidth: MAX_W,
  maxHeight: MAX_H,
  lineClassName: 'fnb-resize-line',
  handleClassName: 'fnb-resize-handle',
} as const;

// DocNode — a fleeting-note card. Double-click (or the pencil affordance)
// flips it into INLINE EDIT mode: the real outliner renders inside the card
// (nodrag/nowheel container, scrollable body); the Check affordance exits.
// The arrow affordance still opens the note full-screen in the outliner view.
const DocNode = memo(function DocNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as DocData;
  const ctx = useContext(BoardContext);
  const { updateNodeData } = useReactFlow();
  const editing = ctx.editingId === id;

  const open = useCallback(() => {
    if (d.slug) navigate({ name: 'notes-doc', slug: d.slug });
  }, [d.slug]);

  const beginEdit = useCallback(() => {
    if (!ctx.readOnly && d.slug) ctx.beginEdit(id);
  }, [ctx, d.slug, id]);

  // Live title while the note is edited in place (first non-empty line —
  // matches the server's deriveTitle, so the card never flashes a stale name).
  const onLiveTitle = useCallback(
    (title: string) => updateNodeData(id, { title }),
    [id, updateNodeData],
  );

  // Cmd/Ctrl+left-click on the card head opens the note in the docked context
  // panel (the same surface the Workbench editor uses) — bridged through
  // BoardContext like every other node callback. NATIVE listeners, not React
  // props: ReactFlow's drag (d3) and the Meta/Ctrl multi-selection both
  // consume the raw mousedown on the node wrapper BEFORE React's
  // root-delegated handlers run, so only a native stopPropagation on the head
  // itself keeps a modified click from starting a drag / toggling selection.
  // Clicks on the head's action buttons are exempt (they keep their meaning).
  const headRef = useRef<HTMLDivElement | null>(null);
  const { openPreview } = ctx;
  const slug = d.slug;
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const modified = (e: MouseEvent) =>
      (e.metaKey || e.ctrlKey) && e.button === 0 && !(e.target as Element).closest('button');
    const swallow = (e: MouseEvent) => {
      if (!modified(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      if (!modified(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (slug) openPreview(slug);
    };
    el.addEventListener('mousedown', swallow);
    el.addEventListener('dblclick', swallow); // a fast second click must not enter edit mode
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('mousedown', swallow);
      el.removeEventListener('dblclick', swallow);
      el.removeEventListener('click', onClick);
    };
  }, [openPreview, slug]);

  return (
    <div
      className={editing ? 'fnb-doc fnb-doc--editing' : 'fnb-doc'}
      data-tint={d.color}
      onDoubleClick={editing ? undefined : beginEdit}
    >
      <NodeResizer {...resizerProps} isVisible={!!selected && !ctx.readOnly} />
      <BoardHandles connectable={!ctx.readOnly} />
      <div className="fnb-doc-head" ref={headRef}>
        <span className="fnb-doc-glyph"><FileText size={14} strokeWidth={1.5} aria-hidden="true" /></span>
        <span className="fnb-doc-title">{d.title}</span>
        {editing ? (
          <button
            type="button"
            className="fnb-node-action fnb-doc-done nodrag"
            aria-label={`Done editing: ${d.title}`}
            title="Done (saves automatically)"
            onClick={ctx.endEdit}
          >
            <Check size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        ) : (
          <>
            {!ctx.readOnly && (
              <button
                type="button"
                className="fnb-node-action nodrag"
                aria-label={`Edit note in place: ${d.title}`}
                title="Edit in place"
                onClick={beginEdit}
              >
                <Pencil size={13} strokeWidth={1.5} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="fnb-node-action fnb-node-action--open nodrag"
              aria-label={`Open note: ${d.title}`}
              title="Open note"
              onClick={open}
            >
              <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {editing && <DocCardEditor slug={d.slug} onLiveTitle={onLiveTitle} />}
    </div>
  );
});

// The in-card note composer: fetches the note fresh (current mtime = the
// optimistic-concurrency base), then mounts the REAL outliner wired to the
// same debounced autosave hook WorkbenchDocView uses. Unmounting (Done /
// switching cards / leaving the board) flushes any pending edit.
function DocCardEditor({ slug, onLiveTitle }: { slug: string; onLiveTitle: (t: string) => void }) {
  const { data, loading, error } = useFetch<WorkbenchDocResponse>(
    `/api/cockpit/notes/${encodeURIComponent(slug)}`,
  );
  if (loading) {
    return (
      <div className="fnb-doc-editor nodrag nowheel" aria-busy="true">
        <div className="skeleton-block" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="fnb-doc-editor nodrag nowheel">
        <p className="fnb-doc-editor-err" role="alert">Could not load the note. {error ?? ''}</p>
      </div>
    );
  }
  return <DocCardEditorInner doc={data} onLiveTitle={onLiveTitle} />;
}

function DocCardEditorInner({
  doc,
  onLiveTitle,
}: {
  doc: WorkbenchDocResponse;
  onLiveTitle: (t: string) => void;
}) {
  const { status, onChange, flush, overwrite } = useWorkbenchSave(doc.slug, doc.mtime);

  // 503 = the write path is dormant — flip the composer read-only, calmly.
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  useEffect(() => {
    if (status.kind === 'disabled') setForcedReadOnly(true);
  }, [status.kind]);

  // Flush a debounced-but-unsent edit when the editor unmounts (Done button,
  // card moved to another board, board navigation) — same discipline as
  // WorkbenchDocView's unmount flush.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => { void flushRef.current(); }, []);

  const onLiveTitleRef = useRef(onLiveTitle);
  onLiveTitleRef.current = onLiveTitle;

  const handleChange = useCallback(
    (md: string) => {
      onChange(md);
      const t = firstLineTitle(md);
      if (t) onLiveTitleRef.current(t);
    },
    [onChange],
  );

  const statusWord =
    forcedReadOnly ? 'Read-only — saving is disabled'
    : status.kind === 'saving' ? 'Saving…'
    : status.kind === 'saved' ? 'Saved'
    : status.kind === 'conflict' ? 'Changed on disk'
    : status.kind === 'error' ? status.message
    : '';

  return (
    <div className="fnb-doc-editor nodrag nowheel">
      <Suspense fallback={<div className="skeleton-block" />}>
        <OutlinerEditorLazy
          slug={doc.slug}
          initialMarkdown={doc.markdown ?? ''}
          editable={!forcedReadOnly}
          onChange={handleChange}
        />
      </Suspense>
      {statusWord && (
        <div className="fnb-doc-editor-status" role="status" data-state={status.kind}>
          {statusWord}
          {status.kind === 'conflict' && (
            <button type="button" className="fnb-btn" onClick={() => void overwrite()}>
              Overwrite
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// BoardCardNode — a nested-board card. Double-click navigates into the board;
// dropping a selection of cards onto it MOVES them to that board (the canvas'
// onNodeDragStop owns the hit-test; this node only renders the target glow).
// A dangling boardSlug (target board deleted) renders as missing — kept on the
// canvas so the reference is visible, never navigated.
const BoardCardNode = memo(function BoardCardNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as BoardCardData;
  const ctx = useContext(BoardContext);
  const name = ctx.boardNames.get(d.boardSlug);
  const missing = name === undefined;

  const open = useCallback(() => {
    if (d.boardSlug) navigate({ name: 'board', slug: d.boardSlug });
  }, [d.boardSlug]);

  const cls = ['fnb-boardcard'];
  if (missing) cls.push('fnb-boardcard--missing');
  if (ctx.dropTargetId === id) cls.push('fnb-boardcard--target');

  return (
    <div className={cls.join(' ')} data-tint={d.color} onDoubleClick={missing ? undefined : open}>
      <NodeResizer {...resizerProps} isVisible={!!selected && !ctx.readOnly} />
      <BoardHandles connectable={!ctx.readOnly} />
      <div className="fnb-doc-head">
        <span className="fnb-doc-glyph"><LayoutDashboard size={14} strokeWidth={1.5} aria-hidden="true" /></span>
        <span className="fnb-doc-title">{name ?? d.boardSlug}</span>
        {!missing && (
          <button
            type="button"
            className="fnb-node-action fnb-node-action--open nodrag"
            aria-label={`Open board: ${name}`}
            title="Open board"
            onClick={open}
          >
            <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
      <span className="fnb-boardcard-hint">
        {missing ? 'Missing board' : 'Board — drop cards here to move them'}
      </span>
    </div>
  );
});

// SectionNode — a labeled frame drawn BEHIND the cards (zIndex -1). Selectable
// and resizable; double-click the label to rename inline. Dragging the frame
// moves every node fully inside it (manual group-drag — see the header note).
const SectionNode = memo(function SectionNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as SectionData;
  const ctx = useContext(BoardContext);
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const begin = useCallback(() => {
    if (ctx.readOnly) return;
    setDraft(d.label);
    setEditing(true);
  }, [ctx.readOnly, d.label]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim().slice(0, MAX_SECTION_LABEL);
    if (next !== d.label) updateNodeData(id, { label: next });
  }, [draft, d.label, id, updateNodeData]);

  return (
    <div className="fnb-section" data-tint={d.color}>
      <NodeResizer {...sectionResizerProps} isVisible={!!selected && !ctx.readOnly} />
      <BoardHandles connectable={!ctx.readOnly} />
      {editing ? (
        <input
          ref={inputRef}
          className="fnb-section-label-input nodrag"
          value={draft}
          maxLength={MAX_SECTION_LABEL}
          aria-label="Section label"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
              setDraft(d.label);
            }
          }}
        />
      ) : (
        <div
          className="fnb-section-label"
          onDoubleClick={begin}
          title={ctx.readOnly ? undefined : 'Double-click to rename'}
        >
          {d.label || <span className="fnb-section-label-empty">Section</span>}
        </div>
      )}
    </div>
  );
});

// LegacyStickyNode — read-only leftover. Only visible when the server could
// not migrate (write path dormant); the text is preserved and passed through
// on save so the migration completes the moment writes are enabled.
const LegacyStickyNode = memo(function LegacyStickyNode({ data }: NodeProps) {
  const d = data as unknown as LegacyStickyData;
  return (
    <div
      className="fnb-sticky"
      data-tint={d.color}
      title="Legacy sticky — becomes a real note once saving is enabled"
    >
      <div className="fnb-sticky-text">{d.text}</div>
    </div>
  );
});

// Module-scope nodeTypes — never inline (a fresh object each render would force
// ReactFlow to re-init every node).
const nodeTypes: NodeTypes = {
  doc: DocNode,
  board: BoardCardNode,
  section: SectionNode,
  sticky: LegacyStickyNode,
};

// ---- the view -----------------------------------------------------------------

export function BoardView({ route }: { route: Extract<Route, { name: 'board' }> }) {
  const { data, loading, error } = useFetch<BoardResponse>(
    `/api/cockpit/boards/${encodeURIComponent(route.slug)}`,
  );
  const { data: notesData } = useFetch<NotesResponse>('/api/cockpit/notes');
  // Board list: nested-board cards resolve their names (and existence) here.
  const { data: boardsData } = useFetch<BoardsResponse>('/api/cockpit/boards');

  if (loading) {
    return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  }
  if (error || !data?.board) {
    return (
      <div role="alert" className="view-error">
        This whiteboard could not load. {error || ''}{' '}
        <a href={hrefFor({ name: 'notes' })}>Back to Fleeting Notes</a>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      {/* key re-mounts the canvas (and its local state) when the slug changes */}
      <BoardCanvas
        key={route.slug}
        slug={route.slug}
        board={data.board}
        docs={notesData?.docs ?? []}
        boards={boardsData?.boards ?? []}
      />
    </ReactFlowProvider>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface GroupDrag {
  sectionId: string;
  origin: { x: number; y: number };
  members: Map<string, { x: number; y: number }>;
}

function BoardCanvas({
  slug,
  board,
  docs,
  boards,
}: {
  slug: string;
  board: Board;
  docs: FleetingDoc[];
  boards: BoardSummary[];
}) {
  const [initialNodes] = useState<FlowNode[]>(() => toFlowNodes(board.nodes));
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialNodes);
  // Edges: the persisted BoardEdge[] is the single source of truth; the
  // ReactFlow Edge[] is DERIVED each render (anchor sides follow node
  // positions). Selection lives beside it so deriving never wipes it.
  const [bEdges, setBEdges] = useState<BoardEdge[]>(() => board.edges ?? []);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(() => new Set());
  // Double-click-an-edge popover: which edge + where (canvas-relative px).
  const [edgeDialog, setEdgeDialog] = useState<{ id: string; x: number; y: number } | null>(null);
  const [edgeNoteDraft, setEdgeNoteDraft] = useState('');
  const [name, setName] = useState(board.name);
  const [readOnly, setReadOnly] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Wikilink-materialization report from the last save ("saved · 2 notes
  // linked") — shown briefly beside the save word, then cleared.
  const [matInfo, setMatInfo] = useState<{ updated: number; failed: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Inline note edit: the ONE card currently hosting the composer.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  // "+ Board" popover (inline name input).
  const [boardPopOpen, setBoardPopOpen] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [creatingBoard, setCreatingBoard] = useState(false);
  // Boards created from THIS canvas (names known before the list refetches).
  const [extraBoardNames, setExtraBoardNames] = useState<ReadonlyMap<string, string>>(new Map());
  // The board card a drag currently hovers (drop-to-move affordance).
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Cmd/Ctrl+click note preview: the note shown in the docked context panel
  // (null = closed). Wikilink clicks INSIDE the panel hop the slug along.
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const boardPopRef = useRef<HTMLDivElement | null>(null);
  const edgeDialogRef = useRef<HTMLDivElement | null>(null);
  const groupDragRef = useRef<GroupDrag | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  // Latest-state refs for the imperative drag handlers (avoid re-binding the
  // ReactFlow handlers on every node move).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const bEdgesRef = useRef(bEdges);
  bEdgesRef.current = bEdges;

  // ---- board names (nested-board cards) -------------------------------------
  const boardNames = useMemo<ReadonlyMap<string, string>>(() => {
    const m = new Map<string, string>();
    for (const b of boards) m.set(b.slug, b.name);
    for (const [k, v] of extraBoardNames) m.set(k, v);
    return m;
  }, [boards, extraBoardNames]);

  // ---- doc titles: look up from the notes list once it arrives --------------
  useEffect(() => {
    if (docs.length === 0) return;
    const titles = new Map(docs.map((d) => [d.slug, d.title]));
    setNodes((ns) => {
      let changed = false;
      const next = ns.map((n): FlowNode => {
        if (n.type !== 'doc') return n;
        const d = n.data as DocData;
        const title = titles.get(d.slug);
        if (!title || title === d.title) return n;
        changed = true;
        return { ...n, data: { ...d, title } };
      });
      return changed ? next : ns;
    });
  }, [docs, setNodes]);

  // ---- inline edit (one card at a time) --------------------------------------
  const beginEdit = useCallback(
    (id: string) => {
      if (readOnly) return;
      setEditingId(id);
      // Grow the card to a workable composer size (kept after exit; the
      // editor body scrolls beyond it).
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id
            ? ({
                ...n,
                width: Math.max(n.width ?? n.measured?.width ?? 0, EDIT_MIN_W),
                height: Math.max(n.height ?? n.measured?.height ?? 0, EDIT_MIN_H),
              } as FlowNode)
            : n,
        ),
      );
    },
    [readOnly, setNodes],
  );
  const endEdit = useCallback(() => setEditingId(null), []);

  // Read-only kills an in-flight edit session (the composer flushes on unmount).
  useEffect(() => {
    if (readOnly) setEditingId(null);
  }, [readOnly]);

  // ---- Cmd/Ctrl+click note preview (docked context panel) --------------------
  const openPreview = useCallback((s: string) => setPreviewSlug(s), []);
  const closePreview = useCallback(() => setPreviewSlug(null), []);

  // Esc closes the panel from anywhere on the board (the panel's own handler
  // covers focus-inside; this window listener covers canvas focus). Handlers
  // that own their Escape — section-label input, edge dialog, the panel itself
  // — stopPropagation at the React root, so the event never reaches here.
  useEffect(() => {
    if (previewSlug === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewSlug, closePreview]);

  const boardCtx = useMemo<BoardCtx>(
    () => ({ readOnly, editingId, beginEdit, endEdit, boardNames, dropTargetId, openPreview }),
    [readOnly, editingId, beginEdit, endEdit, boardNames, dropTargetId, openPreview],
  );

  // ---- edges: derive ReactFlow edges from the persisted shape -----------------
  const flowEdges = useMemo<Edge[]>(() => {
    const centers = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      const s = nodeSize(n);
      centers.set(n.id, { x: n.position.x + s.w / 2, y: n.position.y + s.h / 2 });
    }
    const out: Edge[] = [];
    for (const e of bEdges) {
      const a = centers.get(e.from);
      const b = centers.get(e.to);
      if (!a || !b) continue; // dangling (endpoint just deleted) — server drops it too
      const [sourceHandle, targetHandle] = anchorSides(a, b);
      out.push({
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle,
        targetHandle,
        type: 'default', // bezier
        selected: selectedEdgeIds.has(e.id),
        selectable: !readOnly,
        focusable: !readOnly,
        label: e.note ? truncateNote(e.note) : undefined,
        markerEnd: EDGE_MARKER,
        ...(e.direction === 'both' ? { markerStart: EDGE_MARKER } : {}),
      });
    }
    return out;
  }, [nodes, bEdges, selectedEdgeIds, readOnly]);

  // Selection + removal flow back into the persisted shape; everything else
  // (the derived anchors) is recomputed, so no other change type applies.
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'remove') {
        setBEdges((es) => es.filter((e) => e.id !== ch.id));
        setSelectedEdgeIds((sel) => {
          if (!sel.has(ch.id)) return sel;
          const next = new Set(sel);
          next.delete(ch.id);
          return next;
        });
        setEdgeDialog((d) => (d?.id === ch.id ? null : d));
      } else if (ch.type === 'select') {
        setSelectedEdgeIds((sel) => {
          if (sel.has(ch.id) === ch.selected) return sel;
          const next = new Set(sel);
          if (ch.selected) next.add(ch.id);
          else next.delete(ch.id);
          return next;
        });
      }
    }
  }, []);

  const isValidConnection = useCallback<IsValidConnection>(
    (c) => !!c.source && !!c.target && c.source !== c.target,
    [],
  );

  const onConnect = useCallback((conn: Connection) => {
    const { source, target } = conn;
    if (!source || !target || source === target) return;
    setBEdges((es) => {
      if (es.length >= MAX_EDGES) return es;
      // One edge per unordered pair — mirror the server's duplicate-pair drop.
      if (es.some((e) => (e.from === source && e.to === target) || (e.from === target && e.to === source))) {
        return es;
      }
      return [...es, { id: newNodeId(), from: source, to: target, direction: 'one', note: '' }];
    });
  }, []);

  // ---- edge dialog (double-click an edge) -------------------------------------
  const dialogEdge = edgeDialog ? bEdges.find((e) => e.id === edgeDialog.id) ?? null : null;

  const onEdgeDoubleClick = useCallback<EdgeMouseHandler>(
    (event, edge) => {
      if (readOnly) return;
      const current = bEdges.find((e) => e.id === edge.id);
      if (!current) return;
      const r = wrapRef.current?.getBoundingClientRect();
      const x = Math.max(8, Math.min((r ? event.clientX - r.left : 80), (r?.width ?? 600) - 268));
      const y = Math.max(8, Math.min((r ? event.clientY - r.top : 80), (r?.height ?? 400) - 220));
      setEdgeNoteDraft(current.note);
      setEdgeDialog({ id: edge.id, x, y });
    },
    [readOnly, bEdges],
  );

  const closeEdgeDialog = useCallback(() => setEdgeDialog(null), []);

  const commitEdgeNote = useCallback(() => {
    if (!edgeDialog) return;
    const note = edgeNoteDraft.trim().slice(0, MAX_EDGE_NOTE);
    setBEdges((es) => es.map((e) => (e.id === edgeDialog.id && e.note !== note ? { ...e, note } : e)));
  }, [edgeDialog, edgeNoteDraft]);

  const setEdgeDirection = useCallback(
    (direction: EdgeDirection) => {
      if (!edgeDialog) return;
      setBEdges((es) => es.map((e) => (e.id === edgeDialog.id ? { ...e, direction } : e)));
    },
    [edgeDialog],
  );

  const deleteDialogEdge = useCallback(() => {
    if (!edgeDialog) return;
    setBEdges((es) => es.filter((e) => e.id !== edgeDialog.id));
    setEdgeDialog(null);
  }, [edgeDialog]);

  // Close the edge dialog on an outside click (the textarea's blur has already
  // committed the note by the time the dialog unmounts).
  useEffect(() => {
    if (!edgeDialog) return;
    const onDown = (e: MouseEvent) => {
      if (!edgeDialogRef.current?.contains(e.target as globalThis.Node)) setEdgeDialog(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [edgeDialog]);

  // ---- debounced whole-document persistence ----------------------------------
  // Signature = the serialized board (positions/sizes/labels/colors + name +
  // edges); selection toggles and mount-time measurements never change it, so
  // they never trigger a PUT. Any real change reschedules the 800ms debounce.
  // NOTE CONTENT is deliberately absent — it rides PUT /api/cockpit/notes/:slug
  // via the in-card composer's own autosave.
  const boardNodes = useMemo(() => toBoardNodes(nodes), [nodes]);
  const sig = useMemo(
    () => JSON.stringify({ name, nodes: boardNodes, edges: bEdges }),
    [name, boardNodes, bEdges],
  );

  const sigRef = useRef<string | null>(null);
  if (sigRef.current === null) sigRef.current = sig; // the loaded state is "saved"
  const seqRef = useRef(0);
  const readOnlyRef = useRef(false);
  readOnlyRef.current = readOnly;
  const latestRef = useRef<{ sig: string; board: Board }>({ sig, board });
  latestRef.current = { sig, board: { name, area: board.area, nodes: boardNodes, edges: bEdges } };

  useEffect(() => {
    if (readOnly) return;
    if (sig === sigRef.current) return;
    setSaveState('saving');
    const seq = ++seqRef.current;
    const payload: Board = { name, area: board.area, nodes: boardNodes, edges: bEdges };
    const timer = window.setTimeout(() => {
      void (async () => {
        const res = await saveBoard(slug, payload);
        if (seq !== seqRef.current) return; // superseded by a newer edit
        if (res.kind === 'ok') {
          sigRef.current = sig;
          setSaveState('saved');
          const m = res.data.materialize;
          setMatInfo(
            m && (m.updated.length > 0 || m.failed.length > 0)
              ? { updated: m.updated.length, failed: m.failed.length }
              : null,
          );
        } else if (res.kind === 'disabled') {
          setReadOnly(true);
          setSaveState('idle');
        } else {
          setSaveState('error');
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sig, name, boardNodes, bEdges, slug, board.area, readOnly]);

  // The materialize note is transient — fade it from the status line after a
  // few seconds so the toolbar returns to its quiet "Saved".
  useEffect(() => {
    if (!matInfo) return;
    const t = window.setTimeout(() => setMatInfo(null), 6000);
    return () => window.clearTimeout(t);
  }, [matInfo]);

  // Flush a still-pending change when the view unmounts (fire-and-forget).
  useEffect(
    () => () => {
      const latest = latestRef.current;
      if (!readOnlyRef.current && latest.sig !== sigRef.current) {
        void saveBoard(slug, latest.board);
      }
    },
    [slug],
  );

  // ---- toolbar actions --------------------------------------------------------
  const canvasCenter = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    return screenToFlowPosition({
      x: (r?.left ?? 0) + (r?.width ?? 800) / 2,
      y: (r?.top ?? 0) + (r?.height ?? 500) / 2,
    });
  }, [screenToFlowPosition]);

  const jitter = () => Math.round((Math.random() - 0.5) * 120);
  const atCapacity = nodes.length >= MAX_NODES;

  const spawnNode = useCallback(
    (node: FlowNode) => {
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false }) as FlowNode), node]);
    },
    [setNodes],
  );

  // "+ Note": create a REAL fleeting note (default title, timestamp suffix on
  // collision) and drop its doc card at the canvas center.
  const addNewNote = useCallback(async () => {
    if (readOnly || creatingNote || nodesRef.current.length >= MAX_NODES) return;
    setCreatingNote(true);
    try {
      let res = await createWorkbenchDoc('Untitled');
      if (res.kind === 'conflict') {
        const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
        res = await createWorkbenchDoc(`Untitled ${stamp}`);
      }
      if (res.kind === 'disabled') {
        setReadOnly(true);
        return;
      }
      if (res.kind !== 'ok') {
        setSaveState('error');
        return;
      }
      const c = canvasCenter();
      const node: DocFlowNode = {
        id: newNodeId(),
        type: 'doc',
        position: {
          x: c.x - DEFAULT_SIZE.doc.w / 2 + jitter(),
          y: c.y - DEFAULT_SIZE.doc.h / 2 + jitter(),
        },
        width: DEFAULT_SIZE.doc.w,
        height: DEFAULT_SIZE.doc.h,
        data: { slug: res.data.slug, title: res.data.title || 'Untitled', color: 'paper' },
        selected: true,
      };
      spawnNode(node);
    } finally {
      setCreatingNote(false);
    }
  }, [readOnly, creatingNote, canvasCenter, spawnNode]);

  // "+ Existing note": the picker over notes not yet on the board.
  const addDocNode = useCallback(
    (doc: FleetingDoc) => {
      if (readOnly || nodesRef.current.length >= MAX_NODES) return;
      const c = canvasCenter();
      const node: DocFlowNode = {
        id: newNodeId(),
        type: 'doc',
        position: {
          x: c.x - DEFAULT_SIZE.doc.w / 2 + jitter(),
          y: c.y - DEFAULT_SIZE.doc.h / 2 + jitter(),
        },
        width: DEFAULT_SIZE.doc.w,
        height: DEFAULT_SIZE.doc.h,
        data: { slug: doc.slug, title: doc.title || doc.slug, color: doc.color ?? 'paper' },
        selected: true,
      };
      spawnNode(node);
      setPickerOpen(false);
    },
    [readOnly, canvasCenter, spawnNode],
  );

  // "+ Board": create a board through the existing helper and drop its card.
  const addBoardCard = useCallback(
    (boardSlug: string, knownName?: string) => {
      if (knownName !== undefined) {
        setExtraBoardNames((m) => {
          const next = new Map(m);
          next.set(boardSlug, knownName);
          return next;
        });
      }
      const c = canvasCenter();
      const node: BoardFlowNode = {
        id: newNodeId(),
        type: 'board',
        position: {
          x: c.x - DEFAULT_SIZE.board.w / 2 + jitter(),
          y: c.y - DEFAULT_SIZE.board.h / 2 + jitter(),
        },
        width: DEFAULT_SIZE.board.w,
        height: DEFAULT_SIZE.board.h,
        data: { boardSlug, color: 'paper' },
        selected: true,
      };
      spawnNode(node);
    },
    [canvasCenter, spawnNode],
  );

  const doCreateBoard = useCallback(async () => {
    const newName = newBoardName.trim();
    if (!newName || creatingBoard || nodesRef.current.length >= MAX_NODES) return;
    setCreatingBoard(true);
    try {
      const res = await createBoard(newName, board.area);
      if (res.kind === 'ok') {
        addBoardCard(res.data.slug, res.data.board.name);
      } else if (res.kind === 'conflict' && res.existingSlug) {
        // A board with that name already exists — link it instead of erroring.
        addBoardCard(res.existingSlug);
      } else if (res.kind === 'disabled') {
        setReadOnly(true);
        return;
      } else {
        setSaveState('error');
        return;
      }
      setNewBoardName('');
      setBoardPopOpen(false);
    } finally {
      setCreatingBoard(false);
    }
  }, [newBoardName, creatingBoard, board.area, addBoardCard]);

  // ---- sections ----------------------------------------------------------------
  const selCardCount = nodes.reduce(
    (acc, n) => acc + (n.selected && n.type !== 'section' ? 1 : 0),
    0,
  );

  const createSection = useCallback(() => {
    if (readOnly || nodesRef.current.length >= MAX_NODES) return;
    const sel = nodesRef.current.filter((n) => n.selected && n.type !== 'section');
    if (sel.length < 2) return;
    const PAD = 28;
    const LABEL_ROOM = 34; // headroom so the label never overlaps the top card
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of sel) {
      const s = nodeSize(n);
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + s.w);
      maxY = Math.max(maxY, n.position.y + s.h);
    }
    const node: SectionFlowNode = {
      id: newNodeId(),
      type: 'section',
      position: { x: Math.round(minX - PAD), y: Math.round(minY - PAD - LABEL_ROOM) },
      width: Math.min(MAX_W, Math.round(maxX - minX + PAD * 2)),
      height: Math.min(MAX_H, Math.round(maxY - minY + PAD * 2 + LABEL_ROOM)),
      zIndex: -1,
      data: { label: '', color: 'paper' },
      selected: false,
    };
    setNodes((ns) => [node, ...ns]);
  }, [readOnly, setNodes]);

  // ---- drag orchestration ------------------------------------------------------
  // (a) manual section group-drag, (b) drop-cards-onto-a-board-card moves.

  /** Board-card under the dragged node's center (drop-to-move target), or null. */
  const findBoardDropTarget = useCallback((node: Node, dragged: Node[]): FlowNode | null => {
    if (node.type === 'section') return null; // a section drag is a group drag
    const draggedIds = new Set(dragged.map((n) => n.id));
    const s = nodeSize(node);
    const cx = node.position.x + s.w / 2;
    const cy = node.position.y + s.h / 2;
    for (const n of nodesRef.current) {
      if (n.type !== 'board' || draggedIds.has(n.id)) continue;
      const t = nodeSize(n);
      if (
        cx >= n.position.x && cx <= n.position.x + t.w &&
        cy >= n.position.y && cy <= n.position.y + t.h
      ) {
        return n;
      }
    }
    return null;
  }, []);

  const onNodeDragStart = useCallback<OnNodeDrag<FlowNode>>(
    (_e, node, dragged) => {
      groupDragRef.current = null;
      if (node.type !== 'section' || readOnly) return;
      // Containment is computed ONCE at dragstart: nodes fully inside the
      // frame ride along. Anything ReactFlow drags itself (the selection) is
      // excluded so it never double-moves; nested sections never chain.
      const draggedIds = new Set(dragged.map((n) => n.id));
      const { w, h } = nodeSize(node);
      const x0 = node.position.x;
      const y0 = node.position.y;
      const members = new Map<string, { x: number; y: number }>();
      for (const n of nodesRef.current) {
        if (n.id === node.id || n.type === 'section' || draggedIds.has(n.id)) continue;
        const s = nodeSize(n);
        if (
          n.position.x >= x0 && n.position.y >= y0 &&
          n.position.x + s.w <= x0 + w && n.position.y + s.h <= y0 + h
        ) {
          members.set(n.id, { ...n.position });
        }
      }
      if (members.size > 0) {
        groupDragRef.current = { sectionId: node.id, origin: { x: x0, y: y0 }, members };
      }
    },
    [readOnly],
  );

  const onNodeDrag = useCallback<OnNodeDrag<FlowNode>>(
    (_e, node, dragged) => {
      const g = groupDragRef.current;
      if (g && node.id === g.sectionId) {
        const dx = node.position.x - g.origin.x;
        const dy = node.position.y - g.origin.y;
        setNodes((ns) =>
          ns.map((n) => {
            const start = g.members.get(n.id);
            return start
              ? ({ ...n, position: { x: start.x + dx, y: start.y + dy } } as FlowNode)
              : n;
          }),
        );
      }
      const target = readOnly ? null : findBoardDropTarget(node, dragged);
      setDropTargetId((cur) => {
        const next = target?.id ?? null;
        return cur === next ? cur : next;
      });
    },
    [readOnly, setNodes, findBoardDropTarget],
  );

  // Move the dropped selection into the target board: GET its live document,
  // append the nodes (re-id'd, parked below its lowest node with internal
  // offsets preserved) plus the doc-doc edges whose BOTH endpoints moved, PUT
  // it back, then remove the moved nodes (and every edge touching them) from
  // THIS board — the debounced whole-document save persists the removal.
  const moveNodesToBoard = useCallback(
    async (targetSlug: string, moved: FlowNode[]) => {
      setSaveState('saving');
      let target: Board | null = null;
      try {
        const res = await fetch(`/api/cockpit/boards/${encodeURIComponent(targetSlug)}`, {
          credentials: 'same-origin',
        });
        if (res.ok) {
          const json = (await res.json()) as { ok?: boolean; board?: Board };
          target = json.board ?? null;
        }
      } catch {
        /* handled below */
      }
      if (!target || target.nodes.length + moved.length > MAX_NODES) {
        setSaveState('error');
        return;
      }

      const idMap = new Map(moved.map((n) => [n.id, newNodeId()]));
      const movedIds = new Set(moved.map((n) => n.id));
      const baseY = target.nodes.length > 0
        ? Math.max(...target.nodes.map((n) => n.y + n.h)) + 60
        : 80;
      const minX = Math.round(Math.min(...moved.map((n) => n.position.x)));
      const minY = Math.round(Math.min(...moved.map((n) => n.position.y)));
      const movedBoardNodes = toBoardNodes(moved).map((bn) => ({
        ...bn,
        id: idMap.get(bn.id) as string,
        x: 80 + (bn.x - minX),
        y: baseY + (bn.y - minY),
      }));
      const docIds = new Set(moved.filter((n) => n.type === 'doc').map((n) => n.id));
      const movedEdges = bEdgesRef.current
        .filter((e) => docIds.has(e.from) && docIds.has(e.to))
        .map((e) => ({
          ...e,
          id: newNodeId(),
          from: idMap.get(e.from) as string,
          to: idMap.get(e.to) as string,
        }));

      const put = await saveBoard(targetSlug, {
        name: target.name,
        area: target.area,
        nodes: [...target.nodes, ...movedBoardNodes],
        edges: [...(target.edges ?? []), ...movedEdges],
      });
      if (put.kind === 'disabled') {
        setReadOnly(true);
        return;
      }
      if (put.kind !== 'ok') {
        setSaveState('error');
        return;
      }

      setNodes((ns) => ns.filter((n) => !movedIds.has(n.id)));
      setBEdges((es) => es.filter((e) => !movedIds.has(e.from) && !movedIds.has(e.to)));
      setSelectedEdgeIds(new Set());
      setEditingId((cur) => (cur !== null && movedIds.has(cur) ? null : cur));
      setSaveState('saved');
    },
    [setNodes],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<FlowNode>>(
    (_e, node, dragged) => {
      groupDragRef.current = null;
      setDropTargetId(null);
      if (readOnly) return;
      const target = findBoardDropTarget(node, dragged);
      if (!target) return;
      const targetSlug = (target.data as BoardCardData).boardSlug;
      // No self-moves, no moves into a missing (dangling) board.
      if (!targetSlug || targetSlug === slug || !boardNames.has(targetSlug)) return;
      const moved = dragged.filter(
        (n) => n.type !== 'section' && n.id !== target.id,
      ) as FlowNode[];
      if (moved.length === 0) return;
      void moveNodesToBoard(targetSlug, moved);
    },
    [readOnly, findBoardDropTarget, slug, boardNames, moveNodesToBoard],
  );

  // ---- selection / color / delete ----------------------------------------------
  const selectedCount = nodes.reduce((acc, n) => acc + (n.selected ? 1 : 0), 0);
  const deleteCount = selectedCount + selectedEdgeIds.size;

  const applyColor = useCallback(
    (color: StickyColor) => {
      setNodes((ns) =>
        ns.map((n): FlowNode => (n.selected ? ({ ...n, data: { ...n.data, color } } as FlowNode) : n)),
      );
    },
    [setNodes],
  );

  const deleteSelected = useCallback(() => {
    const removedNodeIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    setNodes((ns) => ns.filter((n) => !n.selected));
    // Deleting a card also deletes its edges (the server's dangling-edge drop,
    // mirrored locally so the canvas never shows a ghost edge for 800ms).
    setBEdges((es) =>
      es.filter(
        (e) => !selectedEdgeIds.has(e.id) && !removedNodeIds.has(e.from) && !removedNodeIds.has(e.to),
      ),
    );
    setSelectedEdgeIds(new Set());
    setEdgeDialog(null);
    setEditingId((cur) => (cur !== null && removedNodeIds.has(cur) ? null : cur));
  }, [nodes, selectedEdgeIds, setNodes]);

  const doDeleteBoard = useCallback(async () => {
    setDeleting(true);
    const res = await deleteBoard(slug);
    if (res.kind === 'ok') {
      sigRef.current = latestRef.current.sig; // nothing left to flush
      navigate({ name: 'notes' });
      return;
    }
    setDeleting(false);
    setConfirmingDelete(false);
    if (res.kind === 'disabled') setReadOnly(true);
    else setSaveState('error');
  }, [slug]);

  // Close the note picker / board popover on an outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      // globalThis.Node: the DOM Node — the bare name is shadowed by xyflow's Node type.
      if (!pickerRef.current?.contains(e.target as globalThis.Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  useEffect(() => {
    if (!boardPopOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!boardPopRef.current?.contains(e.target as globalThis.Node)) setBoardPopOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [boardPopOpen]);

  // Notes not yet on the board (for the "+ Existing note" picker).
  const onBoardSlugs = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) if (n.type === 'doc') s.add((n.data as DocData).slug);
    return s;
  }, [nodes]);
  const availableDocs = useMemo(
    () => docs.filter((d) => !onBoardSlugs.has(d.slug)),
    [docs, onBoardSlugs],
  );

  const saveLabel =
    saveState === 'saving' ? 'Saving…'
    : saveState === 'saved' ? 'Saved'
    : saveState === 'error' ? 'Couldn’t save — your next change retries'
    : '';

  // Browser-native fullscreen on the whole board surface.
  const toggleFullscreen = () => {
    const el = document.querySelector('.fnb-board');
    if (!document.fullscreenElement && el) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  return (
    <div className="fnb-board">
      <header className="fnb-toolbar">
        <button
          type="button"
          className="fnb-back"
          onClick={toggleFullscreen}
          aria-label="Toggle fullscreen"
          title="Fullscreen"
        >
          <Maximize2 size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <a
          className="fnb-back"
          href={hrefFor({ name: 'notes' })}
          aria-label="Back to Fleeting Notes"
          title="Back to Fleeting Notes"
        >
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
        </a>
        <input
          type="text"
          className="fnb-name"
          value={name}
          aria-label="Board name"
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={() => {
            if (!name.trim()) setName(board.name); // never persist an empty name
          }}
        />
        <span className="fnb-save" role="status" aria-live="polite" data-state={saveState}>
          {saveLabel}
          {saveState === 'saved' && matInfo && matInfo.updated > 0 && (
            <> · {matInfo.updated} {matInfo.updated === 1 ? 'note' : 'notes'} linked</>
          )}
          {saveState === 'saved' && matInfo && matInfo.failed > 0 && (
            <span className="fnb-save-warn">
              {' '}· {matInfo.failed} {matInfo.failed === 1 ? 'note' : 'notes'} couldn’t update
            </span>
          )}
        </span>

        <div className="fnb-tools">
          <button
            type="button"
            className="fnb-btn"
            onClick={() => void addNewNote()}
            disabled={readOnly || atCapacity || creatingNote}
            title={atCapacity ? 'This board is full (500 cards)' : 'Create a new note as a card'}
          >
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
            <FileText size={14} strokeWidth={1.5} aria-hidden="true" />
            {creatingNote ? 'Creating…' : 'Note'}
          </button>

          <div className="fnb-pickwrap" ref={pickerRef}>
            <button
              type="button"
              className="fnb-btn"
              aria-expanded={pickerOpen}
              aria-haspopup="true"
              onClick={() => setPickerOpen((o) => !o)}
              disabled={readOnly || atCapacity}
              title={atCapacity ? 'This board is full (500 cards)' : 'Add an existing fleeting note as a card'}
            >
              <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
              Existing note
            </button>
            {pickerOpen && (
              <div
                className="fnb-picker"
                role="menu"
                aria-label="Add a fleeting note to the board"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPickerOpen(false);
                }}
              >
                {availableDocs.length === 0 ? (
                  <p className="fnb-picker-empty">Every fleeting note is already on this board.</p>
                ) : (
                  availableDocs.map((d) => (
                    <button
                      key={d.slug}
                      type="button"
                      role="menuitem"
                      className="fnb-picker-item"
                      onClick={() => addDocNode(d)}
                    >
                      {d.title || d.slug}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="fnb-pickwrap" ref={boardPopRef}>
            <button
              type="button"
              className="fnb-btn"
              aria-expanded={boardPopOpen}
              aria-haspopup="true"
              onClick={() => setBoardPopOpen((o) => !o)}
              disabled={readOnly || atCapacity}
              title={atCapacity ? 'This board is full (500 cards)' : 'Create a nested board as a card'}
            >
              <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
              <LayoutDashboard size={14} strokeWidth={1.5} aria-hidden="true" />
              Board
            </button>
            {boardPopOpen && (
              <div className="fnb-picker fnb-newboard" role="dialog" aria-label="Create a nested board">
                <input
                  type="text"
                  className="fnb-newboard-input"
                  value={newBoardName}
                  placeholder="Board name"
                  aria-label="New board name"
                  maxLength={120}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- small transient popover
                  autoFocus
                  onChange={(e) => setNewBoardName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void doCreateBoard();
                    } else if (e.key === 'Escape') {
                      setBoardPopOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="fnb-btn"
                  onClick={() => void doCreateBoard()}
                  disabled={!newBoardName.trim() || creatingBoard}
                >
                  {creatingBoard ? 'Creating…' : 'Create'}
                </button>
              </div>
            )}
          </div>

          <div className="fnb-swatches" role="group" aria-label="Color of the selected cards">
            {STICKY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="fnb-swatch"
                data-tint={c}
                aria-label={`Color selected cards ${c}`}
                disabled={readOnly || selectedCount === 0}
                onClick={() => applyColor(c)}
              />
            ))}
          </div>

          <button
            type="button"
            className="fnb-btn"
            onClick={deleteSelected}
            disabled={readOnly || deleteCount === 0}
            aria-label={`Delete ${deleteCount} selected ${deleteCount === 1 ? 'item' : 'items'}`}
            title="Delete selected (Del)"
          >
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
            {deleteCount > 0 ? `Delete (${deleteCount})` : 'Delete'}
          </button>

          {confirmingDelete ? (
            <span className="fnb-confirm" role="group" aria-label="Confirm board deletion">
              <span className="fnb-confirm-q">Delete this board?</span>
              <button
                type="button"
                className="fnb-btn fnb-btn--danger"
                onClick={() => void doDeleteBoard()}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button"
                className="fnb-btn"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="fnb-btn"
              aria-label="Delete this board"
              title="Delete this board"
              disabled={readOnly}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {readOnly && (
        <p className="fnb-banner" role="status">
          Read-only — saving is disabled right now. You can look around, but changes won't be stored.
        </p>
      )}

      <div
        ref={wrapRef}
        className="fnb-canvas"
        role="application"
        aria-label={`Whiteboard: ${name}`}
      >
        <BoardContext.Provider value={boardCtx}>
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            isValidConnection={isValidConnection}
            // Loose: a connection drag may start AND end on any of the four
            // side handles (all type=source) — Heptabase-style free linking.
            connectionMode={ConnectionMode.Loose}
            connectionRadius={28}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.1}
            maxZoom={2}
            // Whiteboard gestures: trackpad scroll pans, wheel+ctrl pinches,
            // left-drag rubber-band selects, middle/right-drag pans.
            panOnScroll
            selectionOnDrag
            panOnDrag={[1, 2]}
            selectionMode={SelectionMode.Partial}
            zoomOnDoubleClick={false}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            edgesFocusable={!readOnly}
            // Sections live at zIndex -1, permanently BEHIND the cards — the
            // default select-elevation would raise a selected section over
            // them and swallow card clicks.
            elevateNodesOnSelect={false}
            deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.25} color="var(--border)" />
            <Controls position="bottom-right" showInteractive={false} className="fnb-controls" />
          </ReactFlow>
        </BoardContext.Provider>
        {selCardCount >= 2 && !readOnly && (
          <div className="fnb-seltoolbar" role="toolbar" aria-label="Selection actions">
            <button type="button" className="fnb-btn" onClick={createSection}>
              <Frame size={14} strokeWidth={1.5} aria-hidden="true" />
              Create section ({selCardCount})
            </button>
          </div>
        )}
        {edgeDialog && dialogEdge && !readOnly && (
          <div
            ref={edgeDialogRef}
            className="fnb-edgedialog"
            role="dialog"
            aria-label="Connection between cards"
            style={{ left: edgeDialog.x, top: edgeDialog.y }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeEdgeDialog();
              }
            }}
          >
            <div className="fnb-edgedialog-row">
              <span className="fnb-edgedialog-title">Connection</span>
              <div className="fnb-edgedialog-dir" role="group" aria-label="Connection direction">
                <button
                  type="button"
                  className="fnb-btn fnb-btn--dir"
                  aria-pressed={dialogEdge.direction === 'one'}
                  title="One-way (→)"
                  onClick={() => setEdgeDirection('one')}
                >
                  <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="fnb-btn fnb-btn--dir"
                  aria-pressed={dialogEdge.direction === 'both'}
                  title="Both ways (↔)"
                  onClick={() => setEdgeDirection('both')}
                >
                  <ArrowLeftRight size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                className="fnb-btn fnb-edgedialog-close"
                aria-label="Close connection dialog"
                title="Close"
                onClick={closeEdgeDialog}
              >
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <textarea
              className="fnb-edgedialog-note"
              value={edgeNoteDraft}
              maxLength={MAX_EDGE_NOTE}
              rows={3}
              placeholder="Why are these connected?"
              aria-label="Connection note"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- small transient popover
              autoFocus
              onChange={(e) => setEdgeNoteDraft(e.target.value)}
              onBlur={commitEdgeNote}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitEdgeNote();
                  closeEdgeDialog();
                }
              }}
            />
            <div className="fnb-edgedialog-row">
              <button
                type="button"
                className="fnb-btn fnb-btn--danger"
                onClick={deleteDialogEdge}
              >
                <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                Delete connection
              </button>
            </div>
          </div>
        )}
        {nodes.length === 0 && (
          <div className="fnb-empty" aria-hidden="true">
            <p className="fnb-empty-title">An empty canvas</p>
            <p className="fnb-empty-sub">
              Add a <strong>Note</strong> to capture a fresh thought, an{' '}
              <strong>Existing note</strong> to arrange what you have, or a{' '}
              <strong>Board</strong> to nest another canvas inside this one.
            </p>
          </div>
        )}
        {/* Cmd/Ctrl+click note preview — the SAME context panel the Workbench
            editor docks; here it overlays the canvas' right edge (board.css
            owns the re-anchoring), inside .fnb-board so fullscreen keeps it. */}
        {previewSlug !== null && (
          <div className="fnb-context-dock">
            <WikilinkContextPanel slug={previewSlug} onHop={openPreview} onClose={closePreview} />
          </div>
        )}
      </div>
    </div>
  );
}
