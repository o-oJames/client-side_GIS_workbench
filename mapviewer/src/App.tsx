import React, { useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import OLMap from 'ol/Map.js';
import OSM from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import ImageLayer from 'ol/layer/Image.js';
import TileDebug from 'ol/source/TileDebug.js';
import XYZ from 'ol/source/XYZ.js';
import WMTS from 'ol/source/WMTS.js';
import { optionsFromCapabilities } from 'ol/source/WMTS.js';
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import ImageWMS from 'ol/source/ImageWMS.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import Attribution from 'ol/control/Attribution.js';
import { defaults as defaultControls } from 'ol/control.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style.js';
import JSZip from 'jszip';
import { fromLonLat, toLonLat } from 'ol/proj.js';

import './App.css';

interface WmtsLayerInfo {
  identifier: string;
  title: string;
}

interface WmsLayerInfo {
  name: string;
  title: string;
}
const extractBaseUrl = (url: string): string => {
  const questionMarkIndex = url.indexOf('?');
  return questionMarkIndex !== -1 ? url.substring(0, questionMarkIndex) : url;
};


interface RasterLayer {
  id: string;
  name: string;
  type: 'xyz' | 'wmts' | 'wms';
  url: string;
  wmtsCapabilitiesUrl?: string;
  wmtsLayer?: string;
  wmsCapabilitiesUrl?: string;
  wmsLayer?: string;
  olLayer?: any;
}

interface VectorLayerConfig {
  id: string;
  name: string;
  type: 'geojson' | 'kml' | 'kmz' | 'shapefile';
  visible: boolean;
  olLayer?: any;
}

const STORAGE_KEY = 'mapviewer-settings';

interface StoredSettings {
  showGrid: boolean;
  rasterLayers: RasterLayer[];
}

function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        showGrid: !!parsed.showGrid,
        rasterLayers: Array.isArray(parsed.rasterLayers) ? parsed.rasterLayers : [],
      };
    }
  } catch (e) {
    console.error('Failed to load settings from localStorage:', e);
  }
  return { showGrid: false, rasterLayers: [] };
}

function saveSettings(settings: StoredSettings) {
  try {
    // Remove olLayer references before saving (they can't be serialized)
    const serializableSettings = {
      ...settings,
      rasterLayers: settings.rasterLayers.map(({ olLayer, ...rest }) => rest),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableSettings));
  } catch (e) {
    console.error('Failed to save settings to localStorage:', e);
  }
}


function reorderLayers(map: OLMap, orderedRasterLayers?: RasterLayer[], orderedVectorLayers?: VectorLayerConfig[]) {
  const collection = map.getLayers();
  const allLayers = collection.getArray().slice();

  const baseLayers: any[] = [];
  const gridLayers: any[] = [];
  const rasterOLayers: any[] = [];
  const vectorOLayers: any[] = [];

  allLayers.forEach((layer: any) => {
    const source = layer.getSource?.();
    if (source instanceof OSM) {
      baseLayers.push(layer);
    } else if (source instanceof TileDebug) {
      gridLayers.push(layer);
    } else if (source instanceof VectorSource) {
      vectorOLayers.push(layer);
    } else {
      // XYZ, WMTS, and WMS are all raster layers
      rasterOLayers.push(layer);
    }
  });

  // If ordered arrays are provided, respect their order
  if (orderedRasterLayers && orderedRasterLayers.length > 0) {
    const orderedRasterOLayers: any[] = [];
    orderedRasterLayers.forEach(config => {
      if (config.olLayer && rasterOLayers.includes(config.olLayer)) {
        orderedRasterOLayers.push(config.olLayer);
      }
    });
    // Add any raster layers not in the config (shouldn't happen, but safety)
    rasterOLayers.forEach(l => {
      if (!orderedRasterOLayers.includes(l)) {
        orderedRasterOLayers.push(l);
      }
    });
    rasterOLayers.length = 0;
    rasterOLayers.push(...orderedRasterOLayers);
  }

  if (orderedVectorLayers && orderedVectorLayers.length > 0) {
    const orderedVectorOLayers: any[] = [];
    orderedVectorLayers.forEach(config => {
      if (config.olLayer && vectorOLayers.includes(config.olLayer)) {
        orderedVectorOLayers.push(config.olLayer);
      }
    });
    vectorOLayers.length = 0;
    vectorOLayers.push(...orderedVectorOLayers);
  }

  collection.clear();
  // Order: base < raster < vector < grid
  [...baseLayers, ...rasterOLayers, ...vectorOLayers, ...gridLayers].forEach(layer => collection.push(layer));
}
function getInitialView() {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat') || '');
  const lng = parseFloat(params.get('lng') || '');
  const z = parseInt(params.get('z') || '', 10);

  const center = !isNaN(lat) && !isNaN(lng) ? fromLonLat([lng, lat]) : [14960009, -3001695];
  const zoom = !isNaN(z) ? z : 4;

  return { center, zoom };
}

