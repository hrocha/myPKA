# Worked example: the Films & Series library (movies)

These `.md` files demonstrate the **`PKM/My Life/Movies/`** convention the
cockpit's Films & Series library reads. In a real install they live at the
knowledge-base root under `PKM/My Life/Movies/` (one file per title). They are
shipped here under `examples/` because the standalone cockpit ships no PKM content
of its own — copy them into `PKM/My Life/Movies/` (creating the folder) to see the
library populate, or just read them as the canonical shape.

All content here is **synthetic, English, open-source** demonstration material.

Movies is one of the **two worked instantiations of the library foundation**
(see `../../sqlite-extension/schema/07-library-foundation.sql` and
`DATA-CONTRACT.md §11`). Recipes is the other.

## The convention (one file per title, md-first)

```
PKM/My Life/Movies/<slug>.md      # slug = GL-001 kebab-case filename stem
```

Frontmatter (the contract — full detail in `DATA-CONTRACT.md §11`):

```yaml
---
doc_type: movie                 # REQUIRED — the regen mirrors ONLY doc_type: movie notes
title: The Quiet Archive
media_type: film                # 'film' | 'serie'  (facet)
status: finished                # watchlist / watching / finished / abandoned (facet)
rating: 5                       # 1-5 integer; OMIT for unrated (NULL renders "—", never 0)
release_year: 2024
genre: drama                    # facet axis
director_creator: "[[ada-fontaine]]"   # director (film) / creator (serie); plain OR [[wikilink]]
platform: cinema                # where watched (omit when unknown → honest NULL)
date_watched: 2026-05-30        # ISO; omit for watchlist (NULL = never watched)
total_seasons: 1                # series only (omit on films)
episodes_watched: 5             # series only (omit on films)
verdict: |                      # your verbatim take; line breaks preserved
  A slow, deliberate film...
tags: [drama, slow-cinema]      # optional → JSON-array TEXT
---
The body holds your notes — what it's about, where you saw it.
```

### Md-first + wikilinks + honest NULLs

- **NULLs are honest signals, never errors.** Omit `rating` for unrated (the UI
  renders `—`, not 0 stars). Omit `platform` when unknown (renders blank). Films
  leave `total_seasons` / `episodes_watched` NULL.
- **Link a director / genre** with `[[wikilinks]]` — either in the
  `director_creator` field (e.g. `"[[ada-fontaine]]"`, which the cockpit can
  deep-link to a CRM Person) or in the body (`[[slow-cinema]]`). Both become graph
  edges and surface in backlinks.
- **`verdict` is verbatim** — never translated or truncated; line breaks survive.
