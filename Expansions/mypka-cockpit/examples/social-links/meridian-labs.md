---
name: Meridian Labs
org_type: company
industry: software
# Flat `website` is the long-standing convention many notes already use — it is
# recognized and folded into social_links (label "Website"). You can mix it with
# the richer links: array for the rest.
website: https://meridian-labs.example
links:
  - label: Careers
    url: https://meridian-labs.example/careers
  - label: X
    url: https://x.com/meridianlabs_example
  - label: GitHub
    url: https://github.com/meridian-labs-example
city: Berlin
tags:
  - vendor
  - tooling
---

# Meridian Labs

Synthetic example Organization note. Meridian Labs makes the (fictional) tooling
used in the worked examples.

## Why this note exists

To demonstrate that the flat `website` field (already used across existing
Organization notes) and the `links:` array coexist cleanly: both flow into the
single `social_links` column the cockpit renders as clickable chips. No existing
note needs to be rewritten to gain a website chip — `website:` alone is enough.
