// SettingsView.tsx — runtime cockpit settings (Hub-module toggles + reorder).
//
// Two independent controls per module:
//   1. A real <button role="switch" aria-checked> — show/hide the section on the
//      Hub (Space/Enter, screen-reader-announced, focus-ringed).
//   2. Up/Down move buttons — reorder where the section sits on the Hub. The Hub
//      renders modules in this saved order. Reordering never changes visibility,
//      and toggling never changes order — the two write paths are independent.
//
// State persists to mypka-cockpit.db (module_prefs table) through GET/PUT
// /api/cockpit/settings — the SAME local-write pattern as the planner's settings,
// so it survives a mypka.db regen and never touches canonical markdown. Default:
// everything ON, catalogue order.
//
// ACCESSIBILITY: reorder is keyboard-first. Each move button is a real <button>
// (Tab to reach, Space/Enter to activate), labelled with where it moves the
// module ("Move Open Invoices up"), and disabled at the list ends (aria-disabled
// via the native `disabled` attr). After a move, focus follows the moved row's
// button so a keyboard user can move the same item again without re-Tabbing.
// An aria-live region announces the new position. No drag is required.
import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Check, ChevronUp, ChevronDown, Sun, Moon, Monitor } from 'lucide-react';
import { useFetch } from '../lib/useCockpit';
import {
  saveModulePrefs,
  saveModuleOrder,
  type CockpitSettingsResponse,
  type ModuleCatalogueEntry,
} from '../lib/cockpitExtras';
import { useTheme, type ThemePref } from '../lib/theme';
import { PageHeader } from '../components/PageHeader';
import './settings.css';

