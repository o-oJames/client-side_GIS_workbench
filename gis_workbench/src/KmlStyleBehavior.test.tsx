/**
 * KML Style Behavior Tests
 *
 * Settings-panel level tests for how a KML layer's own styles interact with the
 * vector layer editor: what the editor shows, what Cancel puts back, and what
 * Apply commits.
 *
 * Covers:
 * 1. KML files without styles (e.g., AOI.kml)
 *    - The editor shows the colours the layer was given on load
 *    - There is no in-file style to switch to (the switch is disabled)
 *    - Cancel restores the session snapshot in one atomic call
 *    - Apply commits the editor's colours without inventing `useCustomStyle`
 *
 * 2. KML files with per-feature styles (e.g., XR00C_01_RW_PC-STG1-DES.kml)
 *    - The layer opens rendering with its file's styles: switch on, colour
 *      editor locked
 *    - Cancel restores whichever style source the session opened with - in-file
 *      or custom - rather than always forcing the file's styles back on
 *    - Apply commits the switch as `useCustomStyle`
 *
 * 3. Opacity is a layer property, not part of the style
 *    - It survives the in-file style switch being toggled
 *
 * The map-side consequences of all of this (does the OL layer actually keep its
 * per-feature styles, does the opacity really change) are exercised end to end
 * in MapPage.inFileStyle.test.tsx; the Cancel snapshot itself in
 * InFileStyleCancel.test.tsx.
 */
import { render, fireEvent } from '@testing-library/react';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { SettingsDialog } from './App';

// Mock KML text without styles (like AOI.kml)
const KML_NO_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>AOI</name>
            <Polygon>
                <outerBoundaryIs>
                    <LinearRing>
                        <coordinates>0,0,0 1,0,0 1,1,0 0,1,0 0,0,0</coordinates>
                    </LinearRing>
                </outerBoundaryIs>
            </Polygon>
        </Placemark>
    </Document>
</kml>`;

// Mock KML text with per-feature styles (like XR00C_01_RW_PC-STG1-DES.kml)
const KML_WITH_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>Feature 1</name>
            <Style>
                <LineStyle>
                    <color>ff0000ff</color>
                    <width>2</width>
                </LineStyle>
            </Style>
            <LineString>
                <coordinates>0,0,0 1,1,0</coordinates>
            </LineString>
        </Placemark>
        <Placemark>
            <name>Feature 2</name>
            <Style>
                <LineStyle>
                    <color>ff0000ff</color>
                    <width>2</width>
                </LineStyle>
            </Style>
            <LineString>
                <coordinates>1,0,0 0,1,0</coordinates>
            </LineString>
        </Placemark>
        <Placemark>
            <name>Feature 3</name>
            <Style>
                <LineStyle>
                    <color>ff00ff00</color>
                    <width>2</width>
                </LineStyle>
            </Style>
            <LineString>
                <coordinates>0,0,0 1,0,0</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>`;

function mockOlLayer(features: any[]) {
  const source = { getFeatures: () => features };
  return { getSource: () => source, setStyle: vi.fn(), setOpacity: vi.fn() };
}

