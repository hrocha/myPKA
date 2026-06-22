# Cockpit Data Contract — the exact backing data the myPKA Cockpit needs

The cockpit is a **read-only** viewer over a single SQLite file, `mypka.db`,
sitting at the knowledge-base root. It opens that file with `mode=ro` +
`PRAGMA query_only` and never writes to it. **Your markdown (or whatever your
source of truth is) is canonical; `mypka.db` is a derived mirror you regenerate
at will.**

This document is the contract between the cockpit's queries and that database.
It exists so a downstream LLM can wire **any** knowledge base into the cockpit:
satisfy everything below and the cockpit renders; satisfy the *minimum viable*
subset and it boots and shows something useful; provide nothing for an optional
module and that module degrades to an honest empty state instead of crashing.

There are two ways to satisfy it:

1. **The myPKA path** — run `scripts/regen-mypka-db.py`, which scans a myPKA
   folder and produces this schema from markdown frontmatter. Then run
   `install-extensions.py` for the additive extras the base regen doesn't yet
   cover (and for the optional module tables your own ingest fills).
2. **The adapt path** — you have a non-myPKA source. Build a generator that
   emits the tables/columns/views below with the same shapes. The DDL in
   `schema/` is your template; `install-extensions.py` is your worked example of
   doing it additively and idempotently.

---

## 1. Modules → backing tables/views map

Every entity table carries the same base columns: `id` (INTEGER PK), `slug`,
`file_path` (root-relative), `raw_frontmatter` (the note's frontmatter as a
**JSON object string**), a title column, and a body/content column. The columns
the cockpit *actually reads* are listed per module. Extra columns are fine and
ignored; **fewer** columns break the query.

| UI module | Tables | Views | Key columns the cockpit reads | Frontmatter fields that feed them (via regen) |
|---|---|---|---|---|
| **Nav / browse / resolve** (core) | `people`, `organizations`, `topics`, `projects`, `goals`, `key_elements`, `habits`, `documents`, `deliverables`, `journal` | — | per-table title + subtitle (see §3) | the note's full frontmatter → `raw_frontmatter` |
| **Note view + backlinks** (core) | `links`, + the entity tables, + `journal_media` | — | `links(source_table, source_slug, target_slug, target_table, link_type)`; `journal_media(journal_id, file_path, media_type, …)` | every `[[wikilink]]`/`![[embed]]` in any body; the `## Media` section of a journal entry |
| **Hub — On This Day** (journal across prior years) | `journal`, `journal_media` | — (parameterized query, see §9) | `journal(entry_date, title, content, slug, file_path)`; `journal_media(journal_id, file_path, …)` | `date` / `entry_date` (or the `YYYY-MM-DD` filename prefix); `## Media` embeds |
| **Hub — manual-entry original-text** ("unfold original") | `journal` | — | `journal(integration_status, original_body, manually_added)` (see §10) | `integration_status`, `original_body`, `manually_added` |
| **Hub — random quote** | `quotes` | — | `quotes(slug, quote_text, author, author_slug, source, quote_year, tags, file_path)` (see §8) | `doc_type: quote`, `author` (string or `[[wikilink]]`), `source`, `tags`, `year`; body = quote text |
| **Library** (recipes, movies, + adapted) | `library_registry`, `recipes`, `movies` (+ any adapted library table) | — | `library_registry(library_slug, nav_label, nav_icon, doc_type, sort_order)`; per-library invariant cols + axis cols (see §11) | `doc_type: <recipe\|movie\|…>` discriminator + the library's axis frontmatter fields; body = item detail |
| **Outer World** (mymind-style saved content) | `outer_world` | — | `outer_world(slug, title, captured_on, source_url, source_type, source_author, embed_*, tom_context, tags, linked_topics, linked_key_elements, linked_projects, linked_people, linked_organizations, body, file_path)` (see §14) | `doc_type: outer-world`, `source_url`, `source_type`, `captured_on`, the FLAT `embed_*` card fields, `tom_context`, `tags`, `linked_*`; body = `## Summary`/`## Clip`/`## Context` |
| **Graph views** (core) | `links`, entity tables | — | `goals.key_element`, `goals.linked_projects`, `topics.key_element`, `json_extract(raw_frontmatter,'$.lifecycle' / '$.promoted_to' / '$.linked_habits')` | `key_element`, `linked_projects`, `lifecycle`, `promoted_to`, `linked_habits` |
| **Team Knowledge browser** (governance docs) | `workstreams`, `sops`, `guidelines`, `links` | — | `<table>(slug, doc_id, title, status, owner, doc_type, summary, version, triggered_by, tags, body, file_path, raw_frontmatter)` (see §17); `links WHERE source_table IN ('workstreams','sops','guidelines')` for outbound refs + backlinks | **No YAML frontmatter** — parsed from the `- **Label:** value` header bullet block under the H1 (Status/Owner(s)/Default owner/Type/Version/Triggered by/References). Sources `Team Knowledge/Workstreams\|SOPs\|Guidelines/**`. |
| **Team roster** (core) | `agents` | — | `slug, name, folder, agent_status, bio, avatar_path, owner` (only `agent_status='active'`) | the `Team/<Name - Role>/AGENTS.md` frontmatter |
| **My AI Team — member detail** | `agents`, `agent_journal`, `links` | — | `agents(contract_body, contract_frontmatter, file_path, …)`; `agent_journal(agent_slug, title, body, created, …)`; `links WHERE source_table='agents' AND source_slug=?` | the AGENTS.md **body** (contract text) + its frontmatter; the agent's `journal/*.md` entries; the AGENTS.md `[[wikilinks]]` → connection edges. See §16. |
| **Global search** (core) | `notes_fts` (FTS5) | — | `notes_fts(type, slug, entity_id, title, body)` queried with `MATCH` + `bm25()` + `snippet()` (see §13) | derived — built from titles + bodies of every searchable owned table during regen (no extra frontmatter) |
| **Finance Hub** | `documents` (invoice cols), `transactions` | `v_open_invoices`, `v_reimbursement_pending`, `v_invoice_payment_trail` | invoice cols on `documents` (see §4); `transactions(amount, linked_invoice_slug, …)` | `doc_type: invoice`, `amount`, `currency`, `invoice_number`, `due_date`, `payment_status`, `paid_on`, `reimbursable`, `reimbursement_status`, `reimbursement_via`, `linked_organizations`, `linked_documents` (transactions come from a bank-export ingest, not markdown) |
| **Health dashboard** (optional pack) | `health_metric`, `health_sleep`, `health_mood`, `habits` (`started_on`,`status`) | — | `health_metric(metric_name, qty, units, source, local_date, recorded_at_utc)`; `health_sleep(total_sleep_hr, deep_hr, rem_hr, source, local_date)`; `health_mood(local_date, valence, valence_class, kind)`; `habits.started_on/status`; `journal.mood/mood_valence/energy`; `topics.body`, `key_elements.body` (mind cards) | **NOT from markdown** — fed by the user's own Apple-Health ingest. `habits.started_on/status` come from habit-note frontmatter. |
| **Workouts** (optional pack) | `health_workout`, `health_workout_route` | — | `health_workout(workout_uuid, workout_type, local_date, duration_sec, distance_km, heart_rate_avg/max, elevation_ascended_m, location_*)`; `health_workout_route(route_file_path, point_count, bbox_*)` | **NOT from markdown** — workout + GPX ingest. GPX files live under `PKM/`. |
| **Habit heatmap / streaks** (optional) | `habit_logs` | `v_habit_heatmap`, `v_habit_streaks` | `habit_logs(habit_slug, log_date, done, log_schema)` joined to `habits.name` | a habit-log extractor (derived from markdown daily logs) |
| **Food-log calendar** (optional) | `food_logs` | `v_food_log_calendar` | `food_logs(log_date, mahlzeit_typ, eiweiss_sichtbar, photo_*, journal_slug, …)` | a food-log extractor (derived from journal food sections) |

> **Planner / day-planner is NOT in this contract.** The planner module
> (`modules/planner/`) keeps its own **cockpit-local SQLite store** with its own
> migrations (`001-plan-state.sql` …) and pulls live tasks from Todoist /
> ClickUp / iCal connectors. It does **not** read or write `mypka.db`, so there
> is nothing here for the regen or this installer to provide. Mack owns that
> store and its connectors.

---

## 2. Minimum viable contract (smallest set to boot + render something useful)

The server **refuses to boot** (with an actionable error) unless **all 13 core
tables exist** — even empty:

```
people  organizations  topics  projects  goals  key_elements  habits
documents  deliverables  journal  journal_media  links  agents
```

That is the minimum. With those present and even a handful of entity rows + a
populated `agents` table, the cockpit boots and renders: nav with per-type
counts, the browse list, single-note views with backlinks, the graph, and the
roster. **No invoice columns, no `transactions`, no health/workout/habit/food
tables are needed to boot** — every one of those is additive and degrades
gracefully.

`schema/01-core-entities.sql` is exactly this minimum-viable set.

---

## 3. Title / subtitle / body columns per core table

