// RecentlyScannedCard.tsx — the Hub's "Recently Scanned Documents" module.
//
// UX DECISION (Felix, 2026-06-16): rather than add a redundant server endpoint,
// this reuses the existing read-only /api/cockpit/documents (already newest-
// first: frontmatter date DESC, undated last) and filters client-side to the
// scan/receipt/invoice subset a paperless workflow cares about. It is a FOCUSED
// companion to the existing "Latest documents" card, not a replacement:
//   * Latest documents  → every document note, freshest first (broad).
//   * Recently Scanned   → only doc_type ∈ {invoice, receipt, scan, ...} OR docs
//                          with an attached file — the "what just came off the
//                          scanner" view. Newest first, capped at 6.
// Keeping both is the cleaner UX: a user with a flood of contracts still sees
// the scans surface separately, and the toggle (Settings) hides either freely.
//
// Each row: title, doc_type chip, date, link to the doc's NoteView.
import { ScanLine, FileText } from 'lucide-react';
import { useFetch } from '../../lib/useCockpit';
import { navigate } from '../../lib/router';
import type { DocumentRow, DocumentsResponse } from '../DocumentsView';
import { HubSection } from './HubSection';

// doc_type values that represent something that came off a scanner / camera /
// inbox. Lowercased compare; tolerant of the scaffold's DE+EN mix.
const SCAN_TYPES = new Set([
  'invoice', 'receipt', 'scan', 'bill', 'statement',
  'rechnung', 'beleg', 'quittung', 'kontoauszug',
]);

function isScanLike(doc: DocumentRow): boolean {
  const t = (doc.doc_type || '').trim().toLowerCase();
  if (SCAN_TYPES.has(t)) return true;
  // A document note that carries an attached file (pdfPath resolved) is, in a
  // paperless workflow, almost always a scan/receipt — include it as a fallback
  // so a scaffold that doesn't tag doc_type still surfaces something useful.
  return !!doc.pdfPath;
}

export function RecentlyScannedCard() {
  const { data } = useFetch<DocumentsResponse>('/api/cockpit/documents');
  if (!data) return null;

  const scans = data.items.filter(isScanLike).slice(0, 6);

  return (
    <HubSection
      icon={ScanLine}
      title="Recently Scanned"
      hint="Scans, receipts and invoices — freshest first"
      action={{ label: 'All documents', onClick: () => navigate({ name: 'type', type: 'documents' }) }}
    >
      {scans.length === 0 ? (
        <p className="hub-empty">No scanned documents yet.</p>
      ) : (
        <div className="hub-docs" role="list">
          {scans.map((d) => <ScanCard key={d.slug} doc={d} />)}
        </div>
      )}
    </HubSection>
  );
}

function ScanCard({ doc }: { doc: DocumentRow }) {
  return (
    <button
      type="button"
      role="listitem"
      className="hub-doc"
      onClick={() => navigate({ name: 'note', type: 'documents', slug: doc.slug })}
    >
      <span className="hub-doc-glyph" aria-hidden="true">
        <FileText size={15} strokeWidth={1.5} />
      </span>
      <span className="hub-doc-title">{doc.title}</span>
      <span className="hub-doc-meta">
        {doc.doc_type && <em className="hub-doc-chip">{doc.doc_type}</em>}
        {doc.date && <span className="hub-doc-date">{doc.date}</span>}
        {!doc.pdfPath && <span className="hub-doc-nofile">no file</span>}
      </span>
    </button>
  );
}
