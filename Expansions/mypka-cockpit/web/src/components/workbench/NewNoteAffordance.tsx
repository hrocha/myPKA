// NewNoteAffordance.tsx — the "name the note" inline input that replaces the
// (previously disabled) New-note button on click (P2).
//
// Flow (plan §4): click → inline input → POST /api/cockpit/notes {title} →
//   201 → navigate to {name:'notes-doc', slug}
//   409 → "a note with that name exists" + an "Open it" affordance (the server
//         returns the colliding slug)
//   503 → calm "saving is disabled" state (write path dormant behind Vex gate)
// An inline input (not a modal) keeps it light; Escape cancels, Enter submits.
// (No window.confirm / browser dialog — the design-system ban; this is the calm
// inline equivalent.)

import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { createWorkbenchDoc } from '../../lib/useCockpitWrite';
import { navigate } from '../../lib/router';

type Phase =
  | { kind: 'closed' }
  | { kind: 'naming' }
  | { kind: 'submitting' }
  | { kind: 'collision'; slug: string }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string };

export function NewNoteAffordance() {
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' });
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (phase.kind === 'naming') inputRef.current?.focus();
  }, [phase.kind]);

  const close = useCallback(() => {
    setPhase({ kind: 'closed' });
    setTitle('');
  }, []);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      close();
      return;
    }
    setPhase({ kind: 'submitting' });
    const res = await createWorkbenchDoc(trimmed);
    switch (res.kind) {
      case 'ok':
        navigate({ name: 'notes-doc', slug: res.data.slug });
        break;
      case 'conflict':
        setPhase({ kind: 'collision', slug: res.existingSlug ?? '' });
        break;
      case 'disabled':
        setPhase({ kind: 'disabled' });
        break;
      case 'too-large':
        setPhase({ kind: 'error', message: 'That note is too large to create.' });
        break;
      case 'auth':
        setPhase({ kind: 'error', message: 'Session expired — please sign in again.' });
        break;
      default:
        setPhase({
          kind: 'error',
          message: 'kind' in res && res.kind === 'error' ? res.message : 'Could not create the note.',
        });
    }
  }, [title, close]);

  if (phase.kind === 'closed') {
    return (
      <button
        type="button"
        className="workbench-new-btn"
        onClick={() => setPhase({ kind: 'naming' })}
      >
        <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        New note
      </button>
    );
  }

  return (
    <div className="workbench-new-affordance">
      <div className="workbench-new-row">
        <input
          ref={inputRef}
          type="text"
          className="workbench-new-input"
          placeholder="Name this note…"
          value={title}
          disabled={phase.kind === 'submitting'}
          aria-label="New note title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <button
          type="button"
          className="workbench-new-confirm"
          disabled={phase.kind === 'submitting' || !title.trim()}
          onClick={() => void submit()}
        >
          {phase.kind === 'submitting' ? 'Creating…' : 'Create'}
        </button>
        <button type="button" className="workbench-new-cancel" aria-label="Cancel" onClick={close}>
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {phase.kind === 'collision' && (
        <p className="workbench-new-note" role="alert">
          A note with that name exists.{' '}
          {phase.slug && (
            <button
              type="button"
              className="workbench-new-link"
              onClick={() => navigate({ name: 'notes-doc', slug: phase.slug })}
            >
              Open it
            </button>
          )}
        </p>
      )}
      {phase.kind === 'disabled' && (
        <p className="workbench-new-note workbench-new-note--calm" role="status">
          Saving is disabled right now — creating notes isn't available yet.
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="workbench-new-note" role="alert">
          {phase.message}
        </p>
      )}
    </div>
  );
}