function vectorLayer(id: string, features: any[], extra: Record<string, any> = {}) {
  return {
    id,
    name: id,
    type: 'kml',
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
    onToggleVectorLayer: () => {}, onRemoveVectorLayer: () => {}, onEditVectorLayer: vi.fn(),
    onApplyVectorStyle: vi.fn(), onApplyVectorZoomRange: () => {}, onApplyVectorCluster: () => {},
    onApplyVectorFilter: vi.fn(() => true), onApplyVectorFeatureStyle: () => {},
    onToggleVectorFeatureMeasurements: () => {}, onToggleVectorFeatureNameLabel: () => {},
    onApplyVectorAttrRender: () => {},
    onToggleInFileStyle: vi.fn(),
    onRestoreVectorLayerEdit: vi.fn(),
    onReorderRasterLayers: () => {}, onReorderVectorLayers: () => {},
    onAddVectorLayer: async () => {}, onAddMVTLayer: async () => {}, onAddWFSLayer: async () => {},
    onAddSTACLayer: async () => {}, onAddPostgisLayer: async () => {},
    onExportVectorLayer: () => {}, onReeditVectorLayer: vi.fn(), editingVectorLayerId: null,
    onShowAttributeTable: () => {},
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

const openEdit = (getByTitle: (t: string) => HTMLElement) =>
  fireEvent.click(getByTitle('Edit layer'));

/** The "Colors & style" collapse header title. */
const styleTitle = (container: HTMLElement) =>
  container.querySelector('.settings-style-collapse-title') as HTMLElement | null;

/** The four colour swatches summarising the collapse: line, fill, point, font. */
const styleSwatches = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.settings-style-collapse-swatch'));

/**
 * A swatch's colour, normalised: jsdom collapses an alpha of 1, so
 * `rgba(98, 217, 38, 1)` reads back as `rgb(98, 217, 38)`.
 */
const swatchColor = (el: HTMLElement) => {
  const m = /rgba?\(([^)]+)\)/.exec(el.style.background);
  if (!m) return el.style.background;
  const parts = m[1].split(',').map((p) => p.trim());
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3] ?? '1'})`;
};

/** The "Use in-file style" switch (only file-based layers have one). */
const inFileSwitch = (container: HTMLElement) =>
  container.querySelector('.settings-infile-style-switch') as HTMLButtonElement | null;

const sliderRow = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll('.settings-slider-row'))
    .find((row) => row.querySelector('.settings-slider-label')?.textContent === label);

const sliderOf = (container: HTMLElement, label: string) =>
  sliderRow(container, label)!.querySelector('input[type="range"]') as HTMLInputElement;

/** The editor's own Apply (not the filter panel's inner one). */
const applyButton = (container: HTMLElement) =>
  container.querySelector('.settings-form-buttons .settings-button-primary') as HTMLButtonElement;

const cancelButton = (container: HTMLElement) =>
  container.querySelector('.settings-form-buttons .settings-button-secondary') as HTMLButtonElement;

/** Assert Cancel fired exactly one atomic restore and hand back its snapshot. */
function restoredSnapshot(onRestoreVectorLayerEdit: any, layerId: string) {
  expect(onRestoreVectorLayerEdit).toHaveBeenCalledTimes(1);
  const [id, snapshot] = onRestoreVectorLayerEdit.mock.calls[0];
  expect(id).toBe(layerId);
  return snapshot;
}

const pointFeatures = (names: string[]) =>
  names.map((name, i) => new Feature({ geometry: new Point([i, i]), name }));

describe('KML Style Behavior', () => {
  describe('KML file without styles (like AOI.kml)', () => {
    const layerFor = () => vectorLayer('kml-no-style', pointFeatures(['Test']), {
      kmlText: KML_NO_STYLES,
      hasInFileStyle: false,
      lineColor: 'rgba(98, 217, 38, 1)',
      fillColor: 'rgba(98, 217, 38, 0.3)',
      lineWidth: 2,
    });

    test('shows the assigned colors in the editor', () => {
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({ vectorLayers: [layerFor()] }) as any} />
      );

      openEdit(getByTitle);

      expect(styleTitle(container)?.textContent).toBe('Colors & style');
      // Swatch order is line, fill, point, font.
      const [line, fill] = styleSwatches(container);
      expect(swatchColor(line)).toBe('rgba(98, 217, 38, 1)');
      expect(swatchColor(fill)).toBe('rgba(98, 217, 38, 0.3)');
    });

    test('has no in-file style to switch to', () => {
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({ vectorLayers: [layerFor()] }) as any} />
      );

      openEdit(getByTitle);

      const sw = inFileSwitch(container);
      expect(sw).not.toBeNull();
      expect(sw!.disabled).toBe(true);
      expect(sw!.getAttribute('aria-checked')).toBe('false');
      // With no file styles in charge, the colour editor stays usable.
      expect(container.querySelector('.settings-style-collapse')!.className).not.toContain('disabled');
    });

    test('Cancel restores the session snapshot in one atomic call', () => {
      const onApplyVectorStyle = vi.fn();
      const onRestoreVectorLayerEdit = vi.fn();
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layerFor()],
          onApplyVectorStyle,
          onRestoreVectorLayerEdit,
        }) as any} />
      );

      openEdit(getByTitle);
      fireEvent.click(cancelButton(container));

      const snapshot = restoredSnapshot(onRestoreVectorLayerEdit, 'kml-no-style');
      expect(snapshot.style).toEqual(expect.objectContaining({
        opacity: 100,
        lineColor: 'rgba(98, 217, 38, 1)',
        fillColor: 'rgba(98, 217, 38, 0.3)',
        lineWidth: 2,
      }));
      expect(snapshot.useInFileStyle).toBe(false);
      // Cancel is a single restore, not a call per setting - the per-setting
      // handlers would rebuild their style from state that still holds the
      // values being cancelled.
      expect(onApplyVectorStyle).not.toHaveBeenCalled();
    });

    test('Apply commits the colors without inventing useCustomStyle', () => {
      const onEditVectorLayer = vi.fn();
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layerFor()],
          onEditVectorLayer,
        }) as any} />
      );

      openEdit(getByTitle);
      fireEvent.click(applyButton(container));

      expect(onEditVectorLayer).toHaveBeenCalledTimes(1);
      const committed = onEditVectorLayer.mock.calls[0][0];
      expect(committed.id).toBe('kml-no-style');
      expect(committed.lineColor).toBe('rgba(98, 217, 38, 1)');
      expect(committed.fillColor).toBe('rgba(98, 217, 38, 0.3)');
      // A file with no styles of its own has nothing to override, so Apply
      // leaves the flag alone rather than writing a meaningless `false`.
      expect(committed.useCustomStyle).toBeUndefined();
    });
  });

  describe('KML file with per-feature styles (like XR00C_01_RW_PC-STG1-DES.kml)', () => {
    const layerFor = (extra: Record<string, any> = {}) => vectorLayer(
      'kml-with-styles',
      pointFeatures(['Feature 1', 'Feature 2', 'Feature 3']),
      {
        kmlText: KML_WITH_STYLES,
        hasInFileStyle: true,
        lineColor: 'rgba(0, 0, 255, 1)', // Most common color (2 out of 3 features)
        fillColor: 'rgba(0, 0, 255, 0.3)',
        lineWidth: 2,
        ...extra,
      },
    );

    test('opens rendering with the file styles: switch on, color editor locked', () => {
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({ vectorLayers: [layerFor()] }) as any} />
      );

      openEdit(getByTitle);

      expect(styleTitle(container)?.textContent).toBe('Colors & style');
      const sw = inFileSwitch(container)!;
      expect(sw.disabled).toBe(false);
      expect(sw.getAttribute('aria-checked')).toBe('true');
      // While the file's own styles are in charge the uniform colour editor is
      // greyed out - it does not describe what the map is drawing.
      expect(container.querySelector('.settings-style-collapse')!.className).toContain('disabled');
    });

    test('Cancel restores the in-file style session it opened with', () => {
      const onRestoreVectorLayerEdit = vi.fn();
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layerFor({ useCustomStyle: false })],
          onRestoreVectorLayerEdit,
        }) as any} />
      );

      openEdit(getByTitle);
      fireEvent.click(cancelButton(container));

      const snapshot = restoredSnapshot(onRestoreVectorLayerEdit, 'kml-with-styles');
      // MapPage reads this to put the per-feature styles back on the layer.
      expect(snapshot.useInFileStyle).toBe(true);
    });

    test('Cancel leaves a layer that already used a custom style in custom-style mode', () => {
      const onRestoreVectorLayerEdit = vi.fn();
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layerFor({
            useCustomStyle: true,
            lineColor: 'rgba(255, 0, 0, 1)',
            fillColor: 'rgba(255, 0, 0, 0.3)',
          })],
          onRestoreVectorLayerEdit,
        }) as any} />
      );

      openEdit(getByTitle);
      // The colour editor is live because the custom style is what's drawing.
      expect(container.querySelector('.settings-style-collapse')!.className).not.toContain('disabled');

      fireEvent.click(cancelButton(container));

      const snapshot = restoredSnapshot(onRestoreVectorLayerEdit, 'kml-with-styles');
      // Cancel undoes the edit session; it does not force the file's styles on.
      expect(snapshot.useInFileStyle).toBe(false);
      expect(snapshot.style.lineColor).toBe('rgba(255, 0, 0, 1)');
    });

    test('turning the switch off and applying commits useCustomStyle', () => {
      const onEditVectorLayer = vi.fn();
      const onToggleInFileStyle = vi.fn();
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layerFor()],
          onEditVectorLayer,
          onToggleInFileStyle,
        }) as any} />
      );

      openEdit(getByTitle);
      fireEvent.click(inFileSwitch(container)!);
      expect(onToggleInFileStyle).toHaveBeenCalledWith('kml-with-styles', false);
      // The colour editor unlocks as soon as the file styles step aside.
      expect(container.querySelector('.settings-style-collapse')!.className).not.toContain('disabled');

      fireEvent.click(applyButton(container));
      expect(onEditVectorLayer).toHaveBeenCalledTimes(1);
      expect(onEditVectorLayer.mock.calls[0][0]).toEqual(
        expect.objectContaining({ id: 'kml-with-styles', useCustomStyle: true }),
      );
    });

    test('applying with the switch still on keeps the file styles', () => {
      const onEditVectorLayer = vi.fn();
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layerFor({ useCustomStyle: true })],
          onEditVectorLayer,
        }) as any} />
      );

      openEdit(getByTitle);
      fireEvent.click(inFileSwitch(container)!); // custom -> in-file

      fireEvent.click(applyButton(container));
      expect(onEditVectorLayer.mock.calls[0][0]).toEqual(
        expect.objectContaining({ id: 'kml-with-styles', useCustomStyle: false }),
      );
    });
  });

  describe('Opacity is a layer property, not part of the style', () => {
    test('an opacity edit survives the in-file style switch being toggled', () => {
      const onApplyVectorStyle = vi.fn();
      const onToggleInFileStyle = vi.fn();
      const layer = vectorLayer('kml-with-styles', pointFeatures(['Feature 1']), {
        kmlText: KML_WITH_STYLES,
        hasInFileStyle: true,
        useCustomStyle: false,
        lineColor: 'rgba(0, 0, 255, 1)',
        fillColor: 'rgba(0, 0, 255, 0.3)',
      });
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({
          vectorLayers: [layer],
          onApplyVectorStyle,
          onToggleInFileStyle,
        }) as any} />
      );

      openEdit(getByTitle);

      // Opacity is editable even while the file's styles are in charge.
      const opacity = sliderOf(container, 'Opacity');
      expect(opacity.disabled).toBe(false);
      fireEvent.change(opacity, { target: { value: '40' } });
      expect(onApplyVectorStyle).toHaveBeenCalledWith(
        'kml-with-styles',
        expect.objectContaining({ opacity: 40 }),
      );

      // Switching the style source off and back on carries the opacity in force
      // across - it used to snap the map back to 100% while the slider kept 40.
      fireEvent.click(inFileSwitch(container)!);
      fireEvent.click(inFileSwitch(container)!);
      expect(onToggleInFileStyle.mock.calls.map((c: any[]) => c[1])).toEqual([false, true]);
      expect(sliderOf(container, 'Opacity').value).toBe('40');
      const lastStyleCall = onApplyVectorStyle.mock.calls.at(-1)![1];
      expect(lastStyleCall.opacity).toBe(40);
    });

    test('Cancel puts the edited opacity back in the snapshot', () => {
      const onRestoreVectorLayerEdit = vi.fn();
      const layer = vectorLayer('kml-with-styles', pointFeatures(['Feature 1']), {
        kmlText: KML_WITH_STYLES,
        hasInFileStyle: true,
        useCustomStyle: false,
        opacity: 100,
      });
      const { getByTitle, container } = render(
        <SettingsDialog {...baseProps({ vectorLayers: [layer], onRestoreVectorLayerEdit }) as any} />
      );

      openEdit(getByTitle);
      fireEvent.change(sliderOf(container, 'Opacity'), { target: { value: '25' } });
      expect(sliderOf(container, 'Opacity').value).toBe('25');

      fireEvent.click(cancelButton(container));

      const snapshot = restoredSnapshot(onRestoreVectorLayerEdit, 'kml-with-styles');
      expect(snapshot.style.opacity).toBe(100);
      expect(snapshot.useInFileStyle).toBe(true);
    });
  });
});
