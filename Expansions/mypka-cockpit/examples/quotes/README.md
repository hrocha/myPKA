# Worked example: the Quotes library (random-quote Hub module)

These four `.md` files demonstrate the **`PKM/Quotes/`** convention the cockpit's
random-quote Hub module reads. In a real install they live at the knowledge-base
root under `PKM/Quotes/` (one file per quote). They are shipped here under
`examples/` because the standalone cockpit ships no PKM content of its own — copy
them into `PKM/Quotes/` (creating the folder) to see the module populate, or just
read them as the canonical shape.

All content here is **synthetic, English, open-source** demonstration material.

## The convention (one file per quote, md-first)

```
PKM/Quotes/<slug>.md          # slug = GL-001 kebab-case filename stem
```

Frontmatter (the contract — full detail in `sqlite-extension/DATA-CONTRACT.md` §8):

```yaml
---
doc_type: quote                 # REQUIRED — the regen only mirrors doc_type: quote
author: "Marcus Aurelius"       # plain string, OR a [[wikilink]] to a CRM Person
source: "Meditations, Book V"   # optional — book / talk / page
tags: [stoicism, discipline]    # optional — JSON-array TEXT in the mirror
year: 180                       # optional — year of the quote/source (integer)
---
The quote text goes here, in the body. The body IS the quote.
```

### Md-first + wikilinks

- The **quote text is the markdown body** — that is the canonical place for it.
  (A `quote:` frontmatter field is accepted as a fallback for one-liners; if both
  exist, the body wins.)
- **Wire the author to a CRM Person** by making `author` a `[[wikilink]]`
  (e.g. `author: "[[ada-lovelace]]"`). The regen keeps the display label in the
  `author` column AND resolves `author_slug` so the Hub can deep-link the person.
  It also writes an `author → person` edge into the `links` graph.
- **Link topics in the body** with `[[wikilinks]]` (e.g. `[[stoicism]]`). Those
  become normal graph edges, so the quote shows up in the topic's backlinks.

See `the-obstacle-is-the-way.md` for the wikilink'd-author + linked-topic example.
