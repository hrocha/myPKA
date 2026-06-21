// DocumentsView.tsx — the Documents PDF page.
//
// Search field on top (debounced; empty query -> the full list), a card grid
// of document notes (PDF glyph, title, doc_type chip, key metadata rows,
// connected-note chips), and an inline preview panel that renders the attached
// PDF through the guarded /api/cockpit/file route (PKM-relative path, served
// read-only with an inert CSP). Documents without a file get a calm
// "no file attached" note instead.
//
// SEARCH HONESTY: the search endpoint is TEXT search (SQL LIKE over the note's
// title / doc_type / body / frontmatter). It does not look inside the PDF
// bytes and is not semantic — the server says so via `mode: 'text'` and this
// view labels it. A future semantic mode slots into the same response shape.
import { useEffect, useMemo, useState } from 'react';
import { FileText, Link2, Maximize2, Search, X } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { fileRouteSrc, navigate } from '../lib/router';
import { PageHeader } from '../components/PageHeader';
import './documents.css';

// ---- API shapes (server: server/documentsApi.js) ---------------------------
export interface DocConnection {
  slug: string;
  type: string | null; // entity table when resolvable, else null
  title: string;
  direction: 'outbound' | 'backlink';
  clickable: boolean;
}

export interface DocumentRow {
  id: number;
  slug: string;
  title: string;
  doc_type: string | null;
  metadata: Record<string, unknown>;
  pdfPath: string | null; // PKM-relative; serve via /api/cockpit/file?path=
  date: string | null; // ISO YYYY-MM-DD when frontmatter carries one
  filePath: string | null;
  connections: DocConnection[];
}

export interface DocumentsResponse {
  items: DocumentRow[];
  total: number;
  mode?: 'text';
  q?: string;
}

export function fileUrlFor(pdfPath: string): string {
  return `/api/cockpit/file?path=${encodeURIComponent(pdfPath)}`;
}

// Frontmatter keys never shown as "key metadata" rows (already rendered
// elsewhere on the card, or file plumbing).
const HIDDEN_META_KEYS = new Set([
  'title', 'doc_type', 'tags', 'aliases',
  'digital_location', 'file', 'source_file', 'attachment', 'scan',
]);

