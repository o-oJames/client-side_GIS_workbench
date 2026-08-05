/**
 * Parity tests for layer-row drag & drop reordering: raster vs vector.
 *
 * These pin the behaviour of the raster row drag handlers
 * (handleRasterDragStart / handleRasterDragOver / handleRasterRowDrop /
 * handleRasterDragEnd) and their vector twins, plus handleSectionDragOver
 * and the end-of-list drop strip (handleRasterListDragOver /
 * handleVectorListDragOver), ahead of unifying both kinds into a shared
 * useLayerDragReorder hook. Every scenario is written TWICE - once per
 * kind - with identical expectations; any asymmetry found is documented
 * below, not fixed here.
 *
 * Group-level behaviour (group-header reorder, hover-expand timing,
 * empty-group drops, BUG1/BUG2 anchor cases) is pinned in
 * SettingsDialog.groups.test.tsx and is deliberately NOT repeated here.
 *
 * jsdom cannot initiate native drags, so rows are given layout boxes
 * (withRect) and dragStart/dragOver/drop events are fired explicitly with
 * a defined clientY, because dropPlace() reads the pointer's half of the
 * target row (top 50% -> insert before, bottom 50% -> insert after).
 *
 * Observed raster-vs-vector differences (documented, not fixed):
 *  1. DnD logic is structurally identical: mirrored handlers, same helper
 *     calls (dropPlace/moveLayerToSlot/moveLayerToJoinAt/syncGroupAnchors),
 *     same selectors (.settings-layer-item rows, .settings-group-dropzone
 *     strip, .settings-section-title-row), same callback shapes
 *     (onReorder*Layers(next[]), onUpdate*Groups(next[])).
 *  2. Row drop joins a group via onReorder*Layers with the adopted
 *     groupId - onMove*LayerToGroup is NOT called on the drag path (it is
 *     the folder-menu / empty-group-header / empty-children-area callback
 *     only). Identical for both kinds.
 *  3. dragSessionRef is a SINGLE ref shared by raster and vector layer
 *     drags (and group-header drags): interleaving two drags of different
 *     kinds within one tick would veto the deferred dragstart state
 *     update. Latent coupling only - the UI allows one drag at a time.
 *  4. Row drops where dragged.groupId === target.groupId early-return
 *     WITHOUT clearing drag state; cleanup relies on the native dragend
 *     that jsdom never fires, so these tests fire it manually.
 *  5. Cosmetic only: the row 'layer-off' class condition differs (raster
 *     `visible === false`, vector `visible !== true`), and the vector
 *     section renders a placeholder instead of a list when it has no
 *     layers AND no groups (the raster list always renders).
 */
import React from 'react';
import { render, fireEvent, createEvent, act } from '@testing-library/react';
import { SettingsDialog } from './App';

type LG = { id: string; name: string; expanded: boolean };
type AnyLayer = {
  id: string;
  name: string;
  type: string;
  url?: string;
  visible?: boolean;
  groupId?: string;
};
type Kind = 'raster' | 'vector';

function baseProps(over: Record<string, any> = {}) {
  return {
    onClose: () => {}, pinned: false, onPinToggle: () => {},
    showBasemap: true, onBasemapToggle: () => {},
    showGrid: false, onGridToggle: () => {},
    showDrawToolbar: true, onDrawToolbarToggle: () => {},
    showCoordinates: true, onCoordinatesToggle: () => {},
    rasterLayers: [] as AnyLayer[],
    rasterGroups: [] as LG[],
    onUpdateRasterGroups: () => {}, onToggleRasterGroup: () => {}, onMoveRasterLayerToGroup: () => {},
    onAddRasterLayer: async () => {}, onEditRasterLayer: () => {}, onRemoveRasterLayer: () => {}, onToggleRasterLayer: () => {},
    onApplyColorAdjustments: () => {}, onApplyTileZoomRange: () => {},
    vectorLayers: [] as AnyLayer[],
    vectorGroups: [] as LG[],
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
    onDuplicateWorkspace: () => {}, onDeleteWorkspace: () => {}, onLockApp: () => {},
    hasLockPassword: false, onSetPassword: () => {}, onResetPassword: () => {},
    ...over,
  };
}

