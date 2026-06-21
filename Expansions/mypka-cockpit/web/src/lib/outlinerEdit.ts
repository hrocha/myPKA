// outlinerEdit.ts — keyboard EDIT semantics for the constrained bullet outliner.
//
// SOURCE OF TRUTH: Pax's decision table
// (Deliverables/2026-06-09_outliner-edit-semantics-research.md). This module
// implements Enter / Backspace / Delete so they match canonical outliners
// (Workflowy / Tana / Logseq / Roam), replacing TipTap's default splitListItem /
// joinBackward — those defaults produce the "Enter steals children" bug
// (Tom 2026-06-09) because they ignore the node's collapsed state and re-parent
// the trailing child bulletList onto the newly-created node.
//
// THE GOVERNING RULE (Pax §summary, rec 2): a newly-created node is ALWAYS born
// empty-and-childless. No structural op re-parents an existing node's children to
// a new node. Every op consults collapsed state (the per-node `collapsed` attr —
// the SAME source the decoration + caret-skip read) before deciding placement.
//
// Each handler returns a ProseMirror command (state, dispatch) => boolean and
// performs its work in ONE transaction so undo is atomic and the structural
// markdown round-trip (workbenchMarkdown walks the tree) stays correct. Tab /
// Shift-Tab edge cases are left to ListKeymap (sink/lift already match rows
// 5a–5d); we only guard the zoom-boundary outdent (in OutlinerEditor). The two
// product-decision rows (Pax row 2: mid-split → FIRST half keeps the children;
// Pax row 6b: first-child Backspace → MERGE into parent) are taken as the
// recommended defaults and noted at their call sites.
//
// DOCUMENT MODE (2026-06-11): these semantics apply ONLY while the caret is
// inside a listItem — outside a list every handler returns false and ProseMirror's
// document defaults run. Two extras live here because they share the helpers:
// Enter at the end of a DOC-LEVEL heading inserts a plain paragraph below
// (Obsidian behavior), and Backspace at the start of ANY heading demotes it to a
// paragraph before any merge runs.

import { TextSelection } from '@tiptap/pm/state';
import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { liftListItem } from '@tiptap/pm/schema-list';

// ---- shared structural helpers --------------------------------------------

interface ItemContext {
  /** depth (in $from.path terms) of the enclosing listItem. */
  depth: number;
  /** doc position just before the listItem node. */
  pos: number;
  /** the listItem node itself. */
  node: PMNode;
  /** the listItem's OWN textblock (its first child — a paragraph OR a heading). */
  paragraph: PMNode;
  /** depth of that textblock (itemDepth + 1). */
  paragraphDepth: number;
  /** the child bulletList node, if this item has one (always its last child). */
  childList: PMNode | null;
  /** true when the item carries collapsed=true (only meaningful with childList). */
  collapsed: boolean;
}

/** True for the node types a listItem may carry as its OWN textblock. The
 *  constrained schema allows '(paragraph | heading) block*' — every structural
 *  rule below treats both identically (a heading is a visual register, not a
 *  different outline shape). */
function isOwnTextblock(node: PMNode): boolean {
  return node.type.name === 'paragraph' || node.type.name === 'heading';
}

/** True for the list-container node types a listItem may nest. */
function isListContainer(node: PMNode): boolean {
  return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

/** Resolve the innermost listItem enclosing the caret, plus its structural facts. */
function itemAt($from: ResolvedPos): ItemContext | null {
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'listItem') {
      const node = $from.node(d);
      let paragraph: PMNode | null = null;
      let childList: PMNode | null = null;
      node.forEach((child) => {
        if (isOwnTextblock(child) && !paragraph) paragraph = child;
        if (isListContainer(child)) childList = child;
      });
      if (!paragraph) return null;
      return {
        depth: d,
        pos: $from.before(d),
        node,
        paragraph,
        paragraphDepth: d + 1,
        childList,
        collapsed: node.attrs.collapsed === true,
      };
    }
  }
  return null;
}

