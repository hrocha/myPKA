# ADAPT-EXPANSION.md — LLM-facing entry point

> **This file is a pointer.** The myPKA Expansion spec
> (`Expansions/docs/expansion-spec.md`) requires every Expansion to carry an
> `ADAPT-EXPANSION.md` at its root as the LLM-facing operating manual. For the
> myPKA Cockpit, that manual is **[`INSTALL.md`](./INSTALL.md)** — the single,
> authoritative install contract. Read it now and follow it top to bottom.

You are an LLM assistant installing the **myPKA Cockpit** into the user's
knowledge base. Do not improvise an install from this file. Open
[`INSTALL.md`](./INSTALL.md) and execute its 8 steps in order.

> **Use your most capable model for the install and any major adapt/upgrade.** It
> is judgment-heavy wiring (data mapping, `[[wikilink]]` connections, SQLite
> upgrade + regen); a frontier model gets it wired correctly where a smaller one
> may not. Full rationale at the top of [`INSTALL.md`](./INSTALL.md).

It encodes the four hard rules you must honor:

1. **Consent before write** — surface [`DISCLAIMER.md`](./DISCLAIMER.md) and stop
   for the user's explicit yes before any read or write (INSTALL.md Step 0).
2. **Backup before write** — confirm a restorable backup exists, or the user
   waives it, before any write (Step 1).
3. **Offer, never auto-apply, the SQLite upgrade** (Step 4).
4. **Never auto-launch** — generate a per-OS launcher and hand it to the user;
   the user starts the cockpit (Step 5). **No launcher ships in this package.**

Supporting docs, all cross-linked from `INSTALL.md`:

- [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) — architecture and invariants. Read
  before modifying anything.
- [`CUSTOMIZE.md`](./CUSTOMIZE.md) — adapt the cockpit to any knowledge base.
- [`sqlite-extension/DATA-CONTRACT.md`](./sqlite-extension/DATA-CONTRACT.md) —
  the data the cockpit reads; required vs. optional.
- [`launcher/GENERATE-LAUNCHER.md`](./launcher/GENERATE-LAUNCHER.md) — per-OS
  launcher generation (text templates only; zero shipped executables).
- [`README.md`](./README.md) — the human-facing overview.
- [`expansion.yaml`](./expansion.yaml) — the manifest (version SSOT).

## Saving a URL into the Outer World (common post-install task)

Once installed, the most common thing an assistant does with the cockpit is save
a link the user shares (an X/Twitter post, an article, a video) into their Outer
World library. **There is a right way and it is non-obvious:** run the shipped
`node scripts/fetch-embed.mjs "<url>"` to extract the content via oEmbed/OG with
**no login and no browser** — never plain-`fetch` a social URL (it `402`s) and
never fall back to opening Chrome. Store the extracted **text + flat `embed_*`
fields only** (never raw embed HTML / `<script>` — the CSP blocks it and the card
errors), then regen the mirror. The full three-step rule is in
[`INSTALL.md`](./INSTALL.md) § *"Saving Outer World content from a URL"*. Read it
before you save the first link.

If you are following `WS-003-install-an-expansion`, this file is the
"connector/runtime wiring" entry point it hands off to; the actual procedure is
in `INSTALL.md`. Because `runtime.start.command` is `null` in `expansion.yaml`,
WS-003 must branch to the launcher-generation flow (Step 5) rather than expecting
a shipped `start.command`.
