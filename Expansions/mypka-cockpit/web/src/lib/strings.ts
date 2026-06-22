// strings.ts — the single home for the cockpit's UI CHROME copy (English).
//
// Why this file exists: until 2026-06 the cockpit shipped a mix of German and
// English chrome. This module collects the fixed UI text the app ships — nav
// labels, view titles, buttons, placeholders, empty-states, aria-labels — into
// one English source of truth.
//
// This is NOT an i18n framework and NOT a locale toggle. It's a flat constant
// tree so that a future per-user UI-language switch has a single seam to route
// through (swap `S` for a locale-keyed lookup) without a framework rewrite.
//
// SCOPE — chrome only. This file MUST NOT contain user content or data-derived
// values: note bodies, journal text, chat text, recipe/media titles, medical
// diagnosis names, or anything pulled from mypka.db / the markdown vault. Those
// stay in whatever language the data is in. Enum DISPLAY labels (e.g. a recipe
// cuisine token `korean` -> "Korean") live alongside their view, not here,
// because they're a thin presentation layer over a data vocabulary.

export const S = {
  pin: {
    subtitle: 'Enter your PIN to continue.',
    fieldLabel: 'PIN',
    checking: 'Checking…',
    unlock: 'Unlock',
    footer:
      'Local access on your home network · read-only · no data leaves your network.',
    errNoPin: 'No PIN configured. Run “npm run set-pin” on the Mac.',
    errNetwork: 'Server unreachable. Check your connection.',
    errInvalid: 'Wrong PIN.',
    errLocked: (mins: number) =>
      `Too many attempts. Please wait ${mins} min.`,
  },

  sidebar: {
    groupLibrary: 'Library',
    recipes: 'Recipes',
    media: 'Movies & Series',
  },

  roster: {
    title: 'My AI Team',
    countSub: (n: number) =>
      `${n} ${n === 1 ? 'specialist' : 'specialists'} · one model, many hats`,
    loadError: 'Could not load the team',
    feedTitle: 'Team session log',
    feedEmptyTitle: 'No session logs yet',
    feedEmptySub: 'Your team’s session history appears here once your specialists start logging their work.',
    feedLoadError: 'Could not load the session log',
    rosterHeading: 'The roster',
  },

  // The "My AI Team" fly-out submenu (Sidebar) + the pages it routes to. The
  // fly-out opens off the "My AI Team" nav row and offers five destinations.
  team: {
    menuLabel: 'My AI Team',
    menuAria: 'My AI Team — open team menu',
    flyout: {
      roster: 'Team (Roster)',
      sessionLog: 'Session Log',
      workstreams: 'Workstreams',
      sops: 'SOPs',
      guidelines: 'Guidelines',
    },
    sessionLog: {
      title: 'Team Session Log',
      sub: 'Your team’s working history — newest first.',
    },
    workstreams: {
      title: 'Workstreams',
      sub: 'Multi-agent orchestrations (WS-NNN).',
      empty: 'No workstreams yet',
      emptySub:
        'Your team’s multi-step orchestrations appear here once they’re authored and the mirror is refreshed.',
      loadError: 'Could not load the workstreams',
    },
    sops: {
      title: 'SOPs',
      sub: 'Standard operating procedures (SOP-NNN).',
      empty: 'No SOPs yet',
      emptySub:
        'Your team’s atomic procedures appear here once they’re authored and the mirror is refreshed.',
      loadError: 'Could not load the SOPs',
    },
    guidelines: {
      title: 'Guidelines',
      sub: 'Static reference + house rules (GL-NNN).',
      empty: 'No guidelines yet',
      emptySub:
        'Your team’s reference guidelines appear here once they’re authored and the mirror is refreshed.',
      loadError: 'Could not load the guidelines',
    },
  },

  recipes: {
    title: 'Recipes',
    emptyLibrary: 'Your cookbook',
    emptyTitle: 'No recipes yet',
    emptySub:
      'Mei fills the library once your ingredients are settled. Until then there’s calm space here for the first dish.',
    searchPlaceholder: 'Search by title, ingredient, tag…',
    searchAria: 'Search recipes',
    noResults: 'No recipes match these filters.',
    loadError: 'Could not load the recipes',
    facetCuisine: 'Cuisine',
    facetDish: 'Type',
    facetDifficulty: 'Difficulty',
    facetStatus: 'Status',
    facetAll: 'All',
    sourcePrefix: 'Source',
  },

  media: {
    title: 'Movies & Series',
    emptyLibrary: 'Your movie & series library',
    emptyTitle: 'No entries yet',
    emptySub:
      'Once you log a movie or a series it shows up here — with your take, in your own words.',
    searchPlaceholder: 'Search by title, director, take, tag…',
    searchAria: 'Search movies and series',
    noResults: 'No entries match these filters.',
    loadError: 'Could not load movies & series',
    facetType: 'Type',
    facetStatus: 'Status',
    facetRating: 'Rating',
    facetGenre: 'Genre',
    facetAll: 'All',
    notRated: 'Not rated',
    ratingAria: (value: number) => `${value} of 5 stars`,
    creditFilm: 'Director',
    creditSerie: 'Creator',
    seasons: (n: number) => `${n} ${n === 1 ? 'season' : 'seasons'}`,
    episodesWatched: (n: number) =>
      `${n} ${n === 1 ? 'episode' : 'episodes'} watched`,
  },

  workoutMap: {
    enterFullscreen: 'Open map fullscreen',
    exitFullscreen: 'Exit map (leave fullscreen)',
    fullscreenTitle: 'Fullscreen',
    exitFullscreenTitle: 'Exit fullscreen',
    basemapHint:
      'Basemap is being prepared — routes are shown on a neutral background.',
  },
} as const;
