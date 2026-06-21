// workbenchMarkdown.ts — lossless markdown round-trip for the WORKBENCH DOCUMENT
// editor (Obsidian-style document mode, 2026-06-11 rewrite of the bullet-only
// adapter).
//
// DECISION (unchanged from the outliner pass): CUSTOM serializer + parser, not a
// markdown-it / remark dependency. The grammar we round-trip is deliberately
// SMALL and line-oriented — headings 1–3, paragraphs, nested bullet/ordered
// lists, blockquotes, fenced code blocks, horizontal rules, block images, and
// the inline mark set (bold/italic/strike/code/link). A full CommonMark engine
// is over-powered and (worse) NOT identity-stable: its serializers re-wrap and
// re-indent in ways that churn Tom's hand-editable files. A focused walker is
// exact, dependency-free, and property-testable (parse∘serialize = id — see the
// node self-check battery, docs/outliner-review.md §4).
//
// CONTRACT:
//   - Top-level blocks serialize separated by ONE blank line.
//   - Headings `# ` / `## ` / `### ` (levels 1–3). A bare `#`/`##`/`###` line is
//     an EMPTY heading. 4+ hashes are plain paragraph text.
//   - Lists: "- " bullets / "1. " ordered, exactly 2-space indent per nesting
//     level (Obsidian/Logseq convention; the parser also accepts tabs, "* "/"+ "
//     markers and "1)" ordered markers).
//   - LEGACY heading-bullets: a list item may carry a heading register —
//     `- # Heading` (the Logseq-style shape every pre-rewrite Fleeting Note
//     uses). CHOICE (documented per the conversion brief): these stay LIST
//     ITEMS with a heading textblock — they are NOT normalized to top-level
//     headings, so a legacy bullet-outline file re-opens with its exact
//     structure and re-serializes byte-identically. No content is ever lost.
//   - Blockquotes: each `> ` line is one paragraph of the quote (line-oriented;
//     no lazy continuation, no nested quotes — a `> > x` line keeps "> x" as its
//     literal text and round-trips).
//   - Fenced code blocks: ``` with an optional language; content is VERBATIM
//     (never escaped); the serializer lengthens the fence when the content
//     itself contains backtick fences. An unterminated fence at EOF still
//     becomes a code block (nothing dropped).
//   - Horizontal rule: `---` on its own line (also `***` / `___` parse).
//   - Images: `![alt](relative-path)` on its own line — a top-level image block,
//     or (indented, markerless) a block image attached to the list item above.
//   - WIKILINKS stay PLAIN TEXT: `[[slug]]` is never escaped and never parsed
//     into a node — Obsidian sees a clean wikilink. Only a FULL inline-link
//     shape `[text](url)` is treated as markdown (and only that shape gets a
//     leading-bracket escape when it appears as literal text).
//   - EMPTY top-level paragraphs are NOT serialized (markdown has no marker for
//     them; Obsidian collapses blank runs the same way). The editor normalizes
//     them away at serialize time — identity is defined over normalized trees.
//   - The PARSER is TOLERANT: blank lines separate blocks (and close a list);
//     a markerless indented line inside a list attaches as an image (pure-image
//     shape) or is promoted to a bullet (legacy outliner behavior — nothing a
//     human typed is lost); unknown line shapes fall through as paragraphs.
//
// These functions operate on plain serializable trees (DocBlock / OutlineNode),
// decoupled from ProseMirror so they're unit-testable without an editor. The
// editor adapters (tipTapDocToBlocks / blocksToTipTapDoc) live in outlinerSchema.

export interface OutlineInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

// A block image. `src` is the RELATIVE path (`_attachments/<uuid>.<ext>`) stored
// in markdown; the display URL is resolved at render time only (workbenchAttachments).
export interface OutlineImage {
  alt: string;
  src: string;
}

export type ListKind = 'bullet' | 'ordered';

// One list item (the name OutlineNode is kept from the outliner era — it is the
// same serializable shape, now nested inside a DocBlock list instead of being
// the document root).
export interface OutlineNode {
  inlines: OutlineInline[]; // the item's own text (its paragraph / heading)
  images: OutlineImage[]; // block images attached to this item (after its text)
  children: OutlineNode[]; // nested items
  /** Kind of the nested child list ('bullet' default). */
  childKind?: ListKind;
  /** Legacy Logseq-style heading-bullet: the item's textblock is an h1–h3.
   *  Serialized as `- # text` (hash marks inline after the marker). */
  heading?: 1 | 2 | 3;
}

