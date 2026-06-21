// Workouts.tsx — the Workout-Map panel: a Leaflet canvas map (routes + ember
// glow) beside a filterable workout list. Mirrors the Tracking page's chrome
// (Section/Card primitives, GL-003 tokens, gentle empty states) so it sits in the
// cockpit exactly like Body / Mind / Tracking. Read-only end-to-end.
//
// The map and list are two halves of one section:
//   • Filter toolbar (type chips + a year range) drives BOTH the list and the
//     ember-glow (the glow refetches on filter change; the list filters client-
//     side from the already-loaded catalogue).
//   • Clicking a workout in the list highlights its route on the map (lazy-fetches
//     that one simplified GeoJSON line) and frames the camera to it.
//
// Mobile-first: on narrow screens the map stacks above the list (Tom checks this
// on his phone). The map gets a sensible fixed height; the list scrolls under it.
import { useMemo } from 'react';
import { Flame, Footprints, Bike, Mountain, Activity, MapPin } from 'lucide-react';
import { Card } from '../components/ui';
import { WorkoutMap } from '../components/WorkoutMap';
import type {
  WorkoutSummary, WorkoutTypeCount, HeatFeature, RouteFeature, WorkoutFilter,
} from '../lib/workoutTypes';

// ---- formatting (no shame, no scores — just facts) --------------------------
function fmtKm(km: number | null): string {
  if (km == null) return '—';
  return km >= 10 ? `${km.toFixed(0)} km` : `${km.toFixed(1)} km`;
}
function fmtDuration(sec: number | null): string {
  if (sec == null || sec <= 0) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function fmtDate(d: string | null): string {
  if (!d) return 'undated';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// A small icon per workout type — purely decorative, never a ranking.
function TypeIcon({ type }: { type: string | null }) {
  const t = (type || '').toLowerCase();
  if (t.includes('cycl') || t.includes('bike')) return <Bike size={15} strokeWidth={1.5} aria-hidden="true" />;
  if (t.includes('hik') || t.includes('mountain')) return <Mountain size={15} strokeWidth={1.5} aria-hidden="true" />;
  if (t.includes('run')) return <Activity size={15} strokeWidth={1.5} aria-hidden="true" />;
  if (t.includes('walk')) return <Footprints size={15} strokeWidth={1.5} aria-hidden="true" />;
  return <MapPin size={15} strokeWidth={1.5} aria-hidden="true" />;
}

// ---- Filter toolbar ----------------------------------------------------------
// A single-select type filter built on the shadcn ToggleGroup anatomy (shadcn.io
// MCP: get_component "toggle-group" — Radix Root/Item, roving focus, data-state on
// the active item, group-labelled). We reproduce the structure + a11y contract
// with zero Radix deps, the same way Sidebar.tsx reproduces the shadcn Sidebar.
function FilterToolbar({
  types,
  filter,
  onChange,
  years,
}: {
  types: WorkoutTypeCount[];
  filter: WorkoutFilter;
  onChange: (next: WorkoutFilter) => void;
  years: number[];
}) {
  return (
    <div className="workout-filter" role="group" aria-label="Filter workouts">
      <div className="workout-filter-row" role="group" aria-label="Workout type">
        <button
          type="button"
          className="workout-chip"
          data-state={filter.type === null ? 'on' : 'off'}
          aria-pressed={filter.type === null}
          onClick={() => onChange({ ...filter, type: null })}
        >
          All
        </button>
        {types.map((t) => (
          <button
            key={t.type}
            type="button"
            className="workout-chip"
            data-state={filter.type === t.type ? 'on' : 'off'}
            aria-pressed={filter.type === t.type}
            onClick={() => onChange({ ...filter, type: filter.type === t.type ? null : t.type })}
          >
            <TypeIcon type={t.type} />
            <span>{t.type}</span>
            <span className="workout-chip-count">{t.count}</span>
          </button>
        ))}
      </div>

      {years.length > 1 && (
        <label className="workout-year">
          <span className="workout-year-label">Year</span>
          <select
            className="workout-year-select"
            value={filter.from ? filter.from.slice(0, 4) : 'all'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all') onChange({ ...filter, from: null, to: null });
              else onChange({ ...filter, from: `${v}-01-01`, to: `${v}-12-31` });
            }}
          >
            <option value="all">All years</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

// ---- Place line --------------------------------------------------------------
// Offline reverse-geocoded place on each route card. locationName is the primary
// label (city/place); admin + country are the quieter secondary line. NULL
// locationName means indoor / no route → render nothing (no "Unknown" placeholder).
// The cities1000 dataset snaps to the nearest ≥1000-pop place ("Ottersberg" not
// "Lilienthal"); that's expected for a card label and is not corrected here.
function WorkoutPlace({ workout }: { workout: WorkoutSummary }) {
  if (!workout.locationName) return null;
  const sub = [workout.locationAdmin, workout.locationCountry]
    .filter((p): p is string => Boolean(p))
    .join(' · ');
  const full = [workout.locationName, workout.locationAdmin, workout.locationCountry]
    .filter((p): p is string => Boolean(p))
    .join(', ');
  return (
    <span className="workout-row-place" title={full}>
      <MapPin size={12} strokeWidth={1.5} aria-hidden="true" />
      <span className="workout-row-place-name">{workout.locationName}</span>
      {sub && <span className="workout-row-place-sub">{sub}</span>}
    </span>
  );
}

// ---- Workout list row --------------------------------------------------------
function WorkoutRow({
  workout,
  selected,
  onSelect,
}: {
  workout: WorkoutSummary;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="workout-row"
        data-selected={selected}
        aria-pressed={selected}
        onClick={() => onSelect(workout.id)}
      >
        <span className="workout-row-icon" aria-hidden="true"><TypeIcon type={workout.type} /></span>
        <span className="workout-row-main">
          <span className="workout-row-type">{workout.type || 'Workout'}</span>
          <WorkoutPlace workout={workout} />
          <span className="workout-row-date">{fmtDate(workout.date)}</span>
        </span>
        <span className="workout-row-stats">
          <span className="workout-row-km">{fmtKm(workout.distanceKm)}</span>
          <span className="workout-row-dur">{fmtDuration(workout.durationSec)}</span>
        </span>
      </button>
    </li>
  );
}

export function Workouts({
  workouts,
  types,
  heat,
  selectedId,
  selectedRoute,
  filter,
  onFilterChange,
  onSelect,
  basemapPresent,
  routeLoading,
}: {
  workouts: WorkoutSummary[];
  types: WorkoutTypeCount[];
  heat: HeatFeature[];
  selectedId: number | null;
  selectedRoute: RouteFeature | null;
  filter: WorkoutFilter;
  onFilterChange: (next: WorkoutFilter) => void;
  onSelect: (id: number) => void;
  basemapPresent: boolean;
  routeLoading: boolean;
}) {
  // Client-side list filter (the catalogue is already loaded; the glow refetches
  // server-side). Year filter reuses the from/to the toolbar set.
  const filtered = useMemo(() => {
    return workouts.filter((w) => {
      if (filter.type && (w.type || 'Unknown') !== filter.type) return false;
      if (filter.from && (!w.date || w.date < filter.from)) return false;
      if (filter.to && (!w.date || w.date > filter.to)) return false;
      return true;
    });
  }, [workouts, filter]);

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const w of workouts) {
      if (w.date) set.add(Number(w.date.slice(0, 4)));
    }
    return [...set].filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
  }, [workouts]);

  const totalKm = useMemo(
    () => filtered.reduce((s, w) => s + (w.distanceKm || 0), 0),
    [filtered],
  );

  if (workouts.length === 0) {
    return (
      <Card>
        <div className="workout-empty">
          <MapPin size={24} strokeWidth={1.25} aria-hidden="true" />
          <p className="workout-empty-title">No routes yet</p>
          <p className="workout-empty-sub">
            Outdoor walks, runs and rides with GPS land here as a map and a glowing
            heat trail. The backfill is still importing — they will appear as they sync.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="workout-panel">
      <FilterToolbar types={types} filter={filter} onChange={onFilterChange} years={years} />

      <div className="workout-layout">
        <div className="workout-map-col">
          <WorkoutMap
            workouts={filtered}
            heat={heat}
            selectedRoute={selectedRoute}
            basemapPresent={basemapPresent}
          />
          <p className="workout-map-caption">
            <Flame size={13} strokeWidth={1.5} aria-hidden="true" />
            {filtered.length} route{filtered.length === 1 ? '' : 's'} glowing · {fmtKm(totalKm)} total
            {routeLoading && <span className="workout-map-loading"> · loading route…</span>}
          </p>
        </div>

        <div className="workout-list-col">
          {filtered.length === 0 ? (
            <p className="workout-list-empty">No routes match this filter.</p>
          ) : (
            <ul className="workout-list" aria-label="Workout routes">
              {filtered.map((w) => (
                <WorkoutRow
                  key={w.id}
                  workout={w}
                  selected={w.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
