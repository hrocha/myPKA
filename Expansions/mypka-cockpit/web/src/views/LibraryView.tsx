// LibraryView.tsx — the LIBRARY surface (DATA-CONTRACT §11). A single,
// data-driven view over ALL of the user's libraries (recipes, movies, books, …):
//
//   #/library                 → the PICKER: enumerate library_registry, one card
//                               per library (graceful empty state when none).
//   #/library/:lib            → that library's CARD GRID (client-side facets +
//                               free-text search over the in-memory rows).
//   #/library/:lib/:item      → the item opened in the LARGE detail view (the
//                               structured header ABOVE the rendered markdown body
//                               + the connections canvas, like a note page).
//
// Read-only over mypka.db (server/libraryApi.js). Every payload carries
// `available`; a bare scaffold (no library tables installed) degrades to a calm
// empty state — never a blank page, never a crash (§11.4 degrade-gracefully).
//
// Pattern follows examples/library-module/RecipesView.tsx (facet dropdowns built
// from the distinct values that ACTUALLY occur, so a new token shows up with no
// code change) but generalized: the typed axis columns vary per library, so the
// grid renders a generic, contract-driven card from whatever columns the row
// carries — the invariant columns (title/status/tags) plus a small, ordered set
// of recognised display axes.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Library as LibraryIcon, Search, ArrowLeft, ChevronRight, Info,
  ChefHat, Clapperboard, BookOpen, Wine, Dices, Gamepad2, Disc3, Map as MapIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { hrefFor, useRoute } from '../lib/router';
import { PageHeader } from '../components/PageHeader';
import { WikiMarkdown } from '../components/WikiMarkdown';
import { MiniGraph } from '../components/graph/MiniGraph';
import type {
  LibrariesResponse, LibrarySummary, LibraryListResponse, LibraryItem,
  LibraryItemResponse, LibraryItemDetail,
} from '../lib/cockpitTypes';
import './library.css';

// Map a registry `nav_icon` string (a lucide component NAME, e.g. "ChefHat") to a
// real component, via a CURATED allow-list of the icons libraries realistically
// use. Deliberately NOT a `import * as Lucide` namespace lookup — that pulls the
// entire icon set (~700kB) into this chunk. Unknown / null falls back to a generic
// library icon, so a user-added library with an unrecognised icon never crashes
// the nav (§11.4(a)) — it just shows the generic mark.
const LIBRARY_ICONS: Record<string, LucideIcon> = {
  ChefHat, Clapperboard, BookOpen, Wine, Dices, Gamepad2, Disc3, Map: MapIcon,
  Library: LibraryIcon,
};
function iconFor(name: string | null | undefined): LucideIcon {
  if (name && LIBRARY_ICONS[name]) return LIBRARY_ICONS[name];
  return LibraryIcon;
}

// Columns that are NOT user-facing axis values (rendered through dedicated UI or
// not at all). Everything else that is a scalar token is offered as a card meta
// chip / facet candidate.
const NON_AXIS = new Set([
  'slug', 'title', 'status', 'tags', 'file_path', 'body', 'raw_frontmatter',
  'id', 'source_url', 'verdict', 'progress', 'director_creator',
]);

// Recognised display axes, in a stable render order, with a human label. Unknown
// columns still render (labelled by their column name), so a new library's axes
// appear with zero code change — this is just nicer ordering/labels for the
// built-ins.
const AXIS_LABEL: Record<string, string> = {
  cuisine: 'Cuisine', dish_type: 'Type', difficulty: 'Difficulty',
  media_type: 'Type', genre: 'Genre', rating: 'Rating', release_year: 'Year',
  platform: 'Platform', total_time_min: 'Time', servings: 'Servings',
  ingredient_count: 'Ingredients', source_channel: 'Source',
  total_seasons: 'Seasons', episodes_watched: 'Episodes', date_watched: 'Watched',
};

