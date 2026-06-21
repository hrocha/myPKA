// WorkbenchListView.tsx — the Fleeting-Notes home ("thoughts dashboard").
//
// Capture-first: NewNoteAffordance sits on top (dropping a sticky), then the
// whiteboards strip (open / create canvases), then the notes themselves as
// sticky-styled cards — pinned WIP first, the rest after. Each card exposes a
// hover/focus action row (pin toggle, status cycle, color swatches) that writes
// through PATCH /api/cockpit/notes/:slug/meta with an optimistic local update.
//
// Visual language mirrors hub.css (sticky tints via color-mix over surface,
// dotted-grid board cards, --concept-* area hues) but lives in fleeting.css
// under the `fn-` prefix so the two views stay independently editable.
//
// Data: GET /api/cockpit/notes  -> { ok, docs: FleetingDoc[] } (pinned first)
//       GET /api/cockpit/boards -> { boards: BoardSummary[] }
import { useCallback, useEffect, useRef, useState } from 'react';
import { Map as MapIcon, Pin, Plus, StickyNote, X } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { hrefFor, navigate } from '../lib/router';
import {
  createBoard,
  patchNoteMeta,
  deleteFleetingNote,
  type BoardArea,
  type BoardSummary,
  type FleetingDoc,
} from '../lib/fleeting';
import { NewNoteAffordance } from '../components/workbench/NewNoteAffordance';
import { NoteStickyCard, type NoteMetaPatch } from '../components/fleeting/NoteStickyCard';
import { PageHeader } from '../components/PageHeader';
import './fleeting.css';

interface NotesResponse { ok: boolean; docs: FleetingDoc[] }
interface BoardsResponse { boards: BoardSummary[] }

const AREA_CONCEPT: Record<string, string> = {
  projects: 'project',
  key_elements: 'key-element',
  topics: 'topic',
  goals: 'goal',
  habits: 'habit',
};

const AREA_OPTIONS: { value: '' | NonNullable<BoardArea>; label: string }[] = [
  { value: '', label: 'No area' },
  { value: 'projects', label: 'Projects' },
  { value: 'key_elements', label: 'Key Elements' },
  { value: 'topics', label: 'Topics' },
  { value: 'goals', label: 'Goals' },
  { value: 'habits', label: 'Habits' },
];

