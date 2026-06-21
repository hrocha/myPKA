// wellnessDb.js — guarded prepare() helper for the wellness modules
// (queries.js / tracking.js / gpxRoute.js).
//
// WHY THIS EXISTS: db.js preflights only the CORE mirror tables (people, topics,
// journal, …). The wellness surface additionally reads OPTIONAL tables that a
// member's mypka.db may simply not have yet — health_metric, health_sleep,
// health_mood, health_workout, health_workout_route, habit_logs, food_logs and
// the v_habit_* / v_food_* views (they appear once the Apple-Health /
// habit-tracking ingests are set up). better-sqlite3 throws AT PREPARE TIME for
// a missing table, and the ported modules prepare at module load — which would
// crash the whole cockpit boot for everyone without health data.
//
// optionalStmt() defers the prepare to first use, swallows prepare/run failures,
// and degrades to "no data" (undefined for .get, [] for .all). The prepared
// statement is cached on first success; on failure we RE-TRY on the next call,
// because a regen (regen-mypka-db.py) can add the optional tables to the same
// DB file mid-run. Read-only either way — db.js opens the mirror readonly.
import db from './db.js';

export function optionalStmt(sql) {
  let stmt = null;
  const prep = () => {
    if (stmt) return stmt;
    try {
      stmt = db.prepare(sql);
    } catch {
      stmt = null; // table/view not in this mirror (yet) — degrade, never throw
    }
    return stmt;
  };
  return {
    get(...args) {
      const s = prep();
      if (!s) return undefined;
      try { return s.get(...args); } catch { return undefined; }
    },
    all(...args) {
      const s = prep();
      if (!s) return [];
      try { return s.all(...args); } catch { return []; }
    },
    /** True when the statement could be prepared against the current mirror. */
    get available() { return prep() !== null; },
  };
}

/** Call-time existence probe for a table or view (sqlite_master lookup). */
export function tableExists(name) {
  try {
    return !!db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
      .get(name);
  } catch {
    return false;
  }
}
