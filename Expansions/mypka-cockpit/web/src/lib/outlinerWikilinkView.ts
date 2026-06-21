// outlinerWikilinkView.ts — Obsidian-live-preview rendering for [[wikilinks]]
// in the document editor (2026-06-11).
//
// PURE DECORATIONS, never a node: the doc keeps the raw `[[slug]]` text, so the
// markdown round-trip is untouched by construction (workbenchMarkdown never sees
// anything new). The plugin scans visible text nodes for `[[target]]` /
// `[[target|label]]` and layers inline decorations:
//
//   [[          -> .wb-wl-bracket   (HIDDEN in preview — display:none via CSS)
//   target|     -> .wb-wl-prefix    (HIDDEN in preview; only in the piped form)
//   label/slug  -> .wb-wl-target    (brass link styling, hover underline, pointer)
//   ]]          -> .wb-wl-bracket
//
// PREVIEW vs EDITING (Obsidian live preview): when the caret does NOT touch the
// link's range, the syntax parts (`[[`, `]]`, `slug|`) are hidden entirely
// (cockpit.css sets display:none on .wb-wl-bracket/.wb-wl-prefix without
// .is-editing) — Tom sees just "Dr. Schmidt" styled as a link. When the caret
// (or any selection end) touches the range every part gets `.is-editing` and
// the raw text reveals for editing. The doc text itself never changes — hiding
// is pure CSS on decoration spans, so positions/round-trip stay exact.
// Skipped contexts: code blocks (node.type.spec.code) and inline `code`-marked
// text; `![[...]]` embeds (preceding `!`) are not links and stay undecorated.
//
// CLICK: in PREVIEW state a plain left mousedown on the rendered target opens
// the host panel (onLinkClick) and preventDefaults — the caret never enters the
// link, so the `[[` autocomplete can never misfire from a click. In EDITING
// state (syntax revealed) clicks are left alone: they place the caret normally.
// Modified clicks (meta/ctrl/alt/shift) always fall through to native behavior.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

export const wikilinkViewKey = new PluginKey<DecorationSet>('wikilinkView');

const LINK_RE = /\[\[([^[\]]+?)\]\]/g;
const TARGET_ATTR = 'data-wb-wl-target';

/** Slugify a wikilink target the same way WikiMarkdown / the server resolver
 *  expect: drop a `|label` tail, drop a `#heading` anchor, keep the last path
 *  segment, lowercase, spaces -> dashes. */
export function wikilinkTargetToSlug(raw: string): string {
  let t = raw.split('|')[0];
  t = t.split('#')[0];
  const last = t.split(/[/\\]/).pop() ?? t;
  return last.trim().toLowerCase().replace(/\s+/g, '-');
}

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;

  state.doc.descendants((node: PMNode, pos: number) => {
    // Never decorate inside code blocks; don't descend into them either.
    if (node.isTextblock && node.type.spec.code) return false;
    if (!node.isText || !node.text) return true;
    // Inline code mark — raw text stays raw.
    if (node.marks.some((m) => m.type.name === 'code')) return true;

    const text = node.text;
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(text)) !== null) {
      // `![[...]]` is an embed, not a link — leave it undecorated.
      if (m.index > 0 && text[m.index - 1] === '!') continue;

      const start = pos + m.index;
      const end = start + m[0].length;
      const inner = m[1];
      // Caret (or any selection end) inside the link -> editing mode: full raw
      // visibility. Inclusive bounds so landing right at `[[`/`]]` counts.
      const editing = selFrom <= end && selTo >= start;
      const edit = editing ? ' is-editing' : '';

      decos.push(Decoration.inline(start, start + 2, { class: `wb-wl-bracket${edit}` }));

      const pipe = inner.indexOf('|');
      if (pipe !== -1) {
        // [[target|label]] — dim the `target|`, emphasize the label.
        const prefixEnd = start + 2 + pipe + 1;
        decos.push(Decoration.inline(start + 2, prefixEnd, { class: `wb-wl-prefix${edit}` }));
        decos.push(
          Decoration.inline(prefixEnd, end - 2, {
            class: `wb-wl-target${edit}`,
            [TARGET_ATTR]: wikilinkTargetToSlug(inner),
          })
        );
      } else {
        decos.push(
          Decoration.inline(start + 2, end - 2, {
            class: `wb-wl-target${edit}`,
            [TARGET_ATTR]: wikilinkTargetToSlug(inner),
          })
        );
      }

      decos.push(Decoration.inline(end - 2, end, { class: `wb-wl-bracket${edit}` }));
    }
    return true;
  });

  return DecorationSet.create(state.doc, decos);
}

/** Live-preview wikilink rendering + click-to-preview. `onLinkClick` receives
 *  the slugified target; the host opens its context panel. The callback should
 *  be REF-STABLE (the extension is created once per editor instance). */
export function WikilinkViewExtension(onLinkClick: (slug: string) => void): Extension {
  return Extension.create({
    name: 'wikilinkView',
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: wikilinkViewKey,
          state: {
            init: (_config, state) => buildDecorations(state),
            apply: (tr, value, _old, newState) =>
              // Rebuild on doc OR selection change (the editing-state class
              // tracks the caret). Both fire on every keystroke anyway; a full
              // rescan of a note-sized doc is cheap and always correct.
              tr.docChanged || tr.selectionSet ? buildDecorations(newState) : value,
          },
          props: {
            decorations(state) {
              return wikilinkViewKey.getState(state);
            },
            handleDOMEvents: {
              mousedown(_view, event) {
                if (event.button !== 0) return false;
                if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
                const el = (event.target as HTMLElement | null)?.closest?.(`[${TARGET_ATTR}]`);
                if (!el) return false;
                // Syntax revealed (caret already inside the link) → editing
                // mode: clicks place the caret normally, never hijacked.
                if (el.classList.contains('is-editing')) return false;
                const slug = el.getAttribute(TARGET_ATTR);
                if (!slug) return false;
                // Preview state: open the panel and CONSUME the event — the
                // caret must not enter the hidden-syntax link (entering it
                // would reveal the raw text and previously misfired the `[[`
                // autocomplete popup over the document).
                event.preventDefault();
                onLinkClick(slug);
                return true;
              },
            },
          },
        }),
      ];
    },
  });
}
