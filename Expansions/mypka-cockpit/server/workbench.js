// workbench.js — filesystem-backed reads + (P2) gated writes for the Cockpit
// "Workbench" outliner.
//
// SCOPE.
//   P1 (reads, always on — no flag):
//     listWorkbenchDocs()      → [{ slug, title, mtime, bytes }] sorted mtime desc
//     readWorkbenchDoc(slug)   → { slug, title, markdown, mtime }
//   P2 (writes — the cockpit's FIRST write to real PKM markdown; ships DORMANT
//       behind WORKBENCH_WRITE_ENABLED=1, default OFF; server.js owns the gate):
//     createWorkbenchDoc(title, markdown?)   → { ok:'created', slug, title, mtime }
//                                              | { ok:'bad-title' } | { ok:'reserved' }
//                                              | { ok:'collision' }
//     saveWorkbenchDoc(slug, markdown, baseMtime?) → { ok:'saved', slug, mtime }
//                                              | { ok:'bad' } | { ok:'missing' }
//                                              | { ok:'stale', mtime }
//
// PRECONDITION MECHANISM (Vex W-2 optimistic concurrency): baseMtime in integer
// MILLISECONDS, the exact value the P1 read returned (stat.mtimeMs, floored). On
// save the server re-stats the file and compares floored mtimeMs for STRICT
// equality. Any drift (the user edited the same note in Obsidian under the editor) →
// { ok:'stale' } → 412. baseMtime is OPTIONAL: omitting it is an explicit
// last-write-wins override (the UI only omits it on a deliberate "overwrite
// anyway"). Chosen over a content-hash If-Match because the read already hands
// the client an mtime to echo back, and the comparison costs one stat() rather
// than re-hashing the whole document on every save — simpler and correct for a
// single-user loopback editor.
//
// WHY A SEPARATE MODULE (not db.js): Workbench is INTENTIONALLY excluded from
// mypka.db (Silas §6 of the plan — free-form, no-frontmatter, graph-excluded
// docs are not graph nodes). So we read the filesystem directly and keep ZERO
// dependency on the read-only DB layer. db.js is untouched and unimported.
//
// CONTAINMENT (Vex §7 CRITICAL, narrowed from server.js's containedPkmPath to
// PKM/Fleeting Notes/ only): every slug is whitelisted BEFORE any FS call, then the
// resolved absolute path is re-checked against the realpath of the Workbench
// jail via path.relative() (never a string prefix). Symlink targets that escape
// the jail are rejected. README.md is a RESERVED name — never listed, never
// served as a user doc (it is the governing no-touch contract for the folder).
//
// Builtins only (fs / path / url). No new dependency.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// REPO_ROOT comes from the shared resolver (repoRoot.js) — Workbench carries no
// DB coupling. __dirname is still used below for the cockpit-relative audit dir.
import { REPO_ROOT } from './repoRoot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKBENCH_DIR = path.resolve(REPO_ROOT, 'PKM', 'Fleeting Notes');
export { WORKBENCH_DIR as NOTES_DIR };

// The ONE permitted subfolder under the Workbench jail (Vex §3 of the image-
// attachment build). Markdown stays flat in WORKBENCH_DIR (no separators allowed
// in a slug); binaries land here and ONLY here. The folder name is a literal
// constant — it is never derived from any request input.
const ATTACHMENTS_SUBDIR = '_attachments';
const ATTACHMENTS_DIR = path.resolve(WORKBENCH_DIR, ATTACHMENTS_SUBDIR);

// Slug whitelist (Vex §7): lowercase alphanumeric start, then a-z/0-9/hyphen,
// total length 1..80. Anything with a path separator, dot, NUL, traversal token,
// uppercase, or leading hyphen fails this and never reaches an FS call.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

