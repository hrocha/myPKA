// outlinerCollapse.ts — collapse/expand for the outliner (P4, Vivi Spec 1).
//
// TWO concerns, kept separate:
//   1. PERSISTENCE — collapse state is EPHEMERAL view state, NEVER written to
//      markdown/disk (plan §4 / motion-spec §1.1). It lives in localStorage keyed
//      by file path + a content-path ("0.2.1" = root[0] > child[2] > child[1]). On
//      a path mismatch (Tom hand-edited the .md outside the cockpit and the tree
//      shifted) we render EXPANDED — the safe default, no data loss, no sidecar.
//   2. DECORATION — a ProseMirror plugin that (a) hides the child bulletList of a
//      collapsed listItem and (b) marks rows that HAVE children so the chevron and
//      ARIA aria-expanded render only where a fold is meaningful.
//
// The motion (chevron rotate + CSS Grid 0fr→1fr reveal) is pure CSS keyed off the
// `data-collapsed` / `data-has-children` attrs — see cockpit.css §outliner. The
// decoration's job is correctness (which rows fold, hiding descendants); the feel
// is CSS, which makes it interruptible and reduced-motion-safe for free.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createAriaPlugin } from './outlinerAria';

// Document mode: a list item's child list may be a bulletList OR an orderedList.
export function isListNodeName(name: string): boolean {
  return name === 'bulletList' || name === 'orderedList';
}

// ---- localStorage persistence (content-path keyed) ------------------------

const STORE_PREFIX = 'mypka-workbench-collapsed:';

// A content-path like "0.2.1": the index chain from root through listItems.
type CollapseMap = Record<string, true>;

function storeKey(filePath: string): string {
  return STORE_PREFIX + filePath;
}

export function readCollapseMap(filePath: string): CollapseMap {
  try {
    const raw = localStorage.getItem(storeKey(filePath));
    return raw ? (JSON.parse(raw) as CollapseMap) : {};
  } catch {
    return {};
  }
}

export function writeCollapseMap(filePath: string, map: CollapseMap): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(storeKey(filePath));
    else localStorage.setItem(storeKey(filePath), JSON.stringify(map));
  } catch {
    /* storage unavailable (private mode) — degrade to in-memory session only */
  }
}

// Walk the doc and produce the content-path for every listItem position. Used to
// (a) hydrate collapsed attrs from localStorage on load and (b) persist on toggle.
export function contentPathForPos(doc: PMNode, targetPos: number): string | null {
  let result: string | null = null;
  const walk = (node: PMNode, pos: number, path: number[]) => {
    let itemIndex = 0;
    node.forEach((child, offset) => {
      const childPos = pos + offset + 1;
      if (child.type.name === 'listItem') {
        const childPath = [...path, itemIndex];
        if (childPos === targetPos) result = childPath.join('.');
        walk(child, childPos, childPath);
        itemIndex++;
      } else {
        walk(child, childPos, path);
      }
    });
  };
  walk(doc, -1, []);
  return result;
}

// Build the full map of {contentPath -> pos} so a load can apply saved state.
export function collectListItems(doc: PMNode): { pos: number; path: string; hasChildren: boolean }[] {
  const out: { pos: number; path: string; hasChildren: boolean }[] = [];
  const walk = (node: PMNode, pos: number, path: number[]) => {
    let itemIndex = 0;
    node.forEach((child, offset) => {
      const childPos = pos + offset + 1;
      if (child.type.name === 'listItem') {
        const childPath = [...path, itemIndex];
        let hasChildren = false;
        child.forEach((gc) => {
          if (isListNodeName(gc.type.name)) hasChildren = true;
        });
        out.push({ pos: childPos, path: childPath.join('.'), hasChildren });
        walk(child, childPos, childPath);
        itemIndex++;
      } else {
        walk(child, childPos, path);
      }
    });
  };
  walk(doc, -1, []);
  return out;
}

// ---- Caret-skip over collapsed (hidden) subtrees --------------------------
//
// The collapse decoration clips a collapsed listItem's child bulletList with CSS
// `grid-template-rows:0fr; overflow:hidden` — visually `display:none`-equivalent,
// but ProseMirror's NATIVE vertical caret motion (ArrowUp/ArrowDown) still walks
// the document positions INSIDE that hidden subtree, so the caret visibly pauses
// on hidden lines before reaching the next visible row (Tom 2026-06-09 bug).
//
// Fix: compute the set of hidden ranges (the child bulletList of every collapsed
// listItem, at any depth) from the SAME source of truth the decoration uses (the
// `collapsed` attr), then on Arrow Up/Down move the caret to the next/previous
// VISIBLE textblock, jumping OVER any hidden range in one step.

export interface HiddenRange {
  from: number; // start of the hidden range (a collapsed child list, or a folded heading section)
  to: number; // end of the hidden range
}

