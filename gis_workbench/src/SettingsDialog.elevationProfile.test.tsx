/**
 * The layer right-click menu's "Elevation Profile" entry.
 *
 * A profile reads the elevations a terrain renderer already reads, so the entry
 * belongs to raster layers rendering Hillshade or Contours — COG or tile — and
 * to nothing else: not plain imagery, not a COG shown as RGB, not a vector
 * layer (which gets the attribute table instead).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsDialog } from './App';
import type { RasterLayer, VectorLayerConfig } from './types';

function baseProps(over: Record<string, any> = {}) {
  return {
    onClose: () => {}, pinned: false, onPinToggle: () => {},
    showBasemap: true, onBasemapToggle: () => {},
    showGrid: false, onGridToggle: () => {},
    showDrawToolbar: true, onDrawToolbarToggle: () => {},
    showCoordinates: true, onCoordinatesToggle: () => {},
    rasterLayers: [] as RasterLayer[],
    rasterGroups: [] as any[],
    onUpdateRasterGroups: () => {}, onToggleRasterGroup: () => {}, onMoveRasterLayerToGroup: () => {},
    onAddRasterLayer: async () => {}, onEditRasterLayer: () => {}, onRemoveRasterLayer: () => {}, onToggleRasterLayer: () => {},
    onApplyColorAdjustments: () => {}, onApplyTileZoomRange: () => {},
    vectorLayers: [] as VectorLayerConfig[],
    vectorGroups: [] as any[],
    onUpdateVectorGroups: () => {}, onToggleVectorGroup: () => {}, onMoveVectorLayerToGroup: () => {},
    onToggleVectorLayer: () => {}, onRemoveVectorLayer: () => {}, onEditVectorLayer: () => {},
    onApplyVectorStyle: () => {}, onApplyVectorZoomRange: () => {}, onApplyVectorCluster: () => {},
    onApplyVectorFilter: () => true, onApplyVectorAttrRender: () => {}, onApplyVectorFeatureStyle: () => {},
    onToggleVectorFeatureMeasurements: () => {}, onToggleVectorFeatureNameLabel: () => {},
    onReorderRasterLayers: () => {}, onReorderVectorLayers: () => {},
    onAddVectorLayer: async () => {}, onAddMVTLayer: async () => {}, onAddWFSLayer: async () => {},
    onAddSTACLayer: async () => {}, onAddPostgisLayer: async () => {},
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

const CONTOUR_TILES = {
  id: 'r1', name: 'AWS Terrarium', type: 'xyz' as const,
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  tileRender: { mode: 'contour' as const, encoding: 'terrarium' as const },
};
const HILLSHADE_TILES = {
  id: 'r2', name: 'Mapbox Terrain', type: 'xyz' as const,
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  tileRender: { mode: 'hillshade' as const, encoding: 'mapbox' as const },
};
const CONTOUR_COG = {
  id: 'c1', name: 'SRTM DEM', type: 'cog' as const,
  url: 'https://example.com/dem.tif', cogSource: 'http' as const,
  cogRender: { mode: 'contour' as const, band: 1 },
};
const PLAIN_TILES = {
  id: 'r3', name: 'OSM', type: 'xyz' as const,
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
};
const RGB_COG = {
  id: 'c2', name: 'Sentinel-2', type: 'cog' as const,
  url: 'https://example.com/scene.tif', cogSource: 'http' as const,
  cogRender: { mode: 'rgb' as const, rgb: [1, 2, 3] },
};
const DEFAULT_RENDERER_TILES = {
  id: 'r4', name: 'Terrain, shown as imagery', type: 'xyz' as const,
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  tileRender: { mode: 'default' as const, encoding: 'terrarium' as const },
};
const VECTOR_LAYER = {
  id: 'v1', name: 'Parcels', type: 'geojson' as const, visible: true, drawnGeoJson: '{}',
} as VectorLayerConfig;

/** Right-click the row of the layer called `name` and return the menu. */
function openMenu(container: HTMLElement, name: string) {
  const rows = Array.from(container.querySelectorAll('.settings-layer-item'));
  const row = rows.find(r => r.querySelector('.settings-layer-name')?.textContent === name);
  expect(row, `row for ${name}`).toBeTruthy();
  fireEvent.contextMenu(row!, { clientX: 120, clientY: 200 });
  const menu = document.querySelector('.layer-context-menu');
  expect(menu).toBeTruthy();
  return menu as HTMLElement;
}

const menuItem = (label: string) =>
  Array.from(document.querySelectorAll('.layer-context-menu-item'))
    .find(b => b.querySelector('.layer-context-menu-item-label')?.textContent === label) as HTMLButtonElement | undefined;

function renderDialog(over: Record<string, any> = {}) {
  const onShowElevationProfile = vi.fn();
  const props = baseProps({ onShowElevationProfile, ...over });
  const utils = render(<SettingsDialog {...(props as any)} />);
  return { ...utils, onShowElevationProfile };
}

