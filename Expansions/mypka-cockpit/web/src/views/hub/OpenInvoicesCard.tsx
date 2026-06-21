// OpenInvoicesCard.tsx — the Hub's "Open Invoices" module.
//
// Reads the read-only /api/cockpit/invoices/open endpoint (Silas's
// v_open_invoices view, payee resolved server-side). Renders OVERDUE first,
// loud (--status-error), then DUE-SOON (≤7d) as a warning (--status-warning).
// Each row links to the invoice's note view (#/note/documents/:slug) — the same
// universal NoteView that shows the invoice↔contract connection panels.
//
// Finance labels are English: "overdue by N days" / "due in N days". Amounts
// use the invoice's own currency via Intl.
import { AlertTriangle, ReceiptText, Clock, ArrowRight } from 'lucide-react';
import { useFetch } from '../../lib/useCockpit';
import { navigate, hrefFor } from '../../lib/router';
import { ModuleEmptyState } from '../../components/ui';
import type { OpenInvoice, OpenInvoicesResponse } from '../../lib/cockpitExtras';

// "overdue by 17 days" / "due in 4 days" / "due today".
function dueLabel(inv: OpenInvoice): string {
  const d = inv.daysUntilDue;
  if (d == null) return inv.dueDate ? `due on ${inv.dueDate}` : 'due';
  if (d < 0) {
    const n = Math.abs(d);
    return `overdue by ${n} ${n === 1 ? 'day' : 'days'}`;
  }
  if (d === 0) return 'due today';
  return `due in ${d} ${d === 1 ? 'day' : 'days'}`;
}

function formatAmount(amount: number | null, currency: string): string {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    // Unknown currency code → bare number + raw code (never throws on the Hub).
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function InvoiceRow({ inv }: { inv: OpenInvoice }) {
  const state = inv.isOverdue ? 'overdue' : inv.isDueSoon ? 'soon' : 'open';
  return (
    <a
      role="listitem"
      className="hub-invoice"
      data-state={state}
      href={hrefFor({ name: 'note', type: 'documents', slug: inv.slug })}
    >
      <span className="hub-invoice-glyph" aria-hidden="true">
        {inv.isOverdue
          ? <AlertTriangle size={15} strokeWidth={1.75} />
          : <Clock size={15} strokeWidth={1.5} />}
      </span>
      <span className="hub-invoice-main">
        <span className="hub-invoice-payee">{inv.payee ?? inv.title}</span>
        <span className="hub-invoice-sub">
          {inv.invoiceNumber && <span className="hub-invoice-num">{inv.invoiceNumber}</span>}
          {inv.dueDate && <span className="hub-invoice-date">{inv.dueDate}</span>}
        </span>
      </span>
      <span className="hub-invoice-right">
        <span className="hub-invoice-amount">{formatAmount(inv.amount, inv.currency)}</span>
        <span className="hub-invoice-due" data-state={state}>{dueLabel(inv)}</span>
      </span>
      <ArrowRight className="hub-invoice-arrow" size={15} strokeWidth={1.5} aria-hidden="true" />
    </a>
  );
}

export function OpenInvoicesCard() {
  const { data } = useFetch<OpenInvoicesResponse>('/api/cockpit/invoices/open');
  // Still loading (or a settled error) — render nothing; the Hub stays calm and the
  // section appears once data settles (mirrors the LatestDocumentsSection posture).
  if (!data) return null;

  // Mirror has no v_open_invoices view yet (a bare/basic scaffold) — show an HONEST
  // empty-state naming what's missing + the fix, never a silent gap. The server
  // signals this with available:false (invoicesApi.js viewExists guard).
  if (!data.available) {
    return (
      <section className="hub-section">
        <header className="hub-section-head">
          <h2 className="hub-section-title">
            <ReceiptText size={15} strokeWidth={1.5} aria-hidden="true" />
            Open Invoices
          </h2>
          <p className="hub-section-hint">Open invoices — overdue first</p>
        </header>
        <ModuleEmptyState title="Invoice tracking isn’t set up yet" icon={ReceiptText}>
          Your mirror has no <span className="font-mono">v_open_invoices</span> view, so there’s no
          invoice data to surface. Run the SQLite upgrade to populate it (see{' '}
          <span className="font-mono">sqlite-extension/DATA-CONTRACT.md</span>), then tag a document
          note with an amount and due date.
        </ModuleEmptyState>
      </section>
    );
  }

  const overdue = data.items.filter((i) => i.isOverdue);
  const soon = data.items.filter((i) => !i.isOverdue && i.isDueSoon);
  const rest = data.items.filter((i) => !i.isOverdue && !i.isDueSoon);

  return (
    <section className="hub-section">
      <header className="hub-section-head">
        <h2 className="hub-section-title">
          <ReceiptText size={15} strokeWidth={1.5} aria-hidden="true" />
          Open Invoices
        </h2>
        <p className="hub-section-hint">Open invoices — overdue first</p>
        <button
          type="button"
          className="hub-section-action"
          onClick={() => navigate({ name: 'type', type: 'documents' })}
        >
          All documents
          <ArrowRight size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      {data.items.length === 0 ? (
        <p className="hub-empty">No open invoices — all paid.</p>
      ) : (
        <div className="hub-invoices" role="list">
          {overdue.map((inv) => <InvoiceRow key={inv.slug} inv={inv} />)}
          {soon.map((inv) => <InvoiceRow key={inv.slug} inv={inv} />)}
          {rest.map((inv) => <InvoiceRow key={inv.slug} inv={inv} />)}
        </div>
      )}
    </section>
  );
}
