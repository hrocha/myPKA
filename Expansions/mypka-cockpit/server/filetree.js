// filetree.js — folder-tree + inbox-upload routes for the Deliverables and
// Team Inbox cockpit views.
//
// Surface (all mounted by registerFileTreeRoutes — server.js calls it once):
//   GET  /api/cockpit/tree?root=deliverables|inbox
//        -> nested { name, path, kind, size, mtime, children[] } snapshot of
//           Deliverables/ or "Team Inbox/" at the myPKA root. Read-only.
//           Jail: ONLY those two roots. Dotfiles + _archive skipped, symlinks
//           never followed, depth capped at 6, total entries capped at 2000.
//   POST /api/cockpit/inbox/upload   body { filename, dataBase64 }
//        -> writes ONE new file into "Team Inbox/" (never a subfolder, never
//           an overwrite). Filename is sanitized to a safe basename; a name
//           collision gets a timestamp suffix. Decoded size cap: 20 MB.
//           Atomic + exclusive publish (link(2) fails on EEXIST — no clobber
//           window). Rides the caller-supplied session + CSRF write stack.
//   GET  /api/cockpit/inbox-file?path=Team%20Inbox/<name>
//        -> inline preview serving for inbox files. Same path.relative()
//           containment idiom as /api/cockpit/file, same inert no-script CSP,
//           but its OWN jail (Team Inbox/) and a TIGHTER allowlist:
//           pdf / images / text / markdown only.
//
// REPO_ROOT comes from the shared resolver (repoRoot.js), NOT from db.js — this
// module carries zero database coupling. The resolver is the one place the
// scaffold root is decided (MYPKA_ROOT env → AGENTS.md+PKM/ fingerprint → 3-up).
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
// Shared resolver — see repoRoot.js for the MYPKA_ROOT → fingerprint → fallback order.
import { REPO_ROOT } from './repoRoot.js';

// ---- The two (and ONLY two) browsable roots ---------------------------------
const TREE_ROOTS = {
  deliverables: {
    label: 'Deliverables',
    abs: path.resolve(REPO_ROOT, 'Deliverables'),
    rel: 'Deliverables',
  },
  inbox: {
    label: 'Team Inbox',
    abs: path.resolve(REPO_ROOT, 'Team Inbox'),
    rel: 'Team Inbox',
  },
};

const MAX_DEPTH = 6; // levels below the root dir
const MAX_ENTRIES = 2000; // total nodes per tree response
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB on the DECODED bytes
const UPLOAD_JSON_LIMIT = '32mb'; // base64 inflates ~4/3 + JSON envelope headroom

// ---- Tree walk ----------------------------------------------------------------
// Skip rules: dotfiles/dot-dirs (".DS_Store", ".git", …), anything named
// "_archive" (the Deliverables archive convention), and symlinks (lstat — we
// never follow a link out of the jail). Dirs sort before files, then by name.
function skipEntry(name) {
  return name.startsWith('.') || name.toLowerCase() === '_archive';
}

function walkDir(absDir, relDir, depth, budget) {
  const children = [];
  let names;
  try {
    names = fs.readdirSync(absDir);
  } catch {
    return children; // unreadable dir -> calm empty branch, not a 500
  }
  const entries = [];
  for (const name of names) {
    if (skipEntry(name)) continue;
    const absChild = path.join(absDir, name);
    let st;
    try {
      st = fs.lstatSync(absChild); // lstat: a symlink is neither dir nor file here
    } catch {
      continue;
    }
    if (st.isDirectory()) entries.push({ name, st, kind: 'dir' });
    else if (st.isFile()) entries.push({ name, st, kind: 'file' });
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1
  );

  for (const e of entries) {
    if (budget.entries >= MAX_ENTRIES) {
      budget.truncated = true;
      break;
    }
    budget.entries += 1;
    const relChild = `${relDir}/${e.name}`;
    if (e.kind === 'dir') {
      const node = {
        name: e.name,
        path: relChild,
        kind: 'dir',
        size: 0,
        mtime: e.st.mtimeMs,
        children:
          depth < MAX_DEPTH
            ? walkDir(path.join(absDir, e.name), relChild, depth + 1, budget)
            : [],
      };
      if (depth >= MAX_DEPTH) budget.truncated = true;
      children.push(node);
    } else {
      children.push({
        name: e.name,
        path: relChild,
        kind: 'file',
        size: e.st.size,
        mtime: e.st.mtimeMs,
      });
    }
  }
  return children;
}

