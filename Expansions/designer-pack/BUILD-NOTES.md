# BUILD-NOTES — Designer Expansion Pack

**Author:** Mack
**Linear:** AUTO-170 (v1.0.0), COU-261 (v1.1.0)
**Status:** v1.1.0 built and committed locally. Awaiting the WS-003 §8 Vex security re-gate before push/tag/release. The v1.1.0 changes — bundling `GL-003` (new content) and widening the scaffold version range — re-trigger the security review.

---

## v1.1.0 — 2026-05-18 (COU-261)

Paired with the base scaffold's 2.0.0 release. The base scaffold removed Iris/Charta/Pixel, the four design SOPs, and `GL-003-design-system` (6-specialist base); this pack revision absorbs `GL-003` and re-pins its compatibility range so it installs on both the new 2.0.0 base and legacy 1.x scaffolds.

**v1.1.0 decisions:**

- **`GL-003-design-system` is now bundled.** This supersedes v1.0.0 decision #8. The base scaffold no longer ships an empty `GL-003` template, so the pack must ship one or its three agents (and four SOPs) carry dangling `[[GL-003-design-system]]` wikilinks on a clean install. The pack ships `GL-003-design-system.md` under `guidelines/`, declared in `expansion.yaml` via `adds_guidelines: [{ slug: GL-003-design-system, file: GL-003-design-system.md }]`. The file is the **empty template** — placeholder values only, no user data. Iris populates it with the user post-install, exactly as before.
- **SOP wikilinks inside `GL-003` are de-numbered.** Consistent with v1.0.0 decision #4: the pack ships SOPs de-numbered so the installer assigns slots. `GL-003`'s body links to `SOP-author-a-design-system` / `SOP-audit-content-for-design-system-compliance` / `SOP-build-an-infographic` / `SOP-generate-a-styled-image` in descriptive form; Nolan rewrites them to the assigned `SOP-NNN-` numbers at install, the same pass that renumbers the SOP files and agent files.
- **`requires_scaffold_version` re-pinned to `">=1.7.0 <3.0.0"`.** v1.0.0's `<2.0.0` upper bound made the pack `incompatible` on a 2.0.0 scaffold (WS-003 §1 would block the install). The new range admits the 2.0.0 six-specialist base AND keeps legacy 1.x scaffolds (≥1.7.0) able to install the pack.
- **Uninstall still does not delete `GL-003`.** v1.0.0 decision #9 holds and is reinforced: even though the pack now ships `GL-003`, uninstall leaves it in place — once Iris populates it, it is the user's brand SSOT, not a recoverable pack artifact. It stays absent from `uninstall.residual_paths`.
- **Stale "seven-agent base" copy fixed.** BUILD-NOTES previously said the base "moves to a seven-agent base + this pack." The settled count is six. Corrected to "six-agent base."
- **version → 1.1.0, manifest hash changes.** Bundling a guideline + the range re-pin are content/contract changes, a MINOR bump. The `expansion.yaml` sha256 changes; it is re-pinned in `Expansions/.trusted-sources` by Silas **after** Vex's §8 re-audit, never before.

**v1.1.0 files added:** `guidelines/GL-003-design-system.md`. Total pack files: 16.

---

## v1.0.0 — 2026-05-17 (AUTO-170)

## What this pack is

An `agent_pack` Expansion that extracts the three creative specialists — Iris, Charta, Pixel — out of the base myPKA scaffold roster and into an optional pack. Same model as the App Developer Pack (Felix/Vex/Vera). Silas and Mack stay in the base scaffold; the design trio becomes opt-in.

## Decisions made

**1. Template = App Developer Pack, not Slack Pack.** The App Developer Pack is the proven `agent_pack` reference. The Slack Pack is a `runtime` and ships `runtime/`, `scripts/`, `.env.example`, `INSTALL.md`. An `agent_pack` ships none of those — no code, no env vars, no installers. This pack's file tree mirrors the App Developer Pack's `agent_pack` shape exactly: `expansion.yaml`, `README.md`, `ADAPT-EXPANSION.md`, `BUILD-NOTES.md`, `LICENSE`, `agents/`, `sops/`.

