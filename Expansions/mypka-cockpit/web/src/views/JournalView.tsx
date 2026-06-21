// JournalView.tsx — the journal as a Stoic-app-style vertical timeline.
//
// A single reading column hangs off a left spine (token hairline). Months are
// sticky dividers; each entry is a calm card with a mood-tinted date node on
// the spine, mood/energy chips, a ~400-char excerpt that UNFOLDS in place to
// the full entry (WikiMarkdown), embedded image thumbnails (lightbox-lite),
// and an open-full link into the universal note viewer.
//
// Data: GET /api/cockpit/journal-feed?before=<YYYY-MM-DD>&limit=20
// (server/journalFeed.js). Infinite scroll BACKWARDS: an IntersectionObserver
// sentinel at the bottom loads the next page (before = oldest loaded date);
// the end-state is a quiet "the beginning of your journal".
//
// Motion is CSS-only and inherits the global prefers-reduced-motion collapse
// (index.css); the unfold reuses the measurement-free .collapse-rows utility.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, NotebookPen, ArrowUpRight, Sparkles, X } from 'lucide-react';
import { navigate } from '../lib/router';
import { verifyThenSignalAuthExpired } from '../lib/auth';
import type { CockpitNote } from '../lib/cockpitTypes';
import { MoodChip, EnergyChip } from '../components/JournalChips';
import { WikiMarkdown } from '../components/WikiMarkdown';
import { ImageLightbox } from '../components/ImageLightbox';
import { PageHeader } from '../components/PageHeader';
import {
  fetchRawEntries,
  createJournalEntry,
  integrateJournalEntry,
  type RawJournalEntry,
} from '../lib/journal';
import './journal.css';

// ---------------------------------------------------------------------------
// Feed payload types (server/journalFeed.js).
// ---------------------------------------------------------------------------
interface FeedEntry {
  slug: string;
  title: string;
  date: string;
  mood: string | null;
  moodValence: number | null;
  energy: string | null;
  category: string | null;
  excerpt: string;
  contentLength: number;
  images: string[];
  /** 'raw' for a manually-added entry not yet woven into the graph (drives the
   *  Integrate button). Mirror-served entries leave this undefined. */
  integrationStatus?: 'raw' | 'integrated';
}

// Adapt a file-layer raw entry (journal.ts) to the timeline's FeedEntry shape.
function rawToFeedEntry(r: RawJournalEntry): FeedEntry {
  return {
    slug: r.slug,
    title: r.title,
    date: r.date,
    mood: null,
    moodValence: null,
    energy: null,
    category: null,
    excerpt: r.excerpt,
    contentLength: r.contentLength,
    images: [],
    integrationStatus: 'raw',
  };
}

interface FeedResponse {
  entries: FeedEntry[];
  hasMore: boolean;
  nextBefore: string | null;
}

interface NoteResponse {
  found: boolean;
  note?: CockpitNote;
}

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Small date helpers.
// ---------------------------------------------------------------------------
function monthKey(date: string): string {
  return date.slice(0, 7); // "2026-06-01" -> "2026-06"
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function dayLabel(date: string): string {
  try {
    return new Date(`${date}T12:00:00`)
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    return date;
  }
}

// GL-003 §8.11.1 mood→tint ladder (the --stoic-mood-* tokens): the timeline's
// spine node carries the valence as a quiet border tint. No valence -> hairline.
function valenceClass(v: number | null): string {
  if (v == null) return 'jt-node--neutral';
  if (v >= 5) return 'jt-node--positive';
  if (v >= 4) return 'jt-node--positive-soft';
  if (v <= 1) return 'jt-node--hard';
  if (v <= 2) return 'jt-node--tense';
  return 'jt-node--neutral';
}

// Same-origin GET with the useCockpit 401 discipline: a spurious 401 re-verifies
// the session instead of tearing the app down; this read surfaces inline.
async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) {
    void verifyThenSignalAuthExpired();
    throw new Error('Session check failed — please retry.');
  }
  if (!r.ok) throw new Error(`Server responded ${r.status}`);
  return r.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------
