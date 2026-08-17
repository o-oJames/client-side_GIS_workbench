// ---------------------------------------------------------------------------
// PostgisLayer.test.tsx — Tests for the AddPostgisLayerForm component.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AddPostgisLayerForm } from './components/AddPostgisLayerForm';

// Mock the postgisConnector module
jest.mock('./utils/postgisConnector', () => ({
  listConnections: jest.fn(),
  listTables: jest.fn(),
  queryGeoJSON: jest.fn(),
  findConnector: jest.fn(),
}));

// Mock CustomSelect to avoid portal issues in tests
jest.mock('./components/CustomSelect', () => ({
  CustomSelect: ({ options, value, onChange, placeholder }: any) => (
    <select
      data-testid="custom-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder || 'Select...'}</option>
      {options.map((opt: any) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  ),
}));

import { listConnections, listTables } from './utils/postgisConnector';

const mockListConnections = listConnections as jest.MockedFunction<typeof listConnections>;
const mockListTables = listTables as jest.MockedFunction<typeof listTables>;

beforeEach(() => {
  mockListConnections.mockReset();
  mockListTables.mockReset();
});

describe('AddPostgisLayerForm', () => {
  it('shows connection dropdown', async () => {
    mockListConnections.mockResolvedValue([
      { id: 'c1', name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', createdAt: '' },
    ]);

    await act(async () => {
      render(
        <AddPostgisLayerForm
          connectorUrl="http://localhost:40000"
          onAddPostgisLayer={jest.fn()}
          onClose={jest.fn()}
        />
      );
    });

    expect(screen.getByText('Connection')).toBeInTheDocument();
  });

  it('renders without crashing when connectorUrl is empty', async () => {
    mockListConnections.mockResolvedValue([]);

    await act(async () => {
      render(
        <AddPostgisLayerForm
          connectorUrl=""
          onAddPostgisLayer={jest.fn()}
          onClose={jest.fn()}
        />
      );
    });

    expect(screen.getByText('Connection')).toBeInTheDocument();
  });

  it('shows "Add Layer" button', async () => {
    mockListConnections.mockResolvedValue([]);

    await act(async () => {
      render(
        <AddPostgisLayerForm
          connectorUrl="http://localhost:40000"
          onAddPostgisLayer={jest.fn()}
          onClose={jest.fn()}
        />
      );
    });

    expect(screen.getByText('Add Layer')).toBeInTheDocument();
  });

  it('calls listConnections on mount', async () => {
    mockListConnections.mockResolvedValue([]);

    await act(async () => {
      render(
        <AddPostgisLayerForm
          connectorUrl="http://localhost:40000"
          onAddPostgisLayer={jest.fn()}
          onClose={jest.fn()}
        />
      );
    });

    expect(mockListConnections).toHaveBeenCalledWith('http://localhost:40000');
  });

  it('calls listTables when connection is selected', async () => {
    mockListConnections.mockResolvedValue([
      { id: 'c1', name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', createdAt: '' },
    ]);
    mockListTables.mockResolvedValue([
      { schema: 'public', table: 'roads', geomColumn: 'geom', geomType: 'LINESTRING', srid: 4326, isGeography: false, estimatedExtent: null },
    ]);

    await act(async () => {
      render(
        <AddPostgisLayerForm
          connectorUrl="http://localhost:40000"
          onAddPostgisLayer={jest.fn()}
          onClose={jest.fn()}
        />
      );
    });

    // Select a connection
    const selects = screen.getAllByTestId('custom-select');
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'c1' } });
    });

    expect(mockListTables).toHaveBeenCalledWith('http://localhost:40000', 'c1');
  });

  it('shows table dropdown after tables are loaded', async () => {
    mockListConnections.mockResolvedValue([
      { id: 'c1', name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', createdAt: '' },
    ]);
    mockListTables.mockResolvedValue([
      { schema: 'public', table: 'roads', geomColumn: 'geom', geomType: 'LINESTRING', srid: 4326, isGeography: false, estimatedExtent: null },
    ]);

    await act(async () => {
      render(
        <AddPostgisLayerForm
          connectorUrl="http://localhost:40000"
          onAddPostgisLayer={jest.fn()}
          onClose={jest.fn()}
        />
      );
    });

    // Select connection
    const selects = screen.getAllByTestId('custom-select');
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'c1' } });
    });

    // Table dropdown should appear
    await waitFor(() => {
      expect(screen.getByText('Table')).toBeInTheDocument();
    });
  });
});
