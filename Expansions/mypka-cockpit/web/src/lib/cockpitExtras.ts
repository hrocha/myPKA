// cockpitExtras.ts — typed client contracts + write helpers for the invoice +
// runtime-settings surfaces (server/invoicesApi.js + server/cockpitSettingsRoutes.js).
// Strict; no `any`. Read shapes are consumed via useFetch; the settings write
// rides the shared cockpitWrite envelope (X-Cockpit CSRF belt + session cookie).
import { cockpitWrite, type WriteResult } from './useCockpitWrite';

// ---- Open invoices (GET /api/cockpit/invoices/open) -------------------------
// `available` is false only against a foreign mirror lacking Silas's
// v_open_invoices view — the Hub then shows a calm "not set up" note.
export interface OpenInvoice {
  slug: string;
  title: string;
  invoiceNumber: string | null;
  payeeSlug: string | null;
  payee: string | null;     // first linked org slug resolved to its title
  amount: number | null;
  currency: string;         // ISO code, default 'EUR'
  dueDate: string | null;   // ISO YYYY-MM-DD
  daysUntilDue: number | null; // negative = overdue
  isOverdue: boolean;
  isDueSoon: boolean;       // due within ≤7 days and not overdue
  filePath: string | null;  // myPKA-root-relative
}

export interface OpenInvoicesResponse {
  available: boolean;
  items: OpenInvoice[];
  total: number;
}

// ---- Runtime Hub-module prefs (GET/PUT /api/cockpit/settings) ----------------
// `modules` is a full, default-filled map { moduleKey: boolean }; `catalogue`
// is the server's KNOWN_MODULES — the single source for what the Settings page
// renders (so the UI never hardcodes the toggle list).
export interface ModuleCatalogueEntry {
  key: string;
  label: string;
  hint: string;
}

export interface CockpitSettingsResponse {
  modules: Record<string, boolean>;
  // The known module keys in saved display order — the Hub renders modules in
  // this sequence (still respecting `modules` for visibility).
  order: string[];
  catalogue: ModuleCatalogueEntry[];
}

export interface SettingsWriteOk {
  ok: true;
  modules: Record<string, boolean>;
  order: string[];
  catalogue: ModuleCatalogueEntry[];
}

// PUT /api/cockpit/settings — body carries `modules` (visibility) and/or `order`
// (display sequence); the two are independent. At least one must be present.
interface SettingsWriteBody {
  modules?: Record<string, boolean>;
  order?: string[];
}

// Toggle one or more modules' visibility. Does not change order.
export function saveModulePrefs(
  modules: Record<string, boolean>,
): Promise<WriteResult<SettingsWriteOk>> {
  return cockpitWrite<SettingsWriteOk>('/api/cockpit/settings', 'PUT', { modules } satisfies SettingsWriteBody);
}

// Persist the full display order. `order` must be a permutation of the known set
// (the server rejects anything else with a 400). Does not change visibility.
export function saveModuleOrder(
  order: string[],
): Promise<WriteResult<SettingsWriteOk>> {
  return cockpitWrite<SettingsWriteOk>('/api/cockpit/settings', 'PUT', { order } satisfies SettingsWriteBody);
}

// The stable module keys the Hub gates on. Kept in sync with the server's
// KNOWN_MODULES (cockpitSettingsDb.js) — the closed set the PUT validator allows.
export const MODULE_KEYS = {
  openInvoices: 'open_invoices',
  recentlyScanned: 'recently_scanned',
  buckets: 'buckets',
  pinned: 'pinned',
  whiteboards: 'whiteboards',
  latestDocuments: 'latest_documents',
  latestJournal: 'latest_journal',
  randomQuote: 'random_quote',
  onThisDay: 'on_this_day',
} as const;

// ---- Random quote (GET /api/cockpit/quotes/random) --------------------------
// `available` is false only against a mirror lacking the optional `quotes` table
// (no --with-quotes upgrade) — the Hub then shows a calm "not set up" note.
// `quote` is null when the table exists but is empty (honest empty state).
export interface RandomQuote {
  slug: string;
  quoteText: string | null;
  author: string | null;      // display string, or the resolved Person slug
  authorSlug: string | null;  // Person slug when the author was a [[wikilink]]
  source: string | null;      // book / talk / page
  year: number | null;
  tags: string[];
  filePath: string | null;    // root-relative (PKM/Quotes/<slug>.md)
}

export interface RandomQuoteResponse {
  available: boolean;
  quote: RandomQuote | null;
}

// ---- On This Day (GET /api/cockpit/journal/on-this-day) ---------------------
// Journal entries from the SAME calendar day across prior periods, grouped into
// "how long ago" buckets (near → far). `available` is false only on a foreign
// mirror missing the core `journal` table (boot would already have failed for a
// real myPKA mirror); empty `buckets` is the normal "nothing this day" case.
export interface OnThisDayMedia {
  filePath: string | null;  // PKM/-relative — served via /api/cockpit/media
  mediaType: string | null;
  mimeType: string | null;
  caption: string | null;
}

export interface OnThisDayEntry {
  bucketKey: string;
  bucketLabel: string;        // e.g. "1 month ago", "2 years ago"
  slug: string;
  title: string;
  entryDate: string | null;   // ISO YYYY-MM-DD
  content: string;            // full body — the UI truncates
  filePath: string | null;
  media: OnThisDayMedia[];
}

export interface OnThisDayBucket {
  key: string;
  label: string;
  date: string | null;        // exact target date for discrete buckets; null for the per-year tail
  entries: OnThisDayEntry[];
}

export interface OnThisDayResponse {
  available: boolean;
  anchorDate: string | null;
  buckets: OnThisDayBucket[];
}
