#!/usr/bin/env python3
"""detect-gaps.py — READ-ONLY probe: report which cockpit modules have no backing
data in a scaffold's mypka.db, and what the user will SEE as a result.

This is Step 3 of the cockpit install flow: DETECT before you OFFER to upgrade.
It opens mypka.db read-only and prints, in plain language, for each cockpit
module:
   OK       — backing structure present (and, where cheap to check, has rows)
   EMPTY    — structure present but no data → renders an honest empty state
   MISSING  — structure absent → that module degrades or (for core) blocks boot

It maps every missing structure to the user-visible consequence, and tells the
user the exact next command (install-extensions.py …) to fix it.

READ-ONLY BY CONSTRUCTION
  The database is opened with SQLite URI flags `mode=ro` AND
  `PRAGMA query_only = ON`. This script issues only SELECT / PRAGMA statements.
  It cannot create, alter, drop, or write anything — by design. Run it as often
  as you like; it never changes the file.

REQUIREMENTS
  Python 3.8+ stdlib only (sqlite3). No third-party deps.

USAGE
  python3 detect-gaps.py /path/to/mypka.db
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

# A module is described by the structures it needs and the consequence of each
# being absent. `boot` modules block the whole cockpit; the rest degrade.
#
#   tables   : tables that must EXIST (empty is fine unless noted)
#   views    : views that must EXIST
#   columns  : {table: [cols]} columns that must exist on a table
#   boot     : True → missing structure stops the cockpit booting at all
#   consequence : the user-visible result when a needed structure is absent
#   fix      : the command that adds the missing structures (None for core)

MODULES = [
    {
        "name": "Core graph + browse (people/orgs/projects/goals/topics/KEs/habits)",
        "tables": ["people", "organizations", "topics", "projects", "goals",
                   "key_elements", "habits", "deliverables", "journal",
                   "journal_media", "links", "agents"],
        "views": [], "columns": {}, "boot": True,
        "consequence": "the cockpit server REFUSES TO BOOT (these are the "
                       "minimum-viable required tables).",
        "fix": "run scripts/regen-mypka-db.py against your scaffold.",
    },
    {
        "name": "Team roster",
        "tables": ["agents"], "views": [], "columns": {}, "boot": True,
        "consequence": "the roster page is empty / boot fails.",
        "fix": "run scripts/regen-mypka-db.py (it reads Team/<Name - Role>/AGENTS.md).",
    },
    {
        "name": "Journal media strip (images on journal entries)",
        "tables": ["journal_media"], "views": [], "columns": {}, "boot": False,
        "consequence": "journal entries render without their image strip.",
        "fix": "run scripts/regen-mypka-db.py (it parses the ## Media section).",
    },
    {
        "name": "Hub — On This Day (journal across prior years)",
        "tables": ["journal", "journal_media"], "views": [],
        "columns": {"journal": ["entry_date"]}, "boot": False,
        "consequence": "the 'On This Day' Hub module shows nothing (no prior-period "
                       "entries surfaced). Needs entry_date populated on entries.",
        "fix": "run scripts/regen-mypka-db.py (entry_date comes from the entry's "
               "date frontmatter / filename prefix).",
    },
    {
        "name": "Hub — manual-entry original-text (unfold original)",
        "tables": ["journal"], "views": [],
        "columns": {"journal": ["original_body", "integration_status"]},
        "boot": False,
        "consequence": "the 'unfold original' affordance can't render — the cockpit "
                       "can't tell a raw entry from an integrated one, and has "
                       "nowhere to read the preserved original.",
        "fix": "python3 install-extensions.py <db>   (journal additions are default).",
    },
    {
        "name": "Hub — random quote (Quotes library)",
        "tables": ["quotes"], "views": [], "columns": {}, "boot": False,
        "consequence": "the random-quote Hub module renders empty (no quote to show).",
        "fix": "python3 install-extensions.py <db> --with-quotes   (then add "
               "PKM/Quotes/ notes and run scripts/regen-mypka-db.py).",
    },
    {
        "name": "Outer World (mymind-style saved-content library)",
        "tables": ["outer_world"], "views": [], "columns": {}, "boot": False,
        "consequence": "the Outer World card grid renders empty (no saved articles / "
                       "posts / videos / books / ideas to browse and filter).",
        "fix": "python3 install-extensions.py <db> --with-outer-world   (then add "
               "PKM/Outer World/ notes with doc_type: outer-world and run the regen).",
    },
    {
        "name": "Library — enumeration (data-driven Library nav)",
        "tables": ["library_registry"], "views": [], "columns": {}, "boot": False,
        "consequence": "the cockpit has no list of libraries to put in the sidebar's "
                       "Library group — no library module is enumerated, so the whole "
                       "Library nav section is absent.",
        "fix": "python3 install-extensions.py <db> --with-libraries   (then add "
               "PKM/<Library>/ notes and run scripts/regen-mypka-db.py).",
    },
    {
        "name": "Library — Recipes",
        "tables": ["recipes"], "views": [], "columns": {}, "boot": False,
        "consequence": "the Recipes library renders empty (no recipe cards to browse).",
        "fix": "python3 install-extensions.py <db> --with-libraries   (then add "
               "PKM/My Life/Recipes/ notes with doc_type: recipe and run the regen).",
    },
    {
        "name": "Library — Films & Series (movies)",
        "tables": ["movies"], "views": [], "columns": {}, "boot": False,
        "consequence": "the Films & Series library renders empty (no movie cards).",
        "fix": "python3 install-extensions.py <db> --with-libraries   (then add "
               "PKM/My Life/Movies/ notes with doc_type: movie and run the regen).",
    },
    {
        "name": "Finance Hub — open invoices",
        "tables": ["documents"], "views": ["v_open_invoices"],
        "columns": {"documents": ["amount", "due_date", "payment_status",
                                  "linked_organizations"]},
        "boot": False,
        "consequence": "the 'Open invoices' panel renders empty (no overdue / "
                       "due-soon list).",
        "fix": "python3 install-extensions.py <db>   (Finance Hub is default).",
    },
    {
        "name": "Finance Hub — reimbursements",
        "tables": ["documents"], "views": ["v_reimbursement_pending"],
        "columns": {"documents": ["reimbursable", "reimbursement_status"]},
        "boot": False,
        "consequence": "the 'Reimbursements to claim' panel renders empty.",
        "fix": "python3 install-extensions.py <db>",
    },
    {
        "name": "Finance Hub — payment trail (bank reconciliation)",
        "tables": ["documents", "transactions"], "views": ["v_invoice_payment_trail"],
        "columns": {}, "boot": False,
        "consequence": "the payment-audit-trail shows no matched bank "
                       "transactions for paid invoices.",
        "fix": "python3 install-extensions.py <db>  (then feed transactions from "
               "your own bank export).",
    },
    {
        "name": "Health dashboard (body metrics, trends, mind/mood)",
        "tables": ["health_metric"], "views": [], "columns": {}, "boot": False,
        "consequence": "the Health view renders empty panels (weight/RHR/HRV/"
                       "SpO2/trends all blank). The pack also isn't compiled in "
                       "until you activate it.",
        "fix": "python3 install-extensions.py <db> --with-health  (then run your "
               "Apple-Health ingest).",
    },
    {
        "name": "Health dashboard — sleep trend",
        "tables": ["health_sleep"], "views": [], "columns": {}, "boot": False,
        "consequence": "the 30-day sleep trend (total/deep/REM) is blank.",
        "fix": "python3 install-extensions.py <db> --with-health",
    },
    {
        "name": "Health dashboard — planned-habits cards",
        "tables": ["habits"], "views": [],
        "columns": {"habits": ["started_on", "status"]}, "boot": False,
        "consequence": "habit cards in the Health view show no started-on date / "
                       "status (cards still render from name + cadence).",
        "fix": "python3 install-extensions.py <db> --with-health",
    },
    {
        "name": "Workouts (catalogue + GPX route maps)",
        "tables": ["health_workout", "health_workout_route"], "views": [],
        "columns": {}, "boot": False,
        "consequence": "the Workouts view lists nothing and renders no route "
                       "maps. The pack also isn't compiled in until activated.",
        "fix": "python3 install-extensions.py <db> --with-workouts  (then ingest "
               "workouts + GPX files).",
    },
    {
        "name": "Habit heatmap + streaks",
        "tables": ["habit_logs"], "views": ["v_habit_heatmap", "v_habit_streaks"],
        "columns": {}, "boot": False,
        "consequence": "habit heatmap / streak surfaces render empty.",
        "fix": "python3 install-extensions.py <db> --with-habits  (then run your "
               "habit-log extractor).",
    },
    {
        "name": "Food-log calendar",
        "tables": ["food_logs"], "views": ["v_food_log_calendar"],
        "columns": {}, "boot": False,
        "consequence": "the food-log calendar renders empty.",
        "fix": "python3 install-extensions.py <db> --with-food  (then run your "
               "food-log extractor).",
    },
]


def open_readonly(db_path: Path) -> sqlite3.Connection:
    """Open the db strictly read-only: URI mode=ro + PRAGMA query_only."""
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.execute("PRAGMA query_only = ON")  # belt-and-braces: reject any write
    return con


def inventory(con):
    cur = con.cursor()
    tables = {r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    views = {r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='view'")}
    return tables, views


def columns_of(con, table):
    try:
        return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def row_count(con, table):
    try:
        return con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except sqlite3.Error:
        return None


def assess(con, mod, tables, views):
    """-> (status, [missing structure descriptions])."""
    missing = []
    for t in mod["tables"]:
        if t not in tables:
            missing.append(f"table {t}")
    for v in mod["views"]:
        if v not in views:
            missing.append(f"view {v}")
    for t, cols in mod["columns"].items():
        if t in tables:
            have = columns_of(con, t)
            for c in cols:
                if c not in have:
                    missing.append(f"{t}.{c}")
        # if the table itself is missing it's already flagged above
    if missing:
        return "MISSING", missing

    # All structures present — is there any data? Check the primary tables that
    # exist; "empty" is a soft state (honest empty render), not a failure.
    primary = [t for t in mod["tables"] if t in tables]
    counts = [row_count(con, t) for t in primary]
    counts = [c for c in counts if c is not None]
    if counts and max(counts) == 0:
        return "EMPTY", []
    return "OK", []


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python3 detect-gaps.py /path/to/mypka.db")
    db_path = Path(sys.argv[1]).expanduser()
    if not db_path.is_file():
        sys.exit(f"No such database: {db_path}")

    con = open_readonly(db_path)
    tables, views = inventory(con)

    print(f"\n  Cockpit backing-data gap report")
    print(f"  Database: {db_path}  (opened READ-ONLY)\n")

    symbols = {"OK": "[ OK     ]", "EMPTY": "[ EMPTY  ]", "MISSING": "[ MISSING]"}
    n_missing = n_empty = 0
    for mod in MODULES:
        status, missing = assess(con, mod, tables, views)
        print(f"  {symbols[status]} {mod['name']}")
        if status == "MISSING":
            n_missing += 1
            tag = "BLOCKS BOOT" if mod["boot"] else "degrades"
            print(f"             missing: {', '.join(missing)}")
            print(f"             {tag}: {mod['consequence']}")
            if mod["fix"]:
                print(f"             fix: {mod['fix']}")
        elif status == "EMPTY":
            n_empty += 1
            print(f"             present but no rows yet → renders an honest "
                  f"empty state. Populate via your ingest/regen.")
        print()

    con.close()

    print("  Summary:")
    print(f"    {n_missing} module(s) MISSING backing structure")
    print(f"    {n_empty} module(s) present but EMPTY (will render empty state)")
    if n_missing:
        print("\n  To add the missing structures additively (no data loss):")
        print("    python3 install-extensions.py "
              f"{db_path} [--with-health|--with-workouts|--with-habits|--with-food|--all]")
        print("  (back up mypka.db first — the install flow's backup gate covers this.)")
    print("\n  This probe is READ-ONLY: it changed nothing.\n")


if __name__ == "__main__":
    main()
