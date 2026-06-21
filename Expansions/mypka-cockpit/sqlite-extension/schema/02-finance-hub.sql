-- ============================================================================
-- 02-finance-hub.sql — the Finance Hub backing structures
-- ----------------------------------------------------------------------------
-- These are ADDITIVE to the core. The cockpit BOOTS without them, but the
-- Finance Hub renders empty / partial:
--   * No invoice columns on `documents`     → "Open invoices" panel is empty.
--   * No `transactions` table                → "Payment trail" shows no matches.
--   * Missing v_* views                      → the Hub query errors are caught
--                                              and that panel renders empty.
--
-- WHAT THE INSTALLER DOES
--   `documents` already exists from the core schema WITHOUT the invoice columns.
--   install-extensions.py ADDS the invoice columns with ALTER TABLE ADD COLUMN
--   (idempotent — it checks PRAGMA table_info first and only adds what's
--   missing; it never drops the table, so existing document rows are preserved).
--   The three views are CREATE VIEW IF NOT EXISTS here, but the regen drops +
--   rebuilds them on every run so they can never go stale against the data.
--
-- DERIVED, NEVER STORED: "overdue" and "due soon" are computed in v_open_invoices
-- from due_date vs. today. Never persist them — they would rot the moment the
-- clock advances past midnight.
--
-- ALL VENDOR/AMOUNT/DATE DATA IS THE USER'S OWN. This schema ships with NO
-- seeded rows. The demo rig's synthetic Musterstadtwerke / Beispiel Versicherung
-- example data is deliberately NOT copied here.
-- ============================================================================

-- ── Invoice columns on `documents` (doc_type='invoice' only; NULL elsewhere) ──
-- Applied by install-extensions.py as additive ALTER TABLE ADD COLUMN. Shown
-- here as the canonical column set for anyone building `documents` from scratch.
--
--   amount               REAL      invoice total (bare number, no symbol)
--   currency             TEXT      ISO code, default 'EUR'
--   invoice_number       TEXT      vendor's invoice number (string; preserve leading zeros)
--   due_date             TEXT      ISO YYYY-MM-DD payment deadline
--   payment_status       TEXT      'open' | 'paid' | 'disputed'   (overdue is DERIVED)
--   paid_on              TEXT      ISO date set when paid; NULL while open
--   reimbursable         INTEGER   1 / 0 / NULL  (SQLite has no native bool)
--   reimbursement_status TEXT      'nicht-relevant' | 'einzureichen' | 'eingereicht'
--                                  | 'erstattet' | 'abgelehnt'
--   reimbursement_via    TEXT      who the claim goes to (an insurer/employer slug)
--   linked_organizations TEXT      JSON array of Organization slugs — the PAYEE
--                                  (there is intentionally NO `vendor` column)
--   linked_documents     TEXT      JSON array of Document slugs — the Doc→Doc FK
--                                  (an invoice → the contract it bills against)
--
-- The full `documents` table, INCLUDING these columns, for a from-scratch build:
--
--   CREATE TABLE documents (
--     id INTEGER PRIMARY KEY, slug TEXT NOT NULL, title TEXT, doc_type TEXT,
--     amount REAL, currency TEXT, invoice_number TEXT, due_date TEXT,
--     payment_status TEXT, paid_on TEXT,
--     reimbursable INTEGER, reimbursement_status TEXT, reimbursement_via TEXT,
--     linked_organizations TEXT, linked_documents TEXT,
--     body TEXT, file_path TEXT, raw_frontmatter TEXT);
--
-- (The core schema in 01-core-entities.sql does NOT create `documents` — the
-- installer creates it WITH these columns. See install-extensions.py.)

-- Speeds the open-invoice scan.
CREATE INDEX IF NOT EXISTS idx_documents_payment_status ON documents (payment_status);

