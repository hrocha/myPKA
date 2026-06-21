// invoicesApi.js — the Hub's Open-Invoices read layer over mypka.db (read-only).
//
// One route, registered via registerInvoicesRoutes(app, { safe }):
//   GET /api/cockpit/invoices/open  -> open invoices with derived due-state,
//                                       payee resolved from linked_organizations
//
// Reads Silas's `v_open_invoices` view (db-contract.md "Invoice tracking"):
//   slug, title, invoice_number, linked_organizations (JSON array of payee org
//   slugs), amount, currency, due_date, days_until_due (negative=overdue),
//   is_overdue (1/0), is_due_soon (1/0, ≤7d), file_path.
// Render order is the view's own: is_overdue DESC, due_date ASC.
//
// PAYEE RESOLUTION: linked_organizations is a JSON array of Organization slugs;
// the invoice's PAYEE is the FIRST slug (db-contract.md). We resolve it to the
// org's human title in ONE batched IN(...) pass — never per-row N+1.
//
// CALM DEGRADATION: db.js preflights the contract tables at boot, but the VIEW
// (`v_open_invoices`) is Silas-owned and may be absent against a foreign mirror
// that didn't run the bundled regen. In that case this returns an empty list +
// `available: false` so the Hub can show a calm "invoice tracking not set up"
// note rather than erroring. Markdown is canonical; every statement is a SELECT.
import db from './db.js';

function viewExists(name) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('view','table') AND name = ?`)
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

// Parse a JSON-array TEXT column to a string[]; tolerant of NULL / malformed.
function parseSlugArray(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// Resolve a set of org slugs → { slug: title } in one IN(...) SELECT.
function resolveOrgTitles(slugs) {
  const list = [...new Set(slugs)].filter(Boolean);
  if (list.length === 0 || !viewExists('organizations')) return new Map();
  const placeholders = list.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT slug, name FROM organizations WHERE slug IN (${placeholders})`)
    .all(...list);
  return new Map(rows.map((r) => [r.slug, r.name]));
}

export function listOpenInvoices() {
  if (!viewExists('v_open_invoices')) {
    return { available: false, items: [], total: 0 };
  }
  // The view already orders is_overdue DESC, due_date ASC — keep it.
  const rows = db
    .prepare(
      `SELECT slug, title, invoice_number, linked_organizations, amount, currency,
              due_date, days_until_due, is_overdue, is_due_soon, file_path
       FROM v_open_invoices`
    )
    .all();

  // Batch-resolve the first-payee titles.
  const firstPayeeSlugs = [];
  const parsedPayees = rows.map((r) => {
    const orgs = parseSlugArray(r.linked_organizations);
    if (orgs[0]) firstPayeeSlugs.push(orgs[0]);
    return orgs;
  });
  const titles = resolveOrgTitles(firstPayeeSlugs);

  const items = rows.map((r, i) => {
    const orgs = parsedPayees[i];
    const payeeSlug = orgs[0] || null;
    return {
      slug: r.slug,
      title: r.title || r.slug,
      invoiceNumber: r.invoice_number || null,
      payeeSlug,
      // First org slug → its title; falls back to the slug, then to null.
      payee: payeeSlug ? (titles.get(payeeSlug) || payeeSlug) : null,
      amount: typeof r.amount === 'number' ? r.amount : null,
      currency: r.currency || 'EUR',
      dueDate: r.due_date || null,
      daysUntilDue: typeof r.days_until_due === 'number' ? r.days_until_due : null,
      isOverdue: r.is_overdue === 1,
      isDueSoon: r.is_due_soon === 1,
      filePath: r.file_path || null,
    };
  });

  return { available: true, items, total: items.length };
}

// server.js calls this once with its own safe() wrapper, so the route gets the
// identical try/catch → 500 envelope and sits behind the same /api auth
// middleware as every other cockpit read.
export function registerInvoicesRoutes(app, { safe }) {
  app.get('/api/cockpit/invoices/open', safe(() => listOpenInvoices()));
}
