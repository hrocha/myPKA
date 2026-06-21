// QuickTerminalButton.tsx — the left-sidebar "quick launch terminal" affordance.
//
// Like DiscussButton, but with NO file context: it launches the configured LLM
// CLI at the scaffold ROOT with a user-supplied prompt. Reuses the SAME Dialog
// primitive, the SAME model picker + allow-list, and the SAME discuss-* token
// styling (cockpit.css) so it reads as a sibling of "Discuss with AI".
//
// Flow: sidebar button -> Dialog -> textarea ("What should Claude do?", ≤4000
// chars) + model picker -> POST /api/cockpit/launch-terminal { prompt, model }
// via cockpitWrite (X-Cockpit CSRF belt + same-origin cookie). The prompt rides
// ONLY in the JSON body; the server wraps it in POSIX single quotes and launches
// a FIXED command at REPO_ROOT — nothing typed here becomes part of a shell
// string. The resolved command is returned for the manual-run fallback.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import { Dialog } from './disclosure';
import { cockpitWrite } from '../lib/useCockpitWrite';

export const TERMINAL_PROMPT_MAX = 4000;

// Model picker — the SAME allow-list as DiscussButton (DISCUSS_MODELS on the
// server: opus | sonnet | haiku, '' === Default). Kept in sync deliberately:
// the server independently rejects anything outside the set, so a stale option
// fails closed rather than passing arbitrary text into a command.
type LaunchModel = '' | 'opus' | 'sonnet' | 'haiku';
const DISCUSS_MODELS: ReadonlyArray<{ value: LaunchModel; label: string }> = [
  { value: '', label: 'Default (Claude Code decides)' },
  { value: 'opus', label: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

interface LaunchResponse {
  ok: true;
  launched: boolean;
  // The exact command the server spawned (or, on non-darwin, the one to run
  // manually). Displayed verbatim — display and spawn are the same string.
  command: string;
}

type Phase =
  | { kind: 'compose' }
  | { kind: 'sending' }
  | { kind: 'launched'; command: string; sent: string }
  | { kind: 'manual'; command: string; sent: string }
  | { kind: 'error'; message: string };

export function QuickTerminalButton({ onAfterOpen }: { onAfterOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<LaunchModel>('');
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const labelId = useId();
  const modelId = useId();

  const openDialog = useCallback(() => {
    setPhase({ kind: 'compose' });
    setPrompt('');
    setModel('');
    setOpen(true);
    onAfterOpen?.();
  }, [onAfterOpen]);
  const close = useCallback(() => setOpen(false), []);

  // Land focus in the textarea one frame after the Dialog's own focus effect.
  useEffect(() => {
    if (!open || phase.kind !== 'compose') return;
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, phase.kind]);

  const submit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || text.length > TERMINAL_PROMPT_MAX) return;
    setPhase({ kind: 'sending' });
    const result = await cockpitWrite<LaunchResponse>('/api/cockpit/launch-terminal', 'POST', {
      prompt: text,
      model,
    });
    if (result.kind === 'ok') {
      setPhase(result.data.launched
        ? { kind: 'launched', command: result.data.command, sent: prompt }
        : { kind: 'manual', command: result.data.command, sent: prompt });
      return;
    }
    const message =
      result.kind === 'auth'
        ? 'Your session has expired — unlock the cockpit and try again.'
        : result.kind === 'error'
          ? result.message
          : 'The terminal could not be launched.';
    setPhase({ kind: 'error', message });
  }, [prompt, model]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const composing = phase.kind === 'compose' || phase.kind === 'error';
  const trimmedLen = prompt.trim().length;

  return (
    <>
      <button type="button" className="menu-button menu-button--action" onClick={openDialog}>
        <SquareTerminal size={18} strokeWidth={1.5} aria-hidden="true" className="menu-icon" />
        <span className="menu-label">Quick Terminal</span>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title="Quick-launch terminal"
        subtitle="Launches at your myPKA root — no file context"
      >
        {composing || phase.kind === 'sending' ? (
          <form
            className="discuss-form"
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
          >
            <label id={labelId} className="discuss-label" htmlFor={`${labelId}-input`}>
              What should Claude do?
            </label>
            <textarea
              id={`${labelId}-input`}
              ref={textareaRef}
              className="discuss-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, TERMINAL_PROMPT_MAX))}
              onKeyDown={onKeyDown}
              maxLength={TERMINAL_PROMPT_MAX}
              rows={5}
              disabled={phase.kind === 'sending'}
              placeholder="e.g. Run the daily habit check-in and tell me where things stand…"
            />
            <div className="discuss-model">
              <div className="discuss-model-row">
                <label className="discuss-model-label" htmlFor={modelId}>
                  Model
                </label>
                <select
                  id={modelId}
                  className="discuss-model-select"
                  value={model}
                  onChange={(e) => setModel(e.target.value as LaunchModel)}
                  disabled={phase.kind === 'sending'}
                  aria-describedby={`${modelId}-note`}
                >
                  {DISCUSS_MODELS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <p id={`${modelId}-note`} className="discuss-model-note">
                Applies to this session only — your other open Claude sessions are unaffected.
              </p>
            </div>
            <div className="discuss-meta">
              <span className="discuss-count" aria-live="polite">
                {prompt.length} / {TERMINAL_PROMPT_MAX}
              </span>
              {phase.kind === 'error' && (
                <span role="alert" className="discuss-error">{phase.message}</span>
              )}
            </div>
            <div className="discuss-actions">
              <button
                type="submit"
                className="discuss-submit"
                disabled={phase.kind === 'sending' || trimmedLen === 0}
              >
                <SquareTerminal size={14} strokeWidth={1.5} aria-hidden="true" />
                {phase.kind === 'sending' ? 'Opening Terminal…' : 'Open in Terminal'}
              </button>
              <span className="discuss-hint">⌘/Ctrl + Enter to send</span>
            </div>
          </form>
        ) : (
          <LaunchResult phase={phase} />
        )}
      </Dialog>
    </>
  );
}

function LaunchResult({ phase }: { phase: Extract<Phase, { kind: 'launched' | 'manual' }> }) {
  return (
    <div className="discuss-result">
      {phase.kind === 'launched' ? (
        <p className="discuss-success" role="status">
          <Check size={16} strokeWidth={2} aria-hidden="true" />
          Terminal opened at your myPKA root — Claude has your prompt.
        </p>
      ) : (
        <p className="discuss-success is-manual" role="status">
          Run this command in your terminal:
        </p>
      )}
      <div className="discuss-sent">
        <span className="discuss-sent-label">Your prompt — passed straight to Claude:</span>
        <blockquote className="discuss-sent-text">{phase.sent}</blockquote>
      </div>
      <CommandBox command={phase.command} />
      {phase.kind === 'launched' && (
        <p className="discuss-hint">
          If no window appeared, run the command above manually.
        </p>
      )}
    </div>
  );
}

// The fallback command, always visible + selectable; Copy is sugar on top
// (clipboard API can be unavailable on plain-http LAN origins).
function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the command stays selectable below.
    }
  }, [command]);

  return (
    <div className="discuss-command">
      <code className="discuss-command-text">{command}</code>
      <button type="button" className="discuss-copy" onClick={() => void copy()}>
        {copied
          ? <><Check size={13} strokeWidth={2} aria-hidden="true" /> Copied</>
          : <><Copy size={13} strokeWidth={1.5} aria-hidden="true" /> Copy</>}
      </button>
    </div>
  );
}
