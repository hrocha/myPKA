# Workbench Outliner — Best-Practice Review

**Date:** 2026-06-11 · **Reviewer:** Felix (Frontend) · **Benchmark set:** Workflowy, Logseq, Tana, Obsidian outline plugins
**Scope:** `web/src/lib/outlinerSchema.ts`, `outlinerEdit.ts`, `outlinerCollapse.ts`, `outlinerZoom.ts`, `outlinerReorder.ts`, `outlinerAria.ts`, `workbenchMarkdown.ts`, `components/workbench/OutlinerEditor.tsx`, the outliner sections of `cockpit.css`.

---

## 1. What's already strong (at or above benchmark)

- **Schema-enforced constraint.** `Document(content:'bulletList')` makes a non-bullet top-level line structurally impossible — no guard code to drift. Tana/Workflowy-grade discipline; most TipTap outliners get this wrong with paste guards.
- **Canonical Enter/Backspace/Delete semantics** from a researched decision table (Pax 2026-06-09), each op in ONE transaction (atomic undo), with the Logseq #9128 subtree-deletion failure mode explicitly guarded — merges always re-parent children, never drop them. This is better than Logseq itself was at that bug's vintage.
- **Collapse architecture.** View-only `collapsed` attr + decoration + CSS Grid `0fr→1fr` reveal (compositor-friendly, interruptible, one tween per toggle), `content-visibility:auto` perf skip with the collapsed-branch exception, localStorage persistence keyed by content-path that degrades safely on outside hand-edits.
- **Zoom / focus mode** with editable in-place title, breadcrumb trail as real buttons outside the contentEditable, zoom-boundary outdent guard, Enter-at-root-creates-child. Matches Workflowy's gold-standard zoom model.
- **Keyboard model.** Tab/Shift-Tab (sink/lift), **Alt+↑/↓ AND Mod+Shift+↑/↓ subtree reorder already present** (WCAG 2.1.1 drag alternative — checked `outlinerReorder.ts`, single-transaction, caret-preserving), Mod+. / Mod+Enter fold, Mod+↑/↓ zoom, Esc zoom-out, caret-skip over collapsed content (vertical AND horizontal, deferring to native motion when no hidden range is crossed — column memory preserved).
- **A11y.** `role=tree` + treeitem/group/`aria-level`/`aria-expanded` decorations (`outlinerAria.ts`), `aria-keyshortcuts`, an `sr-only` shortcut legend, ≥24px fold/drag hit targets (WCAG 2.5.8), reduced-motion fallbacks for every animation including the drag lift.
- **Markdown round-trip** is custom, dependency-free, property-testable, tolerant on parse (`- `/`* `/`+ `, tabs, markerless lines promoted — nothing hand-typed is ever lost) and strict on serialize (2-space indent, `- ` marker).
- **Instant mark formatting already live.** Verified in `node_modules`: the TipTap v3 Bold/Italic/Strike/Code extensions ship `markInputRule`s (`**`/`__`, `*`/`_`, `~~`, `` ` ``) and nothing disables `enableInputRules` — typing the closing token converts as-you-type, Obsidian-style.

## 2. Added in this pass (2026-06-11)

- **Block headings (Logseq-style).** New constrained `heading` node (levels 1–3, NOT in the `block` group so it can only ever be a bullet's own textblock; `ListItem content '(paragraph | heading) block*'`). `# ` / `## ` / `### ` at line start converts live (`textblockTypeInputRule`); Backspace at heading start demotes to paragraph (first Backspace strips the register, second merges); Enter at heading end yields a plain-paragraph sibling; mid-split keeps the heading on the first half; merges keep the merge target's register. Round-trips as `- # Heading text`; a paragraph literally starting with `# ` is leading-escaped (`- \# …`) so it stays a paragraph. Markerless `# Heading` lines from hand-edited files re-open as heading bullets.
- **Round-trip bug fixes (pre-existing):** `***bold italic***` now parses back (it serialized fine but mis-split on parse); link hrefs containing parens are escaped on serialize and unescaped on parse.
- **S quick win applied — multi-line plain-text paste → bullets.** Pasting multi-line plain text (markdown from Obsidian/terminal/editor) parses through the same tolerant reader as the file loader and inserts real nested bullets (markers, indent, headings, inline marks). Guards: empty selection only, ≥2 non-blank lines, no `text/html` flavor (rich pastes keep ProseMirror's parser), one transaction → one undo step. An empty leaf bullet is replaced in place; otherwise bullets insert as siblings after the caret's item.
- **Heading CSS** appended as one marked block at the end of `cockpit.css`: stepped register (1.35/1.15/1.05em, weight 560, tightened tracking), bullet-dot + brass collapsed halo + fold cursor parity with paragraph rows, zoom-root/ancestor parity, reduced-motion parity. Tokens only.

## 3. Gaps & recommendations (prioritized, effort-tagged)

| # | Gap | Benchmark behavior | Recommendation | Effort |
|---|-----|--------------------|----------------|--------|
| 1 | **Zoom breadcrumb label is empty for heading bullets.** `outlinerZoom.ts ownText()` reads only `paragraph` children. | Workflowy crumbs always show the row text. | Change the check to `child.isTextblock` (or `paragraph \|\| heading`). One line, but `outlinerZoom.ts` was outside this pass's file territory. | **S** (next pass) |
| 2 | **Copy does not produce markdown.** Copying a multi-bullet selection yields ProseMirror's HTML/plain rendering, not `- ` markdown — paste-in now understands markdown but copy-out doesn't speak it. | Logseq/Obsidian copy markdown. | Add `clipboardTextSerializer` (and optionally `clipboardSerializer`) that walks the selected listItems through `outlineToMarkdown`. | **M** |
| 3 | **Full-doc markdown serialization runs on every keystroke.** `onUpdate → editorMarkdown(ed)` is O(doc) per keypress; the save is debounced upstream but the serialize isn't. Fine at hundreds of bullets, measurable at thousands. | Workflowy virtualizes; Logseq serializes per-block. | Move serialization inside the debounce (pass the editor, serialize at save time), or serialize per-changed-subtree. | **M** |
| 4 | **Mobile/touch.** Drag handle is hover-positioned (no touch affordance), no long-press reorder, Alt/Mod shortcuts need a hardware keyboard, no VisualViewport/IME handling. Fold tap target is OK (≥24px gutter). | Workflowy mobile has tap-to-fold + drag affordances. | Touch pass with Knox: persistent grab affordance on coarse pointers, long-press drag, on-screen indent/outdent controls. | **M–L** |
| 5 | **Heading discoverability + level cycling.** `# ` typing is the only way in; no `Mod-Alt-1/2/3` toggles, no UI affordance, no way to change a heading's level except retype. | Logseq: `Mod-1..3` toggles; Obsidian: command palette. | Add `addKeyboardShortcuts` on the heading node (`Mod-Alt-1/2/3` toggle, repeat-press to clear) + document in the sr-only legend / `aria-keyshortcuts`. | **S–M** |
| 6 | Undo of fold state: collapse toggles are transactions, so Cmd-Z replays them interleaved with edits. Workflowy treats folds as non-undoable view state. | Add `appendedTransaction`/history filtering for `outlinerCollapse`-meta trs. | **M** |
| 7 | Multi-row structural selection: selecting across rows gives a flat text selection; Tab/reorder act on the caret row only. Workflowy/Tana select whole rows and operate on the set. | Row-selection model (NodeSelection set or decoration-based) + batch indent/move. | **L** |
| 8 | Large-doc rendering: no virtualization; `content-visibility:auto` mitigates but decorations (collapse/aria/zoom) rebuild on every doc change. | Map decorations through transactions instead of full rebuilds; consider windowing above ~2k visible rows. | **L** |
| 9 | `aria-expanded` exists, but fold state changes aren't announced (no live region on toggle). | Polite live region announcing "folded/unfolded, N items". | **S–M** (a11y polish; needs `outlinerCollapse.ts` or the component — component half is territory-safe next pass) |

**Applied this pass (S, zero-risk, in-territory):** multi-line paste → bullets (#row "paste behavior" in the brief); `***`/href-paren round-trip fixes. **Not applied:** Alt/Mod-Arrow reorder (already existed); everything tagged M/L above.

### Top-5 next actions
1. Heading-aware zoom breadcrumb label (`outlinerZoom.ts`, one line) — S.
2. Copy-as-markdown (`clipboardTextSerializer`) — M.
3. Serialize-at-debounce for large docs — M.
4. Touch/mobile affordance pass with Knox — M–L.
5. Heading level shortcuts (`Mod-Alt-1/2/3`) + discoverability — S–M.

## 4. Round-trip verification (no web test harness exists)

There is no web-side test runner (`server/workbench.attachments.test.mjs` is the only test in the repo). The round-trip contract was verified with a pure-function self-check run via node against the esbuild-bundled module:

```sh
cd Expansions/mypka-cockpit
./web/node_modules/.bin/esbuild web/src/lib/workbenchMarkdown.ts \
  --bundle --format=esm --outfile=/tmp/wm-check.mjs
node /tmp/wm-check-run.mjs   # property battery, 15 assertions
```

Battery (all passing, 15/15): `parse(serialize(X)) === X` for 10 outline trees — nested headings h1–h3, empty heading/bullet, marks inside headings, bold+italic combined, links with parens in href, paragraphs that LOOK like headings (`# not a heading` → escaped → stays a paragraph), hash-without-space (`#tag`, `####`, bare `#`/`##` — all stay paragraphs), images under heading bullets, sigils inside heading text. Plus `serialize(parse(md)) === md` for canonical markdown, and tolerant-parse checks (markerless `# Heading` lines, tab indent, `*` markers).

Manual editor-level checks (the adapter layer is a direct structural map; covered by the build's strict TS + these steps):
1. Type `## Title` in a bullet → converts on the space; check the `- ## Title` line in the saved file.
2. Backspace at the heading's start → demotes to paragraph; again → merges per Pax rows 6a/6b.
3. Enter at heading end → plain bullet below; mid-heading Enter → register stays on the first half.
4. Collapse a heading bullet with children → brass dot + halo on the heading row; fold/zoom/reorder/caret-skip all behave as on paragraph rows.
5. Paste a multi-line markdown snippet from a plain-text source → nested bullets with headings/marks materialized; single Cmd-Z removes the whole paste.
