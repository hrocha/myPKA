# Changelog

All notable changes to the myPKA Cockpit are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version in `expansion.yaml` is the single source of truth for a release; the
root `package.json` and `package-lock.json` mirror it.

## [1.0.0] - 2026-06-17

First public **standalone** release of the myPKA Cockpit as a community-
distributable Expansion. Public version history starts here. The cockpit
previously lived inside the author's private myPKA instance and reached an
internal `1.7.0` (finance example tracking, Hub modules, runtime Settings page,
the move to a source-available license); that lineage is pre-history and is not
re-numbered into this public series.

### Added

- **Standalone, drop-in distribution.** The cockpit now ships as its own
  Expansion folder you drop into `Expansions/mypka-cockpit/`, with the manifest
  (`expansion.yaml`) as the version SSOT and `INSTALL.md` as the install
  contract your LLM assistant follows.
- **`INSTALL.md` — the keystone install contract.** A deterministic 8-step
  procedure (Step 0 consent → Step 1 backup → Step 2 resolve root → Step 3
  detect gaps → Step 4 offer the SQLite upgrade → Step 5 generate the launcher →
  Step 6 wire & first run → Step 7 adapt to any KB), with four hard rules baked
  in: consent-before-write, backup-before-write, offer-not-auto upgrade, and
  never auto-launch.
- **`DISCLAIMER.md`** — bilingual (EN+DE) backup / breaking-changes / AS-IS
  install disclaimer, surfaced by `INSTALL.md` Step 0 before any write.
- **`HOW-IT-WORKS.md`** and **`CUSTOMIZE.md`** — the architecture reference and
  the "adapt the cockpit to any knowledge base" guide.
- **`sqlite-extension/`** — the additive, idempotent SQLite upgrade area:
  `DATA-CONTRACT.md` (the exact tables/views the cockpit reads), `detect-gaps.py`
  (read-only probe of what will render vs. be empty), and `install-extensions.py`
  (additive installer; never drops a table/column or modifies a row).
- **`launcher/GENERATE-LAUNCHER.md` + text-only templates** — per-OS launcher
  generation. The package ships **zero executables**; your assistant writes the
  launcher locally from a reviewed template (anti-malware-warning posture).
- **Dynamic root resolution** (`server/repoRoot.js`): `MYPKA_ROOT` env →
  upward fingerprint search (`AGENTS.md` + `PKM/`) → three-levels-up fallback,
  so the cockpit no longer assumes a fixed `Expansions/mypka-cockpit/` depth.
- **`LICENSE` + `NOTICE` + `SECURITY.md`** at the package root.

### Changed

- **Version reset to `1.0.0`** for the first public standalone release (internal
  lineage reached `1.7.0`; not carried into the public numbering).
- **Connectors ship as disabled example source.** The example task/PM/calendar
  connectors (Todoist / ClickUp / iCal / IMAP) load only when
  `CONNECTORS_ENABLED=1` AND a key resolves — off by default.
- **Removed the shipped `start-cockpit.command`.** No launcher ships; it is
  generated per-OS at install (see `launcher/`).
- **Manifest reconciled to the standalone Expansion schema v1:** dropped the
  deprecated `requires_scaffold_version` gate, set `runtime.start` to `null`
  (the machine-readable signal that no launcher ships), and updated
  `post_install_steps` / `post_install_validation` to the standalone tree.

### Security

- Loopback-default binding (`127.0.0.1:4317`); LAN mode hard-gated on a
  configured PIN. Reads `mypka.db` strictly read-only (`readonly` open flag +
  `query_only` pragma). The only vault write surface is Fleeting Notes
  (`PKM/Fleeting Notes/`), behind a flag.
- **BYO-key:** the chat bridge spawns the user's own local `claude` CLI — no key
  ships in the package, nothing is pooled, proxied, or centrally stored.
- Connector and tool secrets are stored by reference only in a gitignored local
  `Team Knowledge/.env` (mode `0600`), resolved in-process by name.

[1.0.0]: https://myicor.com/library/mypka-cockpit