| Table | Title col | Subtitle col | Body col |
|---|---|---|---|
| `people` | `full_name` | `relation` | `body` |
| `organizations` | `name` | `org_type` | `body` |
| `topics` | `name` | `key_element` | `body` |
| `projects` | `name` | `status` | `body` |
| `goals` | `name` | `status` | `body` |
| `key_elements` | `name` | `description_short` | `body` |
| `habits` | `name` | `cadence` | `body` |
| `documents` | `title` | `doc_type` | `body` |
| `deliverables` | `title` | — | `body` |
| `journal` | `title` | `category` | `content` *(note: `content`, not `body`)* |

`journal_media.file_path` is **relative to `PKM/`** (e.g. `Images/2026/06/x.png`),
unlike entity `file_path` which is root-relative. `links` carries no title/body
(its columns are listed in §1). `agents` now carries a body column
(`contract_body` = the AGENTS.md markdown body) plus `contract_frontmatter`
(JSON) and `file_path` — see §16. `agent_journal` is a per-agent feed table
(title = the entry's H1, body = the markdown after it) — see §16.

`people` and `organizations` additionally carry **`social_links`** — a JSON array
of `{label, url}` chips built from frontmatter (the `links:` array + recognized
flat fields like `website`). See §15.

---

## 4. Finance Hub — invoice columns, `transactions`, and the three views

These are **additive on top of the core** `documents` table. The base regen
already produces them; `install-extensions.py` adds them to an existing
`documents` table that lacks them (idempotent `ALTER TABLE ADD COLUMN`).

`documents` invoice columns (all NULL on non-invoice docs):

| Column | Type | Meaning |
|---|---|---|
| `amount` | REAL | invoice total (bare number) |
| `currency` | TEXT | ISO code, default `EUR` |
| `invoice_number` | TEXT | vendor's invoice number (string) |
| `due_date` | TEXT | ISO `YYYY-MM-DD` |
| `payment_status` | TEXT | `open` \| `paid` \| `disputed` — **overdue is DERIVED, never stored** |
| `paid_on` | TEXT | ISO date when paid; NULL while open |
| `reimbursable` | INTEGER | `1` / `0` / NULL |
| `reimbursement_status` | TEXT | `nicht-relevant` \| `einzureichen` \| `eingereicht` \| `erstattet` \| `abgelehnt` |
| `reimbursement_via` | TEXT | insurer/employer slug the claim goes to |
| `linked_organizations` | TEXT | JSON array of Organization slugs — the **payee** (there is no `vendor` column) |
| `linked_documents` | TEXT | JSON array of Document slugs — invoice → the contract it bills against |

`transactions` — one bank row each; `amount` is **signed** (debit < 0);
`linked_invoice_slug` is the FK to `documents.slug`. Empty on a fresh scaffold;
the user's own bank-export ingest fills it.

The three views (`v_open_invoices`, `v_reimbursement_pending`,
`v_invoice_payment_trail`) — full column lists in `schema/02-finance-hub.sql`.
They are **regen-owned**: dropped + rebuilt on every run so the derived
due-state can never go stale. The installer recreates them too (a view has no
stored rows, so drop+recreate is always lossless).

---

## 5. Which modules degrade gracefully vs. hard dependencies

**Hard dependency (cockpit will not boot without it):**

- The **13 core tables** of §2. Missing any → boot error. They must exist even
  empty.

**Degrades gracefully (absent structure → honest empty render, never a crash):**

- **Finance Hub** — no invoice columns / no `transactions` / no `v_*` views →
  the panels render empty. (The cockpit catches the view query error and shows
  the empty state.)
- **Health dashboard** — no `health_metric` / `health_sleep` / `health_mood`,
  or empty ones → blank panels. The pack isn't even compiled into the build
  until the user activates it.
- **Workouts** — no `health_workout*` → empty catalogue, no maps.
- **Habit heatmap / streaks** — no `habit_logs` → empty surfaces.
- **Food-log calendar** — no `food_logs` → empty calendar.
- **Journal media strip** — no `journal_media` rows → entries render without
  images. *(Note: `journal_media` is in the boot-required set as a TABLE — it
  must exist; it just renders empty with zero rows.)*
- **Hub — random quote** — no `quotes` table → module renders empty; table
  present but zero rows → honest empty state. Add `PKM/Quotes/` notes + regen.
- **Hub — On This Day** — no prior-period entries on this calendar day → module
  renders empty. Reuses core `journal`/`journal_media`; never blocks boot.
- **Hub — manual-entry original-text** — no `journal.original_body` /
  `integration_status` columns → "unfold original" can't render (the entry just
  shows as-is). `install-extensions.py` adds them by default.

> **For Felix:** the empty-state UI must match this list. Every "degrades
> gracefully" module needs a designed empty state (icon + one honest line, e.g.
> *"No invoices tracked yet — add `doc_type: invoice` notes and regenerate."*).
> The hard-dependency core tables never reach the UI empty-handed because the
> server blocks boot first — so no empty-state design is needed for *missing*
> core tables, only for *empty* ones (e.g. a brand-new journal).

---

## 6. The mapping the upgrade installer adds to the regen pipeline

`install-extensions.py` is the Step-4 upgrade. It maps onto the regen pipeline
as follows:

- **Core tables** — owned by `regen-mypka-db.py`. The installer does **not**
  recreate them; it only verifies `journal` exists as a safety gate.
- **Finance invoice columns + `transactions` + the 3 views** — the base regen
  already produces these. The installer **also** provides them, so a scaffold
  that is *not yet on the current regen* (a leaner generator, a hand-built db, a
  non-myPKA source) reaches the same end-state without a full regen and without
  needing the markdown. End-state schema is identical either way.
- **`habits.started_on` / `habits.status`** — **FIXED in the base regen
  (2026-06-18).** `regen-mypka-db.py` now emits both columns natively (widened
  `CREATE TABLE habits` + INSERT, backfilled from habit-note frontmatter). The
  installer still adds them additively as a bridge for older/hand-built scaffolds,
  but a fresh regen produces them directly. This was the **#1 habits-page 500**:
  `listByType('habits')` builds `SELECT …, started_on, status FROM habits` via a
  **direct `db.prepare`** (not the degrade-on-missing `optionalStmt`), so a habits
  table lacking the columns threw `no such column` and 500'd the whole browse page.
- **`health_mood`** — queried by the Health pack, **not** created by the base
  regen. The installer creates the empty table so the query never errors.
  **→ regen / ingest gap** (see Findings).
- **Optional module tables** (`health_*`, `habit_logs`, `food_logs`) and their
  module-owned views — created empty by the installer under the matching flag.
  The regen **preserves any table it doesn't own**, so once the user's ingest
  fills them they survive every regen run untouched. Their views use **distinct
  names** from the regen's `OWNED_VIEWS`, so the regen leaves them alone.

### Findings for the cockpit's own `regen-mypka-db.py` (gap to close upstream)

~~Probing the live demo `mypka.db` confirmed the base regen produces `habits`
**without** `started_on`/`status`…~~ **`habits.started_on`/`status` is now FIXED
in the base regen (2026-06-18, Silas)** — the columns are emitted natively and
backfilled from frontmatter; the demo regen confirms `SELECT slug, started_on,
status FROM habits` returns real values. The `health_mood` table gap is separate
and still bridged by `install-extensions.py --with-health` (an external Apple-
Health ingest target, not markdown-derived) — that one remains a coordination
item for the health-ingest owner.

---

## 7. How to adapt this for a non-myPKA knowledge base (for the downstream LLM)

1. Decide your source-of-truth → table mapping. Each cockpit entity table needs
   `slug`, a title column, `body`/`content`, `file_path`, and `raw_frontmatter`
   (store *something* JSON-shaped here even if your source has no frontmatter —
   the graph doctrine reads it).
2. Emit the **13 core tables** first (copy `schema/01-core-entities.sql`). Boot
   the cockpit against them — empty is fine.
3. Build your `links` rows from whatever cross-reference your source has
   (`[[wikilinks]]`, hrefs, relation fields). `target_table` resolves a slug to
   the entity table it lives in (NULL when unresolved).
4. Add Finance / Health / etc. only if your source has that data. Use
   `install-extensions.py` as the additive, idempotent template — never drop,
   only add.
5. Run `detect-gaps.py` to see, in the cockpit's own terms, exactly what will
   render and what will be empty.

---

## 8. Quotes — the `quotes` table + `PKM/Quotes/` convention (random-quote Hub)

**Md-first.** Each quote is one markdown file under `PKM/Quotes/`, frontmatter +
body. The regen mirrors every `doc_type: quote` note into `quotes`. Defined in
`schema/05-module-quotes.sql`; added empty by `install-extensions.py --with-quotes`
(or `--all`); filled by `scripts/regen-mypka-db.py`.

Frontmatter convention (`PKM/Quotes/<slug>.md`):

