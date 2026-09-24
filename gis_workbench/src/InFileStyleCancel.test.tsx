/**
 * The vector layer editor's Cancel contract.
 *
 * Cancel means "undo this edit session" — not "switch the layer back to its
 * file's styles". The form hands MapPage the snapshot the editor opened with
 * (style values, opacity, which style source was in charge, clustering, filter,
 * zoom range, attribute render) and MapPage applies it in one pass.
 *
 * Restoring setting by setting through the live-preview callbacks is what this
 * replaced, and it could not work: each of those callbacks rebuilds the style
 * it applies from the layer config in React state, which inside the cancel
 * event still holds the values being cancelled — so the later calls re-applied
 * the preview over the top of the restore (the map kept the edited opacity
 * while the widgets showed the original).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VectorLayerEditForm } from './components/VectorLayerEditForm';
import type { VectorLayerConfig } from './types';

// A KML layer whose file carries its own per-feature styles.
const styledKmlLayer = (overrides: Partial<VectorLayerConfig> = {}): VectorLayerConfig => ({
  id: 'test-kml-layer',
  name: 'Test KML Layer',
  type: 'kml',
  visible: true,
  opacity: 100,
  lineColor: 'rgba(255, 0, 0, 1)',
  lineWidth: 2,
  fillColor: 'rgba(255, 0, 0, 0.3)',
  pointColor: 'rgba(255, 0, 0, 1)',
  pointSize: 6,
  showPoints: true,
  fontColor: 'rgba(0, 0, 0, 1)',
  fontSize: 14,
  kmlText: '<kml><Document><Placemark><Style><LineStyle><color>ff0000ff</color></LineStyle></Style></Placemark></Document></kml>',
  hasInFileStyle: true,
  useCustomStyle: false, // the file's own styles are in charge
  ...overrides,
});

// A file whose contents carry no styles: there is no in-file mode to speak of.
const unstyledFileLayer = (overrides: Partial<VectorLayerConfig> = {}): VectorLayerConfig => ({
  id: 'test-plain-layer',
  name: 'Test Plain Layer',
  type: 'geojson',
  visible: true,
  opacity: 100,
  lineColor: 'rgba(66, 133, 244, 1)',
  lineWidth: 2,
  fillColor: 'rgba(66, 133, 244, 0.3)',
  pointColor: 'rgba(66, 133, 244, 1)',
  pointSize: 6,
  showPoints: true,
  fontColor: 'rgba(0, 0, 0, 1)',
  fontSize: 14,
  hasInFileStyle: false,
  ...overrides,
});

describe('Vector layer editor: Cancel', () => {
  const mocks = {
    onApplyStyle: vi.fn(),
    onToggleInFileStyle: vi.fn(),
    onRestoreEdit: vi.fn(),
    onApplyZoomRange: vi.fn(),
    onApplyCluster: vi.fn(),
    onApplyFilter: vi.fn(() => true),
    onApplyAttrRender: vi.fn(),
    onApplyFeatureStyle: vi.fn(),
    onToggleFeatureMeasurements: vi.fn(),
    onToggleFeatureNameLabel: vi.fn(),
    onEdit: vi.fn(),
    onReedit: vi.fn(),
    onExport: vi.fn(),
    onCancel: vi.fn(),
  };

  const defaultProps = {
    editingVectorLayerId: null,
    revealReeditSignal: 0,
    units: 'metric' as const,
    ...mocks,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onApplyFilter.mockReturnValue(true);
  });

  const open = (layer: VectorLayerConfig) => render(<VectorLayerEditForm layer={layer} {...defaultProps} />);
  const cancel = (c: { getByText: (t: string) => HTMLElement }) => fireEvent.click(c.getByText('Cancel'));
  const snapshot = () => mocks.onRestoreEdit.mock.calls[0][1];

  const inFileSwitch = (c: { container: HTMLElement }) =>
    c.container.querySelector('.settings-infile-style-switch') as HTMLButtonElement;
  const opacitySlider = (c: { container: HTMLElement }) => {
    const rows = Array.from(c.container.querySelectorAll('.settings-slider-row'));
    const row = rows.find(r => r.querySelector('.settings-slider-label')?.textContent === 'Opacity');
    return row!.querySelector('input[type="range"]') as HTMLInputElement;
  };
  const openColors = (c: { getByText: (t: string) => HTMLElement }) => fireEvent.click(c.getByText('Colors & style'));
  const lineColorInput = (c: { container: HTMLElement }) =>
    c.container.querySelector('.ca-editor input[type="color"]') as HTMLInputElement;

  test('restores the snapshot the session opened with', () => {
    const ctx = open(styledKmlLayer());
    cancel(ctx);

    expect(mocks.onRestoreEdit).toHaveBeenCalledTimes(1);
    expect(mocks.onRestoreEdit.mock.calls[0][0]).toBe('test-kml-layer');
    expect(snapshot()).toEqual({
      style: {
        opacity: 100,
        lineColor: 'rgba(255, 0, 0, 1)',
        lineWidth: 2,
        fillColor: 'rgba(255, 0, 0, 0.3)',
        pointColor: 'rgba(255, 0, 0, 1)',
        pointSize: 6,
        showPoints: true,
        fontColor: 'rgba(0, 0, 0, 1)',
        fontSize: 14,
      },
      useInFileStyle: true,
      clusterPoints: false,
      clusterDistance: 40,
      filterEnabled: false,
      filterExpression: '',
      minZoom: undefined,
      maxZoom: undefined,
      attrRender: null,
    });
    expect(mocks.onCancel).toHaveBeenCalled();
  });

  test('is one atomic restore, not a call per setting', () => {
    const ctx = open(styledKmlLayer());
    // Live previews happen during the session…
    fireEvent.change(opacitySlider(ctx), { target: { value: '40' } });
    expect(mocks.onApplyStyle).toHaveBeenCalled();
    mocks.onApplyStyle.mockClear();

    cancel(ctx);

    // …but Cancel itself goes through the single restore handler: the
    // per-setting callbacks would each re-read the config being reverted.
    expect(mocks.onApplyStyle).not.toHaveBeenCalled();
    expect(mocks.onApplyCluster).not.toHaveBeenCalled();
    expect(mocks.onApplyFilter).not.toHaveBeenCalled();
    expect(mocks.onApplyAttrRender).not.toHaveBeenCalled();
    expect(mocks.onApplyZoomRange).not.toHaveBeenCalled();
    expect(mocks.onToggleInFileStyle).not.toHaveBeenCalled();
    expect(mocks.onRestoreEdit).toHaveBeenCalledTimes(1);
  });

  test('restores the original opacity after an opacity preview', () => {
    const ctx = open(styledKmlLayer({ opacity: 80 }));
    fireEvent.change(opacitySlider(ctx), { target: { value: '35' } });
    expect(mocks.onApplyStyle).toHaveBeenCalledWith('test-kml-layer', expect.objectContaining({ opacity: 35 }));

    cancel(ctx);
    expect(snapshot().style.opacity).toBe(80);
  });

  test('restores the original colours after a colour preview', () => {
    const ctx = open(styledKmlLayer({ useCustomStyle: true })); // custom mode: colours are editable
    openColors(ctx);
    fireEvent.change(lineColorInput(ctx), { target: { value: '#00ff00' } });
    expect(mocks.onApplyStyle).toHaveBeenCalledWith(
      'test-kml-layer', expect.objectContaining({ lineColor: 'rgba(0, 255, 0, 1)' }));

    cancel(ctx);
    expect(snapshot().style.lineColor).toBe('rgba(255, 0, 0, 1)');
    expect(snapshot().useInFileStyle).toBe(false);
  });

  test('puts the style source back to the one the session opened with (was in-file)', () => {
    const ctx = open(styledKmlLayer());
    expect(inFileSwitch(ctx).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(inFileSwitch(ctx)); // switch to the custom style mid-session
    expect(mocks.onToggleInFileStyle).toHaveBeenCalledWith('test-kml-layer', false);

    cancel(ctx);
    expect(snapshot().useInFileStyle).toBe(true);
  });

  test('puts the style source back to the one the session opened with (was custom)', () => {
    const ctx = open(styledKmlLayer({ useCustomStyle: true }));
    expect(inFileSwitch(ctx).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(inFileSwitch(ctx)); // try the file's styles mid-session

    cancel(ctx);
    // Cancel is not "go back to the file's styles" — the session opened in
    // custom-style mode, so that is what it restores.
    expect(snapshot().useInFileStyle).toBe(false);
  });

  test('carries the original clustering, filter, zoom range and attribute render', () => {
    const ctx = open(styledKmlLayer({
      clusterPoints: true,
      clusterDistance: 25,
      filterEnabled: true,
      filterExpression: '"kind" = \'road\'',
      minZoom: 5,
      maxZoom: 15,
      attrRender: { enabled: true, field: 'pop', mode: 'color' } as any,
    }));

    cancel(ctx);
    const snap = snapshot();
    expect(snap.clusterPoints).toBe(true);
    expect(snap.clusterDistance).toBe(25);
    expect(snap.filterEnabled).toBe(true);
    expect(snap.filterExpression).toBe('"kind" = \'road\'');
    expect(snap.minZoom).toBe(5);
    expect(snap.maxZoom).toBe(15);
    expect(snap.attrRender).toEqual({ enabled: true, field: 'pop', mode: 'color' });
  });

  test('a file with no styles of its own has no in-file mode to restore', () => {
    const ctx = open(unstyledFileLayer());
    expect(inFileSwitch(ctx).disabled).toBe(true);

    cancel(ctx);
    expect(snapshot().useInFileStyle).toBe(false);
    expect(snapshot().style.opacity).toBe(100);
  });

  test('the widgets go back to the restored values', () => {
    const ctx = open(styledKmlLayer({ opacity: 80 }));
    fireEvent.change(opacitySlider(ctx), { target: { value: '35' } });
    expect(opacitySlider(ctx).value).toBe('35');

    cancel(ctx);
    // The settings panel can stay mounted after a close, so the form puts its
    // own widgets back rather than leaving a cancelled preview on screen.
    expect(opacitySlider(ctx).value).toBe('80');
    expect(inFileSwitch(ctx).getAttribute('aria-checked')).toBe('true');
  });
});
