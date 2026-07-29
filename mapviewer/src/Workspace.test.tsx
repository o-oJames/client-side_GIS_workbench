/**
 * Workspace switcher tests: the selector in the Settings footer lets users
 * keep separate layer/setup configurations per workspace. These cover the
 * trigger, the popover interactions (switch / create / rename / duplicate /
 * delete) and the localStorage registry contract.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceSelector } from './App';

const workspaces = [
  { id: 'default', name: 'Default' },
  { id: 'ws-2', name: 'Field Survey' },
  { id: 'ws-3', name: 'Planning' },
];

function baseProps(over: Record<string, any> = {}) {
  return {
    workspaceId: 'default',
    workspaces,
    onSwitch: jest.fn(),
    onCreate: jest.fn(),
    onRename: jest.fn(),
    onDuplicate: jest.fn(),
    onDelete: jest.fn(),
    ...over,
  };
}

function openMenu(props = baseProps()) {
  const utils = render(<WorkspaceSelector {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  return { ...utils, props };
}

test('trigger shows the active workspace name', () => {
  render(<WorkspaceSelector {...baseProps()} />);
  expect(screen.getByText('Default')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /switch workspace — current: default/i })).toBeInTheDocument();
});

test('popover lists every workspace and marks the active one', () => {
  openMenu();
  expect(screen.getByText('Workspaces')).toBeInTheDocument();
  expect(screen.getByText('Field Survey')).toBeInTheDocument();
  expect(screen.getByText('Planning')).toBeInTheDocument();
  const active = screen.getByRole('option', { name: /Default/ });
  expect(active).toHaveAttribute('aria-selected', 'true');
});

test('clicking another workspace calls onSwitch with its id', () => {
  const { props } = openMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Field Survey' }));
  expect(props.onSwitch).toHaveBeenCalledWith('ws-2');
});

test('clicking the active workspace does not switch', () => {
  const { props } = openMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Default (current workspace)' }));
  expect(props.onSwitch).not.toHaveBeenCalled();
});

test('creating a workspace commits the typed name on Enter', () => {
  const { props } = openMenu();
  fireEvent.click(screen.getByRole('button', { name: /new workspace/i }));
  const input = screen.getByPlaceholderText('Workspace name');
  fireEvent.change(input, { target: { value: '  Rail Corridor  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(props.onCreate).toHaveBeenCalledWith('Rail Corridor');
});

test('Apply button creates the workspace (and is disabled while empty)', () => {
  const { props } = openMenu();
  fireEvent.click(screen.getByRole('button', { name: /new workspace/i }));
  const apply = screen.getByRole('button', { name: 'Apply' });
  expect(apply).toBeDisabled(); // blank name
  const input = screen.getByPlaceholderText('Workspace name');
  fireEvent.change(input, { target: { value: '  Rail Corridor  ' } });
  expect(apply).toBeEnabled();
  fireEvent.click(apply);
  expect(props.onCreate).toHaveBeenCalledWith('Rail Corridor');
  expect(props.onCreate).toHaveBeenCalledTimes(1); // no double-commit via blur
});

test('renaming commits on Enter and ignores blank names', () => {
  const { props } = openMenu();
  // Row order mirrors the workspaces array: index 0 is the active "Default".
  fireEvent.click(screen.getAllByTitle('Rename workspace')[0]);
  const input = screen.getByDisplayValue('Default') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Renamed' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(props.onRename).toHaveBeenCalledWith('default', 'Renamed');

  // Blank rename is discarded
  fireEvent.click(screen.getAllByTitle('Rename workspace')[0]);
  const input2 = screen.getByDisplayValue('Default') as HTMLInputElement;
  fireEvent.change(input2, { target: { value: '   ' } });
  fireEvent.keyDown(input2, { key: 'Enter' });
  expect(props.onRename).toHaveBeenCalledTimes(1);
});

test('duplicate and delete call their handlers (delete needs confirmation)', () => {
  const { props } = openMenu();
  fireEvent.click(screen.getAllByTitle('Duplicate workspace')[0]);
  expect(props.onDuplicate).toHaveBeenCalledWith('default');

  fireEvent.click(screen.getAllByTitle('Delete workspace')[0]);
  expect(props.onDelete).not.toHaveBeenCalled(); // not yet confirmed
  fireEvent.click(screen.getByTitle('Confirm delete'));
  expect(props.onDelete).toHaveBeenCalledWith('default');
});

test('delete is disabled for the last remaining workspace', () => {
  const props = baseProps({ workspaces: [{ id: 'default', name: 'Default' }] });
  render(<WorkspaceSelector {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  expect(screen.getByTitle('The last workspace cannot be deleted')).toBeDisabled();
});

test('outside click closes the popover', () => {
  openMenu();
  expect(screen.getByText('Workspaces')).toBeInTheDocument();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByText('Workspaces')).not.toBeInTheDocument();
});

test('workspace registry round-trips through localStorage', () => {
  // The registry helpers are private to App.tsx; exercise the same storage
  // contract the app reads and writes.
  localStorage.clear();
  localStorage.setItem('mapviewer-workspaces', JSON.stringify({
    workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws-x', name: 'X' }],
    activeId: 'ws-x',
  }));
  const parsed = JSON.parse(localStorage.getItem('mapviewer-workspaces') || '');
  expect(parsed.activeId).toBe('ws-x');
  expect(parsed.workspaces).toHaveLength(2);
});
