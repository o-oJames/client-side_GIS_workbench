/**
 * Wiring tests for layer-group drag & drop in the settings panel.
 *
 * Groups own their order: the groups array decides the panel order (groups
 * first, ungrouped layers after), so dragging a group reorders that array -
 * which works for EMPTY groups too. jsdom can't initiate native drags, so
 * these fire the drag events the browser would (with mocked layout boxes and
 * explicit clientY, since placement reads the pointer's half of the target).
 */
import React from 'react';
import { render, fireEvent, createEvent, act } from '@testing-library/react';
import { SettingsDialog, toggleGroupLayerVisibility } from './App';

type RL = { id: string; name: string; type: 'xyz'; url: string; visible?: boolean; groupId?: string };
type LG = { id: string; name: string; expanded: boolean };

function baseProps(over: Record<string, any> = {}) {
  return {
    onClose: () => {}, pinned: false, onPinToggle: () => {},
    showBasemap: true, onBasemapToggle: () => {},
    showGrid: false, onGridToggle: () => {},
    showDrawToolbar: true, onDrawToolbarToggle: () => {},
    showCoordinates: true, onCoordinatesToggle: () => {},
    rasterLayers: [] as RL[],
    rasterGroups: [] as LG[],
    onUpdateRasterGroups: () => {}, onToggleRasterGroup: () => {}, onMoveRasterLayerToGroup: () => {},
    onAddRasterLayer: async () => {}, onEditRasterLayer: () => {}, onRemoveRasterLayer: () => {}, onToggleRasterLayer: () => {},
    onApplyColorAdjustments: () => {}, onApplyTileZoomRange: () => {},
    vectorLayers: [] as any[],
    vectorGroups: [] as LG[],
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
    onDuplicateWorkspace: () => {}, onDeleteWorkspace: () => {}, onLockApp: () => {},
    hasLockPassword: false, onSetPassword: () => {}, onResetPassword: () => {},
    ...over,
  };
}

/** Stateful harness: like the app, reorders feed back into the dialog. */
function Harness(props: any) {
  const [layers, setLayers] = React.useState<RL[]>(props.rasterLayers);
  const [groups, setGroups] = React.useState<LG[]>(props.rasterGroups);
  return (
    <SettingsDialog
      {...props}
      rasterLayers={layers}
      rasterGroups={groups}
      onReorderRasterLayers={(next: RL[]) => { props.onReorderRasterLayers(next); setLayers(next); }}
      onUpdateRasterGroups={(next: LG[]) => { props.onUpdateRasterGroups(next); setGroups(next); }}
    />
  );
}

const lastCallArg = (fn: jest.Mock) => fn.mock.calls[fn.mock.calls.length - 1][0];
/** Group AND layer dragstart defer their state update one tick (Chrome fix) -
 * wait for it inside act() so React flushes the resulting render. */
const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};


/** Give an element a layout box so dropPlace() can read pointer halves. */
function withRect(el: Element, top: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }),
  });
  return el;
}

/** jsdom's DragEvent ignores clientY init - define it on the event directly. */
function dragOverAt(el: Element, clientY: number) {
  const ev = createEvent.dragOver(el);
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, ev);
}

/** Drop with an explicit clientY - group-header drops are half-sensitive. */
function dropAt(el: Element, clientY: number) {
  const ev = createEvent.drop(el);
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, ev);
}

const headerOf = (container: HTMLElement, name: string) =>
  withRect(
    Array.from(container.querySelectorAll('.settings-group-header')).find(h => h.textContent?.includes(name))!,
    0, 36
  );

test('dragging a group onto another group: top half -> before, bottom half -> after', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: true },
  ];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const g1 = headerOf(container, 'Group 1');
  const g2 = headerOf(container, 'Group 2');

  // g2 onto g1's TOP half -> g2's members move to the front
  fireEvent.dragStart(g2);
  await tick();
  dragOverAt(g1, 10);
  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['c', 'a', 'b']);

  // now drag g1 onto g2's TOP half -> back to [a, b, c]
  fireEvent.dragStart(g1);
  await tick();
  dragOverAt(g2, 5);
  expect(onReorder).toHaveBeenCalledTimes(2);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['a', 'b', 'c']);
});

