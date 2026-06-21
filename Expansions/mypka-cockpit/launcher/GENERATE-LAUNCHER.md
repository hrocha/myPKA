# GENERATE-LAUNCHER.md — how the installing LLM writes the cockpit launcher

You are an LLM assistant (Claude Code, Codex CLI, Cursor, or similar) finishing a
myPKA Cockpit install. **No runnable launcher ships in this package** — not a
`.command`, not a `.sh`, not a `.bat`/`.ps1`, not any executable. You GENERATE the
right launcher locally, on the user's machine, for the user's OS and paths.

**Why we ship zero executables.** A downloaded, pre-made shell/batch/PowerShell file
trips Gatekeeper (macOS), SmartScreen (Windows), and antivirus heuristics — the
exact "is this malware?" friction we refuse to impose. A launcher the user's own
assistant writes into the user's own folder, from a reviewed text template, carries
none of that baggage: the user can read every line before it runs, and nothing
arrived pre-compiled. This is a deliberate anti-malware-warning posture.

This file is your complete instruction set. The text-only reference templates live
in `launcher/templates/`:

| OS | Template | You write |
|----|----------|-----------|
| macOS | `templates/macos.command.txt` | `start-cockpit.command` (in the cockpit root) |
| Linux | `templates/linux.sh.txt` | `start-cockpit.sh` (in the cockpit root) |
| Windows | `templates/windows.ps1.txt` | `start-cockpit.ps1` (in the cockpit root) |
| Windows (alt) | `templates/windows.bat.txt` | `start-cockpit.bat` (double-click friendly wrapper) |

---

## Step 0 — detect the OS

```
node -e "console.log(process.platform)"   # 'darwin' | 'linux' | 'win32'
```
or read it from your own runtime. Pick the matching template. If unsure, ask the user.

## Step 1 — gather the real values

You are adapting a template, not copying it. Resolve these for THIS machine:

- **`COCKPIT_DIR`** — the absolute path to this cockpit folder (the one holding
  `package.json`, `server/`, `web/`). Use the real path, with the user's real
  spaces/characters; quote it everywhere.
- **`PORT`** — default `4317`. Honor a user override.
- **`MYPKA_ROOT`** — usually leave UNSET: the server auto-detects the scaffold root
  (see below). Set it explicitly only for a non-standard layout (cockpit outside
  `Expansions/mypka-cockpit/`, scaffold on another volume). When set, export it so
  the server, and the regen, agree on the root.
- **`PYTHON`** — the Python 3 the regen + installer use (`python3`, or `py -3` on
  Windows). Two cases, handled differently in Step 2: (a) when `mypka.db` ALREADY
  exists, a missing Python/PyYAML only skips the optional refresh — never block the
  launch, the existing DB serves; (b) when `mypka.db` is MISSING and must be created,
  Python 3 + PyYAML are REQUIRED (the base bootstrap parses your markdown). If they
  are absent in that case, print an actionable install message and EXIT — do not
  start the server against a DB that does not exist.
- **`COCKPIT_LLM_CMD`** — usually leave UNSET (defaults to `claude`). Set it only if
  the user runs a different LLM CLI, so the in-app "Discuss with AI" / quick-launch
  terminal buttons launch THEIR CLI: e.g. `COCKPIT_LLM_CMD=codex` or
  `COCKPIT_LLM_CMD=gemini`. Must be a bare command name or a path (no spaces /
  metacharacters). The Claude-only `--model` flag is added by the server ONLY when
  this is `claude`; other CLIs get just the prompt.

> **Root resolution (must match the server).** `server/repoRoot.js` resolves the
> scaffold root in this order: (1) `MYPKA_ROOT` env if set; (2) an upward search
> from the cockpit folder for the scaffold fingerprint (`AGENTS.md` + `PKM/`),
> with a generated `mypka.db` as a secondary marker; (3) fallback to three levels
> up — the `Expansions/mypka-cockpit/` happy path. The launcher does NOT need to
> compute the root itself; it only forwards `MYPKA_ROOT` when the user set one.

## Step 2 — replicate the 6-step launch behavior

Every template performs the same six steps, in order. Adapt the syntax per OS; do
not drop a step.

1. **Resolve the cockpit dir** and `cd` into it (so all relative paths and `npm
   --prefix web` work regardless of where the user double-clicked from).
