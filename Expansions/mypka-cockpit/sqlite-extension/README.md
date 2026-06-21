# sqlite-extension — backing data for the cockpit's richer UIs

A freshly-downloaded **basic** myPKA scaffold's `mypka.db` carries only the core
entity tables. The cockpit's Finance Hub and optional dashboards (Health,
Workouts, habit/food logs) query tables, columns, and views the base regen does
not produce. This folder is the **free, open-source, additive** upgrade — and a
teaching example for wiring any knowledge base into the cockpit.

Everything here is additive and idempotent. Nothing here destroys data.

## Files

| File | What it is |
|---|---|
| `DATA-CONTRACT.md` | The exact backing data the cockpit needs, grouped by UI module: the minimum-viable boot set, which modules degrade gracefully, and the mapping the upgrade adds to the regen pipeline. **Read this first.** |
| `schema/01-core-entities.sql` | The minimum-viable core tables the cockpit needs to boot. |
| `schema/02-finance-hub.sql` | Invoice columns on `documents`, the `transactions` table, and the three invoice views. |
| `schema/03-module-health.sql` | Optional Health + Workouts tables (`health_metric`, `health_sleep`, `health_mood`, `health_workout*`). Fed by the user's own ingest. |
| `schema/04-module-habits-food.sql` | Optional `habit_logs` + `food_logs` tables and their heatmap/streak/calendar views. |
| `schema/05-module-quotes.sql` | The md-first `quotes` table (random-quote Hub; `PKM/Quotes/`, `doc_type: quote`). |
| `schema/06-journal-additions.sql` | The manual-entry preservation columns on `journal` (`original_body`, `integration_status`, `manually_added`). |
| `schema/07-library-foundation.sql` | The **library foundation**: `library_registry` + the two worked libraries `recipes` + `movies` (the reusable collection pattern; `DATA-CONTRACT.md §11`). |
| `detect-gaps.py` | **Step 3 — read-only probe.** Reports which modules have no backing data and what the user will see. Never writes. |
| `install-extensions.py` | **Step 4 — additive installer.** Upgrades an existing `mypka.db` to the contract. Idempotent; never drops a table/column or modifies a row. |

## Flow

```sh
# Step 3 — detect what's missing (read-only, safe anytime)
python3 detect-gaps.py /path/to/mypka.db

# Step 4 — add the missing structures additively (back up mypka.db first)
python3 install-extensions.py /path/to/mypka.db            # Finance Hub (default)
python3 install-extensions.py /path/to/mypka.db --all          # + every optional pack
python3 install-extensions.py /path/to/mypka.db --with-libraries # + the library foundation (recipes + movies)
python3 install-extensions.py /path/to/mypka.db --dry-run      # show the plan, write nothing

# confirm
python3 detect-gaps.py /path/to/mypka.db
```

## Dependencies

**Python 3.8+ standard library only** (`sqlite3`, `argparse`). No third-party
packages for either script.

Note: the scaffold's `scripts/regen-mypka-db.py` (a different tool, owned by the
regen pipeline) needs **PyYAML** to parse markdown frontmatter. These two
scripts do not — they work purely on the database.

## Relationship to the regen

The base regen owns and rebuilds the core tables + invoice columns + invoice
views from markdown. This installer reaches the same end-state for a scaffold
that isn't on the current regen, and creates the optional module tables that an
external ingest (not markdown) fills. The regen preserves any table it doesn't
own, so installer-created module tables survive every regen run. Full detail in
`DATA-CONTRACT.md` §6.
