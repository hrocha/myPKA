// connectors/imapStarred.js — starred/flagged emails as plannable task cards.
//
// WHY IMAP: it is the one open standard that makes "pull my starred emails"
// a paste-a-credential affair. Gmail supports it via App Passwords (Google
// Account → Security → 2-Step Verification → App passwords), and the same
// connector covers Fastmail, iCloud, GMX, posteo, any standard IMAP host.
// (Outlook/Microsoft 365 retired password IMAP — that needs an OAuth/Graph
// connector; see README.md "Filtering" notes. Don't fake it here.)
//
// CONTRACT (types.js): kind 'task'. A starred email maps onto the normalized
// task shape: title = subject, description = sender + date line, due = null
// (dueBucket 'none' — starred mail is something you PLAN, not something with a
// deadline), url = a webmail deep link when derivable (Gmail message-id search;
// Fastmail search fallback), assignedToMe = true (it is the user's mailbox).
//
// POSTURE: strictly READ-ONLY — the mailbox is opened with a readOnly lock; the
// only commands issued are SEARCH and FETCH (envelope). No STORE, no flags
// changed, nothing marked read, nothing moved or deleted, ever. The password is
// resolved in-process from the key vault and never leaves this module. Failures
// degrade calmly (no-token / unreachable / misconfigured) — never a throw.
import { ImapFlow } from 'imapflow';
import { readEnvKey } from './env.js';
import { degraded, ok } from './types.js';

const TIMEOUT_MS = 12_000;
const MAX_ITEMS = 50;
const CACHE_TTL_MS = 60_000; // IMAP handshakes are slow; one fetch per minute is plenty.

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function addr(a) {
  if (!a) return null;
  const first = Array.isArray(a) ? a[0] : a;
  if (!first) return null;
  return first.name ? `${first.name} <${first.address || ''}>` : (first.address || null);
}

// A best-effort webmail deep link from the host + RFC822 Message-ID.
function deepLink(host, messageId) {
  if (!messageId) return null;
  const id = String(messageId).replace(/^<|>$/g, '');
  if (/gmail|googlemail/i.test(host)) {
    return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(id)}`;
  }
  if (/fastmail/i.test(host)) {
    return `https://app.fastmail.com/mail/search:msgid:${encodeURIComponent(id)}/`;
  }
  return null; // other hosts: no universal scheme — card renders without a link.
}

export function makeImapStarredConnector({ id = 'email:starred', label = 'Email (starred)' } = {}) {
  let cache = null; // { at, items }

  return {
    id,
    kind: 'task',
    label,

    /** fetchWeek(_weekStart) → ConnectorResult<NormalizedTask>. Starred mail is
     *  week-independent (no due dates), so the week anchor is ignored. */
    async fetchWeek() {
      const host = readEnvKey('EMAIL_IMAP_HOST');
      const user = readEnvKey('EMAIL_IMAP_USER');
      const pass = readEnvKey('EMAIL_IMAP_PASSWORD');
      if (!host || !user || !pass) {
        return degraded(id, 'no-token', 'EMAIL_IMAP_HOST / EMAIL_IMAP_USER / EMAIL_IMAP_PASSWORD not configured.');
      }

      if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return ok(id, cache.items);
      }

      const client = new ImapFlow({
        host: host.trim(),
        port: 993,
        secure: true,
        auth: { user, pass },
        logger: false,           // NEVER log — log lines could carry the credential
        disableAutoIdle: true,
      });

      try {
        const items = await withTimeout((async () => {
          await client.connect();
          // readOnly lock — the server-side guarantee that nothing mutates.
          const lock = await client.getMailboxLock('INBOX', { readOnly: true });
          try {
            const uids = await client.search({ flagged: true }, { uid: true });
            const recent = (uids || []).slice(-MAX_ITEMS); // newest tail
            const out = [];
            if (recent.length) {
              for await (const msg of client.fetch(recent, { envelope: true, uid: true }, { uid: true })) {
                const env = msg.envelope || {};
                const fromLine = addr(env.from);
                const dateLine = env.date ? new Date(env.date).toISOString().slice(0, 10) : null;
                out.push({
                  kind: 'task',
                  source: id,
                  id: String(msg.uid),
                  title: env.subject || '(no subject)',
                  description: [fromLine && `From: ${fromLine}`, dateLine && `Received: ${dateLine}`]
                    .filter(Boolean).join('\n'),
                  due: null,
                  dueBucket: 'none',
                  priorityRank: 4,
                  url: deepLink(host, env.messageId),
                  tags: [],
                  status: null,
                  assignedToMe: true,
                  editableFields: [], // read-only contract — unstar in your mail client
                });
              }
            }
            out.reverse(); // newest first
            return out;
          } finally {
            lock.release();
          }
        })(), TIMEOUT_MS, 'IMAP starred read');

        cache = { at: Date.now(), items };
        return ok(id, items);
      } catch (err) {
        const auth = /auth|login|credential/i.test(err.message || '');
        return degraded(id, auth ? 'misconfigured' : 'unreachable',
          auth ? 'IMAP login failed — check user / app password.' : 'IMAP host unreachable.');
      } finally {
        try { await client.logout(); } catch { client.close?.(); }
      }
    },

    /** Open-set reconcile: planner cards for this source stay until unstarred. */
    async reconcileOpenIds() {
      if (cache) return { ok: true, ids: new Set(cache.items.map((t) => t.id)) };
      return { ok: false, ids: new Set() };
    },
  };
}
