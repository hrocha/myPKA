# Security Policy

myPKA Cockpit is **local-first, per-user software**. It runs entirely on the
machine it is installed on; by default nothing leaves that machine. This policy
covers how to report a vulnerability and the standing security rules every
distribution of the cockpit must honor.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x   | ✅ Yes — current release line |
| < 1.0.0 | n/a — no public release before 1.0.0 |

Security fixes land on the current minor line. The version in `expansion.yaml`
is the single source of truth for what you are running.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
unfixed vulnerability.

- **Preferred:** GitHub private vulnerability reporting / security advisories on
  the cockpit's repository, once the public repo is live.
- **Email:** `support@myicor.com`

Please include: the affected version, a description, reproduction steps, and the
impact you observed. Coordinated disclosure is the default: we will acknowledge,
investigate, agree a fix timeline, and credit you (if you wish) once a fix ships.
Please give a reasonable window to remediate before any public disclosure.

## Standing distribution rules (release-blocking)

These rules are non-negotiable for every release of the cockpit and any
connector or pack built on it.

### Keys never leave the user's machine (BYO-key)

- Any integration that talks to an LLM provider (e.g. Anthropic) is
  **bring-your-own-key**: each user supplies their own key, it is read from the
  user's local environment/config, held in memory locally, and **never** pooled,
  proxied, centrally stored, reused across users, or shipped in any artifact.
- The frontend never calls a third-party API directly — only the local server on
  `localhost`. Pooling or proxying many users through one key (or through
  consumer Claude.ai / Pro / Max credentials) is an outright provider
  Terms-of-Service violation and is prohibited.
- No key of any kind ships in the distributed package.

### Connector and tool secrets by reference, never by value

- API keys for task/PM/calendar/finance tools are stored locally in
  `Team Knowledge/.env` (file mode `0600`, gitignored) via the cockpit's
  Connections page. Connector code resolves them in-process by key **name** only
  (`readEnvKey(...)`); a secret value must never appear in an emitted item, a
  route response, a log line, an error message, or a commit.

### Network posture

- The server binds to `127.0.0.1` (loopback) by default — reachable only from
  the machine it runs on.
- LAN mode (`COCKPIT_BIND_LAN=1`, binding `0.0.0.0` for the user's own phone/
  tablet on their own network) is **hard-gated on a configured access PIN** and
  refuses to start without one. An optional TLS mode marks the session cookie
  `Secure`.
- The cockpit is **not** a hosting product. It is run by one user, for that user,
  on their own machine — not as a service for other people.

### Write surfaces are narrow and local

- The cockpit reads `mypka.db` strictly **read-only**.
- The only vault write surface is Fleeting Notes, scoped to `PKM/Fleeting Notes/`
  and disengageable (`WORKBENCH_WRITE_ENABLED=0`).
- The settings/module-toggle write path (`PUT /api/cockpit/settings`) and the
  day-planner layout write both target the cockpit-local `mypka-cockpit.db`
  only — never the markdown vault, never an external tool.

### Finance / bank connectors are the user's own responsibility

- Any finance or bank integration is an **unsupported example pattern** for the
  user's own LLM to study, not a product feature. The user alone sets up and
  operates any connection to a bank, payment tool, or money-management app, and
  is solely responsible for those credentials and for the safety, accuracy, and
  integrity of their financial data. The software is provided AS-IS with no
  warranty and no liability. See `LICENSE` Sections 8–10 and the finance
  disclaimer in `README.md` and `server/connectors/README.md`.
