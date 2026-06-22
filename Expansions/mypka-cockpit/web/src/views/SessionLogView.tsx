// SessionLogView.tsx — the "Team Session Log" page (split out of the old combined
// RosterView, 2026-06). One of the five destinations on the sidebar's "My AI
// Team" fly-out. A single full-height column: the page header, then the team's
// session-log history feed in its own contained scroll region (so the list
// scrolls inside the panel, not the whole window) — the same independent-scroll
// idiom the old two-column page used, now given the full viewport height.
//
// Read-only, loopback/LAN posture like every other view. Every value is a GL-003
// token; no hardcoded colours or sizes; the `truncate` class is never used.
import { useEffect, useId, useRef } from 'react';
import { ScrollText } from 'lucide-react';
import { S } from '../lib/strings';
import { PageHeader } from '../components/PageHeader';
import { SessionLogFeed } from './team/SessionLogFeed';
import './team.css';

export function SessionLogView() {
  const topRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, []);

  return (
    <section ref={topRef} className="roster-view team-page-view team-solo-view animate-fade-rise">
      <PageHeader title={S.team.sessionLog.title} icon={ScrollText} subtitle={S.team.sessionLog.sub} />

      {/* A single full-height column: heading + its own contained scroll region.
          .team-solo-scroll mirrors the old .team-feed-scroll (overflow-y:auto +
          overscroll-behavior:contain) but fills the page height — team.css. */}
      <section className="team-solo-col" aria-labelledby={headingId}>
        <h2 id={headingId} className="team-col-head">
          <ScrollText size={16} strokeWidth={1.5} aria-hidden="true" /> {S.roster.feedTitle}
        </h2>
        <div className="team-solo-scroll">
          <SessionLogFeed />
        </div>
      </section>
    </section>
  );
}
