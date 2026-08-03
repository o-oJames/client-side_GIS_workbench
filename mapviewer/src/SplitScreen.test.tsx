/**
 * Split-screen comparison tests: two workspaces side by side with a draggable
 * divider, per-pane workspace choice, auto-creation of a second workspace
 * when only one exists, close-a-pane semantics, and URL state
 * (?split-screen=true&workspaces=a,b) surviving a refresh.
 */
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import {
  parseSplitScreenFromUrl,
  resolveSplitScreenFromUrl,
  setSplitScreenUrlParams,
  nextWorkspaceName,
  loadSplitDivider,
  saveSplitDivider,
} from './utils/workspaceStorage';

/** Let pending promises + the async layer-restore effects settle inside act(). */
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise<void>(r => setTimeout(r, 0));
    });
  }
};

const setUrl = (search: string) => window.history.replaceState(null, '', '/map' + search);
const urlParams = () => new URLSearchParams(window.location.search);
const registryInStorage = () => JSON.parse(localStorage.getItem('mapviewer-workspaces') || '');

/** The split panel keeps BOTH sides' dialogs mounted; this returns the one
 * currently visible (the active tab). */
const visibleDialog = () => {
  const dialogs = Array.from(document.querySelectorAll('.settings-dialog'));
  return dialogs.find(d => !d.classList.contains('settings-dialog--hidden')) as HTMLElement;
};

const TWO_WORKSPACES = {
  workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws-x', name: 'Survey' }],
  activeId: 'default',
};

const THREE_WORKSPACES = {
  workspaces: [
    { id: 'default', name: 'Default' },
    { id: 'ws-x', name: 'Survey' },
    { id: 'ws-y', name: 'Planning' },
  ],
  activeId: 'default',
};

beforeEach(() => {
  localStorage.clear();
  setUrl('');
});

// --- pure helpers ---------------------------------------------------------------

test('parseSplitScreenFromUrl parses the split params and rejects anything else', () => {
  setUrl('?split-screen=true&workspaces=a,b');
  expect(parseSplitScreenFromUrl()).toEqual({ left: 'a', right: 'b' });

  setUrl('?split-screen=true');
  expect(parseSplitScreenFromUrl()).toEqual({ left: null, right: null });

  setUrl('?workspaces=a,b');
  expect(parseSplitScreenFromUrl()).toBeNull();

  setUrl('?split-screen=false&workspaces=a,b');
  expect(parseSplitScreenFromUrl()).toBeNull();
});

test('resolveSplitScreenFromUrl resolves known ids and falls back for unknown ones', () => {
  setUrl('?split-screen=true&workspaces=ws-x,default');
  const resolved = resolveSplitScreenFromUrl(TWO_WORKSPACES as any);
  expect(resolved.split).toEqual({ left: 'ws-x', right: 'default' });
  // The left pane is primary, so the persisted active workspace follows it
  expect(resolved.registry.activeId).toBe('ws-x');
  expect(resolved.registry.workspaces).toEqual(TWO_WORKSPACES.workspaces);

  setUrl('?split-screen=true&workspaces=ghost,phantom');
  const fallback = resolveSplitScreenFromUrl(TWO_WORKSPACES as any);
  expect(fallback.split).toEqual({ left: 'default', right: 'ws-x' }); // activeId + the other one
});

test('resolveSplitScreenFromUrl auto-creates a second workspace when only one exists', () => {
  setUrl('?split-screen=true');
  const single = { workspaces: [{ id: 'default', name: 'Default' }], activeId: 'default' };
  const { registry, split } = resolveSplitScreenFromUrl(single as any);
  expect(registry.workspaces).toHaveLength(2);
  expect(registry.workspaces[1].name).toBe('Workspace 2');
  expect(split).not.toBeNull();
  expect(split!.left).toBe('default');
  expect(split!.right).toBe(registry.workspaces[1].id);
});

test('resolveSplitScreenFromUrl without split intent leaves the registry untouched', () => {
  setUrl('?ws=default');
  const { registry, split } = resolveSplitScreenFromUrl(TWO_WORKSPACES as any);
  expect(split).toBeNull();
  expect(registry).toBe(TWO_WORKSPACES);
});

