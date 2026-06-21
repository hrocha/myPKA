// HubView.tsx — the cockpit's landing dashboard ("the Hub").
//
// Represents the My Life concept as the front door: the bucket cards (Projects /
// Key Elements / Topics, with Goals + Habits as the compact second row) carry
// the user's note + whiteboard counts and tint from the sanctioned GL-003
// concept palette (--concept-*). Below them: the Fleeting-Notes working state —
// pinned WIP stickies, the ready-for-team signal row, whiteboards, and the
// latest journal entries. One fetch (/api/cockpit/hub), pure read.
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, CalendarDays, FileText, FolderKanban, Hash, KeyRound, ListTodo, NotebookPen, Pin, Repeat2, Send, StickyNote, Target, Map as MapIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { navigate, hrefFor } from '../lib/router';
import type { HubData, FleetingDoc, BoardSummary } from '../lib/fleeting';
import type { AgendaData } from '../lib/connectors';
import type { DocumentRow, DocumentsResponse } from './DocumentsView';
import type { CockpitSettingsResponse } from '../lib/cockpitExtras';
import { MODULE_KEYS } from '../lib/cockpitExtras';
import { HubSection } from './hub/HubSection';
import { OpenInvoicesCard } from './hub/OpenInvoicesCard';
import { RecentlyScannedCard } from './hub/RecentlyScannedCard';
import { RandomQuoteCard } from './hub/RandomQuoteCard';
import { OnThisDayCard } from './hub/OnThisDayCard';
import './hub.css';

// The three hero buckets (mirrors the draft: My Projects / Key Elements / My
// Topics) + the two compact ones. `concept` keys into the --concept-* tokens.
const HERO_AREAS: { type: string; label: string; icon: LucideIcon; concept: string }[] = [
  { type: 'projects', label: 'My Projects', icon: FolderKanban, concept: 'project' },
  { type: 'key_elements', label: 'Key Elements', icon: KeyRound, concept: 'key-element' },
  { type: 'topics', label: 'My Topics', icon: Hash, concept: 'topic' },
];
const SUB_AREAS: { type: string; label: string; icon: LucideIcon; concept: string }[] = [
  { type: 'goals', label: 'My Goals', icon: Target, concept: 'goal' },
  { type: 'habits', label: 'My Habits', icon: Repeat2, concept: 'habit' },
];

