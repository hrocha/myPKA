// clickup.js — reusable, READ-ONLY ClickUp client for the myPKA Cockpit.
//
// EXAMPLE CONNECTOR — disabled by default. This ships as reference source so the
// user's LLM assistant can study the pattern and wire their OWN ClickUp (or adapt
// it for another PM tool). It does NOT activate on a fresh install: it loads only
// when its .env key resolves AND the connectors group is enabled (see registry.js /
// CONNECTORS_ENABLED in .env.example). See server/connectors/README.md.
//
// PURPOSE
//   The cockpit Express server runs standalone (loopback-only) and CANNOT use the
//   Claude-session ClickUp MCP. This module is its own Node API client so the
//   cockpit's task connection slot can READ the connected user's open ClickUp
//   tasks — directly against the ClickUp REST API v2, token read from the
//   environment.
//
//   Mirrors the shape/interface of todoist.js so the UI's task slot consumes it
//   identically to the Todoist read surface. The two clients are siblings:
//   Todoist and ClickUp are independent task sources the user can connect.
//
// POSTURE (hard — read-mostly, ONE Vex-gated write)
//   Reads: ping / getSpaces / getOpenTasks. These are the module's whole everyday
//   surface and remain READ-ONLY.
//   Write: completeTask(id) — the connector's FIRST and ONLY write method (Iris
//   spec 20 §7, source-complete, layer B). It does ONE thing: transition a task to
//   its list's done/closed-type status. It cannot rename, move, relabel, reschedule,
//   or delete. It is DORMANT by construction: nothing calls it unless the route layer
//   is armed by BOTH the complete_on_source setting AND the SOURCE_WRITE_ENABLED env
//   gate (default OFF). Adding ANY other mutating method — or widening this one — is
//   a scope change that requires Vex re-review.
//
// API VERSION
//   ClickUp REST API v2 (https://api.clickup.com/api/v2). The "filtered team
//   tasks" endpoint (GET /team/{team_id}/task) returns the workspace's tasks with
//   list/folder/space context attached per task, which is exactly what the BPM
//   slot groups by. It paginates by integer `page` (NOT a cursor) and signals the
//   end with `last_page: true`; this client follows pages transparently so callers
//   get a flat array.
//
// AUTH (important difference vs Todoist)
//   ClickUp personal API tokens go in the Authorization header RAW — NO "Bearer"
//   prefix (a "pk_..." token). OAuth access tokens would also go raw. We send the
//   token value verbatim as the Authorization header.
//
// CREDENTIALS (hard rule — never hardcode)
//   The token is read from process.env.CLICKUP_API_KEY. If that env var is not set
//   (e.g. the cockpit launched without exporting it), the module falls back to
//   reading a SINGLE line out of `Team Knowledge/.env` at the repo root — the
//   canonical, gitignored secret store. We do NOT load the whole .env into
//   process.env — only this one key, to keep blast radius minimal and avoid
//   leaking unrelated secrets into the cockpit process. The token value is NEVER
//   logged, echoed, or written anywhere.
//
//   The team/workspace id is read the same way from CLICKUP_TEAM_ID (it is not a
//   secret, but co-locating it with the token keeps config in one place). It can
//   also be passed explicitly to the factory.
//
// INTERFACE (for Felix — stable, import-ready)
//   import { createClickUpClient } from './clickup.js';
//   const clickup = createClickUpClient();        // throws if no token found
//   await clickup.ping();                          // { ok, taskCount }
//   await clickup.getSpaces();                     // [{ id, name }]
//   await clickup.getOpenTasks({ assigneeId? });   // [{ id, name, status, ... }]
//
//   The cockpit's read-only posture is total here: only getSpaces / getOpenTasks /
//   ping exist. There is no write method to gate.

import fs from 'node:fs';
import path from 'node:path';
// Shared resolver (one dir up from connectors/). See repoRoot.js for the order.
import { REPO_ROOT } from '../repoRoot.js';

const ENV_PATH = path.resolve(REPO_ROOT, 'Team Knowledge', '.env');

const API_BASE = 'https://api.clickup.com/api/v2';