// Every collapsed listItem hides its child bulletList. We only need the OUTERMOST
// collapsed ranges: a collapse nested inside an already-hidden subtree adds no new
// hidden positions (its parent already hid them). descendants() returning `false`
// on a collapsed item stops the walk into it, giving outermost ranges for free.
export function hiddenRanges(doc: PMNode, extra: HiddenRange[] = []): HiddenRange[] {
  const ranges: HiddenRange[] = [...extra];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return true;
    const collapsed = node.attrs.collapsed === true;
    if (collapsed) {
      // Find this item's child bulletList (the hidden subtree) and record it.
      node.forEach((child, offset) => {
        if (isListNodeName(child.type.name)) {
          const from = pos + 1 + offset; // +1 past the listItem open token
          ranges.push({ from, to: from + child.nodeSize });
        }
      });
      return false; // don't descend — nested collapses are already inside this range
    }
    return true;
  });
  return ranges;
}

function isPosInHiddenRange(pos: number, ranges: HiddenRange[]): HiddenRange | null {
  for (const r of ranges) {
    // A position strictly inside the hidden bulletList (its open token at `from`
    // up to its close at `to`) is hidden. We use (from, to) exclusive of the very
    // boundary so a caret legitimately sitting just before/after stays put.
    if (pos > r.from && pos < r.to) return r;
  }
  return null;
}

// Given the current head position and a direction, return the position of the
// next VISIBLE textblock caret target, skipping any hidden range. Returns null if
// there is no further visible textblock (caret should stay / let default run).
//
// We scan textblock-by-textblock using PMNode traversal rather than per-character
// stepping: collect every textblock's inner position, in document order, filter
// out the hidden ones, and pick the neighbour of the current row in `direction`.
export function nextVisibleCaretPos(
  doc: PMNode,
  headPos: number,
  direction: -1 | 1,
  extra: HiddenRange[] = []
): number | null {
  const ranges = hiddenRanges(doc, extra);

  // Collect visible textblock anchor positions (inner start of each paragraph),
  // in document order. A textblock whose position is inside a hidden range is
  // skipped entirely — that is the collapsed content we must not land on.
  const visible: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const inner = pos + 1; // inside the textblock
      if (!isPosInHiddenRange(inner, ranges)) visible.push(inner);
      return false; // textblocks have no block children we care about here
    }
    // Don't descend into hidden ranges at all — saves work on deep collapsed trees.
    if (isListNodeName(node.type.name)) {
      const start = pos + 1;
      if (isPosInHiddenRange(start, ranges)) return false;
    }
    return true;
  });

  if (visible.length === 0) return null;

  // Find the textblock the caret is currently in (the greatest visible anchor that
  // is <= headPos, i.e. the row's own paragraph start). Then step one in direction.
  let currentIdx = -1;
  for (let i = 0; i < visible.length; i++) {
    // The caret's textblock is the last visible anchor at or before headPos that
    // shares the same textblock (anchor <= headPos < nextAnchor handled by order).
    if (visible[i] <= headPos) currentIdx = i;
    else break;
  }
  if (currentIdx === -1) return null;

  const targetIdx = currentIdx + direction;
  if (targetIdx < 0 || targetIdx >= visible.length) return null;
  return visible[targetIdx];
}

// Should Arrow Up/Down be INTERCEPTED for caret-skip? Only when a hidden range
// sits between the caret's textblock and the next visible one — otherwise native
// PM motion is correct (and preserves its column memory, soft-wrap behaviour, and
// multi-line textblock stepping, which we must not break for expanded trees).
//
// Heuristic: there is a hidden range whose `from` lies between the caret's row and
// the next visible row in `direction`. For ArrowDown, that's a collapsed subtree
// immediately after the current row; for ArrowUp, immediately before the target.
// Returns the target caret pos (with a sensible column) to dispatch, or null to
// fall through to native handling.
export function caretSkipTarget(
  doc: PMNode,
  headPos: number,
  direction: -1 | 1,
  extra: HiddenRange[] = []
): number | null {
  const ranges = hiddenRanges(doc, extra);
  if (ranges.length === 0) return null;

  const target = nextVisibleCaretPos(doc, headPos, direction, extra);
  if (target === null) return null;

  // Is there a hidden range strictly between head and target? If the gap the caret
  // would traverse contains hidden positions, native motion would step through
  // them — that's the bug. If not, this is ordinary adjacent-row motion: defer.
  const lo = Math.min(headPos, target);
  const hi = Math.max(headPos, target);
  const crossesHidden = ranges.some((r) => r.from >= lo && r.from < hi);
  if (!crossesHidden) return null;

  // Land at a sensible column: keep the caret's offset within its current row,
  // clamped to the target row's length. $head.parentOffset is the column.
  const $head = doc.resolve(headPos);
  const col = $head.parentOffset;
  const $target = doc.resolve(target);
  const targetRowLen = $target.parent.content.size;
  return target + Math.max(0, Math.min(col, targetRowLen));
}

