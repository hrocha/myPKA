# myPKA Cockpit — database contract

The cockpit reads **`mypka.db` at the myPKA root, read-only** (`readonly` +
`PRAGMA query_only`). It never writes to the database. Markdown is canonical;
the .db is a derived mirror you can regenerate at any time with
`scripts/regen-mypka-db.py`.

This document is the **exact contract** between the cockpit's queries and the
database. If you (or your LLM assistant) maintain `mypka.db` with a different
generator, it must satisfy everything below — otherwise run the bundled regen
script, which produces this schema while leaving any other tables in the file
untouched.

## Required tables

The server refuses to boot (with an actionable error) when any of these is
missing: `people`, `organizations`, `topics`, `projects`, `goals`,
`key_elements`, `habits`, `documents`, `deliverables`, `journal`,
`journal_media`, `links`, `agents`.

## Columns the cockpit actually queries

Every entity table needs: `id` (INTEGER PK), `slug`, `file_path`
(myPKA-root-relative), `raw_frontmatter` (the note's YAML frontmatter as a
**JSON object string**), plus a body column and the per-table columns below.
Extra columns are fine and ignored.

| Table | Title col | Body col | Subtitle col | Extra columns used |
|---|---|---|---|---|
| `people` | `full_name` | `body` | `relation` | — |
| `organizations` | `name` | `body` | `org_type` | — |
| `topics` | `name` | `body` | `key_element` | `raw_frontmatter.lifecycle`, `.promoted_to` (via `json_extract`) |
| `projects` | `name` | `body` | `status` | — |
| `goals` | `name` | `body` | `status` | `key_element` (anchor KE slug), `linked_projects` (JSON-array TEXT of project slugs), `raw_frontmatter.linked_habits` (via `json_extract`) |
| `key_elements` | `name` | `body` | `description_short` | `status` |
| `habits` | `name` | `body` | `cadence` | — |
| `documents` | `title` | `body` | `doc_type` | invoice fields + FK arrays — see "Invoice tracking" below |
| `deliverables` | `title` | `body` | — | — |
| `journal` | `title` | `content` | `category` | `entry_date` (ISO `YYYY-MM-DD`, sorted DESC), `mood`, `mood_valence` (INTEGER 1–5 or NULL), `energy`, `entry_type` |

### `journal_media`

One row per media embed in a journal entry's `## Media` section:
`id`, `journal_id` (FK to `journal.id`), `file_path` (**relative to `PKM/`**,
e.g. `Images/2026/06/foo.png`), `media_type` (`image` | `screenshot` |
`audio`), `mime_type`, `caption`, `sort_order`.

### `links`

The wikilink graph, one row per `[[wikilink]]` / `![[embed]]` occurrence:
`source_table`, `source_slug`, `target_raw` (the raw inner text),
`target_slug` (kebab-case last path segment), `target_table` (the entity table
the slug resolves to, or NULL when unresolved), `link_type` (`wikilink` |
`embed`). Recommended indexes: `(source_table, source_slug)` and
`(target_slug)`.

### `agents`

The team roster: `slug`, `name` (the `"Name - Role"` display string — the
client splits on `" - "`), `folder` (the `Team/` folder name), `agent_status`
(only `'active'` rows are shown), `bio`, `avatar_path` (myPKA-root-relative,
e.g. `Team/Penn - Journal Writer/avatar.png`, or NULL → initials fallback),
`owner`.

## Governance docs (`workstreams`, `sops`, `guidelines`)

The three Team Knowledge doc families, mirrored so the cockpit can browse them
like any entity. Sources: `Team Knowledge/Workstreams/**` → `workstreams`,
`Team Knowledge/SOPs/**` → `sops`, `Team Knowledge/Guidelines/**` →
`guidelines` (recursive; `INDEX.md` is skipped). **These files carry NO YAML
frontmatter** — their metadata lives in a `- **Label:** value` bullet block
directly under the H1. The regen parses that header block (it does *not* invent
values: a field with no matching label is NULL).

All three tables share one column shape, so a single generic doc view renders
any of them:

