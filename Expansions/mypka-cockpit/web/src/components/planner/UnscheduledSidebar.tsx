// UnscheduledSidebar.tsx — the right rail of unscheduled tasks (Todoist + ClickUp)
// waiting to be dragged into a lane. A @dnd-kit SortableContext + droppable so a
// card can be dragged BACK here to unschedule (Vivi §2.6 gentle return).
//
// Iris 11 §3 — two affordances on the head:
//   • COLLAPSE: a chevron icon-button folds the panel to a thin rail
//     (--tasksidebar-collapsed-w) that keeps the frame + count + a reopen handle.
//     State persisted to localStorage (PlannerView owns the hook).
//   • GROUP-BY-SOURCE: a flat/grouped toggle (the .workout-chip idiom). Grouped mode
//     renders cards under source-logo headers ("ClickUp · 23"); flat mode is the
//     current behaviour. Drag works in BOTH modes — the SortableContext below wraps
//     ALL card ids regardless of grouping.
//
// Calm not-connected posture (preserved from actionSlots.ts): when a task source is
// not connected, its calm connect-hint line shows instead of cards — never an error.

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Inbox, CheckCircle2, Layers, PanelRightClose, PanelRightOpen, ChevronDown, Star, CalendarCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SourceMark } from './SourceMark';

export const SIDEBAR_DROPPABLE_ID = 'sidebar';

// Felix (Vivi motion audit A2, 2026-06-03): smooth source-group fold. The group head's
// chevron already animates (cockpit.css), but the card list used to conditionally render
// → SNAP (the worst half-animated case). We animate the body's height via the modern
// measurement-free grid-template-rows 0fr↔1fr technique (a 2-element grid where the inner
// is overflow:hidden), sharing the one calm --ease-collapse curve. Drag-correctness is
// preserved: collapsed groups still UNMOUNT their cards (they can't be dragged while
// hidden), but only AFTER the exit animation finishes (transitionend) — so the cards fade
// down with the closing gap, then leave the DOM. On reduced-motion the global CSS block
// zeroes the transition, transitionend fires effectively immediately, so it still unmounts.
function CollapsibleGroupBody({
  open, bodyId, children,
}: {
  open: boolean;
  bodyId: string;
  children: ReactNode;
}) {
  // Keep the cards mounted while open OR while the closing animation is still running.
  const [mounted, setMounted] = useState(open);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) { setMounted(true); return; }
    // Closing: keep mounted, then drop on the grid-template-rows transitionend. A safety
    // timeout covers the case where no transitionend fires (e.g. display toggles).
    const el = innerRef.current?.parentElement; // the grid wrapper that transitions
    if (!el) { setMounted(false); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; setMounted(false); };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === 'grid-template-rows') finish();
    };
    el.addEventListener('transitionend', onEnd);
    const t = window.setTimeout(finish, 320);
    return () => { el.removeEventListener('transitionend', onEnd); window.clearTimeout(t); };
  }, [open]);

  return (
    <div
      id={bodyId}
      className="planner-group-collapse"
      data-open={open ? 'true' : undefined}
    >
      <div ref={innerRef} className="planner-group-collapse-inner">
        {mounted && <div className="flex flex-col gap-sm">{children}</div>}
      </div>
    </div>
  );
}

// Iris 20 §5 — a weekly goal already PLACED on a day. Rendered as a STATIC ledger row
// in the pinned Weekly Goals section (NOT a draggable card, NOT in the SortableContext:
// its draggable twin already lives on the board under the same dnd-kit id). `dayAbbr`
// is the 3-letter weekday (e.g. "Wed"); `half` is 'AM'/'PM' (or null to fall back to
// just the day in the badge).
export interface PlacedGoal {
  key: string;          // namespaced source:id (matches its board card id) — React key only
  title: string;
  dayAbbr: string;      // 'Mon' … 'Sun'
  half: 'AM' | 'PM' | null;
}

// One placed-goal row: CalendarCheck lead-glyph (teal) + title + a "Wed · PM" day badge.
// Plain static markup — no dnd-kit, draggable={false}, default cursor (the CSS sets it).
// aria-label announces the scheduled state so it isn't conveyed by colour/glyph alone.
function PlacedGoalRow({ goal }: { goal: PlacedGoal }) {
  const badgeText = goal.half ? `${goal.dayAbbr} · ${goal.half}` : goal.dayAbbr;
  const ariaWhen = goal.half ? `${goal.dayAbbr} ${goal.half}` : goal.dayAbbr;
  return (
    <div
      className="planner-goal-row"
      data-placed="true"
      draggable={false}
      aria-label={`${goal.title} — scheduled ${ariaWhen}`}
    >
      <CalendarCheck
        className="planner-goal-glyph"
        size={13}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="planner-goal-title">{goal.title}</span>
      <span className="planner-goal-badge" aria-hidden="true">{badgeText}</span>
    </div>
  );
}

