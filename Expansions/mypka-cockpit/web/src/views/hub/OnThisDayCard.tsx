// OnThisDayCard.tsx — the Hub's "On This Day" module.
//
// Reads the read-only /api/cockpit/journal/on-this-day endpoint (Silas's
// DATA-CONTRACT §9 — journal entries from the SAME calendar day across prior
// periods: 1 month / 6 months / 1 year / 2 years ago, then every prior year in
// the tail; calendar math is done server-side in app code). Entries arrive
// grouped into "how long ago" buckets, near → far, each with its embedded images
// (journal_media, PKM/-relative file_path → /api/cockpit/media).
//
// Per entry: the embedded image(s) (capped to the first few + "more"), the
// TRUNCATED body text (capped to save space — truncation is a UI choice per §9),
// the date + title. Clicking opens the full journal entry (the existing
// note/journal/:slug view). Calm empty state when there's nothing this day.
// Tokens only; styling in hub.css (.hub-otd*).
import { History } from 'lucide-react';
import { useFetch } from '../../lib/useCockpit';
import { hrefFor } from '../../lib/router';
import { MediaImage } from '../../components/MediaImage';
import type { OnThisDayEntry, OnThisDayResponse } from '../../lib/cockpitExtras';

// How many embedded images to show per entry before collapsing to "+N more".
const MAX_IMAGES = 2;
// Truncated body length (chars) — enough to recall the entry, small enough to
// keep the Hub scannable. Cut on a word boundary, append an ellipsis.
const BODY_CAP = 220;

function truncateBody(body: string): string {
  // Strip leading "## Media"/markdown-image noise the body might still carry,
  // then collapse whitespace so the preview reads as prose, not source.
  const clean = body
    .replace(/!\[\[[^\]]*\]\]/g, '') // ![[embed]] tokens
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // ![alt](url) images
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= BODY_CAP) return clean;
  const slice = clean.slice(0, BODY_CAP);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > BODY_CAP * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

function EntryRow({ entry }: { entry: OnThisDayEntry }) {
  const href = hrefFor({ name: 'note', type: 'journal', slug: entry.slug });
  const images = entry.media.filter((m) => m.filePath && (m.mediaType == null || m.mediaType !== 'audio'));
  const shown = images.slice(0, MAX_IMAGES);
  const extra = images.length - shown.length;
  const preview = truncateBody(entry.content);

  return (
    <a role="listitem" className="hub-otd-entry" href={href}>
      <div className="hub-otd-entry-head">
        <span className="hub-otd-entry-title">{entry.title}</span>
        {entry.entryDate && <span className="hub-otd-entry-date">{entry.entryDate}</span>}
      </div>
      {shown.length > 0 && (
        <div className="hub-otd-images" data-count={shown.length}>
          {shown.map((m, i) => (
            <MediaImage key={`${entry.slug}-${i}`} path={m.filePath as string} caption={m.caption} />
          ))}
          {extra > 0 && <span className="hub-otd-images-more">+{extra} more</span>}
        </div>
      )}
      {preview && <p className="hub-otd-entry-body">{preview}</p>}
    </a>
  );
}

export function OnThisDayCard() {
  const { data } = useFetch<OnThisDayResponse>('/api/cockpit/journal/on-this-day');
  // Still loading (or a settled error) — render nothing; the Hub stays calm.
  if (!data) return null;

  // `available:false` only on a foreign mirror missing core `journal` (a real
  // myPKA mirror fails boot first) — render nothing rather than a scary error.
  if (!data.available) return null;

  const hasAny = data.buckets.some((b) => b.entries.length > 0);

  return (
    <section className="hub-section">
      <header className="hub-section-head">
        <h2 className="hub-section-title">
          <History size={15} strokeWidth={1.5} aria-hidden="true" />
          On This Day
        </h2>
        <p className="hub-section-hint">This calendar day in months and years past</p>
      </header>

      {!hasAny ? (
        <p className="hub-empty">Nothing from this day in your history yet.</p>
      ) : (
        <div className="hub-otd">
          {data.buckets.map((bucket) => (
            <div key={bucket.key} className="hub-otd-bucket">
              <h3 className="hub-otd-bucket-label">{bucket.label}</h3>
              <div className="hub-otd-entries" role="list">
                {bucket.entries.map((entry) => (
                  <EntryRow key={entry.slug} entry={entry} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
