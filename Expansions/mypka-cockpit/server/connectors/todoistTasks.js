// connectors/todoistTasks.js — Todoist TaskConnector (Wave 2, Mack).
//
// A REFOLD of tasks.js under the connector contract. It reuses Mack's existing
// READ-ONLY todoist.js client (getProjects + getOpenTasks) and re-emits a FLAT
// NormalizedTask[] — the planner board groups by day/half, not by project, so the
// project grouping that tasks.js does for the Actions page is dropped here.
//
// POSTURE: READ-ONLY. Imports only the READ methods. assignedToMe is intrinsic — a
// Todoist personal token only ever returns the token-owner's own tasks. The week
// window filter keeps overdue (most actionable) + due-within-week tasks; dateless
// tasks are excluded from the planner sidebar (the planner is week-scoped). Never
// throws to the route — degrades calmly.
//
// editableFields: ['due','priority'] — the EXISTING scope-locked
//   PATCH /api/cockpit/tasks/:id supports exactly these two. The board reuses that
//   path verbatim; no new write surface is added here.

import { createTodoistClient } from './todoist.js';
import { clampPriorityRank, weekWindow, dayInWeek, degraded, ok, DISPLAY_TZ } from './types.js';

const TIMEOUT_MS = 12_000;
const SOURCE = 'todoist';

function berlinToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Todoist priority is INVERTED: API 4 = P1 (highest) … 1 = none. Map into the
// normalized 1..5 (1 = highest, 5 = none): 4→1, 3→2, 2→3, 1→4, unset→5.
function priorityRank(apiPriority) {
  if (!apiPriority || apiPriority === 1) return apiPriority === 1 ? 4 : 5;
  return clampPriorityRank(5 - apiPriority);
}

function dueBucketOf(day, today) {
  if (!day) return 'none';
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'upcoming';
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function makeTodoistConnector(opts = {}) {
  const id = opts.id || SOURCE;
  return {
    id,
    kind: 'task',
    label: opts.label || 'Todoist',

    /** fetchWeek(weekStart) → ConnectorResult<NormalizedTask>. Never throws. */
    async fetchWeek(weekStart) {
      const today = berlinToday();
      const window = weekWindow(weekStart, DISPLAY_TZ);

      let client;
      try {
        client = createTodoistClient();
      } catch {
        return degraded(id, 'no-token', 'Todoist is not connected (no token configured).');
      }

      let tasksRaw;
      try {
        tasksRaw = await withTimeout(client.getOpenTasks(), TIMEOUT_MS, 'Todoist read');
      } catch {
        return degraded(id, 'unreachable', 'Todoist is currently unreachable.');
      }

      const items = [];
      for (const t of tasksRaw) {
        const day = t.due && t.due.date ? String(t.due.date).slice(0, 10) : null;
        // Keep overdue tasks regardless of week (most actionable); else keep only
        // tasks due within [weekStart, weekStart+7d). Dateless → excluded.
        if (!day) continue;
        const bucket = dueBucketOf(day, today);
        if (bucket !== 'overdue' && !dayInWeek(day, window.startDay, window.endDay)) continue;
        items.push({
          kind: 'task',
          source: id,
          id: String(t.id),
          title: t.content,
          // Todoist REST returns a `description` field per task (markdown-ish plain
          // text). Always a string in the normalized shape — '' when absent. Trim
          // trailing whitespace; pass the full text (Felix handles display/truncation).
          description: (t.description || '').replace(/\s+$/, ''),
          due: day,
          dueBucket: bucket,
          priorityRank: priorityRank(t.priority),
          url: t.url || null,
          tags: Array.isArray(t.labels) ? t.labels : [],
          status: null,
          assignedToMe: true,
          editableFields: ['due', 'priority'],
        });
      }
      return ok(id, items);
    },

    /**
     * reconcileOpenIds() → { ok, ids:Set<string> }. Never throws.
     *
     * The COMPLETION-truth source for plan reconciliation. Unlike fetchWeek (which
     * narrows to the planner sidebar's week-window + drops dateless tasks),this returns
     * the id set of EVERY open/active task the token owner has, with NO date filter.
     *
     * Why this exists: a planned card must only be tagged 'done' when the source task
     * is ACTUALLY completed. Todoist's GET /tasks returns active tasks only — a task
     * missing from it is genuinely closed/completed (or deleted). "Not due this week"
     * is NOT absence here, because there is no week filter. So `!ids.has(id)` on an
     * ok fetch is a true completion signal, not a window artifact.
     *
     * On any failure returns { ok:false, ids:new Set() } so the caller degrades to
     * 'stale' (never prune/never strike-through on a blip).
     */
    async reconcileOpenIds() {
      let client;
      try {
        client = createTodoistClient();
      } catch {
        return { ok: false, ids: new Set() };
      }
      try {
        const tasksRaw = await withTimeout(client.getOpenTasks(), TIMEOUT_MS, 'Todoist reconcile read');
        return { ok: true, ids: new Set((tasksRaw || []).map((t) => String(t.id))) };
      } catch {
        return { ok: false, ids: new Set() };
      }
    },
  };
}

export default makeTodoistConnector;