// Secondary case: Right/Left arrow at the END/START of a collapsed parent's line
// would otherwise enter its hidden children. Detect a caret AT a textblock edge
// where the next horizontal step crosses into a hidden range, and return the
// next/previous VISIBLE textblock edge to land on instead. null → defer to native.
//   direction 1 = ArrowRight (at end of row → start of next visible row)
//   direction -1 = ArrowLeft (at start of row → end of previous visible row)
export function horizontalSkipTarget(
  doc: PMNode,
  headPos: number,
  direction: -1 | 1,
  extra: HiddenRange[] = []
): number | null {
  const ranges = hiddenRanges(doc, extra);
  if (ranges.length === 0) return null;

  const $head = doc.resolve(headPos);
  // Only act at the textblock boundary in the travel direction. Right needs the
  // caret at end-of-row; Left needs it at start-of-row. Mid-row steps are native.
  const atEnd = $head.parentOffset === $head.parent.content.size;
  const atStart = $head.parentOffset === 0;
  if (direction === 1 && !atEnd) return null;
  if (direction === -1 && !atStart) return null;

  const target = nextVisibleCaretPos(doc, headPos, direction, extra);
  if (target === null) return null;

  // Confirm the step actually crosses a hidden range (a collapsed subtree sits
  // between this row and the visible neighbour). If not, native motion is fine.
  const lo = Math.min(headPos, target);
  const hi = Math.max(headPos, target);
  const crossesHidden = ranges.some((r) => r.from >= lo && r.from < hi);
  if (!crossesHidden) return null;

  // Right → land at the START of the next visible row; Left → END of previous.
  const $target = doc.resolve(target);
  return direction === 1 ? target : target + $target.parent.content.size;
}

// ---- The collapse decoration plugin ---------------------------------------

export const collapsePluginKey = new PluginKey('outlinerCollapse');

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return true;
    let hasChildren = false;
    node.forEach((child) => {
      if (isListNodeName(child.type.name)) hasChildren = true;
    });
    const collapsed = node.attrs.collapsed === true;
    // Node decoration carries the structural flags onto the rendered <li> so CSS
    // (chevron visibility, grid reveal) + the ARIA plugin read a single source.
    const attrs: Record<string, string> = {};
    if (hasChildren) attrs['data-has-children'] = 'true';
    if (collapsed && hasChildren) attrs['data-collapsed'] = 'true';
    if (Object.keys(attrs).length) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    }
    // When collapsed, descend no further into THIS item's subtree for decoration
    // purposes — the CSS grid-rows:0fr clips the child list; we do not unmount it
    // (motion-spec §1.3: one tween per toggle, descendants ride inside the parent).
    return !collapsed;
  });
  return DecorationSet.create(state.doc, decos);
}

function createCollapsePlugin(onToggle: (view: EditorView, pos: number) => void): Plugin {
  return new Plugin({
    key: collapsePluginKey,
    state: {
      init: (_config, state) => buildDecorations(state),
      apply: (tr, old, _oldState, newState) =>
        tr.docChanged || tr.getMeta('outlinerCollapse') ? buildDecorations(newState) : old,
    },
    props: {
      decorations(state) {
        return this.getState(state) ?? null;
      },
      // Bullet click toggles collapse. The chevron glyph was removed (Tom
      // 2026-06-09); the BULLET (a ::before pseudo in the row's left gutter) is
      // now the sole click affordance for folding. A pseudo-element can't receive
      // its own listener, so we hit-test the click X against the row's left edge:
      // a click anywhere in the gutter zone of a row that HAS children toggles it.
      handleClickOn(view, _pos, node, nodePos, event) {
        if (node.type.name !== 'listItem') return false;
        let hasChildren = false;
        node.forEach((c) => {
          if (isListNodeName(c.type.name)) hasChildren = true;
        });
        if (!hasChildren) return false;
        const target = event.target as HTMLElement;
        const li = target.closest('li');
        if (!li) return false;
        const rect = li.getBoundingClientRect();
        // Bullet hit zone: the gutter at the row's left edge, floored at 24px so
        // the click target meets WCAG 2.5.8 (H1). The bullet glyph stays ~5px but
        // the whole 24px+ gutter is clickable — the affordance, not just the dot.
        const gutterPx = Math.max(24, parseFloat(getComputedStyle(li).fontSize) * 1.5 || 24);
        if (event.clientX <= rect.left + gutterPx) {
          onToggle(view, nodePos);
          return true;
        }
        return false;
      },
    },
  });
}

// The TipTap Extension that bundles the collapse decoration + chevron-click + the
// ARIA tree decoration into one plugin pipeline entry. `filePath` is the slug used
// to persist collapse state to localStorage on every toggle.
export function CollapseAndAriaExtension(filePath: string): Extension {
  return Extension.create({
    name: 'outlinerCollapseAria',
    addProseMirrorPlugins() {
      const toggle = (view: EditorView, pos: number) => {
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'listItem') return;
        const next = !(node.attrs.collapsed === true);
        const tr = view.state.tr.setNodeAttribute(pos, 'collapsed', next).setMeta('outlinerCollapse', true);
        view.dispatch(tr);
        // Persist by content-path AFTER the dispatch so the path is computed
        // against the updated doc (position unchanged for an attr-only change).
        const path = contentPathForPos(view.state.doc, pos);
        if (path) {
          const map = readCollapseMap(filePath);
          if (next) map[path] = true;
          else delete map[path];
          writeCollapseMap(filePath, map);
        }
      };
      return [createCollapsePlugin(toggle), createAriaPlugin()];
    },
  });
}
