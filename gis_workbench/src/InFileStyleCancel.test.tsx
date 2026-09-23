/**
 * In-File Style Cancel Behavior Tests
 * 
 * Tests for the cancel button behavior when editing vector layers with in-file styles.
 * 
 * Covers:
 * 1. KML files with per-feature styles
 *    - Opening editor with toggle ON (default)
 *    - Clicking cancel should restore in-file styles
 *    - Style should not change to color editor values
 * 
 * 2. KML files with per-feature styles
 *    - Opening editor with toggle OFF
 *    - Changing colors
 *    - Clicking cancel should restore original custom style
 * 
 * 3. Toggle state changes
 *    - Toggle ON -> OFF -> Cancel: should apply custom style
 *    - Toggle OFF -> ON -> Cancel: should restore in-file styles
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VectorLayerEditForm } from './components/VectorLayerEditForm';
import type { VectorLayerConfig } from './types';

// Mock KML layer with per-feature styles
const createMockKmlLayerWithStyles = (overrides: Partial<VectorLayerConfig> = {}): VectorLayerConfig => ({
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
  useCustomStyle: false, // Using in-file styles
  ...overrides,
});

// Mock KML layer without per-feature styles
const createMockKmlLayerWithoutStyles = (overrides: Partial<VectorLayerConfig> = {}): VectorLayerConfig => ({
  id: 'test-kml-layer-no-styles',
  name: 'Test KML Layer No Styles',
  type: 'kml',
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
  kmlText: '<kml><Document><Placemark><name>Test</name></Placemark></Document></kml>',
  hasInFileStyle: false,
  useCustomStyle: true,
  ...overrides,
});

describe('In-File Style Cancel Behavior', () => {
  const mockOnApplyStyle = vi.fn();
  const mockOnRestoreKmlStyles = vi.fn();
  const mockOnToggleInFileStyle = vi.fn();
  const mockOnApplyZoomRange = vi.fn();
  const mockOnApplyCluster = vi.fn();
  const mockOnApplyFilter = vi.fn();
  const mockOnApplyAttrRender = vi.fn();
  const mockOnApplyFeatureStyle = vi.fn();
  const mockOnToggleFeatureMeasurements = vi.fn();
  const mockOnToggleFeatureNameLabel = vi.fn();
  const mockOnEdit = vi.fn();
  const mockOnReedit = vi.fn();
  const mockOnExport = vi.fn();
  const mockOnCancel = vi.fn();

  const mockUnits = 'metric' as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = {
    editingVectorLayerId: null,
    revealReeditSignal: 0,
    units: mockUnits,
    onApplyStyle: mockOnApplyStyle,
    onRestoreKmlStyles: mockOnRestoreKmlStyles,
    onToggleInFileStyle: mockOnToggleInFileStyle,
    onApplyZoomRange: mockOnApplyZoomRange,
    onApplyCluster: mockOnApplyCluster,
    onApplyFilter: mockOnApplyFilter,
    onApplyAttrRender: mockOnApplyAttrRender,
    onApplyFeatureStyle: mockOnApplyFeatureStyle,
    onToggleFeatureMeasurements: mockOnToggleFeatureMeasurements,
    onToggleFeatureNameLabel: mockOnToggleFeatureNameLabel,
    onEdit: mockOnEdit,
    onReedit: mockOnReedit,
    onExport: mockOnExport,
    onCancel: mockOnCancel,
  };

  test('Cancel with toggle ON should restore in-file styles', async () => {
    const layer = createMockKmlLayerWithStyles();
    const { getByText } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should call onRestoreKmlStyles to restore in-file styles
    expect(mockOnRestoreKmlStyles).toHaveBeenCalledWith('test-kml-layer');
    // Should NOT call onApplyStyle (which would override in-file styles)
    expect(mockOnApplyStyle).not.toHaveBeenCalled();
    // Should call onCancel
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Cancel with toggle OFF should apply custom style', async () => {
    const layer = createMockKmlLayerWithStyles({ useCustomStyle: true });
    const { getByText } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should call onApplyStyle to apply custom style
    expect(mockOnApplyStyle).toHaveBeenCalledWith('test-kml-layer', expect.objectContaining({
      lineColor: 'rgba(255, 0, 0, 1)',
      fillColor: 'rgba(255, 0, 0, 0.3)',
    }));
    // Should NOT call onRestoreKmlStyles
    expect(mockOnRestoreKmlStyles).not.toHaveBeenCalled();
    // Should call onCancel
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Cancel without changing toggle state should preserve original behavior', async () => {
    const layer = createMockKmlLayerWithStyles();
    const { getByText } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Don't change anything, just click cancel
    fireEvent.click(getByText('Cancel'));

    // Should restore in-file styles (toggle was ON at start)
    expect(mockOnRestoreKmlStyles).toHaveBeenCalledWith('test-kml-layer');
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Toggle ON -> OFF -> Cancel should restore to original ON state', async () => {
    const layer = createMockKmlLayerWithStyles();
    const { getByText, getByRole } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Find and click the toggle to turn it OFF
    const toggle = getByRole('switch');
    fireEvent.click(toggle);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should call onToggleInFileStyle to restore original state (ON)
    expect(mockOnToggleInFileStyle).toHaveBeenCalledWith('test-kml-layer', true);
    // Should NOT call onApplyStyle (because we're restoring to original state which was ON)
    expect(mockOnApplyStyle).not.toHaveBeenCalled();
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Toggle OFF -> ON -> Cancel should restore to original OFF state and apply custom style', async () => {
    const layer = createMockKmlLayerWithStyles({ useCustomStyle: true });
    const { getByText, getByRole } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Find and click the toggle to turn it ON
    const toggle = getByRole('switch');
    fireEvent.click(toggle);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should call onToggleInFileStyle to restore original state (OFF)
    expect(mockOnToggleInFileStyle).toHaveBeenCalledWith('test-kml-layer', false);
    // Should call onApplyStyle to apply the original custom style
    expect(mockOnApplyStyle).toHaveBeenCalledWith('test-kml-layer', expect.objectContaining({
      lineColor: 'rgba(255, 0, 0, 1)',
    }));
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Layer without in-file styles should always apply custom style on cancel', async () => {
    const layer = createMockKmlLayerWithoutStyles();
    const { getByText } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should call onApplyStyle
    expect(mockOnApplyStyle).toHaveBeenCalledWith('test-kml-layer-no-styles', expect.objectContaining({
      lineColor: 'rgba(66, 133, 244, 1)',
    }));
    // Should NOT call onRestoreKmlStyles
    expect(mockOnRestoreKmlStyles).not.toHaveBeenCalled();
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Cancel should not call onApplyCluster or onApplyAttrRender when restoring in-file styles', async () => {
    const layer = createMockKmlLayerWithStyles();
    const { getByText } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should restore in-file styles
    expect(mockOnRestoreKmlStyles).toHaveBeenCalledWith('test-kml-layer');
    // Should NOT call onApplyCluster or onApplyAttrRender (they would override in-file styles)
    expect(mockOnApplyCluster).not.toHaveBeenCalled();
    expect(mockOnApplyAttrRender).not.toHaveBeenCalled();
    expect(mockOnCancel).toHaveBeenCalled();
  });

  test('Cancel should call onApplyCluster and onApplyAttrRender when applying custom style', async () => {
    const layer = createMockKmlLayerWithStyles({ useCustomStyle: true });
    const { getByText } = render(<VectorLayerEditForm layer={layer} {...defaultProps} />);

    // Click cancel
    fireEvent.click(getByText('Cancel'));

    // Should apply custom style
    expect(mockOnApplyStyle).toHaveBeenCalled();
    // Should call onApplyCluster and onApplyAttrRender
    expect(mockOnApplyCluster).toHaveBeenCalled();
    expect(mockOnApplyAttrRender).toHaveBeenCalled();
    expect(mockOnCancel).toHaveBeenCalled();
  });
});
