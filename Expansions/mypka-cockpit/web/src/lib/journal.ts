// journal.ts — client types + write/launch helpers for the manual journal-entry
// flow (Feature #9). Mirrors fleeting.ts: thin typed wrappers over cockpitWrite
// (which carries the X-Cockpit CSRF header + same-origin credentials) and a
// read helper for raw (un-mirrored) entries.
//
// Server contracts (server/server.js + journalEntries.js):
//   GET  /api/cockpit/journal/raw        -> { entries: RawJournalEntry[] }
//   POST /api/cockpit/journal/new        -> 201 { ok, slug, title, date, relPath, mtime }
//   POST /api/cockpit/journal/integrate  -> { ok, launched, command, slug }
import { cockpitWrite, type WriteResult } from './useCockpitWrite';
import { verifyThenSignalAuthExpired } from './auth';

/** A raw, manually-added entry read straight off the file layer (not yet in the
 *  mirror). Shaped to drop straight into the timeline alongside FeedEntry. */
export interface RawJournalEntry {
  slug: string;
  title: string;
  date: string;
  integrationStatus: 'raw';
  manuallyAdded: true;
  excerpt: string;
  contentLength: number;
  mtime: number;
}

export interface RawEntriesResponse {
  entries: RawJournalEntry[];
}

export interface CreateJournalResult {
  ok: true;
  slug: string;
  title: string;
  date: string;
  relPath: string;
  mtime: number;
}

export interface IntegrateResult {
  ok: true;
  /** true on macOS (Terminal launched); false elsewhere (command returned to copy). */
  launched: boolean;
  command: string;
  slug: string;
}

/** GET the raw (un-mirrored) manual entries. Read-only, calm-degrades to []. */
export async function fetchRawEntries(): Promise<RawJournalEntry[]> {
  const r = await fetch('/api/cockpit/journal/raw', { credentials: 'same-origin' });
  if (r.status === 401) {
    void verifyThenSignalAuthExpired();
    return [];
  }
  if (!r.ok) return [];
  const data = (await r.json()) as RawEntriesResponse;
  return Array.isArray(data?.entries) ? data.entries : [];
}

/** POST a new manual journal entry. date omitted → server uses today (local). */
export function createJournalEntry(
  title: string,
  body: string,
  date?: string,
): Promise<WriteResult<CreateJournalResult>> {
  const payload: { title: string; body: string; date?: string } = { title, body };
  if (date) payload.date = date;
  return cockpitWrite<CreateJournalResult>('/api/cockpit/journal/new', 'POST', payload);
}

/** POST to launch Penn's integration hand-off for one raw entry. */
export function integrateJournalEntry(slug: string): Promise<WriteResult<IntegrateResult>> {
  return cockpitWrite<IntegrateResult>('/api/cockpit/journal/integrate', 'POST', { slug });
}
