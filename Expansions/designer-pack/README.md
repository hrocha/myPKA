# Designer Expansion Pack

> A myPKA Expansion. Adds three creative specialists to your team for brand-consistent design, layout, and visual work.

## What this pack adds

Three new agents and their signature skill SOPs:

| Specialist | Role | Signature skill |
|---|---|---|
| **Iris** | Design System Architect | Run a guided session that turns "I have a vibe in my head" into a written, queryable brand SSOT — color, type, spacing, imagery, voice |
| **Charta** | Infographic Designer | Turn dense information into a single scannable, branded image — comparison tables, decision guides, flowcharts, timelines, carousels — built from HTML/CSS/SVG and rendered to PNG/PDF |
| **Pixel** | Visual Specialist | Take a brief (or a Charta layout draft) and produce a finished stylized visual — thumbnails, social images, hero illustrations, quote cards, multi-reference composites |

After installation, Larry routes creative requests to these three automatically. They report up through Larry like the rest of your team and write to `Team Knowledge/session-logs/` per the standard discipline.

## When to install

Install this pack if you're using your myPKA team to:

- Build a brand or visual identity and keep it consistent across every deliverable
- Produce infographics, slide decks, carousels, decision guides, or one-pagers
- Generate thumbnails, social images, hero illustrations, or quote cards
- Run visual-consistency audits across a body of creative work
- Pair structured layout (Charta) with stylized finishing (Pixel) on the same deliverable

If you're using your team purely for personal knowledge management, journaling, research, or app development — you don't need this pack.

## How the three work together

The pack ships a complete creative pipeline:

- **Iris owns the system.** She is the only specialist who edits `GL-003-design-system.md` — the brand SSOT. Charta and Pixel read it; they never write it.
- **Charta lays out structure.** HTML/CSS/SVG, rendered to PNG/PDF. Production-ready when the deliverable is structural (table, grid, flow, diagram).
- **Pixel finishes the visual.** When a deliverable needs photographic, illustrated, or AI-generated treatment, Pixel takes Charta's draft as a structural reference and styles on top — or generates from scratch.

On your first creative request, if `GL-003-design-system.md` is empty, Larry pauses and offers Iris's 15-minute guided session to populate it first. You can also work in flagged fallback "no-style" mode and revisit later.

## What changes after installation

1. **Three new folders under `Team/`:**
   - `Team/Iris - Design System Architect/`
   - `Team/Charta - Infographic Designer/`
   - `Team/Pixel - Visual Specialist/`
2. **Four new SOPs in `Team Knowledge/SOPs/`,** auto-numbered to follow your existing SOPs:
   - `SOP-NNN-author-a-design-system.md` (Iris)
   - `SOP-NNN-audit-content-for-design-system-compliance.md` (Iris)
   - `SOP-NNN-build-an-infographic.md` (Charta)
   - `SOP-NNN-generate-a-styled-image.md` (Pixel)
3. **One new guideline in `Team Knowledge/Guidelines/`:** `GL-003-design-system.md` — the brand SSOT all three agents read from. It arrives as an empty template; Iris populates it with you. If your team already has a `GL-003`, the install skips it and keeps yours.
4. **Larry's routing table** is updated to delegate design-system, infographic, and image work to the new specialists.
5. **Your existing roster, SOPs, guidelines, and workstreams are untouched.** The install workstream copies new files in; it doesn't overwrite anything you already have.

## What this pack does NOT add

- **No new workstreams.** Workstreams (multi-agent compositions) emerge from real use. Once you've worked with Iris, Charta, and Pixel for a while, Larry will help you graduate recurring patterns into named workstreams.
- **No environment variables or external connectors.** None of these three agents need API keys to function. Pixel handles image generation: if your LLM can generate images natively, Pixel drives it directly; if it can't, Pixel routes the connection half to **Mack** to wire up an external image API/MCP. That connector wiring is a separate, optional step — it is not part of this pack.

## Image generation

Pixel's signature SOP has three capability paths:

1. **Local image-gen available** — Pixel drives your LLM's native image generation directly. No setup needed.
2. **Local image-gen unavailable** — Pixel names the options (Gemini, OpenAI Images, Flux via Replicate, an image-capable MCP) and routes the connection half to Mack to wire one up.
3. **No image-gen at all** — Pixel produces a detailed design brief you can paste into any external tool (Midjourney, DALL-E, a designer).

The pack ships zero credentials. Any API keys for an external generator are wired by Mack into the relevant connector's `.env`, never bundled here.

## Recommended companion packs

- **App Developer Pack** (separate Expansion): adds Felix (frontend), Vex (security), Vera (QA). Felix implements the designs Iris specs; the two packs compose cleanly.

## Compatibility

- Requires myPKA scaffold v1.7.0 or later (the version that introduced the Expansion system). Installs on the 2.x six-specialist base and on legacy 1.x scaffolds alike.
- Requires the core team agents Larry, Nolan, and Mack — these are part of the v1.5+ scaffold and should already be in your team.

## Post-install

When your team next loads, Larry will introduce Iris, Charta, and Pixel. You don't need to do anything to activate them; they're available for routing the moment they're installed.

If you want to dry-run their signature skills, ask Larry:

- "Iris, let's set up my design system" — Iris runs `SOP-author-a-design-system`.
- "Charta, make me an infographic about X" — Charta runs `SOP-build-an-infographic`.
- "Pixel, design me a thumbnail for X" — Pixel runs `SOP-generate-a-styled-image`.

## Uninstall

Ask Larry to "remove the Designer Expansion Pack." Nolan reverses the team merge: the three agent folders leave `Team/`, the four SOPs are removed from `Team Knowledge/SOPs/`, and the roster is restored. Your existing session logs that reference the removed agents remain as historical record. `GL-003-design-system.md`, if Iris populated one, is **your** content and is left in place — the pack does not delete it.

Welcome to your expanded creative team.
