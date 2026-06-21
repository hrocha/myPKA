// useCockpitWrite.ts — the WRITE-capable counterpart to the read-only useFetch.
//
// The cockpit's first-ever write surface to real PKM markdown (plan §5; the
// Workbench create/save routes). Unlike useFetch this is NOT a subscribing hook
// — writes are imperative, fired from an event (button click, autosave debounce),
// so it exposes a plain async function that callers await.
//
// Header contract (verified against server/server.js localWriteGuard, line 157):
//   - `X-Cockpit: 1`  — the CSRF belt; a cross-site fetch can't set a custom
//     header without a CORS preflight the server never grants. Missing it → 403.
//   - `credentials: 'same-origin'` — carries the session cookie requireSession needs.
// (Felix journal 2026-06-02: the guard checks X-Cockpit, NOT X-Cockpit-Write — a
// mismatch returns 403, which would read as "saving silently fails".)
//
// The write path ships DORMANT behind WORKBENCH_WRITE_ENABLED (default OFF, Vex
// gate). While dormant the server returns 503 {ok:false, reason:'disabled'}; this
// helper surfaces that as a typed result so the UI can degrade to read-only with a
// calm "saving is disabled" notice rather than throwing.

// A discriminated result so callers branch exhaustively on status without parsing
// HTTP codes at every call site. `data` is the parsed JSON for the happy path;
// `body` is the parsed error JSON (it carries `slug` on 409, `mtime` on 412).
export type WriteResult<T> =
  | { kind: 'ok'; status: number; data: T }
  | { kind: 'disabled' } //                              503 — Vex gate not cleared
  | { kind: 'conflict'; existingSlug?: string } //       409 — slug collision (POST)
  | { kind: 'stale'; serverMtime?: number } //           412 — file changed underneath (PUT)
  | { kind: 'not-found' } //                             404
  | { kind: 'too-large' } //                             413 — over the 200 KB cap
  | { kind: 'auth' } //                                  401 — session gone
  | { kind: 'error'; status: number; message: string }; // anything else

interface ErrorBody {
  ok?: boolean;
  reason?: string;
  error?: string;
  message?: string;
  slug?: string;
  mtime?: number;
}

async function parseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function cockpitWrite<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<WriteResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit': '1', // the localWriteGuard CSRF belt — exact header name
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { kind: 'error', status: 0, message: (err as Error).message || 'network error' };
  }

  const parsed = (await parseBody(res)) as ErrorBody | T | null;
  const errBody = (parsed ?? {}) as ErrorBody;

  if (res.ok) return { kind: 'ok', status: res.status, data: parsed as T };

  switch (res.status) {
    case 503:
      return { kind: 'disabled' };
    case 409:
      return { kind: 'conflict', existingSlug: errBody.slug };
    case 412:
      return { kind: 'stale', serverMtime: errBody.mtime };
    case 404:
      return { kind: 'not-found' };
    case 413:
      return { kind: 'too-large' };
    case 401:
      return { kind: 'auth' };
    default:
      return {
        kind: 'error',
        status: res.status,
        message: errBody.error || errBody.message || `Server responded ${res.status}`,
      };
  }
}

// POST /api/cockpit/notes { title, markdown? } -> 201 { ok, slug, title, mtime }
export interface CreateDocResult {
  ok: true;
  slug: string;
  title: string;
  mtime: number;
}
export function createWorkbenchDoc(
  title: string,
  markdown?: string
): Promise<WriteResult<CreateDocResult>> {
  const payload: { title: string; markdown?: string } = { title };
  if (markdown !== undefined) payload.markdown = markdown;
  return cockpitWrite<CreateDocResult>('/api/cockpit/notes', 'POST', payload);
}

// PUT /api/cockpit/notes/:slug { markdown, baseMtime? } -> 200 { ok, slug, mtime }
export interface SaveDocResult {
  ok: true;
  slug: string;
  mtime: number;
}
export function saveWorkbenchDoc(
  slug: string,
  markdown: string,
  baseMtime?: number | null
): Promise<WriteResult<SaveDocResult>> {
  // baseMtime omitted entirely = force overwrite (the 412 "overwrite" resolution,
  // plan §4). When present it's the optimistic-concurrency precondition.
  const payload: { markdown: string; baseMtime?: number | null } = { markdown };
  if (baseMtime !== undefined) payload.baseMtime = baseMtime;
  return cockpitWrite<SaveDocResult>(
    `/api/cockpit/notes/${encodeURIComponent(slug)}`,
    'PUT',
    payload
  );
}