test('nextWorkspaceName picks a unique "Workspace N"', () => {
  expect(nextWorkspaceName(TWO_WORKSPACES.workspaces as any)).toBe('Workspace 3');
  expect(nextWorkspaceName([
    { id: 'a', name: 'Default' },
    { id: 'b', name: 'Workspace 3' },
  ] as any)).toBe('Workspace 4'); // skips the taken name
});

test('setSplitScreenUrlParams writes the split state to the URL', () => {
  setUrl('?ws=default&lat=1&lng=2&z=3');
  setSplitScreenUrlParams('ws-a', 'ws-b');
  expect(urlParams().get('split-screen')).toBe('true');
  expect(urlParams().get('workspaces')).toBe('ws-a,ws-b');
  expect(urlParams().get('ws')).toBeNull(); // stale normal-mode params are gone
});

test('split divider position round-trips through localStorage with clamping', () => {
  saveSplitDivider(62.5);
  expect(loadSplitDivider()).toBe(62.5);
  localStorage.setItem('mapviewer-split-divider', '97');
  expect(loadSplitDivider()).toBe(85); // clamped to the max
  localStorage.setItem('mapviewer-split-divider', 'junk');
  expect(loadSplitDivider()).toBe(50); // falls back to the default
});

// --- app integration ----------------------------------------------------------

test('refreshing a split-screen URL restores both panes with the right workspaces', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  expect(screen.getByRole('separator')).toBeInTheDocument();
  // The pane headers label their side's workspace (selection lives in Settings)
  const paneNames = Array.from(document.querySelectorAll('.split-pane-name')).map(el => el.textContent);
  expect(paneNames).toEqual(['Default', 'Survey']);
  // The URL keeps carrying the split state
  expect(urlParams().get('split-screen')).toBe('true');
  expect(urlParams().get('workspaces')).toBe('default,ws-x');
  // One split-level settings gear (bottom-left, like the normal view)...
  expect(screen.getAllByTitle('Settings')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Split view settings' })).toBeInTheDocument();
  // ...no per-map gears inside the split panes, no split button either
  expect(document.querySelectorAll('.map-container .map-settings-button')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Split screen' })).toBeNull();
  // One coordinate readout riding the divider
  expect(document.querySelectorAll('.mouse-coordinate-display')).toHaveLength(1);
  expect(document.querySelector('.split-coordinate-display')).toBeTruthy();
  // Default split-only prefs are written to the URL
  expect(urlParams().get('basemap')).toBe('true');
  expect(urlParams().get('grid')).toBe('false');
  expect(urlParams().get('show_coord')).toBe('true');
});

test('a split deep link with a single workspace auto-creates the second one', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify({
    workspaces: [{ id: 'default', name: 'Default' }],
    activeId: 'default',
  }));
  setUrl('?split-screen=true&workspaces=default,ws-gone');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  expect(screen.getByRole('separator')).toBeInTheDocument();
  const stored = registryInStorage();
  expect(stored.workspaces).toHaveLength(2);
  expect(stored.workspaces[1].name).toBe('Workspace 2');
  const paneNames = Array.from(document.querySelectorAll('.split-pane-name')).map(el => el.textContent);
  expect(paneNames[1]).toBe('Workspace 2');
  expect(urlParams().get('workspaces')).toBe(`default,${stored.workspaces[1].id}`);
});

test('the split-screen button in the settings footer enters comparison mode (auto-creating when alone)', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  // The split button lives inside the settings panel, next to the lock button
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  const splitButton = screen.getByRole('button', { name: 'Split screen' });
  expect(splitButton.closest('.settings-dialog-footer')).toBeTruthy();
  // ...right next to the lock button
  expect(splitButton.previousElementSibling?.classList.contains('settings-lock-button')).toBe(true);

  fireEvent.click(splitButton);
  await tick(3);

  expect(screen.getByRole('separator')).toBeInTheDocument();
  const stored = registryInStorage();
  expect(stored.workspaces).toHaveLength(2); // only Default existed -> auto-created
  expect(stored.workspaces[1].name).toBe('Workspace 2');
  expect(urlParams().get('split-screen')).toBe('true');
  expect(urlParams().get('workspaces')).toBe(`default,${stored.workspaces[1].id}`);
});