/** Doc position just inside the item's child bulletList (before its first item),
 *  or -1 if the item has no child list. */
function childListInnerStart(ctx: ItemContext): number {
  if (!ctx.childList) return -1;
  let listPos = -1;
  ctx.node.forEach((child, offset) => {
    if (isListContainer(child)) listPos = ctx.pos + 1 + offset;
  });
  return listPos === -1 ? -1 : listPos + 1; // +1 = inside the bulletList, before item 0
}

/** Build an empty listItem (one empty paragraph) for the schema. */
function emptyItem(state: EditorState): PMNode {
  const { listItem, paragraph } = state.schema.nodes;
  return listItem.create(null, paragraph.create());
}

/** Set the caret inside the textblock nearest `pos`, scroll into view. */
function caretTo(tr: Transaction, pos: number): Transaction {
  const clamped = Math.max(0, Math.min(pos, tr.doc.content.size));
  return tr.setSelection(TextSelection.near(tr.doc.resolve(clamped))).scrollIntoView();
}

// ---- ENTER ----------------------------------------------------------------
//
// Implements Pax rows 1a/1b/1c, 2/2-alt, 3a/3b, 4. Branches in order on:
//   (1) caret position within the paragraph (start / middle / end),
//   (2) whether the item has children, and
//   (3) whether those children are collapsed.
// Returns true when handled (caller preventDefaults + stops ListKeymap); false to
// defer to the default split (only the truly-leaf END case, which the default
// already gets right — a new empty sibling below).

