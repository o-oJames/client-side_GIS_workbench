/**
 * Geometry-editing entry points for vector layers in the edit form.
 *
 * File-imported layers (geojson/kml/kmz/shapefile) are editable in place
 * like drawn-in-app layers: the edit form offers a geometry edit button
 * (which starts a re-edit session on the layer) and the Download menu.
 * Drawn layers keep their "Re-edit layer" wording plus the per-feature
 * draw-style section, which stays drawn-only. Remote layers (mvt/wfs/stac)
 * offer neither — their features are re-fetched on restore, so edits could
 * never be persisted.
 */
import { render, fireEvent } from '@testing-library/react';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { SettingsDialog } from './App';

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
    onApplyVectorStyle: () => {}, onApplyVectorZoomRange: () => {}, onApplyVectorCluster: () => {},
    onApplyVectorFilter: jest.fn(() => true), onApplyVectorFeatureStyle: () => {}, onToggleVectorFeatureMeasurements: () => {}, onToggleVectorFeatureNameLabel: () => {},
    onApplyVectorAttrRender: () => {},
    onReorderRasterLayers: () => {}, onReorderVectorLayers: () => {},
    onAddVectorLayer: async () => {}, onAddMVTLayer: async () => {}, onAddWFSLayer: async () => {}, onAddSTACLayer: async () => {},
    onExportVectorLayer: () => {}, onReeditVectorLayer: jest.fn(), editingVectorLayerId: null,
    onShowAttributeTable: () => {},
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

const openEdit = (getByTitle: (t: string) => HTMLElement) =>
  fireEvent.click(getByTitle('Edit layer'));

test('file-imported layer offers geometry editing and starts a session on click', () => {
  const onReedit = jest.fn();
  const feats = [new Feature({ geometry: new Point([0, 0]), name: 'Alpha' })];
  const layer = vectorLayer('file1', feats); // geojson without isDrawnInApp = file import
  const { getByTitle, getByText, queryByText } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onReeditVectorLayer: onReedit })} />
  );
  openEdit(getByTitle);

  const btn = getByText('Edit geometry');
  expect(btn).toBeTruthy();
  expect(queryByText('Re-edit layer')).toBeNull();

  fireEvent.click(btn);
  expect(onReedit).toHaveBeenCalledWith('file1');
});

test('file-imported layer offers the Download menu', () => {
  const feats = [new Feature({ geometry: new Point([0, 0]), name: 'Alpha' })];
  const layer = vectorLayer('file1', feats);
  const { getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );
  openEdit(getByTitle);
  expect(getByTitle('Download this layer’s features')).toBeTruthy();
});

test('file-imported layer has no per-feature draw-style section', () => {
  const feats = [new Feature({ geometry: new Point([0, 0]), name: 'Alpha' })];
  const layer = vectorLayer('file1', feats);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );
  openEdit(getByTitle);
  expect(container.querySelector('.settings-vector-features')).toBeNull();
});

test('drawn-in-app layer keeps the Re-edit wording and per-feature section', () => {
  const feats = [new Feature({ geometry: new Point([0, 0]), name: 'Alpha' })];
  const layer = vectorLayer('drawn1', feats, { isDrawnInApp: true });
  const { container, getByTitle, getByText, queryByText } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );
  openEdit(getByTitle);

  expect(getByText('Re-edit layer')).toBeTruthy();
  expect(queryByText('Edit geometry')).toBeNull();
  expect(container.querySelector('.settings-vector-features-title')!.textContent)
    .toBe('Individual features');
});

test('remote (wfs) layer offers no on-map geometry editing or download', () => {
  const layer = vectorLayer('wfs1', [], { type: 'wfs', url: 'https://example.com/wfs', wfsTypeName: 'ns:layer' });
  const { getByTitle, queryByText, queryByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );
  openEdit(getByTitle);

  expect(queryByText('Edit geometry')).toBeNull();
  expect(queryByText('Re-edit layer')).toBeNull();
  expect(queryByTitle('Download this layer’s features')).toBeNull();
});

test('the active session flips the button to Done editing for file layers too', () => {
  const feats = [new Feature({ geometry: new Point([0, 0]), name: 'Alpha' })];
  const layer = vectorLayer('file1', feats);
  const { getByTitle, getByText } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], editingVectorLayerId: 'file1' })} />
  );
  openEdit(getByTitle);
  expect(getByText('Done editing')).toBeTruthy();
});
