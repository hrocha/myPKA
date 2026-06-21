// wellness.js — mounts the Health / Tracking / Workouts read-only API surface
// (ported from the reference instance + modules/health + modules/workouts,
// 2026-06-11). Pure GETs; markdown stays canonical, mypka.db read-only.
//
// WIRING (server.js, after the auth middleware and BEFORE the /api 404
// catch-all — the registerPlannerRoutes call site is the natural neighbor):
//   import { registerWellnessRoutes } from './wellness.js';
//   registerWellnessRoutes(app, { safe });
//
// DEGRADATION CONTRACT: a member's mypka.db may not have the optional
// health_* / habit_logs / food_logs tables yet, and PKM/My Life/Key Elements/
// health.md may not exist. Every data module behind these routes degrades to
// empty data (see wellnessDb.js optionalStmt) — the endpoints answer 200 with
// calm empty shapes, the views render their not-yet-tracked states, and the
// server boot NEVER depends on the optional schema.
//
// Routes:
//   GET /api/dashboard               — combined Health & Life payload
//   GET /api/body|/api/mind|/api/trends|/api/planned — sections, for debugging
//   GET /api/tracking                — habit streaks + photo-nutrition gallery
//   GET /api/cockpit/workouts        — workout-route catalogue (no geometry)
//   GET /api/cockpit/workout-route   — one simplified GeoJSON LineString (?id=)
//   GET /api/cockpit/workout-heat    — FeatureCollection of all/filtered tracks
//   GET /api/cockpit/basemap-status  — is the self-hosted .pmtiles present?
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './db.js';
import {
  getBodyMetrics, getTrends, getMindTopics, getPsyche, getMindMood, getHabits,
} from './queries.js';
import {
  getLabs, getDiagnoses, getOpenQuestions, getPersonalTasks, getNutritionPlan,
} from './markdown.js';
import { getTracking } from './tracking.js';
import { listWorkouts, getWorkoutRoute, getWorkoutHeat } from './gpxRoute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Self-hosted PMTiles basemap probe (pluggable — see modules/workouts/INSTALL.md).
// In dev Vite serves web/public/* at /basemap/*; the built SPA copies the file
// into web/dist. If the archive is absent the client renders routes/heat on a
// neutral background with a quiet hint — never a crash, never a cloud tile.
const BASEMAP_FILE = path.resolve(__dirname, '..', 'web', 'dist', 'basemap', 'germany-z14.pmtiles');
const BASEMAP_FILE_DEV = path.resolve(__dirname, '..', 'web', 'public', 'basemap', 'germany-z14.pmtiles');

export function registerWellnessRoutes(app, { safe }) {
  // ---- Health & Life dashboard ---------------------------------------------
  // One combined endpoint keeps the client a single fetch; sections are also
  // individually addressable for debugging.
  app.get('/api/dashboard', safe(() => ({
    generatedAt: new Date().toISOString(),
    dbMtime: fs.statSync(DB_PATH).mtime.toISOString(),
    body: {
      metrics: getBodyMetrics(),
      diagnoses: getDiagnoses(),
      labs: getLabs(),
    },
    mind: {
      psyche: getPsyche(),
      topics: getMindTopics(),
      mood: getMindMood(),
    },
    trends: getTrends(),
    planned: {
      habits: getHabits(),
      openQuestions: getOpenQuestions(),
      tasks: getPersonalTasks(),
      nutritionPlan: getNutritionPlan(),
    },
  })));

  app.get('/api/body', safe(() => ({ metrics: getBodyMetrics(), diagnoses: getDiagnoses(), labs: getLabs() })));
  app.get('/api/mind', safe(() => ({ psyche: getPsyche(), topics: getMindTopics(), mood: getMindMood() })));
  app.get('/api/trends', safe(getTrends));
  app.get('/api/planned', safe(() => ({
    habits: getHabits(), openQuestions: getOpenQuestions(),
    tasks: getPersonalTasks(), nutritionPlan: getNutritionPlan(),
  })));

  // ---- Tracking: habit streaks + photo-nutrition gallery --------------------
  // Photos are served through the existing /api/cockpit/media route (PKM/
  // containment) — not re-implemented here.
  app.get('/api/tracking', safe(() => getTracking()));

  // ---- Workout map: routes + ember heatmap ----------------------------------
  // Geometry endpoints read GPX from PKM/ via gpxRoute.js's own containment and
  // XXE-safe parser; the simplified-GeoJSON cache is a derived artifact.
  app.get('/api/cockpit/workouts', safe(() => listWorkouts()));
  app.get('/api/cockpit/workout-route', safe((req) => getWorkoutRoute(req.query.id)));
  app.get('/api/cockpit/workout-heat', safe((req) => getWorkoutHeat(req.query)));

  app.get('/api/cockpit/basemap-status', safe(() => ({
    present: fs.existsSync(BASEMAP_FILE) || fs.existsSync(BASEMAP_FILE_DEV),
    path: 'basemap/germany-z14.pmtiles',
  })));

  console.log('  wellness: routes mounted (health dashboard / tracking / workouts — read-only; optional tables degrade to empty)');
}
