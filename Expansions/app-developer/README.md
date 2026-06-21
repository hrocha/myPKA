# App Developer Pack

> A myPKA Expansion. Adds three specialists to your team for building, auditing, and quality-gating apps.

## What this pack adds

Three new agents and their signature skill SOPs:

| Specialist | Role | Signature skill |
|---|---|---|
| **Felix** | Frontend Developer | Build a component end-to-end with design-system fidelity, type safety, and accessibility |
| **Vex** | Application Security Engineer | Run a structured security audit covering credentials, authorization, integrations, and data handling |
| **Vera** | QA Specialist | Run the visual + accessibility + responsive quality gate every UI deliverable clears before shipping |

After installation, Larry will route relevant requests to these three automatically. They report up through Larry like the rest of your team and write to `Team Knowledge/session-logs/` per the standard discipline.

## When to install

Install this pack if you're using your myPKA team to:

- Build or maintain a web app, mobile app, or desktop app
- Ship UI work that needs design-system fidelity and accessibility rigor
- Operate a backend that stores user data and needs authorization audits
- Handle PII or work in a GDPR-relevant jurisdiction
- Run pre-launch security and quality reviews

If you're using your team purely for personal knowledge management, journaling, content, or research — you don't need this pack.

## What changes after installation

1. **Three new folders under `Team/`:**
   - `Team/Felix - Frontend Developer/`
   - `Team/Vex - Security Engineer/`
   - `Team/Vera - QA Specialist/`
2. **Three new SOPs in `Team Knowledge/SOPs/`,** auto-numbered to follow your existing SOP-001..SOP-006:
   - `SOP-007-felix-build-a-component.md` (or whatever the next number is)
   - `SOP-008-vex-security-audit.md`
   - `SOP-009-vera-quality-gate.md`
3. **Larry's routing table** is updated to delegate frontend / security / QA requests to the new specialists.
4. **Your existing roster, SOPs, guidelines, and workstreams are untouched.** The install workstream copies new files in; it doesn't overwrite anything you already have.

## What this pack does NOT add

- **No new workstreams.** Workstreams (multi-agent compositions) emerge from real use. We don't pre-ship them — once you've worked with Felix, Vex, and Vera for a while, Larry will help you graduate recurring patterns into named workstreams.
- **No new guidelines.** The pack assumes your team's existing guidelines (GL-001 file naming, GL-002 frontmatter) cover what these three need. If you have a design system documented at `GL-003-design-system.md`, Vera and Felix will reference it. If you don't, Vera's first QA report will recommend creating one.
- **No environment variables or external connectors.** None of these three agents need API keys to function. They work with your existing codebase, your existing browser, and your existing knowledge.

## Recommended companion packs

- **Slack Integration Pack** (separate Expansion, in development): adds Sage (community manager) plus the connectors and SOPs to wire your team's outputs into a Slack workspace.

## Compatibility

- Requires the myPKA Expansion system (introduced in scaffold v1.7.0); current bundle v3.0.0.
- Requires the core team agents Larry, Nolan, and Mack — these ship with the v3.0.0 scaffold and should already be in your team.

## Post-install

When your team next loads, Larry will introduce Felix, Vex, and Vera. You don't need to do anything to activate them; they're available for routing the moment they're installed.

If you want to dry-run their signature skills, ask Larry:

- "Felix, build me a small component for X" — Felix runs `SOP-felix-build-a-component`.
- "Vex, do a security audit on my project" — Vex runs `SOP-vex-security-audit`.
- "Vera, QA this deliverable" — Vera runs `SOP-vera-quality-gate`.

Welcome to your expanded team.
