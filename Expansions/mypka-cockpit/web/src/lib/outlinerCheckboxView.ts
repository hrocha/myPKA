// outlinerCheckboxView.ts — clickable task checkboxes over literal `[ ]` /
// `[x]` bullet text in the document editor (2026-06-12).
//
// PURE DECORATIONS, never a node (the wikilink-live-preview house pattern,
// outlinerWikilinkView.ts): the doc keeps the raw `[ ] ` / `[x] ` text at the
// start of a listItem's paragraph, so the markdown stays SSOT BY CONSTRUCTION —
// workbenchMarkdown never sees anything new, the file literally contains
// `- [ ] task` / `- [x] task` and round-trips with Obsidian byte-identically
// (the marker is plain text to the inline parser: `[` not followed by `(` falls
// through as literal; escapeText only escapes `[` before a full link shape).
//
// A bullet whose OWN paragraph starts with `[ ]` or `[x]`/`[X]` (optional
// following space) renders as a task item:
//
//   widget    -> .wb-task-box     interactive checkbox (role=checkbox, brass
//                                 check when checked — rhymes with the brass
//                                 collapsed bullet), placed before the text
//   marker    -> .wb-task-marker  the raw `[ ] ` chars — HIDDEN in preview
//                                 (display:none via CSS, like .wb-wl-bracket)
//   rest      -> .wb-task-done    muted text when checked (NO strikethrough)
//
// PREVIEW vs EDITING (same contract as wikilinks): when the caret does NOT
// touch the marker's range the raw chars are hidden and the checkbox shows.
// When the caret (or any selection end) touches the marker every part gets
// `.is-editing` — the raw `[ ]` reveals for editing and the widget hides. The
// doc text itself never changes — hiding is pure CSS on decoration spans, so
// positions / round-trip / the outlinerEdit Enter-Backspace-caret semantics
// stay exact (the marker is ordinary paragraph text to every structural op).
//
// TOGGLE: mousedown on the box (preview state — the caret never enters the
// hidden marker) or Space/Enter on the focused box flips the ONE state char
// (`[ ]` ↔ `[x]`) via tr.insertText. The doc change fires onUpdate → the
// EXISTING autosave write path persists the markdown. `[X]` normalizes to
// `[ ]` on its first toggle-off and to `[x]` thereafter.
//
// INPUT RULE (convenience): typing `[] ` at the start of a listItem's
// paragraph converts to `[ ] ` — the canonical marker the renderer matches.
//
// Skipped contexts: code blocks (node.type.spec.code), inline `code`-marked
// markers (`` `[ ]` `` stays raw — mirrors the wikilink skip rule), paragraphs
// outside lists, heading-bullets, and non-first paragraphs.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension, InputRule } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const checkboxViewKey = new PluginKey<DecorationSet>('taskCheckboxView');

// `[ ]` / `[x]` / `[X]` at the very start of the paragraph text, optional
// following space (the space, when present, is part of the hidden marker).
const TASK_RE = /^\[([ xX])\]( ?)/;

const BOX_CLASS = 'wb-task-box';

