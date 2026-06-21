-- ============================================================================
-- 04-module-habits-food.sql — habit-log heatmaps + food-log calendar
-- ----------------------------------------------------------------------------
-- OPTIONAL module backing. These are DERIVED FROM MARKDOWN (unlike the health_*
-- tables, which come from an external ingest), but they are NOT part of the
-- cockpit's core regen — they are produced by a habit-log / food-log extractor
-- the user's regen pipeline can add. This file CREATES the empty tables + the
-- two read-time views so the surfaces render an honest empty state.
--
--   habit_logs  one row per habit per day  (done 1/0/NULL, trigger, note)
--   food_logs   one row per logged meal     (from journal "## Essen" / food sections)
--
-- The views v_habit_heatmap / v_habit_streaks / v_food_log_calendar are NOT in
-- the cockpit core's OWNED_VIEWS, so the core regen leaves them untouched — they
-- belong to whichever extractor owns these tables. install-extensions.py only
-- creates them under --with-habits / --with-food. ALL DATA IS THE USER'S OWN;
-- this schema seeds NOTHING.
-- ============================================================================

-- ── habit_logs ───────────────────────────────────────────────────────────────
--   done       1 = did it, 0 = missed, NULL = not yet committed/logged
--   log_schema free-text tag describing the logging shape (carried through views)
CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_slug TEXT NOT NULL,
  log_date TEXT NOT NULL,
  done INTEGER,
  trigger TEXT,
  note TEXT,
  log_schema TEXT,
  source_path TEXT NOT NULL DEFAULT '',
  UNIQUE(habit_slug, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_slug_date ON habit_logs (habit_slug, log_date);

-- ── food_logs ────────────────────────────────────────────────────────────────
--   eiweiss_sichtbar  1/0 — "visible protein" flag (German field, kept verbatim)
--   mahlzeit_typ      meal type label ('Frühstück' | 'Mittag' | …)
CREATE TABLE IF NOT EXISTS food_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER,
  journal_slug TEXT NOT NULL,
  log_date TEXT,
  mahlzeit_typ TEXT,
  kontext TEXT,
  eiweiss_sichtbar INTEGER,
  photo_path TEXT,
  photo_count INTEGER DEFAULT 0,
  note TEXT,
  key_element TEXT,
  linked_habits TEXT,
  source_path TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_food_logs_date ON food_logs (log_date);

-- ── Views (owned by THIS module's extractor, not by the cockpit core regen) ───
-- Read-time aggregations. Distinct names from the core OWNED_VIEWS so the core
-- regen preserves them. Drop+recreate here so re-running the installer refreshes.

DROP VIEW IF EXISTS v_food_log_calendar;
CREATE VIEW v_food_log_calendar AS
SELECT log_date, mahlzeit_typ, kontext, eiweiss_sichtbar,
       photo_path, photo_count, note, key_element, linked_habits, journal_slug
FROM food_logs
ORDER BY log_date DESC, mahlzeit_typ;

DROP VIEW IF EXISTS v_habit_heatmap;
CREATE VIEW v_habit_heatmap AS
SELECT hl.habit_slug, h.name AS habit_name, hl.log_date, hl.done, hl.log_schema
FROM habit_logs hl
LEFT JOIN habits h ON h.slug = hl.habit_slug
ORDER BY hl.habit_slug, hl.log_date;

-- Current-streak / total-done aggregation over committed (done IS NOT NULL) logs.
DROP VIEW IF EXISTS v_habit_streaks;
CREATE VIEW v_habit_streaks AS
WITH committed AS (
    SELECT habit_slug, log_date, done,
           ROW_NUMBER() OVER (PARTITION BY habit_slug ORDER BY log_date DESC) AS rn
    FROM habit_logs
    WHERE done IS NOT NULL
),
first_miss AS (
    SELECT habit_slug, MIN(rn) AS miss_rn
    FROM committed
    WHERE done = 0
    GROUP BY habit_slug
),
agg AS (
    SELECT c.habit_slug,
           MAX(c.log_date) AS last_committed_date,
           (SELECT done FROM committed c2
             WHERE c2.habit_slug = c.habit_slug AND c2.rn = 1) AS most_recent_done,
           COUNT(*) AS committed_logs,
           SUM(CASE WHEN c.done = 1 THEN 1 ELSE 0 END) AS total_done,
           (SELECT miss_rn FROM first_miss fm
             WHERE fm.habit_slug = c.habit_slug) AS first_miss_rn
    FROM committed c
    GROUP BY c.habit_slug
)
SELECT
    a.habit_slug,
    h.name AS habit_name,
    a.last_committed_date,
    CASE
        WHEN a.most_recent_done = 0 THEN 0
        WHEN a.first_miss_rn IS NULL THEN a.committed_logs
        ELSE a.first_miss_rn - 1
    END AS current_streak,
    a.total_done,
    a.committed_logs,
    CAST(julianday('now') - julianday(a.last_committed_date) AS INTEGER) AS days_since_last_log
FROM agg a
LEFT JOIN habits h ON h.slug = a.habit_slug;
