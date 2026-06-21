// outlinerHeadingFold.ts — Obsidian-style HEADING FOLDING for the document
// editor (2026-06-11, document-mode rewrite).
//
// A chevron affordance appears on hover next to every TOP-LEVEL h1–h3 that has
// a section (at least one following block before the next heading of the SAME
// OR HIGHER level). Clicking it — or Mod+. / Mod+Enter with the caret in the
// heading — folds/unfolds everything below the heading until that boundary.
//
// IMPLEMENTATION: a ProseMirror decoration plugin. Pure VIEW state:
//   - the fold set is NEVER serialized to markdown (files stay clean Obsidian
//     markdown); it persists to localStorage keyed by file path + a stable
//     heading key (level + heading text + occurrence index — the same
//     degrade-safely contract as the list-collapse content paths: edit the
//     heading text outside the cockpit and the section simply renders open).
//   - folded sections hide their blocks via a `data-headfold-hidden` node
//     decoration (CSS display:none); the heading itself carries
//     `data-headfold='folded'|'open'` for the chevron CSS.
//   - ONLY top-level headings fold (direct doc children). Legacy heading-
//     BULLETS (`- # x` inside a list) keep the list-collapse mechanism instead.
//
// Caret correctness: foldedHiddenRanges() exposes the hidden spans so the
// editor's caret-skip (outlinerCollapse.caretSkipTarget) jumps OVER folded
// sections exactly like collapsed list subtrees; toggleHeadingFold moves a
// caret that would end up inside the newly hidden range onto the heading.

import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { HiddenRange } from './outlinerCollapse';

// ---- localStorage persistence (heading-key set) -----------------------------

const STORE_PREFIX = 'mypka-workbench-headfold:';

function storeKey(filePath: string): string {
  return STORE_PREFIX + filePath;
}

