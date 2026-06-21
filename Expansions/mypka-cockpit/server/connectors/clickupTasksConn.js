// connectors/clickupTasksConn.js — ClickUp TaskConnector (Wave 2, Mack).
//
// A REFOLD of clickupTasks.js under the connector contract. It reuses Mack's
// existing READ-ONLY clickup.js client (getOpenTasks) and re-emits a FLAT
// NormalizedTask[]. clickupTasks.js groups by list/space for the BPM slot; the
// planner board groups by day/half, so that grouping is dropped here.
//
// POSTURE: READ-ONLY. assignedToMe is enforced upstream by clickup.js
// (assignees[] = the connected user's id, derived from the token via GET /user).
// Week-window filter mirrors the Todoist connector: overdue kept, due-within-week
// kept, dateless excluded.
//
// editableFields: [] — ClickUp has NO write path in the cockpit today (clickup.js
// is read-only by construction) and we are NOT adding one. A ClickUp card can be
// PLACED on the board (local plan-layout state) but its due/priority are not
// editable from the cockpit in v1.

import { createClickUpClient } from './clickup.js';
import { clampPriorityRank, weekWindow, dayInWeek, degraded, ok, DISPLAY_TZ } from './types.js';

const TIMEOUT_MS = 12_000;
const SOURCE = 'clickup';

function berlinToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ClickUp priority is NOT inverted: id 1 = urgent (highest) … 4 = low; unset = null.
// Normalized 1..5 maps 1..4 through verbatim, null → 5.
function priorityRank(priorityId) {
  if (priorityId == null || !Number.isFinite(priorityId)) return 5;
  return clampPriorityRank(priorityId);
}

function msToBerlinDay(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
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

export function makeClickUpConnector(opts = {}) {
  const id = opts.id || SOURCE;
  return {
    id,
    kind: 'task',
    label: opts.label || 'ClickUp',

    /** fetchWeek(weekStart) → ConnectorResult<NormalizedTask>. Never throws. */
    async fetchWeek(weekStart) {
      const today = berlinToday();
      const window = weekWindow(weekStart, DISPLAY_TZ);

      let client;
      try {
        client = createClickUpClient();
      } catch {
        return degraded(id, 'no-token', 'ClickUp is not connected (no token configured).');
      }

      let tasksRaw;
      try {
        tasksRaw = await withTimeout(client.getOpenTasks(), TIMEOUT_MS, 'ClickUp read');
      } catch {
        return degraded(id, 'unreachable', 'ClickUp is currently unreachable.');
      }

      const items = [];
      for (const t of tasksRaw) {
        const day = msToBerlinDay(t.dueDate);
        if (!day) continue; // dateless → excluded from the planner sidebar
        const bucket = dueBucketOf(day, today);
        if (bucket !== 'overdue' && !dayInWeek(day, window.startDay, window.endDay)) continue;
        items.push({
          kind: 'task',
          source: id,
          id: String(t.id),
          title: t.name,
          // clickup.js already picked the clean plaintext body (text_content, else
          // description) and trimmed it. Always a string — '' when absent.
          description: t.description || '',
          due: day,
          dueBucket: bucket,
          priorityRank: priorityRank(t.priorityId),
          url: t.url || null,
          tags: Array.isArray(t.tags) ? t.tags : [],
          status: t.status || null,
          assignedToMe: true,
          editableFields: [],
        });
      }
      return ok(id, items);
    },

    /**
     * reconcileOpenIds() → { ok, ids:Set<string> }. Never throws.
     *
     * The COMPLETION-truth source for plan reconciliation. Unlike fetchWeek (which
     * narrows to the planner sidebar's week-window + drops dateless tasks), this
     * returns the id set of EVERY open task assigned to the user, with NO date filter.
     *
     * Why this exists: a planned card must only be tagged 'done' when the source task
     * is ACTUALLY completed. clickup.getOpenTasks() queries include_closed=false, so a
     * completed/closed task is already absent — and we additionally drop any task whose
     * statusType is 'done'|'closed' (defensive: a custom status mid-pipeline that the
     * API still returns as open should stay 'live', but a true done/closed never counts
     * as open). "Not due this week" is NOT absence here (no week filter), so `!ids.has(id)`
     * on an ok fetch is a true completion signal, not a window artifact.
     *
     * On any failure returns { ok:false, ids:new Set() } so the caller degrades to
     * 'stale' (never prune/never strike-through on a blip).
     */
    async reconcileOpenIds() {
      let client;
      try {
        client = createClickUpClient();
      } catch {
        return { ok: false, ids: new Set() };
      }
      try {
        const tasksRaw = await withTimeout(client.getOpenTasks(), TIMEOUT_MS, 'ClickUp reconcile read');
        const ids = new Set();
        for (const t of tasksRaw || []) {
          const st = (t.statusType || '').toLowerCase();
          if (st === 'done' || st === 'closed') continue; // genuinely completed → not open
          ids.add(String(t.id));
        }
        return { ok: true, ids };
      } catch {
        return { ok: false, ids: new Set() };
      }
    },
  };
}

export default makeClickUpConnector;