export const outlinerEnter: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty) return false; // ranged selection → let default delete+split run
  const { $from } = selection;
  const ctx = itemAt($from);
  if (!ctx) {
    // Not inside a list. ONE document-mode rule lives here: Enter at the END of
    // a heading exits the heading register — the next line is a plain paragraph
    // (Obsidian behavior; the PM default split would clone the heading type).
    if (
      $from.parent.type.name === 'heading' &&
      $from.parentOffset === $from.parent.content.size
    ) {
      if (!dispatch) return true;
      const after = $from.after();
      const tr = state.tr.insert(after, state.schema.nodes.paragraph.create());
      caretTo(tr, after + 1);
      dispatch(tr);
      return true;
    }
    return false; // every other document edit uses ProseMirror's defaults
  }

  const atStart = $from.parentOffset === 0;
  const atEnd = $from.parentOffset === ctx.paragraph.content.size;
  const hasChildren = ctx.childList !== null;

  // ---- Row 4: Enter on an EMPTY bullet → OUTDENT (Workflowy/Roam default) ----
  // Empty = no own text. At top level there's nothing to outdent to → no-op
  // (defer false so the caret stays; the default split on an empty top-level
  // bullet would just make another empty bullet, which we suppress by handling
  // it as a true no-op). A childless empty bullet outdents; an empty bullet WITH
  // children also outdents (the children travel with it — liftListItem moves the
  // whole subtree, Pax row 4 "children move with the node").
  if (ctx.paragraph.content.size === 0) {
    // Outdent the empty bullet one level (Workflowy/Roam/Obsidian default). We
    // delegate to ProseMirror's own liftListItem (the same op Shift-Tab uses) so
    // the now-empty parent child list is cleaned up correctly and the item's own
    // subtree travels intact — in ONE transaction. At the TOP level of a list,
    // liftListItem lifts the content OUT of the list entirely (document mode:
    // Enter on an empty top-level bullet exits the list into a paragraph).
    return liftListItem(ctx.node.type)(state, dispatch);
  }

  // ---- Row 3a/3b: caret at START of non-empty text → empty sibling ABOVE ----
  // The original (with its children, collapsed flag, images) moves down intact;
  // caret stays with the original text on the lower line. We insert an empty
  // listItem immediately BEFORE this item at the same level.
  if (atStart) {
    if (!dispatch) return true;
    const tr = state.tr;
    tr.insert(ctx.pos, emptyItem(state));
    // Caret follows the ORIGINAL text, now pushed one item down. The original
    // item start shifted by the inserted node's size; its paragraph inner start
    // is original-pos + insertedSize + 1 (into listItem) + 1 (into paragraph).
    const insertedSize = emptyItem(state).nodeSize;
    caretTo(tr, ctx.pos + insertedSize + 2);
    dispatch(tr);
    return true;
  }

  // ---- Row 1a: caret at END, NO children → new empty sibling below ----------
  // For a PARAGRAPH bullet the default splitListItem already does exactly this,
  // so defer (preserves PM's column/marks behavior). For a HEADING bullet the
  // default would clone the heading register onto the new row — insert a plain
  // empty paragraph sibling instead (the `#` prefix stays with its line).
  if (atEnd && !hasChildren) {
    if (ctx.paragraph.type.name !== 'heading') return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const insertAt = ctx.pos + ctx.node.nodeSize;
    tr.insert(insertAt, emptyItem(state));
    caretTo(tr, insertAt + 2);
    dispatch(tr);
    return true;
  }

  // ---- Row 1b: caret at END, EXPANDED children → new empty FIRST child -------
  // Children visibly stay under the original; the new empty node is inserted as
  // the first item of the existing child bulletList (caret lands there, ABOVE the
  // existing children). NEVER re-parent the existing children (Pax rule).
  if (atEnd && hasChildren && !ctx.collapsed) {
    if (!dispatch) return true;
    const insertAt = childListInnerStart(ctx);
    if (insertAt < 0) return false;
    const tr = state.tr;
    tr.insert(insertAt, emptyItem(state));
    caretTo(tr, insertAt + 2); // into new listItem → into its paragraph
    dispatch(tr);
    return true;
  }

  // ---- Row 1c: caret at END, COLLAPSED children → new empty sibling BELOW ----
  // THIS FIXES THE REPORTED BUG. The children STAY tucked (collapsed) under the
  // original; the new empty node is a sibling AFTER this item, at the same level.
  // Insert just after the item's closing token (ctx.pos + nodeSize).
  if (atEnd && hasChildren && ctx.collapsed) {
    if (!dispatch) return true;
    const tr = state.tr;
    const insertAt = ctx.pos + ctx.node.nodeSize;
    tr.insert(insertAt, emptyItem(state));
    caretTo(tr, insertAt + 2);
    dispatch(tr);
    return true;
  }

  // ---- Rows 2 / 2-alt: caret in the MIDDLE → SPLIT --------------------------
  // PRODUCT DECISION (Pax row 2): the FIRST/UPPER half keeps the children. The
  // text after the caret becomes a NEW node; caret lands at the start of that new
  // node. Placement of the new (second-half) node mirrors the END rules:
  //   - expanded children  → new node is the FIRST CHILD (second half sits above
  //                           the kept children, which stay under the first half).
  //   - collapsed children → new node is a SIBLING below (children stay folded
  //                           under the first half).
  //   - no children        → new node is a SIBLING below.
  // In every case the existing child bulletList is NOT moved — it stays attached
  // to the original (first-half) item.
  if (!dispatch) return true;
  return splitKeepingChildren(state, dispatch, ctx, $from);
};

