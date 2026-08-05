/**
 * Attribute table window — ArcGIS-style table as a desktop-OS window.
 *
 * Uses a REAL OL VectorSource + Features (data operations are jsdom-safe)
 * behind a stub OL layer and map, so sorting/selection/view modes run the
 * same code paths as on the live map. Layout metrics (clientWidth/Height)
 * are mocked at the prototype level because jsdom reports 0 for all of
 * them — the window initialises from the container size and the virtualised
 * grid from its viewport height.
 */
import { render, fireEvent, screen, within } from '@testing-library/react';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import { AttributeTableWindow } from './App';
import type { AttrTableFocusRequest } from './components/AttributeTableWindow';

// ----- jsdom layout mocks -----------------------------------------------------
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return (this as HTMLElement).classList?.contains('attr-table-grid') ? 800 : 1200; },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return (this as HTMLElement).classList?.contains('attr-table-grid') ? 300 : 700; },
  });
  (URL as any).createObjectURL = jest.fn(() => 'blob:mock');
  (URL as any).revokeObjectURL = jest.fn();
});

beforeEach(() => localStorage.clear());

// ----- fixtures -----------------------------------------------------------------
function makeLayerFixture() {
  const features = [
    new Feature({ geometry: new Point([0, 0]), name: 'Alpha', pop: 5 }),
    new Feature({ geometry: new Point([1, 1]), name: 'Beta', pop: 1 }),
    new Feature({ geometry: new Point([2, 2]), name: 'Gamma', pop: 9 }),
  ];
  const source = new VectorSource({ features });
  const olLayer = { getSource: () => source };
  return { features, source, olLayer };
}

const MAP_STUB: any = {
  on: jest.fn(),
  un: jest.fn(),
  getView: () => ({ calculateExtent: () => [0, 0, 100, 100] }),
  getSize: () => [800, 600],
};

function baseProps(fx: ReturnType<typeof makeLayerFixture>, over: Record<string, any> = {}) {
  const layer = { id: 'L1', name: 'Cities', type: 'geojson' as const, visible: true };
  return {
    layer,
    layers: [layer],
    onSwitchLayer: jest.fn(),
    getOlLayer: jest.fn(() => fx.olLayer),
    map: MAP_STUB,
    onClose: jest.fn(),
    onSelectionChange: jest.fn(),
    onZoomToFeatures: jest.fn(),
    onApplyFilter: jest.fn(() => true),
    showToast: jest.fn(),
    focusRequest: null as AttrTableFocusRequest | null,
    ...over,
  };
}

function rowTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.attr-table-row')).map(r => r.textContent || '');
}

