// todoist.js — reusable Todoist client for the myPKA Cockpit.
//
// EXAMPLE CONNECTOR — disabled by default. Ships as reference source so the user's
// LLM assistant can study the pattern and wire their own Todoist. It activates only
// when its .env key resolves AND the connectors group is enabled (CONNECTORS_ENABLED,
// see registry.js / .env.example). See server/connectors/README.md.
//
// PURPOSE
//   The cockpit Express server runs standalone (loopback-only) and CANNOT use
//   the Claude-session Todoist MCP. This module is its own Node API client so
//   the "Tasks / Today" page can read the connected user's open tasks — directly
//   against the Todoist REST API, token read from the environment.
//
// API VERSION
//   Uses the unified Todoist API v1 (https://api.todoist.com/api/v1). The legacy
//   REST v2 (/rest/v2) returns HTTP 410 Gone as of 2026 — do NOT target it.
//   v1 list endpoints return { results: [...], next_cursor: <string|null> };
//   this client transparently follows next_cursor so callers get a flat array.
//
// CREDENTIALS (hard rule — never hardcode)
//   The token is read from process.env.TODOIST_API_TOKEN. If that env var is not
//   set (e.g. the cockpit launched without exporting it), the module falls back
//   to reading `Team Knowledge/.env` at the repo root — the canonical, gitignored
//   secret store. The token value is NEVER logged, echoed, or written anywhere.
//
// INTERFACE (for Felix — stable, import-ready)
//   import { createTodoistClient } from './todoist.js';
//   const todoist = createTodoistClient();          // throws if no token found
//   await todoist.ping();                            // { ok, projectCount }
//   await todoist.getProjects();                     // [{ id, name, isInbox }]
//   await todoist.getOpenTasks({ projectId? });      // [{ id, content, ... }]
//   await todoist.getProjectByName('Gesundheit');    // project | null
//   await todoist.ensureProject('Gesundheit');       // project (create if absent)
//   await todoist.createTask({ content, projectId, description?, labels?, dueString? });
//   await todoist.findTaskByLabel(projectId, label); // task | null  (idempotency)
//
//   The cockpit's read-only posture is preserved by DEFAULT: only getProjects /
//   getOpenTasks / ping are needed for the "Tasks / Today" page. The write methods
//   (ensureProject / createTask) exist for the approved one-way health-action push
//   ONLY and must be gated behind the user's explicit opt-in before any HTTP route
//   exposes them. Do not wire a write route without Vex sign-off.

import fs from 'node:fs';
import path from 'node:path';
// Shared resolver (one dir up from connectors/). See repoRoot.js for the order.
import { REPO_ROOT } from '../repoRoot.js';

const ENV_PATH = path.resolve(REPO_ROOT, 'Team Knowledge', '.env');

const API_BASE = 'https://api.todoist.com/api/v1';

// --- token resolution (env first, then the canonical gitignored .env) ---------
// Returns the raw token string or null. Never logs the value.
function resolveToken() {
  if (process.env.TODOIST_API_TOKEN && process.env.TODOIST_API_TOKEN.trim()) {
    return process.env.TODOIST_API_TOKEN.trim();
  }
  // Fallback: parse just the one line out of Team Knowledge/.env. We do NOT load
  // the whole file into process.env — only this single key, to keep blast radius
  // minimal and avoid leaking unrelated secrets into the cockpit process.
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*TODOIST_API_TOKEN\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* .env absent or unreadable — fall through to null */
  }
  return null;
}

// Mask a token for any diagnostic surface: never expose more than the last 4.
function maskToken(t) {
  if (!t) return '<none>';
  return `***${t.slice(-4)} (len=${t.length})`;
}

// Open-in-Todoist deep link. The Todoist v1 API task object carries NO `url`
// field (verified live 2026-06-03: undefined on every task), so we CONSTRUCT the
// canonical deep link from the task id. Two candidate forms were probed against a
// real v1 id (alphanumeric, e.g. "6gmXC4W26fG6Vrx7"):
//   - https://app.todoist.com/app/task/<id>   -> HTTP 200 (current web app) ✓
//   - https://todoist.com/showTask?id=<id>    -> HTTP 404 (legacy; only ever
//                                                 resolved for the OLD numeric ids)
// So `showTask` is a dead fallback for current ids — we use the app form only.
// If a future API ever does return a real `url`, we prefer it verbatim.
// READ-ONLY: this is pure string construction from the id, no API call.
function todoistTaskUrl(apiUrl, id) {
  if (apiUrl && typeof apiUrl === 'string' && apiUrl.trim()) return apiUrl;
  if (id === undefined || id === null || String(id).trim() === '') return null;
  return `https://app.todoist.com/app/task/${encodeURIComponent(String(id))}`;
}

