import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { VectorLayerConfig, DrawStyle, UnitsSystem } from '../types';
import { parseColor, rgbaToString } from '../utils/colorHelpers';
import { VECTOR_EXPORT_FORMATS, VectorExportFormat } from '../utils/vectorExport';
import { layerPointStats, vectorFilterStats, vectorFeatureSource } from '../utils/layerHelpers';
import { checkFeatureFilter, compileFeatureFilter, featureProperties } from '../utils/featureFilter';
import { FunnelIcon } from './Icons';
import { SliderRow } from './SliderRow';
import { ColorAlphaEditor } from './ColorAlphaEditor';
import { TileZoomRangeControl, parseZoomInput } from './TileZoomRangeControl';
import { VectorFeatureStyleItem } from './DrawToolbar';

// Query-expression constructs surfaced as hint chips under the filter field,
// so users can discover the grammar without reading docs.
const FILTER_SYNTAX_HINTS = ['=', '!=', '<', '>', '<=', '>=', 'is true', 'is null', "like '%…%'", 'and', 'or', '( )'];

// Style values the edit session starts from, derived from the layer config
// (same defaults the add-form uses when a layer is first styled).
const initialStyle = (layer: VectorLayerConfig) => ({
  opacity: layer.opacity ?? 100,
  lineColor: rgbaToString(parseColor(layer.lineColor, 1)),
  lineWidth: layer.lineWidth ?? 2,
  fillColor: rgbaToString(parseColor(layer.fillColor, 0.3)),
  fontColor: rgbaToString(parseColor(layer.fontColor, 1)),
  fontSize: layer.fontSize ?? 14 });

export interface VectorLayerEditFormProps {
  layer: VectorLayerConfig;
  editingVectorLayerId: string | null;
  units: UnitsSystem;
  onApplyStyle: (layerId: string, style: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number }) => void;
  onApplyZoomRange: (layerId: string, minZoom?: number, maxZoom?: number) => void;
  onApplyCluster: (layerId: string, clusterPoints: boolean, clusterDistance: number) => void;
  onApplyFilter: (layerId: string, enabled: boolean, expression: string) => boolean;
  onApplyFeatureStyle: (layerId: string, feature: any, style: DrawStyle) => void;
  onEdit: (layer: VectorLayerConfig) => void;
  onReedit: (layerId: string) => void;
  onExport: (layerId: string, format: VectorExportFormat) => void;
  onCancel: () => void;
}

