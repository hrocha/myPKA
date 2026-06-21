// moduleRegistry.tsx — the Cockpit module registry (drop-in extension modules).
//
// WHY THIS EXISTS
// The cockpit core is deliberately small: journal, note viewer, graph, roster,
// workbench. Everything else — a recipe library, a films & series library, a
// habit tracker, a dashboard — is meant to be a DROP-IN module your LLM
// assistant builds for you. With this registry, an extension module is ONE
// entry; without the entry, nothing in the core shell references it.
//
// HOW TO ADD A MODULE (this is the seam your LLM assistant uses)
//   1. Create a view component under web/src/views/, e.g. MyLibraryView.tsx.
//      It fetches its data from a server endpoint you add in server/server.js
//      (read-only SELECTs over mypka.db — see examples/library-module/ for a
//      complete worked example: a recipes library + a films & series library).
//   2. Append ONE entry to COCKPIT_MODULES below: slug, label, icon, sidebar
//      section, and the statically-imported component.
//   3. Rebuild (npm run build). The sidebar row, hash route (#/<slug>) and
//      content mount all derive from the entry — no other file changes.
// Rolling a module back = deleting its entry + its files.
//
// THE HYBRID MODEL (deliberate)
// PARAMETERIZED core routes (type/:type, note/:type/:slug, resolve/:slug,
// workbench/:slug) carry payloads and stay in router.ts as the typed union —
// they are core shell, not extensions. EXTENSION modules are SIMPLE top-level
// slug routes with NO payload (#/recipes, #/films, #/tracker, …). Those are
// exactly what the registry owns. The App shell + Sidebar render the union of
// both.
//
// SECURITY SURFACE
// A module entry is plain data + a statically-imported React component
// reference. There is NO eval, NO dynamic code-string injection, NO remote
// import. "Installing" a module = adding a TS entry to this static array at
// build time, which is then type-checked and bundled like any other code. The
// registry is frozen build-time data, not a runtime plugin loader.

import type { ComponentType } from 'react';
import { lazy } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Globe, HeartPulse, Inbox, Library as LibraryIcon, LineChart, ListTodo, Map as MapIcon, Package } from 'lucide-react';

// Heavy module views go behind a lazy boundary (same idiom as the Workbench /
// Board views in App.tsx) so they never enter the eager bundle. A React.lazy
// result IS a ComponentType; App's module case renders it inside <Suspense>.
const DashboardView = lazy(() => import('../views/DashboardView').then((m) => ({ default: m.DashboardView })));
const TrackingView = lazy(() => import('../views/TrackingView').then((m) => ({ default: m.TrackingView })));
const WorkoutsView = lazy(() => import('../views/WorkoutsView').then((m) => ({ default: m.WorkoutsView })));
const DeliverablesView = lazy(() => import('../views/DeliverablesView').then((m) => ({ default: m.DeliverablesView })));
const InboxView = lazy(() => import('../views/InboxView').then((m) => ({ default: m.InboxView })));
const PlannerView = lazy(() =>
  import('../views/PlannerView').then((m) => ({ default: m.PlannerView })),
);
// The Library SURFACE (DATA-CONTRACT §11). One data-driven entry that enumerates
// ALL of the user's libraries from `library_registry` (recipes, movies, books, …)
// and lists/opens their items — so a new library appears with no code change. It
// is registered here only to get the sidebar nav ROW (in the 'library' group);
// the actual rendering is the parameterized `library` core route (router.ts +
// App), which supports deep-linking #/library/:lib/:item. The bare nav link
// targets #/library (the picker). Lazy so it never enters the eager bundle.
const LibraryView = lazy(() =>
  import('../views/LibraryView').then((m) => ({ default: m.LibraryView })),
);
// The Outer World SURFACE (DATA-CONTRACT §14) — the mymind-style saved-content
// card grid. Registered here only to get the sidebar nav ROW (in the 'library'
// group, beside Library); the actual rendering is the parameterized `outer-world`
// core route (router.ts + App), which supports deep-linking #/outer-world/:slug.
// The bare nav link targets #/outer-world (the grid). Always present so the
// surface (with its first-class empty state) is one click away even on a bare
// scaffold; the surface itself shows "no saved items yet" when the table is
// absent/empty. Lazy so it never enters the eager bundle.
const OuterWorldView = lazy(() =>
  import('../views/OuterWorldView').then((m) => ({ default: m.OuterWorldView })),
);