// Reserved basenames (without extension). README is the folder's governing
// contract — it is never a user doc, never listed, never served by slug, never
// created/overwritten. The remainder are Windows OS-reserved device names: even
// though the runtime is macOS today, the markdown notes are meant to be portable
// (Obsidian/Logseq on any OS, synced drives), so a doc named `con.md` or `aux.md`
// would be unopenable on Windows. Reject at the source. Matched case-insensitively
// (the slug is already lowercased by the charset gate, so a plain Set lookup is
// sufficient, but we keep the canonical lowercased forms here for clarity).
const RESERVED_SLUGS = new Set([
  'readme',
  // Windows reserved device names (with or without an extension are reserved):
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Independent content-byte cap (Vex HIGH — distinct from the request-body parser
// limit in server.js). Even a well-formed 256 KB request is rejected at the
// module edge if its markdown payload exceeds this, returning a 413 upstream.
export const MAX_CONTENT_BYTES = 200 * 1024; // 200 KB

// Temp-file prefix used by atomic writes. The leading dot + this charset are
// chosen so a half-written temp NEVER matches SLUG_RE (leading dot fails the
// `^[a-z0-9]` start), and therefore never appears in listWorkbenchDocs() nor is
// addressable as a slug. (`listWorkbenchDocs` also only counts files ending in
// `.md`; temps end in `.tmp`.)
const TMP_PREFIX = '.wbtmp-';

// --- containment -----------------------------------------------------------
// Resolve a slug to its absolute on-disk path INSIDE the Workbench jail, or
// return null if it is not a safe, contained, non-symlink-escaping file path.
// Pure path math + an lstat symlink check; performs no read of file content.
function containedWorkbenchPath(slug) {
  // 1. Whitelist the slug BEFORE touching the filesystem (Vex: reject pre-FS).
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  if (RESERVED_SLUGS.has(slug)) return null;

  // 2. Force the .md extension; the slug itself can carry no separator/dot.
  const filename = `${slug}.md`;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null;
  if (filename.includes(path.sep)) return null;

  const abs = path.resolve(WORKBENCH_DIR, filename);

  // 3. realpath-anchored jail via path.relative() — NOT a string prefix (a
  //    sibling like PKM/Fleeting Notes-secrets/ would fool startsWith). The jail
  //    anchor is the realpath of WORKBENCH_DIR so a symlinked Workbench dir
  //    still resolves correctly. We anchor on the *resolved* jail and compare
  //    the *resolved* candidate (resolving the candidate also dereferences a
  //    symlinked file, so a symlink pointing outside escapes the relative check
  //    and is rejected here).
  let jailReal;
  try {
    jailReal = fs.realpathSync(WORKBENCH_DIR);
  } catch {
    return null; // jail dir missing → calm-degrade upstream, no path served
  }

  // Resolve the candidate's real path only if it exists; for a non-existent
  // file realpathSync throws, so fall back to the lexically-resolved abs (which
  // is already inside the jail by construction) and let the caller 404.
  let candidateReal = abs;
  if (fs.existsSync(abs)) {
    try {
      candidateReal = fs.realpathSync(abs);
    } catch {
      return null;
    }
    // Reject a symlink whose target escapes the jail.
    const rel = path.relative(jailReal, candidateReal);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return null;
    }
  } else {
    // Non-existent: confirm the lexical path is inside the jail (flat, no nesting).
    const rel = path.relative(jailReal, path.resolve(jailReal, filename));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return null;
    }
  }

  return abs;
}

// --- title derivation ------------------------------------------------------
// Title = first `# H1` line if present, else first non-empty line/bullet,
// else the slug. Bullet/heading markers are stripped for display.
function deriveTitle(markdown, slug) {
  const lines = markdown.split(/\r?\n/);
  // THE FIRST NON-EMPTY LINE IS THE TITLE — owner's rule. Plain text and
  // `# Heading` rank equally; markdown markers are stripped for display only.
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const stripped = t
      .replace(/^[-*+]\s+/, '')        // bullet
      .replace(/^\[[ xX]\]\s+/, '')    // bare checkbox after bullet strip
      .replace(/^#+\s+/, '')           // stray heading markers (non-H1)
      .trim();
    if (stripped) return stripped;
  }
  return slug;
}

// --- slugify ---------------------------------------------------------------
// Turn a human title into a filesystem slug:
//   NFKD normalize → strip combining accents → lowercase → non-[a-z0-9] → '-'
//   → collapse runs of '-' → trim leading/trailing '-' → cap at 80 chars
//   → trim a trailing '-' the cap might have left.
// Returns '' for an empty/all-punctuation title (caller maps to 400). The output
// is GUARANTEED to satisfy SLUG_RE when non-empty: it starts with [a-z0-9]
// (leading hyphens are trimmed) and contains only [a-z0-9-], length 1..80.
export function slugifyTitle(title) {
  if (typeof title !== 'string') return '';
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // any run of non-alnum → single hyphen
    .replace(/-+/g, '-')             // collapse (defensive; the run-collapse above mostly handles it)
    .replace(/^-+/, '')              // trim leading hyphens (so result starts [a-z0-9])
    .replace(/-+$/, '')              // trim trailing hyphens
    .slice(0, 80)
    .replace(/-+$/, '');             // a mid-hyphen could now be trailing after the cut
  return slug;
}

// --- audit log (Vex X-3) ----------------------------------------------------
// Append ONE record per successful write to a cockpit-local, month-bucketed
// audit log. Mirrors social.js's decision-queue pattern (one JSON line/record,
// no external call, no credentials). NEVER logs note content — only op, slug,
// byte count, a sha256 fingerprint, timestamp, source. Co-located with the
// cockpit (NOT under PKM/, NOT in mypka.db). Best-effort: an audit-write failure
// must never fail or roll back the (already-committed) note write, so it is
// caught and swallowed with a console.error — the note is canonical, the audit
// is a side record.
const AUDIT_DIR = path.resolve(__dirname, '..', 'workbench-audit');

function appendAuditRecord(record) {
  try {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const file = path.join(AUDIT_DIR, `workbench-writes-${ym}.log`);
    // One JSON object per line (JSONL) — append-only, easy to tail/audit.
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (err) {
    // The note is already on disk; the audit record is a side effect. Surface
    // the failure to the operator log but never propagate it to the caller.
    console.error('[workbench audit] failed to append record:', err.message);
  }
}

// --- atomic write (Vex W-1) -------------------------------------------------
// Write `content` to `targetAbs` atomically: a per-write temp file in the SAME
// directory (so rename is atomic on the same filesystem), 0600, fsync'd, then
// renamed over the target. `exclusive:true` (create) refuses to clobber an
// existing target; `exclusive:false` (save) replaces in place. A partial/failed
// write leaves the original note UNTOUCHED — the temp is cleaned up and the
// error rethrown.
//   Returns the post-rename stat (for mtime). Throws on any I/O failure; the
//   caller maps create-collision (EEXIST) to 409 separately via a pre-check.
function atomicWrite(targetAbs, content, { exclusive }) {
  const dir = path.dirname(targetAbs);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpAbs = path.join(dir, `${TMP_PREFIX}${process.pid}-${rand}.tmp`);

  let fd;
  try {
    // wx on the TEMP guarantees we never collide with another in-flight write's
    // temp (random suffix makes that astronomically unlikely anyway).
    fd = fs.openSync(tmpAbs, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);        // durability: bytes hit disk before the rename
    fs.closeSync(fd);
    fd = undefined;

    if (exclusive) {
      // CREATE: never clobber. We already pre-checked existence in the caller,
      // but re-confirm here at the last moment to shrink the TOCTOU window. If
      // the target appeared between the pre-check and now, abort (the caller
      // surfaces 409). rename() would otherwise silently overwrite.
      if (fs.existsSync(targetAbs)) {
        const e = new Error('target exists'); e.code = 'EEXIST'; throw e;
      }
    }
    fs.renameSync(tmpAbs, targetAbs); // atomic publish (same dir / same fs)
    return fs.statSync(targetAbs);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } }
    // Clean up a leftover temp on any failure path (rename consumes it on success).
    try { if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs); } catch { /* noop */ }
  }
}

