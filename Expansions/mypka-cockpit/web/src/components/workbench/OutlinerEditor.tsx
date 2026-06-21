// OutlinerEditor.tsx — the Workbench DOCUMENT editor (Obsidian-style, 2026-06-11
// rewrite of the constrained bullet-only outliner).
//
// Lives ONLY in the lazy WorkbenchDocView chunk (TipTap+ProseMirror never touch
// the eager bundle). Composes:
//   - the document schema (outlinerSchema): paragraphs, h1–h3, bullet/ordered
//     lists, blockquote, codeBlock, horizontalRule, block images; ALL formatting
//     enters via markdown input rules (no toolbar).
//   - markdown round-trip in/out (workbenchMarkdown), debounced optimistic
//     autosave (useWorkbenchSave — transport payload unchanged).
//   - LIST outlining: Tab/Shift-Tab indent (ListKeymap), Alt/Mod-Shift-Arrow
//     subtree reorder (outlinerReorder), canonical Enter/Backspace/Delete
//     semantics inside lists (outlinerEdit), bullet-click collapse with the
//     `collapsed` attr + decoration + localStorage persistence (outlinerCollapse).
//   - HEADING FOLDING (outlinerHeadingFold): hover chevron next to top-level
//     h1–h3 folds everything below until the next same-or-higher heading;
//     view-only decoration state persisted to localStorage, never serialized.
//   - `[[` WIKILINK autocomplete (outlinerWikilink): inline popup over
//     /api/cockpit/search; Enter/click inserts plain `[[slug]]` text.
//   - TASK CHECKBOXES (outlinerCheckboxView): literal `[ ]` / `[x]` bullet
//     text renders as a clickable checkbox (decorations only — markdown SSOT).
//
// The zoom-into-bullet feature (outlinerZoom + breadcrumb UI) was REMOVED with
// the document-mode conversion; heading folding replaces it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { GripVertical } from 'lucide-react';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import {
  outlinerExtensions,
  blocksToTipTapDoc,
  blocksToNodesJSON,
  listItemsToJSON,
  editorMarkdown,
  outlinerImageName,
} from '../../lib/outlinerSchema';
import { markdownToBlocks } from '../../lib/workbenchMarkdown';
import { OutlinerImageNode } from './OutlinerImageView';
import {
  uploadWorkbenchAttachment,
  uploadErrorMessage,
  workbenchAttachmentSrc,
  type UploadResult,
} from '../../lib/workbenchAttachments';
import {
  CollapseAndAriaExtension,
  caretSkipTarget,
  horizontalSkipTarget,
  collectListItems,
  contentPathForPos,
  isListNodeName,
  readCollapseMap,
  writeCollapseMap,
} from '../../lib/outlinerCollapse';
import {
  HeadingFoldExtension,
  headingFoldHiddenRanges,
  toggleHeadingFoldAtSelection,
  unfoldHeadingAt,
  foldedSectionEndingAt,
  unfoldSection,
} from '../../lib/outlinerHeadingFold';
import { WikilinkExtension, isWikilinkActive } from '../../lib/outlinerWikilink';
import { WikilinkViewExtension } from '../../lib/outlinerWikilinkView';
import { CheckboxViewExtension } from '../../lib/outlinerCheckboxView';
import { moveListItem } from '../../lib/outlinerReorder';
import { outlinerEnter, outlinerBackspace, outlinerDelete } from '../../lib/outlinerEdit';

interface Props {
  /** The doc's slug — the file-path key for fold/collapse persistence. */
  slug: string;
  /** Initial markdown loaded from disk. */
  initialMarkdown: string;
  /** Editable? false when the write path is disabled (503) or the doc is read-only. */
  editable: boolean;
  /** Fires (debounced upstream) with the current markdown on every change. */
  onChange: (markdown: string) => void;
  /** Fires with the slugified target when Tom clicks a rendered [[wikilink]]
   *  (live-preview decoration). The host opens its context panel; the caret
   *  still lands in the text. Optional — without it links render but only
   *  style. */
  onWikilinkClick?: (slug: string) => void;
}

