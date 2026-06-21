# Example connectors — disabled by default

Everything in this folder is **inert, disabled, example source**. None of it loads
or activates on a fresh install. It ships so your LLM assistant can study the
pattern and wire your own task / PM / calendar tools.

## What's here (all OFF by default)

| Module | Tool | Catalog entry | Notes |
|--------|------|---------------|-------|
| `todoist.js` + `todoistTasks.js` | Todoist | `todoist` | REST v1 client + connector. Read-only by default. |
| `clickup.js` + `clickupTasksConn.js` | ClickUp | `clickup` | REST v2 client + connector. Assignee derived from the token (no hard-coded id). |
| `ical.js` | Any iCal/ICS feed | `ical:primary` | Calendar feed parser. |
| `imapStarred.js` | Any IMAP mailbox | `email:starred` | Starred/flagged email as plannable cards. Read-only mailbox lock. |
| `env.js` | — | — | Shared single-key `.env` reader (`readEnvKey` / `maskSecret`). |
| `registry.js` | — | — | The tool-blind engine + the `CONNECTORS_ENABLED` master gate. |
| `types.js` | — | — | Canonical `NormalizedTask` / `NormalizedEvent` shapes + helpers. |

## How "off by default" works

Two independent conditions must BOTH hold for a connector to do anything:

1. **The master gate is on** — `CONNECTORS_ENABLED=1` in `Team Knowledge/.env`.
   Unset (the default) → `registry.js` imports nothing; the engine is dormant.
2. **The connector's key(s) resolve** — e.g. `TODOIST_API_TOKEN` is present.
   Stored via the cockpit's Connections page (#/connections), which writes
   `Team Knowledge/.env` (chmod 600). Absent → that one connector stays a quiet
   "not connected" offer, never an error.

So a fresh cockpit boots with **zero** connectors active, even with the gate on but
no keys. Nothing reaches out to any external service until the user deliberately
opts in.

## These contain no personal data

The example modules carry **no real credentials, no account/user/workspace ids, no
personal endpoints**. Where an id is genuinely needed (ClickUp's "assigned to me"
scope) it is **derived from the token at runtime** (`GET /user`) — never written
into source. The optional `CLICKUP_ASSIGNEE_ID` env var exists only to watch a
*different* assignee than the token owner.

## How to wire your own

1. Set `CONNECTORS_ENABLED=1` (once).
2. Store your tool's key via #/connections → "Any other tool".
3. Follow `README.md` in this folder — one module + one `catalog.json` entry.
   Copy the read-only, secret-free, never-throw posture of `todoistTasks.js`.
4. Restart the cockpit.

See `README.md` (the full authoring contract) and `../../.env.example` (every flag).