function keyMetadataRows(metadata: Record<string, unknown>, max = 4): [string, string][] {
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (HIDDEN_META_KEYS.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = String(value).trim();
    if (!text) continue;
    rows.push([key.replace(/_/g, ' '), text]);
    if (rows.length >= max) break;
  }
  return rows;
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function DocumentsView() {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 250);
  const searching = debounced.length > 0;

  const url = searching
    ? `/api/cockpit/documents/search?q=${encodeURIComponent(debounced)}`
    : '/api/cockpit/documents';
  const { data, loading, error } = useFetch<DocumentsResponse>(url);

  // Preview panel: track the selected doc by slug so a re-fetch (new search)
  // keeps or calmly drops the selection.
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  const previewDoc = useMemo(
    () => data?.items.find((d) => d.slug === previewSlug && d.pdfPath) ?? null,
    [data, previewSlug],
  );

  // Escape closes the preview panel. (The "maximize" affordance navigates to
  // the routed #/file/<src> reading page — views/FileView.tsx — so there is no
  // overlay state to coordinate with here anymore.)
  useEffect(() => {
    if (!previewDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewSlug(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewDoc]);

  const items = data?.items ?? [];

  return (
    <section className="documents animate-fade-rise">
      <PageHeader
        title="Documents"
        icon={FileText}
        subtitle={
          data
            ? `${data.total} ${data.total === 1 ? 'document' : 'documents'}${
                searching ? ` matching “${debounced}”` : ''
              }`
            : undefined
        }
      />

      <div className="doc-search">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" className="doc-search-glyph" />
        <input
          type="search"
          className="doc-search-input"
          placeholder="Search documents…"
          aria-label="Search documents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="doc-search-clear"
            onClick={() => setQuery('')}
            aria-label="Clear search"
          >
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>

      {searching && data?.mode === 'text' && (
        <p className="doc-search-mode" role="note">
          Text match over each note's title, type, body and metadata — this does
          not read inside the PDF files and is not semantic search.
        </p>
      )}

      {loading && (
        <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>
      )}
      {error && <p role="alert" className="view-error">Could not load documents: {error}</p>}

      {!loading && !error && (
        <div className={`docs-layout ${previewDoc ? 'docs-layout--split' : ''}`}>
          <div className="doc-grid" role="list">
            {items.length === 0 ? (
              <p className="doc-empty">
                {searching ? 'No documents match.' : 'No documents in the mirror yet.'}
              </p>
            ) : (
              items.map((doc) => (
                <DocumentCard
                  key={doc.slug}
                  doc={doc}
                  previewOpen={previewDoc?.slug === doc.slug}
                  onPreview={() => setPreviewSlug(doc.slug === previewSlug ? null : doc.slug)}
                />
              ))
            )}
          </div>

          {previewDoc && previewDoc.pdfPath && (
            <aside className="doc-preview" aria-label={`Preview of ${previewDoc.title}`}>
              <header className="doc-preview-head">
                <FileText size={15} strokeWidth={1.5} aria-hidden="true" />
                <span className="doc-preview-title">{previewDoc.title}</span>
                <button
                  type="button"
                  className="doc-preview-max"
                  onClick={() => navigate({ name: 'file', src: fileRouteSrc('file', previewDoc.pdfPath!) })}
                  aria-label="Open the large reading page"
                  title="Large"
                >
                  <Maximize2 size={15} strokeWidth={1.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="doc-preview-close"
                  onClick={() => setPreviewSlug(null)}
                  aria-label="Close preview"
                >
                  <X size={15} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </header>
              <iframe
                className="doc-preview-frame"
                src={fileUrlFor(previewDoc.pdfPath)}
                title={`PDF: ${previewDoc.title}`}
              />
            </aside>
          )}
        </div>
      )}
    </section>
  );
}

function DocumentCard({
  doc, previewOpen, onPreview,
}: {
  doc: DocumentRow;
  previewOpen: boolean;
  onPreview: () => void;
}) {
  const meta = keyMetadataRows(doc.metadata);
  return (
    <article className="doc-card" role="listitem">
      <header className="doc-card-head">
        <span className="doc-card-glyph" aria-hidden="true">
          <FileText size={18} strokeWidth={1.5} />
        </span>
        <button
          type="button"
          className="doc-card-title"
          onClick={() => navigate({ name: 'note', type: 'documents', slug: doc.slug })}
        >
          {doc.title}
        </button>
        {doc.doc_type && <span className="doc-chip">{doc.doc_type}</span>}
      </header>

      {meta.length > 0 && (
        <dl className="doc-meta">
          {meta.map(([k, v]) => (
            <div className="doc-meta-row" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {doc.connections.length > 0 && (
        <div className="doc-connections" aria-label="Connected notes">
          <Link2 size={13} strokeWidth={1.5} aria-hidden="true" className="doc-connections-glyph" />
          {doc.connections.slice(0, 6).map((c) => (
            <button
              key={`${c.type ?? ''}/${c.slug}`}
              type="button"
              className="doc-conn-chip"
              data-direction={c.direction}
              title={c.direction === 'backlink' ? 'Links to this document' : 'Linked from this document'}
              onClick={() =>
                c.clickable && c.type
                  ? navigate({ name: 'note', type: c.type, slug: c.slug })
                  : navigate({ name: 'resolve', slug: c.slug })}
            >
              {c.title}
            </button>
          ))}
          {doc.connections.length > 6 && (
            <span className="doc-conn-more">+{doc.connections.length - 6}</span>
          )}
        </div>
      )}

      <footer className="doc-card-foot">
        {doc.date && <span className="doc-card-date">{formatDate(doc.date)}</span>}
        {doc.pdfPath ? (
          <button
            type="button"
            className="doc-preview-btn"
            aria-pressed={previewOpen}
            onClick={onPreview}
          >
            {previewOpen ? 'Close preview' : 'Preview PDF'}
          </button>
        ) : (
          <span className="doc-nofile">No file attached</span>
        )}
      </footer>
    </article>
  );
}

function formatDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}
