-- ============================================================================
-- 03-module-health.sql — backing tables for the OPTIONAL Health + Workouts packs
-- ----------------------------------------------------------------------------
-- IMPORTANT BOUNDARY
--   These tables are NOT produced by regen-mypka-db.py from markdown. They are
--   fed by the USER'S OWN INGEST (an Apple-Health export pipeline, a workout
--   GPX importer). The regen script preserves any table it does not own, so an
--   ingest that writes `health_metric` into mypka.db survives every regen run
--   byte-for-byte.
--
--   This file's job is to CREATE the empty tables (so the Health/Workouts views
--   render an honest empty state instead of erroring on a missing table) and to
--   document the exact column contract the user's ingest must satisfy.
--
--   install-extensions.py creates these ONLY when run with --with-health /
--   --with-workouts. On a base scaffold you do NOT need them: the Health and
--   Workouts packs are not even compiled into the cockpit until the user
--   activates them (see modules/README.md "Activation model").
--
-- ALL HEALTH DATA IS THE USER'S OWN. This schema seeds NOTHING.
-- ============================================================================

-- ── health_metric ────────────────────────────────────────────────────────────
-- The core table EVERY Health-pack panel reads: one row per scalar reading
-- (weight, resting_heart_rate, heart_rate_variability, blood_oxygen_saturation,
-- vo2_max, body_mass_index, step_count, breathing_disturbances, …).
--   metric_name      canonical snake_case metric key (the query layer matches on it)
--   qty              the numeric value
--   units            display unit ('kg', 'bpm', 'ms', '%', …)
--   source           device/app string (matched with LIKE — may carry odd glyphs)
--   local_date       ISO YYYY-MM-DD — the day the reading belongs to (drives every chart)
--   recorded_at_utc  ISO timestamp — tiebreaker for "latest reading"
CREATE TABLE IF NOT EXISTS health_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  units TEXT,
  qty REAL,
  source TEXT NOT NULL DEFAULT '',
  recorded_at_raw TEXT NOT NULL DEFAULT '',
  recorded_at_utc TEXT NOT NULL DEFAULT '',
  local_date TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(metric_name, recorded_at_raw, source)
);
CREATE INDEX IF NOT EXISTS idx_health_metric_name_date
  ON health_metric (metric_name, local_date);

-- ── health_sleep ─────────────────────────────────────────────────────────────
-- One row per sleep session. Powers the 30d sleep trend (total/deep/REM hours).
CREATE TABLE IF NOT EXISTS health_sleep (
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
  UNIQUE(recorded_at_raw, source)
);
CREATE INDEX IF NOT EXISTS idx_health_sleep_date ON health_sleep (local_date);

-- ── health_mood ──────────────────────────────────────────────────────────────
-- OPTIONAL mood-valence sparkline source (sparse by nature). The Health pack's
-- getMindMood() reads it; the panel renders honestly empty when the table has no
-- rows. Created so that read never errors on a missing table.
--   valence        normalized mood polarity (e.g. -1..+1)
--   valence_class  bucket label ('low' | 'neutral' | 'good' …)
--   kind           source kind (e.g. 'state_of_mind')
CREATE TABLE IF NOT EXISTS health_mood (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_date TEXT NOT NULL DEFAULT '',
  valence REAL,
  valence_class TEXT,
  kind TEXT,
  source TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_health_mood_date ON health_mood (local_date);

-- ── health_workout + health_workout_route (Workouts pack) ─────────────────────
-- health_workout: one row per workout. The Workouts catalogue + GPX maps read it.
CREATE TABLE IF NOT EXISTS health_workout (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_uuid TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  start_raw TEXT NOT NULL DEFAULT '',
  end_raw TEXT,
  start_utc TEXT,
  local_date TEXT NOT NULL DEFAULT '',
  duration_sec REAL,
  distance_km REAL,
  active_energy_kcal REAL,
  total_energy_kcal REAL,
  avg_speed_kmh REAL,
  heart_rate_avg REAL,
  heart_rate_max REAL,
  elevation_ascended_m REAL,
  elevation_descended_m REAL,
  raw_json TEXT,
  source TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  location_name TEXT,
  location_admin TEXT,
  location_country TEXT,
  location_geocoded_at TEXT,
  UNIQUE(workout_uuid, source)
);
CREATE INDEX IF NOT EXISTS idx_health_workout_date ON health_workout (local_date);

-- health_workout_route: zero-or-one route per workout (GPX/GeoJSON track summary).
CREATE TABLE IF NOT EXISTS health_workout_route (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES health_workout(id) ON DELETE CASCADE,
  route_file_path TEXT NOT NULL,
  route_format TEXT NOT NULL DEFAULT 'gpx' CHECK (route_format IN ('gpx','geojson')),
  point_count INTEGER,
  bbox_min_lat REAL, bbox_min_lon REAL, bbox_max_lat REAL, bbox_max_lon REAL,
  elevation_min_m REAL, elevation_max_m REAL,
  file_sha256 TEXT,
  file_bytes INTEGER,
  source TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(workout_id)
);
