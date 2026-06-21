-- ============================================================================
-- mypka-cockpit.db  —  cockpit-owned, READ-WRITE, NOT part of the mypka.db regen.
-- Migration 005: GENERIC SOURCES — drop the hardcoded source allow-list.
--
-- v1 baked CHECK (source IN ('todoist','clickup','gmail')) into three tables.
-- The cockpit's connector registry is now open-ended (any tool, including
-- LLM-authored connectors like 'email:starred' or 'linear'), and the AUTHORITATIVE
-- source validation happens at the route layer against registeredSourceIds()
-- (plannerRoutes.js) — only a currently-registered connector's id is accepted
-- for any plan write. The DB keeps a FORMAT check (non-empty, sane charset,
-- bounded length) as the belt; the registry is the suspenders.
--
-- SQLite cannot ALTER a CHECK, so this is the standard rebuild: new table →
-- copy → drop → rename, inside the runner's single transaction. Data, UNIQUE
-- anchors and indexes are preserved exactly.
-- ============================================================================

-- ---- plan_assignments -------------------------------------------------------
CREATE TABLE plan_assignments_v5 (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start       TEXT    NOT NULL,
    weekday          INTEGER NOT NULL,
    half             TEXT    NOT NULL CHECK (half IN ('am','pm')),
    source           TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64 AND source NOT GLOB '*[^a-z0-9:_-]*'),
    external_task_id TEXT    NOT NULL,
    position         REAL    NOT NULL,
    note             TEXT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (source, external_task_id)
);
INSERT INTO plan_assignments_v5 (id, week_start, weekday, half, source, external_task_id, position, note, created_at, updated_at)
    SELECT id, week_start, weekday, half, source, external_task_id, position, note, created_at, updated_at FROM plan_assignments;
DROP TABLE plan_assignments;
ALTER TABLE plan_assignments_v5 RENAME TO plan_assignments;
CREATE INDEX IF NOT EXISTS idx_plan_assignments_cell
    ON plan_assignments (week_start, weekday, half, position);

-- ---- weekly_goals -----------------------------------------------------------
CREATE TABLE weekly_goals_v5 (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start       TEXT    NOT NULL,
    source           TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64 AND source NOT GLOB '*[^a-z0-9:_-]*'),
    external_task_id TEXT    NOT NULL,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (week_start, source, external_task_id)
);
INSERT INTO weekly_goals_v5 (id, week_start, source, external_task_id, created_at)
    SELECT id, week_start, source, external_task_id, created_at FROM weekly_goals;
DROP TABLE weekly_goals;
ALTER TABLE weekly_goals_v5 RENAME TO weekly_goals;
CREATE INDEX IF NOT EXISTS idx_weekly_goals_week
    ON weekly_goals (week_start, source, external_task_id);

-- ---- completed_tasks ----------------------------------------------------------
CREATE TABLE completed_tasks_v5 (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start       TEXT    NOT NULL,
    source           TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64 AND source NOT GLOB '*[^a-z0-9:_-]*'),
    external_task_id TEXT    NOT NULL,
    completed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (week_start, source, external_task_id)
);
INSERT INTO completed_tasks_v5 (id, week_start, source, external_task_id, completed_at)
    SELECT id, week_start, source, external_task_id, completed_at FROM completed_tasks;
DROP TABLE completed_tasks;
ALTER TABLE completed_tasks_v5 RENAME TO completed_tasks;
CREATE INDEX IF NOT EXISTS idx_completed_tasks_week
    ON completed_tasks (week_start, source, external_task_id);
