// status.ts — REFERENCE-RANGE classification. An assessment, not a diagnosis.
//
// v2 change (Tom's explicit override): he wants clear red / amber / green status
// indicators, NOT the earlier calm-only palette. So each metric now carries a
// `severity` ('green' | 'amber' | 'red') that drives a readable status colour.
// BUT we keep two health-anxiety-aware guarantees from v1:
//   1. Every RED metric still carries its `plan` ("→ Planned" link) — a red value
//      always arrives with "here's the next step", never as a bare verdict.
//   2. The calm `tone` (in range / watch / discuss with doctor) is retained as the
//      human-readable label; red maps to "discuss with doctor", not "ALARM".
//
// Plus per-metric trend (current vs prior reference): the arrow direction and
// whether a given move reads as reassuring or worth-watching is metric-specific
// (weight DOWN is good; RHR UP is worth watching; VO2max UP is good).

import type { MetricTrend, ScalarMetric, TrendKey } from './types';

export type Tone = 'good' | 'watch' | 'attn' | 'neutral';
export type Severity = 'green' | 'amber' | 'red' | 'neutral';

// How a delta reads for THIS metric: 'better' (reassuring), 'worse' (worth
// watching), 'flat' (no meaningful move), or 'info' (neither up nor down is
// inherently good — e.g. weight has no "good direction" without context).
export type DeltaSense = 'better' | 'worse' | 'flat' | 'info';

export interface TrendView {
  delta: number | null;
  direction: -1 | 0 | 1;
  sense: DeltaSense;
  window: string;
  display: string; // e.g. "−0,4 kg" / "+2 bpm"
  hasPrior: boolean;
}

export interface MetricView {
  key: string;
  label: string;
  value: number | null;
  display: string;
  unit: string;
  tone: Tone;
  severity: Severity;
  toneLabel: string;
  reference: string;
  plan?: string; // the PLANNED item this connects to
  sub?: string; // small context line (e.g. SpO2 mean, n readings)
  trend: TrendView | null;
}

