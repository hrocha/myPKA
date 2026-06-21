// useCollapsed — per-section open/closed state, persisted to localStorage so the
// dashboard remembers what Tom collapsed between reloads. Defaults to open.
import { useCallback, useState } from 'react';

const KEY = 'mypka-dash-collapsed-v1';

function readStore(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeStore(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode) — degrade to in-memory only */
  }
}

export function useCollapsed(id: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    const store = readStore();
    return id in store ? store[id] : defaultOpen;
  });

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      const store = readStore();
      store[id] = next;
      writeStore(store);
      return next;
    });
  }, [id]);

  return [open, toggle];
}