test('dragging the divider moves both clips and persists the position', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  // Both maps cover the whole window; the divider position lives in the
  // clip paths: left keeps [0, 50%], right keeps [50%, 100%].
  const leftClip = document.querySelector('[data-split-side="left"]') as HTMLElement;
  const rightClip = document.querySelector('[data-split-side="right"]') as HTMLElement;
  expect(leftClip.style.clipPath).toBe('inset(0 50% 0 0)');
  expect(rightClip.style.clipPath).toBe('inset(0 0 0 50%)');

  fireEvent.mouseDown(screen.getByRole('separator'));
  fireEvent.mouseMove(window, { clientX: window.innerWidth * 0.3 });
  fireEvent.mouseUp(window);

  const clipPct = (clipPath: string) => parseFloat(clipPath.replace(/inset\(0 (\d+\.?\d*)% 0 0\)/, '$1'));
  expect(100 - clipPct(leftClip.style.clipPath)).toBeCloseTo(30, 1); // left keeps [0, ~30%]
  expect(parseFloat(rightClip.style.clipPath.replace(/inset\(0 0 0 (\d+\.?\d*)%\)/, '$1'))).toBeCloseTo(30, 1);
  expect(parseFloat(localStorage.getItem('mapviewer-split-divider') || '')).toBeCloseTo(30, 1);
});

test('the integrated workspace selector in settings switches a side without remounting the panel', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(THREE_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByRole('button', { name: 'Split view settings' }));
  await tick();

  // Both sides' dialogs stay mounted at all times (visibility-only toggle)
  const mountedBefore = Array.from(document.querySelectorAll('.settings-dialog'));
  expect(mountedBefore).toHaveLength(2);

  // Switch to the right tab — the panel must NOT close and reopen
  fireEvent.click(within(visibleDialog()).getByRole('tab', { name: /Right — Survey/ }));
  await tick();
  const mountedAfter = Array.from(document.querySelectorAll('.settings-dialog'));
  expect(mountedAfter).toHaveLength(2);
  expect(mountedAfter.every(n => mountedBefore.includes(n))).toBe(true); // no remount
  expect(within(visibleDialog()).getByRole('tab', { name: /Right — Survey/ })).toHaveAttribute('aria-selected', 'true');

  // The right tab carries a workspace dropdown on its right edge; opening it
  // lists every workspace — this side's flagged, the other side's disabled
  const rightDropdown = within(visibleDialog()).getByRole('button', { name: 'Choose the workspace shown on the right side' });
  fireEvent.click(rightDropdown);
  await tick();
  const menu = within(visibleDialog()).getByRole('listbox', { name: 'Workspaces' });
  expect(within(menu).getByRole('option', { name: /Survey/ })).toHaveAttribute('aria-selected', 'true');
  expect(within(menu).getByRole('option', { name: /Default/ })).toBeDisabled(); // shown on the left already

  // Choose Planning for the right side — URL follows (left stays Default)
  fireEvent.click(within(menu).getByRole('option', { name: /Planning/ }));
  await tick(2);
  expect(urlParams().get('workspaces')).toBe('default,ws-y');
});

test('closing a pane makes the other workspace the normal one', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  // Close the LEFT pane -> Survey (the other one) becomes the normal workspace
  fireEvent.click(screen.getByRole('button', { name: 'Close left side' }));
  await tick(3);

  expect(screen.queryByRole('separator')).toBeNull();
  expect(urlParams().get('split-screen')).toBeNull();
  expect(urlParams().get('ws')).toBe('ws-x');
  expect(registryInStorage().activeId).toBe('ws-x');
  fireEvent.click(screen.getByTitle('Settings'));
  expect(screen.getByRole('button', { name: /switch workspace — current: Survey/i })).toBeInTheDocument();
});

test('closing the right pane keeps the left workspace as the normal one', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByRole('button', { name: 'Close right side' }));
  await tick(3);

  expect(screen.queryByRole('separator')).toBeNull();
  expect(urlParams().get('ws')).toBe('default');
  expect(registryInStorage().activeId).toBe('default');
  expect(screen.getByTitle('Settings')).toBeInTheDocument();
});

