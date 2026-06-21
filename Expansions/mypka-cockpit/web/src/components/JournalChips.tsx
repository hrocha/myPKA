// JournalChips.tsx — calm mood/energy chips for journal entries.
// Mood values in the data are mixed: numeric "1".."5" (legacy) and free-text
// German/English words ("clear-decisive", "rattled", "grateful", "nachdenklich").
// We never moralise the value (no red "bad mood"); the chip is a quiet label so
// the journal reads as a record, not a scorecard.
import { Smile, Gauge } from 'lucide-react';

// A numeric 1..5 mood maps to a soft tone for a gentle visual cue only.
function numericTone(n: number): 'low' | 'mid' | 'high' {
  if (n <= 2) return 'low';
  if (n >= 4) return 'high';
  return 'mid';
}

export function MoodChip({ mood }: { mood: string }) {
  const num = Number(mood);
  const isNum = !Number.isNaN(num) && /^\d+(\.\d+)?$/.test(mood.trim());
  const tone = isNum ? numericTone(num) : 'word';
  const label = isNum ? `Mood ${mood}/5` : mood;
  return (
    <span className={`chip-mood tone-${tone}`} title="Mood">
      <Smile size={12} strokeWidth={1.5} aria-hidden="true" />
      {label}
    </span>
  );
}

export function EnergyChip({ energy }: { energy: string }) {
  const num = Number(energy);
  const isNum = !Number.isNaN(num) && /^\d+(\.\d+)?$/.test(energy.trim());
  const label = isNum ? `Energy ${energy}/5` : energy;
  return (
    <span className="chip-energy" title="Energy">
      <Gauge size={12} strokeWidth={1.5} aria-hidden="true" />
      {label}
    </span>
  );
}
