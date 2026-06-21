// TrackingView.tsx — the Tracking page (habit streaks + photo-nutrition gallery).
// A sibling of DashboardView: same page chrome, same loading/error states, same
// collapsible-section model. Reads /api/tracking via the generic read-only hook.
import { LineChart, AlertCircle } from 'lucide-react';
import './wellness.css';
import { useFetch } from '../lib/useCockpit';
import { useCollapsed } from '../lib/useCollapsed';
import { ModuleEmptyState } from '../components/ui';
import { Tracking } from '../sections/Tracking';
import { PageHeader } from '../components/PageHeader';
import type { TrackingData } from '../lib/trackingTypes';

export function TrackingView() {
  const { data, loading, error } = useFetch<TrackingData>('/api/tracking');

  const [habitsOpen, toggleHabits] = useCollapsed('tracking-habits', true);
  const [foodOpen, toggleFood] = useCollapsed('tracking-food', true);

  return (
    <div className="dashboard-view">
      <PageHeader
        title="Tracking"
        icon={LineChart}
        subtitle="Habits and meals — a gentle record, never a verdict."
      />

      {loading && <LoadingState />}
      {error && <ErrorState message={error} />}

      {data && (
        <main className="dashboard-main">
          {/* Both halves empty — a bare scaffold whose mirror has no habit_logs /
              food_logs (the server returns {habits:[], food:[]}, not an error). One
              calm orienting note points to the fix; the per-section states below
              keep their own gentle "nothing logged yet" copy. */}
          {data.habits.length === 0 && data.food.length === 0 && (
            <ModuleEmptyState title="Nothing to track yet" icon={LineChart}>
              Your mirror has no habit check-ins or meal logs yet. Habits and meals you keep in your
              markdown notes appear here after the next mirror regen; if these never populate, run
              the SQLite upgrade (see{' '}
              <span className="font-mono">sqlite-extension/DATA-CONTRACT.md</span>).
            </ModuleEmptyState>
          )}
          <Tracking
            habits={data.habits}
            food={data.food}
            habitsOpen={habitsOpen}
            onToggleHabits={toggleHabits}
            foodOpen={foodOpen}
            onToggleFood={toggleFood}
          />

          <footer className="dashboard-footer">
            <p className="dashboard-footer-note">
              Live from <span className="font-mono">mypka.db</span> · markdown is canonical, the DB
              derived. This view writes nothing.
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
      <div className="grid gap-md lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[150px] animate-pulse rounded-panel bg-surface-1" />
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
        <p className="text-body font-[520] text-fg">Could not load tracking data</p>
        <p className="mt-xs text-caption leading-relaxed text-fg-muted">
          {message}. Is the local server running? Start it with the{' '}
          <span className="font-mono">start-cockpit.command</span> script.
        </p>
      </div>
    </div>
  );
}
