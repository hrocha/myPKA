// outlinerWikilink.ts — `[[` wikilink autocomplete for the document editor
// (2026-06-11).
//
// Typing `[[` opens an inline suggestion popup fed by
// GET /api/cockpit/search?q=<typed> → { items: [{ type, slug, title, label }] }
// and refines as the user types. Enter / click inserts `[[slug]]` as PLAIN
// TEXT — the markdown stays a clean wikilink string (no special node, cheap and
// round-trip-safe; workbenchMarkdown deliberately never escapes `[[`).
// Escape dismisses (until the trigger changes), ArrowUp/Down navigate.
//
// IMPLEMENTATION: a custom ProseMirror plugin, NOT TipTap's Suggestion utility —
// the two-character `[[` trigger can't be expressed by Suggestion's single
// `char` option and the dependency isn't installed; a focused plugin is ~120
// lines and owns its DOM popup (no React, so the lib layer stays TSX-free).
//
//   - PM STATE holds the active trigger match {from,to,query} + a dismissed
//     flag, so the EDITOR's own keydown handler can defer Enter/Arrows to this
//     plugin via isWikilinkActive(state) (view-level handlers run first).
//   - The VIEW owns the popup element (appended to document.body, position:
//     fixed from coordsAtPos so no overflow clipping), the 150ms debounced
//     fetch with AbortController, and the keyboard/mouse commit paths.
//   - A11y: role=listbox/option with aria-selected; the contentEditable host
//     gets aria-activedescendant while the popup is open.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface WikilinkItem {
  type: string;
  slug: string;
  title: string;
  label?: string;
}

interface WikilinkMatch {
  from: number; // position of the first '[' of the trigger
  to: number; // caret position (end of the typed query)
  query: string;
}

interface WikilinkState {
  match: WikilinkMatch | null;
  dismissedFrom: number | null; // Escape pressed for the match anchored here
}

export const wikilinkKey = new PluginKey<WikilinkState>('wikilinkSuggest');

const DEBOUNCE_MS = 150;
const MAX_ITEMS = 8;

// The popup is "active" when a live (non-dismissed) trigger match exists — the
// editor's keydown handler uses this to defer Enter/Arrows to the plugin.
export function isWikilinkActive(state: EditorState): boolean {
  const ps = wikilinkKey.getState(state);
  return !!ps?.match && ps.dismissedFrom !== ps.match.from;
}

// Find an open `[[query` immediately before the caret, inside the caret's own
// textblock (never in code blocks; inline content here is text-only, so the
// string offset maps 1:1 to the parent offset).
function findMatch(state: EditorState): WikilinkMatch | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  const textBefore = parent.textBetween(0, $from.parentOffset, '\0', '\0');
  const m = /\[\[([^[\]]*)$/.exec(textBefore);
  if (!m) return null;
  // Caret inside an already-CLOSED `[[...]]` is NOT an open trigger: a caret
  // landing in an existing link (arrowing in to edit it) must not pop the
  // suggestion panel over the document — committing there would also corrupt
  // the link (insert would leave the old `]]` tail behind). Only a genuinely
  // unclosed `[[query` counts.
  const textAfter = parent.textBetween($from.parentOffset, parent.content.size, '\0', '\0');
  if (/^[^[\]]*\]\]/.test(textAfter)) return null;
  return { from: $from.pos - m[1].length - 2, to: $from.pos, query: m[1] };
}

function commitItem(view: EditorView, item: WikilinkItem): void {
  const ps = wikilinkKey.getState(view.state);
  if (!ps?.match) return;
  // Insert the alias form `[[slug|Title]]` whenever the human title differs
  // from the slug, so rendered links show the title instead of a raw slug.
  // The round-trip already preserves `|label` and the live-preview decoration
  // dims the `slug|` prefix (outlinerWikilinkView.ts). Titles containing the
  // wikilink-breaking chars `]` or `|` fall back to the bare-slug form.
  const title = (item.title || '').trim();
  const aliasSafe = title && title !== item.slug && !/[\]|[]/.test(title);
  const text = aliasSafe ? `[[${item.slug}|${title}]]` : `[[${item.slug}]]`;
  const tr = view.state.tr.insertText(text, ps.match.from, ps.match.to);
  tr.setSelection(TextSelection.create(tr.doc, ps.match.from + text.length));
  view.dispatch(tr);
  view.focus();
}

