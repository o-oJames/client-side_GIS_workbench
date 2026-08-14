/**
 * GeoProcessingPanel — floating desktop-OS-style window for vector
 * geoprocessing tools (buffer, clip, intersect, union, dissolve, centroid,
 * convex hull, distance, eliminate features).
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
  eliminateSelectedPolygons,
  computeDistances,
  toMeters,
  olFeaturesToGeo,
  checkValidity,
  collectGeometries,
  delaunayTriangulation,
  densifyByCount,
  addGeometryAttributes,
  extractVertices,
  multipartToSingleparts,
  polygonsToLines,
  simplifyFeatures,
  voronoiPolygons,
  linesToPolygons,
  makeValid,
} from '../utils/geoprocessing';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type ToolId = 'buffer' | 'clip' | 'intersect' | 'union' | 'dissolve' | 'centroid' | 'convexHull' | 'distance' | 'eliminate' | 'checkValidity' | 'makeValid' | 'collectGeometries' | 'delaunay' | 'densify' | 'addGeometryAttrs' | 'extractVertices' | 'multipartToSingle' | 'polygonsToLines' | 'simplify' | 'voronoi' | 'linesToPolygons';

interface ToolDef {
  id: ToolId;
  label: string;
  category: string;
  needsSecondLayer: boolean;
  description: string;
}

const TOOLS: ToolDef[] = [
  // Geometry Tool
  { id: 'centroid',            label: 'Centroids',                  category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create point features at the centre of each input feature.' },
  { id: 'checkValidity',       label: 'Check Validity',             category: 'Geometry Tool',  needsSecondLayer: false, description: 'Check if polygon geometries are valid (no self-intersections, proper rings).' },
  { id: 'makeValid',           label: 'Make Valid',                 category: 'Geometry Tool',  needsSecondLayer: false, description: 'Fix invalid polygon geometries (self-intersections, ring orientation, degenerate rings).' },
  { id: 'collectGeometries',   label: 'Collect Geometries',         category: 'Geometry Tool',  needsSecondLayer: false, description: 'Merge all features into a single multi-geometry feature.' },
  { id: 'delaunay',            label: 'Delaunay Triangulation',     category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create a Delaunay triangulation from input points.' },
  { id: 'densify',             label: 'Densify by Count',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Add evenly-spaced vertices along each segment.' },
  { id: 'addGeometryAttrs',    label: 'Add Geometry Attributes',    category: 'Geometry Tool',  needsSecondLayer: false, description: 'Add area, length, perimeter, x, y attributes to features.' },
  { id: 'extractVertices',     label: 'Extract Vertices',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Extract all vertices from line/polygon features as points.' },
  { id: 'multipartToSingle',   label: 'Multipart to Singleparts',   category: 'Geometry Tool',  needsSecondLayer: false, description: 'Split multi-geometries into individual single-geometry features.' },
  { id: 'polygonsToLines',     label: 'Polygons to Lines',          category: 'Geometry Tool',  needsSecondLayer: false, description: 'Convert polygon boundaries to line features.' },
  { id: 'simplify',            label: 'Simplify',                   category: 'Geometry Tool',  needsSecondLayer: false, description: 'Simplify geometries using Douglas-Peucker algorithm.' },
  { id: 'voronoi',             label: 'Voronoi Polygons',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create Voronoi diagram from input points.' },
  { id: 'linesToPolygons',     label: 'Lines to Polygons',          category: 'Geometry Tool',  needsSecondLayer: false, description: 'Convert closed line features to polygons.' },
  // Geoprocessing Tool
  { id: 'buffer',              label: 'Buffer',                     category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Create polygons around features at a specified distance.' },
  { id: 'clip',                label: 'Clip',                       category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Clip input features using a polygon layer as the cookie cutter.' },
  { id: 'intersect',           label: 'Intersect',                  category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Find the overlapping areas between two polygon layers.' },
  { id: 'union',               label: 'Union',                      category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Combine features from two layers into one.' },
  { id: 'dissolve',            label: 'Dissolve',                   category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Merge all features in a layer into a single feature.' },
  { id: 'convexHull',          label: 'Convex Hull',                category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Create the smallest convex polygon enclosing all features.' },
  { id: 'distance',            label: 'Distance',                   category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Compute distances between features of two layers.' },
  { id: 'eliminate',           label: 'Eliminate selected polygons', category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Dissolve selected polygons into their neighbors by removing shared boundaries.' },
];

const CATEGORIES = ['Geometry Tool', 'Geoprocessing Tool'];

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
  /** The OL map instance. */
  map: any;
  /** Get OL layer for a config id — used to extract features. */
  getOlLayer: (layerId: string) => any;
  /** Add a result layer from GeoJSON string. */
  onAddResultLayer: (geoJsonStr: string, name: string) => void;
  onClose: () => void;
  showToast: (message: string, kind?: 'success' | 'error') => void;
}