export type DocBlock =
  | { kind: 'paragraph'; inlines: OutlineInline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inlines: OutlineInline[] }
  | { kind: 'list'; listKind: ListKind; items: OutlineNode[] }
  | { kind: 'quote'; lines: OutlineInline[][] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'rule' }
  | { kind: 'image'; image: OutlineImage };

// `# text` — 1–3 hashes + space + text, OR bare hashes (empty heading).
const HEADING_RE = /^(#{1,3})(?: (.*)|)$/;
// A line/text that is exactly one image: `![alt](src)` with nothing around it.
// Both segments honor backslash escapes (the serializer escapes `]` in alt and
// parens in src), so `![a](x\(1\).png)` round-trips.
const PURE_IMAGE = /^!\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)$/;
// A full inline-link shape — the ONLY bracket sequence the inline parser converts.
const LINK_SHAPE = /^\[[^\]\n]*\]\([^)\n]*\)/;
// Thematic break: --- / *** / ___ (3+).
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
// Opening code fence on a trimmed line: ``` + optional language word.
const FENCE_RE = /^(`{3,})\s*([^`]*)$/;

const INDENT = '  '; // 2 spaces — the one pinned indent unit

// ---- SERIALIZE: DocBlock[] -> markdown -------------------------------------

// Escape inline sigils so plain text round-trips. Deliberately MINIMAL:
//   - `\`, `` ` ``, `*` always (the parser re-interprets them anywhere);
//   - the first `~` of a `~~` pair (single `~` is literal);
//   - `[` ONLY when a full `[text](url)` link shape follows — so wikilinks
//     (`[[slug]]`) and lone brackets stay clean, hand-editable text.
function escapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' || ch === '`' || ch === '*') {
      out += '\\' + ch;
    } else if (ch === '~' && s[i + 1] === '~') {
      out += '\\~';
    } else if (ch === '[' && LINK_SHAPE.test(s.slice(i))) {
      out += '\\[';
    } else {
      out += ch;
    }
  }
  return out;
}

// Inside `[text](...)` the closing bracket would end the link early — escape
// BOTH brackets unconditionally there (the parser honors backslash escapes).
function escapeLinkText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' || ch === '`' || ch === '*' || ch === '[' || ch === ']') {
      out += '\\' + ch;
    } else if (ch === '~' && s[i + 1] === '~') {
      out += '\\~';
    } else {
      out += ch;
    }
  }
  return out;
}

// Code span with a delimiter run LONGER than any backtick run inside, padded
// with one space when the content starts/ends with a backtick or a space
// (CommonMark padding rule — the parser strips exactly one space per side).
function serializeCodeSpan(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const pad =
    text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') || text.endsWith(' ')
      ? ' '
      : '';
  return fence + pad + text + pad + fence;
}

function serializeInline(inl: OutlineInline): string {
  if (!inl.text) return '';
  let t: string;
  if (inl.code) {
    t = serializeCodeSpan(inl.text); // code spans are literal — not escaped inside
  } else {
    t = inl.href ? escapeLinkText(inl.text) : escapeText(inl.text);
  }
  if (inl.strike) t = `~~${t}~~`;
  if (inl.italic) t = `*${t}*`;
  if (inl.bold) t = `**${t}**`;
  // Parens inside the URL are escaped so `[text](url)` re-parses losslessly.
  if (inl.href) t = `[${t}](${inl.href.replace(/[()]/g, (c) => '\\' + c)})`;
  return t;
}

function inlinesToText(inlines: OutlineInline[]): string {
  return inlines.map(serializeInline).join('');
}

function serializeImage(img: OutlineImage): string {
  const alt = escapeLinkText(img.alt || '');
  const src = (img.src || '').replace(/[()]/g, (c) => '\\' + c);
  return `![${alt}](${src})`;
}

