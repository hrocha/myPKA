// summaries.ts — the one-line quick-stats shown when a section is collapsed (v2 #2).
// Each lets Tom scan the state of an area without expanding it.
import type {
  HabitCard,
  JournalEntry,
  OpenQuestion,
  PersonalTask,
  SleepPoint,
  StepPoint,
  TopicCard,
  WeightPoint,
} from './types';

// MIND — "4 patterns · mood: <latest>"
export function mindSummary(topics: TopicCard[], journal: JournalEntry[]): string {
  const patterns = topics.filter((t) => !t.missing).length;
  const latest = journal.find((e) => e.mood || e.energy);
  const mood = latest?.mood ?? latest?.energy ?? '—';
  return `${patterns} patterns · mood: ${mood}`;
}

// PLANNED — "<n> open · <n> overdue · <n> tasks"
export function plannedSummary(
  openQuestions: OpenQuestion[],
  tasks: PersonalTask[]
): string {
  const open = openQuestions.filter((q) => !q.answered).length;
  const overdue = openQuestions.filter((q) => !q.answered && (q.overdue || q.deadline)).length;
  const taskN = tasks.length;
  const parts = [`${open} open`];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (taskN > 0) parts.push(`${taskN} task${taskN === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// TRENDS — "Weight <delta> · Steps avg <n> · Sleep avg <h>h"
export function trendsSummary(
  weight: WeightPoint[],
  steps: StepPoint[],
  sleep: SleepPoint[]
): string {
  const parts: string[] = [];
  if (weight.length >= 2) {
    const first = weight[0].kg;
    const last = weight[weight.length - 1].kg;
    const d = last - first;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    parts.push(`Weight ${sign}${Math.abs(d).toFixed(1)} kg (180d)`);
  }
  if (steps.length) {
    const avg = steps.reduce((s, p) => s + p.steps, 0) / steps.length;
    parts.push(`Steps avg ${Math.round(avg).toLocaleString('en-US')}`);
  }
  if (sleep.length) {
    const avg = sleep.reduce((s, p) => s + p.total_hr, 0) / sleep.length;
    parts.push(`Sleep avg ${avg.toFixed(1)} h`);
  }
  return parts.join(' · ');
}

// Habits — small one-liner for the PLANNED sub-areas if needed.
export function habitsSummary(habits: HabitCard[]): string {
  const active = habits.filter((h) => !h.missing).length;
  return `${active} habit${active === 1 ? '' : 's'}`;
}