```yaml
---
doc_type: quote                 # REQUIRED — regen mirrors ONLY doc_type: quote notes
author: "Marcus Aurelius"       # plain string, OR "[[marcus-aurelius]]" to wire a CRM Person
source: "Meditations, Book V"   # optional — book / talk / page
tags: [stoicism, discipline]    # optional → JSON-array TEXT of the verbatim strings
year: 180                       # optional → quote_year (INTEGER)
---
The impediment to action advances action. What stands in the way becomes the way.
```

- **The quote text is the body** (canonical). A `quote:` frontmatter field is a
  fallback for one-liners; if both exist, the body wins.
- **Author wikilink:** when `author` is a `[[wikilink]]`, the regen keeps the
  display label in `author` *and* resolves `author_slug` (the kebab slug), *and*
  writes an `author → person` edge into `links`. Plain-string author → `author`
  set, `author_slug` NULL.
- Body `[[wikilinks]]` (e.g. `[[stoicism]]`) become normal graph edges.

`quotes` columns the cockpit reads:

| Column | Type | Meaning |
|---|---|---|
| `slug` | TEXT | note filename stem (GL-001 kebab-case) |
| `quote_text` | TEXT | the quote (body, or `quote:` fallback) |
| `author` | TEXT | display string, or the resolved Person slug if wikilink'd |
| `author_slug` | TEXT | Person slug when `author` was a `[[wikilink]]`, else NULL |
| `source` | TEXT | book / talk / page (NULL when unknown) |
| `quote_year` | INTEGER | year of quote/source, or NULL |
| `tags` | TEXT | JSON-array TEXT of tag strings (NULL when none) |
| `body` | TEXT | full markdown body (standard entity body col for the note view) |
| `file_path` | TEXT | root-relative (`PKM/Quotes/<slug>.md`) |
| `raw_frontmatter` | TEXT | frontmatter as a JSON object string |

**Column contract for Felix — the random-quote Hub query.** Returns one random
quote with all fields. Parse `tags` server-side (JSON-array TEXT → array), return
NULL scalars as null (UI renders blank, never `0`/`unknown`):

```sql
SELECT slug, quote_text, author, author_slug, source, quote_year, tags, file_path
FROM quotes
ORDER BY RANDOM()
LIMIT 1;
```

Empty table → the module renders its empty state. No index helps a `RANDOM()`
pick over a tiny table, so none is added (measure before optimizing).

---

## 9. On This Day — the journal prior-periods query (parameterized, NOT a view)

The Hub's "On This Day" module shows journal entries from the **same calendar
month-day** in prior periods: 1 month ago, 6 months ago, then 1 year ago, 2
years ago … back through every year until none remain. It reuses the **core**
`journal` table (no new columns) plus `journal_media` for embedded images. The
only addition is the index `idx_journal_entry_date` on `journal(entry_date)`
(in the core regen schema; added by `install-extensions.py` by default).

**Why a parameterized query, not a view:** the anchor is *today*, which a view
can't take as a parameter. The server/module computes the candidate dates from
today and runs the query. Two equivalent shapes:

**(a) Month-day match (every prior year on this day), newest-first** — one query,
covers the "every year back" tail:

```sql
-- :today = 'YYYY-MM-DD' (local today). substr(entry_date,6,5) = 'MM-DD'.
SELECT slug, title, entry_date, content, integration_status, file_path
FROM journal
WHERE substr(entry_date, 6, 5) = substr(:today, 6, 5)
  AND entry_date < :today
ORDER BY entry_date DESC;
```

**(b) Exact-date pick per period** — when the module wants the discrete buckets
(1 month / 6 months / 1 year / 2 years …). The module builds each target date in
app code (true calendar math — handles month lengths / leap years better than SQL
date arithmetic) and runs:

```sql
SELECT slug, title, entry_date, content, integration_status, file_path
FROM journal
WHERE entry_date = :target_date;   -- e.g. '2025-12-18', '2025-06-18', '2024-06-18'
```

Both are served directly by `idx_journal_entry_date` (a; range/equality on the
indexed column) — (a) scans the index, (b) is an index seek.