// The sidebar groups an extension module can attach to. These mirror the
// existing <div className="sidebar-group"> sections in Sidebar.tsx.
//   'top'      — an UNGROUPED pinned block at the very top of the rail, above
//                the Hub/Overview group (no section header). Reserved for the
//                folder surfaces (Deliverables, Team Inbox) Tom wants one click
//                away.
export type ModuleNavSection = 'top' | 'overview' | 'knowledge' | 'library';

export interface CockpitModule {
  /** The hash slug, e.g. 'recipes' → #/recipes. Must be unique and must NOT
   *  collide with a core route name (journal, graph, roster, workbench, type,
   *  note, resolve). */
  slug: string;
  /** Sidebar label. */
  navLabel: string;
  /** Lucide icon for the nav row (UI-icon convention: 18px @ strokeWidth 1.5). */
  navIcon: LucideIcon;
  /** Which sidebar group the nav row lands in. */
  navSection: ModuleNavSection;
  /** The view component rendered when the route is active. Statically imported
   *  (build-time reference) — never a runtime/remote loader. */
  View: ComponentType;
  /** Optional feature gate. When it returns false the module is fully absent:
   *  no nav row, no route match, no mount. Defaults to enabled. */
  enabled?: () => boolean;
  /** Optional: render the content area full-bleed instead of the centered
   *  reading column. Defaults to the reading column. */
  fullBleed?: boolean;
}

// THE REGISTRY. One entry per drop-in module. See
// examples/library-module/README.md for the step-by-step worked example.
export const COCKPIT_MODULES: readonly CockpitModule[] = [
  // Pinned to the very top of the rail (section 'top'), above Hub. These are the
  // two folder surfaces Tom reaches for most; registration order here is their
  // render order in the top block.
  { slug: 'deliverables', navLabel: 'Deliverables', navIcon: Package, navSection: 'top', View: DeliverablesView },
  { slug: 'inbox', navLabel: 'Team Inbox', navIcon: Inbox, navSection: 'top', View: InboxView },
  // Day planner (ported from modules/planner, 2026-06-11). READ-ONLY toward the
  // source tools: tasks/meetings are visualized; editing happens in Todoist/
  // ClickUp via each card's url deep link. Plan LAYOUT (assign/reorder/weekly-
  // goal/local-complete/settings) persists locally in mypka-cockpit.db.
  // fullBleed: the weekly board owns its own layout, no reading column.
  {
    slug: 'actions',
    navLabel: 'Actions & Planning',
    navIcon: ListTodo,
    navSection: 'overview',
    View: PlannerView,
    fullBleed: true,
  },
  { slug: 'health', navLabel: 'Health & Life', navIcon: HeartPulse, navSection: 'overview', View: DashboardView },
  { slug: 'tracking', navLabel: 'Tracking', navIcon: LineChart, navSection: 'overview', View: TrackingView },
  { slug: 'workouts', navLabel: 'Workouts', navIcon: MapIcon, navSection: 'overview', View: WorkoutsView },
  // Library surface — the data-driven collection browser (recipes, movies, books,
  // …). Lands in the sidebar 'library' group. Always present so the surface (with
  // its first-class empty state) is one click away even on a bare scaffold; the
  // surface itself shows "no libraries yet" when `library_registry` is empty.
  { slug: 'library', navLabel: 'Library', navIcon: LibraryIcon, navSection: 'library', View: LibraryView },
  // Outer World — the mymind-style store of saved external content (articles,
  // posts, videos, books, ideas, news). Lands in the sidebar 'library' group
  // beside Library. fullBleed: the masonry card grid owns its own width (the
  // mymind look), so it renders edge-to-edge, not in the centered reading column.
  { slug: 'outer-world', navLabel: 'Outer World', navIcon: Globe, navSection: 'library', View: OuterWorldView, fullBleed: true },
];

/** Modules whose feature gate currently allows them. The shell only ever sees
 *  these — a gated-off module is indistinguishable from one that was never
 *  installed. */
export function activeModules(): readonly CockpitModule[] {
  return COCKPIT_MODULES.filter((m) => m.enabled?.() ?? true);
}

/** Lookup by slug, gate-aware. Returns undefined for unknown/gated slugs so the
 *  router can fall through to the default view. */
export function moduleForSlug(slug: string): CockpitModule | undefined {
  return activeModules().find((m) => m.slug === slug);
}

/** Active modules attached to a given sidebar group, in registration order. */
export function modulesForSection(section: ModuleNavSection): readonly CockpitModule[] {
  return activeModules().filter((m) => m.navSection === section);
}
