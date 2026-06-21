// DiscussButton.tsx — the shared "Discuss with AI" affordance (button + composer
// modal) used by NoteView, WorkbenchDocView and FileView headers.
//
// Flow: button -> Dialog (the existing disclosure.tsx primitive: focus trap, Esc,
// scrim-click close, scroll-lock, focus-return) -> textarea ("What do you want to
// discuss or do?", ≤4000 chars) -> POST /api/cockpit/discuss { file, prompt } via
// cockpitWrite (X-Cockpit CSRF belt + same-origin cookie).
//
// SECURITY POSTURE (mirrors the server's discuss block): the composer text and the
// file path travel ONLY in the JSON body; the server writes them into
// .discuss-request.md and launches a FIXED terminal command. Nothing typed here
// ever becomes part of a shell string.
//
// Result states:
//   launched: true  -> "Terminal opened — Claude has the context" (+ the command,
//                      copyable, in case the window was missed)
//   launched: false -> non-darwin fallback: show the command to run manually, with
//                      a Copy button (clipboard API, graceful degradation: the
//                      command stays visible/selectable if copy fails).
//
// Styles: token-only classes appended to cockpit.css (the marked "Discuss with AI"
// block) — every colour is a var() from index.css.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, MessageCircle, SquareTerminal } from 'lucide-react';
import { Dialog } from './disclosure';
import { cockpitWrite } from '../lib/useCockpitWrite';

export const DISCUSS_PROMPT_MAX = 4000;

// Model picker options. `value` is the CLI alias the server forwards to
// `claude --model <value>` (verified against `claude --help`); '' === Default
// (server omits the flag). MUST stay in sync with the server's DISCUSS_MODELS
// allow-list — the server independently rejects anything outside { opus, sonnet,
// haiku, '' }, so a stale option here fails closed rather than silently passing
// arbitrary text into a command.
type DiscussModel = '' | 'opus' | 'sonnet' | 'haiku';
const DISCUSS_MODEL_OPTIONS: ReadonlyArray<{ value: DiscussModel; label: string }> = [
  { value: '', label: 'Default (Claude Code decides)' },
  { value: 'opus', label: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

interface DiscussResponse {
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

export function DiscussButton({ file, subject }: {
  /** Repo-relative path of the open file — goes into the request body, never a shell. */
  file: string;
  /** Optional display name for the dialog subtitle (defaults to the file path). */
  subject?: string;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<DiscussModel>('');
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const labelId = useId();
  const modelId = useId();

  const openDialog = useCallback(() => {
    setPhase({ kind: 'compose' });
    setPrompt('');
    setModel('');
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // The Dialog's overlay effect focuses its first focusable (the header X). For a
  // composer the textarea is the right landing spot — refocus it one frame later
  // so the parent effect has already run.
  useEffect(() => {
    if (!open || phase.kind !== 'compose') return;
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, phase.kind]);

  const submit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || text.length > DISCUSS_PROMPT_MAX) return;
    setPhase({ kind: 'sending' });
    const result = await cockpitWrite<DiscussResponse>('/api/cockpit/discuss', 'POST', {
      file,
      prompt: text,
      // '' === Default; the server treats empty/absent as "omit --model" and
      // independently allow-lists any non-empty value.
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
          : 'The discuss hand-off could not be prepared.';
    setPhase({ kind: 'error', message });
  }, [file, prompt, model]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    },
    [submit]
  );

  const composing = phase.kind === 'compose' || phase.kind === 'error';
  const trimmedLen = prompt.trim().length;

  return (
    <>
      <button type="button" className="discuss-trigger" onClick={openDialog}>
        <MessageCircle size={14} strokeWidth={1.5} aria-hidden="true" />
        Discuss with AI
      </button>

      <Dialog open={open} onClose={close} title="Discuss with AI" subtitle={subject ?? file}>
        {composing || phase.kind === 'sending' ? (
          <form
            className="discuss-form"
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
          >
            <label id={labelId} className="discuss-label" htmlFor={`${labelId}-input`}>
              What do you want to discuss or do?
            </label>
            <textarea
              id={`${labelId}-input`}
              ref={textareaRef}
              className="discuss-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, DISCUSS_PROMPT_MAX))}
              onKeyDown={onKeyDown}
              maxLength={DISCUSS_PROMPT_MAX}
              rows={5}
              disabled={phase.kind === 'sending'}
              placeholder="e.g. Summarize this note and propose next steps…"
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
                  onChange={(e) => setModel(e.target.value as DiscussModel)}
                  disabled={phase.kind === 'sending'}
                  aria-describedby={`${modelId}-note`}
                >
                  {DISCUSS_MODEL_OPTIONS.map((opt) => (
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
                {prompt.length} / {DISCUSS_PROMPT_MAX}
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
          <DiscussResult phase={phase} />
        )}
      </Dialog>
    </>
  );
}

function DiscussResult({ phase }: { phase: Extract<Phase, { kind: 'launched' | 'manual' }> }) {
  return (
    <div className="discuss-result">
      {phase.kind === 'launched' ? (
        <p className="discuss-success" role="status">
          <Check size={16} strokeWidth={2} aria-hidden="true" />
          Terminal opened — Claude has the context.
        </p>
      ) : (
        <p className="discuss-success is-manual" role="status">
          The request file is ready. Run this command in your terminal:
        </p>
      )}
      <div className="discuss-sent">
        <span className="discuss-sent-label">Your question — passed straight to Claude:</span>
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

// The fallback command, visible + selectable always; the Copy button is sugar on
// top (clipboard API can be unavailable on plain-http LAN origins).
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
