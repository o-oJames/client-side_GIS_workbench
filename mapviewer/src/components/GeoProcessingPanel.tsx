/**
 * GeoProcessingPanel — floating desktop-OS-style window for vector
 * geoprocessing tools (buffer, clip, intersect, union, dissolve, centroid,
 * convex hull, distance).
 *
 * Movable by title bar, resizable from edges/corners, closable.
 * Follows the same gesture model as AttributeTableWindow.
 */
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { CustomSelect } from './CustomSelect';
import { LoadingIndicator } from './LoadingIndicator';
import { CloseIcon, GeoProcessingIcon } from './Icons';
import type { VectorLayerConfig, CustomSelectOption } from '../types';
import {
  GeoFeature,
  GeoGeom,
  DistanceUnit,
  bufferFeatures,
  clipFeatures,
  intersectFeatures,
  unionFeatures,
  dissolveFeatures,
  centroidFeatures,
  convexHullFeature,
  computeDistances,
  toMeters,
  olFeaturesToGeo,
} from '../utils/geoprocessing';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type ToolId = 'buffer' | 'clip' | 'intersect' | 'union' | 'dissolve' | 'centroid' | 'convexHull' | 'distance';

interface ToolDef {
  id: ToolId;
  label: string;
  category: string;
  needsSecondLayer: boolean;
  description: string;
}

const TOOLS: ToolDef[] = [
  { id: 'buffer',      label: 'Buffer',              category: 'Proximity',    needsSecondLayer: false, description: 'Create polygons around features at a specified distance.' },
  { id: 'clip',        label: 'Clip',                category: 'Overlay',      needsSecondLayer: true,  description: 'Clip input features using a polygon layer as the cookie cutter.' },
  { id: 'intersect',   label: 'Intersect',           category: 'Overlay',      needsSecondLayer: true,  description: 'Find the overlapping areas between two polygon layers.' },
  { id: 'union',       label: 'Union',               category: 'Overlay',      needsSecondLayer: true,  description: 'Combine features from two layers into one.' },
  { id: 'dissolve',    label: 'Dissolve',            category: 'Manage Data',  needsSecondLayer: false, description: 'Merge all features in a layer into a single feature.' },
  { id: 'centroid',    label: 'Centroid',            category: 'Manage Data',  needsSecondLayer: false, description: 'Create point features at the centre of each input feature.' },
  { id: 'convexHull',  label: 'Convex Hull',         category: 'Manage Data',  needsSecondLayer: false, description: 'Create the smallest convex polygon enclosing all features.' },
  { id: 'distance',    label: 'Distance',             category: 'Proximity',    needsSecondLayer: true,  description: 'Compute distances between features of two layers.' },
];

const CATEGORIES = ['Proximity', 'Overlay', 'Manage Data'];

const DISTANCE_UNITS: { value: DistanceUnit; label: string }[] = [
  { value: 'meters',     label: 'Meters' },
  { value: 'kilometers', label: 'Kilometers' },
  { value: 'miles',      label: 'Miles' },
  { value: 'feet',       label: 'Feet' },
];

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

interface WindowRect { x: number; y: number; w: number; h: number; }
type GestureMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const DEFAULT_RECT: WindowRect = { x: 80, y: 60, w: 560, h: 480 };
const MIN_W = 420;
const MIN_H = 320;

function clampRect(r: WindowRect, cw: number, ch: number): WindowRect {
  let { x, y, w, h } = r;
  w = Math.max(MIN_W, Math.min(w, cw));
  h = Math.max(MIN_H, Math.min(h, ch));
  x = Math.max(0, Math.min(x, cw - w));
  y = Math.max(0, Math.min(y, ch - h));
  return { x, y, w, h };
}

