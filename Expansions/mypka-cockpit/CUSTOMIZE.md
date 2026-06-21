# CUSTOMIZE.md — this cockpit is a templated example, not a fixed product

**Read this framing first.** The myPKA Cockpit is a **starting point**, not a
finished, locked product. It ships configured for one specific shape of
knowledge base (a myPKA: markdown notes with YAML frontmatter, mirrored into
`mypka.db`), but it is deliberately built so **your LLM assistant can expand it,
remap it, and re-point it at almost any knowledge base** — even one that looks
nothing like a myPKA.

The honest boundary, stated up front: adapting the cockpit to a *wildly*
different knowledge base is **LLM-assisted work that you own**. We give you the
**pattern** (this doc), the **contract** (`sqlite-extension/DATA-CONTRACT.md`),
and worked **examples** (`examples/library-module/`, `server/connectors/`). We
do **not** guarantee a turnkey result for an arbitrary source. Think of every
section below as "here's the seam, here's the example — your LLM does the
fitting."

Companion docs:

- [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) — the architecture you're customizing
  (the read-only-mirror model, the two-DB split, ports/CSP, the chat bridge).
  **Read it before changing anything** so your change respects the invariants.
- [`sqlite-extension/DATA-CONTRACT.md`](./sqlite-extension/DATA-CONTRACT.md) —
  the exact tables/views/columns the cockpit reads; the required-vs-optional
  map; and §7, "how to adapt this for a non-myPKA knowledge base."
- [`INSTALL.md`](./INSTALL.md) — the install contract (the 8-step procedure).
- [`server/connectors/README.md`](./server/connectors/README.md) — the connector
  authoring contract.
- [`examples/library-module/README.md`](./examples/library-module/README.md) —
  a complete worked example of adding a UI module end-to-end.

---

## 1. Point the cockpit at a different folder (`MYPKA_ROOT`)

The cockpit resolves its knowledge-base root **once at startup**, via
`server/repoRoot.js`, in this order (first match wins):

1. **`MYPKA_ROOT` env var** — if set to a real directory, used verbatim. **This
   is the override.**
2. Upward fingerprint search (a directory containing both `AGENTS.md` and
   `PKM/`, else one containing `mypka.db`).
3. Fallback: `Expansions/mypka-cockpit/` → three levels up.

To point the cockpit at a relocated or non-default knowledge base, set
`MYPKA_ROOT` before launch (e.g. in the launcher's environment, or your shell):

```sh
MYPKA_ROOT="/path/to/your/knowledge-base" node server/server.js
```

The cockpit then expects `mypka.db` at `<MYPKA_ROOT>/mypka.db`, resolves the
Fleeting-Notes write surface to `<MYPKA_ROOT>/PKM/Fleeting Notes/`, and `cd`s the
chat bridge to `<MYPKA_ROOT>`. If `MYPKA_ROOT` points nowhere real it is ignored
(with a one-line warning) and discovery falls through to (2)/(3).

> `MYPKA_ROOT` only changes **where** the cockpit looks. It does not change
> **what shape** the data must be in — that's the DATA-CONTRACT (§2).

---

## 2. Map a different markdown / frontmatter convention onto the contract

The cockpit reads a **fixed SQL contract** — a set of tables, columns, and views
in `mypka.db` (see `sqlite-extension/DATA-CONTRACT.md`). It does **not** read
your markdown directly; it reads the **mirror**. So adapting a different
source-of-truth convention means **changing the generator that fills the mirror**,
not the cockpit.

There are two paths (DATA-CONTRACT §intro):

- **The myPKA path** — your source is markdown-with-frontmatter close to a
  myPKA. Adapt `scripts/regen-mypka-db.py`: keep the table names and the columns
  the cockpit reads (DATA-CONTRACT §3 per-table title/subtitle/body columns), and
  change only the *scan + frontmatter-mapping* logic to match your folder layout
  and field names. Then run `sqlite-extension/install-extensions.py` for the
  optional packs.
- **The adapt path** — your source isn't markdown at all (a different app, a
  database, an export). Write your **own** generator that emits the **13 core
  tables** first (copy `sqlite-extension/schema/01-core-entities.sql`), then the
  optional tables only for the data you actually have. Use
  `install-extensions.py` as the **additive, idempotent** template (never drop,
  only add). Run `sqlite-extension/detect-gaps.py` to see, in the cockpit's own
  terms, exactly what will render and what will be empty.