// ----- tests -----------------------------------------------------------------------
describe('AttributeTableWindow', () => {
  it('shows the layer name, record counts and one row per feature', () => {
    const fx = makeLayerFixture();
    const { container } = render(<AttributeTableWindow {...baseProps(fx)} />);
    expect(screen.getByText('Cities')).toBeTruthy();
    expect(screen.getByText(/3 of 3 records/)).toBeTruthy();
    expect(rowTexts(container)).toHaveLength(3);
    // Row numbers identify the feature (natural order).
    const rowNumbers = Array.from(container.querySelectorAll('.attr-table-rnum')).map(n => n.textContent);
    expect(rowNumbers).toEqual(['1', '2', '3']);
  });

  it('sorts ascending on header click, descending on the second click', () => {
    const fx = makeLayerFixture();
    const { container } = render(<AttributeTableWindow {...baseProps(fx)} />);
    const header = screen.getByTitle(/pop — click to sort/);

    fireEvent.click(header);
    expect(rowTexts(container)[0]).toContain('Beta'); // pop 1
    expect(rowTexts(container)[1]).toContain('Alpha'); // pop 5
    expect(rowTexts(container)[2]).toContain('Gamma'); // pop 9

    fireEvent.click(header);
    expect(rowTexts(container)[0]).toContain('Gamma');
    expect(rowTexts(container)[2]).toContain('Beta');
    // The toolbar mirrors the active sort state (ArcGIS header indicator).
    expect(screen.getByText(/Sorted: pop/)).toBeTruthy();
  });

  it('selects rows via checkbox and mirrors the selection to the map', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx);
    const { container } = render(<AttributeTableWindow {...props} />);

    fireEvent.click(within(container.querySelectorAll('.attr-table-row')[0] as HTMLElement).getByRole('checkbox'));
    expect(props.onSelectionChange).toHaveBeenLastCalledWith([fx.features[0]]);
    expect(screen.getByText('1 selected')).toBeTruthy();

    // Header checkbox selects everything in view; clicking again clears it.
    fireEvent.click(screen.getByLabelText('Select all rows in view'));
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(fx.features);
    fireEvent.click(screen.getByLabelText('Select all rows in view'));
    expect(props.onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it('supports ctrl-click toggling and shift-click ranges on rows', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx);
    const { container } = render(<AttributeTableWindow {...props} />);
    const rows = () => Array.from(container.querySelectorAll('.attr-table-row')) as HTMLElement[];

    fireEvent.click(rows()[0]); // single select
    expect(props.onSelectionChange).toHaveBeenLastCalledWith([fx.features[0]]);
    const lastCallArgs = () => {
      const calls = (props.onSelectionChange as jest.Mock).mock.calls;
      return calls[calls.length - 1][0];
    };
    fireEvent.click(rows()[2], { shiftKey: true }); // range 0..2
    expect(lastCallArgs()).toHaveLength(3);
    fireEvent.click(rows()[1], { ctrlKey: true }); // toggle Beta out
    const last = lastCallArgs();
    expect(last).toHaveLength(2);
    expect(last).not.toContain(fx.features[1]);
  });

  it('filters to checked rows in "Show selected" mode', () => {
    const fx = makeLayerFixture();
    const { container } = render(<AttributeTableWindow {...baseProps(fx)} />);
    fireEvent.click(within(container.querySelectorAll('.attr-table-row')[1] as HTMLElement).getByRole('checkbox'));

    fireEvent.change(screen.getByDisplayValue('Show all'), { target: { value: 'selected' } });
    const rows = rowTexts(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Beta');
    expect(screen.getByText(/1 of 3 records/)).toBeTruthy();
  });

  it('selects and reveals a feature clicked on the map (two-way sync)', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx, {
      focusRequest: { feature: fx.features[2], additive: false, seq: 1 },
    });
    const { container } = render(<AttributeTableWindow {...props} />);
    expect(props.onSelectionChange).toHaveBeenLastCalledWith([fx.features[2]]);
    const selected = container.querySelectorAll('.attr-table-row--selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('Gamma');
  });

  it('zooms to the selection from the toolbar', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx);
    const { container } = render(<AttributeTableWindow {...props} />);
    fireEvent.click(within(container.querySelectorAll('.attr-table-row')[0] as HTMLElement).getByRole('checkbox'));
    fireEvent.click(screen.getByText('Zoom to'));
    expect(props.onZoomToFeatures).toHaveBeenCalledWith([fx.features[0]]);
  });

  it('applies attribute filters from the options menu filter bar', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx);
    render(<AttributeTableWindow {...props} />);

    fireEvent.click(screen.getByLabelText('Table options'));
    fireEvent.click(screen.getByText('Filter by attribute\u2026'));
    const input = screen.getByPlaceholderText(/e\.g\./);
    fireEvent.change(input, { target: { value: '"pop" > 3' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(props.onApplyFilter).toHaveBeenCalledWith('L1', true, '"pop" > 3');
    expect(props.showToast).toHaveBeenCalledWith('Filter applied to Cities');

    // A rejected expression surfaces the error inline and leaves the layer alone.
    (props.onApplyFilter as jest.Mock).mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByText(/Invalid expression/)).toBeTruthy();
  });

  it('exports the current view to CSV', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx);
    render(<AttributeTableWindow {...props} />);
    fireEvent.click(screen.getByLabelText('Table options'));
    fireEvent.click(screen.getByText('Export to CSV'));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(props.showToast).toHaveBeenCalledWith('Exported 3 rows to CSV');
  });

  it('edits a cell in place and writes through to the feature', () => {
    const fx = makeLayerFixture();
    const { container } = render(<AttributeTableWindow {...baseProps(fx)} />);
    const cell = screen.getAllByText('Alpha')[0];
    fireEvent.doubleClick(cell);
    const input = container.querySelector('.attr-table-cell-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Alpha Prime' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fx.features[0].get('name')).toBe('Alpha Prime');
  });

  it('closes via the window close button', () => {
    const fx = makeLayerFixture();
    const props = baseProps(fx);
    render(<AttributeTableWindow {...props} />);
    fireEvent.click(screen.getByLabelText('Close attribute table'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('offers a layer switcher when several table-able layers exist', () => {
    const fx = makeLayerFixture();
    const other = { id: 'L2', name: 'Roads', type: 'geojson' as const, visible: true };
    const props = baseProps(fx, { layers: [baseProps(fx).layer, other] });
    render(<AttributeTableWindow {...props} />);
    const select = screen.getByTitle('Switch table to another layer') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'L2' } });
    expect(props.onSwitchLayer).toHaveBeenCalledWith('L2');
  });

  it('shows an empty state for layers without features yet', () => {
    const fx = makeLayerFixture();
    fx.source.clear();
    const { container } = render(<AttributeTableWindow {...baseProps(fx)} />);
    expect(container.querySelector('.attr-table-empty')!.textContent).toMatch(/No features/);
  });
});