// Re-confirm containment of an absolute path by realpath, used right before a
// write opens/replaces a target. For a NON-existent target (create) the parent
// jail's realpath is the anchor; for an existing target (save) we resolve the
// target itself and reject a symlink/non-regular-file. Returns true if safe.
function reconfirmContained(targetAbs, { mustNotExist }) {
  let jailReal;
  try {
    jailReal = fs.realpathSync(WORKBENCH_DIR);
  } catch {
    return false; // jail missing → refuse to write
  }
  if (fs.existsSync(targetAbs)) {
    if (mustNotExist) return false; // create path: someone created it under us
    // Reject anything that is not a plain regular file (symlink, dir, fifo, …).
    let lst;
    try { lst = fs.lstatSync(targetAbs); } catch { return false; }
    if (lst.isSymbolicLink() || !lst.isFile()) return false;
    let real;
    try { real = fs.realpathSync(targetAbs); } catch { return false; }
    const rel = path.relative(jailReal, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return false;
    return true;
  }
  // Non-existent target: confirm the lexical path sits flat inside the jail.
  const rel = path.relative(jailReal, targetAbs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return false;
  return true;
}

// --- public API ------------------------------------------------------------

// List Workbench docs, newest first. Excludes README.md and anything that is
// not a top-level .md file (flat folder by design). Never throws on a missing
// dir — returns [] so the route can calm-degrade.
export function listWorkbenchDocs() {
  let entries;
  try {
    entries = fs.readdirSync(WORKBENCH_DIR, { withFileTypes: true });
  } catch {
    return null; // signal "dir missing/unreadable" to the route (calm degrade)
  }

  const docs = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (!name.toLowerCase().endsWith('.md')) continue;

    const slug = name.slice(0, -3); // strip ".md"
    // Apply the SAME whitelist + reserved-name exclusion to listing as to reads.
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) continue;

    const abs = path.join(WORKBENCH_DIR, name);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let markdown = '';
    try {
      markdown = fs.readFileSync(abs, 'utf8');
    } catch {
      // Unreadable file: still list it with the slug as title, byte count from stat.
      markdown = '';
    }

    docs.push({
      slug,
      title: deriveTitle(markdown, slug),
      mtime: stat.mtimeMs,
      bytes: stat.size,
    });
  }

  docs.sort((a, b) => b.mtime - a.mtime);
  return docs;
}

