// WorkoutsView.tsx — the Workouts page (route map + ember heatmap). A sibling of
// TrackingView: same page chrome, same loading/error states. Owns the panel's
// data:
//   • catalogue  (/api/cockpit/workouts)       — fetched once
//   • basemap?   (/api/cockpit/basemap-status)  — fetched once (pluggable basemap)
//   • glow       (/api/cockpit/workout-heat?…)  — refetched on filter change
//   • route      (/api/cockpit/workout-route?id)— lazy, on selection
// Read-only via the generic useFetch hook (same as Tracking).
import { useMemo, useState } from 'react';
import { Map as MapIcon, AlertCircle } from 'lucide-react';
import './wellness.css';
import { useFetch } from '../lib/useCockpit';
import { ModuleEmptyState } from '../components/ui';
import { Workouts } from '../sections/Workouts';
import { PageHeader } from '../components/PageHeader';
import type {
  WorkoutCatalogue, WorkoutHeatResponse, WorkoutRouteResponse, BasemapStatus, WorkoutFilter,
} from '../lib/workoutTypes';

// Build the /workout-heat query from the active filter. Empty filter → no params
// (server returns every route). The bbox is intentionally NOT sent here: v1 glows
// the whole filtered set, and the server bbox-prefilter is a perf option we keep
// for a future viewport-driven refetch (Pax §5) without changing this contract.
function heatUrl(filter: WorkoutFilter): string {
  const p = new URLSearchParams();
  if (filter.type) p.set('type', filter.type);
  if (filter.from) p.set('from', filter.from);
  if (filter.to) p.set('to', filter.to);
  const qs = p.toString();
  return qs ? `/api/cockpit/workout-heat?${qs}` : '/api/cockpit/workout-heat';
}

export function WorkoutsView() {
  const { data: catalogue, loading, error } = useFetch<WorkoutCatalogue>('/api/cockpit/workouts');
  const { data: basemap } = useFetch<BasemapStatus>('/api/cockpit/basemap-status');

  const [filter, setFilter] = useState<WorkoutFilter>({ type: null, from: null, to: null });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Glow refetches whenever the filter (hence the URL) changes.
  const { data: heat } = useFetch<WorkoutHeatResponse>(heatUrl(filter));

  // Selected route — lazy: only fetched once a workout is chosen.
  const routeReq = useFetch<WorkoutRouteResponse>(
    selectedId != null ? `/api/cockpit/workout-route?id=${selectedId}` : null,
  );
  const selectedRoute = useMemo(
    () => (routeReq.data && routeReq.data.found && routeReq.data.feature ? routeReq.data.feature : null),
    [routeReq.data],
  );

  // Changing the filter must not strand a now-hidden selection — clear it if the
  // selected workout falls out of the filtered set.
  const onFilterChange = (next: WorkoutFilter) => {
    setFilter(next);
    if (selectedId != null && catalogue) {
      const w = catalogue.workouts.find((x) => x.id === selectedId);
      const stillVisible = w
        && (!next.type || (w.type || 'Unknown') === next.type)
        && (!next.from || (w.date && w.date >= next.from))
        && (!next.to || (w.date && w.date <= next.to));
      if (!stillVisible) setSelectedId(null);
    }
  };

  return (
    <div className="dashboard-view">
      <PageHeader
        title="Workouts"
        icon={MapIcon}
        subtitle="Routes and a glowing heat trail — where your feet have been."
      />

      {loading && <LoadingState />}
      {error && <ErrorState message={error} />}

      {/* No workout routes — a bare scaffold whose mirror has no workout/GPX tables
          (the server returns {workouts:[], types:[]}, not an error). Show an honest
          empty-state rather than mounting the heavy Leaflet map over an empty set. */}
      {catalogue && catalogue.workouts.length === 0 && (
        <main className="dashboard-main">
          <ModuleEmptyState title="No workout routes yet" icon={MapIcon}>
            Your mirror has no workout or GPX-route data yet. Run the SQLite upgrade to populate the
            workout tables (see <span className="font-mono">sqlite-extension/DATA-CONTRACT.md</span>),
            then re-run the mirror regen to bring your routes and heat trail in.
          </ModuleEmptyState>
        </main>
      )}

      {catalogue && catalogue.workouts.length > 0 && (
        <main className="dashboard-main">
          <Workouts
            workouts={catalogue.workouts}
            types={catalogue.types}
            heat={heat?.features ?? []}
            selectedId={selectedId}
            selectedRoute={selectedRoute}
            filter={filter}
            onFilterChange={onFilterChange}
            onSelect={setSelectedId}
            basemapPresent={basemap?.present ?? false}
            routeLoading={routeReq.loading}
          />

          <footer className="dashboard-footer">
            <p className="dashboard-footer-note">
              Live from <span className="font-mono">mypka.db</span> · GPX simplified server-side,
              basemap self-hosted. Read-only · nothing leaves this machine.
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
      <div className="h-[40px] animate-pulse rounded-panel bg-surface-1" />
      <div className="h-[420px] animate-pulse rounded-panel bg-surface-1" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-sm rounded-panel border border-border bg-surface-1 px-md py-md">
      <AlertCircle size={20} strokeWidth={1.5} className="mt-[2px] shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="text-body font-[520] text-fg">Could not load workout routes</p>
        <p className="mt-xs text-caption leading-relaxed text-fg-muted">
          {message}. Is the local server running? Start it with the{' '}
          <span className="font-mono">start-cockpit.command</span> script.
        </p>
      </div>
    </div>
  );
}
