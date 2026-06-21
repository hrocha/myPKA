// HabitHeatmap.tsx — a GitHub-contribution-style calendar for one habit.
//
// Streak philosophy (Atlas), baked into the colour map: NO shame optics on gaps.
//   • hit (done=1)      → brass fill (the warm "you did it" signal)
//   • miss (done=0)     → soft neutral surface tint, NEVER alarm-red. A miss is a
//                         quiet, low-contrast square — present, not punishing.
//   • pending (done=null)→ an even softer outline-only square (logged but undecided)
//   • no-log day        → the faintest grid square (the calendar scaffold)
// The message the colour ramp tells is "how fast back on", not "chain broken".
//
// Zero chart dependency — a pure CSS grid. Weeks are columns, weekdays (Mon→Sun)
// are rows, exactly like the GitHub graph. Tokens only (GL-003), no hardcoded hex.
import type { HabitCell } from '../lib/trackingTypes';

// ISO date helpers (UTC-safe; the mirror stores plain YYYY-MM-DD).
function parseISO(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
function toISO(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
// Monday-based weekday index (0 = Mon … 6 = Sun) so weeks read left→right.
function mondayIdx(dt: Date): number {
  return (dt.getUTCDay() + 6) % 7;
}

type CellState = 'hit' | 'miss' | 'pending' | 'empty';

const STATE_CLASS: Record<CellState, string> = {
  hit: 'heat-cell--hit',
  miss: 'heat-cell--miss',
  pending: 'heat-cell--pending',
  empty: 'heat-cell--empty',
};

const STATE_LABEL: Record<CellState, string> = {
  hit: 'done',
  miss: 'not done',
  pending: 'logged, pending',
  empty: 'no log',
};

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

// Build a dense day grid spanning the first logged day → today (or the last
// logged day, whichever is later), padded to whole Monday→Sunday weeks. A small
// floor (~5 weeks) keeps a sparse, brand-new habit from rendering as a lonely
// single square — it gets a readable calendar to grow into.
function buildGrid(cells: HabitCell[]): {
  weeks: { date: string; state: CellState }[][];
  monthMarks: { col: number; label: string }[];
} {
  const byDate = new Map<string, HabitCell>();
  for (const c of cells) byDate.set(c.date, c);

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const dates = cells.map((c) => parseISO(c.date).getTime());
  const firstLogged = dates.length ? new Date(Math.min(...dates)) : todayUTC;
  const lastLogged = dates.length ? new Date(Math.max(...dates)) : todayUTC;
  const end = lastLogged.getTime() > todayUTC.getTime() ? lastLogged : todayUTC;

  // Ensure at least ~5 weeks of canvas.
  const MIN_DAYS = 5 * 7;
  let start = new Date(firstLogged);
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (span < MIN_DAYS) {
    start = new Date(end.getTime() - (MIN_DAYS - 1) * 86400000);
  }
  // Back up start to its Monday so the first column is a full week.
  start = new Date(start.getTime() - mondayIdx(start) * 86400000);

  const weeks: { date: string; state: CellState }[][] = [];
  const monthMarks: { col: number; label: string }[] = [];
  let cursor = new Date(start);
  let col = 0;
  let lastMonth = -1;

  while (cursor.getTime() <= end.getTime() || mondayIdx(cursor) !== 0) {
    const week: { date: string; state: CellState }[] = [];
    for (let row = 0; row < 7; row++) {
      const iso = toISO(cursor);
      const inRange = cursor.getTime() >= start.getTime() && cursor.getTime() <= end.getTime();
      let state: CellState = 'empty';
      if (inRange) {
        const cell = byDate.get(iso);
        if (cell) {
          state = cell.done === 1 ? 'hit' : cell.done === 0 ? 'miss' : 'pending';
        }
        // a month-label mark when a new month starts in the top row of a column
        if (row === 0) {
          const mo = cursor.getUTCMonth();
          if (mo !== lastMonth) {
            lastMonth = mo;
            monthMarks.push({
              col,
              label: cursor.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
            });
          }
        }
      }
      week.push({ date: iso, state });
      cursor = new Date(cursor.getTime() + 86400000);
    }
    weeks.push(week);
    col++;
    if (col > 80) break; // hard ceiling — never an unbounded grid
  }

  return { weeks, monthMarks };
}

export function HabitHeatmap({ cells }: { cells: HabitCell[] }) {
  const { weeks, monthMarks } = buildGrid(cells);

  return (
    <div className="heatmap" role="img" aria-label="Habit activity calendar. Done days are filled; gaps are shown softly, never in red.">
      <div className="heatmap-scroll">
        {/* Month labels above the columns. */}
        <div className="heatmap-months" aria-hidden="true">
          {monthMarks.map((m) => (
            <span key={`${m.col}-${m.label}`} className="heatmap-month" style={{ gridColumn: m.col + 2 }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="heatmap-body">
          {/* Weekday row labels. */}
          <div className="heatmap-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((d, i) => (
              <span key={i} className="heatmap-weekday">{d}</span>
            ))}
          </div>
          {/* Week columns. */}
          <div className="heatmap-weeks">
            {weeks.map((week, wi) => (
              <div key={wi} className="heatmap-week">
                {week.map((cell) => (
                  <span
                    key={cell.date}
                    className={`heat-cell ${STATE_CLASS[cell.state]}`}
                    title={`${cell.date} · ${STATE_LABEL[cell.state]}`}
                  >
                    <span className="sr-only">{`${cell.date}: ${STATE_LABEL[cell.state]}`}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
