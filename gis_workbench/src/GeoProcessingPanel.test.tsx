/**
 * GeoProcessingPanel — the "Vector Tools" window.
 *
 * Uses a REAL OL VectorSource + Features behind a stub layer (same approach as
 * AttributeTable.test.tsx) so feature extraction runs the production path, and a
 * null map so the click-to-select effects stay dormant.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import { GeoProcessingPanel } from './App';
import type { VectorLayerConfig } from './types';

const ALL_TOOLS = [
  'Centroids', 'Check Validity', 'Make Valid', 'Collect Geometries', 'Delaunay Triangulation',
  'Densify by Count', 'Add Geometry Attributes', 'Extract Vertices', 'Multipart to Singleparts',
  'Polygons to Lines', 'Simplify', 'Voronoi Polygons', 'Lines to Polygons',
  'Buffer', 'Clip', 'Intersect', 'Union', 'Dissolve', 'Convex Hull', 'Distance',
  'Eliminate selected polygons',
  'Merge Vector Layers', 'Split Vector Layer', 'Remove selected features',
];

function squareFeature(x0: number, y0: number, x1: number, y1: number, props: Record<string, any> = {}) {
  return new Feature({
    geometry: new Polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]),
    ...props,
  });
}

function makeLayer(id: string, name: string, type: VectorLayerConfig['type'], features: Feature[]) {
  const source = new VectorSource({ features });
  return {
    config: { id, name, type, visible: true } as VectorLayerConfig,
    olLayer: { _rawSource: source, getSource: () => source },
  };
}

function renderPanel(layers: ReturnType<typeof makeLayer>[]) {
  const byId = new Map(layers.map(l => [l.config.id, l.olLayer]));
  const onAddResultLayer = vi.fn();
  const showToast = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <GeoProcessingPanel
      vectorLayers={layers.map(l => l.config)}
      map={null}
      getOlLayer={(id: string) => byId.get(id) ?? null}
      onAddResultLayer={onAddResultLayer}
      onClose={onClose}
      showToast={showToast}
    />
  );
  return { ...utils, onAddResultLayer, showToast, onClose };
}

const twoSquares = () => makeLayer('l1', 'Parcels', 'geojson', [
  squareFeature(0, 0, 10, 10, { id: 'a' }),
  squareFeature(20, 0, 30, 10, { id: 'b' }),
]);

describe('Vector Tools window', () => {
  it('renders the window with every tool grouped by category', () => {
    renderPanel([twoSquares()]);
    expect(screen.getByText('Vector Tools')).toBeTruthy();
    for (const category of ['Geometry Tool', 'Geoprocessing Tool', 'Manage Layers']) {
      expect(screen.getByText(category)).toBeTruthy();
    }
    for (const tool of ALL_TOOLS) {
      expect(screen.getByRole('button', { name: tool })).toBeTruthy();
    }
    expect(ALL_TOOLS).toHaveLength(24);
  });

  it('filters the tool rail by search text', () => {
    renderPanel([twoSquares()]);
    fireEvent.change(screen.getByPlaceholderText('Search tools…'), { target: { value: 'voronoi' } });
    expect(screen.getByRole('button', { name: 'Voronoi Polygons' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Centroids' })).toBeNull();
  });

  it('defaults the output name to "<tool> of <layer>"', () => {
    renderPanel([twoSquares()]);
    expect((screen.getByPlaceholderText('Result layer name') as HTMLInputElement).value)
      .toBe('Buffer of Parcels');
    fireEvent.click(screen.getByRole('button', { name: 'Centroids' }));
    expect((screen.getByPlaceholderText('Result layer name') as HTMLInputElement).value)
      .toBe('Centroids of Parcels');
  });

  it('warns about approximate kernels, and only for those tools', () => {
    renderPanel([twoSquares()]);
    // Buffer is the default selection and is not flagged.
    expect(document.querySelector('.gp-form-hint--warning')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clip' }));
    const caveat = document.querySelector('.gp-form-hint--warning');
    expect(caveat).not.toBeNull();
    expect(caveat!.textContent).toMatch(/convex/i);
    fireEvent.click(screen.getByRole('button', { name: 'Centroids' }));
    expect(document.querySelector('.gp-form-hint--warning')).toBeNull();
  });

  it('shows the empty state when nothing is usable, and excludes tiled MVT', () => {
    const { unmount } = renderPanel([]);
    expect(screen.getByText('No usable vector layers')).toBeTruthy();
    unmount();

    renderPanel([makeLayer('m', 'Tiles', 'mvt', [squareFeature(0, 0, 1, 1)])]);
    expect(screen.getByText('No usable vector layers')).toBeTruthy();
  });

  it('asks for a second layer only where the tool needs one', () => {
    renderPanel([twoSquares(), makeLayer('l2', 'Boundary', 'geojson', [squareFeature(5, 5, 25, 15)])]);
    expect(screen.queryByText('Clip layer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clip' }));
    expect(screen.getByText('Clip layer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Intersect' }));
    expect(screen.getByText('Overlay layer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Distance' }));
    expect(screen.getByText('Second layer')).toBeTruthy();
  });

  it('runs a tool and adds the result as a new layer', async () => {
    const { onAddResultLayer, showToast } = renderPanel([twoSquares()]);
    fireEvent.click(screen.getByRole('button', { name: 'Centroids' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(1));
    const [geoJson, name] = onAddResultLayer.mock.calls[0];
    expect(name).toBe('Centroids of Parcels');
    const parsed = JSON.parse(geoJson);
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].geometry.type).toBe('Point');
    expect(parsed.features[0].geometry.coordinates).toEqual([5, 5]);
    expect(parsed.features[0].properties.id).toBe('a');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('2 features'), 'success');
  });

  it('keeps a clip run inside the progress/cancel path', async () => {
    const { onAddResultLayer } = renderPanel([
      twoSquares(),
      makeLayer('l2', 'Boundary', 'geojson', [squareFeature(5, 5, 45, 15)]),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Clip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const parsed = JSON.parse(onAddResultLayer.mock.calls[0][0]);
    expect(parsed.features).toHaveLength(2);
    // The progress bar is gone again once the run finishes.
    await waitFor(() => expect(document.querySelector('.gp-progress')).toBeNull());
  });

  it('reports invalid parameters inline and adds nothing', async () => {
    const { onAddResultLayer } = renderPanel([twoSquares()]);
    fireEvent.change(screen.getByPlaceholderText('Distance'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('Buffer distance must be a non-zero number.')).toBeTruthy());
    expect(onAddResultLayer).not.toHaveBeenCalled();
  });

  it('reports an input layer with no features', async () => {
    const { onAddResultLayer } = renderPanel([makeLayer('empty', 'Nothing', 'geojson', [])]);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText('Input layer has no features.')).toBeTruthy());
    expect(onAddResultLayer).not.toHaveBeenCalled();
  });

  it('arms the map picker for the selection-based tools', () => {
    renderPanel([twoSquares()]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected features' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select on map' }));
    expect(screen.getByRole('button', { name: 'Stop selecting' })).toBeTruthy();
    expect(screen.getByText(/0 features selected/)).toBeTruthy();

    // Switching tools clears the selection state.
    fireEvent.click(screen.getByRole('button', { name: 'Eliminate selected polygons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select on map' }));
    expect(screen.getByText(/0 polygons selected/)).toBeTruthy();
  });

  it('closes from the title bar', () => {
    const { onClose } = renderPanel([twoSquares()]);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
