// workbench.attachments.test.mjs — self-test for the Workbench image-attachment
// binary-write path. Run: `node server/workbench.attachments.test.mjs` from the
// Expansion root (or `node workbench.attachments.test.mjs` from server/).
//
// Covers Vex's required cases:
//   - valid PNG accepted (written, correct ext, sha256 returned)
//   - valid JPEG accepted
//   - SVG rejected (script-injection vector — magic-byte gate, not extension)
//   - oversized payload rejected (decoded-byte cap)
//   - magic-byte mismatch rejected (text claiming to be an image)
//   - traversal / non-charset filename rejected by the containment gate
//
// The test exercises the real writeWorkbenchAttachment() against the real
// PKM/Workbench/_attachments/ jail, then DELETES exactly the files it created
// (tracked by returned filename). It also unit-tests the pure sniffer + jail via
// the __test export. No HTTP, no server boot.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { writeWorkbenchAttachment, MAX_ATTACHMENT_BYTES, __test } from './workbench.js';

const { sniffImageExt, containedAttachmentPath, ATTACHMENTS_DIR } = __test;

let pass = 0, fail = 0;
const created = [];
function check(name, fn) {
  try { fn(); console.log(`  ok  — ${name}`); pass++; }
  catch (err) { console.error(`  FAIL — ${name}\n        ${err.message}`); fail++; }
}

// --- byte fixtures ----------------------------------------------------------
// Minimal valid magic-byte headers padded to >=12 bytes so the sniffer accepts.
const PNG  = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46]), Buffer.alloc(8)]);
const GIF  = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(8)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0,0,0,0]), Buffer.from('WEBP', 'ascii'), Buffer.alloc(4)]);
const SVG  = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
const TXT  = Buffer.from('this is plainly not an image, just some bytes pretending', 'utf8');

const b64 = (buf) => buf.toString('base64');

// --- pure sniffer ------------------------------------------------------------
check('sniff: PNG → png',  () => assert.strictEqual(sniffImageExt(PNG),  'png'));
check('sniff: JPEG → jpg', () => assert.strictEqual(sniffImageExt(JPEG), 'jpg'));
check('sniff: GIF → gif',  () => assert.strictEqual(sniffImageExt(GIF),  'gif'));
check('sniff: WebP → webp',() => assert.strictEqual(sniffImageExt(WEBP), 'webp'));
check('sniff: SVG → null (rejected)',  () => assert.strictEqual(sniffImageExt(SVG), null));
check('sniff: text → null (mismatch)', () => assert.strictEqual(sniffImageExt(TXT), null));
check('sniff: too-short buffer → null',() => assert.strictEqual(sniffImageExt(Buffer.from([0x89,0x50])), null));

// --- containment gate (pure) -------------------------------------------------
check('jail: rejects traversal name', () => assert.strictEqual(containedAttachmentPath('../../etc/passwd.png'), null));
check('jail: rejects nested separator', () => assert.strictEqual(containedAttachmentPath('sub/x.png'), null));
check('jail: rejects backslash', () => assert.strictEqual(containedAttachmentPath('a\\b.png'), null));
check('jail: rejects bad extension', () => assert.strictEqual(containedAttachmentPath('abcd1234.svg'), null));
check('jail: rejects uppercase/odd charset', () => assert.strictEqual(containedAttachmentPath('ABCD.png'), null));
check('jail: accepts a generated uuid name', () => {
  // containedAttachmentPath returns null when the _attachments dir does not yet
  // exist (realpath anchor missing) — that is intended; the real write path calls
  // ensureAttachmentsDir() first. So create the dir for this pure-path assertion.
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
  const name = 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890.png';
  const got = containedAttachmentPath(name);
  // The function returns the lexical in-jail abs (path.resolve), so compare to that.
  assert.strictEqual(got, path.resolve(ATTACHMENTS_DIR, name));
});

// --- full write path ---------------------------------------------------------
check('write: valid PNG accepted', () => {
  const r = writeWorkbenchAttachment(b64(PNG));
  assert.strictEqual(r.ok, 'written');
  assert.match(r.path, /^_attachments\/[a-f0-9-]{8,40}\.png$/);
  assert.ok(r.sha256 && r.sha256.length === 64);
  created.push(r.filename);
  assert.ok(fs.existsSync(path.join(ATTACHMENTS_DIR, r.filename)), 'file on disk');
  const mode = fs.statSync(path.join(ATTACHMENTS_DIR, r.filename)).mode & 0o777;
  assert.strictEqual(mode, 0o600, `mode should be 0600, got ${mode.toString(8)}`);
});

check('write: valid JPEG accepted, ext derived from bytes (not client)', () => {
  // Feed a data: URI LYING that it's image/png; bytes are JPEG → must write .jpg.
  const r = writeWorkbenchAttachment(`data:image/png;base64,${b64(JPEG)}`);
  assert.strictEqual(r.ok, 'written');
  assert.match(r.path, /\.jpg$/, 'extension must come from magic bytes, not the data: MIME');
  created.push(r.filename);
});

check('write: SVG rejected (bad-image)', () => {
  const r = writeWorkbenchAttachment(b64(SVG));
  assert.strictEqual(r.ok, 'bad-image');
});

check('write: magic-byte mismatch rejected (text → bad-image)', () => {
  const r = writeWorkbenchAttachment(b64(TXT));
  assert.strictEqual(r.ok, 'bad-image');
});

check('write: oversized rejected (too-large)', () => {
  // A valid PNG header followed by enough padding to exceed the decoded cap.
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]);
  const r = writeWorkbenchAttachment(b64(big));
  assert.strictEqual(r.ok, 'too-large');
});

check('write: empty / non-base64 input rejected (bad-input)', () => {
  assert.strictEqual(writeWorkbenchAttachment('').ok, 'bad-input');
  assert.strictEqual(writeWorkbenchAttachment('   ').ok, 'bad-input');
  assert.strictEqual(writeWorkbenchAttachment('not base64 ©©©').ok, 'bad-input');
  assert.strictEqual(writeWorkbenchAttachment(null).ok, 'bad-input');
});

// --- cleanup: remove only the files this test created ------------------------
for (const f of created) {
  try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, f)); } catch { /* noop */ }
}
// Remove the _attachments dir if the test created it and it is now empty.
try {
  if (fs.existsSync(ATTACHMENTS_DIR) && fs.readdirSync(ATTACHMENTS_DIR).length === 0) {
    fs.rmdirSync(ATTACHMENTS_DIR);
  }
} catch { /* noop */ }

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
