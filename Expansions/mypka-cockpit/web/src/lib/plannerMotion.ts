// plannerMotion.ts — Vivi's MCP-derived motion values (03-motion-spec-vivi.md),
// supplied as the CSS strings dnd-kit consumes (dnd-kit cannot import a JS spring).
//
// These are NOT invented — every value is cited verbatim from Vivi's spec §5 (each
// derived from Motion Studio MCP and visually validated). Felix wires them; he does
// not author them. The named presets map to GL-003 §6 tokens.
//
//   springSettle (§2.4 drop-settle): one soft ~5% overshoot, settled by 320ms.
//   easeFollow   (§2.3/2.5/2.6):     no-overshoot decelerate for layout moves.
//   springSnappy (§2.1 pick-up lift): handled by the DragOverlay scale/shadow CSS.
//
// prefers-reduced-motion (§6): the global index.css collapse already neutralises CSS
// transitions/animations. For the two JS-controlled values (the DragOverlay drop
// animation and the sortable transition string) we additionally branch on this hook
// so position is SET, not animated, under reduce — while keeping the 1:1 pointer
// follow (the mandated drag exception, §6 row 2.2).

import type { DropAnimation } from '@dnd-kit/core';

// §2.4 `springSettle` — MCP value (Vivi §5): 320ms, single ~5.4% overshoot.
export const SPRING_SETTLE =
  'linear(0, 0.5183, 0.9652, 1.0541, 1.0243, 1.0012, 0.9971, 0.9988, 1, 1)';

// §2.3/2.5/2.6 `easeFollow` — MCP value (Vivi §5): clean ease-out, no overshoot.
export const EASE_FOLLOW = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

// Live media-query read (no React subscription needed — drag interactions are
// transient; we read at the moment we build the style). SSR-safe guard.
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The dnd-kit dropAnimation. Full motion: 320ms springSettle (the "soft exhale").
// Reduced motion (§6 row 2.4): no spring/scale/straighten — the card appears in its
// resolved slot with a 100ms opacity fade (position set, not animated).
export function dropAnimationFor(reduced: boolean): DropAnimation {
  if (reduced) {
    return {
      duration: 100,
      easing: 'ease-out',
      // No scale/translate flourish; opacity-only settle.
    };
  }
  return {
    duration: 320,
    easing: SPRING_SETTLE,
  };
}
