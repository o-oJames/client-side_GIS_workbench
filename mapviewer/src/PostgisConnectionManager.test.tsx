// ---------------------------------------------------------------------------
// PostgisConnectionManager.test.tsx — CRUD UI tests for the connection manager.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PostgisConnectionManager } from './components/PostgisConnectionManager';

// Mock the postgisConnector module
vi.mock('./utils/postgisConnector', () => ({
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
}));

import { listConnections, saveConnection, deleteConnection, testConnection } from './utils/postgisConnector';

const mockListConnections = listConnections as MockedFunction<typeof listConnections>;
const mockSaveConnection = saveConnection as MockedFunction<typeof saveConnection>;
const mockDeleteConnection = deleteConnection as MockedFunction<typeof deleteConnection>;
const mockTestConnection = testConnection as MockedFunction<typeof testConnection>;

beforeEach(() => {
  mockListConnections.mockReset();
  mockSaveConnection.mockReset();
  mockDeleteConnection.mockReset();
  mockTestConnection.mockReset();
  // Default: no connections
  mockListConnections.mockResolvedValue([]);
});

describe('PostgisConnectionManager', () => {
  it('shows empty state when no connections exist', async () => {
    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/No saved connections/i)).toBeInTheDocument();
    });
  });

  it('lists saved connections', async () => {
    mockListConnections.mockResolvedValue([
      { id: '1', name: 'Production DB', host: 'db.example.com', port: 5432, database: 'gis_prod', username: 'reader', createdAt: '' },
      { id: '2', name: 'Dev DB', host: 'localhost', port: 5432, database: 'gis_dev', username: 'dev', createdAt: '' },
    ]);

    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Production DB')).toBeInTheDocument();
      expect(screen.getByText('Dev DB')).toBeInTheDocument();
    });
  });

  it('shows connection details', async () => {
    mockListConnections.mockResolvedValue([
      { id: '1', name: 'My DB', host: 'db.example.com', port: 5432, database: 'gis', username: 'admin', createdAt: '' },
    ]);

    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/db\.example\.com:5432 \/ gis/)).toBeInTheDocument();
    });
  });

  it('shows new connection form when button is clicked', async () => {
    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    const newBtn = screen.getByText('+ New Connection');
    fireEvent.click(newBtn);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Production DB')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('localhost')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('gis_database')).toBeInTheDocument();
      // Username and password fields have no placeholders (empty fields ready to be filled)
      const usernameInput = screen.getByLabelText('Username');
      const passwordInput = screen.getByLabelText('Password');
      expect(usernameInput).toHaveAttribute('placeholder', '');
      expect(passwordInput).toHaveAttribute('placeholder', '');
    });
  });

  it('calls saveConnection when form is submitted', async () => {
    mockSaveConnection.mockResolvedValue({ id: 'new', name: 'Test', host: 'localhost', port: 5432, database: 'test', username: 'u', createdAt: '' });

    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    // Open form
    fireEvent.click(screen.getByText('+ New Connection'));

    // Fill in form fields by placeholder (username and password have no placeholders)
    fireEvent.change(screen.getByPlaceholderText('Production DB'), { target: { value: 'Test DB' } });
    fireEvent.change(screen.getByPlaceholderText('localhost'), { target: { value: 'myhost' } });
    fireEvent.change(screen.getByPlaceholderText('5432'), { target: { value: '5433' } });
    fireEvent.change(screen.getByPlaceholderText('gis_database'), { target: { value: 'mydb' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'myuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'mypass' } });

    // Click Save
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockSaveConnection).toHaveBeenCalledWith('http://localhost:40000', expect.objectContaining({
        name: 'Test DB',
        host: 'myhost',
        port: 5433,
        database: 'mydb',
        username: 'myuser',
        password: 'mypass',
      }));
    });
  });

  it('calls deleteConnection when delete button is clicked with confirmation dialog', async () => {
    mockListConnections.mockResolvedValue([
      { id: 'del-1', name: 'ToDelete', host: 'localhost', port: 5432, database: 'del', username: 'u', createdAt: '' },
    ]);
    mockDeleteConnection.mockResolvedValue();

    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('ToDelete')).toBeInTheDocument();
    });

    // Click delete button to open confirmation dialog
    const deleteBtn = screen.getByTitle('Delete this connection');
    fireEvent.click(deleteBtn);

    // Dialog should appear
    await waitFor(() => {
      expect(screen.getByText('Delete Connection')).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
    });

    // Click the Delete button in the dialog
    const confirmBtn = screen.getByText('Delete');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith('http://localhost:40000', 'del-1');
    });
  });

  it('calls testConnection and shows result', async () => {
    mockListConnections.mockResolvedValue([
      { id: 'test-1', name: 'Testable', host: 'localhost', port: 5432, database: 'test', username: 'u', createdAt: '' },
    ]);
    mockTestConnection.mockResolvedValue({ ok: true, version: 'PostgreSQL 15.0' });

    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={() => {}}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Testable')).toBeInTheDocument();
    });

    const testBtn = screen.getByTitle('Test this connection');
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(mockTestConnection).toHaveBeenCalledWith('http://localhost:40000', 'test-1');
    });
  });

  it('calls onSelectConnection when Select button is clicked', async () => {
    mockListConnections.mockResolvedValue([
      { id: 'sel-1', name: 'Selectable', host: 'localhost', port: 5432, database: 'sel', username: 'u', createdAt: '' },
    ]);
    const onSelect = vi.fn();

    render(
      <PostgisConnectionManager
        connectorUrl="http://localhost:40000"
        onSelectConnection={onSelect}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Selectable')).toBeInTheDocument();
    });

    const selectBtn = screen.getByTitle('Use this connection');
    fireEvent.click(selectBtn);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'sel-1', name: 'Selectable' }));
  });
});
