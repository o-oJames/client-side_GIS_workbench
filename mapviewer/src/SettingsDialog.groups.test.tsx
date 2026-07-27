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
    onApplyVectorStyle: () => {}, onApplyVectorZoomRange: () => {}, onApplyVectorFeatureStyle: () => {},
    onReorderRasterLayers: () => {}, onReorderVectorLayers: () => {},
    onAddVectorLayer: async () => {}, onAddMVTLayer: async () => {}, onAddWFSLayer: async () => {}, onAddSTACLayer: async () => {},
    onExportVectorLayer: () => {}, onReeditVectorLayer: () => {}, editingVectorLayerId: null,
    onGoToVectorLayerExtent: () => {}, onGoToRasterLayerExtent: () => {},
    onAdvancedSettings: () => {}, knownSources: [], isRestoringLayers: false,
    loadingVectorIds: new Set<string>(), units: 'metric' as const,
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
/** The group dragstart defers its state update one tick (Chrome fix) - wait
 * for it inside act() so React flushes the resulting render. */
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

const headerOf = (container: HTMLElement, name: string) =>
  withRect(
    Array.from(container.querySelectorAll('.settings-group-header')).find(h => h.textContent?.includes(name))!,
    0, 36
  );

test('dragging a group onto another group: top half -> before, bottom half -> after', async () => {
  const onUpdate = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: true },
  ];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onUpdateRasterGroups: onUpdate })} />);

  const g1 = headerOf(container, 'Group 1');
  const g2 = headerOf(container, 'Group 2');

  // g2 onto g1's TOP half -> before g1
  fireEvent.dragStart(g2);
  await tick();
  dragOverAt(g1, 10);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onUpdate).map((g: LG) => g.id)).toEqual(['g2', 'g1']);

  // now g1 (rendered second) onto g2's BOTTOM half -> after g2 => back to [g2, g1]... 
  // from [g2, g1]: drag g1 onto g2 bottom half -> after -> [g2, g1] no-op; onto TOP -> before -> [g1, g2]
  fireEvent.dragStart(g1);
  await tick();
  dragOverAt(g2, 5);
  expect(onUpdate).toHaveBeenCalledTimes(2);
  expect(lastCallArg(onUpdate).map((g: LG) => g.id)).toEqual(['g1', 'g2']);
});

test('EMPTY groups are reorderable (regression: group "3" with 0 members would not move)', async () => {
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

  // Drag the empty group "3" to the top of the list.
  fireEvent.dragStart(g3);
  await tick();
  dragOverAt(g1, 10); // top half of first group
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onUpdate).map((g: LG) => g.id)).toEqual(['g3', 'g1', 'g2']);
});

test('dragging a group over an ungrouped row sends it to the end of the group section', async () => {
  const onUpdate = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
    { id: 'd', name: 'D', type: 'xyz', url: 'u' }, // ungrouped
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: false },
    { id: 'g2', name: 'Group 2', expanded: false },
  ];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onUpdateRasterGroups: onUpdate })} />);

  const g1 = headerOf(container, 'Group 1');
  const rowD = withRect(
    Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('D'))!,
    200, 40
  );

  fireEvent.dragStart(g1);
  await tick();
  dragOverAt(rowD, 220);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onUpdate).map((g: LG) => g.id)).toEqual(['g2', 'g1']);
});

test('OSCILLATION REGRESSION: repeated dragovers at the same pointer position are no-ops', async () => {
  const onUpdate = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: false },
  ];
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onUpdateRasterGroups: onUpdate })} />);

  const g1 = headerOf(container, 'Group 1');
  const g2 = headerOf(container, 'Group 2');

  fireEvent.dragStart(g2);
  await tick();
  dragOverAt(g1, 10); // top half -> [g2, g1]
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onUpdate).map((g: LG) => g.id)).toEqual(['g2', 'g1']);

  for (let i = 0; i < 10; i++) dragOverAt(g1, 10);
  expect(onUpdate).toHaveBeenCalledTimes(1); // no flip-flopping
});

test('dragging an ungrouped layer onto a group header joins that group', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowC = rows.find(r => r.textContent?.includes('C'))!;
  const g1 = headerOf(container, 'Group 1');

  fireEvent.dragStart(rowC);
  dragOverAt(g1, 18);

  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBe('g1');
});

test('layer row is NOT stuck greyed after drag-joining a group (dragend lost on reparent)', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rowC = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C')) as HTMLElement;
  fireEvent.dragStart(rowC);
  expect(rowC.style.opacity).toBe('0.5'); // dimmed while dragging

  // Drop onto the group header -> C joins g1. Its row is reparented into the
  // group children (new DOM node), so the browser dragend is lost; the
  // dialog must clear the dragged state itself.
  const g1 = headerOf(container, 'Group 1');
  dragOverAt(g1, 18);
  expect(onReorder).toHaveBeenCalled();

  const rowCNow = Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('C')) as HTMLElement;
  expect(rowCNow.style.opacity).toBe('1'); // not stuck greyed
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