export function SettingsView() {
  const { data, loading, error } = useFetch<CockpitSettingsResponse>('/api/cockpit/settings');
  // Theme is a client-only presentation preference (localStorage; applied pre-paint
  // by the index.html bootstrap). The hook here drives the switch + keeps the live
  // System listener owned at the shell level (App.tsx) in sync.
  const { pref: themePref, resolved: themeResolved, setPref: setThemePref } = useTheme();

  // Local working copies, seeded from the fetch and updated optimistically.
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveMsg, setLiveMsg] = useState<string>('');

  // Refs to each row's up button so we can move focus to the row after a move.
  const moveBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // After a move, the key whose move-button should regain focus once re-rendered.
  const refocusKey = useRef<string | null>(null);
  const refocusDir = useRef<'up' | 'down'>('up');

  useEffect(() => {
    if (data?.modules) setModules(data.modules);
    if (data?.order) setOrder(data.order);
  }, [data]);

  // Move focus back to the moved row's button after the reorder re-renders.
  useEffect(() => {
    if (!refocusKey.current) return;
    const btn = moveBtnRefs.current[`${refocusKey.current}:${refocusDir.current}`];
    if (btn && !btn.disabled) {
      btn.focus();
    } else {
      // Button became disabled (moved to an end) — focus the opposite control.
      const alt = moveBtnRefs.current[`${refocusKey.current}:${refocusDir.current === 'up' ? 'down' : 'up'}`];
      alt?.focus();
    }
    refocusKey.current = null;
  }, [order]);

  // Build the rendered rows: catalogue entries indexed by key, ordered by `order`.
  // Guarded — when the settings fetch is still loading or failed, `data` is null
  // and the Hub-modules section renders its own loading/error state; the Theme
  // section (client-only) is unaffected and always available.
  const byKey = new Map<string, ModuleCatalogueEntry>((data?.catalogue ?? []).map((m) => [m.key, m]));
  const rows = order
    .map((key) => byKey.get(key))
    .filter((m): m is ModuleCatalogueEntry => m != null);

  const themeOptions: { value: ThemePref; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ];

  function surfaceSaveError(kind: string, message?: string) {
    setSaveState('error');
    setSaveError(
      kind === 'disabled'
        ? 'Saving settings is disabled on this server.'
        : kind === 'auth'
          ? 'Your session expired — reload and try again.'
          : kind === 'error' && message
            ? message
            : 'Could not save that change.',
    );
  }

  async function toggle(key: string) {
    const next = { ...modules, [key]: !modules[key] };
    setModules(next); // optimistic
    setSaveState('saving');
    setSaveError(null);
    const result = await saveModulePrefs({ [key]: next[key] });
    if (result.kind === 'ok') {
      setModules(result.data.modules); // authoritative server map
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1600);
    } else {
      setModules((m) => ({ ...m, [key]: !next[key] })); // revert
      surfaceSaveError(result.kind, result.kind === 'error' ? result.message : undefined);
    }
  }

  async function move(key: string, dir: 'up' | 'down') {
    const i = order.indexOf(key);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return; // at an end — no-op

    const prev = order;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]]; // swap with neighbour
    setOrder(next); // optimistic
    refocusKey.current = key; // keep focus on the moved row after re-render
    refocusDir.current = dir;

    const label = byKey.get(key)?.label ?? key;
    setLiveMsg(`${label} moved ${dir} — now position ${j + 1} of ${next.length}.`);
    setSaveState('saving');
    setSaveError(null);

    const result = await saveModuleOrder(next);
    if (result.kind === 'ok') {
      setOrder(result.data.order); // authoritative server order
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1600);
    } else {
      setOrder(prev); // revert
      surfaceSaveError(result.kind, result.kind === 'error' ? result.message : undefined);
    }
  }

  return (
    <div className="settings">
      <PageHeader
        title="Settings"
        icon={SlidersHorizontal}
        subtitle="Appearance and Hub layout — saved on this machine only. Changes apply instantly, no rebuild."
      />

      {/* ---- Appearance: Light / Dark / System theme ------------------------- */}
      <section className="settings-section" aria-labelledby="settings-appearance">
        <h2 className="settings-section-title" id="settings-appearance">Appearance</h2>
        <div className="settings-row settings-row--theme">
          <div className="settings-row-text">
            <span className="settings-row-label">Theme</span>
            <span className="settings-row-hint">
              {themePref === 'system'
                ? `Follows your system — currently ${themeResolved}.`
                : `Always ${themePref}.`}
            </span>
          </div>
          <div
            className="theme-segmented"
            role="radiogroup"
            aria-label="Theme"
          >
            {themeOptions.map((opt) => {
              const Icon = opt.icon;
              const active = themePref === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className="theme-option"
                  data-active={active}
                  onClick={() => setThemePref(opt.value)}
                >
                  <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {loading && (
        <div className="list-skeleton" aria-busy="true"><div className="skeleton-block" /></div>
      )}
      {(error || !data) && !loading && (
        <p className="view-error">Hub settings could not load. {error || ''}</p>
      )}

      {data && (
      <section className="settings-section" aria-labelledby="settings-hub-modules">
        <h2 className="settings-section-title" id="settings-hub-modules">Hub modules</h2>
        <ol className="settings-list">
          {rows.map((m, idx) => {
            const enabled = modules[m.key] ?? true;
            const isFirst = idx === 0;
            const isLast = idx === rows.length - 1;
            return (
              <li className="settings-row" key={m.key}>
                <div className="settings-reorder" role="group" aria-label={`Reorder ${m.label}`}>
                  <button
                    type="button"
                    className="settings-move"
                    ref={(el) => { moveBtnRefs.current[`${m.key}:up`] = el; }}
                    onClick={() => move(m.key, 'up')}
                    disabled={isFirst}
                    aria-label={`Move ${m.label} up`}
                  >
                    <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-move"
                    ref={(el) => { moveBtnRefs.current[`${m.key}:down`] = el; }}
                    onClick={() => move(m.key, 'down')}
                    disabled={isLast}
                    aria-label={`Move ${m.label} down`}
                  >
                    <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
                <div className="settings-row-text">
                  <span className="settings-row-label">{m.label}</span>
                  <span className="settings-row-hint">{m.hint}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${m.label}: ${enabled ? 'shown on the Hub' : 'hidden from the Hub'}`}
                  className="settings-switch"
                  data-on={enabled}
                  onClick={() => toggle(m.key)}
                >
                  <span className="settings-switch-track" aria-hidden="true">
                    <span className="settings-switch-thumb" />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="settings-status" role="status" aria-live="polite">
          {saveState === 'saving' && <span className="settings-status-saving">Saving…</span>}
          {saveState === 'saved' && (
            <span className="settings-status-saved">
              <Check size={14} strokeWidth={2} aria-hidden="true" /> Saved
            </span>
          )}
          {saveState === 'error' && saveError && (
            <span className="settings-status-error">{saveError}</span>
          )}
        </div>

        {/* Dedicated reorder announcer — separate from the save status so a move
            announcement isn't clobbered by "Saving…/Saved". */}
        <div className="sr-only" role="status" aria-live="polite">{liveMsg}</div>
      </section>
      )}
    </div>
  );
}
