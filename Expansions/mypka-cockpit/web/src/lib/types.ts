// Shared types mirroring the server's /api/dashboard payload.

// Readable-block model: the server breaks full markdown text into scannable
// pieces (paragraphs / bullet lists / headings / quotes) so the click-to-expand
// Sheet never shows a wall of text. (v2 feedback #1 + #3.)
export type ReadableBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] };

export interface ScalarMetric {
  metric_name?: string;
  local_date: string | null;
  value: number | null;
  avg_value?: number | null;
  units: string | null;
  source?: string | null;
  n?: number;
}

// Per-metric trend vs a prior reference (v2 feedback #4). direction: +1 up / -1 down /
// 0 flat. hasPrior=false means "no prior value" (honest, no fake trend).
export interface MetricTrend {
  current: number;
  prior: number | null;
  delta: number | null;
  direction: -1 | 0 | 1;
  window: string;
  priorDate?: string;
  hasPrior: boolean;
}

export type TrendKey =
  | 'weight' | 'bmi' | 'bodyFat' | 'vo2' | 'rhr' | 'hrv' | 'spo2' | 'breathing';

export interface BodyMetrics {
  weight: ScalarMetric | null;
  bmi: ScalarMetric | null;
  bodyFat: ScalarMetric | null;
  vo2: ScalarMetric | null;
  rhr: ScalarMetric | null;
  hrv: ScalarMetric | null;
  spo2: ScalarMetric | null;
  breathing: ScalarMetric | null;
  trends: Record<TrendKey, MetricTrend | null>;
}

export interface DiagnosisChip {
  label: string;
  code: string;
  tone: 'managed' | 'watch' | 'bad';
  note: string;
}

export interface LabTable {
  headers: string[];
  rows: string[][];
}

export interface LabPanel {
  title: string;
  table: LabTable | null;
  assessment: string | null;
  note: string | null;
  full: ReadableBlock[];
}

export interface PsycheState {
  present: boolean;
  isStub?: boolean;
  name?: string;
}

export interface TopicCard {
  slug: string;
  name: string;
  lead: string | null;
  full: ReadableBlock[] | null;
  missing: boolean;
}

export interface JournalEntry {
  entry_date: string;
  mood: string | null;
  // Language-neutral mood signal (1..5 integer; null/absent on a few legacy rows).
  // PRIMARY colour signal for the mood label; the free-text `mood` word above stays
  // the visible label. When this is null, the client falls back to the word-matcher.
  mood_valence: number | null;
  energy: string | null;
  title: string | null;
}

export interface ValencePoint {
  local_date: string;
  valence: number;
  valence_class: string;
  kind: string;
}

export interface HabitCard {
  slug: string;
  name: string;
  cadence?: string | null;
  started?: string | null;
  status?: string | null;
  lead: string | null;
  full?: ReadableBlock[] | null;
  missing: boolean;
}

// A resolvable cockpit note link (v3 #1): when a PLANNED item maps to a real note
// in v_notes, the server attaches {type, slug} so the row routes into the viewer.
export interface NoteLink {
  type: string;
  slug: string;
}

export interface OpenQuestion {
  num: number;
  title: string;
  text: string;
  answered: boolean;
  overdue: boolean;
  deadline: string | null;
  note?: NoteLink | null;
  full: ReadableBlock[];
}

export interface PersonalTask {
  file: string;
  status: 'open' | 'in-progress';
  title: string;
  due: string | null;
  lifeLinked?: boolean;
}

export interface WeightPoint { local_date: string; kg: number }
export interface StepPoint { local_date: string; steps: number }
export interface SleepPoint { local_date: string; total_hr: number; deep_hr: number; rem_hr: number }

export interface DashboardData {
  generatedAt: string;
  dbMtime: string;
  body: {
    metrics: BodyMetrics;
    diagnoses: { confirmed: { name: string; icd: string | null; confirmed: string | null }[]; chips: DiagnosisChip[] };
    labs: { panels: LabPanel[] };
  };
  mind: {
    psyche: PsycheState;
    topics: TopicCard[];
    mood: { journal: JournalEntry[]; valence: ValencePoint[] };
  };
  trends: {
    weight: WeightPoint[];
    steps: StepPoint[];
    sleep: SleepPoint[];
  };
  planned: {
    habits: HabitCard[];
    openQuestions: OpenQuestion[];
    tasks: PersonalTask[];
    nutritionPlan: { exists: boolean; path: string; note?: NoteLink | null };
  };
}