test('EMPTY groups are reorderable via an afterId anchor', async () => {
  const onUpdate = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'online data', expanded: false },
    { id: 'g2', name: 'New group', expanded: false },
    { id: 'g3', name: '3', expanded: false }, // EMPTY
  ];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onUpdateRasterGroups: onUpdate })} />);

  const g1 = headerOf(container, 'online data');
  const g3 = headerOf(container, '3');

  // Drag the empty group "3" to the top of the list -> afterId = null (top).
  fireEvent.dragStart(g3);
  await tick();
  dragOverAt(g1, 10);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  const groups = lastCallArg(onUpdate);
  expect(groups.find((g: LG & { afterId?: string | null }) => g.id === 'g3').afterId).toBeNull();
});

test('groups and individual layers interleave: group can move below or above a layer', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'd', name: 'D', type: 'xyz', url: 'u' }, // ungrouped, below the group
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: false }];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const g1 = headerOf(container, 'Group 1');
  const rowD = withRect(
    Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('D'))!,
    200, 40
  );

  // Drag the group onto row D's BOTTOM half -> [D, group1] (group below layer)
  fireEvent.dragStart(g1);
  await tick();
  dragOverAt(rowD, 230);
  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['d', 'a', 'b']);

  // And back up: TOP half -> [group1, D]
  fireEvent.dragStart(g1);
  await tick();
  dragOverAt(rowD, 205);
  expect(onReorder).toHaveBeenCalledTimes(2);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['a', 'b', 'd']);
});

test('OSCILLATION REGRESSION: repeated dragovers at the same pointer position are no-ops', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: false },
  ];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const g1 = headerOf(container, 'Group 1');
  const g2 = headerOf(container, 'Group 2');

  fireEvent.dragStart(g2);
  await tick();
  dragOverAt(g1, 10); // top half -> g2's members to the front: [c, a]
  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['c', 'a']);

  for (let i = 0; i < 10; i++) dragOverAt(g1, 10);
  expect(onReorder).toHaveBeenCalledTimes(1); // no flip-flopping
});

test('dropping a layer on a group header places it ABOVE the group (takes the group\'s place)', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rowC = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C'))!;
  const g1 = headerOf(container, 'Group 1');

  // Hovering the header must NOT reorder live - the drop decides.
  fireEvent.dragStart(rowC);
  await tick();
  dragOverAt(g1, 18);
  expect(onReorder).not.toHaveBeenCalled();

  // The group is already expanded (not hover-expanded), so releasing anywhere
  // on its header drops the layer in ABOVE the group (it takes the group's place).
  dropAt(g1, 18);
  expect(onReorder).toHaveBeenCalledTimes(1);
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['c', 'a', 'b']);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBeUndefined(); // ungrouped, above the group
});

test('hovering a collapsed group ~300ms then dropping on its header joins the folder\'s END', () => {
  jest.useFakeTimers();
  try {
    const onReorder = jest.fn();
    const rasterLayers: RL[] = [
      { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
      { id: 'c', name: 'C', type: 'xyz', url: 'u' },
    ];
    const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: false }];
    const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

    const rowC = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C'))!;
    const g1 = headerOf(container, 'Group 1');

    fireEvent.dragStart(rowC);
    act(() => { jest.advanceTimersByTime(1); }); // flush the deferred dragstart state
    dragOverAt(g1, 18); // arms the 300ms hover-expand
    act(() => { jest.advanceTimersByTime(300); }); // group auto-expands + flags hover-expanded

    // Dropping on the header right after the hover-expand joins the folder's end.
    dropAt(headerOf(container, 'Group 1'), 18);
    expect(onReorder).toHaveBeenCalled();
    const arg = lastCallArg(onReorder);
    expect(arg.map((l: RL) => l.id)).toEqual(['a', 'c']);
    expect(arg.find((l: RL) => l.id === 'c').groupId).toBe('g1');
  } finally {
    jest.useRealTimers();
  }
});

test('a free layer can be dragged PAST a group\'s members to the end strip (cross-parent join is drop-only)', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowC = rows.find(r => r.textContent?.includes('C'))!;
  const rowA = withRect(rows.find(r => r.textContent?.includes('A'))!, 60, 40);

  fireEvent.dragStart(rowC);
  await tick();
  // Dragging over member A only highlights it - it must NOT join live (which
  // used to reparent the drag source row and kill the drag mid-gesture).
  dragOverAt(rowA, 70);
  expect(onReorder).not.toHaveBeenCalled();

  // Continuing on to the end-of-list strip drops C below the whole group.
  const strip = container.querySelector('.settings-group-dropzone')!;
  fireEvent.dragOver(strip);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['a', 'b', 'c']);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBeUndefined(); // ungrouped, below the group
});

