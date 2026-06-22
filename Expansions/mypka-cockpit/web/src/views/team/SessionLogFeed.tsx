// SessionLogFeed.tsx — the team's session-log history feed.
//
// Extracted verbatim from the old combined RosterView (2026-06 split): the feed
// + its card used to be the LEFT column of the two-column "My AI Team" page. The
// page is now split into two distinct full-height pages (Roster + Session Log)
// reachable from the sidebar fly-out, so the feed lives in its own module and is
// rendered by SessionLogView.
//
// Reads exactly like the Journal feed: date + title + snippet, click/unfold to
// read the full log. Backwards infinite scroll via an IntersectionObserver whose
// root is the feed's own scroll container. Empty/unavailable -> a calm honest
// state (no logs yet, or no session_logs table on a leaner mirror).
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { ChevronDown, ChevronUp, ScrollText } from 'lucide-react';
import { verifyThenSignalAuthExpired } from '../../lib/auth';
import { S } from '../../lib/strings';
import { WikiMarkdown } from '../../components/WikiMarkdown';

interface SessionLogEntry {
  slug: string;
  title: string;
  agent: string | null;
  type: string | null;
  timestamp: string | null;
  date: string | null;
  excerpt: string;
  body: string;
  contentLength: number;
  filePath: string | null;
}
interface SessionLogsResponse {
  available: boolean;
  entries: SessionLogEntry[];
  hasMore: boolean;
  nextBefore: string | null;
}

// A YYYY-MM-DD (or ISO) string → a readable day label, with a safe fallback.
function dayLabel(date: string | null): string {
  if (!date) return '';
  const head = date.slice(0, 10);
  try {
    return new Date(`${head}T12:00:00`).toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return head;
  }
}

// Same-origin GET with the useCockpit 401 discipline (a spurious 401 re-verifies
// the session instead of tearing the app down; this read surfaces inline).
async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) {
    void verifyThenSignalAuthExpired();
    throw new Error('Session check failed — please retry.');
  }
  if (!r.ok) throw new Error(`Server responded ${r.status}`);
  return r.json() as Promise<T>;
}

const FEED_PAGE = 20;

export function SessionLogFeed() {
  const [entries, setEntries] = useState<SessionLogEntry[]>([]);
  const [available, setAvailable] = useState(true);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialised, setInitialised] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ loading: false, hasMore: true, nextBefore: null as string | null });
  stateRef.current = { loading, hasMore, nextBefore };

  const loadPage = useCallback(async (before: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(FEED_PAGE) });
      if (before) qs.set('before', before);
      const page = await fetchJson<SessionLogsResponse>(`/api/cockpit/session-logs?${qs.toString()}`);
      setAvailable(page.available);
      setEntries((prev) => {
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

  useEffect(() => { void loadPage(null); }, [loadPage]);

  // Backwards infinite scroll: the bottom sentinel pulls the next page. The
  // observer root is the feed's own scroll container (closest scrollable
  // ancestor), so it fires on the column's scroll, not the document's.
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
      { rootMargin: '320px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadPage, initialised]);

  if (!initialised && loading) {
    return (
      <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>
    );
  }

  // Empty / unavailable — a calm, honest state (no logs yet, or no table).
  if (initialised && (!available || entries.length === 0) && !error) {
    return (
      <div className="team-feed-empty">
        <span className="library-empty-mark" aria-hidden="true">
          <ScrollText size={26} strokeWidth={1.5} />
        </span>
        <p className="library-empty-title">{S.roster.feedEmptyTitle}</p>
        <p className="library-empty-sub">{S.roster.feedEmptySub}</p>
      </div>
    );
  }

  if (!initialised && error) {
    return <div role="alert" className="view-error">{S.roster.feedLoadError}: {error}</div>;
  }

  return (
    <ol className="team-feed-list">
      {entries.map((entry) => (
        <li key={entry.slug} className="team-feed-li">
          <SessionLogCard entry={entry} />
        </li>
      ))}
      <li className="team-feed-foot" aria-hidden={!loading && !error}>
        {initialised && loading && (
          <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>
        )}
        {initialised && error && !loading && (
          <p role="alert" className="jt-foot-error">
            {S.roster.feedLoadError}: {error}{' '}
            <button type="button" className="jt-retry" onClick={() => void loadPage(nextBefore)}>
              Retry
            </button>
          </p>
        )}
        {!hasMore && entries.length > 0 && (
          <p className="team-feed-origin">the beginning of your team’s log</p>
        )}
        <div ref={sentinelRef} className="jt-sentinel" aria-hidden="true" />
      </li>
    </ol>
  );
}

// One session-log entry: date + title + snippet, unfolds in place to the full
// body (WikiMarkdown). Mirrors the Journal feed's TimelineEntry reading.
function SessionLogCard({ entry }: { entry: SessionLogEntry }) {
  const [open, setOpen] = useState(false);
  const bodyId = `team-log-${entry.slug}`;
  return (
    <article className="team-log">
      <div className="team-log-meta">
        {entry.date && <time className="team-log-date" dateTime={entry.date}>{dayLabel(entry.date)}</time>}
        <span className="team-log-tags">
          {entry.agent && <span className="team-log-agent">{entry.agent}</span>}
          {entry.type && <span className="team-log-type">{entry.type}</span>}
        </span>
      </div>
      <h3 className="team-log-title">{entry.title}</h3>
      {!open && entry.excerpt && <p className="team-log-excerpt">{entry.excerpt}</p>}
      <div className="collapse-rows" data-open={open} id={bodyId}>
        <div className="collapse-rows-inner">
          <div className="team-log-full">
            {open && <WikiMarkdown body={entry.body} />}
          </div>
        </div>
      </div>
      {(entry.body || entry.excerpt) && (
        <button
          type="button"
          className="team-log-unfold"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {open
            ? <><ChevronUp size={14} strokeWidth={1.5} aria-hidden="true" /> Fold</>
            : <><ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /> Unfold</>}
        </button>
      )}
    </article>
  );
}
