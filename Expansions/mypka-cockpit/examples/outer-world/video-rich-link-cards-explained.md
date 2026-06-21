---
doc_type: outer-world
title: How rich link cards work (video)
captured_on: 2026-06-14
status: filed
source_url: https://video.example/watch?v=abc123def
source_type: video                      # a YouTube-style video
source_author: Build & Learn
source_published: 2026-05-28
embed_kind: video
embed_title: "How Rich Link Cards Work — OpenGraph in 8 Minutes"
embed_description: "A walkthrough of how saved-content apps fetch a title, description, and thumbnail from any URL."
embed_image: _assets/video-rich-link-cards-explained.png
embed_site_name: Video Example
embed_domain: video.example
embed_favicon: _assets/favicon-video.png
embed_author: Build & Learn
embed_captured_at: 2026-06-14T11:40:00Z
tom_context: Reference for the embed-fetch spec — the OG-card mechanics the cockpit cards reuse.
tags:
  - opengraph
  - embeds
  - video
linked_topics:
  - rich-embeds
linked_projects:
  - cockpit-outer-world
---
# How rich link cards work (video)

## Summary
An 8-minute walkthrough of fetching OpenGraph metadata — title, description, image
— from a URL, and the fallbacks when a site provides none.

## Clip
> If there's no `og:image`, fall back to the favicon and the title. Never show a
> broken image — show less, honestly.
> — Build & Learn, ~04:30

## Context
Directly informs how the Outer World card degrades when `embed_image` is NULL.
Feeds [[rich-embeds]] and [[cockpit-outer-world]].