// Read a single Workbench doc by slug. Returns:
//   { ok: 'bad' }                       — slug failed the whitelist/reserved gate (→ 400)
//   { ok: 'missing' }                   — contained but no such file (→ 404)
//   { slug, title, markdown, mtime }    — success
export function readWorkbenchDoc(slug) {
  const abs = containedWorkbenchPath(slug);
  if (!abs) return { ok: 'bad' };

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: 'missing' };
  }
  if (!stat.isFile()) return { ok: 'missing' };

  let markdown;
  try {
    markdown = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: 'missing' };
  }

  return {
    slug,
    title: deriveTitle(markdown, slug),
    markdown,
    mtime: stat.mtimeMs,
  };
}

// --- writes (P2, gated upstream by WORKBENCH_WRITE_ENABLED) -----------------

// Create a NEW Workbench doc from a human title. Slugifies the title, refuses
// empty/reserved slugs, refuses collisions (no silent auto-suffix), then writes
// atomically with exclusive (never-clobber) semantics.
// Returns one of:
//   { ok:'bad-title' }                         — empty after slugify (→ 400)
//   { ok:'reserved' }                          — resolves to a reserved name (→ 400)
//   { ok:'too-large' }                         — markdown over the content cap (→ 413)
//   { ok:'collision', slug }                   — a doc with that slug exists (→ 409)
//   { ok:'created', slug, title, mtime }       — success (→ 201)
export function createWorkbenchDoc(title, markdown = '') {
  // Vex hardening (2026-06-09): reject a title that is *literally a path* BEFORE
  // slugify silently sanitizes it. Without this, `../../etc/passwd` slugifies to
  // `etc-passwd` and a note gets created (in-jail — no escape — but the hostile
  // input is masked into an accepted doc rather than refused). A path separator,
  // traversal token, or NUL in a title is never a legitimate human title; refuse
  // it loudly. Punctuation-rich real titles (e.g. "Café Notes!!") are unaffected —
  // they carry no separator and continue to slugify normally.
  if (typeof title === 'string' &&
      (title.includes('/') || title.includes('\\') || title.includes('\0') ||
       /(^|[\\/])\.\.([\\/]|$)/.test(title))) {
    return { ok: 'bad-title' };
  }

  const slug = slugifyTitle(title);
  if (!slug || !SLUG_RE.test(slug)) return { ok: 'bad-title' };
  if (RESERVED_SLUGS.has(slug)) return { ok: 'reserved' };

  const body = typeof markdown === 'string' ? markdown : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) return { ok: 'too-large' };

  // containedWorkbenchPath whitelists the slug AND rejects symlink-escape; for a
  // brand-new doc the file won't exist yet, so it returns the lexical in-jail abs.
  const abs = containedWorkbenchPath(slug);
  if (!abs) return { ok: 'bad-title' }; // belt-and-braces; slug already passed SLUG_RE

  // Collision check: no silent auto-suffix. A pre-existing file (regular OR a
  // symlink/dir squatting on the name) is a 409 — we never overwrite on create.
  if (fs.existsSync(abs)) return { ok: 'collision', slug };

  // Re-confirm containment immediately before the write (must NOT exist).
  if (!reconfirmContained(abs, { mustNotExist: true })) return { ok: 'collision', slug };

  let stat;
  try {
    stat = atomicWrite(abs, body, { exclusive: true });
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: 'collision', slug };
    throw err; // genuine I/O failure → caller maps to 500
  }

  appendAuditRecord({
    op: 'create',
    slug,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    ts: new Date().toISOString(),
    source: 'cockpit',
  });

  return { ok: 'created', slug, title: deriveTitle(body, slug), mtime: stat.mtimeMs };
}

