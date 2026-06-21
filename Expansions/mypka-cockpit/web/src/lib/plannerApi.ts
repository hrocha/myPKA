// plannerApi.ts — the planner's WRITE client (the cockpit's first UI→server write).
//
// Every write sits behind the server's PLAN_WRITE_ENABLED flag. Until Vex clears it,
// the routes return 503 { ok:false, reason:'disabled' }. We surface that as a
// distinct, NON-error outcome so the UI can keep its optimistic local state and show
// a calm "planning is read-only until enabled" hint — never error spam.
//
// Mirrors the existing write posture (cockpitTaskActions.ts PATCH): same-origin,
// X-Cockpit header (the localWriteGuard's CSRF check reads `X-Cockpit`, NOT
// `X-Cockpit-Write` — sending the wrong name made every planner write 403 →
// revert → "couldn't save", i.e. the drag appeared dead even though dnd-kit fired),
// JSON body, 401 → bounce to PIN via signalAuthExpired.

import { signalAuthExpired } from './auth';
import type {
  AssignBody, ReorderBody, UnassignBody, SettingsBody, WeeklyGoalBody, CompleteBody,
  WriteResponse,
} from './plannerTypes';

// The result the UI reacts to. `disabled` is calm (keep optimistic state); `error`
// triggers a revert + a calm toast; `ok` confirms (swap temp id for the real row).
export type WriteOutcome =
  | { kind: 'ok'; body: Extract<WriteResponse, { ok: true }> }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string };

async function writeRequest(
  method: 'POST' | 'DELETE' | 'PUT',
  url: string,
  body: unknown,
): Promise<WriteOutcome> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit': '1' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { kind: 'error', message: (err as Error).message || 'network error' };
  }

  if (res.status === 401) {
    signalAuthExpired();
    return { kind: 'error', message: 'unauthorized' };
  }
  // 503 with reason:'disabled' is the dormant write path — a calm, expected state.
  if (res.status === 503) {
    return { kind: 'disabled' };
  }

  let json: WriteResponse | null = null;
  try {
    json = (await res.json()) as WriteResponse;
  } catch {
    /* fallthrough to status-based error */
  }
  if (json && json.ok) return { kind: 'ok', body: json };
  // Defensive: a JSON body may still carry reason:'disabled' on a non-503 status.
  if (json && json.ok === false && json.reason === 'disabled') return { kind: 'disabled' };
  const message = (json && json.ok === false && 'error' in json && json.error)
    ? json.error
    : `server responded ${res.status}`;
  return { kind: 'error', message };
}

export function assignPlacement(body: AssignBody): Promise<WriteOutcome> {
  return writeRequest('POST', '/api/planner/assign', body);
}
export function reorderPlacement(body: ReorderBody): Promise<WriteOutcome> {
  return writeRequest('POST', '/api/planner/reorder', body);
}
export function unassignPlacement(body: UnassignBody): Promise<WriteOutcome> {
  return writeRequest('DELETE', '/api/planner/assign', body);
}
export function saveSettings(body: SettingsBody): Promise<WriteOutcome> {
  return writeRequest('PUT', '/api/planner/settings', body);
}

// Weekly-goal flag (Migration 003). Same calm posture as every other write: a 503
// `disabled` keeps the optimistic local state; a genuine error reverts. The server
// route is idempotent, so a double-fire (set→set / unset→unset) is a harmless no-op.
export function setWeeklyGoal(body: WeeklyGoalBody): Promise<WriteOutcome> {
  return writeRequest('POST', '/api/planner/weekly-goal', body);
}
export function unsetWeeklyGoal(body: WeeklyGoalBody): Promise<WriteOutcome> {
  return writeRequest('DELETE', '/api/planner/weekly-goal', body);
}

// Complete / un-complete a placed task (Iris 20 §7 / migration 004). Same calm posture
// as every other write: a 503 `disabled` keeps the optimistic local state; a genuine
// error reverts. `completed:false` un-completes a LOCAL completion only — the server
// guards against re-opening a SOURCE-done task. Body is camelCase per Mack's contract
// (weekStart/externalTaskId), NOT the snake_case shape the assign/weekly-goal routes use.
export function completePlacement(body: CompleteBody): Promise<WriteOutcome> {
  return writeRequest('POST', '/api/planner/complete', body);
}
