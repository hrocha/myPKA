#!/usr/bin/env node
// check-workbench-markdown.mjs — round-trip self-check battery for the document
// mode markdown adapter (web/src/lib/workbenchMarkdown.ts).
//
// There is no web-side test runner in this repo (docs/outliner-review.md §4) —
// this script bundles the adapter with the repo's own esbuild and asserts:
//   A. parse(serialize(blocks)) deep-equals blocks for a battery of block trees
//      (identity over normalized trees: empty top-level paragraphs dropped,
//      adjacent same-mark inlines merged — exactly what the editor emits).
//   B. serialize(parse(md)) === md for canonical markdown (file-stability).
//   C. tolerant-parse checks: legacy bullet-outline files (`- ` lines incl.
//      `- # Heading` heading-bullets), tab indent, `*` markers, markerless
//      continuation lines, blank-separated lists — nothing is lost.
//
// Run from Expansions/mypka-cockpit:  node web/scripts/check-workbench-markdown.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const out = join(mkdtempSync(join(tmpdir(), 'wm-check-')), 'workbenchMarkdown.mjs');
execFileSync(join(webRoot, 'node_modules', '.bin', 'esbuild'), [
  join(webRoot, 'src', 'lib', 'workbenchMarkdown.ts'),
  '--bundle',
  '--format=esm',
  `--outfile=${out}`,
]);

const { blocksToMarkdown, markdownToBlocks } = await import(pathToFileURL(out).href);

let pass = 0;
let fail = 0;
const failures = [];

function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k];
      const bv = b[k];
      if (av === undefined && bv === undefined) continue;
      if (!deepEq(av, bv)) return false;
    }
    return true;
  }
  return false;
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push({ name, detail });
  }
}

const t = (text, marks = {}) => ({ text, ...marks });
const item = (inlines, extra = {}) => ({ inlines, images: [], children: [], ...extra });

// ---- A. parse(serialize(blocks)) === blocks ---------------------------------

