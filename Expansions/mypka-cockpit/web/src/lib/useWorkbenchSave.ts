// useWorkbenchSave.ts — debounced optimistic autosave + the save-status state
// machine (Vivi Spec 3) + conflict (412) / disabled (503) handling.
//
// Lifecycle (Spec 3 §3.1 happy path): idle → saving → saved → fading → idle.
// Branches that DO NOT auto-fade (they persist until resolved): conflict (412),
// disabled (503 read-only), error. The component renders these per spec.
//
// Save model (plan §5): full-document PUT, last-read mtime as baseMtime
// (optimistic concurrency). On 412 the file changed underneath → we surface a
// reload-or-overwrite prompt; overwrite = re-PUT with baseMtime omitted (force).
// On 503 the write path is dormant (Vex gate) → we flip to read-only with a notice.

import { useCallback, useEffect, useRef, useState } from 'react';
import { saveWorkbenchDoc, type WriteResult, type SaveDocResult } from './useCockpitWrite';

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' } //                              triggers the §3.2-C check pop, then fades
  | { kind: 'conflict'; serverMtime?: number } //     412 — persists, prompts reload/overwrite
  | { kind: 'disabled' } //                           503 — write path dormant; read-only
  | { kind: 'error'; message: string }; //            network/server — persists

const DEBOUNCE_MS = 600; // plan §4: ~600ms after last keystroke

export interface UseWorkbenchSave {
  status: SaveStatus;
  /** Call on every doc change with the current markdown; debounces internally. */
  onChange: (markdown: string) => void;
  /** Force-save now (e.g. on blur / route-away). Returns when settled. */
  flush: () => Promise<void>;
  /** Resolve a 412 conflict by overwriting (re-PUT without baseMtime). */
  overwrite: () => Promise<void>;
}

export function useWorkbenchSave(slug: string, initialMtime: number): UseWorkbenchSave {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const mtimeRef = useRef<number>(initialMtime);
  const pendingMarkdown = useRef<string | null>(null);
  // H3 — the last text we actually attempted to PUT. onChange/flush null out
  // pendingMarkdown after capture, so on a 412 conflict overwrite() would read
  // null and silently no-op (Tom's edit never forced). Retaining it here lets
  // overwrite() force the last-attempted body even after pending was cleared.
  const lastAttempted = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  // Keep mtime in sync if the loaded doc changes (route to a different slug).
  useEffect(() => {
    mtimeRef.current = initialMtime;
  }, [slug, initialMtime]);

  const applyResult = useCallback((res: WriteResult<SaveDocResult>) => {
    switch (res.kind) {
      case 'ok':
        mtimeRef.current = res.data.mtime;
        setStatus({ kind: 'saved' });
        break;
      case 'disabled':
        setStatus({ kind: 'disabled' });
        break;
      case 'stale':
        setStatus({ kind: 'conflict', serverMtime: res.serverMtime });
        break;
      case 'too-large':
        setStatus({ kind: 'error', message: 'This note is too large to save.' });
        break;
      case 'not-found':
        setStatus({ kind: 'error', message: 'This note no longer exists on disk.' });
        break;
      case 'auth':
        setStatus({ kind: 'error', message: 'Session expired — please sign in again.' });
        break;
      case 'error':
        setStatus({ kind: 'error', message: res.message });
        break;
      default:
        // 'conflict' (409) is not reachable on PUT (create-only status), but the
        // shared WriteResult union includes it; treat defensively as a save error.
        setStatus({ kind: 'error', message: 'Could not save the note.' });
    }
  }, []);

  const doSave = useCallback(
    async (markdown: string, force: boolean) => {
      if (inFlight.current) {
        // A save is already running; remember the latest text and let the running
        // save's tail re-fire (coalesces rapid edits into one trailing save).
        pendingMarkdown.current = markdown;
        return;
      }
      inFlight.current = true;
      lastAttempted.current = markdown;
      setStatus({ kind: 'saving' });
      const baseMtime = force ? undefined : mtimeRef.current;
      const res = await saveWorkbenchDoc(slug, markdown, baseMtime);
      inFlight.current = false;
      applyResult(res);
      // If edits arrived while saving, flush them now (only on success — a
      // conflict/disabled/error state should not be silently re-attempted).
      if (res.kind === 'ok' && pendingMarkdown.current !== null) {
        const next = pendingMarkdown.current;
        pendingMarkdown.current = null;
        void doSave(next, false);
      }
    },
    [slug, applyResult]
  );

  const onChange = useCallback(
    (markdown: string) => {
      pendingMarkdown.current = markdown;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const md = pendingMarkdown.current;
        pendingMarkdown.current = null;
        if (md !== null) void doSave(md, false);
      }, DEBOUNCE_MS);
    },
    [doSave]
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const md = pendingMarkdown.current;
    pendingMarkdown.current = null;
    if (md !== null) await doSave(md, false);
  }, [doSave]);

  const overwrite = useCallback(async () => {
    // Force-save the latest known text, ignoring the precondition (plan §4).
    // Fall back to lastAttempted so a 412 conflict (where pendingMarkdown was
    // already nulled out at capture) still forces Tom's edit (H3).
    const md = pendingMarkdown.current ?? lastAttempted.current;
    if (md !== null) await doSave(md, true);
  }, [doSave]);

  // Tear down the timer on unmount so a pending save can't fire post-route-away
  // (the component flushes explicitly before navigating).
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { status, onChange, flush, overwrite };
}