test('split settings: workspace tabs, greyed drawing toggle, isolated base defaults', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByRole('button', { name: 'Split view settings' }));
  await tick();

  // A tab per side (labelled with its workspace), left one active by default
  const dlg = visibleDialog();
  expect(within(dlg).getByRole('tab', { name: /Left — Default/ })).toHaveAttribute('aria-selected', 'true');
  expect(within(dlg).getByRole('tab', { name: /Right — Survey/ })).toHaveAttribute('aria-selected', 'false');
  // Two tabs per dialog
  expect(dlg.querySelectorAll('.settings-split-tab')).toHaveLength(2);

  // Layer lists are available
  expect(within(dlg).getByText('Raster Layers')).toBeInTheDocument();
  expect(within(dlg).getByText('Vector Layers')).toBeInTheDocument();

  // Drawing Tool toggle is greyed out, off and disabled
  const drawToggle = dlg.querySelector('#draw-toolbar-toggle') as HTMLInputElement;
  expect(drawToggle.disabled).toBe(true);
  expect(drawToggle.checked).toBe(false);
  expect(drawToggle.closest('.settings-checkbox-row--disabled')).toBeTruthy();

  // Base settings use the split defaults (basemap + coords on, grid off),
  // not anything inherited from a workspace
  expect((dlg.querySelector('#basemap-toggle') as HTMLInputElement).checked).toBe(true);
  expect((dlg.querySelector('#coordinates-toggle') as HTMLInputElement).checked).toBe(true);
  expect((dlg.querySelector('#grid-toggle') as HTMLInputElement).checked).toBe(false);

  // The workspace selector is integrated into the side tabs (not the footer):
  // each tab has a workspace dropdown on its right edge
  expect(within(dlg).queryByRole('button', { name: /switch workspace/i })).toBeNull();
  const leftDropdown = within(dlg).getByRole('button', { name: 'Choose the workspace shown on the left side' });
  expect(within(dlg).getByRole('button', { name: 'Choose the workspace shown on the right side' })).toBeInTheDocument();
  fireEvent.click(leftDropdown);
  await tick();
  const wsMenu = within(dlg).getByRole('listbox', { name: 'Workspaces' });
  // This side's workspace is flagged, the other side's is disabled
  expect(within(wsMenu).getByRole('option', { name: /Default/ })).toHaveAttribute('aria-selected', 'true');
  expect(within(wsMenu).getByRole('option', { name: /Survey/ })).toBeDisabled();
  fireEvent.click(leftDropdown); // close the menu again
  await tick();

  // Lock button is present just like the normal view; Advanced Settings is
  // replaced by Exit Split Mode
  expect(within(dlg).getByRole('button', { name: 'Lock app' })).toBeInTheDocument();
  expect(within(dlg).getByRole('button', { name: 'Exit Split Mode' })).toBeInTheDocument();
  expect(within(dlg).queryByText('Advanced Settings')).toBeNull();

  // Switching tabs activates the other side's tab
  fireEvent.click(within(dlg).getByRole('tab', { name: /Right — Survey/ }));
  await tick();
  expect(within(visibleDialog()).getByRole('tab', { name: /Right — Survey/ })).toHaveAttribute('aria-selected', 'true');
});

test('Exit Split Mode returns to the normal view with the left workspace', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByRole('button', { name: 'Split view settings' }));
  await tick();
  fireEvent.click(within(visibleDialog()).getByRole('button', { name: 'Exit Split Mode' }));
  await tick(2);

  expect(screen.queryByRole('separator')).toBeNull();
  expect(urlParams().get('split-screen')).toBeNull();
  expect(urlParams().get('ws')).toBe('default');
  expect(registryInStorage().activeId).toBe('default');
});

test('split base settings toggles update the URL only — workspaces untouched', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByRole('button', { name: 'Split view settings' }));
  await tick();
  fireEvent.click(document.getElementById('basemap-toggle') as HTMLInputElement);
  fireEvent.click(document.getElementById('grid-toggle') as HTMLInputElement);
  fireEvent.click(document.getElementById('coordinates-toggle') as HTMLInputElement);
  await tick();

  expect(urlParams().get('basemap')).toBe('false');
  expect(urlParams().get('grid')).toBe('true');
  expect(urlParams().get('show_coord')).toBe('false');

  // show_coord=false hides the divider readout
  expect(document.querySelector('.mouse-coordinate-display')).toBeNull();

  // The workspace's own stored settings were NOT modified
  const saved = JSON.parse(localStorage.getItem('mapviewer-settings') || '{}');
  expect(saved.showBasemap).not.toBe(false);
  expect(saved.showGrid).not.toBe(true);
});