export function OutlinerEditor({ slug, initialMarkdown, editable, onChange, onWikilinkClick }: Props) {
  const initialDoc = useMemo<JSONContent>(
    () => blocksToTipTapDoc(markdownToBlocks(initialMarkdown)),
    [initialMarkdown]
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Ref-stable bridge so the extension (created once per [slug] editor instance)
  // always calls the LATEST handler without forcing an editor re-create.
  const onWikilinkClickRef = useRef(onWikilinkClick);
  onWikilinkClickRef.current = onWikilinkClick;

  // Calm inline notice for a failed image upload (415 / 413 / 503 / error). Never
  // a thrown error, never lost surrounding text — the editor stays usable.
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadErrorTimer = useRef<number | null>(null);
  const showUploadError = useCallback((msg: string) => {
    setUploadError(msg);
    if (uploadErrorTimer.current) window.clearTimeout(uploadErrorTimer.current);
    uploadErrorTimer.current = window.setTimeout(() => setUploadError(null), 6000);
  }, []);
  const showUploadErrorRef = useRef(showUploadError);
  showUploadErrorRef.current = showUploadError;
  useEffect(() => () => { if (uploadErrorTimer.current) window.clearTimeout(uploadErrorTimer.current); }, []);

  const editor = useEditor(
    {
      editable,
      extensions: [
        ...outlinerExtensions(OutlinerImageNode),
        // List collapse decoration + bullet-gutter-click + ARIA tree decoration;
        // `slug` keys the localStorage persistence (content-path keyed).
        CollapseAndAriaExtension(slug),
        // Obsidian-style heading folding (top-level h1–h3); view-only decoration
        // state, localStorage-persisted by heading text + occurrence index.
        HeadingFoldExtension(slug),
        // `[[` wikilink autocomplete popup (plain-text insert, round-trip-safe).
        WikilinkExtension(),
        // Live-preview wikilink rendering (decorations only — the doc text stays
        // raw `[[slug]]`) + click-to-preview into the host's context panel.
        WikilinkViewExtension((linkSlug) => onWikilinkClickRef.current?.(linkSlug)),
        // Clickable task checkboxes over literal `[ ]` / `[x]` bullet text
        // (decorations only — the doc text stays raw, markdown stays SSOT).
        CheckboxViewExtension(),
      ],
      content: initialDoc,
      // No autofocus jump on mount inside a scroll region (the view scrolls itself).
      autofocus: false,
      editorProps: {
        attributes: {
          'aria-label': 'Note editor',
          'aria-multiline': 'true',
          class: 'wb-outliner-content',
        },
        handleKeyDown(view, event) {
          // Keydown originating on a focused task-checkbox widget belongs to
          // the checkbox (outlinerCheckboxView's plugin toggles on Space/Enter)
          // — never run the outliner edit semantics off a stale text selection.
          if ((event.target as HTMLElement | null)?.closest?.('.wb-task-box')) return false;
          // While the wikilink popup is open, its plugin owns these keys — view-
          // level handlers run BEFORE plugin handlers, so step aside explicitly.
          if (
            isWikilinkActive(view.state) &&
            !event.metaKey && !event.ctrlKey && !event.altKey &&
            (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape' ||
              event.key === 'ArrowUp' || event.key === 'ArrowDown')
          ) {
            return false;
          }
          // Cmd/Ctrl+Enter and Cmd/Ctrl+. toggle the fold on the focused row:
          // heading fold when the caret is in a top-level heading, list collapse
          // when it is in a list row. preventDefault + return true so the list
          // keymap does NOT also split the bullet.
          if ((event.metaKey || event.ctrlKey) && (event.key === 'Enter' || event.key === '.')) {
            event.preventDefault();
            if (!toggleHeadingFoldAtSelection(view)) toggleCollapseAtSelection(view, slug);
            return true;
          }
          // Bare Enter: canonical outliner semantics inside lists (never steals
          // children, consults collapsed state), heading-exit at a heading's end.
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            // Typing right after a FOLDED heading would insert into the hidden
            // section — unfold it first so the new line is visible.
            const { $from } = view.state.selection;
            if ($from.depth === 1 && $from.parent.type.name === 'heading') {
              unfoldHeadingAt(view, $from.before(1));
            }
            if (outlinerEnter(view.state, view.dispatch)) {
              event.preventDefault();
              return true;
            }
          }
          // Backspace at the START of a bullet → merge into the previous node
          // (subtrees re-parent, never deleted). Also: Backspace at the start of
          // a top-level block sitting right AFTER a folded section unfolds the
          // section instead of silently editing hidden content.
          if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            const { $from } = view.state.selection;
            if ($from.parentOffset === 0 && $from.depth === 1) {
              const folded = foldedSectionEndingAt(view.state, $from.before(1));
              if (folded) {
                event.preventDefault();
                unfoldSection(view, folded.key);
                return true;
              }
            }
            if (outlinerBackspace(view.state, view.dispatch)) {
              event.preventDefault();
              return true;
            }
          }
          // Delete at the END of a bullet → merge the next node up (first-child
          // text only when expanded; never nuke the subtree).
          if (event.key === 'Delete' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            if (outlinerDelete(view.state, view.dispatch)) {
              event.preventDefault();
              return true;
            }
          }
          // Keyboard reorder (WCAG alternative to drag). Cmd/Ctrl+Shift+Arrow and
          // Alt+Arrow both move the focused LIST row (with its subtree).
          const reorderUp =
            ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'ArrowUp') ||
            (event.altKey && event.key === 'ArrowUp');
          const reorderDown =
            ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'ArrowDown') ||
            (event.altKey && event.key === 'ArrowDown');
          if (reorderUp) {
            event.preventDefault();
            return editorInstance.current ? moveListItem(editorInstance.current, -1) : false;
          }
          if (reorderDown) {
            event.preventDefault();
            return editorInstance.current ? moveListItem(editorInstance.current, 1) : false;
          }
          // Caret-skip over HIDDEN content (collapsed list subtrees AND folded
          // heading sections). PM's native vertical motion walks through hidden
          // positions; intercept plain (and Shift-extending) Arrow Up/Down and
          // jump straight to the next/previous VISIBLE row when — and ONLY when —
          // the step would otherwise enter a hidden range. When caretSkipTarget
          // returns null this is ordinary adjacent-row motion and we DEFER to
          // native PM (keeps column memory + soft-wrap correct).
          if (
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ) {
            const dir: -1 | 1 = event.key === 'ArrowDown' ? 1 : -1;
            const extra = headingFoldHiddenRanges(view.state);
            const target = caretSkipTarget(view.state.doc, view.state.selection.head, dir, extra);
            if (target !== null) {
              event.preventDefault();
              const { doc } = view.state;
              const sel = event.shiftKey
                ? TextSelection.create(doc, view.state.selection.anchor, target)
                : TextSelection.create(doc, target);
              view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
              return true;
            }
          }
          // Secondary: Right/Left at a hidden range's edge skips to the next/
          // previous visible row edge (same hidden-range sources).
          if (
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
          ) {
            const dir: -1 | 1 = event.key === 'ArrowRight' ? 1 : -1;
            const extra = headingFoldHiddenRanges(view.state);
            const target = horizontalSkipTarget(view.state.doc, view.state.selection.head, dir, extra);
            if (target !== null) {
              event.preventDefault();
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, target)).scrollIntoView()
              );
              return true;
            }
          }
          return false;
        },
        // Click on a plain markdown link whose href points into the attachments
        // store (a pasted PDF: `[name.pdf](_attachments/<uuid>.pdf)`) opens the
        // file through the jailed inline-preview route in a NEW tab. Other links
        // keep TipTap's openOnClick:false behavior (caret placement only).
        handleClick(_view, _pos, event) {
          if (event.button !== 0) return false;
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
          const a = (event.target as HTMLElement | null)?.closest?.('a[href]');
          if (!a) return false;
          const href = a.getAttribute('href') ?? '';
          if (!href.startsWith('_attachments/')) return false;
          event.preventDefault();
          window.open(workbenchAttachmentSrc(href), '_blank', 'noopener');
          return true;
        },
        // Paste of an image/PDF blob → upload + insert (images become image
        // nodes; PDFs become plain markdown links). Multi-line PLAIN-TEXT paste
        // (markdown copied from Obsidian / a terminal) → parsed through the same
        // tolerant reader the file loader uses and inserted as real blocks
        // (headings, lists, quotes, code — everything materializes). Everything
        // else falls through (return false) to TipTap's normal paste.
        handlePaste(view, event) {
          if (!view.editable) return false;
          const found = attachmentFileFromDataTransfer(event.clipboardData);
          if (!found) {
            if (pasteMultilineMarkdown(view, event.clipboardData)) {
              event.preventDefault();
              return true;
            }
            return false;
          }
          event.preventDefault();
          void startAttachmentUpload(
            editorInstance.current,
            found,
            view.state.selection.from,
            showUploadErrorRef.current
          );
          return true;
        },
        // Drop of an image/PDF file → upload + insert at the drop position. Other
        // drops (e.g. dragging a block) fall through to TipTap's drag handling.
        handleDrop(view, event, _slice, moved) {
          if (moved || !view.editable) return false; // internal node move — let PM handle it
          const dt = event.dataTransfer;
          const found = attachmentFileFromDataTransfer(dt);
          if (!found) return false;
          event.preventDefault();
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          const at = coords ? coords.pos : view.state.selection.from;
          void startAttachmentUpload(editorInstance.current, found, at, showUploadErrorRef.current);
          return true;
        },
      },
      onUpdate({ editor: ed }) {
        onChangeRef.current(editorMarkdown(ed as Editor));
      },
    },
    [slug] // re-create on slug change so the doc/fold state re-hydrate cleanly
  );

  const editorInstance = useRef<Editor | null>(null);
  editorInstance.current = editor ?? null;

  // Hydrate LIST collapse state from localStorage once the editor + doc exist.
  // Content-path mismatch (hand-edit outside the cockpit) → those paths simply
  // don't match any node → render expanded. Safe, lossless. (Heading folds
  // hydrate inside their own plugin's init.)
  useEffect(() => {
    if (!editor) return;
    const saved = readCollapseMap(slug);
    if (Object.keys(saved).length === 0) return;
    const items = collectListItems(editor.state.doc);
    let mutated = false;
    editor.commands.command(({ tr, dispatch }) => {
      for (const it of items) {
        if (saved[it.path] && it.hasChildren) {
          tr.setNodeAttribute(it.pos, 'collapsed', true);
          mutated = true;
        }
      }
      if (mutated && dispatch) dispatch(tr.setMeta('outlinerCollapse', true));
      return mutated;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, slug]);

  // Reflect editable changes (e.g. 503 flips the editor read-only) without a remount.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  if (!editor) {
    return <div className="wb-outliner wb-outliner--loading" aria-busy="true" />;
  }

  return (
    <div
      className="wb-outliner"
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Control+Shift+ArrowUp Control+Shift+ArrowDown Control+. Control+Enter"
      aria-describedby="wb-outliner-shortcuts"
    >
      {/* Make the reorder/fold shortcuts discoverable to keyboard + SR users. */}
      <p id="wb-outliner-shortcuts" className="sr-only">
        Format with markdown: hash for headings, dash for bullets, one period for
        numbered lists, greater-than for quotes, three backticks for code. Reorder
        list rows with Alt plus Up or Down arrow, or Control Shift plus Up or Down
        arrow. Fold or unfold the focused list row or heading section with Control
        period or Control Enter. Type two open brackets to link another note.
      </p>

      {/* Calm inline notice for a failed image upload. Polite live region so a SR
          announces it without stealing focus; auto-dismisses after a few seconds. */}
      {uploadError && (
        <p className="wb-img-error" role="status" aria-live="polite">
          {uploadError}
        </p>
      )}

      {editable && (
        <DragHandle
          editor={editor}
          nested={{ allowedContainers: ['bulletList', 'orderedList'] }}
          className="wb-drag-handle"
        >
          <button
            type="button"
            className="wb-drag-handle-btn"
            // The handle is a pointer affordance; keyboard users reorder via
            // Cmd+Shift+Arrow. Hidden from the a11y tree to avoid a duplicate,
            // non-operable control.
            aria-hidden="true"
            tabIndex={-1}
          >
            <GripVertical size={16} strokeWidth={1.5} />
          </button>
        </DragHandle>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

// ---- multi-line plain-text paste → document blocks --------------------------
//
// Pasting multi-line PLAIN text (no text/html flavor — i.e. markdown copied from
// Obsidian, a terminal, a code editor in plain mode) parses through the same
// tolerant reader the file loader uses (markdownToBlocks) and inserts REAL
// blocks: headings, nested lists, quotes, fenced code, images. Conservative
// guards: only an EMPTY (caret) selection, only when the text actually spans
// multiple lines, and only when no richer flavor exists. One transaction → one
// undo step. When the caret sits inside a LIST and the paste is purely a list,
// its items splice in as SIBLINGS (the Workflowy/Logseq behavior); otherwise the
// blocks insert after the caret's top-level block (replacing it when it is an
// empty paragraph).
function pasteMultilineMarkdown(
  view: import('@tiptap/pm/view').EditorView,
  dt: DataTransfer | null
): boolean {
  if (!dt) return false;
  if (Array.from(dt.types ?? []).includes('text/html')) return false; // rich paste → default
  const text = dt.getData('text/plain');
  if (!text || !text.trim() || !/\S[^\n]*\n[\s\S]*\S/.test(text)) return false; // single line → default
  const { state } = view;
  if (!state.selection.empty) return false; // replace-selection paste → default

  const blocks = markdownToBlocks(text);
  if (blocks.length === 0) return false;

  const { $from } = state.selection;

  // In-list splice: caret inside a listItem AND the paste is exactly one list.
  let itemDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'listItem') {
      itemDepth = d;
      break;
    }
  }
  const tr = state.tr;
  let insertAt: number;
  let fragment: Fragment;
  const first = blocks[0];
  try {
    if (itemDepth !== -1 && blocks.length === 1 && first.kind === 'list') {
      const items = listItemsToJSON(first.items).map((json) => state.schema.nodeFromJSON(json));
      fragment = Fragment.from(items);
      const itemNode = $from.node(itemDepth);
      const itemPos = $from.before(itemDepth);
      // An EMPTY leaf bullet is replaced in place; otherwise the pasted items
      // become siblings AFTER the caret's item (its subtree stays intact).
      const isEmptyLeaf = itemNode.childCount === 1 && itemNode.child(0).content.size === 0;
      if (isEmptyLeaf) {
        tr.replaceWith(itemPos, itemPos + itemNode.nodeSize, fragment);
        insertAt = itemPos;
      } else {
        insertAt = itemPos + itemNode.nodeSize;
        tr.insert(insertAt, fragment);
      }
    } else {
      const nodes = blocksToNodesJSON(blocks).map((json) => state.schema.nodeFromJSON(json));
      fragment = Fragment.from(nodes);
      const topNode = $from.node(1);
      const topPos = $from.before(1);
      const isEmptyParagraph = topNode.type.name === 'paragraph' && topNode.content.size === 0;
      if (isEmptyParagraph) {
        tr.replaceWith(topPos, topPos + topNode.nodeSize, fragment);
        insertAt = topPos;
      } else {
        insertAt = $from.after(1);
        tr.insert(insertAt, fragment);
      }
    }
  } catch {
    return false; // anything unexpected → let the default paste run
  }

  // Caret to the end of the pasted content (the last textblock inside it).
  const end = Math.min(insertAt + fragment.size, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

// ---- image/PDF paste/drop upload pipeline -----------------------------------

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;
const PDF_MIME = 'application/pdf';
// Client-side pre-caps mirroring the server's decoded-byte limits — a cheap
// early refusal so we never base64-encode a hopeless payload. The server stays
// the authority (it re-checks on sniffed bytes).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

interface AttachmentFile {
  file: File;
  kind: 'image' | 'pdf';
}

function classifyFile(f: File): AttachmentFile | null {
  if (IMAGE_MIME.test(f.type)) return { file: f, kind: 'image' };
  if (f.type === PDF_MIME || (!f.type && /\.pdf$/i.test(f.name))) return { file: f, kind: 'pdf' };
  return null;
}

// Pull the first supported File (raster image or PDF) out of a clipboard/drag
// DataTransfer, or null if none. SVG (image/svg+xml) is intentionally NOT
// matched — the backend rejects it (415), so we never even start the upload.
function attachmentFileFromDataTransfer(dt: DataTransfer | null): AttachmentFile | null {
  if (!dt) return null;
  const files = dt.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i);
      const found = f && classifyFile(f);
      if (found) return found;
    }
  }
  // Paste of a blob-from-clipboard arrives as a DataTransferItem, not a file.
  const items = dt.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      const found = f && classifyFile(f);
      if (found) return found;
    }
  }
  return null;
}

