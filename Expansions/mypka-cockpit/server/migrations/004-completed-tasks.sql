-- ============================================================================
-- mypka-cockpit.db  —  Migration 004: completed tasks (planner-LOCAL flags).
--
-- Iris spec 20 §7, "complete a task". Marks a source task (Todoist/ClickUp/…) as
-- COMPLETED for a given week, planner-side. A completed card renders struck-through /
-- checked in the board. This is the LOCAL half of the feature (layer A): it is the
-- planner's own "done" flag and is SAFE — it never touches the source tool.
--
-- The SOURCE half (closing the task on Todoist/ClickUp, layer B) is NOT in this
-- table. It is a runtime call gated behind its OWN env flag (SOURCE_WRITE_ENABLED)
-- and the complete_on_source setting; this migration adds NO source-side state.
--
-- Zero contact with canonical markdown, mypka.db, GL-002, templates, or
-- regen-mypka-db.py. (source, external_task_id) is the opaque link only; the
-- completed_tasks flag is planner-local and READ-ONLY w.r.t. the source unless the
-- separately-gated source-write path fires.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + the version-ordered runner only applies
-- this file when schema_version < 4 and bumps the version inside the same
-- transaction, so the table is created at most once and re-boots are no-ops.
--
-- complete_on_source: the per-planner toggle that ARMS the (separately env-gated)
-- source-write. Added here as an additive column on the planner_settings singleton,
-- DEFAULT 0 (OFF) so the dormant posture is the default for existing rows.
-- ============================================================================

-- One row per (week, source task) marked complete in the planner.
CREATE TABLE IF NOT EXISTS completed_tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start       TEXT    NOT NULL,        -- ISO date of Monday (YYYY-MM-DD), the week anchor
    source           TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64 AND source NOT GLOB '*[^a-z0-9:_-]*'),
    external_task_id TEXT    NOT NULL,        -- opaque source ID; the ONLY link back to the source tool
    completed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    -- A given source task is completed at most ONCE per week. setCompleted() is an
    -- UPSERT against this key; re-completing is a no-op, never a duplicate. This is
    -- the idempotency anchor.
    UNIQUE (week_start, source, external_task_id)
);

-- The getWeek read joins completed_tasks by (week_start) and tags cards by
-- (source, external_task_id); this composite serves both the per-week list and the
-- per-card membership probe.
CREATE INDEX IF NOT EXISTS idx_completed_tasks_week
    ON completed_tasks (week_start, source, external_task_id);

-- ARM-toggle for the source-write path (layer B). Additive column on the singleton
-- settings row. 0 = OFF (default): completing a task is LOCAL-only. 1 = ON: when the
-- SOURCE_WRITE_ENABLED env gate is ALSO set, a complete:true ALSO closes the task on
-- the source. SQLite has no native boolean — stored as INTEGER 0/1; the settings
-- validator maps it to/from a JS boolean.
ALTER TABLE planner_settings ADD COLUMN complete_on_source INTEGER NOT NULL DEFAULT 0;
