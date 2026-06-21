// journalEntries.js — the cockpit's manual journal-entry WRITE + raw-entry READ
// surface (Feature #9). Backs the "+ New entry" composer at the top of /journal
// and the "Integrate" hand-off, and supplies raw (not-yet-mirrored) entries to
// the timeline so a fresh entry shows up the instant it is saved.
//
// WHY a file-layer module (and not the mirror): the cockpit reads mypka.db
// READ-ONLY (db.js opens readonly + query_only). A brand-new markdown file is
// canonical the moment it lands on disk, but it is NOT in the mirror until the
// next regen. Fleeting Notes already solves this exact problem by reading the
// note files directly off disk (workbench.js / cockpit.js searchNotes); we
// follow that established pattern: the rest of the journal stays mirror-served
// (journalFeed.js), and ONLY the raw/manual entries are read from the file
// layer here. The read-only-mirror invariant is untouched for everything else.
//
// SECURITY POSTURE (mirrors workbench.js / fleeting.js — Vex-audited):
//   * Path JAIL: every write/read is realpath-anchored to PKM/Journal/ ONLY.
//     The date-nested YYYY/MM/ folder is derived SERVER-SIDE from the entry's
//     own date (validated YYYY-MM-DD) — never from client input — so the client
//     can never steer the path. The final file path is re-confirmed inside the
//     jail (path.relative containment, no traversal, no symlink escape) right
//     before the exclusive write.
//   * Slug: derived from the title via the SAME slugify discipline as
//     workbench.js (NFKD → [a-z0-9-] → caps), then date-prefixed. Never taken
//     from the client.
//   * No YAML library on the server (the Node side never had one — the Python
//     regen owns YAML). We EMIT frontmatter ourselves with strict escaping and
//     parse only the handful of fields we authored with a minimal line reader.
//   * Writes are gated UPSTREAM by the same WORKBENCH_WRITE_ENABLED + session +
//     CSRF stack as the Fleeting-Notes write path (wired in server.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './repoRoot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The jail root: PKM/Journal/. Date-nested YYYY/MM/ folders live UNDER this and
// are the ONLY place a manual entry is ever written.
const JOURNAL_DIR = path.resolve(REPO_ROOT, 'PKM', 'Journal');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 200;
const MAX_BODY_BYTES = 200 * 1024; // 200 KB, same ceiling as a fleeting note

// ---- audit log (mirrors workbench.js appendAuditRecord) ----------------------
// Co-located cockpit-local JSONL; never logs body content — op, slug, bytes, a
// sha256 fingerprint, ts, source. Best-effort; a failure never rolls back the
// (already-committed) markdown write.
const AUDIT_DIR = path.resolve(__dirname, '..', 'workbench-audit');
function appendAuditRecord(record) {
  try {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, `journal-writes-${ym}.log`), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('[journal audit] failed to append record:', err.message);
  }
}

// ---- slugify (same algorithm as workbench.slugifyTitle) ----------------------
function slugifyTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

// ---- frontmatter EMIT (we author it; no YAML lib) ----------------------------
// title/date are scalar strings on one line each, single-quoted with the YAML
// single-quote escape (doubling). manually_added/integration_status are fixed
// safe tokens. The body is written verbatim after the closing ---.
function yamlSingleQuote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildEntryMarkdown({ title, date, body }) {
  const fm = [
    '---',
    `title: ${yamlSingleQuote(title)}`,
    `date: ${date}`,
    'manually_added: true',
    'integration_status: raw',
    '---',
    '',
  ].join('\n');
  const trimmed = String(body || '').replace(/\r\n?/g, '\n');
  return `${fm}${trimmed}${trimmed.endsWith('\n') || trimmed === '' ? '' : '\n'}`;
}