function makeBox(checked: boolean, editing: boolean): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${BOX_CLASS}${checked ? ' is-checked' : ''}${editing ? ' is-editing' : ''}`;
  // A native button carries focusability + Enter/Space activation; the
  // checkbox ROLE + state make it announce as a real checkbox.
  btn.setAttribute('role', 'checkbox');
  btn.setAttribute('aria-checked', String(checked));
  btn.setAttribute('aria-label', checked ? 'Completed task. Uncheck' : 'Open task. Check');
  btn.contentEditable = 'false';
  return btn;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;

  state.doc.descendants((node, pos, parent, index) => {
    // Never decorate inside code blocks; don't descend into them either.
    if (node.isTextblock && node.type.spec.code) return false;
    if (node.type.name !== 'paragraph') return true;
    // Only the listItem's OWN textblock (its first child) is a task candidate.
    if (!parent || parent.type.name !== 'listItem' || index !== 0) return false;

    const m = TASK_RE.exec(node.textContent);
    if (!m) return false;
    // Inline-code-marked marker stays raw (wikilink skip rule).
    const first = node.firstChild;
    if (first?.isText && first.marks.some((mk) => mk.type.name === 'code')) return false;

    const textStart = pos + 1; // inside the paragraph, before the marker
    const markerEnd = textStart + m[0].length;
    const paraEnd = pos + 1 + node.content.size;
    const checked = m[1] !== ' ';
    // Caret (or any selection end) touching the marker -> editing mode: raw
    // `[ ]` reveals, widget hides. Inclusive bounds, like the wikilink view.
    const editing = selFrom <= markerEnd && selTo >= textStart;
    const edit = editing ? ' is-editing' : '';

    decos.push(
      Decoration.widget(textStart, () => makeBox(checked, editing), {
        side: -1,
        // State in the key so a toggle / caret-touch recreates the DOM with
        // fresh classes (PM reuses same-key widgets without re-rendering).
        key: `wb-task:${checked ? '1' : '0'}:${editing ? '1' : '0'}`,
      })
    );
    decos.push(Decoration.inline(textStart, markerEnd, { class: `wb-task-marker${edit}` }));
    if (checked && markerEnd < paraEnd) {
      decos.push(Decoration.inline(markerEnd, paraEnd, { class: 'wb-task-done' }));
    }
    return false; // a paragraph has no decoratable descendants for this plugin
  });

  return DecorationSet.create(state.doc, decos);
}

/** Flip the task state char of the paragraph hosting `el` (a .wb-task-box
 *  widget). The ONE-char insertText keeps the edit minimal and atomic; the doc
 *  change flows through onUpdate → the existing autosave write path. Returns
 *  the PARAGRAPH's node position (stable across the inner edit — used to
 *  re-focus the recreated widget after a keyboard toggle), or null. */
function toggleTaskAt(view: EditorView, el: HTMLElement): number | null {
  if (!view.editable) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(el, 0);
  } catch {
    return null;
  }
  const $pos = view.state.doc.resolve(pos);
  const para = $pos.parent;
  if (para.type.name !== 'paragraph') return null;
  const paraStart = $pos.start();
  const m = TASK_RE.exec(para.textContent);
  if (!m) return null; // stale widget — never guess
  const checked = m[1] !== ' ';
  view.dispatch(view.state.tr.insertText(checked ? ' ' : 'x', paraStart + 1, paraStart + 2));
  return paraStart - 1;
}

/** Task-checkbox live preview + toggle + `[] ` input rule. Priority 1000 so the
 *  plugin's keydown sees Space/Tab on a FOCUSED box before ListKeymap's keymap
 *  (Tab would otherwise sink a list item off a stale text selection). */
export function CheckboxViewExtension(): Extension {
  return Extension.create({
    name: 'taskCheckboxView',
    priority: 1000,

    addInputRules() {
      return [
        new InputRule({
          // `[] ` typed at the start of a listItem's first paragraph becomes
          // the canonical `[ ] ` marker. Anywhere else the guard leaves the
          // tr untouched and the typed text inserts normally.
          find: /^\[\]\s$/,
          handler: ({ state, range }) => {
            const { $from } = state.selection;
            if ($from.parent.type.name !== 'paragraph') return;
            const d = $from.depth - 1;
            if (d < 1 || $from.node(d).type.name !== 'listItem') return;
            if ($from.index(d) !== 0) return;
            state.tr.insertText('[ ] ', range.from, range.to);
          },
        }),
      ];
    },

    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: checkboxViewKey,
          state: {
            init: (_config, state) => buildDecorations(state),
            apply: (tr, value, _old, newState) =>
              // Rebuild on doc OR selection change (the editing-state class
              // tracks the caret) — same cadence as the wikilink view.
              tr.docChanged || tr.selectionSet ? buildDecorations(newState) : value,
          },
          props: {
            decorations(state) {
              return checkboxViewKey.getState(state);
            },
            handleDOMEvents: {
              mousedown(view, event) {
                if (event.button !== 0) return false;
                if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
                const el = (event.target as HTMLElement | null)?.closest?.(`.${BOX_CLASS}`);
                if (!el) return false;
                // Consume the press — the caret must not enter the hidden
                // marker text (mirrors the wikilink click contract).
                event.preventDefault();
                toggleTaskAt(view, el as HTMLElement);
                return true;
              },
              keydown(view, event) {
                const el = (event.target as HTMLElement | null)?.closest?.(`.${BOX_CLASS}`);
                if (!el) return false;
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  const paraPos = toggleTaskAt(view, el as HTMLElement);
                  if (paraPos !== null) {
                    // The toggle rebuilt the widget (state is in its key) —
                    // restore keyboard focus onto the fresh box.
                    const p = view.nodeDOM(paraPos) as HTMLElement | null;
                    (p?.querySelector?.(`.${BOX_CLASS}`) as HTMLElement | null)?.focus();
                  }
                  return true;
                }
                // Any other key on a focused box: keep PM / keymaps (ListKeymap
                // Tab-sink, outliner Enter semantics) away from the stale text
                // selection; the browser default (Tab focus move, …) proceeds.
                return true;
              },
            },
          },
        }),
      ];
    },
  });
}