// One source group for grouped mode: the source's logo + label + count + its cards.
export interface SidebarGroup {
  source: string;            // connector id (open — any active task connector)
  label: string;             // human label from the /api/cockpit/sources response
  count: number;
  cards: ReactNode;          // the SortableTaskCard list for this source
}

export function UnscheduledSidebar({
  count, sortIds, children, groups, sourceNotices, isDropTarget, allPlaced,
  collapsed, onToggleCollapsed, grouped, onToggleGrouped,
  isGroupCollapsed, onToggleGroup,
  pinnedGoals, pinnedGoalCount, placedGoals,
}: {
  count: number;
  sortIds: string[];
  children: ReactNode;              // the flat SortableTaskCard list (flat mode)
  groups: SidebarGroup[] | null;    // grouped sections (grouped mode), else null
  sourceNotices: ReactNode;         // calm not-connected hint lines per source
  isDropTarget: boolean;
  allPlaced: boolean;               // true when there are 0 unscheduled tasks
  // Iris 20 §4 (weekly goals): the pinned "Weekly Goals" section — the UNPLACED weekly
  // goals, rendered teal under a teal header ABOVE the normal unscheduled content. Null
  // / 0 when there are no unplaced weekly goals (the whole section then renders nothing).
  pinnedGoals?: ReactNode;
  pinnedGoalCount?: number;
  // Iris 20 §5: weekly goals already PLACED on a day. Rendered as STATIC rows in the
  // same pinned section, BELOW the unscheduled (draggable) pool. They are deliberately
  // NOT in `sortIds`/the SortableContext — their draggable twins already exist on the
  // board with the same id, so including them here would duplicate a dnd-kit id.
  placedGoals?: PlacedGoal[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  grouped: boolean;
  onToggleGrouped: () => void;
  // Iris 13 req 5: per-source-group collapse (persisted). A collapsed group shows just
  // its header + count; its cards (and their drag affordance) hide until reopened.
  isGroupCollapsed: (source: string) => boolean;
  onToggleGroup: (source: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: SIDEBAR_DROPPABLE_ID });

  return (
    <aside
      ref={setNodeRef}
      className="planner-tasksidebar"
      data-collapsed={collapsed ? 'true' : undefined}
      data-drop-active={isDropTarget ? 'true' : undefined}
      aria-label={`Unscheduled tasks, ${count} ${count === 1 ? 'task' : 'tasks'}`}
    >
      <div className="planner-tasksidebar-head">
        {/* Collapse / reopen chevron — leads the head; flips to the open icon when
            folded. Reuses the 28px icon-button idiom (Iris 11 §3a). */}
        <button
          type="button"
          className="planner-tasksidebar-toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand unscheduled tasks' : 'Collapse unscheduled tasks'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed
            ? <PanelRightOpen size={16} strokeWidth={1.5} aria-hidden="true" />
            : <PanelRightClose size={16} strokeWidth={1.5} aria-hidden="true" />}
        </button>
        <Inbox size={15} strokeWidth={1.5} aria-hidden="true" />
        <span>Unscheduled</span>
        <span className="count ml-auto tabular-nums text-fg-subtle">{count}</span>
      </div>

      {/* The body holds the toggle + cards; hidden in the collapsed rail (the head's
          chevron + count stay visible). Wrapped so collapse can hide it via CSS. */}
      <div className="planner-tasksidebar-body">
        {/* ONE SortableContext wraps BOTH the pinned Weekly Goals section AND the normal
            unscheduled list, so every sidebar card (pinned or not) is a sortable in the
            same context — dragging a pinned weekly goal onto a day works exactly like any
            other sidebar drag. The parent's `sortIds` lists the pinned goal keys first,
            then the unscheduled keys. */}
        <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
          {/* Iris 20 §4: the PINNED "Weekly Goals" section — the unplaced weekly goals,
              teal, pinned ABOVE the normal unscheduled tasks/source-groups. Teal header
              (--tasksidebar-pinned-head-fg) + a leading filled Star so the section rhymes
              with the highlight cards it holds. Renders nothing when there are no unplaced
              weekly goals. Dragging one onto a day = placed + still a weekly goal → a
              highlight automatically; dragging back here returns it to this pool. */}
          {(() => {
            // Iris 20 §5 (Tom 2026-06-03): the section now lists the FULL roster — the
            // unscheduled DRAGGABLE pool (pinnedGoals, inside the SortableContext via
            // sortIds) AND the PLACED static ledger rows (placedGoals, NOT in sortIds —
            // so no duplicate dnd-kit id; their draggable twins live on the board). The
            // count badge is the total roster; render whenever either list is non-empty.
            const unplaced = pinnedGoalCount ?? 0;
            const placed = placedGoals?.length ?? 0;
            const total = unplaced + placed;
            if (total === 0) return null;
            return (
              <section className="planner-pinned-goals" aria-label={`Weekly goals, ${total}`}>
                <div className="planner-pinned-goals-head">
                  <Star size={13} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
                  <span>Weekly Goals</span>
                  <span className="count ml-auto tabular-nums">{total}</span>
                </div>
                {/* Unscheduled pool: the existing draggable teal cards (sortable). */}
                {unplaced > 0 && <div className="flex flex-col gap-sm">{pinnedGoals}</div>}
                {/* Placed rows: static, non-draggable, day-badged. OUTSIDE the sortable
                    set (their ids already belong to board cards) — plain markup, no
                    useSortable, so no id is registered twice. */}
                {placed > 0 && (
                  <div className="flex flex-col gap-sm">
                    {placedGoals!.map((g) => <PlacedGoalRow key={g.key} goal={g} />)}
                  </div>
                )}
              </section>
            );
          })()}

          {/* Flat / grouped mode toggle (the .workout-chip idiom, data-state). Hidden
              when there are no tasks (nothing to group). */}
          {count > 0 && (
            <button
              type="button"
              className="workout-chip planner-tasksidebar-modechip"
              data-state={grouped ? 'on' : undefined}
              onClick={onToggleGrouped}
              aria-pressed={grouped}
              title={grouped ? 'Show as a flat list' : 'Group by source'}
            >
              <Layers size={13} strokeWidth={1.5} aria-hidden="true" />
              Group
            </button>
          )}

          {count > 0 ? (
            grouped && groups ? (
              <div className="planner-tasksidebar-groups">
                {groups.map((g) => {
                  const groupCollapsed = isGroupCollapsed(g.source);
                  const bodyId = `planner-group-${g.source}`;
                  return (
                    <div key={g.source} className="planner-tasksidebar-group">
                      {/* The head is now a toggle: a chevron (rotates on state) folds
                          the group's cards to just header + count. State persisted by
                          PlannerView (localStorage, keyed by source). */}
                      <button
                        type="button"
                        className="planner-tasksidebar-group-head"
                        data-collapsed={groupCollapsed ? 'true' : undefined}
                        onClick={() => onToggleGroup(g.source)}
                        aria-expanded={!groupCollapsed}
                        aria-controls={bodyId}
                      >
                        <ChevronDown
                          className="planner-tasksidebar-group-chevron"
                          size={14} strokeWidth={1.5} aria-hidden="true"
                        />
                        <SourceMark source={g.source} label={g.label} />
                        <span>{g.label}</span>
                        <span className="planner-tasksidebar-group-count">· {g.count}</span>
                      </button>
                      {/* Vivi audit A2: the body now animates open/closed (grid-rows) and
                          unmounts cards only after the exit completes — drag-correctness
                          preserved (collapsed = no draggable cards), snap removed. */}
                      <CollapsibleGroupBody open={!groupCollapsed} bodyId={bodyId}>
                        {g.cards}
                      </CollapsibleGroupBody>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-sm">{children}</div>
            )
          ) : allPlaced && !(pinnedGoalCount && pinnedGoalCount > 0) && !(placedGoals && placedGoals.length > 0) ? (
            // Only the calm "everything's placed" state when there is ALSO nothing pinned;
            // a lone pinned Weekly Goals pool above is content enough on its own.
            <div className="planner-tasksidebar-empty">
              <CheckCircle2 size={22} strokeWidth={1.25} aria-hidden="true" />
              <p className="text-meta text-fg-muted">Everything&apos;s placed.</p>
            </div>
          ) : null}
        </SortableContext>

        {sourceNotices}
      </div>
    </aside>
  );
}