export function readFoldSet(filePath: string): Set<string> {
  try {
    const raw = localStorage.getItem(storeKey(filePath));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeFoldSet(filePath: string, folded: Set<string>): void {
  try {
    if (folded.size === 0) localStorage.removeItem(storeKey(filePath));
    else localStorage.setItem(storeKey(filePath), JSON.stringify([...folded]));
  } catch {
    /* storage unavailable (private mode) — degrade to in-memory session only */
  }
}

// ---- section model ----------------------------------------------------------

export interface FoldSection {
  /** doc position just before the heading node. */
  headingPos: number;
  /** heading level 1–3. */
  level: number;
  /** stable persistence key: `level:text:occurrenceIndex`. */
  key: string;
  /** hidden span: from the end of the heading node … */
  from: number;
  /** … to the start of the next same-or-higher heading (or doc end). */
  to: number;
}

// Walk the doc's TOP-LEVEL children and compute every heading's foldable
// section. Only sections with at least one block are returned.
export function collectFoldSections(doc: PMNode): FoldSection[] {
  interface Kid { node: PMNode; pos: number }
  const kids: Kid[] = [];
  doc.forEach((node, offset) => kids.push({ node, pos: offset }));

  const seen = new Map<string, number>();
  const sections: FoldSection[] = [];
  for (let i = 0; i < kids.length; i++) {
    const { node, pos } = kids[i];
    if (node.type.name !== 'heading') continue;
    const level = Number(node.attrs.level ?? 1);
    const base = `${level}:${node.textContent}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const from = pos + node.nodeSize;
    let to = doc.content.size;
    for (let j = i + 1; j < kids.length; j++) {
      const k = kids[j];
      if (k.node.type.name === 'heading' && Number(k.node.attrs.level ?? 1) <= level) {
        to = k.pos;
        break;
      }
    }
    if (to > from) sections.push({ headingPos: pos, level, key: `${base}:${n}`, from, to });
  }
  return sections;
}

// ---- the plugin -------------------------------------------------------------

interface FoldPluginState {
  folded: Set<string>;
  sections: FoldSection[];
  decos: DecorationSet;
}

export const headingFoldKey = new PluginKey<FoldPluginState>('headingFold');

interface FoldMeta {
  toggle?: string; // section key to toggle
  unfold?: string; // section key to force-open (no-op when already open)
}

function buildDecorations(doc: PMNode, sections: FoldSection[], folded: Set<string>): DecorationSet {
  const decos: Decoration[] = [];
  for (const s of sections) {
    const isFolded = folded.has(s.key);
    const heading = doc.nodeAt(s.headingPos);
    if (!heading) continue;
    decos.push(
      Decoration.node(s.headingPos, s.headingPos + heading.nodeSize, {
        'data-headfold': isFolded ? 'folded' : 'open',
      })
    );
    if (!isFolded) continue;
    // Hide every TOP-LEVEL block inside the folded span.
    doc.forEach((child, offset) => {
      if (offset >= s.from && offset < s.to) {
        decos.push(Decoration.node(offset, offset + child.nodeSize, { 'data-headfold-hidden': 'true' }));
      }
    });
  }
  return DecorationSet.create(doc, decos);
}

function createHeadingFoldPlugin(filePath: string): Plugin<FoldPluginState> {
  return new Plugin<FoldPluginState>({
    key: headingFoldKey,
    state: {
      init: (_config, state) => {
        const folded = readFoldSet(filePath);
        const sections = collectFoldSections(state.doc);
        return { folded, sections, decos: buildDecorations(state.doc, sections, folded) };
      },
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(headingFoldKey) as FoldMeta | undefined;
        if (!tr.docChanged && !meta) return value;
        let folded = value.folded;
        if (meta?.toggle) {
          folded = new Set(folded);
          if (folded.has(meta.toggle)) folded.delete(meta.toggle);
          else folded.add(meta.toggle);
          writeFoldSet(filePath, folded);
        } else if (meta?.unfold && folded.has(meta.unfold)) {
          folded = new Set(folded);
          folded.delete(meta.unfold);
          writeFoldSet(filePath, folded);
        }
        const sections = tr.docChanged ? collectFoldSections(newState.doc) : value.sections;
        return { folded, sections, decos: buildDecorations(newState.doc, sections, folded) };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decos ?? null;
      },
      // Chevron click: the affordance is a ::before pseudo hanging into the left
      // gutter of a top-level foldable heading, so we hit-test mousedowns whose X
      // lands in that gutter zone (left of the heading's text box, within a
      // generous 2rem so the target meets WCAG 2.5.8).
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0) return false;
          const target = event.target as HTMLElement | null;
          const headingEl = target?.closest?.('h1, h2, h3');
          if (!(headingEl instanceof HTMLElement)) return false;
          if (headingEl.parentElement !== view.dom) return false; // top-level only
          if (!headingEl.hasAttribute('data-headfold')) return false; // not foldable
          const rect = headingEl.getBoundingClientRect();
          if (event.clientX >= rect.left || event.clientX < rect.left - 32) return false;
          let pos: number;
          try {
            pos = view.posAtDOM(headingEl, 0);
          } catch {
            return false;
          }
          event.preventDefault();
          return toggleHeadingFold(view, pos - 1);
        },
      },
    },
  });
}

// The TipTap Extension wrapper. `filePath` is the slug used to persist the fold
// set to localStorage on every toggle.
export function HeadingFoldExtension(filePath: string): Extension {
  return Extension.create({
    name: 'headingFold',
    addProseMirrorPlugins() {
      return [createHeadingFoldPlugin(filePath)];
    },
  });
}

// ---- commands / queries ------------------------------------------------------

function sectionAt(state: EditorState, headingPos: number): FoldSection | null {
  const ps = headingFoldKey.getState(state);
  if (!ps) return null;
  return ps.sections.find((s) => s.headingPos === headingPos) ?? null;
}

/** Toggle the fold of the top-level heading at `headingPos`. Returns false when
 *  the heading has no foldable section. Moves a caret that sits inside the
 *  section onto the heading's end before hiding it. */
export function toggleHeadingFold(view: EditorView, headingPos: number): boolean {
  const { state } = view;
  const section = sectionAt(state, headingPos);
  if (!section) return false;
  const ps = headingFoldKey.getState(state);
  const folding = !(ps?.folded.has(section.key) ?? false);
  const tr = state.tr.setMeta(headingFoldKey, { toggle: section.key } satisfies FoldMeta);
  if (folding) {
    const head = state.selection.head;
    if (head >= section.from && head < section.to) {
      const heading = state.doc.nodeAt(headingPos);
      const end = headingPos + (heading ? heading.nodeSize - 1 : 1);
      tr.setSelection(TextSelection.create(tr.doc, end));
    }
  }
  view.dispatch(tr);
  return true;
}

/** Toggle the fold of the doc-level heading containing the selection. */
export function toggleHeadingFoldAtSelection(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.depth !== 1 || $from.parent.type.name !== 'heading') return false;
  return toggleHeadingFold(view, $from.before(1));
}

/** Force-open the section of the doc-level heading at `headingPos` (no-op when
 *  already open / not foldable). Used before inserting content right after a
 *  folded heading so the new block is visible. */
export function unfoldHeadingAt(view: EditorView, headingPos: number): void {
  const { state } = view;
  const section = sectionAt(state, headingPos);
  if (!section) return;
  const ps = headingFoldKey.getState(state);
  if (!ps?.folded.has(section.key)) return;
  view.dispatch(state.tr.setMeta(headingFoldKey, { unfold: section.key } satisfies FoldMeta));
}

/** The folded sections' hidden spans — fed into caretSkipTarget so arrow motion
 *  jumps over folded content exactly like collapsed list subtrees. */
export function headingFoldHiddenRanges(state: EditorState): HiddenRange[] {
  const ps = headingFoldKey.getState(state);
  if (!ps || ps.folded.size === 0) return [];
  return ps.sections
    .filter((s) => ps.folded.has(s.key))
    .map((s) => ({ from: s.from, to: s.to }));
}

/** The folded section that ENDS exactly at `pos` (the start of the block after
 *  it), or null. Used by the editor's Backspace guard: deleting backwards into a
 *  folded section first unfolds it instead of silently editing hidden content. */
export function foldedSectionEndingAt(state: EditorState, pos: number): FoldSection | null {
  const ps = headingFoldKey.getState(state);
  if (!ps || ps.folded.size === 0) return null;
  return ps.sections.find((s) => ps.folded.has(s.key) && s.to === pos) ?? null;
}

/** Unfold a specific section by key (used with foldedSectionEndingAt). */
export function unfoldSection(view: EditorView, key: string): void {
  const ps = headingFoldKey.getState(view.state);
  if (!ps?.folded.has(key)) return;
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { unfold: key } satisfies FoldMeta));
}