**2. No INSTALL.md, no .env.example, no .gitignore, no scripts/.** The App Developer Pack's own BUILD-NOTES states it explicitly: "no INSTALL.md needed — agent_pack has no runtime setup." There is no external setup (no OAuth app to create, no tokens to generate), so an INSTALL.md would be empty ceremony. No `.env*` because there are zero env vars. No `scripts/` because there is nothing to install or launch. WS-003 + Nolan do the merge. Following the proven template, not inventing structure.

**3. LICENSE included.** The App Developer Pack folder did not ship a standalone `LICENSE` file (its `expansion.yaml` declares `license: proprietary`). The brief named `LICENSE` explicitly, and the Slack Pack — also a tier-2 myICOR Expansion — ships one. A standalone `LICENSE` is the right call for any pack heading to the AI Library: it states the myICOR AI Library Software License terms and the GDPR data-controller position in the user's hands. Adapted the Slack Pack's license text to an `agent_pack` (removed the runtime/listener language; kept the no-credentials and data-controller clauses, scoped to creative deliverables and any future Mack-wired image-gen service).

**4. Byte-faithful agent files, with one packaging-only transform.** Per extraction best practice (verified via Perplexity): the first extracted version is byte-faithful to the bundled originals. The three `AGENTS.md` files are copied verbatim from `Team/<name>/AGENTS.md` in the base scaffold, with exactly one mechanical transform: the numbered design-SOP wikilinks (`SOP-007`/`SOP-008`/`SOP-009`/`SOP-010`) were de-numbered to descriptive form (`SOP-build-an-infographic`, etc.). This matches the App Developer Pack convention — packs ship SOPs un-numbered and the installer (Nolan) assigns the next free `SOP-NNN-` slot, then rewrites the cross-references. `SOP-001` (add-a-new-specialist) is a base-scaffold SOP and keeps its number. No persona text, routing, philosophy, or critical-rule changed.

**5. Four SOPs, copied from the canonical scaffold SOPs.** `SOP-007/008/009/010` from `Team Knowledge/SOPs/` were copied into `sops/` and de-numbered (filename + H1 title + body cross-references). The H1 titles went from `# SOP-007 - Build an Infographic` to `# SOP: Build an Infographic`, matching the App Developer Pack's SOP title style. SOP body content is otherwise byte-faithful. Iris owns two SOPs (author + audit); Charta and Pixel own one each. That mirrors how the base scaffold assigns them today.

**6. journal/_template.md carried with each agent.** The base scaffold ships each of Iris/Charta/Pixel with a `journal/` folder containing a `_template.md`. The App Developer Pack agents also carry per-agent `journal/` templates (per its v1.0.2 re-pin notes). The pack copies each agent's `journal/_template.md` so the per-agent journal discipline survives the extraction. Nolan copies the whole agent folder, journal template included.

**7. requires_agents: [Larry, Nolan, Mack].** Larry + Nolan run WS-003. Mack is listed because Pixel's `SOP-generate-a-styled-image` has a connection-half handoff to Mack when the user's LLM cannot generate images natively — Mack must be present in the team for that path to work. Mack is NOT invoked during the install of this pack itself (no connector wiring in the pack). This matches the App Developer Pack manifest, which also lists `[Larry, Nolan, Mack]`.

**8. GL-003-design-system is NOT shipped.** All three agents reference `GL-003-design-system.md` as the brand SSOT, but the pack does not bundle it. In the base scaffold `GL-003` is authored by Iris during her guided session — it is the user's content, not a pack artifact. `adds_guidelines: []`. The pack's README and ADAPT-EXPANSION both make this explicit. If a future base scaffold stops shipping an empty `GL-003` template in its Guidelines set, a pack revision could add one via `adds_guidelines` — flagged for v1.1+.

**9. Uninstall does not delete GL-003.** `uninstall.residual_paths` lists the three agent folders and the four SOPs (glob-matched on the renumbered slots), and nothing else. `GL-003-design-system.md`, if Iris populated one during use, is the user's own Guideline and is intentionally left in place. ADAPT-EXPANSION §Uninstall states this explicitly.