-- ── transactions ─────────────────────────────────────────────────────────────
-- One bank transaction per row — the shape a MoneyMoney-style export yields, and
-- the worked example of PERSISTING what a reconcile step would otherwise discard.
-- amount is SIGNED (debit < 0, credit > 0). linked_invoice_slug is the FK to
-- documents.slug that wires a payment to the invoice it settled.
--
-- A bare scaffold gets an EMPTY transactions table — that is correct. The user's
-- own ingest (a MoneyMoney export, a CSV importer) populates it. This schema
-- seeds NOTHING.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,            -- bank's unique id for the transaction
  booking_date TEXT, value_date TEXT,      -- ISO YYYY-MM-DD
  amount REAL, currency TEXT,              -- amount is SIGNED (debit < 0, credit > 0)
  counterparty_name TEXT, purpose TEXT,
  end_to_end_reference TEXT,
  booked INTEGER DEFAULT 1,                -- 1 = booked, 0 = pending
  source_system TEXT,                      -- e.g. 'moneymoney'
  linked_invoice_slug TEXT,                -- FK → documents.slug (the invoice it settled)
  reconciliation_confidence TEXT,          -- 'confident' | 'ambiguous' | 'none'
  raw_data TEXT                            -- JSON blob of the original bank record
);
CREATE INDEX IF NOT EXISTS idx_transactions_invoice ON transactions (linked_invoice_slug);

-- ── Views (regen-owned: dropped + rebuilt on every run so they never go stale) ──
-- These reference the invoice columns on `documents`. The installer adds those
-- columns FIRST, then creates these views, so they resolve cleanly.

-- v_open_invoices — every open invoice with DERIVED due-state.
DROP VIEW IF EXISTS v_open_invoices;
CREATE VIEW v_open_invoices AS
SELECT
  d.slug, d.title, d.invoice_number, d.linked_organizations,
  d.amount, d.currency, d.due_date,
  CAST(julianday(d.due_date) - julianday('now', 'localtime', 'start of day') AS INTEGER)
    AS days_until_due,
  CASE WHEN d.due_date IS NOT NULL
            AND d.due_date < date('now', 'localtime')
       THEN 1 ELSE 0 END AS is_overdue,
  CASE WHEN d.due_date IS NOT NULL
            AND d.due_date >= date('now', 'localtime')
            AND d.due_date <= date('now', 'localtime', '+7 days')
       THEN 1 ELSE 0 END AS is_due_soon,
  d.file_path
FROM documents d
WHERE d.doc_type = 'invoice' AND d.payment_status = 'open';

-- v_reimbursement_pending — reimbursable invoices claimed but not yet submitted.
-- (An invoice can be `paid` yet still pending here — the legs are independent.)
DROP VIEW IF EXISTS v_reimbursement_pending;
CREATE VIEW v_reimbursement_pending AS
SELECT
  d.slug, d.title, d.invoice_number, d.linked_organizations,
  d.amount, d.currency, d.payment_status, d.paid_on,
  d.reimbursement_status, d.reimbursement_via, d.file_path
FROM documents d
WHERE d.doc_type = 'invoice'
  AND d.reimbursable = 1
  AND d.reimbursement_status = 'einzureichen';

-- v_invoice_payment_trail — each invoice LEFT JOINed to the transaction that
-- settled it. transaction columns are NULL for invoices with no recorded payment.
-- amount_matches=1 when the debit equals the invoice amount to the cent.
DROP VIEW IF EXISTS v_invoice_payment_trail;
CREATE VIEW v_invoice_payment_trail AS
SELECT
  d.slug AS invoice_slug, d.title AS invoice_title, d.invoice_number,
  d.amount AS invoice_amount, d.currency AS invoice_currency,
  d.due_date, d.payment_status, d.paid_on,
  t.transaction_id, t.booking_date, t.value_date,
  t.amount AS transaction_amount, t.counterparty_name, t.purpose,
  t.end_to_end_reference, t.source_system, t.reconciliation_confidence,
  CASE WHEN t.transaction_id IS NOT NULL
            AND ABS(ABS(t.amount) - d.amount) < 0.005
       THEN 1 ELSE 0 END AS amount_matches
FROM documents d
LEFT JOIN transactions t ON t.linked_invoice_slug = d.slug
WHERE d.doc_type = 'invoice';
