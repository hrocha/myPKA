// outlinerAria.ts — ARIA tree semantics for the outliner (accessibility, plan §
// "Accessibility"; Vera's P6 gate verifies, this builds it now so it's not a
// rebuild).
//
// ProseMirror renders a plain <ul><li> tree with NO tree semantics. A screen
// reader hears "list, N items" — it cannot announce nesting level, that a branch
// is collapsible, or its expanded state. This plugin layers the WAI-ARIA tree
// pattern onto the rendered nodes via Decorations:
//   - each TOP-LEVEL <ul>/<ol> (a direct doc child in document mode) gets
//     role="tree" + an aria-label.
//   - each <li> gets role="treeitem" + aria-level (1-based nesting depth).
//   - each nested <ul>/<ol> gets role="group".
//   - a collapsible <li> gets aria-expanded reflecting its collapsed attr.
//
// Note: a contentEditable tree is an INTERACTIVE editor, so we keep the editor's
// textbox semantics on the contentEditable host and layer treeitem roles on the
// list structure beneath — the keyboard model (Tab/Shift-Tab/Enter/arrows/Cmd+.)
// is the operability contract Vera checks; these roles make the STRUCTURE legible.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';

export const ariaPluginKey = new PluginKey('outlinerAria');

function buildAriaDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      // Document mode: a TOP-LEVEL list (a direct doc child) is its own ARIA
      // tree; every nested list is a group within it.
      const isTopLevel = state.doc.resolve(pos).depth === 0;
      decos.push(
        Decoration.node(
          pos,
          pos + node.nodeSize,
          isTopLevel ? { role: 'tree', 'aria-label': 'Outline' } : { role: 'group' }
        )
      );
    }
    if (node.type.name === 'listItem') {
      const $pos = state.doc.resolve(pos + 1);
      let level = 0;
      for (let d = $pos.depth; d >= 0; d--) {
        const name = $pos.node(d).type.name;
        if (name === 'bulletList' || name === 'orderedList') level++;
      }
      let hasChildren = false;
      node.forEach((child) => {
        if (child.type.name === 'bulletList' || child.type.name === 'orderedList') hasChildren = true;
      });
      const attrs: Record<string, string> = {
        role: 'treeitem',
        'aria-level': String(Math.max(1, level)),
      };
      if (hasChildren) {
        attrs['aria-expanded'] = node.attrs.collapsed === true ? 'false' : 'true';
      }
      decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    }
    return true;
  });

  return DecorationSet.create(state.doc, decos);
}

export function createAriaPlugin(): Plugin {
  return new Plugin({
    key: ariaPluginKey,
    state: {
      init: (_c, state) => buildAriaDecorations(state),
      apply: (tr, old, _o, newState) =>
        tr.docChanged || tr.getMeta('outlinerCollapse') ? buildAriaDecorations(newState) : old,
    },
    props: {
      decorations(state) {
        return this.getState(state) ?? null;
      },
    },
  });
}
