import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomSelectOption, RasterLayer, UnitsSystem } from '../types';
import { CustomSelect } from './CustomSelect';
import { LoadingIndicator } from './LoadingIndicator';
import { CloseIcon, ElevationProfileIcon, PenIcon, TableIcon, TrashIcon } from './Icons';
import { useElevationProfile } from '../hooks/useElevationProfile';
import { downloadCsv } from '../utils/attributeTable';
import {
  buildProfileChart,
  clampElevProfileRect,
  ELEV_PROFILE_DEFAULT_RECT,
  formatProfileDistance,
  formatProfileDistanceTick,
  formatProfileElevation,
  formatProfileElevationTick,
  formatProfileGrade,
  loadElevProfileGeometry,
  PROFILE_FIELDS,
  profileFeatureAttributes,
  profileLineGeoJson,
  profilePointAtDistance,
  profilePointRecords,
  saveElevProfileGeometry,
  terrainRendererOf,
  type ElevProfileRect,
  type ProfilePoint,
  type ProfilePointRecord,
} from '../utils/elevationProfile';

/**
 * Elevation Profile — a floating desktop-OS window over the map, opened from a
 * terrain-rendered raster layer's right-click menu in the Settings panel.
 *
 * The window's Pen button arms a polyline draw on the map (a dashed line, like
 * the scissors tool's cut line). Each finished line is sampled against the
 * layer's own terrain data — the decoded RGB of its terrain tiles, or the
 * elevation band of its COG, read by the same readers that draw the contours
 * and hillshade on screen — and charted here: distance along the ground on x,
 * elevation on y, with the summary numbers (length, min/max, ascent, descent,
 * steepest gradient) underneath and a crosshair that also marks the position
 * on the map.
 *
 * A profile can be saved to the vector layers: the line becomes an ordinary
 * GeoJSON LineString feature whose attributes carry both the summary numbers
 * and every data point behind the chart (`profile_points`), so the attribute
 * table shows exactly what was drawn.
 *
 * All of the map-side work (the line layer, the Draw interaction, the sampling
 * runs) lives in hooks/useElevationProfile; all of the maths lives in
 * utils/elevationProfile. This component is the window: geometry, chrome and
 * the chart.
 */

export interface ElevationProfilePanelProps {
  /** The terrain-rendered raster layer being profiled. */
  layer: RasterLayer;
  /** The OL map; null leaves the window rendered but inert (tests). */
  map: any;
  /** App units, for the distance/elevation readouts. */
  units: UnitsSystem;
  /** Save a profile line as a new vector layer; returns the new layer's id. */
  onSaveLayer: (geoJson: string, name: string) => string | null;
  /** Open a saved profile line's attribute table. */
  onShowAttributeTable?: (layerId: string) => void;
  /** Fires when the Pen armed/disarmed state changes — lets the parent retract
   *  the draw toolbar so the two drawing modes cannot clash. */
  onPenArmedChange?: (armed: boolean) => void;
  onClose: () => void;
  showToast: (message: string, kind?: 'success' | 'error') => void;
  /** Stacking z-index assigned by MapPage's window stack (useWindowStack). */
  zIndex?: number;
  /** Raise this window above its sibling floating windows — fired on any
   *  mouse press inside it, like an OS window manager's click-to-front. */
  onBringToFront?: () => void;
}

type GestureMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Sample-count presets — how finely the line is read. */
const DETAIL_OPTIONS: CustomSelectOption[] = [
  { value: '120', label: 'Coarse (120 points)' },
  { value: '240', label: 'Standard (240 points)' },
  { value: '600', label: 'Fine (600 points)' },
  { value: '1200', label: 'Very fine (1200 points)' },
];

/**
 * Chart size used until the container has been measured. jsdom reports 0×0 for
 * every element, so without a floor the chart (and its tests) would have
 * nothing to draw into; in the browser the measured size replaces it on the
 * first ResizeObserver callback.
 */
const CHART_FALLBACK_W = 620;
const CHART_FALLBACK_H = 240;
const CHART_MIN_MEASURED_W = 120;
const CHART_MIN_MEASURED_H = 80;