function humanLabel(col: string): string {
  return AXIS_LABEL[col] ?? col.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function scalarText(v: LibraryItem[string]): string | null {
  if (v == null || Array.isArray(v)) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// =============================================================================
// (1) PICKER — enumerate the libraries
// =============================================================================
function LibraryPicker() {
  const { data, loading, error } = useFetch<LibrariesResponse>('/api/cockpit/libraries');
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, []);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">Could not load your libraries: {error}</div>;

  const libraries = data?.libraries ?? [];

  return (
    <section ref={topRef} className="library-view animate-fade-rise">
      <PageHeader
        title="Library"
        icon={LibraryIcon}
        subtitle={libraries.length === 0 ? undefined : `${libraries.length} ${libraries.length === 1 ? 'collection' : 'collections'}`}
      />
      {libraries.length === 0 ? (
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <LibraryIcon size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">No libraries yet</p>
          <p className="library-empty-sub">
            A library is a collection you keep many of — recipes, films, books.
            Once one is set up it appears here, ready to browse.
          </p>
        </div>
      ) : (
        <ul className="library-picker-grid">
          {libraries.map((lib) => (
            <LibraryPickerCard key={lib.library_slug} lib={lib} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LibraryPickerCard({ lib }: { lib: LibrarySummary }) {
  const Icon = iconFor(lib.nav_icon);
  return (
    <li className="library-picker-li">
      <a className="library-picker-card" href={hrefFor({ name: 'library', lib: lib.library_slug })}>
        <span className="library-picker-icon" aria-hidden="true">
          <Icon size={22} strokeWidth={1.5} />
        </span>
        <span className="library-picker-label">{lib.nav_label || lib.library_slug}</span>
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="library-picker-chevron" />
      </a>
    </li>
  );
}

// =============================================================================
// (2) CARD GRID — one library's items
// =============================================================================
function LibraryGrid({ lib }: { lib: string }) {
  const { data, loading, error } = useFetch<LibraryListResponse>(
    `/api/cockpit/library/${encodeURIComponent(lib)}`,
  );
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, [lib]);

  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState('');        // selected facet value
  const [facetCol, setFacetCol] = useState('');   // which column the facet filters

  const items = useMemo(() => data?.items ?? [], [data]);
  const header = data?.library;

  // Pick the FIRST recognised single-value axis column present across the data as
  // the primary facet (cuisine for recipes, genre/media_type for movies, …).
  const facetColumn = useMemo(() => {
    if (items.length === 0) return '';
    const candidates = ['cuisine', 'genre', 'media_type', 'dish_type', 'difficulty'];
    const cols = new Set(Object.keys(items[0]));
    return candidates.find((c) => cols.has(c)) ?? '';
  }, [items]);

  const facetOptions = useMemo(() => {
    if (!facetColumn) return [];
    const set = new Set<string>();
    for (const it of items) {
      const v = scalarText(it[facetColumn]);
      if (v) set.add(v);
    }
    return Array.from(set).sort();
  }, [items, facetColumn]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const col = facetCol || facetColumn;
    return items.filter((it) => {
      if (facet && col && scalarText(it[col]) !== facet) return false;
      if (q) {
        const hay: string[] = [String(it.title ?? ''), ...(it.tags ?? [])];
        for (const [k, v] of Object.entries(it)) {
          if (NON_AXIS.has(k)) continue;
          const s = scalarText(v as LibraryItem[string]);
          if (s) hay.push(s);
        }
        if (!hay.join(' ').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [items, query, facet, facetCol, facetColumn]);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">Could not load this library: {error}</div>;

  const title = header?.navLabel || lib;
  const Icon = iconFor(header?.navIcon);

  // Library registered but the table is empty / unavailable.
  const empty = items.length === 0;

  return (
    <section ref={topRef} className="library-view animate-fade-rise">
      <a className="back-button" href={hrefFor({ name: 'library' })}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> All libraries
      </a>
      <PageHeader
        title={title}
        icon={Icon}
        subtitle={empty ? undefined : `${items.length} ${items.length === 1 ? 'item' : 'items'} · ${filtered.length} shown`}
      />

      {empty ? (
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <Icon size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">This library is empty</p>
          <p className="library-empty-sub">
            Items appear here once they’re added to the collection.
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
                placeholder="Search by title, tag, detail…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Search ${title}`}
              />
            </label>
            {facetColumn && facetOptions.length > 0 && (
              <label className="filter-facet">
                <span className="filter-facet-label">{humanLabel(facetColumn)}</span>
                <select
                  className="filter-select"
                  value={facet}
                  onChange={(e) => { setFacet(e.target.value); setFacetCol(facetColumn); }}
                >
                  <option value="">All</option>
                  {facetOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="library-noresults">No items match these filters.</div>
          ) : (
            <ul className="library-grid">
              {filtered.map((it) => (
                <LibraryCard key={it.slug} lib={lib} item={it} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// A generic library card: title + status badge + a few axis chips + tags. The
// whole card links to the item's large detail view (§11.4(d)).
function LibraryCard({ lib, item }: { lib: string; item: LibraryItem }) {
  const axisChips = useMemo(() => {
    const chips: string[] = [];
    for (const [k, v] of Object.entries(item)) {
      if (NON_AXIS.has(k)) continue;
      const s = scalarText(v as LibraryItem[string]);
      if (s) chips.push(s);
      if (chips.length >= 3) break;
    }
    return chips;
  }, [item]);

  return (
    <li className="lib-card-li">
      <a className="lib-card lib-card--link" href={hrefFor({ name: 'library', lib, item: item.slug })}>
        <div className="lib-card-head">
          <span className="lib-card-title">{item.title || item.slug}</span>
          {item.status && <span className="lib-badge">{item.status}</span>}
        </div>
        {axisChips.length > 0 && (
          <div className="lib-meta">
            {axisChips.map((c, i) => (
              <span key={i} className="lib-meta-item">{c}</span>
            ))}
          </div>
        )}
        {item.tags && item.tags.length > 0 && (
          <ul className="lib-tags">
            {item.tags.slice(0, 4).map((t) => (
              <li key={t} className="lib-tag">#{t}</li>
            ))}
          </ul>
        )}
      </a>
    </li>
  );
}

// =============================================================================
// (3) DETAIL — LARGE (item as a note/detail page)
// =============================================================================
function LibraryItemView({ lib, itemSlug }: { lib: string; itemSlug: string }) {
  const { data, loading, error } = useFetch<LibraryItemResponse>(
    `/api/cockpit/library/${encodeURIComponent(lib)}/item/${encodeURIComponent(itemSlug)}`,
  );
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, [lib, itemSlug]);

  if (loading) return <ViewSkeleton />;
  if (error) return <div role="alert" className="view-error">Could not load this item: {error}</div>;
  if (!data || !data.found || !data.item) {
    return (
      <div className="note-view">
        <a className="back-button" href={hrefFor({ name: 'library', lib })}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
        </a>
        <p className="note-empty">No item found for <span className="font-mono">{itemSlug}</span>.</p>
      </div>
    );
  }

  const item: LibraryItemDetail = data.item;
  const header = data.library;
  const typeLabel = header?.navLabel || lib;
  const body = typeof item.body === 'string' ? item.body : '';

  // The structured header fields (typed axis columns) for the meta panel — every
  // non-axis-excluded scalar column the row carries, in row order.
  const metaRows = useMemo(() => {
    const rows: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(item)) {
      if (k === 'body' || k === 'raw_frontmatter' || k === 'id' || k === 'slug' || k === 'file_path' || k === 'title') continue;
      if (Array.isArray(v)) {
        if (v.length) rows.push([humanLabel(k), v.join(', ')]);
        continue;
      }
      const s = scalarText(v as LibraryItem[string]);
      if (s) rows.push([humanLabel(k), s]);
    }
    return rows;
  }, [item]);

  return (
    <article ref={topRef} className="note-view library-item-view animate-fade-rise">
      <a className="back-button" href={hrefFor({ name: 'library', lib })}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back to {typeLabel}
      </a>

      <header className="note-header">
        <div className="note-header-row">
          <span className="note-type-pill">{typeLabel}</span>
          {item.status && <span className="lib-badge">{item.status}</span>}
        </div>
        <h1 className="note-title">{item.title || item.slug}</h1>
      </header>

      <div className="note-grid">
        <div className="note-body-col">
          {body.trim() ? (
            <WikiMarkdown body={body} />
          ) : (
            <p className="note-empty">This item has no detail text yet.</p>
          )}
          {/* Connections canvas, same as the note view. Library items are real
              notes in the graph (their body wikilinks are `links` edges), so this
              shows the item's neighbourhood; it self-hides when there is none. */}
          <MiniGraph focusType={header?.docType ? mapDocTypeToGraphType(header.docType) : 'topics'} slug={item.slug} />
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
            {item.file_path && <p className="side-filepath font-mono">{item.file_path}</p>}
          </section>
        </aside>
      </div>
    </article>
  );
}

// A library mirror table is not one of the 10 entity tables, so the graph
// neighbourhood endpoint won't have a node under the library slug. The item's
// own slug DOES appear as a `links` target/source though; we query under a best-
// guess entity type. The endpoint returns {found:false} for a miss and MiniGraph
// renders nothing, so an unmatched type is harmless (never an error).
function mapDocTypeToGraphType(_docType: string): string {
  return 'topics';
}

// =============================================================================
// Router shell — picks the sub-view from the current route.
// =============================================================================
export function LibraryView() {
  const route = useRoute();
  if (route.name !== 'library') return null; // defensive; App only mounts on 'library'
  if (route.lib && route.item) return <LibraryItemView lib={route.lib} itemSlug={route.item} />;
  if (route.lib) return <LibraryGrid lib={route.lib} />;
  return <LibraryPicker />;
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