// Mid-text split that KEEPS the children with the first half (Pax row 2 product
// default). We do NOT use ProseMirror's splitListItem (which would split the
// listItem and carry the trailing child bulletList to the new item — the bug). We
// instead: (a) compute the inline content AFTER the caret, (b) remove it from the
// original paragraph, (c) create a new empty-paragraph listItem carrying that
// inline content, (d) place it per the END-rule branch (child if expanded, sibling
// if collapsed/none), (e) caret at the new node's start. The original keeps its
// child bulletList untouched.
function splitKeepingChildren(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  ctx: ItemContext,
  $from: ResolvedPos
): boolean {
  const { paragraph } = state.schema.nodes;
  const listItemType = state.schema.nodes.listItem;

  // The caret's paragraph spans [paraStart, paraEnd] (inner content positions).
  // paraStart = position just inside the paragraph; the caret is at $from.pos.
  const paraInnerStart = $from.start(ctx.paragraphDepth);
  const paraInnerEnd = $from.end(ctx.paragraphDepth);
  const cut = $from.pos;

  // Inline content after the caret → becomes the new node's text. The new node
  // is ALWAYS a plain paragraph — splitting a heading mid-text keeps the heading
  // register on the first half only (Logseq behavior: the `#` prefix stays with
  // the line it was typed on).
  const tailSlice = ctx.paragraph.cut(cut - paraInnerStart, paraInnerEnd - paraInnerStart);
  const newParagraph = paragraph.create(null, tailSlice.content);
  const newItem = listItemType.create(null, newParagraph);

  const tr = state.tr;
  // (b) Remove the tail from the original paragraph FIRST (positions below the cut
  // are unaffected by this deletion since they're earlier in the doc... but the
  // child-list insert point is AFTER, so do the delete, then map the insert pos).
  tr.delete(cut, paraInnerEnd);

  const hasChildren = ctx.childList !== null;
  if (hasChildren && !ctx.collapsed) {
    // New node = first child (row 2 expanded). Insert at the child list inner start.
    const insertAt = tr.mapping.map(childListInnerStart(ctx));
    tr.insert(insertAt, newItem);
    caretTo(tr, insertAt + 1); // into the new listItem → its paragraph start
  } else {
    // New node = sibling below (row 2-alt collapsed, or no children).
    const insertAt = tr.mapping.map(ctx.pos + ctx.node.nodeSize);
    tr.insert(insertAt, newItem);
    caretTo(tr, insertAt + 1);
  }
  dispatch(tr);
  return true;
}

// ---- BACKSPACE at START ----------------------------------------------------
//
// Implements Pax rows 6a/6b/6c. Merge into the PREVIOUS node (Pax recommended
// default, including row 6b first-child → MERGE INTO PARENT). Guards the Logseq
// #9128 failure mode: a merge NEVER deletes a subtree — this item's children
// re-parent under the merge target.

export const outlinerBackspace: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0) return false; // only at the very start of the text

  // ---- Heading demote: Backspace at the START of a heading (doc-level OR
  // heading-bullet) reverts it to a paragraph (the inverse of the `# ` input
  // rule) BEFORE any merge runs — the first Backspace strips the visual
  // register, a second one then merges. This must live here (not in the node's
  // keymap) because the editor's keydown chain consumes Backspace-at-start for
  // the merge semantics ahead of plugin keymaps.
  if ($from.parent.type.name === 'heading') {
    if (!dispatch) return true;
    const paraType = state.schema.nodes.paragraph;
    // setBlockType converts every textblock touching [from, to]; the collapsed
    // caret position (inside the heading) addresses exactly this one block.
    dispatch(state.tr.setBlockType($from.pos, $from.pos, paraType));
    return true;
  }

  const ctx = itemAt($from);
  if (!ctx) return false; // not in a list → ProseMirror's document defaults

  // Index of this item among its siblings (in its parent bulletList).
  const listDepth = ctx.depth - 1; // the enclosing bulletList
  if (listDepth < 0) return false;
  const indexInList = $from.index(listDepth);

  if (indexInList > 0) {
    // ---- Row 6a: previous SIBLING exists → merge into it ----
    // Merge target = the previous sibling listItem. Its own paragraph gets this
    // item's text appended; this item's CHILDREN re-parent under the target (so a
    // collapsed/expanded subtree is preserved, never deleted — guards #9128).
    return mergeIntoPrevSibling(state, dispatch, ctx, $from, listDepth);
  }

  // ---- Row 6b: this is the FIRST CHILD → merge into PARENT (product default) ----
  // At the very top of the document (no parent listItem) there is nothing to merge
  // into → defer false so PM's default does nothing harmful at doc start.
  const parentDepth = ctx.depth - 2;
  if (parentDepth < 1 || $from.node(parentDepth).type.name !== 'listItem') {
    return false;
  }
  return mergeIntoParent(state, dispatch, ctx, $from, parentDepth);
};

