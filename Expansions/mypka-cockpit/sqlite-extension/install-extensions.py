#!/usr/bin/env python3
"""install-extensions.py — upgrade a myPKA scaffold's mypka.db so the cockpit's
richer UIs (Finance Hub, and optionally Health / Workouts / habit + food logs)
have backing data structures to render against.

WHAT THIS IS (read this first)
  A freshly-downloaded BASIC myPKA scaffold's mypka.db carries only the CORE
  entity tables (people, projects, journal, links, agents, …). The cockpit's
  Finance Hub and optional dashboards query tables/columns/views the base regen
  does not create. This installer ADDS exactly those structures — additively,
  idempotently, and without ever destroying a row of the user's data.

  It is a TEACHING EXAMPLE. A downstream LLM runs it (Step 4 of the install
  flow, after the backup gate) to wire ANY knowledge base into the cockpit, and
  adapts it for a non-myPKA data source. Read the comments; they explain WHY.

WHAT IT DOES, EXACTLY
  1. Verifies the target looks like a real mypka.db (has the core `journal`
     table) — refuses to touch anything else.
  2. FINANCE HUB (default, always):
       - ensures `documents` exists, then ADDs the invoice columns it lacks
         (ALTER TABLE ADD COLUMN — additive; existing document rows untouched);
       - creates the `transactions` table if missing (empty — the user's own
         bank-export ingest fills it);
       - (re)creates the three invoice views (v_open_invoices,
         v_reimbursement_pending, v_invoice_payment_trail).
  2b. JOURNAL HUB ADDITIONS (default, always):
       - ADDs journal.original_body / integration_status / manually_added
         (manual-entry preservation + "unfold original" after Penn integrates);
       - creates idx_journal_entry_date (CREATE … IF NOT EXISTS) for On-This-Day.
  3. MODULE packs. By DEFAULT (no flags) EVERY pack below installs — the cockpit
     ships fully wired out of the box. Pass one or more --with-… flags to opt INTO
     a deliberate SUBSET instead; --all is an explicit alias of the default.
       --with-quotes    quotes (random-quote Hub module; regen fills from markdown)
       --with-libraries library_registry + recipes + movies (the library foundation;
                        empty tables, regen fills them from PKM/<Library>/ markdown)
       --with-outer-world  outer_world (mymind-style saved-content module; empty table,
                        regen fills it from PKM/Outer World/ markdown)
       --with-health    health_metric / health_sleep / health_mood
       --with-workouts  health_workout / health_workout_route
       --with-habits    habit_logs (+ v_habit_heatmap, v_habit_streaks)
       --with-food      food_logs (+ v_food_log_calendar)
       --all            every module pack (explicit alias of the no-flag default)
     Each also widens `habits` with started_on / status when needed (--with-health
     uses them; the ALTER is harmless on a base scaffold).
  4. Prints a plain-language summary of what it ADDED vs. what was ALREADY THERE.

WHAT IT WILL NEVER DO
  * Never DROP a table. Tables are only ever CREATE … IF NOT EXISTS.
  * Never DROP a column or rewrite existing rows. Columns are only ever ADDed.
  * Never touch a markdown file. This script only opens the .db.
  * The ONLY drop it performs is `DROP VIEW IF EXISTS` on the views it OWNS,
    immediately followed by recreating them — views are pure derived queries
    with zero stored data, so this is lossless and is how they stay fresh.

IDEMPOTENT: safe to run any number of times. The second run reports "already
present" for everything and changes nothing.

INTEGRATION WITH THE REGEN
  The standalone ships scripts/regen-mypka-db.py. That script OWNS and rebuilds
  the core tables + the invoice columns + the three invoice views on every run.
  So once your scaffold's notes carry invoice frontmatter and you run the regen,
  the Finance Hub is fed from markdown automatically. This installer is for the
  case where you are NOT yet on that regen (a leaner generator, a hand-built db,
  or a non-myPKA source): it brings an existing mypka.db UP TO the contract
  WITHOUT a full regen and WITHOUT needing your markdown. The two are
  complementary — run whichever fits, the end-state schema is identical.

  For the OPTIONAL module tables (health_*, habit_logs, food_logs): the regen
  PRESERVES any table it does not own, so a table this installer creates (and an
  ingest later fills) survives every regen run untouched. See
  modules/README.md and DATA-CONTRACT.md.

REQUIREMENTS
  Python 3.8+ and the stdlib `sqlite3` only. NO third-party deps (the regen
  needs PyYAML to parse frontmatter; this installer does not — it works purely
  on the database).

USAGE
  python3 install-extensions.py /path/to/mypka.db                # ALL modules (default)
  python3 install-extensions.py /path/to/mypka.db --all          # ALL modules (explicit alias)
  python3 install-extensions.py /path/to/mypka.db --with-health  # ONLY the health subset
  python3 install-extensions.py /path/to/mypka.db --dry-run      # show plan, write nothing
"""
from __future__ import annotations

