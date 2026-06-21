# HOW-IT-WORKS.md — the myPKA Cockpit architecture, for the next LLM (and the curious human)

Read this before you modify the cockpit. It explains the **model** the code is
built on, so a change you make respects the invariants the whole design rests on.
It is descriptive of the *actual code in this tree* — paths and values below were
read from the source, not assumed.

Companion docs:

- [`CUSTOMIZE.md`](./CUSTOMIZE.md) — how to point the cockpit at a different
  folder, remap a different knowledge base, and add/remove modules.
- [`sqlite-extension/DATA-CONTRACT.md`](./sqlite-extension/DATA-CONTRACT.md) —
  the exact tables/views the cockpit reads, which are required vs. optional.
- [`INSTALL.md`](./INSTALL.md) — the install contract your assistant follows
  (the 8-step procedure; the authoritative LLM-facing manual).
- [`launcher/GENERATE-LAUNCHER.md`](./launcher/GENERATE-LAUNCHER.md) — how the
  per-OS launcher is generated locally (no launcher ships in this package).

---

## 1. The one-sentence model

The cockpit is a **read-only web viewer** over a derived SQLite mirror of your
knowledge base: **markdown is canonical → `mypka.db` is a derived, regenerable
mirror → the cockpit reads that mirror READ-ONLY and renders it.** It never
writes the mirror and never writes your markdown — with exactly one narrow,
opt-in write exception (Fleeting Notes, §6).

```
  your markdown (canonical, source of truth)
        │  regen-mypka-db.py  (derive; never edits markdown)
        ▼
  mypka.db  ── opened mode=ro + PRAGMA query_only ──►  cockpit server (Express)
        ▲                                                      │  serves built React app
        └─ regenerable / deletable at any time                ▼  (single origin, strict CSP)
                                                          your browser @ 127.0.0.1:4317
        cockpit's OWN writable state ──►  mypka-cockpit.db (planner + settings; gitignored, machine-local)
```

**What is canonical vs. derived:**

| Artifact | Role | Who writes it | Lifecycle |
|---|---|---|---|
| Your markdown | **Canonical** source of truth | You / your LLM team | Never touched by the cockpit (except Fleeting Notes, §6) |
| `mypka.db` | **Derived** mirror, read-only data source | `regen-mypka-db.py` only | Regenerate or delete at will — zero loss of canonical content |
| `mypka-cockpit.db` | Cockpit-**owned** writable state (planner layout, Hub-module prefs) | The cockpit server | Gitignored, machine-local; deletable with zero loss of *canonical* content |

If you remember nothing else: **the cockpit treats `mypka.db` as immutable input.**
Anything the cockpit needs to *persist* goes in `mypka-cockpit.db`, never the mirror,
never the markdown.

---

## 2. The two-DB split (the most important invariant)

The cockpit opens **two separate SQLite files**:

### `mypka.db` — the read-only data source

- Opened in `server/db.js`:
  `new Database(DB_PATH, { readonly: true, fileMustExist: true })` then
  `db.pragma('query_only = true')`. **Two belts:** the `readonly` open flag *and*
  the `query_only` pragma. Any `INSERT`/`UPDATE`/`DDL` against this handle throws.
- Path: `<repo-root>/mypka.db` (root resolution in §5).
- **Boot preflight (hard gate):** `db.js` checks for 13 required tables —
  `people, organizations, topics, projects, goals, key_elements, habits,
  documents, deliverables, journal, journal_media, links, agents`. If any is
  missing the server **throws at boot** with an actionable message pointing at
  `regen-mypka-db.py`. Everything else (health, workouts, invoices view, etc.) is
  **optional** and degrades per-endpoint (§7).

### `mypka-cockpit.db` — the cockpit-owned writable store

- Opened READ-WRITE in `server/plannerDb.js` and `server/cockpitSettingsDb.js`
  (the *same* file: `path.resolve(__dirname, '..', 'mypka-cockpit.db')`).
