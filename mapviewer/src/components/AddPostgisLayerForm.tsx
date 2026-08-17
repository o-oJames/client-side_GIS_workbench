// ---------------------------------------------------------------------------
// components/AddPostgisLayerForm.tsx — Connection dropdown, table dropdown
// (populated from /tables), optional filter input, optional SRID override,
// and "Add Layer" button.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react';
import { PostgisConnection, PostgisTableInfo } from '../types';
import { listConnections, listTables } from '../utils/postgisConnector';
import { CustomSelect } from './CustomSelect';
import { LoadingIndicator } from './LoadingIndicator';
import { PostgisConnectionManager } from './PostgisConnectionManager';

interface AddPostgisLayerFormProps {
  connectorUrl: string;
  onAddPostgisLayer: (connectionId: string, table: string, geomColumn: string, name: string, filter?: string, srid?: number) => Promise<void>;
  onClose: () => void;
}

export function AddPostgisLayerForm({ connectorUrl, onAddPostgisLayer, onClose }: AddPostgisLayerFormProps) {
  const [connections, setConnections] = useState<PostgisConnection[]>([]);
  const [selectedConnId, setSelectedConnId] = useState('');
  const [tables, setTables] = useState<PostgisTableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState('');
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedGeomColumn, setSelectedGeomColumn] = useState('');
  const [filter, setFilter] = useState('');
  const [sridOverride, setSridOverride] = useState('');
  const [layerName, setLayerName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [showConnManager, setShowConnManager] = useState(true);

  // Load connections
  useEffect(() => {
    if (!connectorUrl) return;
    listConnections(connectorUrl)
      .then(setConnections)
      .catch(() => setConnections([]));
  }, [connectorUrl]);

  // Refresh connections when returning from connection manager
  useEffect(() => {
    if (!showConnManager && connectorUrl) {
      listConnections(connectorUrl)
        .then(setConnections)
        .catch(() => setConnections([]));
    }
  }, [showConnManager, connectorUrl]);

  // Load tables when connection changes
  const loadTables = useCallback(async (connId: string) => {
    if (!connId) {
      setTables([]);
      return;
    }
    setTablesLoading(true);
    setTablesError('');
    try {
      const result = await listTables(connectorUrl, connId);
      setTables(result);
    } catch (err: any) {
      setTablesError(err.message || 'Failed to load tables');
      setTables([]);
    } finally {
      setTablesLoading(false);
    }
  }, [connectorUrl]);

  useEffect(() => {
    setSelectedTable('');
    setSelectedGeomColumn('');
    loadTables(selectedConnId);
  }, [selectedConnId, loadTables]);

  // When a table is selected, auto-fill the geom column and layer name
  useEffect(() => {
    if (!selectedTable) return;
    const tbl = tables.find(t => `${t.schema}.${t.table}` === selectedTable || t.table === selectedTable);
    if (tbl) {
      setSelectedGeomColumn(tbl.geomColumn);
      if (!layerName) {
        setLayerName(tbl.table);
      }
    }
  }, [selectedTable, tables, layerName]);

  const handleAddLayer = async () => {
    if (!selectedConnId || !selectedTable || !selectedGeomColumn) {
      setAddError('Please select a connection and table');
      return;
    }

    setAdding(true);
    setAddError('');
    try {
      const name = layerName.trim() || selectedTable.split('.').pop() || 'PostGIS Layer';
      const srid = sridOverride ? parseInt(sridOverride) || undefined : undefined;
      await onAddPostgisLayer(
        selectedConnId,
        selectedTable,
        selectedGeomColumn,
        name,
        filter.trim() || undefined,
        srid
      );
      onClose();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add layer');
    } finally {
      setAdding(false);
    }
  };

  const handleSelectConnection = async (conn: PostgisConnection) => {
    // Refresh connections list to include newly created ones
    try {
      const updated = await listConnections(connectorUrl);
      setConnections(updated);
    } catch {
      // keep existing list
    }
    setSelectedConnId(conn.id);
    setShowConnManager(false);
  };

  // Build options for dropdowns
  const connOptions = connections.map(c => ({
    value: c.id,
    label: `${c.name} (${c.host}:${c.port}/${c.database})`,
  }));

  const tableOptions = tables.map(t => ({
    value: `${t.schema}.${t.table}`,
    label: `${t.schema}.${t.table} (${t.geomType}, SRID:${t.srid})`,
  }));

  if (showConnManager) {
    return (
      <PostgisConnectionManager
        connectorUrl={connectorUrl}
        onSelectConnection={handleSelectConnection}
        onClose={() => setShowConnManager(false)}
      />
    );
  }

  return (
    <div className="postgis-add-form">
      <div className="postgis-add-form-row">
        <label>Connection</label>
        <div className="postgis-add-form-select-row">
          <div className="postgis-add-form-select-wrap">
            <CustomSelect
              options={connOptions}
              value={selectedConnId}
              onChange={(val) => setSelectedConnId(val)}
              placeholder="Select a connection…"
              className="postgis-add-form-select"
            />
          </div>
          <button
            className="postgis-conn-manage-btn"
            onClick={() => setShowConnManager(true)}
            title="Manage connections"
          >
            ⚙
          </button>
        </div>
      </div>

      {tablesLoading && <LoadingIndicator message="Loading tables…" />}
      {tablesError && <div className="postgis-add-form-error">{tablesError}</div>}

      {tables.length > 0 && (
        <>
          <div className="postgis-add-form-row">
            <label>Table</label>
            <CustomSelect
              options={tableOptions}
              value={selectedTable}
              onChange={(val) => setSelectedTable(val)}
              placeholder="Select a table…"
              className="postgis-add-form-select"
            />
          </div>

          {selectedTable && (
            <>
              <div className="postgis-add-form-row">
                <label>Geometry Column</label>
                <input
                  type="text"
                  value={selectedGeomColumn}
                  onChange={(e) => setSelectedGeomColumn(e.target.value)}
                  className="settings-input postgis-add-form-input"
                  placeholder="geom"
                />
              </div>
              <div className="postgis-add-form-row">
                <label>Layer Name</label>
                <input
                  type="text"
                  value={layerName}
                  onChange={(e) => setLayerName(e.target.value)}
                  className="settings-input postgis-add-form-input"
                  placeholder={selectedTable.split('.').pop() || 'PostGIS Layer'}
                />
              </div>
              <div className="postgis-add-form-row">
                <label>Filter (optional)</label>
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="settings-input postgis-add-form-input"
                  placeholder="e.g. status = 'active'"
                />
              </div>
              <div className="postgis-add-form-row">
                <label>SRID Override (optional)</label>
                <input
                  type="number"
                  value={sridOverride}
                  onChange={(e) => setSridOverride(e.target.value)}
                  className="settings-input postgis-add-form-input"
                  placeholder="4326"
                />
              </div>
            </>
          )}
        </>
      )}

      {addError && <div className="postgis-add-form-error">{addError}</div>}

      <div className="postgis-add-form-actions">
        <button
          className="postgis-add-form-btn postgis-add-form-btn-primary"
          onClick={handleAddLayer}
          disabled={adding || !selectedConnId || !selectedTable}
        >
          {adding ? 'Adding…' : 'Add Layer'}
        </button>
        <button
          className="postgis-add-form-btn postgis-add-form-btn-cancel"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
