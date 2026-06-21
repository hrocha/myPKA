// useSidebarPrefs — persisted boolean preferences for the planner's Unscheduled
// sidebar (Iris 11 §3): the collapsed state and the grouped/flat preference. Each is
// a single localStorage-backed boolean, mirroring the useCollapsed / usePlannerSettings
// pattern already in the codebase (try/catch degrades to in-memory in private mode).

import { useCallback, useState } from 'react';

function read(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable (private mode) — degrade to in-memory only */
  }
}

// A single persisted boolean with a stable toggle. Generic over the storage key so
// both the collapse flag and the group flag reuse the same machinery.
export function usePersistedBool(key: string, defaultValue: boolean): [boolean, () => void] {
  const [value, setValue] = useState<boolean>(() => read(key, defaultValue));
  const toggle = useCallback(() => {
    setValue((prev) => {
      const next = !prev;
      write(key, next);
      return next;
    });
  }, [key]);
  return [value, toggle];
}

export const SIDEBAR_COLLAPSED_KEY = 'mypka-planner-sidebar-collapsed-v1';
export const SIDEBAR_GROUPED_KEY = 'mypka-planner-sidebar-grouped-v1';
// Iris 16 §9: collapse the morning (AM) band when the afternoon has been reached, so the
// user can focus on the PM. Session-scoped persistence is fine; reuses usePersistedBool.
export const AM_COLLAPSED_KEY = 'mypka-planner-am-collapsed-v1';
// Iris 20 §3: focus-mode filter (show only highlights + meetings on the board). Persisted
// across sessions so the operator returns to the view they left in. Reuses usePersistedBool.
export const FOCUS_MODE_KEY = 'mypka-planner-focus-mode-v1';

// Per-source-group collapsed state (Iris 13 req 5): a map of source key → collapsed
// bool, persisted as one JSON blob keyed by source. Mirrors the usePersistedBool
// degradation (try/catch → in-memory in private mode). A source absent from the map
// reads as expanded (the calm default — groups open until the user folds one).
const GROUP_COLLAPSED_KEY = 'mypka-planner-sidebar-group-collapsed-v1';

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable (private mode) — degrade to in-memory only */
  }
}

// Returns the collapsed map + a stable toggle(source). A group is collapsed when its
// source key is present and true; absent/false ⇒ expanded.
export function useGroupCollapsed(): {
  isCollapsed: (source: string) => boolean;
  toggle: (source: string) => void;
} {
  const [map, setMap] = useState<Record<string, boolean>>(() => readMap());
  const isCollapsed = useCallback((source: string) => map[source] === true, [map]);
  const toggle = useCallback((source: string) => {
    setMap((prev) => {
      const next = { ...prev, [source]: !prev[source] };
      writeMap(next);
      return next;
    });
  }, []);
  return { isCollapsed, toggle };
}