**Embedded images per entry.** For each returned `journal.id`, fetch its embeds
from `journal_media` (already populated from the entry's `## Media` section):

```sql
SELECT file_path, media_type, mime_type, caption, sort_order
FROM journal_media
WHERE journal_id = :journal_id
ORDER BY sort_order;
```

`journal_media.file_path` is **relative to `PKM/`** (e.g. `Images/2025/06/x.png`),
served through the cockpit's existing jailed `/api/cockpit/media` route. For the
"show embedded images truncated" UI, cap the list client-side (e.g. first N +
"more") — the data layer returns all embeds in order; truncation is a UI choice,
not a schema one.

---

## 10. Journal original-text + integration status (the manual-entry flow)

When the user adds a journal entry by hand in the cockpit and later has Penn
integrate/rewrite it, the ORIGINAL text must survive so the cockpit can show an
"unfold original". Three **additive** columns on the core `journal` table back
this (in the core regen CREATE; added by `install-extensions.py` by default):

| Column | Type | Meaning |
|---|---|---|
| `original_body` | TEXT | user's verbatim original text. Set ONCE, by Penn, at integration. NULL = never integrated (body IS the original; nothing to unfold). |
| `integration_status` | TEXT | `'raw'` (user-entered, not yet integrated) \| `'integrated'` (Penn rewrote; `original_body` set). **NULL is treated as `'raw'`.** |
| `manually_added` | INTEGER | `1` = came from the cockpit manual-add flow; `0`/NULL = Penn-captured. |

Frontmatter contract (`PKM/Journal/YYYY/MM/<slug>.md`):

```yaml
---
title: A quick note
date: 2026-06-18
manually_added: true
integration_status: raw          # raw | integrated
original_body: |                 # block scalar — preserved verbatim (set by Penn)
  the user's original words, exactly as typed
---
The integrated / rewritten body lives here.
```

**The integration flow (how Penn sets these):**

1. **Raw entry** — the cockpit's manual-add flow writes the entry with
   `manually_added: true`, `integration_status: raw`, body = the user's text,
   **no** `original_body`.
2. **Penn integrates** — Penn copies the current body verbatim into
   `original_body`, rewrites the body, and flips `integration_status` to
   `integrated`.
3. **Regen** mirrors it. Convenience rule: if a note carries `original_body` but
   no explicit `integration_status`, the regen defaults the status to
   `integrated` (an `original_body` only exists post-integration).

> `original_body` is read with a NON-wikilink-stripping getter in the regen, so
> `#`, `[[`, and multi-line block scalars in the original survive byte-for-byte.

**Column contract for Felix — raw vs integrated, and the unfold:**

```sql
SELECT slug, title, entry_date, content,
       COALESCE(integration_status, 'raw') AS integration_status,
       original_body
FROM journal
WHERE slug = :slug;
```

- **Is it integrated?** `integration_status = 'integrated'`. (Treat NULL as
  `'raw'` — `COALESCE` above does this.)
- **Show the "unfold original" affordance** when `integration_status =
  'integrated'` AND `original_body IS NOT NULL`.
- **What to reveal on unfold:** the `original_body` column (verbatim). The
  always-visible body is `content` (the integrated text).
- A `'raw'` entry has no `original_body` → no unfold; the `content` IS the
  original.

---

## 11. Library foundation — the reusable collection pattern (recipes, movies, …)

A **library** is a curated collection the user keeps many of and wants to browse,
filter, and open: recipes, films, books, board games, wines, gear, restaurants.
The library foundation is the **reusable pattern** for all of them, shipped with
**two worked instantiations**: `recipes` and `movies`.

Defined in `schema/07-library-foundation.sql`; filled by
`scripts/regen-mypka-db.py` (the `LIBRARIES` config block + one generic ingestion
loop); created empty additively by `install-extensions.py --with-libraries` (or
`--all`). Synthetic English example notes live in `../examples/recipes/` and
`../examples/movies/`.

### 11.1 The design: per-library typed tables + a registry (not a god-table)

One PKM **folder** per library, one **mirror table** per library, **typed
columns** that are that library's filterable axes — the same doctrine as every
other table (`quotes`, `people`, `documents`). We deliberately do **not** use a
single polymorphic `library_items(kind, data JSON)` table: the cockpit's contract
is "typed columns the cockpit reads; fewer columns break the query." Typed columns
are what the facet dropdowns enumerate and what SQLite sorts/filters cheaply; a
JSON blob would force `json_extract()` on every field and kill column-level facets.
Different libraries have different axes (a recipe has cuisine + cook-time; a film
has rating + release-year), so one wide blob would be mostly-NULL and lie about its
shape.

The **reuse** lives in the *pattern + the registry*, not a shared table:

- **`library_registry`** — one row per active library. This is what makes the
  Library nav **data-driven**: the cockpit asks the registry "what libraries
  exist and how do I render each?" instead of hard-coding recipes + movies. A
  user's own library shows up in the nav the moment its registry row lands — no UI
  change to the enumeration layer.

```
library_registry(library_slug, nav_label, nav_icon, pkm_folder, doc_type,
                 title_field, sort_order)
```

| Column | Meaning |
|---|---|
| `library_slug` | stable id == the mirror table name (`recipes`, `movies`, `books`, …) |
| `nav_label` | sidebar label ("Recipes", "Films & Series") |
| `nav_icon` | a lucide icon name the client maps (e.g. `ChefHat`, `Clapperboard`) |
| `pkm_folder` | root-relative source folder (`PKM/My Life/Recipes`) |
| `doc_type` | frontmatter discriminator the regen filters on (`recipe`, `movie`) |
| `title_field` | frontmatter field used as the card title (default `title`) |
| `sort_order` | INTEGER nav ordering (ascending; ties break alpha by `nav_label`) |

### 11.2 The invariant library columns (every library mirror table carries these)

| Column | Type | Meaning |
|---|---|---|
| `slug` | TEXT | note filename stem (GL-001 kebab-case) |
| `title` | TEXT | card title (frontmatter `title`, else H1, else slug) |
| `status` | TEXT | per-library lifecycle token (NULL allowed) |
| `tags` | TEXT | JSON-array TEXT of verbatim tag strings (NULL when none) |
| `body` | TEXT | the markdown body after the frontmatter (the detail view content) |
| `file_path` | TEXT | root-relative (`PKM/<Library>/<slug>.md`) |
| `raw_frontmatter` | TEXT | the note's full frontmatter as a JSON object string |

Plus the library's own **axis columns**. The two built-ins:

**`recipes`** (`PKM/My Life/Recipes/`, `doc_type: recipe`):
`cuisine`, `dish_type`, `difficulty` (facet axes, TEXT tokens); `total_time_min`,
`servings`, `ingredient_count` (INTEGER, NULL = unknown); `key_ingredients`
(JSON-array TEXT); `source_url`, `source_channel` (TEXT).

**`movies`** (`PKM/My Life/Movies/`, `doc_type: movie`):
`media_type` (`film`|`serie`), `genre` (facet, TEXT); `rating` (INTEGER 1-5, NULL =
unrated — render `—`, never 0); `release_year` (INTEGER); `director_creator` (TEXT,
plain or `[[wikilink]]`); `platform` (TEXT, NULL = unknown → blank); `date_watched`
(TEXT ISO, NULL = never watched); `progress` (TEXT); `total_seasons`,
`episodes_watched` (INTEGER, series only — NULL on films); `verdict` (TEXT verbatim,
line breaks preserved — read with the non-wikilink-stripping getter).

### 11.3 Md-first + wikilinks

A library item **is a note**: title, a body (recipe steps / your verdict), and
wikilinks. Recipes link a cuisine Topic or the Person who taught it; movies link a
director Person (in `director_creator` as a `[[wikilink]]`) or a genre Topic (in the
body). Every body `[[wikilink]]` becomes a normal `links` graph edge, so the item
surfaces in that note's backlinks. Markdown is canonical; these tables are derived
mirrors rebuilt on every regen. Only notes whose `doc_type` matches the library's
discriminator are mirrored (a stray note is skipped with a warning, never guessed).

### 11.4 Column contract for Felix — the library UI module

**(a) Enumerate the libraries (build the Library nav group):**

```sql
SELECT library_slug, nav_label, nav_icon, pkm_folder, doc_type, sort_order
FROM library_registry
ORDER BY sort_order ASC, nav_label COLLATE NOCASE ASC;
```

Each row is one nav entry under the sidebar "Library" group; `#/<library_slug>`
deep-links to it. The group is absent only when the registry is empty. Map
`nav_icon` → a lucide component client-side (fallback to a generic library icon for
an unknown name, so a user-added library never crashes the nav).

**(b) List a library (the card grid).** One read-only endpoint per library, a
prepared `SELECT *`-of-the-contract-columns ordered by the library's natural sort.
Parse JSON-array TEXT columns (`tags`, `key_ingredients`) server-side into real
arrays; return NULL scalars as `null` (the client renders blank — never `0` /
`unknown`). Recipes sort alpha by title; movies sort most-recently-watched first:

```sql
-- recipes
SELECT slug, title, cuisine, dish_type, difficulty, status,
       total_time_min, servings, ingredient_count, key_ingredients,
       source_url, source_channel, tags, file_path
FROM recipes
ORDER BY title COLLATE NOCASE ASC;

-- movies (NULL date_watched — watchlist — sorts after dated rows)
SELECT slug, title, media_type, status, rating, release_year, genre,
       director_creator, platform, date_watched, progress,
       total_seasons, episodes_watched, verdict, tags, file_path
FROM movies
ORDER BY date_watched IS NULL, date_watched DESC, title COLLATE NOCASE ASC;
```

Filtering + free-text search are **client-side** over the full (small) library —
the same posture as the existing `RecipesView.tsx` / `MediaView.tsx` in
`../examples/library-module/`. Facet dropdowns are built from the **distinct values
that actually occur** in the data, so a new token (`cuisine: thai`) appears with no
code change. The empty state is first-class (a friendly "library not yet filled"
panel), never a blank page.

**(c) Random pick (a library can feed a Hub "random item" card, like quotes):**

```sql
SELECT slug, title, /* … the library's display columns … */ file_path
FROM <library_slug>
ORDER BY RANDOM() LIMIT 1;
```

**(d) The clickable-card → open-detail-in-large view.** Each card carries the row's
`slug` (and `file_path`). On click, the cockpit opens the item in the large detail
view. **No new endpoint is required** — two existing routes already serve it:

1. **The full note (canonical detail):** the card's `file_path` is the
   root-relative markdown path. Render it through the cockpit's existing
   note/markdown read (the same path the entity note view uses) — that gives the
   full body (recipe steps / verdict + notes), rendered markdown, and resolved
   wikilinks (see §12 for slug → title resolution on those links).
2. **The structured header (typed fields) for the large view:** re-use the row the
   list already returned (the client has it in memory), or fetch one row by slug:

```sql
SELECT * FROM <library_slug> WHERE slug = :slug;
```

The large detail view = the structured header (typed axis fields + tags +
status badge) **above** the rendered markdown body. `body` is the canonical detail
content; `raw_frontmatter` is available if the view wants a field the typed columns
don't carry. Covers/photos referenced by a note are served through the existing
jailed `/api/cockpit/media` route (paths relative to `PKM/`) — no new file route.

> **Server wiring (for whoever mounts the endpoints — Mack/Felix on the server
> side):** add one prepared-`SELECT` list function per library behind the existing
> read-only `safe()` wrapper, plus the `library_registry` enumerate query. Pattern
> is identical to `listRecipes()` / `listMedia()` in
> `../examples/library-module/server-queries.js.snippet`. A registry-driven server
> can also iterate `library_registry` and mount `/api/cockpit/library/:slug`
> generically; either shape satisfies this contract.

### 11.5 Adapt-on-install — mapping the user's EXISTING collections onto the pattern

This is the contract the **install-time LLM** follows to wire whatever the user
already collects (books, films, recipes, tools, wines, …) onto the library
foundation. Recipes + movies are the worked examples; the steps generalize:

1. **Discover the collection.** Find the folder(s) of repeating same-shaped notes
   (a `Books/` folder, a `Films/` folder, a tag like `#wine`). One library = one
   coherent collection.
2. **Pick the discriminator.** Choose a `doc_type` token for it (`book`, `wine`,
   `boardgame`). Ensure each note in the folder carries `doc_type: <token>` —
   **this is the one markdown change the install may need** (see §12 for the
   install-time check). The regen mirrors only notes whose `doc_type` matches.
3. **Choose the axes.** From the fields the notes actually carry, pick the
   filterable AXES (single-value tokens → facets, e.g. a book's `genre` /
   `read_status`) and the display fields (e.g. `author`, `pages`, `rating`). Map
   each to a typed column: scalar → TEXT, count/year/rating → INTEGER, lists →
   JSON-array TEXT. Keep the invariant columns
   (`slug`/`title`/`status`/`tags`/`body`/`file_path`/`raw_frontmatter`) as-is.
4. **Add the table + register the library.** Three edits, all additive:
   - a `CREATE TABLE <library_slug> (…)` in `schema/07-library-foundation.sql`
     (or a new numbered schema file) with the invariant columns + the chosen axes;
   - the table name in the regen's `OWNED_TABLES` **and** a dict in the regen's
     `LIBRARIES` config block (`table`, `folder`, `doc_type`, `nav_label`,
     `nav_icon`, `sort_order`, `columns` = the axis list with each column's parser
     kind: `str` / `int` / `list_raw` / `list_slug` / `raw`);
   - for the non-regen path, a `CREATE` in `install-extensions.py`'s
     `LIBRARY_TABLES` + a `LIBRARY_REGISTRY_SEED` row.
   The generic ingestion loop fills it; the registry row makes it appear in the
   nav. **No bespoke ingestion code** — the loop is library-agnostic.
5. **Run the regen** (or `install-extensions.py --with-libraries` for the empty
   end-state), then **`detect-gaps.py`** to confirm the library is enumerated and
   sees the consequence in the cockpit's own terms.

The whole foundation is additive and idempotent: adding a library never touches
another library's table or rows, and re-running changes nothing.

---

## 12. Wikilink display — slug → title resolution at render (item-5 assessment)

**Problem:** a `[[wikilink]]` stores the target **slug** (`weekly-review`), and the
cockpit currently renders that raw slug instead of the target note's human title
("Weekly Review").

**Finding: title resolution is enough. No alias field is needed for the common
case.** `mypka.db` already carries everything required to resolve a wikilink slug to
a display title at render time:

- The **`links`** table gives, for every `[[wikilink]]`/`![[embed]]` occurrence:
  `target_slug` (the kebab last-segment) and `target_table` (the entity table the
  slug resolves to, or NULL when unresolved — a true orphan).
- Every **target table** carries that note's **title column** keyed by `slug`:
  `people.full_name`, `organizations.name`, `topics.name`, `projects.name`,
  `goals.name`, `key_elements.name`, `habits.name`, `documents.title`,
  `deliverables.title`, `journal.title`, `quotes.slug` (a quote's "title" surface),
  and now `recipes.title` / `movies.title` (and any library's `title`). The
  per-table title column is the §3 table.

So the resolver is: `target_slug` + `target_table` → look up that table's title
column by slug. The `links` rows already store `target_table`, and `idx_links_target`
(on `links.target_slug`) plus the per-table `slug` make the lookup cheap.

**Resolution query (one wikilink → its display title):**

```sql
-- Given a link row's (target_slug, target_table), resolve the display title.
-- The cockpit can also resolve directly from the slug across tables if it didn't
-- carry target_table. Example for a topic target:
SELECT name AS title FROM topics WHERE slug = :target_slug;
```

A single resolver picks the title column by `target_table` (a small switch), or a
generic resolver does a UNION across the tables keyed by slug. Recommended shape for
the renderer (resolve the whole link graph of a note in one pass):

```sql
SELECT l.target_raw, l.target_slug, l.target_table, l.link_type
FROM links l
WHERE l.source_table = :table AND l.source_slug = :slug;
-- then for each row, look up the title in l.target_table by l.target_slug.
```

**Display rules for the renderer:**

- `target_table` non-NULL → render the resolved title as the link label; the link
  navigates to `#/<target_table>/<target_slug>`.
- `target_table` NULL → **orphan** link: render the raw `target_slug` (or the
  `target_raw` label) as plain/un-navigable text. This is the honest signal that
  the target note does not exist yet.
- A `[[target|label]]` link already carries an explicit label in `target_raw`
  (everything before the `|`). The regen splits on `|` for the slug; the renderer
  should prefer the author's explicit `|label` when present, else the resolved
  title, else the slug. (The pipe label is the lightweight, zero-schema "alias"
  Obsidian-style users already use.)

**Is an explicit `aliases` frontmatter field worth adding?** **Recommendation: do
NOT add one now.** Title resolution + the existing `[[target|label]]` pipe syntax
cover the display problem with **zero scaffold change**. An `aliases` field solves a
*different* problem — letting `[[old-name]]` resolve to a note whose slug is
`new-name` (multiple link *forms* pointing at one note). That is a real but separate
need (note renames / synonyms), and adding it touches GL-002, every template, the
regen (an `aliases` → slug resolution map), and the `links` resolver. It is **not**
required to fix raw-slug display. If the user later reports broken links after
renames, revisit it as a deliberate GL-002 change — minimal viable would be an
`aliases: [old-slug, other-name]` list mirrored into an `aliases` table
(`alias_slug`, `canonical_slug`) consulted before the orphan fallback. Flag it;
don't build it speculatively.

### 12.1 Install-time check + recommendation (per Tom's directive)

During expansion installation, after the regen + `install-extensions.py`, the
install flow should run a **read-only resolvability check** and recommend (never
auto-apply) markdown structure fixes. What it verifies:

1. **Unresolved wikilink targets (orphans).** Count `links` rows with
   `target_table IS NULL`, grouped by `target_slug`, ordered by frequency. These
   render as raw slugs. Recommend: create the missing note, or fix the typo'd
   link, or accept it as an intentional stub.

```sql
SELECT target_slug, COUNT(*) AS refs
FROM links
WHERE target_table IS NULL
GROUP BY target_slug
ORDER BY refs DESC;
```

2. **Resolvable-but-titleless targets.** A link resolves to a table+slug, but the
   target note's title column is NULL/empty — so the renderer has nothing better
   than the slug to show. Flag these per table (the title comes from frontmatter
   `title`/`name`, else the H1, else the slug; a note with none falls back to the
   slug). Recommend: add a `title:`/`name:` frontmatter field or an H1 to those
   notes.

```sql
-- example for topics; repeat per entity table with its title column
SELECT slug, file_path FROM topics
WHERE name IS NULL OR trim(name) = '';
```

3. **Library doc_type coverage (when adapting existing collections).** For each
   library folder the install is wiring, flag notes in the folder **missing** the
   library's `doc_type` discriminator — they will be silently skipped by the regen.
   Recommend: add `doc_type: <token>` to those notes. (The regen already emits a
   per-note warning for this; the install check surfaces the count up front.)

The recommendation is **advisory**: the cockpit renders correctly regardless
(orphans show as plain text, titleless targets show the slug — honest, not broken).
The check tells the user which markdown edits would upgrade raw-slug links to proper
titles. It is **read-only** — it never rewrites a note (Silas's Mode-A rule: audit,
report, recommend; the user or Penn applies fixes).

---

## 13. Global full-text search — the `notes_fts` index (item-8)

**Problem this closes:** the cockpit's existing global search only matches a note's
**title / slug**. It never searches the note **body**. `notes_fts` is an FTS5
full-text index over titles **and** bodies across the whole searchable corpus, so a
search for a phrase that lives only inside a note's prose returns that note.

**No new dependency.** `better-sqlite3` ships SQLite with the **FTS5** extension
compiled in (`bm25()` + `snippet()` included) — confirmed on the cockpit's pinned
build. Nothing to install.

### 13.1 The table

`notes_fts` is a **standalone (own-content) FTS5 virtual table** — not an
external-content table — because the searchable corpus spans many source tables, not
one. It is built and populated by `regen-mypka-db.py` on every regen, dropped +
rebuilt with the rest of `OWNED_TABLES`, so it can never drift from the owned tables
and never disturbs a non-owned table in the file (same read-only + ownership contract
as everything else in this mirror).

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  type UNINDEXED,        -- source table name → the route prefix
  slug UNINDEXED,        -- note slug within that type → the route key
  entity_id UNINDEXED,   -- the source row's integer id (its own table's id)
  title,                 -- INDEXED — note display title/name
  body,                  -- INDEXED — note body / journal content
  tokenize='porter unicode61'
);
```

| Column | Indexed? | Meaning | UI use |
|---|---|---|---|
| `type` | no (stored) | source table: `people`, `organizations`, `topics`, `projects`, `goals`, `key_elements`, `habits`, `documents`, `deliverables`, `journal`, `recipes`, `movies`, or any user-added library table | route prefix |
| `slug` | no (stored) | note slug within that type | route key |
| `entity_id` | no (stored) | the source row's `id` (its own table's PK) | optional direct join back to the source row |
| `title` | **yes** | display title / name (the §3 title column per table) | result label + ranking signal |
| `body` | **yes** | the note body; for `journal` it is the `content` column | result label + snippet source |

- `type`, `slug`, `entity_id` are **`UNINDEXED`**: stored on every row and returned on
  every hit (so the UI routes without a second query) but **not** tokenized, so they
  never pollute a `MATCH`.
- Tokenizer `porter unicode61` = case-fold + diacritic-fold + English stemming
  (so `mobility` matches `mobilities`, `running` matches `run`). Same tokenizer the
  private vault's `*_fts` indexes use.
- **Quotes are intentionally excluded** (a quote surfaces via the random-quote Hub,
  §8, and has no note route of its own). Add a `('quotes', …)` source in the regen's
  `FTS_SOURCES` list only if a quote route is introduced.
- One FTS row per searchable note. A user-added library (a dict in `LIBRARIES`) is
  indexed automatically — the regen appends every library table to the FTS sources.
- **Governance docs are indexed too** — `workstreams`, `sops`, `guidelines` (title +
  body) are in `FTS_SOURCES`, so a search routes to `#/<type>/<slug>` for them (e.g.
  `#/sops/SOP-002-convert-mypka-to-sqlite`). See §17.

