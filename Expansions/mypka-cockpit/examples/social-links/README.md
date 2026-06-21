# Worked example: social/website chips on People & Organizations

These `.md` files demonstrate the **social-media + website metadata** convention
the cockpit renders as clickable chips on Person and Organization detail views.

All content here is **synthetic, English, open-source** demonstration material —
the people and organizations are fictional and every URL ends in `.example`.

## The field shape (GL-002)

Two interchangeable, additively-mergeable sources, both folded into one
`social_links` column by the regen:

1. **`links:` — an array of `{label, url}`** (the recommended primary shape).
   Extensible to any platform with no schema change. `url` is kept verbatim; a
   bare host/handle (e.g. `ada-rivera`) is normalized to a full `https://` URL;
   `label` defaults from the platform when omitted.

   ```yaml
   links:
     - label: Website
       url: https://example.org
     - label: LinkedIn
       url: https://www.linkedin.com/in/example
   ```

2. **Flat convenience aliases** — recognized scalar keys, each one URL/handle:
   `website` (and `homepage`/`url`), `twitter`/`x`, `linkedin`, `github`,
   `instagram`, `youtube`, `mastodon`, `bluesky`, `threads`, `facebook`,
   `tiktok`, `substack`. These keep notes that already use `website:` working,
   and let you add a single network without the array syntax.

Both sources merge into a deduped (by URL) JSON array of `{label, url}` objects
in the `people.social_links` / `organizations.social_links` columns. See
`sqlite-extension/DATA-CONTRACT.md` §15 for the column + render contract.

## To see them populate

Copy these notes into your knowledge base and regenerate:

```
cp examples/social-links/ada-rivera.md   "<root>/PKM/CRM/People/"
cp examples/social-links/meridian-labs.md "<root>/PKM/CRM/Organizations/"
python3 Expansions/mypka-cockpit/scripts/regen-mypka-db.py
```

The cockpit's Person / Organization detail then renders a row of clickable chips.