test('split base settings restore from the URL', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x&basemap=false&grid=true&show_coord=false');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  expect(document.querySelector('.mouse-coordinate-display')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Split view settings' }));
  await tick();
  expect((document.getElementById('basemap-toggle') as HTMLInputElement).checked).toBe(false);
  expect((document.getElementById('grid-toggle') as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById('coordinates-toggle') as HTMLInputElement).checked).toBe(false);
});

// --- split button right-click workspace picker -------------------------------

/** Opens Settings and right-clicks the split button; returns the picker menu. */
const openSplitPicker = async () => {
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Split screen' }));
  await tick();
  return screen.getByRole('dialog', { name: 'Choose split view workspaces' });
};

test('right-clicking the split button opens a picker; Apply enters split with the chosen pair', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(THREE_WORKSPACES));
  setUrl('');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  const menu = await openSplitPicker();
  expect(within(menu).getAllByRole('option')).toHaveLength(3);
  const apply = within(menu).getByRole('button', { name: 'Apply' });
  expect(apply).toBeDisabled(); // nothing picked yet

  // Pick Survey (left) then Planning (right) — badges show the assignment
  fireEvent.click(within(menu).getByRole('option', { name: /Survey/ }));
  fireEvent.click(within(menu).getByRole('option', { name: /Planning/ }));
  expect(within(menu).getByText('Left')).toBeInTheDocument();
  expect(within(menu).getByText('Right')).toBeInTheDocument();
  expect(apply).not.toBeDisabled();

  fireEvent.click(apply);
  await tick(3);

  expect(screen.getByRole('separator')).toBeInTheDocument();
  expect(urlParams().get('split-screen')).toBe('true');
  expect(urlParams().get('workspaces')).toBe('ws-x,ws-y'); // pick order kept
  expect(registryInStorage().activeId).toBe('ws-x'); // left pane is primary
});

test('the picker close button dismisses it without entering split mode', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  const menu = await openSplitPicker();
  fireEvent.click(within(menu).getByRole('button', { name: 'Close split view menu' }));
  await tick();

  expect(screen.queryByRole('dialog', { name: 'Choose split view workspaces' })).toBeNull();
  expect(screen.queryByRole('separator')).toBeNull(); // still normal mode
  expect(urlParams().get('split-screen')).toBeNull();
});

test('picking a third workspace replaces the earliest pick', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(THREE_WORKSPACES));
  setUrl('');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  const menu = await openSplitPicker();
  fireEvent.click(within(menu).getByRole('option', { name: /Default/ }));
  fireEvent.click(within(menu).getByRole('option', { name: /Survey/ }));
  fireEvent.click(within(menu).getByRole('option', { name: /Planning/ }));
  await tick();

  // Default dropped, Survey = Left, Planning = Right
  expect(within(menu).getByRole('option', { name: /Default/ })).toHaveAttribute('aria-selected', 'false');
  expect(within(menu).getByRole('option', { name: /Survey/ })).toHaveAttribute('aria-selected', 'true');
  expect(within(menu).getByRole('option', { name: /Planning/ })).toHaveAttribute('aria-selected', 'true');

  fireEvent.click(within(menu).getByRole('button', { name: 'Apply' }));
  await tick(3);
  expect(urlParams().get('workspaces')).toBe('ws-x,ws-y');
});

test('wheeling over the divider forwards the event to the map viewport (zoom)', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?split-screen=true&workspaces=default,ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  // The divider swallows the wheel; SplitScreen forwards a copy of the
  // event to the left map's OL viewport — both panes share one view, so OL's
  // native MouseWheelZoom zooms both sides, anchored at the cursor.
  const viewport = document.querySelector('.split-map-clip[data-split-side="left"] .ol-viewport');
  expect(viewport).toBeTruthy();
  const dispatchSpy = jest.spyOn(viewport as EventTarget, 'dispatchEvent');

  fireEvent.wheel(screen.getByRole('separator'), { deltaY: -120, clientX: 500, clientY: 400 });

  const forwarded = dispatchSpy.mock.calls
    .map(([ev]) => ev)
    .find(ev => ev.type === 'wheel') as WheelEvent | undefined;
  expect(forwarded).toBeTruthy();
  expect(forwarded!.deltaY).toBe(-120);
  expect(forwarded!.clientX).toBe(500);
  expect(forwarded!.clientY).toBe(400);
  dispatchSpy.mockRestore();
});
