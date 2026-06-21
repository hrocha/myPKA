// ContextPanel.tsx — the wikilink context panel, extracted verbatim from
// WorkbenchDocView so the whiteboard (BoardView) can dock the SAME surface.
//
// Docked <aside> right of the host column (the host's CSS owns positioning —
// cockpit.css makes it a sticky column beside the editor / an overlay sheet
// under 900px; board.css re-anchors it inside the canvas). Fetches the target
// through the same collision-aware /api/cockpit/resolve/:slug the universal
// viewer uses and renders the body via WikiMarkdown with its link clicks
// REROUTED to onHop — so Tom can hop link-to-link without ever leaving the
// surface he is working on. Esc (while focus is inside the panel) closes it;
// the host keeps its own focus/caret untouched because opening never steals
// focus. Maximize2 leaves for the note's canonical route: a fleeting note's
// fullscreen surface is the Workbench editor (#/notes/<slug>), everything
// else the read-only universal viewer (#/resolve/<slug>).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Maximize2, X } from 'lucide-react';
import { useFetch } from '../../lib/useCockpit';
import { navigate } from '../../lib/router';
import type { ResolveResponse } from '../../lib/cockpitTypes';
import { WikiMarkdown } from '../WikiMarkdown';

export function WikilinkContextPanel({
  slug,
  onHop,
  onClose,
}: {
  slug: string;
  onHop: (slug: string) => void;
  onClose: () => void;
}) {
  const { data, loading, error } = useFetch<ResolveResponse>(
    `/api/cockpit/resolve/${encodeURIComponent(slug)}`
  );

  // Scroll the panel body back to the top on every hop.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [slug]);

  const note = data?.found ? data.note : undefined;

  // DATA-CONTRACT §12 — slug → resolved title for in-body wikilinks (show the
  // target's title, not the raw slug). Built from the note's server-resolved
  // outbound links. Hooks run unconditionally above the conditional render.
  const titleBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of note?.outbound ?? []) {
      if (o.slug && o.title) m.set(o.slug, o.title);
    }
    return m;
  }, [note]);
  const resolveTitle = useCallback(
    (s: string): string | null => titleBySlug.get(s) ?? null,
    [titleBySlug],
  );

  return (
    <aside
      className="wb-context-panel animate-fade-rise"
      aria-label={`Linked note preview: ${note?.title ?? slug}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="wb-context-head">
        {note ? (
          <span className="note-type-pill">{note.typeLabel}</span>
        ) : (
          <span className="wb-context-slug font-mono">{slug}</span>
        )}
        <div className="wb-context-actions">
          <button
            type="button"
            className="wb-context-btn"
            aria-label="Open note full screen"
            title="Open full screen"
            onClick={() => {
              // A fleeting note's canonical fullscreen surface is the Workbench
              // editor, not the read-only universal viewer.
              if (note?.type === 'fleeting') navigate({ name: 'notes-doc', slug: note.slug });
              else navigate({ name: 'resolve', slug });
            }}
          >
            <Maximize2 size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="wb-context-btn"
            aria-label="Close note preview"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div ref={bodyRef} className="wb-context-body">
        {loading && (
          <div aria-busy="true">
            <div className="skeleton-line w-half" />
            <div className="skeleton-block" />
          </div>
        )}
        {!loading && error && (
          <p role="alert" className="view-error">Could not load the note: {error}</p>
        )}
        {!loading && !error && !note && (
          <p className="note-empty">
            No note named <span className="font-mono">{slug}</span> yet.
          </p>
        )}
        {!loading && !error && note && (
          <>
            <h2 className="wb-context-title">{note.title}</h2>
            {note.body.trim() ? (
              <WikiMarkdown body={note.body} onWikilinkClick={onHop} resolveTitle={resolveTitle} />
            ) : (
              <p className="note-empty">This entry has no body text.</p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
