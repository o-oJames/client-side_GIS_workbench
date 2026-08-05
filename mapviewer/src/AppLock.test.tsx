/**
 * App lock tests: the storage-vault plumbing, the password-based encryption
 * round trip, the lock screen (unlock / wrong password / start fresh), the
 * first-lock password setup dialog, and the Settings-footer lock button.
 *
 * The vault crypto runs on whichever cipher the environment provides:
 * AES-256-GCM where Web Crypto exists, the documented SHA-256 stream
 * fallback otherwise (jsdom has no crypto.subtle, so tests exercise the
 * fallback - both paths share the same encrypt/decrypt contract).
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App, { LockScreen, SetPasswordDialog, ResetPasswordDialog, SettingsDialog } from './App';
import {
  LOCKED_VAULT_KEY,
  WrongPasswordError,
  clearAppStorage,
  collectAppStorage,
  decryptAppData,
  encryptAppData,
  hasLockedVault,
  restoreAppStorage,
  sha256Bytes,
  writeVault,
} from './utils/appLock';

beforeEach(() => {
  localStorage.clear();
});

/** Let async effects (layer restore, vault encryption) settle inside act(). */
const tick = async () => {
  await waitFor(() => new Promise<void>((r) => setTimeout(r, 0)));
};

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

/* ------------------------- crypto + storage utils ------------------------ */

test('sha256 matches the FIPS 180-4 known answers', () => {
  const enc = new TextEncoder();
  expect(hex(sha256Bytes(new Uint8Array(0)))).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  expect(hex(sha256Bytes(enc.encode('abc')))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  // 1000 bytes spans many blocks, exercising the loop beyond one chunk.
  expect(hex(sha256Bytes(enc.encode('a'.repeat(1000))))).toBe(
    '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'
  );
});

test('collectAppStorage snapshots only app-owned keys, never the vault', () => {
  localStorage.setItem('mapviewer-workspaces', '{"workspaces":[]}');
  localStorage.setItem('mapviewer-settings', '{"showGrid":true}');
  localStorage.setItem('mapviewer-view:ws-2', '{"zoom":5}');
  localStorage.setItem('unrelated-key', 'keep me');
  localStorage.setItem(LOCKED_VAULT_KEY, '{"v":1}');

  const entries = collectAppStorage();
  expect(Object.keys(entries).sort()).toEqual([
    'mapviewer-settings',
    'mapviewer-view:ws-2',
    'mapviewer-workspaces',
  ]);
});

test('restoreAppStorage writes the snapshot back verbatim', () => {
  restoreAppStorage({ 'mapviewer-settings': '{"a":1}', 'mapviewer-workspaces': '{"b":2}' });
  expect(localStorage.getItem('mapviewer-settings')).toBe('{"a":1}');
  expect(localStorage.getItem('mapviewer-workspaces')).toBe('{"b":2}');
});

test('clearAppStorage removes every app key; keepVault preserves the vault', () => {
  localStorage.setItem('mapviewer-settings', 'x');
  localStorage.setItem('mapviewer-workspaces', 'y');
  localStorage.setItem(LOCKED_VAULT_KEY, 'vault');
  localStorage.setItem('unrelated-key', 'z');

  clearAppStorage(true);
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBe('vault');
  expect(localStorage.getItem('mapviewer-settings')).toBeNull();
  expect(localStorage.getItem('mapviewer-workspaces')).toBeNull();
  expect(localStorage.getItem('unrelated-key')).toBe('z');

  clearAppStorage();
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeNull();
  expect(hasLockedVault()).toBe(false);
});

test('writeVault + hasLockedVault track the locked state', () => {
  expect(hasLockedVault()).toBe(false);
  writeVault('{"v":1}');
  expect(hasLockedVault()).toBe(true);
});

test('encryptAppData/decryptAppData round-trip restores the entries', async () => {
  const entries = {
    'mapviewer-workspaces': JSON.stringify({
      workspaces: [{ id: 'default', name: 'Default' }],
      activeId: 'default',
    }),
    'mapviewer-settings': JSON.stringify({ showGrid: true, rasterLayers: [] }),
  };
  const vault = await encryptAppData(entries, 'hunter2!');

  // The vault is opaque: neither keys nor values appear in plaintext.
  expect(vault).not.toContain('mapviewer-settings');
  expect(vault).not.toContain('showGrid');

  await expect(decryptAppData(vault, 'hunter2!')).resolves.toEqual(entries);
});

test('decryptAppData rejects a wrong password', async () => {
  const vault = await encryptAppData({ 'mapviewer-settings': '{}' }, 'correct horse');
  await expect(decryptAppData(vault, 'wrong horse')).rejects.toBeInstanceOf(WrongPasswordError);
});

test('decryptAppData rejects a corrupted vault', async () => {
  await expect(decryptAppData('not-json', 'pw')).rejects.toBeInstanceOf(WrongPasswordError);
  await expect(decryptAppData('{"v":9}', 'pw')).rejects.toBeInstanceOf(WrongPasswordError);
});

/* ------------------------------- LockScreen ------------------------------ */

test('LockScreen submits the typed password to onUnlock', async () => {
  const onUnlock = jest.fn().mockResolvedValue(undefined);
  render(<LockScreen onUnlock={onUnlock} onStartFresh={() => {}} />);

  expect(screen.getByRole('heading', { name: /map viewer is locked/i })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'letmein' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

  await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('letmein'));
});

test('LockScreen surfaces a wrong-password error and stays usable', async () => {
  const onUnlock = jest.fn().mockRejectedValue(new WrongPasswordError());
  render(<LockScreen onUnlock={onUnlock} onStartFresh={() => {}} />);

  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect password/i);

  // The field survives the failed attempt (remounted, state preserved).
  const input = screen.getByLabelText('Password') as HTMLInputElement;
  expect(input.value).toBe('nope');
  fireEvent.change(input, { target: { value: 'again' } });
  expect(input.value).toBe('again');
});

