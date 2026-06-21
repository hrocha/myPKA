// set-pin.js — user-run, interactive. Sets (or rotates) the cockpit LAN PIN.
//
// WHAT IT DOES
//   Prompts twice for a PIN (hidden, no echo), enforces the strength rule
//   (≥6 digits), scrypt-hashes it, and writes COCKPIT_PIN_HASH=<hash> into
//   `Team Knowledge/.env` (the canonical, gitignored, 0600 secret store) —
//   replacing any existing COCKPIT_PIN_HASH line in place. The cleartext PIN is
//   NEVER printed, logged, or written. Only the hash lands on disk.
//
//   This script GENERATES NO PIN. Choosing the PIN is the user's action; the script
//   only hashes what the user types.
//
// USAGE
//   npm run set-pin          (from Expansions/mypka-cockpit)
//
// SECRET HYGIENE
//   - reads/writes only the .env's COCKPIT_PIN_HASH line; never touches other keys
//   - re-asserts 0600 perms on the .env after writing
//   - terminal echo is disabled while typing the PIN

import fs from 'node:fs';
import readline from 'node:readline';
import { hashPin, verifyPin, ENV_PATH, MIN_PIN_LENGTH } from './auth.js';

const HASH_KEY = 'COCKPIT_PIN_HASH';

// Hidden prompt — disables tty echo so the PIN never shows on screen or scrollback.
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      const s = char.toString('utf8');
      if (s === '\n' || s === '\r' || s === '') {
        process.stdin.removeListener('data', onData);
      } else {
        // Repaint the prompt without the typed character (keeps the cursor sane).
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdout.write(question);
    process.stdin.on('data', onData);
    rl.question('', (value) => {
      rl.close();
      process.stdout.write('\n');
      resolve(value);
    });
  });
}

// Replace (or append) the COCKPIT_PIN_HASH line in .env, leaving every other line
// byte-for-byte intact. Creates .env if it somehow doesn't exist (0600).
function writeHashToEnv(hash) {
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    raw = '';
  }
  const line = `${HASH_KEY}=${hash}`;
  const lines = raw.length ? raw.split('\n') : [];
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*COCKPIT_PIN_HASH\s*=/.test(lines[i])) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // Append with a clean separator; avoid a double blank line.
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('# Cockpit LAN PIN (scrypt hash; set via `npm run set-pin`). Never the cleartext PIN.');
    lines.push(line);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(ENV_PATH, out, { mode: 0o600 });
  // Re-assert restrictive perms even if the file pre-existed with looser ones.
  try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best effort */ }
}

async function main() {
  console.log('\n  myPKA Cockpit — set LAN PIN');
  console.log('  ----------------------------');
  console.log(`  The PIN gates phone access over the home Wi-Fi. Minimum ${MIN_PIN_LENGTH} digits.`);
  console.log('  It is stored only as a scrypt hash. The cleartext is never written.\n');

  const pin1 = (await promptHidden('  Enter new PIN: ')).trim();

  if (!/^\d+$/.test(pin1)) {
    console.error('\n  ✗ PIN must be digits only.\n');
    process.exit(1);
  }
  if (pin1.length < MIN_PIN_LENGTH) {
    console.error(`\n  ✗ PIN must be at least ${MIN_PIN_LENGTH} digits.\n`);
    process.exit(1);
  }

  const pin2 = (await promptHidden('  Confirm PIN:  ')).trim();
  if (pin1 !== pin2) {
    console.error('\n  ✗ PINs did not match. Nothing written.\n');
    process.exit(1);
  }

  const hash = hashPin(pin1);

  // Sanity self-check: the hash we just produced must verify against the PIN.
  if (!verifyPin(pin1, hash)) {
    console.error('\n  ✗ Internal error: hash failed self-verification. Nothing written.\n');
    process.exit(1);
  }

  writeHashToEnv(hash);

  console.log('\n  ✓ PIN set. Stored as a scrypt hash in:');
  console.log(`    ${ENV_PATH}`);
  console.log('\n  Start LAN mode with:  npm run serve:lan');
  console.log('  (or:  COCKPIT_BIND_LAN=1 npm run serve)\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  ✗ set-pin failed:', err.message, '\n');
  process.exit(1);
});
