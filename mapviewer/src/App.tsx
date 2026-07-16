import './App.css';
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
import ScaleLine from 'ol/control/ScaleLine.js';
import Attribution from 'ol/control/Attribution.js';
import Overlay from 'ol/Overlay.js';
import { defaults as defaultControls } from 'ol/control.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from 'ol/style.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import JSZip from 'jszip';
import proj4 from 'proj4';
import { register as registerProj4 } from 'ol/proj/proj4.js';
import Projection from 'ol/proj/Projection.js';
import { parseShapefile, ShapefileResult } from './utils/shapefileParser';
import { registerProjectionFromWKT, registerProjectionFromEPSGCode } from './utils/projectionHelper';
import { fromLonLat, toLonLat } from 'ol/proj.js';

// Register proj4 with OpenLayers
registerProj4(proj4);


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

/**
 * Extract extent [minx, miny, maxx, maxy] in EPSG:3857 from WMTS capabilities for a specific layer.
 */
function extractWmtsExtent(capabilities: any, layerIdentifier: string): number[] | null {
  const layers = capabilities?.Contents?.Layer;
  if (!Array.isArray(layers)) return null;

  const layer = layers.find((l: any) => l.Identifier === layerIdentifier);
  if (!layer) return null;

  // Try WGS84BoundingBox - OL parser returns this as a flat extent array [minLon, minLat, maxLon, maxLat]
  if (layer.WGS84BoundingBox) {
    const extent = layer.WGS84BoundingBox;
    // OL parser returns extent directly as [minLon, minLat, maxLon, maxLat]
    if (Array.isArray(extent) && extent.length === 4 && extent.every((v: any) => typeof v === 'number' && isFinite(v))) {
      const [x1, y1] = fromLonLat([extent[0], extent[1]]);
      const [x2, y2] = fromLonLat([extent[2], extent[3]]);
      return [x1, y1, x2, y2];
    }
  }

  // Try BoundingBox array
  if (Array.isArray(layer.BoundingBox) && layer.BoundingBox.length > 0) {
    const bbox = layer.BoundingBox[0];
    if (bbox.extent && bbox.extent.length === 4 && bbox.extent.every(isFinite)) {
      const ext = bbox.extent;
      // If CRS is EPSG:4326, transform; if already 3857 use as-is
      const crs = (bbox.crs || bbox.CRS || '').toString().toLowerCase();
      if (crs.includes('4326')) {
        const [x1, y1] = fromLonLat([ext[0], ext[1]]);
        const [x2, y2] = fromLonLat([ext[2], ext[3]]);
        return [x1, y1, x2, y2];
      }
      return ext.slice();
    }
  }

  return null;
}

/**
 * Extract extent [minx, miny, maxx, maxy] in EPSG:3857 from WMS capabilities for a specific layer.
 */
function extractWmsExtent(capabilities: any, layerName: string): number[] | null {
  const findLayerBBox = (layerArray: any[] | undefined, name: string): any => {
    if (!layerArray) return null;
    for (const layer of layerArray) {
      if (layer.Name === name) {
        if (layer.EX_GeographicBoundingBox) return { type: 'exgeo', data: layer.EX_GeographicBoundingBox };
        if (layer.BoundingBox && layer.BoundingBox.length > 0) return { type: 'bbox', data: layer.BoundingBox[0] };
        if (layer.LatLonBoundingBox) return { type: 'llbbox', data: layer.LatLonBoundingBox };
        return null;
      }
      const found = findLayerBBox(layer.Layer, name);
      if (found) return found;
    }
    return null;
  };

  const result = findLayerBBox(capabilities?.Capability?.Layer?.Layer || [], layerName);
  if (!result) return null;

  let extent: number[] | null = null;
  if (result.type === 'exgeo') {
    const bb = result.data;
    if (bb.westBoundLongitude !== undefined) {
      extent = [bb.westBoundLongitude, bb.southBoundLatitude, bb.eastBoundLongitude, bb.northBoundLatitude];
    }
  } else if (result.type === 'bbox') {
    const bb = result.data;
    if (bb.extent && bb.extent.length === 4) {
      const crs = (bb.crs || bb.CRS || '').toString().toLowerCase();
      if (crs.includes('4326')) {
        extent = bb.extent.slice();
      } else if (crs.includes('3857') || crs.includes('900913')) {
        return bb.extent.slice();
      } else {
        // assume geographic
        extent = bb.extent.slice();
      }
    }
  } else if (result.type === 'llbbox') {
    const bb = result.data;
    if (Array.isArray(bb) && bb.length === 4) {
      extent = bb.slice();
    }
  }

  if (extent && extent.length === 4 && extent.every(isFinite)) {
    const [x1, y1] = fromLonLat([extent[0], extent[1]]);
    const [x2, y2] = fromLonLat([extent[2], extent[3]]);
    return [x1, y1, x2, y2];
  }

  return null;
}


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
  visible?: boolean;
  extent?: number[]; // [minx, miny, maxx, maxy] in EPSG:3857
}

interface VectorLayerConfig {
  id: string;
  name: string;
  type: 'geojson' | 'kml' | 'kmz' | 'shapefile' | 'mvt';
  visible: boolean;
  olLayer?: any;
  url?: string;
  isDrawnInApp?: boolean;
}

const STORAGE_KEY = 'mapviewer-settings';
const VIEW_STORAGE_KEY = 'mapviewer-view';

interface StoredSettings {
  showGrid: boolean;
  showDrawToolbar: boolean;
  showCoordinates: boolean;
  rasterLayers: RasterLayer[];
  vectorLayers: VectorLayerConfig[];
}

function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Filter out raster layers with blob fields (file-based sources can't persist)
      const validRasterLayers = Array.isArray(parsed.rasterLayers) 
        ? parsed.rasterLayers.filter((layer: any) => !layer.blob)
        : [];
      
      // Filter vector layers to only include MVT (file-based can't persist)
      const validVectorLayers = Array.isArray(parsed.vectorLayers)
        ? parsed.vectorLayers.filter((layer: any) => layer.type === 'mvt')
        : [];
      
      return {
        showGrid: !!parsed.showGrid,
        showDrawToolbar: parsed.showDrawToolbar !== false,
        showCoordinates: parsed.showCoordinates !== false,
        rasterLayers: validRasterLayers,
        vectorLayers: validVectorLayers,
      };
    }
  } catch (e) {
    console.error('Failed to load settings from localStorage:', e);
  }
  return { showGrid: false, showDrawToolbar: true, showCoordinates: true, rasterLayers: [], vectorLayers: [] };
}

function saveSettings(settings: StoredSettings) {
  try {
    // Remove olLayer and blob references before saving (they can't be serialized)
    const serializableSettings = {
      ...settings,
      rasterLayers: settings.rasterLayers
        .filter(layer => !(layer as any).blob) // Don't save file-based layers
        .map(({ olLayer, ...rest }) => rest),
      vectorLayers: settings.vectorLayers
        .filter(layer => layer.type === 'mvt') // Only save MVT layers
        .map(({ olLayer, ...rest }) => rest),
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
  const drawLayers: any[] = [];

  allLayers.forEach((layer: any) => {
    // Separate draw layers - they always stay on top
    if (layer.get('_isDrawLayer')) {
      drawLayers.push(layer);
      return;
    }
    const source = layer.getSource?.();
    if (source instanceof OSM) {
      baseLayers.push(layer);
    } else if (source instanceof TileDebug) {
      gridLayers.push(layer);
    } else if (source instanceof VectorSource || source instanceof VectorTileSource) {
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
  // Order: base (bottom) < raster < vector < grid < draw layers (top)
  // Within each category, reverse so first in UI list = top of map (last added to OL)
  [...baseLayers, ...rasterOLayers.slice().reverse(), ...vectorOLayers.slice().reverse(), ...gridLayers, ...drawLayers].forEach(layer => collection.push(layer));
}
function getInitialView() {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat') || '');
  const lng = parseFloat(params.get('lng') || '');
  const z = parseInt(params.get('z') || '', 10);

  if (!isNaN(lat) && !isNaN(lng) && !isNaN(z)) {
    return { center: fromLonLat([lng, lat]), zoom: z };
  }

  // Fall back to localStorage
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const sLat = parseFloat(parsed.lat);
      const sLng = parseFloat(parsed.lng);
      const sZ = parseInt(parsed.z, 10);
      if (!isNaN(sLat) && !isNaN(sLng) && !isNaN(sZ)) {
        return { center: fromLonLat([sLng, sLat]), zoom: sZ };
      }
    }
  } catch (e) {
    console.error('Failed to load view from localStorage:', e);
  }

  return { center: [14960009, -3001695], zoom: 4 };
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

  // Save to localStorage so refresh restores the last view
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      lat: lat.toFixed(5),
      lng: lng.toFixed(5),
      z: Math.round(zoom).toString(),
    }));
  } catch (e) {
    console.error('Failed to save view to localStorage:', e);
  }
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
function EyeIcon({ visible }: { visible: boolean }) {
  if (visible) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    );
  } else {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
    );
  }
}

function ZoomToExtentIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6"/>
      <path d="M9 21H3v-6"/>
      <path d="M21 3l-7 7"/>
      <path d="M3 21l7-7"/>
    </svg>
  );
}



interface CustomSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function CustomSelect({ 
  value, 
  onChange, 
  options, 
  className, 
  disabled, 
  placeholder,
  onOpen,
  filterable,
}: { 
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  onOpen?: () => void;
  filterable?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setFilterText('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus the filter input when the menu opens
  useEffect(() => {
    if (isOpen && filterable && filterInputRef.current) {
      filterInputRef.current.focus();
    }
  }, [isOpen, filterable]);

  const selectedOption = options.find(o => o.value === value);
  const displayLabel = selectedOption?.label || placeholder || '';

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && onOpen) {
      onOpen();
    }
    if (isOpen) {
      setFilterText('');
    }
    setIsOpen(!isOpen);
  };

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setFilterText('');
    setIsOpen(false);
  };

  const lowerFilter = filterText.toLowerCase();
  const filteredOptions = filterable && filterText
    ? options.filter(o => o.disabled || o.label.toLowerCase().includes(lowerFilter) || (o.value && o.value.toLowerCase().includes(lowerFilter)))
    : options;

  return (
    <div ref={wrapperRef} className={`custom-select-wrapper ${className || ''}`}>
      <button
        type="button"
        className={`custom-select-trigger${disabled ? ' custom-select-disabled' : ''}`}
        onClick={handleToggle}
        disabled={disabled}
      >
        <span className="custom-select-value">{displayLabel}</span>
        <span className={`custom-select-chevron${isOpen ? ' custom-select-chevron-open' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {isOpen && (
        <div className="custom-select-menu">
          {filterable && (
            <div className="custom-select-filter">
              <input
                ref={filterInputRef}
                type="text"
                className="custom-select-filter-input"
                placeholder="Filter layers…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
          {filteredOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-select-option${option.value === value ? ' custom-select-option-selected' : ''}${option.disabled ? ' custom-select-option-disabled' : ''}`}
              onClick={() => !option.disabled && handleSelect(option.value)}
              disabled={option.disabled}
            >
              {option.label}
            </button>
          ))}
          {filterable && filteredOptions.length === 0 && (
            <div className="custom-select-no-results">No matching layers</div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsDialog({ 
  onClose, 
  showGrid, 
  onGridToggle,
  showDrawToolbar,
  onDrawToolbarToggle,
  showCoordinates,
  onCoordinatesToggle,
  rasterLayers,
  onAddRasterLayer,
  onEditRasterLayer,
  onRemoveRasterLayer,
  onToggleRasterLayer,
  vectorLayers,
  onToggleVectorLayer,
  onRemoveVectorLayer,
  onEditVectorLayer,
  onReorderRasterLayers,
  onReorderVectorLayers,
  onAddVectorLayer,
  onAddMVTLayer,
  onExportVectorLayer,
  onGoToVectorLayerExtent,
  onGoToRasterLayerExtent,
}: { 
  onClose: () => void; 
  showGrid: boolean;
  onGridToggle: (checked: boolean) => void;
  showDrawToolbar: boolean;
  onDrawToolbarToggle: (checked: boolean) => void;
  showCoordinates: boolean;
  onCoordinatesToggle: (checked: boolean) => void;
  rasterLayers: RasterLayer[];
  onAddRasterLayer: (layer: RasterLayer) => void;
  onEditRasterLayer: (layer: RasterLayer) => void;
  onRemoveRasterLayer: (id: string) => void;
  onToggleRasterLayer: (id: string) => void;
  vectorLayers: VectorLayerConfig[];
  onToggleVectorLayer: (id: string) => void;
  onRemoveVectorLayer: (id: string) => void;
  onEditVectorLayer: (layer: VectorLayerConfig) => void;
  onReorderRasterLayers: (layers: RasterLayer[]) => void;
  onReorderVectorLayers: (layers: VectorLayerConfig[]) => void;
  onAddVectorLayer: (file: File) => Promise<void>;
  onAddMVTLayer: (url: string, name: string) => Promise<void>;
  onExportVectorLayer: (layerId: string, format: 'geojson' | 'kml') => void;
  onGoToVectorLayerExtent: (layerId: string) => void;
  onGoToRasterLayerExtent: (layerId: string) => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [vectorEditingId, setVectorEditingId] = useState<string | null>(null);
  const [vectorEditName, setVectorEditName] = useState('');
  const [vectorEditUrl, setVectorEditUrl] = useState('');
  const [draggedRasterId, setDraggedRasterId] = useState<string | null>(null);
  const [draggedVectorId, setDraggedVectorId] = useState<string | null>(null);
  const [newLayerName, setNewLayerName] = useState('');
  const [newLayerType, setNewLayerType] = useState<'xyz' | 'wmts' | 'wms'>('xyz');
  const [newLayerUrl, setNewLayerUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAddVectorForm, setShowAddVectorForm] = useState(false);
  const [vectorSourceType, setVectorSourceType] = useState<'file' | 'mvt'>('file');
  const [mvtUrl, setMvtUrl] = useState('');
  const [mvtLayerName, setMvtLayerName] = useState('');
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
          <div className="settings-section-title">Basic Settings</div>
          <div className="settings-basic-grid">
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="grid-toggle"
                checked={showGrid}
                onChange={(e) => onGridToggle(e.target.checked)}
              />
              <label htmlFor="grid-toggle">Show Grid</label>
            </div>
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="draw-toolbar-toggle"
                checked={showDrawToolbar}
                onChange={(e) => onDrawToolbarToggle(e.target.checked)}
              />
              <label htmlFor="draw-toolbar-toggle">Drawing Tool</label>
            </div>
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="coordinates-toggle"
                checked={showCoordinates}
                onChange={(e) => onCoordinatesToggle(e.target.checked)}
              />
              <label htmlFor="coordinates-toggle">Show Coordinates</label>
            </div>
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
                  className="settings-layer-visibility"
                  onClick={() => onToggleRasterLayer(layer.id)}
                  title={layer.visible !== false ? "Hide layer" : "Show layer"}
                >
                  <EyeIcon visible={layer.visible !== false} />
                </button>
                {layer.type !== 'xyz' && (
                  <button
                    className="settings-layer-extent"
                    onClick={() => onGoToRasterLayerExtent(layer.id)}
                    title="Zoom to layer extent"
                  >
                    <ZoomToExtentIcon />
                  </button>
                )}
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
              <CustomSelect
                value={newLayerType}
                onChange={(val) => {
                  setNewLayerType(val as 'xyz' | 'wmts' | 'wms');
                  setWmtsLayers([]);
                  setWmtsFetched(false);
                  setSelectedWmtsLayer('');
                  setWmsLayers([]);
                  setWmsFetched(false);
                  setSelectedWmsLayer('');
                  lastAutoNameRef.current = '';
                }}
                className="settings-select"
                options={[
                  { value: 'xyz', label: 'XYZ' },
                  { value: 'wmts', label: 'WMTS' },
                  { value: 'wms', label: 'WMS' },
                ]}
              />
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
                      if (matched && (!newLayerName.trim() || newLayerName.trim() === lastAutoNameRef.current)) {
                        setNewLayerName(matched.title);
                        lastAutoNameRef.current = matched.title;
                      }
                    }}
                    className="settings-select"
                    disabled={!wmtsCapabilitiesUrl.trim()}
                    placeholder={wmtsLoading ? 'Loading...' : 'Select a layer'}
                    filterable
                    options={wmtsLoading ? [] : [
                      { value: '', label: 'Select a layer', disabled: true },
                      ...wmtsLayers.map((layer) => ({ value: layer.identifier, label: layer.title })),
                    ]}
                  />
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
                      if (matched && (!newLayerName.trim() || newLayerName.trim() === lastAutoNameRef.current)) {
                        setNewLayerName(matched.title.trim());
                        lastAutoNameRef.current = matched.title.trim();
                      }
                    }}
                    className="settings-select"
                    disabled={!wmsCapabilitiesUrl.trim()}
                    placeholder={wmsLoading ? 'Loading...' : 'Select a layer'}
                    filterable
                    options={wmsLoading ? [] : [
                      { value: '', label: 'Select a layer', disabled: true },
                      ...wmsLayers.map((layer) => ({ value: layer.name, label: layer.title })),
                    ]}
                  />
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
                vectorEditingId === layer.id ? (
                  <div key={layer.id} className="settings-add-form">
                    <input
                      type="text"
                      placeholder="Layer name"
                      value={vectorEditName}
                      onChange={(e) => setVectorEditName(e.target.value)}
                      className="settings-input"
                    />
                    {layer.type === 'mvt' ? (
                      <>
                        <input
                          type="text"
                          placeholder="MVT URL"
                          value={vectorEditUrl}
                          onChange={(e) => setVectorEditUrl(e.target.value)}
                          className="settings-input"
                        />
                        <div className="settings-form-buttons">
                          <button className="settings-button-primary" onClick={() => {
                            if (vectorEditName.trim() && vectorEditUrl.trim()) {
                              onEditVectorLayer({ ...layer, name: vectorEditName.trim(), url: vectorEditUrl.trim() });
                              setVectorEditingId(null);
                            }
                          }}>Apply</button>
                          <button className="settings-button-secondary" onClick={() => setVectorEditingId(null)}>Cancel</button>
                        </div>
                      </>
                    ) : (
                      <div className="settings-wmts-info">
                        Source: {layer.type.toUpperCase()} file (name only editable)
                      </div>
                    )}
                    {layer.type !== 'mvt' && (
                      <div className="settings-form-buttons">
                        <button className="settings-button-primary" onClick={() => {
                          if (vectorEditName.trim()) {
                            onEditVectorLayer({ ...layer, name: vectorEditName.trim() });
                            setVectorEditingId(null);
                          }
                        }}>Apply</button>
                        <button className="settings-button-secondary" onClick={() => setVectorEditingId(null)}>Cancel</button>
                        {layer.isDrawnInApp && (
                          <>
                            <button className="settings-button-export" onClick={() => onExportVectorLayer(layer.id, 'geojson')} title="Export as GeoJSON">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              GeoJSON
                            </button>
                            <button className="settings-button-export" onClick={() => onExportVectorLayer(layer.id, 'kml')} title="Export as KML">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              KML
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
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
                    <span className="settings-layer-name">{layer.name}</span>
                    <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                    <button
                      className="settings-layer-edit"
                      onClick={() => {
                        setVectorEditingId(layer.id);
                        setVectorEditName(layer.name);
                        setVectorEditUrl(layer.url || '');
                      }}
                      title="Edit layer"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      className="settings-layer-visibility"
                      onClick={() => onToggleVectorLayer(layer.id)}
                      title={layer.visible ? "Hide layer" : "Show layer"}
                    >
                      <EyeIcon visible={layer.visible} />
                    </button>
                    {layer.type !== 'mvt' && (
                      <button
                        className="settings-layer-extent"
                        onClick={() => onGoToVectorLayerExtent(layer.id)}
                        title="Zoom to layer extent"
                      >
                        <ZoomToExtentIcon />
                      </button>
                    )}
                    <button 
                      className="settings-layer-remove"
                      onClick={() => onRemoveVectorLayer(layer.id)}
                      title="Remove layer"
                    >
                      &times;
                    </button>
                  </div>
                )
              ))}
            </div>
          )}
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
                onChange={(val) => setVectorSourceType(val as 'file' | 'mvt')}
                className="settings-select"
                options={[
                  { value: 'file', label: 'File (GeoJSON/KML/KMZ)' },
                  { value: 'mvt', label: 'MVT (Vector Tiles)' },
                ]}
              />
              {vectorSourceType === 'file' ? (
                <>
                  <input
                    type="file"
                    accept=".geojson,.json,.kml,.kmz"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        onAddVectorLayer(file);
                        setShowAddVectorForm(false);
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
              ) : (
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
              )}
              <div className="settings-form-buttons">
                {vectorSourceType === 'mvt' && (
                  <button 
                    className="settings-button-primary" 
                    onClick={() => {
                      if (mvtLayerName.trim() && mvtUrl.trim()) {
                        onAddMVTLayer(mvtUrl.trim(), mvtLayerName.trim());
                        setMvtUrl('');
                        setMvtLayerName('');
                        setShowAddVectorForm(false);
                      }
                    }}
                  >
                    Add
                  </button>
                )}
                <button 
                  className="settings-button-secondary" 
                  onClick={() => setShowAddVectorForm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


type GoToMethod = 'zxy' | 'latlng' | 'address';

function GoToBar({ onGoTo }: { onGoTo: (center: [number, number], zoom: number) => void }) {
  const [method, setMethod] = useState<GoToMethod>('zxy');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAddressSearch = async (query: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!response.ok) {
        throw new Error('Search request failed');
      }
      const results = await response.json();
      if (!results || results.length === 0) {
        setError('No results found');
        return;
      }
      const result = results[0];
      const lat = parseFloat(result.lat);
      const lon = parseFloat(result.lon);

      // Compute zoom from bounding box if available
      let zoom = 15;
      if (result.boundingbox) {
        const south = parseFloat(result.boundingbox[0]);
        const north = parseFloat(result.boundingbox[1]);
        const west = parseFloat(result.boundingbox[2]);
        const east = parseFloat(result.boundingbox[3]);
        const latDiff = north - south;
        const lonDiff = east - west;
        const maxDiff = Math.max(latDiff, lonDiff);
        if (maxDiff > 0) {
          zoom = Math.max(1, Math.min(18, Math.floor(Math.log2(360 / maxDiff)) - 1));
        }
      }

      onGoTo([lon, lat], zoom);
    } catch (err: any) {
      setError(err?.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = input.trim();
    if (!trimmed) return;

    if (method === 'zxy') {
      const match = trimmed.match(/^(\d+)\/(\d+)\/(\d+)$/);
      if (!match) {
        setError('Format: z/x/y');
        return;
      }
      const z = parseInt(match[1], 10);
      const x = parseInt(match[2], 10);
      const y = parseInt(match[3], 10);

      if (z < 0 || z > 25) {
        setError('Zoom must be 0-25');
        return;
      }
      const maxTile = Math.pow(2, z);
      if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) {
        setError('Tile out of range');
        return;
      }

      const n = Math.pow(2, z);
      const lon = (x + 0.5) / n * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
      const lat = latRad * 180 / Math.PI;

      onGoTo([lon, lat], z);
    } else if (method === 'latlng') {
      const match = trimmed.match(/^(-?[\d.]+)[,\s]+(-?[\d.]+)$/);
      if (!match) {
        setError('Format: lat,lng');
        return;
      }
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);

      if (lat < -90 || lat > 90) {
        setError('Lat must be -90 to 90');
        return;
      }
      if (lng < -180 || lng > 180) {
        setError('Lng must be -180 to 180');
        return;
      }

      onGoTo([lng, lat], 15);
    } else {
      // address search
      handleAddressSearch(trimmed);
    }
  };

  const placeholders: Record<GoToMethod, string> = {
    zxy: 'z/x/y e.g. 11/1811/1236',
    latlng: 'lat,lng e.g. -34.111,138.222',
    address: 'Search address...',
  };

  return (
    <form className={`goto-bar${method === 'address' ? ' goto-bar-address' : ''}`} onSubmit={handleSubmit}>
      <CustomSelect
        className="goto-select"
        value={method}
        onChange={val => { setMethod(val as GoToMethod); setError(''); setInput(''); }}
        options={[
          { value: 'zxy', label: 'ZXY' },
          { value: 'latlng', label: 'LatLng' },
          { value: 'address', label: 'Address' },
        ]}
      />
      <div className={`goto-input-wrapper${method === 'address' ? ' goto-input-wide' : ''}`}>
        <input
          className={`goto-input${error ? ' goto-input-error' : ''}`}
          type="text"
          placeholder={placeholders[method]}
          value={input}
          onChange={e => { setInput(e.target.value); setError(''); }}
          disabled={loading}
        />
        {input && !loading && (
          <button
            type="button"
            className="goto-clear"
            onClick={() => { setInput(''); setError(''); }}
            title="Clear"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
        {loading && (
          <span className="goto-spinner" />
        )}
      </div>
      <button className="goto-button" type="submit" title="Go" disabled={loading}>
        {loading ? (
          <span className="goto-button-spinner" />
        ) : (
          method === 'address' ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          )
        )}
      </button>
      {error && <span className="goto-error">{error}</span>}
    </form>
  );
}