### 13.2 The query for Felix's `searchNotes()` — BM25 + snippet (exact shape)

This is the SQL `searchNotes()` (server lane, Felix) should run. It returns
BM25-ranked hits, each carrying the `(type, slug)` needed to route, plus a
highlighted snippet of the matching body text.

```sql
SELECT
  type,
  slug,
  entity_id,
  title,
  snippet(notes_fts, 4, '<mark>', '</mark>', '…', 12) AS snippet,
  bm25(notes_fts, 5.0, 1.0) AS rank
FROM notes_fts
WHERE notes_fts MATCH :query
ORDER BY rank          -- bm25() returns NEGATIVE scores; lower = more relevant
LIMIT :limit;          -- e.g. 30
```

Exact-detail notes (these are the parts that silently break if you get them wrong):

- **`snippet(notes_fts, 4, …)`** — the `4` is the **0-based column index of `body`**
  (col 0 `type`, 1 `slug`, 2 `entity_id`, 3 `title`, **4 `body`**). Use the `title`
  column index `3` for a second snippet if you want to highlight title matches too.
  Args: `(table, column, open_mark, close_mark, ellipsis, token_budget)`.
- **`bm25(notes_fts, 5.0, 1.0)`** — the per-column weights apply to the **indexed
  columns in declaration order**: `title`=5.0, `body`=1.0 (a title hit outranks a
  body hit ~5:1). `UNINDEXED` columns take no weight. Tune the two numbers to taste.
