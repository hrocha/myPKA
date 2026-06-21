-- ============================================================================
-- mypka-cockpit.db  —  Migration 002: optional lunch-break planner setting.
--
-- Additive only. Adds ONE nullable JSON TEXT column to planner_settings so the
-- planner can carry an optional lunch band alongside the single AM/PM divider.
-- Zero contact with canonical markdown, mypka.db, GL-002, templates, or
-- regen-mypka-db.py. Symmetrical with 001: planner_settings stays column-per-
-- setting (the table has no generic blob column), so a new setting needs its
-- own column rather than "riding in" an existing one — that keeps every prior
-- key's contract (workdays / am_pm_split / work_hours / timezone) untouched.
--
-- Shape carried in the column (JSON):
--   { "enabled": <bool>, "start": "HH:MM", "end": "HH:MM" }
--
-- DEFAULT is disabled, so existing behaviour (single divider) is unchanged until
-- the user turns it on in the gear settings. start mirrors the existing
-- am_pm_split (12:00); end is one hour later (13:00). NULL is also tolerated by
-- the read layer (parseSettings seeds a disabled default), so legacy rows that
-- predate this column round-trip cleanly.
--
-- Idempotency: the runner only applies this file when schema_version < 2 and
-- bumps the version inside the same transaction, so ALTER TABLE ADD COLUMN runs
-- at most once and never collides with SQLite's "duplicate column" error.
-- ============================================================================

ALTER TABLE planner_settings
    ADD COLUMN lunch_break TEXT NOT NULL DEFAULT '{"enabled":false,"start":"12:00","end":"13:00"}';
