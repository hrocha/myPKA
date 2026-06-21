// PromptInput.tsx — a real AI-chat prompt-input primitive.
//
// Anatomy mirrors the Vercel AI SDK "AI Elements" PromptInput component
// (elements.ai-sdk.dev/components/prompt-input — fetched 2026-06-04) and the shadcn/ui
// Textarea + Button + Select primitives that back it (shadcn.io MCP:
// get_component "textarea" | "button" | "select"). Same structural contract as the
// premium component — a column container with a HEADER (attachments), a BODY (an
// auto-growing textarea: Enter submits, Shift+Enter newlines), and a FOOTER TOOLBAR
// (PromptInputTools on the LEFT, PromptInputSubmit on the RIGHT with status states).
//
// Built ZERO-DEP and styled with GL-003 cockpit DARK tokens — the SAME call this
// codebase already documents for disclosure.tsx / ui.tsx / ModelSelector.tsx: the
// canonical shadcn + AI-Elements sources assume Tailwind v4 token names (bg-background),
// `@/lib/utils` cn(), Radix, and cva — none of which this Vite + Tailwind v3 + GL-003
// app ships. So we reproduce the ANATOMY (the slots, the layout, the status model,
// the a11y), not the package. All visual styling lives in cockpit.css (.prompt-input*).
//
// The `status` model on Submit comes verbatim from AI Elements:
//   'ready'    — idle, can send (brass send glyph)
//   'submitted'| 'streaming' — a turn is in flight (square "stop"/spinner affordance)
//   'error'    — last turn errored (retry affordance)
// Accessibility: the toolbar is a labelled group; the submit button carries an
// aria-label that tracks status; the textarea owns the Enter/Shift+Enter contract.
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type FormHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { SendHorizonal, Square, RotateCcw } from 'lucide-react';

/** zero-dep className joiner (the codebase ships clsx transitively but the primitives
 *  here, like disclosure.tsx, stay dependency-free — a plain join is all the slots need). */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Root — the <form>. Flex COLUMN: header (attachments) ▸ body (textarea) ▸
// footer (toolbar). Mirrors AI Elements <PromptInput onSubmit=…>.
// ---------------------------------------------------------------------------
export interface PromptInputProps extends FormHTMLAttributes<HTMLFormElement> {
  children: ReactNode;
  /** Visual flag for an active drag-drop hover (drives the dropzone scrim). */
  dragging?: boolean;
}
export const PromptInput = forwardRef<HTMLFormElement, PromptInputProps>(
  function PromptInput({ children, dragging = false, className, ...rest }, ref) {
    return (
      <form
        ref={ref}
        className={cx('prompt-input', dragging && 'is-dragging', className)}
        {...rest}
      >
        {children}
      </form>
    );
  },
);

// ---------------------------------------------------------------------------
// Header — the attachments rail (AI Elements <PromptInputHeader>). Renders only
// when it has children; the composer passes the preview chips + notice here.
// ---------------------------------------------------------------------------
export function PromptInputHeader({ children }: { children: ReactNode }) {
  return <div className="prompt-input-header">{children}</div>;
}

// ---------------------------------------------------------------------------
// Body — wraps the textarea (AI Elements <PromptInputBody>). Gives the input
// the roomy top region above the toolbar.
// ---------------------------------------------------------------------------
export function PromptInputBody({ children }: { children: ReactNode }) {
  return <div className="prompt-input-body">{children}</div>;
}

/** Auto-growing textarea. The growth + Enter/Shift+Enter handling stays in the
 *  consumer (it owns the ref + value); this is the styled, labelled surface. */
export const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function PromptInputTextarea({ className, rows = 1, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx('prompt-input-textarea', className)}
      {...rest}
    />
  );
});

// ---------------------------------------------------------------------------
// Toolbar (AI Elements <PromptInputFooter>) — the bottom row. Tools LEFT,
// Submit RIGHT, generous spacing. A spacer between them pushes Submit to the edge.
// ---------------------------------------------------------------------------
export function PromptInputToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="prompt-input-toolbar" role="group" aria-label="Composer actions">
      {children}
    </div>
  );
}

/** Left-side action cluster (AI Elements <PromptInputTools>): attach, model-select. */
export function PromptInputTools({ children }: { children: ReactNode }) {
  return <div className="prompt-input-tools">{children}</div>;
}

/** Flexible gap that pushes the submit button to the right edge of the toolbar. */
export function PromptInputSpacer() {
  return <div className="prompt-input-spacer" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Tool button (AI Elements <PromptInputButton>) — a ghost icon button sized as a
// proper toolbar control (not the old crammed 44px slab). Used for "attach image".
// ---------------------------------------------------------------------------
export interface PromptInputButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}
export const PromptInputButton = forwardRef<
  HTMLButtonElement,
  PromptInputButtonProps
>(function PromptInputButton({ children, className, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('prompt-input-btn', className)}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Submit (AI Elements <PromptInputSubmit status=…>) — right-edge primary action.
// The icon + aria-label track the status: ready → send, in-flight → stop-shaped
// affordance, error → retry. The cockpit only ever drives 'ready' (the parent
// disables the whole composer while a turn is in flight), but the full status
// surface is here so the contract matches the premium component 1:1.
// ---------------------------------------------------------------------------
export type PromptInputStatus = 'ready' | 'submitted' | 'streaming' | 'error';

export interface PromptInputSubmitProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  status?: PromptInputStatus;
}
export const PromptInputSubmit = forwardRef<
  HTMLButtonElement,
  PromptInputSubmitProps
>(function PromptInputSubmit(
  { status = 'ready', className, 'aria-label': ariaLabel, ...rest },
  ref,
) {
  const inFlight = status === 'submitted' || status === 'streaming';
  const Icon = status === 'error' ? RotateCcw : inFlight ? Square : SendHorizonal;
  const label =
    ariaLabel ??
    (status === 'error'
      ? 'Retry'
      : inFlight
        ? 'Stop generating'
        : 'Send message');
  return (
    <button
      ref={ref}
      type="submit"
      className={cx('prompt-input-submit', className)}
      data-status={status}
      aria-label={label}
      {...rest}
    >
      <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
});
