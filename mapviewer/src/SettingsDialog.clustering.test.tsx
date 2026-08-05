/**
 * Point-clustering option in the vector layer edit menu.
 *
 * The checkbox should only be offered for point datasets: enabled for pure
 * point layers, disabled (with a hint) when the layer mixes in other geometry
 * types, and hidden entirely for tiled (MVT) layers. Toggling it reports the
 * choice through onApplyVectorCluster so the map can wrap/unwrap the Cluster
 * source.
 */
import { render, fireEvent } from '@testing-library/react';
import { SettingsDialog } from './App';

const pointGeom = { getType: () => 'Point' };
const lineGeom = { getType: () => 'LineString' };
const feat = (geom: any) => ({ getGeometry: () => geom, getStyle: () => null });

function mockOlLayer(features: any[]) {
  const source = { getFeatures: () => features };
  return { getSource: () => source };
}

function vectorLayer(id: string, features: any[], extra: Record<string, any> = {}) {
  return {
    id,
    name: id,
    type: 'geojson',
    visible: true,
    opacity: 100,
    olLayer: mockOlLayer(features),
    ...extra,
  };
}

function baseProps(over: Record<string, any> = {}) {
  return {
    onClose: () => {}, pinned: false, onPinToggle: () => {},
    showBasemap: true, onBasemapToggle: () => {},
    showGrid: false, onGridToggle: () => {},
    showDrawToolbar: true, onDrawToolbarToggle: () => {},
    showCoordinates: true, onCoordinatesToggle: () => {},
    rasterLayers: [] as any[],
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

function openEdit(getByTitle: (t: string) => HTMLElement) {
  fireEvent.click(getByTitle('Edit layer'));
}

test('offers an enabled Point clustering checkbox for a pure point layer', () => {
  const onApplyVectorCluster = jest.fn();
  const layer = vectorLayer('pts', [feat(pointGeom), feat(pointGeom), feat(pointGeom)]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorCluster })} />
  );

  openEdit(getByTitle);

  const checkbox = container.querySelector('.settings-cluster-checkbox input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox).not.toBeNull();
  expect(checkbox.disabled).toBe(false);
  expect(checkbox.checked).toBe(false);

  // The point count badge reflects the dataset size.
  expect(container.querySelector('.settings-cluster-count')?.textContent).toContain('3');

  // Enabling clustering reports the choice (default 40px distance).
  fireEvent.click(checkbox);
  expect(onApplyVectorCluster).toHaveBeenCalledWith('pts', true, 40);

  // A distance slider appears once clustering is on.
  const slider = container.querySelector('.settings-cluster-control input[type="range"]') as HTMLInputElement;
  expect(slider).not.toBeNull();
  fireEvent.change(slider, { target: { value: '60' } });
  expect(onApplyVectorCluster).toHaveBeenLastCalledWith('pts', true, 60);
});

test('disables clustering for a layer with no point features', () => {
  const layer = vectorLayer('lines', [feat(lineGeom), feat(lineGeom)]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );

  openEdit(getByTitle);

  const checkbox = container.querySelector('.settings-cluster-checkbox input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox).not.toBeNull();
  expect(checkbox.disabled).toBe(true);
  expect(container.querySelector('.settings-cluster-control')).toHaveClass('disabled');
});

test('disables clustering for a mixed point + line layer', () => {
  const layer = vectorLayer('mixed', [feat(pointGeom), feat(lineGeom)]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );

  openEdit(getByTitle);

  const checkbox = container.querySelector('.settings-cluster-checkbox input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
});

test('does not offer clustering for MVT (tiled) layers', () => {
  const layer = vectorLayer('tiles', [feat(pointGeom)], { type: 'mvt', url: 'http://example.com/{z}/{x}/{y}.pbf' });
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );

  openEdit(getByTitle);

  expect(container.querySelector('.settings-cluster-checkbox')).toBeNull();
});

test('restores the persisted clustering state when opening the edit menu', () => {
  const layer = vectorLayer('pts', [feat(pointGeom), feat(pointGeom)], { clusterPoints: true, clusterDistance: 55 });
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );

  openEdit(getByTitle);

  const checkbox = container.querySelector('.settings-cluster-checkbox input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  const slider = container.querySelector('.settings-cluster-control input[type="range"]') as HTMLInputElement;
  expect(slider.value).toBe('55');
});
