// gpxRoute.js — read-only GPX → simplified-GeoJSON conversion + on-disk cache for
// the Workout-Map panel. Pure SELECTs against mypka.db (read-only) for the route
// catalogue; the GPX→GeoJSON step parses XML and is therefore the security-
// sensitive part of this module (Vex re-verifies before go-live). The design
// choices below are deliberate defense-in-depth:
//
//   XXE-SAFE GPX PARSING (Vex / Pax flag):
//     • We do NOT use a full XML/DOM parser. We extract <trkpt lat=… lon=…>
//       attributes with a narrow, anchored regex over the raw text. There is no
//       DTD processing, no entity expansion, no external-entity / SYSTEM / file://
//       resolution, no network fetch — the parser cannot be steered to read a
//       local file or call out. A `<!DOCTYPE>` / `<!ENTITY>` declaration is
//       detected and the file is REJECTED (we never expand entities), and any
//       residual character/entity reference inside an attribute value is treated
//       as inert text, never resolved. This matches the cockpit's existing posture
//       (healthIngest.js parses GPX byte-prefix only, never as XML).
//     • Coordinates are validated numerically (finite, lat∈[-90,90],
//       lon∈[-180,180]) before they enter the GeoJSON. Bad points are dropped.
//     • The GPX files come from our own Apple-Health ingest, but this is
//       defense-in-depth: a poisoned file can at worst yield an empty/short track.
//
//   CACHE: the simplified GeoJSON is written ONCE next to the GPX as
//     <uuid>.simplified.geojson and reused on every later request. The cache key
//     includes the source file's sha256 + the simplify tolerance + a schema
//     version, so a re-ingested GPX or a tolerance change invalidates cleanly.
//     This is the cockpit's ONLY write to PKM/ from the read server — and it is a
//     DERIVED-ARTIFACT cache, never source data (markdown/GPX stay canonical). It
//     is namespaced (.simplified.geojson) so it can be safely bulk-deleted. If the
//     cache dir is not writable, we fall back to compute-on-the-fly (no crash).
//
//   PERF: Ramer–Douglas–Peucker simplification (dependency-free) collapses a
//     2,000–10,000-point track to a few hundred vertices with no visible loss at
//     map zoom. RDP runs on the cache-miss path only.

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './db.js';
// SCAFFOLD ADAPTATION (2026-06-11): health_workout / health_workout_route are
// OPTIONAL tables (absent until the Apple-Health workout ingest is set up). The
// two statements ride optionalStmt() (wellnessDb.js): lazy prepare in try/catch,
// degrade to an empty catalogue / found:false, never crash the boot.
import { optionalStmt } from './wellnessDb.js';

// repoRoot/PKM — the containment jail. route_file_path in the DB is stored
// PKM-relative WITH the leading "PKM/" segment (e.g. "PKM/Documents/_files/…"),
// so we resolve against REPO_ROOT and then assert the result is inside PKM/.
const PKM_DIR = path.resolve(REPO_ROOT, 'PKM');

// Simplify tolerance in degrees. ~2.2e-5° ≈ 2.5 m — tight enough that a single
// highlighted route stays smooth even at maxZoom 16, while still crushing GPS
// jitter and collapsing a multi-thousand-point track by 90%+. Part of the cache
// key, so changing it transparently rebuilds caches. (Empirically: a 4,341-pt
// urban walk → ~70 pts at this tolerance vs ~22 at 8e-5 — the extra vertices buy
// noticeably rounder corners at the zoom a selected route fits to.)
const SIMPLIFY_TOLERANCE_DEG = 0.000022;
// A hard ceiling on output vertices per track — even a pathological track stays
// cheap to ship and render. RDP almost always lands far below this.
const MAX_OUTPUT_POINTS = 1500;
// Bump when the GeoJSON shape or the simplify algorithm changes (cache-buster).
const CACHE_SCHEMA_VERSION = 1;

