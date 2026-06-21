// NoteNode.tsx — the custom React Flow node, per GL-003 §8.9.1–§8.9.5.
//
// The three-generation weight ladder, all monochrome, the only chromatic value
// being the single Gen-0 brass moment (left-edge + brass icon, §8.9.2). React.memo'd
// (declared at module scope in MiniGraphCanvas's nodeTypes — perf, Flow SPEC §L8).
//
// Generation reads from: width + fill + border + title token + icon size/colour +
// degree chip + opacity. Compact-LOD (>60 total nodes) drops Gen-2 chips/labels to
// dot-nodes; labels return on hover (§8.9.5).
import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MoreHorizontal } from 'lucide-react';
import { iconForType } from './nodeIcon';
import type { GraphNode } from '../../lib/cockpitTypes';

// Data carried on each React Flow node. `kind:'overflow'` is the synthetic "+N more"
// affordance (§8.9.5); everything else is a real note node.
export interface NoteNodeData extends Record<string, unknown> {
  kind: 'note' | 'overflow';
  node?: GraphNode;        // present when kind === 'note'
  overflowCount?: number;  // present when kind === 'overflow'
  compact: boolean;        // compact-LOD active (total > 60)
  enterDelay: number;      // §2.1 staggered entrance delay (ms), center-out
}

function DegreeChip({ inDeg, outDeg }: { inDeg: number; outDeg: number }) {
  return (
    <span className="mg-node-degree" aria-label={`${inDeg} incoming, ${outDeg} outgoing links`}>
      <span className="mg-node-degree-part">↓{inDeg}</span>
      <span className="mg-node-degree-part">↑{outDeg}</span>
    </span>
  );
}

function NoteNodeImpl({ data }: NodeProps) {
  const d = data as NoteNodeData;
  // §2.1 — the per-node staggered entrance delay, consumed by the CSS keyframe
  // animation-delay on .mg-canvas[data-entering] .mg-node.
  const enterStyle = { '--mg-enter-delay': `${d.enterDelay ?? 0}ms` } as CSSProperties;

  // "+N more" overflow node (§8.9.5): Gen-2 size, dashed border, … glyph, no chip.
  if (d.kind === 'overflow') {
    return (
      <div className="mg-node mg-node--overflow" data-gen="2" style={enterStyle}>
        <Handle type="target" position={Position.Top} className="mg-handle" />
        <Handle type="source" position={Position.Bottom} className="mg-handle" />
        <MoreHorizontal size={16} strokeWidth={1.5} className="mg-node-icon" aria-hidden="true" />
        <span className="mg-node-title">+{d.overflowCount} more</span>
      </div>
    );
  }

  const node = d.node!;
  const Icon = iconForType(node.type);
  const isFocus = node.gen === 0;
  // Compact-LOD: Gen-2 collapses to a dot (icon only); the title returns on hover
  // via CSS (.mg-node--dot:hover .mg-node-title). Gen-0/Gen-1 are never compacted.
  const isDot = d.compact && node.gen === 2;

  return (
    <div
      className={`mg-node${isFocus ? ' mg-node--focus' : ''}${
        !node.clickable ? ' mg-node--plain' : ''
      }${isDot ? ' mg-node--dot' : ''}`}
      data-gen={node.gen}
      title={node.title}
      style={enterStyle}
    >
      <Handle type="target" position={Position.Top} className="mg-handle" />
      <Handle type="source" position={Position.Bottom} className="mg-handle" />
      <div className="mg-node-row">
        <Icon
          size={isFocus ? 20 : 16}
          strokeWidth={1.5}
          className="mg-node-icon"
          aria-hidden="true"
        />
        <span className="mg-node-title">{node.title}</span>
      </div>
      {node.subtitle && !isDot && isFocus && (
        <span className="mg-node-subtitle">{node.subtitle}</span>
      )}
      {/* Degree chip: Gen-0 + Gen-1 only, and never under compact-LOD (§8.9.1). */}
      {node.gen < 2 && !d.compact && (
        <DegreeChip inDeg={node.inDegree} outDeg={node.outDegree} />
      )}
    </div>
  );
}

export const NoteNode = memo(NoteNodeImpl);
