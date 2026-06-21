# docs/journal-integration.md — manual journal entry → integration flow

The cockpit lets you jot a quick journal entry by hand. A note you typed fast
isn't yet woven into your knowledge base — it has no `[[wikilinks]]`, no tidy
frontmatter, no connections to the people / projects / topics it touches. This
doc explains how that raw note becomes a properly integrated entry, the
guarantee that your original words always survive, and how to adapt the flow to
your own knowledge base.

It is a **teaching example.** The cockpit ships the integration prompt as a
text template; you (or your LLM) can read and adapt it to your own conventions.

---

## The flow in one picture

```
   You type a quick note            Penn / your LLM                 The cockpit
   in the cockpit                   integrates it                   reflects it
  ┌──────────────────┐   button   ┌───────────────────┐   regen   ┌──────────────┐
  │ manually_added:  │ ─────────► │ preserve original │ ────────► │  mypka.db    │
  │   true           │  launches  │ add [[wikilinks]]  │  mirror   │  refreshed   │
  │ integration_     │  LLM at    │ clean the prose    │           │  "unfold     │
  │   status: raw    │  root with │ flip status →     │           │   original"  │
  │ body = your text │  a prompt  │   integrated       │           │   available  │
  └──────────────────┘            └───────────────────┘           └──────────────┘
```

1. **You add a raw entry.** The cockpit's manual-add flow writes the markdown
   with `manually_added: true`, `integration_status: raw`, and your text as the
   body. No `original_body` yet — at this stage the body *is* the original.

2. **You press the integrate button.** A raw entry shows a button that launches
   your LLM (Claude by default) in a terminal, at your scaffold root, with a
   prefilled prompt. The prompt is built from
   [`launcher/templates/integrate-journal-entry.prompt.txt`](../launcher/templates/integrate-journal-entry.prompt.txt),
   with the entry's path and your root substituted in.

3. **The LLM integrates it.** Following the prompt, it preserves your original,
   wires the entry into the graph with `[[wikilinks]]`, cleans the prose, and
   flips `integration_status` to `integrated`.

4. **The mirror refreshes.** The LLM regenerates `mypka.db` so the cockpit shows
   the integrated entry — and, because the original is preserved, an **"unfold
   original"** affordance.

---

## The original-preservation guarantee

This is the part that must never break, so it's worth stating plainly:
**your original words are copied into the frontmatter `original_body` field,
verbatim, BEFORE anything is rewritten.**

The prompt makes this the first, non-negotiable step. The contract is:

| Frontmatter field | Meaning |
|---|---|
| `original_body` | Your verbatim original text, as a YAML block scalar. Set **once**, at integration. Never overwritten on a re-run. |
| `integration_status` | `raw` (you typed it, not yet integrated) or `integrated` (rewritten; `original_body` set). NULL is treated as `raw`. |
| `manually_added` | `true` — the entry came from the cockpit's manual-add flow. |

```yaml
---
title: A quick note
date: 2026-06-18
manually_added: true
integration_status: integrated
original_body: |
  the user's original words, exactly as typed
---
The integrated / rewritten body lives here.
```

Two safety properties fall out of this:

- **The cockpit's "unfold original" works** because `original_body` holds the
  pre-rewrite text. The cockpit shows the affordance when
  `integration_status = 'integrated'` AND `original_body IS NOT NULL`.
- **Re-running integration is safe.** If `original_body` is already present, the
  prompt instructs the LLM to leave it untouched — so your true original is
  pinned from the first integration onward, no matter how many times the entry
  is later re-touched.

The LLM is also told to add only — never delete your source text — and to
confirm with you before any substantial rewrite. Small touch-ups it just does;
big restructures it shows you first.

(The schema columns `original_body` / `integration_status` / `manually_added`
are defined in [`sqlite-extension/DATA-CONTRACT.md`](../sqlite-extension/DATA-CONTRACT.md)
§10, mirrored from the journal frontmatter by the regen.)

---

## What "integrate" actually does

Beyond preserving the original, the LLM:

- **Links the entry into the graph.** It finds every person, organization,
  project, topic, key element, goal, habit, or document the note mentions and
  adds a `[[wikilink]]` in the body — searching for an existing note **first**
  so it never creates a duplicate, and creating a minimal stub from a template
  only when the entity genuinely doesn't exist yet.
- **Fills in structured frontmatter** that has a clear home in the schema (date,
  category, mood, the `linked_*` arrays, key element, tags) — structured data in
  frontmatter, narrative in the body, no invented fields.
- **Cleans the prose** for clarity and structure, in your voice, **without
  inventing facts** — the preserved `original_body` is the safety net, not a
  license to embellish.
- **Flips `integration_status` to `integrated`** and refreshes `mypka.db`.

---

## Adapting this to your own knowledge base

The cockpit is a templated example, not a fixed product (see
[`CUSTOMIZE.md`](../CUSTOMIZE.md)). The integration prompt is meant to be edited.

- **If you run the myPKA team**, the prompt already routes the work to **Penn**,
  the Journal Writer & graph curator, who follows the team's own capture and
  curation contracts. You don't have to change anything.
- **If you don't have a Penn-style specialist**, the prompt tells your LLM to act
  as the PKM-curation assistant and do the steps itself. It still works.
- **If your conventions differ** (different folder layout, different frontmatter
  field names, no `[[wikilinks]]`), edit
  [`launcher/templates/integrate-journal-entry.prompt.txt`](../launcher/templates/integrate-journal-entry.prompt.txt):
  - Point the "read the conventions first" line at *your* schema/naming docs.
  - Tell it which entity types and folders you use, and what your cross-reference
    syntax is (wikilinks, hrefs, relation fields).
  - **Keep the three things that are load-bearing for the cockpit:** preserve the
    original into `original_body` *before* rewriting; set
    `integration_status: integrated` when done; regenerate the mirror. Those map
    directly to the SQL contract the cockpit reads — change the field *mapping*
    in your `scripts/regen-mypka-db.py` adaptation if you rename them, but don't
    drop the concepts.

### Placeholders the cockpit substitutes

The prompt template uses two placeholders; the cockpit fills them in before
launching the LLM:

| Placeholder | Substituted with |
|---|---|
| `{{ENTRY_PATH}}` | Absolute path to the raw journal markdown file to integrate. |
| `{{ROOT}}` | Absolute path to the scaffold root the LLM is launched in (where the team contracts and `PKM/` live). |

The cockpit launches the LLM **at the root** (so it boots with the full team /
project context) with the substituted prompt as its first message — the same
launch mechanism the "Discuss with AI" button uses. The regen path the prompt
names (`Expansions/mypka-cockpit/scripts/regen-mypka-db.py`) is the standard
layout; adjust it in the template if your cockpit lives elsewhere.

---

## Related

- [`launcher/templates/integrate-journal-entry.prompt.txt`](../launcher/templates/integrate-journal-entry.prompt.txt) — the prefilled prompt itself.
- [`sqlite-extension/DATA-CONTRACT.md`](../sqlite-extension/DATA-CONTRACT.md) §10 — the journal original-text + integration-status columns.
- [`CUSTOMIZE.md`](../CUSTOMIZE.md) — adapting the cockpit (and this flow) to any knowledge base.
- [`INSTALL.md`](../INSTALL.md) — installing the cockpit and generating the launcher.
