// MediaView.tsx — the films & series LIBRARY ("Filme & Serien"). Surfaces the
// `media` mirror table (GET /api/cockpit/media-library) as a responsive card
// grid Tom can browse and filter on: media_type (film/serie), status, rating,
// genre, plus a free-text search across title / director-creator / verdict / tags.
//
// Read-only, loopback/LAN posture like every other view. Media entries are
// CANONICAL markdown (PKM/My Life/Media/<slug>.md), mirrored into mypka.db; this
// view is a derived read. NULLs are HONEST signals, never errors: rating NULL =
// unrated (render "—", never 0 stars or "0"); platform NULL = unknown (render
// blank, no placeholder); total_seasons/episodes_watched NULL on films.
// `verdict` is Tom's verbatim take — rendered as-is, line breaks preserved,
// never translated or truncated.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Star, Search } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { S } from '../lib/strings';

interface MediaItem {
  slug: string;
  title: string | null;
  media_type: string | null; // 'film' | 'serie'
  status: string | null;     // watchlist | watching | finished | abandoned
  rating: number | null;     // 1-5, NULL = unrated
  release_year: number | null;
  genre: string | null;
  director_creator: string | null;
  platform: string | null;   // NULL common + meaningful (unknown)
  date_watched: string | null;
  progress: string | null;
  total_seasons: number | null;     // series only
  episodes_watched: number | null;  // series only
  verdict: string | null;     // verbatim, preserve line breaks
  tags: string[];
  file_path: string;
}
interface MediaResponse { media: MediaItem[] }

// KEYS are data tokens from mypka.db (do NOT translate); VALUES are UI chrome.
const TYPE_LABEL: Record<string, string> = { film: 'Film', serie: 'Series' };
const STATUS_LABEL: Record<string, string> = {
  watchlist: 'Watchlist', watching: 'Watching', finished: 'Finished', abandoned: 'Abandoned',
};

function labelOf(map: Record<string, string>, value: string | null): string {
  if (!value) return '';
  return map[value] ?? value;
}

// Five-star rating. NULL rating -> a calm "—" (unrated), NOT zero stars (that
// would lie). A filled star = brass, empty star = muted outline.
function Rating({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="media-rating media-rating--none" aria-label={S.media.notRated}>—</span>;
  }
  const stars = [1, 2, 3, 4, 5];
  return (
    <span className="media-rating" aria-label={S.media.ratingAria(value)}>
      {stars.map((n) => (
        <Star
          key={n}
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className={n <= value ? 'media-star media-star--on' : 'media-star'}
          fill={n <= value ? 'currentColor' : 'none'}
        />
      ))}
    </span>
  );
}

function distinct(items: MediaItem[], pick: (m: MediaItem) => string | null): string[] {
  const set = new Set<string>();
  for (const m of items) {
    const v = pick(m);
    if (v) set.add(v);
  }
  return Array.from(set).sort();
}

function Facet({
  label, value, options, labelMap, onChange,
}: {
  label: string; value: string; options: string[];
  labelMap?: Record<string, string>; onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <label className="filter-facet">
      <span className="filter-facet-label">{label}</span>
      <select className="filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{S.media.facetAll}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{labelMap?.[opt] ?? opt}</option>
        ))}
      </select>
    </label>
  );
}