import argparse
import sqlite3
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Base-DB bootstrap. This installer ADDS the cockpit's richer structures ON TOP
# of an already-existing core mypka.db. On a freshly-downloaded scaffold there is
# often NO mypka.db at all (the markdown is the source of truth; the .db is a
# derived layer not generated until the regen runs). Rather than refuse with a
# bare "No such database" — which can stall an installing assistant — we
# AUTO-RUN the base regen to create the core tables FIRST, then proceed.
#
# The base-DB creator is the cockpit's own regen, shipped alongside this script:
#     <cockpit>/scripts/regen-mypka-db.py
# It derives the scaffold root from its OWN location (parents[3]) and always
# writes <root>/mypka.db. So the auto-bootstrap is only correct when the db path
# the user passed IS that <root>/mypka.db. When it diverges (a relocated cockpit,
# a custom db path, or a non-myPKA source), we cannot safely guess — we fall back
# to a CLEAR, ACTIONABLE message naming the exact command to run first.
# ---------------------------------------------------------------------------

REGEN_SCRIPT = (Path(__file__).resolve().parent.parent / "scripts"
                / "regen-mypka-db.py")


def _regen_default_db_path():
    """The mypka.db path the regen would write to: <scaffold-root>/mypka.db,
    where root is three levels up from the regen script (…/Expansions/
    mypka-cockpit/scripts/regen-mypka-db.py → root). Returns None if the regen
    isn't where we expect it."""
    if not REGEN_SCRIPT.is_file():
        return None
    return REGEN_SCRIPT.resolve().parents[3] / "mypka.db"


def _has_core_schema(db_path: Path) -> bool:
    """True if db exists and carries the core `journal` table (our mirror marker)."""
    if not db_path.is_file():
        return False
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            n = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal'"
            ).fetchone()
            return n is not None
        finally:
            con.close()
    except sqlite3.Error:
        return False


def _actionable_no_core(db_path: Path, reason: str) -> str:
    """Build the fallback error we print when we cannot auto-bootstrap. Always
    names the EXACT regen command — never a bare 'no such database'."""
    regen = REGEN_SCRIPT if REGEN_SCRIPT.is_file() else (
        "Expansions/mypka-cockpit/scripts/regen-mypka-db.py")
    return (
        f"{reason}\n\n"
        f"  This installer ADDS the cockpit's tables on top of an existing core\n"
        f"  mypka.db — it does not create the base DB itself. Create the core\n"
        f"  schema FIRST by running the cockpit's regen from your scaffold root:\n\n"
        f"      python3 \"{regen}\"\n\n"
        f"  (the regen needs PyYAML:  pip3 install --user pyyaml)\n"
        f"  It writes mypka.db at the scaffold root, then re-run this installer:\n\n"
        f"      python3 {Path(__file__).name} \"{db_path}\" [--all|--with-…]\n")


