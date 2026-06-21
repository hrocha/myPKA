// AuthGate.tsx — wraps the whole app behind the PIN.
//
// Boot: probe /api/auth/status. 200 -> render children (the cockpit). 401 ->
// render <PinLogin/>. While probing, render a quiet splash (no flash of either
// state). After a successful login the gate re-renders into the app.
//
// Mid-session expiry: any data fetch that hits a 401 dispatches AUTH_EXPIRED_EVENT
// (see lib/auth.ts + lib/useCockpit.ts); the gate listens and drops back to login.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { checkAuth, AUTH_EXPIRED_EVENT } from '../lib/auth';
import { PinLogin } from './PinLogin';

type Status = 'checking' | 'authed' | 'unauthed';

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');

  const runCheck = useCallback(() => {
    let alive = true;
    checkAuth().then((ok) => {
      if (alive) setStatus(ok ? 'authed' : 'unauthed');
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => runCheck(), [runCheck]);

  // Drop to login if a session expires mid-use.
  useEffect(() => {
    const onExpired = () => setStatus('unauthed');
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  if (status === 'checking') {
    return (
      <div className="pin-screen" aria-busy="true">
        <div className="pin-splash" aria-hidden="true" />
      </div>
    );
  }

  if (status === 'unauthed') {
    return <PinLogin onAuthed={() => setStatus('authed')} />;
  }

  return <>{children}</>;
}
