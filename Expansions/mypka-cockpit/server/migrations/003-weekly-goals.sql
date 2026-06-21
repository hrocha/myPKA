-- ============================================================================
-- mypka-cockpit.db  —  Migration 003: weekly goals (planner-local flags).
--
-- Additive only. Adds ONE table that marks a source task (Todoist/ClickUp/…) as
-- a WEEKLY GOAL for a given week. A weekly goal pins to the top of the
-- Unscheduled sidebar. "Highlight of the Day" is DERIVED, never stored:
--   isHighlight = isWeeklyGoal && (the task also has a plan_assignments row on a day)
-- so this migration adds NO highlight column / table — highlights fall out of the
-- existing plan_assignments join at read time.
--
-- Zero contact with canonical markdown, mypka.db, GL-002, templates, or
-- regen-mypka-db.py. The weekly_goals flag is planner-local: it is READ-ONLY with
-- respect to the source task tools (Todoist/ClickUp) — nothing here is ever
-- written back to the source. (source, external_task_id) is the opaque link only.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + the version-ordered runner only
-- applies this file when schema_version < 3 and bumps the version inside the same
-- transaction, so the table is created at most once and re-boots are no-ops.
-- ============================================================================

-- One row per (week, source task) marked as a weekly goal.
CREATE TABLE IF NOT EXISTS weekly_goals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start       TEXT    NOT NULL,        -- ISO date of Monday (YYYY-MM-DD), the week anchor
    source           TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64 AND source NOT GLOB '*[^a-z0-9:_-]*'),
    external_task_id TEXT    NOT NULL,        -- opaque source ID; the ONLY link back to the source tool
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    -- A given source task is a weekly goal at most ONCE per week. set() is an
    -- INSERT OR IGNORE / UPSERT against this key; re-marking is a no-op, never a
    -- duplicate. This is the idempotency anchor.
    UNIQUE (week_start, source, external_task_id)
);

-- The getWeek read joins weekly_goals by (week_start) and tags cards by
-- (source, external_task_id); this composite serves both the per-week list and
-- the per-card membership probe.
CREATE INDEX IF NOT EXISTS idx_weekly_goals_week
    ON weekly_goals (week_start, source, external_task_id);
