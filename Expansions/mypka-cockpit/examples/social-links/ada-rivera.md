---
full_name: Ada Rivera
first_name: Ada
last_name: Rivera
relation: collaborator
role: Independent researcher, knowledge-management writer
city: Lisbon
# ── Primary, extensible shape (GL-002): links is an array of {label, url}. ──
# The cockpit renders each entry as a clickable chip. Use any label/platform —
# no schema change needed to add a new network.
links:
  - label: Website
    url: https://ada-rivera.example
  - label: Newsletter
    url: https://ada-rivera.example/notes
# ── Flat convenience aliases also recognized (folded into social_links). ──
# A bare HOST (e.g. ada-rivera.example) is normalized to a full https URL; give a
# full URL for platform profiles (handles aren't auto-expanded into a host).
linkedin: https://www.linkedin.com/in/ada-rivera-example
github: https://github.com/ada-rivera-example
mastodon: https://mastodon.example/@ada
tags:
  - collaborator
  - pkm
---

# Ada Rivera

Synthetic example Person note demonstrating the **social/website chips** the
cockpit renders. Ada writes about filtering-over-collecting and the two-inbox
capture model — a natural cross-link to the Outer World examples.

## Why this note exists

To show the `links:` array (the recommended GL-002 shape) living alongside the
flat convenience fields (`linkedin`, `github`, `mastodon`). The regen merges both
into one `social_links` JSON column of `{label, url}` objects, deduped by URL, so
the cockpit member/contact view can render clickable chips without parsing
frontmatter at request time.