// DrawToolbar component
function DrawToolbar({ 
  activeTool, 
  onToolSelect 
}: { 
  activeTool: 'line' | 'polygon' | 'rectangle' | 'label' | null;
  onToolSelect: (tool: 'line' | 'polygon' | 'rectangle' | 'label' | null) => void;
}) {
  const tools = [
    {
      id: 'line' as const,
      title: 'Draw Line',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="19" x2="19" y2="5" />
        </svg>
      ),
    },
    {
      id: 'polygon' as const,
      title: 'Draw Polygon',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8.5 18 21 6 21 2 8.5" />
        </svg>
      ),
    },
    {
      id: 'rectangle' as const,
      title: 'Draw Rectangle',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="1" />
        </svg>
      ),
    },
    {
      id: 'label' as const,
      title: 'Add Label',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </svg>
      ),
    },
  ];

  return (
    <div className="draw-toolbar">
      {tools.map((tool) => (
        <button
          key={tool.id}
          className={`draw-toolbar-button ${activeTool === tool.id ? 'active' : ''}`}
          onClick={() => onToolSelect(activeTool === tool.id ? null : tool.id)}
          title={tool.title}
        >
          {tool.icon}
        </button>
      ))}
    </div>
  );
}

// Label Input Dialog component - appears at map position for label text entry
function LabelInputDialog({
  pixel,
  onApply,
  onCancel,
}: {
  pixel: [number, number];
  onApply: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus the input when dialog appears
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleApply = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onApply(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  // Calculate position, keeping dialog within viewport bounds
  const dialogWidth = 260;
  const dialogHeight = 90;
  const mapEl = document.getElementById('map');
  const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;

  let left = pixel[0] + 12;
  let top = pixel[1] - 20;

  if (mapRect) {
    // Ensure dialog stays within map bounds
    if (left + dialogWidth > mapRect.width) {
      left = pixel[0] - dialogWidth - 12;
    }
    if (top + dialogHeight > mapRect.height) {
      top = mapRect.height - dialogHeight - 10;
    }
    if (top < 10) {
      top = 10;
    }
    if (left < 10) {
      left = 10;
    }
  }

  return (
    <div
      className="label-input-dialog"
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        zIndex: 10,
      }}
    >
      <div className="label-input-dialog-title">Enter Label</div>
      <input
        ref={inputRef}
        type="text"
        className="label-input-dialog-input"
        placeholder="Label text..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={100}
      />
      <div className="label-input-dialog-buttons">
        <button className="label-input-dialog-btn label-input-dialog-btn-apply" onClick={handleApply} disabled={!text.trim()}>
          Apply
        </button>
        <button className="label-input-dialog-btn label-input-dialog-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// DrawnFeaturesPanel component
function DrawnFeaturesPanel({
  drawnFeatures,
  expanded,
  onToggle,
  onRemove,
  onSaveToLayers,
  onExport,
}: {
  drawnFeatures: Array<{ id: string; type: string; name: string; feature: any }>;
  expanded: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  onSaveToLayers: (layerName: string) => void;
  onExport: (format: 'geojson' | 'kml') => void;
}) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [layerName, setLayerName] = useState('');

  return (
    <div className={`drawn-features-panel ${expanded ? 'expanded' : ''}`}>
      <div className="drawn-features-header" onClick={onToggle}>
        <span className="drawn-features-title">
          Drawn Features
          {drawnFeatures.length > 0 && (
            <span className="drawn-features-count">{drawnFeatures.length}</span>
          )}
        </span>
        <span className={`drawn-features-chevron ${expanded ? 'expanded' : ''}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </div>
      {expanded && (
        <div className="drawn-features-body">
          {drawnFeatures.length === 0 ? (
            <div className="drawn-features-empty">No features drawn yet</div>
          ) : (
            <>
              <div className="drawn-features-list">
                {drawnFeatures.map((item) => (
                  <div key={item.id} className="drawn-features-item">
                    <div className="drawn-features-item-info">
                      <span className="drawn-features-item-icon">
                        {item.type === 'LineString' && (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="5" y1="19" x2="19" y2="5" />
                          </svg>
                        )}
                        {item.type === 'Polygon' && (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="12 2 22 8.5 18 21 6 21 2 8.5" />
                          </svg>
                        )}
                        {item.type === 'Point' && (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 7V4h16v3" />
                            <path d="M9 20h6" />
                            <path d="M12 4v16" />
                          </svg>
                        )}
                      </span>
                      <span className="drawn-features-item-name">{item.name}</span>
                    </div>
                    <button
                      className="drawn-features-item-remove"
                      onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                      title="Remove feature"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
              <div className="drawn-features-layer-name">
                <input
                  type="text"
                  className="drawn-features-name-input"
                  placeholder="Layer name (optional)"
                  value={layerName}
                  onChange={(e) => setLayerName(e.target.value)}
                />
              </div>
              <div className="drawn-features-actions">
                <button
                  className="drawn-features-btn drawn-features-btn-save"
                  onClick={() => onSaveToLayers(layerName.trim())}
                  disabled={drawnFeatures.length === 0}
                  title="Add to vector layers"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                  Save to Layers
                </button>
                <div className="drawn-features-export-wrapper">
                  <button
                    className="drawn-features-btn drawn-features-btn-export"
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    disabled={drawnFeatures.length === 0}
                    title="Export features"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Export
                  </button>
                  {showExportMenu && (
                    <div className="drawn-features-export-menu">
                      <button onClick={() => { onExport('geojson'); setShowExportMenu(false); }}>
                        Export as GeoJSON
                      </button>
                      <button onClick={() => { onExport('kml'); setShowExportMenu(false); }}>
                        Export as KML
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}


function MouseCoordinateDisplay({ 
  coordinate, 
  projection, 
  onProjectionChange,
  decimals,
  onDecimalsChange
}: { 
  coordinate: [number, number] | null; 
  projection: string;
  onProjectionChange: (proj: string) => void;
  decimals: number;
  onDecimalsChange: (decimals: number) => void;
}) {
  let coordContent: React.ReactNode;
  
  if (coordinate) {
    if (projection === 'EPSG:4326') {
      const [lon, lat] = toLonLat(coordinate);
      coordContent = (
        <>
          <span className="coord-label">Lat: </span>
          <span className="coord-value">{lat.toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Lng: </span>
          <span className="coord-value">{lon.toFixed(decimals)}</span>
        </>
      );
    } else {
      coordContent = (
        <>
          <span className="coord-label">X: </span>
          <span className="coord-value">{coordinate[0].toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Y: </span>
          <span className="coord-value">{coordinate[1].toFixed(decimals)}</span>
        </>
      );
    }
  } else {
    coordContent = <span className="coord-label">Move mouse over map</span>;
  }

  return (
    <div className="mouse-coordinate-display">
      <span className="mouse-coordinate-text">{coordContent}</span>
      <CustomSelect
        className="mouse-coordinate-select"
        value={projection}
        onChange={(val) => {
          onProjectionChange(val);
          onDecimalsChange(val === 'EPSG:4326' ? 6 : 3);
        }}
        options={[
          { value: 'EPSG:4326', label: 'EPSG:4326' },
          { value: 'EPSG:3857', label: 'EPSG:3857' },
        ]}
      />
      <label className="mouse-coordinate-label">Decimal:</label>
      <input
        type="number"
        className="mouse-coordinate-spinbox"
        min="3"
        max="10"
        value={decimals}
        onChange={(e) => onDecimalsChange(parseInt(e.target.value, 10))}
      />
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
  const [showDrawToolbar, setShowDrawToolbar] = useState(storedSettings.current.showDrawToolbar);
  const [showCoordinates, setShowCoordinates] = useState(storedSettings.current.showCoordinates);
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>(storedSettings.current.rasterLayers);
  const [vectorLayers, setVectorLayers] = useState<VectorLayerConfig[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [popupContent, setPopupContent] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<[number, number] | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const popupOverlayRef = useRef<Overlay | null>(null);
  const [activeDrawTool, setActiveDrawTool] = useState<'line' | 'polygon' | 'rectangle' | 'label' | null>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const drawSourceRef = useRef<VectorSource | null>(null);
  const drawLayerRef = useRef<VectorLayer<any> | null>(null);
  const [drawnFeatures, setDrawnFeatures] = useState<Array<{
    id: string;
    type: 'LineString' | 'Polygon' | 'Point';
    name: string;
    feature: any;
  }>>([]);
  const [showDrawnPanel, setShowDrawnPanel] = useState(false);
  const [labelDialogState, setLabelDialogState] = useState<{
    pixel: [number, number];
    feature: any;
    featureId: string;
  } | null>(null);
  const [mouseCoord, setMouseCoord] = useState<[number, number] | null>(null);
  const [coordProjection, setCoordProjection] = useState<string>('EPSG:4326');
  const [coordDecimals, setCoordDecimals] = useState<number>(6);




  useEffect(() => {
    if (!zoomRef.current || !attributionRef.current) {
      return;
    }

    const zoomControl = new Zoom({ target: zoomRef.current });
    const attributionControl = new Attribution({
      target: attributionRef.current,
      collapsible: false,
    });
    const scaleLineControl = new ScaleLine();

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
        scaleLineControl,
      ]),
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
      ],
      view: mapview,
    });

    mapRef.current = map;

    // Track mouse coordinates on the map
    map.on('pointermove', (evt) => {
      if (evt.dragging) return;
      setMouseCoord(evt.coordinate as [number, number]);
    });

    // Setup drawing layer with style function
    const drawSource = new VectorSource();
    
    const drawLayerStyle = (feature: any) => {
      const labelText = feature.get('labelText');
      const baseStyle = new Style({
        fill: new Fill({ color: 'rgba(255, 204, 51, 0.2)' }),
        stroke: new Stroke({ color: '#ffcc33', width: 2 }),
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: '#ffcc33' }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
        }),
      });
      
      if (labelText) {
        return new Style({
          fill: new Fill({ color: 'rgba(255, 204, 51, 0.2)' }),
          stroke: new Stroke({ color: '#ffcc33', width: 2 }),
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: '#ffcc33' }),
            stroke: new Stroke({ color: '#fff', width: 2 }),
          }),
          text: new Text({
            text: labelText,
            font: '14px Arial',
            fill: new Fill({ color: '#000' }),
            stroke: new Stroke({ color: '#fff', width: 3 }),
            offsetY: -15,
          }),
        });
      }
      
      return baseStyle;
    };
    
    const drawLayer = new VectorLayer({
      source: drawSource,
      style: drawLayerStyle,
    });
    drawLayer.setZIndex(9999);
    drawLayer.set('_isDrawLayer', true);
    map.addLayer(drawLayer);
    drawSourceRef.current = drawSource;
    drawLayerRef.current = drawLayer;


    // Setup popup overlay - create element in JS to avoid React/OL DOM conflicts
    const popupEl = document.createElement('div');
    popupEl.className = 'map-popup';
    popupEl.style.display = 'none';
    
    const closerBtn = document.createElement('button');
    closerBtn.className = 'popup-closer';
    closerBtn.innerHTML = '&times;';
    closerBtn.onclick = () => {
      setPopupContent(null);
      setPopupPosition(null);
    };
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'popup-content';
    
    popupEl.appendChild(closerBtn);
    popupEl.appendChild(contentDiv);
    
    // Add popup element to the map container
    
    const popupOverlay = new Overlay({
      element: popupEl,
      autoPan: true,
      positioning: 'bottom-center',
      offset: [0, -12],
    });
    map.addOverlay(popupOverlay);
    popupOverlayRef.current = popupOverlay;
    popupRef.current = popupEl;

    // Click handler for vector layer features
    map.on('click', (evt) => {
      let found = false;
      map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
        if (found) return;
        if (!layer) return;
        
        const properties = feature.getProperties();
        const metadata: Record<string, any> = {};
        
        Object.keys(properties).forEach(key => {
          const value = properties[key];
          if (key === 'geometry') return;
          if (typeof value === 'object' && value !== null && value.getType) return;
          metadata[key] = value;
        });

        if (Object.keys(metadata).length > 0) {
          const html = Object.entries(metadata)
            .map(([key, value]) => '<div><strong>' + key + ':</strong> ' + String(value) + '</div>')
            .join('');
          setPopupContent(html);
          setPopupPosition(evt.coordinate as [number, number]);
          found = true;
        }
      });

      if (!found) {
        setPopupContent(null);
        setPopupPosition(null);
      }
    });

    map.on('moveend', () => updateUrlParams(mapview));

    // Restore layers from localStorage
    (async () => {
    const restoredRasterLayers: RasterLayer[] = [];
    for (const layerConfig of storedSettings.current.rasterLayers) {
      try {
        let olLayer: any;
        let extent: number[] | null = null;

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
          
          extent = extractWmtsExtent(capabilities, layerConfig.wmtsLayer || '');
          olLayer = new TileLayer({
            source: new WMTS(wmtsOptions),
          });
        } else if (layerConfig.type === 'wms') {
          // Fetch capabilities to extract extent
          try {
            const response = await fetch(layerConfig.wmsCapabilitiesUrl || layerConfig.url);
            const text = await response.text();
            const parser = new WMSCapabilities();
            const capabilities = parser.read(text);
            extent = extractWmsExtent(capabilities, layerConfig.wmsLayer || '');
          } catch (capError) {
            console.warn('Failed to fetch WMS capabilities for extent during restore:', capError);
          }

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

        olLayer.setVisible(layerConfig.visible !== false);
        map.addLayer(olLayer);
        rasterLayersRef.current.set(layerConfig.id, olLayer);
        restoredRasterLayers.push({ ...layerConfig, olLayer, ...(extent ? { extent } : {}) });
      } catch (error) {
        console.error('Failed to restore raster layer:', error);
      }
    }

    // Restore MVT vector layers from localStorage
    const restoredMvtLayers: VectorLayerConfig[] = [];
    storedSettings.current.vectorLayers
      .filter(layer => layer.type === 'mvt')
      .forEach((layerConfig) => {
        try {
          const source = new VectorTileSource({
            format: new MVT(),
            url: layerConfig.url || '',
          });

          const olLayer = new VectorTileLayer({
            source: source,
            style: getRandomColorStyle(),
            visible: layerConfig.visible !== false,
          });

          map.addLayer(olLayer);
          vectorLayersRef.current.set(layerConfig.id, olLayer);
          
          // Add to restored layers with OL layer reference
          restoredMvtLayers.push({ ...layerConfig, olLayer });
        } catch (error) {
          console.error('Failed to restore MVT layer:', error);
        }
      });
    
    // Set state with all restored layers
    setRasterLayers(restoredRasterLayers);
    setVectorLayers(restoredMvtLayers);
    if (restoredRasterLayers.length > 0 || restoredMvtLayers.length > 0) {
      reorderLayers(map, restoredRasterLayers, restoredMvtLayers);
    }
    })();

    return () => {
      if (zoomRef.current) {
        zoomRef.current.innerHTML = '';
      }
      if (attributionRef.current) {
        attributionRef.current.innerHTML = '';
      }
      if (popupOverlayRef.current) {
        map.removeOverlay(popupOverlayRef.current);
        popupOverlayRef.current = null;
      }
      map.setTarget(undefined);
    };
  }, []);

  useEffect(() => {
    saveSettings({ showGrid, showDrawToolbar, showCoordinates, rasterLayers, vectorLayers });
  }, [showGrid, showDrawToolbar, showCoordinates, rasterLayers, vectorLayers]);

  // Update popup position and content
  useEffect(() => {
    if (popupOverlayRef.current && popupPosition && popupContent) {
      popupOverlayRef.current.setPosition(popupPosition);
      if (popupRef.current) {
        popupRef.current.style.display = 'block';
        const contentDiv = popupRef.current.querySelector('.popup-content');
        if (contentDiv) {
          contentDiv.innerHTML = popupContent;
        }
      }
    } else if (popupOverlayRef.current) {
      popupOverlayRef.current.setPosition(undefined);
      if (popupRef.current) {
        popupRef.current.style.display = 'none';
      }
    }
  }, [popupPosition, popupContent]);

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

  // Auto-open panel when entering draw mode
  useEffect(() => {
    if (activeDrawTool !== null) {
      setShowDrawnPanel(true);
    }
  }, [activeDrawTool]);

  // Clear drawing interaction and unsaved geometry when toolbar is hidden
  useEffect(() => {
    if (!showDrawToolbar) {
      // Remove active draw interaction
      if (activeDrawTool !== null) {
        if (drawInteractionRef.current && mapRef.current) {
          mapRef.current.removeInteraction(drawInteractionRef.current);
          drawInteractionRef.current = null;
        }
        setActiveDrawTool(null);
      }
      // Clear unsaved drawn features from the map
      if (drawSourceRef.current) {
        drawSourceRef.current.clear();
      }
      setDrawnFeatures([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrawToolbar]);

  const handleEditRasterLayer = async (updated: RasterLayer) => {
    if (!mapRef.current) return;

    const olLayer = rasterLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      mapRef.current.removeLayer(olLayer);
      let newOlLayer: any;
      let extent: number[] | null = null;

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
        
        extent = extractWmtsExtent(capabilities, updated.wmtsLayer || '');
        newOlLayer = new TileLayer({
          source: new WMTS(wmtsOptions),
        });
      } else if (updated.type === 'wms') {
        // Fetch capabilities to extract extent
        try {
          const response = await fetch(updated.wmsCapabilitiesUrl || updated.url);
          const text = await response.text();
          const parser = new WMSCapabilities();
          const capabilities = parser.read(text);
          extent = extractWmsExtent(capabilities, updated.wmsLayer || '');
        } catch (capError) {
          console.warn('Failed to fetch WMS capabilities for extent:', capError);
        }

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
      const updatedWithRef = { ...updated, olLayer: newOlLayer, ...(extent ? { extent } : {}) };
      const newRasterLayers = rasterLayers.map(l => l.id === updated.id ? updatedWithRef : l);
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);
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

  const getRandomColorStyle = () => {
    const hue = Math.floor(Math.random() * 360);
    const solidColor = 'hsl(' + hue + ', 70%, 50%)';
    const fillColor = 'hsla(' + hue + ', 70%, 50%, 0.3)';
    
    return new Style({
      fill: new Fill({
        color: fillColor,
      }),
      stroke: new Stroke({
        color: solidColor,
        width: 2,
      }),
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({
          color: solidColor,
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
        const geojsonData = JSON.parse(text);
        const format = new GeoJSON();
        
        // Check for CRS property in GeoJSON and register projection
        let dataProjection: string | Projection = 'EPSG:4326';
        if (geojsonData.crs) {
          const crsName = geojsonData.crs.properties?.name;
          if (crsName) {
            // Extract EPSG code from CRS name like "urn:ogc:def:crs:EPSG::4326"
            const epsgMatch = crsName.match(/EPSG::?(\d+)/);
            if (epsgMatch) {
              const epsgCode = epsgMatch[1];
              if (epsgCode !== '4326') {
                const registeredId = await registerProjectionFromEPSGCode(epsgCode);
                if (registeredId) {
                  dataProjection = registeredId;
                }
              }
            }
          }
        }
        
        features = format.readFeatures(text, {
          dataProjection: dataProjection,
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
        const shapefileResult = await parseShapefile(file);
        if (shapefileResult.features.length === 0) {
          alert('No features found in the shapefile');
          return;
        }

        // Register projection from .prj file if present
        let dataProjection: string | Projection = 'EPSG:4326';
        if (shapefileResult.projectionWKT) {
          const registeredId = await registerProjectionFromWKT(shapefileResult.projectionWKT);
          if (registeredId) {
            dataProjection = registeredId;
          }
        }

        // Debug: Log WKT projection
        console.log('=== SHAPEFILE DEBUG ===');
        console.log('[1] WKT from .prj file:', shapefileResult.projectionWKT);
        console.log('[2] Feature count:', shapefileResult.features.length);

        // Debug: Log source coordinates before transformation
        if (shapefileResult.features.length > 0) {
          const firstFeature = shapefileResult.features[0];
          const firstGeom = firstFeature.geometry;
          console.log('[3] First feature geometry type:', firstGeom.type);
          
          // Get coordinates based on geometry type
          let sourceCoords: any = null;
          if (firstGeom.type === 'Polygon') {
            sourceCoords = firstGeom.coordinates[0].slice(0, 5); // First 5 points of outer ring
          } else if (firstGeom.type === 'MultiPolygon') {
            sourceCoords = firstGeom.coordinates[0][0].slice(0, 5);
          } else if (firstGeom.type === 'LineString') {
            sourceCoords = firstGeom.coordinates.slice(0, 5);
          } else if (firstGeom.type === 'MultiLineString') {
            sourceCoords = firstGeom.coordinates[0].slice(0, 5);
          } else if (firstGeom.type === 'Point') {
            sourceCoords = firstGeom.coordinates;
          } else if (firstGeom.type === 'MultiPoint') {
            sourceCoords = firstGeom.coordinates.slice(0, 5);
          }
          console.log('[4] Source coordinates (from shapefile):', sourceCoords);
        }

        console.log('[5] dataProjection before readFeatures:', dataProjection);

        const geojsonFormat = new GeoJSON();
        features = geojsonFormat.readFeatures({
          type: 'FeatureCollection',
          features: shapefileResult.features
        }, {
          dataProjection: dataProjection,
          featureProjection: 'EPSG:3857',
        });

        // Debug: Log transformed coordinates
        if (features.length > 0) {
          const firstFeature = features[0];
          const geom = firstFeature.getGeometry();
          if (geom) {
            console.log('[6] OL geometry type:', geom.getType());
            const coords = geom.getCoordinates();
            
            // Get coordinates based on geometry type
            let transformedCoords: any = null;
            if (geom.getType() === 'Polygon') {
              transformedCoords = coords[0].slice(0, 5); // First 5 points of outer ring
            } else if (geom.getType() === 'MultiPolygon') {
              transformedCoords = coords[0][0].slice(0, 5);
            } else if (geom.getType() === 'LineString') {
              transformedCoords = coords.slice(0, 5);
            } else if (geom.getType() === 'MultiLineString') {
              transformedCoords = coords[0].slice(0, 5);
            } else if (geom.getType() === 'Point') {
              transformedCoords = coords;
            } else if (geom.getType() === 'MultiPoint') {
              transformedCoords = coords.slice(0, 5);
            }
            console.log('[7] Transformed coordinates (EPSG:3857):', transformedCoords);
            
            // Get extent
            const extent = geom.getExtent();
            console.log('[8] Feature extent (EPSG:3857):', extent);
          }
        }
        console.log('=== END SHAPEFILE DEBUG ===');
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


      // Check if features have their own styles (KML/KMZ with extractStyles)
      const hasOwnStyles = features.some(f => f.getStyle && f.getStyle() !== null);
      
      const olLayer = new VectorLayer({
        source: source,
        style: hasOwnStyles ? undefined : getRandomColorStyle(),
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

  const handleAddMVTLayer = async (url: string, name: string) => {
    if (!mapRef.current) return;

    try {
      const source = new VectorTileSource({
        format: new MVT(),
        url: url,
      });

      const olLayer = new VectorTileLayer({
        source: source,
        style: getRandomColorStyle(),
      });

      mapRef.current.addLayer(olLayer);

      const layerConfig: VectorLayerConfig = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        type: 'mvt',
        visible: true,
        olLayer: olLayer,
        url: url,
      };

      vectorLayersRef.current.set(layerConfig.id, olLayer);
      const newVectorLayers = [...vectorLayers, layerConfig];
      setVectorLayers(newVectorLayers);

      // Reorder layers
      reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
    } catch (error) {
      console.error('Failed to load MVT layer:', error);
      alert(`Failed to load MVT layer "${name}". The URL may be invalid or inaccessible.`);
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

  const handleEditVectorLayer = async (updated: VectorLayerConfig) => {
    if (!mapRef.current) return;

    const olLayer = vectorLayersRef.current.get(updated.id);
    if (!olLayer) return;

    try {
      // Only MVT layers support URL changes; file-based layers just update name
      if (updated.type === 'mvt' && updated.url) {
        mapRef.current.removeLayer(olLayer);

        const source = new VectorTileSource({
          format: new MVT(),
          url: updated.url,
        });

        const newOlLayer = new VectorTileLayer({
          source: source,
          style: getRandomColorStyle(),
          visible: updated.visible !== false,
        });

        mapRef.current.addLayer(newOlLayer);
        vectorLayersRef.current.set(updated.id, newOlLayer);

        const updatedWithRef = { ...updated, olLayer: newOlLayer };
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updatedWithRef : l);
        setVectorLayers(newVectorLayers);
        reorderLayers(mapRef.current, rasterLayers, newVectorLayers);
      } else {
        // File-based layer: only name changed, no OL layer recreation needed
        const newVectorLayers = vectorLayers.map(l => l.id === updated.id ? updated : l);
        setVectorLayers(newVectorLayers);
      }
    } catch (error) {
      console.error('Failed to edit vector layer:', error);
    }
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
    const newLayers = rasterLayers.filter(l => l.id !== id);
    setRasterLayers(newLayers);
    reorderLayers(mapRef.current, newLayers, vectorLayers);
  };

  const handleToggleRasterLayer = (id: string) => {
    const olLayer = rasterLayersRef.current.get(id);
    if (!olLayer) return;

    setRasterLayers(prev =>
      prev.map(l => {
        if (l.id === id) {
          const newVisible = l.visible === false ? true : false;
          olLayer.setVisible(newVisible);
          return { ...l, visible: newVisible };
        }
        return l;
      })
    );
  };


  const handleDrawTool = (tool: 'line' | 'polygon' | 'rectangle' | 'label' | null) => {
    if (!mapRef.current || !drawSourceRef.current) return;

    // Remove existing draw interaction
    if (drawInteractionRef.current) {
      mapRef.current.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }

    // If same tool clicked, toggle off
    if (tool === activeDrawTool) {
      setActiveDrawTool(null);
      return;
    }

    setActiveDrawTool(tool);

    if (!tool) return;

    let drawType: any;
    let geometryFunction: any = undefined;

    if (tool === 'line') {
      drawType = 'LineString';
    } else if (tool === 'polygon') {
      drawType = 'Polygon';
    } else if (tool === 'rectangle') {
      drawType = 'Circle';
      geometryFunction = createBox();
    } else if (tool === 'label') {
      drawType = 'Point';
    }

    const drawInteraction = new Draw({
      source: drawSourceRef.current,
      type: drawType,
      geometryFunction: geometryFunction,
    });

    // Track features as they are drawn
    drawInteraction.on('drawend', (evt) => {
      const feature = evt.feature;
      const featureId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6);
      const geomType = feature.getGeometry()?.getType() || 'Unknown';
      
      // Clear any individual style - let the layer's style function handle it
      feature.setStyle();
      
      if (tool === 'label') {
        // Get the pixel position of the drawn point for dialog placement
        const pointCoords = (feature.getGeometry() as any).getCoordinates();
        const pixel = mapRef.current!.getPixelFromCoordinate(pointCoords);
        
        // Show the in-app label dialog instead of browser prompt
        setLabelDialogState({
          pixel: pixel as [number, number],
          feature: feature,
          featureId: featureId,
        });
      } else {
        // Non-label features — compute name inside updater so we always see the latest list
        setDrawnFeatures(prev => {
          let displayName = '';
          if (tool === 'line') displayName = 'Line ' + (prev.filter(f => f.type === 'LineString').length + 1);
          else if (tool === 'polygon') displayName = 'Polygon ' + (prev.filter(f => f.type === 'Polygon' && !f.name.startsWith('Rectangle')).length + 1);
          else if (tool === 'rectangle') displayName = 'Rectangle ' + (prev.filter(f => f.name.startsWith('Rectangle')).length + 1);
          
          return [...prev, {
            id: featureId,
            type: tool === 'rectangle' ? 'Polygon' : (geomType as any),
            name: displayName,
            feature: feature,
          }];
        });
      }
    });

    mapRef.current.addInteraction(drawInteraction);
    drawInteractionRef.current = drawInteraction;
  };

  const handleLabelDialogApply = (text: string) => {
    if (!labelDialogState) return;
    const { feature, featureId } = labelDialogState;
    
    feature.set('labelText', text);
    setDrawnFeatures(prev => [...prev, {
      id: featureId,
      type: 'Point',
      name: 'Label: ' + text,
      feature: feature,
    }]);
    setLabelDialogState(null);
  };

  const handleLabelDialogCancel = () => {
    if (!labelDialogState) return;
    const { feature } = labelDialogState;
    
    // Remove the feature from draw source since no label was provided
    if (drawSourceRef.current) {
      drawSourceRef.current.removeFeature(feature);
    }
    setLabelDialogState(null);
  };

  const handleExportVectorLayer = (layerId: string, format: 'geojson' | 'kml') => {
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;

    const source = olLayer.getSource();
    if (!source) return;

    const features = source.getFeatures().slice();
    if (features.length === 0) {
      alert('No features to export.');
      return;
    }

    const layerConfig = vectorLayers.find(l => l.id === layerId);
    const baseName = layerConfig?.name || 'export';
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'geojson') {
      const geojsonFormat = new GeoJSON();
      content = geojsonFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = safeName + '.geojson';
      mimeType = 'application/geo+json';
    } else {
      const kmlFormat = new KML({ extractStyles: false });
      content = kmlFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = safeName + '.kml';
      mimeType = 'application/vnd.google-earth.kml+xml';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleGoToRasterLayerExtent = (layerId: string) => {
    if (!mapRef.current) return;
    const layerConfig = rasterLayers.find(l => l.id === layerId);
    if (!layerConfig || !layerConfig.extent) return;

    const extent = layerConfig.extent;
    if (extent.length === 4 && extent.every((v: number) => isFinite(v))) {
      mapRef.current.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 18,
        duration: 500,
      });
    }
  };

  const handleGoToVectorLayerExtent = (layerId: string) => {
    if (!mapRef.current) return;
    const olLayer = vectorLayersRef.current.get(layerId);
    if (!olLayer) return;
    const source = olLayer.getSource();
    if (!source) return;
    const extent = source.getExtent();
    if (extent && extent.every((v: number) => isFinite(v))) {
      mapRef.current.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 18,
        duration: 500,
      });
    }
  };

  const handleRemoveDrawnFeature = (id: string) => {
    const featureToRemove = drawnFeatures.find(f => f.id === id);
    if (featureToRemove && drawSourceRef.current) {
      drawSourceRef.current.removeFeature(featureToRemove.feature);
    }
    setDrawnFeatures(prev => prev.filter(f => f.id !== id));
  };

  const handleSaveDrawnToLayers = (layerName: string) => {
    if (drawnFeatures.length === 0 || !mapRef.current || !drawSourceRef.current) return;

    // Clone features from draw source
    const features = drawSourceRef.current.getFeatures().slice();
    if (features.length === 0) return;

    // Create a new vector layer with these features
    const source = new VectorSource({ features: features });
    const olLayer = new VectorLayer({
      source: source,
      style: getRandomColorStyle(),
    });

    mapRef.current.addLayer(olLayer);

    const layerConfig: VectorLayerConfig = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      name: layerName || ('Drawn Features ' + (vectorLayers.length + 1)),
      type: 'geojson',
      visible: true,
      olLayer: olLayer,
      isDrawnInApp: true,
    };

    vectorLayersRef.current.set(layerConfig.id, olLayer);
    setVectorLayers(prev => [...prev, layerConfig]);
    reorderLayers(mapRef.current, rasterLayers, [...vectorLayers, layerConfig]);

    // Clear drawn features from the draw layer
    drawSourceRef.current.clear();
    setDrawnFeatures([]);
  };

  const handleExportDrawnFeatures = (format: 'geojson' | 'kml') => {
    if (drawnFeatures.length === 0 || !drawSourceRef.current) return;

    const features = drawSourceRef.current.getFeatures().slice();
    if (features.length === 0) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'geojson') {
      const geojsonFormat = new GeoJSON();
      content = geojsonFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = 'drawn-features.geojson';
      mimeType = 'application/geo+json';
    } else {
      const kmlFormat = new KML({ extractStyles: false });
      content = kmlFormat.writeFeatures(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      filename = 'drawn-features.kml';
      mimeType = 'application/vnd.google-earth.kml+xml';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleGoTo = (lonlat: [number, number], zoom: number) => {
    if (!mapRef.current) return;
    const view = mapRef.current.getView();
    const center = fromLonLat(lonlat);
    view.animate({ center, zoom, duration: 500 });
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
      let extent: number[] | null = null;

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
        
        extent = extractWmtsExtent(capabilities, layerConfig.wmtsLayer || '');
        olLayer = new TileLayer({
          source: new WMTS(wmtsOptions),
        });
      } else if (layerConfig.type === 'wms') {
        // Fetch capabilities to extract extent
        try {
          const response = await fetch(layerConfig.wmsCapabilitiesUrl || layerConfig.url);
          const text = await response.text();
          const parser = new WMSCapabilities();
          const capabilities = parser.read(text);
          extent = extractWmsExtent(capabilities, layerConfig.wmsLayer || '');
        } catch (capError) {
          console.warn('Failed to fetch WMS capabilities for extent:', capError);
        }

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

      olLayer.setVisible(layerConfig.visible !== false);
      mapRef.current.addLayer(olLayer);
      rasterLayersRef.current.set(layerConfig.id, olLayer);
      const layerConfigWithRef = { ...layerConfig, olLayer, ...(extent ? { extent } : {}) };
      const newRasterLayers = [...rasterLayers, layerConfigWithRef];
      setRasterLayers(newRasterLayers);
      reorderLayers(mapRef.current, newRasterLayers, vectorLayers);
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
      <GoToBar onGoTo={handleGoTo} />
      {showCoordinates && <MouseCoordinateDisplay
        coordinate={mouseCoord}
        projection={coordProjection}
        onProjectionChange={setCoordProjection}
        decimals={coordDecimals}
        onDecimalsChange={setCoordDecimals}
      />}

      {showDrawToolbar && <DrawToolbar activeTool={activeDrawTool} onToolSelect={handleDrawTool} />}
      {showDrawToolbar && activeDrawTool !== null && (
        <DrawnFeaturesPanel
          drawnFeatures={drawnFeatures}
          expanded={showDrawnPanel}
          onToggle={() => setShowDrawnPanel(!showDrawnPanel)}
          onRemove={handleRemoveDrawnFeature}
          onSaveToLayers={handleSaveDrawnToLayers}
          onExport={handleExportDrawnFeatures}
        />
      )}
      {labelDialogState && (
        <LabelInputDialog
          pixel={labelDialogState.pixel}
          onApply={handleLabelDialogApply}
          onCancel={handleLabelDialogCancel}
        />
      )}
      <div ref={zoomRef} className="map-controls" />
      <div ref={attributionRef} className="map-attribution" />

      <div className="map-settings-wrapper">
        {showSettings && (
          <SettingsDialog 
            onClose={() => setShowSettings(false)} 
            showGrid={showGrid}
            onGridToggle={setShowGrid}
            showDrawToolbar={showDrawToolbar}
            onDrawToolbarToggle={setShowDrawToolbar}
            showCoordinates={showCoordinates}
            onCoordinatesToggle={setShowCoordinates}
            rasterLayers={rasterLayers}
            onAddRasterLayer={handleAddRasterLayer}
            onEditRasterLayer={handleEditRasterLayer}
            onRemoveRasterLayer={handleRemoveRasterLayer}
            onToggleRasterLayer={handleToggleRasterLayer}
            vectorLayers={vectorLayers}
            onToggleVectorLayer={handleToggleVectorLayer}
            onRemoveVectorLayer={handleRemoveVectorLayer}
            onEditVectorLayer={handleEditVectorLayer}
            onReorderRasterLayers={handleReorderRasterLayers}
            onReorderVectorLayers={handleReorderVectorLayers}
            onAddVectorLayer={handleAddVectorLayer}
            onAddMVTLayer={handleAddMVTLayer}
            onExportVectorLayer={handleExportVectorLayer}
            onGoToVectorLayerExtent={handleGoToVectorLayerExtent}
            onGoToRasterLayerExtent={handleGoToRasterLayerExtent}
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
