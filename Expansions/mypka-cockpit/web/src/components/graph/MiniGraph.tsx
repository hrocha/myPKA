// MiniGraph.tsx — the per-note knowledge-graph mini-graph (GL-003 §8.9, Flow SPEC).
//
// This is the EAGER, lightweight wrapper NoteView imports. It owns the section
// chrome (heading + fallback note + fullscreen toggle) and the React.lazy boundary
// that keeps React Flow + d3-force OUT of the note-view critical bundle. The heavy
// canvas (MiniGraphCanvas) loads only when this section mounts.
//
// Data: GET /api/cockpit/graph/neighborhood/:type/:slug (live, PIN-gated, read-only).
// The route returns the success shape { focus, nodes, edges, stats } OR { found:false }.
//
// "+N more" expand: the server caps Gen-2 grandchildren per hub at `cap` (default
// 12). Expanding a hub re-fetches the neighbourhood at a higher cap so the hidden
// grandchildren appear in place, then the canvas re-lays-out + fitViews (§8.9.5).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Share2 } from 'lucide-react';
import { useFetch } from '../../lib/useCockpit';
import type { GraphResponse, GraphNeighborhood } from '../../lib/cockpitTypes';

// Lazy chunk — React Flow + d3-force + the canvas CSS live behind this boundary.
const MiniGraphCanvas = lazy(() => import('./MiniGraphCanvas'));

// When the user expands any hub, we re-request at this higher cap. One bump covers
// the realistic hub case (the 50 server clamp is the ceiling); a hub with >50 hidden
// grandchildren is vanishingly rare and still reads as "+N more" beyond the bump.
const EXPANDED_CAP = 50;
const DEFAULT_CAP = 12;

function isFound(r: GraphResponse | null): r is GraphNeighborhood {
  return !!r && 'focus' in r;
}

export interface MiniGraphProps {
  focusType: string;
  slug: string;
}

