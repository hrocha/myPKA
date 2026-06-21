// outlinerReorder.ts — move a bullet's whole SUBTREE up/down among its siblings
// inside ONE ProseMirror transaction (P5, Vivi Spec 2 §2.6 keyboard path; also the
// commit the drag-handle uses on drop).
//
// Why one transaction: undo must restore the whole move in a single step, and the
// markdown serializer must see a consistent tree — a multi-step move would corrupt
// both (plan §5 "moves whole subtrees inside ONE PM transaction").
//
// This is the WCAG-required keyboard alternative to drag (drag-only fails 2.1.1).
// It is MOTIONLESS by contract (§2.6) — the row simply appears in its new slot;
// the drag choreography state machine is never entered.

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

interface ListItemContext {
  pos: number; // start position of the listItem node
  node: PMNode;
  parentPos: number; // start position of the parent bulletList
  index: number; // index of this listItem within the parent bulletList
  parent: PMNode;
}

// Resolve the listItem that currently contains the selection head.
function listItemAtSelection(editor: Editor): ListItemContext | null {
  const { state } = editor;
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'listItem') {
      const pos = $from.before(depth);
      const parent = $from.node(depth - 1); // the containing list (bullet or ordered)
      if (parent.type.name !== 'bulletList' && parent.type.name !== 'orderedList') return null;
      const parentPos = $from.before(depth - 1);
      const index = $from.index(depth - 1);
      return { pos, node, parentPos, index, parent };
    }
  }
  return null;
}

// Move the focused subtree one slot in `direction` (-1 up, +1 down) among its
// siblings. Returns true if a move happened. Re-establishes the caret inside the
// moved item so focus stays put (§2.6: focus stays on the moved subtree's root).
export function moveListItem(editor: Editor, direction: -1 | 1): boolean {
  const ctx = listItemAtSelection(editor);
  if (!ctx) return false;
  const target = ctx.index + direction;
  if (target < 0 || target >= ctx.parent.childCount) return false; // at an edge

  const { state, view } = editor;
  const { tr } = state;
  const item = ctx.node;
  const itemSize = item.nodeSize;

  // Caret offset within the item so we can restore it after the move.
  const caretOffsetInItem = state.selection.from - (ctx.pos + 1);

  // Delete the item from its current slot, then insert before/after its sibling.
  // Compute the sibling's position relative to the parent bulletList start.
  // Parent content starts at parentPos + 1.
  const parentContentStart = ctx.parentPos + 1;

  // Sum sizes of siblings before `index` to locate the item, and before `target`.
  let offsetToItem = 0;
  for (let i = 0; i < ctx.index; i++) offsetToItem += ctx.parent.child(i).nodeSize;
  const itemStart = parentContentStart + offsetToItem;

  // Delete the item first.
  tr.delete(itemStart, itemStart + itemSize);

  // After deletion, recompute the insertion point in the mutated doc.
  let offsetToTarget = 0;
  const upperBound = direction === 1 ? target + 1 : target; // insert AFTER target when moving down
  for (let i = 0; i < upperBound; i++) {
    if (i === ctx.index) continue; // the removed item no longer counts
    offsetToTarget += ctx.parent.child(i).nodeSize;
  }
  const insertPos = parentContentStart + offsetToTarget;

  tr.insert(insertPos, item);

  // Restore the caret inside the moved item.
  const newCaret = insertPos + 1 + Math.max(0, Math.min(caretOffsetInItem, item.content.size));
  try {
    tr.setSelection(TextSelection.create(tr.doc, newCaret));
  } catch {
    /* if the computed caret is out of range, leave PM's default mapping */
  }
  tr.scrollIntoView();

  view.dispatch(tr);
  view.focus();
  return true;
}
