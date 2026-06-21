// plannerReducer.ts — the optimistic plan-state source of truth during a session.
//
// The cockpit has NO global store; the planner matches that with one useReducer in
// PlannerView (per the spec: useReducer + useFetch, no new state lib). This module
// holds the placements as a flat list and exposes pure operations the UI mutates
// optimistically, then persists via Mack's API.
//
// CORE INSIGHT (drop-index → neighbor ids): the server computes `position` from
// before_id/after_id — we NEVER send a numeric position. So a drop resolves to:
//   - the target lane's ordered list of *task* placements (meetings are anchors,
//     not plan_assignments rows),
//   - an insertion index within that ordered lane,
//   - → beforeId = the row id immediately ABOVE the index, afterId = the row id
//     immediately BELOW. Either may be null (top / bottom / empty lane).
//
// Optimistic IDs: a freshly-dropped card has no server id yet. We assign a negative
// temp id so the reducer can order/track it; on the server's echo we swap the temp
// id for the real one. A revert removes the temp card (or restores the prior state).

import type {
  PlanAssignment, PlanCardStatus, Half, Weekday,
} from './plannerTypes';

// The reducer's unit. Extends the server PlanAssignment with an optimistic flag so
// the UI can show a freshly-dropped card before persistence confirms.
export interface PlanItem extends PlanAssignment {
  optimistic?: boolean; // true until the server echoes a real id
}

export interface PlanState {
  // Flat list keyed by the plan_assignments row id (negative = optimistic temp).
  items: PlanItem[];
  // A monotonically-decreasing temp id source for optimistic inserts.
  nextTempId: number;
}

export function emptyPlanState(): PlanState {
  return { items: [], nextTempId: -1 };
}

// Hydrate from GET /api/planner/week (days[wd].{am,pm}). Flattens to the item list.
export function hydratePlan(
  days: Record<number, { am: PlanAssignment[]; pm: PlanAssignment[] }>,
): PlanState {
  const items: PlanItem[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const bucket = days[wd];
    if (!bucket) continue;
    for (const a of bucket.am) items.push({ ...a });
    for (const a of bucket.pm) items.push({ ...a });
  }
  return { items, nextTempId: -1 };
}

// ---- selectors --------------------------------------------------------------

// The task placements in one lane, in display order (by server `position`).
export function laneItems(state: PlanState, weekday: Weekday, half: Half): PlanItem[] {
  return state.items
    .filter((it) => it.weekday === weekday && it.half === half)
    .sort((a, b) => a.position - b.position);
}

// Is this task (namespaced source:id) currently placed anywhere in the plan?
export function findPlacement(
  state: PlanState, source: string, externalTaskId: string,
): PlanItem | undefined {
  return state.items.find((it) => it.source === source && it.externalTaskId === externalTaskId);
}

// Given a target lane's ordered items and an insertion index, resolve the
// neighbor row ids (excluding `selfId` so a move within a lane doesn't pick itself).
export function neighborIdsAt(
  lane: PlanItem[], index: number, selfId: number | null,
): { beforeId: number | null; afterId: number | null } {
  const others = selfId == null ? lane : lane.filter((it) => it.id !== selfId);
  const clamped = Math.min(Math.max(index, 0), others.length);
  const before = clamped > 0 ? others[clamped - 1] : null;
  const after = clamped < others.length ? others[clamped] : null;
  return { beforeId: before ? before.id : null, afterId: after ? after.id : null };
}

// Compute a fractional position from neighbor positions (mirrors the server's
// (prev+next)/2 insert-between, O(1)). Used ONLY for optimistic local ordering;
// the server recomputes authoritatively and echoes the real value.
export function optimisticPosition(
  lane: PlanItem[], beforeId: number | null, afterId: number | null,
): number {
  const posOf = (id: number | null) =>
    id == null ? null : (lane.find((it) => it.id === id)?.position ?? null);
  const before = posOf(beforeId);
  const after = posOf(afterId);
  if (before == null && after == null) return 1000;          // empty lane
  if (before == null && after != null) return after - 1;     // top
  if (before != null && after == null) return before + 1;    // bottom
  return ((before as number) + (after as number)) / 2;       // between
}

// ---- actions ----------------------------------------------------------------

