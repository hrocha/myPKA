// outlinerSchema.ts — the WORKBENCH DOCUMENT schema (Obsidian-style document
// mode, 2026-06-11 rewrite of the constrained bullet-only outliner) + the
// editor⇄blocks adapters used by the markdown round-trip.
//
// SCHEMA: Document(content:'block+') — a normal rich document. Blocks:
// paragraph, heading 1–3 (top-level now, not just inside bullets), bulletList /
// orderedList (+ listItem), blockquote, codeBlock, horizontalRule, and the
// block image. Inline marks: bold / italic / strike / code / link.
//
// ALL formatting enters via markdown INPUT RULES, Obsidian-style — there is no
// toolbar. `# `…`### ` headings, `- `/`* ` bullets, `1. ` ordered, `> ` quote,
// ``` code fence, `---` rule; the mark input rules (`**`, `*`, `~~`, `` ` ``)
// ship with the TipTap v3 mark extensions (verified in node_modules — each mark
// registers markInputRule + markPasteRule; nothing here disables them).
//
// OUTLINING stays first-class inside lists: ListItem keeps the view-only
// `collapsed` attr (decoration + localStorage persistence in outlinerCollapse;
// never serialized), Tab/Shift-Tab sink/lift via ListKeymap, Alt/Mod-Shift
// arrow reorder via outlinerReorder. ListItem content is PINNED to
// '(paragraph | heading) outlinerImage* (bulletList | orderedList)?' so every
// editor state has an exact markdown shape (the heading option carries the
// legacy `- # Heading` heading-bullets every pre-rewrite Fleeting Note uses).
//
// The zoom-into-bullet feature (outlinerZoom) is REMOVED in document mode;
// heading folding (outlinerHeadingFold) replaces it as the big-structure tool.

import Document from '@tiptap/extension-document';
import {
  Node,
  mergeAttributes,
  textblockTypeInputRule,
  wrappingInputRule,
  nodeInputRule,
} from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import BulletList from '@tiptap/extension-bullet-list';
import { OrderedList } from '@tiptap/extension-list';
import ListItem from '@tiptap/extension-list-item';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Code from '@tiptap/extension-code';
import Link from '@tiptap/extension-link';
import History from '@tiptap/extension-history';
import Gapcursor from '@tiptap/extension-gapcursor';
import Dropcursor from '@tiptap/extension-dropcursor';
import { ListKeymap } from '@tiptap/extension-list-keymap';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor, AnyExtension } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import {
  blocksToMarkdown,
  type DocBlock,
  type ListKind,
  type OutlineInline,
  type OutlineImage,
  type OutlineNode,
} from './workbenchMarkdown';

// ---- Heading (levels 1–3) ---------------------------------------------------
// In group 'block' (top-level headings) AND named explicitly in ListItem's
// content expression (legacy heading-bullets). `# ` / `## ` / `### ` at the
// start of a paragraph converts live; Backspace at the start of a heading
// demotes it back to a paragraph (outlinerEdit.outlinerBackspace).
const HEADING_LEVELS = [1, 2, 3] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

const clampHeadingLevel = (lvl: unknown): HeadingLevel => {
  const n = Number(lvl);
  return (HEADING_LEVELS as readonly number[]).includes(n) ? (n as HeadingLevel) : 1;
};

const DocHeading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      level: {
        default: 1,
        parseHTML: (el: HTMLElement) => clampHeadingLevel(el.tagName.charAt(1)),
        renderHTML: () => ({}), // level is carried by the tag name itself
      },
    };
  },
  parseHTML() {
    return HEADING_LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } }));
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = clampHeadingLevel(node.attrs.level);
    return [`h${level}`, mergeAttributes(HTMLAttributes), 0];
  },
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^(#{1,3})\s$/,
        type: this.type,
        getAttributes: (match) => ({ level: clampHeadingLevel(match[1].length) }),
      }),
    ];
  },
});

