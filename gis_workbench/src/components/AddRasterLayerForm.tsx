/**
 * AddRasterLayerForm — the "Add Raster Layer" button + expandable form for
 * creating XYZ, WMTS, WMS, COG (GeoTIFF) and known-source raster layers.
 * Manages all of its own form state (including WMTS/WMS capabilities
 * discovery and COG validation) and emits a finished RasterLayer config
 * through onAddRasterLayer. Extracted from SettingsDialog per AGENTS.md §3.
 */
import { useState, useRef } from 'react';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import {
  RasterLayer,
  KnownSource,
  WmtsLayerInfo,
  WmsLayerInfo,
} from '../types';
import { validateCogBuffer, buildS3HttpsUrl, hasS3Credentials, presignS3Url, parseS3Url, MAX_NON_COG_TIFF_SIZE, COG_HEADER_VALIDATION_BYTES } from '../utils/cogHelpers';
import { encryptCogCredentials, extractCogCredentials } from '../utils/cogCredentials';
import { getCogEncryptionKey } from '../utils/companion';
import type { S3Config } from '../utils/cogHelpers';
import { registerCogFile } from '../utils/cogFileRegistry';
import { CustomSelect } from './CustomSelect';
import { LoadingIndicator } from './LoadingIndicator';
import { TileZoomRangeControl, parseZoomInput } from './TileZoomRangeControl';

/**
 * Turn a thrown value into a message that is safe to show inline. Multi-line
 * guidance (e.g. the COG CORS explainer built in rasterLayerFactory) is kept
 * verbatim — the error block renders with `white-space: pre-wrap`.
 */
function describeAddError(error: unknown, fallback: string): string {
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return msg.trim() ? msg.trim() : fallback;
}

export interface AddRasterLayerFormProps {
  knownSources: KnownSource[];
  /** Existing raster layers — used only to auto-name unnamed XYZ layers (xyz_N). */
  existingRasterLayers: RasterLayer[];
  /**
   * Add the finished config to the map. Must reject on failure: the form only
   * collapses and clears its inputs after a resolved add, and renders the
   * rejection message above the Add/Cancel buttons otherwise.
   */
  onAddRasterLayer: (layer: RasterLayer) => Promise<void>;
  onClose: () => void;  // collapses the form
}

