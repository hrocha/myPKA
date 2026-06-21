/*
 * theme-bootstrap.js — runs BEFORE the stylesheet/app so the correct token set is
 * on <html> at first paint (no flash of the wrong theme). Mirrors src/lib/theme.ts:
 * read the 'cockpit-theme' preference, resolve 'system' via prefers-color-scheme,
 * set data-theme + color-scheme on the root.
 *
 * WHY THIS IS AN EXTERNAL FILE (not an inline <script>):
 *   The cockpit server serves the SPA under a strict CSP (`script-src 'self'`),
 *   which BLOCKS inline scripts (no 'unsafe-inline'). Loaded from /theme-bootstrap.js
 *   it is a same-origin ('self') asset the existing CSP already permits — no nonce,
 *   no per-build hash to drift. Vite copies web/public/* to the dist root verbatim,
 *   and index.html references it with a plain (non-module, non-deferred) <script> so
 *   it executes synchronously in <head> before first paint, exactly as the old inline
 *   script did. Keep this CSP-safe (self-origin) and synchronous if you edit it.
 */
(function () {
  try {
    var pref = localStorage.getItem('cockpit-theme');
    if (pref !== 'light' && pref !== 'dark') pref = 'system';
    var resolved =
      pref === 'system'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : pref;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
