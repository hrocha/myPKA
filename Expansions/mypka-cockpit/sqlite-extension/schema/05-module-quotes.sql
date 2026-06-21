-- ============================================================================
-- 05-module-quotes.sql — the Quotes library (random-quote Hub module)
-- ----------------------------------------------------------------------------
-- A md-first library: one markdown file per quote under PKM/Quotes/, frontmatter
-- carries the structured fields and the body carries the quote text. The regen
-- mirrors every quote note into this `quotes` table; the cockpit's Hub renders a
-- random one. Same doctrine as every other entity table — markdown is canonical,
-- this table is a derived mirror rebuilt on every regen.
--
-- WHY md-first (and not a seed JSON like transactions): a quote IS a note — it
-- has an author, a source, a body, wikilinks to the CRM Person who said it and
-- to the Topics it touches. Transactions are bank rows, not notes, so they seed
-- from JSON; quotes are notes, so they live as markdown and mirror like People
-- or Topics do.
--
-- FRONTMATTER CONVENTION (PKM/Quotes/<slug>.md) — see DATA-CONTRACT.md §8:
--   doc_type: quote          (required — the regen only mirrors doc_type: quote)
--   author:   "Marcus Aurelius"   OR   "[[marcus-aurelius]]" to wire a CRM Person
--   source:   "Meditations, Book V"   (optional — work / talk / page)
--   tags:     [stoicism, discipline]  (optional — JSON-array TEXT in the mirror)
--   year:     180                     (optional — year of the quote/source)
--   The QUOTE TEXT itself is the markdown BODY (everything after the frontmatter).
--   A `quote:` frontmatter field is ALSO accepted as a fallback for one-liners;
--   if both exist, the body wins (it is the canonical place for the text).
--
-- This file is OPTIONAL module backing. The base regen (current build) does not
-- yet emit it; the updated regen shipped alongside this file DOES. install-
-- extensions.py creates the empty table additively under --with-quotes (and
-- --all) so a non-regen / hand-built / non-myPKA db reaches the same end-state.
-- ============================================================================

-- PKM/Quotes/  → one row per quote note. Title surface = a short label (author
-- or the first words); the quote text lives in `quote_text` (= the note body).
--   slug             the note's filename stem (GL-001 kebab-case)
--   quote_text       the quote itself (the markdown body, or the `quote:` field)
--   author           display string OR resolved Person slug (see author_slug)
--   author_slug      kebab slug if `author` was a [[wikilink]] to a CRM Person,
--                    else NULL. Lets the Hub deep-link the attribution.
--   source           work / book / talk / page the quote is from
--   quote_year       year of the quote or its source (INTEGER) or NULL
--   tags             JSON-array TEXT of tag strings (NULL when none)
--   file_path        myPKA-root-relative path (PKM/Quotes/<slug>.md)
--   body             the full markdown body (same as quote_text for most notes;
--                    kept as the standard entity `body` column for the note view)
--   raw_frontmatter  the note's YAML frontmatter as a JSON object string
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  quote_text TEXT,
  author TEXT,
  author_slug TEXT,
  source TEXT,
  quote_year INTEGER,
  tags TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- The Hub's random-quote pick is `ORDER BY RANDOM() LIMIT 1` — no index helps a
-- full-table random pick, and the table is tiny, so no index is warranted here.
-- (Documented deliberately: measure before optimizing. A RANDOM() over a few
-- hundred rows is sub-millisecond; an index on a random sort is unused.)
