---
agent_id: silas
session_id: v3_1_0-cockpit-governance-docs
timestamp: 2026-06-22T13:26:00Z
type: end-of-session
linked_sops: [SOP-002-convert-mypka-to-sqlite]
linked_workstreams: []
linked_guidelines: [GL-002-frontmatter-conventions]
---

# Mode A — added workstreams/sops/guidelines mirror tables to the Cockpit regen

## What I did
Extended `Expansions/mypka-cockpit/scripts/regen-mypka-db.py` to index the three Team
Knowledge governance-doc families into three new SQLite tables so Felix's Cockpit can
browse them: `workstreams`, `sops`, `guidelines`. Regenerated the bundled `mypka.db`
in the v3.1.0 working scaffold. Updated both cockpit contract docs.

Row counts after regen (from the shipped sample docs): workstreams=3, sops=17,
guidelines=4. Idempotent across 3 runs, zero warnings.

## The load-bearing insight (durable)
**Governance docs carry NO YAML frontmatter.** Unlike every entity note, WS-/SOP-/GL-
files put their metadata in a `- **Label:** value` bullet block directly under the H1
(Status / Owner(s) / Default owner / Type / Version / Triggered by / References). So I
wrote a `header_block_fields()` parser that reads ONLY the first contiguous bullet
block (a `- **Path:**` bullet deeper in the body must not be mistaken for a header
field). `read_note()` returns fm={} for these — correct — and the body parse does the
real work.

**Resolver case mismatch (pre-existing scaffold trap I had to work around):**
`slug_of()` lowercases every link target, but governance filename stems are
upper-case-prefixed (`GL-001-…`). Entity slugs are already lowercase (GL-001 naming),
so they resolve fine; governance docs would NOT. Fix: register the **lowercased** slug
in `slug_to_table` while keeping the original-case `slug` column as the route key.
Without this, every `[[GL-001]]` / `[[SOP-002]]` reference resolves `target_table=NULL`
and the connections canvas draws no edges to governance docs.

## What Felix / the next agent must know
- `doc_id` is the formal id (`WS-001`), NULL for un-numbered task SOPs.
- `owner` can be a multi-owner narrative sentence (not one name); inline `**bold**` +
  wikilinks are flattened. `version` can be free text, not semver. Both `status` and
  `version` are sparse (most SOPs/GLs have neither) — never fabricate.
- No `domain`/`category` column: no source label exists today. Don't infer one.
- These tables are ADDITIVE — NOT in the 13-table boot-required set. A leaner scaffold
  still boots.

## Files changed
- `Expansions/mypka-cockpit/scripts/regen-mypka-db.py` (OWNED_TABLES, SCHEMA, indexes,
  TYPE_PRIORITY, header parser + GOVERNANCE_FAMILIES, ingestion pass, FTS_SOURCES,
  print summary, docstring folder-map).
- `Expansions/mypka-cockpit/docs/db-contract.md` (new governance-docs section).
- `Expansions/mypka-cockpit/sqlite-extension/DATA-CONTRACT.md` (§1 row, §13 note, new §17).
- Regenerated `mypka.db`.
