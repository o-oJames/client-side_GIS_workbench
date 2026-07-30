import React, { useState, useEffect } from 'react';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import { KnownSource, UnitsSystem } from '../types';
import { DEFAULT_BASEMAP_URL, BASEMAP_PRESETS } from '../constants';
import { isValidTileTemplate, templateToTileUrl } from '../utils/tileHelpers';
import { UnitsIcon, BasemapIcon, RasterIcon, VectorIcon, PencilIcon, TransferIcon } from './Icons';
import { CustomSelect } from './CustomSelect';
import { TileZoomRangeControl, parseZoomInput } from './TileZoomRangeControl';
import {
  downloadProjectFile,
  parseProjectHeader,
  parseProjectFile,
  restoreProject,
  ProjectImportError,
  ProjectPasswordError,
  PROJECT_FILE_EXTENSION,
} from '../utils/projectTransfer';

/** Live three-tile preview (z4 over Australia) for an XYZ template. */
function BasemapPreview({ template }: { template: string | null }) {
  const [loaded, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(0);
    setFailed(false);
  }, [template]);

  if (!template) {
    return (
      <div className="basemap-preview basemap-preview-empty">
        <span>Enter a valid XYZ URL to see a live preview</span>
      </div>
    );
  }

  const tiles = [12, 13, 14].map(x => ({ x, src: templateToTileUrl(template, 4, x, 9) }));
  const done = loaded >= tiles.length;

  return (
    <div className="basemap-preview">
      {tiles.map(tile => (
        <img
          key={template + '/' + tile.x}
          src={tile.src}
          alt=""
          className="basemap-preview-tile"
          onLoad={() => setLoaded(n => n + 1)}
          onError={() => setFailed(true)}
        />
      ))}
      <div className={'basemap-preview-status' + (failed ? ' error' : done ? ' ok' : '')}>
        {failed
          ? 'Preview failed to load — check the URL (and CORS)'
          : done
            ? 'Preview loaded · z4 sample tiles'
            : 'Loading preview…'}
      </div>
    </div>
  );
}