// Inline edit form for a single vector layer (extracted from
// SettingsDialog's renderVectorLayerRow). Mount it only while the layer is
// being edited (keyed by layer id) — all edit state is seeded from the
// layer prop on mount and committed or reverted through the callbacks.
export function VectorLayerEditForm({
  layer,
  editingVectorLayerId,
  units,
  onApplyStyle,
  onApplyZoomRange,
  onApplyCluster,
  onApplyFilter,
  onApplyFeatureStyle,
  onEdit,
  onReedit,
  onExport,
  onCancel }: VectorLayerEditFormProps) {
  // ----- Edit state, seeded from the layer when the form mounts -----
  const [editName, setEditName] = useState(layer.name);
  const [editUrl, setEditUrl] = useState(layer.url || '');
  const [originalStyle] = useState(() => initialStyle(layer));
  const [editOpacity, setEditOpacity] = useState(originalStyle.opacity);
  const [editLineColor, setEditLineColor] = useState(originalStyle.lineColor);
  const [editLineWidth, setEditLineWidth] = useState(originalStyle.lineWidth);
  const [editFillColor, setEditFillColor] = useState(originalStyle.fillColor);
  const [editFontColor, setEditFontColor] = useState(originalStyle.fontColor);
  const [editFontSize, setEditFontSize] = useState(originalStyle.fontSize);
  const [styleExpanded, setStyleExpanded] = useState(false);
  // Zoom range state (strings so fields can be emptied = unlimited)
  const [editMinZoom, setEditMinZoom] = useState(layer.minZoom !== undefined ? String(layer.minZoom) : '');
  const [editMaxZoom, setEditMaxZoom] = useState(layer.maxZoom !== undefined ? String(layer.maxZoom) : '');
  const [originalZoomRange] = useState<{ min?: number; max?: number }>({ min: layer.minZoom, max: layer.maxZoom });
  // Point clustering state (checkbox + cluster distance px)
  const [editCluster, setEditCluster] = useState(layer.clusterPoints === true);
  const [editClusterDistance, setEditClusterDistance] = useState(layer.clusterDistance ?? 40);
  const [originalCluster] = useState<{ clusterPoints: boolean; clusterDistance: number }>({ clusterPoints: layer.clusterPoints === true, clusterDistance: layer.clusterDistance ?? 40 });
  // Attribute filter state: the toggle, the query expression being typed,
  // inline validation feedback, and the values the edit session started
  // with (restored on Cancel).
  const filterEnabledInitial = layer.filterEnabled === true && !!layer.filterExpression;
  const [filterEnabled, setFilterEnabled] = useState(filterEnabledInitial);
  const [filterExpr, setFilterExpr] = useState(layer.filterExpression || '');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterTouched, setFilterTouched] = useState(false);
  const [originalFilter] = useState<{ enabled: boolean; expression: string }>({ enabled: filterEnabledInitial, expression: layer.filterExpression || '' });

  // Grouped "Download" menu (null = closed). It is rendered through a portal
  // at position:fixed so it floats above the dialog instead of stretching
  // the dialog body's scrollable area; an absolutely-positioned menu inside
  // that scroll container forced a horizontal scrollbar the moment it poked
  // past an edge.
  const [downloadMenu, setDownloadMenu] = useState<{ layerId: string; left: number; bottom?: number; top?: number } | null>(null);
  const downloadToggleRef = useRef<HTMLDivElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);

  const openDownloadMenu = useCallback((layerId: string, anchor: HTMLElement) => {
    const MENU_WIDTH = 184;
    const MENU_HEIGHT = 150;
    const MARGIN = 8;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;
    // Prefer opening upward (the button row sits near the dialog's bottom);
    // flip below the button only when there is no room above.
    setDownloadMenu(
      rect.top >= MENU_HEIGHT + MARGIN
        ? { layerId, left, bottom: window.innerHeight - rect.top + 6 }
        : { layerId, left, top: rect.bottom + 6 }
    );
  }, []);

  useEffect(() => {
    if (!downloadMenu) return;
    const close = () => setDownloadMenu(null);
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (downloadMenuRef.current?.contains(t)) return; // menu items close themselves
      if (downloadToggleRef.current?.contains(t)) return; // button re-toggles itself
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // The menu is viewport-anchored, so any scroll (the dialog body scrolls)
    // or resize would detach it from its button — dismiss instead of drift.
    const onScroll = (e: Event) => {
      if (downloadMenuRef.current && downloadMenuRef.current.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [downloadMenu]);

  // Build the full style payload from the current edit state, overriding one field.
  const stylePayload = (override: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number } = {}) => ({
    opacity: editOpacity,
    lineColor: editLineColor,
    lineWidth: editLineWidth,
    fillColor: editFillColor,
    fontColor: editFontColor,
    fontSize: editFontSize,
    ...override });

  // Commit a zoom-range pair from the text inputs (MVT tile clamp /
  // visibility range). An invalid pair is ignored until both fields form a
  // valid range.
  const applyZoomRange = (layerId: string, minStr: string, maxStr: string) => {
    const min = parseZoomInput(minStr);
    const max = parseZoomInput(maxStr);
    if (min !== undefined && max !== undefined && min > max) return; // invalid pair — wait for a valid one
    onApplyZoomRange(layerId, min, max);
  };

  return (
    <div key={layer.id} className="settings-add-form">
      <input
        type="text"
        placeholder="Layer name"
        value={editName}
        onChange={(e) => setEditName(e.target.value)}
        className="settings-input"
      />
      {['mvt', 'wfs', 'stac'].includes(layer.type) && (
        <input
          type="text"
          placeholder={layer.type === 'wfs' ? 'WFS URL' : layer.type === 'stac' ? 'STAC API or Item URL' : 'MVT URL'}
          value={editUrl}
          onChange={(e) => setEditUrl(e.target.value)}
          className="settings-input"
        />
      )}
      <div className="settings-color-adjustments">
        <SliderRow
          label="Opacity"
          min={0}
          max={100}
          value={editOpacity}
          defaultValue={100}
          unit="%"
          onChange={(val) => {
            setEditOpacity(val);
            onApplyStyle(layer.id, stylePayload({ opacity: val }));
          }}
          onReset={() => {
            setEditOpacity(100);
            onApplyStyle(layer.id, stylePayload({ opacity: 100 }));
          }}
          resetTitle="Reset opacity"
        />
        <div className="settings-style-collapse">
          <button
            type="button"
            className="settings-style-collapse-header"
            onClick={() => setStyleExpanded((expanded) => !expanded)}
            aria-expanded={styleExpanded}
          >
            <span className={'settings-style-collapse-chevron' + (styleExpanded ? ' expanded' : '')}>▸</span>
            <span className="settings-style-collapse-title">Colors & style</span>
            <span className="settings-style-collapse-summary">
              <span className="settings-style-collapse-swatch" style={{ background: editLineColor }} title="Line color" />
              <span className="settings-style-collapse-swatch" style={{ background: editFillColor }} title="Fill color" />
              <span className="settings-style-collapse-swatch" style={{ background: editFontColor }} title="Font color" />
            </span>
          </button>
          {styleExpanded && (
            <div className="settings-style-collapse-body">
              <SliderRow
                label="Line width"
                min={1}
                max={10}
                value={editLineWidth}
                defaultValue={2}
                unit="px"
                onChange={(val) => {
                  setEditLineWidth(val);
                  onApplyStyle(layer.id, stylePayload({ lineWidth: val }));
                }}
                onReset={() => {
                  setEditLineWidth(2);
                  onApplyStyle(layer.id, stylePayload({ lineWidth: 2 }));
                }}
                resetTitle="Reset line width"
              />
              <ColorAlphaEditor
                label="Line color"
                value={editLineColor}
                defaultAlpha={1}
                onChange={(val) => {
                  setEditLineColor(val);
                  onApplyStyle(layer.id, stylePayload({ lineColor: val }));
                }}
              />
              <ColorAlphaEditor
                label="Fill color"
                value={editFillColor}
                defaultAlpha={0.3}
                onChange={(val) => {
                  setEditFillColor(val);
                  onApplyStyle(layer.id, stylePayload({ fillColor: val }));
                }}
              />
              <SliderRow
                label="Font size"
                min={8}
                max={32}
                value={editFontSize}
                defaultValue={14}
                unit="px"
                onChange={(val) => {
                  setEditFontSize(val);
                  onApplyStyle(layer.id, stylePayload({ fontSize: val }));
                }}
                onReset={() => {
                  setEditFontSize(14);
                  onApplyStyle(layer.id, stylePayload({ fontSize: 14 }));
                }}
                resetTitle="Reset font size"
              />
              <ColorAlphaEditor
                label="Font color"
                value={editFontColor}
                defaultAlpha={1}
                onChange={(val) => {
                  setEditFontColor(val);
                  onApplyStyle(layer.id, stylePayload({ fontColor: val }));
                }}
              />
            </div>
          )}
        </div>
      </div>
      {(() => {
        // MVT layers clamp tile requests to the grid's native range;
        // other vector types use the range as a visibility window.
        const mvtGrid = layer.type === 'mvt' ? layer.olLayer?.getSource?.()?.getTileGrid?.() : null;
        const native = layer.type === 'mvt'
          ? ((layer.olLayer as any)?._nativeTileZoomRange ?? (mvtGrid ? { min: mvtGrid.getMinZoom(), max: mvtGrid.getMaxZoom() } : null))
          : null;
        return (
          <TileZoomRangeControl
            minValue={editMinZoom}
            maxValue={editMaxZoom}
            onMinChange={(v) => { setEditMinZoom(v); applyZoomRange(layer.id, v, editMaxZoom); }}
            onMaxChange={(v) => { setEditMaxZoom(v); applyZoomRange(layer.id, editMinZoom, v); }}
            collapsible
            defaultOpen={layer.minZoom !== undefined || layer.maxZoom !== undefined}
            nativeMin={native?.min}
            nativeMax={native?.max}
            title={layer.type === 'mvt' ? 'Tile zoom range' : 'Zoom range'}
            hint={layer.type === 'mvt'
              ? undefined
              : 'The layer is only visible while the map zoom is inside this range.'}
          />
        );
      })()}
      {layer.type !== 'mvt' && (() => {
        // Clustering only applies to point datasets. Inspect the
        // live features to decide whether the option is available.
        const stats = layerPointStats(layer.olLayer);
        const canCluster = stats.total === 0 || stats.pointCount === stats.total;
        return (
          <div className={'settings-cluster-control' + (canCluster ? '' : ' disabled')}>
            <label
              className="settings-cluster-checkbox"
              title={canCluster
                ? 'Group nearby points into count bubbles — ideal for dense point datasets'
                : 'Clustering needs a point dataset — this layer mixes in lines or polygons'}
            >
              <input
                type="checkbox"
                checked={editCluster}
                disabled={!canCluster}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setEditCluster(checked);
                  onApplyCluster(layer.id, checked, editClusterDistance);
                }}
              />
              <span className="settings-cluster-label">Point clustering</span>
              {stats.pointCount > 0 && (
                <span className="settings-cluster-count" title="Point features in this layer">
                  {stats.pointCount.toLocaleString()} {stats.pointCount === 1 ? 'point' : 'points'}
                </span>
              )}
            </label>
            {editCluster && canCluster && (
              <SliderRow
                label="Cluster distance"
                min={10}
                max={120}
                value={editClusterDistance}
                defaultValue={40}
                unit="px"
                onChange={(val) => {
                  setEditClusterDistance(val);
                  onApplyCluster(layer.id, true, val);
                }}
                onReset={() => {
                  setEditClusterDistance(40);
                  onApplyCluster(layer.id, true, 40);
                }}
                resetTitle="Reset cluster distance"
              />
            )}
          </div>
        );
      })()}
      {layer.type !== 'mvt' && (() => {
        // Attribute filter: a toggle that pops out a query
        // expression field. Apply narrows the layer to the
        // matching features; the full dataset stays stashed on
        // the OL layer so Clear/Cancel restores everything.
        const stats = vectorFilterStats(layer.olLayer);
        const exprTrimmed = filterExpr.trim();
        const liveCheck = filterEnabled && exprTrimmed ? checkFeatureFilter(exprTrimmed) : null;
        // Preview how many features the typed expression would
        // match, evaluated against the full (unfiltered) set.
        const masterFeats: any[] | null = layer.olLayer
          ? (Array.isArray(layer.olLayer._filterMaster)
              ? layer.olLayer._filterMaster
              : (vectorFeatureSource(layer.olLayer)?.getFeatures() ?? null))
          : null;
        let liveMatched: number | null = null;
        if (liveCheck && liveCheck.ok && masterFeats) {
          try {
            const pred = compileFeatureFilter(exprTrimmed).predicate;
            liveMatched = masterFeats.filter((f: any) => pred(featureProperties(f))).length;
          } catch { liveMatched = null; }
        }
        const liveError = liveCheck && !liveCheck.ok ? liveCheck.error : null;
        const showError = filterError || (filterTouched ? liveError : null);

        const applyFilterExpr = () => {
          if (!exprTrimmed) return;
          const check = checkFeatureFilter(exprTrimmed);
          if (!check.ok) { setFilterError(check.error); return; }
          setFilterError(null);
          onApplyFilter(layer.id, true, exprTrimmed);
        };

        return (
          <div className={'settings-filter-control' + (filterEnabled ? ' active' : '')}>
            <div className="settings-filter-header">
              <button
                type="button"
                role="switch"
                aria-checked={filterEnabled}
                className={'settings-filter-switch' + (filterEnabled ? ' on' : '')}
                title={filterEnabled
                  ? 'Turn the attribute filter off'
                  : 'Show only the features that match a query expression'}
                onClick={() => {
                  const next = !filterEnabled;
                  setFilterEnabled(next);
                  setFilterError(null);
                  setFilterTouched(false);
                  // Toggling off clears the filter from the map at
                  // once; toggling on only opens the expression
                  // field - nothing is filtered until Apply.
                  if (!next) onApplyFilter(layer.id, false, '');
                }}
              >
                <span className="settings-filter-switch-knob" />
              </button>
              <span className="settings-filter-title">
                <FunnelIcon size={13} />
                Filter
              </span>
              {filterEnabled && stats.filtered && (
                <span className="settings-filter-count" title="Features shown / total features in the layer">
                  {stats.shown.toLocaleString()} of {stats.total.toLocaleString()}
                </span>
              )}
            </div>
            <div className={'settings-filter-body' + (filterEnabled ? ' open' : '')}>
              <div className="settings-filter-body-inner">
                <input
                  className={'settings-filter-input' + (showError ? ' has-error' : '')}
                  value={filterExpr}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Filter query expression"
                  placeholder={'e.g. "capture_date" > \'2024-01-01\'  or  "published" is true'}
                  onChange={(e) => { setFilterExpr(e.target.value); setFilterError(null); }}
                  onBlur={() => setFilterTouched(true)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFilterExpr(); } }}
                />
                <div className="settings-filter-syntax">
                  <span className="settings-filter-syntax-label">Syntax</span>
                  {FILTER_SYNTAX_HINTS.map((hint) => (
                    <code key={hint} className="settings-filter-syntax-chip">{hint}</code>
                  ))}
                </div>
                {showError ? (
                  <div className="settings-filter-feedback error" role="alert">{showError}</div>
                ) : exprTrimmed && liveCheck && liveCheck.ok ? (
                  <div className="settings-filter-feedback ok">
                    {'\u2713'} Valid expression{masterFeats && liveMatched !== null && (
                      <span> {'\u2014'} matches {liveMatched.toLocaleString()} of {masterFeats.length.toLocaleString()} {masterFeats.length === 1 ? 'feature' : 'features'}</span>
                    )}
                  </div>
                ) : null}
                <div className="settings-filter-actions">
                  <button
                    className="settings-filter-apply"
                    disabled={!exprTrimmed}
                    onClick={applyFilterExpr}
                  >Apply</button>
                  {stats.filtered && (
                    <button
                      className="settings-filter-clear"
                      onClick={() => {
                        setFilterExpr('');
                        setFilterError(null);
                        setFilterTouched(false);
                        onApplyFilter(layer.id, false, '');
                      }}
                    >Clear filter</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {layer.isDrawnInApp && layer.olLayer && (() => {
        const feats = layer.olLayer.getSource?.()?.getFeatures?.() || [];
        if (feats.length === 0) return null;
        return (
          <div className="settings-vector-features">
            <div className="settings-vector-features-title">Individual features</div>
            <div className="settings-vector-features-list">
              {feats.map((f: any, i: number) => (
                <VectorFeatureStyleItem
                  key={i}
                  feature={f}
                  index={i}
                  onApply={(feat, s) => onApplyFeatureStyle(layer.id, feat, s)}
                  units={units}
                />
              ))}
            </div>
          </div>
        );
      })()}
      <div className="settings-form-buttons">
        <button className="settings-button-primary" onClick={() => {
          if (editName.trim() && (!['mvt', 'wfs', 'stac'].includes(layer.type) || editUrl.trim())) {
            // Commit the filter alongside the other edits: an
            // invalid expression blocks the commit (the error is
            // surfaced inline in the filter panel above).
            const exprToCommit = filterEnabled ? filterExpr.trim() : '';
            if (exprToCommit) {
              const filterCheck = checkFeatureFilter(exprToCommit);
              if (!filterCheck.ok) {
                setFilterError(filterCheck.error);
                return;
              }
              onApplyFilter(layer.id, true, exprToCommit);
            } else if (layer.filterEnabled) {
              onApplyFilter(layer.id, false, '');
            }
            const updated: VectorLayerConfig = {
              ...layer,
              name: editName.trim(),
              ...(['mvt', 'wfs', 'stac'].includes(layer.type) ? { url: editUrl.trim() } : {}),
              opacity: editOpacity,
              lineColor: editLineColor,
              lineWidth: editLineWidth,
              fillColor: editFillColor,
              fontColor: editFontColor,
              fontSize: editFontSize,
              minZoom: parseZoomInput(editMinZoom),
              maxZoom: parseZoomInput(editMaxZoom),
              clusterPoints: editCluster,
              clusterDistance: editClusterDistance,
              filterEnabled: !!exprToCommit,
              filterExpression: exprToCommit };
            onEdit(updated);
            // Applying commits the layer — that also ends any geometry
            // re-edit session on it, exactly like "Done editing".
            if (editingVectorLayerId === layer.id) {
              onReedit(layer.id);
            }
            onCancel();
          }
        }}>Apply</button>
        <button className="settings-button-secondary" onClick={() => {
          onApplyStyle(layer.id, originalStyle);
          onApplyZoomRange(layer.id, originalZoomRange.min, originalZoomRange.max);
          onApplyCluster(layer.id, originalCluster.clusterPoints, originalCluster.clusterDistance);
          setEditCluster(originalCluster.clusterPoints);
          setEditClusterDistance(originalCluster.clusterDistance);
          onApplyFilter(layer.id, originalFilter.enabled, originalFilter.expression);
          setFilterEnabled(originalFilter.enabled);
          setFilterExpr(originalFilter.expression);
          setFilterError(null);
          setFilterTouched(false);
          onCancel();
        }}>Cancel</button>
        {layer.isDrawnInApp && (
          <>
            <button
              className={`settings-button-reedit ${editingVectorLayerId === layer.id ? 'active' : ''}`}
              onClick={() => onReedit(layer.id)}
              title={editingVectorLayerId === layer.id
                ? 'Finish editing the layer'
                : 'Edit this layer on the map \u2014 reshape and move its features, draw new ones straight into it, undo/redo included'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19l5-11 5 5 6-8" />
                <rect x="6.9" y="5.9" width="4.2" height="4.2" fill="#fff" />
              </svg>
              {editingVectorLayerId === layer.id ? 'Done editing' : 'Re-edit layer'}
            </button>
            <div className="settings-export-wrapper" ref={downloadToggleRef}>
              <button
                className={'settings-button-export settings-export-toggle' + (downloadMenu && downloadMenu.layerId === layer.id ? ' open' : '')}
                onClick={(e) => {
                  if (downloadMenu && downloadMenu.layerId === layer.id) {
                    setDownloadMenu(null);
                  } else {
                    openDownloadMenu(layer.id, e.currentTarget);
                  }
                }}
                title="Download this layer’s features"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download
                <svg className="settings-export-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {downloadMenu && downloadMenu.layerId === layer.id && createPortal(
                <div
                  className={'settings-export-menu' + (downloadMenu.top !== undefined ? ' below' : '')}
                  role="menu"
                  ref={downloadMenuRef}
                  style={downloadMenu.bottom !== undefined
                    ? { left: downloadMenu.left, bottom: downloadMenu.bottom }
                    : { left: downloadMenu.left, top: downloadMenu.top }}
                >
                  {VECTOR_EXPORT_FORMATS.map((fmt) => (
                    <button
                      key={fmt.id}
                      role="menuitem"
                      onClick={() => { setDownloadMenu(null); onExport(layer.id, fmt.id); }}
                    >
                      <span className="settings-export-menu-label">{fmt.label}</span>
                      <span className="settings-export-menu-ext">{fmt.extension}</span>
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