/** Stateful harness: like the app, reorders and group updates feed back
 * into the dialog - for BOTH kinds, so the same harness serves parity. */
function Harness(props: any) {
  const [raster, setRaster] = React.useState<AnyLayer[]>(props.rasterLayers);
  const [rasterGroups, setRasterGroups] = React.useState<LG[]>(props.rasterGroups);
  const [vector, setVector] = React.useState<AnyLayer[]>(props.vectorLayers);
  const [vectorGroups, setVectorGroups] = React.useState<LG[]>(props.vectorGroups);
  return (
    <SettingsDialog
      {...props}
      rasterLayers={raster}
      rasterGroups={rasterGroups}
      vectorLayers={vector}
      vectorGroups={vectorGroups}
      onReorderRasterLayers={(next: AnyLayer[]) => { props.onReorderRasterLayers(next); setRaster(next); }}
      onUpdateRasterGroups={(next: LG[]) => { props.onUpdateRasterGroups(next); setRasterGroups(next); }}
      onReorderVectorLayers={(next: AnyLayer[]) => { props.onReorderVectorLayers(next); setVector(next); }}
      onUpdateVectorGroups={(next: LG[]) => { props.onUpdateVectorGroups(next); setVectorGroups(next); }}
    />
  );
}

const lastCallArg = (fn: jest.Mock) => fn.mock.calls[fn.mock.calls.length - 1][0];
/** Layer dragstart defers its state update one tick (Chrome fix) - wait
 * for it inside act() so React flushes the resulting render. */
const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};

/** Give an element a layout box so dropPlace() can read pointer halves. */
function withRect(el: HTMLElement, top: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }),
  });
  return el;
}

/** jsdom's DragEvent ignores clientY init - define it on the event directly. */
function dragOverAt(el: HTMLElement, clientY: number) {
  const ev = createEvent.dragOver(el);
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, ev);
}

/** Drop with an explicit clientY - row drops are half-sensitive. */
function dropAt(el: HTMLElement, clientY: number) {
  const ev = createEvent.drop(el);
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, ev);
}

const rowOf = (container: HTMLElement, name: string): HTMLElement =>
  Array.from(container.querySelectorAll<HTMLElement>('.settings-layer-item'))
    .find(r => (r.textContent || '').includes(name))!;

/** There are TWO section title rows (raster + vector) - pick by text. */
const sectionTitleOf = (container: HTMLElement, kind: Kind): HTMLElement =>
  Array.from(container.querySelectorAll<HTMLElement>('.settings-section-title-row'))
    .find(el => (el.textContent || '').includes(kind === 'raster' ? 'Raster Layers' : 'Vector Layers'))!;

const endStripOf = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>('.settings-group-dropzone')!;

const ids = (layers: AnyLayer[]) => layers.map(l => l.id);

const REORDER_PROP: Record<Kind, string> = {
  raster: 'onReorderRasterLayers',
  vector: 'onReorderVectorLayers',
};
const MOVE_PROP: Record<Kind, string> = {
  raster: 'onMoveRasterLayerToGroup',
  vector: 'onMoveVectorLayerToGroup',
};
const UPDATE_GROUPS_PROP: Record<Kind, string> = {
  raster: 'onUpdateRasterGroups',
  vector: 'onUpdateVectorGroups',
};