// ---- containment: resolve a date-nested entry path INSIDE the jail -----------
// monthDir = PKM/Journal/<YYYY>/<MM>/ derived from a validated date. filename =
// "<slug>.md". The candidate must resolve INSIDE the realpath of JOURNAL_DIR
// (path.relative, not startsWith) with NO escaping. Returns { monthDir, abs } or
// null. Performs no content read.
function containedEntryPath(date, slug) {
  if (!DATE_RE.test(date)) return null;
  if (!SLUG_RE.test(slug)) return null;
  const [y, m] = date.split('-');
  // y/m are pure digits from a DATE_RE match — no separators possible.
  const filename = `${slug}.md`;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0') || filename.includes(path.sep)) {
    return null;
  }

  // Anchor the candidate on the REALPATH of the jail root (resolves a symlinked
  // /tmp → /private/tmp on macOS, an iCloud-relocated PKM, etc.). Building the
  // month dir + file off the resolved jail keeps the containment math honest —
  // a lexical JOURNAL_DIR would mismatch the realpath and falsely reject.
  let jailReal;
  try {
    jailReal = fs.realpathSync(JOURNAL_DIR);
  } catch {
    // Jail root missing — we mkdir it on write; for containment math fall back
    // to the lexical jail root (the candidate is in-jail by construction).
    jailReal = JOURNAL_DIR;
  }
  const monthDir = path.resolve(jailReal, y, m);
  const abs = path.resolve(monthDir, filename);

  const rel = path.relative(jailReal, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Must sit exactly two levels deep: <YYYY>/<MM>/<file>.md
  const parts = rel.split(path.sep);
  if (parts.length !== 3 || parts[0] !== y || parts[1] !== m || parts[2] !== filename) return null;
  return { monthDir, abs, rel: parts.join('/') };
}

// ---- WRITE: create a new manual journal entry --------------------------------
// Returns:
//   { ok:'bad-title' }                       — empty/path-like title (→ 400)
//   { ok:'bad-date' }                         — date not YYYY-MM-DD (→ 400)
//   { ok:'too-large' }                        — body over the cap (→ 413)
//   { ok:'collision', slug }                  — a file already at that path (→ 409)
//   { ok:'created', slug, date, relPath, absPath, mtime } — success (→ 201)
export function createJournalEntry(title, body = '', dateInput) {
  if (typeof title !== 'string' ||
      title.includes('/') || title.includes('\\') || title.includes('\0') ||
      /(^|[\\/])\.\.([\\/]|$)/.test(title)) {
    return { ok: 'bad-title' };
  }
  const cleanTitle = title.trim().slice(0, MAX_TITLE);
  if (!cleanTitle) return { ok: 'bad-title' };

  // Date handling:
  //   * ABSENT / empty  → fall back to server "today" (local). Keeps the
  //     composer's "save with no date" UX.
  //   * PRESENT         → must pass BOTH the shape check (DATE_RE) AND a
  //     calendar-range check (month 1-12, day 1-31). A present-but-invalid date
  //     (e.g. "not-a-date" or "2026-13-99") returns bad-date rather than
  //     silently misfiling under today (L-2) or creating a bad YYYY/MM folder
  //     like PKM/Journal/2026/13/ (L-1). NEVER trusted into a path until
  //     DATE_RE passes again in containedEntryPath.
  const hasDate = typeof dateInput === 'string' && dateInput.trim() !== '';
  let date;
  if (hasDate) {
    if (!isValidCalendarDate(dateInput)) return { ok: 'bad-date' };
    date = dateInput;
  } else {
    date = todayLocalDate();
  }
  if (!isValidCalendarDate(date)) return { ok: 'bad-date' };

  const baseSlug = slugifyTitle(cleanTitle);
  if (!baseSlug || !SLUG_RE.test(baseSlug)) return { ok: 'bad-title' };

  const bodyStr = typeof body === 'string' ? body : '';
  if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_BYTES) return { ok: 'too-large' };

  // Date-prefix the slug so same-titled entries on different days never collide,
  // and the file sorts naturally inside its month folder.
  let slug = `${date}-${baseSlug}`.slice(0, 80).replace(/-+$/, '');
  if (!SLUG_RE.test(slug)) return { ok: 'bad-title' };

  let contained = containedEntryPath(date, slug);
  if (!contained) return { ok: 'bad-title' };

  // Collision: no silent overwrite. One uniquifying retry with a short suffix.
  if (fs.existsSync(contained.abs)) {
    const suffix = String(Date.now()).slice(-5);
    slug = `${date}-${baseSlug}`.slice(0, 74).replace(/-+$/, '') + `-${suffix}`;
    if (!SLUG_RE.test(slug)) return { ok: 'collision', slug };
    contained = containedEntryPath(date, slug);
    if (!contained) return { ok: 'collision', slug };
    if (fs.existsSync(contained.abs)) return { ok: 'collision', slug };
  }

  const markdown = buildEntryMarkdown({ title: cleanTitle, date, body: bodyStr });

  // Create the month dir, then exclusive write (wx) — fails if a file appears
  // under us between the existsSync and the write (TOCTOU close-out).
  fs.mkdirSync(contained.monthDir, { recursive: true });
  let stat;
  try {
    const fd = fs.openSync(contained.abs, 'wx', 0o644);
    try {
      fs.writeFileSync(fd, markdown, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    stat = fs.statSync(contained.abs);
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: 'collision', slug };
    throw err;
  }

  appendAuditRecord({
    op: 'create',
    slug,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    sha256: crypto.createHash('sha256').update(markdown, 'utf8').digest('hex'),
    ts: new Date().toISOString(),
    source: 'cockpit',
  });

  return {
    ok: 'created',
    slug,
    date,
    title: cleanTitle,
    relPath: contained.rel,                 // relative to PKM/Journal/
    absPath: contained.abs,                 // absolute (the integrate hand-off needs this)
    mtime: Math.floor(stat.mtimeMs),
  };
}

