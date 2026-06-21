-- ============================================================================
-- 07-library-foundation.sql — the LIBRARY FOUNDATION (a reusable collection pattern)
-- ----------------------------------------------------------------------------
-- A "library" is a curated COLLECTION the user keeps: recipes, films, books,
-- board games, wines, gear, restaurants — anything you keep many of and want to
-- browse, filter, and open. This file is the GENERALIZED FOUNDATION for that
-- pattern, shipped with TWO worked instantiations (recipes + movies) so a
-- downstream LLM can clone the shape for whatever the user already collects.
--
-- DESIGN DECISION — per-library TYPED tables, NOT one polymorphic table.
--   The whole cockpit is built on "one folder → one mirror table → typed columns
--   the cockpit reads directly" (see quotes, people, documents). A library obeys
--   the SAME doctrine: one PKM folder per library, one mirror table per library,
--   typed columns chosen to be that library's filterable AXES. We deliberately do
--   NOT use a single `library_items(kind, data JSON)` blob:
--     * the cockpit's contract is "fewer columns break the query" — typed columns
--       are what the views read, what the facet dropdowns enumerate, what SQLite
--       sorts/filters on cheaply. A JSON blob forces json_extract() on every
--       field and kills column-level facets.
--     * each library has DIFFERENT axes (a recipe has cuisine + cook-time; a film
--       has rating + release-year). One wide blob table would be mostly-NULL and
--       lie about its shape.
--   So the FOUNDATION is a *pattern + a registry*, not a god-table. Adding a
--   library = pick a folder + a doc_type + the axis columns, register it in the
--   regen's LIBRARIES config block, and the mirror table appears. Recipes and
--   movies below ARE that pattern, twice.
--
-- THE INVARIANT COLUMNS every library mirror table carries (the library contract):
--   id               INTEGER PRIMARY KEY
--   slug             TEXT     the note filename stem (GL-001 kebab-case)
--   title            TEXT     the card title (frontmatter `title`, else H1, else slug)
--   status           TEXT     a per-library lifecycle token (idea/to-try/in-rotation;
--                             watchlist/watching/finished/abandoned) — NULL allowed
--   tags             TEXT     JSON-array TEXT of verbatim tag strings (NULL when none)
--   body             TEXT     the markdown body after the frontmatter
--   file_path        TEXT     root-relative path (PKM/<Library>/<slug>.md)
--   raw_frontmatter  TEXT     the note's full YAML frontmatter as a JSON object string
-- Plus the library's OWN axis columns (the filterable facets + display fields).
--
-- WHY md-first: a library item IS a note — it has a title, a body (the recipe
-- steps / the verdict), and wikilinks (a recipe → its cuisine Topic or the Person
-- who taught it; a movie → its director Person or genre Topic). So it lives as
-- markdown and mirrors like People/Topics do. Markdown is canonical; these tables
-- are derived mirrors rebuilt on every regen.
--
-- OPTIONAL module backing. The updated regen shipped alongside this file emits
-- both tables from PKM/<Library>/ markdown. install-extensions.py creates them
-- EMPTY additively under --with-libraries (and --all), so a non-regen / hand-built
-- / non-myPKA db reaches the same end-state. See DATA-CONTRACT.md §11.
-- ============================================================================

