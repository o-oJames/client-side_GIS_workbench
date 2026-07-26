/**
 * Wiring tests for layer-group drag & drop in the settings panel.
 *
 * jsdom can't initiate native drags, so these fire the drag events the
 * browser would and assert the dialog calls the reorder callbacks with
 * correctly moved layer arrays. Dragover targets get a mocked
 * getBoundingClientRect and events carry clientY, because placement is
 * anchored to the pointer's half of the hovered element (top -> before,
 * bottom -> after) - that anchoring is what keeps live reordering stable.
 */
import React from 'react';
import { render, fireEvent, createEvent } from '@testing-library/react';
import { SettingsDialog } from './App';

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

const lastCallArg = (fn: jest.Mock) => fn.mock.calls[fn.mock.calls.length - 1][0];
/**
 * jsdom's DragEvent constructor ignores MouseEvent init like clientY, so
 * define it on the event directly - dropPlace() reads it off the event.
 */
function dragOverAt(el: Element, clientY: number) {
  const ev = createEvent.dragOver(el);
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, ev);
}


/** Give an element a layout box so dropPlace() can read pointer halves. */
function withRect(el: Element, top: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }),
  });
  return el;
}

test('dragging a group over a row: bottom half lands AFTER the row', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'Layer B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'Layer C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const header = container.querySelector('.settings-group-header')!;
  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowC = withRect(rows.find(r => r.textContent?.includes('Layer C'))!, 200, 40);

  fireEvent.dragStart(header);
  dragOverAt(rowC, 230); // bottom half

  expect(onReorder).toHaveBeenCalled();
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['c', 'a', 'b']);
});

test('dragging a group over a row: top half lands BEFORE the row', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'c', name: 'Layer C', type: 'xyz', url: 'u' },
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'Layer B', type: 'xyz', url: 'u', groupId: 'g1' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const header = container.querySelector('.settings-group-header')!;
  const rowC = withRect(Array.from(container.querySelectorAll('.settings-layer-item')).find(r => r.textContent?.includes('Layer C'))!, 0, 40);

  fireEvent.dragStart(header);
  dragOverAt(rowC, 10); // top half

  expect(onReorder).toHaveBeenCalled();
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['a', 'b', 'c']);
});

test('dragging a group over another group header respects the pointer half', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'Layer B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'Layer C', type: 'xyz', url: 'u' },
    { id: 'd', name: 'Layer D', type: 'xyz', url: 'u', groupId: 'g2' },
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: true },
  ];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const headers = Array.from(container.querySelectorAll('.settings-group-header'));
  const g1 = withRect(headers.find(h => h.textContent?.includes('Group 1'))!, 0, 36);
  const g2 = withRect(headers.find(h => h.textContent?.includes('Group 2'))!, 300, 36);

  // g2 dragged onto g1's TOP half -> before g1
  fireEvent.dragStart(g2);
  dragOverAt(g1, 10);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['d', 'a', 'b', 'c']);

  // g1 dragged onto g2's BOTTOM half -> after g2
  fireEvent.dragStart(g1);
  dragOverAt(g2, 330);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['c', 'd', 'a', 'b']);
});

test('dragging an ungrouped layer onto a group header joins that group', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'Layer B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'Layer C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const rowC = rows.find(r => r.textContent?.includes('Layer C'))!;
  const g1 = withRect(container.querySelector('.settings-group-header')!, 0, 36);

  fireEvent.dragStart(rowC);
  dragOverAt(g1, 18);

  expect(onReorder).toHaveBeenCalled();
  const arg = lastCallArg(onReorder);
  expect(arg.map((l: RL) => l.id)).toEqual(['a', 'b', 'c']);
  expect(arg.find((l: RL) => l.id === 'c').groupId).toBe('g1');
});

test('a COLLAPSED group is draggable and reorders (regression)', () => {
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'b', name: 'Layer B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'c', name: 'Layer C', type: 'xyz', url: 'u' },
  ];
  const rasterGroups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: false }];
  const { container } = render(<SettingsDialog {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  expect(container.querySelectorAll('.settings-layer-item').length).toBe(1);
  const header = container.querySelector('.settings-group-header')!;
  expect(header.getAttribute('draggable')).toBe('true');

  const rowC = withRect(container.querySelector('.settings-layer-item')!, 60, 40);
  fireEvent.dragStart(header);
  dragOverAt(rowC, 90); // bottom half -> after C

  expect(onReorder).toHaveBeenCalled();
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['c', 'a', 'b']);
});

test('OSCILLATION REGRESSION: repeated dragovers at the same pointer position are no-ops', () => {
  // The old direction-inferred logic flipped the order on every dragover when
  // the pointer stayed over the target after a swap (short group over a tall
  // one), so collapsed groups could never be moved. Pointer-anchored
  // placement must settle after a single move.
  const onReorder = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' }, // tall group
    { id: 'b', name: 'Layer B', type: 'xyz', url: 'u', groupId: 'g1' },
    { id: 'd', name: 'Layer D', type: 'xyz', url: 'u', groupId: 'g2' }, // short group
  ];
  const rasterGroups: LG[] = [
    { id: 'g1', name: 'Group 1', expanded: true },
    { id: 'g2', name: 'Group 2', expanded: false },
  ];
  // Stateful harness: like the real app, a reorder feeds the new layer
  // order back into the dialog, which is what makes the next dragover at
  // the same pointer position a no-op.
  function Harness(props: any) {
    const [layers, setLayers] = React.useState<RL[]>(props.rasterLayers);
    return (
      <SettingsDialog
        {...props}
        rasterLayers={layers}
        onReorderRasterLayers={(next: RL[]) => { props.onReorderRasterLayers(next); setLayers(next); }}
      />
    );
  }
  const { container } = render(<Harness {...baseProps({ rasterLayers, rasterGroups, onReorderRasterLayers: onReorder })} />);

  const headers = Array.from(container.querySelectorAll('.settings-group-header'));
  const g1 = withRect(headers.find(h => h.textContent?.includes('Group 1'))!, 0, 120);
  const g2 = withRect(headers.find(h => h.textContent?.includes('Group 2'))!, 120, 36);

  // Drag the short collapsed group up into g1's TOP half...
  fireEvent.dragStart(g2);
  dragOverAt(g1, 20);
  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(lastCallArg(onReorder).map((l: RL) => l.id)).toEqual(['d', 'a', 'b']);

  // ...then simulate the browser firing dragover again and again at the same
  // pointer position (the rect mock is static, like the pointer "staying put").
  for (let i = 0; i < 10; i++) dragOverAt(g1, 20);
  expect(onReorder).toHaveBeenCalledTimes(1); // no flip-flopping
});

test('group eye toggle and chevron collapse call the group callbacks', () => {
  const onToggleGroup = jest.fn();
  const onUpdateGroups = jest.fn();
  const rasterLayers: RL[] = [
    { id: 'a', name: 'Layer A', type: 'xyz', url: 'u', groupId: 'g1' },
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
