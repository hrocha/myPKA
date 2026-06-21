// InboxView.tsx — the Team Inbox/ drop surface: the same folder tree as
// Deliverables (root=inbox) PLUS a whole-view drag-and-drop dropzone. Dropping
// (or picking) files reads them client-side (FileReader → base64), POSTs each
// to /api/cockpit/inbox/upload (session + CSRF write stack, 20 MB decoded cap,
// never overwrites — collisions get a timestamp suffix server-side), then
// refreshes the tree. Per-file chips show uploading / done / error.
//
// Previews ride /api/cockpit/inbox-file — the inbox twin of /api/cockpit/file
// (Team Inbox/ jail, pdf/images/text/md allowlist, inert no-script CSP).
import { useCallback, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Inbox, UploadCloud } from 'lucide-react';
import { FolderTree, FilePreviewPanel } from '../components/FolderTree';
import { fileRouteSrc } from '../lib/router';
import { cockpitWrite } from '../lib/useCockpitWrite';
import { PageHeader } from '../components/PageHeader';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // mirror of the server's decoded cap

interface UploadChip {
  id: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  message?: string;
}

interface UploadOkResult {
  ok: true;
  path: string;
  bytes: number;
}

// FileReader → pure base64 (strip the data-URL prefix the reader produces).
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function InboxView() {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [chips, setChips] = useState<UploadChip[]>([]);
  const [dragging, setDragging] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const dragDepth = useRef(0);
  const pickRef = useRef<HTMLInputElement | null>(null);

  const onFileOpen = useCallback((path: string) => setOpenPath(path), []);
  const onClose = useCallback(() => setOpenPath(null), []);

  const patchChip = useCallback((id: string, patch: Partial<UploadChip>) => {
    setChips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setChips((prev) => [...prev, { id, name: file.name, status: 'uploading' }]);

        if (file.size > MAX_UPLOAD_BYTES) {
          patchChip(id, { status: 'error', message: 'over the 20 MB limit' });
          continue;
        }

        try {
          const dataBase64 = await readFileAsBase64(file);
          const result = await cockpitWrite<UploadOkResult>(
            '/api/cockpit/inbox/upload',
            'POST',
            { filename: file.name, dataBase64 }
          );
          if (result.kind === 'ok') {
            patchChip(id, { status: 'done', message: result.data.path });
            setReloadToken((t) => t + 1); // refresh the tree
          } else if (result.kind === 'too-large') {
            patchChip(id, { status: 'error', message: 'over the 20 MB limit' });
          } else if (result.kind === 'auth') {
            patchChip(id, { status: 'error', message: 'session expired — log in again' });
          } else if (result.kind === 'error') {
            patchChip(id, { status: 'error', message: result.message });
          } else {
            patchChip(id, { status: 'error', message: result.kind });
          }
        } catch (err) {
          patchChip(id, { status: 'error', message: (err as Error).message || 'upload failed' });
        }
      }
    },
    [patchChip]
  );

  // ---- whole-view dropzone (depth counter so child enter/leave doesn't flicker)
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void uploadFiles(files);
    },
    [uploadFiles]
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = ''; // allow re-picking the same file
      if (files.length) void uploadFiles(files);
    },
    [uploadFiles]
  );

  return (
    <section
      className={`ft-view ft-dropzone animate-fade-rise${dragging ? ' ft-dropzone-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PageHeader
        title="Team Inbox"
        icon={Inbox}
        subtitle="Raw drops for the team — screenshots, voice memos, business cards, braindumps. Larry routes; Penn files."
        action={
          <button type="button" className="page-action-btn" onClick={() => pickRef.current?.click()}>
            <UploadCloud size={15} strokeWidth={1.5} aria-hidden="true" />
            Add files
          </button>
        }
      />

      <div className="ft-drop-hint">
        <span className="ft-drop-hint-icon" aria-hidden="true">
          <UploadCloud size={16} strokeWidth={1.5} />
        </span>
        <span>Drop files anywhere on this view to add them to the inbox (max 20 MB each).</span>
        <button type="button" className="ft-pick-button" onClick={() => pickRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={pickRef}
          type="file"
          multiple
          onChange={onPick}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {chips.length > 0 && (
        <ul className="ft-upload-chips" aria-live="polite" aria-label="Uploads">
          {chips.map((chip) => (
            <li
              key={chip.id}
              className={`ft-chip ft-chip-${chip.status}`}
              title={chip.message || chip.name}
            >
              {chip.status === 'uploading' && <span className="ft-chip-spinner" aria-hidden="true" />}
              {chip.status === 'done' && (
                <span className="ft-chip-icon" aria-hidden="true">
                  <CheckCircle2 size={12} strokeWidth={1.5} />
                </span>
              )}
              {chip.status === 'error' && (
                <span className="ft-chip-icon" aria-hidden="true">
                  <AlertCircle size={12} strokeWidth={1.5} />
                </span>
              )}
              <span className="ft-chip-name">{chip.name}</span>
              {chip.status === 'error' && chip.message && <span>— {chip.message}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className={openPath ? 'ft-layout ft-layout-split' : 'ft-layout'}>
        <FolderTree
          root="inbox"
          onFileOpen={onFileOpen}
          selectedPath={openPath}
          reloadToken={reloadToken}
        />
        {openPath && (
          <FilePreviewPanel
            path={openPath}
            fileUrl={`/api/cockpit/inbox-file?path=${encodeURIComponent(openPath)}`}
            src={fileRouteSrc('inbox-file', openPath)}
            onClose={onClose}
          />
        )}
      </div>
    </section>
  );
}
