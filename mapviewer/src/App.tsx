import './App.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { WorkspaceRegistry } from './types';
import {
  loadWorkspaceRegistry,
  saveWorkspaceRegistry,
  generateWorkspaceId,
  copyWorkspaceStorage,
  deleteWorkspaceStorage,
} from './utils/workspaceStorage';
import {
  hasLockedVault,
  collectAppStorage,
  encryptAppData,
  decryptAppData,
  readVault,
  restoreAppStorage,
  writeVault,
  clearAppStorage,
  WrongPasswordError,
} from './utils/appLock';
import { MapPage } from './components/MapPage';
import { LockScreen, SetPasswordDialog, ResetPasswordDialog } from './components/AppLock';

// Re-exports for test compatibility — tests import these from './App'
export { SettingsDialog } from './components/SettingsDialog';
export { WorkspaceSelector } from './components/WorkspaceSelector';
export { LockScreen, SetPasswordDialog, ResetPasswordDialog } from './components/AppLock';
export { toggleGroupLayerVisibility } from './components/LayerPanel';
export { saveDrawSession, loadDrawSession } from './utils/drawHelpers';
export { DEFAULT_WORKSPACE_ID } from './constants';

/** Strip lat/lng/z query params so an incoming workspace restores its own
 * saved view instead of inheriting the outgoing one from the URL. */
