import { useEffect, useState } from 'react';
import type { DashboardData } from './types';
import { verifyThenSignalAuthExpired } from './auth';

interface State {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
}

export function useDashboard(): State {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let alive = true;
    fetch('/api/dashboard', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) {
          // Background read — re-verify before tearing the app down (see auth.ts).
          void verifyThenSignalAuthExpired();
          throw new Error('Session check failed — please retry.');
        }
        if (!r.ok) throw new Error(`Server responded ${r.status}`);
        return r.json() as Promise<DashboardData>;
      })
      .then((data) => {
        if (alive) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (alive) setState({ data: null, loading: false, error: (err as Error).message });
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
