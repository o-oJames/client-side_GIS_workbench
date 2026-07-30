import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

/** Let the async layer-restore effect settle inside act(). */
const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};

beforeEach(() => {
  localStorage.clear();
});

test('redirects to /map and renders the map page shell', async () => {
  render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
  await tick();
  // The map page exposes the Settings gear button once mounted.
  expect(screen.getByTitle('Settings')).toBeInTheDocument();
});

test('creates, switches and persists workspaces from the Settings footer', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  // Open Settings, then the workspace popover in its footer.
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  expect(screen.getByRole('button', { name: 'Default (current workspace)' })).toBeInTheDocument();

  // Create a second workspace.
  fireEvent.click(screen.getByRole('button', { name: /new workspace/i }));
  fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Survey' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await tick(); // MapPage remounts onto the fresh workspace

  const registry = () => JSON.parse(localStorage.getItem('mapviewer-workspaces') || '');
  expect(registry().workspaces.map((w: any) => w.name)).toEqual(['Default', 'Survey']);
  expect(registry().workspaces.find((w: any) => w.name === 'Survey').id).toBe(registry().activeId);

  // Re-open Settings: the trigger now carries the new workspace's name.
  fireEvent.click(screen.getByTitle('Settings'));
  expect(screen.getByRole('button', { name: /switch workspace — current: Survey/i })).toBeInTheDocument();

  // Switch back to Default and confirm the registry follows.
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Default' }));
  await tick();
  expect(registry().activeId).toBe('default');
});
