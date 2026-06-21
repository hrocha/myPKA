// trackingTypes.ts — types mirroring the /api/tracking payload (server/tracking.js).
// Strict; no `any`.

// One heatmap cell. done: 1 = committed hit, 0 = a miss/skip, null = pending/blank.
// The tri-state is preserved end-to-end so the UI can paint a miss softly (never
// alarm-red) and a pending day even softer — Atlas's no-shame streak philosophy.
export interface HabitCell {
  date: string;
  done: 1 | 0 | null;
  schema: string | null;
}

export interface HabitStreak {
  current: number;
  totalDone: number;
  committedLogs: number;
  lastDate: string | null;
  daysSinceLast: number | null;
}

export interface HabitTracking {
  slug: string;
  name: string;
  streak: HabitStreak | null; // null when the habit has only pending (null-done) cells
  cells: HabitCell[];
}

// A food log row. ANXIETY-FREE: no numbers, no calories, no scores anywhere.
// context tags are neutral-descriptive (planned/random/stress/social/late) and the
// UI never colours them good/bad. proteinVisible is a quiet flag, not a badge.
export interface FoodLog {
  id: number;
  date: string | null;
  mealType: string | null; // breakfast | lunch | dinner | snack | other | null
  context: string[];
  proteinVisible: boolean | null;
  photoPath: string | null;
  photoCount: number;
  note: string | null;
  keyElement: string | null;
  linkedHabits: string[];
  journalSlug: string | null;
}

export interface TrackingData {
  habits: HabitTracking[];
  food: FoodLog[];
}
