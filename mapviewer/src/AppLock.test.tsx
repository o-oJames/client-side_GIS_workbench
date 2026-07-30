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
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App, { LockScreen, SetPasswordDialog, SettingsDialog } from './App';
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
    onApplyVectorStyle: () => {}, onApplyVectorZoomRange: () => {}, onApplyVectorCluster: () => {}, onApplyVectorFeatureStyle: () => {},
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
