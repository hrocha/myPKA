# myPKA v3.0 — License Map

**In one sentence:** You may freely edit every part of myPKA for your own
private, non-commercial use — change anything to your liking — but you may not
sell it, or redistribute it as your own commercial product.

This file is a plain-language guide. The binding terms are in each subtree's
own `LICENSE` file. Where this guide and a `LICENSE` differ, the `LICENSE` wins.

---

## What governs what

| Subtree | License | © Holder | You MAY | You MAY NOT |
|---|---|---|---|---|
| **Base scaffold** (root markdown: PKM, Team, Team Knowledge, SOPs, etc.) | CC BY-NC-SA 4.0 | Paperless Movement S.L. | Edit, adapt, and customize for your own personal, non-commercial use. Run it with any LLM. | Use commercially / sell it. If you publicly redistribute an adapted version, you must license that shared version under the same CC BY-NC-SA terms (ShareAlike). |
| **Cockpit runtime** (`Expansions/mypka-cockpit/`) | PolyForm Noncommercial 1.0.0 (adapted: "myICOR Cockpit Personal-Use License") | myICOR | Download, run, read, study, and modify the source (including with your own LLM), and share your changes — all for personal, non-commercial use. | Sell it, sublicense it for a fee, or run it as a paid product / hosted service for others. |
| **App Developer Pack** (`Expansions/app-developer/`) | CC BY-NC 4.0 (adapted) | Paperless Movement S.L. | Install, run, and freely modify/adapt the specialist contracts and SOPs for your own personal, non-commercial use. Share your changes at no charge. | Sell it, sublicense it for a fee, or redistribute it (original or modified) as part of a commercial product or service. |
| **Designer Expansion Pack** (`Expansions/designer-pack/`) | CC BY-NC 4.0 (adapted) | Paperless Movement S.L. | Install, run, and freely modify/adapt the specialists, SOPs, and GL-003 for your own personal, non-commercial use. Share your changes at no charge. | Sell it, sublicense it for a fee, or redistribute it (original or modified) as part of a commercial product or service. |

**Common thread across all four:** edit freely for yourself; never sell as your
own. Attribution and the original copyright/license notices must stay intact in
anything you share.

---

## What changed in v3.0 (relicensing)

Both Expansion Packs previously shipped under restrictive "install-and-run-only"
proprietary terms that did **not** permit modification. As of v3.0 they move to
**editable CC BY-NC 4.0**: you may now freely modify and adapt the packs for
your own non-commercial use. The non-commercial / no-resale boundary is
unchanged.

---

## Trademarks (NOT licensed by any of the above)

The licenses above cover copyrightable text and structure only. These marks are
owned by Paperless Movement S.L. and/or its affiliated holding entity and are
**not** licensed:

- **PAPERLESS MOVEMENT®** — USPTO Reg. No. 6,689,873
- **ICOR®** — USPTO Reg. Nos. 6,607,819 and 6,608,200
- **myICOR™**, **myPKA™** — common-law / EUTM pending

You may name them descriptively (e.g. "based on the myPKA™ Scaffold by ICOR®").
You may not use them to brand a derivative or competing product. See `NOTICE.md`.

---

## One bundled dependency to be aware of (inert)

The Cockpit lists `react-leaflet` and `@react-leaflet/core` under the
**Hippocratic License 2.1** (an "ethical-source", non-OSI license). These are
used **only** by the optional `workouts` feature pack, which ships as **inert
source** and is **not compiled into the core application** unless a user
explicitly activates it. As distributed, the core Cockpit executes no
Hippocratic-licensed code. If you activate the workouts pack and distribute the
result, you must preserve the Hippocratic 2.1 text and honor its conditions for
those portions. Full detail in `Expansions/mypka-cockpit/NOTICE`.

---

This is compliance analysis (Einschätzung im Sinne des § 6 RDG), not legal
advice (keine Rechtsberatung). For binding legal opinions, consult a licensed
Fachanwalt in the relevant jurisdiction.
