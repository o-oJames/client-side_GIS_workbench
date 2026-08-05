/**
 * Raster layer edit-form behaviour in the settings panel.
 *
 * Apply must commit the edits AND close the inline editor (returning the
 * row to the collapsed layer row) — previously it committed but left the
 * form open until the whole settings dialog was closed. Cancel must close
 * the editor and revert the live-applied changes (color adjustments).
 */
import { render, fireEvent } from '@testing-library/react';
import { SettingsDialog } from './App';

type RL = { id: string; name: string; type: 'xyz'; url: string; visible?: boolean };

function baseProps(over: Record<string, any> = {}) {
  return {
    onClose: () => {}, pinned: false, onPinToggle: () => {},
    showBasemap: true, onBasemapToggle: () => {},
    showGrid: false, onGridToggle: () => {},
    showDrawToolbar: true, onDrawToolbarToggle: () => {},
    showCoordinates: true, onCoordinatesToggle: () => {},
    rasterLayers: [] as RL[],
    rasterGroups: [] as any[],
    onUpdateRasterGroups: () => {}, onToggleRasterGroup: () => {}, onMoveRasterLayerToGroup: () => {},
    onAddRasterLayer: async () => {}, onEditRasterLayer: () => {}, onRemoveRasterLayer: () => {}, onToggleRasterLayer: () => {},
    onApplyColorAdjustments: () => {}, onApplyTileZoomRange: () => {},
    vectorLayers: [] as any[],
    vectorGroups: [] as any[],
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

const LAYER: RL = { id: 'r1', name: 'OSM', type: 'xyz', url: 'https://tiles.example.com/{z}/{x}/{y}.png' };
const FILE_COG_LAYER = {
  id: 'c1', name: 'aerial', type: 'cog' as const, url: 'blob:http://localhost:3000/abc-123',
  cogSource: 'file' as const, cogFileName: 'aerial.tif',
};

function renderDialog(over: Record<string, any> = {}) {
  const props = baseProps({ rasterLayers: [LAYER], ...over });
  const utils = render(<SettingsDialog {...(props as any)} />);
  return { ...utils, props };
}

/** Open the inline editor for the (single) raster layer row. */
function openEditor(container: HTMLElement) {
  const editBtn = container.querySelector('.settings-layer-edit') as HTMLButtonElement;
  expect(editBtn).toBeTruthy();
  fireEvent.click(editBtn);
}

const editForm = (container: HTMLElement) =>
  container.querySelector('.settings-add-form') as HTMLElement | null;

describe('SettingsDialog raster layer edit form', () => {
  test('Apply commits the edits and closes the editor', () => {
    const onEditRasterLayer = jest.fn();
    const { container } = renderDialog({ onEditRasterLayer });

    openEditor(container);
    expect(editForm(container)).toBeTruthy();

    const nameInput = editForm(container)!.querySelector('input[placeholder="Layer name"]') as HTMLInputElement;
    const urlInput = editForm(container)!.querySelectorAll('input[placeholder="XYZ URL"]')[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed tiles' } });
    fireEvent.change(urlInput, { target: { value: 'https://tiles.example.com/v2/{z}/{x}/{y}.png' } });

    const applyBtn = Array.from(editForm(container)!.querySelectorAll('button'))
      .find(b => b.textContent === 'Apply') as HTMLButtonElement;
    fireEvent.click(applyBtn);

    // Committed with the edited values
    expect(onEditRasterLayer).toHaveBeenCalledTimes(1);
    expect(onEditRasterLayer.mock.calls[0][0]).toMatchObject({
      id: 'r1',
      name: 'Renamed tiles',
      url: 'https://tiles.example.com/v2/{z}/{x}/{y}.png',
    });
    // ...and the editor is closed without needing to close the dialog
    expect(editForm(container)).toBeNull();
    expect(container.querySelector('.settings-layer-item')).toBeTruthy();
  });

  test('Apply with an empty name keeps the editor open and does not commit', () => {
    const onEditRasterLayer = jest.fn();
    const { container } = renderDialog({ onEditRasterLayer });

    openEditor(container);
    const nameInput = editForm(container)!.querySelector('input[placeholder="Layer name"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '   ' } });

    const applyBtn = Array.from(editForm(container)!.querySelectorAll('button'))
      .find(b => b.textContent === 'Apply') as HTMLButtonElement;
    fireEvent.click(applyBtn);

    expect(onEditRasterLayer).not.toHaveBeenCalled();
    expect(editForm(container)).toBeTruthy();
  });

  test('file-based COG: Apply keeps the session blob URL and hides it from the form', () => {
    const onEditRasterLayer = jest.fn();
    const { container } = renderDialog({ rasterLayers: [FILE_COG_LAYER], onEditRasterLayer });

    openEditor(container);
    const form = editForm(container)!;

    // The opaque blob URL is not editable; a read-only file row is shown
    expect(form.querySelector('input[placeholder="XYZ URL"]')).toBeNull();
    expect(form.textContent).toContain('aerial.tif');

    const nameInput = form.querySelector('input[placeholder="Layer name"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Aerial 2024' } });
    const applyBtn = Array.from(form.querySelectorAll('button'))
      .find(b => b.textContent === 'Apply') as HTMLButtonElement;
    fireEvent.click(applyBtn);

    expect(onEditRasterLayer).toHaveBeenCalledTimes(1);
    expect(onEditRasterLayer.mock.calls[0][0]).toMatchObject({
      id: 'c1',
      name: 'Aerial 2024',
      url: 'blob:http://localhost:3000/abc-123',
      cogSource: 'file',
    });
    expect(editForm(container)).toBeNull();
  });

  test('Cancel closes the editor, reverts live color adjustments, and does not commit', () => {
    const onEditRasterLayer = jest.fn();
    const onApplyColorAdjustments = jest.fn();
    const { container } = renderDialog({ onEditRasterLayer, onApplyColorAdjustments });

    openEditor(container);
    const form = editForm(container)!;

    // Expand the colors panel and live-apply a brightness change
    fireEvent.click(form.querySelector('.color-adjust-toggle') as HTMLButtonElement);
    const brightnessSlider = form.querySelectorAll('input[type="range"]')[0] as HTMLInputElement;
    fireEvent.change(brightnessSlider, { target: { value: '150' } });
    expect(onApplyColorAdjustments).toHaveBeenLastCalledWith('r1', expect.objectContaining({ brightness: 150 }));

    const cancelBtn = Array.from(form.querySelectorAll('button'))
      .find(b => b.textContent === 'Cancel') as HTMLButtonElement;
    fireEvent.click(cancelBtn);

    // Reverted to the original adjustments, editor closed, nothing committed
    expect(onApplyColorAdjustments).toHaveBeenLastCalledWith('r1', { brightness: 100, saturation: 100, contrast: 100, opacity: 100 });
    expect(onEditRasterLayer).not.toHaveBeenCalled();
    expect(editForm(container)).toBeNull();
  });
});
