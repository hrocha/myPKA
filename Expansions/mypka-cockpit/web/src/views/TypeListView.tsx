// TypeListView.tsx — browse one entity type (Menschen, Themen, Projekte, ...).
// Each row opens the universal note viewer. Documents/deliverables are large
// (1028 / 399) so the list is capped server-side; a count line stays honest.
//
// item-7 — the rows became a clean columnar list with per-entity detail columns
// + an instant client-side filter at the top.
//
// item-5 — that columnar list is now a PROPER DATA TABLE:
//   • A real <table> with click-to-sort column headers (WAI-ARIA APG pattern:
//     each sortable <th scope="col"> wraps a <button>; the active header carries
//     aria-sort="ascending|descending"; a chevron mirrors the state). Sort is
//     client-side over the already-loaded rows (instant, no round-trip). Default
//     sort = name/title asc. Clicking a header toggles asc⇄desc; clicking a
//     different header re-sorts by it (asc).
//   • Social / website chips (DATA-CONTRACT §15): people + organizations carry a
//     `socialLinks` JSON string → parsed to {label,url}[] and rendered as
//     clickable chips (favicon + label, open in a new tab, rel="noopener
//     noreferrer"). Other types simply have no chip column.
//   • Mobile-first: below 640px the table collapses to a STACKED CARD per row
//     (label: value), each card a single tappable target with ≥44px touch
//     height; the column headers become a compact sort-control bar (each control
//     ≥24px). Above 640px the full table renders. Same sort state drives both.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ChevronRight, ChevronUp, ChevronDown, ChevronsUpDown, ExternalLink,
  Users, Hash, FolderKanban, KeyRound, Repeat2, Target,
  Building2, FileText, Package, NotebookPen, Search,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { navigate, type Route } from '../lib/router';
import type { TypeListResponse, TypeListItem, EntityType, SocialLink } from '../lib/cockpitTypes';
import { PageHeader } from '../components/PageHeader';

// Entity-type → Lucide glyph (mirrors the sidebar TYPE_ICON map) so each list
// page carries the same brass icon beside its title as its nav row.
const TYPE_ICON: Record<EntityType, LucideIcon> = {
  journal: NotebookPen,
  people: Users,
  topics: Hash,
  projects: FolderKanban,
  key_elements: KeyRound,
  habits: Repeat2,
  goals: Target,
  organizations: Building2,
  documents: FileText,
  deliverables: Package,
};

// Human header label for each server column alias (server sends aliases only;
// the client owns the display text — strings.ts is chrome-only, but these are a
// thin presentation layer over the data vocabulary, so they live beside the view).
const COLUMN_LABEL: Record<string, string> = {
  relation: 'Relationship',
  org_type: 'Type',
  key_element: 'Key element',
  status: 'Status',
  description: 'Description',
  cadence: 'Cadence',
  started_on: 'Started',
  doc_type: 'Doc type',
  category: 'Category',
};

function columnLabel(alias: string): string {
  return COLUMN_LABEL[alias] ?? alias.replace(/_/g, ' ');
}

// Normalise a cell value to a display string ('' for empty/null).
function cellText(v: string | number | null | undefined): string {
  if (v == null) return '';
  return String(v);
}

// ---------------------------------------------------------------------------
// Sort model. A sort key is either the synthetic 'name' (title, then slug) or a
// column alias. Direction is asc | desc. Sorting is client-side over the loaded
// rows and is locale-aware + numeric-aware (Intl.Collator with numeric:true so
// "Item 2" sorts before "Item 10"); empty cells always sink to the bottom.
// ---------------------------------------------------------------------------
type SortDir = 'asc' | 'desc';
interface SortState { key: string; dir: SortDir }
const NAME_KEY = 'name';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function rowName(it: TypeListItem): string {
  return (it.title || it.slug || '').trim();
}

function sortValue(it: TypeListItem, key: string): string {
  if (key === NAME_KEY) return rowName(it);
  return cellText(it.cols?.[key]).trim();
}

// Parse + validate the §15 socialLinks JSON string into a clean SocialLink[].
// Defensive: never trust the wire shape — drop anything missing a string url.
function parseSocialLinks(raw: string | null | undefined): SocialLink[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): SocialLink[] => {
      if (!entry || typeof entry !== 'object') return [];
      const o = entry as Record<string, unknown>;
      const url = typeof o.url === 'string' ? o.url.trim() : '';
      if (!url) return [];
      const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : url;
      return [{ label, url }];
    });
  } catch {
    return [];
  }
}

