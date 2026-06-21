// RecipesView.tsx — the recipe LIBRARY ("Rezepte"). Surfaces the `recipes`
// mirror table (GET /api/cockpit/recipes) as a responsive card grid Tom can
// browse and filter on the schema axes that matter: cuisine, dish_type,
// difficulty, status, plus a free-text search across title / key ingredients /
// tags.
//
// Read-only, loopback/LAN posture like every other view. Recipes are CANONICAL
// markdown (PKM/My Life/Recipes/<slug>.md), mirrored into mypka.db; this view is
// a derived read. The table is 0 rows today (Mei seeds content later), so the
// EMPTY STATE is first-class — a friendly "library not yet filled" panel, never a
// broken/blank page. NULL filter cells render blank, never `unknown`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChefHat, Clock, Users, Search } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import { S } from '../lib/strings';

interface Recipe {
  slug: string;
  title: string | null;
  cuisine: string | null;
  dish_type: string | null;
  difficulty: string | null;
  status: string | null;
  total_time_min: number | null;
  servings: number | null;
  ingredient_count: number | null;
  key_ingredients: string[];
  source_url: string | null;
  source_channel: string | null;
  tags: string[];
  file_path: string;
}
interface RecipesResponse { recipes: Recipe[] }

// English display labels for the structured single-value axes (GL-002 §Recipes
// vocab). The KEYS are data tokens from mypka.db (do NOT translate them); the
// VALUES are UI chrome (English). An unknown / future value falls through to the
// raw token, so a new `cuisine: mediterran` shows up with no code change.
const CUISINE_LABEL: Record<string, string> = {
  korean: 'Korean', chinese: 'Chinese', thai: 'Thai',
  japanese: 'Japanese', vietnamese: 'Vietnamese', indian: 'Indian',
  mediterran: 'Mediterranean', italian: 'Italian', other: 'Other',
};
const DISH_LABEL: Record<string, string> = {
  suppe: 'Soup', hauptgericht: 'Main', beilage: 'Side',
  snack: 'Snack', teigtaschen: 'Dumplings', dessert: 'Dessert',
  sauce: 'Sauce', other: 'Other',
};
const DIFFICULTY_LABEL: Record<string, string> = {
  anfaenger: 'Beginner', mittel: 'Intermediate', fortgeschritten: 'Advanced',
};
const STATUS_LABEL: Record<string, string> = {
  idee: 'Idea', 'zu-testen': 'To try', 'im-repertoire': 'In rotation',
};

function labelOf(map: Record<string, string>, value: string | null): string {
  if (!value) return '';
  return map[value] ?? value;
}

// Distinct, sorted set of a single-value axis across the data (drives the facet
// dropdown options — only values that actually occur are offered).
function distinct(recipes: Recipe[], pick: (r: Recipe) => string | null): string[] {
  const set = new Set<string>();
  for (const r of recipes) {
    const v = pick(r);
    if (v) set.add(v);
  }
  return Array.from(set).sort();
}

function Facet({
  label, value, options, labelMap, onChange,
}: {
  label: string; value: string; options: string[];
  labelMap: Record<string, string>; onChange: (v: string) => void;
}) {
  // Don't render a facet that has no values to filter on.
  if (options.length === 0) return null;
  return (
    <label className="filter-facet">
      <span className="filter-facet-label">{label}</span>
      <select className="filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{S.recipes.facetAll}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{labelMap[opt] ?? opt}</option>
        ))}
      </select>
    </label>
  );
}

function RecipeCard({ recipe }: { recipe: Recipe }) {
  const cuisine = labelOf(CUISINE_LABEL, recipe.cuisine);
  const dish = labelOf(DISH_LABEL, recipe.dish_type);
  const difficulty = labelOf(DIFFICULTY_LABEL, recipe.difficulty);
  const status = labelOf(STATUS_LABEL, recipe.status);
  return (
    <li className="lib-card">
      <div className="lib-card-head">
        <span className="lib-card-title">{recipe.title || recipe.slug}</span>
        {status && <span className="lib-badge">{status}</span>}
      </div>

      <div className="lib-meta">
        {cuisine && <span className="lib-meta-item">{cuisine}</span>}
        {dish && <span className="lib-meta-item">{dish}</span>}
        {difficulty && <span className="lib-meta-item">{difficulty}</span>}
      </div>

      <div className="lib-stats">
        {recipe.total_time_min != null && (
          <span className="lib-stat">
            <Clock size={14} strokeWidth={1.5} aria-hidden="true" />
            {recipe.total_time_min} min
          </span>
        )}
        {recipe.servings != null && (
          <span className="lib-stat">
            <Users size={14} strokeWidth={1.5} aria-hidden="true" />
            {recipe.servings} {recipe.servings === 1 ? 'serving' : 'servings'}
          </span>
        )}
      </div>

      {recipe.tags.length > 0 && (
        <ul className="lib-tags">
          {recipe.tags.map((t) => (
            <li key={t} className="lib-tag">#{t}</li>
          ))}
        </ul>
      )}

      {recipe.source_channel && (
        <span className="lib-card-source">{S.recipes.sourcePrefix}: {recipe.source_channel}</span>
      )}
    </li>
  );
}