// The "assigned to me" scope for the task read.
//
// The CORRECT way to scope to the connected user is to derive their id from the
// token (GET /user → user.id) — never hard-code it (see server/connectors/README.md
// §"Filtering 'assigned to me'"). resolveAssigneeId() does exactly that, with a
// per-client memo so it costs one extra request per process, not per fetch.
//
// CLICKUP_ASSIGNEE_ID is an OPTIONAL env override for the rare case where a user
// wants to watch a DIFFERENT assignee than the token owner; when unset (the
// default), the id is derived from the token. EXAMPLE_CLICKUP_ASSIGNEE_ID below
// is an inert placeholder shown only in diagnostics — it is never used as a real id.
const EXAMPLE_CLICKUP_ASSIGNEE_ID = 'EXAMPLE_0000000'; // illustrative only — replaced at runtime by the token owner's id

// --- single-key .env parse (env first, then the canonical gitignored .env) -----
// Returns the raw value for `key` or null. Never logs the value. Reads ONLY the
// one requested line — never loads the whole file into process.env.
function readEnvKey(key) {
  if (process.env[key] && String(process.env[key]).trim()) {
    return String(process.env[key]).trim();
  }
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`);
    for (const line of raw.split('\n')) {
      const m = line.match(re);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* .env absent or unreadable — fall through to null */
  }
  return null;
}

function resolveToken() {
  return readEnvKey('CLICKUP_API_KEY');
}

// Optional explicit assignee override (watch someone other than the token owner).
// Unset by default → the id is derived from the token via GET /user. Never a secret.
function resolveAssigneeOverride() {
  return readEnvKey('CLICKUP_ASSIGNEE_ID');
}

function resolveTeamId() {
  return readEnvKey('CLICKUP_TEAM_ID');
}

// Mask a token for any diagnostic surface: never expose more than the last 4.
function maskToken(t) {
  if (!t) return '<none>';
  return `***${t.slice(-4)} (len=${t.length})`;
}

// --- low-level request helper: retry + 429 backoff + JSON ---------------------
// ClickUp token goes in Authorization RAW (no "Bearer" prefix).
// `body` is optional and JSON-encoded when present (used ONLY by the Vex-gated
// completeTask write path below — every read call passes no body, so the read
// posture is structurally unchanged).
async function apiRequest(token, method, endpoint, body, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const url = `${API_BASE}${endpoint}`;
  const headers = { Authorization: token };
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
    // ClickUp rate-limit headers: X-RateLimit-Reset is an epoch-seconds timestamp.
    // Fall back to Retry-After, then a small fixed wait.
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    let waitMs;
    if (Number.isFinite(reset) && reset > 0) {
      waitMs = Math.max(1000, reset * 1000 - Date.now());
    } else {
      waitMs = Number(res.headers.get('retry-after') || '5') * 1000;
    }
    await sleep(Math.min(waitMs, 30_000));
    if (attempt >= MAX_ATTEMPTS) throw new Error('ClickUp rate limit: retries exhausted');
    return apiRequest(token, method, endpoint, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    // ClickUp error bodies are JSON like {"err":"...","ECODE":"..."} and never
    // contain the token; safe to surface for diagnostics. (The route layer still
    // degrades to a generic reason so this text never reaches the browser.)
    throw new Error(`ClickUp ${method} ${endpoint} -> HTTP ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Walk the page-indexed "filtered team tasks" endpoint, concatenating .tasks
// across pages. ClickUp paginates by integer `page` and sets `last_page: true`
// on the final page (and returns 100 tasks/page). We stop on last_page OR an
// empty page OR a hard page cap (defensive against an upstream that never flags
// last_page — caps the blast radius at 20 pages / 2000 tasks).
async function listAllTasks(token, baseEndpoint) {
  const out = [];
  const MAX_PAGES = 20;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = baseEndpoint.includes('?') ? '&' : '?';
    const ep = `${baseEndpoint}${sep}page=${page}`;
    const data = await apiRequest(token, 'GET', ep);
    const tasks = (data && data.tasks) || [];
    out.push(...tasks);
    if (!tasks.length || (data && data.last_page === true)) break;
  }
  return out;
}