function applyGesture(mode: GestureMode, start: ElevProfileRect, dx: number, dy: number): ElevProfileRect {
  let { x, y, w, h } = start;
  if (mode === 'move') {
    x += dx;
    y += dy;
  } else {
    if (mode.includes('e')) w += dx;
    if (mode.includes('s')) h += dy;
    if (mode.includes('w')) { x += dx; w -= dx; }
    if (mode.includes('n')) { y += dy; h -= dy; }
  }
  return { x, y, w, h };
}

export function ElevationProfilePanel({
  layer,
  map,
  units,
  onSaveLayer,
  onShowAttributeTable,
  onPenArmedChange,
  onClose,
  showToast,
  zIndex,
  onBringToFront,
}: ElevationProfilePanelProps) {
  // ----- window geometry (desktop-OS window behaviour) ----------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const containerSizeRef = useRef(containerSize);
  containerSizeRef.current = containerSize;
  const [rect, setRect] = useState<ElevProfileRect>(
    () => loadElevProfileGeometry() ?? ELEV_PROFILE_DEFAULT_RECT,
  );
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const gestureRef = useRef<{ mode: GestureMode; startX: number; startY: number; startRect: ElevProfileRect } | null>(null);

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

  useEffect(() => {
    if (containerSize.w === 0 || containerSize.h === 0) return;
    setRect(prev => clampElevProfileRect(prev, containerSize.w, containerSize.h));
  }, [containerSize]);

  const onGestureMove = useCallback((e: MouseEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const next = applyGesture(g.mode, g.startRect, e.clientX - g.startX, e.clientY - g.startY);
    const { w, h } = containerSizeRef.current;
    const clamped = w > 0 ? clampElevProfileRect(next, w, h) : next;
    // Take the ref straight to the new rect: the gesture ends on a mouseup that
    // can arrive before React has re-rendered, and the ref is what is persisted.
    rectRef.current = clamped;
    setRect(clamped);
  }, []);

  const onGestureEnd = useCallback(() => {
    gestureRef.current = null;
    window.removeEventListener('mousemove', onGestureMove);
    window.removeEventListener('mouseup', onGestureEnd);
    document.body.style.userSelect = '';
    saveElevProfileGeometry(rectRef.current);
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
    if (target.closest('button, select, input, textarea, a')) return;
    beginGesture('move', e);
  }, [beginGesture]);

  // ----- profile session (map side) ----------------------------------------
  const [samples, setSamples] = useState(240);
  const [zeroBaseline, setZeroBaseline] = useState(false);
  const {
    profiles, activeId, activeProfile, penArmed,
    togglePen, selectProfile, removeProfile, clearProfiles, markSaved,
    setHoverDistance,
  } = useElevationProfile({ map, layer, samples });

  // Notify the parent when the pen arms/disarms so it can retract the draw toolbar.
  useEffect(() => {
    onPenArmedChange?.(penArmed);
  }, [penArmed, onPenArmedChange]);

  const renderer = terrainRendererOf(layer);
  const sampling = activeProfile?.status === 'sampling';
  const hasChart = !!activeProfile && activeProfile.points.length >= 2;

  // ----- chart --------------------------------------------------------------
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const [chartBox, setChartBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const node = chartWrapRef.current;
    if (!node) return;
    const measure = () => setChartBox({ w: node.clientWidth, h: node.clientHeight });
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(node);
    }
    return () => { if (ro) ro.disconnect(); };
    // Re-measure whenever the chart area appears or disappears (a window
    // resize is already covered by the ResizeObserver).
  }, [hasChart, activeId]);

  const chartSize = {
    w: chartBox.w >= CHART_MIN_MEASURED_W ? chartBox.w : CHART_FALLBACK_W,
    h: chartBox.h >= CHART_MIN_MEASURED_H ? chartBox.h : CHART_FALLBACK_H,
  };

  const labelDistance = useCallback((m: number) => formatProfileDistanceTick(m, units), [units]);
  const labelElevation = useCallback((m: number) => formatProfileElevationTick(m, units), [units]);

  const chart = useMemo(() => {
    if (!activeProfile || activeProfile.points.length < 2) return null;
    return buildProfileChart(activeProfile.points, {
      width: chartSize.w,
      height: chartSize.h,
      zeroBaseline,
      labelDistance,
      labelElevation,
    });
  }, [activeProfile, chartSize.w, chartSize.h, zeroBaseline, labelDistance, labelElevation]);

  const [hover, setHover] = useState<{ point: ProfilePoint; px: number; py: number } | null>(null);

  const handleChartMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!chart || !activeProfile) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    // The SVG is drawn at exactly chart.width px, so this scale is 1 unless
    // CSS ever scales it; the crosshair snaps to a sample, so the pointer's
    // own y is not used.
    const scaleX = bounds.width > 0 ? chart.width / bounds.width : 1;
    const px = (e.clientX - bounds.left) * scaleX;
    const point = profilePointAtDistance(activeProfile.points, chart.distanceAtX(px));
    if (!point) return;
    setHover({
      point,
      px: chart.xFor(point.distance),
      py: Number.isFinite(point.elevation) ? chart.yFor(point.elevation) : chart.plot.y + chart.plot.h,
    });
    setHoverDistance(point.distance);
  }, [chart, activeProfile, setHoverDistance]);

  const handleChartLeave = useCallback(() => {
    setHover(null);
    setHoverDistance(null);
  }, [setHoverDistance]);

  // ----- saving -------------------------------------------------------------
  const [saveName, setSaveName] = useState('');
  useEffect(() => {
    setSaveName(activeId ? (profiles.find(p => p.id === activeId)?.name ?? '') : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const handleSave = useCallback(() => {
    const record = activeProfile;
    if (!record || record.status !== 'ready' || !record.stats) {
      showToast('There is no finished profile to save yet.', 'error');
      return;
    }
    const name = saveName.trim() || record.name;
    const info = terrainRendererOf(layer);
    const attributes = profileFeatureAttributes({
      name,
      sourceLayer: layer.name,
      renderer: info
        ? `${info.label} · ${info.kind === 'cog' ? 'COG elevation band' : 'terrain tiles'}`
        : 'terrain',
      stats: record.stats,
      points: record.points,
    });
    let newLayerId: string | null = null;
    try {
      newLayerId = onSaveLayer(
        profileLineGeoJson(record.mercator, attributes, profilePointRecords(record.points)),
        name,
      );
    } catch (err) {
      console.error('[ElevationProfile] Save failed:', err);
    }
    if (!newLayerId) {
      showToast(`Could not save "${name}" as a vector layer.`, 'error');
      return;
    }
    markSaved(record.id, newLayerId);
    showToast(
      `"${name}" saved with ${record.stats.sampleCount.toLocaleString('en-US')} profile points in its attributes.`,
      'success',
    );
  }, [activeProfile, saveName, layer, onSaveLayer, markSaved, showToast]);

  const canSave = !!activeProfile && activeProfile.status === 'ready' && !!activeProfile.stats;

  const handleExportCsv = useCallback(() => {
    const record = activeProfile;
    if (!record || record.points.length === 0) return;
    const records: ProfilePointRecord[] = profilePointRecords(record.points);
    const header = [
      PROFILE_FIELDS.pointIndex,
      PROFILE_FIELDS.pointDistance,
      PROFILE_FIELDS.pointElevation,
      PROFILE_FIELDS.pointLon,
      PROFILE_FIELDS.pointLat,
    ];
    const rows: string[] = [header.join(',')];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      rows.push([
        String(i),
        String(r.distance),
        r.elevation !== null ? String(r.elevation) : '',
        String(r.lon),
        String(r.lat),
      ].join(','));
    }
    downloadCsv(rows.join('\r\n'), record.name);
  }, [activeProfile]);

  // ----- readouts -----------------------------------------------------------
  const stats = activeProfile?.stats ?? null;
  const statusParts: string[] = [];
  if (renderer) statusParts.push(`${layer.name} · ${renderer.label}`);
  else statusParts.push(`${layer.name} · no terrain renderer`);
  if (activeProfile?.cellSize) statusParts.push(`grid ≈ ${formatProfileDistance(activeProfile.cellSize, units)}/cell`);
  if (activeProfile?.grid?.detail) statusParts.push(activeProfile.grid.detail);
  if (stats) statusParts.push(`${stats.sampleCount.toLocaleString('en-US')} samples`);
  if (chart && Number.isFinite(chart.exaggeration)) {
    statusParts.push(`vertical exaggeration ×${chart.exaggeration >= 100
      ? Math.round(chart.exaggeration).toLocaleString('en-US')
      : chart.exaggeration.toFixed(1)}`);
  }

  return (
    <div
      ref={rootRef}
      className="ep-window"
      data-testid="elevation-profile-window"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex }}
      onMouseDownCapture={onBringToFront}
    >
      {/* Title bar */}
      <div className="ep-titlebar" onMouseDown={onTitleBarMouseDown}>
        <span className="ep-titlebar-icon"><ElevationProfileIcon /></span>
        <span className="ep-titlebar-title">Elevation Profile</span>
        <span className="ep-titlebar-layer" title={`Terrain source: ${layer.name}`}>{layer.name}</span>
        {renderer && <span className="ep-titlebar-badge">{renderer.label}</span>}
        <span className="ep-titlebar-spacer" />
        <button
          type="button"
          className="ep-winbtn ep-winbtn--close"
          onClick={onClose}
          title="Close"
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Toolbar */}
      <div className="ep-toolbar">
        <button
          type="button"
          className={`ep-toolbtn ep-toolbtn--pen${penArmed ? ' ep-toolbtn--active' : ''}`}
          onClick={togglePen}
          disabled={!map || !renderer}
          title={penArmed
            ? 'Put the pen down (Esc)'
            : 'Draw a profile line on the map: click to add vertices, double-click or Enter to finish'}
          aria-pressed={penArmed}
        >
          <PenIcon />
          <span>Pen</span>
        </button>
        <span className="ep-toolbar-sep" aria-hidden="true" />
        <span className="ep-toolbar-label">Detail</span>
        <CustomSelect
          className="ep-select"
          value={String(samples)}
          onChange={value => setSamples(Number(value) || 240)}
          options={DETAIL_OPTIONS}
        />
        <label className="ep-toolbar-check">
          <input
            type="checkbox"
            checked={zeroBaseline}
            onChange={e => setZeroBaseline(e.target.checked)}
          />
          <span>Zero baseline</span>
        </label>
        <span className="ep-toolbar-spacer" />
        <button
          type="button"
          className="ep-toolbtn"
          onClick={clearProfiles}
          disabled={profiles.length === 0}
          title="Remove every profile line"
        >
          Clear all
        </button>
      </div>

      {penArmed && (
        <div className="ep-hintbar">
          Click the map to start the line, click to add vertices, then double-click or press Enter to
          finish it. Esc abandons the sketch — or puts the pen down.
        </div>
      )}

      {/* One tab per drawn line, once there is more than one */}
      {profiles.length > 1 && (
        <div className="ep-tabs" role="tablist" aria-label="Profile lines">
          {profiles.map(profile => (
            <div
              key={profile.id}
              className={`ep-tab${profile.id === activeId ? ' ep-tab--active' : ''}`}
              title={profile.error ?? profile.name}
            >
              <button
                type="button"
                role="tab"
                aria-selected={profile.id === activeId}
                className="ep-tab-body"
                onClick={() => selectProfile(profile.id)}
              >
                <span className="ep-tab-name">{profile.name}</span>
                <span className="ep-tab-meta">
                  {profile.status === 'sampling'
                    ? 'reading…'
                    : profile.stats
                      ? `${formatProfileDistance(profile.stats.totalDistance, units)} · ${formatProfileElevation(profile.stats.maxElevation - profile.stats.minElevation, units)} relief`
                      : 'no data'}
                </span>
              </button>
              <button
                type="button"
                className="ep-tab-x"
                aria-label={`Remove ${profile.name}`}
                title={`Remove ${profile.name}`}
                onClick={() => removeProfile(profile.id)}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="ep-body">
        {!activeProfile && (
          <div className="ep-empty">
            <span className="ep-empty-icon"><ElevationProfileIcon size={22} /></span>
            <div className="ep-empty-text">No profile line yet</div>
            <div className="ep-empty-hint">
              {renderer
                ? 'Press Pen and draw a line across the terrain. Elevations are read from the same data this layer’s Hillshade / Contours renderer uses.'
                : 'This layer is not using a terrain renderer. Choose Hillshade or Contours in its edit form to profile it.'}
            </div>
          </div>
        )}

        {activeProfile && (
          <>
            <div className="ep-chart-wrap" ref={chartWrapRef} data-testid="ep-chart-wrap">
              {sampling && (
                <div className="ep-chart-busy">
                  <LoadingIndicator message="Reading terrain…" />
                </div>
              )}
              {!sampling && chart && (
                <svg
                  className="ep-chart"
                  data-testid="ep-chart"
                  width={chart.width}
                  height={chart.height}
                  role="img"
                  aria-label={`Elevation profile of ${activeProfile.name}`}
                  onMouseMove={handleChartMove}
                  onMouseLeave={handleChartLeave}
                >
                  <defs>
                    <linearGradient id="ep-chart-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop className="ep-chart-fill-top" offset="0%" />
                      <stop className="ep-chart-fill-bottom" offset="100%" />
                    </linearGradient>
                  </defs>
                  {chart.yTicks.map(tick => (
                    <g key={`y${tick.value}`}>
                      <line
                        className="ep-chart-grid"
                        x1={chart.plot.x}
                        x2={chart.plot.x + chart.plot.w}
                        y1={tick.at}
                        y2={tick.at}
                      />
                      <text className="ep-chart-ylabel" x={chart.plot.x - 6} y={tick.at + 3.5} textAnchor="end">
                        {tick.label}
                      </text>
                    </g>
                  ))}
                  {chart.xTicks.map(tick => (
                    <g key={`x${tick.value}`}>
                      <line
                        className="ep-chart-grid ep-chart-grid--x"
                        x1={tick.at}
                        x2={tick.at}
                        y1={chart.plot.y}
                        y2={chart.plot.y + chart.plot.h}
                      />
                      <text
                        className="ep-chart-xlabel"
                        x={tick.at}
                        y={chart.plot.y + chart.plot.h + 15}
                        textAnchor="middle"
                      >
                        {tick.label}
                      </text>
                    </g>
                  ))}
                  <line
                    className="ep-chart-axis"
                    x1={chart.plot.x}
                    x2={chart.plot.x + chart.plot.w}
                    y1={chart.plot.y + chart.plot.h}
                    y2={chart.plot.y + chart.plot.h}
                  />
                  <line
                    className="ep-chart-axis"
                    x1={chart.plot.x}
                    x2={chart.plot.x}
                    y1={chart.plot.y}
                    y2={chart.plot.y + chart.plot.h}
                  />
                  {chart.areas.map((d, i) => (
                    <path key={`area-${i}`} className="ep-chart-area" d={d} fill="url(#ep-chart-fill)" />
                  ))}
                  {chart.segments.map((d, i) => (
                    <path key={`line-${i}`} className="ep-chart-line" d={d} />
                  ))}
                  {stats && Number.isFinite(stats.maxElevation) && (
                    <g>
                      <circle
                        className="ep-chart-marker ep-chart-marker--max"
                        cx={chart.xFor(stats.maxAt)}
                        cy={chart.yFor(stats.maxElevation)}
                        r={3}
                      />
                      <circle
                        className="ep-chart-marker ep-chart-marker--min"
                        cx={chart.xFor(stats.minAt)}
                        cy={chart.yFor(stats.minElevation)}
                        r={3}
                      />
                    </g>
                  )}
                  {hover && (
                    <g>
                      <line
                        className="ep-chart-crosshair"
                        x1={hover.px}
                        x2={hover.px}
                        y1={chart.plot.y}
                        y2={chart.plot.y + chart.plot.h}
                      />
                      <circle className="ep-chart-hoverdot" cx={hover.px} cy={hover.py} r={4} />
                    </g>
                  )}
                </svg>
              )}
              {!sampling && !chart && (
                <div className="ep-chart-empty">
                  {activeProfile.status === 'error'
                    ? 'No elevations to chart.'
                    : 'Nothing sampled yet.'}
                </div>
              )}
              {hover && chart && (
                <div
                  className="ep-chart-tooltip"
                  style={{
                    left: Math.min(Math.max(hover.px, 60), Math.max(60, chart.width - 60)),
                    top: Math.max(4, hover.py - 46),
                  }}
                >
                  <span className="ep-chart-tooltip-dist">{formatProfileDistance(hover.point.distance, units)}</span>
                  <span className="ep-chart-tooltip-elev">
                    {Number.isFinite(hover.point.elevation)
                      ? formatProfileElevation(hover.point.elevation, units)
                      : 'no data'}
                  </span>
                </div>
              )}
            </div>

            {activeProfile.status === 'error' && activeProfile.error && (
              <div className="ep-error" role="alert">{activeProfile.error}</div>
            )}

            {stats && (
              <div className="ep-stats" data-testid="ep-stats">
                <div className="ep-stat">
                  <span className="ep-stat-label">Length</span>
                  <span className="ep-stat-value">{formatProfileDistance(stats.totalDistance, units)}</span>
                </div>
                <div className="ep-stat">
                  <span className="ep-stat-label">Min elev.</span>
                  <span className="ep-stat-value">{formatProfileElevation(stats.minElevation, units)}</span>
                  <span className="ep-stat-sub">at {formatProfileDistance(stats.minAt, units)}</span>
                </div>
                <div className="ep-stat">
                  <span className="ep-stat-label">Max elev.</span>
                  <span className="ep-stat-value">{formatProfileElevation(stats.maxElevation, units)}</span>
                  <span className="ep-stat-sub">at {formatProfileDistance(stats.maxAt, units)}</span>
                </div>
                <div className="ep-stat">
                  <span className="ep-stat-label">Ascent</span>
                  <span className="ep-stat-value">{formatProfileElevation(stats.ascent, units)}</span>
                </div>
                <div className="ep-stat">
                  <span className="ep-stat-label">Descent</span>
                  <span className="ep-stat-value">{formatProfileElevation(stats.descent, units)}</span>
                </div>
                <div className="ep-stat">
                  <span className="ep-stat-label">Steepest</span>
                  <span className="ep-stat-value">{formatProfileGrade(stats.maxGradePercent)}</span>
                </div>
                {stats.missingCount > 0 && (
                  <div className="ep-stat ep-stat--warning" title={`Longest gap without data: ${formatProfileDistance(stats.longestGap, units)}`}>
                    <span className="ep-stat-label">No data</span>
                    <span className="ep-stat-value">{stats.missingCount.toLocaleString('en-US')} pts</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Save row */}
      <div className="ep-saverow">
        <input
          type="text"
          className="ep-name-input"
          value={saveName}
          onChange={e => setSaveName(e.target.value)}
          placeholder="Layer name"
          aria-label="Saved layer name"
          disabled={!canSave}
        />
        <button
          type="button"
          className="ep-savebtn"
          onClick={handleSave}
          disabled={!canSave}
          title="Save this line to the vector layers, with the profile points as its attributes"
        >
          Save to layer
        </button>
        <button
          type="button"
          className="ep-savebtn"
          onClick={handleExportCsv}
          disabled={!activeProfile || activeProfile.points.length === 0}
          title="Download the profile point data as a CSV file"
        >
          Export CSV
        </button>
        {activeProfile?.savedLayerId && onShowAttributeTable && (
          <button
            type="button"
            className="ep-toolbtn"
            onClick={() => onShowAttributeTable(activeProfile.savedLayerId as string)}
            title="Open the saved layer's attribute table"
          >
            <TableIcon size={13} />
            <span>Attributes</span>
          </button>
        )}
        <button
          type="button"
          className="ep-toolbtn ep-toolbtn--danger"
          onClick={() => activeProfile && removeProfile(activeProfile.id)}
          disabled={!activeProfile}
          title="Remove this profile line from the map"
        >
          <TrashIcon />
          <span>Remove</span>
        </button>
      </div>

      {/* Status bar */}
      <div className="ep-statusbar">
        <span className="ep-statusbar-text" title={statusParts.join(' · ')}>{statusParts.join(' · ')}</span>
        <span className="ep-statusbar-spacer" />
        <span className="ep-statusbar-hint">
          {penArmed ? 'Pen armed' : `${profiles.length} line${profiles.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Resize handles */}
      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as GestureMode[]).map(mode => (
        <div
          key={mode}
          className={`ep-resize ep-resize-${mode}`}
          onMouseDown={e => beginGesture(mode, e)}
        />
      ))}
    </div>
  );
}
