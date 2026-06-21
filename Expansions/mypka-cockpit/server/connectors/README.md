<!-- FINANCE / BANK-CONNECTOR DISCLAIMER — keep at the top, both languages. -->

> **⚠ Finance & bank connectors — unsupported example, use at your own risk**
>
> Any finance or banking integration you build with this contract — for example
> reconciling transactions against **MoneyMoney** or another bank tool — is only
> an **example of how the cockpit's author does it**, so your own LLM assistant
> can study the pattern. It is **not a product feature, not a recommendation,
> and not supported.** **You alone** set up and operate any connection to your
> bank, payment tools, or money software, and **you alone** are responsible for
> your credentials and for the safety, accuracy, and integrity of your financial
> data. The software is provided **"as is", with no warranty and no liability** —
> myICOR accepts no liability for loss, corruption, or unauthorized access to
> your financial data, whether or not it follows an example here. See the root
> `LICENSE` (Sections 8–10).

> **⚠ Finanz- & Bank-Konnektoren — nicht unterstütztes Beispiel, Nutzung auf eigene Gefahr**
>
> Jede Finanz- oder Bank-Integration, die du mit diesem Vertrag baust — zum
> Beispiel der Abgleich von Transaktionen mit **MoneyMoney** oder einem anderen
> Bank-Tool — ist nur ein **Beispiel dafür, wie der Autor des Cockpits es selbst
> macht**, damit dein eigener LLM-Assistent das Muster studieren kann. Es ist
> **keine Produktfunktion, keine Empfehlung und wird nicht unterstützt.** **Du
> allein** richtest jede Verbindung zu deiner Bank, deinen Zahlungs-Tools oder
> deiner Finanzsoftware ein und betreibst sie, und **du allein** bist für deine
> Zugangsdaten sowie für die Sicherheit, Richtigkeit und Integrität deiner
> Finanzdaten verantwortlich. Die Software wird **„wie besehen" („as is") ohne
> jegliche Gewährleistung und ohne Haftung** bereitgestellt — myICOR übernimmt
> keine Haftung für Verlust, Beschädigung oder unbefugten Zugriff auf deine
> Finanzdaten, unabhängig davon, ob ein hier gezeigtes Beispiel befolgt wurde.
> Siehe die `LICENSE` im Wurzelverzeichnis (Abschnitte 8–10).
>
> *Soweit zwingendes Recht eine Haftungsbeschränkung nicht zulässt, gilt diese
> Beschränkung insoweit nicht.*

---

# Connector authoring guide (for the user's LLM assistant)

This folder is how the cockpit talks to the user's task / project-management /
calendar tools. The user asked for a tool you don't see here? **You write one
module + one registry entry.** This page is the whole contract.

## OFF by default — these are inert EXAMPLE connectors

Every connector in this folder ships **disabled**. The whole group is behind a
single master gate, **off by default**:

```
CONNECTORS_ENABLED=1   # admit the example connectors at all
```

When `CONNECTORS_ENABLED` is unset (the fresh-install default) the engine
(`registry.js`) loads **nothing** — no example module is even imported, and the
Connections page shows no live tools. The bundled Todoist / ClickUp / iCal /
IMAP-starred modules exist as **reference source** for you to study and adapt;
they carry **no real credentials and no personal ids** (the assignee/user id is
derived from the token at runtime — never hard-coded). To go live, the user sets
`CONNECTORS_ENABLED=1` AND stores a key; even then, each connector activates only
when its own key resolves. See `EXAMPLE.md` in this folder and `.env.example`.

## The deal

- **Read-only.** Connectors pull tasks/events to *visualize* them. Editing
  happens in the source tool — every task carries a `url` deep link for that.
  Never implement a write call.
- **Only the user's items.** Task connectors emit ONLY tasks assigned to the
  user (`assignedToMe: true` is part of the shape).
- **The minimal field set:** task title, description, due date, url. Extras
  (priority, tags, status) are normalized into the shape below.
