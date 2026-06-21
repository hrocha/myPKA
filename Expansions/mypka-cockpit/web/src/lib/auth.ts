// auth.ts — client-side auth helpers for the PIN gate.
//
// The cockpit is gated behind a PIN when reached over the LAN. This module owns
// the three calls the AuthGate needs: a boot status probe, the login POST, and a
// logout POST. It also exposes a tiny event so any fetch in the app that receives
// a 401 mid-session can ask the gate to drop back to the login screen.

export type LoginResult =
  | { ok: true }
  | { ok: false; kind: 'invalid' }
  | { ok: false; kind: 'locked'; retryAfterSeconds: number }
  | { ok: false; kind: 'no-pin' }
  | { ok: false; kind: 'network' };

// Boot probe: is the current session valid? 200 -> yes, 401 -> show login.
export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    return res.ok;
  } catch {
    // Network error on boot — treat as "not authed" so the user sees the login
    // screen rather than a blank app; a successful login then proves reachability.
    return false;
  }
}

export async function login(pin: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pin }),
    });
  } catch {
    return { ok: false, kind: 'network' };
  }

  if (res.ok) return { ok: true };

  if (res.status === 429) {
    let retryAfterSeconds = 15 * 60;
    try {
      const body = (await res.json()) as { retryAfterSeconds?: number };
      if (typeof body.retryAfterSeconds === 'number') retryAfterSeconds = body.retryAfterSeconds;
    } catch {
      /* fall back to the 15-min default */
    }
    return { ok: false, kind: 'locked', retryAfterSeconds };
  }

  if (res.status === 503) return { ok: false, kind: 'no-pin' };

  return { ok: false, kind: 'invalid' };
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* best effort — the gate drops to login regardless */
  }
}

// A session can expire mid-use (12h TTL) or be cleared server-side on restart.
// When a data fetch sees a 401, the gate may need to drop back to the login
// screen so the user re-PINs instead of staring at a silently-empty dashboard.
export const AUTH_EXPIRED_EVENT = 'cockpit:auth-expired';

// Force the gate to the login screen RIGHT NOW. Reserved for user-initiated
// mutations (send chat, patch a task, planner write) whose 401 is unambiguous:
// the user just acted, the action was rejected for auth, so re-PIN immediately.
export function signalAuthExpired(): void {
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

// Re-verify BEFORE tearing the app down. A background READ fetch (the My Life
// graph's lazy members fetch, the dashboard poll, the roster load) that returns
// 401 is NOT proof the session is gone — a single read can 401 spuriously (a
// race against a brief server blip, a stale proxy, a transient hiccup) while the
// session is still perfectly valid. Hard-bouncing to PIN on that single signal
// is the bug behind "click a Key Element → whole app drops to login": the
// members read 401'd once and nuked the session instead of degrading inline.
//
// So: confirm with the cheap /api/auth/status probe. Only if THAT also says the
// session is gone do we dispatch the expiry event. If status says we're still
// authed, we stay put and the caller surfaces an inline error — no teardown.
// Returns true iff the session was confirmed gone (and the event dispatched).
export async function verifyThenSignalAuthExpired(): Promise<boolean> {
  const stillAuthed = await checkAuth();
  if (stillAuthed) return false; // false alarm — keep the session, degrade inline
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  return true;
}
