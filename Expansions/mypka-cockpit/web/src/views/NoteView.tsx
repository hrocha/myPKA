// NoteView.tsx — the universal note viewer (Phase 1 foundation).
//
// Renders ANY resolved note: markdown body with clickable [[wikilinks]], a
// frontmatter/metadata panel, and a backlinks panel ("what links here").
// Every wikilink inside the body is itself navigable -> graph browsing. This is
// what makes "Planned -> ENT appointment" finally openable into real context.
//
// Two entry shapes share this view:
//   #/resolve/:slug      -> /api/cockpit/resolve/:slug  (collision-aware, "auch:")
//   #/note/:type/:slug   -> /api/cockpit/note/:type/:slug (type already known)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Link2, CornerUpLeft, Info, Calendar, FileText, Maximize2, FileQuestion } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { fileRouteSrc, hrefFor, navigate, type Route } from '../lib/router';
import type { ResolveResponse, CockpitNote, Backlink, OutboundLink, NotePreview } from '../lib/cockpitTypes';
import { WikiMarkdown } from '../components/WikiMarkdown';
import { ImageLightbox } from '../components/ImageLightbox';
import { MoodChip, EnergyChip } from '../components/JournalChips';
import { MiniGraph } from '../components/graph/MiniGraph';
import { DiscussButton } from '../components/DiscussButton';

