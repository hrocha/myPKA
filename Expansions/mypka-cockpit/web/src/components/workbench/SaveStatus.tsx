// SaveStatus.tsx — the optimistic save-status indicator (Vivi Spec 3).
//
// IMPLEMENTATION NOTE (for Vera): the spec references `AnimatePresence
// mode="wait"`, but the Cockpit has NO Motion/Framer dependency — it does motion
// via CSS keyframes + `linear()` spring strings (the cockpit.css convention; see
// the planner DragOverlay + chat-marker-breath). Adding Motion for one indicator
// would be a bundle regression and break the house pattern. So this renders the
// SAME FEEL via CSS:
//   - entry: 150ms springSnappy opacity + 2px rise (Spec §3.2-A)
//   - saving cue: a single dot breathing 1200ms on --ease-collapse (§3.2-B) — NO
//     spinner; cut (not finished) when the PUT resolves
//   - saved: the check glyph "pops" once on springPunctuate (~5% overshoot, the ONE
//     earned-delight beat, §3.2-C) + label fade-in
//   - saved → fade: dwell --dur-save-settle (≈1400ms) then a calm 400ms fade-out
//     with a 2px lift (§3.2-D)
//   - conflict / disabled / error: PERSIST (no fade) — a fade would hide a problem.
// All of it is neutralized to opacity-only by the global prefers-reduced-motion
// rule in index.css (§3.5), and the dwell (a timing, not a motion) is preserved.
//
// Tokens: --dur-save-settle, --ease-collapse (Iris/GL-003 §6 + §6.7). No hex/px
// beyond the 2px micro-offsets the spec pins (inside the §6 2–6px band).

import { useEffect, useState } from 'react';
import { Check, Lock, AlertCircle } from 'lucide-react';
import type { SaveStatus as SaveStatusModel } from '../../lib/useWorkbenchSave';

interface Props {
  status: SaveStatusModel;
  /** Called when Tom chooses "reload" on a 412 conflict. */
  onReload: () => void;
  /** Called when Tom chooses "overwrite" on a 412 conflict. */
  onOverwrite: () => void;
}

export function SaveStatus({ status, onReload, onOverwrite }: Props) {
  // The "saved" state self-recedes after the dwell. Lifecycle (M3 / §6.8):
  //   visible → (dwell --dur-save-settle) → exiting (calm 400ms fade-out) →
  //   hidden (unmount on transitionend). idle renders no chrome at all.
  const [savedHidden, setSavedHidden] = useState(false);
  const [savedExiting, setSavedExiting] = useState(false);

  useEffect(() => {
    if (status.kind !== 'saved') {
      setSavedHidden(false);
      setSavedExiting(false);
      return;
    }
    setSavedHidden(false);
    setSavedExiting(false);
    // Dwell (--dur-save-settle ≈1400ms) handled by reading the CSS var would
    // require a layout read; the dwell is a fixed house timing, so we mirror it
    // here as the JS trigger to begin the fade. Kept in sync with the token.
    const dwellMs = readDurSaveSettle();
    const t = setTimeout(() => setSavedExiting(true), dwellMs);
    return () => clearTimeout(t);
  }, [status]);

  // idle (or a faded-out saved) → render nothing. The indicator is present only
  // when there's something to report (§3.2-A).
  if (status.kind === 'idle' || (status.kind === 'saved' && savedHidden)) return null;

  if (status.kind === 'conflict') {
    return (
      <div className="wb-save-status wb-save-status--conflict" role="alert">
        <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="wb-save-label">This note changed on disk.</span>
        <button type="button" className="wb-save-action" onClick={onReload}>
          Reload
        </button>
        <button type="button" className="wb-save-action wb-save-action--danger" onClick={onOverwrite}>
          Overwrite
        </button>
      </div>
    );
  }

  if (status.kind === 'disabled') {
    return (
      <div className="wb-save-status wb-save-status--disabled" role="status">
        <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="wb-save-label">Saving is disabled — your edits won't persist yet.</span>
      </div>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="wb-save-status wb-save-status--error" role="alert">
        <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="wb-save-label">{status.message}</span>
      </div>
    );
  }

  if (status.kind === 'saving') {
    return (
      <div className="wb-save-status wb-save-status--saving" role="status" aria-live="polite">
        <span className="wb-save-dot" aria-hidden="true" />
        <span className="wb-save-label">Saving…</span>
      </div>
    );
  }

  // saved — visible through the dwell, then recedes via the §6.8 calm fade-out
  // (M3). On transitionend of the opacity fade we unmount (savedHidden). Under
  // reduced motion the global rule zeroes the transition, so transitionend
  // still fires (duration 0) and the unmount stays correct.
  return (
    <div
      className={`wb-save-status wb-save-status--saved${savedExiting ? ' wb-save-status--exiting' : ''}`}
      role="status"
      aria-live="polite"
      onTransitionEnd={(e) => {
        if (savedExiting && e.propertyName === 'opacity') setSavedHidden(true);
      }}
    >
      <span className="wb-save-check" aria-hidden="true">
        <Check size={14} strokeWidth={2} />
      </span>
      <span className="wb-save-label">Saved</span>
    </div>
  );
}

// Errors persist (no fade); the next keystroke re-triggers the debounced save, so
// no explicit retry control is needed here.

// Read --dur-save-settle from the cascade so JS and CSS share ONE source of truth
// for the dwell. Falls back to the spec value if the var is absent.
function readDurSaveSettle(): number {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--dur-save-settle')
      .trim();
    const ms = /^([\d.]+)ms$/.exec(raw);
    if (ms) return parseFloat(ms[1]);
    const s = /^([\d.]+)s$/.exec(raw);
    if (s) return parseFloat(s[1]) * 1000;
  } catch {
    /* SSR / no DOM */
  }
  return 1400; // spec default
}
