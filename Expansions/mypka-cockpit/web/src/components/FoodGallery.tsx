// FoodGallery.tsx — a photo timeline of meals. ANXIETY-FREE by hard contract:
// NO numbers, NO calories, NO scores, NO good/bad colouring. Just a quiet record
// of what was on the plate.
//   • photo (or a calm "noch kein Foto" tile when none yet)
//   • meal-type + time-of-day label
//   • neutral-descriptive context tags (geplant/random/stress/sozial/spät) — all
//     the same surface tint, never red/green
//   • visible-protein as a dezent icon, NOT a rating badge
// Photos load through the existing read-only /api/cockpit/media route (PKM/
// containment), with the same broken-image → calm placeholder degradation the
// journal viewer uses.
import { useState } from 'react';
import { Camera, ImageOff, Drumstick, UtensilsCrossed, ArrowUpRight } from 'lucide-react';
import { navigate } from '../lib/router';
import type { FoodLog } from '../lib/trackingTypes';

// Meal-type → a human, neutral label. Never ranked.
const MEAL_LABEL: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
  other: 'Meal',
};

// Context tags get a plain, descriptive label — deliberately NOT colour-coded by
// "good vs bad". stress/spät read exactly as calm as geplant/sozial.
const CONTEXT_LABEL: Record<string, string> = {
  geplant: 'planned',
  random: 'random',
  stress: 'stress',
  sozial: 'social',
  spät: 'late',
  spaet: 'late',
};

function mealLabel(t: string | null): string {
  if (!t) return 'Meal';
  return MEAL_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

// Turn the markdown note into a calm one-or-two-line plain-text preview: strip the
// "## Entry" scaffolding, wikilinks, emphasis, code, bullets — just the prose.
function notePreview(note: string | null): string | null {
  if (!note) return null;
  const body = note
    .replace(/##\s+Related[\s\S]*$/i, '')   // drop the Related section
    .replace(/##\s+Entry/i, '')             // drop the Entry heading
    .replace(/`[^`]*`/g, '')                // inline code / paths
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return null;
  return body.length > 220 ? `${body.slice(0, 217)}…` : body;
}

// One photo (or placeholder). Degrades to a calm tile, never a broken <img>.
function MealPhoto({ path, alt }: { path: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!path || failed) {
    return (
      <div className="food-photo food-photo--empty" aria-hidden="true">
        {path ? <ImageOff size={22} strokeWidth={1.5} /> : <Camera size={22} strokeWidth={1.25} />}
        <span className="food-photo-empty-note">{path ? 'photo not on disk' : 'no photo yet'}</span>
      </div>
    );
  }
  return (
    <img
      className="food-photo"
      src={`/api/cockpit/media?path=${encodeURIComponent(path)}`}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function MealCard({ log }: { log: FoodLog }) {
  const meal = mealLabel(log.mealType);
  const preview = notePreview(log.note);
  const extraPhotos = log.photoCount > 1 ? log.photoCount - 1 : 0;

  return (
    <article className="food-card">
      <div className="food-card-media">
        <MealPhoto path={log.photoPath} alt={`${meal}${log.date ? ` on ${log.date}` : ''}`} />
        {extraPhotos > 0 && (
          <span className="food-photo-more" aria-label={`${log.photoCount} photos`}>
            +{extraPhotos}
          </span>
        )}
      </div>

      <div className="food-card-body">
        <div className="food-card-head">
          <span className="food-meal">
            <UtensilsCrossed size={14} strokeWidth={1.5} aria-hidden="true" />
            {meal}
          </span>
          {log.date && <time className="food-date">{log.date}</time>}
          {/* Visible-protein: a dezent icon, NOT a rating. Only shown when true. */}
          {log.proteinVisible === true && (
            <span className="food-protein" title="visible protein source on the plate">
              <Drumstick size={13} strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">visible protein</span>
            </span>
          )}
        </div>

        {/* Neutral context tags — all one calm tint, no good/bad colour. */}
        {log.context.length > 0 && (
          <div className="food-tags">
            {log.context.map((c) => (
              <span key={c} className="food-tag">{CONTEXT_LABEL[c] ?? c}</span>
            ))}
          </div>
        )}

        {preview && <p className="food-note">{preview}</p>}

        {log.journalSlug && (
          <button
            type="button"
            className="food-open"
            onClick={() => navigate({ name: 'note', type: 'journal', slug: log.journalSlug as string })}
          >
            Open entry
            <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}

export function FoodGallery({ logs }: { logs: FoodLog[] }) {
  if (logs.length === 0) {
    return (
      <div className="food-empty">
        <Camera size={24} strokeWidth={1.25} aria-hidden="true" />
        <p className="food-empty-title">No meals logged yet</p>
        <p className="food-empty-sub">
          Photo meal logs appear here as they land — just a quiet record of what was on the plate.
        </p>
      </div>
    );
  }

  // Group by date so the timeline reads as a calm day-by-day record.
  const byDate = new Map<string, FoodLog[]>();
  for (const log of logs) {
    const key = log.date ?? 'undated';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(log);
  }
  const days = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  return (
    <div className="food-timeline">
      {days.map(([date, dayLogs]) => (
        <section key={date} className="food-day">
          <h4 className="food-day-label">
            {date === 'undated'
              ? 'Undated'
              : new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {
                  weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
                })}
          </h4>
          <div className="food-grid">
            {dayLogs.map((log) => (
              <MealCard key={log.id} log={log} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
