-- ============================================================================
-- 01-core-entities.sql — the CORE entity tables the cockpit needs to BOOT
-- ----------------------------------------------------------------------------
-- These are the MINIMUM VIABLE CONTRACT. The cockpit server refuses to start
-- (with an actionable error) if any of these tables is missing. They must
-- exist even when empty — an empty table renders an honest empty state, a
-- MISSING table is a boot failure.
--
-- Every entity table follows the same shape:
--   id              INTEGER PRIMARY KEY   (one row per markdown note)
--   slug            TEXT                  (the note's filename stem, GL-001 kebab-case)
--   <title col>     TEXT                  (per-table — see each CREATE below)
--   body / content  TEXT                  (the markdown body after the frontmatter)
--   file_path       TEXT                  (myPKA-root-relative path, e.g. PKM/CRM/People/foo.md)
--   raw_frontmatter TEXT                  (the note's YAML frontmatter as a JSON OBJECT STRING)
--
-- raw_frontmatter is load-bearing: the cockpit reads several doctrine fields out
-- of it with json_extract() (e.g. topics.lifecycle, goals.linked_habits). It is
-- NOT optional — store the whole frontmatter object as JSON, even when the
-- typed columns already mirror some of it.
--
-- "Extra columns are fine and ignored" — the cockpit only ever reads the columns
-- documented in DATA-CONTRACT.md. You may carry more; you may not carry fewer.
-- ============================================================================

-- PKM/CRM/People/  → one row per person note. Title = full_name, subtitle = relation.
--   social_links → JSON array of {label,url} clickable chips (DATA-CONTRACT §15),
--   built from the `links:` frontmatter array + recognized flat fields (website,
--   linkedin, github, …). Additive; NULL when a note has none.
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  full_name TEXT,
  relation TEXT,
  social_links TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/CRM/Organizations/  → title = name, subtitle = org_type.
--   social_links → same {label,url} JSON chip array as people (DATA-CONTRACT §15).
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  org_type TEXT,
  social_links TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/My Life/Topics/  → title = name, subtitle = key_element (anchor KE slug).
-- The cockpit ALSO reads json_extract(raw_frontmatter,'$.lifecycle') and
-- '$.promoted_to' for the topic-lifecycle doctrine — keep those in frontmatter.
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  key_element TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/My Life/Projects/  → title = name, subtitle = status.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  status TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/My Life/Goals/  → title = name, subtitle = status.
--   key_element     = anchor Key-Element slug (doctrine column for the graph)
--   linked_projects = JSON-array TEXT of project slugs (doctrine column)
-- The cockpit also reads json_extract(raw_frontmatter,'$.linked_habits').
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  status TEXT,
  key_element TEXT,
  linked_projects TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/My Life/Key Elements/  → title = name, subtitle = description_short.
--   status is read by the cockpit (lifecycle of the life-area).
CREATE TABLE IF NOT EXISTS key_elements (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  description_short TEXT,
  status TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/My Life/Habits/  → title = name, subtitle = cadence.
--   started_on / status are read by the OPTIONAL health pack's planned-habits
--   panel. They are additive: harmless on a base scaffold, required only if you
--   activate the health module and want the habit cards populated. See the
--   note in 03-module-health.sql / install-extensions.py (--with-health).
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  cadence TEXT,
  started_on TEXT,
  status TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- Deliverables/  → title = title. No subtitle.
CREATE TABLE IF NOT EXISTS deliverables (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- PKM/Journal/YYYY/MM/  → title = title, content = content (NOT 'body'),
-- subtitle = category. entry_date drives the DESC sort; mood / mood_valence /
-- energy / entry_type drive the mind/mood surfaces.
--   mood_valence is INTEGER 1..5 (language-neutral mood polarity) or NULL.
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT,
  entry_date TEXT,
  mood TEXT,
  mood_valence INTEGER,
  energy TEXT,
  category TEXT,
  entry_type TEXT,
  content TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- One row per media embed in a journal entry's "## Media" section.
--   journal_id  → FK to journal.id
--   file_path   → relative to PKM/ (e.g. Images/2026/06/foo.png), NOT root-relative
--   media_type  → 'image' | 'screenshot' | 'audio'
CREATE TABLE IF NOT EXISTS journal_media (
  id INTEGER PRIMARY KEY,
  journal_id INTEGER NOT NULL,
  file_path TEXT,
  media_type TEXT,
  mime_type TEXT,
  caption TEXT,
  sort_order INTEGER DEFAULT 0
);

-- The team roster (Team/<Name - Role>/AGENTS.md). Only agent_status='active'
-- rows are shown. name is the "Name - Role" display string (client splits on " - ").
--   contract_body        → the AGENTS.md markdown body (frontmatter stripped),
--                          rendered like a note body in the member-detail view.
--   contract_frontmatter → the AGENTS.md YAML as a JSON object string ('{}' when
--                          the contract has no frontmatter).
--   file_path            → root-relative path to the AGENTS.md.
-- The contract's [[wikilinks]] are extracted into `links` with
-- source_table='agents' (the connections canvas). See DATA-CONTRACT §16.
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT,
  folder TEXT,
  agent_status TEXT DEFAULT 'active',
  bio TEXT,
  avatar_path TEXT,
  owner TEXT,
  contract_body TEXT,
  contract_frontmatter TEXT,
  file_path TEXT
);

-- Per-agent journal feed: one row per Team/<Name>/journal/*.md durable insight
-- (the _template.md stub is skipped). Newest-first per agent (created DESC).
-- title = the entry's H1. agent_slug FKs agents.slug. See DATA-CONTRACT §16.
CREATE TABLE IF NOT EXISTS agent_journal (
  id INTEGER PRIMARY KEY,
  agent_slug TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT,
  topic TEXT,
  created TEXT,
  updated TEXT,
  status TEXT,
  tags TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_journal_agent ON agent_journal (agent_slug, created);

-- The wikilink graph: one row per [[wikilink]] / ![[embed]] occurrence.
--   source_table/source_slug → the note the link is written IN
--   target_slug              → kebab-case last path segment of the link target
--   target_table             → the entity table the slug resolves to, or NULL
--   link_type                → 'wikilink' | 'embed'
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  target_raw TEXT,
  target_slug TEXT,
  target_table TEXT,
  link_type TEXT
);

-- Generator bookkeeping (generated_at, generator). Not queried by the cockpit's
-- feature views, but the regen writes it and detect-gaps reports its freshness.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Indexes the cockpit's hot paths rely on.
CREATE INDEX IF NOT EXISTS idx_links_source ON links (source_table, source_slug);
CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_slug);
CREATE INDEX IF NOT EXISTS idx_journal_media_journal ON journal_media (journal_id);