export type PlanAction =
  | { type: 'hydrate'; days: Record<number, { am: PlanAssignment[]; pm: PlanAssignment[] }> }
  // Place/move a task into a lane at a resolved position (optimistic).
  | {
      type: 'place';
      source: string;
      externalTaskId: string;
      weekday: Weekday;
      half: Half;
      position: number;
      tempId?: number;        // when re-placing an existing row, keep its id
      status?: PlanCardStatus;
    }
  // Swap a temp/optimistic id for the server's real id + position after persist.
  | { type: 'confirm'; matchSource: string; matchTaskId: string; serverRow: PlanAssignment }
  // Optimistically flip a PLACED card's weekly-goal flag (drives the teal highlight
  // treatment instantly; the POST/DELETE persists, a failure reverts via 'replace').
  | { type: 'weeklyGoal'; source: string; externalTaskId: string; value: boolean }
  // Optimistically flip a PLACED card's planner-LOCAL completion flag (Iris 20 §7 /
  // migration 004). Drives the done treatment instantly; the POST persists, a failure
  // reverts via 'replace'. Only ever toggles `completedLocal` — never `status` (the
  // source-done reconciliation stays server-authoritative + sticky).
  | { type: 'complete'; source: string; externalTaskId: string; value: boolean }
  // Remove a placement (unschedule, or revert a failed insert).
  | { type: 'remove'; source: string; externalTaskId: string }
  // Replace the whole state (used to revert to a snapshot on persist failure).
  | { type: 'replace'; state: PlanState };

export function planReducer(state: PlanState, action: PlanAction): PlanState {
  switch (action.type) {
    case 'hydrate':
      return hydratePlan(action.days);

    case 'replace':
      return action.state;

    case 'place': {
      const existing = findPlacement(state, action.source, action.externalTaskId);
      const id = existing ? existing.id : (action.tempId ?? state.nextTempId);
      const isNew = !existing;
      const item: PlanItem = {
        id,
        weekday: action.weekday,
        half: action.half,
        source: action.source,
        externalTaskId: action.externalTaskId,
        position: action.position,
        note: existing?.note ?? null,
        status: action.status ?? existing?.status ?? 'live',
        // A placed weekly goal that MOVES to another lane stays a weekly goal (→ a
        // highlight on the new day). Carry the flag through the re-place; new cards
        // start non-goal. (isHighlight === isWeeklyGoal for placed cards.)
        isWeeklyGoal: existing?.isWeeklyGoal ?? false,
        isHighlight: existing?.isWeeklyGoal ?? false,
        // A placed card that MOVES to another lane keeps its planner-local completion
        // (Iris 20 §7). New cards start incomplete. Source-done `status` carries via
        // `status` above; this is the LOCAL flag only.
        completedLocal: existing?.completedLocal ?? false,
        optimistic: existing ? existing.optimistic : true,
      };
      const rest = state.items.filter(
        (it) => !(it.source === action.source && it.externalTaskId === action.externalTaskId),
      );
      return {
        items: [...rest, item],
        nextTempId: isNew && action.tempId == null ? state.nextTempId - 1 : state.nextTempId,
      };
    }

    case 'confirm': {
      return {
        ...state,
        items: state.items.map((it) =>
          it.source === action.matchSource && it.externalTaskId === action.matchTaskId
            ? {
                ...it,
                id: action.serverRow.id,
                position: action.serverRow.position,
                weekday: action.serverRow.weekday,
                half: action.serverRow.half,
                optimistic: false,
              }
            : it,
        ),
      };
    }

    case 'weeklyGoal':
      return {
        ...state,
        items: state.items.map((it) =>
          it.source === action.source && it.externalTaskId === action.externalTaskId
            // For a placed card, weekly-goal ⟺ highlight (placed by construction).
            ? { ...it, isWeeklyGoal: action.value, isHighlight: action.value }
            : it,
        ),
      };

    case 'complete':
      return {
        ...state,
        items: state.items.map((it) =>
          it.source === action.source && it.externalTaskId === action.externalTaskId
            ? { ...it, completedLocal: action.value }
            : it,
        ),
      };

    case 'remove':
      return {
        ...state,
        items: state.items.filter(
          (it) => !(it.source === action.source && it.externalTaskId === action.externalTaskId),
        ),
      };

    default:
      return state;
  }
}
