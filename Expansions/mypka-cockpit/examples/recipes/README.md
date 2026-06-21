# Worked example: the Recipes library

These `.md` files demonstrate the **`PKM/My Life/Recipes/`** convention the
cockpit's Recipes library reads. In a real install they live at the knowledge-base
root under `PKM/My Life/Recipes/` (one file per recipe). They are shipped here
under `examples/` because the standalone cockpit ships no PKM content of its own —
copy them into `PKM/My Life/Recipes/` (creating the folder) to see the library
populate, or just read them as the canonical shape.

All content here is **synthetic, English, open-source** demonstration material.

Recipes is one of the **two worked instantiations of the library foundation**
(see `../../sqlite-extension/schema/07-library-foundation.sql` and
`DATA-CONTRACT.md §11`). Movies is the other.

## The convention (one file per recipe, md-first)

```
PKM/My Life/Recipes/<slug>.md     # slug = GL-001 kebab-case filename stem
```

Frontmatter (the contract — full detail in `DATA-CONTRACT.md §11`):

```yaml
---
doc_type: recipe                # REQUIRED — the regen mirrors ONLY doc_type: recipe notes
title: Weeknight Miso Noodle Soup
cuisine: japanese               # facet axis (single value)
dish_type: suppe                # facet axis (single value)
difficulty: anfaenger           # facet axis (single value)
status: im-repertoire           # idea / to-try / in-rotation
total_time_min: 20              # integer minutes (optional)
servings: 1                     # integer (optional)
ingredient_count: 6             # integer (optional)
key_ingredients: [ramen-noodles, miso-paste, egg]   # JSON-array TEXT in the mirror
source_url:                     # optional origin link
source_channel: handed down     # optional origin label
tags: [soup, quick, vegetarian] # optional → JSON-array TEXT
---
The recipe steps go here, in the body.
```

### Md-first + wikilinks

- The **recipe body is the steps** — that is the canonical place for them.
- **Link the cuisine / a teacher** with `[[wikilinks]]` in the body
  (e.g. `[[japanese-cooking]]`, or the Person who taught it). Those become normal
  graph edges, so the recipe shows up in that note's backlinks.

The single-value axes (`cuisine`, `dish_type`, `difficulty`, `status`) are stored
as raw **data tokens** — the UI maps them to display labels. A new token (e.g.
`cuisine: thai`) appears in the facet with no code change.
