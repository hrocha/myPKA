// SourceMark.tsx — the source-tool glyph that leads a planner card's meta row
// (Iris spec 11 §1). The backend is TOOL-BLIND (0..N task connectors of anything),
// so the mark matches the OPEN source id against a small set of KNOWN glyphs and
// falls back to a generic monochrome mark for any unknown id — it must never
// crash or render empty on a source it hasn't seen before.
//
// Matching (by source id):
//   'todoist'              → inlined simple-icons Todoist mark
//   'clickup'              → inlined simple-icons ClickUp mark
//   'calendar' / 'ical*'   → inlined simple-icons Google Calendar mark
//   'email*'               → Lucide Mail (e.g. 'email:starred')
//   anything else          → Lucide CircleDot (generic, monochrome, 14px)
//
// MONOCHROME, currentColor, 14px (Iris's --planner-source-mark-size /
// --planner-source-mark tint). NOT the multicolour stock brand assets — the calm
// dark palette (§0 / §9.1) cannot host Todoist red + ClickUp gradient + Google
// Calendar multicolour. Brand path strings are the verified single-path glyphs
// from simple-icons (siTodoist, siClickup, siGooglecalendar; fetched 2026-06-02);
// inlined for 3 glyphs rather than adding the whole dep. Platform logos remain
// the sanctioned exception to the Lucide-only icon rule (§5.5).

import { CircleDot, Mail } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GlyphSource } from '../../lib/plannerTypes';

// simple-icons single-path data (24×24 viewBox), monochrome by design.
const BRAND_PATHS: Record<string, string> = {
  // siTodoist
  todoist:
    'M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z',
  // siClickup
  clickup:
    'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z',
  // siGooglecalendar
  calendar:
    'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
};

// Resolve a free-form source id to a known brand path (or null → Lucide fallback).
function brandPathFor(source: string): string | null {
  if (BRAND_PATHS[source]) return BRAND_PATHS[source];
  if (source.startsWith('ical') || source.startsWith('calendar')) return BRAND_PATHS.calendar;
  return null;
}

// Resolve a free-form source id to its Lucide fallback glyph: Mail for any
// 'email*' connector (e.g. 'email:starred'), CircleDot for everything unknown.
function lucideFor(source: string): LucideIcon {
  return source.startsWith('email') ? Mail : CircleDot;
}

// Human-readable labels for the KNOWN sources; anything else falls back to the
// source id itself (the response's own `label` is preferred wherever available —
// this is only the last-resort fallback for callers that lack one).
const KNOWN_LABELS: Record<string, string> = {
  todoist: 'Todoist',
  clickup: 'ClickUp',
  calendar: 'Google Calendar',
};
export function sourceLabelFor(source: string): string {
  if (KNOWN_LABELS[source]) return KNOWN_LABELS[source];
  if (source.startsWith('ical') || source.startsWith('calendar')) return KNOWN_LABELS.calendar;
  return source;
}

export interface SourceMarkProps {
  source: GlyphSource;
  /** When set, the mark is exposed as an img with this name; otherwise decorative. */
  label?: string;
}

export function SourceMark({ source, label }: SourceMarkProps) {
  const path = brandPathFor(source);
  const Fallback = lucideFor(source);
  return (
    <span
      className="planner-source-mark"
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {path ? (
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d={path} />
        </svg>
      ) : (
        // Lucide glyphs are STROKE icons; the .planner-source-mark svg rule sets
        // fill:currentColor (right for the filled brand paths, wrong here — it
        // would solid-fill the outline). The inline fill:none out-specifies the
        // class rule so the stroke rendering survives; size rides the same
        // --planner-source-mark-size box via the 100% width/height rule.
        <Fallback size={14} strokeWidth={1.75} style={{ fill: 'none' }} aria-hidden="true" />
      )}
    </span>
  );
}
