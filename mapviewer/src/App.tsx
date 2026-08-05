import './App.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { SplitScreenState, SplitViewPrefs, WorkspaceRegistry } from './types';
import {
  loadWorkspaceRegistryFromUrl,
  saveWorkspaceRegistry,
  generateWorkspaceId,
  copyWorkspaceStorage,
  deleteWorkspaceStorage,
  setWorkspaceUrlParam,
  resolveSplitScreenFromUrl,
  setSplitScreenUrlParams,
  parseSplitPrefsFromUrl,
  SPLIT_PREFS_DEFAULTS,
  loadSplitDivider,
  saveSplitDivider,
  nextWorkspaceName,
} from './utils/workspaceStorage';
import {
  WORKSPACE_QUERY_PARAM,
  SPLIT_SCREEN_QUERY_PARAM,
  SPLIT_WORKSPACES_QUERY_PARAM,
  SPLIT_BASEMAP_QUERY_PARAM,
  SPLIT_GRID_QUERY_PARAM,
  SPLIT_SHOW_COORD_QUERY_PARAM,
} from './constants';
import {
  hasLockedVault,
  hasPasswordHash,
  verifyPasswordHash,
  writePasswordHash,
  removePasswordHash,
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
import { SplitScreen } from './components/SplitScreen';
import { LockScreen, SetPasswordDialog, ResetPasswordDialog, ConfirmPasswordDialog } from './components/AppLock';

// Re-exports for test compatibility — tests import these from './App'
export { SettingsDialog } from './components/SettingsDialog';
export { WorkspaceSelector } from './components/WorkspaceSelector';
export { LockScreen, SetPasswordDialog, ResetPasswordDialog, ConfirmPasswordDialog } from './components/AppLock';
export { toggleGroupLayerVisibility } from './components/LayerPanel';
export { saveDrawSession, loadDrawSession } from './utils/drawHelpers';
export { DEFAULT_WORKSPACE_ID } from './constants';

function App() {
  // Boot resolves both the active workspace (?ws= deep link) and any
  // split-screen state (?split-screen=true&workspaces=a,b) from the URL.
  const [boot] = useState(() => resolveSplitScreenFromUrl(loadWorkspaceRegistryFromUrl()));
  const [registry, setRegistry] = useState<WorkspaceRegistry>(boot.registry);
  // Split-screen comparison state: null = normal single-workspace view.
  const [split, setSplit] = useState<SplitScreenState | null>(boot.split);
  const [splitDivider, setSplitDivider] = useState<number>(() => loadSplitDivider());
  // Split-view-only basic settings (isolated from every workspace's own
  // settings); carried in the URL while split mode is active.
  const [splitPrefs, setSplitPrefs] = useState<SplitViewPrefs>(() => parseSplitPrefsFromUrl());
  // A split deep link may have extended the registry (auto-created
  // comparison workspace, re-pointed active id) before the first render —
  // persist the boot result once so it survives a plain reload.
  useEffect(() => {
    saveWorkspaceRegistry(boot.registry);
  }, [boot.registry]);

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
  // True when the user needs to confirm their existing password before locking
  // (happens after a page refresh when the in-memory password is lost).
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Reactive mirror of "a lock password exists" so the Settings footer menu
  // can label itself "Reset Password" vs "Set Password". Persisted across
  // refreshes via the password hash in localStorage.
  const [hasLockPassword, setHasLockPassword] = useState(() => hasLockedVault() || hasPasswordHash());
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
    setShowConfirmPassword(false);
    setLockState('locked');
  }, []);

  /** Settings-footer lock icon: reuse the session password, verify against
   * the persisted hash, or ask for a new one. */
  const handleLockRequest = useCallback(() => {
    if (lockPasswordRef.current) {
      // Password already established this session: lock immediately, no prompt.
      void engageLock(lockPasswordRef.current);
    } else if (hasPasswordHash()) {
      // Password was set in a previous session but the in-memory copy is gone
      // (page refresh). Ask the user to confirm their password before locking.
      setShowConfirmPassword(true);
    } else {
      // First lock ever: choose a password, then lock.
      setSetPasswordMode('lock');
    }
  }, [engageLock]);

  /** Confirm-password dialog submit: verify against the stored hash, then lock. */
  const handleConfirmPassword = useCallback(async (password: string) => {
    if (!verifyPasswordHash(password)) {
      throw new WrongPasswordError();
    }
    lockPasswordRef.current = password;
    await engageLock(password);
  }, [engageLock]);

  /** Right-click "Set Password": store a password for future locks without
   * locking the app right now. */
  const handleSetPasswordOnly = useCallback((password: string) => {
    lockPasswordRef.current = password;
    writePasswordHash(password);
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
    writePasswordHash(newPassword);
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
    writePasswordHash(password);
    setHasLockPassword(true);
    const restored = loadWorkspaceRegistryFromUrl();
    const { registry: restoredRegistry, split: restoredSplit } = resolveSplitScreenFromUrl(restored);
    if (restoredRegistry !== restored) saveWorkspaceRegistry(restoredRegistry);
    setRegistry(restoredRegistry);
    setSplit(restoredSplit);
    setSplitPrefs(parseSplitPrefsFromUrl());
    setUnlockEpoch((epoch) => epoch + 1);
    setLockState('unlocked');
  }, []);

  /** "Start fresh": wipe the vault plus every persisted key and reboot. */
  const handleStartFresh = useCallback(() => {
    clearAppStorage();
    removePasswordHash();
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

  // Keep the address bar reflecting the active workspace: fill in or repair
  // the ?ws= param after boot and unlock. The switch / create / delete
  // handlers write it eagerly (stripping stale view params in the same step);
  // this effect covers URLs that predate the param or carry a stale id.
  useEffect(() => {
    // Split screen owns the URL (?split-screen=true&workspaces=a,b).
    if (lockState !== 'unlocked' || split) return;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get(WORKSPACE_QUERY_PARAM) !== registry.activeId) {
        params.set(WORKSPACE_QUERY_PARAM, registry.activeId);
        window.history.replaceState(null, '', '?' + params.toString());
      }
    } catch (e) {
      console.error('[App] Failed to sync workspace URL param:', e);
    }
  }, [registry.activeId, lockState, split]);

  // Keep the address bar reflecting the split state — repairs URLs that
  // carry split-screen=true without (or with unresolvable) workspaces.
  useEffect(() => {
    if (lockState !== 'unlocked' || !split) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const matches =
        params.get(SPLIT_SCREEN_QUERY_PARAM) === 'true' &&
        params.get(SPLIT_WORKSPACES_QUERY_PARAM) === `${split.left},${split.right}` &&
        params.get(SPLIT_BASEMAP_QUERY_PARAM) === String(splitPrefs.basemap) &&
        params.get(SPLIT_GRID_QUERY_PARAM) === String(splitPrefs.grid) &&
        params.get(SPLIT_SHOW_COORD_QUERY_PARAM) === String(splitPrefs.showCoords);
      if (!matches) {
        setSplitScreenUrlParams(split.left, split.right, splitPrefs);
      }
    } catch (e) {
      console.error('[App] Failed to sync split-screen URL params:', e);
    }
  }, [split, splitPrefs, lockState]);

  const updateRegistry = useCallback((next: WorkspaceRegistry) => {
    setRegistry(next);
    saveWorkspaceRegistry(next);
  }, []);

  /** Enter split-screen. A plain click puts the current workspace on the
   * left and another one on the right — auto-creating one when only a
   * single workspace exists. The split button's right-click picker passes
   * the two chosen workspace ids explicitly (left first). */
  const handleEnterSplitScreen = useCallback((leftId?: string, rightId?: string) => {
    const knownIds = new Set(registry.workspaces.map(w => w.id));
    const left = leftId && knownIds.has(leftId) ? leftId : registry.activeId;
    let nextRegistry = registry;
    let right = rightId && knownIds.has(rightId) && rightId !== left
      ? rightId
      : registry.workspaces.find(w => w.id !== left)?.id;
    if (!right || right === left) {
      right = generateWorkspaceId();
      nextRegistry = {
        ...nextRegistry,
        workspaces: [...nextRegistry.workspaces, { id: right, name: nextWorkspaceName(nextRegistry.workspaces) }],
      };
    }
    // The left pane is primary: keep the persisted active workspace in step.
    if (nextRegistry.activeId !== left) nextRegistry = { ...nextRegistry, activeId: left };
    if (nextRegistry !== registry) updateRegistry(nextRegistry);
    setSplitPrefs(SPLIT_PREFS_DEFAULTS);
    setSplitScreenUrlParams(left, right, SPLIT_PREFS_DEFAULTS);
    setSplit({ left, right });
  }, [registry, updateRegistry]);

  /** Swap which workspace a split pane shows. */
  const handleChangeSplitWorkspace = useCallback((side: 'left' | 'right', id: string) => {
    if (!split) return;
    const next = side === 'left' ? { left: id, right: split.right } : { left: split.left, right: id };
    if (next.left === next.right) return; // selects disable the other side's workspace anyway
    setSplitScreenUrlParams(next.left, next.right);
    setSplit(next);
    // The left pane is primary: keep the persisted active workspace in step.
    if (side === 'left' && registry.activeId !== id) {
      updateRegistry({ ...registry, activeId: id });
    }
  }, [split, registry, updateRegistry]);

  /** Closing a pane exits split screen; the *other* pane's workspace becomes
   * the normal full-screen workspace. */
  const handleCloseSplitPane = useCallback((side: 'left' | 'right') => {
    if (!split) return;
    const survivor = side === 'left' ? split.right : split.left;
    setWorkspaceUrlParam(survivor); // strips split params + stale view params
    if (registry.activeId !== survivor) updateRegistry({ ...registry, activeId: survivor });
    setSplit(null);
  }, [split, registry, updateRegistry]);

  /** Update one of the split-view-only basic settings (URL sync follows via
   * the effect above; workspaces' own settings are never touched). */
  const handleSplitPrefsChange = useCallback((patch: Partial<SplitViewPrefs>) => {
    setSplitPrefs(prev => ({ ...prev, ...patch }));
  }, []);

  /** Exit split mode from the settings footer: the left (primary) workspace
   * becomes the normal full-screen workspace. */
  const handleExitSplitMode = useCallback(() => {
    if (!split) return;
    const survivor = split.left;
    setWorkspaceUrlParam(survivor); // strips split params + prefs
    if (registry.activeId !== survivor) updateRegistry({ ...registry, activeId: survivor });
    setSplit(null);
  }, [split, registry, updateRegistry]);

  const handleSplitDividerChange = useCallback((pct: number) => {
    setSplitDivider(pct);
    saveSplitDivider(pct);
  }, []);

  const handleSwitchWorkspace = useCallback((id: string) => {
    if (registry.activeId === id || !registry.workspaces.some(w => w.id === id)) return;
    setWorkspaceUrlParam(id);
    updateRegistry({ ...registry, activeId: id });
  }, [registry, updateRegistry]);

  const handleCreateWorkspace = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = generateWorkspaceId();
    setWorkspaceUrlParam(id);
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
    setWorkspaceUrlParam(id);
    updateRegistry({ workspaces: [...registry.workspaces, { id: newId, name }], activeId: id });
  }, [registry, updateRegistry]);

  const handleDeleteWorkspace = useCallback((id: string) => {
    if (registry.workspaces.length <= 1) return; // never delete the last workspace
    deleteWorkspaceStorage(id);
    const remaining = registry.workspaces.filter(w => w.id !== id);
    const activeId = registry.activeId === id ? remaining[0].id : registry.activeId;
    if (registry.activeId === id) setWorkspaceUrlParam(activeId);
    updateRegistry({ workspaces: remaining, activeId });
  }, [registry, updateRegistry]);

  return (
    <>
      <div className="app-root" ref={appRootRef}>
        {lockState === 'locked' ? (
          /* Static placeholder: no user data or interactive elements exist in
           * the DOM while locked, so removing the blur overlay via dev tools
           * reveals nothing sensitive. The placeholder gives the backdrop-filter
           * blur something to render against. */
          <div className="lock-placeholder" aria-hidden="true" />
        ) : (
          <Routes>
            <Route
              path="/map"
              element={split ? (
                <SplitScreen
                  workspaces={registry.workspaces}
                  split={split}
                  dividerPct={splitDivider}
                  unlockEpoch={unlockEpoch}
                  onChangeWorkspace={handleChangeSplitWorkspace}
                  onClosePane={handleCloseSplitPane}
                  onDividerChange={handleSplitDividerChange}
                  splitPrefs={splitPrefs}
                  onToggleBasemap={(on) => handleSplitPrefsChange({ basemap: on })}
                  onToggleGrid={(on) => handleSplitPrefsChange({ grid: on })}
                  onToggleCoords={(on) => handleSplitPrefsChange({ showCoords: on })}
                  onLockApp={handleLockRequest}
                  hasLockPassword={hasLockPassword}
                  onSetPassword={() => setSetPasswordMode('set')}
                  onResetPassword={() => setShowResetPassword(true)}
                  getLockPassword={() => lockPasswordRef.current}
                  onExitSplitMode={handleExitSplitMode}
                />
              ) : (
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
                  getLockPassword={() => lockPasswordRef.current}
                  onEnterSplitScreen={handleEnterSplitScreen}
                />
              )}
            />
            <Route path="/" element={<Navigate to="/map" replace />} />
          </Routes>
        )}
      </div>
      {lockState === 'locked' && (
        <LockScreen onUnlock={handleUnlock} onStartFresh={handleStartFresh} />
      )}
      {lockState === 'unlocked' && setPasswordMode === 'lock' && (
        <SetPasswordDialog
          mode="lock"
          onCancel={() => setSetPasswordMode(null)}
          onConfirm={(password) => {
            writePasswordHash(password);
            void engageLock(password);
          }}
        />
      )}
      {lockState === 'unlocked' && setPasswordMode === 'set' && (
        <SetPasswordDialog
          mode="set"
          onCancel={() => setSetPasswordMode(null)}
          onConfirm={handleSetPasswordOnly}
        />
      )}
      {lockState === 'unlocked' && showConfirmPassword && (
        <ConfirmPasswordDialog
          onCancel={() => setShowConfirmPassword(false)}
          onConfirm={handleConfirmPassword}
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