function createWikilinkPlugin(): Plugin<WikilinkState> {
  // ---- view-side closure state (popup DOM, items, fetch machinery) ----------
  let items: WikilinkItem[] = [];
  let activeIndex = 0;
  let lastQuery: string | null = null;
  let debounceTimer: number | null = null;
  let abort: AbortController | null = null;
  let popup: HTMLDivElement | null = null;
  let viewRef: EditorView | null = null;

  const popupId = `wb-wikilink-${Math.random().toString(36).slice(2, 8)}`;

  const ensurePopup = (): HTMLDivElement => {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.className = 'wb-wikilink-popup';
    popup.id = popupId;
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', 'Wikilink suggestions');
    popup.hidden = true;
    document.body.appendChild(popup);
    return popup;
  };

  const hidePopup = () => {
    if (popup) popup.hidden = true;
    if (viewRef) viewRef.dom.removeAttribute('aria-activedescendant');
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    abort?.abort();
    abort = null;
    lastQuery = null;
    items = [];
    activeIndex = 0;
  };

  const render = () => {
    const el = ensurePopup();
    el.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wb-wikilink-empty';
      empty.textContent = lastQuery ? 'No matching notes' : 'Type to search notes…';
      el.appendChild(empty);
      viewRef?.dom.removeAttribute('aria-activedescendant');
      return;
    }
    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wb-wikilink-item';
      btn.id = `${popupId}-opt-${i}`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      const title = document.createElement('span');
      title.className = 'wb-wikilink-title';
      title.textContent = item.title || item.slug;
      btn.appendChild(title);
      if (item.label) {
        const label = document.createElement('span');
        label.className = 'wb-wikilink-type';
        label.textContent = item.label;
        btn.appendChild(label);
      }
      // mousedown (not click) so the editor never loses focus mid-commit.
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (viewRef) commitItem(viewRef, item);
      });
      el.appendChild(btn);
    });
    viewRef?.dom.setAttribute('aria-activedescendant', `${popupId}-opt-${activeIndex}`);
    const active = el.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView?.({ block: 'nearest' });
  };

  const position = (view: EditorView, match: WikilinkMatch) => {
    const el = ensurePopup();
    const coords = view.coordsAtPos(Math.min(match.from, view.state.doc.content.size));
    el.hidden = false;
    // First place it, then clamp to the viewport once it has a size.
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = coords.left;
    let top = coords.bottom + 4;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, coords.top - h - 4);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  const scheduleFetch = (query: string) => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      abort?.abort();
      const ctl = new AbortController();
      abort = ctl;
      fetch(`/api/cockpit/search?q=${encodeURIComponent(query)}&limit=${MAX_ITEMS}`, {
        credentials: 'same-origin',
        signal: ctl.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ items?: WikilinkItem[] }>) : { items: [] }))
        .then((data) => {
          if (ctl.signal.aborted) return;
          items = (data.items ?? []).slice(0, MAX_ITEMS);
          activeIndex = 0;
          render();
          // Re-position after content changes (height may have changed).
          const ps = viewRef ? wikilinkKey.getState(viewRef.state) : null;
          if (viewRef && ps?.match) position(viewRef, ps.match);
        })
        .catch(() => {
          /* network/abort — keep whatever is shown; never throw into the editor */
        });
    }, DEBOUNCE_MS);
  };

  return new Plugin<WikilinkState>({
    key: wikilinkKey,
    state: {
      init: () => ({ match: null, dismissedFrom: null }),
      apply: (tr, value, _old, newState) => {
        const match = findMatch(newState);
        let dismissedFrom = value.dismissedFrom;
        const meta = tr.getMeta(wikilinkKey) as { dismiss?: true } | undefined;
        if (meta?.dismiss && match) dismissedFrom = match.from;
        // A dismissal only holds while the SAME trigger anchor is live.
        if (!match || (dismissedFrom !== null && dismissedFrom !== match.from)) {
          dismissedFrom = meta?.dismiss && match ? match.from : null;
        }
        return { match, dismissedFrom };
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (!isWikilinkActive(view.state)) return false;
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        switch (event.key) {
          case 'ArrowDown':
            if (!items.length) return false;
            activeIndex = (activeIndex + 1) % items.length;
            render();
            return true;
          case 'ArrowUp':
            if (!items.length) return false;
            activeIndex = (activeIndex - 1 + items.length) % items.length;
            render();
            return true;
          case 'Enter':
          case 'Tab': {
            const item = items[activeIndex];
            if (!item) return false; // nothing to commit → let the key act normally
            commitItem(view, item);
            return true;
          }
          case 'Escape':
            view.dispatch(view.state.tr.setMeta(wikilinkKey, { dismiss: true }));
            return true;
          default:
            return false;
        }
      },
    },
    view(editorView) {
      viewRef = editorView;
      return {
        update(view) {
          viewRef = view;
          const ps = wikilinkKey.getState(view.state);
          const active = !!ps?.match && ps.dismissedFrom !== ps.match.from;
          if (!active || !view.editable) {
            if (popup && !popup.hidden) hidePopup();
            return;
          }
          const match = ps!.match!;
          ensurePopup();
          if (match.query !== lastQuery) {
            lastQuery = match.query;
            scheduleFetch(match.query);
          }
          render();
          position(view, match);
        },
        destroy() {
          hidePopup();
          popup?.remove();
          popup = null;
          viewRef = null;
        },
      };
    },
  });
}

// The TipTap Extension wrapper.
export function WikilinkExtension(): Extension {
  return Extension.create({
    name: 'wikilinkSuggest',
    addProseMirrorPlugins() {
      return [createWikilinkPlugin()];
    },
  });
}