let pendingSeq = 0;

// Route an accepted paste/drop file to its insert shape: images become block
// image nodes; PDFs become plain markdown links `[name.pdf](_attachments/…)`.
async function startAttachmentUpload(
  editor: Editor | null,
  found: AttachmentFile,
  at: number,
  onError: (msg: string) => void
): Promise<void> {
  const cap = found.kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (found.file.size > cap) {
    onError(uploadErrorMessage({ kind: 'too-large' }));
    return;
  }
  if (found.kind === 'pdf') return startPdfUpload(editor, found.file, at, onError);
  return startImageUpload(editor, found.file, at, onError);
}

// Insert an optimistic uploading placeholder at `at`, upload the blob, then either
// fill in the returned RELATIVE path (success) or remove the placeholder + show a
// calm notice (failure). Surrounding text is never touched on failure.
async function startImageUpload(
  editor: Editor | null,
  file: File,
  at: number,
  onError: (msg: string) => void
): Promise<void> {
  if (!editor) return;
  const pendingId = `up-${Date.now()}-${pendingSeq++}`;

  // Optimistic placeholder. insertContentAt is schema-validated; if `at` isn't a
  // valid block boundary, ProseMirror lifts it to the nearest legal spot.
  editor
    .chain()
    .insertContentAt(at, {
      type: outlinerImageName,
      attrs: { src: '', alt: '', uploading: true, pendingId },
    })
    .run();

  let result: UploadResult;
  try {
    result = await uploadWorkbenchAttachment(file);
  } catch {
    result = { kind: 'error', status: 0, message: 'upload failed' };
  }

  const pos = findPendingImagePos(editor, pendingId);
  if (pos === null) return; // placeholder gone (doc reset / node deleted) — nothing to do

  if (result.kind === 'ok') {
    // Resolve the node view's display src from the RELATIVE path at render time;
    // the stored attr (and thus the markdown) keeps the relative path.
    editor.view.dispatch(
      editor.view.state.tr
        .setNodeAttribute(pos, 'src', result.path)
        .setNodeAttribute(pos, 'uploading', false)
        .setNodeAttribute(pos, 'pendingId', null)
    );
    // The attr change fires onUpdate → autosave persists the new markdown.
  } else {
    // Remove the placeholder node cleanly (one block), leave everything else.
    const node = editor.view.state.doc.nodeAt(pos);
    const size = node ? node.nodeSize : 1;
    editor.view.dispatch(editor.view.state.tr.delete(pos, pos + size));
    onError(uploadErrorMessage(result));
  }
}