// ---- ListItem with the view-only `collapsed` attr ---------------------------
// Content is pinned to the exact serializable shape: own textblock (paragraph
// or legacy heading register), then block images, then at most ONE nested list.
const OutlinerListItem = ListItem.extend({
  content: '(paragraph | heading) outlinerImage* (bulletList | orderedList)?',
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        // NOT parsed from / rendered to markdown; only mirrored to a data attr
        // for CSS + the decoration plugin.
        parseHTML: (el: HTMLElement) => el.getAttribute('data-collapsed') === 'true',
        renderHTML: (attrs: { collapsed?: boolean }) =>
          attrs.collapsed ? { 'data-collapsed': 'true' } : {},
      },
    };
  },
});

// ---- Blockquote --------------------------------------------------------------
// Line-oriented: each `> ` markdown line is one paragraph of the quote.
const DocBlockquote = Node.create({
  name: 'blockquote',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  parseHTML() {
    return [{ tag: 'blockquote' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['blockquote', mergeAttributes(HTMLAttributes), 0];
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*>\s$/, type: this.type })];
  },
});

// ---- Fenced code block --------------------------------------------------------
// `code: true` keeps marks/input-rules out and makes the core Enter chain insert
// a newline (newlineInCode) instead of splitting the block. ArrowDown at the very
// end of a TRAILING code block creates a paragraph after it (otherwise the caret
// would be jailed in the last block).
const DocCodeBlock = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() {
    return {
      language: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-language') ?? '',
        renderHTML: (attrs: { language?: string }) =>
          attrs.language ? { 'data-language': attrs.language } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'pre', preserveWhitespace: 'full' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes), ['code', 0]];
  },
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^```([a-zA-Z0-9_+#-]*)\s$/,
        type: this.type,
        getAttributes: (match) => ({ language: match[1] ?? '' }),
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      // Escape hatch: ArrowDown at the end of a code block that is the LAST doc
      // child appends a paragraph and moves the caret there.
      ArrowDown: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type.name !== 'codeBlock') return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;
        if ($from.depth !== 1 || $from.index(0) !== state.doc.childCount - 1) return false;
        const end = state.doc.content.size;
        const tr = state.tr.insert(end, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView();
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});

// ---- Horizontal rule ----------------------------------------------------------
const DocHorizontalRule = Node.create({
  name: 'horizontalRule',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'hr' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['hr', mergeAttributes(HTMLAttributes)];
  },
  addInputRules() {
    // `---` converts on the third dash; `***` / `___` require a trailing space
    // so typing `***bold***` or `___x___` never detonates into a rule mid-word
    // (mirrors TipTap's own HorizontalRule guard).
    return [nodeInputRule({ find: /^(?:---|___\s|\*\*\*\s)$/, type: this.type })];
  },
});

// ---- Image node (block) -------------------------------------------------------
// A block-level leaf image. Group 'block', so it lives at the doc level OR as a
// listItem child (named in the listItem content expression). Round-trips to
// `![alt](relativePath)` on its own line.
//
// `src` ALWAYS holds the RELATIVE path (e.g. `_attachments/<uuid>.png`) — the
// same value written to markdown. The DISPLAY url is resolved at render time
// only (OutlinerImageView), never stored. `uploading`/`pendingId` are transient
// view-only flags for the optimistic upload placeholder (never serialized).
const OUTLINER_IMAGE_NAME = 'outlinerImage';

const OutlinerImage = Node.create({
  name: OUTLINER_IMAGE_NAME,
  group: 'block',
  inline: false,
  draggable: true,
  selectable: true,
  atom: true,
  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-src') ?? el.getAttribute('src') ?? '',
        renderHTML: (attrs: { src?: string }) => (attrs.src ? { 'data-src': attrs.src } : {}),
      },
      alt: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('alt') ?? '',
        renderHTML: (attrs: { alt?: string }) => ({ alt: attrs.alt ?? '' }),
      },
      uploading: { default: false, rendered: false },
      pendingId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'img[data-src], figure[data-outliner-image]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-outliner-image': 'true' }, HTMLAttributes)];
  },
});

export const outlinerImageName = OUTLINER_IMAGE_NAME;
export { OutlinerImage };

// The full extension list for the document editor. No StarterKit — we assemble
// the exact set by hand so the schema stays pinned to the markdown grammar.
//
// `imageNode` is the (React-node-view-wrapped) image node, injected by the
// caller so this lib file stays free of any @tiptap/react / TSX dependency.
export function outlinerExtensions(imageNode: AnyExtension = OutlinerImage as AnyExtension): AnyExtension[] {
  return [
    Document, // default content 'block+'
    Paragraph,
    DocHeading,
    Text,
    BulletList,
    OrderedList,
    OutlinerListItem,
    DocBlockquote,
    DocCodeBlock,
    DocHorizontalRule,
    imageNode,
    Bold,
    Italic,
    Strike,
    Code,
    Link.configure({ openOnClick: false, autolink: true }),
    History,
    Gapcursor,
    Dropcursor,
    ListKeymap, // Tab = sink (indent), Shift-Tab = lift (outdent)
  ] as AnyExtension[];
}

// ---- Adapter: DocBlock[]  <->  TipTap JSON doc ------------------------------
// We round-trip through DocBlock (the serializable tree) so the markdown
// functions never touch ProseMirror, and the editor never touches markdown
// strings directly. One translation layer, fully typed.

function inlineToJSON(inl: OutlineInline): JSONContent {
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  if (inl.bold) marks.push({ type: 'bold' });
  if (inl.italic) marks.push({ type: 'italic' });
  if (inl.strike) marks.push({ type: 'strike' });
  if (inl.code) marks.push({ type: 'code' });
  if (inl.href) marks.push({ type: 'link', attrs: { href: inl.href } });
  const node: JSONContent = { type: 'text', text: inl.text || '' };
  if (marks.length) node.marks = marks;
  return node;
}

function inlinesContent(inlines: OutlineInline[]): JSONContent[] {
  return inlines.map(inlineToJSON).filter((n) => n.text);
}

function listItemToJSON(item: OutlineNode): JSONContent {
  const textblock: JSONContent = item.heading
    ? { type: 'heading', attrs: { level: item.heading }, content: inlinesContent(item.inlines) }
    : { type: 'paragraph', content: inlinesContent(item.inlines) };
  const content: JSONContent[] = [textblock];
  for (const img of item.images) {
    content.push({ type: OUTLINER_IMAGE_NAME, attrs: { src: img.src, alt: img.alt } });
  }
  if (item.children.length) {
    content.push({
      type: item.childKind === 'ordered' ? 'orderedList' : 'bulletList',
      content: item.children.map(listItemToJSON),
    });
  }
  return { type: 'listItem', content };
}

function blockToJSON(block: DocBlock): JSONContent {
  switch (block.kind) {
    case 'paragraph':
      return { type: 'paragraph', content: inlinesContent(block.inlines) };
    case 'heading':
      return { type: 'heading', attrs: { level: block.level }, content: inlinesContent(block.inlines) };
    case 'list':
      return {
        type: block.listKind === 'ordered' ? 'orderedList' : 'bulletList',
        content: block.items.map(listItemToJSON),
      };
    case 'quote': {
      const paragraphs = (block.lines.length ? block.lines : [[]]).map((line) => ({
        type: 'paragraph',
        content: inlinesContent(line),
      }));
      return { type: 'blockquote', content: paragraphs };
    }
    case 'code':
      return {
        type: 'codeBlock',
        attrs: { language: block.language },
        content: block.text ? [{ type: 'text', text: block.text }] : [],
      };
    case 'rule':
      return { type: 'horizontalRule' };
    case 'image':
      return { type: OUTLINER_IMAGE_NAME, attrs: { src: block.image.src, alt: block.image.alt } };
  }
}

export function blocksToTipTapDoc(blocks: DocBlock[]): JSONContent {
  const content = blocks.map(blockToJSON);
  // An empty doc still needs one empty paragraph so the editor has a caret home.
  if (content.length === 0) content.push({ type: 'paragraph', content: [] });
  return { type: 'doc', content };
}

// DocBlock[] → bare block-node JSON array (no doc wrapper). Used by the
// multi-line-paste path to materialize pasted markdown as real blocks.
export function blocksToNodesJSON(blocks: DocBlock[]): JSONContent[] {
  return blocks.map(blockToJSON);
}

// OutlineNode[] → bare listItem JSON array — the paste path uses this to splice
// pasted list items as SIBLINGS inside an existing list.
export function listItemsToJSON(items: OutlineNode[]): JSONContent[] {
  return items.map(listItemToJSON);
}

// ---- reverse: TipTap JSON -> DocBlock[] --------------------------------------

function jsonInlineToOutline(node: JSONContent): OutlineInline | null {
  if (node.type !== 'text' || !node.text) return null;
  const inl: OutlineInline = { text: node.text };
  for (const m of node.marks ?? []) {
    if (m.type === 'bold') inl.bold = true;
    else if (m.type === 'italic') inl.italic = true;
    else if (m.type === 'strike') inl.strike = true;
    else if (m.type === 'code') inl.code = true;
    else if (m.type === 'link') inl.href = (m.attrs as { href?: string } | undefined)?.href;
  }
  return inl;
}

function jsonInlines(content: JSONContent[] | undefined): OutlineInline[] {
  const out: OutlineInline[] = [];
  for (const child of content ?? []) {
    const inl = jsonInlineToOutline(child);
    if (inl) out.push(inl);
  }
  return out;
}

function jsonImage(node: JSONContent): OutlineImage | null {
  const attrs = (node.attrs ?? {}) as { src?: string; alt?: string; uploading?: boolean };
  // Skip in-flight placeholders so an unsaved upload never serializes.
  if (attrs.uploading || !attrs.src) return null;
  return { src: attrs.src, alt: attrs.alt ?? '' };
}

function jsonItemToOutline(item: JSONContent): OutlineNode {
  const node: OutlineNode = { inlines: [], images: [], children: [] };
  let sawTextblock = false;
  for (const child of item.content ?? []) {
    if (child.type === 'paragraph' || child.type === 'heading') {
      if (!sawTextblock && child.type === 'heading') {
        const lvl = Number((child.attrs as { level?: number } | undefined)?.level ?? 1);
        node.heading = (lvl >= 1 && lvl <= 3 ? lvl : 1) as 1 | 2 | 3;
      }
      sawTextblock = true;
      node.inlines.push(...jsonInlines(child.content));
    } else if (child.type === OUTLINER_IMAGE_NAME) {
      const img = jsonImage(child);
      if (img) node.images.push(img);
    } else if (child.type === 'bulletList' || child.type === 'orderedList') {
      node.children = (child.content ?? []).map(jsonItemToOutline);
      node.childKind = (child.type === 'orderedList' ? 'ordered' : 'bullet') as ListKind;
    }
  }
  if (!node.children.length) delete node.childKind;
  return node;
}

export function tipTapDocToBlocks(doc: JSONContent): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const child of doc.content ?? []) {
    switch (child.type) {
      case 'paragraph': {
        const inlines = jsonInlines(child.content);
        // Empty top-level paragraphs have no markdown shape — normalized away.
        if (inlines.length) blocks.push({ kind: 'paragraph', inlines });
        break;
      }
      case 'heading': {
        const lvl = Number((child.attrs as { level?: number } | undefined)?.level ?? 1);
        blocks.push({
          kind: 'heading',
          level: (lvl >= 1 && lvl <= 3 ? lvl : 1) as 1 | 2 | 3,
          inlines: jsonInlines(child.content),
        });
        break;
      }
      case 'bulletList':
      case 'orderedList':
        blocks.push({
          kind: 'list',
          listKind: child.type === 'orderedList' ? 'ordered' : 'bullet',
          items: (child.content ?? []).map(jsonItemToOutline),
        });
        break;
      case 'blockquote':
        blocks.push({
          kind: 'quote',
          lines: (child.content ?? []).map((p) => jsonInlines(p.content)),
        });
        break;
      case 'codeBlock': {
        const text = (child.content ?? [])
          .map((n) => (n.type === 'text' ? n.text ?? '' : ''))
          .join('');
        const language = String((child.attrs as { language?: string } | undefined)?.language ?? '');
        blocks.push({ kind: 'code', language, text });
        break;
      }
      case 'horizontalRule':
        blocks.push({ kind: 'rule' });
        break;
      case OUTLINER_IMAGE_NAME: {
        const img = jsonImage(child);
        if (img) blocks.push({ kind: 'image', image: img });
        break;
      }
      default:
        break; // unknown block — nothing to serialize
    }
  }
  return blocks;
}

// Convenience: the editor's current doc as markdown (used by autosave).
export function editorMarkdown(editor: Editor): string {
  return blocksToMarkdown(tipTapDocToBlocks(editor.getJSON() as JSONContent));
}
