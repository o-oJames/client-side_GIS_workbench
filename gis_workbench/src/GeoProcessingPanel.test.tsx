/**
 * GeoProcessingPanel — the "Vector Tools" window.
 *
 * Uses a REAL OL VectorSource + Features behind a stub layer (same approach as
 * AttributeTable.test.tsx) so feature extraction runs the production path, and a
 * null map so the click-to-select effects stay dormant.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import { GeoProcessingPanel } from './App';
import type { VectorLayerConfig } from './types';

const ALL_TOOLS = [
  'Centroids', 'Point on Surface', 'Check Validity', 'Make Valid', 'Collect Geometries',
  'Delaunay Triangulation', 'Densify by Count', 'Add Geometry Attributes', 'Extract Vertices',
  'Multipart to Singleparts', 'Polygons to Lines', 'Simplify', 'Voronoi Polygons',
  'Lines to Polygons', 'Polygonize',
  'Buffer', 'Clip', 'Intersect', 'Union', 'Difference', 'Symmetrical Difference', 'Dissolve',
  'Convex Hull', 'Distance', 'Eliminate selected polygons',
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
    expect(ALL_TOOLS).toHaveLength(28);
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

  it('only warns where a kernel is still approximate', () => {
    renderPanel([twoSquares()]);
    // Buffer carries a neutral tessellation note, not an accuracy warning.
    expect(document.querySelector('.gp-form-hint--warning')).toBeNull();
    expect(document.querySelector('.gp-form-hint')!.textContent).toMatch(/quarter circle/i);

    // Clip is exact now (overlay kernel), so its Stage-1 caveat is gone.
    fireEvent.click(screen.getByRole('button', { name: 'Clip' }));
    expect(document.querySelector('.gp-form-hint--warning')).toBeNull();
    for (const tool of ['Intersect', 'Union', 'Dissolve', 'Make Valid', 'Eliminate selected polygons']) {
      fireEvent.click(screen.getByRole('button', { name: tool }));
      expect(document.querySelector('.gp-form-hint--warning')).toBeNull();
    }

    // Delaunay is the one engine that still has a genuine accuracy caveat.
    fireEvent.click(screen.getByRole('button', { name: 'Delaunay Triangulation' }));
    const caveat = document.querySelector('.gp-form-hint--warning');
    expect(caveat).not.toBeNull();
    expect(caveat!.textContent).toMatch(/incircle/i);
  });

  it('offers the new overlay tools with a second layer', () => {
    renderPanel([twoSquares(), makeLayer('l2', 'Boundary', 'geojson', [squareFeature(5, 5, 25, 15)])]);
    for (const tool of ['Difference', 'Symmetrical Difference']) {
      fireEvent.click(screen.getByRole('button', { name: tool }));
      expect(screen.getByText('Overlay layer')).toBeTruthy();
    }
  });

  it('exposes dissolve grouping and the disjoint option', () => {
    renderPanel([makeLayer('l1', 'Zones', 'geojson', [
      squareFeature(0, 0, 10, 10, { zone: 'a' }),
      squareFeature(10, 0, 20, 10, { zone: 'b' }),
    ])]);
    fireEvent.click(screen.getByRole('button', { name: 'Dissolve' }));
    expect(screen.getByText('Dissolve field(s)')).toBeTruthy();
    expect(screen.getByText('zone')).toBeTruthy();
    expect(screen.getByText('Keep disjoint features separate')).toBeTruthy();
    expect(screen.getByText('Merge overlapping geometries')).toBeTruthy();
  });

  it('runs a difference and keeps the input attributes', async () => {
    const { onAddResultLayer } = renderPanel([
      makeLayer('l1', 'Parcels', 'geojson', [squareFeature(0, 0, 10, 10, { id: 'a' })]),
      makeLayer('l2', 'Cut', 'geojson', [squareFeature(5, 0, 15, 10)]),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Difference' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const parsed = JSON.parse(onAddResultLayer.mock.calls[0][0]);
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].properties).toEqual({ id: 'a' });
    expect(parsed.features[0].geometry.coordinates[0].length).toBeGreaterThan(3);
  });

  it('runs check validity and adds the error-point layer alongside', async () => {
    const bowtie = new Feature({
      geometry: new Polygon([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]),
    });
    const { onAddResultLayer } = renderPanel([
      makeLayer('l1', 'Bad', 'geojson', [bowtie, squareFeature(50, 50, 60, 60)]),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Check Validity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(2), { timeout: 3000 });

    const [errorJson, errorName] = onAddResultLayer.mock.calls.find(
      c => String(c[1]).endsWith('error points')
    )!;
    expect(errorName).toBe('Check Validity of Bad — error points');
    const errorPoints = JSON.parse(errorJson);
    expect(errorPoints.features.length).toBeGreaterThan(0);
    expect(errorPoints.features[0].geometry.type).toBe('Point');
    expect(errorPoints.features[0].geometry.coordinates).toEqual([5, 5]);

    const main = JSON.parse(onAddResultLayer.mock.calls.find(c => !String(c[1]).endsWith('error points'))![0]);
    expect(main.features.map((f: any) => f.properties.valid)).toEqual([false, true]);
    expect(main.features[0].properties.validity_error_count).toBeGreaterThan(0);
  });

  it('measures the nearest feature and writes the hub attributes back', async () => {
    const { onAddResultLayer } = renderPanel([
      makeLayer('l1', 'Houses', 'geojson', [squareFeature(0, 0, 2, 2, { id: 'h' })]),
      makeLayer('l2', 'Roads', 'geojson', [squareFeature(10, 0, 40, 4)]),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Distance' }));
    expect(screen.getByText('What to measure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const parsed = JSON.parse(onAddResultLayer.mock.calls[0][0]);
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].properties.id).toBe('h');
    expect(parsed.features[0].properties.nearest_id).toBe(1);
    expect(parsed.features[0].properties.nearest_rank).toBe(1);
    // Ground metres on the sphere: 8 map units at the equator read as 7.991 m.
    expect(parsed.features[0].properties.nearest_distance).toBeCloseTo(8, 1);
    // The input geometry is preserved, not replaced by a connector line.
    expect(parsed.features[0].geometry.type).toBe('Polygon');
  });

  it('hulls per feature by default and offers the whole-layer mode', async () => {
    const { onAddResultLayer } = renderPanel([twoSquares()]);
    fireEvent.click(screen.getByRole('button', { name: 'Convex Hull' }));
    expect(screen.getByText('Hull of')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(JSON.parse(onAddResultLayer.mock.calls[0][0]).features).toHaveLength(2);
  });

  it('polygonizes a line network into the faces it encloses', async () => {
    const { onAddResultLayer } = renderPanel([makeLayer('l1', 'Arcs', 'geojson', [
      new Feature({ geometry: new LineString([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) }),
      new Feature({ geometry: new LineString([[0, 5], [10, 5]]) }),
    ])]);
    fireEvent.click(screen.getByRole('button', { name: 'Polygonize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onAddResultLayer).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const parsed = JSON.parse(onAddResultLayer.mock.calls[0][0]);
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features.every((f: any) => f.geometry.type === 'Polygon')).toBe(true);
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
