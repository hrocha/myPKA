// useCockpit.ts — generic read-only fetch hook for /api/cockpit/* endpoints.
import { useEffect, useState } from 'react';
import { verifyThenSignalAuthExpired } from './auth';

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// Fetches `url` and re-fetches whenever `url` changes. `url=null` is a no-op
// (used to skip a fetch until a dependency is ready).
export function useFetch<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: !!url, error: null });

  useEffect(() => {
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState({ data: null, loading: true, error: null });
    fetch(url, { credentials: 'same-origin' })
      .then((r) => {
        // A 401 on a BACKGROUND read is NOT proof the session is gone (a single
        // read can 401 spuriously while the session is still valid — the cause of
        // the "click a KE → whole app bounces to login" bug). Re-verify via the
        // status probe; only bounce to PIN if the session is genuinely gone.
        // Either way THIS read surfaces an inline error and never tears the app
        // down itself.
        if (r.status === 401) {
          void verifyThenSignalAuthExpired();
          throw new Error('Session check failed — please retry.');
        }
        if (!r.ok) throw new Error(`Server responded ${r.status}`);
        return r.json() as Promise<T>;
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
  }, [url]);

  return state;
}