// ---- PKM containment (mirrors server.js containedPkmPath semantics) ---------
// `rel` is the DB-stored route_file_path. It may or may not carry the leading
// "PKM/"; we normalise both. Returns the absolute on-disk path if strictly inside
// PKM/, else null. Never writes here.
function resolveRouteFile(rel) {
  if (!rel || typeof rel !== 'string' || rel.includes('\0')) return null;
  // Strip an explicit leading PKM/ so we can resolve against PKM_DIR uniformly.
  const stripped = rel.replace(/^\.?\/*/, '').replace(/^PKM\//i, '');
  const abs = path.resolve(PKM_DIR, stripped);
  const relToPkm = path.relative(PKM_DIR, abs);
  if (relToPkm === '' || relToPkm.startsWith('..') || path.isAbsolute(relToPkm)) return null;
  return abs;
}

// ---- XXE-SAFE GPX → coordinate list ----------------------------------------
// We never run a real XML parser. We pull lat/lon off <trkpt>/<rtept> tags with a
// narrow regex and validate them numerically. A DOCTYPE/ENTITY declaration is a
// hard reject (we refuse to process any file that declares entities — we will not
// expand them, and refusing is the safest signal). No file:// / SYSTEM / network
// resolution is possible because there is no entity resolver in the loop at all.
const DOCTYPE_OR_ENTITY = /<!DOCTYPE|<!ENTITY/i;
// Anchored to the <trkpt …> / <rtept …> opening tag; lat and lon may appear in
// either order. Coordinates are plain decimal numbers in GPX 1.1.
const PT_TAG = /<(?:trkpt|rtept)\b[^>]*?>/gi;
const LAT_ATTR = /\blat\s*=\s*["']([-+]?\d+(?:\.\d+)?)["']/i;
const LON_ATTR = /\blon\s*=\s*["']([-+]?\d+(?:\.\d+)?)["']/i;

function parseGpxCoords(text) {
  if (DOCTYPE_OR_ENTITY.test(text)) {
    // Refuse to touch any GPX that declares a DTD or entities. Our own ingest
    // never produces these; a file that does is treated as hostile.
    throw new Error('gpx rejected: DOCTYPE/ENTITY declaration present');
  }
  const coords = []; // [lon, lat] (GeoJSON order)
  let m;
  PT_TAG.lastIndex = 0;
  while ((m = PT_TAG.exec(text)) !== null) {
    const tag = m[0];
    const latM = LAT_ATTR.exec(tag);
    const lonM = LON_ATTR.exec(tag);
    if (!latM || !lonM) continue;
    const lat = Number(latM[1]);
    const lon = Number(lonM[1]);
    if (
      Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
      !(lat === 0 && lon === 0) // drop the classic null-island GPS dropout
    ) {
      coords.push([lon, lat]);
    }
    if (coords.length > 200000) break; // absurd-size guard before simplification
  }
  return coords;
}

// ---- Ramer–Douglas–Peucker (dependency-free) -------------------------------
// Operates in lon/lat degree space. For the zoom levels and short distances of a
// single workout track, planar RDP in degrees is more than accurate enough (the
// alternative — projecting to meters first — buys nothing visible here).
function perpDistSq(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

function rdp(points, epsilonSq) {
  if (points.length < 3) return points.slice();
  // Iterative RDP (explicit stack) — recursion would blow the stack on a 10k-point
  // track. Keeps a boolean keep-mask, then emits kept points in order.
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistSq(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > epsilonSq) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// Adaptively tighten the tolerance until the track is under MAX_OUTPUT_POINTS, so
// even a pathological 10k-point track ships small. Starts at the default tolerance.
function simplify(coords) {
  if (coords.length <= 2) return coords.slice();
  let eps = SIMPLIFY_TOLERANCE_DEG;
  let out = rdp(coords, eps * eps);
  let guard = 0;
  while (out.length > MAX_OUTPUT_POINTS && guard < 12) {
    eps *= 1.8;
    out = rdp(coords, eps * eps);
    guard += 1;
  }
  return out;
}

// ---- DB: route catalogue (read-only SELECTs) -------------------------------
// One row per workout that HAS a route, joined to its summary. Ordered most-recent
// first so the list reads newest-at-top like the rest of the cockpit.
const listRoutesStmt = optionalStmt(`
  SELECT w.id            AS workout_id,
         w.workout_uuid  AS uuid,
         w.workout_type  AS type,
         w.local_date    AS date,
         w.start_utc     AS start_utc,
         w.duration_sec  AS duration_sec,
         w.distance_km   AS distance_km,
         w.active_energy_kcal AS energy_kcal,
         w.heart_rate_avg     AS hr_avg,
         w.heart_rate_max     AS hr_max,
         w.elevation_ascended_m AS ascent_m,
         w.location_name    AS location_name,
         w.location_admin   AS location_admin,
         w.location_country AS location_country,
         r.route_file_path AS route_file_path,
         r.point_count     AS point_count,
         r.bbox_min_lat    AS bbox_min_lat,
         r.bbox_min_lon    AS bbox_min_lon,
         r.bbox_max_lat    AS bbox_max_lat,
         r.bbox_max_lon    AS bbox_max_lon
  FROM health_workout w
  JOIN health_workout_route r ON r.workout_id = w.id
  WHERE r.route_file_path IS NOT NULL AND r.point_count > 1
  ORDER BY (w.local_date IS NULL), w.local_date DESC, w.start_utc DESC
`);

const routeRowStmt = optionalStmt(`
  SELECT w.id AS workout_id, w.workout_type AS type, w.local_date AS date,
         r.route_file_path AS route_file_path, r.file_sha256 AS sha
  FROM health_workout w
  JOIN health_workout_route r ON r.workout_id = w.id
  WHERE w.id = ?
  LIMIT 1
`);

// ---- Cache helpers ----------------------------------------------------------
function cachePathFor(absGpx) {
  return `${absGpx}.simplified.geojson`;
}

// Cache validity: same source sha + same tolerance + same schema version. We embed
// these into the cached document's `_cache` block and compare on read.
function readCache(absGpx, expectSha) {
  const cp = cachePathFor(absGpx);
  try {
    if (!fs.existsSync(cp)) return null;
    const doc = JSON.parse(fs.readFileSync(cp, 'utf8'));
    const c = doc && doc._cache;
    if (!c) return null;
    if (c.schema !== CACHE_SCHEMA_VERSION) return null;
    if (c.tolerance !== SIMPLIFY_TOLERANCE_DEG) return null;
    if (expectSha && c.sha && c.sha !== expectSha) return null;
    return doc;
  } catch {
    return null; // corrupt cache → recompute
  }
}

function writeCache(absGpx, doc) {
  try {
    fs.writeFileSync(cachePathFor(absGpx), JSON.stringify(doc));
    return true;
  } catch {
    // Read-only PKM dir or disk-full — degrade to compute-on-the-fly. Never throws.
    return false;
  }
}

// Build the simplified GeoJSON Feature (LineString) for one workout, using the
// cache when valid. Returns { feature, cached } or throws on a hard parse failure.
function buildFeature(row) {
  const abs = resolveRouteFile(row.route_file_path);
  if (!abs) throw new Error('route file outside PKM containment');

  const cached = readCache(abs, row.sha);
  if (cached) return { feature: cached.feature, cached: true };

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error('route file not found on disk');
  }
  const text = fs.readFileSync(abs, 'utf8');
  const coords = parseGpxCoords(text);
  const simplified = simplify(coords);

  const feature = {
    type: 'Feature',
    properties: {
      workout_id: row.workout_id,
      type: row.type ?? null,
      date: row.date ?? null,
      raw_points: coords.length,
      points: simplified.length,
    },
    geometry: { type: 'LineString', coordinates: simplified },
  };

  const doc = {
    _cache: { schema: CACHE_SCHEMA_VERSION, tolerance: SIMPLIFY_TOLERANCE_DEG, sha: row.sha || null },
    feature,
  };
  writeCache(abs, doc);
  return { feature, cached: false };
}

// ---- Public API (consumed by server.js route handlers) ---------------------

// GET /api/cockpit/workouts — the route catalogue (list + filter source). No
// geometry here; the client lazily fetches geometry per selected workout and the
// aggregate glow once. distance/energy/hr are passed through as-is (the client
// formats + filters). bbox lets the client frame the map without loading geometry.
export function listWorkouts() {
  const rows = listRoutesStmt.all();
  const workouts = rows.map((r) => ({
    id: r.workout_id,
    uuid: r.uuid || null,
    type: r.type || null,
    date: r.date || null,
    startUtc: r.start_utc || null,
    durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
    distanceKm: r.distance_km == null ? null : Number(r.distance_km),
    energyKcal: r.energy_kcal == null ? null : Number(r.energy_kcal),
    hrAvg: r.hr_avg == null ? null : Number(r.hr_avg),
    hrMax: r.hr_max == null ? null : Number(r.hr_max),
    ascentM: r.ascent_m == null ? null : Number(r.ascent_m),
    // Offline reverse-geocoded place metadata (cities1000 snap to nearest ≥1000-pop
    // place; a nearby larger town rather than the exact suburb is expected, not a bug). NULL location_name
    // ⇒ indoor / no route ⇒ client renders no location block (no "Unknown" placeholder).
    locationName: r.location_name ? String(r.location_name) : null,
    locationAdmin: r.location_admin ? String(r.location_admin) : null,
    locationCountry: r.location_country ? String(r.location_country) : null,
    pointCount: r.point_count == null ? 0 : Number(r.point_count),
    bbox: (r.bbox_min_lat != null && r.bbox_min_lon != null && r.bbox_max_lat != null && r.bbox_max_lon != null)
      ? [Number(r.bbox_min_lon), Number(r.bbox_min_lat), Number(r.bbox_max_lon), Number(r.bbox_max_lat)]
      : null,
  }));

  // Distinct types present (with a route), for the filter toolbar — server-derived
  // so the client never hardcodes the type vocabulary.
  const typeCounts = new Map();
  for (const w of workouts) {
    const t = w.type || 'Unknown';
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  }
  const types = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return { workouts, types, count: workouts.length };
}

// GET /api/cockpit/workout-route?id=… — one simplified GeoJSON Feature for the
// selected workout (the highlighted line).
export function getWorkoutRoute(idRaw) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return { found: false, error: 'invalid id' };
  }
  const row = routeRowStmt.get(id);
  if (!row) return { found: false, error: 'no route for this workout' };
  try {
    const { feature, cached } = buildFeature(row);
    return { found: true, cached, feature };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// GET /api/cockpit/workout-heat?… — the aggregate "ember" glow source: a
// FeatureCollection of every (filtered) simplified track. v1 renders these as
// additive low-opacity polylines (dense areas glow). v2 (leaflet.heat) can derive
// its point cloud from the same FeatureCollection — the contract is forward-
// compatible by design (Pax §4).
//
// Filters (all optional, AND-combined): type (exact), from / to (YYYY-MM-DD on
// local_date), bbox=minLon,minLat,maxLon,maxLat (route bbox must intersect). The
// server simplifies + caches each track exactly as the single-route endpoint does,
// so the heat source reuses the same on-disk cache (no double work).
export function getWorkoutHeat(query) {
  const rows = listRoutesStmt.all();
  const type = typeof query.type === 'string' && query.type.trim() ? query.type.trim() : null;
  const from = isISODate(query.from) ? query.from : null;
  const to = isISODate(query.to) ? query.to : null;
  const viewBbox = parseBbox(query.bbox); // [minLon,minLat,maxLon,maxLat] | null

  const features = [];
  let considered = 0;
  let skipped = 0;
  for (const r of rows) {
    if (type && (r.type || 'Unknown') !== type) continue;
    if (from && (!r.date || r.date < from)) continue;
    if (to && (!r.date || r.date > to)) continue;
    if (viewBbox && !bboxIntersects(viewBbox, r)) continue;
    considered += 1;
    try {
      const { feature } = buildFeature(r);
      // Strip per-feature props down to nothing the glow layer needs (smaller wire).
      features.push({ type: 'Feature', properties: { id: r.workout_id }, geometry: feature.geometry });
    } catch {
      skipped += 1; // a single bad track never sinks the whole heat layer
    }
  }
  return {
    type: 'FeatureCollection',
    features,
    meta: { considered, included: features.length, skipped },
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isISODate(v) {
  return typeof v === 'string' && ISO_DATE.test(v);
}

function parseBbox(v) {
  if (typeof v !== 'string') return null;
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon > maxLon || minLat > maxLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

// Does the view bbox intersect this route's stored bbox? Cheap pre-filter so we
// never even open the GPX for a track entirely off-screen.
function bboxIntersects(view, r) {
  if (r.bbox_min_lat == null || r.bbox_min_lon == null || r.bbox_max_lat == null || r.bbox_max_lon == null) {
    return true; // unknown bbox → don't exclude (safe default)
  }
  const [vMinLon, vMinLat, vMaxLon, vMaxLat] = view;
  return !(r.bbox_max_lon < vMinLon || r.bbox_min_lon > vMaxLon ||
           r.bbox_max_lat < vMinLat || r.bbox_min_lat > vMaxLat);
}

export const __test = { parseGpxCoords, rdp, simplify, resolveRouteFile, bboxIntersects, parseBbox };
