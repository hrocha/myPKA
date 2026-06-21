-- ============================================================================
-- mypka-cockpit.db  —  cockpit-owned, READ-WRITE, NOT part of the mypka.db regen.
-- Migration 001: day-planner plan-state.
--
-- Additive only. Zero contact with canonical markdown, mypka.db, GL-002,
-- templates, or regen-mypka-db.py. Every statement is IF NOT EXISTS /
-- INSERT OR IGNORE so re-running on every server boot is a no-op once applied.
-- Pragmas (journal_mode = WAL, foreign_keys = ON) are set by plannerDb.js on
-- the connection, NOT here — pragmas are connection-scoped, not migration data.
-- ============================================================================

-- One row per task card placed on the weekly board.
CREATE TABLE IF NOT EXISTS plan_assignments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start       TEXT    NOT NULL,        -- ISO date of Monday (YYYY-MM-DD), the week anchor
    weekday          INTEGER NOT NULL,        -- 0=Mon .. 6=Sun (matches workdays bitset semantics)
    half             TEXT    NOT NULL CHECK (half IN ('am','pm')),
    source           TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64 AND source NOT GLOB '*[^a-z0-9:_-]*'),
    external_task_id TEXT    NOT NULL,        -- opaque source ID; the ONLY link back to the source tool
    position         REAL    NOT NULL,        -- fractional rank within (week_start, weekday, half)
    note             TEXT,                    -- optional user scratch on the card (planner-only, never written back)
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    -- A given source task can sit in exactly ONE slot at a time. Re-dragging it
    -- MOVES it (UPDATE), never duplicates it. This is the idempotency anchor.
    UNIQUE (source, external_task_id)
);

-- Read-a-week and reorder-within-a-cell both hit this composite.
CREATE INDEX IF NOT EXISTS idx_plan_assignments_cell
    ON plan_assignments (week_start, weekday, half, position);

-- One row of work-hours settings. Single-user cockpit -> singleton row (id=1),
-- but keyed so a future multi-profile cockpit is a non-breaking additive change.
CREATE TABLE IF NOT EXISTS planner_settings (
    id            INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton guard for v1
    workdays      TEXT    NOT NULL DEFAULT '[0,1,2,3,4]',  -- JSON array of weekday ints (Mon..Fri default)
    am_pm_split   TEXT    NOT NULL DEFAULT '12:00',         -- HH:MM local; cards before = AM, after = PM
    -- Per-weekday work hours as a JSON object keyed by weekday int.
    -- Each value: {"start":"HH:MM","end":"HH:MM"}. Missing key = non-workday.
    work_hours    TEXT    NOT NULL DEFAULT
        '{"0":{"start":"09:00","end":"17:00"},"1":{"start":"09:00","end":"17:00"},"2":{"start":"09:00","end":"17:00"},"3":{"start":"09:00","end":"17:00"},"4":{"start":"09:00","end":"17:00"}}',
    timezone      TEXT    NOT NULL DEFAULT 'Europe/Vienna', -- planner-local TZ for split/positioning
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Seed the singleton on first boot (idempotent).
INSERT OR IGNORE INTO planner_settings (id) VALUES (1);