// A top-level PARAGRAPH line that would re-parse as some other block gets a
// leading backslash (the inline parser unescapes any backslashed char).
function escapeParagraphLine(line: string): string {
  if (
    HEADING_RE.test(line) ||
    /^[-*+] /.test(line) ||
    /^\d{1,9}[.)] /.test(line) ||
    line.startsWith('>') ||
    RULE_RE.test(line) ||
    /^`{3,}/.test(line) ||
    PURE_IMAGE.test(line)
  ) {
    return '\\' + line;
  }
  return line;
}

// A LIST ITEM's text only collides with the heading-bullet and image-bullet
// shapes (the line's marker is already consumed before this text re-parses).
function escapeListItemText(text: string): string {
  if (HEADING_RE.test(text) || PURE_IMAGE.test(text)) return '\\' + text;
  return text;
}

function listItemLines(item: OutlineNode, depth: number, kind: ListKind, index: number, out: string[]): void {
  const marker = kind === 'ordered' ? `${index + 1}. ` : '- ';
  let text = inlinesToText(item.inlines);
  if (item.heading) {
    text = `${'#'.repeat(item.heading)} ${text}`;
  } else {
    text = escapeListItemText(text);
  }
  out.push(`${INDENT.repeat(depth)}${marker}${text}`);
  // Block images attach to THIS item: markerless continuation lines, depth+1.
  for (const img of item.images) {
    out.push(`${INDENT.repeat(depth + 1)}${serializeImage(img)}`);
  }
  const childKind: ListKind = item.childKind ?? 'bullet';
  item.children.forEach((child, i) => listItemLines(child, depth + 1, childKind, i, out));
}

function blockLines(block: DocBlock): string[] {
  switch (block.kind) {
    case 'paragraph': {
      const text = inlinesToText(block.inlines);
      if (!text) return []; // empty paragraphs have no markdown shape — normalized away
      return [escapeParagraphLine(text)];
    }
    case 'heading': {
      const text = inlinesToText(block.inlines);
      return [text ? `${'#'.repeat(block.level)} ${text}` : '#'.repeat(block.level)];
    }
    case 'list': {
      const out: string[] = [];
      block.items.forEach((item, i) => listItemLines(item, 0, block.listKind, i, out));
      return out;
    }
    case 'quote':
      return block.lines.map((line) => {
        const text = inlinesToText(line);
        return text ? `> ${text}` : '>';
      });
    case 'code': {
      let longest = 2;
      for (const run of block.text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      const body = block.text === '' ? [] : block.text.split('\n');
      return [fence + block.language, ...body, fence];
    }
    case 'rule':
      return ['---'];
    case 'image':
      return [serializeImage(block.image)];
  }
}

export function blocksToMarkdown(blocks: DocBlock[]): string {
  const chunks = blocks.map(blockLines).filter((lines) => lines.length > 0);
  if (chunks.length === 0) return '';
  return chunks.map((lines) => lines.join('\n')).join('\n\n') + '\n';
}

// ---- PARSE: markdown -> DocBlock[] ------------------------------------------

function parsePureImage(text: string): OutlineImage | null {
  const m = PURE_IMAGE.exec(text.trim());
  if (!m) return null;
  const alt = m[1].replace(/\\([\\`*~[\]])/g, '$1');
  const src = m[2].replace(/\\([()])/g, '$1');
  return { alt, src };
}

// Find a closing run of EXACTLY n backticks (not part of a longer run).
function findCodeClose(src: string, from: number, n: number): number {
  let j = from;
  while (j < src.length) {
    if (src[j] === '`') {
      let k = j;
      while (k < src.length && src[k] === '`') k++;
      if (k - j === n) return j;
      j = k;
    } else if (src[j] === '\\') {
      j += 2;
    } else {
      j++;
    }
  }
  return -1;
}

