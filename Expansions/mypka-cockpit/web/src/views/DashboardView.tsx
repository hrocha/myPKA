// DashboardView.tsx — the original health dashboard, now ONE section inside the
// cockpit (the "Health" view). The data hook, the four collapsible sections
// (Body / Planned / Trends / Mind), and the disclaimer are unchanged; only the
// page chrome moved up into the cockpit shell (App.tsx).
import { HeartPulse, AlertCircle } from 'lucide-react';
import './wellness.css';
import { PageHeader } from '../components/PageHeader';
import { useDashboard } from '../lib/useDashboard';
import { useCollapsed } from '../lib/useCollapsed';
import { DisclaimerBanner } from '../components/DisclaimerBanner';
import { Body } from '../sections/Body';
import { Mind } from '../sections/Mind';
import { Trends } from '../sections/Trends';
import { Planned } from '../sections/Planned';

function formatStamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function DashboardView() {
  const { data, loading, error } = useDashboard();

  const [bodyOpen, toggleBody] = useCollapsed('body', true);
  const [plannedOpen, togglePlanned] = useCollapsed('planned', true);
  const [trendsOpen, toggleTrends] = useCollapsed('trends', true);
  const [mindOpen, toggleMind] = useCollapsed('mind', true);

  return (
    <div className="dashboard-view">
      <PageHeader
        title="Health & Life"
        icon={HeartPulse}
        subtitle="A calm look at body and mind — at a glance."
      />

      {loading && <LoadingState />}
      {error && <ErrorState message={error} />}

      {data && (
        <main className="dashboard-main">
          <DisclaimerBanner />

          {/* v3 #1 — section order is BODY → MIND (patterns) → TRENDS → PLANNED.
              Tom wants the MIND "patterns" cards directly after the body values, so
              the psyche/patterns sit right under the Body readings, not at the
              very bottom. PLANNED (the path forward) closes the page. */}
          <Body
            metrics={data.body.metrics}
            diagnoses={data.body.diagnoses}
            labs={data.body.labs}
            open={bodyOpen}
            onToggle={toggleBody}
          />
          <Mind
            psyche={data.mind.psyche}
            topics={data.mind.topics}
            mood={data.mind.mood}
            open={mindOpen}
            onToggle={toggleMind}
          />
          <Trends
            weight={data.trends.weight}
            steps={data.trends.steps}
            sleep={data.trends.sleep}
            open={trendsOpen}
            onToggle={toggleTrends}
          />
          <Planned
            habits={data.planned.habits}
            openQuestions={data.planned.openQuestions}
            tasks={data.planned.tasks}
            nutritionPlan={data.planned.nutritionPlan}
            open={plannedOpen}
            onToggle={togglePlanned}
          />

          <footer className="dashboard-footer">
            <p className="dashboard-footer-note">
              Live from <span className="font-mono">mypka.db</span> · markdown is canonical, the DB
              derived. This view writes nothing. As of {formatStamp(data.dbMtime)}.
            </p>
          </footer>
        </main>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-md" aria-busy="true" aria-live="polite">
      <div className="h-[60px] animate-pulse rounded-panel bg-surface-1" />
      <div className="grid grid-cols-2 gap-md sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[110px] animate-pulse rounded-panel bg-surface-1" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-sm rounded-panel border border-border bg-surface-1 px-md py-md">
      <AlertCircle size={20} strokeWidth={1.5} className="mt-[2px] shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="text-body font-[520] text-fg">Could not load data</p>
        <p className="mt-xs text-caption leading-relaxed text-fg-muted">
          {message}. Is the local server running? Start it with the{' '}
          <span className="font-mono">start-cockpit.command</span> script.
        </p>
      </div>
    </div>
  );
}
