// OuterWorldView.tsx — the OUTER WORLD surface (DATA-CONTRACT §14). The mymind-
// style store of everything the user SAVES from outside their own head (articles,
// posts, videos, books, ideas, news):
//
//   #/outer-world            → the CARD GRID: a masonry/auto-fill grid of rich,
//                              static embed cards (client-side facets + free-text
//                              search over the in-memory rows). First-class empty
//                              state on a bare scaffold (table absent/empty).
//   #/outer-world/:slug      → that item opened in the LARGE detail view (the embed
//                              header ABOVE the rendered markdown body + tom_context
//                              annotation + linked entities + the connections canvas,
//                              like a note/library-item page).
//
// Read-only over mypka.db (server/outerWorldApi.js). Every payload carries
// `available`; a bare scaffold (no outer_world table) degrades to a calm empty
// state — never a blank page, never a crash (§14 degrade-gracefully).
//
// SECURITY POSTURE (Axon / Vex). The cards are STATIC, prop-driven, offline:
//   * NO iframes, NO third-party scripts, NO oEmbed/X-widget/YouTube-player embeds.
//   * Metadata is rendered as TEXT ONLY — no dangerouslySetInnerHTML anywhere.
//   * embed_image / embed_favicon are LOCAL paths (localized at capture, §14.2)
//     served through the existing jailed /api/cockpit/media route — there is NO
//     remote image fetch at render and the cockpit's CSP need not allow remote
//     img-src. <img> uses loading="lazy" + decoding="async"; a missing file shows
//     a calm fallback (never a broken-image icon).
//   * A card click EITHER opens the source URL in a new tab with
//     rel="noopener noreferrer" (the open-out affordance) OR opens the in-app
//     detail-large — the card body itself routes to detail-large; the explicit
//     open-out is a separate, labelled control.
//
// Pattern follows LibraryView.tsx (facets built from the distinct values that
// ACTUALLY occur, so a new source_type/tag/domain shows up with no code change),
// specialised to the §14 embed-card shape + per-embed_kind card variants.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Globe, Search, ArrowLeft, ExternalLink, Info, ImageOff,
  Play, FileText, MessageSquare, BookOpen, Lightbulb, Newspaper, Link as LinkIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { hrefFor, useRoute } from '../lib/router';
import { PageHeader } from '../components/PageHeader';
import { WikiMarkdown } from '../components/WikiMarkdown';
import { MiniGraph } from '../components/graph/MiniGraph';
import type {
  OuterWorldItem, OuterWorldListResponse,
  OuterWorldItemResponse, OuterWorldItemDetail,
} from '../lib/cockpitTypes';
import './outerworld.css';

// A source-type → icon map (CURATED named imports — never `import * as Lucide`,
// which pulls the whole ~700kB icon set into this chunk; Felix-C's 741kB lesson).
// Unknown / null → a generic link mark, so a new open-vocab source_type
// ('podcast', 'newsletter', …) renders with no code change (§14.4(a)).
const SOURCE_ICONS: Record<string, LucideIcon> = {
  article: FileText,
  post: MessageSquare,
  video: Play,
  book: BookOpen,
  idea: Lightbulb,
  news: Newspaper,
};
function sourceIcon(t: string | null | undefined): LucideIcon {
  if (t && SOURCE_ICONS[t]) return SOURCE_ICONS[t];
  return LinkIcon;
}

