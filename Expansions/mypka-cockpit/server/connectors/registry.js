// connectors/registry.js — the TOOL-BLIND connector engine.
//
// This file names no tool. The catalog (catalog.json, pure data) declares which
// connectors exist; each entry points at a module file in THIS folder and a
// factory export. The engine loads them once at boot, then enables each entry
// IFF its required .env key(s) resolve:
//   * Absent key → connector simply not active → its cards don't appear →
//     NO error (the calm not-connected posture is structural, not a branch).
//
// HOW A USER CONNECTS A TOOL (the accessible path):
//   1. They paste the tool's credential into the cockpit's Connections page
//      (#/connections) — the server stores it in `Team Knowledge/.env` (0600).
//   2. The catalog entry whose keys now resolve activates on the next load.
//
// HOW AN LLM ASSISTANT ADDS A BRAND-NEW TOOL:
//   1. The user stores the tool's key first via the Connections page — the
//      assistant only ever knows the KEY NAME, referenced via readEnvKey().
//   2. The assistant writes ONE connector module in this folder following
//      README.md (normalized, secret-free, read-only, never-throw).
//   3. The assistant appends ONE entry to catalog.json (id, label, kind,
//      category, module, factory, keys, help) and the user restarts the
//      cockpit. Zero engine change, zero UI change, zero route change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasEnv } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(__dirname, 'catalog.json');

// ---- MASTER FEATURE GATE (disabled by default) ------------------------------
// The bundled connectors (Todoist / ClickUp / iCal / IMAP-starred) ship as inert
// EXAMPLE source so the user's LLM can study and adapt the pattern. They DO NOT
// activate on a fresh install. The whole connector group is gated behind a single
// env switch, OFF by default:
//
//   CONNECTORS_ENABLED=1   → load the catalog + activate any connector whose keys resolve
//   (unset / anything else) → load NOTHING; the engine is dormant, no module evaluated
//
// Even with the group enabled, an individual connector still only activates when
// its .env key(s) resolve (the original calm not-connected posture). So a fresh
// install with CONNECTORS_ENABLED=1 but no keys is still inert — the flag just
// admits the example modules into the loader at all. Documented in .env.example.
const CONNECTORS_ENABLED = process.env.CONNECTORS_ENABLED === '1';

// Module filenames must be plain basenames inside THIS folder — the catalog can
// never reach outside the connectors directory.
const MODULE_RE = /^[a-zA-Z0-9_-]+\.js$/;
const ID_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

function readCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    return Array.isArray(raw?.connectors) ? raw.connectors : [];
  } catch (err) {
    console.error(`  connectors: catalog.json unreadable (${err.message}) — no connectors active.`);
    return [];
  }
}

// Load every catalog entry's factory ONCE at boot (top-level await — Node 20+).
// A broken entry is skipped with a one-line warning; it never takes the engine
// down. Adding a new connector module therefore needs a cockpit restart — keys,
// by contrast, activate without one (checked per call).
//
// When CONNECTORS_ENABLED !== '1' the loop is skipped entirely: no example
// connector module is imported or evaluated, ENTRIES stays empty, and every
// public function below returns the dormant shape. This is the fresh-install
// default — the cockpit boots clean with zero connectors active.
const ENTRIES = [];
if (CONNECTORS_ENABLED) for (const raw of readCatalog()) {
  const where = `catalog entry '${raw?.id ?? '?'}'`;
  if (!raw || typeof raw !== 'object'
    || typeof raw.id !== 'string' || !ID_RE.test(raw.id)
    || (raw.kind !== 'task' && raw.kind !== 'calendar')
    || typeof raw.module !== 'string' || !MODULE_RE.test(raw.module)
    || typeof raw.factory !== 'string' || !/^[a-zA-Z0-9_]+$/.test(raw.factory)
    || !Array.isArray(raw.keys) || raw.keys.length === 0) {
    console.error(`  connectors: ${where} malformed — skipped.`);
    continue;
  }
  try {
    const mod = await import(`./${raw.module}`);
    const factory = mod[raw.factory];
    if (typeof factory !== 'function') {
      console.error(`  connectors: ${where} — ${raw.module} has no export '${raw.factory}' — skipped.`);
      continue;
    }
    ENTRIES.push({
      id: raw.id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.id,
      kind: raw.kind,
      category: typeof raw.category === 'string' ? raw.category
        : (raw.kind === 'calendar' ? 'calendar' : 'tasks'),
      help: typeof raw.help === 'string' ? raw.help : '',
      keys: raw.keys
        .filter((k) => k && typeof k.key === 'string')
        .map((k) => ({
          key: k.key,
          label: typeof k.label === 'string' ? k.label : k.key,
          secret: k.secret !== false,
        })),
      make: () => factory(raw.options || undefined),
    });
  } catch (err) {
    console.error(`  connectors: ${where} failed to load (${err.message}) — skipped.`);
  }
}

function entryConfigured(entry) {
  return entry.keys.every((k) => hasEnv(k.key));
}

/**
 * loadConnectors() → Connector[]
 *   Every catalog connector whose required .env keys are ALL present.
 *   Constructed fresh per call (cheap), so a key saved via the Connections
 *   page activates on the next load without a restart.
 */
export function loadConnectors() {
  const out = [];
  for (const entry of ENTRIES) {
    if (entryConfigured(entry)) out.push(entry.make());
  }
  return out;
}

/**
 * describeRegistry() → secret-free metadata for the Connections page: every
 * catalog connector (configured or not) with per-key configured flags.
 * NEVER carries a value — only key names and booleans.
 */
export function describeRegistry() {
  return ENTRIES.map((e) => ({
    id: e.id,
    label: e.label,
    kind: e.kind,
    category: e.category,
    help: e.help,
    configured: entryConfigured(e),
    keys: e.keys.map((k) => ({ ...k, configured: hasEnv(k.key) })),
  }));
}

/** Active calendar connectors. */
export function calendarConnectors() {
  return loadConnectors().filter((c) => c.kind === 'calendar');
}

/** Active task connectors. */
export function taskConnectors() {
  return loadConnectors().filter((c) => c.kind === 'task');
}

/** Display label for a connector id (falls back to the id itself). */
export function labelForSource(id) {
  return ENTRIES.find((e) => e.id === id)?.label ?? id;
}

/** The set of active source ids — any write-path validator's allow-list. */
export function registeredSourceIds() {
  return new Set(loadConnectors().map((c) => c.id));
}

/**
 * True iff the master connector gate (CONNECTORS_ENABLED=1) is on. When false the
 * engine is fully dormant (no example module loaded). Lets a UI/diagnostic surface
 * explain WHY no connectors appear ("set CONNECTORS_ENABLED=1") without inferring
 * it from an empty list. Carries no secret.
 */
export function connectorsEnabled() {
  return CONNECTORS_ENABLED;
}