(['raster', 'vector'] as Kind[]).forEach(kind => {
  describe(kind + ' layer row drag & drop', () => {
    const mkLayer = (id: string, name: string, groupId?: string): AnyLayer =>
      kind === 'raster'
        ? { id, name, type: 'xyz', url: 'u', groupId }
        : { id, name, type: 'geojson', visible: true, groupId };

    const layersProps = (layers: AnyLayer[], groups: LG[]): Record<string, any> =>
      kind === 'raster'
        ? { rasterLayers: layers, rasterGroups: groups }
        : { vectorLayers: layers, vectorGroups: groups };

    test('flat reorder upward: drag C onto the TOP half of A -> onReorder([C, A, B])', async () => {
      const onReorder = jest.fn();
      const layers = [mkLayer('a', 'A'), mkLayer('b', 'B'), mkLayer('c', 'C')];
      const over: Record<string, any> = { ...layersProps(layers, []) };
      over[REORDER_PROP[kind]] = onReorder;
      const { container } = render(<Harness {...baseProps(over)} />);

      const rowC = rowOf(container, 'C');
      const rowA = withRect(rowOf(container, 'A'), 60, 40); // mid = 80

      fireEvent.dragStart(rowC);
      await tick();
      dragOverAt(rowA, 70); // top half -> insert before A (live on dragover)

      expect(onReorder).toHaveBeenCalledTimes(1);
      expect(ids(lastCallArg(onReorder))).toEqual(['c', 'a', 'b']);
    });

    test('flat reorder downward: drag A onto the BOTTOM half of C -> onReorder([B, C, A])', async () => {
      const onReorder = jest.fn();
      const layers = [mkLayer('a', 'A'), mkLayer('b', 'B'), mkLayer('c', 'C')];
      const over: Record<string, any> = { ...layersProps(layers, []) };
      over[REORDER_PROP[kind]] = onReorder;
      const { container } = render(<Harness {...baseProps(over)} />);

      const rowA = rowOf(container, 'A');
      const rowC = withRect(rowOf(container, 'C'), 140, 40); // mid = 160

      fireEvent.dragStart(rowA);
      await tick();
      dragOverAt(rowC, 170); // bottom half -> insert after C (live on dragover)

      expect(onReorder).toHaveBeenCalledTimes(1);
      expect(ids(lastCallArg(onReorder))).toEqual(['b', 'c', 'a']);
    });

    test('dropPlace() boundary: clientY exactly at row midpoint inserts BEFORE, just below it inserts AFTER', async () => {
      // dropPlace: clientY > rect.top + rect.height / 2 -> 'after', else
      // 'before'. The midpoint itself therefore belongs to the TOP half.
      const layers = [mkLayer('a', 'A'), mkLayer('b', 'B'), mkLayer('c', 'C')];

      // clientY === top + height/2 (100 + 20) -> 'before' -> [C, A, B]
      const onReorder1 = jest.fn();
      const over1: Record<string, any> = { ...layersProps(layers, []) };
      over1[REORDER_PROP[kind]] = onReorder1;
      const r1 = render(<Harness {...baseProps(over1)} />);
      fireEvent.dragStart(rowOf(r1.container, 'C'));
      await tick();
      dragOverAt(withRect(rowOf(r1.container, 'A'), 100, 40), 120); // exactly mid
      expect(ids(lastCallArg(onReorder1))).toEqual(['c', 'a', 'b']);

      // clientY one px below the midpoint -> 'after' -> [A, C, B]
      const onReorder2 = jest.fn();
      const over2: Record<string, any> = { ...layersProps(layers, []) };
      over2[REORDER_PROP[kind]] = onReorder2;
      const r2 = render(<Harness {...baseProps(over2)} />);
      fireEvent.dragStart(rowOf(r2.container, 'C'));
      await tick();
      dragOverAt(withRect(rowOf(r2.container, 'A'), 100, 40), 121); // just below mid
      expect(ids(lastCallArg(onReorder2))).toEqual(['a', 'c', 'b']);
    });

    test('dragover/drop onto the row itself is a no-op (no reorder callback)', async () => {
      const onReorder = jest.fn();
      const layers = [mkLayer('a', 'A'), mkLayer('b', 'B'), mkLayer('c', 'C')];
      const over: Record<string, any> = { ...layersProps(layers, []) };
      over[REORDER_PROP[kind]] = onReorder;
      const { container } = render(<Harness {...baseProps(over)} />);

      const rowA = withRect(rowOf(container, 'A'), 60, 40); // mid = 80

      fireEvent.dragStart(rowA);
      await tick();
      expect(rowA.style.opacity).toBe('0.5'); // drag is active

      // Both halves of the dragged row itself: handlers bail on self-target.
      dragOverAt(rowA, 70);
      dragOverAt(rowA, 90);
      dropAt(rowA, 70);
      dropAt(rowA, 90);
      expect(onReorder).not.toHaveBeenCalled();

      // The row-drop handler early-returns on self without clearing drag
      // state; in a real browser the native dragend does that (jsdom never
      // fires it, so fire it manually - see parity note 4 in the header).
      fireEvent.dragEnd(rowA);
      expect(rowA.style.opacity).toBe('1');
    });

    test('dropping an ungrouped layer onto a grouped row joins that group at the pointer position (top & bottom half)', async () => {
      const groups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
      const makeLayers = () => [
        mkLayer('a', 'A', 'g1'),
        mkLayer('b', 'B', 'g1'),
        mkLayer('d', 'D'),
      ];

      // --- TOP half of member A -> D joins g1 as its FIRST member -------
      const onReorder1 = jest.fn();
      const onMove1 = jest.fn();
      const onUpdate1 = jest.fn();
      const over1: Record<string, any> = { ...layersProps(makeLayers(), groups) };
      over1[REORDER_PROP[kind]] = onReorder1;
      over1[MOVE_PROP[kind]] = onMove1;
      over1[UPDATE_GROUPS_PROP[kind]] = onUpdate1;
      const r1 = render(<Harness {...baseProps(over1)} />);

      const rowD = rowOf(r1.container, 'D');
      const rowA = withRect(rowOf(r1.container, 'A'), 60, 40); // mid = 80

      fireEvent.dragStart(rowD);
      await tick();
      dragOverAt(rowA, 70); // cross-parent: highlight only, commits on drop
      expect(onReorder1).not.toHaveBeenCalled();
      // The cue lands on the group header: the dragover bubbles from the
      // member row to the children area, whose markGroupDragOver clears
      // the row-level cue (identical for both kinds).
      const header1 = r1.container.querySelector('.settings-group-header')!;
      expect(header1.className).toContain('drag-over');

      dropAt(rowA, 70);
      expect(onReorder1).toHaveBeenCalledTimes(1);
      const arg1 = lastCallArg(onReorder1);
      expect(ids(arg1)).toEqual(['d', 'a', 'b']);
      expect(arg1.find((l: AnyLayer) => l.id === 'd').groupId).toBe('g1');
      // Drag-join commits via onReorder*Layers, NOT onMove*LayerToGroup
      // (parity note 2); no group was emptied, so no anchor update either.
      expect(onMove1).not.toHaveBeenCalled();
      expect(onUpdate1).not.toHaveBeenCalled();

      // --- BOTTOM half of member A -> D joins g1 right AFTER A ----------
      const onReorder2 = jest.fn();
      const over2: Record<string, any> = { ...layersProps(makeLayers(), groups) };
      over2[REORDER_PROP[kind]] = onReorder2;
      const r2 = render(<Harness {...baseProps(over2)} />);

      const rowD2 = rowOf(r2.container, 'D');
      const rowA2 = withRect(rowOf(r2.container, 'A'), 60, 40); // mid = 80

      fireEvent.dragStart(rowD2);
      await tick();
      dragOverAt(rowA2, 90); // bottom half -> after A
      expect(onReorder2).not.toHaveBeenCalled(); // highlight only
      dropAt(rowA2, 90);
      expect(onReorder2).toHaveBeenCalledTimes(1);
      const arg2 = lastCallArg(onReorder2);
      expect(ids(arg2)).toEqual(['a', 'd', 'b']);
      expect(arg2.find((l: AnyLayer) => l.id === 'd').groupId).toBe('g1');
    });

    test('dragging a grouped layer onto the section title ungroups it and moves it to the TOP', async () => {
      const onReorder = jest.fn();
      const groups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: true }];
      const layers = [
        mkLayer('a', 'A', 'g1'),
        mkLayer('b', 'B', 'g1'),
        mkLayer('c', 'C'),
      ];
      const over: Record<string, any> = { ...layersProps(layers, groups) };
      over[REORDER_PROP[kind]] = onReorder;
      const { container } = render(<Harness {...baseProps(over)} />);

      const rowB = rowOf(container, 'B');
      const titleRow = sectionTitleOf(container, kind);

      fireEvent.dragStart(rowB);
      await tick();
      // The end-of-list strip is up while the drag is pending...
      expect(endStripOf(container).textContent).toContain('Drop layer at the end');

      // Dragover on the section title moves LIVE: to the top, ungrouped.
      fireEvent.dragOver(titleRow);
      expect(onReorder).toHaveBeenCalledTimes(1);
      const arg = lastCallArg(onReorder);
      expect(ids(arg)).toEqual(['b', 'a', 'c']);
      expect(arg.find((l: AnyLayer) => l.id === 'b').groupId).toBeUndefined();
      expect(arg.find((l: AnyLayer) => l.id === 'a').groupId).toBe('g1'); // A stays

      // ...and because the layer reparented out of its group, the handler
      // cleared the drag state itself: the strip is gone without a drop.
      expect(container.querySelector('.settings-group-dropzone')).toBeNull();
    });

    test('dragging onto the end-of-list strip moves the layer below everything (incl. a trailing group)', async () => {
      const onReorder = jest.fn();
      const groups: LG[] = [{ id: 'g1', name: 'Group 1', expanded: false }];
      const layers = [
        mkLayer('c', 'C'),
        mkLayer('a', 'A', 'g1'),
        mkLayer('b', 'B', 'g1'),
      ];
      const over: Record<string, any> = { ...layersProps(layers, groups) };
      over[REORDER_PROP[kind]] = onReorder;
      const { container } = render(<Harness {...baseProps(over)} />);

      const rowC = rowOf(container, 'C');
      fireEvent.dragStart(rowC);
      await tick();

      // The strip appears during a layer drag; the move commits LIVE on the
      // strip's dragOver (its onDrop only preventDefaults) - same for both
      // kinds.
      const strip = endStripOf(container);
      expect(strip.textContent).toContain('Drop layer at the end');
      fireEvent.dragOver(strip);

      expect(onReorder).toHaveBeenCalledTimes(1);
      const arg = lastCallArg(onReorder);
      expect(ids(arg)).toEqual(['a', 'b', 'c']);
      expect(arg.find((l: AnyLayer) => l.id === 'c').groupId).toBeUndefined(); // ungrouped, below the group
    });

    test('dragend without a drop resets drag state; the next drag reorders cleanly', async () => {
      const onReorder = jest.fn();
      const layers = [mkLayer('a', 'A'), mkLayer('b', 'B'), mkLayer('c', 'C')];
      const over: Record<string, any> = { ...layersProps(layers, []) };
      over[REORDER_PROP[kind]] = onReorder;
      const { container } = render(<Harness {...baseProps(over)} />);

      const rowA = withRect(rowOf(container, 'A'), 60, 40);
      const rowB = withRect(rowOf(container, 'B'), 100, 40); // mid = 120
      const rowC = withRect(rowOf(container, 'C'), 140, 40); // mid = 160

      // First drag: live-reorder A in front of C, then CANCEL (no drop).
      fireEvent.dragStart(rowA);
      await tick();
      expect(rowA.style.opacity).toBe('0.5');
      expect(container.querySelector('.settings-group-dropzone')).not.toBeNull();
      dragOverAt(rowC, 150); // top half of C -> [B, A, C]
      expect(onReorder).toHaveBeenCalledTimes(1);
      expect(ids(lastCallArg(onReorder))).toEqual(['b', 'a', 'c']);

      fireEvent.dragEnd(rowA);
      expect(rowA.style.opacity).toBe('1'); // not stuck dimmed
      expect(container.querySelector('.settings-group-dropzone')).toBeNull();

      // Second drag on ANOTHER row starts from a clean slate.
      fireEvent.dragStart(rowC);
      await tick();
      expect(rowC.style.opacity).toBe('0.5');
      dragOverAt(rowB, 110); // top half of B -> [C, B, A]
      expect(onReorder).toHaveBeenCalledTimes(2);
      expect(ids(lastCallArg(onReorder))).toEqual(['c', 'b', 'a']);
    });
  });
});