function fmt(v: number | null, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Signed delta with a typographic minus glyph: -0.4 -> "−0.4".
function fmtDelta(v: number, digits: number, unit: string): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  const abs = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}${abs}${unit ? ` ${unit}` : ''}`;
}

const TONE_LABEL: Record<Tone, string> = {
  good: 'in range',
  watch: 'watch',
  attn: 'discuss with doctor',
  neutral: '—',
};

// For each metric: which raw direction (+1/-1) counts as 'better'.
// null => 'info' (no inherently good direction without clinical context).
const BETTER_WHEN: Record<TrendKey, 1 | -1 | null> = {
  weight: -1, // down is the active goal (PKV)
  bmi: -1,
  bodyFat: -1,
  vo2: 1, // higher fitness
  rhr: -1, // lower resting HR
  hrv: 1, // higher variability = calmer autonomic state
  spo2: 1, // higher nightly low
  breathing: -1, // fewer disturbances
};

const DELTA_DIGITS: Record<TrendKey, number> = {
  weight: 1, bmi: 1, bodyFat: 1, vo2: 1, rhr: 0, hrv: 0, spo2: 0, breathing: 0,
};

const DELTA_UNIT: Record<TrendKey, string> = {
  weight: 'kg', bmi: '', bodyFat: '%', vo2: '', rhr: 'bpm', hrv: 'ms', spo2: '%', breathing: '',
};

function buildTrendView(key: TrendKey, t: MetricTrend | null): TrendView | null {
  if (!t) return null;
  if (!t.hasPrior || t.delta === null) {
    return { delta: null, direction: 0, sense: 'flat', window: t.window, display: 'no prior value', hasPrior: false };
  }
  const betterDir = BETTER_WHEN[key];
  let sense: DeltaSense;
  if (t.direction === 0) sense = 'flat';
  else if (betterDir === null) sense = 'info';
  else sense = t.direction === betterDir ? 'better' : 'worse';
  return {
    delta: t.delta,
    direction: t.direction,
    sense,
    window: t.window,
    display: fmtDelta(t.delta, DELTA_DIGITS[key], DELTA_UNIT[key]),
    hasPrior: true,
  };
}

// tone (calm label) + severity (red/amber/green light) decoupled. Tom wants the
// light to be unmistakable; the words stay calm.
const SEV_FROM_TONE: Record<Tone, Severity> = {
  good: 'green',
  watch: 'amber',
  attn: 'red',
  neutral: 'neutral',
};

export function buildMetricViews(m: {
  weight: ScalarMetric | null;
  bmi: ScalarMetric | null;
  bodyFat: ScalarMetric | null;
  vo2: ScalarMetric | null;
  rhr: ScalarMetric | null;
  hrv: ScalarMetric | null;
  spo2: ScalarMetric | null;
  breathing: ScalarMetric | null;
  trends: Record<TrendKey, MetricTrend | null>;
}): MetricView[] {
  const raw: Omit<MetricView, 'severity' | 'toneLabel' | 'trend'>[] = [];

  // Weight — no clinical "range"; the trend now carries the signal (down = goal).
  raw.push({
    key: 'weight',
    label: 'Weight',
    value: m.weight?.value ?? null,
    display: fmt(m.weight?.value ?? null, 1),
    unit: 'kg',
    tone: 'neutral',
    reference: 'no clinical range · the trend is what counts',
    plan: 'Kitchen closed · nutrition plan',
  });

  // BMI — the obesity range is the PKV story; framed as the active project.
  const bmi = m.bmi?.value ?? null;
  raw.push({
    key: 'bmi',
    label: 'BMI',
    value: bmi,
    display: fmt(bmi, 1),
    unit: '',
    tone: bmi !== null && bmi >= 30 ? 'attn' : bmi !== null && bmi >= 25 ? 'watch' : 'good',
    reference: 'Normal <25 · PKV deadline 21.06.',
    plan: 'Weight management (PKV) · kitchen closed',
  });

  // Body-fat % — reference ~10–20% athletic, >25% high for male.
  const bf = m.bodyFat?.value ?? null;
  raw.push({
    key: 'bodyFat',
    label: 'Body fat',
    value: bf,
    display: fmt(bf, 1),
    unit: '%',
    tone: bf !== null && bf >= 30 ? 'attn' : bf !== null && bf >= 25 ? 'watch' : 'good',
    reference: 'Reference ~10–20 % (m)',
    plan: 'Weight management (PKV)',
  });

  // VO2max — <30 reads "Poor" for a 43yo male per health.md; <25 is the red zone.
  const vo2 = m.vo2?.value ?? null;
  raw.push({
    key: 'vo2',
    label: 'VO₂max',
    value: vo2,
    display: fmt(vo2, 1),
    unit: 'ml/kg·min',
    tone: vo2 !== null && vo2 < 26 ? 'attn' : vo2 !== null && vo2 < 30 ? 'watch' : 'good',
    reference: '≥30 for the age cohort',
    plan: 'Daily movement · GP appointment',
  });

  // Resting HR — 60–80 normal; >85 or <50 worth watching.
  const rhr = m.rhr?.value ?? null;
  raw.push({
    key: 'rhr',
    label: 'Resting HR',
    value: rhr,
    display: fmt(rhr, 0),
    unit: 'bpm',
    tone: rhr !== null && (rhr > 85 || rhr < 48) ? 'attn' : rhr !== null && (rhr > 80 || rhr < 52) ? 'watch' : 'good',
    reference: 'Reference 60–80 bpm · 30-day avg',
    plan: rhr !== null && rhr > 80 ? 'Movement · sleep · GP appointment' : undefined,
  });

  // HRV — higher is calmer; <20 is the watch zone (autonomic load).
  const hrv = m.hrv?.value ?? null;
  raw.push({
    key: 'hrv',
    label: 'HRV',
    value: hrv,
    display: fmt(hrv, 0),
    unit: 'ms',
    tone: hrv !== null && hrv < 20 ? 'watch' : 'good',
    reference: 'higher is calmer · daily mean',
  });

  // SpO2 nadir — nightly low. <88 is the apnoea-signal red; pair with HNO plan.
  const spo2 = m.spo2?.value ?? null;
  raw.push({
    key: 'spo2',
    label: 'SpO₂ night low',
    value: spo2,
    display: fmt(spo2, 0),
    unit: '%',
    tone: spo2 !== null && spo2 < 88 ? 'attn' : spo2 !== null && spo2 < 90 ? 'watch' : 'good',
    reference: 'low ≥90 % desired',
    plan: 'ENT / sleep-apnea appointment (overdue)',
    sub: m.spo2?.avg_value != null ? `avg ${fmt(m.spo2.avg_value, 0)} % · ${m.spo2?.n ?? 0} readings` : undefined,
  });

  // Breathing disturbances — apnoea proxy. >=15/night reds; pairs with HNO plan.
  const bd = m.breathing?.value ?? null;
  raw.push({
    key: 'breathing',
    label: 'Breathing disturbances',
    value: bd,
    display: fmt(bd, 0),
    unit: '/night',
    tone: bd !== null && bd >= 15 ? 'attn' : bd !== null && bd >= 5 ? 'watch' : 'good',
    reference: 'Apple Watch signal · lower is calmer',
    plan: 'ENT / sleep-apnea appointment (overdue)',
  });

  return raw.map((v) => ({
    ...v,
    severity: SEV_FROM_TONE[v.tone],
    toneLabel: TONE_LABEL[v.tone],
    trend: buildTrendView(v.key as TrendKey, m.trends?.[v.key as TrendKey] ?? null),
  }));
}

// Quick-stats summary for the collapsed BODY header (v2 #2).
export function bodySummary(views: MetricView[]): string {
  const attn = views.filter((v) => v.severity === 'red').length;
  const watch = views.filter((v) => v.severity === 'amber').length;
  const good = views.filter((v) => v.severity === 'green').length;
  return `${attn} to discuss · ${watch} watch · ${good} in range`;
}
