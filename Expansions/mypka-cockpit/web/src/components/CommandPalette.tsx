// CommandPalette.tsx — the ⌘K / Ctrl+K global search modal (item-8).
//
// FTS5 full-text search across note TITLES and BODIES (DATA-CONTRACT §13),
// served by GET /api/cockpit/search/global. This is the cockpit's first search
// that reaches into note prose, not just titles. Results are grouped by entity
// type, fully keyboard-navigable (↑/↓ move, Enter opens, Esc closes), render the
// server's <mark> snippet highlights, and route to the universal note viewer.
//
// A11y: role="dialog" + aria-modal; the listbox/option pattern with
// aria-activedescendant tracks the active row for screen readers; focus is
// trapped inside the modal and restored to the trigger on close. Honours the
// light/dark theme (tokens only) and prefers-reduced-motion (the shared
// .cmdk-* animations collapse via the global reduce block in index.css).
//
// Debounced as-you-type (140ms) so a fast typist fires one query per pause, not
// per keystroke. Portal-rendered to <body> (same idiom as ImageLightbox) so no
// transformed ancestor can trap the fixed overlay.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import { navigate } from '../lib/router';
import type {
  GlobalSearchResponse, GlobalSearchHit, EntityType,
} from '../lib/cockpitTypes';
import { verifyThenSignalAuthExpired } from '../lib/auth';

const DEBOUNCE_MS = 140;
const RESULT_LIMIT = 30;

interface Group {
  label: string;
  type: string;
  hits: GlobalSearchHit[];
}

// Split a server snippet on the literal <mark>…</mark> tags into safe segments.
// The body text itself is rendered as plain text (never as HTML), so untrusted
// note prose can't inject markup; only the server's own <mark> wrapper styles a
// match. Returns alternating { text, mark } runs.
function parseSnippet(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  const re = /<mark>(.*?)<\/mark>/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), mark: false });
    out.push({ text: m[1], mark: true });
    last = re.lastIndex;
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), mark: false });
  return out;
}

function Snippet({ snippet }: { snippet: string }) {
  const parts = useMemo(() => parseSnippet(snippet), [snippet]);
  return (
    <span className="cmdk-snippet">
      {parts.map((p, i) =>
        p.mark
          ? <mark key={i} className="cmdk-mark">{p.text}</mark>
          : <span key={i}>{p.text}</span>
      )}
    </span>
  );
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<GlobalSearchHit[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0); // index into the FLAT hit list

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus the input on open; restore focus to the trigger on close. Scroll-lock
  // the body while open (house idiom — .overlay-open).
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    document.body.classList.add('overlay-open');
    return () => {
      document.body.classList.remove('overlay-open');
      restoreRef.current?.focus();
    };
  }, []);

  // Debounced FTS fetch. Empty query clears results without a round-trip.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]); setLoading(false); setError(null); setActive(0);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      fetch(`/api/cockpit/search/global?q=${encodeURIComponent(q)}&limit=${RESULT_LIMIT}`,
        { credentials: 'same-origin' })
        .then((r) => {
          if (r.status === 401) {
            void verifyThenSignalAuthExpired();
            throw new Error('Session check failed — please retry.');
          }
          if (!r.ok) throw new Error(`Server responded ${r.status}`);
          return r.json() as Promise<GlobalSearchResponse>;
        })
        .then((data) => {
          if (!alive) return;
          setAvailable(data.available);
          setHits(data.items);
          setActive(0);
          setLoading(false);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setHits([]); setLoading(false); setError((err as Error).message);
        });
    }, DEBOUNCE_MS);
    return () => { alive = false; window.clearTimeout(t); };
  }, [query]);

  // Group hits by type for display, but keep a FLAT order for ↑/↓ navigation so
  // the active index maps 1:1 to a rendered row regardless of grouping.
  const { groups, flat } = useMemo(() => {
    const byType = new Map<string, GlobalSearchHit[]>();
    for (const h of hits) {
      const arr = byType.get(h.type) ?? [];
      arr.push(h);
      byType.set(h.type, arr);
    }
    const groups: Group[] = [];
    const flat: GlobalSearchHit[] = [];
    for (const [type, arr] of byType) {
      groups.push({ type, label: arr[0]?.label ?? type, hits: arr });
      for (const h of arr) flat.push(h);
    }
    return { groups, flat };
  }, [hits]);

  const open = useCallback((hit: GlobalSearchHit) => {
    navigate({ name: 'note', type: hit.type as EntityType, slug: hit.slug });
    onClose();
  }, [onClose]);

  // Keyboard model: Esc closes; ↑/↓ move the active row (wrapping); Enter opens
  // it; Tab is trapped to the input (the only tab-stop besides the close). Owned
  // on the modal container so it works wherever focus sits inside.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (flat.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = flat[active];
      if (hit) open(hit);
    }
  };

  // Keep the active row scrolled into view as the selection moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${active}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const activeId = flat.length > 0 ? `cmdk-opt-${active}` : undefined;
  const showNoResults = query.trim().length > 0 && !loading && !error && hits.length === 0;

  // Render a running flat index so each option's id matches the nav model.
  let flatIdx = -1;

  return createPortal(
    <div className="cmdk-overlay" role="presentation" onMouseDown={onClose}>
      <div className="cmdk-scrim" aria-hidden="true" />
      <div
        ref={modalRef}
        className="cmdk-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search your knowledge base"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <Search size={18} strokeWidth={1.5} aria-hidden="true" className="cmdk-input-icon" />
          <input
            ref={inputRef}
            type="text"
            className="cmdk-input"
            placeholder="Search notes, people, journal…"
            aria-label="Search query"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="cmdk-esc-hint" aria-hidden="true">Esc</span>
        </div>

        <div className="cmdk-results">
          {error && (
            <p role="alert" className="cmdk-state cmdk-state--error">{error}</p>
          )}
          {!error && !available && (
            <p className="cmdk-state">
              The search index hasn’t been built yet. Run a database regen to enable
              full-text search.
            </p>
          )}
          {!error && available && query.trim() === '' && (
            <p className="cmdk-state cmdk-state--hint">
              Type to search across every note’s title and body.
            </p>
          )}
          {showNoResults && available && (
            <p className="cmdk-state">No matches for “{query.trim()}”.</p>
          )}

          {flat.length > 0 && (
            <ul
              ref={listRef}
              id="cmdk-listbox"
              className="cmdk-listbox"
              role="listbox"
              aria-label="Search results"
            >
              {groups.map((group) => (
                <li key={group.type} className="cmdk-group" role="presentation">
                  <p className="cmdk-group-label" id={`cmdk-grp-${group.type}`} role="presentation">
                    {group.label}
                  </p>
                  <ul className="cmdk-group-list" role="group" aria-labelledby={`cmdk-grp-${group.type}`}>
                    {group.hits.map((hit) => {
                      flatIdx += 1;
                      const idx = flatIdx;
                      const isActive = idx === active;
                      return (
                        <li
                          key={`${hit.type}/${hit.slug}`}
                          id={`cmdk-opt-${idx}`}
                          role="option"
                          aria-selected={isActive}
                          className={`cmdk-option ${isActive ? 'is-active' : ''}`}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => open(hit)}
                        >
                          <span className="cmdk-option-main">
                            <span className="cmdk-option-title">{hit.title}</span>
                            {hit.snippet && <Snippet snippet={hit.snippet} />}
                          </span>
                          {isActive && (
                            <CornerDownLeft
                              size={14} strokeWidth={1.5} aria-hidden="true" className="cmdk-option-enter"
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