// --- low-level request helper: retry + 429 backoff + JSON ---------------------
async function apiRequest(token, method, endpoint, body, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const url = `${API_BASE}${endpoint}`;
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) throw err;
    await sleep(2 ** attempt * 1000);
    return apiRequest(token, method, endpoint, body, attempt + 1);
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || '5');
    await sleep(retryAfter * 1000);
    if (attempt >= MAX_ATTEMPTS) throw new Error('Todoist rate limit: retries exhausted');
    return apiRequest(token, method, endpoint, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    // The error text from Todoist never contains the token; safe to surface.
    throw new Error(`Todoist ${method} ${endpoint} -> HTTP ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Walk a paginated v1 list endpoint, concatenating .results across cursors.
async function listAll(token, endpoint) {
  const out = [];
  let cursor = null;
  do {
    const sep = endpoint.includes('?') ? '&' : '?';
    const ep = cursor ? `${endpoint}${sep}cursor=${encodeURIComponent(cursor)}` : endpoint;
    const page = await apiRequest(token, 'GET', ep);
    if (Array.isArray(page)) return page; // defensive: some endpoints return a bare array
    out.push(...(page.results || []));
    cursor = page.next_cursor || null;
  } while (cursor);
  return out;
}

// --- public factory -----------------------------------------------------------
export function createTodoistClient(opts = {}) {
  const token = opts.token || resolveToken();
  if (!token) {
    throw new Error(
      `TODOIST_API_TOKEN not found. Set it in the environment or in ${ENV_PATH}.`
    );
  }

  const normalizeProject = (p) => ({
    id: p.id,
    name: p.name,
    isInbox: Boolean(p.is_inbox_project),
    color: p.color,
    url: p.url,
  });

  return {
    /** Token fingerprint for safe logging. Never the full value. */
    tokenFingerprint() {
      return maskToken(token);
    },

    /** Connectivity probe: { ok, projectCount }. */
    async ping() {
      const projects = await listAll(token, '/projects');
      return { ok: true, projectCount: projects.length };
    },

    /** All projects as [{ id, name, isInbox, color, url }]. */
    async getProjects() {
      const projects = await listAll(token, '/projects');
      return projects.map(normalizeProject);
    },

    /** First project whose name matches exactly (case-insensitive), or null. */
    async getProjectByName(name) {
      const target = String(name).trim().toLowerCase();
      const projects = await this.getProjects();
      return projects.find((p) => p.name.trim().toLowerCase() === target) || null;
    },

    /** Get-or-create a project by name. Returns the (existing or new) project. */
    async ensureProject(name) {
      const existing = await this.getProjectByName(name);
      if (existing) return existing;
      const created = await apiRequest(token, 'POST', '/projects', { name });
      return normalizeProject(created);
    },

    /** Open (active) tasks, optionally scoped to one project. */
    async getOpenTasks({ projectId } = {}) {
      const ep = projectId ? `/tasks?project_id=${encodeURIComponent(projectId)}` : '/tasks';
      const tasks = await listAll(token, ep);
      return tasks.map((t) => ({
        id: t.id,
        content: t.content,
        description: t.description,
        projectId: t.project_id,
        labels: t.labels || [],
        priority: t.priority,
        due: t.due || null,
        // v1 API returns no `url`; construct the deep link from the id so every
        // task carries a working "Open in Todoist" link. Non-null for every task.
        url: todoistTaskUrl(t.url, t.id),
      }));
    },

    /**
     * Find an open task in a project that carries a given label.
     * This is the idempotency primitive: every pushed health action gets a
     * deterministic marker label, so a re-run can detect "already pushed."
     */
    async findTaskByLabel(projectId, label) {
      const tasks = await this.getOpenTasks({ projectId });
      return tasks.find((t) => (t.labels || []).includes(label)) || null;
    },

    /** Create a task. Returns the created task (normalized). */
    async createTask({ content, projectId, description, labels, dueString, priority }) {
      if (!content) throw new Error('createTask: content is required');
      const payload = { content };
      if (projectId) payload.project_id = projectId;
      if (description) payload.description = description;
      if (labels && labels.length) payload.labels = labels;
      if (dueString) payload.due_string = dueString;
      if (priority) payload.priority = priority;
      const t = await apiRequest(token, 'POST', '/tasks', payload);
      return {
        id: t.id,
        content: t.content,
        projectId: t.project_id,
        labels: t.labels || [],
        url: todoistTaskUrl(t.url, t.id),
      };
    },

    /**
     * SCOPE-LOCKED task update — the cockpit "Actions" write path.
     *
     * Updates ONLY a task's due date and/or priority. This is deliberately the
     * narrowest possible write surface: it is the first user-initiated write
     * route the cockpit exposes (the user editing their own tasks from the dashboard),
     * so the method is hard-locked to those two fields. Any other field passed
     * in the object — content, projectId, labels, section, description, etc. —
     * is IGNORED, not forwarded. There is no path through this method that can
     * rename a task, move it, relabel it, or delete it. Adding a field here is a
     * scope change that requires Vex re-review.
     *
     * Targets the Todoist v1 update-task endpoint:
     *   POST https://api.todoist.com/api/v1/tasks/{id}
     * (v1 uses POST, not PATCH/PUT, for partial task updates.)
     *
     * @param {string} id  Todoist task id (required).
     * @param {object} fields
     * @param {string|null} [fields.dueDate]  ISO date string ("YYYY-MM-DD") sent
     *   as `due_date`. Pass `null` to CLEAR the due date (sent as `due_string: 'no date'`,
     *   the v1 idiom for "no due date"). Omit the key entirely to leave the due
     *   date untouched.
     * @param {1|2|3|4} [fields.priority]  Todoist API priority convention:
     *   **4 = P1 (highest) … 1 = P4 (none / default)** — i.e. INVERTED vs. the
     *   human "P1 is highest" label. The caller (Felix's UI) already maps
     *   API<->human for display; this method takes and forwards the RAW API
     *   value (1..4). Omit the key to leave priority untouched.
     *
     * Returns the updated task (normalized to the read shape so the route can
     * echo it straight back to the client). Never returns or logs the token.
     */
    async updateTask(id, fields = {}) {
      if (!id) throw new Error('updateTask: id is required');

      // Build the payload from ONLY the two allowed keys. We read named
      // properties off `fields` — any extra keys on the object are structurally
      // unreachable here, so unknown fields can never leak into the request.
      const payload = {};

      // priority: only forward when explicitly provided and a valid 1..4 int.
      if (Object.prototype.hasOwnProperty.call(fields, 'priority')) {
        const p = fields.priority;
        if (!Number.isInteger(p) || p < 1 || p > 4) {
          throw new Error('updateTask: priority must be an integer 1..4 (Todoist API convention; 4 = highest)');
        }
        payload.priority = p;
      }

      // dueDate: ISO date string sets it; explicit null clears it. `undefined`
      // (key absent) leaves it untouched. The v1 endpoint takes `due_date` for a
      // full-day date; to clear, it takes `due_string: 'no date'`.
      if (Object.prototype.hasOwnProperty.call(fields, 'dueDate')) {
        const d = fields.dueDate;
        if (d === null) {
          payload.due_string = 'no date';
        } else if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d))) {
          payload.due_date = d;
        } else {
          throw new Error('updateTask: dueDate must be an ISO date string "YYYY-MM-DD" or null to clear');
        }
      }

      if (Object.keys(payload).length === 0) {
        throw new Error('updateTask: nothing to update — provide dueDate and/or priority');
      }

      // v1 partial update is a POST to /tasks/{id}.
      const t = await apiRequest(token, 'POST', `/tasks/${encodeURIComponent(id)}`, payload);
      // Normalize to the read shape (same fields the page already consumes).
      return {
        id: t.id,
        content: t.content,
        description: t.description,
        projectId: t.project_id,
        labels: t.labels || [],
        priority: t.priority,
        due: t.due || null,
        url: todoistTaskUrl(t.url, t.id),
      };
    },

    /**
     * CLOSE (complete) a task — status transition only, nothing else.
     *
     * The close-session "task reconciliation" write path (step 2.6). The team
     * may only reach this AFTER the user has confirmed a proposed close-list; there is
     * no content/label/project mutation here — Todoist's close endpoint marks the
     * task done and that is the entire blast radius. Cannot rename, move, relabel,
     * reschedule, or delete.
     *
     * Targets the v1 close endpoint: POST /api/v1/tasks/{id}/close (returns 204).
     * Idempotent in practice: a 404 (already closed / already gone) resolves to
     * { ok:false, alreadyGone:true } rather than throwing, so a re-run is safe.
     */
    async closeTask(id) {
      if (!id) throw new Error('closeTask: id is required');
      try {
        await apiRequest(token, 'POST', `/tasks/${encodeURIComponent(id)}/close`);
        return { ok: true, id };
      } catch (err) {
        if (String(err.message).includes('HTTP 404')) {
          return { ok: false, id, alreadyGone: true };
        }
        throw err;
      }
    },

    /**
     * completeTask(id) — VEX-GATED source-complete alias (Iris spec 20 §7, layer B).
     *
     * The planner's "complete on source" path calls completeTask(id) uniformly
     * across connectors. For Todoist, completing == closing, so this delegates
     * VERBATIM to closeTask (POST /tasks/{id}/close) — no new blast radius, no new
     * HTTP surface; it is the same status-transition-only call under the name the
     * route layer expects. DORMANT unless the route is armed by BOTH the
     * complete_on_source setting AND SOURCE_WRITE_ENABLED==='1'. See plannerRoutes.js.
     */
    async completeTask(id) {
      return this.closeTask(id);
    },
  };
}

export default createTodoistClient;