export function MiniGraph({ focusType, slug }: MiniGraphProps) {
  // Track which hubs the user expanded. Any expansion bumps the fetch cap so the
  // server returns the previously-hidden grandchildren.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [fullscreen, setFullscreen] = useState(false);

  const cap = expanded.size > 0 ? EXPANDED_CAP : DEFAULT_CAP;
  const url = `/api/cockpit/graph/neighborhood/${encodeURIComponent(focusType)}/${encodeURIComponent(
    slug,
  )}?depth=2&cap=${cap}`;
  const { data, loading, error } = useFetch<GraphResponse>(url);

  const neighborhood = isFound(data) ? data : null;
  // After a cap bump the server may still report `capped` for hubs with >cap
  // grandchildren; keep showing "+N more" for hubs the user hasn't expanded. For
  // expanded hubs whose overflow is now gone, the canvas simply won't render one.
  const stillCapped = useMemo(() => {
    if (!neighborhood) return new Set<string>();
    return new Set(Object.keys(neighborhood.stats.capped));
  }, [neighborhood]);

  // The set of hub ids the canvas should treat as "already expanded" (hide the
  // overflow node): user-expanded hubs that the server no longer reports as capped.
  const canvasExpanded = useMemo(() => {
    const s = new Set<string>();
    for (const id of expanded) if (!stillCapped.has(id)) s.add(id);
    return s;
  }, [expanded, stillCapped]);

  const onExpand = (hubId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(hubId);
      return next;
    });
  };

  // ---- Fullscreen dialog a11y (Vera residual #5) ----------------------------
  // role="dialog" aria-modal needs: focus moved IN on open, a focus trap, Escape
  // to close, and focus restored to the trigger on close. We also pass data-closing
  // to the overlay for the §2.5 springClose, then unmount after the 350ms exit.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [closing, setClosing] = useState(false);

  const closeFullscreen = useCallback(() => {
    const motionOk =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setClosing(true);
    const exit = motionOk ? 350 : 100; // §2.5 springClose / RM fade
    window.setTimeout(() => {
      setFullscreen(false);
      setClosing(false);
    }, exit);
  }, []);

  // Body scroll-lock while the fullscreen dialog is open (mirrors the app's
  // `body.overlay-open` Sheet/Dialog convention, index.css). Without this the page
  // behind the fixed overlay stays scrollable, so a wheel event that lands on the bar
  // — or that React Flow's pane chooses not to consume — bubbles to the document and
  // scrolls the page under the modal. Restored on close/unmount. Separate effect from
  // the focus-trap so the lock toggles on the `fullscreen` flip (open) and the cleanup
  // runs on close, independent of the trap's keydown wiring.
  useEffect(() => {
    if (!fullscreen) return;
    document.body.classList.add('overlay-open');
    return () => {
      document.body.classList.remove('overlay-open');
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Move focus into the dialog (its close button if present, else the dialog).
    const focusables = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"]), .react-flow__node',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
    const first = focusables()[0] ?? dialog;
    first.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFullscreen();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: wrap Tab / Shift+Tab at the dialog edges.
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      } else if (!dialog.contains(active)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to the trigger when the dialog unmounts.
      triggerRef.current?.focus();
    };
  }, [fullscreen, closeFullscreen]);

  // Empty neighbourhood (a brand-new note with no links yet) — render nothing rather
  // than an empty canvas. The note still has its text "What links here" / "Links to"
  // rail cards as the full record; the graph is an enhancement, not the source.
  const isEmpty = neighborhood && neighborhood.nodes.length <= 1 && neighborhood.edges.length === 0;

  if (error || (data && !isFound(data)) || isEmpty) {
    return null;
  }

  const openControl = neighborhood && (
    <div className="mg-header-controls">
      <button
        type="button"
        className="mg-control"
        onClick={() => setFullscreen(true)}
        aria-label="Open graph fullscreen"
        title="Fullscreen"
      >
        <Maximize2 size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <section className="mg-section" aria-label="Knowledge graph">
      <div className="mg-header">
        <h2 className="mg-title">
          <Share2 size={15} strokeWidth={1.5} aria-hidden="true" /> Knowledge graph
        </h2>
        {!fullscreen && openControl}
      </div>

      {loading && !neighborhood ? (
        <div className="mg-canvas mg-canvas--loading" aria-busy="true">
          <span className="mg-loading-note">Loading neighbourhood…</span>
        </div>
      ) : neighborhood ? (
        <>
          {/* Inline canvas. UNMOUNTED while fullscreen is open (Vera L2 — never run
              two d3-force sims on a 161-node hub at once). A lightweight placeholder
              holds the layout height so the page doesn't jump. */}
          {fullscreen ? (
            <div className="mg-canvas mg-canvas--loading" aria-hidden="true">
              <span className="mg-loading-note">Graph open in fullscreen</span>
            </div>
          ) : (
            <div className="mg-canvas">
              <Suspense fallback={<div className="mg-canvas-fallback" aria-busy="true" />}>
                <MiniGraphCanvas data={neighborhood} expanded={canvasExpanded} onExpand={onExpand} />
              </Suspense>
            </div>
          )}

          {/* Portal to <body>: the note-view ancestor carries `animate-fade-rise`
              (fill-mode `both`), whose final keyframe leaves a residual
              `transform: translateY(0)` on .note-view. A transformed ancestor becomes
              the containing block for `position: fixed`, so an in-tree overlay would
              resolve `inset:0` against the ~980px reading column (sidebar still shown,
              dead space L/R). Portaling out of that subtree lets `position: fixed;
              inset: 0` resolve against the VIEWPORT — true edge-to-edge fullscreen over
              the sidebar. Matches the codebase dialog convention (SettingsSheet,
              CardDetailModal, RejectReasonModal all createPortal to body). */}
          {fullscreen &&
            createPortal(
              <div
                ref={dialogRef}
                className="mg-fullscreen"
                data-closing={closing ? 'true' : undefined}
                role="dialog"
                aria-modal="true"
                aria-label="Knowledge graph, fullscreen"
              >
                <div className="mg-fullscreen-bar">
                  <h2 className="mg-title">
                    <Share2 size={15} strokeWidth={1.5} aria-hidden="true" /> {neighborhood.focus.title}
                  </h2>
                  <div className="mg-header-controls">
                    <button
                      type="button"
                      className="mg-control"
                      onClick={closeFullscreen}
                      aria-label="Exit fullscreen graph"
                      title="Exit fullscreen"
                    >
                      <Minimize2 size={16} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="mg-fullscreen-canvas">
                  <Suspense fallback={<div className="mg-canvas-fallback" aria-busy="true" />}>
                    <MiniGraphCanvas
                      data={neighborhood}
                      expanded={canvasExpanded}
                      onExpand={onExpand}
                    />
                  </Suspense>
                </div>
              </div>,
              document.body,
            )}
        </>
      ) : null}
    </section>
  );
}
