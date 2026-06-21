---
# ── Outer World entry template ───────────────────────────────────────────────
# A saved piece of EXTERNAL content (the consume/save counterpart to the Journal).
# File location: PKM/Outer World/YYYY/MM/<slug>.md  (slug = GL-001 kebab-case).
# The regen mirrors ONLY notes with doc_type: outer-world.
#
# THREE LAYERS:
#   SOURCE (source_*) — what the external thing IS (immutable).
#   EMBED card (FLAT embed_*) — the machine-fetched OpenGraph card; the fetcher
#     writes these keys (images are LOCAL relative paths, localized at capture).
#   ANNOTATION (tom_context + tags + linked_*) — your Inner-World take, on top.
# See DATA-CONTRACT.md §14.

doc_type: outer-world             # REQUIRED — literal 'outer-world'
title:                            # REQUIRED — how you want to remember it
captured_on:                      # REQUIRED — ISO date you saved it (matches filename)
status: filed                     # optional — inbox | filed | archived

# ── immutable SOURCE record ──
source_url:                       # REQUIRED — the canonical link; no URL, no entry
source_type:                      # REQUIRED — article | post | video | book | idea | news (+ open vocab)
source_author:                    # optional — byline / poster / handle / speaker
source_published:                 # optional — ISO date the SOURCE was published

# ── EMBED card (FLAT embed_* — written by the fetcher; images are LOCAL paths) ──
embed_kind:                       # link | article | video | image | rich
embed_title:                      # OpenGraph/card title
embed_description:                # OpenGraph/card snippet
embed_image:                      # LOCAL relative image path (blank → favicon fallback)
embed_site_name:                  # publisher / site name
embed_domain:                     # bare domain (e.g. theverge.com)
embed_favicon:                    # LOCAL relative favicon path
embed_author:                     # author as the embed reported it
embed_captured_at:                # ISO datetime the embed metadata was fetched

# ── Inner-World ANNOTATION layer (your take, ON TOP of the source) ──
tom_context:                      # why you kept it / what it connects to
tags: []                          # free filter pills

# ── Capturing-Beast bucket lanes (slugs; one save can touch several) ──
linked_topics: []                 # PKM/My Life/Topics/* slugs       — MOST COMMON
linked_key_elements: []           # PKM/My Life/Key Elements/* slugs
linked_projects: []               # PKM/My Life/Projects/* slugs
linked_people: []                 # PKM/CRM/People/* slugs
linked_organizations: []          # PKM/CRM/Organizations/* slugs
---
# <Title>

## Summary
One factual paragraph — what the source actually says. (The immutable layer, in prose.)

## Clip
> The excerpt / pull-quote you actually wanted to keep — verbatim, with attribution.
> — Author, Source, Date

## Context
Your annotation — why you kept it, what it connects to, what you want to do with it.
(The Inner-World layer.)

## Related
[[topic-slug]] · [[project-slug]] — narrative reading of the linked_* fields.
