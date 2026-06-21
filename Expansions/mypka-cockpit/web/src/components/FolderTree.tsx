// FolderTree.tsx — reusable folder-tree browser for the Deliverables and Team
// Inbox views (visual reference: the myICOR scaffold-tree component — dark card,
// chevron + brass folder glyphs, mono labels, vertical indent guide lines).
//
// Data: GET /api/cockpit/tree?root=deliverables|inbox (read-only, jailed
// server-side in server/filetree.js). Node paths are REPO-ROOT-relative
// ("Deliverables/2026-…/brief.md", "Team Inbox/photo.png"), which is exactly
// what the preview routes (/api/cockpit/file, /api/cockpit/inbox-file) accept.
//
// A11y: role=tree/treeitem with aria-level/aria-expanded/aria-selected, roving
// tabindex, full arrow-key navigation (Up/Down walk visible rows, Right expands
// or enters, Left collapses or jumps to parent, Enter/Space activates,
// Home/End jump). Tokens only — every colour in foldertree.css resolves to an
// index.css :root custom property.
//
// Also exports FilePreviewPanel — the right-docked preview both views share
// (md/txt through WikiMarkdown, pdf in an <iframe>, images in an <img>, calm
// "no preview" for everything else). Its "Large" affordance navigates to the
// routed #/file/<src> reading page (views/FileView.tsx) — normal cockpit
// chrome, sidebar visible, browser back works — exactly like opening a note.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Maximize2,
  X,
} from 'lucide-react';
import { WikiMarkdown } from './WikiMarkdown';
import { navigate } from '../lib/router';
import './foldertree.css';

export interface TreeNode {
  name: string;
  path: string; // repo-root-relative, forward slashes
  kind: 'dir' | 'file';
  size: number;
  mtime: number;
  children?: TreeNode[];
}

interface TreeResponse {
  ok: boolean;
  root: TreeNode;
  truncated: boolean;
  entryCount: number;
  generatedAt: string;
}