// Upload a pasted/dropped PDF and insert a plain markdown LINK
// `[name.pdf](_attachments/<uuid>.pdf)` — never an image node. Reuses the same
// optimistic placeholder node as images while the bytes are in flight (it
// renders the calm uploading figure and gives us a position-stable correlation
// id); on success the placeholder is REPLACED by a paragraph holding the linked
// file name (insertContentAt is schema-validated, so a placeholder that landed
// inside a list item still resolves to a legal spot). On failure the
// placeholder is removed and a calm notice shows — surrounding text untouched.
async function startPdfUpload(
  editor: Editor | null,
  file: File,
  at: number,
  onError: (msg: string) => void
): Promise<void> {
  if (!editor) return;
  const pendingId = `up-${Date.now()}-${pendingSeq++}`;

  editor
    .chain()
    .insertContentAt(at, {
      type: outlinerImageName,
      attrs: { src: '', alt: file.name, uploading: true, pendingId },
    })
    .run();

  let result: UploadResult;
  try {
    result = await uploadWorkbenchAttachment(file);
  } catch {
    result = { kind: 'error', status: 0, message: 'upload failed' };
  }

  const pos = findPendingImagePos(editor, pendingId);
  if (pos === null) return; // placeholder gone (doc reset / node deleted) — nothing to do

  const node = editor.view.state.doc.nodeAt(pos);
  const size = node ? node.nodeSize : 1;

  if (result.kind === 'ok') {
    // Display text: the original file name (single-line); href: the RELATIVE
    // path the server minted — exactly what the markdown stores. The serializer
    // escapes link text/URL, so any file name round-trips losslessly.
    const name = file.name.replace(/\s+/g, ' ').trim() || result.filename || 'document.pdf';
    editor
      .chain()
      .command(({ tr }) => {
        tr.delete(pos, pos + size);
        return true;
      })
      .insertContentAt(pos, {
        type: 'paragraph',
        content: [
          { type: 'text', text: name, marks: [{ type: 'link', attrs: { href: result.path } }] },
        ],
      })
      .run();
    // The insert fires onUpdate → autosave persists the new markdown.
  } else {
    editor.view.dispatch(editor.view.state.tr.delete(pos, pos + size));
    onError(uploadErrorMessage(result));
  }
}