export function RecipesView() {
  const { data, loading, error } = useFetch<RecipesResponse>('/api/cockpit/recipes');
  const topRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const [cuisine, setCuisine] = useState('');
  const [dishType, setDishType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');

  const recipes = useMemo(() => data?.recipes ?? [], [data]);

  const cuisineOpts = useMemo(() => distinct(recipes, (r) => r.cuisine), [recipes]);
  const dishOpts = useMemo(() => distinct(recipes, (r) => r.dish_type), [recipes]);
  const difficultyOpts = useMemo(() => distinct(recipes, (r) => r.difficulty), [recipes]);
  const statusOpts = useMemo(() => distinct(recipes, (r) => r.status), [recipes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recipes.filter((r) => {
      if (cuisine && r.cuisine !== cuisine) return false;
      if (dishType && r.dish_type !== dishType) return false;
      if (difficulty && r.difficulty !== difficulty) return false;
      if (status && r.status !== status) return false;
      if (q) {
        const hay = [
          r.title ?? '',
          ...r.key_ingredients,
          ...r.tags,
          r.source_channel ?? '',
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [recipes, cuisine, dishType, difficulty, status, query]);

  if (loading) return <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>;
  if (error) return <div role="alert" className="view-error">{S.recipes.loadError}: {error}</div>;
  if (!data) return null;

  const total = recipes.length;

  return (
    <section ref={topRef} className="library-view animate-fade-rise">
      <header className="library-header">
        <h1 className="page-title">
          <ChefHat size={24} strokeWidth={1.5} aria-hidden="true" className="title-icon" />
          {S.recipes.title}
        </h1>
        <p className="page-sub">
          {total === 0
            ? S.recipes.emptyLibrary
            : `${total} ${total === 1 ? 'recipe' : 'recipes'} · ${filtered.length} shown`}
        </p>
      </header>

      {/* Empty state — 0 rows today (Mei seeds content once the ingredients
          are settled). Friendly, not broken. */}
      {total === 0 ? (
        <div className="library-empty">
          <span className="library-empty-mark" aria-hidden="true">
            <ChefHat size={28} strokeWidth={1.5} />
          </span>
          <p className="library-empty-title">{S.recipes.emptyTitle}</p>
          <p className="library-empty-sub">
            {S.recipes.emptySub}
          </p>
        </div>
      ) : (
        <>
          <div className="filter-bar" role="search">
            <label className="filter-search">
              <Search size={16} strokeWidth={1.5} aria-hidden="true" className="filter-search-icon" />
              <input
                type="search"
                className="filter-search-input"
                placeholder={S.recipes.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={S.recipes.searchAria}
              />
            </label>
            <Facet label={S.recipes.facetCuisine} value={cuisine} options={cuisineOpts} labelMap={CUISINE_LABEL} onChange={setCuisine} />
            <Facet label={S.recipes.facetDish} value={dishType} options={dishOpts} labelMap={DISH_LABEL} onChange={setDishType} />
            <Facet label={S.recipes.facetDifficulty} value={difficulty} options={difficultyOpts} labelMap={DIFFICULTY_LABEL} onChange={setDifficulty} />
            <Facet label={S.recipes.facetStatus} value={status} options={statusOpts} labelMap={STATUS_LABEL} onChange={setStatus} />
          </div>

          {filtered.length === 0 ? (
            <div className="library-noresults">{S.recipes.noResults}</div>
          ) : (
            <ul className="library-grid">
              {filtered.map((r) => (
                <RecipeCard key={r.slug} recipe={r} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