// Merge this item's text + children into the PREVIOUS SIBLING (row 6a).
function mergeIntoPrevSibling(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  ctx: ItemContext,
  $from: ResolvedPos,
  listDepth: number
): boolean {
  if (!dispatch) return true;
  const listNode = $from.node(listDepth);
  const listStart = $from.start(listDepth);
  const indexInList = $from.index(listDepth);

  // Locate the previous sibling listItem (its position + node).
  let prevPos = listStart;
  for (let i = 0; i < indexInList - 1; i++) prevPos += listNode.child(i).nodeSize;
  const prevNode = listNode.child(indexInList - 1);
  const prevStart = prevPos; // doc position just before the previous listItem (merge target)

  // The previous item's OWN textblock + whether it already has a child list.
  let prevParagraph: PMNode | null = null;
  let prevChildList: PMNode | null = null;
  prevNode.forEach((child) => {
    if (isOwnTextblock(child) && !prevParagraph) prevParagraph = child;
    if (isListContainer(child)) prevChildList = child;
  });
  if (!prevParagraph) return false;
  const prevPara: PMNode = prevParagraph;

  const seamCol = prevPara.content.size; // caret lands here after the join

  // Build the merged previous item: prev textblock text + this item's text, then
  // prev's existing children FOLLOWED BY this item's children (preserve order so a
  // subtree is never lost — Logseq #9128 guard). The MERGE TARGET's textblock type
  // wins (merging into a heading keeps the heading; the source's register is lost,
  // matching Logseq/Obsidian join behavior).
  const { listItem } = state.schema.nodes;
  const mergedParaContent = prevPara.content.append(ctx.paragraph.content);
  const mergedParagraph = prevPara.type.create(prevPara.attrs, mergedParaContent);

  // Collect child items from prev's list and this item's list (if any).
  const prevChildren: PMNode[] = [];
  if (prevChildList) (prevChildList as PMNode).forEach((c) => prevChildren.push(c));
  const thisChildren: PMNode[] = [];
  if (ctx.childList) ctx.childList.forEach((c) => thisChildren.push(c));

  const mergedItemContent: PMNode[] = [mergedParagraph];
  const allChildren = prevChildren.concat(thisChildren);
  if (allChildren.length) {
    // The surviving child list keeps the TARGET's list kind (bullet/ordered).
    const listType = ((prevChildList ?? ctx.childList) as PMNode).type;
    mergedItemContent.push(listType.create(null, allChildren));
  }
  // Carry the previous item's attrs (collapsed state of the TARGET survives).
  const mergedItem = listItem.create(prevNode.attrs, mergedItemContent);

  // One transaction: replace [prevStart .. end-of-this-item] with the merged item.
  const tr = state.tr;
  const replaceFrom = prevStart;
  const replaceTo = ctx.pos + ctx.node.nodeSize;
  tr.replaceWith(replaceFrom, replaceTo, mergedItem);
  // Caret at the seam: prevStart + 1 (into merged listItem) + 1 (into paragraph)
  // + seamCol (offset where prev text ended).
  caretTo(tr, prevStart + 2 + seamCol);
  dispatch(tr);
  return true;
}

