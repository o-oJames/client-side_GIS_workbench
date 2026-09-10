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
  bufferFeaturesAsync,
  BufferEndCapStyle,
  BufferJoinStyle,
  clipFeaturesAsync,
  intersectFeaturesAsync,
  unionFeatures,
  dissolveFeatures,
  differenceFeaturesAsync,
  symmetricalDifferenceFeatures,
  createProgress,
  type ProgressToken,
  centroidFeatures,
  pointsOnSurface,
  convexHullFeatures,
  eliminateSelectedPolygonsAsync,
  type EliminateResult,
  computeDistancesAsync,
  computeNearestDistances,
  nearestAttributeFeatures,
  toMeters,
  olFeaturesToGeo,
  checkValidity,
  validityErrorPoints,
  collectGeometries,
  delaunayTriangulationAsync,
  densifyByCount,
  addGeometryAttributes,
  extractVertices,
  multipartToSingleparts,
  polygonsToLines,
  polygonizeFeatures,
  simplifyFeatures,
  voronoiPolygonsAsync,
  linesToPolygons,
  makeValid,
  EliminateStrategy,
  mergeVectorLayers,
  splitVectorLayer,
  SplitLayerResult,
  removeSelectedFeatures,
  type BufferLayerOptions,
  type SimplifyMethod,
} from '../utils/geoprocessing';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type ToolId =
  | 'buffer' | 'clip' | 'intersect' | 'union' | 'difference' | 'symDifference' | 'dissolve'
  | 'centroid' | 'pointOnSurface' | 'convexHull' | 'distance' | 'eliminate'
  | 'checkValidity' | 'makeValid' | 'collectGeometries' | 'delaunay' | 'densify'
  | 'addGeometryAttrs' | 'extractVertices' | 'multipartToSingle' | 'polygonsToLines'
  | 'simplify' | 'voronoi' | 'linesToPolygons' | 'polygonize'
  | 'merge' | 'split' | 'removeSelected';

interface ToolDef {
  id: ToolId;
  label: string;
  category: string;
  needsSecondLayer: boolean;
  description: string;
  /**
   * When set, the tool's kernel is known to be approximate and this sentence is
   * shown under the description in the warning colour, so a result is never
   * silently trusted. Every Stage-1 caveat except the two below is now gone: the
   * planar overlay kernel in utils/overlay.ts made Clip, Intersect, Union,
   * Dissolve, Eliminate and Make Valid exact.
   */
  approximate?: string;
  /** Neutral "good to know" line, shown in the ordinary hint style. */
  note?: string;
}

const TESSELLATION_NOTE =
  'Rounded corners and caps are straight-line approximations: the Segments setting is how many pieces '
  + 'a quarter circle is broken into (GEOS uses 8 per quadrant by default, so does this).';