test('hovering a collapsed group ~300ms while dragging expands it', () => {
  jest.useFakeTimers();
  try {
    const onUpdate = jest.fn();
    const rasterLayers: RL[] = [
      { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
      { id: 'c', name: 'C', type: 'xyz', url: 'u' },
    ];
    const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: false }];
    const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onUpdateRasterGroups: onUpdate })} />);

    const rowC = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C'))!;
    const g1 = headerOf(container, 'Group 1');

    fireEvent.dragStart(rowC);
    // dragstart defers its state update; under fake timers flush it explicitly
    // so the layer drag is active before the hover-expand timer is armed.
    act(() => { jest.advanceTimersByTime(1); });
    dragOverAt(g1, 18);
    expect(onUpdate).not.toHaveBeenCalled(); // not before the 300ms

    act(() => { jest.advanceTimersByTime(200); });
    expect(onUpdate).not.toHaveBeenCalled(); // still not at 200ms

    act(() => { jest.advanceTimersByTime(150); });
    expect(onUpdate).toHaveBeenCalledWith([expect.objectContaining({ id: 'g1', expanded: true })]);
  } finally {
    jest.useRealTimers();
  }
});

test('dropping onto a grouped row joins that group at the pointer position', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'd', name: 'D', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowD = rows.find(r => r.textContent?.includes('D'))!;
  const rowA = withRect(rows.find(r => r.textContent?.includes('A'))!, 60, 40);

  // Top half of member A -> D joins g1 as its FIRST member (commits on drop).
  fireEvent.dragStart(rowD);
  await tick();
  dragOverAt(rowA, 70);
  expect(onReorder).not.toHaveBeenCalled(); // highlight only, no live join
  dropAt(rowA, 70);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['d', 'a', 'b']);
  expect(arg.find((l: RL) => l.id === 'd').groupId).toBe('g1');
});

test('dropping onto another group\'s row moves the layer between groups', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: true },
  ];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowC = rows.find(r => r.textContent?.includes('C'))!;
  const rowA = withRect(rows.find(r => r.textContent?.includes('A'))!, 60, 40);

  fireEvent.dragStart(rowC);
  await tick();
  dragOverAt(rowA, 90); // bottom half of A -> after A, inside g1
  expect(onReorder).not.toHaveBeenCalled(); // highlight only, no live join
  dropAt(rowA, 90);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['a', 'c']);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBe('g1');
});

test('dragging a grouped layer out of its group ungroups it', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'd', name: 'D', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowA = rows.find(r => r.textContent?.includes('A'))!;
  const rowD = withRect(rows.find(r => r.textContent?.includes('D'))!, 200, 40);

  fireEvent.dragStart(rowA);
  await tick();
  dragOverAt(rowD, 230); // bottom half of D
  expect(onReorder).not.toHaveBeenCalled(); // highlight only, no live move
  dropAt(rowD, 230);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['b', 'd', 'a']);
  expect(arg.find((l: RL) => l.id === 'a').groupId).toBeUndefined(); // ungrouped
  expect(arg.find((l: RL) => l.id === 'b').groupId).toBe('g1');      // B stays
});

test('dropping a layer on the end-of-list strip places it below everything (e.g. under a last group)', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: false }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rowC = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C'))!;
  fireEvent.dragStart(rowC);
  await tick();

  // The strip appears during a layer drag; dropping there -> end of list.
  const strip = container.querySelector('.settings-group-dropzone')!;
  expect(strip.textContent).toContain('Drop layer at the end');
  fireEvent.dragOver(strip);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['a', 'b', 'c']);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBeUndefined();
});

test('dropping a layer on the section title moves it to the very top (and ungroups)', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  // Drag grouped layer B onto the Raster Layers section title.
  const rowB = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('B'))!;
  const titleRow = container.querySelector('.settings-section-title-row')!;
  fireEvent.dragStart(rowB);
  await tick();
  fireEvent.dragOver(titleRow);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['b', 'a', 'c']);
  expect(arg.find((l: RL) => l.id === 'b').groupId).toBeUndefined(); // ungrouped
  expect(arg.find((l: RL) => l.id === 'a').groupId).toBe('g1');      // A stays
});

test('reordering within the same group keeps membership', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowA = rows.find(r => r.textContent?.includes('A'))!;
  const rowB = withRect(rows.find(r => r.textContent?.includes('B'))!, 100, 40);

  fireEvent.dragStart(rowA);
  await tick();
  dragOverAt(rowB, 130);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['b', 'a']);
  expect(arg.every((l: RL) => l.groupId === 'g1')).toBe(true);
});

