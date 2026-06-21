# BUILD-NOTES — App Developer Pack v1.0.0

**Author:** Nolan
**Date:** 2026-05-09
**Status:** Draft for the maintainer's review; manifest schema awaits Mack's v1.7 lock

## Decisions made

**1. Style match: Mack/Silas v1.5 lean.** Used those two files as the AGENTS.md template — second-person voice, no `agent_version` frontmatter, no Library Card block, no MCP-First Mandate, no in-monorepo paths. Lifted capability rigor from the Larry-repo Felix/Vex/Vera files but stripped every myICOR specific (Supabase, React 19, Tailwind v4, OKLCH, Phosphor, Vercel, etc.). Substituted "your stack" / "your design system" / "your platform" throughout.

**2. SOP filenames without numeric prefixes.** Per the brief — install workstream auto-numbers them. Filenames are `SOP-felix-build-a-component.md`, `SOP-vex-security-audit.md`, `SOP-vera-quality-gate.md`. Each SOP header carries the "Default owner: <agent>; any agent can invoke" line per the locked taxonomy.

**3. One signature SOP per agent.** Held the line. Genuine candidates I considered and rejected:
   - *Felix*: "performance audit" and "accessibility hardening" — both are workstreams that will emerge from `SOP-felix-build-a-component` use, not day-1 skills.
   - *Vex*: "GDPR erasure pipeline implementation" and "incident response runbook" — both workstreams, not skills. The audit SOP already covers GDPR posture as Phase 4.
   - *Vera*: "video QA gate" and "motion preset audit" — Larry-repo only, not generalizable to a v1.7 end-user pack.

**4. No workstreams, no guidelines, no env vars.** Per the brief. The pack is intentionally lean.

**5. GL-003-design-system as a soft reference.** Felix and Vera both reference `GL-003-design-system.md` as the design-system SSOT, but neither requires it to exist. Vera's gate explicitly handles the "design system not documented" case by making it the first finding (forces the user to create one as a prerequisite to objective QA). This means the pack works even for users who don't yet have a design system — Vera will help them realize they need one.

**6. Vera's verdict ladder is stricter than Felix's accept ladder.** Vera fails on any CRITICAL or 3+ HIGH; conditional-passes only with explicit user acceptance. Felix's "definition of done" requires Vera's pass. The handoff is enforceable.

**7. Vex's severity ladder is conservative.** I deliberately defined CRITICAL narrowly (exploitable now, exposes user data, ship-blocker) to prevent severity inflation, which is the #1 way security gates lose team trust over time.

**8. Manifest schema as proposed in brief.** Used the brief's schema verbatim. `requires_agents: [Larry, Nolan, Mack]` because the install workstream Mack is authoring will need them; once that workstream lands and locks the schema, this manifest may need a field rename (e.g., `requires_agents` → `requires_core_agents`). Flagged below.

## Flagged for review

- **Manifest schema is provisional.** Mack's v1.7 install workstream is the one that will actually parse this. If Mack's spec diverges (field renames, new required fields, version-pinning syntax), this manifest will need a follow-up edit. I built to the schema in the brief.
- **GL-003 reference path is conventional.** I used `Team Knowledge/Guidelines/GL-003-design-system.md` as the canonical path Felix and Vera reference. If the v1.7 scaffold uses a different convention for design-system docs (e.g., `Team Knowledge/Design System/INDEX.md`), update both AGENTS.md files.
- **Pack assumes Larry is already trained on the new specialists.** Felix/Vex/Vera each describe their routing table, but Larry's own routing logic is not in this pack. The install workstream presumably handles Larry's update; if not, that's a gap.
- **No explicit "uninstall" guidance.** The README says installation adds folders and SOPs but doesn't describe how to reverse an install if a user changes their mind. If the v1.7 install workstream supports uninstall, the README can be updated to mention it; if not, no action needed.
- **Felix could grow into ReactFlow / mobile / etc. variants.** Future packs could specialize Felix (e.g., "Flow" for ReactFlow, "Knox" for mobile). The signature SOP here is general-purpose enough to absorb most frontend work; specialization is a v1.8+ conversation.
- **Slack pack coordination (Pax).** Pax is researching the Slack pack in parallel. If their pack's structure diverges (different manifest fields, different SOP filename conventions, different README sections), one of us should align. No conflicts foreseen — these two packs share zero agents.

## Files shipped (all under `Deliverables/26-05-09_mypka-expansions/app-developer-pack/`)

- `expansion.yaml`
- `README.md`
- `BUILD-NOTES.md` (this file)
- `agents/Felix - Frontend Developer/AGENTS.md`
- `agents/Vex - Security Engineer/AGENTS.md`
- `agents/Vera - QA Specialist/AGENTS.md`
- `sops/SOP-felix-build-a-component.md`
- `sops/SOP-vex-security-audit.md`
- `sops/SOP-vera-quality-gate.md`

Total: 9 files. Pack is drop-in ready for Mack's v1.7 install workstream once that spec lands.

## Vex fix-pass (2026-05-09)

Applied Vex's audit findings:

- **MED-A1 fixed.** Authored `ADAPT-EXPANSION.md` at the pack root, matching the trinity contract per Mack's slack-pack reference. Adapted for `agent_pack` scope (no runtime, no env vars, no connector wiring) — covers manifest preflight, Vex security review, Nolan merge, Silas integrity, post-install validation, archive + announce, suggested next steps, and uninstall.
- **LOW-A1 fixed.** Updated BUILD-NOTES.md "Files shipped" list: `manifest.yaml` → `expansion.yaml`. Zero remaining `manifest.yaml` references in the pack.
- **expansion.yaml untouched.** Vex's hash `be3a4da88a2d3f56f64c0f0ee53ccc623ffc1a0b33b0dbe0dc05305fed22a8eb` remains valid.

Pack now ships ten files (added ADAPT-EXPANSION.md). Trinity complete: README + ADAPT-EXPANSION (no INSTALL.md needed — agent_pack has no runtime setup).