export function WorkbenchListView() {
  const { data, loading, error } = useFetch<NotesResponse>('/api/cockpit/notes');
  const { data: boardsData } = useFetch<BoardsResponse>('/api/cockpit/boards');

  // Local working copy of the docs so meta patches apply optimistically.
  const [docs, setDocs] = useState<FleetingDoc[] | null>(null);
  const docsRef = useRef<FleetingDoc[] | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // slug currently being deleted (drives the per-card "Deleting…" state).
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  useEffect(() => {
    if (data?.docs) setDocs(data.docs);
  }, [data]);
  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);

  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const applyPatch = useCallback(async (slug: string, patch: NoteMetaPatch) => {
    const prev = docsRef.current;
    setNotice(null);
    setDocs((cur) => (cur ? cur.map((d) => (d.slug === slug ? { ...d, ...patch } : d)) : cur));
    const res = await patchNoteMeta(slug, patch);
    if (res.kind === 'ok') return;
    setDocs(prev); // revert the optimistic update
    if (res.kind === 'disabled') {
      setReadOnly(true);
    } else if (res.kind === 'auth') {
      setNotice('Session expired — please sign in again.');
    } else {
      setNotice('That change could not be saved — please retry.');
    }
  }, []);

  const removeNote = useCallback(async (slug: string) => {
    setNotice(null);
    setDeletingSlug(slug);
    const res = await deleteFleetingNote(slug);
    setDeletingSlug(null);
    if (res.kind === 'ok' || res.kind === 'not-found') {
      // 'not-found' means it's already gone — treat both as "remove from list".
      setDocs((cur) => (cur ? cur.filter((d) => d.slug !== slug) : cur));
      return;
    }
    if (res.kind === 'disabled') {
      setReadOnly(true);
    } else if (res.kind === 'auth') {
      setNotice('Session expired — please sign in again.');
    } else {
      setNotice('That note could not be deleted — please retry.');
    }
  }, []);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">Could not load Fleeting Notes: {error}</div>;
  if (!docs) return null;

  const boards = boardsData?.boards ?? [];
  const pinned = docs.filter((d) => d.pinned);
  const rest = docs.filter((d) => !d.pinned);

  return (
    <section ref={topRef} className="type-list animate-fade-rise">
      <PageHeader
        title="Fleeting Notes"
        icon={StickyNote}
        subtitle={
          docs.length === 0
            ? 'Capture thoughts now — work them out later'
            : `${docs.length} ${docs.length === 1 ? 'note' : 'notes'}`
        }
        action={<NewNoteAffordance />}
      />

      {readOnly && (
        <p className="fn-banner" role="status">
          Read-only — saving is disabled right now, so pins, statuses and colors can't change yet.
        </p>
      )}
      {notice && <p className="fn-banner fn-banner--error" role="alert">{notice}</p>}

      {/* ---- Whiteboards strip ------------------------------------------- */}
      <section className="fn-section" aria-labelledby="fn-boards-title">
        <h2 className="fn-section-title" id="fn-boards-title">
          <MapIcon size={15} strokeWidth={1.5} aria-hidden="true" />
          Whiteboards
        </h2>
        <div className="fn-boards" role="list">
          {boards.map((b) => <BoardCard key={b.slug} board={b} />)}
          <NewBoardAffordance disabled={readOnly} onDisabled={() => setReadOnly(true)} />
        </div>
      </section>

      {/* ---- Notes -------------------------------------------------------- */}
      {docs.length === 0 ? (
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <StickyNote size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">No fleeting notes yet</p>
          <p className="library-empty-sub">
            Drop a thought with <strong>New note</strong> above — that's a <em>capture</em>.
            Pin the ones you keep expanding and mark them <em>working</em>; when a note is
            done incubating, set it <em>ready</em> and your team picks it up and integrates
            it into the PKM.
          </p>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="fn-section" aria-labelledby="fn-pinned-title">
              <h2 className="fn-section-title" id="fn-pinned-title">
                <Pin size={15} strokeWidth={1.5} aria-hidden="true" />
                Pinned
              </h2>
              <div className="fn-grid" role="list">
                {pinned.map((n) => (
                  <NoteStickyCard
                    key={n.slug}
                    note={n}
                    disabled={readOnly}
                    onPatch={applyPatch}
                    onDelete={removeNote}
                    deleting={deletingSlug === n.slug}
                  />
                ))}
              </div>
            </section>
          )}
          <section className="fn-section" aria-labelledby="fn-notes-title">
            <h2 className="fn-section-title" id="fn-notes-title">
              <StickyNote size={15} strokeWidth={1.5} aria-hidden="true" />
              {pinned.length > 0 ? 'Everything else' : 'Notes'}
            </h2>
            {rest.length === 0 ? (
              <p className="fn-empty">Everything is pinned — nothing else lying around.</p>
            ) : (
              <div className="fn-grid" role="list">
                {rest.map((n) => (
                  <NoteStickyCard
                    key={n.slug}
                    note={n}
                    disabled={readOnly}
                    onPatch={applyPatch}
                    onDelete={removeNote}
                    deleting={deletingSlug === n.slug}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function BoardCard({ board }: { board: BoardSummary }) {
  const concept = board.area ? AREA_CONCEPT[board.area] : undefined;
  return (
    <a
      role="listitem"
      className="fn-board"
      data-concept={concept}
      href={hrefFor({ name: 'board', slug: board.slug })}
    >
      <span className="fn-board-name">{board.name}</span>
      <span className="fn-board-meta">{board.noteCount} {board.noteCount === 1 ? 'card' : 'cards'}</span>
    </a>
  );
}

type BoardPhase =
  | { kind: 'closed' }
  | { kind: 'naming' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string };

// "New whiteboard" — a board-shaped card that flips into an inline name + area
// form (no browser dialogs). POST /api/cockpit/boards → navigate to the board.
function NewBoardAffordance({ disabled, onDisabled }: { disabled: boolean; onDisabled: () => void }) {
  const [phase, setPhase] = useState<BoardPhase>({ kind: 'closed' });
  const [name, setName] = useState('');
  const [area, setArea] = useState<'' | NonNullable<BoardArea>>('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (phase.kind === 'naming') inputRef.current?.focus();
  }, [phase.kind]);

  const close = () => {
    setPhase({ kind: 'closed' });
    setName('');
    setArea('');
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { close(); return; }
    setPhase({ kind: 'submitting' });
    const res = await createBoard(trimmed, area === '' ? null : area);
    switch (res.kind) {
      case 'ok':
        navigate({ name: 'board', slug: res.data.slug });
        break;
      case 'disabled':
        onDisabled();
        close();
        break;
      case 'conflict':
        setPhase({ kind: 'error', message: 'A whiteboard with that name already exists.' });
        break;
      case 'auth':
        setPhase({ kind: 'error', message: 'Session expired — please sign in again.' });
        break;
      default:
        setPhase({ kind: 'error', message: 'Could not create the whiteboard.' });
    }
  };

  if (disabled) return null;

  if (phase.kind === 'closed') {
    return (
      <button type="button" role="listitem" className="fn-board fn-board--new" onClick={() => setPhase({ kind: 'naming' })}>
        <span className="fn-board-name">
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          New whiteboard
        </span>
        <span className="fn-board-meta">A canvas for your stickies</span>
      </button>
    );
  }

  return (
    <div role="listitem" className="fn-board fn-board--form">
      <div className="fn-board-form-row">
        <input
          ref={inputRef}
          type="text"
          className="fn-board-input"
          placeholder="Name this whiteboard…"
          aria-label="New whiteboard name"
          value={name}
          disabled={phase.kind === 'submitting'}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
        />
        <button
          type="button"
          className="fn-board-cancel"
          aria-label="Cancel new whiteboard"
          onClick={close}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="fn-board-form-row">
        <select
          className="fn-board-select"
          aria-label="Whiteboard area"
          value={area}
          disabled={phase.kind === 'submitting'}
          onChange={(e) => setArea(e.target.value as '' | NonNullable<BoardArea>)}
        >
          {AREA_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="fn-board-create"
          disabled={phase.kind === 'submitting' || !name.trim()}
          onClick={() => void submit()}
        >
          {phase.kind === 'submitting' ? 'Creating…' : 'Create'}
        </button>
      </div>
      {phase.kind === 'error' && <p className="fn-board-error" role="alert">{phase.message}</p>}
    </div>
  );
}