test('layer row is NOT stuck greyed after being dragged out of its group (dragend lost on reparent)', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rowA = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('A')) as HTMLElement;
  fireEvent.dragStart(rowA);
  await tick();
  expect(rowA.style.opacity).toBe('0.5'); // dimmed while dragging

  // Drop below ungrouped row C -> A leaves g1 (commits on drop); the dialog
  // clears the drag state so the row is not left greyed.
  const rowC = withRect(
    Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C'))!,
    200, 40
  );
  dragOverAt(rowC, 230);
  expect(onReorder).not.toHaveBeenCalled(); // highlight only before the drop
  dropAt(rowC, 230);
  expect(onReorder).toHaveBeenCalled();

  const rowANow = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('A')) as HTMLElement;
  expect(rowANow.style.opacity).toBe('1'); // not stuck greyed
});

test('layer dragstart defers its state update so the source row is not mutated mid-dragstart (Chrome drag-cancel fix)', async () => {
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u' },
  ];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers })} />);

  const rowA = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('A')) as HTMLElement;
  fireEvent.dragStart(rowA);
  // Synchronously after dragstart the row must NOT yet be dimmed: React must
  // not mutate the drag source during the dragstart event, or Chrome cancels
  // the session. The dimming only lands one tick later.
  expect(rowA.style.opacity).toBe('1');
  await tick();
  expect(rowA.style.opacity).toBe('0.5');
});

test('group toggle remembers each layer\'s individual visibility across off -> on', () => {
  type TL = { id: string; groupId?: string; visible?: boolean; groupHiddenVisible?: boolean };
  const layers: TL[] = [
    { id: 'a', groupId: 'g1', visible: true },
    { id: 'b', groupId: 'g1', visible: false }, // individually hidden
    { id: 'c', visible: true },                 // ungrouped: never touched
  ];

  // Some visible -> hide all, remembering a=true, b=false.
  const hidden = toggleGroupLayerVisibility(layers, 'g1');
  expect(hidden.map(l => l.visible)).toEqual([false, false, true]);
  expect(hidden.find(l => l.id === 'a')!.groupHiddenVisible).toBe(true);
  expect(hidden.find(l => l.id === 'b')!.groupHiddenVisible).toBe(false);

  // All hidden -> restore the remembered individual states (b stays hidden).
  const restored = toggleGroupLayerVisibility(hidden, 'g1');
  expect(restored.map(l => l.visible)).toEqual([true, false, true]);
  expect(restored.find(l => l.id === 'a')!.groupHiddenVisible).toBeUndefined();
  expect(restored.find(l => l.id === 'b')!.groupHiddenVisible).toBeUndefined();

  // All visible -> hide all again (remembers the current true/true... b=false).
  const hidden2 = toggleGroupLayerVisibility(restored, 'g1');
  expect(hidden2.map(l => l.visible)).toEqual([false, false, true]);
  expect(hidden2.find(l => l.id === 'b')!.groupHiddenVisible).toBe(false);
});

test('group eye toggle and chevron collapse call the group callbacks', () => {
  const onToggleGroup = jest.fn();
  const onUpdateGroups = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({
    rasterLayers, rasterGroups, onToggleRasterGroup: onToggleGroup, onUpdateRasterGroups: onUpdateGroups,
  })} />);

  const header = container.querySelector('.settings-group-header')!;
  fireEvent.click(header.querySelector('.settings-layer-visibility')!);
  expect(onToggleGroup).toHaveBeenCalledWith('g1');

  fireEvent.click(header.querySelector('.settings-group-chevron')!);
  expect(onUpdateGroups).toHaveBeenCalledWith([{ id: 'g1', name: 'Group 1', expanded: false }]);
});