// Save (full-document overwrite) an EXISTING Workbench doc. Enforces the
// optimistic-concurrency precondition: if `baseMtime` is provided and the file's
// current floored mtimeMs differs, the file changed under the editor → 'stale'.
// Returns one of:
//   { ok:'bad' }                       — slug failed whitelist/reserved (→ 400)
//   { ok:'too-large' }                 — markdown over the content cap (→ 413)
//   { ok:'missing' }                   — no such doc to overwrite (→ 404)
//   { ok:'stale', mtime }              — baseMtime mismatch (→ 412)
//   { ok:'saved', slug, mtime }        — success (→ 200)
export function saveWorkbenchDoc(slug, markdown, baseMtime) {
  const abs = containedWorkbenchPath(slug);
  if (!abs) return { ok: 'bad' };

  const body = typeof markdown === 'string' ? markdown : null;
  if (body === null) return { ok: 'bad' };
  if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) return { ok: 'too-large' };

  // Must already exist as a regular file to be a SAVE (vs a create).
  let stat;
  try { stat = fs.statSync(abs); } catch { return { ok: 'missing' }; }
  if (!stat.isFile()) return { ok: 'missing' };

  // Optimistic-concurrency precondition. Floor both sides: mtimeMs carries
  // sub-ms float noise across a JSON round-trip, and the client echoes the
  // floored integer the read returned. Equality on the floor is the contract.
  if (baseMtime !== undefined && baseMtime !== null) {
    const base = Math.floor(Number(baseMtime));
    if (!Number.isFinite(base) || Math.floor(stat.mtimeMs) !== base) {
      return { ok: 'stale', mtime: stat.mtimeMs };
    }
  }

  // Re-confirm containment + reject symlink/non-regular target right before write.
  if (!reconfirmContained(abs, { mustNotExist: false })) return { ok: 'bad' };

  const after = atomicWrite(abs, body, { exclusive: false });

  appendAuditRecord({
    op: 'save',
    slug,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    ts: new Date().toISOString(),
    source: 'cockpit',
  });

  return { ok: 'saved', slug, mtime: after.mtimeMs };
}

// Delete an EXISTING Workbench doc by slug. Same jail discipline as read/save:
// slug whitelist BEFORE any FS call, realpath-anchored containment, and a
// reconfirm-immediately-before-unlink that rejects a symlink / non-regular
// target (so a symlink dropped in under us can never make us unlink something
// outside the jail). The unlink itself is fs.unlinkSync — it removes ONLY the
// single contained .md file; it can never recurse or touch a directory.
// Returns one of:
//   { ok:'bad' }                 — slug failed whitelist/reserved (→ 400)
//   { ok:'missing' }             — no such doc to delete (→ 404)
//   { ok:'deleted', slug }       — success (→ 200)
export function deleteWorkbenchDoc(slug) {
  const abs = containedWorkbenchPath(slug);
  if (!abs) return { ok: 'bad' };

  // Must already exist as a regular file to be a DELETE.
  let stat;
  try { stat = fs.statSync(abs); } catch { return { ok: 'missing' }; }
  if (!stat.isFile()) return { ok: 'missing' };

  // Re-confirm containment + reject symlink/non-regular target right before the
  // unlink (TOCTOU close-out — identical posture to the save path).
  if (!reconfirmContained(abs, { mustNotExist: false })) return { ok: 'bad' };

  fs.unlinkSync(abs);

  appendAuditRecord({
    op: 'delete',
    slug,
    bytes: 0,
    sha256: null,
    ts: new Date().toISOString(),
    source: 'cockpit',
  });

  return { ok: 'deleted', slug };
}