// --- public factory -----------------------------------------------------------
export function createClickUpClient(opts = {}) {
  const token = opts.token || resolveToken();
  if (!token) {
    throw new Error(
      `CLICKUP_API_KEY not found. Set it in the environment or in ${ENV_PATH}.`
    );
  }
  const teamId = opts.teamId || resolveTeamId();
  if (!teamId) {
    throw new Error(
      `CLICKUP_TEAM_ID not found. Set it in the environment or in ${ENV_PATH}.`
    );
  }

  const normalizeSpace = (s) => ({ id: s.id, name: s.name });

  // Normalize one raw ClickUp task into a flat, render-ready shape. Carries
  // nothing sensitive — pure display data the BPM slot consumes. The grouping
  // context (list / folder / space) is preserved so the route can group by it.
  const normalizeTask = (t) => ({
    id: t.id,
    name: t.name,
    // Task body for the cockpit's detail modal. The filtered-team-tasks response
    // carries BOTH `text_content` (clean plaintext, no markdown) and `description`
    // (the same body with markdown markup). Prefer `text_content` — it's the
    // human-readable plaintext the UI wants — and fall back to `description` only
    // when text_content is absent. Always a string ('' when neither is present);
    // trailing whitespace trimmed. Never a secret.
    description: ((t.text_content || t.description || '')).replace(/\s+$/, ''),
    status: (t.status && t.status.status) || null,
    statusColor: (t.status && t.status.color) || null,
    statusType: (t.status && t.status.type) || null, // open | custom | done | closed
    // ClickUp priority: object { priority: 'urgent'|'high'|'normal'|'low', id }
    // or null when unset. We surface the human label + the numeric id (1=urgent
    // … 4=low in ClickUp's scheme) so the client can rank without re-deriving.
    priority: (t.priority && t.priority.priority) || null,
    priorityId: t.priority && t.priority.id != null ? Number(t.priority.id) : null,
    // due_date / start_date are epoch-MILLISECONDS strings or null.
    dueDate: t.due_date ? Number(t.due_date) : null,
    startDate: t.start_date ? Number(t.start_date) : null,
    url: t.url || null,
    // Grouping context — the BPM slot groups by list (with space as the header).
    list: t.list ? { id: t.list.id, name: t.list.name } : null,
    folder: t.folder && !t.folder.hidden ? { id: t.folder.id, name: t.folder.name } : null,
    space: t.space ? { id: t.space.id } : null,
    tags: Array.isArray(t.tags) ? t.tags.map((tag) => tag.name).filter(Boolean) : [],
  });

  // Per-client memo of the resolved assignee id, so deriving it from the token
  // (GET /user) costs at most one extra request per process, not per fetch.
  let assigneeIdMemo = null;

  return {
    /** Token fingerprint for safe logging. Never the full value. */
    tokenFingerprint() {
      return maskToken(token);
    },

    /** The workspace/team id in use (not a secret). */
    teamId() {
      return teamId;
    },

    /**
     * The user id to scope "assigned to me" by. Resolution order:
     *   1. an explicit CLICKUP_ASSIGNEE_ID env override (watch a different user), else
     *   2. the token owner's id, derived ONCE from GET /user (the correct, portable
     *      path — no hard-coded account id ever ships).
     * Memoized for the client's lifetime. The EXAMPLE_ placeholder is only a
     * last-resort diagnostic label and is never sent to the API.
     */
    async resolveAssigneeId() {
      if (assigneeIdMemo) return assigneeIdMemo;
      const override = resolveAssigneeOverride();
      if (override) { assigneeIdMemo = override; return assigneeIdMemo; }
      const data = await apiRequest(token, 'GET', '/user');
      const id = data && data.user && data.user.id != null ? String(data.user.id) : null;
      if (!id) throw new Error('ClickUp: could not derive user id from token (GET /user)');
      assigneeIdMemo = id;
      return assigneeIdMemo;
    },

    /** Connectivity probe: { ok, taskCount } — counts the connected user's open tasks. */
    async ping() {
      const tasks = await this.getOpenTasks();
      return { ok: true, taskCount: tasks.length };
    },

    /** All spaces in the workspace as [{ id, name }] — used to label task groups. */
    async getSpaces() {
      const data = await apiRequest(token, 'GET', `/team/${encodeURIComponent(teamId)}/space?archived=false`);
      const spaces = (data && data.spaces) || [];
      return spaces.map(normalizeSpace);
    },

    /**
     * Open (not-closed) tasks assigned to the connected user across the whole
     * workspace, with list/folder/space context attached per task. Read-only.
     *   @param {object}  [opts]
     *   @param {string}  [opts.assigneeId]  Explicit ClickUp user id. When omitted,
     *     resolved from the token (or the CLICKUP_ASSIGNEE_ID override).
     */
    async getOpenTasks({ assigneeId } = {}) {
      const who = assigneeId || await this.resolveAssigneeId();
      const params = new URLSearchParams({
        include_closed: 'false',
        subtasks: 'false',
        // order by due date so the most time-relevant work surfaces first; the
        // route re-sorts within groups anyway, this just biases the page walk.
        order_by: 'due_date',
      });
      // assignees[] must be repeated array syntax for ClickUp.
      params.append('assignees[]', who);
      const ep = `/team/${encodeURIComponent(teamId)}/task?${params.toString()}`;
      const tasks = await listAllTasks(token, ep);
      return tasks.map(normalizeTask);
    },

    // ========================================================================
    // VEX-GATED WRITE (layer B) — the connector's ONLY mutating method.
    // ========================================================================
    /**
     * completeTask(id) — close (complete) a ClickUp task by setting its status to
     * the task's list's done/closed-type status. Status transition ONLY; no other
     * field is touched.
     *
     * ClickUp has no single "close" endpoint like Todoist's /close. A task is
     * "completed" by moving it to a status of type 'done' (or 'closed'). The
     * available statuses are list-scoped, and their names are user-defined (e.g.
     * "Complete", "Done", "✅ Shipped"). So we:
     *   1. GET /task/{id} to read the task's list id + its current status,
     *   2. GET /list/{listId} to read that list's status set,
     *   3. pick the FIRST status whose `type` is 'done' (preferred) else 'closed',
     *   4. PUT /task/{id} { status: <that status's name> } to transition it.
     * (The ClickUp REST equivalent of the MCP clickup_update_task status write.)
     *
     * DORMANCY: this is never reached unless the route layer is armed by BOTH the
     * complete_on_source setting AND SOURCE_WRITE_ENABLED==='1'. See plannerRoutes.js.
     *
     * Idempotent in practice: if the task is already in a done/closed-type status,
     * resolves { ok:true, id, alreadyDone:true } without a write. A 404 (gone)
     * resolves { ok:false, id, alreadyGone:true } rather than throwing, so a re-run
     * is safe. Never returns or logs the token.
     */
    async completeTask(id) {
      if (!id) throw new Error('completeTask: id is required');
      let task;
      try {
        task = await apiRequest(token, 'GET', `/task/${encodeURIComponent(id)}`);
      } catch (err) {
        if (String(err.message).includes('HTTP 404')) {
          return { ok: false, id, alreadyGone: true };
        }
        throw err;
      }
      const listId = task && task.list && task.list.id;
      if (!listId) throw new Error('completeTask: could not resolve task list id');

      // Already in a done/closed-type status → no-op write.
      const curType = (task.status && task.status.type || '').toLowerCase();
      if (curType === 'done' || curType === 'closed') {
        return { ok: true, id, alreadyDone: true, status: task.status.status };
      }

      const list = await apiRequest(token, 'GET', `/list/${encodeURIComponent(listId)}`);
      const statuses = (list && list.statuses) || [];
      const done = statuses.find((s) => (s.type || '').toLowerCase() === 'done')
        || statuses.find((s) => (s.type || '').toLowerCase() === 'closed');
      if (!done) {
        throw new Error(`completeTask: list ${listId} has no done/closed status to transition to`);
      }
      // PUT /task/{id} with ONLY the status field — narrowest possible write.
      const updated = await apiRequest(token, 'PUT', `/task/${encodeURIComponent(id)}`, { status: done.status });
      return { ok: true, id, status: (updated && updated.status && updated.status.status) || done.status };
    },
  };
}

export default createClickUpClient;
