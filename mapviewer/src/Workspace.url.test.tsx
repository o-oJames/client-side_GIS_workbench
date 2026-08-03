/**
 * URL <-> workspace sync: the address bar always carries a ?ws=<id> param
 * reflecting the active workspace, a ?ws= deep link activates the named
 * workspace on load, and every switch/create/delete keeps the URL in step.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import View from 'ol/View.js';
import { fromLonLat } from 'ol/proj.js';
import App from './App';
import {
  resolveActiveWorkspaceFromUrl,
  loadWorkspaceRegistryFromUrl,
  setWorkspaceUrlParam,
  updateUrlParams,
} from './utils/workspaceStorage';

/** Let pending promises + the async layer-restore effect settle inside act(). */
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

const TWO_WORKSPACES = {
  workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws-x', name: 'Survey' }],
  activeId: 'default',
};

beforeEach(() => {
  localStorage.clear();
  setUrl('');
});

// --- pure helpers ------------------------------------------------------------

test('resolveActiveWorkspaceFromUrl honours a valid ?ws= deep link', () => {
  setUrl('?ws=ws-x');
  const resolved = resolveActiveWorkspaceFromUrl(TWO_WORKSPACES as any);
  expect(resolved.activeId).toBe('ws-x');
});

test('resolveActiveWorkspaceFromUrl ignores unknown ids and missing params', () => {
  setUrl('?ws=nope');
  expect(resolveActiveWorkspaceFromUrl(TWO_WORKSPACES as any)).toBe(TWO_WORKSPACES);
  setUrl('');
  expect(resolveActiveWorkspaceFromUrl(TWO_WORKSPACES as any)).toBe(TWO_WORKSPACES);
});

test('loadWorkspaceRegistryFromUrl persists the deep-linked workspace', () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?ws=ws-x');
  const registry = loadWorkspaceRegistryFromUrl();
  expect(registry.activeId).toBe('ws-x');
  expect(registryInStorage().activeId).toBe('ws-x');
});

test('setWorkspaceUrlParam writes ?ws= and strips stale view params', () => {
  setUrl('?ws=old&lat=1&lng=2&z=3');
  setWorkspaceUrlParam('ws-x');
  const params = urlParams();
  expect(params.get('ws')).toBe('ws-x');
  expect(params.get('lat')).toBeNull();
  expect(params.get('lng')).toBeNull();
  expect(params.get('z')).toBeNull();
});

test('updateUrlParams keeps ws alongside the view params', () => {
  const view = new View({ center: fromLonLat([138.6, -34.9]), zoom: 10 });
  updateUrlParams(view, 'ws-x');
  const params = urlParams();
  expect(params.get('ws')).toBe('ws-x');
  expect(parseFloat(params.get('lng') || '')).toBeCloseTo(138.6, 3);
  expect(parseFloat(params.get('lat') || '')).toBeCloseTo(-34.9, 3);
  expect(params.get('z')).toBe('10');
});

// --- app integration -----------------------------------------------------------

test('a ?ws= deep link activates the named workspace and persists it', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?ws=ws-x');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByTitle('Settings'));
  expect(screen.getByRole('button', { name: /switch workspace — current: Survey/i })).toBeInTheDocument();
  expect(registryInStorage().activeId).toBe('ws-x');
});

test('an unknown ?ws= falls back to the persisted workspace and repairs the URL', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify({ ...TWO_WORKSPACES, activeId: 'ws-x' }));
  setUrl('?ws=missing');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByTitle('Settings'));
  expect(screen.getByRole('button', { name: /switch workspace — current: Survey/i })).toBeInTheDocument();
  expect(urlParams().get('ws')).toBe('ws-x');
});

test('loading without ?ws= fills the URL from the active workspace', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);
  expect(urlParams().get('ws')).toBe('default');
});

test('switching workspaces updates the URL immediately', async () => {
  localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
  setUrl('?ws=default&lat=1.00000&lng=2.00000&z=3');
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick(3);

  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Survey' }));

  // The handler rewrites the URL synchronously, before the map remounts:
  // the new workspace id is in place and the old workspace's view is gone.
  expect(urlParams().get('ws')).toBe('ws-x');
  expect(urlParams().get('lat')).toBeNull();

  await tick(3);
  expect(urlParams().get('ws')).toBe('ws-x');
  expect(registryInStorage().activeId).toBe('ws-x');
});
