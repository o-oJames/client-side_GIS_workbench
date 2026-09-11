/**
 * Raster layer edit-form behaviour in the settings panel.
 *
 * Apply must commit the edits AND close the inline editor (returning the
 * row to the collapsed layer row) — previously it committed but left the
 * form open until the whole settings dialog was closed. Cancel must close
 * the editor and revert the live-applied changes (color adjustments).
 */
import { render, fireEvent, waitFor, act } from '@testing-library/react';
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
    onApplyVectorStyle: () => {}, onApplyVectorZoomRange: () => {}, onApplyVectorCluster: () => {}, onApplyVectorFilter: () => true, onApplyVectorAttrRender: () => {}, onApplyVectorFeatureStyle: () => {}, onToggleVectorFeatureMeasurements: () => {}, onToggleVectorFeatureNameLabel: () => {},
    onReorderRasterLayers: () => {}, onReorderVectorLayers: () => {},
    onAddVectorLayer: async () => {}, onAddMVTLayer: async () => {}, onAddWFSLayer: async () => {}, onAddSTACLayer: async () => {}, onAddPostgisLayer: async () => {},
    onExportVectorLayer: () => {}, onReeditVectorLayer: () => {}, editingVectorLayerId: null,
    onGoToVectorLayerExtent: () => {}, onGoToRasterLayerExtent: () => {},
    onDuplicateRasterLayer: () => {}, onDuplicateVectorLayer: () => {},
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

/**
 * A 12-band multispectral COG whose live source is faked: the band panel reads
 * the layout off the loaded OL source (public bandCount/hasAlpha plus the
 * private sourceImagery_ that carries the parsed TIFF tags).
 */
function fakeMultispectralSource() {
  const image = {
    fileDirectory: {
      loadValue: async (tag: string) => (tag === 'PhotometricInterpretation' ? 2 : undefined),
      getValue: (tag: string) => (tag === 'PhotometricInterpretation' ? 2 : undefined),
    },
    getSamplesPerPixel: () => 12,
    getSampleFormat: () => 1,
    getBitsPerSample: () => 16,
    getGDALNoData: () => null,
    getGDALMetadata: async (i: number) => ({
      STATISTICS_MINIMUM: '1',
      STATISTICS_MAXIMUM: String(4000 + i),
      DESCRIPTION: ['Coastal', 'Blue', 'Green', 'Red'][i] ?? `B${i + 1}`,
    }),
  };
  return { bandCount: 12, hasAlpha: false, sourceImagery_: [[image]] };
}

const MULTISPECTRAL_COG = {
  id: 'c2', name: 'scene', type: 'cog' as const, url: 'https://example.com/scene.tif',
  cogSource: 'http' as const,
  olLayer: { getSource: () => fakeMultispectralSource(), setStyle: () => {} },
};