const TOOLS: ToolDef[] = [
  // Geometry Tool
  { id: 'centroid',            label: 'Centroids',                  category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create point features at the area centroid of each input feature.' },
  { id: 'pointOnSurface',      label: 'Point on Surface',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create a point guaranteed to lie inside each feature (GEOS ST_PointOnSurface). Unlike the centroid it never falls outside a concave shape or into a hole.' },
  { id: 'checkValidity',       label: 'Check Validity',             category: 'Geometry Tool',  needsSecondLayer: false, description: 'Check polygon validity against the GEOS/QGIS error classes: self-intersection, hole outside shell, nested holes, disconnected interior, duplicate rings, unclosed rings, too few points, non-finite coordinates, overlapping parts.' },
  { id: 'makeValid',           label: 'Make Valid',                 category: 'Geometry Tool',  needsSecondLayer: false, description: 'Repair invalid geometries without losing any of them: a bowtie becomes a multipart polygon of both lobes, a stray hole becomes its own polygon, rings are closed and re-oriented.' },
  { id: 'collectGeometries',   label: 'Collect Geometries',         category: 'Geometry Tool',  needsSecondLayer: false, description: 'Merge all features into a single multi-geometry feature.' },
  { id: 'delaunay',            label: 'Delaunay Triangulation',     category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create a Delaunay triangulation from input points, as triangles or as edges.', approximate: 'Approximate: the floating-point incircle test is fragile for exactly cocircular or near-duplicate seeds. Set a snapping tolerance for such input.' },
  { id: 'densify',             label: 'Densify by Count',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Add evenly-spaced vertices along each segment.' },
  { id: 'addGeometryAttrs',    label: 'Add Geometry Attributes',    category: 'Geometry Tool',  needsSecondLayer: false, description: 'Add area, length, perimeter, x, y attributes to features.' },
  { id: 'extractVertices',     label: 'Extract Vertices',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Extract all vertices from line/polygon features as points.' },
  { id: 'multipartToSingle',   label: 'Multipart to Singleparts',   category: 'Geometry Tool',  needsSecondLayer: false, description: 'Split multi-geometries into individual single-geometry features.' },
  { id: 'polygonsToLines',     label: 'Polygons to Lines',          category: 'Geometry Tool',  needsSecondLayer: false, description: 'Convert polygon boundaries to line features.' },
  { id: 'simplify',            label: 'Simplify',                   category: 'Geometry Tool',  needsSecondLayer: false, description: 'Simplify geometries with Douglas-Peucker (distance) or Visvalingam-Whyatt (area), optionally refusing any result that would break topology.' },
  { id: 'voronoi',             label: 'Voronoi Polygons',           category: 'Geometry Tool',  needsSecondLayer: false, description: 'Create the Voronoi diagram of the input points.', note: 'Cells are built by half-plane clipping (pruned by distance), which is slower than the Delaunay duality GEOS uses on very large point sets.' },
  { id: 'linesToPolygons',     label: 'Lines to Polygons',          category: 'Geometry Tool',  needsSecondLayer: false, description: 'Convert closed line features to polygons. Open lines are skipped, as in QGIS.' },
  { id: 'polygonize',          label: 'Polygonize',                 category: 'Geometry Tool',  needsSecondLayer: false, description: 'Build every polygon a line network encloses (GEOS ST_Polygonize). Lines are noded against each other first, so separate arcs, T-junctions and dangles all behave.' },
  // Geoprocessing Tool
  { id: 'buffer',              label: 'Buffer',                     category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Create polygons around features at a specified distance, in ground metres.', note: TESSELLATION_NOTE + ' Where an offset curve would cross itself the buffer is rebuilt as a union of per-segment pieces (the GEOS decomposition), so the result is always valid and never double-counts its own overlaps.' },
  { id: 'clip',                label: 'Clip',                       category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Clip input features using a polygon layer as the cookie cutter. Points, lines and polygons are all clipped, and holes in the clip layer are subtracted.' },
  { id: 'intersect',           label: 'Intersect',                  category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Keep only the overlapping parts of two layers, with both attribute tables. Colliding field names are suffixed _2 instead of being overwritten.' },
  { id: 'union',               label: 'Union',                      category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Full overlay of two layers: the intersection with both attribute tables, plus each layer\'s exclusive parts with its own attributes and nulls for the other\'s fields.' },
  { id: 'difference',          label: 'Difference',                 category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Cut the overlay layer out of the input layer (QGIS Difference / ST_Difference). Attributes come from the input layer.' },
  { id: 'symDifference',       label: 'Symmetrical Difference',     category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Keep the parts of either layer the other does not cover, dropping the overlap (ST_SymDifference). Each feature is tagged with its source_layer.' },
  { id: 'dissolve',            label: 'Dissolve',                   category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Merge features into one, optionally grouped by field value, with shared boundaries removed exactly.' },
  { id: 'convexHull',          label: 'Convex Hull',                category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Create the smallest convex polygon enclosing the input — one hull per feature (QGIS), or one for the whole layer.' },
  { id: 'distance',            label: 'Distance',                   category: 'Geoprocessing Tool', needsSecondLayer: true,  description: 'Measure distances between two layers: the nearest (or k nearest) features of one layer for every feature of the other, or every pair.' },
  { id: 'eliminate',           label: 'Eliminate selected polygons', category: 'Geoprocessing Tool', needsSecondLayer: false, description: 'Dissolve selected polygons into an adjacent neighbour by removing their shared boundary.', note: 'A selected polygon with no neighbour at all cannot be absorbed; it is removed and you are told how many.' },
  // Manage Layers
  { id: 'merge',               label: 'Merge Vector Layers',        category: 'Manage Layers', needsSecondLayer: false, description: 'Combine features from multiple layers into a single layer with unified schema.' },
  { id: 'split',               label: 'Split Vector Layer',         category: 'Manage Layers', needsSecondLayer: false, description: 'Split a layer into multiple layers based on unique values of a chosen field.' },
  { id: 'removeSelected',      label: 'Remove selected features',   category: 'Manage Layers', needsSecondLayer: false, description: 'Create a new layer with selected features removed from the input layer.' },
];

const CATEGORIES = ['Geometry Tool', 'Geoprocessing Tool', 'Manage Layers'];

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
  const [bufferSegments, setBufferSegments] = useState('8');
  const [bufferEndCap, setBufferEndCap] = useState<BufferEndCapStyle>('round');
  const [bufferJoin, setBufferJoin] = useState<BufferJoinStyle>('round');
  const [bufferMiterLimit, setBufferMiterLimit] = useState('5');
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>('meters');
  const [distanceMode, setDistanceMode] = useState<'nearest' | 'kNearest' | 'all'>('nearest');
  const [nearestK, setNearestK] = useState('5');
  const [distanceAsLines, setDistanceAsLines] = useState(false);
  const [dissolveOverlap, setDissolveOverlap] = useState(true);
  const [dissolveFields, setDissolveFields] = useState<string[]>([]);
  const [keepDisjoint, setKeepDisjoint] = useState(false);
  const [collectFields, setCollectFields] = useState<string[]>([]);
  const [hullWholeLayer, setHullWholeLayer] = useState(false);
  // Buffer layer options
  const [bufferDissolve, setBufferDissolve] = useState(false);
  const [bufferSeparateParts, setBufferSeparateParts] = useState(false);
  const [bufferDistanceField, setBufferDistanceField] = useState('');
  const [bufferSingleSided, setBufferSingleSided] = useState(false);
  // Geometry tool options
  const [simplifyMethod, setSimplifyMethod] = useState<SimplifyMethod>('distance');
  const [simplifyPreserve, setSimplifyPreserve] = useState(true);
  const [simplifyGroundUnits, setSimplifyGroundUnits] = useState(false);
  const [verticesSkipClosing, setVerticesSkipClosing] = useState(false);
  const [polygonsPerRing, setPolygonsPerRing] = useState(false);
  const [linesClosureTolerance, setLinesClosureTolerance] = useState('');
  const [delaunayTolerance, setDelaunayTolerance] = useState('0');
  const [delaunayEdges, setDelaunayEdges] = useState(false);
  const [voronoiPadPercent, setVoronoiPadPercent] = useState('50');
  const [voronoiCopyAttrs, setVoronoiCopyAttrs] = useState(true);
  const [attrsXYDegrees, setAttrsXYDegrees] = useState(true);
  const [attrsVertexCount, setAttrsVertexCount] = useState(false);
  const [validityErrorLayer, setValidityErrorLayer] = useState(true);
  // New geometry tool state
  const [densifyCount, setDensifyCount] = useState('3');
  const [simplifyTolerance, setSimplifyTolerance] = useState('10');
  const [addArea, setAddArea] = useState(true);
  const [addLength, setAddLength] = useState(true);
  const [addPerimeter, setAddPerimeter] = useState(false);
  const [addX, setAddX] = useState(false);
  const [addY, setAddY] = useState(false);
  // Merge/Split state
  const [mergeLayerIds, setMergeLayerIds] = useState<Set<string>>(new Set());
  const [splitFieldName, setSplitFieldName] = useState('');
  // C4: Merge geometry-type harmonisation option
  const [mergeHarmonise, setMergeHarmonise] = useState<'dominant' | 'multi' | false>(false);
  // Selection state for eliminate tool
  const [selectingMode, setSelectingMode] = useState(false);
  const [selectedOlFeatures, setSelectedOlFeatures] = useState<any[]>([]);
  const selectedOlFeaturesRef = useRef<any[]>([]);
  selectedOlFeaturesRef.current = selectedOlFeatures;
  const clickHandlerRef = useRef<((e: any) => void) | null>(null);
  const [eliminateStrategy, setEliminateStrategy] = useState<EliminateStrategy>('largestArea');
  // Selection state for remove selected features tool
  const [removeSelectingMode, setRemoveSelectingMode] = useState(false);
  const [removeSelectedOlFeatures, setRemoveSelectedOlFeatures] = useState<any[]>([]);
  const removeSelectedOlFeaturesRef = useRef<any[]>([]);
  removeSelectedOlFeaturesRef.current = removeSelectedOlFeatures;
  const removeClickHandlerRef = useRef<((e: any) => void) | null>(null);
  const removeHighlightLayerRef = useRef<any>(null);
  // C3: Eliminate highlight layer (same style as remove-selected)
  const eliminateHighlightLayerRef = useRef<any>(null);

  // Auto-select first layer when layers change
  useEffect(() => {
    if (usableLayers.length > 0 && !usableLayers.find(l => l.id === inputLayerId)) {
      setInputLayerId(usableLayers[0].id);
    }
  }, [usableLayers, inputLayerId]);

  /**
   * Keep the overlay layer a DIFFERENT layer from the input.
   *
   * This used to only check that the id still existed. On first mount the input
   * id is still '' when this runs, so the fallback picked the very first layer —
   * and once the input layer settled on that same layer nothing re-picked it.
   * Clip/Intersect/Union/Difference then silently ran a layer against itself
   * (Difference returning nothing at all), while the select — which filters the
   * input layer out of its options — showed a placeholder.
   */
  useEffect(() => {
    if (usableLayers.length < 2) return;
    if (usableLayers.some(l => l.id === secondLayerId && l.id !== inputLayerId)) return;
    const fallback = usableLayers.find(l => l.id !== inputLayerId) ?? usableLayers[0];
    setSecondLayerId(fallback.id);
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
    setRemoveSelectedOlFeatures([]);
    setRemoveSelectingMode(false);
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

  // Selection click handler for remove selected features tool
  useEffect(() => {
    if (!removeSelectingMode || !map) return;
    
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
        setRemoveSelectedOlFeatures(prev => {
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
    removeClickHandlerRef.current = handler;
    
    return () => {
      map.un('click', handler);
      removeClickHandlerRef.current = null;
    };
  }, [removeSelectingMode, map, inputLayerId, getOlLayer]);

  // Manage highlight layer for remove selection
  useEffect(() => {
    if (!map) return;
    
    // Only create/manage highlight layer when in remove selection mode
    if (!removeSelectingMode) {
      // Clean up highlight layer when exiting selection mode
      if (removeHighlightLayerRef.current) {
        map.removeLayer(removeHighlightLayerRef.current);
        removeHighlightLayerRef.current = null;
      }
      return;
    }
    
    // Create highlight layer if it doesn't exist
    if (!removeHighlightLayerRef.current) {
      // Dynamic import to avoid breaking SSR
      import('ol/layer/Vector.js').then(({ default: VectorLayer }) => {
        import('ol/source/Vector.js').then(({ default: VectorSource }) => {
          import('ol/style/Style.js').then(({ default: Style }) => {
            import('ol/style/Stroke.js').then(({ default: Stroke }) => {
              import('ol/style/Fill.js').then(({ default: Fill }) => {
                const highlightSource = new VectorSource();
                const highlightLayer = new VectorLayer({
                  source: highlightSource,
                  style: new Style({
                    stroke: new Stroke({
                      color: '#ff0000',
                      width: 3,
                    }),
                    fill: new Fill({
                      color: 'rgba(255, 0, 0, 0.2)',
                    }),
                  }),
                  zIndex: 999,
                });
                removeHighlightLayerRef.current = highlightLayer;
                map.addLayer(highlightLayer);
                // Update features after layer is added
                if (removeSelectedOlFeatures.length > 0) {
                  highlightSource.addFeatures(removeSelectedOlFeatures);
                }
              });
            });
          });
        });
      });
    } else {
      // Update highlight layer features
      const highlightLayer = removeHighlightLayerRef.current;
      const source = highlightLayer.getSource();
      if (source) {
        source.clear();
        if (removeSelectedOlFeatures.length > 0) {
          source.addFeatures(removeSelectedOlFeatures);
        }
      }
    }
    
    // Cleanup when component unmounts or dependencies change
    return () => {
      // Don't remove layer here - let the main effect handle it
      // This cleanup runs on every re-render, so we only clear features
      if (removeHighlightLayerRef.current) {
        const source = removeHighlightLayerRef.current.getSource();
        if (source) source.clear();
      }
    };
  }, [map, removeSelectingMode, removeSelectedOlFeatures]);

  // C3: Manage highlight layer for eliminate selection
  useEffect(() => {
    if (!map) return;
    
    // Only create/manage highlight layer when in eliminate selection mode
    if (!selectingMode) {
      // Clean up highlight layer when exiting selection mode
      if (eliminateHighlightLayerRef.current) {
        map.removeLayer(eliminateHighlightLayerRef.current);
        eliminateHighlightLayerRef.current = null;
      }
      return;
    }
    
    // Create highlight layer if it doesn't exist
    if (!eliminateHighlightLayerRef.current) {
      // Dynamic import to avoid breaking SSR
      import('ol/layer/Vector.js').then(({ default: VectorLayer }) => {
        import('ol/source/Vector.js').then(({ default: VectorSource }) => {
          import('ol/style/Style.js').then(({ default: Style }) => {
            import('ol/style/Stroke.js').then(({ default: Stroke }) => {
              import('ol/style/Fill.js').then(({ default: Fill }) => {
                const highlightSource = new VectorSource();
                const highlightLayer = new VectorLayer({
                  source: highlightSource,
                  style: new Style({
                    stroke: new Stroke({
                      color: '#ff0000',
                      width: 3,
                    }),
                    fill: new Fill({
                      color: 'rgba(255, 0, 0, 0.2)',
                    }),
                  }),
                  zIndex: 999,
                });
                eliminateHighlightLayerRef.current = highlightLayer;
                map.addLayer(highlightLayer);
                // Update features after layer is added
                if (selectedOlFeatures.length > 0) {
                  highlightSource.addFeatures(selectedOlFeatures);
                }
              });
            });
          });
        });
      });
    } else {
      // Update highlight layer features
      const highlightLayer = eliminateHighlightLayerRef.current;
      const source = highlightLayer.getSource();
      if (source) {
        source.clear();
        if (selectedOlFeatures.length > 0) {
          source.addFeatures(selectedOlFeatures);
        }
      }
    }
    
    // Cleanup when component unmounts or dependencies change
    return () => {
      // Don't remove layer here - let the main effect handle it
      // This cleanup runs on every re-render, so we only clear features
      if (eliminateHighlightLayerRef.current) {
        const source = eliminateHighlightLayerRef.current.getSource();
        if (source) source.clear();
      }
    };
  }, [map, selectingMode, selectedOlFeatures]);

  // Clean up highlight layer when switching tools or unmounting
  useEffect(() => {
    return () => {
      if (removeHighlightLayerRef.current && map) {
        map.removeLayer(removeHighlightLayerRef.current);
        removeHighlightLayerRef.current = null;
      }
      // C3: Also clean up eliminate highlight layer
      if (eliminateHighlightLayerRef.current && map) {
        map.removeLayer(eliminateHighlightLayerRef.current);
        eliminateHighlightLayerRef.current = null;
      }
    };
  }, [map, selectedTool]);

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
  /** Progress + cancellation for whichever chunked tool is running. */
  const [toolProgress, setToolProgress] = useState<ProgressToken | null>(null);
  /**
   * The live token handed to the engine. The engine reads `cancelled` off this
   * very object, so the Cancel button really does abort the run — the previous
   * dissolve-only wiring mutated a separate object the engine never saw.
   */
  const progressTokenRef = useRef<ProgressToken | null>(null);

  const beginProgress = useCallback((message: string): ProgressToken => {
    const token = createProgress(message);
    progressTokenRef.current = token;
    setToolProgress({ ...token });
    return token;
  }, []);

  const reportProgress = useCallback((p: ProgressToken) => setToolProgress({ ...p }), []);

  const endProgress = useCallback(() => {
    progressTokenRef.current = null;
    setToolProgress(null);
  }, []);

  const extractFeatures = useCallback((layerId: string): GeoFeature[] => {
    const olLayer = getOlLayer(layerId);
    if (!olLayer) return [];
    const source = olLayer._rawSource || (olLayer.getSource && olLayer.getSource());
    if (!source || typeof source.getFeatures !== 'function') return [];
    return olFeaturesToGeo(source.getFeatures());
  }, [getOlLayer]);

  // Extract field names from input layer (for Split tool)
  const inputFieldNames = useMemo(() => {
    if (!inputLayerId) return [];
    const feats = extractFeatures(inputLayerId);
    const names = new Set<string>();
    for (const f of feats) {
      if (f.properties) {
        for (const key of Object.keys(f.properties)) {
          names.add(key);
        }
      }
    }
    return Array.from(names).sort();
  }, [inputLayerId, extractFeatures]);

  // Auto-select all layers when Merge tool is chosen
  useEffect(() => {
    if (selectedTool === 'merge' && mergeLayerIds.size === 0 && usableLayers.length > 0) {
      setMergeLayerIds(new Set(usableLayers.map(l => l.id)));
    }
  }, [selectedTool]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRun = useCallback(() => {
    setError(null);
    const inputFeatures = extractFeatures(inputLayerId);
    if (inputFeatures.length === 0) {
      setError('Input layer has no features.');
      return;
    }
    // Two-layer tools must never be pointed at the input layer itself.
    if (toolDef.needsSecondLayer && (!secondLayerId || secondLayerId === inputLayerId)) {
      setError('Choose a second layer that is not the input layer.');
      return;
    }

    setRunning(true);
    // Use setTimeout to allow the UI to update with spinner
    setTimeout(async () => {
      try {
        let resultFeatures: GeoFeature[] = [];

        switch (selectedTool) {
          case 'buffer': {
            const d = parseFloat(bufferDistance);
            if (isNaN(d) || d === 0) {
              setError('Buffer distance must be a non-zero number.');
              setRunning(false);
              return;
            }
            const meters = toMeters(d, bufferUnit);
            const bufOpts: BufferLayerOptions = {
              segments: Math.max(1, parseInt(bufferSegments, 10) || 8),
              endCapStyle: bufferEndCap,
              joinStyle: bufferJoin,
              miterLimit: Math.max(1, parseFloat(bufferMiterLimit) || 5),
              dissolveResult: bufferDissolve,
              separateDisjointParts: bufferSeparateParts,
              distanceField: bufferDistanceField || undefined,
              singleSided: bufferSingleSided,
            };
            const token = beginProgress('Buffering…');
            try {
              resultFeatures = await bufferFeaturesAsync(inputFeatures, meters, bufOpts, token, reportProgress);
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Buffer cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'clip': {
            const clipFeats = extractFeatures(secondLayerId);
            if (clipFeats.length === 0) {
              setError('Clip layer has no features.');
              setRunning(false);
              return;
            }
            const token = beginProgress('Clipping…');
            try {
              resultFeatures = await clipFeaturesAsync(inputFeatures, clipFeats, token, reportProgress);
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Clip cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'intersect': {
            const layerB = extractFeatures(secondLayerId);
            if (layerB.length === 0) {
              setError('Second layer has no features.');
              setRunning(false);
              return;
            }
            const token = beginProgress('Intersecting…');
            try {
              resultFeatures = await intersectFeaturesAsync(inputFeatures, layerB, token, reportProgress);
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Intersect cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'union': {
            const layerB = extractFeatures(secondLayerId);
            const token = beginProgress('Unioning…');
            try {
              resultFeatures = await unionFeatures(inputFeatures, layerB, {
                progress: token,
                onProgress: reportProgress,
              });
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Union cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'dissolve': {
            // Async + chunked so large datasets never freeze the UI. Work is split
            // by connected component, which is also what Cancel interrupts.
            const token = beginProgress('Starting…');
            try {
              resultFeatures = await dissolveFeatures(inputFeatures, {
                fields: dissolveFields,
                keepDisjoint,
                dissolveOverlap,
                progress: token,
                onProgress: reportProgress,
              });
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Dissolve cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'difference': {
            const layerB = extractFeatures(secondLayerId);
            if (layerB.length === 0) {
              setError('Overlay layer has no features.');
              setRunning(false);
              return;
            }
            const token = beginProgress('Computing difference…');
            try {
              resultFeatures = await differenceFeaturesAsync(inputFeatures, layerB, token, reportProgress);
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Difference cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'symDifference': {
            const layerB = extractFeatures(secondLayerId);
            if (layerB.length === 0) {
              setError('Overlay layer has no features.');
              setRunning(false);
              return;
            }
            const token = beginProgress('Computing symmetrical difference…');
            try {
              resultFeatures = await symmetricalDifferenceFeatures(inputFeatures, layerB, {
                progress: token,
                onProgress: reportProgress,
              });
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Symmetrical difference cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'centroid': {
            resultFeatures = centroidFeatures(inputFeatures);
            break;
          }
          case 'pointOnSurface': {
            resultFeatures = pointsOnSurface(inputFeatures);
            break;
          }
          case 'convexHull': {
            resultFeatures = convexHullFeatures(inputFeatures, { wholeLayer: hullWholeLayer });
            break;
          }
          case 'distance': {
            const layerB = extractFeatures(secondLayerId);
            if (layerB.length === 0) {
              setError('Second layer has no features.');
              setRunning(false);
              return;
            }
            const token = beginProgress('Measuring distances…');
            try {
              if (distanceMode === 'all') {
                const pairs = await computeDistancesAsync(inputFeatures, layerB, distanceUnit, token, reportProgress);
                if (token.cancelled) throw new Error('cancelled');
                // One connector line per pair, drawn between the two *closest*
                // points rather than the vertex-average centres.
                const lines: GeoFeature[] = [];
                for (const dr of pairs) {
                  const fA = inputFeatures[dr.featureA_index];
                  const fB = layerB[dr.featureB_index];
                  if (!fA?.geometry || !fB?.geometry) continue;
                  // Overlapping pairs have no distinct closest points (distance 0),
                  // so fall back to their centres to keep the connector visible.
                  const cA = dr.overlapping ? getGeomCenter(fA.geometry) : dr.closest_on_a;
                  const cB = dr.overlapping ? getGeomCenter(fB.geometry) : dr.closest_on_b;
                  lines.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [cA, cB] },
                    properties: {
                      distance: Math.round(dr.distance_display * 1000) / 1000,
                      unit: dr.unit,
                      from_feature: dr.featureA_index + 1,
                      to_feature: dr.featureB_index + 1,
                      overlapping: dr.overlapping,
                    },
                  });
                }
                resultFeatures = lines;
              } else {
                const k = distanceMode === 'kNearest' ? Math.max(1, parseInt(nearestK, 10) || 1) : 1;
                const nearest = await computeNearestDistances(
                  inputFeatures, layerB, distanceUnit, k, token, reportProgress);
                if (token.cancelled) throw new Error('cancelled');
                const hubLines: GeoFeature[] = nearest.map(dr => ({
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [dr.closest_on_a, dr.overlapping ? dr.closest_on_a : dr.closest_on_b],
                  },
                  properties: {
                    nearest_rank: dr.rank,
                    from_feature: dr.featureA_index + 1,
                    to_feature: dr.featureB_index + 1,
                    distance: Math.round(dr.distance_display * 1000) / 1000,
                    unit: dr.unit,
                  },
                }));
                resultFeatures = distanceAsLines
                  ? hubLines
                  // QGIS "Join attributes by nearest": the input features come back
                  // carrying nearest_id / nearest_distance / nearest_x / nearest_y.
                  : nearestAttributeFeatures(inputFeatures, nearest);
              }
            } catch (err: any) {
              endProgress();
              if (err?.message === 'cancelled') {
                setError('Distance cancelled.');
              } else {
                throw err;
              }
              setRunning(false);
              return;
            }
            endProgress();
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
            const token = beginProgress('Eliminating…');
            let eliminateResult: EliminateResult;
            try {
              eliminateResult = await eliminateSelectedPolygonsAsync(
                inputFeatures, selectedIndices, eliminateStrategy, token, reportProgress);
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Eliminate cancelled.');
              setRunning(false);
              return;
            }
            // Never let area vanish without saying so.
            if (eliminateResult.droppedIndices.length > 0) {
              showToast(
                `${eliminateResult.droppedIndices.length} selected polygon(s) had no mergeable neighbour and were removed`,
                'error'
              );
            }
            resultFeatures = eliminateResult.features;
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
                validity_error_count: vr.errors.length,
                feature_index: idx + 1,
              },
            }));
            // QGIS emits a third output: the error locations themselves.
            if (validityErrorLayer) {
              const points = validityErrorPoints(validityResults);
              if (points.length > 0) {
                const baseName = outputName.trim() || toolDef.label;
                onAddResultLayer(
                  JSON.stringify({ type: 'FeatureCollection', features: points }),
                  `${baseName} — error points`
                );
                showToast(`${points.length} validity error location(s) added as a point layer`, 'success');
              }
            }
            break;
          }
          case 'makeValid': {
            resultFeatures = makeValid(inputFeatures);
            break;
          }
          case 'collectGeometries': {
            resultFeatures = collectGeometries(inputFeatures, { fields: collectFields });
            break;
          }
          case 'polygonize': {
            resultFeatures = polygonizeFeatures(inputFeatures);
            break;
          }
          case 'delaunay': {
            const token = beginProgress('Triangulating…');
            try {
              resultFeatures = await delaunayTriangulationAsync(inputFeatures, {
                tolerance: Math.max(0, parseFloat(delaunayTolerance) || 0),
                outputEdges: delaunayEdges,
                progress: token,
                onProgress: reportProgress,
              });
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Delaunay cancelled.');
              setRunning(false);
              return;
            }
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
              xyInDegrees: attrsXYDegrees,
              addVertexCount: attrsVertexCount,
            });
            break;
          }
          case 'extractVertices': {
            resultFeatures = extractVertices(inputFeatures, { skipClosingVertex: verticesSkipClosing });
            break;
          }
          case 'multipartToSingle': {
            resultFeatures = multipartToSingleparts(inputFeatures);
            break;
          }
          case 'polygonsToLines': {
            resultFeatures = polygonsToLines(inputFeatures, { perRing: polygonsPerRing });
            break;
          }
          case 'simplify': {
            const tolerance = parseFloat(simplifyTolerance);
            if (isNaN(tolerance) || tolerance <= 0) {
              setError('Simplify tolerance must be a positive number.');
              setRunning(false);
              return;
            }
            resultFeatures = simplifyFeatures(inputFeatures, tolerance, {
              method: simplifyMethod,
              preserveTopology: simplifyPreserve,
              groundUnits: simplifyGroundUnits,
            });
            break;
          }
          case 'voronoi': {
            const token = beginProgress('Building Voronoi cells…');
            try {
              resultFeatures = await voronoiPolygonsAsync(inputFeatures, {
                padFraction: Math.max(0, (parseFloat(voronoiPadPercent) || 50) / 100),
                copyAttributes: voronoiCopyAttrs,
              }, token, reportProgress);
            } finally {
              endProgress();
            }
            if (token.cancelled) {
              setError('Voronoi cancelled.');
              setRunning(false);
              return;
            }
            break;
          }
          case 'linesToPolygons': {
            const parsed = parseFloat(linesClosureTolerance);
            resultFeatures = linesToPolygons(
              inputFeatures,
              Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
            );
            break;
          }
          case 'merge': {
            if (mergeLayerIds.size === 0) {
              setError('Select at least one layer to merge.');
              setRunning(false);
              return;
            }
            const allLayerFeatures: GeoFeature[][] = [];
            for (const lid of Array.from(mergeLayerIds)) {
              allLayerFeatures.push(extractFeatures(lid));
            }
            resultFeatures = mergeVectorLayers(allLayerFeatures);
            break;
          }
          case 'split': {
            if (!splitFieldName) {
              setError('Select a field to split by.');
              setRunning(false);
              return;
            }
            const splitResults = splitVectorLayer(inputFeatures, splitFieldName);
            if (splitResults.length === 0) {
              setError('No features to split.');
              setRunning(false);
              return;
            }
            // Add each split group as a separate layer
            const baseName = outputName.trim() || toolDef.label;
            for (const sr of splitResults) {
              const geoJsonStr = JSON.stringify({
                type: 'FeatureCollection',
                features: sr.features,
              });
              const layerName = splitResults.length > 1
                ? `${baseName} - ${sr.name}`
                : baseName;
              onAddResultLayer(geoJsonStr, layerName);
            }
            showToast(`"${baseName}" split into ${splitResults.length} layer${splitResults.length !== 1 ? 's' : ''}`, 'success');
            setRunning(false);
            return; // skip the normal single-layer output path
          }
          case 'removeSelected': {
            if (removeSelectedOlFeatures.length === 0) {
              setError('No features selected. Use "Select on map" to pick features to remove.');
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
            for (const sel of removeSelectedOlFeatures) {
              const idx = allOlFeatures.indexOf(sel);
              if (idx >= 0) selectedIndices.add(idx);
            }
            if (selectedIndices.size === 0) {
              setError('Selected features not found in the input layer.');
              setRunning(false);
              return;
            }
            resultFeatures = removeSelectedFeatures(inputFeatures, selectedIndices);
            // Clean up selection after successful run
            setRemoveSelectingMode(false);
            setRemoveSelectedOlFeatures([]);
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
  }, [
    selectedTool, inputLayerId, secondLayerId, bufferDistance, bufferUnit, bufferSegments,
    bufferEndCap, bufferJoin, bufferMiterLimit, bufferDissolve, bufferSeparateParts, bufferDistanceField,
    bufferSingleSided,
    distanceUnit, distanceMode, nearestK, distanceAsLines, dissolveOverlap, dissolveFields, keepDisjoint,
    collectFields, hullWholeLayer, simplifyMethod, simplifyPreserve, simplifyGroundUnits,
    verticesSkipClosing, polygonsPerRing, linesClosureTolerance, delaunayTolerance, delaunayEdges,
    voronoiPadPercent, voronoiCopyAttrs, attrsXYDegrees, attrsVertexCount, validityErrorLayer,
    outputName, extractFeatures, onAddResultLayer, showToast, toolDef, selectedOlFeatures, getOlLayer,
    densifyCount, simplifyTolerance, addArea, addLength, addPerimeter, addX, addY, mergeLayerIds,
    splitFieldName, eliminateStrategy, removeSelectedOlFeatures, beginProgress, reportProgress, endProgress, mergeHarmonise,
  ]);

  // ----- render helpers ----------------------------------------------------
  const inputLayerName = usableLayers.find(l => l.id === inputLayerId)?.name || '';

  /**
   * Multi-select over the input layer's field names, reusing the Merge tool's
   * checkbox-list pattern (`.gp-merge-layers`) so Dissolve and Collect look like
   * the rest of the panel.
   */
  const fieldPicker = (
    label: string,
    selected: string[],
    setSelected: (next: string[]) => void,
    hint: string
  ) => (
    <div className="gp-form-row">
      <label className="gp-form-label">{label}</label>
      <div className="gp-merge-layers">
        {inputFieldNames.map(name => (
          <label key={name} className="gp-form-checkbox gp-merge-layer-item">
            <input
              type="checkbox"
              checked={selected.includes(name)}
              onChange={e => setSelected(e.target.checked
                ? [...selected, name]
                : selected.filter(n => n !== name))}
            />
            <span>{name}</span>
          </label>
        ))}
      </div>
      <div className="gp-form-hint">{hint}</div>
    </div>
  );

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
              {toolDef.approximate && (
                <div className="gp-form-hint gp-form-hint--warning">{toolDef.approximate}</div>
              )}
              {toolDef.note && (
                <div className="gp-form-hint">{toolDef.note}</div>
              )}

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
                  <div className="gp-form-hint">
                    Use negative distance to shrink (inset) polygon geometries.
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-label">Segments</label>
                    <input
                      type="number"
                      className="gp-form-input"
                      value={bufferSegments}
                      onChange={e => setBufferSegments(e.target.value)}
                      min="1"
                      step="1"
                      placeholder="Segments per quarter circle"
                    />
                    <div className="gp-form-hint">
                      Number of line segments used to approximate a quarter circle for rounded offsets.
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-label">End cap style</label>
                    <CustomSelect
                      value={bufferEndCap}
                      onChange={v => setBufferEndCap(v as BufferEndCapStyle)}
                      options={[
                        { value: 'round', label: 'Round' },
                        { value: 'flat', label: 'Flat' },
                        { value: 'square', label: 'Square' },
                      ]}
                      className="settings-select"
                    />
                    <div className="gp-form-hint">
                      Controls how line endings are handled in the buffer.
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-label">Join style</label>
                    <CustomSelect
                      value={bufferJoin}
                      onChange={v => setBufferJoin(v as BufferJoinStyle)}
                      options={[
                        { value: 'round', label: 'Round' },
                        { value: 'miter', label: 'Miter' },
                        { value: 'bevel', label: 'Bevel' },
                      ]}
                      className="settings-select"
                    />
                    <div className="gp-form-hint">
                      Specifies how corners are handled when offsetting corners in a line or polygon.
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-label">Distance from field</label>
                    <CustomSelect
                      value={bufferDistanceField}
                      onChange={setBufferDistanceField}
                      options={[
                        { value: '', label: 'Use the distance above for every feature' },
                        ...inputFieldNames.map(n => ({ value: n, label: n })),
                      ]}
                      className="settings-select"
                    />
                    <div className="gp-form-hint">
                      Data-defined buffer distance: the field is read as ground metres per feature.
                      Features with a missing or non-numeric value fall back to the distance above.
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={bufferDissolve}
                        onChange={e => setBufferDissolve(e.target.checked)}
                      />
                      <span>Dissolve result</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={bufferSeparateParts}
                        onChange={e => setBufferSeparateParts(e.target.checked)}
                      />
                      <span>Separate disjoint parts into separate features</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={bufferSingleSided}
                        onChange={e => setBufferSingleSided(e.target.checked)}
                      />
                      <span>Single-sided (lines only)</span>
                    </label>
                    <div className="gp-form-hint">
                      Dissolving merges overlapping buffers into one feature and drops the attributes;
                      separating parts then splits any multipart result back into single-part features.
                      Single-sided offsets lines to the LEFT of their direction of travel, or to the
                      right for a negative distance, with flat ends — GEOS's single-sided buffer.
                      Points and polygons ignore it.
                    </div>
                  </div>
                  {bufferJoin === 'miter' && (
                    <div className="gp-form-row">
                      <label className="gp-form-label">Miter limit</label>
                      <input
                        type="number"
                        className="gp-form-input"
                        value={bufferMiterLimit}
                        onChange={e => setBufferMiterLimit(e.target.value)}
                        min="1"
                        step="any"
                        placeholder="Miter limit"
                      />
                      <div className="gp-form-hint">
                        Maximum ratio of miter length to buffer distance. When the miter exceeds this limit, a bevel join is used instead.
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Distance options */}
              {selectedTool === 'distance' && (
                <>
                  <div className="gp-form-row">
                    <label className="gp-form-label">What to measure</label>
                    <CustomSelect
                      value={distanceMode}
                      onChange={v => setDistanceMode(v as typeof distanceMode)}
                      options={[
                        { value: 'nearest', label: 'Nearest feature of the second layer' },
                        { value: 'kNearest', label: 'K nearest features of the second layer' },
                        { value: 'all', label: 'Every pair (input × second layer)' },
                      ]}
                      className="settings-select"
                    />
                    <div className="gp-form-hint">
                      {distanceMode === 'all'
                        ? 'One connector line per pair. For anything but small layers this is a lot of output.'
                        : 'Candidates come from an R-tree and are visited nearest-first, so the exact distance is only computed until the k-th best is provably nearer than anything left.'}
                    </div>
                  </div>
                  {distanceMode === 'kNearest' && (
                    <div className="gp-form-row">
                      <label className="gp-form-label">K</label>
                      <input
                        type="number"
                        className="gp-form-input"
                        value={nearestK}
                        onChange={e => setNearestK(e.target.value)}
                        min="1"
                        step="1"
                      />
                      <div className="gp-form-hint">How many of the nearest features to report per input feature.</div>
                    </div>
                  )}
                  {distanceMode !== 'all' && (
                    <div className="gp-form-row">
                      <label className="gp-form-label">Output</label>
                      <CustomSelect
                        value={distanceAsLines ? 'lines' : 'attributes'}
                        onChange={v => setDistanceAsLines(v === 'lines')}
                        options={[
                          { value: 'attributes', label: 'Input features with nearest attributes' },
                          { value: 'lines', label: 'Connector lines to the nearest features' },
                        ]}
                        className="settings-select"
                      />
                      <div className="gp-form-hint">
                        Attributes mode copies the input features and adds nearest_rank, nearest_id,
                        nearest_distance, nearest_x and nearest_y — QGIS "Join attributes by nearest".
                      </div>
                    </div>
                  )}
                  <div className="gp-form-row">
                    <label className="gp-form-label">Output units</label>
                    <CustomSelect
                      value={distanceUnit}
                      onChange={v => setDistanceUnit(v as DistanceUnit)}
                      options={DISTANCE_UNITS.map(u => ({ value: u.value, label: u.label }))}
                      className="settings-select"
                    />
                  </div>
                </>
              )}

              {/* Dissolve options */}
              {selectedTool === 'dissolve' && (
                <>
                  {inputFieldNames.length > 0 && fieldPicker(
                    'Dissolve field(s)',
                    dissolveFields,
                    setDissolveFields,
                    dissolveFields.length === 0
                      ? 'No field selected: the whole layer dissolves into one feature.'
                      : 'Features sharing these values dissolve together, and only these fields are kept on the output.'
                  )}
                  <div className="gp-form-row">
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={dissolveOverlap}
                        onChange={e => setDissolveOverlap(e.target.checked)}
                      />
                      <span>Merge overlapping geometries</span>
                    </label>
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={keepDisjoint}
                        onChange={e => setKeepDisjoint(e.target.checked)}
                      />
                      <span>Keep disjoint features separate</span>
                    </label>
                    <div className="gp-form-hint">
                      With "merge" off the geometries are only collected into a multipart feature and
                      their shared boundaries are kept.
                    </div>
                  </div>
                </>
              )}

              {/* Collect geometries grouping */}
              {selectedTool === 'collectGeometries' && inputFieldNames.length > 0 && fieldPicker(
                'Group by field(s)',
                collectFields,
                setCollectFields,
                collectFields.length === 0
                  ? 'No field selected: every feature is collected into one multi-geometry.'
                  : 'One collected feature per distinct combination of these values, which are kept as attributes.'
              )}

              {/* Convex hull mode */}
              {selectedTool === 'convexHull' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Hull of</label>
                  <CustomSelect
                    value={hullWholeLayer ? 'layer' : 'feature'}
                    onChange={v => setHullWholeLayer(v === 'layer')}
                    options={[
                      { value: 'feature', label: 'Each feature (QGIS default)' },
                      { value: 'layer', label: 'The whole layer' },
                    ]}
                    className="settings-select"
                  />
                  <div className="gp-form-hint">
                    Per-feature hulls keep the input attributes; a whole-layer hull has none.
                  </div>
                </div>
              )}

              {/* Check validity output */}
              {selectedTool === 'checkValidity' && (
                <div className="gp-form-row">
                  <label className="gp-form-checkbox">
                    <input
                      type="checkbox"
                      checked={validityErrorLayer}
                      onChange={e => setValidityErrorLayer(e.target.checked)}
                    />
                    <span>Also add an error-point layer</span>
                  </label>
                  <div className="gp-form-hint">
                    Every feature gets valid / validity_reason / validity_error_count attributes, and each
                    located error is also written to a separate point layer, as QGIS's Check validity does.
                  </div>
                </div>
              )}

              {/* Progress + cancel — shared by every chunked tool */}
              {toolProgress && (
                <div className="gp-form-row">
                  <div className="gp-progress">
                    <div className="gp-progress-bar">
                      <div
                        className="gp-progress-fill"
                        style={{ width: `${Math.round(toolProgress.progress * 100)}%` }}
                      />
                    </div>
                    <div className="gp-progress-text">
                      <span>{toolProgress.message}</span>
                      <button
                        type="button"
                        className="gp-progress-cancel-btn"
                        onClick={() => {
                          if (progressTokenRef.current) {
                            progressTokenRef.current.cancelled = true;
                          }
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
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

              {/* Eliminate strategy selector */}
              {selectedTool === 'eliminate' && selectedOlFeatures.length > 0 && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Merge selection with the neighbouring polygon with the</label>
                  <CustomSelect
                    value={eliminateStrategy}
                    onChange={v => setEliminateStrategy(v as EliminateStrategy)}
                    options={[
                      { value: 'largestArea', label: 'Largest Area' },
                      { value: 'smallestArea', label: 'Smallest Area' },
                      { value: 'largestCommonBoundary', label: 'Largest Common Boundary' },
                    ]}
                    className="settings-select"
                  />
                  <div className="gp-form-hint">
                    {eliminateStrategy === 'largestArea' && 'Each selected polygon will be absorbed by its adjacent neighbor with the largest area.'}
                    {eliminateStrategy === 'smallestArea' && 'Each selected polygon will be absorbed by its adjacent neighbor with the smallest area.'}
                    {eliminateStrategy === 'largestCommonBoundary' && 'Each selected polygon will be absorbed by its adjacent neighbor that shares the longest boundary.'}
                  </div>
                </div>
              )}

              {/* Remove selected features selection */}
              {selectedTool === 'removeSelected' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Select features to remove</label>
                  <div className="gp-eliminate-controls">
                    <button
                      type="button"
                      className={`gp-select-btn${removeSelectingMode ? ' gp-select-btn--active' : ''}`}
                      onClick={() => setRemoveSelectingMode(!removeSelectingMode)}
                    >
                      {removeSelectingMode ? 'Stop selecting' : 'Select on map'}
                    </button>
                    <span className="gp-select-count">
                      {removeSelectedOlFeatures.length} feature{removeSelectedOlFeatures.length !== 1 ? 's' : ''} selected
                    </span>
                  </div>
                  {removeSelectedOlFeatures.length > 0 && (
                    <button
                      type="button"
                      className="gp-clear-btn"
                      onClick={() => setRemoveSelectedOlFeatures([])}
                    >
                      Clear selection
                    </button>
                  )}
                  <div className="gp-form-hint">
                    Click features on the map to select them for removal. The output layer will contain all features except the selected ones.
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

              {/* Simplify options */}
              {selectedTool === 'simplify' && (
                <>
                  <div className="gp-form-row">
                    <label className="gp-form-label">Method</label>
                    <CustomSelect
                      value={simplifyMethod}
                      onChange={v => setSimplifyMethod(v as SimplifyMethod)}
                      options={[
                        { value: 'distance', label: 'Distance (Douglas-Peucker)' },
                        { value: 'area', label: 'Area (Visvalingam-Whyatt)' },
                      ]}
                      className="settings-select"
                    />
                    <div className="gp-form-hint">
                      {simplifyMethod === 'distance'
                        ? 'The tolerance is the maximum perpendicular distance a vertex may be moved, in map units.'
                        : 'The tolerance is the smallest triangle area a vertex may contribute, in map units². Visvalingam keeps the silhouette of dense lines better at the same tolerance.'}
                    </div>
                  </div>
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
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={simplifyGroundUnits}
                        onChange={e => setSimplifyGroundUnits(e.target.checked)}
                      />
                      <span>Tolerance is in ground metres</span>
                    </label>
                    <div className="gp-form-hint">
                      Ground metres are scaled for Web Mercator latitude per feature, the way Buffer reads
                      its distance, so the same tolerance behaves the same at every latitude.
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={simplifyPreserve}
                        onChange={e => setSimplifyPreserve(e.target.checked)}
                      />
                      <span>Preserve topology</span>
                    </label>
                    <div className="gp-form-hint">
                      If simplifying a feature would make it invalid — a hole pushed outside its shell, a
                      self-intersection — the original geometry is kept for that feature instead.
                    </div>
                  </div>
                </>
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
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={attrsVertexCount}
                        onChange={e => setAttrsVertexCount(e.target.checked)}
                      />
                      <span>Vertex count</span>
                    </label>
                  </div>
                  {(addX || addY) && (
                    <div className="gp-form-row">
                      <label className="gp-form-checkbox">
                        <input
                          type="checkbox"
                          checked={attrsXYDegrees}
                          onChange={e => setAttrsXYDegrees(e.target.checked)}
                        />
                        <span>x / y in degrees (lon / lat)</span>
                      </label>
                      <div className="gp-form-hint">
                        Untick to write raw EPSG:3857 metres instead. Degrees are what QGIS reports and the
                        only form that means the same thing everywhere on a web-Mercator map.
                      </div>
                    </div>
                  )}
                  <div className="gp-form-hint">
                    Area, length and perimeter are true ground metres, measured the same way as the
                    on-map measure tool (holes subtracted), not stretched Web Mercator units.
                  </div>
                </div>
              )}

              {/* Extract vertices */}
              {selectedTool === 'extractVertices' && (
                <div className="gp-form-row">
                  <label className="gp-form-checkbox">
                    <input
                      type="checkbox"
                      checked={verticesSkipClosing}
                      onChange={e => setVerticesSkipClosing(e.target.checked)}
                    />
                    <span>Skip the duplicated closing vertex of each ring</span>
                  </label>
                  <div className="gp-form-hint">
                    Each point carries vertex_index, vertex_part, vertex_part_index, vertex_ring, the
                    cumulative distance along the ring and the turn angle at the vertex.
                  </div>
                </div>
              )}

              {/* Polygons to lines */}
              {selectedTool === 'polygonsToLines' && (
                <div className="gp-form-row">
                  <label className="gp-form-checkbox">
                    <input
                      type="checkbox"
                      checked={polygonsPerRing}
                      onChange={e => setPolygonsPerRing(e.target.checked)}
                    />
                    <span>One line per ring instead of one multipart line per feature</span>
                  </label>
                  <div className="gp-form-hint">
                    By default every ring of a feature (shell and holes) becomes one MultiLineString,
                    matching QGIS "Polygons to lines" and PostGIS ST_Boundary.
                  </div>
                </div>
              )}

              {/* Lines to polygons */}
              {selectedTool === 'linesToPolygons' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Closure tolerance</label>
                  <input
                    type="number"
                    className="gp-form-input"
                    value={linesClosureTolerance}
                    onChange={e => setLinesClosureTolerance(e.target.value)}
                    min="0"
                    step="any"
                    placeholder="Default (1e-6 map units)"
                  />
                  <div className="gp-form-hint">
                    How far apart the first and last vertex may be and still count as closed. Use Polygonize
                    instead when the lines are separate arcs that only meet at their ends.
                  </div>
                </div>
              )}

              {/* Delaunay */}
              {selectedTool === 'delaunay' && (
                <>
                  <div className="gp-form-row">
                    <label className="gp-form-label">Snapping tolerance</label>
                    <input
                      type="number"
                      className="gp-form-input"
                      value={delaunayTolerance}
                      onChange={e => setDelaunayTolerance(e.target.value)}
                      min="0"
                      step="any"
                    />
                    <div className="gp-form-hint">
                      Vertices closer than this are snapped onto the same grid point and deduplicated
                      before triangulating. 0 keeps the input coordinates exactly.
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={delaunayEdges}
                        onChange={e => setDelaunayEdges(e.target.checked)}
                      />
                      <span>Create edges instead of polygons</span>
                    </label>
                  </div>
                </>
              )}

              {/* Voronoi */}
              {selectedTool === 'voronoi' && (
                <>
                  <div className="gp-form-row">
                    <label className="gp-form-label">Buffer region (%)</label>
                    <input
                      type="number"
                      className="gp-form-input"
                      value={voronoiPadPercent}
                      onChange={e => setVoronoiPadPercent(e.target.value)}
                      min="0"
                      step="any"
                    />
                    <div className="gp-form-hint">
                      How far beyond the extent of the seeds the outer cells are allowed to reach, as a
                      percentage of that extent per side (QGIS's "Buffer region").
                    </div>
                  </div>
                  <div className="gp-form-row">
                    <label className="gp-form-checkbox">
                      <input
                        type="checkbox"
                        checked={voronoiCopyAttrs}
                        onChange={e => setVoronoiCopyAttrs(e.target.checked)}
                      />
                      <span>Copy attributes from input features</span>
                    </label>
                  </div>
                </>
              )}

              {/* Merge layer selection */}
              {selectedTool === 'merge' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Layers to merge</label>
                  <div className="gp-merge-layers">
                    {usableLayers.map(layer => (
                      <label key={layer.id} className="gp-form-checkbox gp-merge-layer-item">
                        <input
                          type="checkbox"
                          checked={mergeLayerIds.has(layer.id)}
                          onChange={e => {
                            setMergeLayerIds(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(layer.id);
                              else next.delete(layer.id);
                              return next;
                            });
                          }}
                        />
                        <span>{layer.name}</span>
                      </label>
                    ))}
                  </div>
                  <div className="gp-merge-actions">
                    <button
                      type="button"
                      className="gp-merge-select-all"
                      onClick={() => setMergeLayerIds(new Set(usableLayers.map(l => l.id)))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="gp-merge-select-none"
                      onClick={() => setMergeLayerIds(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="gp-form-hint">
                    Select the layers to combine. All fields from all layers will be included in the output.
                  </div>
                </div>
              )}

              {/* Split field selection */}
              {selectedTool === 'split' && (
                <div className="gp-form-row">
                  <label className="gp-form-label">Split by field</label>
                  <CustomSelect
                    value={splitFieldName}
                    onChange={setSplitFieldName}
                    options={inputFieldNames.map(n => ({ value: n, label: n }))}
                    className="settings-select"
                    placeholder="Select a field"
                  />
                  {splitFieldName && (
                    <div className="gp-form-hint">
                      Each unique value in "{splitFieldName}" will become a separate output layer.
                    </div>
                  )}
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
