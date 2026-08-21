import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getUid } from 'ol/util.js';
import { unByKey } from 'ol/Observable.js';
import type { VectorLayerConfig } from '../types';
import { vectorFeatureSource } from '../utils/layerHelpers';
import {
  AttrTableSortSpec,
  AttrTableViewMode,
  AttrTableWindowRect,
  ATTR_TABLE_ROW_HEIGHT as ROW_H,
  ATTR_TABLE_HEADER_HEIGHT as HEADER_H,
  ATTR_TABLE_ROWNUM_WIDTH as ROWNUM_W,
  ATTR_TABLE_COLUMN_WIDTH as COL_W,
  getFeatureAttributes,
  collectColumns,
  sortFeatures,
  computeFieldStats,
  numericColumns,
  featuresToCsv,
  downloadCsv,
  virtualRowRange,
  clampWindowRect,
  defaultWindowRect,
  loadAttrTableGeometry,
  saveAttrTableGeometry,
} from '../utils/attributeTable';
import { TableIcon, MoreIcon } from './Icons';

/**
 * ArcGIS Online-style attribute table, presented as a floating desktop-OS
 * window over the map: draggable by its title bar, resizable from every
 * edge and corner, maximisable, closable — and remembered between
 * sessions (geometry in localStorage, the open layer in workspace
 * settings).
 *
 * Data model: rows are the layer's OL features, queried live from the
 * feature source rather than copied, so edits (cell edits, filter swaps,
 * WFS/STAC loads) propagate through source events. The grid is virtualised
 * — only the visible band of rows exists in the DOM — which keeps million-
 * feature layers responsive the way ArcGIS's server-batched queries do.
 *
 * Features mirrored from ArcGIS Online: sortable (multi-column) headers,
 * row numbers that identify features rather than display order, checkbox
 * selection with Ctrl/Shift gestures, two-way selection sync with the map,
 * Show all / selected / visible / filtered view modes, an options menu
 * (attribute filter, show/hide columns, statistics, CSV export) and direct
 * cell editing.
 */

export interface AttrTableFocusRequest {
  feature: any;
  additive: boolean;
  seq: number;
}

export interface AttributeTableWindowProps {
  /** Config of the layer currently shown in the table. */
  layer: VectorLayerConfig;
  /** All table-able vector layers (non-MVT) for the title-bar switcher. */
  layers: VectorLayerConfig[];
  onSwitchLayer: (layerId: string) => void;
  /** Resolve a layer config id to its live OL layer. */
  getOlLayer: (layerId: string) => any;
  /** The OL map (used for the "Show visible" extent query). */
  map: any;
  onClose: () => void;
  /** Selection mirror — MapPage draws the on-map highlight from this. */
  onSelectionChange: (features: any[]) => void;
  /** Zoom the map to the given (selected) features. */
  onZoomToFeatures: (features: any[]) => void;
  /** Apply/clear the layer's attribute filter (same path as settings UI). */
  onApplyFilter: (layerId: string, enabled: boolean, expression: string) => boolean;
  /** A cell edit wrote through to a feature — persist the layer now. */
  onFeaturesEdited?: () => void;
  showToast: (message: string, kind?: 'success' | 'error') => void;
  /** A feature clicked on the map that the table should select & reveal. */
  focusRequest: AttrTableFocusRequest | null;
}

type GestureMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Apply a drag delta to the gesture's start rect for one resize/move mode,
 * enforcing the minimum size against the anchored edge/corner. */
function computeGestureRect(
  mode: GestureMode,
  start: AttrTableWindowRect,
  dx: number,
  dy: number
): AttrTableWindowRect {
  let { x, y, w, h } = start;
  if (mode === 'move') {
    x += dx;
    y += dy;
  } else {
    if (mode.includes('e')) w += dx;
    if (mode.includes('s')) h += dy;
    if (mode.includes('w')) { x += dx; w -= dx; }
    if (mode.includes('n')) { y += dy; h -= dy; }
    if (w < 1) w = 1;
    if (h < 1) h = 1;
  }
  return { x, y, w, h };
}

/** Display formatting for one attribute value. */
function formatCellValue(v: any): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

