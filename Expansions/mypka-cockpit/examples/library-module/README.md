# Worked example: building a library module

> **The DATA side is now a first-class foundation.** This folder is the **client
> / UI reference** (the two view components + the server snippet). The **schema +
> ingestion + install + data contract** for libraries now ship as a built
> foundation:
> - `../../sqlite-extension/schema/07-library-foundation.sql` — the registry +
>   the `recipes` and `movies` mirror tables (the reusable pattern).
> - `../../scripts/regen-mypka-db.py` — the registry-driven `LIBRARIES` config
>   block + the one generic ingestion loop that fills every library.
> - `../../sqlite-extension/install-extensions.py --with-libraries` — additive,
>   idempotent install of the empty tables + registry rows.
> - `../../sqlite-extension/DATA-CONTRACT.md §11` — the column contract Felix
>   builds the UI against, the enumeration + list + random queries, and the
>   card → open-detail-in-large spec.
> - `../recipes/` and `../movies/` — synthetic English example notes.
>
> Treat the `.tsx` files here as the UI you adapt; treat §11 as the data contract.

This folder contains the complete, working code of two library modules that
once shipped in the cockpit core — a **Recipes** library and a **Films &
Series** library. They were moved here so the core stays minimal and so your
LLM assistant has a reference for building **any** library you ask for: books,
board games, vinyl, wines, restaurants, gear…

A library module is three small pieces:

```
1. Data    — markdown notes in a folder you choose, mirrored into a table in mypka.db
2. Server  — one read-only endpoint (a prepared SELECT) in server/server.js
3. Client  — one view component + one entry in web/src/lib/moduleRegistry.tsx
```

## 1. Data

Pick a home for the notes (e.g. `PKM/My Life/Recipes/`, one file per recipe,
YAML frontmatter for the structured fields). Then teach the regen to mirror
them: copy the pattern of any entity block in
`../../scripts/regen-mypka-db.py` — add a `CREATE TABLE recipes (…)` to a new
section (do **not** add it to `OWNED_TABLES`' contract tables; add your table
name to that list so it's rebuilt each run), scan the folder, insert rows.
Keep list-ish fields (tags, ingredients) as JSON-array TEXT.

`server-queries.js.snippet` shows the original mirror queries the two example
views consume, including the JSON-array parsing helper:

- `recipes(slug, title, cuisine, dish_type, difficulty, status, total_time_min,
  servings, ingredient_count, key_ingredients, source_url, source_channel,
  tags, file_path)`
- `media(slug, title, media_type, status, rating, release_year, genre,
  director_creator, platform, date_watched, progress, total_seasons,
  episodes_watched, verdict, tags, file_path)`

## 2. Server

In `server/cockpit.js` (or a new module), add the prepared statement + list
function from the snippet. In `server/server.js`, mount it next to the other
cockpit reads:

```js
app.get('/api/cockpit/recipes', safe(() => listRecipes()));
```

Read-only `safe()` + prepared SELECTs only. No new file routes — covers/photos
referenced by notes are served through the existing jailed `/api/cockpit/media`
route (paths relative to `PKM/`).

## 3. Client

Copy `RecipesView.tsx` (or `MediaView.tsx`) into `web/src/views/`, adjust the
fields/filters to your data, then register it in
`web/src/lib/moduleRegistry.tsx`:

```tsx
import { ChefHat } from 'lucide-react';
import { RecipesView } from '../views/RecipesView';

export const COCKPIT_MODULES: readonly CockpitModule[] = [
  {
    slug: 'recipes',
    navLabel: 'Recipes',
    navIcon: ChefHat,
    navSection: 'library',
    View: RecipesView,
  },
];
```

Rebuild (`npm --prefix web run build`), relaunch — the sidebar's Library group
appears with your module in it. `#/recipes` deep-links to it.

> Note: the two example views were written against the original mirror schema
> above and may reference small helpers from their old home; treat them as
> living documentation to copy from, not as files to import unchanged.