// Locate the doc position of the in-flight placeholder image carrying `pendingId`.
// Positions shift while the user keeps typing, so we search by the correlation id
// rather than trust the original insert position.
function findPendingImagePos(editor: Editor, pendingId: string): number | null {
  let found: number | null = null;
  editor.view.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === outlinerImageName && node.attrs.pendingId === pendingId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

// Toggle the `collapsed` attr on the listItem at the current selection, persist to
// localStorage by content-path, and tag the tr so the decoration + ARIA plugins
// rebuild. Defined module-scope (no closure over render state) and called from the
// keydown handler with the live view.
function toggleCollapseAtSelection(view: import('@tiptap/pm/view').EditorView, slug: string): void {
  const { state } = view;
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'listItem') {
      let hasChildren = false;
      node.forEach((c) => {
        if (isListNodeName(c.type.name)) hasChildren = true;
      });
      if (!hasChildren) return; // nothing to fold
      const pos = $from.before(depth);
      const next = !(node.attrs.collapsed === true);
      const tr = state.tr.setNodeAttribute(pos, 'collapsed', next).setMeta('outlinerCollapse', true);
      view.dispatch(tr);
      const path = contentPathForPos(view.state.doc, pos);
      if (path) {
        const map = readCollapseMap(slug);
        if (next) map[path] = true;
        else delete map[path];
        writeCollapseMap(slug, map);
      }
      return;
    }
  }
}