function MediaCard({ item }: { item: MediaItem }) {
  const type = labelOf(TYPE_LABEL, item.media_type);
  const status = labelOf(STATUS_LABEL, item.status);
  // Label the credit line per type: "Director" for film, "Creator" for serie.
  const creditLabel = item.media_type === 'serie' ? S.media.creditSerie : S.media.creditFilm;
  const isSerie = item.media_type === 'serie';
  return (
    <li className="lib-card">
      <div className="lib-card-head">
        <span className="lib-card-title">{item.title || item.slug}</span>
        {status && <span className="lib-badge">{status}</span>}
      </div>

      <div className="lib-meta">
        {type && <span className="lib-meta-item">{type}</span>}
        {item.release_year != null && <span className="lib-meta-item">{item.release_year}</span>}
        {item.genre && <span className="lib-meta-item">{item.genre}</span>}
        {/* platform: blank when NULL (no placeholder) */}
        {item.platform && <span className="lib-meta-item">{item.platform}</span>}
      </div>

      <div className="lib-stats">
        <Rating value={item.rating} />
        {item.director_creator && (
          <span className="lib-stat lib-stat--text">{creditLabel}: {item.director_creator}</span>
        )}
      </div>

      {/* Series position (films leave these NULL). */}
      {isSerie && (item.total_seasons != null || item.episodes_watched != null) && (
        <div className="lib-stats">
          {item.total_seasons != null && (
            <span className="lib-stat lib-stat--text">{S.media.seasons(item.total_seasons)}</span>
          )}
          {item.episodes_watched != null && (
            <span className="lib-stat lib-stat--text">{S.media.episodesWatched(item.episodes_watched)}</span>
          )}
        </div>
      )}

      {item.progress && <span className="media-progress">{item.progress}</span>}

      {/* Verdict — Tom's verbatim take. Line breaks preserved (white-space:
          pre-line via .media-verdict). Never translated, never truncated. */}
      {item.verdict && <p className="media-verdict">{item.verdict}</p>}

      {item.tags.length > 0 && (
        <ul className="lib-tags">
          {item.tags.map((t) => (
            <li key={t} className="lib-tag">#{t}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function MediaView() {
  const { data, loading, error } = useFetch<MediaResponse>('/api/cockpit/media-library');
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const [mediaType, setMediaType] = useState('');
  const [status, setStatus] = useState('');
  const [rating, setRating] = useState('');
  const [genre, setGenre] = useState('');
  const [query, setQuery] = useState('');

  const items = useMemo(() => data?.media ?? [], [data]);

  const typeOpts = useMemo(() => distinct(items, (m) => m.media_type), [items]);
  const statusOpts = useMemo(() => distinct(items, (m) => m.status), [items]);
  const genreOpts = useMemo(() => distinct(items, (m) => m.genre), [items]);
  // Ratings present in the data, descending (5 first). NULL ratings are not a
  // facet value — they're reachable via "Alle".
  const ratingOpts = useMemo(() => {
    const set = new Set<string>();
    for (const m of items) if (m.rating != null) set.add(String(m.rating));
    return Array.from(set).sort((a, b) => Number(b) - Number(a));
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((m) => {
      if (mediaType && m.media_type !== mediaType) return false;
      if (status && m.status !== status) return false;
      if (rating && String(m.rating) !== rating) return false;
      if (genre && m.genre !== genre) return false;
      if (q) {
        const hay = [
          m.title ?? '',
          m.director_creator ?? '',
          m.verdict ?? '',
          ...m.tags,
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, mediaType, status, rating, genre, query]);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">{S.media.loadError}: {error}</div>;
  if (!data) return null;

  const total = items.length;

  return (
    <section ref={topRef} className="library-view animate-fade-rise">
      <header className="library-header">
        <h1 className="page-title">
          <Clapperboard size={24} strokeWidth={1.5} aria-hidden="true" className="title-icon" />
          {S.media.title}
        </h1>
        <p className="page-sub">
          {total === 0
            ? S.media.emptyLibrary
            : `${total} ${total === 1 ? 'entry' : 'entries'} · ${filtered.length} shown`}
        </p>
      </header>

      {total === 0 ? (
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <Clapperboard size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">{S.media.emptyTitle}</p>
          <p className="library-empty-sub">
            {S.media.emptySub}
          </p>
        </div>
      ) : (
        <>
          <div className="filter-bar" role="search">
            <label className="filter-search">
              <Search size={16} strokeWidth={1.5} aria-hidden="true" className="filter-search-icon" />
              <input
                type="search"
                className="filter-search-input"
                placeholder={S.media.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={S.media.searchAria}
              />
            </label>
            <Facet label={S.media.facetType} value={mediaType} options={typeOpts} labelMap={TYPE_LABEL} onChange={setMediaType} />
            <Facet label={S.media.facetStatus} value={status} options={statusOpts} labelMap={STATUS_LABEL} onChange={setStatus} />
            <Facet label={S.media.facetRating} value={rating} options={ratingOpts} onChange={setRating} />
            <Facet label={S.media.facetGenre} value={genre} options={genreOpts} onChange={setGenre} />
          </div>

          {filtered.length === 0 ? (
            <div className="library-noresults">{S.media.noResults}</div>
          ) : (
            <ul className="library-grid">
              {filtered.map((m) => (
                <MediaCard key={m.slug} item={m} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