def ensure_core_db(db_path: Path, dry: bool) -> bool:
    """Guarantee a core mypka.db (with the `journal` table) exists at db_path
    BEFORE the extension tables are applied. Idempotent: a no-op when the core is
    already present. Auto-runs the base regen when it is safe to do so; otherwise
    exits with an actionable message. Never proceeds on a coreless DB.

    Returns True when a core DB is now present (caller may proceed to apply the
    extensions). Returns False ONLY in dry-run mode when the core DB does not yet
    exist — the regen is reported-but-skipped, so there is no schema to plan
    against and the caller must stop cleanly WITHOUT opening (and thereby
    creating) an empty sqlite file."""
    if _has_core_schema(db_path):
        return True  # core already there — nothing to bootstrap

    # The DB is missing OR present-but-coreless. Can the regen build the right file?
    regen_target = _regen_default_db_path()
    if regen_target is None:
        sys.exit(_actionable_no_core(
            db_path,
            "Cannot locate the base-DB regen script "
            "(scripts/regen-mypka-db.py) next to this installer."))

    if regen_target.resolve() != db_path.resolve():
        # Custom/relocated db path — auto-bootstrapping the default location would
        # build the wrong file. Tell the user exactly what to do.
        sys.exit(_actionable_no_core(
            db_path,
            f"No core mypka.db at: {db_path}\n"
            f"  (and the regen would write a DIFFERENT path: {regen_target})"))

    state = "missing" if not db_path.is_file() else "present but has no core `journal` table"
    print(f"  Core mypka.db {state} → auto-running the base regen first:")
    print(f"    python3 {REGEN_SCRIPT}")
    if dry:
        print("    (DRY-RUN: skipping the regen; it WOULD create the core schema,\n"
              "     then this installer WOULD add the cockpit extension tables.)\n")
        return False  # no core yet; caller must not open/create an empty .db

    proc = subprocess.run([sys.executable, str(REGEN_SCRIPT)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        sys.exit(_actionable_no_core(
            db_path,
            "The base regen did not complete (so no core DB was created).\n"
            f"  regen said: {detail}"))

    if not _has_core_schema(db_path):
        sys.exit(_actionable_no_core(
            db_path,
            "The base regen ran but the core `journal` table is still absent."))
    print("  Core schema created. Continuing with the cockpit extensions.\n")
    return True

# ---------------------------------------------------------------------------
# Column contracts. Each entry: (column_name, column_type_and_default).
# Applied with ALTER TABLE ADD COLUMN only when the column is absent.
# ---------------------------------------------------------------------------

# Invoice columns added to `documents` (GL-002; doc_type='invoice' only, NULL elsewhere).
DOCUMENTS_INVOICE_COLUMNS = [
    ("amount", "REAL"),
    ("currency", "TEXT"),
    ("invoice_number", "TEXT"),
    ("due_date", "TEXT"),
    ("payment_status", "TEXT"),
    ("paid_on", "TEXT"),
    ("reimbursable", "INTEGER"),
    ("reimbursement_status", "TEXT"),
    ("reimbursement_via", "TEXT"),
    ("linked_organizations", "TEXT"),
    ("linked_documents", "TEXT"),
]

# Columns the OPTIONAL health pack's planned-habits panel reads off `habits`.
HABITS_EXTRA_COLUMNS = [
    ("started_on", "TEXT"),
    ("status", "TEXT"),
]

# Journal additions for two Hub features (see schema/06-journal-additions.sql):
#   original_body / integration_status / manually_added  → manual-entry preservation
#     + "unfold original" after Penn integrates a raw entry.
#   (On-This-Day needs no new column — it reuses entry_date; only the index below.)
# Additive on the CORE `journal` table; existing rows get NULL (= 'raw').
JOURNAL_EXTRA_COLUMNS = [
    ("original_body", "TEXT"),
    ("integration_status", "TEXT"),
    ("manually_added", "INTEGER"),
]

# Full `documents` table for the from-scratch case (no `documents` yet).
DOCUMENTS_CREATE = """
CREATE TABLE documents (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL, title TEXT, doc_type TEXT,
  amount REAL, currency TEXT, invoice_number TEXT, due_date TEXT,
  payment_status TEXT, paid_on TEXT,
  reimbursable INTEGER, reimbursement_status TEXT, reimbursement_via TEXT,
  linked_organizations TEXT, linked_documents TEXT,
  body TEXT, file_path TEXT, raw_frontmatter TEXT)
"""

# Full `quotes` table for the random-quote Hub module (PKM/Quotes/, md-first).
# Created empty by the installer under --with-quotes / --all; the regen fills it
# from markdown. See schema/05-module-quotes.sql + DATA-CONTRACT.md §8.
QUOTES_CREATE = """
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL,
  quote_text TEXT, author TEXT, author_slug TEXT, source TEXT,
  quote_year INTEGER, tags TEXT,
  body TEXT, file_path TEXT, raw_frontmatter TEXT)
"""

# ---------------------------------------------------------------------------
# Library foundation (schema/07-library-foundation.sql). The registry + the two
# built-in libraries, created EMPTY under --with-libraries (or --all); the regen
# fills them from PKM/<Library>/ markdown. See DATA-CONTRACT.md §11.
#
# ADAPTATION: to wire a user's existing collection (books, wines, gear, …) without
# the regen, add a CREATE TABLE here with the invariant library columns
# (slug/title/status/tags/body/file_path/raw_frontmatter) + your axis columns, add
# it to LIBRARY_TABLES, and seed a LIBRARY_REGISTRY_SEED row. ensure_table is the
# additive, idempotent template — never drop, only add.
# ---------------------------------------------------------------------------
LIBRARY_REGISTRY_CREATE = """
CREATE TABLE library_registry (
  id INTEGER PRIMARY KEY, library_slug TEXT NOT NULL, nav_label TEXT,
  nav_icon TEXT, pkm_folder TEXT, doc_type TEXT,
  title_field TEXT DEFAULT 'title', sort_order INTEGER DEFAULT 0)
"""

LIBRARY_TABLES = {
    "recipes": """
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL, title TEXT,
  cuisine TEXT, dish_type TEXT, difficulty TEXT, status TEXT,
  total_time_min INTEGER, servings INTEGER, ingredient_count INTEGER,
  key_ingredients TEXT, source_url TEXT, source_channel TEXT,
  tags TEXT, body TEXT, file_path TEXT, raw_frontmatter TEXT)
""",
    "movies": """
CREATE TABLE movies (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL, title TEXT,
  media_type TEXT, status TEXT, rating INTEGER, release_year INTEGER,
  genre TEXT, director_creator TEXT, platform TEXT, date_watched TEXT,
  progress TEXT, total_seasons INTEGER, episodes_watched INTEGER, verdict TEXT,
  tags TEXT, body TEXT, file_path TEXT, raw_frontmatter TEXT)
""",
}

# (library_slug, nav_label, nav_icon, pkm_folder, doc_type, sort_order) for the
# built-in libraries. Seeded ONLY when the registry is empty of that slug, so a
# regen-written registry (which carries the live folder paths) is never clobbered.
LIBRARY_REGISTRY_SEED = [
    ("recipes", "Recipes", "ChefHat", "PKM/My Life/Recipes", "recipe", 10),
    ("movies", "Films & Series", "Clapperboard", "PKM/My Life/Movies", "movie", 20),
]

# Full `outer_world` table for the Outer World module (PKM/Outer World/, md-first,
# doc_type: outer-world). Created EMPTY under --with-outer-world / --all; the regen
# fills it from markdown. The FLAT embed_* columns are the Axon/Mack fetcher contract
# (embed_image / embed_favicon are LOCAL relative paths). The linked_* are JSON-array
# TEXT of slugs projected for grid filtering. See schema/08-module-outer-world.sql +
# DATA-CONTRACT.md §14.
OUTER_WORLD_CREATE = """
CREATE TABLE outer_world (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL, title TEXT, status TEXT,
  captured_on TEXT,
  source_url TEXT, source_type TEXT, source_author TEXT, source_published TEXT,
  embed_kind TEXT, embed_title TEXT, embed_description TEXT, embed_image TEXT,
  embed_site_name TEXT, embed_domain TEXT, embed_favicon TEXT, embed_author TEXT,
  embed_captured_at TEXT,
  tom_context TEXT, tags TEXT,
  linked_topics TEXT, linked_key_elements TEXT, linked_projects TEXT,
  linked_people TEXT, linked_organizations TEXT,
  body TEXT, file_path TEXT, raw_frontmatter TEXT)
"""

# Indexes for the Outer World module (the reverse-chron grid + the source_type facet).
# Applied with CREATE INDEX IF NOT EXISTS only when the table exists. Lossless.
OUTER_WORLD_INDEXES = [
    ("idx_outer_world_captured_on", "outer_world", "captured_on"),
    ("idx_outer_world_source_type", "outer_world", "source_type"),
]

TRANSACTIONS_CREATE = """
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  booking_date TEXT, value_date TEXT,
  amount REAL, currency TEXT,
  counterparty_name TEXT, purpose TEXT,
  end_to_end_reference TEXT,
  booked INTEGER DEFAULT 1,
  source_system TEXT,
  linked_invoice_slug TEXT,
  reconciliation_confidence TEXT,
  raw_data TEXT)
"""

# Finance views (regen-owned in the core; recreated here so a non-regen install
# still gets them). Dropping a view loses NOTHING — it has no stored rows.
FINANCE_VIEWS = {
    "v_open_invoices": """
CREATE VIEW v_open_invoices AS
SELECT
  d.slug, d.title, d.invoice_number, d.linked_organizations,
  d.amount, d.currency, d.due_date,
  CAST(julianday(d.due_date) - julianday('now', 'localtime', 'start of day') AS INTEGER)
    AS days_until_due,
  CASE WHEN d.due_date IS NOT NULL AND d.due_date < date('now', 'localtime')
       THEN 1 ELSE 0 END AS is_overdue,
  CASE WHEN d.due_date IS NOT NULL
            AND d.due_date >= date('now', 'localtime')
            AND d.due_date <= date('now', 'localtime', '+7 days')
       THEN 1 ELSE 0 END AS is_due_soon,
  d.file_path
FROM documents d
WHERE d.doc_type = 'invoice' AND d.payment_status = 'open'
""",
    "v_reimbursement_pending": """
CREATE VIEW v_reimbursement_pending AS
SELECT
  d.slug, d.title, d.invoice_number, d.linked_organizations,
  d.amount, d.currency, d.payment_status, d.paid_on,
  d.reimbursement_status, d.reimbursement_via, d.file_path
FROM documents d
WHERE d.doc_type = 'invoice'
  AND d.reimbursable = 1
  AND d.reimbursement_status = 'einzureichen'
""",
    "v_invoice_payment_trail": """
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
WHERE d.doc_type = 'invoice'
""",
}

HEALTH_TABLES = {
    "health_metric": """
CREATE TABLE health_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL, units TEXT, qty REAL,
  source TEXT NOT NULL DEFAULT '',
  recorded_at_raw TEXT NOT NULL DEFAULT '',
  recorded_at_utc TEXT NOT NULL DEFAULT '',
  local_date TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(metric_name, recorded_at_raw, source))
""",
    "health_sleep": """
CREATE TABLE health_sleep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asleep_hr REAL, awake_hr REAL, core_hr REAL, deep_hr REAL, rem_hr REAL,
  total_sleep_hr REAL, in_bed_hr REAL,
  in_bed_start_raw TEXT, in_bed_end_raw TEXT,
  sleep_start_raw TEXT, sleep_end_raw TEXT,
  source TEXT NOT NULL DEFAULT '',
  recorded_at_raw TEXT NOT NULL DEFAULT '',
  recorded_at_utc TEXT NOT NULL DEFAULT '',
  local_date TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(recorded_at_raw, source))
""",
    "health_mood": """
CREATE TABLE health_mood (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_date TEXT NOT NULL DEFAULT '',
  valence REAL, valence_class TEXT, kind TEXT,
  source TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))
""",
}

WORKOUT_TABLES = {
    "health_workout": """
CREATE TABLE health_workout (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_uuid TEXT NOT NULL, workout_type TEXT NOT NULL,
  start_raw TEXT NOT NULL DEFAULT '', end_raw TEXT, start_utc TEXT,
  local_date TEXT NOT NULL DEFAULT '',
  duration_sec REAL, distance_km REAL,
  active_energy_kcal REAL, total_energy_kcal REAL, avg_speed_kmh REAL,
  heart_rate_avg REAL, heart_rate_max REAL,
  elevation_ascended_m REAL, elevation_descended_m REAL,
  raw_json TEXT, source TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  location_name TEXT, location_admin TEXT, location_country TEXT,
  location_geocoded_at TEXT,
  UNIQUE(workout_uuid, source))
""",
    "health_workout_route": """
CREATE TABLE health_workout_route (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES health_workout(id) ON DELETE CASCADE,
  route_file_path TEXT NOT NULL,
  route_format TEXT NOT NULL DEFAULT 'gpx' CHECK (route_format IN ('gpx','geojson')),
  point_count INTEGER,
  bbox_min_lat REAL, bbox_min_lon REAL, bbox_max_lat REAL, bbox_max_lon REAL,
  elevation_min_m REAL, elevation_max_m REAL,
  file_sha256 TEXT, file_bytes INTEGER,
  source TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(workout_id))
""",
}

HABIT_LOG_TABLE = {
    "habit_logs": """
CREATE TABLE habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_slug TEXT NOT NULL, log_date TEXT NOT NULL,
  done INTEGER, trigger TEXT, note TEXT, log_schema TEXT,
  source_path TEXT NOT NULL DEFAULT '',
  UNIQUE(habit_slug, log_date))
""",
}
HABIT_LOG_VIEWS = {
    "v_habit_heatmap": """
CREATE VIEW v_habit_heatmap AS
SELECT hl.habit_slug, h.name AS habit_name, hl.log_date, hl.done, hl.log_schema
FROM habit_logs hl LEFT JOIN habits h ON h.slug = hl.habit_slug
ORDER BY hl.habit_slug, hl.log_date
""",
    "v_habit_streaks": """
CREATE VIEW v_habit_streaks AS
WITH committed AS (
  SELECT habit_slug, log_date, done,
         ROW_NUMBER() OVER (PARTITION BY habit_slug ORDER BY log_date DESC) AS rn
  FROM habit_logs WHERE done IS NOT NULL),
first_miss AS (
  SELECT habit_slug, MIN(rn) AS miss_rn FROM committed
  WHERE done = 0 GROUP BY habit_slug),
agg AS (
  SELECT c.habit_slug, MAX(c.log_date) AS last_committed_date,
         (SELECT done FROM committed c2 WHERE c2.habit_slug = c.habit_slug AND c2.rn = 1) AS most_recent_done,
         COUNT(*) AS committed_logs,
         SUM(CASE WHEN c.done = 1 THEN 1 ELSE 0 END) AS total_done,
         (SELECT miss_rn FROM first_miss fm WHERE fm.habit_slug = c.habit_slug) AS first_miss_rn
  FROM committed c GROUP BY c.habit_slug)
SELECT a.habit_slug, h.name AS habit_name, a.last_committed_date,
       CASE WHEN a.most_recent_done = 0 THEN 0
            WHEN a.first_miss_rn IS NULL THEN a.committed_logs
            ELSE a.first_miss_rn - 1 END AS current_streak,
       a.total_done, a.committed_logs,
       CAST(julianday('now') - julianday(a.last_committed_date) AS INTEGER) AS days_since_last_log
FROM agg a LEFT JOIN habits h ON h.slug = a.habit_slug
""",
}

FOOD_LOG_TABLE = {
    "food_logs": """
CREATE TABLE food_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER, journal_slug TEXT NOT NULL, log_date TEXT,
  mahlzeit_typ TEXT, kontext TEXT, eiweiss_sichtbar INTEGER,
  photo_path TEXT, photo_count INTEGER DEFAULT 0, note TEXT,
  key_element TEXT, linked_habits TEXT,
  source_path TEXT NOT NULL DEFAULT '')
""",
}
FOOD_LOG_VIEWS = {
    "v_food_log_calendar": """
CREATE VIEW v_food_log_calendar AS
SELECT log_date, mahlzeit_typ, kontext, eiweiss_sichtbar,
       photo_path, photo_count, note, key_element, linked_habits, journal_slug
FROM food_logs ORDER BY log_date DESC, mahlzeit_typ
""",
}


# ---------------------------------------------------------------------------
# Small helpers — all read-only against sqlite_master / PRAGMA.
# ---------------------------------------------------------------------------

def existing_objects(cur, kind):
    return {r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type = ?", (kind,))}


def table_columns(cur, table):
    return {r[1] for r in cur.execute(f"PRAGMA table_info({table})")}


class Plan:
    """Accumulates what we did so we can print an honest before/after summary."""
    def __init__(self):
        self.added = []      # things created/added this run
        self.present = []    # things already satisfying the contract
        self.refreshed = []  # views dropped+recreated (lossless)

    def add(self, msg): self.added.append(msg)
    def have(self, msg): self.present.append(msg)
    def refresh(self, msg): self.refreshed.append(msg)


def ensure_table(cur, name, ddl, tables_now, plan, dry):
    if name in tables_now:
        plan.have(f"table {name}")
        return
    plan.add(f"table {name}")
    if not dry:
        cur.executescript(ddl)
        tables_now.add(name)


def ensure_columns(cur, table, columns, plan, dry):
    have = table_columns(cur, table)
    for col, coltype in columns:
        if col in have:
            plan.have(f"{table}.{col}")
            continue
        plan.add(f"{table}.{col}")
        if not dry:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")


def ensure_views(cur, views, plan, dry):
    """Views carry no data — drop+recreate is always lossless, keeps them fresh."""
    for name, ddl in views.items():
        plan.refresh(f"view {name}")
        if not dry:
            cur.execute(f"DROP VIEW IF EXISTS {name}")
            cur.executescript(ddl)


def install_finance(cur, tables_now, plan, dry):
    # `documents` may already exist (core) WITHOUT invoice columns, or be absent.
    if "documents" in tables_now:
        plan.have("table documents")
        ensure_columns(cur, "documents", DOCUMENTS_INVOICE_COLUMNS, plan, dry)
    else:
        plan.add("table documents (with invoice columns)")
        if not dry:
            cur.executescript(DOCUMENTS_CREATE)
            tables_now.add("documents")
    if not dry:
        cur.execute("CREATE INDEX IF NOT EXISTS idx_documents_payment_status "
                    "ON documents (payment_status)")
    ensure_table(cur, "transactions", TRANSACTIONS_CREATE, tables_now, plan, dry)
    if not dry:
        cur.execute("CREATE INDEX IF NOT EXISTS idx_transactions_invoice "
                    "ON transactions (linked_invoice_slug)")
    ensure_views(cur, FINANCE_VIEWS, plan, dry)


def install_journal_additions(cur, plan, dry):
    """Always-on, like Finance: the manual-entry preservation columns + the
    On-This-Day index. Both back CORE Hub features, so they ship by default.
    Additive (ALTER ADD COLUMN guarded by PRAGMA) + idempotent index."""
    ensure_columns(cur, "journal", JOURNAL_EXTRA_COLUMNS, plan, dry)
    plan.refresh("index idx_journal_entry_date")  # CREATE … IF NOT EXISTS: lossless
    if not dry:
        cur.execute("CREATE INDEX IF NOT EXISTS idx_journal_entry_date "
                    "ON journal (entry_date)")


def install_quotes(cur, tables_now, plan, dry):
    """Random-quote Hub module backing. Creates the empty `quotes` table; the
    regen fills it from PKM/Quotes/ markdown. --with-quotes (or --all)."""
    ensure_table(cur, "quotes", QUOTES_CREATE, tables_now, plan, dry)


def install_libraries(cur, tables_now, plan, dry):
    """Library foundation: the registry + the two built-in library tables, created
    EMPTY (the regen fills them from PKM/<Library>/ markdown). --with-libraries
    (or --all). Additive + idempotent: tables are CREATE-if-absent; registry rows
    are seeded ONLY when that library_slug is not already present, so a
    regen-populated registry is never overwritten."""
    ensure_table(cur, "library_registry", LIBRARY_REGISTRY_CREATE, tables_now, plan, dry)
    for name, ddl in LIBRARY_TABLES.items():
        ensure_table(cur, name, ddl, tables_now, plan, dry)
    # Seed the registry rows for the built-ins, idempotently (skip slugs already
    # registered, e.g. by the regen). The empty mirror tables still render an
    # honest empty Library nav entry without any markdown.
    if not dry and "library_registry" in tables_now:
        have_slugs = {r[0] for r in cur.execute(
            "SELECT library_slug FROM library_registry")}
        for slug, label, icon, folder, doc_type, order in LIBRARY_REGISTRY_SEED:
            if slug in have_slugs:
                plan.have(f"library_registry row {slug}")
                continue
            plan.add(f"library_registry row {slug}")
            cur.execute(
                "INSERT INTO library_registry (library_slug, nav_label, nav_icon,"
                " pkm_folder, doc_type, title_field, sort_order)"
                " VALUES (?,?,?,?,?,?,?)",
                (slug, label, icon, folder, doc_type, "title", order))
    elif dry:
        for slug, *_ in LIBRARY_REGISTRY_SEED:
            plan.add(f"library_registry row {slug} (if absent)")


def install_outer_world(cur, tables_now, plan, dry):
    """Outer World module backing (mymind-style saved external content). Creates the
    empty `outer_world` table + its two indexes; the regen fills it from
    PKM/Outer World/ markdown (doc_type: outer-world). --with-outer-world (or --all).
    Additive + idempotent: table is CREATE-if-absent, indexes are CREATE … IF NOT
    EXISTS (guarded on the table existing)."""
    ensure_table(cur, "outer_world", OUTER_WORLD_CREATE, tables_now, plan, dry)
    if not dry and "outer_world" in tables_now:
        for idx, table, col in OUTER_WORLD_INDEXES:
            cur.execute(f"CREATE INDEX IF NOT EXISTS {idx} ON {table} ({col})")


def main():
    ap = argparse.ArgumentParser(
        description="Additively upgrade a myPKA mypka.db for the cockpit's richer "
                    "UIs. With NO flags, installs ALL module packs (the out-of-the-box "
                    "default); pass --with-… to install only a subset.")
    ap.add_argument("db", help="path to the scaffold's mypka.db")
    ap.add_argument("--with-quotes", action="store_true",
                    help="add the `quotes` table (random-quote Hub module; regen fills it)")
    ap.add_argument("--with-libraries", action="store_true",
                    help="add the library foundation: library_registry + recipes + movies "
                         "(empty; regen fills them from PKM/<Library>/ markdown)")
    ap.add_argument("--with-outer-world", action="store_true",
                    help="add the `outer_world` table (mymind-style saved-content module; "
                         "regen fills it from PKM/Outer World/ markdown)")
    ap.add_argument("--with-health", action="store_true",
                    help="add health_metric / health_sleep / health_mood + habits.started_on/status")
    ap.add_argument("--with-workouts", action="store_true",
                    help="add health_workout / health_workout_route")
    ap.add_argument("--with-habits", action="store_true",
                    help="add habit_logs + v_habit_heatmap / v_habit_streaks")
    ap.add_argument("--with-food", action="store_true",
                    help="add food_logs + v_food_log_calendar")
    ap.add_argument("--all", action="store_true",
                    help="install every module pack (explicit alias of the no-flag default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the plan, write nothing")
    args = ap.parse_args()

    db_path = Path(args.db).expanduser()

    # Bootstrap gate: guarantee a core mypka.db (with the `journal` table) exists
    # BEFORE we add the cockpit's extension tables. On a fresh scaffold there is
    # no mypka.db yet; this auto-runs the base regen to create the core schema
    # first (idempotent, and a no-op when the core is already present), so the
    # install never stalls on "no such database". Falls back to a clear,
    # actionable message if it cannot safely auto-create the right file.
    core_ready = ensure_core_db(db_path, args.dry_run)
    if not core_ready:
        # Dry-run on a scaffold with no mypka.db yet: the regen was reported but
        # skipped, so there is no core schema to plan the extensions against.
        # Stop here WITHOUT opening sqlite (which would create an empty .db file).
        print("  DRY-RUN complete: no DB was created or modified. Re-run without\n"
              "  --dry-run to auto-create the core DB and add the extensions.\n")
        return

    # DEFAULT = ALL (myPKA 3.0 launch contract). The cockpit install must wire the
    # FULL module schema deterministically, out of the box — NOT contingent on the
    # activating LLM (or a launcher) remembering to pass --all. So when the script
    # is invoked with NO explicit module selection (no --all AND no per-module
    # --with-… flag), we treat it EXACTLY as --all: every optional pack installs.
    #
    # Explicit subset selection is preserved for advanced users: passing one or more
    # --with-… flags opts INTO precisely that subset (and --all still forces all).
    # Only the no-selection default changed — from "Finance/Journal core only" to
    # "core + every module". This is safe to default-on even against an existing,
    # already-populated scaffold because every install path is additive,
    # non-destructive, and idempotent (ensure_table = CREATE-if-absent;
    # ensure_columns = ALTER ADD COLUMN-if-absent; ensure_views = lossless
    # drop+recreate of derived, zero-row views). The worst case on an à-la-carte
    # data source is a few unused EMPTY tables — never a dropped table, never a
    # modified or deleted row.
    module_flags = (args.with_quotes or args.with_libraries or args.with_outer_world
                    or args.with_health or args.with_workouts or args.with_habits
                    or args.with_food)
    install_all = args.all or not module_flags  # no explicit selection ⇒ all

    with_quotes = args.with_quotes or install_all
    with_libraries = args.with_libraries or install_all
    with_outer_world = args.with_outer_world or install_all
    with_health = args.with_health or install_all
    with_workouts = args.with_workouts or install_all
    with_habits = args.with_habits or install_all
    with_food = args.with_food or install_all

    con = sqlite3.connect(str(db_path))
    cur = con.cursor()
    plan = Plan()

    # Safety gate: this must look like a real myPKA mirror. The core regen always
    # creates `journal`. ensure_core_db() above already guarantees it (auto-running
    # the regen on a fresh scaffold), so reaching here without `journal` means the
    # DB is some OTHER (non-myPKA) sqlite file the user pointed us at by mistake —
    # refuse, with the actionable regen command rather than a bare error.
    tables_now = existing_objects(cur, "table")
    if "journal" not in tables_now:
        con.close()
        sys.exit(_actionable_no_core(
            db_path,
            f"{db_path} has no `journal` table — this does not look like a myPKA\n"
            "  mirror (mypka.db). Refusing to modify it."))

    print(f"\n  Target: {db_path}")
    print(f"  Mode:   {'DRY-RUN (no writes)' if args.dry_run else 'apply'}\n")

    # 1) Finance Hub — always.
    install_finance(cur, tables_now, plan, args.dry_run)

    # 1b) Journal Hub additions (manual-entry preservation + On-This-Day index) — always.
    install_journal_additions(cur, plan, args.dry_run)

    # 2) Optional packs.
    if with_quotes:
        install_quotes(cur, tables_now, plan, args.dry_run)
    if with_libraries:
        install_libraries(cur, tables_now, plan, args.dry_run)
    if with_outer_world:
        install_outer_world(cur, tables_now, plan, args.dry_run)
    if with_health:
        ensure_columns(cur, "habits", HABITS_EXTRA_COLUMNS, plan, args.dry_run)
        for name, ddl in HEALTH_TABLES.items():
            ensure_table(cur, name, ddl, tables_now, plan, args.dry_run)
    if with_workouts:
        for name, ddl in WORKOUT_TABLES.items():
            ensure_table(cur, name, ddl, tables_now, plan, args.dry_run)
    if with_habits:
        for name, ddl in HABIT_LOG_TABLE.items():
            ensure_table(cur, name, ddl, tables_now, plan, args.dry_run)
        ensure_views(cur, HABIT_LOG_VIEWS, plan, args.dry_run)
    if with_food:
        for name, ddl in FOOD_LOG_TABLE.items():
            ensure_table(cur, name, ddl, tables_now, plan, args.dry_run)
        ensure_views(cur, FOOD_LOG_VIEWS, plan, args.dry_run)

    if not args.dry_run:
        con.commit()
    con.close()

    # 3) Honest summary.
    verb = "WOULD ADD" if args.dry_run else "ADDED"
    if plan.added:
        print(f"  {verb} ({len(plan.added)}):")
        for m in plan.added:
            print(f"    + {m}")
    else:
        print("  Nothing to add — every required structure was already present.")
    if plan.refreshed:
        print(f"\n  {'WOULD REFRESH' if args.dry_run else 'REFRESHED'} views "
              f"(lossless drop+recreate, {len(plan.refreshed)}):")
        for m in plan.refreshed:
            print(f"    ~ {m}")
    if plan.present:
        print(f"\n  Already present ({len(plan.present)}):")
        for m in plan.present:
            print(f"    = {m}")

    print("\n  Idempotent: re-running changes nothing. No table or column was "
          "dropped; no row was modified.")
    print("  Next: run detect-gaps.py to confirm which cockpit modules now have "
          "backing data.\n")


if __name__ == "__main__":
    main()