// Inline parser for the constrained mark set. Greedy, left-to-right, supports
// nesting (e.g. **bold *and italic***). Unknown sequences fall through as
// literal text — `[[wikilinks]]`, lone `~`, unclosed marks all stay literal.
export function parseInline(src: string): OutlineInline[] {
  const out: OutlineInline[] = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ text: buf });
      buf = '';
    }
  };
  const findClose = (from: number, delim: string): number => {
    let j = from;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src.startsWith(delim, j)) return j;
      j++;
    }
    return -1;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1]; // unescape
      i += 2;
      continue;
    }
    // Link [text](href) — ONLY the full shape converts; `[[slug]]` falls through.
    if (ch === '[') {
      const close = findClose(i + 1, ']');
      if (close !== -1 && src[close + 1] === '(') {
        const hrefEnd = findClose(close + 2, ')');
        if (hrefEnd !== -1) {
          flush();
          const inner = parseInline(src.slice(i + 1, close));
          const href = src.slice(close + 2, hrefEnd).replace(/\\([()])/g, '$1');
          for (const seg of inner) out.push({ ...seg, href });
          i = hrefEnd + 1;
          continue;
        }
      }
    }
    // Code span: a run of n backticks closed by a run of exactly n.
    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      const close = findCodeClose(src, i + n, n);
      if (close !== -1) {
        flush();
        let content = src.slice(i + n, close);
        // CommonMark padding rule: strip ONE space per side when both present.
        if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
          content = content.slice(1, -1);
        }
        if (content) out.push({ text: content, code: true });
        i = close + n;
        continue;
      }
    }
    // Bold+italic *** ... ***
    if (src.startsWith('***', i)) {
      const close = findClose(i + 3, '***');
      if (close !== -1) {
        flush();
        for (const seg of parseInline(src.slice(i + 3, close))) {
          out.push({ ...seg, bold: true, italic: true });
        }
        i = close + 3;
        continue;
      }
    }
    // Bold ** ... **
    if (src.startsWith('**', i)) {
      const close = findClose(i + 2, '**');
      if (close !== -1) {
        flush();
        for (const seg of parseInline(src.slice(i + 2, close))) out.push({ ...seg, bold: true });
        i = close + 2;
        continue;
      }
    }
    // Strike ~~ ... ~~
    if (src.startsWith('~~', i)) {
      const close = findClose(i + 2, '~~');
      if (close !== -1) {
        flush();
        for (const seg of parseInline(src.slice(i + 2, close))) out.push({ ...seg, strike: true });
        i = close + 2;
        continue;
      }
    }
    // Italic * ... *
    if (ch === '*') {
      const close = findClose(i + 1, '*');
      if (close !== -1) {
        flush();
        for (const seg of parseInline(src.slice(i + 1, close))) out.push({ ...seg, italic: true });
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---- list-line machinery (the legacy-tolerant outliner core) ---------------

interface ListLine {
  depth: number;
  kind: ListKind | null; // null = markerless continuation line
  text: string;
  image: OutlineImage | null; // set when the text is PURELY one image
}

function readListLine(raw: string): ListLine {
  const expanded = raw.replace(/\t/g, INDENT);
  const leading = expanded.length - expanded.trimStart().length;
  const depth = Math.floor(leading / 2);
  const body = expanded.trimStart();
  const bullet = /^([-*+])\s+(.*)$/.exec(body);
  if (bullet) return { depth, kind: 'bullet', text: bullet[2], image: parsePureImage(bullet[2]) };
  const ordered = /^(\d{1,9})[.)]\s+(.*)$/.exec(body);
  if (ordered) return { depth, kind: 'ordered', text: ordered[2], image: parsePureImage(ordered[2]) };
  return { depth, kind: null, text: body, image: parsePureImage(body) };
}

function makeItem(line: ListLine): OutlineNode {
  if (line.image) return { inlines: [], images: [line.image], children: [] };
  const hm = /^(#{1,3}) (.*)$/.exec(line.text);
  if (hm) {
    return {
      inlines: parseInline(hm[2]),
      images: [],
      children: [],
      heading: hm[1].length as 1 | 2 | 3,
    };
  }
  return { inlines: parseInline(line.text), images: [], children: [] };
}

export function markdownToBlocks(md: string): DocBlock[] {
  const blocks: DocBlock[] = [];

  // Open accumulators (at most one active at a time, lists aside).
  let list: { listKind: ListKind; items: OutlineNode[] } | null = null;
  let listStack: { depth: number; node: OutlineNode }[] = [];
  let quote: OutlineInline[][] | null = null;
  let code: { language: string; lines: string[]; fenceLen: number } | null = null;

  const closeList = () => {
    if (list) {
      blocks.push({ kind: 'list', listKind: list.listKind, items: list.items });
      list = null;
      listStack = [];
    }
  };
  const closeQuote = () => {
    if (quote) {
      blocks.push({ kind: 'quote', lines: quote });
      quote = null;
    }
  };
  const closeAll = () => {
    closeList();
    closeQuote();
  };

  const attachListLine = (line: ListLine) => {
    // Markerless pure-image continuation: attach to the nearest shallower item.
    if (line.kind === null && line.image) {
      while (listStack.length && listStack[listStack.length - 1].depth >= line.depth) listStack.pop();
      if (listStack.length) {
        listStack[listStack.length - 1].node.images.push(line.image);
        return;
      }
      // No parent — fall through: becomes a standalone image item.
    }
    const node = makeItem(line);
    const kind: ListKind = line.kind ?? 'bullet';
    while (listStack.length && listStack[listStack.length - 1].depth >= line.depth) listStack.pop();
    if (listStack.length === 0) {
      if (!list) {
        list = { listKind: kind, items: [] };
      } else if (line.kind !== null && line.kind !== list.listKind) {
        // Marker kind changed at the root level → a NEW list (CommonMark).
        closeList();
        list = { listKind: kind, items: [] };
      }
      list.items.push(node);
    } else {
      const parent = listStack[listStack.length - 1].node;
      if (parent.children.length === 0 && line.kind !== null) parent.childKind = line.kind;
      parent.children.push(node);
    }
    listStack.push({ depth: line.depth, node });
  };

  for (const raw of md.split(/\r?\n/)) {
    // Inside a fenced code block: verbatim until the closing fence.
    if (code) {
      const t = raw.trim();
      const closeFence = /^(`{3,})\s*$/.exec(t);
      if (closeFence && closeFence[1].length >= code.fenceLen) {
        blocks.push({ kind: 'code', language: code.language, text: code.lines.join('\n') });
        code = null;
      } else {
        code.lines.push(raw);
      }
      continue;
    }

    if (!raw.trim()) {
      // Blank line: closes the open block (a serialized list never contains
      // blank lines, so two lists separated by a blank stay TWO lists).
      closeAll();
      continue;
    }

    const trimmed = raw.trim();
    const leading = raw.replace(/\t/g, INDENT).length - raw.replace(/\t/g, INDENT).trimStart().length;

    // Opening code fence (any indent — tolerant).
    const fence = FENCE_RE.exec(trimmed);
    if (fence) {
      closeAll();
      code = { language: fence[2].trim(), lines: [], fenceLen: fence[1].length };
      continue;
    }

    // Horizontal rule — only un-indented (an indented `---` inside a list is a
    // legacy continuation line and stays with the list machinery below).
    if (leading === 0 && RULE_RE.test(trimmed)) {
      closeAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    // Blockquote line — only un-indented.
    if (leading === 0) {
      const q = /^>\s?(.*)$/.exec(raw);
      if (q) {
        closeList();
        if (!quote) quote = [];
        quote.push(parseInline(q[1]));
        continue;
      }
    }
    if (quote) closeQuote(); // any non-quote line ends the quote

    const line = readListLine(raw);

    // A marker line always belongs to the list machinery.
    if (line.kind !== null) {
      attachListLine(line);
      continue;
    }

    // Markerless lines.
    if (list && line.depth >= 1) {
      // Inside an open list: legacy continuation — image attach or promoted bullet.
      attachListLine(line);
      continue;
    }
    closeList();

    // Top-level heading (`# x`, bare `##` = empty heading).
    const hm = HEADING_RE.exec(trimmed);
    if (hm) {
      blocks.push({
        kind: 'heading',
        level: hm[1].length as 1 | 2 | 3,
        inlines: parseInline(hm[2] ?? ''),
      });
      continue;
    }

    // Top-level standalone image block.
    if (line.image) {
      blocks.push({ kind: 'image', image: line.image });
      continue;
    }

    // Plain paragraph (one line = one paragraph; no lazy continuation).
    blocks.push({ kind: 'paragraph', inlines: parseInline(trimmed) });
  }

  // EOF: close anything still open (an unterminated fence keeps its content —
  // minus the file's own trailing newline, which is not a code line).
  if (code !== null) {
    const open: { language: string; lines: string[] } = code;
    if (open.lines.length && open.lines[open.lines.length - 1] === '') open.lines.pop();
    blocks.push({ kind: 'code', language: open.language, text: open.lines.join('\n') });
  }
  closeAll();
  return blocks;
}
