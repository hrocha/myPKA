// DeliverablesView.tsx — browse the Deliverables/ working surface as a folder
// tree (collapsible dirs, brass folder glyphs, mono labels — the myICOR
// scaffold-tree look) with a right-docked file preview.
//
// Data: GET /api/cockpit/tree?root=deliverables (server/filetree.js, read-only,
// jailed). Previews ride the EXISTING /api/cockpit/file route — it already
// jails repo-relative Deliverables/ paths and serves md/txt/pdf/images inline
// with an inert no-script CSP. md/txt are fetched as text and rendered in-app
// (markdown through the sanitized WikiMarkdown); pdf/images embed natively;
// anything else gets a calm "no preview" note with the path.
import { useCallback, useState } from 'react';
import { Package } from 'lucide-react';
import { FolderTree, FilePreviewPanel } from '../components/FolderTree';
import { fileRouteSrc } from '../lib/router';
import { PageHeader } from '../components/PageHeader';

export function DeliverablesView() {
  const [openPath, setOpenPath] = useState<string | null>(null);

  const onFileOpen = useCallback((path: string) => setOpenPath(path), []);
  const onClose = useCallback(() => setOpenPath(null), []);

  return (
    <section className="ft-view animate-fade-rise">
      <PageHeader
        title="Deliverables"
        icon={Package}
        subtitle="The team’s working surface — research briefs, hire workups, multi-file artifacts. Click a file to preview it."
      />

      <div className={openPath ? 'ft-layout ft-layout-split' : 'ft-layout'}>
        <FolderTree root="deliverables" onFileOpen={onFileOpen} selectedPath={openPath} />
        {openPath && (
          <FilePreviewPanel
            path={openPath}
            fileUrl={`/api/cockpit/file?path=${encodeURIComponent(openPath)}`}
            src={fileRouteSrc('file', openPath)}
            onClose={onClose}
          />
        )}
      </div>
    </section>
  );
}