const blockTrees = [
  ['single paragraph', [{ kind: 'paragraph', inlines: [t('hello world')] }]],
  ['two paragraphs', [
    { kind: 'paragraph', inlines: [t('first')] },
    { kind: 'paragraph', inlines: [t('second')] },
  ]],
  ['headings h1–h3 + empty heading', [
    { kind: 'heading', level: 1, inlines: [t('Top')] },
    { kind: 'paragraph', inlines: [t('body')] },
    { kind: 'heading', level: 2, inlines: [t('Mid')] },
    { kind: 'heading', level: 3, inlines: [t('Deep')] },
    { kind: 'heading', level: 2, inlines: [] },
  ]],
  ['marks in paragraph', [
    { kind: 'paragraph', inlines: [t('a '), t('bold', { bold: true }), t(' and '), t('em', { italic: true }), t(' and '), t('both', { bold: true, italic: true })] },
  ]],
  ['strike, code, link', [
    { kind: 'paragraph', inlines: [t('gone', { strike: true }), t(' '), t('x = 1', { code: true }), t(' '), t('site', { href: 'https://x.dev/a(b)' })] },
  ]],
  ['pdf attachment links round-trip as plain markdown links', [
    { kind: 'paragraph', inlines: [t('report.pdf', { href: '_attachments/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0.pdf' })] },
    { kind: 'paragraph', inlines: [t('see '), t('Q3 plan (final).pdf', { href: '_attachments/abc12345.pdf' }), t(' attached')] },
    { kind: 'list', listKind: 'bullet', items: [
      item([t('inside a bullet: '), t('doc.pdf', { href: '_attachments/deadbeef.pdf' })]),
    ] },
  ]],
  ['link text with bracket characters escapes', [
    { kind: 'paragraph', inlines: [t('a [weird] name.pdf', { href: '_attachments/abcd1234.pdf' })] },
  ]],
  ['code span containing backticks', [
    { kind: 'paragraph', inlines: [t('use '), t('a ` tick', { code: true })] },
  ]],
  ['wikilink stays plain', [
    { kind: 'paragraph', inlines: [t('see [[some-note]] and [[another|x]]')] },
  ]],
  ['literal link-shaped text escapes', [
    { kind: 'paragraph', inlines: [t('[not](a-link)')] },
  ]],
  ['paragraph that looks like other blocks', [
    { kind: 'paragraph', inlines: [t('# not a heading')] },
    { kind: 'paragraph', inlines: [t('- not a bullet')] },
    { kind: 'paragraph', inlines: [t('1. not ordered')] },
    { kind: 'paragraph', inlines: [t('> not a quote')] },
    { kind: 'paragraph', inlines: [t('---')] },
    { kind: 'paragraph', inlines: [t('![not](an-image.png)')] },
  ]],
  ['bullet list nested', [
    { kind: 'list', listKind: 'bullet', items: [
      item([t('one')]),
      item([t('two')], { childKind: 'bullet', children: [item([t('two.a')]), item([t('two.b')])] }),
      item([t('three')]),
    ] },
  ]],
  ['ordered list nested under bullet', [
    { kind: 'list', listKind: 'bullet', items: [
      item([t('steps')], { childKind: 'ordered', children: [item([t('first')]), item([t('second')])] }),
    ] },
  ]],
  ['top-level ordered list', [
    { kind: 'list', listKind: 'ordered', items: [item([t('alpha')]), item([t('beta')], { childKind: 'bullet', children: [item([t('beta.1')])] })] },
  ]],
  ['legacy heading-bullets', [
    { kind: 'list', listKind: 'bullet', items: [
      item([t('Section')], { heading: 2, childKind: 'bullet', children: [item([t('child')])] }),
      item([t('plain')]),
    ] },
  ]],
  ['heading-bullet text collision escapes', [
    { kind: 'list', listKind: 'bullet', items: [item([t('# literal hashes')])] },
  ]],
  ['images: top-level + attached to items', [
    { kind: 'image', image: { alt: 'hero', src: '_attachments/hero.png' } },
    { kind: 'list', listKind: 'bullet', items: [
      item([t('shot below')], { images: [{ alt: 'a(b)', src: '_attachments/x(1).png' }] }),
    ] },
  ]],
  ['image-shaped bullet text escapes', [
    { kind: 'list', listKind: 'bullet', items: [item([t('![alt](text.png)')])] },
  ]],
  ['blockquote multi-line + empty line', [
    { kind: 'quote', lines: [[t('first')], [], [t('with '), t('bold', { bold: true })]] },
  ]],
  ['code block with language', [
    { kind: 'code', language: 'ts', text: 'const a = 1;\nconst b = `x`;' },
  ]],
  ['code block containing a fence', [
    { kind: 'code', language: '', text: 'outer\n```inner\nstill code\n```\ndone' },
  ]],
  ['empty code block', [{ kind: 'code', language: 'js', text: '' }]],
  ['horizontal rule between paragraphs', [
    { kind: 'paragraph', inlines: [t('above')] },
    { kind: 'rule' },
    { kind: 'paragraph', inlines: [t('below')] },
  ]],
  ['adjacent lists stay separate', [
    { kind: 'list', listKind: 'bullet', items: [item([t('a')])] },
    { kind: 'list', listKind: 'bullet', items: [item([t('b')])] },
  ]],
  ['kitchen sink document', [
    { kind: 'heading', level: 1, inlines: [t('Doc')] },
    { kind: 'paragraph', inlines: [t('intro with [[link-target]]')] },
    { kind: 'list', listKind: 'bullet', items: [
      item([t('bullet with ', {}), t('code', { code: true })], {
        childKind: 'ordered',
        children: [item([t('one')]), item([t('two')], { childKind: 'bullet', children: [item([t('deep')])] })],
      }),
    ] },
    { kind: 'quote', lines: [[t('a quote')]] },
    { kind: 'code', language: 'sh', text: 'echo hi' },
    { kind: 'rule' },
    { kind: 'heading', level: 2, inlines: [t('End')] },
    { kind: 'paragraph', inlines: [t('bye')] },
  ]],
  ['task checkboxes stay literal bullet text', [
    { kind: 'list', listKind: 'bullet', items: [
      item([t('[ ] open task')]),
      item([t('[x] done task')], { childKind: 'bullet', children: [item([t('[X] caps stays literal')])] }),
      item([t('[ ] task with a [[wikilink]] inside')]),
      item([t('[x]no-space variant')]),
    ] },
  ]],
  ['empty document', []],
  ['tilde and star soup', [
    { kind: 'paragraph', inlines: [t('a*b ~ c~~d~~~e \\f `g')] },
  ]],
];

for (const [name, blocks] of blockTrees) {
  const md = blocksToMarkdown(blocks);
  const back = markdownToBlocks(md);
  check(`A: ${name}`, deepEq(back, blocks), JSON.stringify({ md, back }, null, 1));
}

// ---- B. serialize(parse(md)) === md (canonical file stability) ---------------

