-- ============================================================================
-- mypka-cockpit.db  —  Migration 008: unified lane position space.
--
-- WHY. Until now events (calendar meetings) were positionless top-anchors and
-- only TASKS carried a stored `position`. The lane always rendered "all events
-- first, then all tasks", so a task could never be ordered ABOVE an event: a task
-- dropped above an event snapped back below it on the next paint, because the
-- ordering model had no slot for "before an event" (Felix diagnosis, 2026-06-23).
--
-- THE NEW MODEL. There is now ONE comparable position space per lane
-- (week_start, weekday, half) spanning events AND tasks:
--   * An EVENT derives a DETERMINISTIC position from its local start time:
--       event_position = minutes-since-local-midnight (0..1439); all-day = -1.
--     Events are NEVER stored as plan_assignments rows — they remain read-only
--     calendar anchors. The client computes their position at render time and
--     uses it only to sort + to pick the numeric target position when a task is
--     dropped next to an event. (No schema for events; nothing to migrate there.)
--   * A TASK keeps its stored REAL `position` in the SAME numeric space. A task
--     dropped ABOVE a 10:00 event (event_position 600) is stored with a position
--     < 600; a task dropped below it is stored > 600.
--
-- The `position` column is ALREADY REAL (migration 001), so this migration adds
-- NO column and changes NO type. It only REBASES the existing real-data rows so
-- the new unified space PRESERVES TOM'S CURRENT VISUAL ORDER on first load.
--
-- ---------------------------------------------------------------------------
-- THE REBASE (the only data change here).
--
-- Existing plan_assignments rows hold positions in the OLD task-only space (the
-- server seeded ~1.0, 2.0, 3.0 ... or fractional midpoints like 1.5). In the OLD
-- world every task rendered BELOW every event regardless of position. To keep
-- that exact picture after the upgrade, every existing task must land ABOVE the
-- highest possible event position (1439 = 23:59) — i.e. at 1440 and up — WHILE
-- preserving each cell's current task-to-task order.
--
-- We renumber, PER CELL (week_start, weekday, half), in current ascending
-- `position` order, to 1440, 1441, 1442, ... (stride 1, starting at the
-- EVENT_FLOOR of 1440). Result: every pre-existing task stays in the same
-- relative order it has today AND stays below every event (events live in
-- 0..1439), so Tom sees ZERO reordering of his existing plan after the upgrade.
-- New drops made AFTER the upgrade can place a task anywhere in the 0..1439
-- event band (above / between / below events) as intended.
--
-- DETERMINISTIC + IDEMPOTENT. The rebase is computed with a window function over
-- a stable ORDER BY (position, id) — the same input rows always produce the same
-- output numbers. It runs at most ONCE: the version-ordered runner only applies
-- this file when schema_version < 8 and bumps the version inside the SAME
-- transaction, so a re-boot is a no-op (the file is never re-executed). The
-- UPDATE itself is also self-stable: re-running it on already-rebased rows
-- (1440, 1441, ...) reproduces the identical numbers, so even a manual re-apply
-- is harmless.
--
-- ZERO contact with canonical markdown, mypka.db, GL-002, templates, or
-- regen-mypka-db.py. plan_assignments is cockpit-local and outside the regen.
-- ============================================================================

-- Rebase every existing task to the event-floor band (>= 1440), preserving each
-- cell's current order. row_number() over the cell partition gives 1,2,3,... in
-- (position, id) order; (1440 + rn - 1) maps that to 1440, 1441, 1442, ...
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY week_start, weekday, half
            ORDER BY position, id
        ) AS rn
    FROM plan_assignments
)
UPDATE plan_assignments
SET position = 1440.0 + (
        SELECT rn FROM ranked WHERE ranked.id = plan_assignments.id
    ) - 1.0
WHERE id IN (SELECT id FROM ranked);