**10. version 1.0.0.** First release of the pack as its own artifact. Independent SemVer, declared `requires_scaffold_version: ">=1.7.0 <2.0.0"`. v1.0.0 corresponds byte-for-byte (modulo the packaging-only SOP de-numbering) to the Iris/Charta/Pixel that ship in the base scaffold at the time of this build.

## Flagged for review

- **Scaffold + course impact is DEFERRED (not done in this build).** This pack is built so it *could* replace the base-scaffold-bundled Iris/Charta/Pixel. Per the AUTO-170 brief, removing those three from the base scaffold roster and updating the myPKA course is explicitly deferred — Tom is not doing that yet. Until it lands, a user on a base scaffold that still bundles the trio who also installs this pack will hit a duplicate-agent situation; Nolan's `conflict_policy` skip-with-notify path handles that cleanly (existing agent stays, conflict reported to Larry). When the deferred work is picked up, the base scaffold's `Team/` folders for Iris/Charta/Pixel and SOP-007..010 + their INDEX rows and agent-index rows come out, and the myPKA course copy that introduces the nine-agent roster moves to a six-agent base + this pack. That is a separate Linear issue.
- **SOP renumbering is the installer's job.** The pack ships SOPs de-numbered. Nolan assigns `SOP-NNN-` slots at install and rewrites the cross-references in the four SOP files and three AGENTS.md files. If WS-003's renumbering step does not also patch in-file `[[SOP-...]]` wikilinks, the installed pack will have dangling links — ADAPT-EXPANSION §Step 3 calls this out as a Nolan responsibility.
- **Manifest hash not yet pinned.** SHA256 of `expansion.yaml` for v1.1.0 is `86ce16a0804e3c542ad719e61eac862b8770a5652a96d54050821d284d13ea48` (the v1.0.0 hash was `c3203bcfcfe3bab6af1038f3c39d9566b350db79ecccb2c908e744ac3439d006` — it changed because the manifest now declares `version: 1.1.0`, `requires_scaffold_version: ">=1.7.0 <3.0.0"`, and `adds_guidelines`). This is informational only — the hash is pinned in `Expansions/.trusted-sources` AFTER Vex's §8 security re-audit, by Silas, never before. If Vex's review requires any `expansion.yaml` edit, this hash changes and must be recomputed.
- **Cover image handled separately.** Per the brief, the AI Library cover image for this pack is an Iris + Pixel deliverable. Not generated here, not bundled in the pack.

## Files shipped (all under `Expansions/designer-pack/`)

- `expansion.yaml`
- `README.md`
- `ADAPT-EXPANSION.md`
- `BUILD-NOTES.md` (this file)
- `LICENSE`
- `agents/Iris - Design System Architect/AGENTS.md`
- `agents/Iris - Design System Architect/journal/_template.md`
- `agents/Charta - Infographic Designer/AGENTS.md`
- `agents/Charta - Infographic Designer/journal/_template.md`
- `agents/Pixel - Visual Specialist/AGENTS.md`
- `agents/Pixel - Visual Specialist/journal/_template.md`
- `sops/SOP-author-a-design-system.md`
- `sops/SOP-audit-content-for-design-system-compliance.md`
- `sops/SOP-build-an-infographic.md`
- `sops/SOP-generate-a-styled-image.md`
- `guidelines/GL-003-design-system.md` *(added v1.1.0)*

Total: 16 files (15 at v1.0.0 + `guidelines/GL-003-design-system.md` at v1.1.0). Trinity complete: `README.md` + `ADAPT-EXPANSION.md` (no INSTALL.md — `agent_pack` has no runtime or external setup).

## Status

v1.1.0 built. Committed locally. **Not pushed, not tagged, not released.** Awaiting the WS-003 §8 Vex security re-gate (Larry routes it) — the v1.1.0 changes add new content (`GL-003`) and widen the version range, so the pack goes back through the security review. After Vex returns GREEN: the paired release runs (scaffold 2.0.0 + pack v1.1.0 tag), then Silas pins the new `expansion.yaml` hash in `Expansions/.trusted-sources`, then the AUTO-28 snapshot sync.
