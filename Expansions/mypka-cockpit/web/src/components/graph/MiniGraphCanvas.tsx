// MiniGraphCanvas.tsx — the heavy React Flow + d3-force chunk (lazy-loaded by
// MiniGraph.tsx via React.lazy so it stays OUT of the note-view critical bundle).
//
// Owns: data->graph transform, d3-force concentric layout (layout.ts), the React
// Flow canvas, directed edges (outbound solid / backlink dashed — §8.9.4),
// "+N more" overflow nodes + in-place expand, compact-LOD (>60 nodes), click->
// hash-navigate, keyboard focus + Enter/Space-to-navigate, and the fullscreen overlay.
//
// Motion: Vivi spec 2026-06-03 (MCP-derived, GL-003 v3.1 §8.9.9). All node motion
// animates the inner .mg-node wrapper transform/opacity ONLY (never RF position).
// Every fitView duration is gated through the single MOTION_OK boolean
// (prefers-reduced-motion → 0, camera snaps). Hover via a CSS data-hover attribute
// (no re-render on a 160-node canvas); edge emphasis via className + RF state; the
// §2.4 position re-layout via the .mg-canvas[data-reflowing] transition guard.
//
// The React Flow stylesheet is imported HERE (inside the lazy chunk) and scoped
// behind `.mg-canvas` in cockpit.css so it can't bleed into the rest of the app.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  ControlButton,
  MarkerType,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import { Plus, Minus, Crosshair } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { navigate } from '../../lib/router';
import type { GraphNeighborhood, GraphNode, GraphEdge } from '../../lib/cockpitTypes';
import { NoteNode, type NoteNodeData } from './NoteNode';
import { computeConcentricLayout } from './layout';

// Module-scope nodeTypes (NOT inline) — Flow SPEC §L8 perf rule. A new object each
// render forces React Flow to re-init every node; module scope keeps it stable.
const nodeTypes: NodeTypes = { note: NoteNode };

// Compact-LOD threshold — above this total node count, Gen-2 collapses to dot-nodes
// and all degree chips drop so a hub (~160 nodes) stays legible (§8.9.5, Flow §L3).
const COMPACT_THRESHOLD = 60;

// Motion gate — the single highest-risk reduced-motion offender (Vivi §3). EVERY
// fitView duration reads this; when reduce is set, the camera snaps (duration 0),
// never tweens (a moving viewport is the worst vestibular trigger).
const MOTION_OK =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const FIT_DURATION = MOTION_OK ? 520 : 0; // --graph-fit-duration, gated

// Default framing zoom (Tom 2026-06-03). The entrance no longer fitView-zooms-out
// to fit every node (visually weak); instead it CENTERS on the Gen-0 focus node at
// this standard zoom so the focus renders at its natural readable size mid-panel and
// neighbors extend outward off-frame. 1.0 = the focus node draws at its token width
// (--graph-node-w-0 = 200px) 1:1, matching the reference screenshot.
const DEFAULT_ZOOM = 1.0;

// Gen-0 fallback box (token --graph-node-w-0 = 200px; height ≈ title+subtitle row).
// Used only before React Flow has measured the node, so setCenter targets the node
// CENTER (layout pins Gen-0's top-left at origin) rather than its corner.
const FOCUS_FALLBACK_W = 200;
const FOCUS_FALLBACK_H = 64;

// §2.1 stagger ladder (Vivi). Center-out: Gen-0 anchors at 0ms; Gen-1 follows; the
// Gen-2 ring + "+N more" trail. Within-group stagger is tight and capped so a
// 20-node ring never takes 800ms (9th+/13th+ share the last staggered slot).
const GEN1_START = 120;
const GEN1_STEP = 40;
const GEN1_CAP = 8;
const GEN2_STEP = 28;
const GEN2_CAP = 12;
const EDGE_TRAIL = 80; // edges arrive 80ms after their target node

interface BuildResult {
  nodes: Node<NoteNodeData>[];
  edges: Edge[];
}