/** Open the Bands panel inside the edit form and wait for the band read. */
async function openBandsPanel(form: HTMLElement) {
  const control = form.querySelector('[data-testid="cog-render-control"]') as HTMLElement;
  expect(control).toBeTruthy();
  if (!control.querySelector('.color-adjust-body')) {
    fireEvent.click(control.querySelector('.color-adjust-toggle') as HTMLButtonElement);
  }
  await waitFor(() => expect(control.querySelector('[data-testid="cog-render-file"]')).toBeTruthy());
  return control;
}
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
    const onEditRasterLayer = vi.fn();
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
    const onEditRasterLayer = vi.fn();
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
    const onEditRasterLayer = vi.fn();
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

  test('Cancel closes the editor, reverts live color adjustments, and does not commit', async () => {
    const onEditRasterLayer = vi.fn();
    const onApplyColorAdjustments = vi.fn();
    const { container } = renderDialog({ onEditRasterLayer, onApplyColorAdjustments });

    // Wait for the edit button to appear
    await waitFor(() => {
      const editBtn = container.querySelector('.settings-layer-edit');
      expect(editBtn).toBeTruthy();
    }, { timeout: 1000 });

    openEditor(container);
    
    // Wait for the edit form to appear
    await waitFor(() => {
      const form = editForm(container);
      expect(form).toBeTruthy();
    }, { timeout: 1000 });
    
    const form = editForm(container)!;

    // Expand the colors panel - find the button with "Colors" text
    const toggleBtns = Array.from(form.querySelectorAll('.color-adjust-toggle')) as HTMLButtonElement[];
    const colorsToggle = toggleBtns.find(btn => btn.textContent?.includes('Colors'));
    expect(colorsToggle).toBeTruthy();
    await act(async () => {
      fireEvent.click(colorsToggle!);
    });
    
    // Wait for the color-adjust-body to appear (indicates panel is expanded)
    await waitFor(() => {
      const body = form.querySelector('.color-adjust-body');
      expect(body).toBeTruthy();
    }, { timeout: 1000 });
    
    // Log the HTML to see what's being rendered
    console.log('Form HTML after expanding colors panel:', form.innerHTML);
    
    // Now wait for the sliders to appear
    await waitFor(() => {
      const sliders = form.querySelectorAll('input[type="range"]');
      expect(sliders.length).toBeGreaterThan(0);
    }, { timeout: 1000 });
    
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

describe('SettingsDialog raster edit form — COG band renderer', () => {
  test('the Bands panel is offered for COG layers only', async () => {
    const cog = renderDialog({ rasterLayers: [MULTISPECTRAL_COG] });
    openEditor(cog.container);
    expect(editForm(cog.container)!.querySelector('[data-testid="cog-render-control"]')).toBeTruthy();

    const xyz = renderDialog({ rasterLayers: [LAYER] });
    openEditor(xyz.container);
    expect(editForm(xyz.container)!.querySelector('[data-testid="cog-render-control"]')).toBeNull();
  });

  test('a band choice is pushed live through onApplyCogRender', async () => {
    const onApplyCogRender = vi.fn();
    const { container } = renderDialog({ rasterLayers: [MULTISPECTRAL_COG], onApplyCogRender });
    openEditor(container);
    const form = editForm(container)!;
    const control = await openBandsPanel(form);

    // 12 bands with no renderer chosen: the panel offers the obvious fix
    expect(control.textContent).toContain('this file has 12');
    const suggest = Array.from(control.querySelectorAll('button'))
      .find(b => b.textContent === 'Use suggested') as HTMLButtonElement;
    fireEvent.click(suggest);

    expect(onApplyCogRender).toHaveBeenCalledTimes(1);
    expect(onApplyCogRender).toHaveBeenCalledWith('c2', { mode: 'rgb', rgb: [1, 2, 3] });
    // The editor stays open so the user can keep refining the choice
    expect(editForm(container)).toBeTruthy();
  });

  test('Apply commits the band renderer with the rest of the edit', async () => {
    const onEditRasterLayer = vi.fn();
    const onApplyCogRender = vi.fn();
    const { container } = renderDialog({
      rasterLayers: [{ ...MULTISPECTRAL_COG, cogRender: { mode: 'single', band: 8 } }],
      onEditRasterLayer,
      onApplyCogRender,
    });
    openEditor(container);
    const form = editForm(container)!;

    // A layer that already has a renderer opens its panel with the summary
    const control = form.querySelector('[data-testid="cog-render-control"]') as HTMLElement;
    expect(control.querySelector('.color-adjust-badge')!.textContent).toBe('Band 8');

    fireEvent.change(form.querySelector('input[placeholder="Layer name"]') as HTMLInputElement,
      { target: { value: 'NIR band' } });
    const applyBtn = Array.from(form.querySelectorAll('button'))
      .find(b => b.textContent === 'Apply') as HTMLButtonElement;
    fireEvent.click(applyBtn);

    expect(onEditRasterLayer).toHaveBeenCalledTimes(1);
    expect(onEditRasterLayer.mock.calls[0][0]).toMatchObject({
      id: 'c2',
      name: 'NIR band',
      url: 'https://example.com/scene.tif',
      cogRender: { mode: 'single', band: 8 },
    });
    expect(editForm(container)).toBeNull();
  });

  test('Cancel reverts a live band change', async () => {
    const onApplyCogRender = vi.fn();
    const onEditRasterLayer = vi.fn();
    const { container } = renderDialog({ rasterLayers: [MULTISPECTRAL_COG], onApplyCogRender, onEditRasterLayer });
    openEditor(container);
    const form = editForm(container)!;
    const control = await openBandsPanel(form);

    const suggest = Array.from(control.querySelectorAll('button'))
      .find(b => b.textContent === 'Use suggested') as HTMLButtonElement;
    fireEvent.click(suggest);
    expect(onApplyCogRender).toHaveBeenCalledWith('c2', { mode: 'rgb', rgb: [1, 2, 3] });

    const cancelBtn = Array.from(form.querySelectorAll('button'))
      .find(b => b.textContent === 'Cancel') as HTMLButtonElement;
    fireEvent.click(cancelBtn);

    expect(onApplyCogRender).toHaveBeenLastCalledWith('c2', { mode: 'auto' });
    expect(onEditRasterLayer).not.toHaveBeenCalled();
    expect(editForm(container)).toBeNull();
  });

  test('Cancel on an untouched COG does not touch the renderer', () => {
    const onApplyCogRender = vi.fn();
    const { container } = renderDialog({ rasterLayers: [MULTISPECTRAL_COG], onApplyCogRender });
    openEditor(container);
    const form = editForm(container)!;
    const cancelBtn = Array.from(form.querySelectorAll('button'))
      .find(b => b.textContent === 'Cancel') as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    expect(onApplyCogRender).not.toHaveBeenCalled();
  });
});