- Holds **only** cockpit-local state the user creates *inside* the cockpit:
  - the **day-planner** layout (task placements, weekly goals, local
    completions, work-hours settings) — `plannerDb.js` + `server/migrations/`,
  - the **Hub-module preferences** (visibility toggles + display order) —
    `cockpitSettingsDb.js`, `module_prefs` table.
- It is **gitignored** (`.gitignore`: `mypka-cockpit.db*`) and **machine-local**.
  Think of it like browser local-storage: it survives a `mypka.db` regen, and
  deleting it loses only your planner layout and module prefs — never canonical
  content.
- It **never** reads or writes `mypka.db`, and the planner is intentionally
  *out of the DATA-CONTRACT* (it pulls live tasks from connectors, not the mirror).

This split is why a `mypka.db` regen is always safe: your planner and settings
live in a different file the regen never touches.

---

## 3. The server / web split (one process, one origin)

`server/server.js` is an **Express** app that does two jobs from a **single
origin**:

1. **JSON API** under `/api/...` — read-only SELECTs over `mypka.db`
   (`/api/dashboard`, `/api/cockpit/hub`, `/api/cockpit/graph/...`, etc.) plus
   the few writable endpoints that target `mypka-cockpit.db` (planner, settings)
   or the Fleeting-Notes surface (§6).
2. **Static serving** of the **built React app** from `web/dist/` (Vite build of
   `web/src/`). The same Express process serves the HTML/JS/CSS and the API, so
   the app and its data share one origin — **no CORS, no cross-origin fetches**
   (`connect-src 'self'`).

The React app is a single-page app (hash routing, `web/src/lib/router.ts`); the
server has an SPA fallback so deep links resolve to `index.html`.

### Content-Security-Policy and security headers

- **App surface CSP** (`APP_CSP` in `server.js`), set on the app HTML + assets:
  ```
  default-src 'self'; script-src 'self'; connect-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;
  media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  ```
  Self-origin for scripts/connections; Google Fonts is the only external origin
  (two webfonts). `frame-ancestors 'none'` + `X-Content-Type-Options: nosniff`.
- **Document-preview CSP** (the untrusted PDF/file embed route
  `/api/cockpit/file`) is *stricter*:
  `default-src 'none'; img-src 'self'; object-src 'self'; style-src 'unsafe-inline'`
  — a sandbox for user document bytes.

When you add a feature that talks to a new origin, you must widen `connect-src`
in `APP_CSP` deliberately — the default forbids it. (For most additions you
should not: keep everything self-origin.)

---

## 4. Ports and binding

- **Default port: `4317`** (`const PORT = process.env.PORT || 4317`).
- **Loopback by default:** `HOST = '127.0.0.1'`. Your notes never leave the
  machine. The loopback origin is `http://127.0.0.1:4317`.
- **LAN exposure is opt-in and PIN-gated:** `COCKPIT_BIND_LAN=1` binds `0.0.0.0`
  so your own phone/tablet on your own network can reach it — but the server
  **refuses to start** in LAN mode unless a PIN is configured
  (`COCKPIT_PIN_HASH`, an scrypt hash set via `npm run set-pin`, never the
  cleartext). This hard gate is in `server.js` startup.
- **TLS is a single switch:** `COCKPIT_USE_TLS=1` (with `COCKPIT_TLS_CERT` /
  `COCKPIT_TLS_KEY`) serves HTTPS and marks the session cookie `Secure`.
- **Optional voice ports:** none are wired in this tree today. If a future build
  adds a voice/transcription side-channel it must follow the same loopback-default
  + opt-in posture; document it here when it lands.

### Auth, session, and the loopback convenience

- **PIN-less loopback convenience:** when **no PIN is configured AND** the server
  is loopback-only, the UI needs no login (a single-user machine talking to
  `127.0.0.1`). The moment a PIN is set, or LAN mode is on, the PIN login gates
  every request.
- **DNS-rebinding guard:** the PIN-less convenience is honoured **only** for
  genuine loopback `Host` headers (`127.0.0.1` / `localhost` / `[::1]`), so a
  hostile page that points its own domain at `127.0.0.1` can't ride the
  convenience.
