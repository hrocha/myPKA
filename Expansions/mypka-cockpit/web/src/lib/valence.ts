// valence.ts — frontend valence map for the MIND "patterns" cards (v3 #1).
//
// Tom wants each pattern coloured by whether it's a strength (good) or a struggle
// (straining), so the patterns read at a glance as "where I'm solid vs where it hurts."
//
// IMPORTANT — this is a HARDCODED frontend map, on purpose and temporarily:
//   • Inventing a `valence` frontmatter field on the Topic notes would require a
//     GL-002 change first (root AGENTS.md: "Do NOT invent frontmatter fields").
//   • So this map lives in the frontend for now and is FLAGGED to graduate into a
//     GL-002 `valence` field on the pattern Topics, maintained by Anima (who owns
//     the psyche/inner-work layer). Once that field exists, the server reads it
//     from `topics.valence` and this map is deleted. Handoff noted to Larry.
//
// Tone vocabulary (calm, not alarmist — health-anxiety-aware):
//   good     → a core value / strength (green)
//   watch    → a real but managed tension ("watch", amber)
//   strain   → a painful one Tom is actively struggling with (red, but soft)
//   neutral  → unknown / unmapped pattern (no colour, honest default)

export type ValenceTone = 'good' | 'watch' | 'strain' | 'neutral';

export interface Valence {
  tone: ValenceTone;
  label: string;
}

// Per-instance valence map for the Mind "patterns" cards.
//
// EMPTY BY DEFAULT. The cockpit author's real pattern-note slugs have been
// removed — every slug resolves to the neutral default until you wire your own.
// This is the client-side partner of the server's MIND_TOPIC_SLUGS scrub
// (server/queries.js): MIND_TOPIC_SLUGS decides WHICH pattern Topics surface,
// VITE_MIND_VALENCE_MAP decides their tone. Both empty → a calm, honest section.
//
// Wire your own at build time via the VITE_MIND_VALENCE_MAP env var — a JSON
// object of { "<your-topic-slug>": { "tone": "good|watch|strain|neutral",
// "label": "..." } }. Unset or malformed → empty map → neutral for every slug.
// (FLAGGED to graduate into a GL-002 `valence` field on the pattern Topics,
// maintained by Anima; once that field exists, the server reads `topics.valence`
// and this map is deleted entirely. Handoff noted to Larry.)
function loadValenceMap(): Record<string, Valence> {
  const raw = import.meta.env.VITE_MIND_VALENCE_MAP;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Valence> = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as { tone?: unknown; label?: unknown };
      const tone: ValenceTone =
        v.tone === 'good' || v.tone === 'watch' || v.tone === 'strain' ? v.tone : 'neutral';
      const label = typeof v.label === 'string' ? v.label : 'pattern';
      out[slug] = { tone, label };
    }
    return out;
  } catch {
    // Malformed env → empty map (calm default), never a build/runtime crash.
    return {};
  }
}

const VALENCE_MAP: Record<string, Valence> = loadValenceMap();

const UNKNOWN: Valence = { tone: 'neutral', label: 'pattern' };

export function patternValence(slug: string): Valence {
  return VALENCE_MAP[slug] ?? UNKNOWN;
}
