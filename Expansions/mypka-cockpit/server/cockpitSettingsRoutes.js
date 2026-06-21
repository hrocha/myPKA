// cockpitSettingsRoutes.js — the runtime Hub-module-toggle API surface.
//
// Wires the Settings page's read + write onto the cockpit's Express app.
// Persistence is delegated VERBATIM to cockpitSettingsDb.js (KNOWN_MODULES,
// getModulePrefs, setModulePrefs) — this module re-implements none of it and
// never touches db.js or mypka.db.
//
// ENDPOINTS
//   GET /api/cockpit/settings    read-only — current module prefs + the catalogue
//   PUT /api/cockpit/settings    WRITE — set a partial { modules: { key: bool } } map
//
// WRITE-PATH GUARD (HARD): the PUT reuses the cockpit's EXACT write guard stack
// passed in from server.js — sessionOrLoopback → localWriteGuard → a scoped JSON
// parser → a strict scope-locked validator. This matches how plannerRoutes.js
// reuses the same instances (no re-implementation, no drift).
//
// READ is always on (a single-user local cockpit reading its own UI prefs).
// There is NO env dormancy flag here: unlike the planner's PLAN_WRITE_ENABLED
// (which could in principle reach a source tool), this write touches ONLY the
// cockpit-local module_prefs table — it cannot affect canonical markdown or
// mypka.db, so it carries the same trust level as the connector key-vault write.

import {
  KNOWN_MODULES,
  KNOWN_KEY_LIST,
  getModuleSettings,
  setModulePrefs,
  setModuleOrder,
  isKnownModuleKey,
} from './cockpitSettingsDb.js';

export function registerCockpitSettingsRoutes(app, deps) {
  const { safe, sessionOrLoopback, localWriteGuard } = deps;
  // Scoped parser — the body is tiny ({ modules?: {…}, order?: [...] }); cap hard.
  const settingsJson = deps.express.json({ limit: '8kb' });

  // READ — current prefs (enabled map + saved order) + the catalogue the
  // Settings page renders. `order` is the known keys in display order.
  app.get('/api/cockpit/settings', safe(() => {
    const { modules, order } = getModuleSettings();
    return { modules, order, catalogue: KNOWN_MODULES };
  }));

  // WRITE — body { modules?: { [key]: boolean }, order?: string[] }. At least one
  // of the two must be present. `modules` patches visibility; `order` replaces the
  // display order (must be a permutation of the known set). They are independent:
  // a reorder never changes enabled, a toggle never changes order.
  app.put('/api/cockpit/settings', sessionOrLoopback, localWriteGuard, settingsJson, (req, res) => {
    const v = validateSettingsBody(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    try {
      let settings = getModuleSettings();
      if (v.modules) settings = setModulePrefs(v.modules);
      if (v.order) settings = setModuleOrder(v.order);
      return res.json({ ok: true, modules: settings.modules, order: settings.order, catalogue: KNOWN_MODULES });
    } catch (err) {
      console.error('[PUT /api/cockpit/settings]', err.message);
      return res.status(500).json({ ok: false, error: 'settings write failed' });
    }
  });
}

// Scope-locked validator: body must be { modules?: {...}, order?: [...] }, with
// at least one present. Unknown top-level keys, unknown module keys, and any
// `order` that is not an exact permutation of the known set are rejected with a
// clean 400 — never silently dropped, so a malformed client surfaces the bug.
function validateSettingsBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }
  const allowed = new Set(['modules', 'order']);
  const extras = Object.keys(body).filter((k) => !allowed.has(k));
  if (extras.length) return { error: `unexpected field(s): ${extras.join(', ')}` };

  const hasModules = Object.prototype.hasOwnProperty.call(body, 'modules');
  const hasOrder = Object.prototype.hasOwnProperty.call(body, 'order');
  if (!hasModules && !hasOrder) {
    return { error: 'body must contain "modules" and/or "order"' };
  }

  const out = {};

  if (hasModules) {
    const modules = body.modules;
    if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) {
      return { error: 'modules must be an object keyed by module id' };
    }
    const entries = Object.entries(modules);
    if (entries.length === 0) return { error: 'modules must contain at least one key' };
    for (const [key, val] of entries) {
      if (!isKnownModuleKey(key)) return { error: `unknown module key: ${key}` };
      if (typeof val !== 'boolean') return { error: `modules.${key} must be a boolean` };
    }
    out.modules = modules;
  }

  if (hasOrder) {
    const order = body.order;
    if (!Array.isArray(order)) return { error: 'order must be an array of module keys' };
    // Must be an EXACT permutation of the known set: same length, no unknowns,
    // no duplicates, no missing keys.
    if (order.length !== KNOWN_KEY_LIST.length) {
      return { error: `order must list all ${KNOWN_KEY_LIST.length} modules exactly once` };
    }
    const seen = new Set();
    for (const key of order) {
      if (!isKnownModuleKey(key)) return { error: `unknown module key in order: ${key}` };
      if (seen.has(key)) return { error: `duplicate module key in order: ${key}` };
      seen.add(key);
    }
    // length === known length + no dup + all known ⇒ every known key present.
    out.order = order;
  }

  return out;
}