// Transform the neighborhood payload + a set of expanded hubs into React Flow
// nodes/edges with settled positions. Pure given its inputs.
function buildGraph(
  data: GraphNeighborhood,
  expanded: Set<string>,
): BuildResult {
  const realNodes: GraphNode[] = data.nodes;
  const realEdges: GraphEdge[] = data.edges;

  // Overflow "+N more" synthetic nodes: one per capped Gen-1 hub that the user has
  // NOT yet expanded. Expanding is a client-side affordance — the server already
  // returned every node it will ever return for this focus (the cap hides Gen-2
  // GRANDCHILDREN beyond `cap`); "expand" here reveals the count honestly and, on
  // click, re-requests that hub at a higher cap. For v1 we surface the count and,
  // on expand, re-fetch is handled by the parent (onExpand) — see MiniGraphCanvas.
  const overflowNodes: { id: string; hubId: string; count: number }[] = [];
  for (const [hubId, count] of Object.entries(data.stats.capped)) {
    if (expanded.has(hubId)) continue;
    overflowNodes.push({ id: `overflow:${hubId}`, hubId, count });
  }

  const totalForLod = realNodes.length + overflowNodes.length;
  const compact = totalForLod > COMPACT_THRESHOLD;

  // Layout over real nodes + overflow nodes (overflow inherits its hub's edge so it
  // lays out next to the hub). Build a synthetic edge hub->overflow for layout + draw.
  const overflowGraphNodes: GraphNode[] = overflowNodes.map((o) => ({
    id: o.id,
    type: 'documents',
    typeLabel: '',
    slug: '',
    title: `+${o.count} more`,
    subtitle: null,
    tags: [],
    gen: 2,
    inDegree: 0,
    outDegree: 0,
    degree: 0,
    clickable: true,
  }));
  const overflowEdges: GraphEdge[] = overflowNodes.map((o) => ({
    id: `edge:${o.id}`,
    source: o.hubId,
    target: o.id,
    direction: 'out',
    linkType: 'wikilink',
  }));

  const layoutNodes = [...realNodes, ...overflowGraphNodes];
  const layoutEdges = [...realEdges, ...overflowEdges];
  const positions = computeConcentricLayout(layoutNodes, layoutEdges);

  // §2.1 stagger order — compute a per-node enter delay (center-out). Edges read
  // their target's delay + 80ms (set on the edge below).
  const nodeDelay = new Map<string, number>();
  let gen1Index = 0;
  let gen2Index = 0;
  const gen1Count = realNodes.filter((n) => n.gen === 1).length;
  const gen2Start =
    GEN1_START + Math.min(gen1Count, GEN1_CAP) * GEN1_STEP + EDGE_TRAIL;
  for (const n of realNodes) {
    if (n.gen === 0) {
      nodeDelay.set(n.id, 0);
    } else if (n.gen === 1) {
      nodeDelay.set(n.id, GEN1_START + Math.min(gen1Index, GEN1_CAP - 1) * GEN1_STEP);
      gen1Index += 1;
    } else {
      nodeDelay.set(n.id, gen2Start + Math.min(gen2Index, GEN2_CAP - 1) * GEN2_STEP);
      gen2Index += 1;
    }
  }
  // Overflow nodes ride the Gen-2 stagger tail.
  for (const o of overflowNodes) {
    nodeDelay.set(o.id, gen2Start + Math.min(gen2Index, GEN2_CAP - 1) * GEN2_STEP);
    gen2Index += 1;
  }

  const rfNodes: Node<NoteNodeData>[] = [];
  for (const n of realNodes) {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    const enterDelay = nodeDelay.get(n.id) ?? 0;
    rfNodes.push({
      id: n.id,
      type: 'note',
      position: { x: pos.x, y: pos.y },
      data: { kind: 'note', node: n, compact, enterDelay },
      // H1 (Vera) — a focused node announces the NOTE, not the React Flow id.
      ariaLabel: `${n.title}, ${n.typeLabel}, generation ${n.gen}, ${n.inDegree} incoming ${n.outDegree} outgoing links${n.clickable ? '' : ', not navigable'}`,
      // Gen-0 is the focus and re-centres on click (no-op nav); it's not draggable.
      draggable: false,
      selectable: n.clickable,
      // Keyboard focusability + Enter handled at the ReactFlow level (onNodeClick +
      // tabIndex via focusable). React Flow makes nodes focusable when `nodesFocusable`.
    });
  }
  for (const o of overflowNodes) {
    const pos = positions.get(o.id) ?? { x: 0, y: 0 };
    const enterDelay = nodeDelay.get(o.id) ?? gen2Start;
    rfNodes.push({
      id: o.id,
      type: 'note',
      position: { x: pos.x, y: pos.y },
      data: { kind: 'overflow', overflowCount: o.count, compact, enterDelay },
      // H2 (Vera) — overflow node announces the affordance, not the synthetic id.
      ariaLabel: `Show ${o.count} more linked notes`,
      draggable: false,
      selectable: true,
    });
  }

  // Edges: outbound = solid + arrow source->target; backlink = dashed 4 3 + arrow.
  // Both arrowheads point the way the server oriented them (out: focus->neighbor;
  // back: neighbor->focus), so direction is read from the arrow + the dash style,
  // never hue (§8.9.4). Colour is var(--graph-edge); Gen-1↔Gen-2 edges recede.
  const isFar = (e: GraphEdge): boolean => {
    const s = realNodes.find((n) => n.id === e.source);
    const t = realNodes.find((n) => n.id === e.target);
    return (s?.gen ?? 0) >= 1 && (t?.gen ?? 0) >= 1; // neither endpoint is Gen-0
  };
  const rfEdges: Edge[] = [];
  for (const e of realEdges) {
    const dashed = e.direction === 'back';
    const far = isFar(e);
    // §2.1 — edge fade trails its TARGET node by 80ms (node arrives, tether draws).
    const edgeDelay = (nodeDelay.get(e.target) ?? 0) + EDGE_TRAIL;
    rfEdges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      className: `mg-edge${dashed ? ' mg-edge--back' : ' mg-edge--out'}${far ? ' mg-edge--far' : ''}`,
      style: { '--mg-edge-enter-delay': `${edgeDelay}ms` } as CSSProperties,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        // Arrowhead matches the stroke; CSS overrides via .react-flow__arrowhead
        // fill is unreliable, so we set color here to the resting edge token.
        color: 'var(--graph-edge)',
      },
      // strokeDasharray + stroke set in cockpit.css off the className so the values
      // come from --graph-edge / --graph-edge-dash tokens, never hardcoded here.
    });
  }
  // Synthetic hub->overflow edges (drawn as muted dashed, the affordance link).
  for (const o of overflowEdges) {
    const edgeDelay = (nodeDelay.get(o.target) ?? gen2Start) + EDGE_TRAIL;
    rfEdges.push({
      id: o.id,
      source: o.source,
      target: o.target,
      type: 'smoothstep',
      className: 'mg-edge mg-edge--far mg-edge--overflow',
      style: { '--mg-edge-enter-delay': `${edgeDelay}ms` } as CSSProperties,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--graph-edge-far)' },
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}

interface CanvasInnerProps {
  data: GraphNeighborhood;
  expanded: Set<string>;
  onExpand: (hubId: string) => void;
}

function CanvasInner({ data, expanded, onExpand }: CanvasInnerProps) {
  const { setCenter, getNode, zoomIn, zoomOut } = useReactFlow();
  const { nodes, edges } = useMemo(() => buildGraph(data, expanded), [data, expanded]);

  // The Gen-0 focus node id (`${type}/${slug}`). Layout pins it at the origin.
  const focusId = data.focus.id;

  // Center the camera on the Gen-0 focus node at DEFAULT_ZOOM. This is the default
  // framing for BOTH mounts (inline + fullscreen): the focus renders at its natural
  // readable size mid-panel; neighbors run outward off-frame. Reads the measured
  // node box when available (RF measures after first paint); before that, falls back
  // to the Gen-0 token box so the center is still right. MOTION_OK gates the tween.
  const centerOnFocus = useCallback(
    (duration: number) => {
      const node = getNode(focusId);
      const x = node?.position.x ?? 0;
      const y = node?.position.y ?? 0;
      const w = node?.measured?.width ?? FOCUS_FALLBACK_W;
      const h = node?.measured?.height ?? FOCUS_FALLBACK_H;
      setCenter(x + w / 2, y + h / 2, { zoom: DEFAULT_ZOOM, duration });
    },
    [getNode, setCenter, focusId],
  );

  // Our own DOM root inside the RF mount. We walk UP from here to the nearest
  // .mg-canvas / .mg-fullscreen wrapper — scoped to THIS mount, so the inline and
  // fullscreen canvases never toggle each other's entrance/reflow attributes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const timers = useRef<number[]>([]);
  // Edges incident to the hovered node carry mg-edge--emphasis (§2.2). React state
  // since edges are a separate render tree; node hover itself is CSS data-hover.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Is this the very first reveal? Distinguishes §2.1 entrance from §2.4 reflow.
  const firstReveal = useRef(true);
  const prevNodeCount = useRef(nodes.length);

  const resolveWrapper = useCallback((): HTMLElement | null => {
    return (rootRef.current?.closest('.mg-canvas, .mg-fullscreen') as HTMLElement | null) ?? null;
  }, []);

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  // §2.1 entrance + §2.4 reflow orchestration. On first reveal: data-entering for
  // the full stagger window + a tweened fitView. On a subsequent node-set change
  // (expand): data-reflowing so persisting nodes glide to new positions, plus the
  // new nodes carry data-entering for their fade-in, plus a re-frame fitView.
  useEffect(() => {
    const wrap = resolveWrapper();
    wrapperRef.current = wrap;
    clearTimers();

    const isExpand = !firstReveal.current && nodes.length !== prevNodeCount.current;
    prevNodeCount.current = nodes.length;

    if (!wrap) {
      // Still frame the camera even if the wrapper isn't resolvable yet.
      const raf = requestAnimationFrame(() => centerOnFocus(FIT_DURATION));
      return () => cancelAnimationFrame(raf);
    }

    if (isExpand) {
      // §2.4 — guard the position transition ON for the reflow window only (OFF
      // during pan/zoom otherwise). New nodes still fade via data-entering.
      wrap.setAttribute('data-reflowing', 'true');
      wrap.setAttribute('data-entering', 'true');
      const reflowMs = MOTION_OK ? 380 + 100 : 0; // --graph-reflow-duration + buffer
      timers.current.push(
        window.setTimeout(() => wrap.removeAttribute('data-reflowing'), reflowMs),
      );
      timers.current.push(
        window.setTimeout(() => wrap.removeAttribute('data-entering'), 900),
      );
    } else {
      // §2.1 — fresh constellation entrance: stagger the reveal.
      wrap.setAttribute('data-entering', 'true');
      timers.current.push(
        window.setTimeout(() => wrap.removeAttribute('data-entering'), 1100),
      );
    }
    firstReveal.current = false;

    // Center-on-focus is the default framing for entrance AND reflow (was fitView).
    const raf = requestAnimationFrame(() => centerOnFocus(FIT_DURATION));
    return () => {
      cancelAnimationFrame(raf);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, centerOnFocus, resolveWrapper]);

  useEffect(() => () => clearTimers(), []);

  // Re-frame on container resize. The fullscreen mount is a SEPARATE ReactFlowProvider
  // whose container (a) mounts after `fullscreen` flips true, (b) sizes via flex
  // `1 1 auto` (no final height at first paint), and (c) is briefly scaled by the
  // §2.5 mg-fs-open entrance animation. Any of those means the entrance-effect RAF
  // above runs fitView against a wrong/zero rect → nodes frame off-screen (blank
  // canvas). A ResizeObserver re-fits whenever the container's box changes — it fires
  // once the flex height resolves AND again as the open animation settles, so the
  // graph always ends framed to the FINAL viewport. Snaps (duration 0) so the camera
  // doesn't visibly chase the resize; the entrance effect owns the one tweened reframe.
  // Re-CENTERS on the focus node (not fit-all) so the resize default matches the
  // entrance default. Inline mount: its box is static, fires once at mount (harmless).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      // Ignore sub-pixel jitter; only re-center on a real box change.
      if (Math.abs(box.width - lastW) < 1 && Math.abs(box.height - lastH) < 1) return;
      lastW = box.width;
      lastH = box.height;
      centerOnFocus(0);
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [centerOnFocus]);

  // §2.2 hover — toggle a CSS data-hover attribute on the inner .mg-node (no
  // re-render) AND set hoveredId so incident edges get mg-edge--emphasis.
  const onNodeMouseEnter = useCallback((evt: React.MouseEvent, node: Node) => {
    const inner = (evt.currentTarget as HTMLElement).querySelector('.mg-node');
    inner?.setAttribute('data-hover', 'true');
    setHoveredId(node.id);
  }, []);
  const onNodeMouseLeave = useCallback((evt: React.MouseEvent) => {
    const inner = (evt.currentTarget as HTMLElement).querySelector('.mg-node');
    inner?.removeAttribute('data-hover');
    setHoveredId(null);
  }, []);

  // Apply edge emphasis derived from hoveredId without rebuilding the graph.
  const renderedEdges = useMemo(() => {
    if (!hoveredId) return edges;
    return edges.map((e) =>
      e.source === hoveredId || e.target === hoveredId
        ? { ...e, className: `${e.className ?? ''} mg-edge--emphasis` }
        : e,
    );
  }, [edges, hoveredId]);

  // The shared navigate/expand path. Used by click AND by Space (H3) so keyboard
  // matches the backlink-button nav exactly.
  const activateNode = useCallback(
    (node: Node, sourceEl?: HTMLElement | null) => {
      const d = node.data as NoteNodeData;
      if (d.kind === 'overflow') {
        const hubId = node.id.replace(/^overflow:/, '');
        onExpand(hubId);
        return;
      }
      const gn = d.node;
      if (!gn || !gn.clickable) return;
      if (gn.gen === 0) {
        centerOnFocus(FIT_DURATION); // re-centre on the focus, no nav
        return;
      }
      // §2.6 press-confirm — flash data-pressing on the inner node, then navigate.
      const inner = sourceEl?.querySelector('.mg-node') as HTMLElement | null;
      if (inner && MOTION_OK) {
        inner.setAttribute('data-pressing', 'true');
        window.setTimeout(() => inner.removeAttribute('data-pressing'), 120);
      }
      // §2.6 depart fade on the leaving canvas (it re-mounts on the new route).
      const wrap = wrapperRef.current;
      if (wrap && MOTION_OK) wrap.setAttribute('data-departing', 'true');
      // Navigation target by node kind (agent-graph adds sibling-agent nodes):
      //   - a sibling agent → the team roster (members live on that one page)
      //   - an entity table → its #/note view
      // SOP/WS/GL nodes are clickable:false (no route yet) and never reach here —
      // the `!gn.clickable` guard above returns first, so they degrade to a
      // non-navigable node with its title tooltip.
      if (gn.type === 'agents') {
        navigate({ name: 'roster' });
      } else {
        navigate({ name: 'note', type: gn.type, slug: gn.slug });
      }
    },
    [centerOnFocus, onExpand],
  );

  // Click / Enter on a node -> hash-navigate to that note. React Flow binds Enter
  // to onNodeClick internally; we add Space below to match.
  const onNodeClick = useCallback(
    (evt: React.MouseEvent, node: Node) => {
      activateNode(node, evt.currentTarget as HTMLElement);
    },
    [activateNode],
  );

  // H3 (Vera) — Space activates like Enter. React Flow binds Enter only; we map
  // Space → the same activate path on the focused node, preventing page scroll.
  const onPaneKeyDown = useCallback(
    (evt: React.KeyboardEvent) => {
      if (evt.key !== ' ' && evt.key !== 'Spacebar') return;
      const focused = document.activeElement as HTMLElement | null;
      const rfNode = focused?.closest('.react-flow__node') as HTMLElement | null;
      if (!rfNode) return;
      const id = rfNode.getAttribute('data-id');
      if (!id) return;
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      evt.preventDefault(); // no page scroll
      activateNode(node, rfNode);
    },
    [nodes, activateNode],
  );

  // onInit — React Flow signals the instance is mounted with a measured pane. For the
  // fullscreen mount this is the earliest point its (larger) viewport dimensions are
  // known; frame immediately so the graph is never blank before the entrance tween /
  // ResizeObserver land. Snap (duration 0) center-on-focus — the entrance effect owns
  // the one visible tween; this is the default framing, matching the entrance.
  const onInit = useCallback(() => {
    centerOnFocus(0);
  }, [centerOnFocus]);

  return (
    <div
      ref={rootRef}
      style={{ width: '100%', height: '100%' }}
      onKeyDown={onPaneKeyDown}
    >
      <ReactFlow
        nodes={nodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        onInit={onInit}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        // a11y: nodes are focusable; Enter (RF built-in) + Space (onPaneKeyDown)
        // both trigger the same navigate/expand path as the text link-lists in
        // NoteView (the non-visual fallback, §8.9 / Flow §L9). All fitView durations
        // gate through MOTION_OK; CSS motion collapses under prefers-reduced-motion.
        nodesFocusable
        // Edges are decorative / read-only — never focusable, selectable, or
        // reconnectable. Belt-and-suspenders alongside the `.react-flow__edge {
        // pointer-events: none }` rule in cockpit.css (the core fix that stops the
        // transparent `.react-flow__edge-interaction` hit-path from capturing the
        // pointer and blocking panOnDrag). edgesReconnectable defaults false in v12
        // but is pinned so a later default change can't re-enable edge interaction.
        edgesFocusable={false}
        edgesReconnectable={false}
        nodesConnectable={false}
        nodesDraggable={false}
        // Selection OFF: this graph never selects edges or nodes. Node click-to-
        // navigate is driven by onNodeClick (and Space via onPaneKeyDown), BOTH of
        // which fire independently of elementsSelectable in RF v12 — selectability
        // only toggles the .selected store/class, never suppresses the click/keyboard
        // callbacks. nodesFocusable (above) stays true so Enter/Space nav survives.
        // Net: dragging anywhere — over edges, over nodes, over empty pane — pans.
        elementsSelectable={false}
        // Wheel = zoom the graph (Tom 2026-06-03), NOT pan/scroll. zoomOnScroll is the
        // RF default; pinned explicitly here so a later default change can't silently
        // disable it. panOnScroll OFF so the wheel is unambiguously a zoom gesture.
        panOnScroll={false}
        zoomOnScroll
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        // NO `fitView` prop — that would zoom-out-to-fit on mount (the framing Tom
        // rejected). onInit centers on the focus at DEFAULT_ZOOM instead.
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} className="mg-bg" />
        {/* Manual zoom controls, bottom-right. RF's default zoom/fit/lock buttons are
            replaced with our own +/−/recenter so we control labels + GL-003 styling.
            showZoom/showFitView/showInteractive OFF; we render explicit ControlButtons. */}
        <Controls
          position="bottom-right"
          showZoom={false}
          showFitView={false}
          showInteractive={false}
          className="mg-controls"
        >
          <ControlButton
            onClick={() => zoomIn({ duration: FIT_DURATION })}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          </ControlButton>
          <ControlButton
            onClick={() => zoomOut({ duration: FIT_DURATION })}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={14} strokeWidth={1.75} aria-hidden="true" />
          </ControlButton>
          <ControlButton
            onClick={() => centerOnFocus(FIT_DURATION)}
            aria-label="Recenter"
            title="Recenter on focus"
          >
            <Crosshair size={14} strokeWidth={1.75} aria-hidden="true" />
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  );
}

export interface MiniGraphCanvasProps {
  data: GraphNeighborhood;
  expanded: Set<string>;
  onExpand: (hubId: string) => void;
}

// The exported canvas. Wrapped in its own ReactFlowProvider so the fullscreen
// overlay (a second mount) doesn't fight the inline mount's store.
export default function MiniGraphCanvas({ data, expanded, onExpand }: MiniGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner data={data} expanded={expanded} onExpand={onExpand} />
    </ReactFlowProvider>
  );
}