**The minimum to boot** (DATA-CONTRACT §2): the 13 core tables — `people,
organizations, topics, projects, goals, key_elements, habits, documents,
deliverables, journal, journal_media, links, agents` — must exist (even empty),
or the server refuses to boot. Each entity table needs `slug`, a title column,
`body`/`content`, `file_path`, and `raw_frontmatter` (store *something*
JSON-shaped here even if your source has no frontmatter — the graph reads it).
Build `links` rows from whatever cross-reference your source has (`[[wikilinks]]`,
hrefs, relation fields). Everything beyond the core (Finance, Health, Workouts,
Habit/Food logs) is optional and **degrades to an honest empty state** when
absent — so you can map incrementally and the cockpit stays calm the whole way.

> **Adapting the manual-entry integration prompt.** When you remap conventions,
> also adapt the prompt that integrates hand-added journal entries into the graph
> — `launcher/templates/integrate-journal-entry.prompt.txt`. Point it at your own
> schema/naming docs and entity types, but keep its three load-bearing steps
> (preserve the original into `original_body` before rewriting, set
> `integration_status: integrated`, regenerate the mirror). The whole flow is
> documented in [`docs/journal-integration.md`](./docs/journal-integration.md).

---

## 3. Add or remove UI modules

The cockpit has **two layers** for turning modules on and off — and you'll use
both for different reasons.

### a) Runtime toggle + reorder (no rebuild) — the Settings page

The Hub's modules (Open Invoices, My Life buckets, Recently Scanned, Pinned,
Whiteboards, Latest documents, Latest journal) can be **shown/hidden and
reordered at runtime** from **Settings** (`web/src/views/SettingsView.tsx`). The
prefs persist to `mypka-cockpit.db` (`module_prefs` table) via
`GET`/`PUT /api/cockpit/settings` — the cockpit-owned writable store, so they
survive a `mypka.db` regen and never touch canonical markdown. The set of
toggleable Hub modules is the server's `KNOWN_MODULES` catalogue (mirrored in
`web/src/lib/cockpitExtras.ts` `MODULE_KEYS`); the Settings page renders the
catalogue, so it never hardcodes the toggle list.

Use this when you want to **hide a module you don't use** without touching code.

### b) Build-time registry (add/remove a whole view) — `moduleRegistry.tsx`

Whole **page-level modules** (the sidebar surfaces: Deliverables, Team Inbox,
Actions & Planning, Health & Life, Tracking, Workouts) are registered in
`web/src/lib/moduleRegistry.tsx`. This is the seam your LLM uses to add a new
module. **One entry** wires the sidebar row, the hash route (`#/<slug>`), and the
content mount:

```ts
{ slug: 'recipes', navLabel: 'Recipes', navIcon: BookOpen,
  navSection: 'library', View: RecipesView /* lazy-imported */ }
```

To **add** a module (full worked example in `examples/library-module/`):

