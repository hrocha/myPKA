// OrbitingInsight.tsx — the conversation→journal "crystallisation" visual, lifted in
// spirit from the old stoic-mentor orbiting-insights field (Felix 08 §Deferred) and
// re-implemented CSS-driven for the cockpit Journal page (unified spec Decision 5:
// "Conversations crystallise as journal entries… with the orbiting-insight visual").
//
// A small Σ-marked node with a few insight motes orbiting it — a quiet signal that this
// entry condensed out of a Chat-with-Larry session. Pure presentational, token-only.
// The orbit animation is ambient and is collapsed by the global prefers-reduced-motion
// rule (index.css), so it freezes to a static glyph for motion-sensitive users.
import { Sparkles } from 'lucide-react';

export function OrbitingInsight({ count = 3 }: { count?: number }) {
  // Cap the motes so a long conversation doesn't crowd the row.
  const motes = Array.from({ length: Math.min(Math.max(count, 1), 4) });
  return (
    <span className="orbiting-insight" aria-hidden="true" title="Crystallised from a conversation">
      <span className="orbiting-insight-core">
        <Sparkles size={11} strokeWidth={1.6} />
      </span>
      {motes.map((_, i) => (
        <span
          key={i}
          className="orbiting-insight-mote"
          style={{ '--mote-i': i, '--mote-n': motes.length } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

/** True when a journal item came from a Chat-with-Larry conversation (voice OR text). */
export function isConversationEntry(item: {
  entryType?: string | null;
  tags?: string[] | null;
}): boolean {
  const et = (item.entryType ?? '').toLowerCase();
  if (et === 'voice' || et === 'chat' || et === 'conversation') return true;
  const tags = (item.tags ?? []).map((t) => t.toLowerCase());
  return tags.some(
    (t) =>
      t === 'voice-reflection' ||
      t === 'chat-reflection' ||
      t === 'stoic-mentor' ||
      t === 'conversation',
  );
}
