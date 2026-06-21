// repoRoot.js — the ONE place the cockpit decides where the myPKA scaffold root is.
//
// WHY THIS EXISTS
//   Every server + connector module needs the scaffold root (to find mypka.db,
//   Team Knowledge/.env, PKM/, Deliverables/). Historically each module computed
//   it positionally with `path.resolve(__dirname, '..', '..', '..')` — which is
//   brittle: it hard-codes "the cockpit sits exactly at Expansions/mypka-cockpit/"
//   AND it differs by caller depth (server/*.js is 3 up; server/connectors/*.js is
//   4 up). A relocated cockpit, a symlinked install, or a connector added one level
//   deeper silently resolved to the wrong directory. This module replaces all of
//   that with ONE resolver every caller imports.
//
// RENAME-PROOF BY DESIGN
//   The cockpit installs INSIDE the scaffold (`<root>/Expansions/mypka-cockpit/`),
//   so its position RELATIVE to the root never changes — even if the user renames
//   the root folder. Resolution is therefore RELATIVE-FIRST: it is anchored to this
//   module's own location (`__dirname` → COCKPIT_ROOT) and walks UP. Renaming the
//   root dir leaves every relative step intact, so REPO_ROOT keeps resolving.
//   Nothing downstream stores an absolute root; every path is re-derived at runtime
//   from REPO_ROOT, which itself comes from this relative walk.
//
// RESOLUTION ORDER (first match wins) — also documented in .env.example:
//   1. RELATIVE upward search from the COCKPIT ROOT for the scaffold fingerprint:
//      a directory that contains BOTH `AGENTS.md` AND a `PKM/` directory. That
//      pair is the scaffold's fingerprint and is present from day one (unlike
//      mypka.db, which does not exist until the first regen). A directory that
//      has a `mypka.db` is accepted as a SECONDARY marker if the primary pair is
//      never found, since a generated DB also reliably marks the root. This is
//      the DEFAULT for a normal install and is rename-proof (relative to __dirname).
//   2. RELATIVE fallback: three levels up from the cockpit root — the documented
//      `Expansions/mypka-cockpit/` happy path. Also rename-proof (relative).
//   3. MYPKA_ROOT env var — OPTIONAL, absolute, and consulted ONLY as an escape
//      hatch for the NON-STANDARD case where the cockpit is installed OUTSIDE the
//      scaffold (another volume, CI, tests). It is NOT baked into .env on a normal
//      install, precisely because an absolute path goes STALE when the root folder
//      is renamed. A normal in-scaffold install leaves it unset and relies on (1).
//
// STALE-OVERRIDE SAFETY: if MYPKA_ROOT is set but no longer points at a real
//   directory (e.g. it was baked in by an older install and the folder was then
//   renamed/moved), we DO NOT fail — we log once and fall back to the relative
//   resolution (1)→(2), which is still correct. The relative walk is the backstop.
//
// All callers get the SAME answer because resolution is anchored to the cockpit
// root (the folder holding package.json / this server/ dir), NOT to each caller's
// own __dirname. Connectors that live deeper no longer need a different `..` count.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The cockpit root = the parent of this server/ directory (i.e. the folder that
// holds package.json, server/, web/, scripts/). Anchoring here means a connector
// nested at server/connectors/ resolves identically to a top-level server module.
const COCKPIT_ROOT = path.resolve(__dirname, '..');

// Primary scaffold fingerprint: AGENTS.md + PKM/ in the same directory. Present
// from the very first scaffold checkout (mypka.db is not — it is generated later).
function isScaffoldRoot(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, 'AGENTS.md')) &&
      fs.statSync(path.join(dir, 'PKM')).isDirectory()
    );
  } catch {
    return false;
  }
}

// Secondary marker: a generated mypka.db. Weaker than the AGENTS.md+PKM/ pair
// (a stray .db elsewhere could false-positive), so it is only consulted as a
// fallback during the same upward walk.
function hasDb(dir) {
  try {
    return fs.statSync(path.join(dir, 'mypka.db')).isFile();
  } catch {
    return false;
  }
}

// Walk from `start` up to the filesystem root, returning the first directory that
// satisfies `predicate`, or null. Bounded by the filesystem (path.dirname becomes
// a fixed point at the root), so it always terminates.
function searchUpward(start, predicate) {
  let dir = start;
  // Guard against a pathological symlink loop: a hard cap well above any real
  // directory nesting. The natural terminator is dir === parent at the FS root.
  for (let i = 0; i < 64; i++) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveRelativeRoot() {
  // RELATIVE, rename-proof resolution — anchored to COCKPIT_ROOT (this module's
  // own location), never to a stored absolute. Survives a root-folder rename.
  // (1) scaffold fingerprint (primary), (2) generated mypka.db (secondary), then
  // (3) the documented Expansions/mypka-cockpit/ three-up fallback.
  const byFingerprint = searchUpward(COCKPIT_ROOT, isScaffoldRoot);
  if (byFingerprint) return byFingerprint;
  const byDb = searchUpward(COCKPIT_ROOT, hasDb);
  if (byDb) return byDb;
  return path.resolve(COCKPIT_ROOT, '..', '..');
}

function resolveRepoRoot() {
  // OPTIONAL absolute override — ONLY for the non-standard "cockpit installed
  // OUTSIDE the scaffold" case. A normal in-scaffold install leaves this UNSET and
  // uses the rename-proof relative walk below. We honor it only when it points at a
  // real directory; if it is set but STALE (e.g. baked in by an older install, then
  // the root was renamed), we ignore it and fall back to relative resolution — the
  // relative walk is the backstop, so a rename never breaks the cockpit.
  const fromEnv = process.env.MYPKA_ROOT;
  if (fromEnv && String(fromEnv).trim()) {
    const abs = path.resolve(String(fromEnv).trim());
    try {
      if (fs.statSync(abs).isDirectory()) return abs;
    } catch {
      /* MYPKA_ROOT points nowhere real — fall through to relative discovery. */
    }
    console.error(
      `  repoRoot: MYPKA_ROOT="${fromEnv}" is not a directory (stale after a rename/move?) ` +
      `— ignoring it and resolving the scaffold root RELATIVE to the cockpit's own location.`
    );
  }

  // DEFAULT: rename-proof relative resolution.
  return resolveRelativeRoot();
}

// Resolved ONCE at module load and frozen for the process lifetime. Importers get
// a stable value; nothing recomputes per call.
export const REPO_ROOT = resolveRepoRoot();
export { COCKPIT_ROOT };
export default REPO_ROOT;