export function NoteView({ route }: { route: Extract<Route, { name: 'resolve' | 'note' }> }) {
  const url =
    route.name === 'resolve'
      ? `/api/cockpit/resolve/${encodeURIComponent(route.slug)}`
      : `/api/cockpit/note/${encodeURIComponent(route.type)}/${encodeURIComponent(route.slug)}`;
  const { data, loading, error } = useFetch<ResolveResponse>(url);
  const topRef = useRef<HTMLDivElement | null>(null);
  // Lightbox-lite for the media strip — the same shared ImageLightbox the
  // journal timeline uses (portalled to document.body, which keeps it outside
  // this article's animate-fade-rise containing block).
  const [lightbox, setLightbox] = useState<{ path: string; alt: string } | null>(null);

  // Scroll the note to the top whenever we navigate to a new one.
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [url]);

  // DATA-CONTRACT §12 — slug → resolved title map for in-body [[wikilinks]].
  // The server already resolved each outbound link's target title (cockpit.js
  // shapeOutbound); we index it by slug so WikiMarkdown can show "Weekly Review"
  // in place of the raw slug. Hooks run unconditionally (above the early
  // returns); a missing note yields an empty map and the renderer falls back to
  // the slug, exactly as before.
  const titleBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of data?.note?.outbound ?? []) {
      if (o.slug && o.title) m.set(o.slug, o.title);
    }
    return m;
  }, [data]);
  const resolveTitle = useCallback(
    (slug: string): string | null => titleBySlug.get(slug) ?? null,
    [titleBySlug],
  );

  if (loading) return <ViewSkeleton />;
  if (error) return <ViewError message={error} />;
  if (!data || !data.found || !data.note) return <NotFound slug={route.slug} />;

  const note = data.note;
  const secondary = data.secondary ?? [];

  return (
    <article ref={topRef} className="note-view animate-fade-rise">
      <button type="button" className="back-button" onClick={() => window.history.back()}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
      </button>

      <header className="note-header">
        <div className="note-header-row">
          <span className="note-type-pill">{note.typeLabel}</span>
          {/* filePath is repo-relative (mypka.db file_path) — exactly what the
              discuss endpoint validates against the repo jail. */}
          {note.filePath && <DiscussButton file={note.filePath} subject={note.title} />}
        </div>
        <h1 className="note-title">{note.title}</h1>
        {note.journal && <JournalHeaderMeta note={note} />}
        {secondary.length > 0 && (
          <p className="note-also">
            also:{' '}
            {secondary.map((s, i) => (
              <span key={`${s.type}-${s.slug}`}>
                {i > 0 && ', '}
                <button
                  type="button"
                  className="wikilink"
                  onClick={() => navigate({ name: 'note', type: s.type, slug: s.slug })}
                >
                  {s.label}
                </button>
              </span>
            ))}
          </p>
        )}
      </header>

      <div className="note-grid">
        <div className="note-body-col">
          {note.preview && <DocumentPreview preview={note.preview} title={note.title} />}
          {note.media && note.media.images.length > 0 && (
            <div className="note-media-strip">
              {note.media.images.map((img, i) => (
                <ImageThumb
                  key={i}
                  path={img.path}
                  caption={img.caption}
                  onOpen={(path, alt) => setLightbox({ path, alt })}
                />
              ))}
            </div>
          )}
          {note.body.trim() ? (
            <WikiMarkdown body={note.body} resolveTitle={resolveTitle} />
          ) : (
            <p className="note-empty">This entry has no body text.</p>
          )}
          {note.media && note.media.audioCount > 0 && (
            <p className="note-audio-note">
              {note.media.audioCount} audio recording{note.media.audioCount > 1 ? 's' : ''} linked (not played).
            </p>
          )}
          {/* Mini-graph — Tom's call (option B): full-content-width, in the MAIN
              reading column directly below the rendered note body (the body's
              "Related" tail). NOT in the right rail. The rail's "What links here" /
              "Links to" cards stay untouched as the non-visual text fallback (§8.9).
              Lazy-loaded so React Flow + d3-force stay out of the critical bundle. */}
          <MiniGraph focusType={note.type} slug={note.slug} />
        </div>

        <aside className="note-side">
          <MetadataPanel metadata={note.metadata} filePath={note.filePath} />
          <BacklinksPanel backlinks={note.backlinks} />
          <OutboundPanel outbound={note.outbound} />
        </aside>
      </div>

      {lightbox && (
        <ImageLightbox path={lightbox.path} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </article>
  );
}

// v3 #4 — in-app document preview. The actual file (PDF/image/txt) is served from
// disk through the guarded /api/cockpit/file route and embedded inline. PDFs use a
// native <iframe> (no renderer dependency); images use <img>. Non-previewable types
// (docx/xlsx/external links) show a calm "not previewable" note with the path — we
// never force a download or show a broken embed.
function DocumentPreview({ preview, title }: { preview: NotePreview; title: string }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/cockpit/file?path=${encodeURIComponent(preview.path)}`;
  const fileName = preview.path.split('/').pop() || preview.path;

  if (!preview.previewable || failed) {
    return (
      <section className="doc-preview doc-preview-unavailable">
        <div className="doc-preview-head">
          <FileQuestion size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>Document</span>
        </div>
        <p className="doc-preview-note">
          {preview.kind === 'external'
            ? 'External file — no inline preview.'
            : failed
              ? 'File not found on disk.'
              : `No inline preview for ${preview.ext ? `.${preview.ext}` : 'this file type'}.`}
        </p>
        <p className="doc-preview-path font-mono">{preview.path}</p>
      </section>
    );
  }

  return (
    <section className="doc-preview">
      <div className="doc-preview-head">
        <FileText size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="doc-preview-name">{fileName}</span>
        {/* Routed "Large" — same in-app reading page (#/file/<src>) the tree
            previews and DocumentsView use, instead of the raw URL in a new tab. */}
        <a
          href={hrefFor({ name: 'file', src: fileRouteSrc('file', preview.path) })}
          className="doc-preview-open"
          title="Open the large reading page"
        >
          <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" /> Large
        </a>
      </div>
      {preview.kind === 'image' ? (
        <img
          className="doc-preview-image"
          src={src}
          alt={title}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        // PDF + txt: native iframe, zero renderer dependency.
        <iframe
          className="doc-preview-frame"
          src={src}
          title={`Preview: ${title}`}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </section>
  );
}

function JournalHeaderMeta({ note }: { note: CockpitNote }) {
  const j = note.journal!;
  return (
    <div className="note-journal-meta">
      {j.entryDate && (
        <span className="meta-pair">
          <Calendar size={13} strokeWidth={1.5} aria-hidden="true" />
          {formatDate(j.entryDate)}
        </span>
      )}
      {j.mood && <MoodChip mood={j.mood} />}
      {j.energy && <EnergyChip energy={j.energy} />}
      {j.category && <span className="meta-cat">{j.category}</span>}
    </div>
  );
}

function ImageThumb({
  path,
  caption,
  onOpen,
}: {
  path: string;
  caption: string | null;
  onOpen: (path: string, alt: string) => void;
}) {
  // Lazy thumbnail via the read-only media route. A real <button> wraps the
  // image (cursor: zoom-in, Enter/Space for free) and opens the shared
  // lightbox. Degrades silently when the bytes are missing on disk — the
  // mirror knows the path; the file may not be there. No broken-image icon.
  const [failed, setFailed] = useState(false);
  const name = path.split('/').pop() ?? path;
  if (failed) return null;
  return (
    <div className="media-thumb">
      <button
        type="button"
        className="media-thumb-btn"
        onClick={() => onOpen(path, caption || name)}
        aria-label={`View image ${caption || name}`}
      >
        <img
          src={`/api/cockpit/media?path=${encodeURIComponent(path)}`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </button>
      {caption && <span className="media-thumb-cap">{caption}</span>}
    </div>
  );
}

function MetadataPanel({ metadata, filePath }: { metadata: Record<string, unknown>; filePath: string | null }) {
  const entries = Object.entries(metadata).filter(([k]) => k !== 'body' && k !== 'content');
  return (
    <section className="side-panel">
      <h2 className="side-panel-title"><Info size={15} strokeWidth={1.5} aria-hidden="true" /> Metadata</h2>
      {entries.length === 0 ? (
        <p className="side-empty">No frontmatter fields.</p>
      ) : (
        <dl className="meta-list">
          {entries.map(([k, v]) => (
            <div key={k} className="meta-row">
              <dt>{k}</dt>
              <dd>{renderValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {filePath && <p className="side-filepath font-mono">{filePath}</p>}
    </section>
  );
}

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function BacklinksPanel({ backlinks }: { backlinks: Backlink[] }) {
  return (
    <section className="side-panel">
      <h2 className="side-panel-title"><CornerUpLeft size={15} strokeWidth={1.5} aria-hidden="true" /> What links here</h2>
      {backlinks.length === 0 ? (
        <p className="side-empty">No backlinks yet.</p>
      ) : (
        <ul className="backlink-list">
          {backlinks.map((b) => (
            <li key={`${b.sourceType}/${b.slug}`}>
              {b.clickable ? (
                <button type="button" className="backlink" onClick={() => navigate({ name: 'note', type: b.sourceType, slug: b.slug })}>
                  <span className="backlink-label">{b.label}</span>
                  <span className="backlink-title">{b.title}</span>
                </button>
              ) : (
                <span className="backlink is-plain" title="Source is not a navigable entry">
                  <span className="backlink-label">{b.label}</span>
                  <span className="backlink-title">{b.title}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OutboundPanel({ outbound }: { outbound: OutboundLink[] }) {
  if (outbound.length === 0) return null;
  // Plain (non-clickable) links are shown muted, never as broken links.
  return (
    <section className="side-panel">
      <h2 className="side-panel-title"><Link2 size={15} strokeWidth={1.5} aria-hidden="true" /> Links to</h2>
      <ul className="outbound-list">
        {outbound.map((o, i) => (
          <li key={`${o.raw}-${i}`}>
            {o.clickable && o.slug ? (
              <button type="button" className="wikilink" onClick={() => navigate({ name: 'note', type: String(o.targetType), slug: o.slug! })}>
                {o.raw}
              </button>
            ) : (
              <span className="outbound-plain" title="Target is not (yet) a navigable entry">{o.raw}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}

function ViewSkeleton() {
  return (
    <div className="note-view" aria-busy="true">
      <div className="skeleton-line w-half" />
      <div className="skeleton-block" />
      <div className="skeleton-block" />
    </div>
  );
}

function ViewError({ message }: { message: string }) {
  return <div role="alert" className="view-error">Could not load the entry: {message}</div>;
}

function NotFound({ slug }: { slug: string }) {
  return (
    <div className="note-view">
      <button type="button" className="back-button" onClick={() => window.history.back()}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
      </button>
      <p className="note-empty">
        No entry found for <span className="font-mono">{slug}</span>. This link points to something that does not (yet) exist as a note.
      </p>
    </div>
  );
}
