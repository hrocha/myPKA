// usePlannerSettings — work-hours / split / workdays state for the planner.
//
// Persistence is layered, graceful under the write gate:
//   1) The server is the source of truth (GET /api/planner/week → settings; PUT
//      /api/planner/settings to save). Passed in via `serverSettings`.
//   2) localStorage is the offline / write-disabled fallback (mirrors useCollapsed).
//      When PUT returns `disabled` (PLAN_WRITE_ENABLED unset) we keep the change
//      locally so the planner is fully usable before Vex clears the write path.
//
// Precedence on load: server settings (if present) override the local cache; else
// the local cache; else defaultSettings(). Every save writes localStorage first
// (so it survives a refresh regardless of the gate) THEN attempts the server PUT.

import { useCallback, useEffect, useState } from 'react';
import type { PlannerSettings } from './plannerTypes';
import { defaultSettings } from './plannerLogic';
import { saveSettings, type WriteOutcome } from './plannerApi';

const KEY = 'mypka-planner-settings-v1';

function readLocal(): PlannerSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PlannerSettings) : null;
  } catch {
    return null;
  }
}

function writeLocal(s: PlannerSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — in-memory only */
  }
}

// Guarantee a well-formed lunch_break on EVERY settings object the hook hands out.
// A localStorage cache written before Iris 14 (key 'mypka-planner-settings-v1')
// has no lunch_break, and a degraded GET could omit it — either would leave the
// gear form + band render reading `undefined.enabled`. Seed a disabled band from
// the split when the key is missing/malformed so the single-divider default holds.
function withLunchBreak(s: PlannerSettings): PlannerSettings {
  const lb = s.lunch_break;
  if (lb && typeof lb === 'object'
    && typeof lb.enabled === 'boolean'
    && typeof lb.start === 'string' && typeof lb.end === 'string') {
    return s;
  }
  return {
    ...s,
    lunch_break: { enabled: false, start: s.am_pm_split || '12:00', end: '13:00' },
  };
}

export interface UsePlannerSettings {
  settings: PlannerSettings;
  // Update + persist. Returns the write outcome so the caller can show the calm
  // "read-only until enabled" hint when the server write is dormant.
  update: (next: PlannerSettings) => Promise<WriteOutcome>;
  // True when the last save hit the disabled write gate (kept locally only).
  writeDisabled: boolean;
}

export function usePlannerSettings(serverSettings: PlannerSettings | null): UsePlannerSettings {
  const [settings, setSettings] = useState<PlannerSettings>(
    () => withLunchBreak(serverSettings ?? readLocal() ?? defaultSettings()),
  );
  const [writeDisabled, setWriteDisabled] = useState(false);

  // When the server settings arrive (after the week fetch resolves), adopt them as
  // the source of truth and refresh the local cache.
  useEffect(() => {
    if (serverSettings) {
      const normalized = withLunchBreak(serverSettings);
      setSettings(normalized);
      writeLocal(normalized);
    }
  }, [serverSettings]);

  const update = useCallback(async (next: PlannerSettings): Promise<WriteOutcome> => {
    setSettings(next);
    writeLocal(next); // local-first: survives refresh regardless of the write gate
    const outcome = await saveSettings({
      workdays: next.workdays,
      am_pm_split: next.am_pm_split,
      work_hours: next.work_hours,
      timezone: next.timezone,
      lunch_break: next.lunch_break,
      // Iris 20 §7 — mirror completions to the source tool when ON (default OFF).
      complete_on_source: next.complete_on_source ?? false,
    });
    setWriteDisabled(outcome.kind === 'disabled');
    return outcome;
  }, []);

  return { settings, update, writeDisabled };
}