1. **Data** — pick a folder for the notes; teach the generator
   (`scripts/regen-mypka-db.py`) to mirror them into a new table in `mypka.db`
   (add your table name to its owned-tables list so it's rebuilt each run).
2. **Server** — add one **read-only** prepared `SELECT` endpoint in
   `server/server.js` (e.g. `app.get('/api/cockpit/recipes', safe(() => listRecipes()))`).
   Guard any *optional* table with `tableExists`/`viewExists`/`optionalStmt` so
   it degrades to an empty payload, never a 500 (see HOW-IT-WORKS §7).
3. **Client** — add a view under `web/src/views/`, fetch with the read-only
   `useFetch` hook, render an honest empty state (`ModuleEmptyState` from
   `web/src/components/ui.tsx`) when the data is absent, then append **one** entry
   to `moduleRegistry.tsx`.
4. **Rebuild** — `npm --prefix web run build`. The row, route, and mount derive
   from the entry; no other file changes.

To **remove** a build-time module: delete its registry entry (and its files). The
registry is **frozen build-time data** — a static array of plain data + a
statically-imported component reference. **No eval, no dynamic code-string
injection, no remote import** — "installing" a module is adding a type-checked TS
entry, bundled like any other code. Keep it that way; never turn the registry
into a runtime plugin loader (that would break the security model in
HOW-IT-WORKS §3).

---

## 4. Add a connector (task / calendar / PM tool)

Connectors are how the cockpit pulls **live, read-only** tasks and calendar
events into the Hub's "Today" panel and the day-planner. The full contract is in
[`server/connectors/README.md`](./server/connectors/README.md); the essentials:

- **Read-only.** Connectors *visualize* items; editing happens in the source
  tool (every item carries a `url` deep link). Never implement a write call.
- **Secrets by reference, never by value.** The user stores the API key **first**
  via the Connections page (`#/connections` → "Connect a tool"), which writes it
  to `Team Knowledge/.env` (mode `0600`, never echoed back). Your connector
  resolves it in-process by **name only** with `readEnvKey('TOOL_API_KEY')`
  (`server/connectors/env.js`). The value must never appear in an emitted item, a
  response, a log line, an error, your context, or a commit.
- **Never throw.** On any failure (missing key, timeout, 401) return the calm
  degraded shape (`degraded(...)` from `types.js`) — it renders as a quiet "not
  connected" placeholder, not a crash.
- **Normalize to the shape.** Emit `NormalizedTask` / `NormalizedEvent` exactly
  (the canonical reference is `server/connectors/types.js`). Study
  `todoistTasks.js` (the cleanest REST example) and `imapStarred.js` (a non-REST
  example) before writing one.

The Connections page also has a **"let Claude wire this up"** hand-off: it asks
your local `claude` CLI to write the connector module, referencing the stored key
**by name only** (the chat bridge — HOW-IT-WORKS §8). So "add a connector" is
often: *store the key → ask Claude → it follows this contract.*

---

## 5. Use a different LLM (Codex / Gemini / other CLI)

The cockpit is **Claude-first, but LLM-agnostic by configuration.** The
"Discuss with AI" hand-off and the quick-launch terminal buttons (HOW-IT-WORKS
§8) shell out to a CLI — by default the `claude` CLI. If you drive your work
with **Codex CLI, the Gemini CLI, or another terminal agent**, point the cockpit
at it with one environment variable:

```sh
# in <scaffold-root>/Team Knowledge/.env (where the cockpit reads its config)
COCKPIT_LLM_CMD=codex        # or: gemini, or any CLI on your PATH; default: claude
```

Set it, restart the cockpit, and the AI/terminal buttons will spawn **your** CLI
(your login, your key) instead of `claude`. This stays fully BYO-key: the command
runs locally on your machine, nothing is pooled or proxied, and no key ships in
the package.

> **One caveat — prompt-passing differs per CLI.** The cockpit builds the command
> as `<COCKPIT_LLM_CMD> '<prompt>'` (the prompt as a single quoted argument), and
> for Claude it also maps the model selector to `--model`. A different CLI may
> expect the prompt on stdin, behind a subcommand (e.g. `codex exec "…"`), or
> with different flags — and the `--model` allow-list (`opus`/`sonnet`/`haiku`)
> is Claude-specific. If your CLI doesn't take the prompt the same way, have your
> own LLM adjust the **command builder** in
> [`server/server.js`](./server/server.js) (the `discuss` /
> `wire-assistant` routes that assemble the spawned command — see HOW-IT-WORKS
> §8). The seam is small and deliberately readable; the env var covers the common
> case, the builder edit covers the rest.

> **Confirm the exact variable name** against your shipped
> [`.env.example`](./.env.example) — `COCKPIT_LLM_CMD` (default `claude`) is the
> documented name; the `.env.example` comment is authoritative if it ever differs.

---

## 6. The honest boundary (what you own vs. what we provide)

| You provide / own | We provide |
|---|---|
| Your knowledge base + its conventions | The cockpit (reader, shell, modules) |
| The generator that fills `mypka.db` to the contract (or your adaptation of `regen-mypka-db.py`) | `scripts/regen-mypka-db.py`, `sqlite-extension/` (schema, installer, gap detector) |
| Your connector credentials + their safety | The connector contract + two worked examples |
| The LLM-assisted fitting for a non-myPKA source | The pattern, the contract, `detect-gaps.py` |
| Your `MYPKA_ROOT` / launch environment | Root resolution + the launcher |

Adapting to a knowledge base that looks like a myPKA is mostly **mapping**;
adapting to one that doesn't is **LLM-assisted engineering you own**. Either way,
the contract (`sqlite-extension/DATA-CONTRACT.md`) is the target, the read-only
+ two-DB model (`HOW-IT-WORKS.md`) is the invariant you must not break, and your
LLM assistant is the one doing the fitting. Start small: satisfy the 13 core
tables, boot the cockpit, then add optional modules one at a time — every absent
module degrades to a calm empty state, so you're never staring at a crash while
you build up.