function clearViewQueryParams() {
  if (window.location.search) {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

function App() {
  const [registry, setRegistry] = useState<WorkspaceRegistry>(() => loadWorkspaceRegistry());
  // Locked when an encrypted vault is present (e.g. the page reloaded while
  // locked); the map renders underneath a heavy blur until the correct
  // password decrypts the storage back into place.
  const [lockState, setLockState] = useState<'locked' | 'unlocked'>(() =>
    hasLockedVault() ? 'locked' : 'unlocked'
  );
  // Which password dialog is open (null = none). 'lock' = first-time lock
  // flow (set + lock); 'set' = right-click "Set Password" (set only, no lock).
  const [setPasswordMode, setSetPasswordMode] = useState<'lock' | 'set' | null>(null);
  const [showResetPassword, setShowResetPassword] = useState(false);
  // Reactive mirror of "a lock password exists this session" so the Settings
  // footer menu can label itself "Reset Password" vs "Set Password".
  const [hasLockPassword, setHasLockPassword] = useState(() => hasLockedVault());
  // Bumped after unlocking so MapPage remounts and reloads restored storage.
  const [unlockEpoch, setUnlockEpoch] = useState(0);
  // The lock password lives only in memory for this session, so re-locking
  // from the Settings footer never asks for it again.
  const lockPasswordRef = useRef<string | null>(null);
  const appRootRef = useRef<HTMLDivElement>(null);

  /** Encrypt every persisted app key into the vault and engage the lock. */
  const engageLock = useCallback(async (password: string) => {
    const entries = collectAppStorage();
    const vault = await encryptAppData(entries, password);
    // Write the vault first, then strip the plaintext keys around it, so a
    // crash in between can never leave unencrypted data behind.
    writeVault(vault);
    clearAppStorage(true);
    lockPasswordRef.current = password;
    setHasLockPassword(true);
    setSetPasswordMode(null);
    setLockState('locked');
  }, []);

  /** Settings-footer lock icon: reuse the session password or ask for one. */
  const handleLockRequest = useCallback(() => {
    if (lockPasswordRef.current) {
      // Password already established this session: lock immediately, no prompt.
      void engageLock(lockPasswordRef.current);
    } else {
      // First lock: choose a password, then lock.
      setSetPasswordMode('lock');
    }
  }, [engageLock]);

  /** Right-click "Set Password": store a password for future locks without
   * locking the app right now. */
  const handleSetPasswordOnly = useCallback((password: string) => {
    lockPasswordRef.current = password;
    setHasLockPassword(true);
    setSetPasswordMode(null);
  }, []);

  /** Right-click "Reset Password": verify the current password, then switch to
   * the new one. If a vault happens to be present it is re-encrypted in place. */
  const handleResetPassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (lockPasswordRef.current === null || lockPasswordRef.current !== currentPassword) {
      throw new WrongPasswordError();
    }
    const vault = readVault();
    if (vault !== null) {
      const entries = await decryptAppData(vault, currentPassword);
      writeVault(await encryptAppData(entries, newPassword));
    }
    lockPasswordRef.current = newPassword;
    setHasLockPassword(true);
    setShowResetPassword(false);
  }, []);

  /** Lock-screen submit: decrypt the vault back into localStorage. */
  const handleUnlock = useCallback(async (password: string) => {
    const vault = readVault();
    if (vault === null) {
      // Vault vanished (storage cleared elsewhere) - boot straight in.
      setLockState('unlocked');
      return;
    }
    const entries = await decryptAppData(vault, password); // throws on a wrong password
    clearAppStorage();
    restoreAppStorage(entries);
    lockPasswordRef.current = password;
    setHasLockPassword(true);
    setRegistry(loadWorkspaceRegistry());
    setUnlockEpoch((epoch) => epoch + 1);
    setLockState('unlocked');
  }, []);

  /** "Start fresh": wipe the vault plus every persisted key and reboot. */
  const handleStartFresh = useCallback(() => {
    clearAppStorage();
    lockPasswordRef.current = null;
    setHasLockPassword(false);
    window.location.reload();
  }, []);

  // While locked, the blurred app underneath must not be operable.
  useEffect(() => {
    const root = appRootRef.current;
    if (!root) return;
    if (lockState === 'locked') {
      root.setAttribute('inert', '');
      root.setAttribute('aria-hidden', 'true');
    } else {
      root.removeAttribute('inert');
      root.removeAttribute('aria-hidden');
    }
  }, [lockState]);

  const updateRegistry = useCallback((next: WorkspaceRegistry) => {
    setRegistry(next);
    saveWorkspaceRegistry(next);
  }, []);

  const handleSwitchWorkspace = useCallback((id: string) => {
    if (registry.activeId === id || !registry.workspaces.some(w => w.id === id)) return;
    clearViewQueryParams();
    updateRegistry({ ...registry, activeId: id });
  }, [registry, updateRegistry]);

  const handleCreateWorkspace = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = generateWorkspaceId();
    clearViewQueryParams();
    // The fresh workspace starts from the app defaults: loadSettings()
    // returns them when no storage exists yet for the new id.
    updateRegistry({ workspaces: [...registry.workspaces, { id, name: trimmed }], activeId: id });
  }, [registry, updateRegistry]);

  const handleRenameWorkspace = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateRegistry({
      ...registry,
      workspaces: registry.workspaces.map(w => (w.id === id ? { ...w, name: trimmed } : w)),
    });
  }, [registry, updateRegistry]);

  const handleDuplicateWorkspace = useCallback((id: string) => {
    const source = registry.workspaces.find(w => w.id === id);
    if (!source) return;
    const newId = generateWorkspaceId();
    copyWorkspaceStorage(id, newId);
    const baseName = source.name.replace(/ copy( \d+)?$/, '');
    const takenNames = new Set(registry.workspaces.map(w => w.name));
    let name = `${baseName} copy`;
    let n = 2;
    while (takenNames.has(name)) {
      name = `${baseName} copy ${n++}`;
    }
    clearViewQueryParams();
    updateRegistry({ workspaces: [...registry.workspaces, { id: newId, name }], activeId: newId });
  }, [registry, updateRegistry]);

  const handleDeleteWorkspace = useCallback((id: string) => {
    if (registry.workspaces.length <= 1) return; // never delete the last workspace
    deleteWorkspaceStorage(id);
    const remaining = registry.workspaces.filter(w => w.id !== id);
    const activeId = registry.activeId === id ? remaining[0].id : registry.activeId;
    if (registry.activeId === id) clearViewQueryParams();
    updateRegistry({ workspaces: remaining, activeId });
  }, [registry, updateRegistry]);

  return (
    <>
      <div className="app-root" ref={appRootRef}>
        <Routes>
          <Route
            path="/map"
            element={
              <MapPage
                key={`${registry.activeId}:${unlockEpoch}`}
                workspaceId={registry.activeId}
                workspaces={registry.workspaces}
                onSwitchWorkspace={handleSwitchWorkspace}
                onCreateWorkspace={handleCreateWorkspace}
                onRenameWorkspace={handleRenameWorkspace}
                onDuplicateWorkspace={handleDuplicateWorkspace}
                onDeleteWorkspace={handleDeleteWorkspace}
                onLockApp={handleLockRequest}
                hasLockPassword={hasLockPassword}
                onSetPassword={() => setSetPasswordMode('set')}
                onResetPassword={() => setShowResetPassword(true)}
              />
            }
          />
          <Route path="/" element={<Navigate to="/map" replace />} />
        </Routes>
      </div>
      {lockState === 'locked' && (
        <LockScreen onUnlock={handleUnlock} onStartFresh={handleStartFresh} />
      )}
      {lockState === 'unlocked' && setPasswordMode === 'lock' && (
        <SetPasswordDialog
          mode="lock"
          onCancel={() => setSetPasswordMode(null)}
          onConfirm={(password) => void engageLock(password)}
        />
      )}
      {lockState === 'unlocked' && setPasswordMode === 'set' && (
        <SetPasswordDialog
          mode="set"
          onCancel={() => setSetPasswordMode(null)}
          onConfirm={handleSetPasswordOnly}
        />
      )}
      {lockState === 'unlocked' && showResetPassword && (
        <ResetPasswordDialog
          onCancel={() => setShowResetPassword(false)}
          onReset={handleResetPassword}
        />
      )}
    </>
  );
}

export default App;
