-- ============================================================================
-- 08-module-outer-world.sql — the Outer World library (mymind-style saved-content)
-- ----------------------------------------------------------------------------
-- The OUTER WORLD is the store for everything the user SAVES from outside their
-- own head: articles, X/social posts, YouTube videos, books, podcasts, reports,
-- and "ideas I just don't want to forget." It is the consume/save counterpart to
-- the Journal's create/reflect (the Inner World). Grounded in the lesson-697
-- "PKM like a Pro" Inner/Outer-World model.
--
-- DESIGN DECISION — a PROPER, FIRST-CLASS concept, not a reused doc_type.
--   This ships as its OWN doc_type (`outer-world`), its OWN folder
--   (PKM/Outer World/YYYY/MM/), and its OWN mirror table (`outer_world`). The
--   old scaffold "News" entity (doc_type: news) is GENERALIZED into this: "news"
--   is no longer a top-level entity, it is just ONE value of `source_type` below.
--   A non-destructive migration (see scripts/migrate-news-to-outer-world.py)
--   carries any legacy PKM/News/ + doc_type: news note into this concept.
--
--   Why its own table (and not the library_registry foundation in 07-*):
--     * the library foundation is for symmetric collections with simple typed
--       AXES (a recipe's cuisine, a film's rating). The Outer World carries THREE
--       distinct structural layers that the library pattern does not model:
--         1. the immutable SOURCE record (source_url / source_type / author …);
--         2. the machine-fetched EMBED card (the flat embed_* OpenGraph fields,
--            the mymind rich-card layer — localized image, favicon, site name);
--         3. the Inner-World ANNOTATION layer the user lays ON TOP of the source
--            (tom_context + the four linked_* bucket lanes + tags).
--       Those layers earn a dedicated, documented table. It still obeys the same
--       doctrine as every other table: md-first, one note per item, typed columns
--       the cockpit reads directly, derived + rebuilt on every regen.
--
-- THE FLAT embed_* CONTRACT (coordinated with Axon's embed spec + Mack's fetcher).
--   The embed metadata is stored as FLAT, top-level frontmatter keys — NOT a
--   nested `embed:` block. Flat keeps the note Obsidian-safe (Properties UI shows
--   each as its own field) and gives each its own sortable/filterable SQLite
--   column. The fetcher (Mack) writes EXACTLY these keys; this schema reads them
--   1:1. embed_image is a LOCAL relative path (the image is localized at capture
--   time — never a hotlinked remote URL — so the card renders offline and there is
--   no third-party image/CSP exposure at render). See DATA-CONTRACT.md §14.
--
-- THE SOURCE STAYS OUTER WORLD; ANNOTATIONS LAYER ON TOP — encoded structurally:
--   source_* + embed_* are the immutable source record (the fetcher / capture
--   writes them; the user does not author them). tom_context + the linked_* fan-out
--   + tags are the Inner-World layer the user adds. Both live in one note; the
--   table keeps them in distinct columns so a query can read either layer alone.
--
-- THE CAPTURING-BEAST LINK FAN-OUT (linked_* — the bucket lanes):
--   linked_topics / linked_key_elements / linked_projects are the three "MY LIFE"
--   bucket lanes the Capturing Beast wires a save into; linked_people /
--   linked_organizations carry CRM relevance. All are JSON-array TEXT of slugs,
--   PROJECTED here as columns so the cockpit can filter the grid by Topic / KE /
--   Project / Person / Org with `json_each(...)` WITHOUT a links-table join. The
--   body wikilinks ALSO become normal `links` graph edges (so the item appears in
--   each bucket's backlinks) — the projection is an additive filter convenience,
--   not a replacement for the graph.
--
-- OPTIONAL module backing. The updated regen shipped alongside this file emits
-- this table from PKM/Outer World/ markdown (the OUTER_WORLD ingestion in
-- regen-mypka-db.py). install-extensions.py creates it EMPTY additively under
-- --with-outer-world (and --all), so a non-regen / hand-built / non-myPKA db
-- reaches the same end-state. See DATA-CONTRACT.md §14.
-- ============================================================================

-- PKM/Outer World/YYYY/MM/<slug>.md  (doc_type: outer-world) → one row per save.
--   ── invariant note columns ──
--   slug              the note's filename stem (GL-001 kebab-case)
--   title             how the user wants to remember it (frontmatter title, else H1,
--                     else slug) — may restate a clickbait/foreign source headline
--   status            optional lifecycle token (inbox / filed / archived) — NULL ok
--   captured_on       TEXT ISO YYYY-MM-DD — when the user SAVED it (filename prefix) [sort]
--   ── immutable SOURCE record (the Outer-World layer) ──
--   source_url        REQUIRED canonical link — no URL, no Outer World entry
--   source_type       article | post | video | book | idea | news  (+ open vocab) [facet]
--                       (free-string-with-recommended-vocab, like recipe `cuisine`)
--   source_author     byline / poster / handle / speaker (NULL ok)            [display]
--   source_published  TEXT ISO — when the SOURCE was published (vs captured_on)  [display]
--   ── EMBED card (the mymind rich-card layer; FLAT embed_* — Axon/Mack contract) ──
--   embed_kind        the embed/card kind: link | article | video | image | rich …  [facet]
--   embed_title       OpenGraph/card title (may differ from `title`)          [display]
--   embed_description OpenGraph/card description / snippet                     [display]
--   embed_image       LOCAL relative image path (localized at capture; NULL → favicon
--                     fallback). Served via the cockpit's jailed media route.   [display]
--   embed_site_name   publisher / site name (e.g. "The Verge", "YouTube")      [display]
--   embed_domain      bare domain (e.g. "theverge.com") — cheap source facet   [facet]
--   embed_favicon     LOCAL relative favicon path (card chrome / image fallback) [display]
--   embed_author      author as the EMBED reported it (vs the user-curated source_author)
--   embed_captured_at TEXT ISO datetime — when the embed metadata was fetched  [staleness]
--   ── Inner-World ANNOTATION layer (laid ON TOP of the source) ──
--   tom_context       the user's short annotation — why they kept it / what it connects to
--   tags              JSON-array TEXT of verbatim tag strings (NULL when none) [facet]
--   ── Capturing-Beast bucket lanes (JSON-array TEXT of slugs; projected for filtering) ──
--   linked_topics         Topic slugs      → PKM/My Life/Topics/*         [filter]
--   linked_key_elements   Key Element slugs → PKM/My Life/Key Elements/*  [filter]
--   linked_projects       Project slugs    → PKM/My Life/Projects/*       [filter]
--   linked_people         Person slugs     → PKM/CRM/People/*             [filter]
--   linked_organizations  Organization slugs → PKM/CRM/Organizations/*    [filter]
--   ── standard note columns ──
--   body              the markdown body (## Summary / ## Clip / ## Context …)
--   file_path         root-relative path (PKM/Outer World/YYYY/MM/<slug>.md)
--   raw_frontmatter   the note's full YAML frontmatter as a JSON object string
CREATE TABLE IF NOT EXISTS outer_world (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT,
  status TEXT,
  captured_on TEXT,
  source_url TEXT,
  source_type TEXT,
  source_author TEXT,
  source_published TEXT,
  embed_kind TEXT,
  embed_title TEXT,
  embed_description TEXT,
  embed_image TEXT,
  embed_site_name TEXT,
  embed_domain TEXT,
  embed_favicon TEXT,
  embed_author TEXT,
  embed_captured_at TEXT,
  tom_context TEXT,
  tags TEXT,
  linked_topics TEXT,
  linked_key_elements TEXT,
  linked_projects TEXT,
  linked_people TEXT,
  linked_organizations TEXT,
  body TEXT,
  file_path TEXT,
  raw_frontmatter TEXT
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- The Outer World grid is reverse-chronological (newest save first) and filtered
-- by source_type. These two are the measured hot paths (the default grid query +
-- the most-used facet); they earn an index. The linked_* / tags filters use
-- json_each() over a SMALL in-memory table (tens to low-hundreds of rows, like the
-- libraries) — a full scan + json_each is sub-millisecond, so NO json index is
-- warranted now (measure before optimizing; add idx only if a real instance grows
-- past a few thousand saves AND the server pushes the json filter into SQL).
CREATE INDEX IF NOT EXISTS idx_outer_world_captured_on ON outer_world (captured_on);
CREATE INDEX IF NOT EXISTS idx_outer_world_source_type ON outer_world (source_type);
