// HalfLane.tsx — one AM or PM lane: a single @dnd-kit SortableContext that mixes
// fixed meeting anchors with draggable task cards, in plan order.
//
// The lane's sortable items array = [...meeting anchors at their time slots,
// ...placed task cards]. A task dropped at index i encodes the SEMANTIC read
// (Tom's spec): above the first meeting = "before it"; between A and B = "in
// between"; after the last = "after the day's meetings". We store {weekday, half,
// neighbor ids}, never the prose — the ordered stack renders the meaning.
//
// The lane is a droppable region (useDroppable) so an EMPTY lane (no items) is still
// a valid target. data-drop-active toggles Iris's faint brass valid-hover wash.

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Fragment, type ReactNode } from 'react';
import type { Half, Weekday } from '../../lib/plannerTypes';

// The transient brass insertion rule shown mid-drag at the resolved drop slot (M1).
// Iris's .planner-drop-line owns the 2px/brass/rounded look + transform-origin; the
// planner motion block (cockpit.css) owns the line-grow choreography. aria-hidden:
// the spoken announcement already conveys the slot to screen readers.
function DropLine() {
  return <div className="planner-drop-line" aria-hidden="true" />;
}

export interface LaneRenderItem {
  // The dnd-kit sortable id for this row (eventKey for meetings, taskKey for tasks).
  sortId: string;
  node: ReactNode;
}

export function laneDroppableId(weekday: Weekday, half: Half): string {
  return `lane:${weekday}:${half}`;
}

export function parseLaneDroppableId(id: string): { weekday: Weekday; half: Half } | null {
  const m = /^lane:(\d):(AM|PM)$/.exec(id);
  if (!m) return null;
  return { weekday: Number(m[1]) as Weekday, half: m[2] as Half };
}

export function HalfLane({
  weekday, half, day, items, sortIds, dropLineIndex, isDropTarget, empty,
}: {
  weekday: Weekday;
  half: Half;
  day: string;
  items: LaneRenderItem[];
  sortIds: string[];        // the ordered id list for SortableContext
  // Full-list insertion index where the card will land (M1). null = no live drag
  // over this lane. The transient brass line renders BEFORE the item at this index
  // (or at the tail when === items.length), at the exact slot resolveDrop computed.
  dropLineIndex: number | null;
  isDropTarget: boolean;    // true while a drag hovers this lane
  empty: ReactNode;         // calm empty/placeholder when there are no items
}) {
  const droppableId = laneDroppableId(weekday, half);
  const { setNodeRef } = useDroppable({ id: droppableId });
  const count = items.length;

  // Iris 16 §4–7: the lane header row is GONE — the top-left "AM"/"PM" lane label
  // (item 4) and the top-right timer chip (items 5/6/7) are both removed. The aria-label
  // on the lane still announces the half (morning/afternoon) + item count, so the half
  // identity stays available to screen readers without the visible label. The active
  // half's countdown now lives in the sticky bottom bar on the daybox (PlannerCountdownBar).
  return (
    <div
      ref={setNodeRef}
      className="planner-lane"
      data-drop-active={isDropTarget ? 'true' : undefined}
      role="group"
      aria-label={`${day} ${half === 'AM' ? 'morning' : 'afternoon'}, ${count} ${count === 1 ? 'item' : 'items'}`}
    >
      <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
        {count > 0 ? items.map((it, i) => (
          <Fragment key={it.sortId}>
            {dropLineIndex === i && <DropLine />}
            <div className="group">{it.node}</div>
          </Fragment>
        )) : empty}
        {/* Tail insertion (after the last item, or into an empty lane). */}
        {dropLineIndex != null && dropLineIndex >= count && <DropLine />}
      </SortableContext>
    </div>
  );
}
