// RandomQuoteCard.tsx — the Hub's "Random quote" module.
//
// Reads the read-only /api/cockpit/quotes/random endpoint (Silas's DATA-CONTRACT
// §8 query — ORDER BY RANDOM() LIMIT 1, tags parsed server-side, NULL scalars →
// null). Renders the quote text, the attribution (author, deep-linking to the
// CRM Person note when author_slug is present), and source/year. Clicking the
// card opens the full quote — quotes are markdown docs (PKM/Quotes/<slug>.md), so
// we route to the file reading view (FileView), reusing the existing note/file
// view path rather than the entity note view (quotes aren't an ENTITY type).
//
// Empty / not-set-up states use ModuleEmptyState (GL-003 §8.7), pointing at the
// --with-quotes SQLite upgrade. Tokens only; styling in hub.css (.hub-quote*).
import { Quote as QuoteIcon, ArrowRight } from 'lucide-react';
import { useFetch } from '../../lib/useCockpit';
import { navigate, hrefFor, fileRouteSrc } from '../../lib/router';
import { ModuleEmptyState } from '../../components/ui';
import type { RandomQuote, RandomQuoteResponse } from '../../lib/cockpitExtras';

// A quote's PKM/Quotes/<slug>.md → the FileView route. The /api/cockpit/file jail
// is PKM/-relative, so strip a leading "PKM/" from the root-relative file_path.
function fileRouteForQuote(q: RandomQuote): string | null {
  if (!q.filePath) return null;
  const rel = q.filePath.replace(/^PKM\//, '');
  return fileRouteSrc('file', rel);
}

function QuoteCardHeader() {
  return (
    <header className="hub-section-head">
      <h2 className="hub-section-title">
        <QuoteIcon size={15} strokeWidth={1.5} aria-hidden="true" />
        Random quote
      </h2>
      <p className="hub-section-hint">A line from your Quotes library</p>
    </header>
  );
}

export function RandomQuoteCard() {
  const { data } = useFetch<RandomQuoteResponse>('/api/cockpit/quotes/random');
  // Still loading (or a settled error) — render nothing; the Hub stays calm and
  // the section appears once data settles (mirrors OpenInvoicesCard posture).
  if (!data) return null;

  // Mirror has no `quotes` table (no --with-quotes upgrade) — honest empty state.
  if (!data.available) {
    return (
      <section className="hub-section">
        <QuoteCardHeader />
        <ModuleEmptyState title="No quotes library yet" icon={QuoteIcon}>
          Your mirror has no <span className="font-mono">quotes</span> table. Run the SQLite
          upgrade with <span className="font-mono">--with-quotes</span> (see{' '}
          <span className="font-mono">sqlite-extension/DATA-CONTRACT.md</span> §8), then add{' '}
          <span className="font-mono">doc_type: quote</span> notes under{' '}
          <span className="font-mono">PKM/Quotes/</span> and regenerate.
        </ModuleEmptyState>
      </section>
    );
  }

  // Table present but empty (zero rows) — calm, honest empty state.
  if (!data.quote) {
    return (
      <section className="hub-section">
        <QuoteCardHeader />
        <ModuleEmptyState title="Your Quotes library is empty" icon={QuoteIcon}>
          Add a quote as a <span className="font-mono">doc_type: quote</span> note under{' '}
          <span className="font-mono">PKM/Quotes/</span> and regenerate the mirror to see it here.
        </ModuleEmptyState>
      </section>
    );
  }

  const q = data.quote;
  const fileRoute = fileRouteForQuote(q);

  // Attribution line: author (deep-linked when a CRM Person slug resolved),
  // then source, then year — each rendered only when present (null → blank).
  const authorHref = q.authorSlug ? hrefFor({ name: 'resolve', slug: q.authorSlug }) : null;

  return (
    <section className="hub-section">
      <QuoteCardHeader />
      <figure className="hub-quote">
        <blockquote
          className="hub-quote-text"
          onClick={fileRoute ? () => navigate({ name: 'file', src: fileRoute }) : undefined}
          role={fileRoute ? 'button' : undefined}
          tabIndex={fileRoute ? 0 : undefined}
          onKeyDown={
            fileRoute
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate({ name: 'file', src: fileRoute });
                  }
                }
              : undefined
          }
        >
          {q.quoteText ?? ''}
        </blockquote>
        <figcaption className="hub-quote-cite">
          {q.author && (
            authorHref ? (
              <a className="hub-quote-author" href={authorHref}>
                {q.author}
              </a>
            ) : (
              <span className="hub-quote-author">{q.author}</span>
            )
          )}
          {q.source && <span className="hub-quote-source">{q.source}</span>}
          {q.year != null && <span className="hub-quote-year">{q.year}</span>}
        </figcaption>
        {fileRoute && (
          <button
            type="button"
            className="hub-section-action hub-quote-open"
            onClick={() => navigate({ name: 'file', src: fileRoute })}
          >
            Open quote
            <ArrowRight size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </figure>
    </section>
  );
}
