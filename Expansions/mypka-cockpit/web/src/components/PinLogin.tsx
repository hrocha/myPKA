// PinLogin.tsx — the PIN entry screen shown when the cockpit is unauthorized.
//
// Appears on boot when the session probe returns 401, and again if a session
// expires mid-use. On success it calls onAuthed() and the gate renders the app.
//
// Design: GL-003 tokens only (no hardcoded hex / px-as-design-value). Mobile-first
// — Tom uses this on his phone, so large tap targets (≥44px), a numeric keypad
// (inputMode="numeric"), and a layout that holds at 375px. Accessible: labelled
// input, autofocus, aria-live error region, Enter submits, busy state announced.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Lock, LoaderCircle } from 'lucide-react';
import { login, type LoginResult } from '../lib/auth';
import { MIN_PIN_LENGTH } from '../lib/authConstants';
import { S } from '../lib/strings';

interface Props {
  onAuthed: () => void;
}

function messageFor(result: Extract<LoginResult, { ok: false }>): string {
  switch (result.kind) {
    case 'locked': {
      const mins = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
      return S.pin.errLocked(mins);
    }
    case 'no-pin':
      return S.pin.errNoPin;
    case 'network':
      return S.pin.errNetwork;
    case 'invalid':
    default:
      return S.pin.errInvalid;
  }
}

export function PinLogin({ onAuthed }: Props) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const tooShort = pin.length < MIN_PIN_LENGTH;
  const disabled = busy || locked;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (disabled || tooShort) return;
    setBusy(true);
    setError(null);
    const result = await login(pin);
    if (result.ok) {
      onAuthed();
      return; // unmounts; no state update needed
    }
    setBusy(false);
    setPin('');
    setError(messageFor(result));
    if (result.kind === 'locked') setLocked(true);
    inputRef.current?.focus();
  }

  return (
    <div className="pin-screen">
      <form className="pin-card" onSubmit={submit} aria-labelledby="pin-title">
        <div className="pin-mark" aria-hidden="true">
          <Lock size={22} strokeWidth={1.5} />
        </div>
        <h1 id="pin-title" className="pin-title">myPKA Cockpit</h1>
        <p className="pin-sub">{S.pin.subtitle}</p>

        <label className="pin-field-label" htmlFor="pin-input">{S.pin.fieldLabel}</label>
        <input
          id="pin-input"
          ref={inputRef}
          className="pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          value={pin}
          disabled={disabled}
          onChange={(e) => {
            // Digits only; the server enforces the same, this keeps the field clean.
            setPin(e.target.value.replace(/\D/g, ''));
            if (error) setError(null);
          }}
          aria-describedby={error ? 'pin-error' : undefined}
          aria-invalid={error ? true : undefined}
        />

        <button type="submit" className="pin-submit" disabled={disabled || tooShort}>
          {busy ? (
            <>
              <LoaderCircle size={18} strokeWidth={2} className="pin-spin" aria-hidden="true" />
              <span>{S.pin.checking}</span>
            </>
          ) : (
            <span>{S.pin.unlock}</span>
          )}
        </button>

        {/* aria-live so a screen reader announces the error / lockout as it appears. */}
        <p id="pin-error" className="pin-error" role="status" aria-live="polite">
          {error ?? ' '}
        </p>
      </form>

      <p className="pin-foot">
        {S.pin.footer}
      </p>
    </div>
  );
}