// ---- minimal frontmatter read (only the fields WE author) --------------------
// Reads the leading --- … --- block and pulls title/date/manually_added/
// integration_status. We do NOT need a full YAML parser: these are flat scalar
// lines we wrote ourselves. original_body (a block scalar, set later by Penn) is
// detected only as a presence flag — we never re-parse Penn's block here; once a
// note is integrated it is in the mirror and the unfold reads original_body from
// the mirror (see DATA-CONTRACT §10 / getNote in cockpit.js).
function parseLeadingFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, hasOriginalBody: false };
  const block = m[1];
  const fm = {};
  let hasOriginalBody = false;
  for (const line of block.split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (key === 'original_body') { hasOriginalBody = true; continue; }
    // unquote a single- or double-quoted scalar
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1).replace(/''/g, "'");
    }
    fm[key] = val;
  }
  return { fm, hasOriginalBody };
}

function bodyAfterFrontmatter(md) {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}

// ---- READ: raw (un-mirrored) manual entries from the file layer --------------
// Walk PKM/Journal/<YYYY>/<MM>/*.md, surface entries whose frontmatter says
// manually_added: true AND integration_status is raw (or absent). These are the
// freshly-added entries the mirror hasn't ingested yet. Capped + newest-first.
// Calm-degrades to [] on any I/O problem (the jail dir may not exist yet).
const MAX_RAW_SCAN_FILES = 4000;
const MAX_RAW_RETURN = 200;

