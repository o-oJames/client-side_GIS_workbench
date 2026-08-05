import { useCallback, useEffect, useRef, useState } from 'react';
import View from 'ol/View.js';
import { SplitScreenState, SplitViewPrefs, WorkspaceMeta } from '../types';
import { SPLIT_MIN_PCT, SPLIT_MAX_PCT } from '../constants';
import { getInitialView, loadSplitSettingsPinned, saveSplitSettingsPinned } from '../utils/workspaceStorage';
import { MapPage } from './MapPage';
import { MouseCoordinateDisplay } from './MouseCoordinateDisplay';
import { CloseIcon, GearIcon } from './Icons';

interface SplitScreenProps {
  workspaces: WorkspaceMeta[];
  split: SplitScreenState;
  dividerPct: number;
  /** Bumped on unlock so both panes remount with restored storage. */
  unlockEpoch: number;
  onChangeWorkspace: (side: 'left' | 'right', id: string) => void;
  /** Closing a pane exits split screen; the *other* pane's workspace becomes
   * the normal full-screen workspace. */
  onClosePane: (side: 'left' | 'right') => void;
  onDividerChange: (pct: number) => void;
  /** Split-view-only basic settings (isolated from workspaces, in the URL). */
  splitPrefs: SplitViewPrefs;
  onToggleBasemap: (on: boolean) => void;
  onToggleGrid: (on: boolean) => void;
  onToggleCoords: (on: boolean) => void;
  /** App-lock wiring so the split settings footer matches the normal view. */
  onLockApp: () => void;
  hasLockPassword: boolean;
  onSetPassword: () => void;
  onResetPassword: () => void;
  getLockPassword: () => string | null;
  /** Exit split mode from the settings footer. */
  onExitSplitMode: () => void;
}

const noop = () => {};

/**
 * Swipe-style comparison of two workspaces.
 *
 * Both maps render the WHOLE window — one shared extent whose top-left and
 * bottom-right corners are the window corners — stacked on top of each
 * other, and the divider clips each map to its side. The geography lines up
 * exactly across the divider: drag the divider across a building to see
 * workspace A's data on one side and workspace B's data at the very same
 * location on the other. Panning or zooming either side moves both.
 */