// Title-case an open-vocab token for a facet/pill label.
function humanToken(t: string): string {
  return t.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const mediaUrl = (path: string) => `/api/cockpit/media?path=${encodeURIComponent(path)}`;

// =============================================================================
// Card image — LOCAL only, graceful. Never a broken <img>; on a missing file it
// falls back to the favicon chrome + title (handled by the caller passing failed).
// =============================================================================
function CardImage({ path, alt }: { path: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="ow-card-img ow-card-img--missing" aria-hidden="true">
        <ImageOff size={20} strokeWidth={1.5} />
      </div>
    );
  }
  return (
    <img
      className="ow-card-img"
      src={mediaUrl(path)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// A small favicon chip (LOCAL path) used in the card chrome line. Self-hides on
// error (the domain text alone is enough chrome).
function Favicon({ path }: { path: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!path || failed) return null;
  return (
    <img
      className="ow-favicon"
      src={mediaUrl(path)}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// =============================================================================
// (1) CARD GRID
// =============================================================================
// The card is a STATIC, prop-driven embed card. Its main body links to the in-app
// detail-large (#/outer-world/:slug); a small explicit open-out control opens the
// source in a new tab (rel=noopener noreferrer). Variants by embed_kind:
//   * video → hero image with a play badge overlay
//   * post  → a compact "post on <site>" chrome card (X-style affordance)
//   * else  → the standard rich link card (image OR favicon+title fallback)
function OuterWorldCard({ item }: { item: OuterWorldItem }) {
  const kind = (item.embed_kind || item.source_type || 'link').toLowerCase();
  const Icon = sourceIcon(item.source_type);
  const detailHref = hrefFor({ name: 'outer-world', slug: item.slug });

  const cardTitle = item.embed_title || item.title || item.slug;
  const domain = item.embed_domain || item.embed_site_name || null;
  const isPost = kind === 'post';
  const isVideo = kind === 'video';
  const hasImage = !!item.embed_image && !isPost; // post variant is chrome-only

  return (
    <li className="ow-card-li">
      <article className="ow-card">
        {/* Whole-card click → in-app detail-large. The media region is a link so
            the big target opens detail; the explicit source open-out is separate. */}
        <a className="ow-card-main" href={detailHref} aria-label={`Open ${cardTitle}`}>
          {hasImage && item.embed_image ? (
            <div className={`ow-card-media${isVideo ? ' ow-card-media--video' : ''}`}>
              <CardImage path={item.embed_image} alt={item.embed_title || item.title || ''} />
              {isVideo && (
                <span className="ow-play-badge" aria-hidden="true">
                  <Play size={20} strokeWidth={2} />
                </span>
              )}
            </div>
          ) : null}

          <div className="ow-card-body">
            {/* Source-type affordance + domain chrome. */}
            <div className="ow-card-chrome">
              <span className="ow-kind-pill">
                <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
                {humanToken(item.source_type || kind)}
              </span>
              {(domain || item.embed_favicon) && (
                <span className="ow-card-domain">
                  <Favicon path={item.embed_favicon} />
                  {domain}
                </span>
              )}
            </div>

            <h3 className="ow-card-title">{cardTitle}</h3>

            {isPost && (
              <p className="ow-card-postline">
                {item.source_author ? `${item.source_author} · ` : ''}
                Post on {item.embed_site_name || domain || 'the web'}
              </p>
            )}

            {item.embed_description && (
              <p className="ow-card-desc">{item.embed_description}</p>
            )}

            {/* The Inner-World annotation snippet — what Tom kept it for. */}
            {item.tom_context && (
              <p className="ow-card-note">{item.tom_context}</p>
            )}

            {item.tags.length > 0 && (
              <ul className="ow-card-tags">
                {item.tags.slice(0, 4).map((t) => (
                  <li key={t} className="ow-tag">#{t}</li>
                ))}
              </ul>
            )}
          </div>
        </a>

        {/* Footer: open the source out (new tab, hardened rel) + saved date. */}
        <div className="ow-card-foot">
          {item.captured_on && <span className="ow-card-date">Saved {item.captured_on}</span>}
          {item.source_url && (
            <a
              className="ow-card-out"
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
              Open source
            </a>
          )}
        </div>
      </article>
    </li>
  );
}

// The bucket facets (Topic / KE / Project / source_type / tag) — built from the
// values that ACTUALLY occur across the loaded rows (§14.4(a)/(b)).
type BucketKey =
  | 'source_type' | 'tag'
  | 'linked_topics' | 'linked_key_elements' | 'linked_projects';

const BUCKET_LABEL: Record<BucketKey, string> = {
  source_type: 'Type',
  tag: 'Tag',
  linked_topics: 'Topic',
  linked_key_elements: 'Key Element',
  linked_projects: 'Project',
};

function OuterWorldGrid() {
  const { data, loading, error } = useFetch<OuterWorldListResponse>('/api/cockpit/outer-world');
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState<BucketKey>('source_type');
  const [facet, setFacet] = useState(''); // selected facet value within the bucket

  const items = useMemo(() => data?.items ?? [], [data]);

  // Distinct values for the active bucket, sorted. source_type is a scalar; the
  // others are arrays (tags / linked_*). Built from real occurring values.
  const facetOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (bucket === 'source_type') {
        if (it.source_type) set.add(it.source_type);
      } else if (bucket === 'tag') {
        for (const t of it.tags) set.add(t);
      } else {
        for (const v of it[bucket]) set.add(v);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items, bucket]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (facet) {
        if (bucket === 'source_type') {
          if (it.source_type !== facet) return false;
        } else if (bucket === 'tag') {
          if (!it.tags.includes(facet)) return false;
        } else if (!it[bucket].includes(facet)) {
          return false;
        }
      }
      if (q) {
        const hay = [
          it.title, it.embed_title, it.embed_description, it.tom_context,
          it.source_author, it.embed_author, it.embed_site_name, it.embed_domain,
          it.source_type, ...it.tags,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, query, bucket, facet]);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">Could not load Outer World: {error}</div>;

  // Table absent on a bare scaffold (available:false), or installed-but-empty.
  const unavailable = data && !data.available;
  const empty = items.length === 0;

  return (
    <section ref={topRef} className="ow-view animate-fade-rise">
      <PageHeader
        title="Outer World"
        icon={Globe}
        subtitle={empty ? undefined : `${items.length} saved · ${filtered.length} shown`}
      />

      {empty ? (
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <Globe size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">
            {unavailable ? 'Outer World isn’t set up yet' : 'Nothing saved yet'}
          </p>
          <p className="library-empty-sub">
            {unavailable ? (
              <>
                The Outer World is your mymind-style library of everything you save from
                outside your own head — articles, posts, videos, books, ideas. Enable it
                with the SQLite upgrade (<span className="font-mono">install-extensions.py
                --with-outer-world</span>), then capture a few items and regenerate.
              </>
            ) : (
              <>
                Save an article, post, video, book, or idea into{' '}
                <span className="font-mono">PKM/Outer World/</span> and it appears here as a
                rich card, ready to browse.
              </>
            )}
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
                placeholder="Search title, note, author, tag…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search Outer World"
              />
            </label>
            <label className="filter-facet">
              <span className="filter-facet-label">Facet</span>
              <select
                className="filter-select"
                value={bucket}
                onChange={(e) => { setBucket(e.target.value as BucketKey); setFacet(''); }}
                aria-label="Choose facet"
              >
                {(Object.keys(BUCKET_LABEL) as BucketKey[]).map((b) => (
                  <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
                ))}
              </select>
            </label>
            {facetOptions.length > 0 && (
              <label className="filter-facet">
                <span className="filter-facet-label">{BUCKET_LABEL[bucket]}</span>
                <select
                  className="filter-select"
                  value={facet}
                  onChange={(e) => setFacet(e.target.value)}
                  aria-label={`Filter by ${BUCKET_LABEL[bucket]}`}
                >
                  <option value="">All</option>
                  {facetOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {bucket === 'source_type' || bucket === 'tag' ? humanToken(opt) : opt}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="library-noresults">No saved items match these filters.</div>
          ) : (
            <ul className="ow-grid">
              {filtered.map((it) => (
                <OuterWorldCard key={it.slug} item={it} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// =============================================================================
// (2) DETAIL — LARGE (embed header above the rendered body)
// =============================================================================
function OuterWorldItemView({ itemSlug }: { itemSlug: string }) {
  const { data, loading, error } = useFetch<OuterWorldItemResponse>(
    `/api/cockpit/outer-world/item/${encodeURIComponent(itemSlug)}`,
  );
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, [itemSlug]);

  // React #310 fix: ALL hooks run UNCONDITIONALLY, before any early return. These
  // memos previously sat AFTER the loading/error/not-found guards, so the first
  // (loading) render ran fewer hooks than the loaded render — "rendered more hooks
  // than during the previous render", crashing on EVERY card open. We derive the
  // memo inputs from the (possibly absent) item and tolerate its absence; the
  // guards below just decide what to PAINT, never which hooks run.
  const item: OuterWorldItemDetail | null = data?.item ?? null;

  // The structured meta rows (source provenance + embed staleness).
  const metaRows = useMemo(() => {
    const rows: Array<[string, string]> = [];
    if (!item) return rows;
    if (item.source_type) rows.push(['Type', humanToken(item.source_type)]);
    if (item.source_author) rows.push(['Author', item.source_author]);
    if (item.embed_site_name) rows.push(['Site', item.embed_site_name]);
    if (item.embed_domain) rows.push(['Domain', item.embed_domain]);
    if (item.source_published) rows.push(['Published', item.source_published]);
    if (item.captured_on) rows.push(['Saved', item.captured_on]);
    if (item.status) rows.push(['Status', humanToken(item.status)]);
    return rows;
  }, [item]);

  const linkedChips = useMemo(() => {
    if (!item) return [] as Array<[string, string, string[]]>;
    const lanes: Array<[string, string, string[]]> = [
      ['Topics', 'topics', item.linked_topics],
      ['Key Elements', 'key_elements', item.linked_key_elements],
      ['Projects', 'projects', item.linked_projects],
      ['People', 'people', item.linked_people],
      ['Organizations', 'organizations', item.linked_organizations],
    ];
    return lanes.filter(([, , v]) => v.length > 0);
  }, [item]);

  if (loading) return <ViewSkeleton />;
  if (error) return <div role="alert" className="view-error">Could not load this item: {error}</div>;
  if (!data || !data.found || !item) {
    return (
      <div className="note-view">
        <a className="back-button" href={hrefFor({ name: 'outer-world' })}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Outer World
        </a>
        <p className="note-empty">No saved item found for <span className="font-mono">{itemSlug}</span>.</p>
      </div>
    );
  }

  const Icon = sourceIcon(item.source_type);
  const body = typeof item.body === 'string' ? item.body : '';
  const cardTitle = item.embed_title || item.title || item.slug;
  const isVideo = (item.embed_kind || item.source_type || '').toLowerCase() === 'video';

  return (
    <article ref={topRef} className="note-view ow-item-view animate-fade-rise">
      <a className="back-button" href={hrefFor({ name: 'outer-world' })}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back to Outer World
      </a>

      {/* The embed card up top — image (or favicon fallback) + title + source. */}
      <header className="ow-detail-embed">
        {item.embed_image ? (
          <div className={`ow-detail-media${isVideo ? ' ow-card-media--video' : ''}`}>
            <CardImage path={item.embed_image} alt={item.embed_title || item.title || ''} />
            {isVideo && (
              <span className="ow-play-badge ow-play-badge--lg" aria-hidden="true">
                <Play size={26} strokeWidth={2} />
              </span>
            )}
          </div>
        ) : null}
        <div className="ow-detail-embed-body">
          <div className="ow-card-chrome">
            <span className="ow-kind-pill">
              <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
              {humanToken(item.source_type || item.embed_kind || 'link')}
            </span>
            {(item.embed_domain || item.embed_site_name) && (
              <span className="ow-card-domain">
                <Favicon path={item.embed_favicon} />
                {item.embed_domain || item.embed_site_name}
              </span>
            )}
          </div>
          <h1 className="ow-detail-title">{item.title || cardTitle}</h1>
          {item.embed_title && item.embed_title !== item.title && (
            <p className="ow-detail-embed-title">{item.embed_title}</p>
          )}
          {item.embed_description && (
            <p className="ow-detail-desc">{item.embed_description}</p>
          )}
          {item.source_url && (
            <a
              className="ow-detail-out"
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
              Open source
            </a>
          )}
        </div>
      </header>

      <div className="note-grid">
        <div className="note-body-col">
          {/* tom_context — the highlighted Inner-World annotation. */}
          {item.tom_context && (
            <blockquote className="ow-detail-context">{item.tom_context}</blockquote>
          )}
          {body.trim() ? (
            <WikiMarkdown body={body} />
          ) : (
            <p className="note-empty">No detail text saved for this item.</p>
          )}
          {/* Connections canvas — outer_world rows are real graph nodes (their body
              wikilinks are `links` edges). Self-hides when there is no neighbourhood. */}
          <MiniGraph focusType="outer_world" slug={item.slug} />
        </div>

        <aside className="note-side">
          <section className="side-panel">
            <h2 className="side-panel-title">
              <Info size={15} strokeWidth={1.5} aria-hidden="true" /> Details
            </h2>
            {metaRows.length === 0 ? (
              <p className="side-empty">No structured fields.</p>
            ) : (
              <dl className="meta-list">
                {metaRows.map(([k, v]) => (
                  <div key={k} className="meta-row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {item.tags.length > 0 && (
              <ul className="ow-card-tags ow-detail-tags">
                {item.tags.map((t) => (
                  <li key={t} className="ow-tag">#{t}</li>
                ))}
              </ul>
            )}
            {linkedChips.length > 0 && (
              <div className="ow-linked">
                {linkedChips.map(([label, type, slugs]) => (
                  <div key={type} className="ow-linked-lane">
                    <span className="ow-linked-label">{label}</span>
                    <ul className="ow-linked-chips">
                      {slugs.map((s) => (
                        <li key={s}>
                          <a
                            className="ow-linked-chip"
                            href={hrefFor({ name: 'resolve', slug: s })}
                          >
                            {s}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {item.file_path && <p className="side-filepath font-mono">{item.file_path}</p>}
          </section>
        </aside>
      </div>
    </article>
  );
}

// =============================================================================
// Router shell — picks the sub-view from the current route.
// =============================================================================
export function OuterWorldView() {
  const route = useRoute();
  if (route.name !== 'outer-world') return null; // defensive; App only mounts on 'outer-world'
  if (route.slug) return <OuterWorldItemView itemSlug={route.slug} />;
  return <OuterWorldGrid />;
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