test('Start fresh asks for confirmation before wiping', () => {
  const onStartFresh = jest.fn();
  render(<LockScreen onUnlock={jest.fn()} onStartFresh={onStartFresh} />);

  fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
  expect(screen.getByText('Erase everything?')).toBeInTheDocument();

  // Cancel backs out without wiping.
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onStartFresh).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Start fresh' })).toBeInTheDocument();

  // Confirming wipes.
  fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, start fresh' }));
  expect(onStartFresh).toHaveBeenCalledTimes(1);
});

/* ---------------------------- SetPasswordDialog -------------------------- */

test('SetPasswordDialog validates length and confirmation before locking', () => {
  const onConfirm = jest.fn();
  render(<SetPasswordDialog onCancel={() => {}} onConfirm={onConfirm} />);

  const pw = screen.getByLabelText('Password');
  const confirm = screen.getByLabelText('Confirm password');

  // Too short.
  fireEvent.change(pw, { target: { value: 'abc' } });
  fireEvent.change(confirm, { target: { value: 'abc' } });
  expect(screen.getByText('Too short')).toBeInTheDocument(); // strength meter
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
  expect(screen.getByText(/at least 4 characters/i)).toBeInTheDocument();
  expect(onConfirm).not.toHaveBeenCalled();

  // Mismatch.
  fireEvent.change(pw, { target: { value: 'abcd1234' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
  expect(screen.getByText(/don.t match/i)).toBeInTheDocument();
  expect(onConfirm).not.toHaveBeenCalled();

  // Valid pair locks with the chosen password.
  fireEvent.change(confirm, { target: { value: 'abcd1234' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
  expect(onConfirm).toHaveBeenCalledWith('abcd1234');
});

test('SetPasswordDialog cancel does not lock', () => {
  const onCancel = jest.fn();
  render(<SetPasswordDialog onCancel={onCancel} onConfirm={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

/* ------------------------- Settings footer button ------------------------ */

function settingsBaseProps(over: Record<string, any> = {}) {
  return {
    onClose: () => {}, pinned: false, onPinToggle: () => {},
    showBasemap: true, onBasemapToggle: () => {},
    showGrid: false, onGridToggle: () => {},
    showDrawToolbar: true, onDrawToolbarToggle: () => {},
    showCoordinates: true, onCoordinatesToggle: () => {},
    rasterLayers: [] as any[], rasterGroups: [] as any[],
    onUpdateRasterGroups: () => {}, onToggleRasterGroup: () => {}, onMoveRasterLayerToGroup: () => {},
    onAddRasterLayer: async () => {}, onEditRasterLayer: () => {}, onRemoveRasterLayer: () => {}, onToggleRasterLayer: () => {},
    onApplyColorAdjustments: () => {}, onApplyTileZoomRange: () => {},
    vectorLayers: [] as any[], vectorGroups: [] as any[],
    onUpdateVectorGroups: () => {}, onToggleVectorGroup: () => {}, onMoveVectorLayerToGroup: () => {},
    onToggleVectorLayer: () => {}, onRemoveVectorLayer: () => {}, onEditVectorLayer: () => {},
    onApplyVectorStyle: () => {}, onApplyVectorZoomRange: () => {}, onApplyVectorCluster: () => {}, onApplyVectorFilter: () => true, onApplyVectorAttrRender: () => {}, onApplyVectorFeatureStyle: () => {}, onToggleVectorFeatureMeasurements: () => {},
    onReorderRasterLayers: () => {}, onReorderVectorLayers: () => {},
    onAddVectorLayer: async () => {}, onAddMVTLayer: async () => {}, onAddWFSLayer: async () => {}, onAddSTACLayer: async () => {},
    onExportVectorLayer: () => {}, onReeditVectorLayer: () => {}, editingVectorLayerId: null,
    onGoToVectorLayerExtent: () => {}, onGoToRasterLayerExtent: () => {},
    onAdvancedSettings: () => {}, knownSources: [], isRestoringLayers: false,
    loadingVectorIds: new Set<string>(), units: 'metric' as const,
    workspaceId: 'default',
    workspaces: [{ id: 'default', name: 'Default' }],
    onSwitchWorkspace: () => {}, onCreateWorkspace: () => {}, onRenameWorkspace: () => {},
    onDuplicateWorkspace: () => {}, onDeleteWorkspace: () => {},
    onLockApp: () => {},
    hasLockPassword: false, onSetPassword: () => {}, onResetPassword: () => {},
    ...over,
  };
}

test('Settings footer shows the lock button left of the workspace switch', () => {
  const onLockApp = jest.fn();
  render(<SettingsDialog {...settingsBaseProps({ onLockApp })} />);

  const lock = screen.getByRole('button', { name: 'Lock app' });
  expect(lock).toBeInTheDocument();

  // The lock button precedes the workspace switcher in the footer.
  const trigger = screen.getByRole('button', { name: /switch workspace/i });
  expect(lock.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(lock);
  expect(onLockApp).toHaveBeenCalledTimes(1);
});

/* --------------------------- Full App lock cycle ------------------------- */

test('full lock cycle: set password, storage encrypts, unlock restores it', async () => {
  localStorage.setItem(
    'mapviewer-workspaces',
    JSON.stringify({ workspaces: [{ id: 'default', name: 'Default' }], activeId: 'default' })
  );
  localStorage.setItem('mapviewer-settings', JSON.stringify({ showGrid: true }));

  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  // Lock from the Settings footer; first lock asks for a password.
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 's3cret!' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 's3cret!' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));

  // The vault replaces the plaintext keys and the lock screen takes over.
  await screen.findByRole('heading', { name: /map viewer is locked/i });
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeTruthy();
  expect(localStorage.getItem('mapviewer-settings')).toBeNull();
  expect(localStorage.getItem('mapviewer-workspaces')).toBeNull();

  // A wrong password is rejected and keeps the vault intact.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeTruthy();

  // The right password decrypts storage back and dismisses the lock screen.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 's3cret!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() => expect(localStorage.getItem('mapviewer-settings')).not.toBeNull());
  expect(JSON.parse(localStorage.getItem('mapviewer-settings') || '{}').showGrid).toBe(true);
  expect(JSON.parse(localStorage.getItem('mapviewer-workspaces') || '{}').activeId).toBe('default');
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: /map viewer is locked/i })).toBeNull()
  );
});

test('app boots straight into the lock screen when a vault exists', async () => {
  const vault = await encryptAppData({ 'mapviewer-settings': '{"showGrid":true}' }, 'pw1234');
  localStorage.setItem(LOCKED_VAULT_KEY, vault);

  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  expect(await screen.findByRole('heading', { name: /map viewer is locked/i })).toBeInTheDocument();

  // The vault survives the boot untouched. The idle app may persist fresh
  // *defaults* while locked, but never the locked content: the vault had
  // showGrid=true, so any plaintext settings must still show the default.
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBe(vault);
  const plain = localStorage.getItem('mapviewer-settings');
  if (plain !== null) {
    expect(JSON.parse(plain).showGrid).toBe(false);
  }
});

/* ------------------- Lock icon right-click menu (Settings) --------------- */

test('lock icon right-click menu offers "Set Password" when no password is set', () => {
  const onSetPassword = jest.fn();
  render(<SettingsDialog {...settingsBaseProps({ hasLockPassword: false, onSetPassword })} />);

  fireEvent.contextMenu(screen.getByRole('button', { name: 'Lock app' }));
  const item = screen.getByRole('menuitem', { name: /set password/i });
  expect(item).toBeInTheDocument();

  fireEvent.click(item);
  expect(onSetPassword).toHaveBeenCalledTimes(1);
  // The menu closes after choosing an action.
  expect(screen.queryByRole('menuitem')).toBeNull();
});

test('lock icon right-click menu offers "Reset Password" once a password exists', () => {
  const onResetPassword = jest.fn();
  render(<SettingsDialog {...settingsBaseProps({ hasLockPassword: true, onResetPassword })} />);

  fireEvent.contextMenu(screen.getByRole('button', { name: 'Lock app' }));
  const item = screen.getByRole('menuitem', { name: /reset password/i });
  expect(item).toBeInTheDocument();

  fireEvent.click(item);
  expect(onResetPassword).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menuitem')).toBeNull();
});

/* --------------------------- ResetPasswordDialog ------------------------- */

test('ResetPasswordDialog validates the new password before submitting', async () => {
  const onReset = jest.fn().mockResolvedValue(undefined);
  render(<ResetPasswordDialog onCancel={() => {}} onReset={onReset} />);

  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass1' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'ab' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'ab' } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

  expect(await screen.findByText(/at least 4 characters/i)).toBeInTheDocument();
  expect(onReset).not.toHaveBeenCalled();
});

test('ResetPasswordDialog rejects mismatched new passwords', async () => {
  const onReset = jest.fn().mockResolvedValue(undefined);
  render(<ResetPasswordDialog onCancel={() => {}} onReset={onReset} />);

  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass1' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass2' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different' } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

  expect(await screen.findByText(/match/i)).toBeInTheDocument();
  expect(onReset).not.toHaveBeenCalled();
});

test('ResetPasswordDialog reports a wrong current password', async () => {
  const onReset = jest.fn().mockRejectedValue(new WrongPasswordError());
  render(<ResetPasswordDialog onCancel={() => {}} onReset={onReset} />);

  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'nope' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass2' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass2' } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

  expect(onReset).toHaveBeenCalledWith('nope', 'newpass2');
  expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i);
});

test('ResetPasswordDialog submits the current and new passwords on success', async () => {
  const onReset = jest.fn().mockResolvedValue(undefined);
  render(<ResetPasswordDialog onCancel={() => {}} onReset={onReset} />);

  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass1' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass2' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass2' } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

  await waitFor(() => expect(onReset).toHaveBeenCalledWith('oldpass1', 'newpass2'));
});

/* --------------------- SetPasswordDialog "set" variant ------------------- */

test('SetPasswordDialog mode="set" sets a password without the lock wording', () => {
  const onConfirm = jest.fn();
  render(<SetPasswordDialog mode="set" onCancel={() => {}} onConfirm={onConfirm} />);

  expect(screen.getByRole('heading', { name: /^set a password$/i })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abcd1234' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'abcd1234' } });
  fireEvent.click(screen.getByRole('button', { name: /^set password$/i }));
  expect(onConfirm).toHaveBeenCalledWith('abcd1234');
});

/* --------------------- Full App: set-once + reset flows ------------------ */

test('a password set via right-click locks the next time without re-asking', async () => {
  localStorage.setItem(
    'mapviewer-workspaces',
    JSON.stringify({ workspaces: [{ id: 'default', name: 'Default' }], activeId: 'default' })
  );
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  fireEvent.click(screen.getByTitle('Settings'));
  const lock = screen.getByRole('button', { name: 'Lock app' });

  // No password yet: the right-click menu offers "Set Password".
  fireEvent.contextMenu(lock);
  fireEvent.click(screen.getByRole('menuitem', { name: /set password/i }));

  // Setting a password does NOT lock the app.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'hunter22' } });
  fireEvent.click(screen.getByRole('button', { name: /^set password$/i }));
  await tick();
  expect(screen.queryByRole('heading', { name: /map viewer is locked/i })).toBeNull();
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeNull();

  // Left-clicking the lock icon now locks immediately - no setup dialog.
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));
  await screen.findByRole('heading', { name: /map viewer is locked/i });
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeTruthy();

  // The password we set earlier is the one that unlocks.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: /map viewer is locked/i })).toBeNull()
  );
});

test('reset password verifies the current one and re-locks with the new one', async () => {
  localStorage.setItem(
    'mapviewer-workspaces',
    JSON.stringify({ workspaces: [{ id: 'default', name: 'Default' }], activeId: 'default' })
  );
  localStorage.setItem('mapviewer-settings', JSON.stringify({ showGrid: true }));
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  // Establish a password by locking once, then unlock.
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'oldpass1' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'oldpass1' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
  await screen.findByRole('heading', { name: /map viewer is locked/i });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'oldpass1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() => expect(localStorage.getItem('mapviewer-settings')).not.toBeNull());

  await tick(); // let MapPage remount after unlock
  // A password exists now, so the right-click menu offers "Reset Password".
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Lock app' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /reset password/i }));

  // A wrong current password is rejected and keeps the dialog open.
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass2' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'newpass2' } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i);

  // The correct current password applies the new one and closes the dialog.
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldpass1' } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: /reset your password/i })).toBeNull()
  );

  // Lock again; only the NEW password unlocks now.
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));
  await screen.findByRole('heading', { name: /map viewer is locked/i });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'oldpass1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'newpass2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: /map viewer is locked/i })).toBeNull()
  );
  expect(JSON.parse(localStorage.getItem('mapviewer-settings') || '{}').showGrid).toBe(true);
});