// Merge this (first-child) item's text + children into its PARENT (row 6b default).
// The parent's text gets this item's text appended; this item's children become
// the parent's children (appended after any existing parent children). The parent's
// remaining sibling children (this item's later siblings) are untouched.
function mergeIntoParent(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  ctx: ItemContext,
  $from: ResolvedPos,
  parentDepth: number
): boolean {
  if (!dispatch) return true;
  const parentNode = $from.node(parentDepth);
  const parentPos = $from.before(parentDepth);

  // Parent's own textblock + its child bulletList (which contains THIS item first).
  let parentParagraph: PMNode | null = null;
  let parentChildList: PMNode | null = null;
  parentNode.forEach((child) => {
    if (isOwnTextblock(child) && !parentParagraph) parentParagraph = child;
    if (isListContainer(child)) parentChildList = child;
  });
  if (!parentParagraph || !parentChildList) return false;
  const pPara: PMNode = parentParagraph;
  const pList: PMNode = parentChildList;

  const seamCol = pPara.content.size;

  const { listItem } = state.schema.nodes;
  // The merge TARGET's textblock type wins (a heading parent stays a heading).
  const mergedParagraph = pPara.type.create(pPara.attrs, pPara.content.append(ctx.paragraph.content));

  // Sibling items of THIS one (index 1..n in the parent's child list) stay as the
  // parent's children; THIS item's own children are PROMOTED in front of them
  // (Pax: children re-parent under the merged parent, subtree preserved — #9128).
  const siblings: PMNode[] = [];
  pList.forEach((c, _o, i) => { if (i > 0) siblings.push(c); });
  const thisChildren: PMNode[] = [];
  if (ctx.childList) ctx.childList.forEach((c) => thisChildren.push(c));

  const newParentContent: PMNode[] = [mergedParagraph];
  const remainingChildren = thisChildren.concat(siblings);
  if (remainingChildren.length) {
    // The parent's child list keeps its OWN kind (bullet/ordered).
    newParentContent.push((pList as PMNode).type.create((pList as PMNode).attrs, remainingChildren));
  }
  const mergedParent = listItem.create(parentNode.attrs, newParentContent);

  const tr = state.tr;
  tr.replaceWith(parentPos, parentPos + parentNode.nodeSize, mergedParent);
  caretTo(tr, parentPos + 2 + seamCol);
  dispatch(tr);
  return true;
}

// ---- DELETE at END ---------------------------------------------------------
//
// Implements Pax rows 7 / 7-bug. Merge the NEXT node up. Guards Logseq #9128: when
// the next node is a CHILD (expanded), merge only the FIRST child's text up and
// preserve the rest of the hierarchy — never delete the whole subtree.

export const outlinerDelete: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const ctx = itemAt($from);
  if (!ctx) return false;
  if ($from.parentOffset !== ctx.paragraph.content.size) return false; // only at END

  const hasChildren = ctx.childList !== null;

  if (hasChildren && !ctx.collapsed) {
    // ---- Row 7-bug: next visible node is this item's FIRST CHILD (expanded) ----
    // Merge the FIRST CHILD's text into this item; the first child's OWN children
    // (and this item's remaining children) are preserved (NEVER nuke the subtree).
    return mergeFirstChildUp(state, dispatch, ctx);
  }

  // ---- Row 7: next node is a SIBLING (or this is collapsed → next visible is the
  // following sibling) → merge that sibling's text up; its children re-parent here.
  return mergeNextSiblingUp(state, dispatch, ctx, $from);
};

