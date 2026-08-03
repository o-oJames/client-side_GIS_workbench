import { useState, useRef } from 'react';
import { KnownSource } from '../types';
import { probeDirectStacItem, stacItemLabel } from '../utils/layerHelpers';
import { CustomSelect } from './CustomSelect';
import { LoadingIndicator } from './LoadingIndicator';

// --- Component interface -------------------------------------------------

interface AddVectorLayerFormProps {
  knownSources: KnownSource[];
  onAddVectorLayer: (file: File, layerName?: string) => Promise<void>;
  onAddMVTLayer: (url: string, name: string) => Promise<void>;
  onAddWFSLayer: (url: string, typeName: string, name: string) => Promise<void>;
  onAddSTACLayer: (url: string, collection: string, name: string, limit?: number) => Promise<void>;
  onClose: () => void; // collapses the form
}

/**
 * Self-contained "Add Vector Layer" form (extracted from SettingsDialog).
 * Handles File (GeoJSON/KML/KMZ), MVT, WFS (with GetCapabilities feature-type
 * discovery), STAC (with collection discovery / direct-item probing) and
 * saved known-source vector layers.
 */
export function AddVectorLayerForm({
  knownSources,
  onAddVectorLayer,
  onAddMVTLayer,
  onAddWFSLayer,
  onAddSTACLayer,
  onClose,
}: AddVectorLayerFormProps) {
  // --- Form state --------------------------------------------------------

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAddVectorForm, setShowAddVectorForm] = useState(false);
  const [vectorSourceType, setVectorSourceType] = useState<'file' | 'mvt' | 'wfs' | 'stac' | 'known'>('file');
  const [mvtUrl, setMvtUrl] = useState('');
  const [mvtLayerName, setMvtLayerName] = useState('');
  const [fileLayerName, setFileLayerName] = useState('');
  const [selectedVectorSourceId, setSelectedVectorSourceId] = useState('');
  const [wfsTypeName, setWfsTypeName] = useState('');
  const [stacCollection, setStacCollection] = useState('');
  const [stacLimit, setStacLimit] = useState(''); // empty = all items
  // WFS feature-type discovery (GetCapabilities) for the type-name selector
  const [wfsTypeOptions, setWfsTypeOptions] = useState<Array<{ name: string; title: string }>>([]);
  const [wfsTypesLoading, setWfsTypesLoading] = useState(false);
  const [wfsTypesError, setWfsTypesError] = useState('');
  const [wfsTypesForUrl, setWfsTypesForUrl] = useState(''); // URL the cached options belong to
  // STAC collection discovery for the collection selector
  const [stacCollectionOptions, setStacCollectionOptions] = useState<Array<{ id: string; title: string }>>([]);
  const [stacCollectionsLoading, setStacCollectionsLoading] = useState(false);
  const [stacCollectionsError, setStacCollectionsError] = useState('');
  const [stacCollectionsForUrl, setStacCollectionsForUrl] = useState(''); // URL the cached options belong to
  // When the URL points directly at a single static STAC Item (e.g. an item
  // JSON hosted on S3) rather than a STAC API catalog, the parsed item is
  // kept here and the collection selector is replaced by an info banner.
  const [stacDirectItem, setStacDirectItem] = useState<any | null>(null);

  // --- Discovery handlers --------------------------------------------------

  /**
   * Fetch the WFS GetCapabilities document for the given URL and extract the
   * advertised feature types (Name + Title) to populate the type selector.
   * Results are cached per URL; opening the selector again for the same URL
   * re-uses them, while editing the URL invalidates the cache.
   */
  const fetchWfsFeatureTypes = async (url: string, force: boolean = false) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!force && wfsTypesForUrl === trimmed && (wfsTypeOptions.length > 0 || wfsTypesLoading)) return;

    setWfsTypesLoading(true);
    setWfsTypesError('');
    setWfsTypesForUrl(trimmed);

    try {
      const sep = trimmed.includes('?') ? '&' : '?';
      const capUrl = trimmed + sep + new URLSearchParams({ service: 'WFS', request: 'GetCapabilities' }).toString();
      const response = await fetch(capUrl);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();

      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('Response is not valid XML');
      }

      // Namespace-agnostic walk over <FeatureType> entries (WFS 1.0/1.1/2.0)
      const featureTypes = doc.getElementsByTagNameNS('*', 'FeatureType');
      const types: Array<{ name: string; title: string }> = [];
      for (let i = 0; i < featureTypes.length; i++) {
        const ft = featureTypes[i];
        const name = ft.getElementsByTagNameNS('*', 'Name')[0]?.textContent?.trim();
        const title = ft.getElementsByTagNameNS('*', 'Title')[0]?.textContent?.trim();
        if (name) types.push({ name, title: title || name });
      }

      setWfsTypeOptions(types);
      if (types.length === 0) {
        setWfsTypesError('No feature types advertised by this service.');
      }
    } catch (error) {
      console.error('Failed to fetch WFS capabilities:', error);
      setWfsTypeOptions([]);
      setWfsTypesError('Could not read feature types from this URL. Check the service and try again.');
    } finally {
      setWfsTypesLoading(false);
    }
  };


  /**
   * Fetch the list of collections from a STAC API endpoint.
   * Caches results per URL so re-opening the dropdown re-uses them,
   * while editing the URL invalidates the cache.
   */
  const fetchStacCollections = async (url: string, force: boolean = false) => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    if (!force && stacCollectionsForUrl === trimmed && (stacCollectionOptions.length > 0 || stacCollectionsLoading || stacDirectItem)) return;

    setStacCollectionsLoading(true);
    setStacCollectionsError('');
    setStacDirectItem(null);
    setStacCollectionsForUrl(trimmed);

    try {
      const collectionsUrl = trimmed + '/collections';
      const response = await fetch(collectionsUrl);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();

      const collections: Array<{ id: string; title: string }> = [];
      if (Array.isArray(data.collections)) {
        for (const col of data.collections) {
          if (col.id) {
            collections.push({ id: col.id, title: col.title || col.id });
          }
        }
      }

      setStacCollectionOptions(collections);
      if (collections.length === 0) {
        setStacCollectionsError('No collections found at this STAC API.');
      }
    } catch (error) {
      setStacCollectionOptions([]);
      // Not a STAC API catalog: the URL may point directly at a single
      // static STAC Item JSON document (e.g. an item hosted on S3). Probe
      // it before declaring the URL unusable.
      const item = await probeDirectStacItem(trimmed);
      if (item) {
        setStacDirectItem(item);
        setStacCollectionsError('');
        // Auto-fill the layer name from the item when the field is empty.
        setMvtLayerName(prev => prev.trim() ? prev : stacItemLabel(item));
      } else {
        // Neither a catalog nor an item — surface the original failure.
        console.error('Failed to fetch STAC collections:', error);
        setStacDirectItem(null);
        setStacCollectionsError('Could not read collections from this URL, and it is not a direct STAC Item. Check the URL and try again.');
      }
    } finally {
      setStacCollectionsLoading(false);
    }
  };

  // --- Render --------------------------------------------------------------

  return (
    <>
      {!showAddVectorForm ? (
        <button 
          className="settings-add-button"
          onClick={() => setShowAddVectorForm(true)}
        >
          + Add Vector Layer
        </button>
      ) : (
        <div className="settings-add-form">
          <CustomSelect
            value={vectorSourceType}
            onChange={(val) => setVectorSourceType(val as 'file' | 'mvt' | 'wfs' | 'stac' | 'known')}
            className="settings-select"
            options={[
              { value: 'file', label: 'File (GeoJSON/KML/KMZ)' },
              { value: 'mvt', label: 'MVT (Vector Tiles)' },
              { value: 'wfs', label: 'WFS (Web Feature Service)' },
              { value: 'stac', label: 'STAC (SpatioTemporal Asset Catalog)' },
              ...(knownSources.filter(s => s.type === 'vtile' || s.type === 'wfs' || s.type === 'stac').length > 0 ? [{ value: 'known', label: 'Saved source' }] : []),
            ]}
          />
          {vectorSourceType === 'file' ? (
            <>
              <input
                type="text"
                placeholder="Layer name (optional)"
                value={fileLayerName}
                onChange={(e) => setFileLayerName(e.target.value)}
                className="settings-input"
              />
              <input
                type="file"
                accept=".geojson,.json,.kml,.kmz"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    onAddVectorLayer(file, fileLayerName.trim() || undefined);
                    setFileLayerName('');
                    setShowAddVectorForm(false);
                    onClose();
                  }
                  e.target.value = '';
                }}
                style={{ display: 'none' }}
                ref={fileInputRef}
              />
              <button
                className="settings-add-button"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose File
              </button>
            </>
          ) : vectorSourceType === 'mvt' ? (
            <>
              <input
                type="text"
                placeholder="Layer name"
                value={mvtLayerName}
                onChange={(e) => setMvtLayerName(e.target.value)}
                className="settings-input"
              />
              <input
                type="text"
                placeholder="MVT URL (e.g., https://example.com/tiles/{z}/{x}/{y}.pbf)"
                value={mvtUrl}
                onChange={(e) => setMvtUrl(e.target.value)}
                className="settings-input"
              />
            </>
          ) : vectorSourceType === 'wfs' ? (
            <>
              <input
                type="text"
                placeholder="Layer name"
                value={mvtLayerName}
                onChange={(e) => setMvtLayerName(e.target.value)}
                className="settings-input"
              />
              <input
                type="text"
                placeholder="WFS URL (e.g., https://example.com/geoserver/wfs)"
                value={mvtUrl}
                onChange={(e) => {
                  const val = e.target.value;
                  setMvtUrl(val);
                  // Editing the URL invalidates any previously fetched types
                  if (val.trim() !== wfsTypesForUrl) {
                    setWfsTypeOptions([]);
                    setWfsTypesForUrl('');
                    setWfsTypesError('');
                    setWfsTypeName('');
                  }
                }}
                className="settings-input"
              />
              <CustomSelect
                value={wfsTypeName}
                onChange={(val) => {
                  setWfsTypeName(val);
                  // Auto-fill the layer name from the chosen type's title
                  const t = wfsTypeOptions.find(o => o.name === val);
                  if (t && !mvtLayerName.trim()) setMvtLayerName(t.title);
                }}
                disabled={!mvtUrl.trim() || wfsTypesLoading}
                onOpen={() => fetchWfsFeatureTypes(mvtUrl)}
                filterable
                className="settings-select"
                placeholder={
                  !mvtUrl.trim()
                    ? 'Enter a WFS URL first'
                    : wfsTypesLoading
                    ? 'Reading feature types…'
                    : 'Select a feature type'
                }
                options={wfsTypeOptions.map(t => ({
                  value: t.name,
                  label: t.title !== t.name ? t.title + ' (' + t.name + ')' : t.name,
                }))}
              />
              {wfsTypesLoading && (
                <LoadingIndicator message="Reading feature types from service..." />
              )}
              {wfsTypesError && !wfsTypesLoading && (
                <div className="settings-error-message">{wfsTypesError}</div>
              )}
            </>
          ) : vectorSourceType === 'stac' ? (
            <>
              <input
                type="text"
                placeholder="Layer name"
                value={mvtLayerName}
                onChange={(e) => setMvtLayerName(e.target.value)}
                className="settings-input"
              />
              <input
                type="text"
                placeholder="STAC API or Item URL (e.g., https://earth-search.aws.element84.com/v1)"
                value={mvtUrl}
                onChange={(e) => {
                  const val = e.target.value;
                  setMvtUrl(val);
                  // Editing the URL invalidates any previously fetched collections
                  if (val.trim().replace(/\/+$/, '') !== stacCollectionsForUrl) {
                    setStacCollectionOptions([]);
                    setStacCollectionsForUrl('');
                    setStacCollectionsError('');
                    setStacCollection('');
                    setStacDirectItem(null);
                  }
                }}
                onBlur={() => { if (mvtUrl.trim()) fetchStacCollections(mvtUrl); }}
                className="settings-input"
              />
              {stacDirectItem ? (
                <div className="settings-info-message stac-item-banner">
                  <div className="stac-item-banner-title">Direct STAC Item detected</div>
                  <div className="stac-item-banner-label">{stacItemLabel(stacDirectItem)}</div>
                  <div className="stac-item-banner-hint">
                    No collection needed — the item's footprint will be added as a single feature with all of its properties.
                  </div>
                </div>
              ) : (
                <>
                  <CustomSelect
                    value={stacCollection}
                    onChange={(val) => {
                      setStacCollection(val);
                      // Auto-fill the layer name from the chosen collection's title
                      const c = stacCollectionOptions.find(o => o.id === val);
                      if (c && !mvtLayerName.trim()) setMvtLayerName(c.title);
                    }}
                    disabled={!mvtUrl.trim() || stacCollectionsLoading}
                    onOpen={() => fetchStacCollections(mvtUrl)}
                    filterable
                    className="settings-select"
                    placeholder={
                      !mvtUrl.trim()
                        ? 'Enter a STAC API or Item URL first'
                        : stacCollectionsLoading
                        ? 'Loading collections\u2026'
                        : 'Select a collection'
                    }
                    options={stacCollectionOptions.map(c => ({
                      value: c.id,
                      label: c.title !== c.id ? c.title + ' (' + c.id + ')' : c.id,
                    }))}
                  />
                  {stacCollectionsLoading && (
                    <LoadingIndicator message="Loading collections from STAC API..." />
                  )}
                  {stacCollectionsError && !stacCollectionsLoading && (
                    <div className="settings-error-message">{stacCollectionsError}</div>
                  )}
                  <input
                    type="number"
                    min="1"
                    placeholder="Item limit (blank = fetch all)"
                    value={stacLimit}
                    onChange={(e) => setStacLimit(e.target.value)}
                    className="settings-input"
                  />
                </>
              )}
            </>
          ) : (
            <>
              <input
                type="text"
                placeholder="Layer name (optional)"
                value={mvtLayerName}
                onChange={(e) => setMvtLayerName(e.target.value)}
                className="settings-input"
              />
              <CustomSelect
                value={selectedVectorSourceId}
                onChange={(val) => {
                  const src = knownSources.find(s => s.id === val);
                  // WFS sources only store a URL: jump into the WFS form so the
                  // feature type can be picked from the live dropdown.
                  if (src && src.type === 'wfs') {
                    setVectorSourceType('wfs');
                    setMvtUrl(src.url);
                    if (!mvtLayerName.trim()) setMvtLayerName(src.name);
                    // Legacy sources may carry a saved type name — preselect it
                    setWfsTypeName(src.wfsTypeName || '');
                    setSelectedVectorSourceId('');
                    fetchWfsFeatureTypes(src.url);
                    return;
                  }
                  // STAC sources only store a URL: jump into the STAC form so the
                  // collection can be picked from the live dropdown.
                  if (src && src.type === 'stac') {
                    setVectorSourceType('stac');
                    setMvtUrl(src.url);
                    if (!mvtLayerName.trim()) setMvtLayerName(src.name);
                    setStacCollection('');
                    setStacDirectItem(null);
                    setSelectedVectorSourceId('');
                    fetchStacCollections(src.url);
                    return;
                  }
                  setSelectedVectorSourceId(val);
                  // Auto-fill name from source if name field is empty
                  if (src && !mvtLayerName.trim()) {
                    setMvtLayerName(src.name);
                  }
                }}
                className="settings-select"
                options={[
                  { value: '', label: 'Select a saved vector source...', disabled: true },
                  ...knownSources.filter(s => s.type === 'vtile' || s.type === 'wfs' || s.type === 'stac').map(s => ({
                    value: s.id,
                    label: s.name + ' [' + s.type.toUpperCase() + '] (' + s.url.substring(0, 40) + (s.url.length > 40 ? '...' : '') + ')',
                  })),
                ]}
              />
            </>
          )}
          <div className="settings-form-buttons">
            {(vectorSourceType === 'mvt' || vectorSourceType === 'wfs' || vectorSourceType === 'stac' || vectorSourceType === 'known') && (
              <button 
                className="settings-button-primary" 
                onClick={() => {
                  if (vectorSourceType === 'known') {
                    const src = knownSources.find(s => s.id === selectedVectorSourceId);
                    if (src) {
                      // WFS sources jump into the WFS form when selected (to pick
                      // a feature type), so they never reach this branch.
                      const layerName = mvtLayerName.trim() || src.name;
                      if (src.type === 'stac') {
                        onAddSTACLayer(src.url, src.stacCollection || '', layerName, src.stacLimit);
                      } else {
                        onAddMVTLayer(src.url, layerName);
                      }
                      setMvtUrl('');
                      setMvtLayerName('');
                      setSelectedVectorSourceId('');
                      setShowAddVectorForm(false);
                      onClose();
                    }
                  } else if (vectorSourceType === 'wfs') {
                    if (mvtLayerName.trim() && mvtUrl.trim() && wfsTypeName.trim()) {
                      onAddWFSLayer(mvtUrl.trim(), wfsTypeName.trim(), mvtLayerName.trim());
                      setMvtUrl('');
                      setMvtLayerName('');
                      setWfsTypeName('');
                      setWfsTypeOptions([]);
                      setWfsTypesForUrl('');
                      setWfsTypesError('');
                      setShowAddVectorForm(false);
                      onClose();
                    }
                  } else if (vectorSourceType === 'stac') {
                    if (mvtLayerName.trim() && mvtUrl.trim() && (stacCollection.trim() || stacDirectItem)) {
                      const parsedLimit = stacLimit.trim() ? parseInt(stacLimit.trim(), 10) : undefined;
                      // Direct STAC Item sources pass an empty collection: the
                      // loader then fetches the URL itself as a single item.
                      onAddSTACLayer(
                        mvtUrl.trim(),
                        stacDirectItem ? '' : stacCollection.trim(),
                        mvtLayerName.trim(),
                        stacDirectItem ? undefined : (parsedLimit && parsedLimit > 0 ? parsedLimit : undefined),
                      );
                      setMvtUrl('');
                      setMvtLayerName('');
                      setStacCollection('');
                      setStacCollectionOptions([]);
                      setStacCollectionsForUrl('');
                      setStacCollectionsError('');
                      setStacDirectItem(null);
                      setStacLimit('');
                      setShowAddVectorForm(false);
                      onClose();
                    }
                  } else {
                    if (mvtLayerName.trim() && mvtUrl.trim()) {
                      onAddMVTLayer(mvtUrl.trim(), mvtLayerName.trim());
                      setMvtUrl('');
                      setMvtLayerName('');
                      setShowAddVectorForm(false);
                      onClose();
                    }
                  }
                }}
                disabled={
                  (vectorSourceType === 'known' && !selectedVectorSourceId) ||
                  (vectorSourceType === 'wfs' && !(mvtLayerName.trim() && mvtUrl.trim() && wfsTypeName.trim())) ||
                  (vectorSourceType === 'stac' && !(mvtLayerName.trim() && mvtUrl.trim() && (stacCollection.trim() || stacDirectItem)))
                }
              >
                Add
              </button>
            )}
            <button 
              className="settings-button-secondary" 
              onClick={() => {
                setShowAddVectorForm(false);
                setSelectedVectorSourceId('');
                setFileLayerName('');
                setMvtUrl('');
                setMvtLayerName('');
                setWfsTypeName('');
                setStacCollection('');
                setStacCollectionOptions([]);
                setStacCollectionsForUrl('');
                setStacCollectionsError('');
                setStacDirectItem(null);
                setStacLimit('');
                setWfsTypeOptions([]);
                setWfsTypesForUrl('');
                setWfsTypesError('');
                onClose();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
