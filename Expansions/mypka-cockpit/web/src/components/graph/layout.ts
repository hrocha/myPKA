// layout.ts — d3-force concentric layout for the mini-graph (Flow LOCKED SPEC §L4).
//
// Gen-0 pinned dead-center (fx/fy). Gen-1 settles on an inner ring, Gen-2 on an
// outer ring (forceRadial per generation) with a light charge (anti-overlap) and
// a link force at a generation-aware distance. We run the simulation headless to
// settle (single-thread is fine at the node counts here — single-digit to ~160,
// Flow SPEC §L4), then hand the settled {x,y} to React Flow. No worker.
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceRadial,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphEdge } from '../../lib/cockpitTypes';

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  gen: 0 | 1 | 2;
}

// Ring radii by generation. Gen-2 sits clearly outside Gen-1; Gen-0 is the origin.
// Tuned so a typical neighbourhood reads as concentric without colliding; the hub
// case (~160) relies on collide + charge to spread the dense outer ring.
const RING_RADIUS: Record<0 | 1 | 2, number> = { 0: 0, 1: 260, 2: 520 };
// Per-node collision radius by generation (half node width + breathing room).
const COLLIDE_R: Record<0 | 1 | 2, number> = { 0: 130, 1: 108, 2: 80 };

/**
 * Settle a concentric layout headlessly and return absolute node positions.
 * Deterministic given the same input (seeded start angles), so re-layouts on
 * expand are stable rather than jumping.
 *
 * `seedFrom` (Vivi §2.4): a map of id → start {x,y} used to SEED the sim instead
 * of the even-angle ring seed. Persisting nodes seed at their prior settled spot
 * (stable glide); new-this-expand grandchildren seed at their hub's position so
 * they visibly *emerge from the hub* rather than fade in at their final ring spot.
 * Omitted on first load → deterministic even-angle seeding as before.
 */
export function computeConcentricLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  seedFrom?: Map<string, { x: number; y: number }>,
): Map<string, PositionedNode> {
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const r = RING_RADIUS[n.gen];
    // Seed each node on its ring at an even angle so the sim starts near-settled
    // (faster convergence, deterministic result). Gen-0 starts at origin + pinned.
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const seed = seedFrom?.get(n.id);
    const node: SimNode = {
      id: n.id,
      gen: n.gen,
      x: seed ? seed.x : Math.cos(angle) * r,
      y: seed ? seed.y : Math.sin(angle) * r,
    };
    if (n.gen === 0) {
      node.fx = 0;
      node.fy = 0;
    }
    return node;
  });

  const idIndex = new Map(simNodes.map((n) => [n.id, n]));
  // Drop edges whose endpoints aren't both present (defensive — server filters,
  // but an expand could reference a not-yet-loaded node).
  const simLinks: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => idIndex.has(e.source) && idIndex.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance((l) => {
          // Link distance scales with the deeper endpoint's ring gap.
          const s = l.source as SimNode;
          const t = l.target as SimNode;
          const maxGen = Math.max(s.gen ?? 0, t.gen ?? 0) as 0 | 1 | 2;
          return maxGen === 2 ? 180 : 200;
        })
        .strength(0.15),
    )
    .force('charge', forceManyBody<SimNode>().strength(-220))
    .force(
      'radial',
      forceRadial<SimNode>((d) => RING_RADIUS[d.gen], 0, 0).strength((d) =>
        // Gen-0 is pinned, so its radial strength is moot. Gen-1/2 hold their ring
        // firmly so the concentric read survives the charge/link push.
        d.gen === 0 ? 0 : 0.9,
      ),
    )
    .force('collide', forceCollide<SimNode>((d) => COLLIDE_R[d.gen]).strength(0.9))
    .stop();

  // Headless settle. ~300 ticks is plenty for these node counts; alpha decays to
  // rest well within that. Single-threaded, runs once on load / re-expand.
  const ticks = nodes.length > 60 ? 400 : 300;
  for (let i = 0; i < ticks; i += 1) sim.tick();

  const out = new Map<string, PositionedNode>();
  for (const n of simNodes) {
    out.set(n.id, { id: n.id, x: n.x ?? 0, y: n.y ?? 0 });
  }
  return out;
}