function buildTree(rootKey) {
  const root = TREE_ROOTS[rootKey];
  const budget = { entries: 0, truncated: false };
  const exists = fs.existsSync(root.abs) && fs.statSync(root.abs).isDirectory();
  return {
    ok: true,
    root: {
      name: root.label,
      path: root.rel,
      kind: 'dir',
      size: 0,
      mtime: exists ? fs.statSync(root.abs).mtimeMs : 0,
      children: exists ? walkDir(root.abs, root.rel, 1, budget) : [],
    },
    truncated: budget.truncated,
    entryCount: budget.entries,
    generatedAt: new Date().toISOString(),
  };
}

// ---- Inbox containment (same idiom as containedDeliverablesPath) --------------
// path.relative() is the check, never a string prefix — a sibling like
// "Team Inbox-secrets/" would fool startsWith. Input is repo-root-relative
// ("Team Inbox/photo.png").
const INBOX_DIR = TREE_ROOTS.inbox.abs;
function containedInboxPath(rel) {
  if (!rel || rel.includes('\0')) return null;
  const abs = path.resolve(REPO_ROOT, rel);
  const relToInbox = path.relative(INBOX_DIR, abs);
  if (relToInbox === '' || relToInbox.startsWith('..') || path.isAbsolute(relToInbox)) return null;
  return abs;
}

// ---- Inline-preview allowlist (inbox) ------------------------------------------
// Copied from server.js INLINE_MIME but DELIBERATELY tighter: pdf / images /
// text / markdown only — no audio, nothing else. Served inert: conservative
// Content-Type + a no-script CSP, so even a hostile SVG cannot execute.
const INBOX_INLINE_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  // Markdown is served as TEXT, never as HTML — the client renders it through
  // the sanitized markdown component (same posture as /api/cockpit/file).
  '.md': 'text/markdown; charset=utf-8',
};

// ---- Upload filename hygiene ----------------------------------------------------
// basename only (kills any path smuggling), strip control/odd characters down to
// a calm [A-Za-z0-9._ -] alphabet, collapse whitespace, no leading dots (no
// dotfiles), extension preserved through the same filter. Empty result falls
// back to "upload". The full name is length-capped so the FS never chokes.
function sanitizeFilename(raw) {
  const base = path.basename(String(raw || '')).normalize('NFC');
  let cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '') // control chars
    .replace(/[^A-Za-z0-9._ \-()]/g, '-') // anything weird -> dash
    .replace(/\s+/g, ' ') // collapse runs of whitespace
    .replace(/^[. ]+/, '') // no dotfiles / leading spaces
    .trim();
  if (!cleaned) cleaned = 'upload';
  if (cleaned.length > 120) {
    const ext = path.extname(cleaned).slice(0, 16);
    cleaned = cleaned.slice(0, 120 - ext.length) + ext;
  }
  return cleaned;
}

function timestampSuffix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function withSuffix(filename, suffix) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${suffix}${ext}`;
}

// Atomic + EXCLUSIVE publish: bytes land in a same-dir temp file (0600, fsync'd),
// then link(2) publishes — link fails with EEXIST when the target exists, so
// there is no overwrite window at all (rename would silently clobber).
function atomicExclusiveWrite(targetAbs, buf) {
  const dir = path.dirname(targetAbs);
  const tmpAbs = path.join(dir, `.fttmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmpAbs, 'wx', 0o600);
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(tmpAbs, targetAbs); // EEXIST -> caller retries with a new name
    fs.unlinkSync(tmpAbs);
    return true;
  } catch (err) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* noop */ }
    try { if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs); } catch { /* noop */ }
    if (err && err.code === 'EEXIST') return false; // collision — not an error
    throw err;
  }
}

// Decode { dataBase64 } defensively: tolerate a data-URL prefix, validate the
// alphabet, enforce the decoded-byte cap BEFORE any FS work.
function decodeBase64Payload(dataBase64) {
  let b64 = String(dataBase64 || '').trim();
  const comma = b64.indexOf(',');
  if (b64.startsWith('data:') && comma !== -1) b64 = b64.slice(comma + 1);
  b64 = b64.replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return { error: 'bad-base64' };
  // Cheap pre-check on the encoded length (4 chars ≈ 3 bytes) before allocating.
  if ((b64.length / 4) * 3 > MAX_UPLOAD_BYTES + 3) return { error: 'too-large' };
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return { error: 'bad-base64' };
  if (buf.length > MAX_UPLOAD_BYTES) return { error: 'too-large' };
  return { buf };
}

