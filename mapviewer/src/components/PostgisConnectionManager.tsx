// ---------------------------------------------------------------------------
// components/PostgisConnectionManager.tsx — CRUD UI for saved PostGIS
// connections. Follows existing dialog/input styles from App.css.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react';
import { PostgisConnection } from '../types';
import {
  listConnections,
  saveConnection,
  deleteConnection,
  testConnection,
  NewConnectionInput,
} from '../utils/companion';
import { LoadingIndicator } from './LoadingIndicator';
import { ConfirmDialog } from './ConfirmDialog';

interface PostgisConnectionManagerProps {
  connectorUrl: string;
  getLockPassword?: () => string | null;
  /** Called when the user selects a connection to add a layer from. */
  onSelectConnection: (conn: PostgisConnection) => void;
  onClose: () => void;
}

export function PostgisConnectionManager({
  connectorUrl,
  getLockPassword,
  onSelectConnection,
  onClose,
}: PostgisConnectionManagerProps) {
  const [connections, setConnections] = useState<PostgisConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('localhost');
  const [formPort, setFormPort] = useState('5432');
  const [formDatabase, setFormDatabase] = useState('');
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [saveWarning, setSaveWarning] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const password = getLockPassword?.() || undefined;
      const conns = await listConnections(connectorUrl, password);
      setConnections(conns);
    } catch (err: any) {
      setError(err.message || 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, [connectorUrl, getLockPassword]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleSave = async () => {
    if (!formName.trim() || !formHost.trim() || !formDatabase.trim() || !formUsername.trim() || !formPassword.trim()) {
      setFormError('All fields are required');
      return;
    }

    setFormSaving(true);
    setFormError('');
    try {
      const input: NewConnectionInput = {
        name: formName.trim(),
        host: formHost.trim(),
        port: parseInt(formPort) || 5432,
        database: formDatabase.trim(),
        username: formUsername.trim(),
        password: formPassword,
      };
      
      const password = getLockPassword?.() || undefined;
      const savedConn = await saveConnection(connectorUrl, input, password);
      
      // Close form and reset immediately
      setShowForm(false);
      resetForm();
      
      // Optimistically add the connection to the list
      if (savedConn && savedConn.id) {
        setConnections(prev => {
          // Check if it's already in the list (avoid duplicates)
          if (prev.some(c => c.id === savedConn.id)) {
            return prev;
          }
          return [...prev, savedConn];
        });
      }
      
      // Try to reload from server, but don't block on it
      try {
        await loadConnections();
      } catch (reloadErr) {
        // If reload fails, keep the optimistic update and show warning
        setSaveWarning('Connection saved locally but could not be verified from server. It may not persist after refresh.');
        // Auto-clear warning after 5 seconds
        setTimeout(() => setSaveWarning(''), 5000);
      }
    } catch (err: any) {
      setFormError(err.message || 'Failed to save connection');
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const password = getLockPassword?.() || undefined;
      await deleteConnection(connectorUrl, id, password);
      setConfirmDeleteId(null);
      await loadConnections();
    } catch (err: any) {
      setError(err.message || 'Failed to delete connection');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await testConnection(connectorUrl, id);
      setTestResult({
        id,
        ok: result.ok,
        message: result.ok ? `Connected! ${result.version || ''}` : result.error || 'Connection failed',
      });
    } catch (err: any) {
      setTestResult({ id, ok: false, message: err.message || 'Test failed' });
    } finally {
      setTestingId(null);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormHost('localhost');
    setFormPort('5432');
    setFormDatabase('');
    setFormUsername('');
    setFormPassword('');
    setFormError('');
  };

  return (
    <div className="postgis-conn-manager">
      <div className="postgis-conn-manager-header">
        <h4>Saved Connections</h4>
        <button
          className="postgis-conn-new-btn"
          onClick={() => { setShowForm(!showForm); resetForm(); }}
          title="Add a new database connection"
        >
          + New Connection
        </button>
      </div>

      {showForm && (
        <div className="postgis-conn-form">
          <div className="postgis-conn-form-row">
            <label>Name</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Production DB"
              className="settings-input"
            />
          </div>
          <div className="postgis-conn-form-grid">
            <div className="postgis-conn-form-row">
              <label>Host</label>
              <input
                type="text"
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder="localhost"
                className="settings-input"
              />
            </div>
            <div className="postgis-conn-form-row postgis-conn-form-row--short">
              <label>Port</label>
              <input
                type="number"
                value={formPort}
                onChange={(e) => setFormPort(e.target.value)}
                placeholder="5432"
                className="settings-input"
              />
            </div>
          </div>
          <div className="postgis-conn-form-row">
            <label>Database</label>
            <input
              type="text"
              value={formDatabase}
              onChange={(e) => setFormDatabase(e.target.value)}
              placeholder="gis_database"
              className="settings-input"
            />
          </div>
          <div className="postgis-conn-form-grid postgis-conn-form-grid--equal">
            <div className="postgis-conn-form-row">
              <label>Username</label>
              <input
                type="text"
                value={formUsername}
                onChange={(e) => setFormUsername(e.target.value)}
                placeholder=""
                className="settings-input"
              />
            </div>
            <div className="postgis-conn-form-row">
              <label>Password</label>
              <input
                type="password"
                value={formPassword}
                onChange={(e) => setFormPassword(e.target.value)}
                placeholder=""
                className="settings-input"
              />
            </div>
          </div>
          {formError && <div className="postgis-conn-form-error">{formError}</div>}
          <div className="postgis-conn-form-actions">
            <button className="settings-btn settings-btn-primary" onClick={handleSave} disabled={formSaving}>
              {formSaving ? 'Saving…' : 'Save'}
            </button>
            <button className="settings-btn" onClick={() => { setShowForm(false); resetForm(); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {saveWarning && (
        <div className="postgis-conn-warning">
          <span>{saveWarning}</span>
          <button className="postgis-conn-warning-dismiss" onClick={() => setSaveWarning('')}>✕</button>
        </div>
      )}
      {loading && <LoadingIndicator message="Loading connections…" />}
      {error && <div className="postgis-conn-error">{error}</div>}

      {!loading && connections.length === 0 && !showForm && (
        <p className="settings-placeholder">No saved connections. Click "+ New Connection" to add one.</p>
      )}

      <div className="postgis-conn-list">
        {connections.map((conn) => (
          <div key={conn.id} className="postgis-conn-item">
            <div className="postgis-conn-item-info">
              <span className="postgis-conn-item-name">{conn.name}</span>
              <span className="postgis-conn-item-detail">
                {conn.host}:{conn.port} / {conn.database} ({conn.username})
              </span>
            </div>
            <div className="postgis-conn-item-actions">
              {testResult?.id === conn.id && (
                <span className={`postgis-conn-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                  {testResult.message}
                </span>
              )}
              <button
                className="postgis-conn-test-btn"
                onClick={() => handleTest(conn.id)}
                disabled={testingId === conn.id}
                title="Test this connection"
              >
                {testingId === conn.id ? 'Testing…' : 'Test'}
              </button>
              <button
                className="postgis-conn-select-btn"
                onClick={() => onSelectConnection(conn)}
                title="Use this connection"
              >
                Select
              </button>
              <button
                className="postgis-conn-delete-btn"
                onClick={() => setConfirmDeleteId(conn.id)}
                title="Delete this connection"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {confirmDeleteId && (
        <ConfirmDialog
          title="Delete Connection"
          message="Are you sure you want to delete this PostGIS connection? This action cannot be undone."
          confirmText="Delete"
          cancelText="Cancel"
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}