- **Secrets by reference, never by value.** The user stores the API key FIRST
  through the cockpit's Connections page (#/connections → "Any other tool"),
  which writes it to `Team Knowledge/.env` (0600). You only ever know the KEY
  NAME. Resolve it in-process with `readEnvKey('TOOL_API_KEY')` (env.js). The
  value must never appear in: an emitted item, a route response, a log line, an
  error message, your own context, or a commit. If you need to debug, use
  `maskSecret()`.
- **Never throw.** On any failure return the calm degraded shape
  (`degraded(source, reason, message)` from types.js). A missing key, a
  timeout, a 401 — all render as a quiet "not connected" placeholder, never a
  crash.

## The shapes (types.js is the canonical reference)

Task connector → `fetchWeek(weekStart) → ConnectorResult<NormalizedTask>`:

```js
{
  kind: 'task', source: '<your-id>', id: '<stable-source-id>',
  title, description /* '' when none */, due /* 'YYYY-MM-DD' | null */,
  dueBucket /* 'overdue'|'today'|'upcoming'|'none' */,
  priorityRank /* 1..5 normalized, 5 = none */,
  url /* deep link to the task in the tool — REQUIRED whenever the API has one */,
  tags: [], status /* display label | null */,
  assignedToMe: true, editableFields: [] /* read-only contract → empty */,
}
```

Calendar connector → same `fetchWeek`, emitting `NormalizedEvent` (see
types.js: uid, title, description, start/end ISO, allDay, day, half, location,
url, readOnly: true).

Use the helpers in types.js: `weekWindow`, `dayInWeek`, `clampPriorityRank`,
`instantToDisplayDay`, `ok()`, `degraded()`. Look at `todoistTasks.js` (the
cleanest REST example, ~140 lines) and `imapStarred.js` (a non-REST example:
starred emails over IMAP, with caching + a strict read-only mailbox lock)
before writing anything.

## The recipe

1. **Key first.** Tell the user to store the credential via #/connections →
   "Any other tool" (e.g. `LINEAR_API_KEY`). Confirm with the secret-free
   status endpoint: `GET /api/cockpit/connectors`.
2. **Write `server/connectors/<tool>Tasks.js`** exporting
   `make<Tool>Connector()` that follows the contract above. HTTP via global
   `fetch`, a 6–10s timeout, and the auth header built from
   `readEnvKey('LINEAR_API_KEY')` in-process.
3. **Register it** — ONE entry in `catalog.json`'s `connectors` array with `id`,
   `label`, `kind`, `category`, `module` (the file's basename), `factory` (the
   exported factory name), `keys: [{ key: 'LINEAR_API_KEY', label: '…', secret: true }]`,
   `help`. The engine (`registry.js`) is tool-blind and loads whatever the
   catalog lists; the Connections page, the planner, and the hub agenda all
   pick it up automatically — zero UI change, zero route change.
4. **Verify read-only + secret-free**: the module contains no POST/PUT/PATCH/
   DELETE to the tool, and `grep` shows the key name only ever flows into
   `readEnvKey(...)`.
5. Restart the cockpit (or just reload — connectors are constructed per
   request) and check the hub's "Today" panel / `GET /api/cockpit/agenda`.

## Filtering "assigned to me"

Most APIs need an identity to filter by. Prefer endpoints that scope by token
owner ("my tasks", `/me`). If the API needs an explicit user id, resolve it
once per fetch from the token (e.g. `GET /me`) — never hardcode it, never ask
the user to paste ids you can derive.


## Known OAuth-only tools (don't fake these with a key field)

Some tools have no simple API key: **Outlook / Microsoft 365** (Graph API,
OAuth2 — the device-code flow works for a local app but needs an Azure app
registration) and **Gmail's full API** (the bundled `email:starred` connector
sidesteps this via IMAP + an app password instead). If the user asks for one
of these, say so honestly, propose the device-code-flow build as a bigger
step, and store any resulting refresh token through the same key vault.