test('dropping a layer onto the expanded children area of an EMPTY group joins it (hover-expand dead-zone fix)', () => {
  jest.useFakeTimers();
  try {
    const onReorder = jest.fn();
    const onMoveToGroup = jest.fn();
    const rasterLayers: RL[] = [
      { id: 'layer1', name: 'Layer 1', type: 'xyz', url: 'u' },
    ];
    const rasterGroups: LG[] = [{ id: 'folder1', name: 'Folder', expanded: false }];
    const { container } = render(<Harness {...baseProps({
      rasterLayers, rasterGroups,
      onReorderRasterLayers: onReorder,
      onMoveRasterLayerToGroup: onMoveToGroup,
    })} />);

    const row = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('Layer 1'))!;
    const header = headerOf(container, 'Folder');

    // Start dragging layer1
    fireEvent.dragStart(row);
    act(() => { jest.advanceTimersByTime(1); }); // flush deferred dragstart

    // Hover the collapsed folder header -> arms the 300ms expand timer
    dragOverAt(header, 18);
    act(() => { jest.advanceTimersByTime(300); }); // folder auto-expands

    // After expansion the children area is visible. Simulate the pointer
    // moving down into it (the dead zone that previously had no handlers).
    const childrenArea = container.querySelector('.settings-group-children')!;
    expect(childrenArea).toBeTruthy();
    fireEvent.dragOver(childrenArea);

    // Drop onto the children area -> layer joins the empty group
    fireEvent.drop(childrenArea);
    expect(onMoveToGroup).toHaveBeenCalledWith('layer1', 'folder1');
  } finally {
    jest.useRealTimers();
  }
});

test('dropping a layer onto the children area of a NON-EMPTY group joins it at the end', async () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rowC = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C'))!;
  fireEvent.dragStart(rowC);
  await tick(); // flush the deferred dragstart state

  // Drag over the children area (between/after member rows)
  const childrenArea = container.querySelector('.settings-group-children')!;
  fireEvent.dragOver(childrenArea);

  // Drop -> C joins g1 at the end
  fireEvent.drop(childrenArea);
  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['a', 'b', 'c']);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBe('g1');
});

test('BUG1: dragging the only layer below an empty folder re-anchors the folder above it', async () => {
  const onReorder = jest.fn();
  const onUpdateGroups = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'layer1', name: 'Layer 1', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'folder1', name: 'Folder', expanded: false }];
  const { container } = render(<Harness {...baseProps({
    rasterLayers, rasterGroups,
    onReorderRasterLayers: onReorder,
    onUpdateRasterGroups: onUpdateGroups,
  })} />);

  const row = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('Layer 1'))!;
  fireEvent.dragStart(row);
  await tick();

  // Drop on the end-of-list strip (below the empty folder)
  const strip = container.querySelector('.settings-group-dropzone')!;
  fireEvent.dragOver(strip);

  // The flat array doesn't change (only one layer), but the folder's
  // afterId must be updated to null (top) so the panel becomes
  // [folder(empty), layer1].
  expect(onUpdateGroups).toHaveBeenCalled();
  const groups = lastCallArg(onUpdateGroups);
  expect(groups.find((g: LG & { afterId?: string | null }) => g.id === 'folder1').afterId).toBeNull();
});

test('BUG2: dragging the last member out of a folder keeps the empty folder in place', async () => {
  const onReorder = jest.fn();
  const onUpdateGroups = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'layer1', name: 'Layer 1', type: 'xyz', url: 'u' },
    { id: 'layer2', name: 'Layer 2', type: 'xyz', url: 'u', groupId: 'folder1' },
  ];
  const rasterGroups: LG[] = [{ id: 'folder1', name: 'Folder', expanded: true }];
  const { container } = render(<Harness {...baseProps({
    rasterLayers, rasterGroups,
    onReorderRasterLayers: onReorder,
    onUpdateRasterGroups: onUpdateGroups,
  })} />);

  // Drag layer2 (inside folder) onto layer1's bottom half -> layer2 leaves
  // the folder and lands after layer1.
  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowLayer2 = rows.find(r => r.textContent?.includes('Layer 2'))!;
  const rowLayer1 = withRect(rows.find(r => r.textContent?.includes('Layer 1'))!, 0, 40);

  fireEvent.dragStart(rowLayer2);
  await tick();
  dragOverAt(rowLayer1, 30); // bottom half -> after layer1
  dropAt(rowLayer1, 30);

  // layer2 is now ungrouped, after layer1
  expect(onReorder).toHaveBeenCalled();
  const layers = lastCallArg(onReorder);
  expect(layers.map((l: RL) => l.id)).toEqual(['layer1', 'layer2']);
  expect(layers.find((l: RL) => l.id === 'layer2').groupId).toBeUndefined();

  // The empty folder must be anchored after layer2 (its former member) so
  // the panel reads [layer1, layer2, folder(empty)] - the folder stays at
  // the end where it was before the member was dragged out.
  expect(onUpdateGroups).toHaveBeenCalled();
  const groups = lastCallArg(onUpdateGroups);
  expect(groups.find((g: LG & { afterId?: string | null }) => g.id === 'folder1').afterId).toBe('layer2');
});
