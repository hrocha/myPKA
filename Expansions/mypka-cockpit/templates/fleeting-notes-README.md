# Fleeting Notes

This folder is **your** capture space — quick thoughts, ideas, drafts,
work-in-progress documents you expand a little every day. Like sticky notes,
but with depth. It is deliberately **outside** the curated myPKA knowledge
graph:

- **No frontmatter rules.** No templates, no required fields. Write however
  you want.
- **No wikilink discipline.** Links are welcome but nothing audits them.
- **Never indexed.** Fleeting notes are excluded from the SQLite mirror
  (`mypka.db`), graph sweeps, orphan audits, and duplicate detection — by
  design, not by oversight.

The myPKA Cockpit reads and writes these files directly on disk (its Fleeting
Notes editor and whiteboards). You can equally edit them with any text editor.

## The flow: capture → working → ready

Each note carries a status (shown in the cockpit, stored in `_meta.json`,
never in the note itself):

- **capture** — just dropped in.
- **working** — a pinned work-in-progress you keep coming back to.
- **ready** — *the signal*: you are done; the team may now pick this note up,
  organize it, and integrate it into the PKM properly.

## Hard rule — no AI editing

No AI agent may rewrite, edit, restructure, reformat, summarize-in-place,
"clean up", or delete anything in this folder — **except** when a note is
marked **ready**: then an agent may, with the owner's go-ahead, integrate its
content into the PKM (creating proper notes elsewhere) and afterwards archive
or delete the fleeting note **only with explicit approval**.

For non-ready notes, the one carve-out stands: when the owner explicitly asks
an agent to add something, the agent may **append at the very end only**,
clearly demarcated:

```markdown
---
## Appended by [agent name] — YYYY-MM-DD
```

## Housekeeping (cockpit-owned files — leave them alone)

- `_attachments/` — images pasted into the cockpit editor.
- `_meta.json` — pin/status/color state per note.
- `_boards/` — whiteboard layouts (which stickies sit where on each canvas).

These sidecars belong to the cockpit. Agents never edit them; the regen never
indexes them.
