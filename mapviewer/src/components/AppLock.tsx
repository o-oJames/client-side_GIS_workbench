import React, { useState, useEffect, useRef } from 'react';
import { LockIcon, EyeIcon, ResetKeyIcon } from './Icons';
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
  mode = 'lock',
}: {
  onCancel: () => void;
  onConfirm: (password: string) => void;
  /**
   * 'lock' - first-time lock flow: choosing a password locks the app right away.
   * 'set'  - password management (right-click the lock icon): store the password
   *          for future locks without locking the app immediately.
   */
  mode?: 'lock' | 'set';
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
            <h2 id="setpw-title" className="setpw-title">
              {mode === 'lock' ? 'Set a password to lock the app' : 'Set a password'}
            </h2>
            <p className="setpw-subtitle">
              {mode === 'lock'
                ? 'Your workspaces, layers and settings are encrypted on this device and hidden behind a lock screen until the password is entered.'
                : 'Choose the password you will use to lock this app. Your workspaces, layers and settings are encrypted with it whenever the app is locked.'}
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
            <LockIcon /> {mode === 'lock' ? 'Set password & lock' : 'Set password'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reset-password dialog, opened from the lock icon's right-click menu once a
 * password already exists. It verifies the current password first (the parent
 * rejects a wrong one with `WrongPasswordError`), then applies the new one.
 * The app stays unlocked throughout - the new password simply encrypts the
 * next lock.
 */
export function ResetPasswordDialog({
  onCancel,
  onReset,
}: {
  onCancel: () => void;
  /** Verify `currentPassword` and switch to `newPassword`. Reject with
   * `WrongPasswordError` when the current password does not match. */
  onReset: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every failed attempt so the shake animation replays.
  const [shakeKey, setShakeKey] = useState(0);

  const tooShort = next.length < 4;
  const mismatch = confirm !== next;
  const sameAsCurrent = next.length > 0 && next === current;
  const valid = current.length > 0 && !tooShort && !mismatch && !sameAsCurrent;
  const strength = passwordStrength(next);

  const clearError = () => { if (error) setError(null); };

  const submit = async () => {
    setTouched(true);
    if (!valid || checking) return;
    setChecking(true);
    setError(null);
    try {
      await onReset(current, next);
    } catch (err) {
      setChecking(false);
      if (err instanceof WrongPasswordError) {
        setError('Current password is incorrect.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not reset the password.');
      }
      setShakeKey((k) => k + 1);
    }
  };

  return (
    <div className="setpw-overlay" role="dialog" aria-modal="true" aria-labelledby="resetpw-title">
      <div className={`setpw-dialog${shakeKey > 0 ? ' resetpw-shake' : ''}`} key={shakeKey}>
        <div className="setpw-header">
          <span className="setpw-badge" aria-hidden="true"><ResetKeyIcon /></span>
          <div className="setpw-heading">
            <h2 id="resetpw-title" className="setpw-title">Reset your password</h2>
            <p className="setpw-subtitle">
              Confirm your current password, then choose a new one. The next
              time you lock the app it will be encrypted with the new password.
            </p>
          </div>
        </div>
        <div className="setpw-body">
          <label className="setpw-label" htmlFor="resetpw-current">Current password</label>
          <div className="setpw-field">
            <input
              id="resetpw-current"
              type={showPw ? 'text' : 'password'}
              value={current}
              autoFocus
              placeholder="Your current password"
              autoComplete="current-password"
              disabled={checking}
              onChange={(e) => { setCurrent(e.target.value); clearError(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
            <button
              type="button"
              className="setpw-eye"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? 'Hide passwords' : 'Show passwords'}
              title={showPw ? 'Hide passwords' : 'Show passwords'}
            >
              <EyeIcon visible={!showPw} />
            </button>
          </div>
          <label className="setpw-label" htmlFor="resetpw-new">New password</label>
          <div className="setpw-field">
            <input
              id="resetpw-new"
              type={showPw ? 'text' : 'password'}
              value={next}
              placeholder="At least 4 characters"
              autoComplete="new-password"
              disabled={checking}
              onChange={(e) => { setNext(e.target.value); clearError(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </div>
          {next.length > 0 && (
            <div className="setpw-strength" data-level={strength}>
              <span className="setpw-strength-bar"><span className="setpw-strength-fill" /></span>
              <span className="setpw-strength-label">{STRENGTH_LABELS[strength]}</span>
            </div>
          )}
          <label className="setpw-label" htmlFor="resetpw-confirm">Confirm new password</label>
          <div className="setpw-field">
            <input
              id="resetpw-confirm"
              type={showPw ? 'text' : 'password'}
              value={confirm}
              placeholder="Repeat the new password"
              autoComplete="new-password"
              disabled={checking}
              onChange={(e) => { setConfirm(e.target.value); clearError(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </div>
          {error && <p className="setpw-error" role="alert">{error}</p>}
          {!error && touched && tooShort && <p className="setpw-error">Use at least 4 characters.</p>}
          {!error && touched && !tooShort && mismatch && <p className="setpw-error">Passwords don’t match.</p>}
          {!error && touched && !tooShort && !mismatch && sameAsCurrent && (
            <p className="setpw-error">Choose a new password that is different from the current one.</p>
          )}
          <p className="setpw-note">
            Resetting only changes the password used the next time you lock -
            your already-saved workspaces, layers and settings are kept.
          </p>
        </div>
        <div className="setpw-actions">
          <button className="settings-button-secondary" onClick={onCancel} disabled={checking}>Cancel</button>
          <button className="setpw-confirm-button" onClick={() => void submit()} disabled={checking}>
            <ResetKeyIcon /> {checking ? 'Resetting…' : 'Reset password'}
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