describe('SettingsDialog layer menu — Elevation Profile', () => {
  test('a tile layer rendering contours offers it, and opens the window for that layer', () => {
    const { container, onShowElevationProfile } = renderDialog({ rasterLayers: [CONTOUR_TILES] });
    const menu = openMenu(container, 'AWS Terrarium');
    const item = menuItem('Elevation Profile');
    expect(item).toBeTruthy();
    expect(item!.disabled).toBe(false);
    // The entry says which terrain data it will read.
    expect(item!.getAttribute('title')).toMatch(/Contours/);
    expect(menu.querySelector('.layer-context-menu-separator')).toBeTruthy();

    fireEvent.click(item!);
    expect(onShowElevationProfile).toHaveBeenCalledWith('r1');
    expect(document.querySelector('.layer-context-menu')).toBeNull();
  });

  test('a tile layer rendering hillshade offers it too', () => {
    const { container } = renderDialog({ rasterLayers: [HILLSHADE_TILES] });
    openMenu(container, 'Mapbox Terrain');
    expect(menuItem('Elevation Profile')!.getAttribute('title')).toMatch(/Hillshade/);
  });

  test('a COG rendering contours or hillshade offers it', () => {
    const { container } = renderDialog({
      rasterLayers: [CONTOUR_COG, { ...CONTOUR_COG, id: 'c9', name: 'SRTM shaded', cogRender: { mode: 'hillshade' as const, band: 1 } }],
    });
    openMenu(container, 'SRTM DEM');
    expect(menuItem('Elevation Profile')).toBeTruthy();
    fireEvent.click(menuItem('Elevation Profile')!);

    openMenu(container, 'SRTM shaded');
    expect(menuItem('Elevation Profile')).toBeTruthy();
  });

  test.each([
    ['plain imagery', PLAIN_TILES],
    ['a default tile renderer', DEFAULT_RENDERER_TILES],
    ['an RGB COG', RGB_COG],
  ])('a raster layer showing %s does not offer it', (_label, layer) => {
    const { container } = renderDialog({ rasterLayers: [layer as RasterLayer] });
    openMenu(container, layer.name);
    expect(menuItem('Elevation Profile')).toBeUndefined();
    // The entries every raster layer does get are untouched.
    expect(menuItem('Zoom to Extent')).toBeTruthy();
    expect(menuItem('Duplicate Layer')).toBeTruthy();
  });

  test('a vector layer gets the attribute table, not a profile', () => {
    const { container } = renderDialog({
      rasterLayers: [CONTOUR_TILES],
      vectorLayers: [VECTOR_LAYER],
    });
    openMenu(container, 'Parcels');
    expect(menuItem('Elevation Profile')).toBeUndefined();
    expect(menuItem('Open Attribute Table')).toBeTruthy();
    expect(menuItem('Edit Geometry')).toBeTruthy();
  });

  test('without a handler wired up the entry is present but disabled', () => {
    const props = baseProps({ rasterLayers: [CONTOUR_TILES], onShowElevationProfile: undefined });
    const { container } = render(<SettingsDialog {...(props as any)} />);
    openMenu(container, 'AWS Terrarium');
    expect(menuItem('Elevation Profile')!.disabled).toBe(true);
  });

  test('the menu belongs to the layer that was right-clicked', () => {
    const { container, onShowElevationProfile } = renderDialog({
      rasterLayers: [CONTOUR_TILES, PLAIN_TILES],
    });
    // The plain layer's menu has no profile entry at all…
    openMenu(container, 'OSM');
    expect(menuItem('Elevation Profile')).toBeUndefined();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('.layer-context-menu')).toBeNull();
    // …and the terrain layer's opens its own profile.
    openMenu(container, 'AWS Terrarium');
    fireEvent.click(menuItem('Elevation Profile')!);
    expect(onShowElevationProfile).toHaveBeenCalledWith('r1');
    expect(onShowElevationProfile).toHaveBeenCalledTimes(1);
  });

  test('hiding the panel dismisses an open menu, so it cannot float over the map', () => {
    const { container, rerender } = renderDialog({ rasterLayers: [CONTOUR_TILES] });
    openMenu(container, 'AWS Terrarium');
    expect(document.querySelector('.layer-context-menu')).toBeTruthy();
    const props = baseProps({ rasterLayers: [CONTOUR_TILES], panelHidden: true });
    rerender(<SettingsDialog {...(props as any)} />);
    expect(document.querySelector('.layer-context-menu')).toBeNull();
  });

  test('the entry sits with the other raster actions, below Zoom to Extent', () => {
    const { container } = renderDialog({ rasterLayers: [CONTOUR_TILES] });
    openMenu(container, 'AWS Terrarium');
    const labels = Array.from(document.querySelectorAll('.layer-context-menu-item-label')).map(n => n.textContent);
    expect(labels).toEqual(['Zoom to Extent', 'Duplicate Layer', 'Elevation Profile']);
    expect(screen.getAllByRole('menuitem').length).toBe(3);
  });
});