// ---- file-icon mapping (Lucide UI-icon convention: 16px @ strokeWidth 1.5) ----
const EXT_ICONS: Record<string, LucideIcon> = {
  md: FileText, txt: FileText, pdf: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage, svg: FileImage, heic: FileImage,
  mp3: FileAudio, m4a: FileAudio, wav: FileAudio, aac: FileAudio, ogg: FileAudio,
  mp4: FileVideo, mov: FileVideo, webm: FileVideo,
  zip: FileArchive, gz: FileArchive, tar: FileArchive,
  csv: FileSpreadsheet, xlsx: FileSpreadsheet, numbers: FileSpreadsheet,
  json: FileCode, js: FileCode, ts: FileCode, py: FileCode, sh: FileCode, yaml: FileCode, yml: FileCode,
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function fileIconFor(name: string): LucideIcon {
  return EXT_ICONS[extOf(name)] ?? File;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- flatten the visible rows (expanded dirs only) for render + keyboard ------
interface FlatRow {
  node: TreeNode;
  depth: number; // 0 = direct child of the root
  parentPath: string | null;
}

function flattenVisible(root: TreeNode, expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const visit = (node: TreeNode, depth: number, parentPath: string | null) => {
    rows.push({ node, depth, parentPath });
    if (node.kind === 'dir' && expanded.has(node.path)) {
      for (const child of node.children ?? []) visit(child, depth + 1, node.path);
    }
  };
  for (const child of root.children ?? []) visit(child, 0, null);
  return rows;
}

export function FolderTree({
  root,
  onFileOpen,
  selectedPath = null,
  reloadToken = 0,
}: {
  /** Which jailed server root to browse. */
  root: 'deliverables' | 'inbox';
  /** A file row was activated (click / Enter). Receives the repo-relative path. */
  onFileOpen: (path: string) => void;
  /** Highlight the currently-previewed file. */
  selectedPath?: string | null;
  /** Bump to force a re-fetch (e.g. after an inbox upload). */
  reloadToken?: number;
}) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const seededRef = useRef(false);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Own fetch (not useFetch) so reloadToken can re-pull without a URL hack,
  // and so a refresh preserves the expansion state.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/cockpit/tree?root=${encodeURIComponent(root)}`, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`Server responded ${r.status}`);
        return r.json() as Promise<TreeResponse>;
      })
      .then((data) => {
        if (!alive) return;
        setTree(data);
        setLoading(false);
        // Default expansion: top-level folders open (once per mount, so a
        // refresh after upload doesn't fight the user's collapse choices).
        if (!seededRef.current) {
          seededRef.current = true;
          const seed = new Set<string>();
          for (const child of data.root.children ?? []) {
            if (child.kind === 'dir') seed.add(child.path);
          }
          setExpanded(seed);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError((err as Error).message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [root, reloadToken]);

  const rows = useMemo(
    () => (tree ? flattenVisible(tree.root, expanded) : []),
    [tree, expanded]
  );

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activate = useCallback(
    (row: FlatRow) => {
      setFocusPath(row.node.path);
      if (row.node.kind === 'dir') toggleDir(row.node.path);
      else onFileOpen(row.node.path);
    },
    [toggleDir, onFileOpen]
  );

  // Roving focus: move DOM focus to the row whose path === focusPath.
  const focusRow = useCallback((path: string) => {
    setFocusPath(path);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
      el?.focus();
    });
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, row: FlatRow, index: number) => {
      const { node } = row;
      const isOpen = node.kind === 'dir' && expanded.has(node.path);
      switch (e.key) {
        case 'ArrowDown':
          if (index + 1 < rows.length) focusRow(rows[index + 1].node.path);
          break;
        case 'ArrowUp':
          if (index > 0) focusRow(rows[index - 1].node.path);
          break;
        case 'ArrowRight':
          if (node.kind === 'dir' && !isOpen) toggleDir(node.path);
          else if (isOpen && (node.children?.length ?? 0) > 0) focusRow(node.children![0].path);
          break;
        case 'ArrowLeft':
          if (isOpen) toggleDir(node.path);
          else if (row.parentPath) focusRow(row.parentPath);
          break;
        case 'Enter':
        case ' ':
          activate(row);
          break;
        case 'Home':
          if (rows.length) focusRow(rows[0].node.path);
          break;
        case 'End':
          if (rows.length) focusRow(rows[rows.length - 1].node.path);
          break;
        default:
          return; // let everything else through
      }
      e.preventDefault();
    },
    [rows, expanded, focusRow, toggleDir, activate]
  );

  if (loading && !tree) {
    return <div className="ft-card ft-card-empty" aria-busy="true"><div className="skeleton-block" /></div>;
  }
  if (error) {
    return <div role="alert" className="view-error">Could not load the folder tree: {error}</div>;
  }
  if (!tree) return null;

  const tabStopPath = focusPath ?? rows[0]?.node.path ?? null;

  return (
    <div className="ft-card">
      <ul
        ref={listRef}
        role="tree"
        aria-label={tree.root.name}
        className="ft-tree"
      >
        {rows.length === 0 && (
          <li className="ft-empty">This folder is empty.</li>
        )}
        {rows.map((row, index) => {
          const { node, depth } = row;
          const isDir = node.kind === 'dir';
          const isOpen = isDir && expanded.has(node.path);
          const isSelected = !isDir && node.path === selectedPath;
          const FileIcon = isDir ? (isOpen ? FolderOpen : Folder) : fileIconFor(node.name);
          return (
            <li key={node.path} role="none">
              <div
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={isDir ? isOpen : undefined}
                aria-selected={isSelected || undefined}
                data-path={node.path}
                tabIndex={node.path === tabStopPath ? 0 : -1}
                className={`ft-row${isSelected ? ' ft-row-selected' : ''}`}
                onClick={() => activate(row)}
                onKeyDown={(e) => onKeyDown(e, row, index)}
                onFocus={() => setFocusPath(node.path)}
              >
                {Array.from({ length: depth }, (_, i) => (
                  <span key={i} className="ft-guide" aria-hidden="true" />
                ))}
                <span className={`ft-chevron${isOpen ? ' ft-chevron-open' : ''}`} aria-hidden="true">
                  {isDir && <ChevronRight size={14} strokeWidth={1.5} />}
                </span>
                <span className={isDir ? 'ft-icon ft-icon-folder' : 'ft-icon ft-icon-file'} aria-hidden="true">
                  <FileIcon size={16} strokeWidth={1.5} />
                </span>
                <span className="ft-name truncate-fade">{node.name}</span>
                {!isDir && <span className="ft-size">{formatSize(node.size)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {tree.truncated && (
        <p className="ft-truncated">
          Large folder — showing the first {tree.entryCount} entries.
        </p>
      )}
    </div>
  );
}

// ---- FilePreviewPanel — the right-docked preview both tree views share --------
// `fileUrl` is the jailed serving route for the host view's root:
//   Deliverables -> /api/cockpit/file?path=Deliverables/…
//   Team Inbox   -> /api/cockpit/inbox-file?path=Team%20Inbox/…
// md/txt are FETCHED as text and rendered in-app (markdown through the
// sanitized WikiMarkdown component); pdf/images embed via <iframe>/<img> on the
// same URL; everything else gets a calm "no preview" note with the path.
const TEXT_EXTS = new Set(['md', 'txt']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

export function FilePreviewPanel({
  path,
  fileUrl,
  src,
  onClose,
}: {
  /** Repo-relative path (display + ext detection). */
  path: string;
  /** Full jailed serving URL for this file. */
  fileUrl: string;
  /** File-route src for the "Large" reading page (build with fileRouteSrc). */
  src: string;
  onClose: () => void;
}) {
  const name = path.split('/').pop() || path;
  const ext = extOf(name);
  const kind = previewKindFor(name);

  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [embedFailed, setEmbedFailed] = useState(false);

  useEffect(() => {
    setText(null);
    setTextError(null);
    setEmbedFailed(false);
    if (kind !== 'text') return;
    let alive = true;
    fetch(fileUrl, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`Server responded ${r.status}`);
        return r.text();
      })
      .then((body) => { if (alive) setText(body); })
      .catch((err: unknown) => { if (alive) setTextError((err as Error).message); });
    return () => { alive = false; };
  }, [fileUrl, kind]);

  const FileIcon = fileIconFor(name);

  return (
    <aside className="ft-preview" aria-label={`Preview: ${name}`}>
      <header className="ft-preview-head">
        <FileIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="ft-preview-name truncate-fade">{name}</span>
        {kind !== 'none' && (
          <button
            type="button"
            className="ft-preview-open"
            onClick={() => navigate({ name: 'file', src })}
            title="Open the large reading page"
          >
            <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" /> Large
          </button>
        )}
        <button type="button" className="ft-preview-close" onClick={onClose} aria-label="Close preview">
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="ft-preview-body">
        {kind === 'text' && textError && (
          <p role="alert" className="ft-preview-note">Could not load the file: {textError}</p>
        )}
        {kind === 'text' && text === null && !textError && (
          <div className="skeleton-block" aria-busy="true" />
        )}
        {kind === 'text' && text !== null && (
          ext === 'md'
            ? <WikiMarkdown body={text} />
            : <pre className="ft-preview-plain">{text}</pre>
        )}

        {kind === 'image' && !embedFailed && (
          <img
            className="ft-preview-image"
            src={fileUrl}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => setEmbedFailed(true)}
          />
        )}
        {kind === 'pdf' && !embedFailed && (
          <iframe
            className="ft-preview-frame"
            src={fileUrl}
            title={`Preview: ${name}`}
            loading="lazy"
            onError={() => setEmbedFailed(true)}
          />
        )}

        {(kind === 'none' || embedFailed) && (
          <div className="ft-preview-none">
            <p className="ft-preview-note">
              {embedFailed
                ? 'The file could not be displayed.'
                : `No inline preview for ${ext ? `.${ext}` : 'this file type'}.`}
            </p>
            <p className="ft-preview-path">{path}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

// Shared kind detection for the preview panel + the routed FileView reading
// page (views/FileView.tsx — which replaced the old FileFullscreenOverlay).
export function previewKindFor(name: string): 'text' | 'image' | 'pdf' | 'none' {
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'none';
}