// ===========================================================================
// IMAGE ATTACHMENTS (P3, gated upstream by the SAME WORKBENCH_WRITE_ENABLED flag)
// ===========================================================================
//
// The cockpit's FIRST BINARY write. The user pastes/drops a raster image into a
// Workbench bullet; the editor inserts `![](_attachments/<name>.<ext>)`. Bytes
// land under PKM/Fleeting Notes/_attachments/ ONLY — never the flat doc folder, never
// anywhere else.
//
// !!! VEX AUDIT REQUIRED BEFORE THIS IS CONSIDERED CLEARED. !!!
//   The dormancy gate is SHARED with the text-write path (WORKBENCH_WRITE_ENABLED).
//   But binary upload carries write-class risks the text path never did:
//     - content-type confusion / polyglot files (magic-byte validation below),
//     - SVG as a script-injection vector (HARD-REJECTED below — v1 exclusion),
//     - decompression / oversize (independent decoded-byte cap below),
//     - the served Content-Type must be trustworthy (derived from sniffed bytes,
//       never client MIME/extension; the serve route is /api/cockpit/file which
//       already sets a strict `default-src 'none'; img-src 'self'` CSP + nosniff).
//   Flipping WORKBENCH_WRITE_ENABLED=1 enables BOTH text writes (already audited)
//   AND this binary path (NOT yet audited). Do not treat the shared flag as
//   transitive clearance. Mirrors how the text-write path itself rolled out
//   dormant pending Vex.

// Independent decoded-byte cap (Vex HIGH — distinct from any request-body parser
// limit in server.js, and enforced on the DECODED bytes, not the base64 string
// nor Content-Length). 10 MB is a sane ceiling for a pasted screenshot/photo.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

// PDFs get a higher independent cap (scanned multi-page documents routinely
// exceed 10 MB; 20 MB is still a sane local-write ceiling). Enforced on the
// DECODED bytes, after the sniffer has established the type.
export const MAX_PDF_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

// Magic-byte (file-signature) sniffers. We NEVER trust a client-supplied MIME or
// extension — the extension we ultimately write is DERIVED from these bytes. Each
// returns the canonical extension (no dot) on a confident match, else null.
//   PNG : 89 50 4E 47 0D 0A 1A 0A
//   JPEG: FF D8 FF  (SOI + first marker)
//   GIF : "GIF87a" | "GIF89a"
//   WebP: "RIFF" .... "WEBP"  (RIFF container, WEBP fourCC at offset 8)
//   PDF : "%PDF-"  (25 50 44 46 2D — the header every conforming PDF starts with)
// SVG is INTENTIONALLY absent — it is XML, can carry <script>/onload, and is a
// known stored-XSS vector. v1 hard-rejects it (returns null → 'bad-image').
// PDF is served ONLY via /api/cockpit/file (Content-Disposition: inline +
// `default-src 'none'` CSP + nosniff), never executed in the app origin's
// script context.
function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'png';
  }
  // JPEG (SOI FF D8, then FF marker)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpg';
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return 'gif';
  }
  // WebP — RIFF container with a "WEBP" fourCC at byte 8.
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'webp';
  }
  // PDF — "%PDF-" header.
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 &&
      buf[4] === 0x2d) {
    return 'pdf';
  }
  return null; // unknown / SVG / not a type we accept
}

