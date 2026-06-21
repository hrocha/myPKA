// workoutTypes.ts — types mirroring the /api/cockpit/workouts, /workout-route and
// /workout-heat payloads (server/gpxRoute.js). Strict; no `any`.

// One workout that has a route. Geometry is NOT included here — the list is light;
// geometry is fetched lazily per selected workout, and the glow once. distance/
// energy/HR are raw numbers; the client formats and filters them.
export interface WorkoutSummary {
  id: number;
  uuid: string | null;
  type: string | null;
  date: string | null;       // local_date YYYY-MM-DD
  startUtc: string | null;
  durationSec: number | null;
  distanceKm: number | null;
  energyKcal: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  ascentM: number | null;
  // Offline reverse-geocoded place (cities1000 → nearest ≥1000-pop place). NULL
  // locationName = indoor / no route → render no location block (no placeholder).
  locationName: string | null;   // primary label, e.g. "Ottersberg", "Basel"
  locationAdmin: string | null;  // region/state, e.g. "Lower Saxony", "Basel-City"
  locationCountry: string | null; // ISO alpha-2, e.g. "DE", "CH"
  pointCount: number;
  // [minLon, minLat, maxLon, maxLat] — lets the map frame without loading geometry.
  bbox: [number, number, number, number] | null;
}

export interface WorkoutTypeCount {
  type: string;
  count: number;
}

export interface WorkoutCatalogue {
  workouts: WorkoutSummary[];
  types: WorkoutTypeCount[];
  count: number;
}

// A GeoJSON LineString Feature (the highlighted single route). Coordinates are
// [lon, lat] pairs (GeoJSON order); Leaflet wants [lat, lon] so the map layer
// flips them at render time.
export interface RouteFeature {
  type: 'Feature';
  properties: {
    workout_id: number;
    type: string | null;
    date: string | null;
    raw_points: number;
    points: number;
  };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

export interface WorkoutRouteResponse {
  found: boolean;
  cached?: boolean;
  feature?: RouteFeature;
  error?: string;
}

// The ember-glow source: a FeatureCollection of every (filtered) simplified track.
// v1 renders these as additive low-opacity polylines; properties are stripped to
// just the id (the glow layer needs no per-feature metadata).
export interface HeatFeature {
  type: 'Feature';
  properties: { id: number };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

export interface WorkoutHeatResponse {
  type: 'FeatureCollection';
  features: HeatFeature[];
  meta: { considered: number; included: number; skipped: number };
}

export interface BasemapStatus {
  present: boolean;
  path: string;
}

// The active client-side filter for the list + glow. `type === null` = all types.
export interface WorkoutFilter {
  type: string | null;
  from: string | null; // YYYY-MM-DD
  to: string | null;
}