/* --------------------- Password hash persistence ------------------------ */

import {
  PASSWORD_HASH_KEY,
  hasPasswordHash,
  writePasswordHash,
  verifyPasswordHash,
  removePasswordHash,
} from './utils/appLock';

test('writePasswordHash + verifyPasswordHash round-trip', () => {
  expect(hasPasswordHash()).toBe(false);
  writePasswordHash('mypassword');
  expect(hasPasswordHash()).toBe(true);
  expect(verifyPasswordHash('mypassword')).toBe(true);
  expect(verifyPasswordHash('wrongpassword')).toBe(false);
});

test('removePasswordHash clears the stored hash', () => {
  writePasswordHash('test123');
  expect(hasPasswordHash()).toBe(true);
  removePasswordHash();
  expect(hasPasswordHash()).toBe(false);
  expect(verifyPasswordHash('test123')).toBe(false);
});

test('password hash survives localStorage persistence (simulated refresh)', () => {
  writePasswordHash('persist-me');
  // Simulate a page refresh: the hash is still in localStorage.
  expect(localStorage.getItem(PASSWORD_HASH_KEY)).toBeTruthy();
  expect(hasPasswordHash()).toBe(true);
  expect(verifyPasswordHash('persist-me')).toBe(true);
});

/* ------------------------- ConfirmPasswordDialog ------------------------- */

