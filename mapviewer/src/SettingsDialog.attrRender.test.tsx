/**
 * Attribute-driven Render ("smart mapping") toggle in the vector layer edit
 * menu. The toggle exposes an attribute field picker plus mode options
 * (Types / Color / Size, ArcGIS Online style); every change live-applies
 * through onApplyVectorAttrRender with stats derived from the layer's
 * features, a legend preview explains what each feature looks like, and
 * Apply/Cancel commit or restore the config on the layer.
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

const FEATURES = [
  feat({ pop: 10, kind: 'school' }),
  feat({ pop: 20, kind: 'hospital' }),
  feat({ pop: 30, kind: 'school' }),
  feat({ pop: 40, kind: 'park' }),
  feat({ kind: 'park' }), // feature missing the numeric field
];

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
    onApplyVectorFilter: jest.fn(() => true), onApplyVectorAttrRender: jest.fn(),
    onApplyVectorFeatureStyle: () => {}, onToggleVectorFeatureMeasurements: () => {},
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

const openEdit = (getByTitle: (t: string) => HTMLElement) => fireEvent.click(getByTitle('Edit layer'));
const getAttrSwitch = (container: HTMLElement) =>
  container.querySelector('.settings-attr-control .settings-attr-switch') as HTMLButtonElement;

// The attribute field picker is the app's CustomSelect: click the trigger to
// open the portal menu, then click the option with the given label.
const openAttrFieldSelect = (container: HTMLElement) => {
  fireEvent.click(container.querySelector('.settings-attr-select .custom-select-trigger') as HTMLButtonElement);
};
const pickAttrField = (container: HTMLElement, label: string) => {
  openAttrFieldSelect(container);
  const option = Array.from(document.querySelectorAll('.custom-select-menu-portal .custom-select-option'))
    .find(el => el.textContent === label);
  if (!option) throw new Error('attribute option not found: ' + label);
  fireEvent.click(option);
};

test('the Attribute-driven Render toggle reveals the field picker with the layer\'s attributes', () => {
  const layer = vectorLayer('v1', FEATURES);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] }) as any} />
  );
  openEdit(getByTitle);

  const toggle = getAttrSwitch(container);
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  // The body content stays mounted for the collapse animation; only the
  // 'open' class (which expands the grid row) flips with the toggle.
  expect(container.querySelector('.settings-attr-body')!.className).not.toContain('open');

  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('.settings-attr-body')!.className).toContain('open');

  expect(container.querySelector('.settings-attr-select .custom-select-trigger')).toBeTruthy();
  openAttrFieldSelect(container);
  const optionLabels = Array.from(document.querySelectorAll('.custom-select-menu-portal .custom-select-option'))
    .map(el => el.textContent);
  expect(optionLabels).toEqual(expect.arrayContaining(['pop', 'kind (text)']));
});

test('picking a numeric field applies a classed colour ramp with computed stats and a legend', () => {
  const onApplyVectorAttrRender = jest.fn();
  const layer = vectorLayer('v1', FEATURES);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorAttrRender }) as any} />
  );
  openEdit(getByTitle);
  fireEvent.click(getAttrSwitch(container));
  pickAttrField(container, 'pop');

  expect(onApplyVectorAttrRender).toHaveBeenCalled();
  const [layerId, config] = onApplyVectorAttrRender.mock.calls[onApplyVectorAttrRender.mock.calls.length - 1];
  expect(layerId).toBe('v1');
  expect(config.enabled).toBe(true);
  expect(config.field).toBe('pop');
  expect(config.mode).toBe('color'); // numeric field defaults to the colour ramp
  expect(config.domainMin).toBe(10);
  expect(config.domainMax).toBe(40);
  expect(config.classBreaks).toHaveLength((config.classes ?? 5) + 1);
  expect(config.missingCount).toBe(1); // one feature has no "pop"

  // The legend preview explains each class, plus a No data row.
  const rows = container.querySelectorAll('.settings-attr-legend .attr-legend-row');
  expect(rows.length).toBe((config.classes ?? 5) + 1);
  expect(container.querySelector('.settings-attr-legend')!.textContent).toContain('No data');
});

test('picking a text field applies unique-symbol (Types) styling with category assignments', () => {
  const onApplyVectorAttrRender = jest.fn();
  const layer = vectorLayer('v1', FEATURES);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorAttrRender }) as any} />
  );
  openEdit(getByTitle);
  fireEvent.click(getAttrSwitch(container));
  pickAttrField(container, 'kind (text)');

  const [, config] = onApplyVectorAttrRender.mock.calls[onApplyVectorAttrRender.mock.calls.length - 1];
  expect(config.mode).toBe('types');
  expect(config.classBreaks).toBeUndefined();
  // 'park' and 'school' tie on frequency; alphabetical order breaks the tie,
  // so 'park' takes the first palette slot.
  expect(config.categories[0]).toEqual({ value: 'park', colorIndex: 0 });
  expect(config.categories.map((c: any) => c.value)).toEqual(expect.arrayContaining(['school', 'hospital']));
});

test('Apply commits the attribute config onto the layer; Cancel restores the original', () => {
  const onApplyVectorAttrRender = jest.fn();
  const onEditVectorLayer = jest.fn();
  const layer = vectorLayer('v1', FEATURES);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorAttrRender, onEditVectorLayer }) as any} />
  );
  openEdit(getByTitle);
  fireEvent.click(getAttrSwitch(container));
  pickAttrField(container, 'pop');

  fireEvent.click(container.querySelector('.settings-form-buttons .settings-button-primary') as HTMLButtonElement);
  expect(onEditVectorLayer).toHaveBeenCalled();
  const committed = onEditVectorLayer.mock.calls[0][0];
  expect(committed.attrRender.enabled).toBe(true);
  expect(committed.attrRender.field).toBe('pop');
});

test('Cancel reverts a toggled-on attribute render to the layer\'s original (none)', () => {
  const onApplyVectorAttrRender = jest.fn();
  const layer = vectorLayer('v1', FEATURES);
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer], onApplyVectorAttrRender }) as any} />
  );
  openEdit(getByTitle);
  fireEvent.click(getAttrSwitch(container));
  pickAttrField(container, 'pop');
  onApplyVectorAttrRender.mockClear();

  fireEvent.click(container.querySelector('.settings-form-buttons .settings-button-secondary') as HTMLButtonElement);
  expect(onApplyVectorAttrRender).toHaveBeenCalledWith('v1', null);
});

test('an existing attribute config is restored when the edit menu opens', () => {
  const layer = vectorLayer('v1', FEATURES, {
    attrRender: {
      enabled: true,
      field: 'pop',
      mode: 'color',
      classes: 3,
      method: 'equal-interval',
      rampId: 'wh-bl',
      domainMin: 10,
      domainMax: 40,
      classBreaks: [10, 20, 30, 40],
      missingCount: 1,
    },
  });
  const { container, getByTitle } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] }) as any} />
  );
  openEdit(getByTitle);
  const toggle = getAttrSwitch(container);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('.settings-attr-select .custom-select-value')!.textContent).toBe('pop');
  // Legend shows the three persisted classes + No data row.
  const rows = container.querySelectorAll('.settings-attr-legend .attr-legend-row');
  expect(rows.length).toBe(4);
});

test('the collapsed layer row advertises an active attribute style with a chip', () => {
  const layer = vectorLayer('v1', FEATURES, {
    attrRender: { enabled: true, field: 'pop', mode: 'color', classBreaks: [10, 25, 40] },
  });
  const { container } = render(
    <SettingsDialog {...baseProps({ vectorLayers: [layer] }) as any} />
  );
  const chip = container.querySelector('.settings-layer-attr-chip');
  expect(chip).toBeTruthy();
  expect(chip!.textContent).toBe('Attribute');
});