function applyGesture(mode: GestureMode, start: WindowRect, dx: number, dy: number): WindowRect {
  let { x, y, w, h } = start;
  if (mode === 'move') { x += dx; y += dy; }
  else {
    if (mode.includes('e')) w += dx;
    if (mode.includes('s')) h += dy;
    if (mode.includes('w')) { x += dx; w -= dx; }
    if (mode.includes('n')) { y += dy; h -= dy; }
  }
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GeoProcessingPanelProps {
  vectorLayers: VectorLayerConfig[];
  /** Get OL layer for a config id — used to extract features. */
  getOlLayer: (layerId: string) => any;
  /** Add a result layer from GeoJSON string. */
  onAddResultLayer: (geoJsonStr: string, name: string) => void;
  onClose: () => void;
  showToast: (message: string, kind?: 'success' | 'error') => void;
}

export function GeoProcessingPanel({
  vectorLayers,
  getOlLayer,
  onAddResultLayer,
  onClose,
  showToast,
}: GeoProcessingPanelProps) {

  // ----- usable vector layers (exclude mvt — no local features) -----------
  const usableLayers = useMemo(
    () => vectorLayers.filter(l => l.type !== 'mvt'),
    [vectorLayers]
  );

  const layerOptions: CustomSelectOption[] = useMemo(
    () => usableLayers.map(l => ({ value: l.id, label: l.name })),
    [usableLayers]
  );

  // ----- window geometry ---------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;

  const [rect, setRect] = useState<WindowRect>(DEFAULT_RECT);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const gestureRef = useRef<{ mode: GestureMode; startX: number; startY: number; startRect: WindowRect } | null>(null);

  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setContainerSize({ w: parent.clientWidth, h: parent.clientHeight });
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(parent);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Clamp initial rect to container
  useEffect(() => {
    if (containerSize.w === 0) return;
    setRect(prev => clampRect(prev, containerSize.w, containerSize.h));
  }, [containerSize]);

  const onGestureMove = useCallback((e: MouseEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const next = applyGesture(g.mode, g.startRect, e.clientX - g.startX, e.clientY - g.startY);
    const { w, h } = containerSizeRef.current;
    setRect(w > 0 ? clampRect(next, w, h) : next);
  }, []);

  const onGestureEnd = useCallback(() => {
    gestureRef.current = null;
    window.removeEventListener('mousemove', onGestureMove);
    window.removeEventListener('mouseup', onGestureEnd);
    document.body.style.userSelect = '';
  }, [onGestureMove]);

  const beginGesture = useCallback((mode: GestureMode, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gestureRef.current = { mode, startX: e.clientX, startY: e.clientY, startRect: rectRef.current };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onGestureMove);
    window.addEventListener('mouseup', onGestureEnd);
  }, [onGestureMove, onGestureEnd]);

  const onTitleBarMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    beginGesture('move', e);
  }, [beginGesture]);

  // ----- tool state --------------------------------------------------------
  const [selectedTool, setSelectedTool] = useState<ToolId>('buffer');
  const [searchText, setSearchText] = useState('');

  const [inputLayerId, setInputLayerId] = useState('');
  const [secondLayerId, setSecondLayerId] = useState('');
  const [outputName, setOutputName] = useState('');
  const [bufferDistance, setBufferDistance] = useState('100');
  const [bufferUnit, setBufferUnit] = useState<DistanceUnit>('meters');
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>('meters');
  const [dissolveOverlap, setDissolveOverlap] = useState(true);

  // Auto-select first layer when layers change
  useEffect(() => {
    if (usableLayers.length > 0 && !usableLayers.find(l => l.id === inputLayerId)) {
      setInputLayerId(usableLayers[0].id);
    }
  }, [usableLayers, inputLayerId]);

  useEffect(() => {
    if (usableLayers.length > 1 && !usableLayers.find(l => l.id === secondLayerId)) {
      const fallback = usableLayers.find(l => l.id !== inputLayerId) || usableLayers[0];
      setSecondLayerId(fallback.id);
    }
  }, [usableLayers, secondLayerId, inputLayerId]);

  // Update default output name when tool/layer changes
  const toolDef = TOOLS.find(t => t.id === selectedTool)!;
  useEffect(() => {
    const inputLayer = usableLayers.find(l => l.id === inputLayerId);
    const name = inputLayer ? `${toolDef.label} of ${inputLayer.name}` : toolDef.label;
    setOutputName(name);
  }, [selectedTool, inputLayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter tools by search
  const filteredTools = useMemo(() => {
    if (!searchText.trim()) return TOOLS;
    const q = searchText.toLowerCase();
    return TOOLS.filter(t =>
      t.label.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q)
    );
  }, [searchText]);

  // ----- run ---------------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extractFeatures = useCallback((layerId: string): GeoFeature[] => {
    const olLayer = getOlLayer(layerId);
    if (!olLayer) return [];
    const source = olLayer._rawSource || (olLayer.getSource && olLayer.getSource());
    if (!source || typeof source.getFeatures !== 'function') return [];
    return olFeaturesToGeo(source.getFeatures());
  }, [getOlLayer]);

  const handleRun = useCallback(() => {
    setError(null);
    const inputFeatures = extractFeatures(inputLayerId);
    if (inputFeatures.length === 0) {
      setError('Input layer has no features.');
      return;
    }

    setRunning(true);
    // Use setTimeout to allow the UI to update with spinner
    setTimeout(() => {
      try {
        let resultFeatures: GeoFeature[] = [];

        switch (selectedTool) {
          case 'buffer': {
            const d = parseFloat(bufferDistance);
            if (isNaN(d) || d <= 0) {
              setError('Buffer distance must be a positive number.');
              setRunning(false);
              return;
            }
            const meters = toMeters(d, bufferUnit);
            resultFeatures = bufferFeatures(inputFeatures, meters);
            break;
          }
          case 'clip': {
            const clipFeats = extractFeatures(secondLayerId);
            if (clipFeats.length === 0) {
              setError('Clip layer has no features.');
              setRunning(false);
              return;
            }
            resultFeatures = clipFeatures(inputFeatures, clipFeats);
            break;
          }
          case 'intersect': {
            const layerB = extractFeatures(secondLayerId);
            if (layerB.length === 0) {
              setError('Second layer has no features.');
              setRunning(false);
              return;
            }
            resultFeatures = intersectFeatures(inputFeatures, layerB);
            break;
          }
          case 'union': {
            const layerB = extractFeatures(secondLayerId);
            resultFeatures = unionFeatures(inputFeatures, layerB);
            break;
          }
          case 'dissolve': {
            resultFeatures = dissolveFeatures(inputFeatures);
            break;
          }
          case 'centroid': {
            resultFeatures = centroidFeatures(inputFeatures);
            break;
          }
          case 'convexHull': {
            const hull = convexHullFeature(inputFeatures);
            resultFeatures = hull ? [hull] : [];
            break;
          }
          case 'distance': {
            const layerB = extractFeatures(secondLayerId);
            if (layerB.length === 0) {
              setError('Second layer has no features.');
              setRunning(false);
              return;
            }
            const distanceResults = computeDistances(inputFeatures, layerB, distanceUnit);
            // Convert distance results to point features (midpoints with distance attribute)
            resultFeatures = [];
            for (const dr of distanceResults) {
              const fA = inputFeatures[dr.featureA_index];
              const fB = layerB[dr.featureB_index];
              if (!fA?.geometry || !fB?.geometry) continue;
              const cA = getGeomCenter(fA.geometry);
              const cB = getGeomCenter(fB.geometry);
              resultFeatures.push({
                type: 'Feature' as const,
                geometry: { type: 'LineString' as const, coordinates: [cA, cB] },
                properties: {
                  distance: Math.round(dr.distance_display * 1000) / 1000,
                  unit: dr.unit,
                  from_feature: dr.featureA_index + 1,
                  to_feature: dr.featureB_index + 1,
                },
              });
            }
            break;
          }
        }

        if (resultFeatures.length === 0) {
          setError('No result features were produced. Try different inputs or parameters.');
          setRunning(false);
          return;
        }

        const geoJsonStr = JSON.stringify({
          type: 'FeatureCollection',
          features: resultFeatures,
        });

        const name = outputName.trim() || toolDef.label;
        onAddResultLayer(geoJsonStr, name);
        showToast(`"${name}" added — ${resultFeatures.length} feature${resultFeatures.length !== 1 ? 's' : ''}`, 'success');
        setRunning(false);
      } catch (err: any) {
        setError(err?.message || 'Geoprocessing failed.');
        setRunning(false);
      }
    }, 30);
  }, [selectedTool, inputLayerId, secondLayerId, bufferDistance, bufferUnit, distanceUnit, outputName, extractFeatures, onAddResultLayer, showToast, toolDef]);

  // ----- render helpers ----------------------------------------------------
  const inputLayerName = usableLayers.find(l => l.id === inputLayerId)?.name || '';

  return (
    <div
      ref={rootRef}
      className="gp-window"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {/* Title bar */}
      <div className="gp-titlebar" onMouseDown={onTitleBarMouseDown}>
        <span className="gp-titlebar-icon"><GeoProcessingIcon /></span>
        <span className="gp-titlebar-title">Vector Geoprocessing</span>
        <span className="gp-titlebar-spacer" />
        <button type="button" className="gp-titlebar-close" onClick={onClose} title="Close" aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div className="gp-body">
        {/* Tool rail */}
        <div className="gp-rail">
          <div className="gp-rail-search">
            <input
              type="text"
              className="gp-rail-search-input"
              placeholder="Search tools…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
          </div>
          <div className="gp-rail-list">
            {CATEGORIES.map(cat => {
              const catTools = filteredTools.filter(t => t.category === cat);
              if (catTools.length === 0) return null;
              return (
                <div key={cat} className="gp-rail-category">
                  <div className="gp-rail-category-label">{cat}</div>
                  {catTools.map(tool => (
                    <button
                      key={tool.id}
                      type="button"
                      className={`gp-rail-tool${selectedTool === tool.id ? ' gp-rail-tool--active' : ''}`}
                      title={tool.description}
                      onClick={() => setSelectedTool(tool.id)}
                    >
                      {tool.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Tool form */}
        <div className="gp-form">
          {usableLayers.length === 0 ? (
            <div className="gp-empty">
              <div className="gp-empty-icon">
                <GeoProcessingIcon />
              </div>
              <div className="gp-empty-text">No usable vector layers</div>
              <div className="gp-empty-hint">Add a vector layer (GeoJSON, KML, Shapefile, etc.) to get started.</div>
            </div>
          ) : (
            <>
              <div className="gp-form-description">{toolDef.description}</div>

              {/* Input layer */}
              <div className="gp-form-row">
                <label className="gp-form-label">Input layer</label>
                <CustomSelect
                  value={inputLayerId}
                  onChange={setInputLayerId}
                  options={layerOptions}
                  className="settings-select"
                  placeholder="Select input layer"
                />
              </div>

              {/* Second layer (for tools that need it) */}
              {toolDef.needsSecondLayer && (
                <div className="gp-form-row">
                  <label className="gp-form-label">{selectedTool === 'distance' ? 'Second layer' : selectedTool === 'clip' ? 'Clip layer' : 'Overlay layer'}</label>
                  <CustomSelect
                    value={secondLayerId}
                    onChange={setSecondLayerId}
                    options={layerOptions.filter(o => o.value !== inputLayerId)}
                    className="settings-select"
                    placeholder="Select layer"
                  />
                </div>
              )}

              {/* Buffer parameters */}
              {selectedTool === 'buffer' && (
                <>
                  <div className="gp-form-row gp-form-row-inline">
                    <div className="gp-form-row-flex">
                      <label className="gp-form-label">Distance</label>
                      <input
                        type="number"
                        className="gp-form-input"
                        value={bufferDistance}
                        onChange={e => setBufferDistance(e.target.value)}
                        min="0"
                        step="any"
                        placeholder="Distance"
                      />
                    </div>
                    <div className="gp-form-row-flex">
                      <label className="gp-form-label">Units</label>
                      <CustomSelect
                        value={bufferUnit}
                        onChange={v => setBufferUnit(v as DistanceUnit)}
                        options={DISTANCE_UNITS.map(u => ({ value: u.value, label: u.label }))}
                        className="settings-select"
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Distance units */}
              {selectedTool === 'distance' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Output units</label>
                  <CustomSelect
                    value={distanceUnit}
                    onChange={v => setDistanceUnit(v as DistanceUnit)}
                    options={DISTANCE_UNITS.map(u => ({ value: u.value, label: u.label }))}
                    className="settings-select"
                  />
                </div>
              )}

              {/* Dissolve options */}
              {selectedTool === 'dissolve' && (
                <div className="gp-form-row">
                  <label className="gp-form-checkbox">
                    <input
                      type="checkbox"
                      checked={dissolveOverlap}
                      onChange={e => setDissolveOverlap(e.target.checked)}
                    />
                    <span>Merge overlapping geometries</span>
                  </label>
                </div>
              )}

              {/* Output name */}
              <div className="gp-form-row">
                <label className="gp-form-label">Output name</label>
                <input
                  type="text"
                  className="gp-form-input"
                  value={outputName}
                  onChange={e => setOutputName(e.target.value)}
                  placeholder="Result layer name"
                />
              </div>

              {/* Run row */}
              <div className="gp-run-row">
                <button
                  type="button"
                  className="gp-run-button"
                  onClick={handleRun}
                  disabled={running || !inputLayerId}
                >
                  {running ? 'Running…' : 'Run'}
                </button>
                {running && <LoadingIndicator message="Processing…" />}
              </div>

              {/* Error / status */}
              {error && (
                <div className="gp-error">{error}</div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Resize handles */}
      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as GestureMode[]).map(mode => (
        <div
          key={mode}
          className={`gp-resize gp-resize-${mode}`}
          onMouseDown={e => beginGesture(mode, e)}
        />
      ))}
    </div>
  );
}

/** Get the center coordinate of a geometry (simple average). */
function getGeomCenter(geom: GeoGeom): [number, number] {
  const coords = collectAllCoords(geom);
  if (coords.length === 0) return [0, 0];
  let sx = 0, sy = 0;
  for (const c of coords) { sx += c[0]; sy += c[1]; }
  return [sx / coords.length, sy / coords.length];
}

function collectAllCoords(geom: GeoGeom): [number, number][] {
  switch (geom.type) {
    case 'Point': return [geom.coordinates];
    case 'MultiPoint': return geom.coordinates;
    case 'LineString': return geom.coordinates;
    case 'MultiLineString': return geom.coordinates.flat();
    case 'Polygon': return geom.coordinates[0];
    case 'MultiPolygon': return geom.coordinates.map(p => p[0]).flat();
  }
}