// ---- Route registration ----------------------------------------------------------
// server.js wires this with its own guard stack:
//   registerFileTreeRoutes(app, { safe, sessionOrLoopback, localWriteGuard });
// Must be mounted BEFORE the catch-all /api 404 handler. The global /api auth
// middleware already gates every route here.
export function registerFileTreeRoutes(app, { safe, sessionOrLoopback, localWriteGuard }) {
  // -- GET /api/cockpit/tree?root=deliverables|inbox (read-only) --------------
  app.get('/api/cockpit/tree', (req, res) => {
    const rootKey = String(req.query.root || '');
    if (!Object.prototype.hasOwnProperty.call(TREE_ROOTS, rootKey)) {
      return res.status(400).json({ ok: false, error: 'root must be "deliverables" or "inbox"' });
    }
    return safe(() => buildTree(rootKey))(req, res);
  });

  // -- POST /api/cockpit/inbox/upload (the ONLY write in this module) ---------
  // Parser instance is scoped to THIS route, mirroring the server's
  // per-route-parser discipline (no global body parsing).
  const uploadJson = express.json({ limit: UPLOAD_JSON_LIMIT });
  app.post('/api/cockpit/inbox/upload', sessionOrLoopback, localWriteGuard, uploadJson, (req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'body must be a JSON object' });
    }
    const extras = Object.keys(body).filter((k) => k !== 'filename' && k !== 'dataBase64');
    if (extras.length) {
      return res.status(400).json({ ok: false, error: `unexpected field(s): ${extras.join(', ')}` });
    }
    if (typeof body.filename !== 'string' || !body.filename.trim()) {
      return res.status(400).json({ ok: false, error: 'filename is required (non-empty string)' });
    }
    if (typeof body.dataBase64 !== 'string' || !body.dataBase64.trim()) {
      return res.status(400).json({ ok: false, error: 'dataBase64 is required (non-empty base64 string)' });
    }

    const decoded = decodeBase64Payload(body.dataBase64);
    if (decoded.error === 'too-large') {
      return res.status(413).json({ ok: false, error: 'file exceeds the 20 MB upload limit' });
    }
    if (decoded.error) {
      return res.status(400).json({ ok: false, error: 'invalid base64 payload' });
    }

    if (!fs.existsSync(INBOX_DIR) || !fs.statSync(INBOX_DIR).isDirectory()) {
      return res.status(500).json({ ok: false, error: 'Team Inbox/ folder not found at the myPKA root' });
    }

    let filename = sanitizeFilename(body.filename);
    // Containment belt on the FINAL absolute path — sanitizeFilename already
    // makes escape impossible, but the jail check is cheap and non-negotiable.
    let abs = containedInboxPath(`Team Inbox/${filename}`);
    if (!abs) return res.status(400).json({ ok: false, error: 'filename failed containment' });

    try {
      if (!atomicExclusiveWrite(abs, decoded.buf)) {
        // Collision -> timestamp suffix; a second collision (same second) gets
        // one random retry, then we give up loudly rather than loop.
        filename = withSuffix(filename, timestampSuffix());
        abs = containedInboxPath(`Team Inbox/${filename}`);
        if (!abs || !atomicExclusiveWrite(abs, decoded.buf)) {
          filename = withSuffix(filename, crypto.randomBytes(3).toString('hex'));
          abs = containedInboxPath(`Team Inbox/${filename}`);
          if (!abs || !atomicExclusiveWrite(abs, decoded.buf)) {
            return res.status(409).json({ ok: false, error: 'filename collision; retry' });
          }
        }
      }
    } catch (err) {
      console.error('[POST /api/cockpit/inbox/upload]', err.message);
      return res.status(500).json({ ok: false, error: 'upload write failed' });
    }

    return res.status(201).json({ ok: true, path: `Team Inbox/${filename}`, bytes: decoded.buf.length });
  });

  // -- GET /api/cockpit/inbox-file?path=Team%20Inbox/<name> (read-only) -------
  // The existing /api/cockpit/file route jails Deliverables/ + PKM/ but NOT
  // Team Inbox/ — this is its inbox twin: same containment idiom, same inert
  // inline headers, tighter allowlist.
  app.get('/api/cockpit/inbox-file', (req, res) => {
    const abs = containedInboxPath(String(req.query.path || ''));
    if (!abs) return res.status(403).json({ error: 'forbidden' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: 'not found' });
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = INBOX_INLINE_MIME[ext];
    if (!mime) return res.status(415).json({ error: 'no inline preview for this type', ext });
    res.set('Content-Type', mime);
    res.set('Content-Disposition', 'inline');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'self'; style-src 'unsafe-inline'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  });
}