// Strict attachment-filename charset. The filename is GENERATED server-side
// (uuid + sniffed ext), so this is a belt-and-braces invariant check, not a
// sanitizer of hostile input: 8..40 lowercase-hex/hyphen chars + '.' + a known
// accepted extension. No path separators, no dots beyond the single extension
// dot, no traversal token can ever satisfy it.
const ATTACHMENT_NAME_RE = /^[a-f0-9-]{8,40}\.(png|jpg|gif|webp|pdf)$/;

// --- attachment containment ------------------------------------------------
// Resolve a GENERATED attachment filename to its absolute on-disk path inside the
// _attachments jail, or null if it is not a safe, contained path. Mirrors
// containedWorkbenchPath but anchors on ATTACHMENTS_DIR (exactly ONE level of
// permitted nesting under WORKBENCH_DIR) and forbids ANY further separator. Pure
// path math + realpath anchoring; reject `..`/absolute/symlink/extra nesting.
function containedAttachmentPath(filename) {
  if (typeof filename !== 'string' || !ATTACHMENT_NAME_RE.test(filename)) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null;
  if (filename.includes(path.sep)) return null;

  const abs = path.resolve(ATTACHMENTS_DIR, filename);

  // realpath-anchor on the _attachments dir (resolves a symlinked Workbench or
  // _attachments dir correctly). For a brand-new file the candidate won't exist,
  // so anchor the containment check on the parent jail's realpath.
  let jailReal;
  try {
    jailReal = fs.realpathSync(ATTACHMENTS_DIR);
  } catch {
    return null; // jail dir missing → caller creates it, then re-checks
  }

  let candidateReal = abs;
  if (fs.existsSync(abs)) {
    try {
      candidateReal = fs.realpathSync(abs);
    } catch {
      return null;
    }
    const rel = path.relative(jailReal, candidateReal);
    // Must sit DIRECTLY in _attachments (no further nesting), not be the dir
    // itself, not escape upward, not be absolute.
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return null;
    }
  } else {
    const rel = path.relative(jailReal, path.resolve(jailReal, filename));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return null;
    }
  }
  return abs;
}

// Ensure the _attachments dir exists, then realpath-confirm it sits flat inside
// the Workbench jail (defends against a symlinked _attachments pointing out of
// the jail). Returns true if safe to write into. Creating it at mode 0700 keeps
// the binaries owner-only at the directory level too.
function ensureAttachmentsDir() {
  let wbReal;
  try {
    wbReal = fs.realpathSync(WORKBENCH_DIR);
  } catch {
    return false; // Workbench jail itself missing → refuse
  }
  try {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  // Re-resolve and confirm _attachments is EXACTLY one level under the jail and
  // is a real directory (not a symlink escaping it).
  let attReal;
  try {
    attReal = fs.realpathSync(ATTACHMENTS_DIR);
  } catch {
    return false;
  }
  let lst;
  try { lst = fs.lstatSync(ATTACHMENTS_DIR); } catch { return false; }
  if (lst.isSymbolicLink() || !lst.isDirectory()) return false;
  const rel = path.relative(wbReal, attReal);
  if (rel !== ATTACHMENTS_SUBDIR) return false; // must be exactly "_attachments"
  return true;
}

// Atomic binary write: temp in the SAME dir → fsync → rename, mode 0600. Mirrors
// atomicWrite() but takes a Buffer and writes binary (no utf8 coercion). The
// generated uuid filename makes a pre-existing collision astronomically unlikely,
// but we still use `wx` on the temp and confirm the final target is absent.
function atomicWriteBinary(targetAbs, buf) {
  const dir = path.dirname(targetAbs);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpAbs = path.join(dir, `${TMP_PREFIX}${process.pid}-${rand}.tmp`);

  let fd;
  try {
    fd = fs.openSync(tmpAbs, 'wx', 0o600);
    fs.writeFileSync(fd, buf);   // Buffer → raw bytes, no encoding
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.existsSync(targetAbs)) {
      const e = new Error('target exists'); e.code = 'EEXIST'; throw e;
    }
    fs.renameSync(tmpAbs, targetAbs);
    return fs.statSync(targetAbs);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } }
    try { if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs); } catch { /* noop */ }
  }
}