export function GeoProcessingPanel({
  vectorLayers,
  map,
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
  // New geometry tool state
  const [densifyCount, setDensifyCount] = useState('3');
  const [simplifyTolerance, setSimplifyTolerance] = useState('10');
  const [addArea, setAddArea] = useState(true);
  const [addLength, setAddLength] = useState(true);
  const [addPerimeter, setAddPerimeter] = useState(false);
  const [addX, setAddX] = useState(false);
  const [addY, setAddY] = useState(false);
  // Selection state for eliminate tool
  const [selectingMode, setSelectingMode] = useState(false);
  const [selectedOlFeatures, setSelectedOlFeatures] = useState<any[]>([]);
  const selectedOlFeaturesRef = useRef<any[]>([]);
  selectedOlFeaturesRef.current = selectedOlFeatures;
  const clickHandlerRef = useRef<((e: any) => void) | null>(null);

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

  // Clear selection when switching tools or input layers
  useEffect(() => {
    setSelectedOlFeatures([]);
    setSelectingMode(false);
  }, [selectedTool, inputLayerId]);

  // Selection click handler for eliminate tool
  useEffect(() => {
    if (!selectingMode || !map) return;
    
    const olLayer = getOlLayer(inputLayerId);
    if (!olLayer) return;
    
    const source = olLayer._rawSource || (olLayer.getSource && olLayer.getSource());
    if (!source || typeof source.getFeatures !== 'function') return;
    
    const handler = (e: any) => {
      const pixel = e.pixel;
      const features = map.getFeaturesAtPixel(pixel, {
        layerFilter: (layer: any) => layer === olLayer,
      });
      
      if (features && features.length > 0) {
        const feature = features[0];
        setSelectedOlFeatures(prev => {
          const idx = prev.indexOf(feature);
          if (idx >= 0) {
            return prev.filter((_, i) => i !== idx);
          } else {
            return [...prev, feature];
          }
        });
      }
    };
    
    map.on('click', handler);
    clickHandlerRef.current = handler;
    
    return () => {
      map.un('click', handler);
      clickHandlerRef.current = null;
    };
  }, [selectingMode, map, inputLayerId, getOlLayer]);

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
          case 'eliminate': {
            if (selectedOlFeatures.length === 0) {
              setError('No polygons selected. Use "Select on map" to pick polygons to eliminate.');
              setRunning(false);
              return;
            }
            // Find indices of selected features in the input features array
            const allOlFeatures = (() => {
              const olLayer = getOlLayer(inputLayerId);
              if (!olLayer) return [];
              const source = olLayer._rawSource || (olLayer.getSource && olLayer.getSource());
              if (!source || typeof source.getFeatures !== 'function') return [];
              return source.getFeatures();
            })();
            const selectedIndices = new Set<number>();
            for (const sel of selectedOlFeatures) {
              const idx = allOlFeatures.indexOf(sel);
              if (idx >= 0) selectedIndices.add(idx);
            }
            if (selectedIndices.size === 0) {
              setError('Selected features not found in the input layer.');
              setRunning(false);
              return;
            }
            resultFeatures = eliminateSelectedPolygons(inputFeatures, selectedIndices);
            break;
          }
          case 'checkValidity': {
            const validityResults = checkValidity(inputFeatures);
            resultFeatures = validityResults.map((vr, idx) => ({
              type: 'Feature' as const,
              geometry: vr.feature.geometry,
              properties: {
                ...vr.feature.properties,
                valid: vr.valid,
                validity_reason: vr.reason,
                feature_index: idx + 1,
              },
            }));
            break;
          }
          case 'makeValid': {
            resultFeatures = makeValid(inputFeatures);
            break;
          }
          case 'collectGeometries': {
            resultFeatures = collectGeometries(inputFeatures);
            break;
          }
          case 'delaunay': {
            resultFeatures = delaunayTriangulation(inputFeatures);
            break;
          }
          case 'densify': {
            const count = parseInt(densifyCount, 10);
            if (isNaN(count) || count < 1) {
              setError('Densify count must be a positive integer.');
              setRunning(false);
              return;
            }
            resultFeatures = densifyByCount(inputFeatures, count);
            break;
          }
          case 'addGeometryAttrs': {
            resultFeatures = addGeometryAttributes(inputFeatures, {
              addArea,
              addLength,
              addPerimeter,
              addX,
              addY,
            });
            break;
          }
          case 'extractVertices': {
            resultFeatures = extractVertices(inputFeatures);
            break;
          }
          case 'multipartToSingle': {
            resultFeatures = multipartToSingleparts(inputFeatures);
            break;
          }
          case 'polygonsToLines': {
            resultFeatures = polygonsToLines(inputFeatures);
            break;
          }
          case 'simplify': {
            const tolerance = parseFloat(simplifyTolerance);
            if (isNaN(tolerance) || tolerance <= 0) {
              setError('Simplify tolerance must be a positive number.');
              setRunning(false);
              return;
            }
            resultFeatures = simplifyFeatures(inputFeatures, tolerance);
            break;
          }
          case 'voronoi': {
            resultFeatures = voronoiPolygons(inputFeatures);
            break;
          }
          case 'linesToPolygons': {
            resultFeatures = linesToPolygons(inputFeatures);
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
  }, [selectedTool, inputLayerId, secondLayerId, bufferDistance, bufferUnit, distanceUnit, outputName, extractFeatures, onAddResultLayer, showToast, toolDef, selectedOlFeatures, getOlLayer, densifyCount, simplifyTolerance, addArea, addLength, addPerimeter, addX, addY]);

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
        <span className="gp-titlebar-title">Vector Tools</span>
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

              {/* Eliminate selection */}
              {selectedTool === 'eliminate' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Select polygons</label>
                  <div className="gp-eliminate-controls">
                    <button
                      type="button"
                      className={`gp-select-btn${selectingMode ? ' gp-select-btn--active' : ''}`}
                      onClick={() => setSelectingMode(!selectingMode)}
                    >
                      {selectingMode ? 'Stop selecting' : 'Select on map'}
                    </button>
                    <span className="gp-select-count">
                      {selectedOlFeatures.length} polygon{selectedOlFeatures.length !== 1 ? 's' : ''} selected
                    </span>
                  </div>
                  {selectedOlFeatures.length > 0 && (
                    <button
                      type="button"
                      className="gp-clear-btn"
                      onClick={() => setSelectedOlFeatures([])}
                    >
                      Clear selection
                    </button>
                  )}
                  <div className="gp-form-hint">
                    Click polygons on the map to select them for elimination. Each selected polygon will be dissolved into an adjacent neighbor.
                  </div>
                </div>
              )}

              {/* Densify count */}
              {selectedTool === 'densify' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Vertices per segment</label>
                  <input
                    type="number"
                    className="gp-form-input"
                    value={densifyCount}
                    onChange={e => setDensifyCount(e.target.value)}
                    min="1"
                    step="1"
                    placeholder="Number of vertices to add"
                  />
                  <div className="gp-form-hint">
                    Number of evenly-spaced vertices to add along each segment.
                  </div>
                </div>
              )}

              {/* Simplify tolerance */}
              {selectedTool === 'simplify' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Tolerance</label>
                  <input
                    type="number"
                    className="gp-form-input"
                    value={simplifyTolerance}
                    onChange={e => setSimplifyTolerance(e.target.value)}
                    min="0"
                    step="any"
                    placeholder="Simplification tolerance"
                  />
                  <div className="gp-form-hint">
                    Maximum distance a vertex can be moved during simplification (in map units).
                  </div>
                </div>
              )}

              {/* Add Geometry Attributes options */}
              {selectedTool === 'addGeometryAttrs' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Attributes to add</label>
                  <div className="gp-attr-checkboxes">
                    <label className="gp-form-checkbox">
                      <input type="checkbox" checked={addArea} onChange={e => setAddArea(e.target.checked)} />
                      <span>Area</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input type="checkbox" checked={addLength} onChange={e => setAddLength(e.target.checked)} />
                      <span>Length / Perimeter</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input type="checkbox" checked={addPerimeter} onChange={e => setAddPerimeter(e.target.checked)} />
                      <span>Perimeter (polygons only)</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input type="checkbox" checked={addX} onChange={e => setAddX(e.target.checked)} />
                      <span>X coordinate</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input type="checkbox" checked={addY} onChange={e => setAddY(e.target.checked)} />
                      <span>Y coordinate</span>
                    </label>
                  </div>
                  <div className="gp-form-hint">
                    Select which geometry-derived attributes to add to each feature.
                  </div>
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