2. **Ensure `mypka.db` exists with the core schema BEFORE node starts.** This is
   load-bearing: the server opens `mypka.db` read-only and **hard-exits if it is
   missing** (`db.js` throws `mypka.db not found`), so a launcher that proceeds to
   `node server/server.js` without a DB hands the user a dead cockpit
   (`ERR_CONNECTION_REFUSED`). Check first, create only when needed — a normal
   start must NOT rebuild:
   - **Resolve the root DB path** the server will open: `<root>/mypka.db`, where
     `<root>` is `MYPKA_ROOT` if the user set it, else three levels up from the
     cockpit dir (the standard `Expansions/mypka-cockpit/` layout). Pass this exact
     path to the installer below so its auto-bootstrap targets the right file.
   - **DB present AND has the core schema** (a `journal` table) → FAST PATH: refresh
     it from markdown via `scripts/regen-mypka-db.py` with the graceful
     Python/PyYAML fallback (if `python3` is absent OR `python3 -c "import yaml"`
     fails, print a one-line "skipping DB refresh (Python/PyYAML missing)" and
     continue — the existing DB still serves). The regen is non-destructive and
     finds the root from its own location, so you pass it nothing.
   - **DB missing or coreless** → FIRST-RUN PATH: create it by running
     `python3 sqlite-extension/install-extensions.py "<root>/mypka.db" --all`. That
     installer is idempotent and **auto-bootstraps the base core schema** (it runs
     the base regen itself when the DB is absent) and then installs **every** cockpit
     module — the no-flag default is also "all", but pass `--all` explicitly so the
     intent is unmistakable. The base bootstrap needs **Python 3 + PyYAML** (the
     regen parses your markdown frontmatter). If either is missing at this point, do
     **NOT** fall through to the server — print a clear, actionable install message
     (what to install + the exact `pip` line) and **exit non-zero**. A cryptic
     connection-refused is the failure mode we are closing; a readable "install
     Python 3 + PyYAML, then re-run me" is the cure. Likewise, if the installer
     itself exits non-zero, stop with a short "could not create mypka.db" note —
     never start node against a missing DB.
   - Detect "has core schema" with a tiny read-only probe (open
     `file:<db>?mode=ro` and check `sqlite_master` for a `journal` table); see the
     `db_has_core` / `Test-DbCore` helpers in the per-OS templates.
3. **First-run install + build** (only when missing): if `node_modules/` is absent
   run `npm install --no-audit --no-fund`; if `web/node_modules/` is absent run
   `npm --prefix web install --no-audit --no-fund`; if `web/dist/` is absent run
   `npm --prefix web run build`. On later launches these are skipped (fast start).
4. **Free the port** so a stale instance doesn't block the new one:
   - macOS/Linux: `lsof -ti tcp:$PORT | xargs kill` (guarded — no-op if nothing
     is listening).
   - Windows: there is NO `lsof`. Use
     `Get-NetTCPConnection -LocalPort $Port` → `Stop-Process -Id <OwningProcess>`
     (PowerShell), or parse `netstat -ano | findstr :$Port` for the PID and
     `taskkill /PID <pid> /F`.
5. **Open the browser** to `http://127.0.0.1:$PORT/`:
   - macOS: `open`  ·  Linux: `xdg-open`  ·  Windows: `start "" <url>`.
   Open it slightly BEFORE or just after starting the server — the SPA retries
   until the API is up, so a half-second race is invisible.
6. **Start the server** loopback-only with the right env:
   `node server/server.js` with `PORT`, `WORKBENCH_WRITE_ENABLED=1` and
   `PLAN_WRITE_ENABLED=1` (the documented launcher defaults — set `0` for a fully
   read-only cockpit), `MYPKA_ROOT` only if the user set one, and
   `COCKPIT_LLM_CMD` only if the user runs a non-`claude` CLI (defaults to
   `claude` when unset). Do NOT pass
   `COCKPIT_BIND_LAN` here — LAN mode is a separate, PIN-gated opt-in (see below).
   Leave the server in the foreground so closing the window/terminal stops it.

## Step 3 — write the file and tell the user how to start it

Write the adapted launcher into the **cockpit root** (next to `package.json`), make
it executable where that applies, and then **hand off — never auto-launch**:

- **macOS**: `chmod +x start-cockpit.command`. Tell the user to **double-click** it.
  First launch: right-click → **Open** once to pass Gatekeeper (it is plain shell,
  not signed app code). If macOS still blocks it:
  `xattr -d com.apple.quarantine start-cockpit.command`.
- **Linux**: `chmod +x start-cockpit.sh`. Tell the user to run `./start-cockpit.sh`
  (or wire a `.desktop` entry if they want a clickable icon).
- **Windows**: tell the user to double-click `start-cockpit.bat` (it just calls the
  `.ps1` with an ExecutionPolicy bypass scoped to that one process). If SmartScreen
  warns, **More info → Run anyway** — the file is local plain text they can read.

## Connectors and LAN mode are OFF by default — do not turn them on in the launcher

- **External connectors** (Todoist / ClickUp / iCal / IMAP) ship as **disabled
  example source**. They activate only when `CONNECTORS_ENABLED=1` AND the user has
  stored a key. The launcher must NOT set `CONNECTORS_ENABLED`. If the user later
  wants them, they enable the flag and add keys via the Connections page — that is
  a deliberate, separate decision, not a launch default. See
  `server/connectors/README.md`.
- **LAN mode** (`COCKPIT_BIND_LAN=1`) binds `0.0.0.0` and is HARD-GATED on a PIN
  (`npm run set-pin`). The default launcher binds loopback only. Offer a SEPARATE
  `start-cockpit-lan.command/.sh/.ps1` only if the user explicitly asks, and only
  after a PIN is set — the server refuses to bind the LAN without one.

## Reference templates are TEXT ONLY

The files in `launcher/templates/` end in `.txt` on purpose. They are references
to read and adapt, not files to rename-and-run. Adapt the values, the path-quoting,
and the OS-specific port/browser/regen idioms to the user's real machine, then write
the result as the real launcher. Never copy a template verbatim if any path,
port, or interpreter differs.
