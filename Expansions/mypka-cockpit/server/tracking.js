// tracking.js — read-only data layer for the Tracking panel (habit streaks +
// photo-nutrition gallery). Every statement is a SELECT against Silas's final
// schema (habit_logs / food_logs + the three views). Markdown is canonical; this
// never writes.
//
// Streak philosophy (Atlas): NO shame optics on gaps. Misses are surfaced
// neutrally — the server reports raw done/0/null state and counts; the CLIENT
// paints gaps in a soft neutral, never alarm-red. The message is "how fast back
// on", not "chain broken". So this module deliberately exposes the friendly
// signals (current_streak, days_since_last_log) and leaves the framing to the UI.
//
// Anxiety-free nutrition (hard rule): NO numbers, NO calories, NO scores. The
// food shape carries meal type, context tags, a visible-protein flag, a photo
// path, and the free-text note ONLY. No quantities are computed anywhere here.
//
// SCAFFOLD ADAPTATION (2026-06-11): habit_logs / food_logs / v_habit_streaks /
// v_habit_heatmap are OPTIONAL tables — absent until the tracking ingest is set
// up. All statements ride optionalStmt() (wellnessDb.js): lazy prepare in a
// try/catch, degrade to empty arrays, never crash the boot.
import { optionalStmt } from './wellnessDb.js';

// ---- HABITS ---------------------------------------------------------------

// One row per habit with its committed streak + lifetime tallies. Most-recent
// activity first so the most-alive habit reads at the top.
const streaksStmt = optionalStmt(`
  SELECT habit_slug, habit_name, last_committed_date, current_streak,
         total_done, committed_logs, days_since_last_log
  FROM v_habit_streaks
  ORDER BY (last_committed_date IS NULL), last_committed_date DESC, habit_name COLLATE NOCASE
`);

// Every heatmap cell (done = 1 hit / 0 miss / NULL pending) for every habit.
// The client buckets these into a per-habit calendar grid.
const heatmapStmt = optionalStmt(`
  SELECT habit_slug, habit_name, log_date, done, log_schema
  FROM v_habit_heatmap
  ORDER BY habit_slug, log_date
`);

export function getHabitTracking() {
  const streaks = streaksStmt.all();
  const heatRows = heatmapStmt.all();

  // Group heatmap cells per habit. A habit can appear in the heatmap with logs
  // but NOT in v_habit_streaks (e.g. only NULL-done pending rows) — and vice
  // versa — so we union both keyed sets into one habit list, no row dropped.
  const byHabit = new Map();
  const ensure = (slug, name) => {
    if (!byHabit.has(slug)) {
      byHabit.set(slug, { slug, name: name || slug, streak: null, cells: [] });
    }
    const h = byHabit.get(slug);
    if (name && (!h.name || h.name === slug)) h.name = name;
    return h;
  };

  for (const r of heatRows) {
    const h = ensure(r.habit_slug, r.habit_name);
    h.cells.push({
      date: r.log_date,
      // done is 1 | 0 | null in the mirror — keep that tri-state verbatim so the
      // client can render hit / soft-miss / pending distinctly.
      done: r.done === null ? null : Number(r.done),
      schema: r.log_schema || null,
    });
  }

  for (const s of streaks) {
    const h = ensure(s.habit_slug, s.habit_name);
    h.streak = {
      current: s.current_streak ?? 0,
      totalDone: s.total_done ?? 0,
      committedLogs: s.committed_logs ?? 0,
      lastDate: s.last_committed_date || null,
      daysSinceLast: s.days_since_last_log == null ? null : Number(s.days_since_last_log),
    };
  }

  // Most-recent activity first; habits with no cells fall to the back calmly.
  const habits = [...byHabit.values()].sort((a, b) => {
    const ad = a.cells.length ? a.cells[a.cells.length - 1].date : '';
    const bd = b.cells.length ? b.cells[b.cells.length - 1].date : '';
    return bd.localeCompare(ad) || a.name.localeCompare(b.name);
  });

  return habits;
}

// ---- FOOD (photo nutrition) -----------------------------------------------

// kontext + linked_habits are JSON arrays in the mirror. Resolve them per-row
// with json_each() rather than parsing JSON in JS (Silas's note). We read from the
// base food_logs table because it carries the `id` column that v_food_log_calendar
// omits (used only as a stable React key); every other column is identical to the
// view, and the read is equally read-only. GROUP_CONCAT folds the json_each rows
// back to one cell, joined by an ASCII unit-separator (char(31)) that can never
// appear inside a tag value, so the client splits it back losslessly. The
// json_valid() guard means a NULL / malformed array yields NULL (→ empty list).
const foodStmt = optionalStmt(`
  SELECT f.id,
         f.log_date,
         f.mahlzeit_typ,
         f.eiweiss_sichtbar,
         f.photo_path,
         f.photo_count,
         f.note,
         f.key_element,
         f.journal_slug,
         (SELECT GROUP_CONCAT(k.value, char(31))
            FROM json_each(f.kontext) k
            WHERE json_valid(f.kontext)) AS kontext_csv,
         (SELECT GROUP_CONCAT(h.value, char(31))
            FROM json_each(f.linked_habits) h
            WHERE json_valid(f.linked_habits)) AS linked_csv
  FROM food_logs f
  ORDER BY f.log_date DESC, f.mahlzeit_typ, f.id
`);

const SEP = String.fromCharCode(31);
const splitArr = (csv) => (csv ? csv.split(SEP).filter(Boolean) : []);

export function getFoodTracking() {
  const rows = foodStmt.all();
  return rows.map((r) => ({
    id: r.id,
    date: r.log_date || null,
    mealType: r.mahlzeit_typ || null,
    // context tags are neutral-descriptive: planned | random | stress | social |
    // late. The client never colours them good/bad.
    context: splitArr(r.kontext_csv),
    // visible-protein is a quiet boolean flag, not a score. null = unknown.
    proteinVisible: r.eiweiss_sichtbar === null ? null : Number(r.eiweiss_sichtbar) === 1,
    photoPath: r.photo_path || null,
    photoCount: r.photo_count == null ? 0 : Number(r.photo_count),
    note: r.note || null,
    keyElement: r.key_element || null,
    linkedHabits: splitArr(r.linked_csv),
    journalSlug: r.journal_slug || null,
  }));
}

export function getTracking() {
  return {
    habits: getHabitTracking(),
    food: getFoodTracking(),
  };
}
