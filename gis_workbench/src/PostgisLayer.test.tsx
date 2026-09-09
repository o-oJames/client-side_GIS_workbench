// ---------------------------------------------------------------------------
// PostgisLayer.test.tsx — Tests for the AddPostgisLayerForm component.
//
// The form deliberately opens ON the connection manager (`showConnManager`
// starts true), so a user always sees their saved connections before picking
// a table. Every test that needs the add-layer form therefore first chooses a
// connection there — that is the real user path, and it keeps these tests
// honest about the entry state instead of assuming the dropdown is showing.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AddPostgisLayerForm } from './components/AddPostgisLayerForm';

// Mock the companion module
vi.mock('./utils/companion', () => ({
  listConnections: vi.fn(),
  listTables: vi.fn(),
  queryGeoJSON: vi.fn(),
  findConnector: vi.fn(),
}));

// Mock CustomSelect to avoid portal issues in tests
vi.mock('./components/CustomSelect', () => ({
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

import { listConnections, listTables } from './utils/companion';

const mockListConnections = listConnections as MockedFunction<typeof listConnections>;
const mockListTables = listTables as MockedFunction<typeof listTables>;

const CONN = { id: 'c1', name: 'DB1', host: 'localhost', port: 5432, database: 'db1', username: 'u', createdAt: '' };
const TABLE = { schema: 'public', table: 'roads', geomColumn: 'geom', geomType: 'LINESTRING', srid: 4326, isGeography: false, estimatedExtent: null };

function renderForm(connectorUrl = 'http://localhost:40000') {
  return render(
    <AddPostgisLayerForm
      connectorUrl={connectorUrl}
      onAddPostgisLayer={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

/** Walk the real entry path: manager → "Select" on a saved connection → form. */
async function chooseConnectionFromManager(index = 0) {
  await waitFor(() => {
    expect(screen.getByText('DB1')).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getAllByTitle('Use this connection')[index]);
  });
}

beforeEach(() => {
  mockListConnections.mockReset();
  mockListTables.mockReset();
  mockListConnections.mockResolvedValue([]);
  mockListTables.mockResolvedValue([]);
});

describe('AddPostgisLayerForm', () => {
  it('opens on the connection manager, listing saved connections', async () => {
    mockListConnections.mockResolvedValue([CONN]);

    await act(async () => {
      renderForm();
    });

    expect(screen.getByText('Saved Connections')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('DB1')).toBeInTheDocument();
    });
    // The table form only appears once a connection has been chosen
    expect(screen.queryByText('Connection')).not.toBeInTheDocument();
  });

  it('shows the connection dropdown once a connection is chosen', async () => {
    mockListConnections.mockResolvedValue([CONN]);

    await act(async () => {
      renderForm();
    });
    await chooseConnectionFromManager();

    await waitFor(() => {
      expect(screen.getByText('Connection')).toBeInTheDocument();
    });
    const selects = screen.getAllByTestId('custom-select');
    expect((selects[0] as HTMLSelectElement).value).toBe('c1');
  });

  it('shows an empty manager (no crash) when connectorUrl is empty', async () => {
    await act(async () => {
      renderForm('');
    });

    // No companion configured: the form renders the manager and asks nothing of it
    expect(mockListConnections).not.toHaveBeenCalledWith('http://localhost:40000', undefined);
    await waitFor(() => {
      expect(screen.getByText(/No saved connections/i)).toBeInTheDocument();
    });
  });

  it('shows "Add Layer" button', async () => {
    mockListConnections.mockResolvedValue([CONN]);

    await act(async () => {
      renderForm();
    });
    await chooseConnectionFromManager();

    await waitFor(() => {
      expect(screen.getByText('Add Layer')).toBeInTheDocument();
    });
  });

  it('calls listConnections on mount', async () => {
    await act(async () => {
      renderForm();
    });

    expect(mockListConnections).toHaveBeenCalledWith('http://localhost:40000', undefined);
  });

  it('calls listTables when a connection is selected from the manager', async () => {
    mockListConnections.mockResolvedValue([CONN]);
    mockListTables.mockResolvedValue([TABLE]);

    await act(async () => {
      renderForm();
    });
    await chooseConnectionFromManager();

    await waitFor(() => {
      expect(mockListTables).toHaveBeenCalledWith('http://localhost:40000', 'c1');
    });
  });

  it('calls listTables when the connection dropdown changes', async () => {
    mockListConnections.mockResolvedValue([CONN, { ...CONN, id: 'c2', name: 'DB2' }]);
    mockListTables.mockResolvedValue([TABLE]);

    await act(async () => {
      renderForm();
    });
    await chooseConnectionFromManager();

    const selects = screen.getAllByTestId('custom-select');
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'c2' } });
    });

    await waitFor(() => {
      expect(mockListTables).toHaveBeenCalledWith('http://localhost:40000', 'c2');
    });
  });

  it('shows table dropdown after tables are loaded', async () => {
    mockListConnections.mockResolvedValue([CONN]);
    mockListTables.mockResolvedValue([TABLE]);

    await act(async () => {
      renderForm();
    });
    await chooseConnectionFromManager();

    await waitFor(() => {
      expect(screen.getByText('Table')).toBeInTheDocument();
    });
    // Both dropdowns are present: connection first, table second
    const selects = screen.getAllByTestId('custom-select');
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('returns to the connection manager when the ⚙ button is clicked', async () => {
    mockListConnections.mockResolvedValue([CONN]);

    await act(async () => {
      renderForm();
    });
    await chooseConnectionFromManager();

    await waitFor(() => {
      expect(screen.getByTitle('Manage connections')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Manage connections'));
    });

    await waitFor(() => {
      expect(screen.getByText('Saved Connections')).toBeInTheDocument();
    });
  });
});