- **`ORDER BY rank` ascending** is correct: FTS5 `bm25()` returns **negative**
  numbers and the most relevant row is the most negative. Do **not** add `DESC`.
- **`MATCH :query`** — bind the user's text as a parameter; never string-concatenate
  it (FTS5 MATCH has its own query syntax and is an injection surface otherwise). For
  a forgiving "search as you type" UX, append `*` to the last token for a prefix
  match (e.g. user types `mobil` → query `mobil*`). FTS5 also supports `AND`/`OR`/
  `NEAR`/`"quoted phrase"` for power users.

### 13.3 Hit → note route mapping

Each result row already carries everything needed to navigate — no follow-up query:

```
route = `#/${row.type}/${row.slug}`
```

`type` is the source table name, which is exactly the cockpit's route segment (the
same `#/<target_table>/<target_slug>` convention §12 uses for resolved wikilinks).
`title` is the result label; `snippet` is the highlighted body preview; `entity_id`
is available if you ever want to join straight back to the source row
(`… JOIN <type> ON <type>.id = :entity_id`), though `slug` is the normal key.

A minimal result item for the UI:

```json
{ "type": "people", "slug": "andrea-schmidt", "title": "Andrea Schmidt",
  "snippet": "Andrea runs the spine <mark>rehab</mark> clinic …",
  "route": "#/people/andrea-schmidt" }
```

### 13.4 Verification (done at authoring time)

Built on a throwaway DB copy from a synthetic vault; the real regen builds it the
same way:

- `notes_fts` builds during regen (1 row per searchable note across all sources).
- A **body-only** term (`umami`, present in no title/slug) returns its note with a
  highlighted snippet — the gap this index closes.
- BM25 ranks title hits above body hits with `bm25(notes_fts, 5.0, 1.0)`.
- `snippet(notes_fts, 4, …)` highlights the matching body fragment.
- Rebuild is **idempotent** (row count stable across repeated regens; dropped +
  rebuilt each run).
- **Read-only contract intact**: no markdown file is modified by the regen, and a
  non-owned table in the same `.db` survives the rebuild untouched.

---

## 13.1 FUTURE — opt-in semantic search layer (DEFERRED, do NOT build in v1)

> **Status: planned opt-in enhancement, not built.** v1 ships **FTS5 only** (§13).
> This subsection documents the intended shape so the seam is known; it is a future
> addition, gated on the user opting in.

FTS5 is **lexical** — it matches tokens (and their stems), not meaning. A semantic
layer would let "how do I loosen up my lower back" find the lumbar-mobility note even
with zero shared keywords. The planned design, mirroring the private vault's deferred
v2 path:

- **`note_chunks`** — one row per ~200–400-token chunk of a note body, with
  `(type, slug, chunk_index, text)` so a hit maps back to its note the same way
  `notes_fts` does.
- **`vec_notes`** — the chunk embeddings. Generated **locally** with
  **transformers.js running MiniLM** (`all-MiniLM-L6-v2`, 384-dim) so no embedding
  data leaves the machine and there is no API key or external dependency — consistent
  with the cockpit's keys-never-leave-the-machine posture.
- **Retrieval** — **brute-force cosine similarity** over the stored vectors in JS
  (the corpus is small — thousands of chunks, not millions — so an ANN index like
  HNSW is unnecessary; brute force is simpler and fast enough). Optionally **fused**
  with the FTS5 BM25 results (hybrid search: reciprocal-rank fusion of the lexical and
  semantic hit lists) for the best of both.

**Why opt-in:** generating embeddings is a one-time compute cost (model download +
an embedding pass over every note on regen), so it is gated behind an explicit user
choice rather than run on every install. **Do not implement this in v1** — it is
recorded here only so the v2 seam (the two tables + the local-embedding +
brute-force-cosine approach) is unambiguous when the user asks for it.

---

## 14. Outer World — the `outer_world` table + `PKM/Outer World/` convention (saved-content library)

**The Outer World is the mymind-style store of everything the user SAVES from
outside their own head** — articles, social posts, videos, books, podcasts,
reports, and "ideas I don't want to forget." It is the consume/save counterpart to
the Journal's create/reflect (the Inner World), grounded in the lesson-697 PKM
Inner/Outer-World model. **The old scaffold "News" entity is generalized into this
concept:** `news` is no longer a top-level entity — it is one value of
`source_type`. (A non-destructive migration carries legacy `PKM/News/` notes over;
see §14.5.)

**Md-first.** Each saved item is one markdown file under
`PKM/Outer World/YYYY/MM/<slug>.md` (date-nested like the Journal and Images — saves
are time-series capture events), frontmatter + body. `doc_type: outer-world` is the
discriminator; the regen mirrors only those notes. Defined in
`schema/08-module-outer-world.sql`; added empty by
`install-extensions.py --with-outer-world` (or `--all`); filled by
`scripts/regen-mypka-db.py`. Synthetic English example notes live in
`../examples/outer-world/`.

### 14.1 Why its own table (not the library foundation §11)

The Outer World carries **three structural layers** the library pattern does not
model, so it is a dedicated, documented table (still obeying the same doctrine:
md-first, one note per item, typed columns the cockpit reads, derived + rebuilt on
every regen):

1. **SOURCE** (`source_url` / `source_type` / `source_author` / `source_published`)
   — the immutable record of what the external thing IS.
2. **EMBED card** (the FLAT `embed_*` fields) — the machine-fetched OpenGraph card
   the cockpit renders mymind-style.
3. **ANNOTATION** (`tom_context` + `tags` + the five `linked_*` bucket lanes) — the
   Inner-World layer the user lays on top. The source stays Outer World; the
   annotation layers on.

### 14.2 The FLAT `embed_*` contract (Axon's embed spec + Mack's fetcher output)

The embed metadata is stored as **FLAT, top-level frontmatter keys — NOT a nested
`embed:` block.** Flat keeps the note Obsidian-safe (each shows as its own
Properties field) and gives each its own sortable/filterable SQLite column. The
fetcher (Mack) writes **exactly** these keys; the regen reads them 1:1. **The names
are coordinated with Axon's embed spec and locked:**

`embed_kind`, `embed_title`, `embed_description`, `embed_image`, `embed_site_name`,
`embed_domain`, `embed_favicon`, `embed_author`, `embed_captured_at`.

> **Image / CSP posture (flag for Vex + Felix).** `embed_image` and `embed_favicon`
> are **LOCAL relative paths** — the image is **localized at capture time** (the
> fetcher downloads it into the scaffold), never a hotlinked remote URL. So the card
> renders **offline**, there is **no third-party image fetch at render**, and the
> cockpit's CSP need not allow remote `img-src`. Felix serves these paths through the
> existing **jailed `/api/cockpit/media`** route (paths are relative to the note /
> `PKM/`, same as `journal_media`). A NULL `embed_image` is honest — the card falls
> back to `embed_favicon` + `embed_title`, and never shows a broken image.

### 14.3 Frontmatter convention (`PKM/Outer World/YYYY/MM/<slug>.md`)

```yaml
---
doc_type: outer-world           # REQUIRED — regen mirrors ONLY doc_type: outer-world notes
title: How rich link cards work # how the user wants to remember it
captured_on: 2026-06-14         # ISO date saved (matches the dated filename prefix)
status: filed                   # optional: inbox | filed | archived
# ── immutable SOURCE record ──
source_url: https://…           # REQUIRED — no URL, no Outer World entry
source_type: video              # article | post | video | book | idea | news (open vocab)
source_author: Build & Learn    # optional
source_published: 2026-05-28    # optional ISO date the SOURCE was published
# ── EMBED card (FLAT embed_* — Axon/Mack contract; images are LOCAL paths) ──
embed_kind: video
embed_title: "…"
embed_description: "…"
embed_image: _assets/<slug>.png # LOCAL relative path (NULL → favicon fallback)
embed_site_name: Video Example
embed_domain: video.example
embed_favicon: _assets/favicon-video.png
embed_author: Build & Learn
embed_captured_at: 2026-06-14T11:40:00Z
# ── Inner-World ANNOTATION layer ──
tom_context: why it was kept / what it connects to
tags: [opengraph, embeds, video]
# ── Capturing-Beast bucket lanes (slugs; projected as columns for grid filtering) ──
linked_topics: [rich-embeds]
linked_key_elements: [building-the-system]
linked_projects: [cockpit-outer-world]
linked_people: []
linked_organizations: []
---
## Summary / ## Clip / ## Context   (the body)
```