export function JournalView() {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  // Raw (manually-added, un-mirrored) entries read off the file layer. Kept
  // separate from the mirror feed and merged at render so a freshly-saved entry
  // appears immediately, before the next regen ingests it.
  const [rawEntries, setRawEntries] = useState<FeedEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialised, setInitialised] = useState(false);
  const [lightbox, setLightbox] = useState<{ path: string; alt: string } | null>(null);

  const reloadRaw = useCallback(async () => {
    const raws = await fetchRawEntries();
    setRawEntries(raws.map(rawToFeedEntry));
  }, []);
  // Per-month collapse, keyed on "YYYY-MM". Session-only — no persistence.
  const [collapsedMonths, setCollapsedMonths] = useState<ReadonlySet<string>>(new Set());

  const toggleMonth = useCallback((key: string) => {
    setCollapsedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Live mirrors for the observer callback (avoids re-wiring it per page).
  const stateRef = useRef({ loading: false, hasMore: true, nextBefore: null as string | null });
  stateRef.current = { loading, hasMore, nextBefore };

  const loadPage = useCallback(async (before: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) qs.set('before', before);
      const page = await fetchJson<FeedResponse>(`/api/cockpit/journal-feed?${qs.toString()}`);
      setEntries((prev) => {
        // Dedupe on slug across the page seam (defensive; the date cursor
        // shouldn't repeat, but a regen between pages could shift rows).
        const seen = new Set(prev.map((e) => e.slug));
        return [...prev, ...page.entries.filter((e) => !seen.has(e.slug))];
      });
      setHasMore(page.hasMore);
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setInitialised(true);
    }
  }, []);

  // First page on mount, plus the raw (un-mirrored) entries.
  useEffect(() => { void loadPage(null); }, [loadPage]);
  useEffect(() => { void reloadRaw(); }, [reloadRaw]);

  // Backwards infinite scroll: the bottom sentinel pulls the next page.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (obs) => {
        const s = stateRef.current;
        if (obs.some((o) => o.isIntersecting) && !s.loading && s.hasMore && s.nextBefore) {
          void loadPage(s.nextBefore);
        }
      },
      { rootMargin: '480px 0px' }, // start fetching well before the edge
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadPage, initialised]);

  // Merge raw (file-layer) entries with the mirror feed. A raw entry that the
  // mirror already knows (same slug — e.g. after a regen) is dropped so the
  // richer mirror row wins. Combined list is re-sorted newest-first by date
  // (the file-layer entries carry the same YYYY-MM-DD shape).
  const merged = useMemo(() => {
    const mirrorSlugs = new Set(entries.map((e) => e.slug));
    const rawOnly = rawEntries.filter((r) => !mirrorSlugs.has(r.slug));
    const all = [...rawOnly, ...entries];
    all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return all;
  }, [entries, rawEntries]);

  // Consecutive month grouping (entries arrive newest-first, so months are
  // contiguous). Grouped sections — not a flat list — so each sticky month
  // header has its whole month as its sticky scope.
  const groups = useMemo(() => {
    const out: { key: string; entries: FeedEntry[] }[] = [];
    for (const e of merged) {
      const mk = monthKey(e.date);
      const last = out[out.length - 1];
      if (last && last.key === mk) last.entries.push(e);
      else out.push({ key: mk, entries: [e] });
    }
    return out;
  }, [merged]);

  if (!initialised && loading) {
    return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  }
  if (!initialised && error) {
    return <div role="alert" className="view-error">Could not load the journal: {error}</div>;
  }

  return (
    <section className="jt-view animate-fade-rise">
      <PageHeader
        title="Journal"
        icon={NotebookPen}
        subtitle={`${merged.length} ${merged.length === 1 ? 'entry' : 'entries'} loaded · newest first`}
        action={<NewEntryAffordance onCreated={() => void reloadRaw()} />}
      />

      {merged.length === 0 ? (
        <p className="jt-empty">No journal entries yet — your timeline begins with the first one.</p>
      ) : (
        <div className="jt-timeline">
          {groups.map((group) => {
            const expanded = !collapsedMonths.has(group.key);
            const listId = `jt-month-entries-${group.key}`;
            return (
              <section key={group.key} className="jt-month-group">
                {/* The sticky month bar is a real button: it collapses/expands the
                    month. Sticky behaviour is unchanged while expanded; collapsed
                    months reduce to just this bar. */}
                <h2 className="jt-month">
                  <button
                    type="button"
                    className="jt-month-btn"
                    onClick={() => toggleMonth(group.key)}
                    aria-expanded={expanded}
                    aria-controls={listId}
                  >
                    <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" className="jt-month-chevron" />
                    <span className="jt-month-text">{monthLabel(group.key)}</span>
                    <span className="jt-month-count">{group.entries.length}</span>
                  </button>
                </h2>
                <div className="collapse-rows" data-open={expanded} id={listId}>
                  <div className="collapse-rows-inner">
                    <ol className="jt-list">
                      {group.entries.map((entry) => (
                        <li key={entry.slug} className="jt-item">
                          <TimelineEntry entry={entry} onImage={(path, alt) => setLightbox({ path, alt })} />
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Footer zone: loader / retry / the calm beginning-of-journal end-state. */}
      <div className="jt-foot">
        {initialised && loading && (
          <div className="list-skeleton jt-foot-loading" aria-busy="true"><div className="skeleton-block" /></div>
        )}
        {initialised && error && !loading && (
          <p role="alert" className="jt-foot-error">
            Could not load older entries: {error}{' '}
            <button type="button" className="jt-retry" onClick={() => void loadPage(nextBefore)}>
              Retry
            </button>
          </p>
        )}
        {!hasMore && merged.length > 0 && (
          <p className="jt-origin">the beginning of your journal</p>
        )}
        <div ref={sentinelRef} className="jt-sentinel" aria-hidden="true" />
      </div>

      {lightbox && (
        <ImageLightbox path={lightbox.path} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One timeline entry card. The unfold lazily fetches the full note body once
// (via the existing /api/cockpit/note route) and renders it through
// WikiMarkdown, so in-body [[wikilinks]] and ![[images]] behave exactly as in
// the note viewer. Collapse keeps the fetched body cached for re-unfolds.
// ---------------------------------------------------------------------------
function TimelineEntry({
  entry,
  onImage,
}: {
  entry: FeedEntry;
  onImage: (path: string, alt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  // Preserved verbatim original (DATA-CONTRACT §10), available once an
  // integrated entry's note detail is fetched; null = nothing to unfold.
  const [originalBody, setOriginalBody] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  // Integrate-launch state for a raw entry.
  const [integrating, setIntegrating] = useState(false);
  const [integrateMsg, setIntegrateMsg] = useState<string | null>(null);
  const bodyId = `jt-full-${entry.slug}`;
  const originalId = `jt-orig-${entry.slug}`;
  const isRaw = entry.integrationStatus === 'raw';

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && body === null && !bodyLoading) {
      setBodyLoading(true);
      setBodyError(null);
      fetchJson<NoteResponse>(`/api/cockpit/note/journal/${encodeURIComponent(entry.slug)}`)
        .then((res) => {
          setBody(res.found && res.note ? res.note.body : '');
          // Capture the preserved original when the entry is integrated.
          const orig = res.note?.journal?.originalBody;
          setOriginalBody(typeof orig === 'string' && orig.trim() ? orig : null);
        })
        .catch((err: unknown) => setBodyError((err as Error).message))
        .finally(() => setBodyLoading(false));
    }
  };

  const onIntegrate = async () => {
    setIntegrating(true);
    setIntegrateMsg(null);
    const res = await integrateJournalEntry(entry.slug);
    setIntegrating(false);
    if (res.kind === 'ok') {
      setIntegrateMsg(
        res.data.launched
          ? 'Opening a terminal with Penn’s integration prompt…'
          : 'Copy the command from the terminal hand-off to integrate this entry.',
      );
    } else if (res.kind === 'disabled') {
      setIntegrateMsg('Integration is unavailable right now.');
    } else if (res.kind === 'not-found') {
      setIntegrateMsg('This entry could not be found on disk.');
    } else if (res.kind === 'auth') {
      setIntegrateMsg('Session expired — please sign in again.');
    } else {
      setIntegrateMsg('Could not start the integration — please retry.');
    }
  };

  return (
    <article className="jt-entry">
      <span className={`jt-node ${valenceClass(entry.moodValence)}`} aria-hidden="true" />
      <div className="jt-card">
        <div className="jt-meta">
          <time className="jt-date" dateTime={entry.date}>{dayLabel(entry.date)}</time>
          <span className="jt-chips">
            {entry.mood && <MoodChip mood={entry.mood} />}
            {entry.energy && <EnergyChip energy={entry.energy} />}
            {entry.category && <span className="jt-cat">{entry.category}</span>}
          </span>
        </div>

        <h3 className="jt-title">
          {entry.title}
          {isRaw && <span className="jt-raw-badge" title="Not yet integrated into your knowledge graph">raw</span>}
        </h3>

        {/* Collapsed: the excerpt. Unfolded: the full entry (WikiMarkdown). */}
        {!open && entry.excerpt && <p className="jt-excerpt">{entry.excerpt}</p>}
        <div className="collapse-rows" data-open={open} id={bodyId}>
          <div className="collapse-rows-inner">
            <div className="jt-full">
              {bodyLoading && <p className="jt-body-loading">Unfolding…</p>}
              {bodyError && (
                <p role="alert" className="jt-foot-error">Could not load the entry: {bodyError}</p>
              )}
              {body !== null && !bodyLoading && <WikiMarkdown body={body} />}

              {/* Unfold-original (DATA-CONTRACT §10): only when the entry is
                  integrated AND the verbatim original was preserved. The
                  always-visible body above is the integrated text; this reveals
                  what the user originally typed. */}
              {body !== null && !bodyLoading && originalBody && (
                <div className="jt-original">
                  <button
                    type="button"
                    className="jt-original-toggle"
                    onClick={() => setShowOriginal((v) => !v)}
                    aria-expanded={showOriginal}
                    aria-controls={originalId}
                  >
                    {showOriginal
                      ? <><ChevronUp size={13} strokeWidth={1.5} aria-hidden="true" /> Hide original</>
                      : <><ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" /> Unfold to show original</>}
                  </button>
                  <div className="collapse-rows" data-open={showOriginal} id={originalId}>
                    <div className="collapse-rows-inner">
                      <div className="jt-original-body">
                        <WikiMarkdown body={originalBody} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {entry.images.length > 0 && (
          <div className="jt-thumbs" role="group" aria-label={`${entry.images.length} attached image${entry.images.length > 1 ? 's' : ''}`}>
            {entry.images.map((path) => (
              <ThumbButton key={path} path={path} title={entry.title} onOpen={onImage} />
            ))}
          </div>
        )}

        <div className="jt-actions">
          <button
            type="button"
            className="jt-unfold"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
          >
            {open
              ? <><ChevronUp size={14} strokeWidth={1.5} aria-hidden="true" /> Fold</>
              : <><ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /> Unfold</>}
          </button>
          <button
            type="button"
            className="jt-open-full"
            onClick={() => navigate({ name: 'note', type: 'journal', slug: entry.slug })}
          >
            Open entry <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {/* Integrate — only for raw (not-yet-integrated) entries. Launches a
              terminal with Penn's prefilled integration prompt for THIS entry. */}
          {isRaw && (
            <button
              type="button"
              className="jt-integrate"
              onClick={() => void onIntegrate()}
              disabled={integrating}
              title="Weave this entry into your knowledge graph with Penn"
            >
              <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
              {integrating ? 'Launching…' : 'Integrate'}
            </button>
          )}
        </div>
        {integrateMsg && <p className="jt-integrate-msg" role="status">{integrateMsg}</p>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// "+ New entry" — the composer at the top of the journal (Feature #9a). An
// inline panel (no browser dialog): a title field + a markdown body textarea.
// On save → POST /api/cockpit/journal/new → the entry is written as a raw,
// manually-added markdown file under PKM/Journal/YYYY/MM/ and surfaces
// immediately (the parent re-pulls /journal/raw via onCreated).
// ---------------------------------------------------------------------------
type ComposerPhase =
  | { kind: 'closed' }
  | { kind: 'open' }
  | { kind: 'saving' }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string };

function NewEntryAffordance({ onCreated }: { onCreated: () => void }) {
  const [phase, setPhase] = useState<ComposerPhase>({ kind: 'closed' });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (phase.kind === 'open') titleRef.current?.focus();
  }, [phase.kind]);

  const close = () => {
    setPhase({ kind: 'closed' });
    setTitle('');
    setBody('');
  };

  const submit = async () => {
    const t = title.trim();
    if (!t) { titleRef.current?.focus(); return; }
    setPhase({ kind: 'saving' });
    const res = await createJournalEntry(t, body);
    switch (res.kind) {
      case 'ok':
        onCreated();
        close();
        break;
      case 'disabled':
        setPhase({ kind: 'disabled' });
        break;
      case 'too-large':
        setPhase({ kind: 'error', message: 'That entry is too large to save.' });
        break;
      case 'conflict':
        setPhase({ kind: 'error', message: 'An entry with that title already exists today.' });
        break;
      case 'auth':
        setPhase({ kind: 'error', message: 'Session expired — please sign in again.' });
        break;
      default:
        setPhase({
          kind: 'error',
          message: 'kind' in res && res.kind === 'error' ? res.message : 'Could not save the entry.',
        });
    }
  };

  if (phase.kind === 'closed') {
    return (
      <button type="button" className="jt-new-btn" onClick={() => setPhase({ kind: 'open' })}>
        <NotebookPen size={15} strokeWidth={1.5} aria-hidden="true" />
        New entry
      </button>
    );
  }

  const busy = phase.kind === 'saving';

  return (
    <div className="jt-composer" role="group" aria-label="New journal entry">
      <div className="jt-composer-row">
        <input
          ref={titleRef}
          type="text"
          className="jt-composer-title"
          placeholder="Title…"
          aria-label="Entry title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
        />
        <button
          type="button"
          className="jt-composer-cancel"
          aria-label="Cancel new entry"
          onClick={close}
          disabled={busy}
        >
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <textarea
        className="jt-composer-body"
        placeholder="Write your entry… (markdown)"
        aria-label="Entry body"
        rows={5}
        value={body}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter saves; Escape cancels.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); close(); }
        }}
      />
      <div className="jt-composer-foot">
        {phase.kind === 'disabled' && (
          <p className="jt-composer-note" role="status">Saving is disabled right now (read-only cockpit).</p>
        )}
        {phase.kind === 'error' && (
          <p className="jt-composer-note jt-composer-note--error" role="alert">{phase.message}</p>
        )}
        <span className="jt-composer-hint">⌘/Ctrl + Enter to save</span>
        <button
          type="button"
          className="jt-composer-save"
          disabled={busy || !title.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : 'Save entry'}
        </button>
      </div>
    </div>
  );
}

// A thumbnail that degrades silently when the bytes are missing on disk (the
// mirror knows the path; the file may not be there). No broken-image icon.
function ThumbButton({
  path,
  title,
  onOpen,
}: {
  path: string;
  title: string;
  onOpen: (path: string, alt: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const name = path.split('/').pop() ?? path;
  if (failed) return null;
  return (
    <button
      type="button"
      className="jt-thumb"
      onClick={() => onOpen(path, `${title} — ${name}`)}
      aria-label={`View image ${name}`}
    >
      <img
        src={`/api/cockpit/media?path=${encodeURIComponent(path)}`}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </button>
  );
}