export function AddRasterLayerForm({
  knownSources,
  existingRasterLayers,
  onAddRasterLayer,
  onClose,
}: AddRasterLayerFormProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLayerName, setNewLayerName] = useState('');
  const [newLayerType, setNewLayerType] = useState<'xyz' | 'wmts' | 'wms' | 'known' | 'cog'>('xyz');
  const [newLayerUrl, setNewLayerUrl] = useState('');
  const [newMinZoom, setNewMinZoom] = useState('');
  const [newMaxZoom, setNewMaxZoom] = useState('');
  const [wmtsCapabilitiesUrl, setWmtsCapabilitiesUrl] = useState('');
  const [wmtsLayers, setWmtsLayers] = useState<WmtsLayerInfo[]>([]);
  const [selectedWmtsLayer, setSelectedWmtsLayer] = useState('');
  const [wmtsLoading, setWmtsLoading] = useState(false);
  const [wmtsFetched, setWmtsFetched] = useState(false);
  const [wmsCapabilitiesUrl, setWmsCapabilitiesUrl] = useState('');
  const [wmsLayers, setWmsLayers] = useState<WmsLayerInfo[]>([]);
  const [selectedWmsLayer, setSelectedWmsLayer] = useState('');
  const [wmsLoading, setWmsLoading] = useState(false);
  const [wmsFetched, setWmsFetched] = useState(false);
  const nameManuallyEditedRef = useRef(false);
  const [addingRaster, setAddingRaster] = useState(false);
  /**
   * Failure message for the latest Add attempt, rendered directly above the
   * Add/Cancel buttons. While it is set the form stays open with every input
   * intact, so a typo can be corrected without re-typing the whole layer.
   */
  const [addFormError, setAddFormError] = useState('');

  // ----- COG (Cloud Optimized GeoTIFF) add-form state -----
  const [cogSourceType, setCogSourceType] = useState<'file' | 'http' | 's3'>('http');
  const [cogHttpUrl, setCogHttpUrl] = useState('');
  const [cogS3Url, setCogS3Url] = useState('');
  const [cogRegion, setCogRegion] = useState('');
  const [cogEndpoint, setCogEndpoint] = useState('');
  const [cogAccessKeyId, setCogAccessKeyId] = useState('');
  const [cogSecretAccessKey, setCogSecretAccessKey] = useState('');
  const [cogSessionToken, setCogSessionToken] = useState('');
  const [cogFile, setCogFile] = useState<File | null>(null);
  const [cogFileError, setCogFileError] = useState('');
  const [cogFileValidating, setCogFileValidating] = useState(false);
  const [cogShowCredentials, setCogShowCredentials] = useState(false);
  const cogFileInputRef = useRef<HTMLInputElement>(null);

  // "Add from known source" state
  const [selectedKnownSourceId, setSelectedKnownSourceId] = useState('');
  const [knownSourceLayers, setKnownSourceLayers] = useState<Array<{id: string; title: string}>>([]);
  const [selectedKnownSourceLayer, setSelectedKnownSourceLayer] = useState('');
  const [knownSourceLoading, setKnownSourceLoading] = useState(false);
  const [knownSourceFetched, setKnownSourceFetched] = useState(false);

  const fetchKnownSourceCapabilities = async (sourceId: string) => {
    const source = knownSources.find(s => s.id === sourceId);
    if (!source) return;

    setKnownSourceLoading(true);
    setKnownSourceFetched(false);
    setKnownSourceLayers([]);
    setSelectedKnownSourceLayer('');

    // XYZ sources don't have capabilities to fetch - just set as fetched with no layers
    if (source.type === 'xyz') {
      setKnownSourceFetched(true);
      setKnownSourceLoading(false);
      return;
    }

    try {
      const response = await fetch(source.url);
      const text = await response.text();

      if (source.type === 'wmts') {
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        // OL WMTSCapabilities layers are untyped JSON — `any` per field access.
        const layers = (capabilities.Contents?.Layer || []).map((layer: any) => ({
          id: layer.Identifier,
          title: layer.Title || layer.Identifier,
        }));
        setKnownSourceLayers(layers);
        setKnownSourceFetched(true);
        if (layers.length > 0) {
          setSelectedKnownSourceLayer(layers[0].id);
        }
      } else {
        // WMS
        const parser = new WMSCapabilities();
        const capabilities = parser.read(text);
        const extractLayers = (arr: any[], depth: number = 0): Array<{id: string; title: string}> => {
          if (!arr) return [];
          const result: Array<{id: string; title: string}> = [];
          arr.forEach((layer: any) => {
            if (layer.Name) {
              result.push({ id: layer.Name, title: '  '.repeat(depth) + (layer.Title || layer.Name) });
            }
            result.push(...extractLayers(layer.Layer, depth + 1));
          });
          return result;
        };
        const layers = extractLayers(capabilities.Capability?.Layer?.Layer || []);
        setKnownSourceLayers(layers);
        setKnownSourceFetched(true);
        if (layers.length > 0) {
          setSelectedKnownSourceLayer(layers[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to fetch capabilities for known source:', error);
      setKnownSourceLayers([]);
      setKnownSourceFetched(false);
    } finally {
      setKnownSourceLoading(false);
    }
  };

  const extractWmsLayers = (layerArray: any[] | undefined, depth: number = 0): WmsLayerInfo[] => {
    if (!layerArray) return [];
    
    const result: WmsLayerInfo[] = [];
    const indent = '  '.repeat(depth);
    
    layerArray.forEach((layer: any) => {
      if (layer.Name) {
        result.push({
          name: layer.Name,
          title: indent + (layer.Title || layer.Name),
        });
      }
      // Recursively extract sub-layers
      result.push(...extractWmsLayers(layer.Layer, depth + 1));
    });
    
    return result;
  };

  const fetchWmsCapabilities = async () => {
    if (!wmsCapabilitiesUrl.trim() || wmsLoading) return;
    
    setWmsLoading(true);
    try {
      const response = await fetch(wmsCapabilitiesUrl.trim());
      const text = await response.text();
      const parser = new WMSCapabilities();
      const capabilities = parser.read(text);
      
      const layers = extractWmsLayers(capabilities.Capability?.Layer?.Layer || []);
      
      setWmsLayers(layers);
      setWmsFetched(true);
      if (layers.length > 0 && !selectedWmsLayer) {
        setSelectedWmsLayer(layers[0].name);
        if (!nameManuallyEditedRef.current) {
          setNewLayerName(layers[0].title.trim());
        }
      }
    } catch (error) {
      console.error('Failed to fetch WMS capabilities:', error);
      setWmsLayers([]);
      setWmsFetched(false);
    } finally {
      setWmsLoading(false);
    }
  };

  const fetchWmtsCapabilities = async () => {
    if (!wmtsCapabilitiesUrl.trim() || wmtsLoading) return;
    
    setWmtsLoading(true);
    try {
      const response = await fetch(wmtsCapabilitiesUrl.trim());
      const text = await response.text();
      const parser = new WMTSCapabilities();
      const capabilities = parser.read(text);
      
      const layers: WmtsLayerInfo[] = (capabilities.Contents?.Layer || []).map((layer: any) => ({
        identifier: layer.Identifier,
        title: layer.Title || layer.Identifier,
      }));
      
      setWmtsLayers(layers);
      setWmtsFetched(true);
      if (layers.length > 0 && !selectedWmtsLayer) {
        setSelectedWmtsLayer(layers[0].identifier);
        if (!nameManuallyEditedRef.current) {
          setNewLayerName(layers[0].title);
        }
      }
    } catch (error) {
      console.error('Failed to fetch WMTS capabilities:', error);
      setWmtsLayers([]);
      setWmtsFetched(false);
    } finally {
      setWmtsLoading(false);
    }
  };

  /**
   * Build the layer config, then hand it to the map.
   *
   * The form collapses (and its inputs are cleared) only once the layer has
   * actually been added to the map. Any failure — validation, reading a file
   * header, S3 pre-signing, CORS, an unreadable COG — keeps the form open with
   * every field intact and reports the problem just above the Add/Cancel
   * buttons.
   */
  const handleAddLayer = async (existingRasterLayers: RasterLayer[]) => {
    setAddFormError('');
    let layerName = newLayerName.trim();

    let layer: RasterLayer | null = null;

    try {
      if (newLayerType === 'known') {
        const source = knownSources.find(s => s.id === selectedKnownSourceId);
        if (!source) { setAddFormError('Select a known source to add.'); return; }
        if (source.type !== 'xyz' && !selectedKnownSourceLayer) { setAddFormError('Select a layer from this source.'); return; }

        if (!layerName) {
          if (source.type === 'xyz') {
            layerName = source.name;
          } else {
            const matched = knownSourceLayers.find(l => l.id === selectedKnownSourceLayer);
            layerName = matched ? matched.title.trim() : selectedKnownSourceLayer;
          }
        }

        layer = {
          id: Date.now().toString(),
          name: layerName,
          type: source.type as RasterLayer['type'],
          url: source.url,
          ...(source.type === 'wmts' ? {
            wmtsCapabilitiesUrl: source.url,
            wmtsLayer: selectedKnownSourceLayer,
          } : source.type === 'wms' ? {
            wmsCapabilitiesUrl: source.url,
            wmsLayer: selectedKnownSourceLayer,
          } : {}), // XYZ has no extra fields
          ...(source.type === 'xyz' ? {
            minZoom: parseZoomInput(newMinZoom),
            maxZoom: parseZoomInput(newMaxZoom),
          } : {}),
        };
      } else if (newLayerType === 'wmts') {
        if (!wmtsCapabilitiesUrl.trim()) { setAddFormError('Enter the WMTS GetCapabilities URL.'); return; }
        if (!selectedWmtsLayer) { setAddFormError('Select a WMTS layer to add.'); return; }
        if (!layerName) {
          const matched = wmtsLayers.find(l => l.identifier === selectedWmtsLayer);
          layerName = matched ? matched.title : selectedWmtsLayer;
        }
        layer = {
          id: Date.now().toString(),
          name: layerName,
          type: 'wmts',
          url: wmtsCapabilitiesUrl.trim(),
          wmtsCapabilitiesUrl: wmtsCapabilitiesUrl.trim(),
          wmtsLayer: selectedWmtsLayer,
        };
      } else if (newLayerType === 'wms') {
        if (!wmsCapabilitiesUrl.trim()) { setAddFormError('Enter the WMS GetCapabilities URL.'); return; }
        if (!selectedWmsLayer) { setAddFormError('Select a WMS layer to add.'); return; }
        if (!layerName) {
          const matched = wmsLayers.find(l => l.name === selectedWmsLayer);
          layerName = matched ? matched.title.trim() : selectedWmsLayer;
        }
        layer = {
          id: Date.now().toString(),
          name: layerName,
          type: 'wms',
          url: wmsCapabilitiesUrl.trim(),
          wmsCapabilitiesUrl: wmsCapabilitiesUrl.trim(),
          wmsLayer: selectedWmsLayer,
        };
      } else if (newLayerType === 'cog') {
        // --- COG layer ---
        if (cogSourceType === 'file') {
          if (!cogFile) { setAddFormError('Select a GeoTIFF (.tif) file to add.'); return; }
          // Only the header slice is read — the OL GeoTIFF source streams the
          // rest of the file via Range requests on the blob URL, so even very
          // large files (tens of GB) work without loading them into memory.
          let validation: ReturnType<typeof validateCogBuffer>;
          try {
            const header = await cogFile.slice(0, COG_HEADER_VALIDATION_BYTES).arrayBuffer();
            validation = validateCogBuffer(header, cogFile.name, cogFile.size);
          } catch (e) {
            console.warn('[AddRasterLayerForm] Failed to read GeoTIFF header:', e);
            setAddFormError('The file could not be read. It may have been moved or deleted since it was selected.');
            return;
          }
          if (!validation.isTiff) { setAddFormError(validation.error || 'Not a valid TIFF.'); return; }
          if (!validation.isCog && validation.fileSize > MAX_NON_COG_TIFF_SIZE) { setAddFormError(validation.error || 'File too large.'); return; }
          if (!layerName) layerName = cogFile.name.replace(/\.(tif|tiff|geotiff)$/i, '');
          const id = Date.now().toString();
          const blobUrl = registerCogFile(id, cogFile);
          layer = {
            id,
            name: layerName,
            type: 'cog',
            url: blobUrl,
            cogSource: 'file',
            cogFileName: cogFile.name,
          };
        } else if (cogSourceType === 's3') {
          const parsed = parseS3Url(cogS3Url);
          if (!parsed) { setAddFormError('Enter a valid S3 URL, e.g. s3://bucket-name/path/to/file.tif'); return; }
          if (!layerName) layerName = parsed.objectKey.split('/').pop() || 'COG layer';
          const region = cogRegion.trim() || parsed.region || undefined;
          const s3: S3Config = {
            bucket: parsed.bucket,
            objectKey: parsed.objectKey,
            region,
            endpoint: cogEndpoint.trim() || undefined,
            accessKeyId: cogAccessKeyId.trim() || undefined,
            secretAccessKey: cogSecretAccessKey.trim() || undefined,
            sessionToken: cogSessionToken.trim() || undefined,
          };
          const resolvedUrl = hasS3Credentials(s3) ? await presignS3Url(s3, 3600) : buildS3HttpsUrl(s3);

          // Encrypt S3 credentials at rest — plain-text fields are never persisted
          let cogCredentialsEncrypted: string | undefined;
          const plainCreds: Record<string, string> = {};
          if (cogAccessKeyId.trim()) plainCreds.cogAccessKeyId = cogAccessKeyId.trim();
          if (cogSecretAccessKey.trim()) plainCreds.cogSecretAccessKey = cogSecretAccessKey.trim();
          if (cogSessionToken.trim()) plainCreds.cogSessionToken = cogSessionToken.trim();
          if (Object.keys(plainCreds).length > 0) {
            try {
              const encKey = await getCogEncryptionKey();
              cogCredentialsEncrypted = await encryptCogCredentials(plainCreds, encKey);
            } catch (e) {
              console.warn('[AddRasterLayerForm] Failed to encrypt COG credentials:', e);
            }
          }

          layer = {
            id: Date.now().toString(),
            name: layerName,
            type: 'cog',
            url: resolvedUrl,
            cogSource: 's3',
            cogBucket: parsed.bucket,
            cogObjectKey: parsed.objectKey,
            cogRegion: region,
            cogEndpoint: cogEndpoint.trim() || undefined,
            cogCredentialsEncrypted,
          };
        } else {
          // HTTP URL
          if (!cogHttpUrl.trim()) { setAddFormError('Enter the GeoTIFF (COG) URL.'); return; }
          if (!layerName) layerName = cogHttpUrl.split('/').pop()?.split('?')[0] || 'COG layer';
          layer = {
            id: Date.now().toString(),
            name: layerName,
            type: 'cog',
            url: cogHttpUrl.trim(),
            cogSource: 'http',
          };
        }
      } else {
        if (!newLayerUrl.trim()) { setAddFormError('Enter the XYZ tile URL.'); return; }
        if (!layerName) {
          const xyzCount = existingRasterLayers.filter(l => l.name.startsWith('xyz_')).length;
          layerName = 'xyz_' + (xyzCount + 1);
        }
        layer = {
          id: Date.now().toString(),
          name: layerName,
          type: 'xyz',
          url: newLayerUrl.trim(),
          minZoom: parseZoomInput(newMinZoom),
          maxZoom: parseZoomInput(newMaxZoom),
        };
      }
    } catch (error) {
      // Building the config can fail on its own (reading a GeoTIFF header,
      // pre-signing an S3 URL, encrypting credentials).
      setAddFormError(describeAddError(error, 'Could not prepare this layer. Check the inputs and try again.'));
      return;
    }

    if (!layer) return;

    
    setAddingRaster(true);
    try {
      await onAddRasterLayer(layer);
    } catch (error) {
      // The layer never made it onto the map: leave the form open, leave every
      // input untouched, and explain the failure next to the buttons.
      setAddFormError(describeAddError(error, 'Failed to add this layer to the map.'));
      return;
    } finally {
      setAddingRaster(false);
    }
    setNewLayerName('');
    setNewLayerUrl('');
    setNewMinZoom('');
    setNewMaxZoom('');
    setWmtsCapabilitiesUrl('');
    setWmtsLayers([]);
    setSelectedWmtsLayer('');
    setWmtsFetched(false);
    setWmsCapabilitiesUrl('');
    setWmsLayers([]);
    setSelectedWmsLayer('');
    setWmsFetched(false);
    nameManuallyEditedRef.current = false;
    // Reset known source state
    setSelectedKnownSourceId('');
    setKnownSourceLayers([]);
    setSelectedKnownSourceLayer('');
    setKnownSourceFetched(false);
    setShowAddForm(false);
    // Reset COG state
    setCogSourceType('http');
    setCogHttpUrl('');
    setCogS3Url('');
    setCogRegion('');
    setCogEndpoint('');
    setCogAccessKeyId('');
    setCogSecretAccessKey('');
    setCogSessionToken('');
    setCogFile(null);
    setCogFileError('');
    setCogShowCredentials(false);
    onClose();
  };

  const selectedKnownSource = knownSources.find(s => s.id === selectedKnownSourceId);
  const addingXyzLayer =
    newLayerType === 'xyz' || (newLayerType === 'known' && selectedKnownSource?.type === 'xyz');

  return (
    <>
      {addingRaster && (
        <LoadingIndicator message="Adding layer..." />
      )}
      {!showAddForm ? (
        <button 
          className="settings-add-button"
          onClick={() => setShowAddForm(true)}
        >
          + Add Raster Layer
        </button>
      ) : (
        <div className="settings-add-form">
          <CustomSelect
            value={newLayerType}
            onChange={(val) => {
              setNewLayerType(val as 'xyz' | 'wmts' | 'wms' | 'known' | 'cog');
              setAddFormError('');
              setWmtsLayers([]);
              setWmtsFetched(false);
              setSelectedWmtsLayer('');
              setWmsLayers([]);
              setWmsFetched(false);
              setSelectedWmsLayer('');
              nameManuallyEditedRef.current = false;
              // Reset known source state
              setSelectedKnownSourceId('');
              setKnownSourceLayers([]);
              setSelectedKnownSourceLayer('');
              setKnownSourceFetched(false);
            }}
            className="settings-select"
            options={[
              { value: 'xyz', label: 'XYZ' },
              { value: 'wmts', label: 'WMTS' },
              { value: 'wms', label: 'WMS' },
              { value: 'cog', label: 'COG (GeoTIFF)' },
              ...(knownSources.filter(s => s.type !== 'vtile' && s.type !== 'wfs' && s.type !== 'stac').length > 0 ? [{ value: 'known', label: 'Known source' }] : []),
            ]}
          />
          <input
            type="text"
            placeholder="Layer name"
            value={newLayerName}
            onChange={(e) => { setNewLayerName(e.target.value); nameManuallyEditedRef.current = true; }}
            className="settings-input"
          />
          {newLayerType === 'xyz' ? (
            <input
              type="text"
              placeholder="XYZ URL ({'{z}/{x}/{y}'} or {'{q}'} quadkey, e.g., https://tile.example.com/{'{z}/{x}/{y}'}.png)"
              value={newLayerUrl}
              onChange={(e) => setNewLayerUrl(e.target.value)}
              className="settings-input"
            />
          ) : newLayerType === 'known' ? (
            <>
              <CustomSelect
                value={selectedKnownSourceId}
                onChange={(val) => {
                  setSelectedKnownSourceId(val);
                  if (val) {
                    // Prefill layer name with source name
                    const src = knownSources.find(s => s.id === val);
                    if (src && !nameManuallyEditedRef.current) {
                      setNewLayerName(src.name);
                    }
                    fetchKnownSourceCapabilities(val);
                  } else {
                    setKnownSourceLayers([]);
                    setSelectedKnownSourceLayer('');
                    setKnownSourceFetched(false);
                  }
                }}
                className="settings-select"
                options={[
                  { value: '', label: 'Select a source', disabled: true },
                  ...knownSources.filter(s => s.type !== 'vtile' && s.type !== 'wfs' && s.type !== 'stac').map(s => ({ 
                    value: s.id, 
                    label: `${s.name} (${s.type.toUpperCase()})` 
                  })),
                ]}
              />
              {knownSourceLoading && (
                <LoadingIndicator message="Loading layers..." />
              )}
              {knownSourceFetched && knownSourceLayers.length === 0 && selectedKnownSourceId && (() => {
                const source = knownSources.find(s => s.id === selectedKnownSourceId);
                return source?.type === 'xyz' ? (
                  <div className="settings-info-message">
                    XYZ tile sources don't have multiple layers. Enter a name and add the layer.
                  </div>
                ) : null;
              })()}
              {knownSourceFetched && knownSourceLayers.length > 0 && (
                <CustomSelect
                  value={selectedKnownSourceLayer}
                  onChange={(val) => {
                    setSelectedKnownSourceLayer(val);
                    const matched = knownSourceLayers.find(l => l.id === val);
                    if (matched && !nameManuallyEditedRef.current) {
                      setNewLayerName(matched.title.trim());
                    }
                  }}
                  className="settings-select"
                  placeholder="Select a layer"
                  filterable
                  options={[
                    ...knownSourceLayers.map(l => ({ value: l.id, label: l.title })),
                  ]}
                />
              )}
            </>
          ) : newLayerType === 'wmts' ? (
            <>
              <input
                type="text"
                placeholder="GetCapabilities URL"
                value={wmtsCapabilitiesUrl}
                onChange={(e) => {
                  setWmtsCapabilitiesUrl(e.target.value);
                  setWmtsFetched(false);
                  setWmtsLayers([]);
                }}
                className="settings-input"
              />
              <CustomSelect
                value={selectedWmtsLayer}
                onOpen={() => {
                  if (wmtsCapabilitiesUrl.trim() && !wmtsFetched && !wmtsLoading) {
                    fetchWmtsCapabilities();
                  }
                }}
                onChange={(val) => {
                  setSelectedWmtsLayer(val);
                  const matched = wmtsLayers.find(l => l.identifier === val);
                  if (matched && !nameManuallyEditedRef.current) {
                    setNewLayerName(matched.title);
                  }
                }}
                className="settings-select"
                disabled={!wmtsCapabilitiesUrl.trim()}
                placeholder={wmtsLoading ? 'Loading...' : 'Select a layer'}
                filterable
                options={wmtsLoading ? [] : [
                  ...wmtsLayers.map((layer) => ({ value: layer.identifier, label: layer.title })),
                ]}
              />
            </>
          ) : newLayerType === 'cog' ? (
            <>
              {/* COG source mode selector */}
              <div className="cog-source-tabs">
                {(['http', 's3', 'file'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    className={'cog-source-tab' + (cogSourceType === mode ? ' active' : '')}
                    onClick={() => { setCogSourceType(mode); setCogFileError(''); setAddFormError(''); }}
                  >
                    {mode === 'http' ? 'HTTP URL' : mode === 's3' ? 'S3 / Object Storage' : 'Local File'}
                  </button>
                ))}
              </div>

              {cogSourceType === 'http' && (
                <input
                  type="text"
                  placeholder="https://example.com/data/cog.tif"
                  value={cogHttpUrl}
                  onChange={(e) => setCogHttpUrl(e.target.value)}
                  className="settings-input"
                />
              )}

              {cogSourceType === 'file' && (
                <div className="cog-file-zone">
                  <input
                    ref={cogFileInputRef}
                    type="file"
                    accept=".tif,.tiff,.geotiff"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0] || null;
                      setCogFile(f);
                      setCogFileError('');
                      if (f) {
                        setCogFileValidating(true);
                        try {
                          const buf = await f.slice(0, COG_HEADER_VALIDATION_BYTES).arrayBuffer();
                          const v = validateCogBuffer(buf, f.name, f.size);
                          if (!v.isTiff) { setCogFileError(v.error || 'Not a valid TIFF file.'); setCogFile(null); }
                          else if (!v.isCog && v.fileSize > MAX_NON_COG_TIFF_SIZE) { setCogFileError(v.error || 'File too large.'); setCogFile(null); }
                          else if (!v.isCog && v.error) { setCogFileError(v.error); }
                          else { setCogFileError(''); }
                        } catch { setCogFileError('Failed to read file.'); setCogFile(null); }
                        finally { setCogFileValidating(false); }
                      }
                    }}
                  />
                  <div
                    className={'cog-drop-area' + (cogFile ? ' has-file' : '')}
                    onClick={() => cogFileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={async (e) => {
                      e.preventDefault(); e.stopPropagation();
                      const f = e.dataTransfer.files?.[0];
                      if (!f) return;
                      const ext = f.name.split('.').pop()?.toLowerCase();
                      if (ext !== 'tif' && ext !== 'tiff' && ext !== 'geotiff') {
                        setCogFileError('Please drop a GeoTIFF file (.tif / .tiff).');
                        return;
                      }
                      setCogFile(f);
                      setCogFileError('');
                      setCogFileValidating(true);
                      try {
                        const buf = await f.slice(0, COG_HEADER_VALIDATION_BYTES).arrayBuffer();
                        const v = validateCogBuffer(buf, f.name, f.size);
                        if (!v.isTiff) { setCogFileError(v.error || 'Not a valid TIFF file.'); setCogFile(null); }
                        else if (!v.isCog && v.fileSize > MAX_NON_COG_TIFF_SIZE) { setCogFileError(v.error || 'File too large.'); setCogFile(null); }
                        else if (!v.isCog && v.error) { setCogFileError(v.error); }
                        else { setCogFileError(''); }
                      } catch { setCogFileError('Failed to read file.'); setCogFile(null); }
                      finally { setCogFileValidating(false); }
                    }}
                  >
                    {cogFileValidating ? (
                      <span>Validating…</span>
                    ) : cogFile ? (
                      <span className="cog-file-name">📄 {cogFile.name} ({(cogFile.size / (1024 * 1024)).toFixed(1)} MB)</span>
                    ) : (
                      <span>Click or drag a GeoTIFF (.tif) file here</span>
                    )}
                  </div>
                  {cogFileError && <div className="cog-error-message">{cogFileError}</div>}
                </div>
              )}

              {cogSourceType === 's3' && (
                <>
                  <input
                    type="text"
                    placeholder="s3://bucket-name/path/to/file.tif"
                    value={cogS3Url}
                    onChange={(e) => setCogS3Url(e.target.value)}
                    className="settings-input"
                    spellCheck={false}
                  />
                  {(() => {
                    const p = parseS3Url(cogS3Url);
                    return p ? (
                      <div className="cog-s3-parsed">bucket <b>{p.bucket}</b> · key <b>{p.objectKey}</b>{p.region ? <> · region <b>{p.region}</b></> : null}</div>
                    ) : cogS3Url.trim() ? (
                      <div className="cog-s3-parsed invalid">Unrecognised URL — expected s3://bucket/key or an S3 HTTPS URL</div>
                    ) : null;
                  })()}
                  <input
                    type="text"
                    placeholder="Region (default: us-east-1)"
                    value={cogRegion}
                    onChange={(e) => setCogRegion(e.target.value)}
                    className="settings-input"
                  />
                  <input
                    type="text"
                    placeholder="Custom endpoint (optional, for MinIO / R2 / etc.)"
                    value={cogEndpoint}
                    onChange={(e) => setCogEndpoint(e.target.value)}
                    className="settings-input"
                  />
                  <button
                    type="button"
                    className="cog-credentials-toggle"
                    onClick={() => setCogShowCredentials(!cogShowCredentials)}
                  >
                    {cogShowCredentials ? '▾ Hide credentials' : '▸ Credentials (optional)'}
                  </button>
                  {cogShowCredentials && (
                    <div className="cog-credentials-fields">
                      <input
                        type="text"
                        placeholder="AWS_ACCESS_KEY_ID"
                        value={cogAccessKeyId}
                        onChange={(e) => setCogAccessKeyId(e.target.value)}
                        className="settings-input"
                        autoComplete="off"
                      />
                      <input
                        type="password"
                        placeholder="AWS_SECRET_ACCESS_KEY"
                        value={cogSecretAccessKey}
                        onChange={(e) => setCogSecretAccessKey(e.target.value)}
                        className="settings-input"
                        autoComplete="off"
                      />
                      <input
                        type="password"
                        placeholder="AWS_SESSION_TOKEN (optional, for temporary creds)"
                        value={cogSessionToken}
                        onChange={(e) => setCogSessionToken(e.target.value)}
                        className="settings-input"
                        autoComplete="off"
                      />
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <input
                type="text"
                placeholder="GetCapabilities URL"
                value={wmsCapabilitiesUrl}
                onChange={(e) => {
                  setWmsCapabilitiesUrl(e.target.value);
                  setWmsFetched(false);
                  setWmsLayers([]);
                }}
                className="settings-input"
              />
              <CustomSelect
                value={selectedWmsLayer}
                onOpen={() => {
                  if (wmsCapabilitiesUrl.trim() && !wmsFetched && !wmsLoading) {
                    fetchWmsCapabilities();
                  }
                }}
                onChange={(val) => {
                  setSelectedWmsLayer(val);
                  const matched = wmsLayers.find(l => l.name === val);
                  if (matched && !nameManuallyEditedRef.current) {
                    setNewLayerName(matched.title.trim());
                  }
                }}
                className="settings-select"
                disabled={!wmsCapabilitiesUrl.trim()}
                placeholder={wmsLoading ? 'Loading...' : 'Select a layer'}
                filterable
                options={wmsLoading ? [] : [
                  ...wmsLayers.map((layer) => ({ value: layer.name, label: layer.title })),
                ]}
              />
            </>
          )}
          {addingXyzLayer && (
            <TileZoomRangeControl
              minValue={newMinZoom}
              maxValue={newMaxZoom}
              onMinChange={setNewMinZoom}
              onMaxChange={setNewMaxZoom}
              collapsible
              defaultOpen={false}
            />
          )}
          {addFormError && (
            <div className="settings-error-message settings-add-form-error" role="alert">
              {addFormError}
            </div>
          )}
          <div className="settings-form-buttons">
            <button
              className="settings-button-primary"
              onClick={() => handleAddLayer(existingRasterLayers)}
              disabled={addingRaster}
            >
              Add
            </button>
            <button className="settings-button-secondary" onClick={() => { setShowAddForm(false); setNewLayerName(''); setAddFormError(''); nameManuallyEditedRef.current = false; onClose(); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
