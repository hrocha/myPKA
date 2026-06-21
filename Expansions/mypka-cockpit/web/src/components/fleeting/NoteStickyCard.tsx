// NoteStickyCard.tsx — one fleeting note as a sticky-styled card (the hub's
// visual language, made interactive). Used by the Fleeting-Notes home
// (WorkbenchListView): title + relative date + status chip, with a hover/focus
// action row — pin toggle, status cycle (capture → working → ready → capture),
// and a six-swatch color popover. All meta writes go through the parent's
// `onPatch` (optimistic patchNoteMeta); this component stays presentational.
import { useEffect, useRef, useState } from 'react';
import { Palette, Pin, RefreshCw, Trash2, Check, X } from 'lucide-react';
import { navigate } from '../../lib/router';
import {
  STICKY_COLORS,
  type FleetingDoc,
  type NoteStatus,
  type StickyColor,
} from '../../lib/fleeting';

export type NoteMetaPatch = Partial<{
  pinned: boolean;
  status: NoteStatus;
  color: StickyColor | null;
}>;

const NEXT_STATUS: Record<NoteStatus, NoteStatus> = {
  capture: 'working',
  working: 'ready',
  ready: 'capture',
};

// Relative "time ago" label from an epoch-ms mtime. Falls back gracefully on a
// bad/zero timestamp (renders nothing rather than "NaN ago" or "Invalid Date").
export function relativeTime(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '';
  const diffMs = Date.now() - epochMs;
  if (diffMs < 0) return 'just now';
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} ${day === 1 ? 'day' : 'days'} ago`;
  if (day < 30) {
    const wk = Math.round(day / 7);
    return `${wk} ${wk === 1 ? 'week' : 'weeks'} ago`;
  }
  try {
    return new Date(epochMs).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

export function NoteStickyCard({
  note,
  disabled,
  onPatch,
  onDelete,
  deleting,
}: {
  note: FleetingDoc;
  /** true when the write path is dormant (read-only cockpit) — actions hide. */
  disabled: boolean;
  onPatch: (slug: string, patch: NoteMetaPatch) => void;
  /** Confirmed delete (Feature #10). Parent removes the card on success. */
  onDelete: (slug: string) => void;
  /** true while THIS card's delete request is in flight. */
  deleting: boolean;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Inline two-step confirm (NO browser confirm() — design-system ban): the
  // trash button flips the action row into a "Delete this note? [Delete][Cancel]"
  // confirm strip; nothing is deleted until the explicit confirm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const paletteBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  // Close the color popover on an outside click.
  useEffect(() => {
    if (!paletteOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!paletteRef.current?.contains(e.target as Node)) setPaletteOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [paletteOpen]);

  // Move focus to the destructive button when the confirm strip opens, so a
  // keyboard user lands on the action and Escape (handled below) can cancel.
  useEffect(() => {
    if (confirmingDelete) confirmBtnRef.current?.focus();
  }, [confirmingDelete]);

  const when = relativeTime(note.mtime);
  const next = NEXT_STATUS[note.status];

  return (
    <div className="fn-card" data-tint={note.color ?? 'paper'} role="listitem">
      <button
        type="button"
        className="fn-card-open"
        onClick={() => navigate({ name: 'notes-doc', slug: note.slug })}
      >
        <span className="fn-card-title">{note.title || note.slug}</span>
        <span className="fn-card-meta">
          {when && <span className="fn-card-date">{when}</span>}
          <em className="fn-chip" data-status={note.status}>{note.status}</em>
        </span>
      </button>

      {!disabled && (
        <div className="fn-card-actions">
          <button
            type="button"
            className="fn-action"
            aria-label={note.pinned ? `Unpin ${note.title}` : `Pin ${note.title}`}
            aria-pressed={note.pinned}
            title={note.pinned ? 'Unpin' : 'Pin'}
            onClick={() => onPatch(note.slug, { pinned: !note.pinned })}
          >
            <Pin
              size={13}
              strokeWidth={1.5}
              fill={note.pinned ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="fn-action"
            aria-label={`Status is ${note.status} — set to ${next}`}
            title={`Status: ${note.status} → ${next}`}
            onClick={() => onPatch(note.slug, { status: next })}
          >
            <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <div className="fn-palette-wrap" ref={paletteRef}>
            <button
              ref={paletteBtnRef}
              type="button"
              className="fn-action"
              aria-label={`Change color of ${note.title}`}
              aria-expanded={paletteOpen}
              aria-haspopup="true"
              title="Color"
              onClick={() => setPaletteOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPaletteOpen(false);
              }}
            >
              <Palette size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
            {paletteOpen && (
              <div
                className="fn-palette"
                role="group"
                aria-label="Sticky color"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setPaletteOpen(false);
                    paletteBtnRef.current?.focus();
                  }
                }}
              >
                {STICKY_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="fn-swatch"
                    data-tint={c}
                    aria-label={`Color: ${c}`}
                    aria-pressed={note.color === c}
                    onClick={() => {
                      setPaletteOpen(false);
                      onPatch(note.slug, { color: c });
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="fn-action fn-action--danger"
            aria-label={`Delete ${note.title}`}
            title="Delete note"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Inline delete confirm (no browser dialog). Covers the card foot with a
          clear destructive choice; Escape or Cancel backs out. */}
      {confirmingDelete && !disabled && (
        <div
          className="fn-confirm"
          role="group"
          aria-label={`Delete ${note.title}?`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setConfirmingDelete(false); }
          }}
        >
          <span className="fn-confirm-text">Delete this note?</span>
          <button
            ref={confirmBtnRef}
            type="button"
            className="fn-confirm-yes"
            disabled={deleting}
            onClick={() => onDelete(note.slug)}
          >
            <Check size={13} strokeWidth={1.5} aria-hidden="true" />
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className="fn-confirm-no"
            disabled={deleting}
            onClick={() => setConfirmingDelete(false)}
          >
            <X size={13} strokeWidth={1.5} aria-hidden="true" />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