export function AdvancedSettingsDialog({ 
  onClose, 
  knownSources,
  onUpdateSources,
  basemapUrl,
  onBasemapChange,
  basemapMinZoom,
  basemapMaxZoom,
  onBasemapZoomRangeChange,
  units,
  onUnitsChange,
  hasLockPassword,
  getLockPassword,
}: { 
  onClose: () => void;
  knownSources: KnownSource[];
  onUpdateSources: (sources: KnownSource[]) => void;
  basemapUrl: string;
  onBasemapChange: (url: string) => void;
  basemapMinZoom?: number;
  basemapMaxZoom?: number;
  onBasemapZoomRangeChange: (minZoom?: number, maxZoom?: number) => void;
  units: UnitsSystem;
  onUnitsChange: (units: UnitsSystem) => void;
  hasLockPassword: boolean;
  getLockPassword: () => string | null;
}) {
  const rasterSources = knownSources.filter(s => s.type !== 'vtile' && s.type !== 'wfs' && s.type !== 'stac');
  const vectorSources = knownSources.filter(s => s.type === 'vtile' || s.type === 'wfs' || s.type === 'stac');

  // Raster sources state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<'wmts' | 'wms' | 'xyz'>('wmts');
  const [editUrl, setEditUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'wmts' | 'wms' | 'xyz'>('wmts');
  const [newUrl, setNewUrl] = useState('');
  const [addTesting, setAddTesting] = useState(false);
  const [addError, setAddError] = useState('');
  const [editTesting, setEditTesting] = useState(false);
  const [editError, setEditError] = useState('');

  // Vector sources state
  const [showVAddForm, setShowVAddForm] = useState(false);
  const [vEditingId, setVEditingId] = useState<string | null>(null);
  const [vEditName, setVEditName] = useState('');
  const [vEditUrl, setVEditUrl] = useState('');
  const [vNewName, setVNewName] = useState('');
  const [vNewUrl, setVNewUrl] = useState('');
  const [vNewType, setVNewType] = useState<'vtile' | 'wfs' | 'stac'>('vtile');
  const [vNewExtra, setVNewExtra] = useState(''); // WFS type name
  const [vEditType, setVEditType] = useState<'vtile' | 'wfs' | 'stac'>('vtile');
  const [vEditExtra, setVEditExtra] = useState('');

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    
    // XYZ sources don't need validation
    if (newType === 'xyz') {
      const newSource: KnownSource = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: newName.trim(),
        type: newType,
        url: newUrl.trim(),
      };
      onUpdateSources([...knownSources, newSource]);
      setNewName('');
      setNewUrl('');
      setShowAddForm(false);
      return;
    }
    
    // WMS and WMTS need validation
    setAddTesting(true);
    setAddError('');
    
    try {
      const response = await fetch(newUrl.trim());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const text = await response.text();
      
      // Validate based on type
      if (newType === 'wmts') {
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Contents || !capabilities.Contents.Layer) {
          throw new Error('Invalid WMTS capabilities document');
        }
      } else if (newType === 'wms') {
        const parser = new WMSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Capability) {
          throw new Error('Invalid WMS capabilities document');
        }
      }
      
      const newSource: KnownSource = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: newName.trim(),
        type: newType,
        url: newUrl.trim(),
      };
      onUpdateSources([...knownSources, newSource]);
      setNewName('');
      setNewUrl('');
      setShowAddForm(false);
    } catch (error: any) {
      setAddError(error.message || 'Failed to validate URL');
    } finally {
      setAddTesting(false);
    }
  };

  const handleEdit = async () => {
    if (!editingId || !editName.trim() || !editUrl.trim()) return;
    
    // XYZ sources don't need validation
    if (editType === 'xyz') {
      onUpdateSources(knownSources.map(s => 
        s.id === editingId ? { ...s, name: editName.trim(), type: editType, url: editUrl.trim() } : s
      ));
      setEditingId(null);
      setEditName('');
      setEditUrl('');
      return;
    }
    
    // WMS and WMTS need validation
    setEditTesting(true);
    setEditError('');
    
    try {
      const response = await fetch(editUrl.trim());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const text = await response.text();
      
      // Validate based on type
      if (editType === 'wmts') {
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Contents || !capabilities.Contents.Layer) {
          throw new Error('Invalid WMTS capabilities document');
        }
      } else if (editType === 'wms') {
        const parser = new WMSCapabilities();
        const capabilities = parser.read(text);
        if (!capabilities || !capabilities.Capability) {
          throw new Error('Invalid WMS capabilities document');
        }
      }
      
      onUpdateSources(knownSources.map(s => 
        s.id === editingId ? { ...s, name: editName.trim(), type: editType, url: editUrl.trim() } : s
      ));
      setEditingId(null);
      setEditName('');
      setEditUrl('');
      setEditError('');
    } catch (error: any) {
      setEditError(error.message || 'Failed to validate URL');
    } finally {
      setEditTesting(false);
    }
  };

  const handleRemove = (id: string) => {
    onUpdateSources(knownSources.filter(s => s.id !== id));
  };

  const startEdit = (source: KnownSource) => {
    setEditingId(source.id);
    setEditName(source.name);
    setEditType(source.type as 'wmts' | 'wms' | 'xyz');
    setEditUrl(source.url);
  };

  // Vector sources handlers
  const handleVAdd = () => {
    if (!vNewName.trim() || !vNewUrl.trim()) return;
    // WFS needs its type name; STAC picks its collection when added to the map
    if (vNewType === 'wfs' && !vNewExtra.trim()) return;
    const newSource: KnownSource = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      name: vNewName.trim(),
      type: vNewType,
      url: vNewUrl.trim(),
      ...(vNewType === 'wfs' ? { wfsTypeName: vNewExtra.trim() } : {}),
    };
    onUpdateSources([...knownSources, newSource]);
    setVNewName('');
    setVNewUrl('');
    setVNewType('vtile');
    setVNewExtra('');
    setShowVAddForm(false);
  };

  const handleVEdit = () => {
    if (!vEditingId || !vEditName.trim() || !vEditUrl.trim()) return;
    if (vEditType === 'wfs' && !vEditExtra.trim()) return;
    onUpdateSources(knownSources.map(s =>
      s.id === vEditingId ? {
        ...s,
        name: vEditName.trim(),
        type: vEditType,
        url: vEditUrl.trim(),
        wfsTypeName: vEditType === 'wfs' ? vEditExtra.trim() : undefined,
        stacCollection: undefined,
      } : s
    ));
    setVEditingId(null);
    setVEditName('');
    setVEditUrl('');
    setVEditType('vtile');
    setVEditExtra('');
  };

  const handleVRemove = (id: string) => {
    onUpdateSources(knownSources.filter(s => s.id !== id));
  };

  const startVEdit = (source: KnownSource) => {
    setVEditingId(source.id);
    setVEditName(source.name);
    setVEditUrl(source.url);
    const t = (source.type === 'wfs' || source.type === 'stac') ? source.type : 'vtile';
    setVEditType(t);
    setVEditExtra(t === 'wfs' ? (source.wfsTypeName || '') : '');
  };

  // ----- Basemap editing -----
  const [bmUrl, setBmUrl] = useState(basemapUrl);
  const [bmPreviewTemplate, setBmPreviewTemplate] = useState<string | null>(
    isValidTileTemplate(basemapUrl) ? basemapUrl.trim() : null
  );
  const [bmAppliedFlash, setBmAppliedFlash] = useState(false);
  const [bmMinZoom, setBmMinZoom] = useState(basemapMinZoom !== undefined ? String(basemapMinZoom) : '');
  const [bmMaxZoom, setBmMaxZoom] = useState(basemapMaxZoom !== undefined ? String(basemapMaxZoom) : '');

  // ----- Project export / import -----
  const [exportBusy, setExportBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importNeedsPassword, setImportNeedsPassword] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [importError, setImportError] = useState('');
  const [importFileBytes, setImportFileBytes] = useState<Uint8Array | null>(null);
  const [transferStatus, setTransferStatus] = useState('');
  const importFileRef = React.useRef<HTMLInputElement>(null);

  // Debounce the live preview so we don't hammer the tile server while typing
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = bmUrl.trim();
      setBmPreviewTemplate(isValidTileTemplate(trimmed) ? trimmed : null);
    }, 350);
    return () => clearTimeout(timer);
  }, [bmUrl]);

  const bmTrimmed = bmUrl.trim();
  const bmInputValid = isValidTileTemplate(bmTrimmed);
  const bmDirty = bmTrimmed !== basemapUrl;

  const applyBasemap = (url: string) => {
    const trimmed = url.trim();
    if (!isValidTileTemplate(trimmed)) return;
    onBasemapChange(trimmed);
    setBmUrl(trimmed);
    setBmAppliedFlash(true);
    window.setTimeout(() => setBmAppliedFlash(false), 2200);
  };

  /** Live-apply a (valid) basemap tile zoom range. */
  const applyBasemapZoomRange = (minStr: string, maxStr: string) => {
    const min = parseZoomInput(minStr);
    const max = parseZoomInput(maxStr);
    if (min !== undefined && max !== undefined && min > max) return; // invalid pair — wait for a valid one
    onBasemapZoomRangeChange(min, max);
  };

  const bmRangeCustomized = basemapMinZoom !== undefined || basemapMaxZoom !== undefined;

  // ----- Project export / import handlers -----
  const handleExportProject = async () => {
    setExportBusy(true);
    setTransferStatus('');
    try {
      const password = hasLockPassword ? getLockPassword() : null;
      await downloadProjectFile(password);
      setTransferStatus('Project exported successfully.');
    } catch (e: any) {
      setTransferStatus('Export failed: ' + (e.message || 'unknown error'));
    } finally {
      setExportBusy(false);
      window.setTimeout(() => setTransferStatus(''), 5000);
    }
  };

  const handleImportFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be re-selected
    e.target.value = '';
    setImportError('');
    setImportNeedsPassword(false);
    setImportPassword('');
    setTransferStatus('');

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const header = parseProjectHeader(bytes);

      if (header.encrypted) {
        // Need password before we can proceed
        setImportFileBytes(bytes);
        setImportNeedsPassword(true);
      } else {
        // No encryption — import directly
        setImportBusy(true);
        const payload = await parseProjectFile(bytes);
        await restoreProject(payload);
        setTransferStatus('Project imported successfully. Reloading…');
        window.setTimeout(() => window.location.reload(), 1200);
      }
    } catch (err: any) {
      if (err instanceof ProjectImportError) {
        setImportError(err.message);
      } else {
        setImportError('Failed to read file: ' + (err.message || 'unknown error'));
      }
    }
  };

  const handleImportWithPassword = async () => {
    if (!importFileBytes || !importPassword) return;
    setImportBusy(true);
    setImportError('');
    try {
      const payload = await parseProjectFile(importFileBytes, importPassword);
      await restoreProject(payload);
      setTransferStatus('Project imported successfully. Reloading…');
      setImportNeedsPassword(false);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (err: any) {
      if (err instanceof ProjectPasswordError) {
        setImportError('Incorrect password — could not decrypt the project file.');
      } else if (err instanceof ProjectImportError) {
        setImportError(err.message);
      } else {
        setImportError('Import failed: ' + (err.message || 'unknown error'));
      }
    } finally {
      setImportBusy(false);
    }
  };

  const cancelImport = () => {
    setImportNeedsPassword(false);
    setImportPassword('');
    setImportError('');
    setImportFileBytes(null);
  };

  return (
    <div className="advanced-settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="advanced-settings-dialog">
        <div className="advanced-settings-header">
          <span className="advanced-settings-title">Advanced Settings</span>
          <button className="advanced-settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="advanced-settings-body">
          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <BasemapIcon />
              Edit Base Map
            </div>
            <p className="advanced-settings-section-desc">
              Change the background tile layer. Use an XYZ template with {'{z}'} / {'{x}'} / {'{y}'} placeholders — or a Bing-style {'{q}'} quadkey. The preview below updates as you type.
            </p>
            <input
              type="text"
              value={bmUrl}
              onChange={(e) => setBmUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyBasemap(bmUrl); }}
              placeholder="XYZ URL ({z}/{x}/{y} or {q} quadkey, e.g., https://tile.openstreetmap.org/{z}/{x}/{y}.png)"
              className="advanced-settings-input basemap-input"
              spellCheck={false}
            />
            <div className="basemap-presets">
              {BASEMAP_PRESETS.map(preset => (
                <button
                  key={preset.name}
                  type="button"
                  className={'basemap-preset-chip' + (bmTrimmed === preset.url ? ' active' : '')}
                  onClick={() => setBmUrl(preset.url)}
                  title={preset.url}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <BasemapPreview template={bmPreviewTemplate} />
            {bmTrimmed !== '' && !bmInputValid && (
              <div className="advanced-settings-error basemap-error">
                Not a valid tile template — the URL must start with http(s) and include {'{z}'}, {'{x}'} and {'{y}'} placeholders, or a {'{q}'} quadkey.
              </div>
            )}
            <TileZoomRangeControl
              minValue={bmMinZoom}
              maxValue={bmMaxZoom}
              onMinChange={(v) => { setBmMinZoom(v); applyBasemapZoomRange(v, bmMaxZoom); }}
              onMaxChange={(v) => { setBmMaxZoom(v); applyBasemapZoomRange(bmMinZoom, v); }}
              collapsible
              defaultOpen={bmRangeCustomized}
            />
            <div className="advanced-settings-form-buttons basemap-buttons">
              <button
                className="settings-button-primary"
                onClick={() => applyBasemap(bmUrl)}
                disabled={!bmInputValid || !bmDirty}
              >
                Apply
              </button>
              <button
                className="settings-button-secondary"
                onClick={() => {
                  applyBasemap(DEFAULT_BASEMAP_URL);
                  setBmMinZoom('');
                  setBmMaxZoom('');
                  onBasemapZoomRangeChange(undefined, undefined);
                }}
                disabled={!bmDirty && !bmRangeCustomized && basemapUrl === DEFAULT_BASEMAP_URL}
              >
                Reset to Default
              </button>
              {bmAppliedFlash ? (
                <span className="basemap-applied-note">Basemap updated ✓</span>
              ) : bmDirty && bmInputValid ? (
                <span className="basemap-dirty-note">Unsaved changes</span>
              ) : null}
            </div>
          </div>

          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <UnitsIcon />
              Measurement Units
            </div>
            <p className="advanced-settings-section-desc">
              Unit system for drawing measurements (segment lengths and areas) and the map scale line. Changes apply instantly to features already on the map.
            </p>
            <div className="units-toggle" role="radiogroup" aria-label="Measurement units">
              <button
                type="button"
                role="radio"
                aria-checked={units === 'metric'}
                className={'units-toggle-option' + (units === 'metric' ? ' active' : '')}
                onClick={() => onUnitsChange('metric')}
              >
                <span className="units-toggle-name">Metric</span>
                <span className="units-toggle-units">m &middot; km &middot; m&sup2; &middot; km&sup2;</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={units === 'imperial'}
                className={'units-toggle-option' + (units === 'imperial' ? ' active' : '')}
                onClick={() => onUnitsChange('imperial')}
              >
                <span className="units-toggle-name">Imperial</span>
                <span className="units-toggle-units">ft &middot; mi &middot; ft&sup2; &middot; mi&sup2;</span>
              </button>
            </div>
          </div>

          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <RasterIcon />
              Saved Raster Sources
            </div>
            <p className="advanced-settings-section-desc">Save WMS, WMTS, and XYZ URLs for quick access when adding raster layers.</p>
            {rasterSources.length === 0 ? (
              <p className="advanced-settings-placeholder">No sources added yet.</p>
            ) : (
              <div className="advanced-settings-sources-list">
                {rasterSources.map(source => (
                  editingId === source.id ? (
                    <div key={source.id} className="advanced-settings-source-edit">
                      <input
                        type="text"
                        placeholder="Source name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="advanced-settings-input"
                      />
                      <CustomSelect
                        value={editType}
                        onChange={(val) => setEditType(val as 'wmts' | 'wms' | 'xyz')}
                        className="advanced-settings-select"
                        options={[
                          { value: 'wmts', label: 'WMTS' },
                          { value: 'wms', label: 'WMS' },
                          { value: 'xyz', label: 'XYZ' },
                        ]}
                      />
                      <input
                        type="text"
                        placeholder={editType === 'xyz' ? 'XYZ URL ({z}/{x}/{y} or {q} quadkey)' : 'Capabilities URL'}
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        className="advanced-settings-input"
                      />
                      {editTesting && (
                        <div className="settings-loading-indicator">
                          <div className="settings-loading-spinner"></div>
                          <span>Testing connection...</span>
                        </div>
                      )}
                      {editError && (
                        <div className="advanced-settings-error">{editError}</div>
                      )}
                      <div className="advanced-settings-form-buttons">
                        <button className="settings-button-primary" onClick={handleEdit} disabled={editTesting}>
                          {editTesting ? 'Testing...' : 'Save'}
                        </button>
                        <button className="settings-button-secondary" onClick={() => setEditingId(null)} disabled={editTesting}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div key={source.id} className="advanced-settings-source-item">
                      <div className="advanced-settings-source-info">
                        <span className="advanced-settings-source-name">{source.name}</span>
                        <span className="advanced-settings-source-type">{source.type.toUpperCase()}</span>
                      </div>
                      <div className="advanced-settings-source-url">{source.url}</div>
                      <div className="advanced-settings-source-actions">
                        <button
                          className="advanced-settings-source-edit-btn"
                          onClick={() => startEdit(source)}
                          title="Edit"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="advanced-settings-source-remove-btn"
                          onClick={() => handleRemove(source.id)}
                          title="Remove"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {!showAddForm ? (
              <button
                className="advanced-settings-add-button"
                onClick={() => setShowAddForm(true)}
              >
                + Add Source
              </button>
            ) : (
              <div className="advanced-settings-source-edit">
                <input
                  type="text"
                  placeholder="Source name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="advanced-settings-input"
                />
                <CustomSelect
                  value={newType}
                  onChange={(val) => setNewType(val as 'wmts' | 'wms' | 'xyz')}
                  className="advanced-settings-select"
                  options={[
                    { value: 'wmts', label: 'WMTS' },
                    { value: 'wms', label: 'WMS' },
                    { value: 'xyz', label: 'XYZ' },
                  ]}
                />
                <input
                  type="text"
                  placeholder={newType === 'xyz' ? 'XYZ URL ({z}/{x}/{y} or {q} quadkey)' : 'Capabilities URL'}
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  className="advanced-settings-input"
                />
                {addTesting && (
                  <div className="settings-loading-indicator">
                    <div className="settings-loading-spinner"></div>
                    <span>Testing connection...</span>
                  </div>
                )}
                {addError && (
                  <div className="advanced-settings-error">{addError}</div>
                )}
                <div className="advanced-settings-form-buttons">
                  <button className="settings-button-primary" onClick={handleAdd} disabled={addTesting}>
                    {addTesting ? 'Testing...' : 'Add'}
                  </button>
                  <button className="settings-button-secondary" onClick={() => setShowAddForm(false)} disabled={addTesting}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <VectorIcon />
              Saved Vector Sources
            </div>
            <p className="advanced-settings-section-desc">Save MVT, WFS, or STAC endpoints for quick access when adding vector layers.</p>
            {vectorSources.length === 0 ? (
              <p className="advanced-settings-placeholder">No vector sources added yet.</p>
            ) : (
              <div className="advanced-settings-sources-list">
                {vectorSources.map(source => (
                  vEditingId === source.id ? (
                    <div key={source.id} className="advanced-settings-source-edit">
                      <CustomSelect
                        value={vEditType}
                        onChange={(val) => { setVEditType(val as 'vtile' | 'wfs' | 'stac'); }}
                        className="advanced-settings-select"
                        options={[
                          { value: 'vtile', label: 'MVT (Vector Tiles)' },
                          { value: 'wfs', label: 'WFS (Web Feature Service)' },
                          { value: 'stac', label: 'STAC (SpatioTemporal Asset Catalog)' },
                        ]}
                      />
                      <input
                        type="text"
                        placeholder="Source name"
                        value={vEditName}
                        onChange={(e) => setVEditName(e.target.value)}
                        className="advanced-settings-input"
                      />
                      <input
                        type="text"
                        placeholder={vEditType === 'wfs'
                          ? 'WFS URL (e.g., https://example.com/geoserver/wfs)'
                          : vEditType === 'stac'
                          ? 'STAC API URL (e.g., https://earth-search.aws.element84.com/v1)'
                          : 'MVT URL (e.g., https://example.com/tiles/{z}/{x}/{y}.pbf)'}
                        value={vEditUrl}
                        onChange={(e) => setVEditUrl(e.target.value)}
                        className="advanced-settings-input"
                      />
                      {vEditType === 'wfs' && (
                        <input
                          type="text"
                          placeholder="Type name (e.g., namespace:layername)"
                          value={vEditExtra}
                          onChange={(e) => setVEditExtra(e.target.value)}
                          className="advanced-settings-input"
                        />
                      )}
                      <div className="advanced-settings-form-buttons">
                        <button
                          className="settings-button-primary"
                          onClick={handleVEdit}
                          disabled={vEditType === 'wfs' && !vEditExtra.trim()}
                        >
                          Save
                        </button>
                        <button className="settings-button-secondary" onClick={() => setVEditingId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div key={source.id} className="advanced-settings-source-item">
                      <div className="advanced-settings-source-info">
                        <span className="advanced-settings-source-name">{source.name}</span>
                        <span className="advanced-settings-source-type">{source.type.toUpperCase()}</span>
                      </div>
                      <div className="advanced-settings-source-url">{source.url}</div>
                      {source.wfsTypeName && (
                        <div className="advanced-settings-source-url">
                          Type: {source.wfsTypeName}
                        </div>
                      )}
                      <div className="advanced-settings-source-actions">
                        <button
                          className="advanced-settings-source-edit-btn"
                          onClick={() => startVEdit(source)}
                          title="Edit"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="advanced-settings-source-remove-btn"
                          onClick={() => handleVRemove(source.id)}
                          title="Remove"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
            {!showVAddForm ? (
              <button
                className="advanced-settings-add-button"
                onClick={() => setShowVAddForm(true)}
              >
                + Add Vector Source
              </button>
            ) : (
              <div className="advanced-settings-source-edit">
                <CustomSelect
                  value={vNewType}
                  onChange={(val) => { setVNewType(val as 'vtile' | 'wfs' | 'stac'); }}
                  className="advanced-settings-select"
                  options={[
                    { value: 'vtile', label: 'MVT (Vector Tiles)' },
                    { value: 'wfs', label: 'WFS (Web Feature Service)' },
                    { value: 'stac', label: 'STAC (SpatioTemporal Asset Catalog)' },
                  ]}
                />
                <input
                  type="text"
                  placeholder="Source name"
                  value={vNewName}
                  onChange={(e) => setVNewName(e.target.value)}
                  className="advanced-settings-input"
                />
                <input
                  type="text"
                  placeholder={vNewType === 'wfs'
                    ? 'WFS URL (e.g., https://example.com/geoserver/wfs)'
                    : vNewType === 'stac'
                    ? 'STAC API URL (e.g., https://earth-search.aws.element84.com/v1)'
                    : 'MVT URL (e.g., https://example.com/tiles/{z}/{x}/{y}.pbf)'}
                  value={vNewUrl}
                  onChange={(e) => setVNewUrl(e.target.value)}
                  className="advanced-settings-input"
                />
                {vNewType === 'wfs' && (
                  <input
                    type="text"
                    placeholder="Type name (e.g., namespace:layername)"
                    value={vNewExtra}
                    onChange={(e) => setVNewExtra(e.target.value)}
                    className="advanced-settings-input"
                  />
                )}
                <div className="advanced-settings-form-buttons">
                  <button
                    className="settings-button-primary"
                    onClick={handleVAdd}
                    disabled={vNewType === 'wfs' && !vNewExtra.trim()}
                  >
                    Add
                  </button>
                  <button className="settings-button-secondary" onClick={() => setShowVAddForm(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div className="advanced-settings-section">
            <div className="advanced-settings-section-title">
              <TransferIcon />
              Project Import / Export
            </div>
            <p className="advanced-settings-section-desc">
              Export the full project (all workspaces, layers, styles, view settings and
              stored geometry) as a shareable binary file.
              {hasLockPassword
                ? ' Because a lock password is set, the export is encrypted — importing it will require the same password.'
                : ' No password is set, so the export is unencrypted.'}
            </p>
            <div className="project-transfer-actions">
              <button
                className="settings-button-primary project-transfer-btn"
                onClick={() => void handleExportProject()}
                disabled={exportBusy || importBusy}
              >
                {exportBusy ? 'Exporting…' : 'Export Project'}
              </button>
              <button
                className="settings-button-secondary project-transfer-btn"
                onClick={() => importFileRef.current?.click()}
                disabled={exportBusy || importBusy}
              >
                {importBusy && !importNeedsPassword ? 'Importing…' : 'Import Project'}
              </button>
              <input
                ref={importFileRef}
                type="file"
                accept={PROJECT_FILE_EXTENSION}
                style={{ display: 'none' }}
                onChange={(e) => void handleImportFileSelected(e)}
              />
            </div>
            {transferStatus && (
              <div className="project-transfer-status">{transferStatus}</div>
            )}
            {importError && (
              <div className="advanced-settings-error">{importError}</div>
            )}
            {importNeedsPassword && (
              <div className="project-transfer-password">
                <p className="project-transfer-password-label">
                  This project file is encrypted. Enter the password to import it:
                </p>
                <div className="project-transfer-password-row">
                  <input
                    type="password"
                    value={importPassword}
                    onChange={(e) => { setImportPassword(e.target.value); setImportError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleImportWithPassword(); }}
                    placeholder="Project password"
                    className="advanced-settings-input project-transfer-password-input"
                    autoFocus
                    disabled={importBusy}
                  />
                  <button
                    className="settings-button-primary"
                    onClick={() => void handleImportWithPassword()}
                    disabled={importBusy || !importPassword}
                  >
                    {importBusy ? 'Decrypting…' : 'Unlock & Import'}
                  </button>
                  <button
                    className="settings-button-secondary"
                    onClick={cancelImport}
                    disabled={importBusy}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