import { ConfirmPasswordDialog } from './App';

test('ConfirmPasswordDialog submits the typed password to onConfirm', async () => {
  const onConfirm = jest.fn().mockResolvedValue(undefined);
  render(<ConfirmPasswordDialog onCancel={() => {}} onConfirm={onConfirm} />);

  expect(screen.getByRole('heading', { name: /enter your password to lock/i })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'letmein' } });
  const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: /lock app/i }));

  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('letmein'));
});

test('ConfirmPasswordDialog surfaces a wrong-password error', async () => {
  const onConfirm = jest.fn().mockRejectedValue(new WrongPasswordError());
  render(<ConfirmPasswordDialog onCancel={() => {}} onConfirm={onConfirm} />);

  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
  const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: /lock app/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect password/i);
});

test('ConfirmPasswordDialog cancel does not lock', () => {
  const onCancel = jest.fn();
  render(<ConfirmPasswordDialog onCancel={onCancel} onConfirm={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

/* ---------- Full App: password persists across simulated refresh --------- */

test('after refresh, locking asks to confirm password instead of setting a new one', async () => {
  localStorage.setItem(
    'mapviewer-workspaces',
    JSON.stringify({ workspaces: [{ id: 'default', name: 'Default' }], activeId: 'default' })
  );

  // First render: set a password via the lock flow.
  const { unmount } = render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'persist-pw' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'persist-pw' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
  await screen.findByRole('heading', { name: /map viewer is locked/i });

  // Unlock to get back to the app.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'persist-pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: /map viewer is locked/i })).toBeNull()
  );

  // Simulate a page refresh: unmount and re-render. The password hash is
  // still in localStorage, but the in-memory ref is gone.
  unmount();
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  // Clicking lock should show the "confirm password" dialog, NOT "set password".
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));

  expect(screen.getByRole('heading', { name: /enter your password to lock/i })).toBeInTheDocument();
  expect(screen.queryByText(/set a password to lock/i)).toBeNull();

  // A wrong password is rejected.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /lock app/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect password/i);

  // The correct password locks the app.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'persist-pw' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /lock app/i }));
  await screen.findByRole('heading', { name: /map viewer is locked/i });
  expect(localStorage.getItem(LOCKED_VAULT_KEY)).toBeTruthy();
});

test('start fresh removes the password hash so next lock asks to set a new one', async () => {
  localStorage.setItem(
    'mapviewer-workspaces',
    JSON.stringify({ workspaces: [{ id: 'default', name: 'Default' }], activeId: 'default' })
  );

  // Set a password and lock.
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Lock app' }));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'oldpw123' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'oldpw123' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
  await screen.findByRole('heading', { name: /map viewer is locked/i });

  // Start fresh wipes everything including the hash.
  fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, start fresh' }));

  // After reload (simulated), the hash should be gone.
  expect(hasPasswordHash()).toBe(false);
});