// Write a Workbench image attachment from a base64 payload. The caller (server.js)
// extracts the base64 string from the JSON body { dataBase64 } (an optional data:
// URI prefix is tolerated and stripped). The client-supplied MIME/extension, if
// any, is IGNORED — the written extension is derived from sniffed magic bytes.
// Returns one of:
//   { ok:'bad-input' }                          — missing/non-string/empty base64 (→ 400)
//   { ok:'too-large' }                          — decoded bytes over MAX_ATTACHMENT_BYTES (→ 413)
//   { ok:'bad-image' }                          — magic bytes are not PNG/JPEG/GIF/WebP
//                                                 (incl. SVG, which is rejected) (→ 415)
//   { ok:'contain-fail' }                       — jail/dir containment refused the write (→ 500)
//   { ok:'collision' }                          — uuid name already taken (→ 409, ~never)
//   { ok:'written', path, filename, bytes, sha256 } — success (→ 201)
//                                                 path is the EDITOR-relative path:
//                                                 "_attachments/<name>.<ext>"
export function writeWorkbenchAttachment(dataBase64) {
  if (typeof dataBase64 !== 'string' || !dataBase64.trim()) return { ok: 'bad-input' };

  // Tolerate (and strip) a `data:<mime>;base64,` prefix if the client sent one.
  // The declared mime in the prefix is NOT trusted — only the decoded bytes are.
  let b64 = dataBase64.trim();
  const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
  if (comma !== -1) b64 = b64.slice(comma + 1);
  // Strip any whitespace/newlines a multipart-ish client may have folded in.
  b64 = b64.replace(/\s+/g, '');
  if (!b64) return { ok: 'bad-input' };
  // Reject anything that is not valid base64 alphabet (defensive; Buffer would
  // otherwise silently drop invalid chars and we'd sniff garbage).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: 'bad-input' };

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { ok: 'bad-input' };
  }
  if (!buf || buf.length === 0) return { ok: 'bad-input' };

  // Absolute size ceiling on the DECODED bytes — enforced independently of
  // Content-Length and of the parser limit, BEFORE any further work. The
  // per-type cap (10 MB images / 20 MB PDFs) follows after the sniff.
  if (buf.length > MAX_PDF_ATTACHMENT_BYTES) return { ok: 'too-large' };

  // Magic-byte validation. The extension we WRITE comes from here — never the
  // client. null ⇒ not a type we accept (SVG/unknown/polyglot) ⇒ reject.
  const ext = sniffImageExt(buf);
  if (!ext) return { ok: 'bad-image' };

  // Per-type cap: raster images keep the original 10 MB ceiling; PDFs already
  // passed their 20 MB ceiling above.
  if (ext !== 'pdf' && buf.length > MAX_ATTACHMENT_BYTES) return { ok: 'too-large' };

  // Ensure + realpath-confirm the single permitted subfolder.
  if (!ensureAttachmentsDir()) return { ok: 'contain-fail' };

  // Server-generated filename: uuid + sniffed extension. Never client-supplied.
  const filename = `${crypto.randomUUID()}.${ext}`;
  const abs = containedAttachmentPath(filename);
  if (!abs) return { ok: 'contain-fail' }; // belt-and-braces; generated name is in-charset

  if (fs.existsSync(abs)) return { ok: 'collision' }; // uuid clash — practically impossible

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  try {
    atomicWriteBinary(abs, buf);
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: 'collision' };
    throw err; // genuine I/O failure → caller maps to 500
  }

  appendAuditRecord({
    op: 'attach',
    filename,
    bytes: buf.length,
    sha256,             // fingerprint only — never the content
    ts: new Date().toISOString(),
    source: 'cockpit',
  });

  // The editor inserts `![](_attachments/<name>.<ext>)`; the cockpit serve route
  // (/api/cockpit/file) builds its URL from this relative path under PKM/Fleeting Notes/.
  return {
    ok: 'written',
    path: `${ATTACHMENTS_SUBDIR}/${filename}`,
    filename,
    bytes: buf.length,
    sha256,
  };
}

// Exported for the self-test only (so the test can exercise the sniffer + jail
// directly without an HTTP round-trip). Not part of the route contract.
export const __test = { sniffImageExt, containedAttachmentPath, ATTACHMENTS_DIR };
