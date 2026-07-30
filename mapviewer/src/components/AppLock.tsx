import React, { useState, useEffect, useRef } from 'react';
import { LockIcon, EyeIcon } from './Icons';
import { WrongPasswordError } from '../utils/appLock';

/** Rough 0–4 strength score that drives the setup dialog's meter. */
export function passwordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 4) score++;
  if (pw.length >= 8) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

export const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

/**
 * First-lock dialog: the app has no password yet, so locking starts by
 * choosing one. The password is never stored — it only derives the key
 * that encrypts the storage vault.
 */
export function SetPasswordDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState(false);

  const tooShort = password.length < 4;
  const mismatch = confirm !== password;
  const valid = !tooShort && !mismatch;
  const strength = passwordStrength(password);

  const submit = () => {
    setTouched(true);
    if (valid) onConfirm(password);
  };

  return (
    <div className="setpw-overlay" role="dialog" aria-modal="true" aria-labelledby="setpw-title">
      <div className="setpw-dialog">
        <div className="setpw-header">
          <span className="setpw-badge" aria-hidden="true"><LockIcon /></span>
          <div className="setpw-heading">
            <h2 id="setpw-title" className="setpw-title">Set a password to lock the app</h2>
            <p className="setpw-subtitle">
              Your workspaces, layers and settings are encrypted on this device
              and hidden behind a lock screen until the password is entered.
            </p>
          </div>
        </div>
        <div className="setpw-body">
          <label className="setpw-label" htmlFor="setpw-password">Password</label>
          <div className="setpw-field">
            <input
              id="setpw-password"
              type={showPw ? 'text' : 'password'}
              value={password}
              autoFocus
              placeholder="At least 4 characters"
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
            <button
              type="button"
              className="setpw-eye"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              title={showPw ? 'Hide password' : 'Show password'}
            >
              <EyeIcon visible={!showPw} />
            </button>
          </div>
          {password.length > 0 && (
            <div className="setpw-strength" data-level={strength}>
              <span className="setpw-strength-bar"><span className="setpw-strength-fill" /></span>
              <span className="setpw-strength-label">{STRENGTH_LABELS[strength]}</span>
            </div>
          )}
          <label className="setpw-label" htmlFor="setpw-confirm">Confirm password</label>
          <div className="setpw-field">
            <input
              id="setpw-confirm"
              type={showPw ? 'text' : 'password'}
              value={confirm}
              placeholder="Repeat the password"
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          </div>
          {touched && tooShort && <p className="setpw-error">Use at least 4 characters.</p>}
          {touched && !tooShort && mismatch && <p className="setpw-error">Passwords don’t match.</p>}
          <p className="setpw-note">
            The password is never stored anywhere. If you forget it, the only
            recovery is “Start fresh” on the lock screen, which erases all data.
          </p>
        </div>
        <div className="setpw-actions">
          <button className="settings-button-secondary" onClick={onCancel}>Cancel</button>
          <button className="setpw-confirm-button" onClick={submit}>
            <LockIcon /> Set password &amp; lock
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen lock overlay. The live app stays mounted underneath a heavy
 * blur; the password card sits centred in the window. Unlocking decrypts
 * the storage vault back into localStorage. “Start fresh” wipes the vault
 * and every persisted setting for a clean slate.
 */
export function LockScreen({
  onUnlock,
  onStartFresh,
}: {
  onUnlock: (password: string) => Promise<void>;
  onStartFresh: () => void;
}) {
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every failed attempt so the shake animation replays.
  const [shakeKey, setShakeKey] = useState(0);
  const [capsLock, setCapsLock] = useState(false);
  const [confirmingFresh, setConfirmingFresh] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  // Re-focus (and select) the field after a failed attempt remounts the form.
  useEffect(() => {
    if (shakeKey > 0 && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [shakeKey]);

  const trackCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLock(e.getModifierState('CapsLock'));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checking || !password) return;
    setChecking(true);
    setError(null);
    try {
      await onUnlock(password);
    } catch (err) {
      setChecking(false);
      if (err instanceof WrongPasswordError) {
        setError('Incorrect password — try again.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not unlock the vault.');
      }
      setShakeKey((k) => k + 1);
    }
  };

  return (
    <div className="lock-overlay" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-card">
        <span className="lock-badge" aria-hidden="true"><LockIcon /></span>
        <h1 id="lock-title" className="lock-title">Map Viewer is locked</h1>
        <p className="lock-subtitle">
          Enter your password to restore your workspaces, layers and settings.
        </p>
        <form className="lock-form" onSubmit={submit} key={shakeKey} noValidate>
          <div className={`lock-field${error ? ' invalid' : ''}`}>
            <input
              ref={inputRef}
              type={showPw ? 'text' : 'password'}
              value={password}
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
              disabled={checking}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={trackCaps}
              onKeyUp={trackCaps}
            />
            <button
              type="button"
              className="lock-eye"
              tabIndex={-1}
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              title={showPw ? 'Hide password' : 'Show password'}
            >
              <EyeIcon visible={!showPw} />
            </button>
          </div>
          {capsLock && <p className="lock-hint">Caps Lock is on</p>}
          {error && <p className="lock-error" role="alert">{error}</p>}
          <button type="submit" className="lock-unlock-button" disabled={checking || !password}>
            {checking ? (
              <>
                <span className="lock-spinner" aria-hidden="true" />
                Unlocking…
              </>
            ) : (
              'Unlock'
            )}
          </button>
        </form>
        <div className="lock-footer">
          <span className="lock-footer-note">
            Your data never leaves this device — it is encrypted with your password.
          </span>
          {confirmingFresh ? (
            <span className="lock-fresh-confirm" role="group" aria-label="Start fresh confirmation">
              <span className="lock-fresh-confirm-text">Erase everything?</span>
              <button className="lock-fresh-yes" onClick={onStartFresh}>Yes, start fresh</button>
              <button className="lock-fresh-no" onClick={() => setConfirmingFresh(false)}>Cancel</button>
            </span>
          ) : (
            <button
              className="lock-fresh-link"
              onClick={() => setConfirmingFresh(true)}
              title="Erase all locked data and start over"
            >
              Start fresh
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