// Row 7-bug: merge first child's text up; preserve the rest of the hierarchy.
function mergeFirstChildUp(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  ctx: ItemContext
): boolean {
  if (!dispatch) return true;
  if (!ctx.childList) return false;
  const list: PMNode = ctx.childList;
  if (list.childCount === 0) return false;
  const firstChild = list.child(0);
  let firstChildPara: PMNode | null = null;
  let firstChildList: PMNode | null = null;
  firstChild.forEach((c) => {
    if (isOwnTextblock(c) && !firstChildPara) firstChildPara = c;
    if (isListContainer(c)) firstChildList = c;
  });
  if (!firstChildPara) return false;
  const fcPara: PMNode = firstChildPara;

  const { listItem } = state.schema.nodes;
  const seamCol = ctx.paragraph.content.size;

  // This item's new textblock = own text + first child's text; THIS item's
  // textblock type wins (the merge target keeps its paragraph/heading register).
  const mergedParagraph = ctx.paragraph.type.create(ctx.paragraph.attrs, ctx.paragraph.content.append(fcPara.content));

  // The new child list = first child's OWN children (promoted up one level) FOLLOWED
  // BY the first child's later siblings. Nothing is deleted — full subtree preserved.
  const promoted: PMNode[] = [];
  if (firstChildList) (firstChildList as PMNode).forEach((c) => promoted.push(c));
  const laterSiblings: PMNode[] = [];
  list.forEach((c, _o, i) => { if (i > 0) laterSiblings.push(c); });

  const newContent: PMNode[] = [mergedParagraph];
  const newChildren = promoted.concat(laterSiblings);
  if (newChildren.length) newContent.push(list.type.create(list.attrs, newChildren));
  // Merging consumed the (former) first child; if no children remain the item is a
  // leaf now → drop the collapsed flag so a leaf never carries a stale fold state.
  const attrs = newChildren.length ? ctx.node.attrs : { ...ctx.node.attrs, collapsed: false };
  const mergedItem = listItem.create(attrs, newContent);

  const tr = state.tr;
  tr.replaceWith(ctx.pos, ctx.pos + ctx.node.nodeSize, mergedItem);
  caretTo(tr, ctx.pos + 2 + seamCol);
  dispatch(tr);
  return true;
}

// Row 7: merge the FOLLOWING SIBLING's text into this item; the sibling's children
// re-parent under this item (appended after this item's existing children).
function mergeNextSiblingUp(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  ctx: ItemContext,
  $from: ResolvedPos
): boolean {
  if (!dispatch) return true;
  const listDepth = ctx.depth - 1;
  if (listDepth < 0) return false;
  const listNode = $from.node(listDepth);
  const indexInList = $from.index(listDepth);
  if (indexInList >= listNode.childCount - 1) return false; // no following sibling → defer

  const nextNode = listNode.child(indexInList + 1);
  let nextPara: PMNode | null = null;
  let nextList: PMNode | null = null;
  nextNode.forEach((c) => {
    if (isOwnTextblock(c) && !nextPara) nextPara = c;
    if (isListContainer(c)) nextList = c;
  });
  if (!nextPara) return false;
  const nPara: PMNode = nextPara;

  const { listItem } = state.schema.nodes;
  const seamCol = ctx.paragraph.content.size;
  // THIS item's textblock type wins (the merge target keeps its register).
  const mergedParagraph = ctx.paragraph.type.create(ctx.paragraph.attrs, ctx.paragraph.content.append(nPara.content));

  // This item's existing children FOLLOWED BY the next sibling's children.
  const ownChildren: PMNode[] = [];
  if (ctx.childList) ctx.childList.forEach((c) => ownChildren.push(c));
  const nextChildren: PMNode[] = [];
  if (nextList) (nextList as PMNode).forEach((c) => nextChildren.push(c));

  const newContent: PMNode[] = [mergedParagraph];
  const allChildren = ownChildren.concat(nextChildren);
  if (allChildren.length) {
    // The surviving child list keeps THIS item's kind when it has one.
    const listType = ((ctx.childList ?? nextList) as PMNode).type;
    newContent.push(listType.create(null, allChildren));
  }
  const mergedItem = listItem.create(ctx.node.attrs, newContent);

  // Replace [this item start .. next item end] with the merged item.
  const nextEnd = ctx.pos + ctx.node.nodeSize + nextNode.nodeSize;
  const tr = state.tr;
  tr.replaceWith(ctx.pos, nextEnd, mergedItem);
  caretTo(tr, ctx.pos + 2 + seamCol);
  dispatch(tr);
  return true;
};