- **Write guard + CSRF:** writable endpoints run a stack of
  `writeGate → session (or loopback-without-PIN) → CSRF guard → body parser`.
  The CSRF belt requires a custom `X-Cockpit: 1` header (a cross-origin
  form/fetch can't set it without a preflight, and no permissive CORS is sent)
  **and**, when an `Origin`/`Referer` is present, it must match the cockpit
  origin (`http://127.0.0.1:4317`); either failing → `403`. `express.json()` is
  scoped **per write route** (small byte limits), so the read surface stays
  body-parser-free. When a write path is disabled (e.g. `PLAN_WRITE_ENABLED=0`),
  the endpoint returns a calm `503 disabled` and the UI degrades to a read-only
  notice — never an error.
- **Other belts:** every response carries `Cache-Control: no-store`; unknown
  `/api/*` paths return a JSON `404` (never the SPA `index.html`, which would
  otherwise produce a confusing "Unexpected token '<'" parse error in the
  client).

---

## 5. Root resolution (where the cockpit finds your knowledge base)

The scaffold root (`REPO_ROOT`) is resolved **once at process start** by the
shared resolver `server/repoRoot.js`, in this order:

1. **`MYPKA_ROOT` env var** — if set and it points at a real directory, use it
   verbatim. (This is the explicit override CUSTOMIZE.md uses to point the
   cockpit at a non-default or relocated knowledge base.)
2. **Upward fingerprint search** — walk up from the cockpit folder looking for a
   scaffold fingerprint (`AGENTS.md` + `PKM/`), then for a `mypka.db`.
3. **Documented fallback** — `Expansions/mypka-cockpit/` → three levels up.

`db.js` re-exports `REPO_ROOT`, so every consumer (`server.js`, `gpxRoute.js`,
`markdown.js`, the connectors) anchors to the same resolved root. `mypka.db` is
expected at `<REPO_ROOT>/mypka.db`.

---

## 6. The Fleeting Notes write exception (the only markdown write)

The cockpit is read-only toward your knowledge base **except** for one explicit,
opt-in surface: **Fleeting Notes** (`server/workbench.js`). It writes **only**
under `PKM/Fleeting Notes/` (capture notes + whiteboards), and only when
`WORKBENCH_WRITE_ENABLED=1` (the launcher default; set `0` for a fully read-only
cockpit). It never edits any other markdown, never touches entity notes, and
never writes `mypka.db`. This is the single seam where the cockpit creates
canonical content — by design, contained to one folder, behind a flag.

Everything else that "persists" (planner, module prefs) goes to
`mypka-cockpit.db` (§2), not markdown.

---

## 7. Graceful degradation (why a bare scaffold doesn't crash)

A freshly-generated **basic** scaffold has the 13 required core tables (so the
cockpit boots and the Hub, notes, graph, and roster all work) but may **lack the
optional tables** the richer modules render against (`health_*`, `workout_*`,
`v_open_invoices`, `habit_logs`, `food_logs`). The architecture handles this in
**two layers**, so a missing optional table is *never* a crash and *never* a
blank:

1. **Server layer — calm empty payloads.** Every optional-table endpoint is
   guarded (`optionalStmt` in `wellnessDb.js`, `viewExists`/`tableExists`
   probes, per-row try/catch). When the backing table/view is absent the
   endpoint returns an honest empty shape — `{ available: false, items: [] }`,
   `{ habits: [], food: [] }`, `{ workouts: [], types: [] }`,
   `{ found: false }`, an empty `FeatureCollection` — **never a 500.** The only
   hard failure is boot-time (a missing *core* table), which is surfaced once
   with remediation text.
2. **Client layer — honest empty states.** Each data-backed module renders a
   calm "what's missing + the fix" panel (`ModuleEmptyState` in
   `web/src/components/ui.tsx`) when its data is absent — e.g. *"Invoice
   tracking isn't set up yet — your mirror has no `v_open_invoices` view. Run
   the SQLite upgrade (see `sqlite-extension/DATA-CONTRACT.md`)."* It points the
   user at the fix instead of crashing or showing a wall of `—`.

Which modules are hard dependencies vs. degrade gracefully is the
**`sqlite-extension/DATA-CONTRACT.md` §5** list; the client empty states are
built to match it exactly.

---

## 8. The chat bridge (BYO-key, localhost-only)

The cockpit can hand a note (or a connector-wiring brief) to **your own local
`claude` CLI** — it does not embed a model or a central API key.

- Routes: `POST /api/cockpit/discuss` (discuss a file) and
  `POST /api/cockpit/connectors/wire-assistant` (hand the connector brief to
  Claude). Both sit behind the local-write guard (session-or-loopback → CSRF).
- Mechanism (macOS): the server builds a `cd <REPO_ROOT> && claude '<prompt>'`
  command and spawns `osascript` to open **Terminal** running it. The user's own
  Claude CLI (their login, their key) answers — **BYO-key; no central key; runs
  on the user's machine.** On non-macOS the route returns the exact command for
  the user to paste-run (`launched: false`).
- **Injection safety:** the prompt is wrapped in POSIX single quotes (the only
  metacharacter, `'`, is escaped); the optional `--model` value is validated
  against a **closed allow-list** (`opus` / `sonnet` / `haiku`) and is never
  free text. `cd`-ing to `REPO_ROOT` (not the file's folder) means Claude boots
  with the full team context (`AGENTS.md` / `CLAUDE.md` / `Team/`).

The chat bridge is a **local hand-off**, not a network call — it never sends
your data to a server the cockpit controls.

---

## 9. The launcher's order of operations

The user launches with a thin shell launcher their assistant **generated** for
their OS during install (`start-cockpit.command` on macOS, `start-cockpit.sh` on
Linux, `start-cockpit.bat`/`.ps1` on Windows — no launcher ships in this
package; see [`launcher/GENERATE-LAUNCHER.md`](./launcher/GENERATE-LAUNCHER.md)).
On every launch it runs, in order:

1. **Regen** — `python3 scripts/regen-mypka-db.py`: rebuild the cockpit's tables
   in `mypka.db` from the current markdown. Non-destructive — it only ever reads
   `.md` files and only drops/rebuilds the tables it owns; any other table in the
   file is left byte-for-byte.
2. **Install** — install Node deps (root + `web/`) if missing.
3. **Build** — `npm --prefix web run build` (`tsc -b && vite build`) if the
   built app is stale/absent → `web/dist/`.
4. **Bind + start** — `node server/server.js`: open `mypka.db` read-only (boot
   preflight), bind `127.0.0.1:4317` (or LAN if opted-in + PIN-gated).
5. **Open** — open the browser at `http://127.0.0.1:4317/`.

Stop with Ctrl-C / closing the Terminal window. (The LLM installer prepares
everything per [`INSTALL.md`](./INSTALL.md); it **never auto-launches** — the
user runs the generated launcher.)

---

## 10. Modifying the cockpit without breaking the model — a checklist

- **Reading data?** Add a read-only SELECT endpoint over `mypka.db`. Guard any
  *optional* table with `tableExists`/`viewExists`/`optionalStmt` so it degrades
  to an empty payload, and give the UI a `ModuleEmptyState` (§7).
- **Persisting cockpit state?** Write it to `mypka-cockpit.db` (a migration +
  a `plannerDb`/`cockpitSettingsDb`-style module). **Never** write `mypka.db`.
- **Need canonical content created?** The only sanctioned write-to-markdown path
  is Fleeting Notes under `PKM/Fleeting Notes/` (§6). Don't add new markdown
  write surfaces without an explicit owner decision.
- **Talking to a new origin?** Widen `APP_CSP`'s `connect-src` deliberately —
  and prefer not to (keep it self-origin).
- **Pointing at a different folder / knowledge base?** That's `MYPKA_ROOT` + the
  DATA-CONTRACT mapping — see [`CUSTOMIZE.md`](./CUSTOMIZE.md).
