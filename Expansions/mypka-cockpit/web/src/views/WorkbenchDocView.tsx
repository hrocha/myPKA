// WorkbenchDocView.tsx — open + EDIT one Workbench doc (P3+, the outliner).
//
// Replaces the P1 read-only react-markdown render with the constrained nested
// outliner (OutlinerEditor). Loads markdown via the read-only useFetch, hands it
// to the editor, and drives the debounced optimistic autosave (useWorkbenchSave)
// + the save-status indicator (SaveStatus, Vivi Spec 3).
//
// Graceful degradation when the write path is dormant (503, WORKBENCH_WRITE_ENABLED
// off — the Vex gate): the FIRST save attempt returns 503; useWorkbenchSave flips
// status to 'disabled'; we set the editor read-only and show the calm notice. We
// do NOT pre-flight a probe — the first edit naturally surfaces the state, and an
// unedited doc stays fully editable-looking until Tom actually changes something
// (no nagging banner on a doc he's only reading).
//
// Data: GET /api/cockpit/notes/:slug -> { slug, title, markdown, mtime }
// (Mack's contract, plan §5). mtime (epoch-ms) is the baseMtime for optimistic
// concurrency on PUT.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { navigate, type Route } from '../lib/router';
import { WikilinkContextPanel } from '../components/workbench/ContextPanel';
import { OutlinerEditor } from '../components/workbench/OutlinerEditor';
import { SaveStatus } from '../components/workbench/SaveStatus';
import { useWorkbenchSave } from '../lib/useWorkbenchSave';
import { DiscussButton } from '../components/DiscussButton';

interface WorkbenchDocResponse {
  slug: string;
  title: string;
  markdown: string;
  mtime: number;
}

export function WorkbenchDocView({ route }: { route: Extract<Route, { name: 'notes-doc' }> }) {
  const { data, loading, error } = useFetch<WorkbenchDocResponse>(
    `/api/cockpit/notes/${encodeURIComponent(route.slug)}`
  );
  const topRef = useRef<HTMLElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, [route.slug]);

  // The loading / error states have no editor mounted yet, so a plain back link
  // is correct here. The live editor view builds its OWN flush-before-navigate
  // back button (see WorkbenchDocEditor) so an in-flight debounced edit is never
  // dropped when Tom clicks "Workbench" within the autosave debounce window.
  const back = (
    <button type="button" className="back-button" onClick={() => navigate({ name: 'notes' })}>
      <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Fleeting Notes
    </button>
  );

  if (loading) {
    return (
      <article className="note-view" aria-busy="true">
        {back}
        <div className="skeleton-line w-half" />
        <div className="skeleton-block" />
      </article>
    );
  }
  if (error) {
    return (
      <article className="note-view">
        {back}
        <div role="alert" className="view-error">Could not load the note: {error}</div>
      </article>
    );
  }
  if (!data) return null;

  return <WorkbenchDocEditor key={data.slug} doc={data} topRef={topRef} />;
}

// Inner component so the save hook keys cleanly off the loaded doc (mounted only
// once data is present; remounted via `key` when the slug changes).
function WorkbenchDocEditor({
  doc,
  topRef,
}: {
  doc: WorkbenchDocResponse;
  topRef: React.Ref<HTMLElement>;
}) {
  const { status, onChange, overwrite, flush } = useWorkbenchSave(doc.slug, doc.mtime);

  // The editor is read-only once we learn the write path is dormant (503) or a
  // hard error makes further edits pointless. A 412 conflict keeps it editable
  // (Tom can re-edit then overwrite).
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  useEffect(() => {
    if (status.kind === 'disabled') setForcedReadOnly(true);
  }, [status.kind]);

  // Flush any debounced-but-unsent edit on unmount. Without this, leaving the doc
  // within the ~600ms autosave window drops the last keystrokes — the hook's
  // unmount cleanup only CANCELS the pending timer, it does not fire the save.
  // `flush` is stable (useCallback) so this binds the latest pending text.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => { void flushRef.current(); }, []);

  // Back button that flushes first, then navigates — so clicking "Workbench"
  // mid-debounce persists the last edit instead of silently losing it.
  const goBack = useCallback(async () => {
    await flush();
    navigate({ name: 'notes' });
  }, [flush]);

  const back = (
    <button type="button" className="back-button" onClick={() => void goBack()}>
      <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Fleeting Notes
    </button>
  );

  const handleReload = useCallback(() => {
    // Reload the doc fresh from disk by re-navigating to the same slug (forces a
    // re-fetch + editor remount via the `key` upstream). We deliberately do NOT
    // flush here — reload's intent is to DISCARD local edits for the disk copy.
    navigate({ name: 'notes-doc', slug: doc.slug });
  }, [doc.slug]);

  // Context side panel: clicking a rendered [[wikilink]] in the editor previews
  // the target note beside the text (Obsidian-style). Link clicks INSIDE the
  // panel hop the preview to the next note; Esc / X closes; Maximize2 leaves the
  // editor for the note's canonical route via #/resolve/<slug>.
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  const handleWikilinkClick = useCallback((slug: string) => setPreviewSlug(slug), []);
  const closePreview = useCallback(() => setPreviewSlug(null), []);

  return (
    <div className="wb-doc-layout">
      <article ref={topRef} className="note-view animate-fade-rise">
        <div className="workbench-doc-toolbar">
          {back}
          <div className="workbench-doc-tools">
            {/* Fleeting docs live at PKM/Fleeting Notes/<slug>.md (workbench.js jail) —
                repo-relative, matching the discuss endpoint's containment check. */}
            <DiscussButton file={`PKM/Fleeting Notes/${doc.slug}.md`} subject={doc.title} />
            <SaveStatus status={status} onReload={handleReload} onOverwrite={overwrite} />
          </div>
        </div>
        <header className="note-header">
        </header>
        <OutlinerEditor
          slug={doc.slug}
          initialMarkdown={doc.markdown ?? ''}
          editable={!forcedReadOnly}
          onChange={onChange}
          onWikilinkClick={handleWikilinkClick}
        />
      </article>
      {previewSlug !== null && (
        <WikilinkContextPanel slug={previewSlug} onHop={handleWikilinkClick} onClose={closePreview} />
      )}
    </div>
  );
}

// The wikilink context panel itself moved to components/workbench/ContextPanel
// (shared with the whiteboard's Cmd/Ctrl+click note preview — BoardView).
