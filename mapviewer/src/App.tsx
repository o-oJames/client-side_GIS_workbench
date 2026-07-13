import React, { useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import OLMap from 'ol/Map.js';
import OSM from 'ol/source/OSM.js';
import TileLayer from 'ol/layer/Tile.js';
import TileDebug from 'ol/source/TileDebug.js';
import XYZ from 'ol/source/XYZ.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import Attribution from 'ol/control/Attribution.js';
import { defaults as defaultControls } from 'ol/control.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';

import './App.css';

interface RasterLayer {
  id: string;
  name: string;
  type: 'xyz';
  url: string;
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings to localStorage:', e);
  }
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
  onRemoveRasterLayer
}: { 
  onClose: () => void; 
  showGrid: boolean;
  onGridToggle: (checked: boolean) => void;
  rasterLayers: RasterLayer[];
  onAddRasterLayer: (layer: RasterLayer) => void;
  onEditRasterLayer: (layer: RasterLayer) => void;
  onRemoveRasterLayer: (id: string) => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [newLayerName, setNewLayerName] = useState('');
  const [newLayerType, setNewLayerType] = useState<'xyz'>('xyz');
  const [newLayerUrl, setNewLayerUrl] = useState('');

  const handleAddLayer = () => {
    if (!newLayerName.trim() || !newLayerUrl.trim()) return;
    
    const layer: RasterLayer = {
      id: Date.now().toString(),
      name: newLayerName.trim(),
      type: newLayerType,
      url: newLayerUrl.trim(),
    };
    
    onAddRasterLayer(layer);
    setNewLayerName('');
    setNewLayerUrl('');
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
          <div className="settings-section-title">Layers</div>
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
                  placeholder="XYZ URL"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="settings-input"
                />
                <div className="settings-form-buttons">
                  <button className="settings-button-primary" onClick={() => {
                    if (editName.trim() && editUrl.trim()) {
                      onEditRasterLayer({ ...layer, name: editName.trim(), url: editUrl.trim() });
                      setEditingId(null);
                    }
                  }}>Save</button>
                  <button className="settings-button-secondary" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div key={layer.id} className="settings-layer-item">
                <span className="settings-layer-name">{layer.name}</span>
                <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                <button
                  className="settings-layer-edit"
                  onClick={() => {
                    setEditingId(layer.id);
                    setEditName(layer.name);
                    setEditUrl(layer.url);
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
              <input
                type="text"
                placeholder="XYZ URL (e.g., https://tile.example.com/{z}/{x}/{y}.png)"
                value={newLayerUrl}
                onChange={(e) => setNewLayerUrl(e.target.value)}
                className="settings-input"
              />
              <div className="settings-form-buttons">
                <button className="settings-button-primary" onClick={handleAddLayer}>
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
          <div className="settings-section-title">Overlays</div>
          <p className="settings-placeholder">Overlay options will appear here.</p>
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
  const storedSettings = useRef(loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showGrid, setShowGrid] = useState(storedSettings.current.showGrid);
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>(storedSettings.current.rasterLayers);

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
    storedSettings.current.rasterLayers.forEach((layerConfig) => {
      try {
        const olLayer = new TileLayer({
          source: new XYZ({ url: layerConfig.url }),
        });
        map.addLayer(olLayer);
        rasterLayersRef.current.set(layerConfig.id, olLayer);
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
    } else {
      if (gridLayerRef.current) {
        mapRef.current.removeLayer(gridLayerRef.current);
        gridLayerRef.current = null;
      }
    }
  }, [showGrid]);

  const handleAddRasterLayer = (layerConfig: RasterLayer) => {
    if (!mapRef.current) return;

    try {
      const olLayer = new TileLayer({
        source: new XYZ({
          url: layerConfig.url,
        }),
      });

      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      setRasterLayers([...rasterLayers, layerConfig]);
    } catch (error) {
      console.error('Failed to add raster layer:', error);
    }
  };

  const handleEditRasterLayer = (updated: RasterLayer) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      mapRef.current.removeLayer(olLayer);
      const newOlLayer = new TileLayer({
        source: new XYZ({ url: updated.url }),
      });
      mapRef.current.addLayer(newOlLayer);
      rasterLayersRef.current.set(updated.id, newOlLayer);
      setRasterLayers(rasterLayers.map(l => l.id === updated.id ? updated : l));
    } catch (error) {
      console.error('Failed to edit raster layer:', error);
    }
  };

  const handleRemoveRasterLayer = (id: string) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(id);
    if (olLayer) {
      mapRef.current.removeLayer(olLayer);
      rasterLayersRef.current.delete(id);
      setRasterLayers(rasterLayers.filter(l => l.id !== id));
    }
  };

  return (
    <div id="map" className="map-container">
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