export function listRawManualEntries() {
  const out = [];
  let scanned = 0;
  let years;
  try {
    years = fs.readdirSync(JOURNAL_DIR, { withFileTypes: true });
  } catch {
    return []; // jail dir missing → no raw entries (calm degrade)
  }
  for (const yEnt of years) {
    if (!yEnt.isDirectory() || !/^\d{4}$/.test(yEnt.name)) continue;
    let months;
    try { months = fs.readdirSync(path.join(JOURNAL_DIR, yEnt.name), { withFileTypes: true }); }
    catch { continue; }
    for (const mEnt of months) {
      if (!mEnt.isDirectory() || !/^\d{2}$/.test(mEnt.name)) continue;
      const monthAbs = path.join(JOURNAL_DIR, yEnt.name, mEnt.name);
      let files;
      try { files = fs.readdirSync(monthAbs, { withFileTypes: true }); }
      catch { continue; }
      for (const fEnt of files) {
        if (scanned >= MAX_RAW_SCAN_FILES) break;
        if (!fEnt.isFile() || !fEnt.name.toLowerCase().endsWith('.md')) continue;
        const slug = fEnt.name.slice(0, -3);
        if (!SLUG_RE.test(slug)) continue;
        scanned += 1;
        const abs = path.join(monthAbs, fEnt.name);
        let md, stat;
        try {
          stat = fs.statSync(abs);
          if (!stat.isFile()) continue;
          md = fs.readFileSync(abs, 'utf8');
        } catch { continue; }
        const { fm } = parseLeadingFrontmatter(md);
        const manual = fm.manually_added === 'true' || fm.manually_added === '1';
        const status = (fm.integration_status || 'raw').toLowerCase();
        if (!manual || status === 'integrated') continue;
        const body = bodyAfterFrontmatter(md);
        out.push({
          slug,
          title: fm.title || slug,
          date: fm.date && DATE_RE.test(fm.date) ? fm.date : `${yEnt.name}-${mEnt.name}-01`,
          integrationStatus: 'raw',
          manuallyAdded: true,
          excerpt: excerptOf(stripLight(body), 400),
          contentLength: body.length,
          mtime: Math.floor(stat.mtimeMs),
        });
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.mtime - a.mtime));
  return out.slice(0, MAX_RAW_RETURN);
}

// ---- INTEGRATE hand-off: resolve a raw entry's absolute path ------------------
// Given a journal slug, find the on-disk file under the jail and return its
// absolute path + raw/integrated state. The integrate route uses this to build
// the {{ENTRY_PATH}} substitution. JAILED: the slug is whitelisted and the
// resolved path is re-checked inside PKM/Journal/. Returns null when not found
// or out of jail.
export function resolveJournalEntryPath(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  // The date prefix tells us the year/month folder directly (our entries are
  // always "<YYYY-MM-DD>-<title>"). Fall back to a bounded scan for entries that
  // predate this convention.
  const datePrefix = slug.match(/^(\d{4})-(\d{2})-\d{2}-/);
  const candidates = [];
  if (datePrefix) {
    const c = containedEntryPath(`${datePrefix[1]}-${datePrefix[2]}-01`, slug);
    if (c) candidates.push(c.abs);
  }
  // Bounded fallback scan if the prefix path didn't resolve to a real file.
  for (const abs of candidates) {
    try { if (fs.statSync(abs).isFile()) return readEntryState(abs, slug); } catch { /* fall through */ }
  }
  // Scan the tree for "<slug>.md" (bounded).
  let years;
  try { years = fs.readdirSync(JOURNAL_DIR, { withFileTypes: true }); } catch { return null; }
  for (const yEnt of years) {
    if (!yEnt.isDirectory() || !/^\d{4}$/.test(yEnt.name)) continue;
    let months;
    try { months = fs.readdirSync(path.join(JOURNAL_DIR, yEnt.name), { withFileTypes: true }); } catch { continue; }
    for (const mEnt of months) {
      if (!mEnt.isDirectory() || !/^\d{2}$/.test(mEnt.name)) continue;
      const abs = path.join(JOURNAL_DIR, yEnt.name, mEnt.name, `${slug}.md`);
      try {
        if (fs.statSync(abs).isFile()) {
          // Re-confirm containment (symlink-escape close-out).
          const jailReal = fs.realpathSync(JOURNAL_DIR);
          const real = fs.realpathSync(abs);
          const rel = path.relative(jailReal, real);
          if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
          return readEntryState(abs, slug);
        }
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

function readEntryState(abs, slug) {
  let md = '';
  try { md = fs.readFileSync(abs, 'utf8'); } catch { /* still return path */ }
  const { fm, hasOriginalBody } = parseLeadingFrontmatter(md);
  const status = (fm.integration_status || (hasOriginalBody ? 'integrated' : 'raw')).toLowerCase();
  return {
    absPath: abs,
    slug,
    integrationStatus: status === 'integrated' ? 'integrated' : 'raw',
    manuallyAdded: fm.manually_added === 'true' || fm.manually_added === '1',
  };
}

// ---- helpers -----------------------------------------------------------------
function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Shape (YYYY-MM-DD) + calendar-range validation. DATE_RE is shape-only, so it
// happily accepts "2026-13-99" → which would build a PKM/Journal/2026/13/ folder
// (in-jail but wrong). We additionally bound month to 1-12 and day to 1-31.
// Deliberately a coarse 1-31 bound (not per-month/leap-year exact) — the goal is
// to reject obviously-broken dates, not to be a full calendar validator.
function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // y is constrained to 4 digits by DATE_RE; no further bound needed.
  return Number.isInteger(y);
}

function stripLight(md) {
  if (!md) return '';
  let s = String(md);
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/!\[\[[^\]]*\]\]/g, ' ');
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)([^*_\n]+)\1/g, '$2');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function excerptOf(text, n) {
  if (text.length <= n) return text;
  let cut = text.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > n * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

export const __test = { containedEntryPath, slugifyTitle, buildEntryMarkdown, parseLeadingFrontmatter };
export { JOURNAL_DIR };