export function SplitScreen({
  workspaces,
  split,
  dividerPct,
  unlockEpoch,
  onChangeWorkspace,
  onClosePane,
  onDividerChange,
  splitPrefs,
  onToggleBasemap,
  onToggleGrid,
  onToggleCoords,
  onLockApp,
  hasLockPassword,
  onSetPassword,
  onResetPassword,
  getLockPassword,
  onExitSplitMode,
}: SplitScreenProps) {
  const [dragging, setDragging] = useState(false);
  // Which workspace's settings the split-level dialog shows (null = closed).
  const [settingsSide, setSettingsSide] = useState<'left' | 'right' | null>(null);

  // One pin state for the whole split-level settings panel (shared by both
  // side tabs) — persisted separately from any workspace's own pin setting,
  // so split mode never writes into workspace settings.
  const [settingsPinned, setSettingsPinned] = useState<boolean>(() => loadSplitSettingsPinned());
  const handleSettingsPinned = useCallback((on: boolean) => {
    setSettingsPinned(on);
    saveSplitSettingsPinned(on);
  }, []);
  const handleSplitSettingsClose = useCallback(() => setSettingsSide(null), []);

  // One shared View for both maps: identical extent and zoom by construction.
  // Created once per split session from the left (primary) workspace's saved
  // view; pane workspace changes remount MapPages but keep this view.
  const sharedViewRef = useRef<View | null>(null);
  if (!sharedViewRef.current) {
    const { center, zoom } = getInitialView(split.left, false);
    sharedViewRef.current = new View({ center, zoom, minZoom: 2, maxZoom: 25 });
  }
  const sharedView = sharedViewRef.current;

  // Pointer coordinates lifted from whichever side the mouse is over, shown
  // in ONE centred display (independent of the divider position).
  const [mouseCoord, setMouseCoord] = useState<[number, number] | null>(null);
  const [coordProjection, setCoordProjection] = useState<string>('EPSG:4326');
  const [coordDecimals, setCoordDecimals] = useState<number>(6);
  const handleMouseCoordinate = useCallback((coordinate: [number, number] | null) => {
    setMouseCoord(coordinate);
  }, []);

  // The divider floats above both maps and would swallow the mouse wheel,
  // so scrolling over it never reaches OpenLayers. Forward wheel events to
  // the left map's viewport — both maps span the whole window and share ONE
  // view, so OL's native MouseWheelZoom takes over: the zoom is anchored at
  // the cursor and both sides zoom together.
  const dividerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dividerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      const viewport = document.querySelector(
        '.split-map-clip[data-split-side="left"] .ol-viewport',
      );
      if (!viewport) return;
      e.preventDefault();
      viewport.dispatchEvent(new WheelEvent('wheel', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        bubbles: true,
        cancelable: true,
      }));
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Divider drag: track the pointer on the window so the drag keeps working
  // over the map canvases; a fixed overlay shields the maps from pointer
  // events (and shows the resize cursor) for the duration of the drag.
  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: MouseEvent) => {
      const pct = (e.clientX / window.innerWidth) * 100;
      onDividerChange(Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct)));
    };
    const handleUp = () => setDragging(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, onDividerChange]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  // One tab per side so the single split-level settings dialog can show
  // either workspace's layer list; each tab also carries the integrated
  // workspace selector for its side.
  const leftName = workspaces.find(w => w.id === split.left)?.name ?? 'Left';
  const rightName = workspaces.find(w => w.id === split.right)?.name ?? 'Right';
  const splitTabs = [
    { id: 'left', label: `Left — ${leftName}`, workspaceId: split.left },
    { id: 'right', label: `Right — ${rightName}`, workspaceId: split.right },
  ];

  const renderMap = (side: 'left' | 'right', workspaceId: string) => (
    <MapPage
      key={`${workspaceId}:${unlockEpoch}`}
      workspaceId={workspaceId}
      workspaces={workspaces}
      splitPane
      splitSide={side}
      mapTargetId={`map-${side}`}
      sharedView={sharedView}
      onMouseCoordinate={handleMouseCoordinate}
      splitSettingsOpen={settingsSide === side}
      onSplitSettingsClose={handleSplitSettingsClose}
      splitSettingsPinned={settingsPinned}
      onSplitSettingsPinned={handleSettingsPinned}
      splitShowBasemap={splitPrefs.basemap}
      splitShowGrid={splitPrefs.grid}
      splitShowCoords={splitPrefs.showCoords}
      onSplitBasemapToggle={onToggleBasemap}
      onSplitGridToggle={onToggleGrid}
      onSplitCoordsToggle={onToggleCoords}
      splitTabs={splitTabs}
      activeSplitTabId={settingsSide ?? undefined}
      onSplitTabChange={(id) => setSettingsSide(id === 'right' ? 'right' : 'left')}
      onSplitTabWorkspaceChange={(tabId, wsId) => onChangeWorkspace(tabId === 'right' ? 'right' : 'left', wsId)}
      onExitSplitMode={onExitSplitMode}
      onSwitchWorkspace={noop}
      onCreateWorkspace={noop}
      onRenameWorkspace={noop}
      onDuplicateWorkspace={noop}
      onDeleteWorkspace={noop}
      onLockApp={onLockApp}
      hasLockPassword={hasLockPassword}
      onSetPassword={onSetPassword}
      onResetPassword={onResetPassword}
      getLockPassword={getLockPassword}
    />
  );

  // Workspace choice lives in the settings panel's tabs now — the header
  // just labels the side and offers the close button.
  const renderHeader = (side: 'left' | 'right', workspaceId: string, otherId: string) => {
    const name = workspaces.find(w => w.id === workspaceId)?.name ?? workspaceId;
    const otherName = workspaces.find(w => w.id === otherId)?.name ?? otherId;
    return (
      <>
        <span
          className="split-pane-name"
          title={`Workspace shown on the ${side} side — change it in Settings`}
        >
          {name}
        </span>
        <button
          type="button"
          className="split-pane-close"
          aria-label={`Close ${side} side`}
          title={`Close split view — ${otherName} becomes the normal workspace`}
          onClick={() => onClosePane(side)}
        >
          <CloseIcon />
        </button>
      </>
    );
  };

  return (
    <div
      className="split-screen"
      style={{ '--split-divider-pct': dividerPct } as React.CSSProperties}
    >
      {/* Map layer: BOTH maps cover the whole window (one shared extent);
          each is clipped to its side of the divider, so the geography is
          continuous across the divider. */}
      <div className="split-map-layer">
        <div
          className="split-map-clip"
          data-split-side="left"
          style={{ clipPath: `inset(0 ${100 - dividerPct}% 0 0)` }}
        >
          {renderMap('left', split.left)}
        </div>
        <div
          className="split-map-clip"
          data-split-side="right"
          style={{ clipPath: `inset(0 0 0 ${dividerPct}%)` }}
        >
          {renderMap('right', split.right)}
        </div>
      </div>

      {/* UI layer: settings gear (same spot as the normal view), divider +
          one header per side, following the divider */}
      <div className="map-settings-wrapper split-settings-wrapper">
        <button
          type="button"
          className="map-settings-button split-settings-button"
          title="Settings"
          aria-label="Split view settings"
          onClick={() => setSettingsSide(prev => (prev ? null : 'left'))}
        >
          <GearIcon />
        </button>
      </div>
      <div
        className="split-pane-header split-pane-header--left"
        style={{ left: `${dividerPct / 2}%`, maxWidth: `calc(${dividerPct}% - 1em)` }}
      >
        {renderHeader('left', split.left, split.right)}
      </div>
      <div
        ref={dividerRef}
        className={`split-divider${dragging ? ' split-divider--dragging' : ''}`}
        style={{ left: `${dividerPct}%` }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to move the comparison divider"
        title="Drag to compare"
        onMouseDown={handleDividerMouseDown}
      />
      <div
        className="split-pane-header split-pane-header--right"
        style={{ left: `${(100 + dividerPct) / 2}%`, maxWidth: `calc(${100 - dividerPct}% - 1em)` }}
      >
        {renderHeader('right', split.right, split.left)}
      </div>

      {/* One coordinate readout for both sides, riding the divider line */}
      {splitPrefs.showCoords && (
        <div className="split-coordinate-display" aria-hidden={mouseCoord === null}>
          <div className="split-coordinate-anchor">
            <MouseCoordinateDisplay
              coordinate={mouseCoord}
              projection={coordProjection}
              onProjectionChange={(proj) => {
                setCoordProjection(proj);
                setCoordDecimals(proj === 'EPSG:4326' ? 6 : 3);
              }}
              decimals={coordDecimals}
              onDecimalsChange={setCoordDecimals}
            />
          </div>
        </div>
      )}
      {dragging && <div className="split-drag-overlay" aria-hidden="true" />}
    </div>
  );
}
