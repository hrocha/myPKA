-- ============================================================================
-- mypka-cockpit.db  —  cockpit-owned, READ-WRITE, NOT part of the mypka.db regen.
-- Migration 006: runtime Hub module preferences (Settings page).
--
-- Additive only. Zero contact with canonical markdown, mypka.db, GL-002,
-- templates, or regen-mypka-db.py. Every statement is IF NOT EXISTS /
-- INSERT OR IGNORE so re-running on every server boot is a no-op once applied.
-- Pragmas (journal_mode = WAL, foreign_keys = ON) are set on the connection by
-- the opening module, NOT here — pragmas are connection-scoped, not migration data.
--
-- WHY A TABLE (not the build-time moduleRegistry): the moduleRegistry decides
-- which extension modules EXIST in the build. THIS table decides which Hub
-- SECTIONS the user shows/hides at RUNTIME — no rebuild. A missing row = the
-- module is ON (default-on posture, so a fresh cockpit shows everything).
-- ============================================================================

-- One row per toggleable Hub module. Key is a stable string id (see
-- cockpitSettingsDb.js KNOWN_MODULES); enabled is 1/0 (SQLite has no bool).
CREATE TABLE IF NOT EXISTS module_prefs (
    module_key  TEXT    PRIMARY KEY,                 -- stable id, e.g. 'open_invoices'
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
