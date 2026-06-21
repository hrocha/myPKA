# Worked example: the Outer World library

These `.md` files demonstrate the **`PKM/Outer World/YYYY/MM/`** convention the
cockpit's **Outer World** module reads — a mymind-style library of everything you
**save from outside your own head**: articles, social posts, videos, books, and
saved "ideas." In a real install they live at the knowledge-base root under
`PKM/Outer World/<year>/<month>/` (one file per saved item, date-nested like the
Journal and Images). They are shipped here under `examples/` because the standalone
cockpit ships no PKM content of its own — copy them into `PKM/Outer World/2026/06/`
(creating the folders) to see the grid populate, or read them as the canonical shape.

All content here is **synthetic, English, open-source** demonstration material. The
images in `_assets/` are flat-colour placeholders standing in for the localized
embed thumbnails a real capture would fetch.

The Outer World is the **consume/save** counterpart to the Journal's **create/reflect**
(the Inner World) — grounded in the lesson-697 "PKM like a Pro" Inner/Outer-World
model. The old scaffold **News** entity is generalized into this concept: `news` is
now just one value of `source_type`.

## The convention (one file per saved item, md-first, date-nested)

```
PKM/Outer World/YYYY/MM/<slug>.md     # slug = GL-001 kebab-case filename stem
```

Full field detail in `../../sqlite-extension/DATA-CONTRACT.md §14` and
`../../sqlite-extension/schema/08-module-outer-world.sql`. The shape, in brief:

```yaml
---
doc_type: outer-world             # REQUIRED — regen mirrors ONLY doc_type: outer-world notes
title: How rich link cards work   # how YOU want to remember it
captured_on: 2026-06-14           # when you SAVED it (matches dated filename)
# ── immutable SOURCE record ──
source_url: https://…             # REQUIRED — no URL, no Outer World entry
source_type: video                # article | post | video | book | idea | news (open vocab)
source_author: Build & Learn
source_published: 2026-05-28
# ── EMBED card (FLAT embed_* — the mymind rich-card layer) ──
embed_kind: video
embed_title: "…"
embed_description: "…"
embed_image: _assets/<slug>.png   # LOCAL relative path (localized at capture; NULL → favicon fallback)
embed_site_name: Video Example
embed_domain: video.example
embed_favicon: _assets/favicon-video.png
embed_author: Build & Learn
embed_captured_at: 2026-06-14T11:40:00Z
# ── Inner-World ANNOTATION layer (your take, ON TOP of the source) ──
tom_context: why I kept it / what it connects to
tags: [opengraph, embeds, video]
# ── Capturing-Beast bucket lanes (slugs; projected for grid filtering) ──
linked_topics: [rich-embeds]
linked_key_elements: [building-the-system]
linked_projects: [cockpit-outer-world]
linked_people: []
linked_organizations: []
---
## Summary / ## Clip / ## Context  (the body)
```

## The three layers (why this is its own concept, not a library)

1. **SOURCE** (`source_*`) — the immutable record of what the external thing IS.
2. **EMBED card** (the FLAT `embed_*` fields) — the machine-fetched OpenGraph card
   (title, description, **local** image, favicon, site name). The fetcher writes
   these keys; you don't author them. `embed_image` / `embed_favicon` are **local
   relative paths** — the image is localized at capture, so the card renders offline
   and there is no third-party image / CSP exposure at render.
3. **ANNOTATION** (`tom_context` + `tags` + the five `linked_*` lanes) — the
   Inner-World layer you lay on top. The source stays Outer World; your take layers
   on.

## The five examples (one per source_type)

| File | `source_type` | Demonstrates |
|---|---|---|
| `the-two-inbox-capture-model.md` | `article` | full embed card + all three bucket lanes |
| `post-on-filtering-over-collecting.md` | `post` | an X-style social post + `linked_people` |
| `video-rich-link-cards-explained.md` | `video` | a YouTube-style video card |
| `book-building-a-second-brain.md` | `book` | a saved book + multi-Topic links |
| `idea-an-outer-world-inbox-view.md` | `idea` | **no `embed_image`** → favicon/title fallback |

## Md-first + wikilinks

Each item **is a note**: a title, a body (`## Summary` / `## Clip` / `## Context`),
and `[[wikilinks]]`. The body wikilinks become normal `links` graph edges, so the
saved item appears in the backlinks of each Topic / Key Element / Project it touches.
The `linked_*` frontmatter arrays are **additionally** projected into columns so the
cockpit grid can facet by them cheaply. Markdown is canonical; the `outer_world`
mirror table is a derived rebuild on every regen.

## See it render

```
# from the cockpit root, against your scaffold's mypka.db:
python3 sqlite-extension/install-extensions.py /path/to/mypka.db --with-outer-world
#   (or just run the regen, which owns + fills the table from markdown)
python3 scripts/regen-mypka-db.py
python3 sqlite-extension/detect-gaps.py /path/to/mypka.db   # confirms Outer World [ OK ]
```
