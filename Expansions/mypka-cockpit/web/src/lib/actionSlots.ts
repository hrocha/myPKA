// actionSlots.ts — the per-source connection contract for the "Actions & Planning"
// hub. ICOR frames action-handling + planning as three sources; the cockpit
// surfaces each as a first-class CONNECTION SLOT.
//
// THE CONTRACT (this is the reusable part)
//   Every slot maps an ICOR source (PPM / BPM / Calendar) to an external tool
//   (Todoist / ClickUp / Google Calendar) and resolves to a `SlotState`:
//
//     { status: 'connected' }                      -> the slot renders its live data
//     { status: 'not-connected', hint }            -> calm placeholder box
//     { status: 'loading' }                        -> quiet skeleton
//     { status: 'error', message }                 -> calm "couldn't reach the server"
//
//   A slot is therefore a pure function of (definition, state). To bring a new
//   source online later you do exactly ONE thing: give it a `state` derived from
//   its own data source and a `renderConnected` body. No restructure — the hub,
//   the card chrome, the placeholder, the a11y, the layout all stay put.
//
//   PHASING (Tom-confirmed):
//     PPM  -> Todoist          -> CONNECTED today. State derives from the existing
//                                 /api/cockpit/tasks payload (ok:true === connected).
//     BPM  -> ClickUp          -> not-connected. Next phase: ClickUp API token
//                                 (server-side, mirrors todoist.js). Flip to connected
//                                 by deriving state from a /api/cockpit/clickup read.
//     Cal  -> Google Calendar  -> not-connected. Hosted phase: Google OAuth (Mack).
//                                 Flip by deriving state from /api/cockpit/calendar.

export type SourceKey = 'ppm' | 'bpm' | 'calendar';

// The discriminated connection state. `connected` is the only state that renders
// the source's own data; every other state renders shared, calm chrome.
export type SlotState =
  | { status: 'connected' }
  | { status: 'not-connected'; hint: string }
  | { status: 'loading' }
  | { status: 'error'; message: string };

// Static, source-of-truth metadata for each slot. The label + tool + the EXACT
// placeholder string Tom specified ("No PPM Connected" etc.) live here so the
// three slots read uniformly and a new source is registered by adding one entry.
export interface SlotDefinition {
  key: SourceKey;
  // ICOR source name shown as the slot title (PPM / BPM / Calendar).
  source: string;
  // What ICOR concern this slot covers — the one-line frame under the title.
  frame: string;
  // The external tool this source maps to (Todoist / ClickUp / Google Calendar).
  tool: string;
  // Tom's exact not-connected heading. Uniform across all three.
  notConnectedTitle: string;
  // The calm connect hint shown under the heading in the not-connected state.
  connectHint: string;
}

// The three ICOR action+planning sources, in the order they read at a glance:
// personal actions, then business actions, then time/planning.
export const SLOT_DEFS: readonly SlotDefinition[] = [
  {
    key: 'ppm',
    source: 'PPM',
    frame: 'Personal actions',
    tool: 'Todoist',
    notConnectedTitle: 'No PPM Connected',
    connectHint: 'Connect Todoist to bring your personal actions in.',
  },
  {
    key: 'bpm',
    source: 'BPM',
    frame: 'Business actions',
    tool: 'ClickUp',
    notConnectedTitle: 'No BPM Connected',
    connectHint: 'Connect ClickUp to bring business actions in.',
  },
  {
    key: 'calendar',
    source: 'Calendar',
    frame: 'Planning & time',
    tool: 'Google Calendar',
    notConnectedTitle: 'No Calendar Connected',
    connectHint: 'Connect Google Calendar to bring your schedule in.',
  },
] as const;