- The **body** is the canonical detail (`## Summary` = factual; `## Clip` = the
  verbatim excerpt the user kept; `## Context` = the Inner-World take). Body
  `[[wikilinks]]` become normal `links` graph edges (the item surfaces in each
  bucket's backlinks).
- The **`linked_*` arrays** are **also** projected into columns so the grid facets
  by Topic / KE / Project / Person / Org cheaply (`json_each(...)`) **without** a
  `links` join. They are JSON-array TEXT of **slugs** (FK-style), like
  `goals.linked_projects`.
- `embed_title` / `embed_description` / `embed_image` / `embed_site_name` /
  `embed_favicon` / `embed_author` / `tom_context` are read with the
  **non-wikilink-stripping** getter so `#`, `[[`, and multi-line block scalars in
  the fetched/authored text survive byte-for-byte.

### 14.4 Column contract for Felix — the Outer World UI module

`outer_world` columns the cockpit reads:

| Column | Type | Meaning / UI use |
|---|---|---|
| `slug` | TEXT | note filename stem (route key) |
| `title` | TEXT | card title (how the user remembers it) |
| `status` | TEXT | `inbox` / `filed` / `archived` (NULL allowed) |
| `captured_on` | TEXT | ISO date saved — the **default grid sort** (newest first) |
| `source_url` | TEXT | the canonical link the card opens out to |
| `source_type` | TEXT | `article`/`post`/`video`/`book`/`idea`/`news` (+ open) — **primary facet pill** |
| `source_author` | TEXT | byline / handle (NULL → blank) |
| `source_published` | TEXT | ISO date the source was published (NULL → blank) |
| `embed_kind` | TEXT | card kind (`link`/`article`/`video`/`image`/`rich`) |
| `embed_title` | TEXT | OG card title (may differ from `title`) |
| `embed_description` | TEXT | OG snippet (card body line) |
| `embed_image` | TEXT | **LOCAL** hero image path (NULL → favicon fallback) — via `/api/cockpit/media` |
| `embed_site_name` | TEXT | publisher / site label on the card |
| `embed_domain` | TEXT | bare domain — a cheap secondary source facet |
| `embed_favicon` | TEXT | **LOCAL** favicon path (card chrome / image fallback) |
| `embed_author` | TEXT | author as the embed reported it |
| `embed_captured_at` | TEXT | ISO datetime the embed was fetched (staleness signal) |
| `tom_context` | TEXT | the user's annotation snippet shown on the card |
| `tags` | TEXT | JSON-array TEXT of tag strings — facet pills |
| `linked_topics` | TEXT | JSON-array TEXT of Topic slugs — **filter** |
| `linked_key_elements` | TEXT | JSON-array TEXT of Key Element slugs — **filter** |
| `linked_projects` | TEXT | JSON-array TEXT of Project slugs — **filter** |
| `linked_people` | TEXT | JSON-array TEXT of Person slugs — **filter** |
| `linked_organizations` | TEXT | JSON-array TEXT of Organization slugs — **filter** |
| `body` | TEXT | full markdown body (the detail-large content) |
| `file_path` | TEXT | root-relative (`PKM/Outer World/YYYY/MM/<slug>.md`) |
| `raw_frontmatter` | TEXT | frontmatter as a JSON object string |

**(a) Enumerate the Outer World library (the card grid), newest-saved first.** Parse
the JSON-array TEXT columns (`tags`, every `linked_*`) server-side into real arrays;
return NULL scalars as `null` (the client renders blank, never `0`/`unknown`):

```sql
SELECT slug, title, status, captured_on,
       source_url, source_type, source_author, source_published,
       embed_kind, embed_title, embed_description, embed_image,
       embed_site_name, embed_domain, embed_favicon, embed_author,
       tom_context, tags,
       linked_topics, linked_key_elements, linked_projects,
       linked_people, linked_organizations,
       file_path
FROM outer_world
ORDER BY captured_on DESC, title COLLATE NOCASE ASC;
```

Served by `idx_outer_world_captured_on`. Filtering + free-text are **client-side over
the full (small) set** — the same posture as `RecipesView.tsx` / `MediaView.tsx`. The
`source_type` facet, the `tags` pills, and the `embed_domain` facet are built from the
**distinct values that actually occur**, so a new token (`source_type: podcast`)
appears with no code change. Empty table → first-class empty state.

**(b) Filter the grid by a bucket (Topic / KE / Project / Person / Org).** The
`linked_*` columns are JSON arrays of slugs; filter with `json_each` (or client-side
over the parsed array). SQL shape for a server-side push (e.g. "everything I saved
under Topic `rich-embeds`"):

```sql
SELECT ow.slug, ow.title, ow.captured_on, ow.source_type, ow.embed_image
FROM outer_world ow
WHERE EXISTS (
  SELECT 1 FROM json_each(ow.linked_topics) WHERE json_each.value = :topic_slug
)
ORDER BY ow.captured_on DESC;
```

Swap `linked_topics` → `linked_key_elements` / `linked_projects` / `linked_people` /
`linked_organizations` for the other lanes. Filter by `source_type` is a plain
indexed equality (`WHERE source_type = :type`, served by
`idx_outer_world_source_type`). The grid is small, so the common path is: read the
whole table once, facet/filter in memory.

**(c) The "Outer World inbox" view (saves awaiting a Beast pass).** Items whose
bucket lanes are all empty (saved but not yet filed):

```sql
SELECT slug, title, captured_on, source_type, embed_image, embed_title
FROM outer_world
WHERE COALESCE(linked_topics, '[]') = '[]'
  AND COALESCE(linked_key_elements, '[]') = '[]'
  AND COALESCE(linked_projects, '[]') = '[]'
ORDER BY captured_on DESC;
```

**(d) The card → detail-large read.** Each card carries the row's `slug` + `file_path`.
On click the cockpit opens the large detail view — **no new endpoint needed**, two
existing routes serve it:

1. **The full note (canonical detail):** render `file_path` through the cockpit's
   existing note/markdown read — the body (`## Summary`/`## Clip`/`## Context`) with
   resolved wikilinks (§12 for slug → title resolution).
2. **The structured header (the embed card + source + your take):** reuse the row the
   grid already returned, or fetch one row by slug:

```sql
SELECT * FROM outer_world WHERE slug = :slug;
```

The detail-large view = the **embed card** (`embed_image` or favicon fallback +
`embed_title` + `embed_site_name` + the `source_url` open-out + `source_type` pill +
`source_author`/`source_published`) **above** the rendered markdown body, with
`tom_context` as the highlighted annotation and the `linked_*` / `tags` as navigable
chips. `embed_image` / `embed_favicon` are local paths served via the jailed
`/api/cockpit/media` route — **no remote image fetch, no CSP `img-src` widening** (see
§14.2).

### 14.5 Non-destructive News → Outer World migration (the install flow)

When the install flow detects a legacy `PKM/News/` folder (notes with
`doc_type: news`), it runs `scripts/migrate-news-to-outer-world.py` to carry them
into the Outer World concept **non-destructively**:

- **Move + retype:** each `PKM/News/**` note → `PKM/Outer World/YYYY/MM/<slug>.md`
  (the YYYY/MM derived from `captured_on`/`captured_date`/`published_date`/filename),
  `doc_type: news` → `doc_type: outer-world`, `source_type: news` added (only when
  absent). All body + every wikilink preserved byte-for-byte.
- **Field mapping** (legacy → new, applied only when the target is absent so nothing
  is clobbered): `captured_date`→`captured_on`, `author`→`source_author`,
  `channel`→`embed_site_name`, `published_date`→`source_published`,
  `related_topics/key_elements/projects/people/organizations`→the `linked_*` names,
  singular `key_element`→merged into `linked_key_elements`, any legacy nested `embed:`
  or flat `og_*` block→the flat `embed_*` names, `embed_fetched_at`→`embed_captured_at`.
  **Any unmapped legacy key is carried through verbatim** — no data is ever dropped.
- **Non-destructive guarantees:** dry-run is the default (writes nothing); `--apply`
  **copies** (the original `PKM/News/` note survives so the move is reversible);
  a slug collision in `PKM/Outer World/` is **skipped, never overwritten**
  (rename-never-overwrite, WS-002 default conflict policy); `--archive-originals`
  optionally moves originals aside to `PKM/News/_migrated/`. **It NEVER executes
  against a real instance unprompted** — the install flow runs it on the user's own
  folder after the backup gate, and the user deletes `PKM/News/` themselves once
  they've verified + regenerated.

> This is the install-time step a downstream LLM runs; it is also a worked example to
> adapt for a non-myPKA source. Verified on a throwaway scaffold: dry-run → apply →
> regen picks up the migrated note (`source_type='news'`), original preserved,
> re-run skips the collision, markdown left untouched by the regen.

---

## 15. Social / website chips — `people.social_links` + `organizations.social_links`

People and Organizations can carry clickable **social-media + website chips**. The
regen folds two frontmatter sources into one `social_links` column (TEXT, a JSON
array of `{label, url}` objects, deduped by URL; `NULL` when a note has none).

**Field shape (GL-002 — recommended primary):** a `links:` array of `{label, url}`.
Extensible to any platform with no schema change:

```yaml
links:
  - label: Website
    url: https://example.org
  - label: LinkedIn
    url: https://www.linkedin.com/in/example
```

**Flat convenience aliases (also recognized, merged in):** `website` (+ `homepage`,
`url`), `twitter`/`x`, `linkedin`, `github`, `instagram`, `youtube`, `mastodon`,
`bluesky`, `threads`, `facebook`, `tiktok`, `substack`. Each is a scalar URL/handle;
the label defaults from the field name. These keep notes that already use `website:`
working and let you add one network without the array syntax.

**Normalization (regen `_normalize_url`):** an explicit `http(s)://` / `mailto:` URL
is kept verbatim; a bare **host** (`example.org`, `sub.host/path`) is prefixed with
`https://`; anything else (a bare `@handle`, a username with no host) is kept
verbatim so the chip stays honest — the regen never invents a host from a handle.

**Render contract for Felix:** `JSON.parse(row.social_links || '[]')` → render each
`{label, url}` as a chip whose visible text is `label` and whose `href` is `url`
(open in a new tab, `rel="noopener noreferrer"`). `social_links` is `NULL`/absent on
notes without any → render no chip row (degrades gracefully). Worked synthetic
examples live in `examples/social-links/`.

> **GL-002 / scaffold flag (does NOT touch the private instance):** the `links:`
> array of `{label, url}` is the recommended **net-new GL-002 field** for Person and
> Organization (and is sensible on any entity that has an external presence). The
> flat `website` field is **already in use** on Organization notes in the shipped
> scaffold; this contract simply formalizes it and generalizes it to the other
> networks. Adding the field to GL-002 + the Person/Organization templates is a
> scaffold change for Larry to route — not applied here.

---

## 16. My AI Team — member detail (contract body + journal feed + connections)

The member-detail view renders three things per agent: the **contract** (AGENTS.md
body) like a note body, the agent's **journal feed**, and a **connections canvas**.
Three backing surfaces, all regen-produced and read-only:

**`agents` (widened):** in addition to the roster columns (§1), each row now carries
`contract_body` (the AGENTS.md markdown body, frontmatter stripped — render as a note
body), `contract_frontmatter` (the YAML as a JSON object string — `agent_version`,
`owner`, `supersedes`, etc.; `{}` when the contract has no frontmatter), and
`file_path` (root-relative path to the AGENTS.md).

**`agent_journal`:** one row per `Team/<Name>/journal/*.md` durable insight
(the `_template.md` stub is skipped). Columns: `agent_slug` (FK → `agents.slug`),
`slug`, `title` (the entry's H1 — the insight in one sentence), `topic`, `created`,
`updated`, `status`, `tags` (JSON array), `body`, `file_path`, `raw_frontmatter`.
Indexed `(agent_slug, created)` for the per-agent newest-first feed.

**Connections:** the AGENTS.md `[[wikilinks]]` (to SOPs / Workstreams / Guidelines /
documents / other agents) are extracted into the **`links`** graph with
`source_table='agents'`, `source_slug=<agent slug>`. The connections canvas reads
them via the same `idx_links_source` path every note backlink uses. `target_table`
is the resolved entity table when the target is one of the mirrored tables, else
`NULL` (SOP/WS/GL slugs aren't entity tables — render them as labeled chips keyed by
`target_slug` / `target_raw`).

### 16.1 Query contract for Felix

```sql
-- (a) the contract body + meta for the member-detail header/body
SELECT slug, name, folder, bio, avatar_path, owner, agent_status,
       contract_body, contract_frontmatter, file_path
FROM agents
WHERE slug = ?;

-- (b) the journal feed, newest-first
SELECT slug, title, topic, created, updated, status, tags, body, file_path
FROM agent_journal
WHERE agent_slug = ?
ORDER BY created DESC, title ASC;

-- (c) the connection edges out of this agent (for the connections canvas)
SELECT target_slug, target_raw, target_table, link_type
FROM links
WHERE source_table = 'agents' AND source_slug = ?
ORDER BY target_table IS NULL, target_table, target_slug;

-- (c-optional) inbound edges — notes/agents that link TO this agent
SELECT source_table, source_slug, link_type
FROM links
WHERE target_slug = ? AND target_table = 'agents'
ORDER BY source_table, source_slug;
```

`agent_journal` and the widened `agents` columns are **additive**: an agent with no
`journal/` folder yields an empty feed (calm empty state, never an error), and a
contract with no frontmatter yields `contract_frontmatter='{}'`. All three queries
degrade to empty results on a leaner mirror.

> **Coordination:** Felix builds the member-detail UI (contract render, journal feed,
> connections canvas) against this query contract next wave. Field names
> (`contract_body`, `contract_frontmatter`, `agent_journal.*`, `social_links`,
> `habits.started_on`/`status`) are the agreed names — change them only by editing
> the regen + this contract together (append-only; never rename a shipped column
> silently).

## 17. Team Knowledge browser — `workstreams` / `sops` / `guidelines`

The three Team Knowledge doc families, mirrored so the cockpit can browse and
search them like any entity. Sources (recursive; `INDEX.md` skipped):

| Folder | Table | `doc_type` |
|---|---|---|
| `Team Knowledge/Workstreams/**` | `workstreams` | `'workstream'` |
| `Team Knowledge/SOPs/**` | `sops` | `'sop'` |
| `Team Knowledge/Guidelines/**` | `guidelines` | `'guideline'` |

### 17.1 The shape (identical across all three)

**These files carry NO YAML frontmatter.** Their metadata lives in a
`- **Label:** value` bullet block directly under the H1. The regen parses *only*
the first contiguous bullet block (a `- **Path:**` bullet buried deeper in the
body is never mistaken for a header field) and never invents a value — an absent
label is NULL.

| Column | Type | Source / notes |
|---|---|---|
| `id` | INTEGER PK | — |
| `slug` | TEXT | filename stem, **original case** (`WS-001-daily-journaling`, `SOP-create-task`). The route key: `#/<type>/<slug>` |
| `doc_id` | TEXT | formal id off the stem (`WS-001`/`SOP-001`/`GL-001`), uppercased; **NULL** for un-numbered task SOPs (`SOP-create-task`, `SOP-close-task`, `SOP-read-own-journal`, …) |
| `title` | TEXT | the H1 (always present) |
| `status` | TEXT | `- **Status:**`, else NULL. Only WS-00x + a few SOPs carry it (e.g. `Active (since v1.4.0)`) |
| `owner` | TEXT | `- **Owner:**`/`- **Owners:**`/`- **Default owner:**`, with inline `**bold**` + `[[wikilinks]]` flattened. **May be a multi-owner narrative sentence**, not one name |
| `doc_type` | TEXT | family discriminator (table above) |
| `summary` | TEXT | first prose paragraph after the header block (≤400 chars), else NULL |
| `version` | TEXT | `- **Version:**`, else NULL. **Free text, not guaranteed semver** (WS-001's is a full changelog sentence) |
| `triggered_by` | TEXT | `- **Triggered by:**`/`- **Trigger:**`, else NULL |
| `tags` | TEXT | JSON array of a `- **Tags:**` line if present (none ship today), else NULL |
| `body` | TEXT | full markdown body (incl. the header block) |
| `file_path` | TEXT | myPKA-root-relative |
| `raw_frontmatter` | TEXT | the parsed **header bullet block** as a JSON object string (closest structured echo for a Properties panel; these docs have no real fm) |

Indexes: `idx_<table>_doc_id` on `(doc_id)` each.

### 17.2 Links + search

- `body` wikilinks — **including every `- **References:** [[…]]` bullet** — flow
  into `links` with `source_table` ∈ {`workstreams`,`sops`,`guidelines`}.
- **Incoming** references (from agent contracts, other docs) resolve their
  `target_table` to these tables: the resolver keys on the **lowercased** slug
  while the stored `slug` keeps original case (the governance stems are
  upper-case `GL-`/`WS-`/`SOP-`, but every `target_slug` is lowercased by the
  link extractor — registering the lowercase form is what makes incoming
  `[[GL-001-…]]` edges resolve). So the connections canvas works in both
  directions via the same `idx_links_source` / `idx_links_target` paths.
- `title` + `body` feed `notes_fts` (§13), so search routes to `#/<type>/<slug>`.

### 17.3 What is NOT here

- **No `domain`/`category` column.** Today's docs carry no such label; inventing
  one would be guessing. Add the column + parse the label only if a future
  convention introduces it.
- `status`/`version`/`triggered_by`/`owner` are **sparse** — most SOPs and all
  GLs have no Status or Version line. Render them as optional fields; never
  fabricate a default.

> **Coordination:** Felix builds the Team Knowledge browser UI against this
> contract. Field names are the agreed names — change them only by editing the
> regen + this contract together (append-only; never rename a shipped column
> silently).