const fence = '```';
const canonicalDocs = [
  ['canonical document', [
    '# Title',
    '',
    'Intro paragraph with **bold** and a [[wikilink]].',
    '',
    '- one',
    '- two',
    '  1. sub one',
    '  2. sub two',
    '- three',
    '  ![shot](_attachments/a.png)',
    '',
    '> quoted line',
    '> second line',
    '',
    `${fence}js`,
    'const x = 1;',
    fence,
    '',
    '---',
    '',
    '![hero](_attachments/b.png)',
    '',
  ].join('\n')],
  ['canonical pdf attachment links', [
    'Attached: [report.pdf](_attachments/0b1c2d3e.pdf) for review.',
    '',
    '- bullet with [scan.pdf](_attachments/deadbeef.pdf) inline',
    '',
  ].join('\n')],
  ['canonical legacy outline (bullet-only file)', [
    '- # Heading',
    '  - child one',
    '    - grandchild',
    '  - child two',
    '- plain bullet with *italic*',
    '',
  ].join('\n')],
  ['canonical task list (Obsidian-compatible checkboxes)', [
    '- [ ] open task',
    '- [x] done task',
    '  - [ ] child task',
    '- plain bullet between tasks',
    '',
  ].join('\n')],
  ['canonical ordered roots', [
    '1. first',
    '2. second',
    '  - nested bullet',
    '3. third',
    '',
  ].join('\n')],
];

for (const [name, md] of canonicalDocs) {
  const back = blocksToMarkdown(markdownToBlocks(md));
  check(`B: ${name}`, back === md, JSON.stringify({ md, back }, null, 1));
}

// ---- C. tolerant parsing (legacy + hand-edited files) -------------------------

{
  // Legacy heading-bullet file: structure preserved exactly (NOT normalized to
  // top-level headings — documented choice), nothing lost.
  const md = '- # Section\n  - a\n- b\n';
  const blocks = markdownToBlocks(md);
  check(
    'C: legacy heading-bullet keeps list shape',
    blocks.length === 1 &&
      blocks[0].kind === 'list' &&
      blocks[0].items[0].heading === 1 &&
      blocks[0].items[0].children.length === 1 &&
      blocksToMarkdown(blocks) === md,
    JSON.stringify(blocks)
  );
}
{
  // Tab indent + '*' markers normalize to 2-space + '- '.
  const blocks = markdownToBlocks('* a\n\t* b\n');
  check(
    'C: tab indent + * markers normalize',
    blocksToMarkdown(blocks) === '- a\n  - b\n',
    blocksToMarkdown(blocks)
  );
}
{
  // Markerless indented line inside a list is promoted to a bullet (legacy).
  const blocks = markdownToBlocks('- a\n  loose continuation\n');
  check(
    'C: markerless list line promoted, not dropped',
    blocks.length === 1 && blocks[0].items[0].children[0].inlines[0].text === 'loose continuation',
    JSON.stringify(blocks)
  );
}
{
  // Blank line between bullets → two lists; all content survives.
  const blocks = markdownToBlocks('- a\n\n- b\n');
  check(
    'C: blank-separated bullets keep all content',
    blocks.length === 2 && blocks[0].kind === 'list' && blocks[1].kind === 'list',
    JSON.stringify(blocks)
  );
}
{
  // Unterminated code fence at EOF keeps its content.
  const blocks = markdownToBlocks('```py\nx = 1\n');
  check(
    'C: unterminated fence keeps content',
    blocks.length === 1 && blocks[0].kind === 'code' && blocks[0].text === 'x = 1',
    JSON.stringify(blocks)
  );
}
{
  // Hand-typed top-level prose + heading mix (no list) parses as document blocks.
  const blocks = markdownToBlocks('## Notes\nSome prose line.\nAnother line.\n');
  check(
    'C: prose lines become paragraphs under a heading',
    blocks.length === 3 && blocks[0].kind === 'heading' && blocks[1].kind === 'paragraph' && blocks[2].kind === 'paragraph',
    JSON.stringify(blocks)
  );
}
{
  // Task markers are LITERAL bullet text to the adapter (the checkbox is a
  // pure view-layer decoration) — `[X]`, bare `[ ]`, and ordered-task lines
  // all survive parse + re-serialize byte-identically.
  const md = '- [X] caps marker\n- [ ]\n';
  const blocks = markdownToBlocks(md);
  check(
    'C: task markers stay literal bullet text',
    blocks.length === 1 &&
      blocks[0].kind === 'list' &&
      blocks[0].items[0].inlines[0].text === '[X] caps marker' &&
      blocks[0].items[1].inlines[0].text === '[ ]' &&
      blocksToMarkdown(blocks) === md,
    JSON.stringify(blocks)
  );
}
{
  // 4+ hashes are NOT a heading (grammar pins 1–3).
  const blocks = markdownToBlocks('#### four hashes\n#tag without space\n');
  check(
    'C: #### and #tag stay paragraphs',
    blocks.length === 2 && blocks.every((b) => b.kind === 'paragraph'),
    JSON.stringify(blocks)
  );
}

// ---- report -------------------------------------------------------------------

console.log(`workbenchMarkdown round-trip battery: ${pass} passed, ${fail} failed (of ${pass + fail})`);
for (const f of failures) {
  console.error(`\nFAIL ${f.name}\n${f.detail}`);
}
process.exit(fail ? 1 : 0);