| Column | Type | Source |
|---|---|---|
| `id` | INTEGER PK | — |
| `slug` | TEXT | filename stem, **original case** (e.g. `WS-001-daily-journaling`, `SOP-create-task`) — the route key (`#/<type>/<slug>`) |
| `doc_id` | TEXT | formal id prefix off the stem (`WS-001` / `SOP-001` / `GL-001`), uppercased; **NULL** for the un-numbered task SOPs (`SOP-create-task`, `SOP-close-task`, …) |
| `title` | TEXT | the H1 (always present) |
| `status` | TEXT | `- **Status:**` value, else NULL (most SOPs/GLs have none) |
| `owner` | TEXT | `- **Owner:**` / `- **Owners:**` / `- **Default owner:**` value, inline `**bold**` + `[[wikilinks]]` flattened to display text; NULL if absent. **May be a multi-owner narrative sentence**, not a single name |
| `doc_type` | TEXT | `'workstream'` \| `'sop'` \| `'guideline'` (the family discriminator) |
| `summary` | TEXT | first prose paragraph after the header bullet block (≤400 chars), else NULL |
| `version` | TEXT | `- **Version:**` value, else NULL. **Free text, not guaranteed semver** (WS-001's is a full changelog sentence) |
| `triggered_by` | TEXT | `- **Triggered by:**` / `- **Trigger:**` value, else NULL |
| `tags` | TEXT | JSON array of a `- **Tags:**` line if present (none ship today), else NULL |
| `body` | TEXT | full markdown body (incl. the header block) |
| `file_path` | TEXT | myPKA-root-relative |
| `raw_frontmatter` | TEXT | the parsed **header bullet block** as a JSON object string (these docs have no YAML fm; this is the closest structured echo for a Properties panel) |

Indexes: `(doc_id)` on each table.

`body` wikilinks — including every `- **References:** [[…]]` bullet — flow into
the `links` graph with `source_table` ∈ {`workstreams`,`sops`,`guidelines`}.
Incoming references from anywhere (agent contracts, other docs) resolve their
`target_table` to these tables too (the resolver keys on the lowercased slug,
while the stored `slug` keeps original case). `title` + `body` feed `notes_fts`
so full-text search routes hits to `#/<type>/<slug>`.

There is **no `domain`/`category` column**: today's docs carry no such label.
If a future convention adds one, add the column + parse the label — don't infer.

## Invoice tracking (documents invoice fields, transactions, and the three views)

A worked, fully-synthetic example of invoice + contract + bank-transaction
tracking ships in this scaffold so the Hub renders something useful on first
launch. All vendors/amounts/dates are fictional (e.g. *Musterstadtwerke*,
*Beispiel Versicherung AG*) — a real install replaces them with its own notes.
The field SSOT is [[GL-002-frontmatter-conventions]] (Documents section); this
doc describes only the mirrored shape.

### `documents` — invoice columns (additive, `doc_type: invoice` only)

On top of the base entity columns, the `documents` table now carries (all
NULL on non-invoice docs):

| Column | Type | Meaning |
|---|---|---|
| `amount` | REAL | invoice total (bare number, no symbol) |
| `currency` | TEXT | ISO code, default `EUR` |
| `invoice_number` | TEXT | vendor's invoice number (string; leading zeros/hyphens preserved) |
| `due_date` | TEXT | ISO `YYYY-MM-DD` payment deadline |
| `payment_status` | TEXT | `open` \| `paid` \| `disputed` (overdue is DERIVED, never stored) |
| `paid_on` | TEXT | ISO date set when paid; NULL while open |
| `reimbursable` | INTEGER | `1` / `0` / NULL (SQLite has no bool) |
| `reimbursement_status` | TEXT | `nicht-relevant` \| `einzureichen` \| `eingereicht` \| `erstattet` \| `abgelehnt` |
| `reimbursement_via` | TEXT | who the claim goes to (an insurer/employer slug) |
| `linked_organizations` | TEXT | JSON array of Organization slugs — the invoice **payee** (there is no `vendor` column) |
| `linked_documents` | TEXT | JSON array of Document slugs — the Document→Document FK (an invoice → the contract it bills against) |

`linked_documents` makes "which contract does this invoice bill against"
**SQL-joinable** (`json_each(linked_documents)` → `documents.slug`). The same
relationship ALSO flows through the `links` table from the body `## Related`
`[[wikilink]]`, so both paths resolve it — the FK is the direct queryable one,
the link is for reading. Keep them in sync.

### `transactions` (example/import-external)

One bank transaction per row — the shape a MoneyMoney-style export yields, and
the example of **persisting** what a reconcile step would otherwise discard.
Seeded from `PKM/Documents/_data/transactions.example.json` (optional: a
scaffold without it just gets an empty table). Columns: `id`,
`transaction_id` (bank's unique id), `booking_date`, `value_date`, `amount`
(**signed** — debit < 0), `currency`, `counterparty_name`, `purpose`,
`end_to_end_reference`, `booked` (1/0), `source_system` (e.g. `moneymoney`),
`linked_invoice_slug` (FK → `documents.slug`), `reconciliation_confidence`
(`confident` \| `ambiguous` \| `none`), `raw_data` (JSON blob of the original
record). Indexed on `linked_invoice_slug`.

### Views (Silas-owned; dropped + rebuilt on every regen so they never go stale)

**`v_open_invoices`** — every `doc_type: invoice` with `payment_status='open'`,
with derived due-state. Columns:

| Column | Type | Notes |
|---|---|---|
| `slug` | TEXT | invoice slug |
| `title` | TEXT | |
| `invoice_number` | TEXT | |
| `linked_organizations` | TEXT | JSON array of payee slugs |
| `amount` | REAL | |
| `currency` | TEXT | |
| `due_date` | TEXT | ISO |
| `days_until_due` | INTEGER | negative when overdue |
| `is_overdue` | INTEGER | `1` when `due_date < today` |
| `is_due_soon` | INTEGER | `1` when due within the next 7 days (and not overdue) |
| `file_path` | TEXT | myPKA-root-relative |

**`v_reimbursement_pending`** — reimbursable invoices still to be claimed
(`reimbursable=1 AND reimbursement_status='einzureichen'`). Columns: `slug`,
`title`, `invoice_number`, `linked_organizations`, `amount`, `currency`,
`payment_status`, `paid_on`, `reimbursement_status`, `reimbursement_via`,
`file_path`. (An invoice can be `paid` yet still pending here — the legs are
independent.)

**`v_invoice_payment_trail`** — every invoice LEFT JOINed to the transaction
that settled it (`transactions.linked_invoice_slug = documents.slug`). Surfaces
the matched payment audit trail; transaction columns are NULL for invoices with
no recorded payment yet. Columns: `invoice_slug`, `invoice_title`,
`invoice_number`, `invoice_amount`, `invoice_currency`, `due_date`,
`payment_status`, `paid_on`, `transaction_id`, `booking_date`, `value_date`,
`transaction_amount`, `counterparty_name`, `purpose`, `end_to_end_reference`,
`source_system`, `reconciliation_confidence`, `amount_matches` (`1` when the
debit equals the invoice amount to the cent).

These three views are listed in the regen script's `OWNED_VIEWS` and are
dropped + rebuilt on every run, exactly like the owned tables — any *other*
view in the file (an analytics layer, a different mirror) is left untouched.

## How the cockpit uses this

- **Nav + browse + resolve** — a `UNION ALL` over the ten entity tables
  (type, id, slug, title, subtitle, file_path), `GROUP BY type` counts,
  slug lookups with a fixed type-priority for collisions.
- **Note view** — single-row fetch by (table, slug), then `links` outbound by
  `(source_table, source_slug)` and backlinks by `target_slug`;
  `journal_media` rows by `journal_id` for the image strip.
- **Graph views** — `PRAGMA table_info(<table>)` for tolerant node hydration,
  plus the `links` degree/edge queries and the `goals.key_element` /
  `goals.linked_projects` / `topics.key_element` doctrine columns.
- **Roster** — `SELECT … FROM agents WHERE agent_status = 'active'`.

## What is deliberately NOT in the database

- **`PKM/Fleeting Notes/`** — free-form capture/WIP docs (plus the cockpit's
  `_meta.json` / `_boards/` sidecars) outside the curated graph. The cockpit
  reads/writes them **directly on disk** through its own jailed routes. Never
  index Fleeting Notes into the mirror.
- **File bytes** — images/audio/PDFs stay on disk; the mirror stores relative
  paths only, served through jailed read-only routes.

## Extending the schema (library modules etc.)

Drop-in modules may add their **own** tables to `mypka.db` (e.g. `recipes`,
`media` — see `examples/library-module/`). Add new tables rather than
repurposing the required ones, keep them regenerable from markdown, and teach
your regen step to rebuild them. The bundled regen script only ever drops the
tables in `OWNED_TABLES` and the views in `OWNED_VIEWS`, so module tables/views
survive its runs untouched. If you add a derived view of your own, give it a
distinct name (not one of the `OWNED_VIEWS`) and it will be preserved across
regens.