function updateUrlParams(view: View) {
  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || zoom === undefined) return;

  const [lng, lat] = toLonLat(center);
  const params = new URLSearchParams();
  params.set('lat', lat.toFixed(5));
  params.set('lng', lng.toFixed(5));
  params.set('z', Math.round(zoom).toString());

  window.history.replaceState(null, '', '?' + params.toString());
}

function GearIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function SettingsDialog({ 
  onClose, 
  showGrid, 
  onGridToggle,
  rasterLayers,
  onAddRasterLayer,
  onEditRasterLayer,
  onRemoveRasterLayer,
  vectorLayers,
  onToggleVectorLayer,
  onRemoveVectorLayer,
  onReorderRasterLayers,
  onReorderVectorLayers
}: { 
  onClose: () => void; 
  showGrid: boolean;
  onGridToggle: (checked: boolean) => void;
  rasterLayers: RasterLayer[];
  onAddRasterLayer: (layer: RasterLayer) => void;
  onEditRasterLayer: (layer: RasterLayer) => void;
  onRemoveRasterLayer: (id: string) => void;
  vectorLayers: VectorLayerConfig[];
  onToggleVectorLayer: (id: string) => void;
  onRemoveVectorLayer: (id: string) => void;
  onReorderRasterLayers: (layers: RasterLayer[]) => void;
  onReorderVectorLayers: (layers: VectorLayerConfig[]) => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [draggedRasterId, setDraggedRasterId] = useState<string | null>(null);
  const [draggedVectorId, setDraggedVectorId] = useState<string | null>(null);
  const [newLayerName, setNewLayerName] = useState('');
  const [newLayerType, setNewLayerType] = useState<'xyz' | 'wmts' | 'wms'>('xyz');
  const [newLayerUrl, setNewLayerUrl] = useState('');
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
  const lastAutoNameRef = useRef('');

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
        if (!newLayerName.trim() || newLayerName.trim() === lastAutoNameRef.current) {
          setNewLayerName(layers[0].title.trim());
          lastAutoNameRef.current = layers[0].title.trim();
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
        if (!newLayerName.trim() || newLayerName.trim() === lastAutoNameRef.current) {
          setNewLayerName(layers[0].title);
          lastAutoNameRef.current = layers[0].title;
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

  const handleRasterDragStart = (id: string) => {
    setDraggedRasterId(id);
  };

  const handleRasterDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedRasterId || draggedRasterId === targetId) return;
    
    const draggedIndex = rasterLayers.findIndex(l => l.id === draggedRasterId);
    const targetIndex = rasterLayers.findIndex(l => l.id === targetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    const newLayers = [...rasterLayers];
    const [draggedLayer] = newLayers.splice(draggedIndex, 1);
    newLayers.splice(targetIndex, 0, draggedLayer);
    
    onReorderRasterLayers(newLayers);
  };

  const handleRasterDragEnd = () => {
    setDraggedRasterId(null);
  };

  const handleVectorDragStart = (id: string) => {
    setDraggedVectorId(id);
  };

  const handleVectorDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedVectorId || draggedVectorId === targetId) return;
    
    const draggedIndex = vectorLayers.findIndex(l => l.id === draggedVectorId);
    const targetIndex = vectorLayers.findIndex(l => l.id === targetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    const newLayers = [...vectorLayers];
    const [draggedLayer] = newLayers.splice(draggedIndex, 1);
    newLayers.splice(targetIndex, 0, draggedLayer);
    
    onReorderVectorLayers(newLayers);
  };

  const handleVectorDragEnd = () => {
    setDraggedVectorId(null);
  };

  const handleAddLayer = (existingRasterLayers: RasterLayer[]) => {
    let layerName = newLayerName.trim();
    
    let layer: RasterLayer;
    
    if (newLayerType === 'wmts') {
      if (!wmtsCapabilitiesUrl.trim() || !selectedWmtsLayer) return;
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
      if (!wmsCapabilitiesUrl.trim() || !selectedWmsLayer) return;
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
    } else {
      if (!newLayerUrl.trim()) return;
      if (!layerName) {
        const xyzCount = existingRasterLayers.filter(l => l.name.startsWith('xyz_')).length;
        layerName = 'xyz_' + (xyzCount + 1);
      }
      layer = {
        id: Date.now().toString(),
        name: layerName,
        type: 'xyz',
        url: newLayerUrl.trim(),
      };
    }
    
    onAddRasterLayer(layer);
    setNewLayerName('');
    setNewLayerUrl('');
    setWmtsCapabilitiesUrl('');
    setWmtsLayers([]);
    setSelectedWmtsLayer('');
    setWmtsFetched(false);
    setWmsCapabilitiesUrl('');
    setWmsLayers([]);
    setSelectedWmsLayer('');
    setWmsFetched(false);
    lastAutoNameRef.current = '';
    setShowAddForm(false);
  };

  return (
    <div className="settings-dialog">
      <div className="settings-dialog-header">
        <span className="settings-dialog-title">Settings</span>
        <button className="settings-dialog-close" onClick={onClose}>&times;</button>
      </div>
      <div className="settings-dialog-body">
        <div className="settings-section">
          <div className="settings-section-title">Base Map</div>
          <div className="settings-checkbox-row">
            <input
              type="checkbox"
              id="grid-toggle"
              checked={showGrid}
              onChange={(e) => onGridToggle(e.target.checked)}
            />
            <label htmlFor="grid-toggle">Show Grid</label>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">Raster Layers</div>
          {rasterLayers.map((layer) => (
            editingId === layer.id ? (
              <div key={layer.id} className="settings-add-form">
                <input
                  type="text"
                  placeholder="Layer name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="settings-input"
                />
                <input
                  type="text"
                  placeholder={layer.type === 'wmts' || layer.type === 'wms' ? 'GetCapabilities URL' : 'XYZ URL'}
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="settings-input"
                />
                {layer.type === 'wmts' && (
                  <div className="settings-wmts-info">
                    Layer: {layer.wmtsLayer}
                  </div>
                )}
                {layer.type === 'wms' && (
                  <div className="settings-wmts-info">
                    Layer: {layer.wmsLayer}
                  </div>
                )}
                <div className="settings-form-buttons">
                  <button className="settings-button-primary" onClick={() => {
                    if (editName.trim() && editUrl.trim()) {
                      let updated: RasterLayer;
                      if (layer.type === 'wmts') {
                        updated = { ...layer, name: editName.trim(), wmtsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim() };
                      } else if (layer.type === 'wms') {
                        updated = { ...layer, name: editName.trim(), wmsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim() };
                      } else {
                        updated = { ...layer, name: editName.trim(), url: editUrl.trim() };
                      }
                      onEditRasterLayer(updated);
                      setEditingId(null);
                    }
                  }}>Apply</button>
                  <button className="settings-button-secondary" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div 
                key={layer.id} 
                className="settings-layer-item"
                draggable
                onDragStart={() => handleRasterDragStart(layer.id)}
                onDragOver={(e) => handleRasterDragOver(e, layer.id)}
                onDragEnd={handleRasterDragEnd}
                style={{ cursor: 'grab', opacity: draggedRasterId === layer.id ? 0.5 : 1 }}
              >
                <span className="settings-drag-handle">⋮⋮</span>
                <span className="settings-layer-name">{layer.name}</span>
                <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                <button
                  className="settings-layer-edit"
                  onClick={() => {
                    setEditingId(layer.id);
                    setEditName(layer.name);
                    setEditUrl(
                      layer.type === 'wmts' ? (layer.wmtsCapabilitiesUrl || layer.url) :
                      layer.type === 'wms' ? (layer.wmsCapabilitiesUrl || layer.url) :
                      layer.url
                    );
                  }}
                  title="Edit layer"
                >
                  <PencilIcon />
                </button>
                <button 
                  className="settings-layer-remove"
                  onClick={() => onRemoveRasterLayer(layer.id)}
                  title="Remove layer"
                >
                  &times;
                </button>
              </div>
            )
          ))}
          {!showAddForm ? (
            <button 
              className="settings-add-button"
              onClick={() => setShowAddForm(true)}
            >
              + Add Raster Layer
            </button>
          ) : (
            <div className="settings-add-form">
              <input
                type="text"
                placeholder="Layer name"
                value={newLayerName}
                onChange={(e) => setNewLayerName(e.target.value)}
                className="settings-input"
              />
              <select
                value={newLayerType}
                onChange={(e) => {
                  setNewLayerType(e.target.value as 'xyz' | 'wmts' | 'wms');
                  setWmtsLayers([]);
                  setWmtsFetched(false);
                  setSelectedWmtsLayer('');
                  setWmsLayers([]);
                  setWmsFetched(false);
                  setSelectedWmsLayer('');
                  lastAutoNameRef.current = '';
                }}
                className="settings-select"
              >
                <option value="xyz">XYZ</option>
                <option value="wmts">WMTS</option>
                <option value="wms">WMS</option>
              </select>
              {newLayerType === 'xyz' ? (
                <input
                  type="text"
                  placeholder="XYZ URL (e.g., https://tile.example.com/{'{z}/{x}/{y}'}.png)"
                  value={newLayerUrl}
                  onChange={(e) => setNewLayerUrl(e.target.value)}
                  className="settings-input"
                />
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
                  <select
                    value={selectedWmtsLayer}
                    onClick={() => {
                      if (wmtsCapabilitiesUrl.trim() && !wmtsFetched && !wmtsLoading) {
                        fetchWmtsCapabilities();
                      }
                    }}
                    onFocus={() => {
                      if (wmtsCapabilitiesUrl.trim() && !wmtsFetched && !wmtsLoading) {
                        fetchWmtsCapabilities();
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedWmtsLayer(val);
                      const matched = wmtsLayers.find(l => l.identifier === val);
                      if (matched && (!newLayerName.trim() || newLayerName.trim() === lastAutoNameRef.current)) {
                        setNewLayerName(matched.title);
                        lastAutoNameRef.current = matched.title;
                      }
                    }}
                    className="settings-select"
                    disabled={!wmtsCapabilitiesUrl.trim()}
                  >
                    {wmtsLoading ? (
                      <option value="" disabled>Loading...</option>
                    ) : (
                      <>
                        <option value="" disabled>Select a layer</option>
                        {wmtsLayers.map((layer) => (
                          <option key={layer.identifier} value={layer.identifier}>
                            {layer.title}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
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
                  <select
                    value={selectedWmsLayer}
                    onClick={() => {
                      if (wmsCapabilitiesUrl.trim() && !wmsFetched && !wmsLoading) {
                        fetchWmsCapabilities();
                      }
                    }}
                    onFocus={() => {
                      if (wmsCapabilitiesUrl.trim() && !wmsFetched && !wmsLoading) {
                        fetchWmsCapabilities();
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedWmsLayer(val);
                      const matched = wmsLayers.find(l => l.name === val);
                      if (matched && (!newLayerName.trim() || newLayerName.trim() === lastAutoNameRef.current)) {
                        setNewLayerName(matched.title.trim());
                        lastAutoNameRef.current = matched.title.trim();
                      }
                    }}
                    className="settings-select"
                    disabled={!wmsCapabilitiesUrl.trim()}
                  >
                    {wmsLoading ? (
                      <option value="" disabled>Loading...</option>
                    ) : (
                      <>
                        <option value="" disabled>Select a layer</option>
                        {wmsLayers.map((layer) => (
                          <option key={layer.name} value={layer.name}>
                            {layer.title}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                </>
              )}
              <div className="settings-form-buttons">
                <button className="settings-button-primary" onClick={() => handleAddLayer(rasterLayers)}>
                  Add
                </button>
                <button className="settings-button-secondary" onClick={() => setShowAddForm(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="settings-section">
          <div className="settings-section-title">Vector Layers</div>
          {vectorLayers.length === 0 ? (
            <p className="settings-placeholder">No vector layers added yet. Drag and drop GeoJSON, KML, or KMZ files onto the map.</p>
          ) : (
            <div className="settings-layers-list">
              {vectorLayers.map((layer) => (
                <div 
                  key={layer.id} 
                  className="settings-layer-item"
                  draggable
                  onDragStart={() => handleVectorDragStart(layer.id)}
                  onDragOver={(e) => handleVectorDragOver(e, layer.id)}
                  onDragEnd={handleVectorDragEnd}
                  style={{ cursor: 'grab', opacity: draggedVectorId === layer.id ? 0.5 : 1 }}
                >
                  <span className="settings-drag-handle">⋮⋮</span>
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={() => onToggleVectorLayer(layer.id)}
                    className="settings-layer-checkbox"
                  />
                  <span className="settings-layer-name">{layer.name}</span>
                  <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                  <button 
                    className="settings-layer-remove"
                    onClick={() => onRemoveVectorLayer(layer.id)}
                    title="Remove layer"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MapPage() {
  const zoomRef = useRef<HTMLDivElement>(null);
  const attributionRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const gridLayerRef = useRef<TileLayer<any> | null>(null);
  const rasterLayersRef = useRef<Map<string, any>>(new Map());
  const vectorLayersRef = useRef<Map<string, any>>(new Map());
  const storedSettings = useRef(loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showGrid, setShowGrid] = useState(storedSettings.current.showGrid);
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>(storedSettings.current.rasterLayers);
  const [vectorLayers, setVectorLayers] = useState<VectorLayerConfig[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!zoomRef.current || !attributionRef.current) {
      return;
    }

    const zoomControl = new Zoom({ target: zoomRef.current });
    const attributionControl = new Attribution({
      target: attributionRef.current,
      collapsible: false,
    });

    const { center, zoom } = getInitialView();

    const mapview = new View({
      center: center,
      zoom: zoom,
      minZoom: 2,
      maxZoom: 25,
    });

    const map = new OLMap({
      target: 'map',
      controls: defaultControls({ zoom: false, attribution: false }).extend([
        zoomControl,
        attributionControl,
      ]),
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
      ],
      view: mapview,
    });

    mapRef.current = map;
    map.on('moveend', () => updateUrlParams(mapview));

    // Restore raster layers from localStorage
    storedSettings.current.rasterLayers
      
      .forEach(async (layerConfig) => {
      try {
        let olLayer: any;

        if (layerConfig.type === 'wmts') {
          const response = await fetch(layerConfig.wmtsCapabilitiesUrl || layerConfig.url);
          const text = await response.text();
          const parser = new WMTSCapabilities();
          const capabilities = parser.read(text);
          
          const wmtsOptions = optionsFromCapabilities(capabilities, {
            layer: layerConfig.wmtsLayer || '',
          });
          
          if (!wmtsOptions) {
            throw new Error('Failed to create WMTS options from capabilities');
          }
          
          olLayer = new TileLayer({
            source: new WMTS(wmtsOptions),
          });
        } else if (layerConfig.type === 'wms') {
          olLayer = new ImageLayer({
            source: new ImageWMS({
              url: extractBaseUrl(layerConfig.wmsCapabilitiesUrl || layerConfig.url),
              params: { LAYERS: layerConfig.wmsLayer || '' },
              ratio: 1,
              serverType: 'geoserver',
            }),
          });
        } else {
          olLayer = new TileLayer({
            source: new XYZ({ url: layerConfig.url }),
          });
        }

        map.addLayer(olLayer);
        rasterLayersRef.current.set(layerConfig.id, olLayer);
        
        // Reorder after each layer to maintain correct stacking
        reorderLayers(map);
      } catch (error) {
        console.error('Failed to restore raster layer:', error);
      }
    });

    return () => {
      if (zoomRef.current) {
        zoomRef.current.innerHTML = '';
      }
      if (attributionRef.current) {
        attributionRef.current.innerHTML = '';
      }
      map.setTarget(undefined);
    };
  }, []);

  useEffect(() => {
    saveSettings({ showGrid, rasterLayers });
  }, [showGrid, rasterLayers]);

  useEffect(() => {
    if (!mapRef.current) return;

    if (showGrid) {
      const gridLayer = new TileLayer({
        source: new TileDebug(),
      });
      mapRef.current.addLayer(gridLayer);
      gridLayerRef.current = gridLayer;
      reorderLayers(mapRef.current, rasterLayers, vectorLayers);
    } else {
      if (gridLayerRef.current) {
        mapRef.current.removeLayer(gridLayerRef.current);
        gridLayerRef.current = null;
      }
    }
  }, [showGrid]);



  const handleEditRasterLayer = async (updated: RasterLayer) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      mapRef.current.removeLayer(olLayer);
      let newOlLayer: any;

      if (updated.type === 'wmts') {
        const response = await fetch(updated.wmtsCapabilitiesUrl || updated.url);
        const text = await response.text();
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        
        const wmtsOptions = optionsFromCapabilities(capabilities, {
          layer: updated.wmtsLayer || '',
        });
        
        if (!wmtsOptions) {
          throw new Error('Failed to create WMTS options from capabilities');
        }
        
        newOlLayer = new TileLayer({
          source: new WMTS(wmtsOptions),
        });
      } else if (updated.type === 'wms') {
        newOlLayer = new ImageLayer({
          source: new ImageWMS({
            url: extractBaseUrl(updated.wmsCapabilitiesUrl || updated.url),
            params: { LAYERS: updated.wmsLayer || '' },
            ratio: 1,
            serverType: 'geoserver',
          }),
        });
      } else {
        newOlLayer = new TileLayer({
          source: new XYZ({ url: updated.url }),
        });
      }

      mapRef.current.addLayer(newOlLayer);
      rasterLayersRef.current.set(updated.id, newOlLayer);
      setRasterLayers(prev => prev.map(l => l.id === updated.id ? updated : l));
      reorderLayers(mapRef.current);
    } catch (error) {
      console.error('Failed to edit raster layer:', error);
    }
  };

  const getDefaultVectorStyle = () => {
    return new Style({
      fill: new Fill({
        color: 'rgba(66, 133, 244, 0.3)',
      }),
      stroke: new Stroke({
        color: '#4285f4',
        width: 2,
      }),
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({
          color: '#4285f4',
        }),
        stroke: new Stroke({
          color: '#fff',
          width: 2,
        }),
      }),
    });
  };

  const handleAddVectorLayer = async (file: File) => {
    if (!mapRef.current) return;

    const fileName = file.name;
    const extension = fileName.split('.').pop()?.toLowerCase();
    
    if (!extension) {
      alert('Invalid file format');
      return;
    }

    let layerType: VectorLayerConfig['type'];
    let features: any[] = [];

    try {
      if (extension === 'geojson' || extension === 'json') {
        layerType = 'geojson';
        const text = await file.text();
        const format = new GeoJSON();
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'kml') {
        layerType = 'kml';
        const text = await file.text();
        const format = new KML({
          extractStyles: true,
        });
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'kmz') {
        layerType = 'kmz';
        const zip = await JSZip.loadAsync(file);
        const kmlFile = Object.keys(zip.files).find(f => f.endsWith('.kml'));
        if (!kmlFile) {
          alert('No KML file found in KMZ archive');
          return;
        }
        const text = await zip.files[kmlFile].async('text');
        const format = new KML({
          extractStyles: true,
        });
        features = format.readFeatures(text, {
          featureProjection: 'EPSG:3857',
        });
      } else if (extension === 'zip') {
        layerType = 'shapefile';
        alert('Shapefile support coming soon. Please use GeoJSON or KML format.');
        return;
      } else {
        alert(`Unsupported file format: .${extension}`);
        return;
      }

      if (features.length === 0) {
        alert('No features found in the file');
        return;
      }

      const source = new VectorSource({
        features: features,
      });

      const olLayer = new VectorLayer({
        source: source,
        style: getDefaultVectorStyle(),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: fileName.replace(/\.(geojson|json|kml|kmz|zip)$/i, ''),
        type: layerType!,
        visible: true,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer };
      setVectorLayers(prev => [...prev, layerConfigWithRef]);

      // Fit map to features extent
      const extent = source.getExtent();
      if (extent && extent.every(v => isFinite(v))) {
        mapRef.current.getView().fit(extent, {
          padding: [50, 50, 50, 50],
          maxZoom: 18,
        });
      }
    } catch (error) {
      console.error('Failed to load vector layer:', error);
      alert(`Failed to load "${fileName}". The file may be corrupted or in an unsupported format.`);
    }
  };

  const handleToggleVectorLayer = (id: string) => {
    const olLayer = vectorLayersRef.current.get(id);
    if (!olLayer) return;

    setVectorLayers(prev =>
      prev.map(l => {
        if (l.id === id) {
          const newVisible = !l.visible;
          olLayer.setVisible(newVisible);
          return { ...l, visible: newVisible };
        }
        return l;
      })
    );
  };

  const handleRemoveVectorLayer = (id: string) => {
    if (!mapRef.current) return;

    const olLayer = vectorLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      vectorLayersRef.current.delete(id);
    }

    setVectorLayers(prev => prev.filter(l => l.id !== id));
  };

  const handleReorderRasterLayers = (newLayers: RasterLayer[]) => {
    setRasterLayers(newLayers);
    if (mapRef.current) {
      reorderLayers(mapRef.current, newLayers, vectorLayers);
    }
  };

  const handleReorderVectorLayers = (newLayers: VectorLayerConfig[]) => {
    setVectorLayers(newLayers);
    if (mapRef.current) {
      reorderLayers(mapRef.current, rasterLayers, newLayers);
    }
  };

  const handleRemoveRasterLayer = (id: string) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      rasterLayersRef.current.delete(id);
    }
    setRasterLayers(prev => prev.filter(l => l.id !== id));
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    
    for (const file of files) {
      await handleAddVectorLayer(file);
    }
  };

  const handleAddRasterLayer = async (layerConfig: RasterLayer) => {
    if (!mapRef.current) return;

    try {
      let olLayer: any;

      if (layerConfig.type === 'wmts') {
        const response = await fetch(layerConfig.wmtsCapabilitiesUrl || layerConfig.url);
        const text = await response.text();
        const parser = new WMTSCapabilities();
        const capabilities = parser.read(text);
        
        const wmtsOptions = optionsFromCapabilities(capabilities, {
          layer: layerConfig.wmtsLayer || '',
        });
        
        if (!wmtsOptions) {
          throw new Error('Failed to create WMTS options from capabilities');
        }
        
        olLayer = new TileLayer({
          source: new WMTS(wmtsOptions),
        });
      } else if (layerConfig.type === 'wms') {
        olLayer = new ImageLayer({
          source: new ImageWMS({
            url: extractBaseUrl(layerConfig.wmsCapabilitiesUrl || layerConfig.url),
            params: { LAYERS: layerConfig.wmsLayer || '' },
            ratio: 1,
            serverType: 'geoserver',
          }),
        });
      } else {
        olLayer = new TileLayer({
          source: new XYZ({
            url: layerConfig.url,
          }),
        });
      }

      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer };
      setRasterLayers(prev => [...prev, layerConfigWithRef]);
      reorderLayers(mapRef.current);
    } catch (error) {
      console.error('Failed to add raster layer:', error);
    }
  };

  return (
    <div 
      id="map" 
      className="map-container"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(66, 133, 244, 0.3)',
          border: '3px dashed #4285f4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          pointerEvents: 'none',
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '20px 40px',
            borderRadius: '8px',
            fontSize: '18px',
            fontWeight: 'bold',
            color: '#4285f4',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}>
            Drop vector files here
          </div>
        </div>
      )}
      <div ref={zoomRef} className="map-controls" />
      <div ref={attributionRef} className="map-attribution" />
      <div className="map-settings-wrapper">
        {showSettings && (
          <SettingsDialog 
            onClose={() => setShowSettings(false)} 
            showGrid={showGrid}
            onGridToggle={setShowGrid}
            rasterLayers={rasterLayers}
            onAddRasterLayer={handleAddRasterLayer}
            onEditRasterLayer={handleEditRasterLayer}
            onRemoveRasterLayer={handleRemoveRasterLayer}
            vectorLayers={vectorLayers}
            onToggleVectorLayer={handleToggleVectorLayer}
            onRemoveVectorLayer={handleRemoveVectorLayer}
            onReorderRasterLayers={handleReorderRasterLayers}
            onReorderVectorLayers={handleReorderVectorLayers}
          />
        )}
        <button
          className="map-settings-button"
          onClick={() => setShowSettings((prev) => !prev)}
          title="Settings"
        >
          <GearIcon />
        </button>
      </div>
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/map" element={<MapPage />} />
      <Route path="/" element={<Navigate to="/map" replace />} />
    </Routes>
  );
}

export default App;