-- ── recipes ────────────────────────────────────────────────────────────────
-- PKM/My Life/Recipes/  (doc_type: recipe). Axes chosen from the established
-- recipe-collection convention (GL-002 Recipes vocab; mirrors Mei's recipe notes):
--   cuisine          single-value axis (korean / japanese / italian / …)  [facet]
--   dish_type        single-value axis (suppe / hauptgericht / dessert / …) [facet]
--   difficulty       single-value axis (anfaenger / mittel / fortgeschritten) [facet]
--   status           idea / to-try / in-rotation (idee / zu-testen / im-repertoire) [facet]
--   total_time_min   INTEGER minutes start-to-plate (NULL = unknown)        [display]
--   servings         INTEGER (NULL = unknown)                               [display]
--   ingredient_count INTEGER (NULL = unknown)                               [display]
--   key_ingredients  JSON-array TEXT of ingredient slugs/strings            [search]
--   source_url       TEXT origin link (NULL when none)                      [display]
--   source_channel   TEXT origin label, e.g. a channel / person / book      [display]
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT,
  cuisine TEXT,
  dish_type TEXT,
  difficulty TEXT,
  status TEXT,
  total_time_min INTEGER,
  servings INTEGER,
  ingredient_count INTEGER,
  key_ingredients TEXT,
  source_url TEXT,
  source_channel TEXT,
  tags TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- ── movies (films & series) ──────────────────────────────────────────────────
-- PKM/My Life/Movies/  (doc_type: movie). Axes chosen from the established
-- films-&-series convention (mirrors the private-instance Media notes):
--   media_type       'film' | 'serie'                                       [facet]
--   status           watchlist / watching / finished / abandoned            [facet]
--   rating           INTEGER 1..5 (NULL = unrated — render "—", never 0)     [facet+display]
--   release_year     INTEGER (NULL = unknown)                               [display]
--   genre            single-value axis (drama / scifi / comedy / …)         [facet]
--   director_creator TEXT director (film) or creator (serie)                [display+search]
--   platform         TEXT where watched (NULL common + meaningful: unknown) [display]
--   date_watched     TEXT ISO YYYY-MM-DD (NULL = never watched / watchlist) [sort]
--   progress         TEXT free-text progress note (e.g. "abandoned at ~50%") [display]
--   total_seasons    INTEGER (series only; NULL on films)                   [display]
--   episodes_watched INTEGER (series only; NULL on films)                   [display]
--   verdict          TEXT the user's verbatim take (line breaks preserved)  [display+search]
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT,
  media_type TEXT,
  status TEXT,
  rating INTEGER,
  release_year INTEGER,
  genre TEXT,
  director_creator TEXT,
  platform TEXT,
  date_watched TEXT,
  progress TEXT,
  total_seasons INTEGER,
  episodes_watched INTEGER,
  verdict TEXT,
  tags TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- ── library_registry — enumerate the active libraries for the cockpit ─────────
-- The cockpit's Library nav group is data-driven: it asks this tiny table "what
-- libraries exist, and how do I render each one?" instead of hard-coding recipes
-- + movies. The regen writes one row per library it mirrored (from its LIBRARIES
-- config block); install-extensions.py seeds the same rows for the two built-ins.
-- This is what makes the foundation ADAPTABLE — a user's own library (books,
-- wines, …) shows up in the nav the moment its row lands here, no UI code change
-- for the listing/enumeration layer.
--   library_slug   stable id (recipes / movies / books / …) = the mirror table name
--   nav_label      human label for the sidebar ("Recipes", "Films & Series")
--   nav_icon       a lucide icon name the client maps (e.g. "ChefHat", "Clapperboard")
--   pkm_folder     root-relative source folder (PKM/My Life/Recipes)
--   doc_type       the frontmatter discriminator the regen filters on (recipe / movie)
--   title_field    frontmatter field used as the card title (default 'title')
--   sort_order     INTEGER nav ordering (ascending); ties break alpha by nav_label
CREATE TABLE IF NOT EXISTS library_registry (
  id INTEGER PRIMARY KEY,
  library_slug TEXT NOT NULL,
  nav_label TEXT,
  nav_icon TEXT,
  pkm_folder TEXT,
  doc_type TEXT,
  title_field TEXT DEFAULT 'title',
  sort_order INTEGER DEFAULT 0
);

-- Browse/filter are client-side over the full (small) library; the cockpit reads
-- whole tables and facets in memory. Libraries are curated collections (tens to a
-- few hundred rows), so no per-axis index is warranted — a full scan + ORDER BY
-- title is sub-millisecond. (Documented deliberately: measure before optimizing.
-- If a library ever grows past a few thousand rows AND the server moves filtering
-- into SQL, add idx_<library>_status / idx_<library>_<facet> THEN, not now.)