const VIEW_MODE_OPTIONS: Array<{ id: AttrTableViewMode; label: string; hint: string }> = [
  { id: 'all', label: 'Show all', hint: 'every record in the layer' },
  { id: 'selected', label: 'Show selected', hint: 'only checked rows' },
  { id: 'visible', label: 'Show visible', hint: 'only features in the current map extent' },
  { id: 'filtered', label: 'Show filtered', hint: 'only features matching the layer filter' },
];

export function AttributeTableWindow({
  layer,
  layers,
  onSwitchLayer,
  getOlLayer,
  map,
  onClose,
  onSelectionChange,
  onZoomToFeatures,
  onApplyFilter,
  onFeaturesEdited,
  showToast,
  focusRequest,
}: AttributeTableWindowProps) {
  // ----- window geometry (desktop-OS window behaviour) ----------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;
  const [rect, setRect] = useState<AttrTableWindowRect | null>(null);
  const [maximized, setMaximized] = useState(false);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const maximizedRef = useRef(maximized);
  maximizedRef.current = maximized;
  const gestureRef = useRef<{ mode: GestureMode; startX: number; startY: number; startRect: AttrTableWindowRect } | null>(null);

  // Measure the map container the window lives in (and follow its resizes).
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

  // First measurement: restore the persisted geometry (or dock at the bottom
  // like ArcGIS). Later container resizes re-clamp the window inside it.
  useEffect(() => {
    if (containerSize.w === 0 || containerSize.h === 0) return;
    setRect(prev => {
      if (prev) {
        const clamped = clampWindowRect(prev, containerSize.w, containerSize.h);
        return clamped.x === prev.x && clamped.y === prev.y && clamped.w === prev.w && clamped.h === prev.h ? prev : clamped;
      }
      const persisted = loadAttrTableGeometry();
      return persisted
        ? clampWindowRect(persisted.rect, containerSize.w, containerSize.h)
        : defaultWindowRect(containerSize.w, containerSize.h);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerSize]);

  // Restore the persisted maximized flag once on mount.
  useEffect(() => {
    const persisted = loadAttrTableGeometry();
    if (persisted?.maximized) setMaximized(true);
  }, []);

  const persistGeometry = useCallback(() => {
    if (rectRef.current) {
      saveAttrTableGeometry({ rect: rectRef.current, maximized: maximizedRef.current });
    }
  }, []);

  const onGestureMove = useCallback((e: MouseEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const next = computeGestureRect(g.mode, g.startRect, e.clientX - g.startX, e.clientY - g.startY);
    const { w, h } = containerSizeRef.current;
    setRect(w > 0 ? clampWindowRect(next, w, h) : next);
  }, []);

  const onGestureEnd = useCallback(() => {
    gestureRef.current = null;
    window.removeEventListener('mousemove', onGestureMove);
    window.removeEventListener('mouseup', onGestureEnd);
    document.body.style.userSelect = '';
    persistGeometry();
  }, [onGestureMove, persistGeometry]);

  const beginGesture = useCallback((mode: GestureMode, e: React.MouseEvent) => {
    if (e.button !== 0 || maximizedRef.current || !rectRef.current) return;
    e.preventDefault();
    gestureRef.current = { mode, startX: e.clientX, startY: e.clientY, startRect: rectRef.current };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onGestureMove);
    window.addEventListener('mouseup', onGestureEnd);
  }, [onGestureMove, onGestureEnd]);

  const onTitleBarMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, select, input, textarea, a')) return;
    beginGesture('move', e);
  }, [beginGesture]);

  const toggleMaximize = useCallback(() => {
    setMaximized(m => !m);
  }, []);

  useEffect(() => {
    persistGeometry();
  }, [maximized, persistGeometry]);

  // ----- data: live features from the layer's source ------------------------
  const [dataVersion, setDataVersion] = useState(0);
  useEffect(() => {
    const source = vectorFeatureSource(getOlLayer(layer.id));
    if (!source) return;
    const bump = () => setDataVersion(v => v + 1);
    const keys = [
      source.on('addfeature', bump),
      source.on('removefeature', bump),
      source.on('clear', bump),
      source.on('changefeature', bump),
    ];
    return () => keys.forEach(k => unByKey(k));
  }, [layer.id, getOlLayer]); // (re)subscribe once per layer

  /** The layer's full record set (its filter stash when a filter is on). */
  const master = useMemo<any[]>(() => {
    const olLayer = getOlLayer(layer.id);
    const source = vectorFeatureSource(olLayer);
    if (!source) return [] as any[];
    const stash = olLayer._filterMaster;
    return (Array.isArray(stash) ? stash : source.getFeatures()).slice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, dataVersion, getOlLayer]);

  const columns = useMemo(() => collectColumns(master), [master]);
  /** Row numbers identify the feature (its position in the natural order),
   * not its current display position — like ArcGIS's FID/ObjectID column. */
  const naturalNumbers = useMemo(() => {
    const m = new Map<any, number>();
    master.forEach((f, i) => m.set(f, i + 1));
    return m;
  }, [master]);

  // ----- selection ------------------------------------------------------------
  const [selection, setSelection] = useState<Set<any>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  const [scrollTarget, setScrollTarget] = useState<any>(null);

  // Mirror every selection change to the map (highlight layer).
  const selectionNotifyRef = useRef(onSelectionChange);
  selectionNotifyRef.current = onSelectionChange;
  useEffect(() => {
    selectionNotifyRef.current(Array.from(selection));
  }, [selection]);

  // Drop selected features that left the dataset (removed / filtered away).
  useEffect(() => {
    if (selection.size === 0) return;
    const present = new Set(master);
    let dirty = false;
    selection.forEach(f => { if (!present.has(f)) dirty = true; });
    if (!dirty) return;
    setSelection(prev => {
      const next = new Set<any>();
      prev.forEach(f => { if (present.has(f)) next.add(f); });
      return next;
    });
  }, [master, selection]);

  // ----- view mode -------------------------------------------------------------
  const [viewMode, setViewMode] = useState<AttrTableViewMode>('all');
  const [extentTick, setExtentTick] = useState(0);

  // "Show visible" re-queries against the map extent as the view moves.
  useEffect(() => {
    if (!map || viewMode !== 'visible' || typeof map.on !== 'function') return;
    const bump = () => setExtentTick(t => t + 1);
    map.on('moveend', bump);
    bump();
    return () => { if (typeof map.un === 'function') map.un('moveend', bump); };
  }, [map, viewMode]);

  const currentExtent = useMemo(() => {
    if (!map || viewMode !== 'visible') return null;
    try {
      return map.getView().calculateExtent(map.getSize());
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, viewMode, extentTick]);

  /** Rows for the active view mode, before sorting. */
  const baseRows = useMemo(() => {
    switch (viewMode) {
      case 'selected':
        return master.filter(f => selection.has(f));
      case 'visible': {
        if (!currentExtent) return master;
        return master.filter(f => {
          const g = f.getGeometry && f.getGeometry();
          return !!g && typeof g.intersectsExtent === 'function' && g.intersectsExtent(currentExtent);
        });
      }
      case 'filtered': {
        if (!layer.filterEnabled) return master;
        const source = vectorFeatureSource(getOlLayer(layer.id));
        return source ? source.getFeatures().slice() : master;
      }
      case 'all':
      default:
        return master;
    }
  }, [master, viewMode, selection, currentExtent, layer.filterEnabled, layer.id, getOlLayer]);

  // ----- sorting ------------------------------------------------------------------
  const [sorts, setSorts] = useState<AttrTableSortSpec[]>([]);
  const sortedRows = useMemo(() => sortFeatures(baseRows, sorts), [baseRows, sorts]);

  const handleHeaderClick = useCallback((field: string, shiftKey: boolean) => {
    setSorts(prev => {
      const existing = prev.find(s => s.field === field);
      if (!shiftKey) {
        // Plain click makes this column the (only) primary sort; clicking the
        // active primary flips its direction.
        if (existing && prev.length === 1) {
          return [{ field, dir: existing.dir === 'asc' ? 'desc' : 'asc' }];
        }
        return [{ field, dir: 'asc' }];
      }
      // Shift-click adds a secondary sort (or flips an existing one).
      if (existing) {
        return prev.map(s => (s.field === field ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' as const } : s));
      }
      return [...prev, { field, dir: 'asc' as const }];
    });
  }, []);

  // ----- column visibility -----------------------------------------------------
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const visibleColumns = useMemo(
    () => columns.filter(c => !hiddenColumns.has(c)),
    [columns, hiddenColumns]
  );

  // ----- virtualised grid --------------------------------------------------------
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    if (!gridRef.current) return;
    const measure = () => setViewportH(gridRef.current ? gridRef.current.clientHeight : 0);
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(gridRef.current);
    }
    return () => { if (ro) ro.disconnect(); };
  }, [rect, maximized, layer.id]);

  const rowRange = useMemo(
    () => virtualRowRange(scrollTop, viewportH, ROW_H, sortedRows.length, 12),
    [scrollTop, viewportH, sortedRows.length]
  );

  // ----- cell editing ----------------------------------------------------------------
  const editable = layer.type !== 'mvt';
  const [editingCell, setEditingCell] = useState<{ feature: any; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  const startCellEdit = useCallback((feature: any, field: string) => {
    if (!editable) return;
    const v = getFeatureAttributes(feature)[field];
    setEditValue(v === undefined || v === null ? '' : String(v));
    setEditingCell({ feature, field });
  }, [editable]);

  const commitCellEdit = useCallback(() => {
    if (!editingCell) return;
    const { feature, field } = editingCell;
    const old = getFeatureAttributes(feature)[field];
    let value: any = editValue;
    if (typeof old === 'number') {
      if (editValue.trim() === '') {
        value = null;
      } else {
        const n = Number(editValue);
        if (!Number.isFinite(n)) {
          showToast(`"${field}" expects a numeric value — change discarded.`, 'error');
          setEditingCell(null);
          return;
        }
        value = n;
      }
    } else if (typeof old === 'boolean') {
      const t = editValue.trim().toLowerCase();
      value = t === 'true' || t === '1' || t === 'yes';
    }
    try {
      feature.set(field, value); // fires changefeature → grid re-renders
      if (onFeaturesEdited) onFeaturesEdited(); // persist straight away (no unmount flush on reload)
    } catch (e) {
      console.warn('[AttributeTable] Failed to write attribute:', e);
    }
    setEditingCell(null);
  }, [editingCell, editValue, showToast, onFeaturesEdited]);

  // ----- options menu / overlay panels / filter bar ----------------------------------
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const [overlayPanel, setOverlayPanel] = useState<'columns' | 'stats' | null>(null);
  const [filterBarOpen, setFilterBarOpen] = useState(false);
  const [filterText, setFilterText] = useState(layer.filterExpression || '');
  const [filterError, setFilterError] = useState<string | null>(null);

  // Dismiss the options menu on any outside interaction.
  useEffect(() => {
    if (!optionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) setOptionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOptionsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [optionsOpen]);

  const applyFilterFromBar = useCallback(() => {
    const expr = filterText.trim();
    if (!expr) return;
    const ok = onApplyFilter(layer.id, true, expr);
    if (!ok) {
      setFilterError('Invalid expression — the filter was not applied.');
    } else {
      setFilterError(null);
      showToast('Filter applied to ' + layer.name);
    }
  }, [filterText, layer.id, layer.name, onApplyFilter, showToast]);

  const clearLayerFilter = useCallback(() => {
    onApplyFilter(layer.id, false, '');
    setFilterText('');
    setFilterError(null);
    showToast('Filter cleared');
  }, [layer.id, onApplyFilter, showToast]);

  // ----- selection gestures -------------------------------------------------------------
  const handleRowClick = useCallback((e: React.MouseEvent, feature: any, displayIdx: number) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, button')) return;
    if (e.shiftKey && anchorRef.current !== null) {
      const a = Math.min(anchorRef.current, displayIdx);
      const b = Math.max(anchorRef.current, displayIdx);
      setSelection(prev => {
        const next = new Set(prev);
        for (let i = a; i <= b; i += 1) {
          const f = sortedRows[i];
          if (f) next.add(f);
        }
        return next;
      });
      return;
    }
    anchorRef.current = displayIdx;
    if (e.ctrlKey || e.metaKey) {
      setSelection(prev => {
        const next = new Set(prev);
        if (next.has(feature)) next.delete(feature);
        else next.add(feature);
        return next;
      });
    } else {
      setSelection(new Set([feature]));
    }
  }, [sortedRows]);

  const toggleRowChecked = useCallback((feature: any) => {
    setSelection(prev => {
      const next = new Set(prev);
      if (next.has(feature)) next.delete(feature);
      else next.add(feature);
      return next;
    });
  }, []);

  const allInViewSelected = sortedRows.length > 0 && selection.size > 0 &&
    sortedRows.every(f => selection.has(f));
  const someInViewSelected = sortedRows.some(f => selection.has(f));

  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someInViewSelected && !allInViewSelected;
    }
  }, [someInViewSelected, allInViewSelected]);

  const toggleSelectAllInView = useCallback(() => {
    setSelection(prev => {
      const next = new Set(prev);
      if (allInViewSelected) sortedRows.forEach(f => next.delete(f));
      else sortedRows.forEach(f => next.add(f));
      return next;
    });
  }, [allInViewSelected, sortedRows]);

  // ----- map → table focus (two-way sync) -------------------------------------------------
  const focusSeq = focusRequest ? focusRequest.seq : -1;
  useEffect(() => {
    if (!focusRequest) return;
    const { feature, additive } = focusRequest;
    setScrollTarget(() => feature);
    setSelection(prev => {
      const next = additive ? new Set(prev) : new Set<any>();
      if (additive && prev.has(feature)) next.delete(feature);
      else next.add(feature);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq]);

  // Reveal the focused row once it exists in the displayed rows.
  useEffect(() => {
    if (!scrollTarget) return;
    const idx = sortedRows.indexOf(scrollTarget);
    if (idx >= 0 && gridRef.current) {
      const target = idx * ROW_H + HEADER_H;
      const viewH = gridRef.current.clientHeight;
      gridRef.current.scrollTop = Math.max(0, target - viewH / 2 + ROW_H / 2);
    }
    setScrollTarget(null);
  }, [scrollTarget, sortedRows]);

  // ----- layer switch: reset per-layer view state --------------------------------------------
  const prevLayerIdRef = useRef(layer.id);
  useEffect(() => {
    if (prevLayerIdRef.current === layer.id) return; // not a switch (e.g. initial mount)
    prevLayerIdRef.current = layer.id;
    setSelection(new Set());
    setSorts([]);
    setHiddenColumns(new Set());
    setScrollTop(0);
    setEditingCell(null);
    setFilterBarOpen(false);
    setFilterError(null);
    setFilterText(layer.filterExpression || '');
    setOptionsOpen(false);
    setOverlayPanel(null);
    setScrollTarget(null);
    anchorRef.current = null;
    if (gridRef.current) gridRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id]);

  // ----- toolbar actions ------------------------------------------------------------------------
  const handleExportCsv = useCallback(() => {
    if (sortedRows.length === 0) {
      showToast('Nothing to export — the current view has no rows.', 'error');
      return;
    }
    try {
      downloadCsv(featuresToCsv(sortedRows, visibleColumns), `${layer.name}-table`);
      showToast(`Exported ${sortedRows.length.toLocaleString()} rows to CSV`);
    } catch (e) {
      console.warn('[AttributeTable] CSV export failed:', e);
      showToast('CSV export failed', 'error');
    }
    setOptionsOpen(false);
  }, [sortedRows, visibleColumns, layer.name, showToast]);

  const stats = useMemo(() => {
    if (overlayPanel !== 'stats') return [];
    return numericColumns(baseRows, columns).map(col => computeFieldStats(baseRows, col));
  }, [overlayPanel, baseRows, columns]);

  // ----- render -------------------------------------------------------------------------------------
  if (!rect) {
    // Not initialised yet (waiting for the first container measurement).
    return <div className="attr-table-root" ref={rootRef} style={{ display: 'contents' }} />;
  }

  const windowStyle: React.CSSProperties = maximized
    ? { left: 8, top: 8, right: 8, bottom: 8 }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };

  const totalWidth = ROWNUM_W + visibleColumns.length * COL_W;
  const innerHeight = HEADER_H + sortedRows.length * ROW_H;
  const sortSummary = sorts.map(s => `${s.field} ${s.dir === 'asc' ? '\u2191' : '\u2193'}`).join(', ');
  const modeOption = VIEW_MODE_OPTIONS.find(o => o.id === viewMode)!;

  return (
    <div className="attr-table-root" ref={rootRef} style={{ display: 'contents' }}>
      <div
        className={`attr-table-window${maximized ? ' attr-table-window--maximized' : ''}`}
        style={windowStyle}
        role="dialog"
        aria-label={`Attribute table — ${layer.name}`}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {/* ----- title bar (drag to move) ----- */}
        <div
          className="attr-table-titlebar"
          onMouseDown={onTitleBarMouseDown}
          onDoubleClick={toggleMaximize}
        >
          <span className="attr-table-titlebar-icon"><TableIcon size={14} /></span>
          <span className="attr-table-title" title={`Attribute table of ${layer.name}`}>
            {layer.name}
          </span>
          <span className="attr-table-title-tag">Attribute Table</span>
          {layers.length > 1 && (
            <select
              className="attr-table-layer-select"
              value={layer.id}
              onChange={(e) => onSwitchLayer(e.target.value)}
              title="Switch table to another layer"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {layers.map(l => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}
          <span className="attr-table-titlebar-spacer" />
          <button
            type="button"
            className="attr-table-winbtn"
            onClick={toggleMaximize}
            title={maximized ? 'Restore window' : 'Maximize window'}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {maximized ? '\u2752' : '\u25A1'}
          </button>
          <button
            type="button"
            className="attr-table-winbtn attr-table-winbtn--close"
            onClick={onClose}
            title="Close attribute table"
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Close attribute table"
          >
            {'\u00D7'}
          </button>
        </div>

        {/* ----- toolbar ----- */}
        <div className="attr-table-toolbar">
          <select
            className="attr-table-select"
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value as AttrTableViewMode)}
            title={modeOption.hint}
          >
            {VIEW_MODE_OPTIONS.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <span className="attr-table-count">
            {sortedRows.length.toLocaleString()} of {master.length.toLocaleString()} records
          </span>
          {layer.filterEnabled && !!layer.filterExpression && (
            <span className="attr-table-chip attr-table-chip--filter" title={layer.filterExpression}>
              Filtered
            </span>
          )}
          {sorts.length > 0 && (
            <span className="attr-table-chip" title={'Sorted by ' + sortSummary}>
              Sorted: {sortSummary}
              <button
                type="button"
                className="attr-table-chip-x"
                onClick={() => setSorts([])}
                title="Clear sorting"
              >
                {'\u00D7'}
              </button>
            </span>
          )}
          <span className="attr-table-toolbar-spacer" />
          {selection.size > 0 && (
            <>
              <span className="attr-table-selcount">{selection.size.toLocaleString()} selected</span>
              <button
                type="button"
                className="attr-table-toolbtn"
                onClick={() => onZoomToFeatures(Array.from(selection))}
                title="Zoom to selected features"
              >
                Zoom to
              </button>
              <button
                type="button"
                className="attr-table-toolbtn"
                onClick={() => setSelection(new Set())}
                title="Clear selection"
              >
                Clear
              </button>
            </>
          )}
          <div className="attr-table-options-anchor" ref={optionsRef}>
            <button
              type="button"
              className={`attr-table-toolbtn attr-table-toolbtn--icon${optionsOpen ? ' attr-table-toolbtn--active' : ''}`}
              onClick={() => setOptionsOpen(o => !o)}
              title="Table options"
              aria-label="Table options"
            >
              <MoreIcon />
            </button>
            {optionsOpen && (
              <div className="attr-table-menu" role="menu">
                <button type="button" role="menuitem" className="attr-table-menu-item"
                  onClick={() => { setFilterBarOpen(o => !o); setOptionsOpen(false); }}>
                  {filterBarOpen ? 'Hide filter bar' : 'Filter by attribute\u2026'}
                </button>
                <button type="button" role="menuitem" className="attr-table-menu-item"
                  onClick={() => { setOverlayPanel(p => (p === 'columns' ? null : 'columns')); setOptionsOpen(false); }}>
                  Show / hide columns{'\u2026'}
                </button>
                <button type="button" role="menuitem" className="attr-table-menu-item"
                  disabled={baseRows.length === 0}
                  onClick={() => { setOverlayPanel(p => (p === 'stats' ? null : 'stats')); setOptionsOpen(false); }}>
                  Statistics{'\u2026'}
                </button>
                <button type="button" role="menuitem" className="attr-table-menu-item"
                  onClick={handleExportCsv}>
                  Export to CSV
                </button>
                {sorts.length > 0 && (
                  <button type="button" role="menuitem" className="attr-table-menu-item"
                    onClick={() => { setSorts([]); setOptionsOpen(false); }}>
                    Clear sorting
                  </button>
                )}
                {selection.size > 0 && (
                  <button type="button" role="menuitem" className="attr-table-menu-item"
                    onClick={() => { setSelection(new Set()); setOptionsOpen(false); }}>
                    Clear selection
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ----- filter bar (ArcGIS "Filter by attribute expression") ----- */}
        {filterBarOpen && (
          <div className="attr-table-filterbar">
            <input
              className="attr-table-filter-input"
              value={filterText}
              placeholder={'e.g. "population" > 1000000 and "type" like \'%city%\''}
              onChange={(e) => { setFilterText(e.target.value); setFilterError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') applyFilterFromBar(); if (e.key === 'Escape') setFilterBarOpen(false); }}
              autoFocus
            />
            <button type="button" className="attr-table-toolbtn attr-table-toolbtn--solid" onClick={applyFilterFromBar}>Apply</button>
            <button type="button" className="attr-table-toolbtn" onClick={clearLayerFilter}
              disabled={!layer.filterEnabled}>Clear filter</button>
            <button type="button" className="attr-table-toolbtn attr-table-toolbtn--icon" onClick={() => setFilterBarOpen(false)}
              title="Hide filter bar" aria-label="Hide filter bar">{'\u00D7'}</button>
            {filterError && <span className="attr-table-filter-error">{filterError}</span>}
          </div>
        )}

        {/* ----- grid ----- */}
        <div
          className="attr-table-grid"
          ref={gridRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {master.length === 0 ? (
            <div className="attr-table-empty">
              No features to show{layer.type === 'wfs' || layer.type === 'stac' ? ' yet — the data may still be loading' : ''}.
            </div>
          ) : (
            <div className="attr-table-inner" style={{ width: totalWidth, height: innerHeight }}>
              <div className="attr-table-header" style={{ width: totalWidth }}>
                <div className="attr-table-corner" style={{ width: ROWNUM_W }}>
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allInViewSelected}
                    onChange={toggleSelectAllInView}
                    title="Select / deselect all rows in view"
                    aria-label="Select all rows in view"
                  />
                  <span className="attr-table-corner-num">#</span>
                </div>
                {visibleColumns.map(col => {
                  const sortIdx = sorts.findIndex(s => s.field === col);
                  const spec = sortIdx >= 0 ? sorts[sortIdx] : null;
                  return (
                    <div
                      key={col}
                      className={`attr-table-hcell${spec ? ' attr-table-hcell--sorted' : ''}`}
                      style={{ width: COL_W }}
                      onClick={(e) => handleHeaderClick(col, e.shiftKey)}
                      title={spec ? `Sorted ${spec.dir === 'asc' ? 'ascending' : 'descending'} (shift-click to add a sort)` : col + ' — click to sort, shift-click to add a sort'}
                    >
                      <span className="attr-table-hcell-name">{col}</span>
                      {spec && (
                        <span className="attr-table-hcell-sort">
                          {spec.dir === 'asc' ? '\u25B2' : '\u25BC'}
                          {sorts.length > 1 && <i className="attr-table-hcell-sortidx">{sortIdx + 1}</i>}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {sortedRows.slice(rowRange.start, rowRange.end).map((feature, i) => {
                const displayIdx = rowRange.start + i;
                const selected = selection.has(feature);
                const attrs = getFeatureAttributes(feature);
                return (
                  <div
                    key={getUid(feature)}
                    className={`attr-table-row${selected ? ' attr-table-row--selected' : ''}`}
                    style={{ top: HEADER_H + displayIdx * ROW_H, width: totalWidth }}
                    onClick={(e) => handleRowClick(e, feature, displayIdx)}
                  >
                    <div className="attr-table-rcell" style={{ width: ROWNUM_W }}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRowChecked(feature)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select row ${naturalNumbers.get(feature)}`}
                      />
                      <span className="attr-table-rnum">{naturalNumbers.get(feature)}</span>
                    </div>
                    {visibleColumns.map(col => {
                      const isEditing = !!editingCell && editingCell.feature === feature && editingCell.field === col;
                      return (
                        <div
                          key={col}
                          className="attr-table-cell"
                          style={{ width: COL_W }}
                          onDoubleClick={() => startCellEdit(feature, col)}
                          title={isEditing ? undefined : formatCellValue(attrs[col])}
                        >
                          {isEditing ? (
                            <input
                              className="attr-table-cell-input"
                              value={editValue}
                              autoFocus
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={commitCellEdit}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitCellEdit();
                                if (e.key === 'Escape') setEditingCell(null);
                              }}
                            />
                          ) : (
                            formatCellValue(attrs[col])
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ----- status bar ----- */}
        <div className="attr-table-statusbar">
          <span>{modeOption.label}: {modeOption.hint}</span>
          <span className="attr-table-statusbar-spacer" />
          {selection.size > 0 && <span>{selection.size.toLocaleString()} selected{' \u00B7 '}</span>}
          <span>{sortedRows.length.toLocaleString()} rows{' \u00B7 '}{visibleColumns.length} columns</span>
          {editable && <span className="attr-table-statusbar-hint">{' \u00B7 '}double-click a cell to edit</span>}
        </div>

        {/* ----- overlay panels ----- */}
        {overlayPanel === 'columns' && (
          <div className="attr-table-overlay">
            <div className="attr-table-overlay-header">
              <span>Show / hide columns</span>
              <button type="button" className="attr-table-toolbtn attr-table-toolbtn--icon"
                onClick={() => setOverlayPanel(null)} aria-label="Close columns panel">{'\u00D7'}</button>
            </div>
            <div className="attr-table-overlay-body">
              {columns.map(col => (
                <label key={col} className="attr-table-column-toggle">
                  <input
                    type="checkbox"
                    checked={!hiddenColumns.has(col)}
                    onChange={() => {
                      setHiddenColumns(prev => {
                        const next = new Set(prev);
                        if (next.has(col)) next.delete(col);
                        else next.add(col);
                        return next;
                      });
                    }}
                  />
                  <span>{col}</span>
                </label>
              ))}
              {columns.length === 0 && <div className="attr-table-empty">No attribute fields.</div>}
            </div>
            <div className="attr-table-overlay-footer">
              <button type="button" className="attr-table-toolbtn" onClick={() => setHiddenColumns(new Set())}>Show all</button>
              <button type="button" className="attr-table-toolbtn"
                onClick={() => setHiddenColumns(new Set(columns))}>Hide all</button>
            </div>
          </div>
        )}
        {overlayPanel === 'stats' && (
          <div className="attr-table-overlay">
            <div className="attr-table-overlay-header">
              <span>Statistics — {baseRows.length.toLocaleString()} records in current view</span>
              <button type="button" className="attr-table-toolbtn attr-table-toolbtn--icon"
                onClick={() => setOverlayPanel(null)} aria-label="Close statistics panel">{'\u00D7'}</button>
            </div>
            <div className="attr-table-overlay-body">
              {stats.length === 0 && <div className="attr-table-empty">No numeric fields in this view.</div>}
              {stats.map(st => {
                const maxBin = Math.max(1, ...st.histogram);
                return (
                  <div key={st.field} className="attr-table-stat">
                    <div className="attr-table-stat-head">
                      <span className="attr-table-stat-field" title={st.field}>{st.field}</span>
                      <span className="attr-table-stat-count">
                        {st.count.toLocaleString()} values{st.nulls > 0 ? ` (${st.nulls.toLocaleString()} empty)` : ''}
                      </span>
                    </div>
                    <div className="attr-table-stat-nums">
                      <span>min {st.min.toLocaleString()}</span>
                      <span>max {st.max.toLocaleString()}</span>
                      <span>mean {st.mean.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                      <span>std {st.stddev.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    </div>
                    {st.histogram.length > 0 && (
                      <div className="attr-table-stat-hist" aria-hidden="true">
                        {st.histogram.map((v, i) => (
                          <span key={i} className="attr-table-stat-bar"
                            style={{ height: 4 + Math.round((v / maxBin) * 34) }} title={`${v} features`} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ----- resize handles ----- */}
        {!maximized && (
          <>
            <div className="attr-table-resize attr-table-resize--n" onMouseDown={(e) => beginGesture('n', e)} />
            <div className="attr-table-resize attr-table-resize--s" onMouseDown={(e) => beginGesture('s', e)} />
            <div className="attr-table-resize attr-table-resize--e" onMouseDown={(e) => beginGesture('e', e)} />
            <div className="attr-table-resize attr-table-resize--w" onMouseDown={(e) => beginGesture('w', e)} />
            <div className="attr-table-resize attr-table-resize--ne" onMouseDown={(e) => beginGesture('ne', e)} />
            <div className="attr-table-resize attr-table-resize--nw" onMouseDown={(e) => beginGesture('nw', e)} />
            <div className="attr-table-resize attr-table-resize--se" onMouseDown={(e) => beginGesture('se', e)} />
            <div className="attr-table-resize attr-table-resize--sw" onMouseDown={(e) => beginGesture('sw', e)} />
          </>
        )}
      </div>
    </div>
  );
}
