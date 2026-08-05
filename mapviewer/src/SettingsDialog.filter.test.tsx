/**
 * Attribute-filter option in the vector layer edit menu.
 *
 * The Filter toggle pops out a query-expression field; Apply pushes the
 * expression through onApplyVectorFilter so the map can narrow the layer to
 * the matching features. Invalid expressions are rejected inline without
 * ever reaching the map, and an active filter is advertised with a chip on
 * the collapsed layer row.
 */
import { render, fireEvent } from '@testing-library/react';
import { SettingsDialog } from './App';

const feat = (props: Record<string, any>) => ({
  ...props,
  getProperties: () => props,
  getGeometryName: () => 'geometry',
  getGeometry: () => ({ getType: () => 'Point' }),
  getStyle: () => null,
});

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
    onApplyVectorFilter: jest.fn(() => true), onApplyVectorFeatureStyle: () => {}, onToggleVectorFeatureMeasurements: () => {},
    onApplyVectorAttrRender: () => {},
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

const openEdit = (getByTitle: (t: string) => HTMLElement) =>
  fireEvent.click(getByTitle('Edit layer'));

const getSwitch = (container: HTMLElement) =>
  container.querySelector('.settings-filter-switch') as HTMLButtonElement;

test('the expression field pops out when the Filter toggle switches on', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const layer = vectorLayer('v1', [feat({ published: true })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter })} />
  );
  openEdit(getByTitle);

  const switchBtn = getSwitch(container);
  expect(switchBtn.getAttribute('aria-checked')).toBe('false');
  expect(container.querySelector('.settings-filter-body.open')).toBeNull();

  fireEvent.click(switchBtn);
  expect(switchBtn.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('.settings-filter-body.open')).not.toBeNull();
  expect(container.querySelector('.settings-filter-input')).not.toBeNull();
  // Toggling on only reveals the field - the map is untouched until Apply.
  expect(onApplyVectorFilter).not.toHaveBeenCalled();
});

test('toggling the filter off clears it from the map immediately', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const layer = vectorLayer('v1', [], { filterEnabled: true, filterExpression: '"a" = 1' });
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter })} />
  );
  openEdit(getByTitle);

  const switchBtn = getSwitch(container);
  expect(switchBtn.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(switchBtn);
  expect(onApplyVectorFilter).toHaveBeenCalledWith('v1', false, '');
});

test('an invalid expression is rejected inline and never reaches the map', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const layer = vectorLayer('v1', [feat({ a: 1 })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter })} />
  );
  openEdit(getByTitle);
  fireEvent.click(getSwitch(container));

  const input = container.querySelector('.settings-filter-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '"a" ===' } });
  fireEvent.click(container.querySelector('.settings-filter-apply') as HTMLButtonElement);

  expect(container.querySelector('.settings-filter-feedback.error')).not.toBeNull();
  expect(onApplyVectorFilter).not.toHaveBeenCalled();
});

test('applying a valid expression reports it through onApplyVectorFilter', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const layer = vectorLayer('v1', [feat({ published: true }), feat({ published: false })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter })} />
  );
  openEdit(getByTitle);
  fireEvent.click(getSwitch(container));

  const input = container.querySelector('.settings-filter-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '"published" is true' } });

  // Live feedback previews the match count before anything is applied.
  const ok = container.querySelector('.settings-filter-feedback.ok');
  expect(ok?.textContent).toContain('matches 1 of 2');

  fireEvent.click(container.querySelector('.settings-filter-apply') as HTMLButtonElement);
  expect(onApplyVectorFilter).toHaveBeenCalledWith('v1', true, '"published" is true');
});

test('Enter in the field applies the filter', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const layer = vectorLayer('v1', [feat({ a: 1 })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter })} />
  );
  openEdit(getByTitle);
  fireEvent.click(getSwitch(container));

  const input = container.querySelector('.settings-filter-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '"a" = 1' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onApplyVectorFilter).toHaveBeenCalledWith('v1', true, '"a" = 1');
});

test('the outer Apply button commits the pending filter with the layer', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const onEditVectorLayer = jest.fn();
  const layer = vectorLayer('v1', [feat({ a: 1 })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter, onEditVectorLayer })} />
  );
  openEdit(getByTitle);
  fireEvent.click(getSwitch(container));
  fireEvent.change(container.querySelector('.settings-filter-input') as HTMLInputElement, {
    target: { value: '"a" >= 1' },
  });

  fireEvent.click(container.querySelector('.settings-button-primary') as HTMLButtonElement);

  expect(onApplyVectorFilter).toHaveBeenCalledWith('v1', true, '"a" >= 1');
  expect(onEditVectorLayer).toHaveBeenCalledWith(
    expect.objectContaining({ filterEnabled: true, filterExpression: '"a" >= 1' })
  );
});

test('the outer Apply button blocks a commit while the expression is invalid', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const onEditVectorLayer = jest.fn();
  const layer = vectorLayer('v1', [feat({ a: 1 })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter, onEditVectorLayer })} />
  );
  openEdit(getByTitle);
  fireEvent.click(getSwitch(container));
  fireEvent.change(container.querySelector('.settings-filter-input') as HTMLInputElement, {
    target: { value: '"a" >' },
  });

  fireEvent.click(container.querySelector('.settings-button-primary') as HTMLButtonElement);

  expect(container.querySelector('.settings-filter-feedback.error')).not.toBeNull();
  expect(onEditVectorLayer).not.toHaveBeenCalled();
  expect(onApplyVectorFilter).not.toHaveBeenCalled();
});

test('Cancel restores the filter the edit session started with', () => {
  const onApplyVectorFilter = jest.fn(() => true);
  const layer = vectorLayer('v1', [feat({ a: 1 })]);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorFilter })} />
  );
  openEdit(getByTitle);
  fireEvent.click(getSwitch(container));
  fireEvent.change(container.querySelector('.settings-filter-input') as HTMLInputElement, {
    target: { value: '"a" = 1' },
  });
  fireEvent.click(container.querySelector('.settings-filter-apply') as HTMLButtonElement);
  onApplyVectorFilter.mockClear();

  fireEvent.click(container.querySelector('.settings-button-secondary') as HTMLButtonElement);
  expect(onApplyVectorFilter).toHaveBeenCalledWith('v1', false, '');
});

test('an active filter shows a "Filtered" chip on the collapsed row', () => {
  const layer = vectorLayer('v1', [], { filterEnabled: true, filterExpression: '"a" = 1' });
  const { container } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );
  const chip = container.querySelector('.settings-layer-filter-chip');
  expect(chip).not.toBeNull();
  expect(chip?.textContent).toContain('Filtered');
});

test('the filter control is not offered for tiled MVT layers', () => {
  const layer = { ...vectorLayer('m1', []), type: 'mvt', url: 'https://example.com/{z}/{x}/{y}.pbf' };
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] })} />
  );
  openEdit(getByTitle);
  expect(container.querySelector('.settings-filter-control')).toBeNull();
});