// A favicon for the chip when the url has a real host. Bare handles / mailto /
// hostless strings get no favicon (the label carries the chip on its own).
function faviconFor(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=32`;
  } catch {
    return null;
  }
}

function SocialChips({ links }: { links: SocialLink[] }) {
  if (links.length === 0) return null;
  return (
    <span className="social-chips">
      {links.map((lnk, i) => {
        const fav = faviconFor(lnk.url);
        return (
          <a
            key={`${lnk.url}-${i}`}
            className="social-chip"
            href={lnk.url}
            target="_blank"
            rel="noopener noreferrer"
            // Stop the row/card open handler from firing when the chip is tapped.
            onClick={(e) => e.stopPropagation()}
            title={`${lnk.label} — opens in a new tab`}
          >
            {fav ? (
              <img className="social-chip-favicon" src={fav} alt="" width={14} height={14} loading="lazy" />
            ) : (
              <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" className="social-chip-glyph" />
            )}
            <span className="social-chip-label">{lnk.label}</span>
          </a>
        );
      })}
    </span>
  );
}

export function TypeListView({ route }: { route: Extract<Route, { name: 'type' }> }) {
  const { data, loading, error } = useFetch<TypeListResponse>(
    `/api/cockpit/type/${encodeURIComponent(route.type)}?limit=300`
  );
  const topRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ key: NAME_KEY, dir: 'asc' });

  // Reset filter + sort when switching entity type (the same component instance
  // is reused across #/type/* routes).
  useEffect(() => {
    setQuery('');
    setSort({ key: NAME_KEY, dir: 'asc' });
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [route.type]);

  const columns = data?.columns ?? [];

  // Does any loaded row carry social chips? (people/orgs with §15 data). Drives
  // whether the social column / card row renders at all.
  const hasSocial = useMemo(
    () => (data?.items ?? []).some((it) => parseSocialLinks(it.socialLinks).length > 0),
    [data]
  );

  // Instant client-side filter over the loaded rows: name + subtitle + every
  // visible column value + social-link labels. Case-insensitive substring.
  const filtered = useMemo<TypeListItem[]>(() => {
    const items = data?.items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay: string[] = [it.title ?? '', it.slug, it.subtitle ?? ''];
      if (it.cols) for (const alias of columns) hay.push(cellText(it.cols[alias]));
      for (const lnk of parseSocialLinks(it.socialLinks)) hay.push(lnk.label, lnk.url);
      return hay.some((s) => s.toLowerCase().includes(q));
    });
  }, [data, query, columns]);

  // Client-side sort over the filtered rows. Stable; empty cells sink last.
  const sorted = useMemo<TypeListItem[]>(() => {
    const rows = [...filtered];
    const { key, dir } = sort;
    const sign = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (!av && !bv) return collator.compare(rowName(a), rowName(b)); // tie → by name
      if (!av) return 1;   // empties always sink, regardless of direction
      if (!bv) return -1;
      const cmp = collator.compare(av, bv);
      return cmp !== 0 ? cmp * sign : collator.compare(rowName(a), rowName(b));
    });
    return rows;
  }, [filtered, sort]);

  const onSort = useCallback((key: string) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );
  }, []);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">Could not load the list: {error}</div>;
  if (!data) return null;

  const total = data.total;
  const loaded = data.items.length;
  const showing = sorted.length;
  const hasFilter = query.trim().length > 0;

  // Ordered sort keys: Name first, then each detail column. (Social chips are not
  // sortable — they're a cluster of links, not an orderable scalar.)
  const sortKeys: { key: string; label: string }[] = [
    { key: NAME_KEY, label: 'Name' },
    ...columns.map((alias) => ({ key: alias, label: columnLabel(alias) })),
  ];

  return (
    <section ref={topRef} className="type-list animate-fade-rise" aria-labelledby="type-list-title">
      <PageHeader
        id="type-list-title"
        title={data.label}
        icon={TYPE_ICON[data.type as EntityType]}
        subtitle={
          hasFilter
            ? `${showing} of ${loaded} shown`
            : `${total} ${total === 1 ? 'entry' : 'entries'}` +
              (loaded < total ? ` · ${loaded} loaded` : '')
        }
      />

      {/* Instant filter — quiet, top-of-list. Reuses the shared .filter-search-*
          tokens (no new colours/sizes). */}
      {loaded > 0 && (
        <div className="type-list-toolbar">
          <div className="filter-search">
            <Search size={15} strokeWidth={1.5} aria-hidden="true" className="filter-search-icon" />
            <input
              type="search"
              className="filter-search-input"
              placeholder={`Filter ${data.label.toLowerCase()}…`}
              aria-label={`Filter ${data.label}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {loaded === 0 ? (
        <div className="type-list-empty">Nothing here yet.</div>
      ) : showing === 0 ? (
        <div className="type-list-empty">
          No {data.label.toLowerCase()} match “{query.trim()}”.
        </div>
      ) : (
        <>
          {/* MOBILE (≤640px): a compact sort-control bar. Hidden ≥641px where the
              real table headers take over. ≥24px touch targets per control. */}
          <div className="type-table-sortbar" role="group" aria-label="Sort by">
            <span className="type-table-sortbar-label">Sort</span>
            {sortKeys.map(({ key, label }) => {
              const active = sort.key === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`sort-pill${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => onSort(key)}
                >
                  <span>{label}</span>
                  <SortGlyph active={active} dir={sort.dir} />
                </button>
              );
            })}
          </div>

          {/* DESKTOP table + MOBILE stacked cards share one <table>. CSS swaps the
              presentation at the 640px breakpoint (table-row ↔ card). */}
          <div className="type-table-wrap">
            <table className="type-table">
              <caption className="sr-only">
                {data.label} — sortable. Activate a column header to sort.
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="th-name"
                    aria-sort={sort.key === NAME_KEY ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <SortHeaderButton
                      label="Name"
                      active={sort.key === NAME_KEY}
                      dir={sort.dir}
                      onClick={() => onSort(NAME_KEY)}
                    />
                  </th>
                  {columns.map((alias) => (
                    <th
                      key={alias}
                      scope="col"
                      className="th-col"
                      aria-sort={sort.key === alias ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <SortHeaderButton
                        label={columnLabel(alias)}
                        active={sort.key === alias}
                        dir={sort.dir}
                        onClick={() => onSort(alias)}
                      />
                    </th>
                  ))}
                  {hasSocial && <th scope="col" className="th-social">Links</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((it) => {
                  const links = parseSocialLinks(it.socialLinks);
                  return (
                    <tr
                      key={it.slug}
                      className="type-row"
                      tabIndex={0}
                      role="link"
                      aria-label={`Open ${it.title || it.slug}`}
                      onClick={() => navigate({ name: 'note', type: data.type as EntityType, slug: it.slug })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate({ name: 'note', type: data.type as EntityType, slug: it.slug });
                        }
                      }}
                    >
                      <td className="td-name" data-label="Name">
                        <span className="td-name-main">
                          <span className="row-title">{it.title || it.slug}</span>
                          {it.subtitle && <span className="row-sub">{it.subtitle}</span>}
                        </span>
                        {it.date && <span className="row-date">{formatDate(it.date)}</span>}
                        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="row-chevron" />
                      </td>
                      {columns.map((alias) => {
                        const val = cellText(it.cols?.[alias]);
                        return (
                          <td key={alias} className="td-col" data-label={columnLabel(alias)}>
                            {val ? <span className="td-col-value">{val}</span> : <span className="td-empty" aria-hidden="true">—</span>}
                          </td>
                        );
                      })}
                      {hasSocial && (
                        <td className="td-social" data-label="Links">
                          {links.length > 0 ? <SocialChips links={links} /> : <span className="td-empty" aria-hidden="true">—</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// A sort indicator glyph: neutral (both arrows) when this key is not the active
// sort; up/down when it is. aria-hidden — the <th aria-sort> is the SR source.
function SortGlyph({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown size={13} strokeWidth={1.5} aria-hidden="true" className="sort-glyph is-idle" />;
  return dir === 'asc'
    ? <ChevronUp size={13} strokeWidth={2} aria-hidden="true" className="sort-glyph" />
    : <ChevronDown size={13} strokeWidth={2} aria-hidden="true" className="sort-glyph" />;
}

// The clickable/keyboard-focusable header control inside each <th>. The <th>
// owns aria-sort; this button just toggles. Accessible name = the column label.
function SortHeaderButton({
  label, active, dir, onClick,
}: { label: string; active: boolean; dir: SortDir; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`sort-header${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <SortGlyph active={active} dir={dir} />
    </button>
  );
}

function formatDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}
