// FileView.tsx — the routed "Large" reading page for a raw file.
//
// Replaces the old FileFullscreenOverlay: instead of a fullscreen portal this
// renders IN the routed content column, exactly like opening a journal entry —
// normal cockpit chrome, sidebar visible, browser back works, deep-linkable.
//
// Route: #/file/<encodeURIComponent(src)> -> { name: 'file'; src }.
// The src codec (plain path -> /api/cockpit/file, 'inbox:' prefix ->
// /api/cockpit/inbox-file) lives in lib/router.ts — see "File-route src
// encoding" there. md/txt are fetched as text and rendered through the
// sanitized WikiMarkdown (.note-prose) in a centered reading column; pdf /
// images embed full-width below the header on the same jailed URL. A small
// "Raw" link keeps the native-URL escape hatch. A missing file gets a calm
// not-found state, never a broken embed.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { parseFileSrc, type Route } from '../lib/router';
import { WikiMarkdown } from '../components/WikiMarkdown';
import { DiscussButton } from '../components/DiscussButton';
import { fileIconFor, previewKindFor } from '../components/FolderTree';
import '../components/foldertree.css';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Map a file-route src/path to the REPO-relative path the discuss endpoint
// expects. The /api/cockpit/file jail convention: 'inbox:' paths ("Team Inbox/…"),
// Deliverables/ paths, and Team Knowledge/ paths are already repo-relative;
// everything else is PKM/-relative (see server.js "Three jails with DIFFERENT base
// conventions").
function repoRelativeFor(src: string, path: string): string {
  if (src.startsWith('inbox:')) return path;
  const norm = path.replace(/\\/g, '/');
  if (norm === 'Deliverables' || norm.startsWith('Deliverables/')) return path;
  if (norm === 'Team Knowledge' || norm.startsWith('Team Knowledge/')) return path;
  return `PKM/${path}`;
}

export function FileView({ route }: { route: Extract<Route, { name: 'file' }> }) {
  const { path, fileUrl } = parseFileSrc(route.src);
  const name = path.split('/').pop() || path;
  const ext = extOf(name);
  const kind = previewKindFor(name);
  const FileIcon = fileIconFor(name);
  const topRef = useRef<HTMLElement | null>(null);

  // md/txt: fetched as text. A 404 flips the calm not-found state below.
  const [text, setText] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [embedFailed, setEmbedFailed] = useState(false);

  useEffect(() => {
    setText(null);
    setNotFound(false);
    setTextError(null);
    setEmbedFailed(false);
    if (kind !== 'text') return;
    let alive = true;
    fetch(fileUrl, { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 404) {
          if (alive) setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`Server responded ${r.status}`);
        return r.text();
      })
      .then((body) => { if (alive && body !== null) setText(body); })
      .catch((err: unknown) => { if (alive) setTextError((err as Error).message); });
    return () => { alive = false; };
  }, [fileUrl, kind]);

  // Scroll to the top whenever we navigate to a new file.
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [route.src]);

  const missing = notFound || embedFailed;

  return (
    <article ref={topRef} className="note-view file-view animate-fade-rise">
      <button type="button" className="back-button" onClick={() => window.history.back()}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
      </button>

      <header className="file-view-head">
        <span className="file-view-glyph" aria-hidden="true">
          <FileIcon size={18} strokeWidth={1.5} />
        </span>
        <h1 className="file-view-title">{name}</h1>
        {!missing && kind !== 'none' && (
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="file-view-raw"
            title="Open the raw file in a new tab"
          >
            Raw
          </a>
        )}
        {!missing && <DiscussButton file={repoRelativeFor(route.src, path)} subject={name} />}
      </header>
      <p className="file-view-path">{path}</p>

      {missing && (
        <div className="file-view-reading">
          <p className="note-empty">
            This file could not be found. It may have been moved, renamed, or
            removed since this link was made.
          </p>
        </div>
      )}

      {!missing && kind === 'text' && textError && (
        <div className="file-view-reading">
          <p role="alert" className="ft-preview-note">Could not load the file: {textError}</p>
        </div>
      )}
      {!missing && kind === 'text' && text === null && !textError && (
        <div className="file-view-reading" aria-busy="true">
          <div className="skeleton-block" />
        </div>
      )}
      {!missing && kind === 'text' && text !== null && (
        <div className="file-view-reading">
          {ext === 'md'
            ? <WikiMarkdown body={text} />
            : <pre className="ft-preview-plain">{text}</pre>}
        </div>
      )}

      {!missing && kind === 'image' && (
        <img
          className="file-view-image"
          src={fileUrl}
          alt={name}
          decoding="async"
          onError={() => setEmbedFailed(true)}
        />
      )}
      {!missing && kind === 'pdf' && (
        <iframe
          className="file-view-frame"
          src={fileUrl}
          title={`File: ${name}`}
          onError={() => setEmbedFailed(true)}
        />
      )}

      {!missing && kind === 'none' && (
        <div className="file-view-reading">
          <p className="ft-preview-note">
            No inline view for {ext ? `.${ext}` : 'this file type'}.
          </p>
          <p className="ft-preview-path">{path}</p>
        </div>
      )}
    </article>
  );
}
