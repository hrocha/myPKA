// theme.ts — Light / Dark / System theme control for the cockpit.
//
// THE MODEL
//   The user picks one of three PREFERENCES: 'light' | 'dark' | 'system'.
//   'system' RESOLVES to light or dark via `prefers-color-scheme`, and re-resolves
//   live when the OS theme changes. The RESOLVED value is written to
//   document.documentElement[data-theme], which flips the token set in index.css
//   ([data-theme="light"] vs the default [data-theme="dark"]).
//
// PERSISTENCE
//   The preference is a pure presentation choice that must apply BEFORE first
//   paint (no flash of the wrong theme), so it lives in localStorage and is
//   applied by a tiny inline bootstrap in index.html as well as here. localStorage
//   survives reload and is the consistent, simplest store for a client-only,
//   render-blocking concern (the module_prefs DB path is for Hub-module state and
//   would round-trip a fetch after paint — wrong tool for theming).
//
// Tokens stay the single source of truth: this module never sets a colour, only
// toggles which token set is active.
import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'cockpit-theme';

const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

function isThemePref(v: unknown): v is ThemePref {
  return typeof v === 'string' && (PREFS as readonly string[]).includes(v);
}

/** The stored preference, or 'system' when unset/invalid. */
export function readThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePref(raw)) return raw;
  } catch {
    /* storage unavailable (private mode / disabled) — fall through to default */
  }
  return 'system';
}

/** What the OS currently asks for. */
export function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Resolve a preference to a concrete theme. */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref;
}

/** Paint the resolved theme onto <html> (the token-set switch) and keep the UA
 *  color-scheme hint in sync so native form controls / scrollbars match. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

/**
 * useTheme — the Settings switch's hook.
 *   pref      — the current preference ('light' | 'dark' | 'system')
 *   resolved  — the concrete theme in effect right now
 *   setPref   — persist a new preference + re-apply (and start/stop the live
 *               OS-change listener as needed)
 *
 * On mount it re-applies the stored preference (the inline bootstrap already did
 * the pre-paint pass; this keeps React state in sync and owns the live listener).
 */
export function useTheme(): {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (next: ThemePref) => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(() => readThemePref());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemePref()));

  // Apply on mount + whenever the preference changes.
  useEffect(() => {
    const next = resolveTheme(pref);
    setResolved(next);
    applyResolvedTheme(next);
  }, [pref]);

  // Live OS-theme tracking — only while the preference is 'system'.
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const next = systemTheme();
      setResolved(next);
      applyResolvedTheme(next);
    };
    // addEventListener is the modern API; all current browsers support it on MQL.
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = useCallback((next: ThemePref) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — the in-memory state below still applies the theme */
    }
    setPrefState(next);
  }, []);

  return { pref, resolved, setPref };
}