function countFor(data: HubData, type: string): number {
  return data.types.find((t) => t.type === type)?.count ?? 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Render the My Life bucket cards (the three hero tiles + two compact ones).
function BucketsModule({ data }: { data: HubData }) {
  return (
    <>
      <div className="hub-areas" role="list">
        {HERO_AREAS.map(({ type, label, icon: Icon, concept }) => (
          <a
            key={type}
            role="listitem"
            className="hub-area"
            data-concept={concept}
            href={hrefFor({ name: 'type', type })}
          >
            <span className="hub-area-glyph"><Icon size={22} strokeWidth={1.5} aria-hidden="true" /></span>
            <span className="hub-area-name">{label}</span>
            <span className="hub-area-meta">
              {plural(countFor(data, type), 'note', 'notes')}
              {' · '}
              {plural(data.boardsByArea[type] ?? 0, 'whiteboard', 'whiteboards')}
            </span>
            <ArrowRight className="hub-area-arrow" size={16} strokeWidth={1.5} aria-hidden="true" />
          </a>
        ))}
      </div>
      <div className="hub-areas hub-areas--sub" role="list">
        {SUB_AREAS.map(({ type, label, icon: Icon, concept }) => (
          <a
            key={type}
            role="listitem"
            className="hub-area hub-area--sub"
            data-concept={concept}
            href={hrefFor({ name: 'type', type })}
          >
            <span className="hub-area-glyph"><Icon size={18} strokeWidth={1.5} aria-hidden="true" /></span>
            <span className="hub-area-name">{label}</span>
            <span className="hub-area-meta">
              {plural(countFor(data, type), 'note', 'notes')}
              {' · '}
              {plural(data.boardsByArea[type] ?? 0, 'board', 'boards')}
            </span>
          </a>
        ))}
      </div>
    </>
  );
}

// Pinned WIP stickies + the "ready for the team" signal row (both gate on the
// `pinned` module key, exactly as before).
function PinnedModule({ data }: { data: HubData }) {
  return (
    <>
      <HubSection
        icon={Pin}
        title="Pinned"
        hint="Work-in-progress notes you keep coming back to"
        action={{ label: 'All fleeting notes', onClick: () => navigate({ name: 'notes' }) }}
      >
        {data.notes.pinned.length === 0 ? (
          <p className="hub-empty">
            Nothing pinned yet. Pin a fleeting note to keep it on the hub —
            ideal for documents you expand a little every day.
          </p>
        ) : (
          <div className="hub-stickies" role="list">
            {data.notes.pinned.map((n) => <StickyCard key={n.slug} note={n} />)}
          </div>
        )}
      </HubSection>

      {data.notes.ready.length > 0 && (
        <HubSection
          icon={Send}
          title="Ready for the team"
          hint="Marked ready — your agents can pick these up and integrate them into the PKM"
        >
          <div className="hub-stickies" role="list">
            {data.notes.ready.map((n) => <StickyCard key={n.slug} note={n} ready />)}
          </div>
        </HubSection>
      )}
    </>
  );
}

function WhiteboardsModule({ data }: { data: HubData }) {
  return (
    <HubSection
      icon={MapIcon}
      title="Whiteboards"
      hint="Spatial canvases for deep thinking"
      action={{ label: 'Manage', onClick: () => navigate({ name: 'notes' }) }}
    >
      {data.boards.length === 0 ? (
        <p className="hub-empty">
          No whiteboards yet. Create one from Fleeting Notes and arrange your
          stickies on a canvas.
        </p>
      ) : (
        <div className="hub-boards" role="list">
          {data.boards.map((b) => <BoardCard key={b.slug} board={b} />)}
        </div>
      )}
    </HubSection>
  );
}

function LatestJournalModule({ data }: { data: HubData }) {
  return (
    <HubSection
      icon={NotebookPen}
      title="Latest journal"
      action={{ label: 'Journal', onClick: () => navigate({ name: 'journal' }) }}
    >
      {data.recentJournal.length === 0 ? (
        <p className="hub-empty">No journal entries yet.</p>
      ) : (
        <ul className="hub-journal">
          {data.recentJournal.slice(0, 3).map((j) => (
            <li key={j.slug}>
              <a href={hrefFor({ name: 'note', type: 'journal', slug: j.slug })} className="hub-journal-row">
                <span className="hub-journal-date">{j.date ?? ''}</span>
                <span className="hub-journal-title">{j.title}</span>
                {j.mood && <span className="hub-journal-mood">{j.mood}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </HubSection>
  );
}

// Default render sequence — used when settings/order haven't loaded yet, or the
// server is older than this build (no `order` in the response). Mirrors the
// historical hardcoded order so behaviour is unchanged without a saved order.
const DEFAULT_MODULE_ORDER: string[] = [
  MODULE_KEYS.openInvoices,
  MODULE_KEYS.buckets,
  MODULE_KEYS.recentlyScanned,
  MODULE_KEYS.pinned,
  MODULE_KEYS.whiteboards,
  MODULE_KEYS.latestDocuments,
  MODULE_KEYS.latestJournal,
  MODULE_KEYS.randomQuote,
  MODULE_KEYS.onThisDay,
];

export function HubView() {
  const { data, loading, error } = useFetch<HubData>('/api/cockpit/hub');
  // Runtime module toggles + saved order (Settings page). A missing response or
  // missing key defaults to ON / catalogue order — the Hub never hides or
  // mis-orders a section just because prefs haven't loaded yet or the server is
  // older than this build.
  const { data: settings } = useFetch<CockpitSettingsResponse>('/api/cockpit/settings');
  const on = (key: string): boolean => settings?.modules?.[key] ?? true;

  if (loading) {
    return (
      <div className="list-skeleton" aria-busy="true">
        <div className="skeleton-block" />
      </div>
    );
  }
  if (error || !data) {
    return <p className="view-error">The hub could not load. {error || ''}</p>;
  }

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  // Each toggleable Hub module → its renderer. Driven by the saved `order` from
  // Settings so a reorder there re-renders the Hub in the new sequence. Any key
  // in `order` not present here (e.g. a future server-only module) is skipped.
  const renderers: Record<string, () => ReactNode> = {
    [MODULE_KEYS.openInvoices]: () => <OpenInvoicesCard />,
    [MODULE_KEYS.buckets]: () => <BucketsModule data={data} />,
    [MODULE_KEYS.recentlyScanned]: () => <RecentlyScannedCard />,
    [MODULE_KEYS.pinned]: () => <PinnedModule data={data} />,
    [MODULE_KEYS.whiteboards]: () => <WhiteboardsModule data={data} />,
    [MODULE_KEYS.latestDocuments]: () => <LatestDocumentsSection />,
    [MODULE_KEYS.latestJournal]: () => <LatestJournalModule data={data} />,
    [MODULE_KEYS.randomQuote]: () => <RandomQuoteCard />,
    [MODULE_KEYS.onThisDay]: () => <OnThisDayCard />,
  };

  // Saved order from the server, falling back to the historical default. Append
  // any known renderer the order omits (older server / new build) so nothing
  // silently vanishes from the Hub.
  const savedOrder = settings?.order ?? DEFAULT_MODULE_ORDER;
  const orderedKeys = [
    ...savedOrder.filter((k) => k in renderers),
    ...DEFAULT_MODULE_ORDER.filter((k) => !savedOrder.includes(k) && k in renderers),
  ];

  return (
    <div className="hub">
      <header className="hub-head">
        <p className="hub-date">{today}</p>
        <h1 className="hub-title">My Life</h1>
      </header>

      <TodaySection />

      {orderedKeys.map((key) =>
        on(key) ? <Fragment key={key}>{renderers[key]()}</Fragment> : null,
      )}
    </div>
  );
}

// ---- Latest documents: the 6 newest document notes as compact PDF cards ------
// Own fetch (the hub endpoint predates the documents API); the server returns
// items newest-first (frontmatter date desc, undated last by file order), so a
// plain slice(0, 6) is the contract. Renders nothing while loading/failing —
// the hub stays calm without it.
function LatestDocumentsSection() {
  const { data } = useFetch<DocumentsResponse>('/api/cockpit/documents');
  if (!data) return null;

  return (
    <HubSection
      icon={FileText}
      title="Latest documents"
      hint="Document notes with their PDFs, freshest first"
      action={{ label: 'All documents', onClick: () => navigate({ name: 'type', type: 'documents' }) }}
    >
      {data.items.length === 0 ? (
        <p className="hub-empty">No documents in the mirror yet.</p>
      ) : (
        <div className="hub-docs" role="list">
          {data.items.slice(0, 6).map((d) => <HubDocCard key={d.slug} doc={d} />)}
        </div>
      )}
    </HubSection>
  );
}

function HubDocCard({ doc }: { doc: DocumentRow }) {
  return (
    <button
      type="button"
      role="listitem"
      className="hub-doc"
      onClick={() => navigate({ name: 'note', type: 'documents', slug: doc.slug })}
    >
      <span className="hub-doc-glyph" aria-hidden="true">
        <FileText size={15} strokeWidth={1.5} />
      </span>
      <span className="hub-doc-title">{doc.title}</span>
      <span className="hub-doc-meta">
        {doc.doc_type && <em className="hub-doc-chip">{doc.doc_type}</em>}
        {doc.date && <span className="hub-doc-date">{doc.date}</span>}
        {!doc.pdfPath && <span className="hub-doc-nofile">no file</span>}
      </span>
    </button>
  );
}

// ---- Today: planned actions + calendar events (from the user's connectors) ----
function TodaySection() {
  const { data } = useFetch<AgendaData>('/api/cockpit/agenda');
  if (!data) return null;

  const anySource = data.sources.tasks.length > 0 || data.sources.calendar.length > 0;
  const planned = data.planned ?? [];
  const events = data.events ?? [];

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <section className="hub-today">
      <div className="hub-today-col">
        <h2 className="hub-section-title">
          <ListTodo size={15} strokeWidth={1.5} aria-hidden="true" />
          Today's actions
        </h2>
        {!anySource ? (
          <p className="hub-empty">
            No tools connected yet.{' '}
            <a className="hub-today-link" href={hrefFor({ name: 'connections' })}>
              Connect your task manager →
            </a>
          </p>
        ) : planned.length === 0 ? (
          <p className="hub-empty">
            Nothing planned for today yet.{' '}
            <a className="hub-today-link" href={hrefFor({ name: 'module', slug: 'actions' })}>
              Lay out your day in Actions &amp; Planning →
            </a>
          </p>
        ) : (
          <ul className="hub-today-list">
            {planned.map((p) => (
              <li key={`p-${p.source}-${p.id}`} className="hub-today-row">
                <span className="hub-today-dot hub-today-dot--planned" aria-hidden="true" />
                <span className="hub-today-text">{p.title ?? p.id}</span>
                <span className="hub-today-source">{p.source}</span>
                {p.url && <ExtLink url={p.url} label={`Open in ${p.source}`} />}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hub-today-col">
        <h2 className="hub-section-title">
          <CalendarDays size={15} strokeWidth={1.5} aria-hidden="true" />
          Today's calendar
        </h2>
        {data.sources.calendar.length === 0 ? (
          <p className="hub-empty">
            No calendar connected.{' '}
            <a className="hub-today-link" href={hrefFor({ name: 'connections' })}>
              Connect one →
            </a>
          </p>
        ) : events.length === 0 ? (
          <p className="hub-empty">No events today.</p>
        ) : (
          <ul className="hub-today-list">
            {events.map((e) => (
              <li key={e.uid} className="hub-today-row">
                <span className="hub-today-time">
                  {e.allDay ? 'all day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`}
                </span>
                <span className="hub-today-text">{e.title}</span>
                {e.location && <span className="hub-today-source">{e.location}</span>}
                {e.url && <ExtLink url={e.url} label="Open event" />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ExtLink({ url, label }: { url: string; label: string }) {
  return (
    <a className="hub-today-ext" href={url} target="_blank" rel="noreferrer noopener" aria-label={label} title={label}>
      <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" />
    </a>
  );
}

function StickyCard({ note, ready }: { note: FleetingDoc; ready?: boolean }) {
  const when = new Date(note.mtime).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <button
      type="button"
      role="listitem"
      className="hub-sticky"
      data-tint={note.color ?? 'paper'}
      onClick={() => navigate({ name: 'notes-doc', slug: note.slug })}
    >
      <span className="hub-sticky-glyph"><StickyNote size={14} strokeWidth={1.5} aria-hidden="true" /></span>
      <span className="hub-sticky-title">{note.title}</span>
      <span className="hub-sticky-meta">
        {when}
        {ready ? <em className="hub-sticky-ready">ready</em>
          : note.status === 'working' ? <em className="hub-sticky-working">working</em> : null}
      </span>
    </button>
  );
}

function BoardCard({ board }: { board: BoardSummary }) {
  const concept = board.area
    ? { projects: 'project', key_elements: 'key-element', topics: 'topic', goals: 'goal', habits: 'habit' }[board.area]
    : null;
  return (
    <a
      role="listitem"
      className="hub-board"
      data-concept={concept ?? undefined}
      href={hrefFor({ name: 'board', slug: board.slug })}
    >
      <span className="hub-board-name">{board.name}</span>
      <span className="hub-board-meta">{board.noteCount} {board.noteCount === 1 ? 'card' : 'cards'}</span>
    </a>
  );
}
