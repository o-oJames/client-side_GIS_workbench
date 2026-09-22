import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  RasterLayer,
  LayerGroup,
  VectorLayerConfig,
  SettingsDialogProps,
  VectorExportFormat, ExportOptions } from '../types';
import { TILE_ZOOM_MIN, TILE_ZOOM_MAX } from '../constants';
import {
  LockIcon,
  PinIcon,
  PencilIcon,
  EyeIcon,
  ZoomToExtentIcon,
  FolderIcon,
  FolderPlusIcon,
  GroupEyeIcon,
  KeyIcon,
  ResetKeyIcon,
  SunIcon,
  MoonIcon,
  SplitScreenIcon,
  GeoProcessingIcon,
  CheckIcon,
  CloseIcon,
  TableIcon,
  FunnelIcon,
  CopyIcon,
  DownloadIcon,
  ElevationProfileIcon,
  SearchIcon } from './Icons';
import { LoadingIndicator } from './LoadingIndicator';
import { AddRasterLayerForm } from './AddRasterLayerForm';
import { AddVectorLayerForm } from './AddVectorLayerForm';
import { RasterLayerEditForm } from './RasterLayerEditForm';
import { VectorLayerEditForm } from './VectorLayerEditForm';
import { WorkspaceSelector } from './WorkspaceSelector';
import { ExportPopup } from './ExportPopup';
import { SplitTabWorkspaceDropdown } from './SplitTabWorkspaceDropdown';
import {
  buildLayerPanelItems,
  makeGroupId,
  GroupAssignMenu,
  spanActivate } from './LayerPanel';
import { useLayerDragReorder } from '../hooks/useLayerDragReorder';
import { terrainRendererOf } from '../utils/elevationProfile';

export function SettingsDialog({ 
  onClose, 
  onEnterSplitScreen,
  onOpenGeoProcessing,
  splitPaneMode = false,
  splitTabs,
  activeSplitTabId,
  onSplitTabChange,
  panelHidden = false,
  noRevealAnimation = false,
  onSplitTabWorkspaceChange,
  onExitSplitMode,
  pinned,
  onPinToggle,
  showBasemap,
  onBasemapToggle,
  showGrid, 
  onGridToggle,
  showDrawToolbar,
  onDrawToolbarToggle,
  showCoordinates,
  onCoordinatesToggle,
  rasterLayers,
  rasterGroups,
  onUpdateRasterGroups,
  onToggleRasterGroup,
  onMoveRasterLayerToGroup,
  onAddRasterLayer,
  onEditRasterLayer,
  onRemoveRasterLayer,
  onToggleRasterLayer,
  onApplyColorAdjustments,
  onApplyTileZoomRange,
  onApplyCogRender,
  onApplyTileRender,
  vectorLayers,
  vectorGroups,
  onUpdateVectorGroups,
  onToggleVectorGroup,
  onMoveVectorLayerToGroup,
  onToggleVectorLayer,
  onRemoveVectorLayer,
  onEditVectorLayer,
  onApplyVectorStyle,
  onApplyVectorZoomRange,
  onApplyVectorCluster,
  onApplyVectorFilter,
  onApplyVectorAttrRender,
  onApplyVectorFeatureStyle,
  onToggleVectorFeatureMeasurements,
  onToggleVectorFeatureNameLabel,
  onReorderRasterLayers,
  onReorderVectorLayers,
  onAddVectorLayer,
  onAddMVTLayer,
  onAddWFSLayer,
  onAddSTACLayer,
  onAddPostgisLayer,
  connectorUrl,
  getLockPassword,
  onReconnectPostgisLayer,
  onExportVectorLayer,
  onShowAttributeTable,
  onShowElevationProfile,
  onReeditVectorLayer,
  editingVectorLayerId,
  onGoToVectorLayerExtent,
  onGoToRasterLayerExtent,
  onDuplicateRasterLayer,
  onDuplicateVectorLayer,
  onAdvancedSettings,
  knownSources,
  isRestoringLayers,
  loadingVectorIds,
  units,
  workspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDuplicateWorkspace,
  onDeleteWorkspace,
  onLockApp,
  hasLockPassword,
  onSetPassword,
  onResetPassword,
  theme = 'light',
  onToggleTheme }: SettingsDialogProps) {
  // ----- Theme toggle (the footer button right of the lock button) -----
  // One flag drives the glyph, the tooltip and the aria labels below.
  const dark = theme === 'dark';

  // ----- Lock icon right-click menu (Set / Reset password) -----
  const lockButtonRef = useRef<HTMLButtonElement>(null);
  const lockMenuRef = useRef<HTMLDivElement>(null);
  // Viewport-anchored position (fixed) of the menu; null = closed.
  const [lockMenuPos, setLockMenuPos] = useState<{ left: number; bottom: number } | null>(null);

  const closeLockMenu = useCallback(() => setLockMenuPos(null), []);

  const openLockMenu = useCallback((e: React.MouseEvent) => {
    // Suppress the native menu and anchor ours just above the lock button.
    e.preventDefault();
    e.stopPropagation();
    const rect = lockButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const MENU_WIDTH = 208;
    const MARGIN = 8;
    let left = rect.left;
    const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;
    setLockMenuPos({ left, bottom: window.innerHeight - rect.top + 6 });
  }, []);

  const handleLockMenuSet = useCallback(() => { closeLockMenu(); onSetPassword(); }, [closeLockMenu, onSetPassword]);
  const handleLockMenuReset = useCallback(() => { closeLockMenu(); onResetPassword(); }, [closeLockMenu, onResetPassword]);

  // Dismiss the menu on any outside interaction, Escape or resize. (No scroll
  // listener: the app viewport does not scroll and the footer anchor is fixed.)
  useEffect(() => {
    if (!lockMenuPos) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (lockMenuRef.current?.contains(t)) return;
      if (lockButtonRef.current?.contains(t)) return; // button re-toggles itself
      closeLockMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLockMenu(); };
    const onReposition = () => closeLockMenu();
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
    };
  }, [lockMenuPos, closeLockMenu]);

  // ----- Split button right-click menu (pick the two workspaces) -----
  const splitButtonRef = useRef<HTMLButtonElement>(null);
  const splitMenuRef = useRef<HTMLDivElement>(null);
  // Viewport-anchored position (fixed) of the menu; null = closed.
  const [splitMenuPos, setSplitMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  // Ordered picks: index 0 = left pane, index 1 = right pane.
  const [splitMenuPicks, setSplitMenuPicks] = useState<string[]>([]);

  const closeSplitMenu = useCallback(() => setSplitMenuPos(null), []);

  const openSplitMenu = useCallback((e: React.MouseEvent) => {
    // Suppress the native menu and anchor ours just above the split button.
    e.preventDefault();
    e.stopPropagation();
    const rect = splitButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const MENU_WIDTH = 240;
    const MARGIN = 8;
    let left = rect.left;
    const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;
    setSplitMenuPicks([]);
    setSplitMenuPos({ left, bottom: window.innerHeight - rect.top + 6 });
  }, []);

  /** Toggle a workspace pick; a third pick replaces the earliest one so the
   * user never has to uncheck first. */
  const toggleSplitMenuPick = useCallback((id: string) => {
    setSplitMenuPicks(prev => {
      if (prev.includes(id)) return prev.filter(p => p !== id);
      if (prev.length < 2) return [...prev, id];
      return [prev[1], id];
    });
  }, []);

  const applySplitMenu = useCallback(() => {
    if (splitMenuPicks.length !== 2 || !onEnterSplitScreen) return;
    onEnterSplitScreen(splitMenuPicks[0], splitMenuPicks[1]);
    setSplitMenuPos(null);
  }, [splitMenuPicks, onEnterSplitScreen]);

  // Dismiss the menu on any outside interaction, Escape or resize — same
  // pattern as the lock menu.
  useEffect(() => {
    if (!splitMenuPos) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (splitMenuRef.current?.contains(t)) return;
      if (splitButtonRef.current?.contains(t)) return; // button re-toggles itself
      closeSplitMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSplitMenu(); };
    const onReposition = () => closeSplitMenu();
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
    };
  }, [splitMenuPos, closeSplitMenu]);

  const [editingId, setEditingId] = useState<string | null>(null);

  // ----- Multi-select mode for raster/vector layer lists -----
  // Per-kind sets of selected layer IDs. When more than one layer is selected
  // in a kind, right-clicking any selected layer shows a multi-select context
  // menu (toggle visibility, group, move to top/bottom). Dragging a selected
  // layer while multi-selected moves the whole selection into a folder
  // (reorder is disabled in multi-select mode).
  const [selectedRasterIds, setSelectedRasterIds] = useState<Set<string>>(new Set());
  const [selectedVectorIds, setSelectedVectorIds] = useState<Set<string>>(new Set());
  // Layer-list search (per-section). When active, only layers whose name
  // matches the query are shown; the section background changes to signal
  // that the list is filtered.
  const [rasterSearchActive, setRasterSearchActive] = useState(false);
  const [rasterSearchQuery, setRasterSearchQuery] = useState("");
  const [vectorSearchActive, setVectorSearchActive] = useState(false);
  const [vectorSearchQuery, setVectorSearchQuery] = useState("");
  const rasterSearchInputRef = useRef<HTMLInputElement>(null);
  const vectorSearchInputRef = useRef<HTMLInputElement>(null);
  // Multi-select context menu state (null = closed).
  const [multiCtxMenu, setMultiCtxMenu] = useState<{
    kind: 'raster' | 'vector';
    left: number;
    top: number;
  } | null>(null);
  const multiCtxMenuRef = useRef<HTMLDivElement>(null);
  // Inline rename for the "group selected" action.
  const [multiGroupRename, setMultiGroupRename] = useState<{ kind: 'raster' | 'vector' } | null>(null);
  const [multiGroupNewName, setMultiGroupNewName] = useState('');
  // Anchor for shift-click range selection (last clicked layer per kind)
  const selectionAnchorRef = useRef<{ raster: string | null; vector: string | null }>({ raster: null, vector: null });
  // Seeded from the active geometry re-edit session on the panel's first
  // mount, so a dialog opened mid-session shows the edited layer's editor
  // section straight away.
  const [vectorEditingId, setVectorEditingId] = useState<string | null>(editingVectorLayerId ?? null);
  // Bumped when the panel becomes visible while a geometry edit session is
  // live: the edit form scrolls its Edit geometry button into view on the
  // signal. The dialog stays mounted across visibility toggles (both in split
  // mode and in the normal view, where closing only hides it), so the initial
  // state above never re-runs — this is what re-reveals the form on reopen.
  const [reeditRevealTick, setReeditRevealTick] = useState(0);
  const prevPanelHiddenRef = useRef(panelHidden);
  // Grouped "Download" menu on drawn vector layers (null = closed). It is
  // rendered through a portal at position:fixed — exactly like the lock menu
  // — so it floats above the dialog instead of stretching the dialog body's
  // scrollable area; an absolutely-positioned menu inside that scroll
  // container forced a horizontal scrollbar the moment it poked past an edge.
  const [downloadMenu, setDownloadMenu] = useState<{ layerId: string; left: number; bottom?: number; top?: number } | null>(null);
  const downloadToggleRef = useRef<HTMLDivElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);


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

  // ----- Layer right-click context menu (raster & vector) -----
  // Viewport-anchored (position:fixed) portal menu, same pattern as the lock
  // and download menus above. null = closed.
  const [layerCtxMenu, setLayerCtxMenu] = useState<{
    kind: 'raster' | 'vector';
    layerId: string;
    left: number;
    top: number;
  } | null>(null);
  const layerCtxMenuRef = useRef<HTMLDivElement>(null);
  // Export popup state for the "Download" context menu action (null = closed).
  const [ctxExportPopup, setCtxExportPopup] = useState<{
    layerId: string;
  } | null>(null);

  // The panel is only hidden when closed (it stays mounted so a half-filled
  // add-layer form survives), but the portalled overlays below are anchored to
  // the viewport rather than to this dialog — hiding the panel would leave them
  // floating over the map. Dismiss them the moment the panel goes invisible.
  useEffect(() => {
    if (!panelHidden) return;
    setLockMenuPos(null);
    setSplitMenuPos(null);
    setDownloadMenu(null);
    setLayerCtxMenu(null);
    setCtxExportPopup(null);
  }, [panelHidden]);

  const closeLayerCtxMenu = useCallback(() => setLayerCtxMenu(null), []);

  // ----- Multi-select helpers -----
  const selectedIdsOf = (kind: 'raster' | 'vector') => kind === 'raster' ? selectedRasterIds : selectedVectorIds;
  const setSelectedIdsOf = (kind: 'raster' | 'vector', next: Set<string>) => {
    if (kind === 'raster') setSelectedRasterIds(next);
    else setSelectedVectorIds(next);
  };
  const toggleLayerSelection = (kind: 'raster' | 'vector', layerId: string) => {
    setSelectedIdsOf(kind, new Set([...selectedIdsOf(kind)].filter(id => id !== layerId).concat(
      selectedIdsOf(kind).has(layerId) ? [] : [layerId]
    )));
  };
  const isLayerSelected = (kind: 'raster' | 'vector', layerId: string) => selectedIdsOf(kind).has(layerId);
  const multiCountOf = (kind: 'raster' | 'vector') => selectedIdsOf(kind).size;
  // Clear selection when the panel hides or workspace changes.
  const prevPanelHiddenForSelRef = useRef(panelHidden);
  const prevWorkspaceIdForSelRef = useRef(workspaceId);
  useEffect(() => {
    if (panelHidden && !prevPanelHiddenForSelRef.current) {
      setSelectedRasterIds(new Set());
      setSelectedVectorIds(new Set());
      setMultiCtxMenu(null);
    }
    prevPanelHiddenForSelRef.current = panelHidden;
    if (workspaceId !== prevWorkspaceIdForSelRef.current) {
      setSelectedRasterIds(new Set());
      setSelectedVectorIds(new Set());
      setMultiCtxMenu(null);
    }
    prevWorkspaceIdForSelRef.current = workspaceId;
  }, [panelHidden, workspaceId]);

  // Clean up stale selection IDs when layers are removed.
  useEffect(() => {
    const rasterIds = new Set(rasterLayers.map(l => l.id));
    setSelectedRasterIds(prev => {
      const next = new Set([...prev].filter(id => rasterIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    const vectorIds = new Set(vectorLayers.map(l => l.id));
    setSelectedVectorIds(prev => {
      const next = new Set([...prev].filter(id => vectorIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rasterLayers, vectorLayers]);

  // Handle row click for selection (Ctrl/Meta toggles, Shift selects range, plain click clears and selects one)
  const handleLayerRowClick = (kind: 'raster' | 'vector', layerId: string, e: React.MouseEvent) => {
    // Don't interfere with clicks on interactive controls inside the row.
    const target = e.target as HTMLElement;
    if (target.closest('button, input, .group-assign, [role="button"]')) return;

    const layers = kind === 'raster' ? rasterLayers : vectorLayers;
    const groups = kind === 'raster' ? rasterGroups : vectorGroups;

    if (e.shiftKey) {
      // Shift-click: select range from anchor to clicked layer
      const anchor = selectionAnchorRef.current[kind];
      if (anchor) {
        // Get panel order (flattened list of layer IDs) - handle each kind separately for type safety
        const orderedIds: string[] = [];
        if (kind === 'raster') {
          const items = buildLayerPanelItems(rasterLayers, rasterGroups);
          for (const item of items) {
            if (item.kind === 'layer') {
              orderedIds.push(item.layer.id);
            } else {
              for (const member of item.members) {
                orderedIds.push(member.id);
              }
            }
          }
        } else {
          const items = buildLayerPanelItems(vectorLayers, vectorGroups);
          for (const item of items) {
            if (item.kind === 'layer') {
              orderedIds.push(item.layer.id);
            } else {
              for (const member of item.members) {
                orderedIds.push(member.id);
              }
            }
          }
        }

        const anchorIdx = orderedIds.indexOf(anchor);
        const clickedIdx = orderedIds.indexOf(layerId);

        if (anchorIdx !== -1 && clickedIdx !== -1) {
          const start = Math.min(anchorIdx, clickedIdx);
          const end = Math.max(anchorIdx, clickedIdx);
          const rangeIds = orderedIds.slice(start, end + 1);
          setSelectedIdsOf(kind, new Set(rangeIds));
        } else {
          // Anchor or clicked not in panel (shouldn't happen), fallback to just selecting clicked
          setSelectedIdsOf(kind, new Set([layerId]));
          selectionAnchorRef.current = { ...selectionAnchorRef.current, [kind]: layerId };
        }
      } else {
        // No anchor yet, just select this layer and set it as anchor
        setSelectedIdsOf(kind, new Set([layerId]));
        selectionAnchorRef.current = { ...selectionAnchorRef.current, [kind]: layerId };
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Meta-click: toggle this layer
      toggleLayerSelection(kind, layerId);
      selectionAnchorRef.current = { ...selectionAnchorRef.current, [kind]: layerId };
    } else {
      // Plain click: clear other selections and select this one.
      setSelectedIdsOf(kind, new Set([layerId]));
      selectionAnchorRef.current = { ...selectionAnchorRef.current, [kind]: layerId };
    }
  };

  // Handle checkbox change for multi-select.
  const handleCheckboxChange = (kind: 'raster' | 'vector', layerId: string, checked: boolean) => {
    const current = new Set(selectedIdsOf(kind));
    if (checked) current.add(layerId);
    else current.delete(layerId);
    setSelectedIdsOf(kind, current);
    // Update anchor to this layer (for subsequent shift-clicks)
    selectionAnchorRef.current = { ...selectionAnchorRef.current, [kind]: layerId };
  };

  // Multi-select context menu open/close.
  const closeMultiCtxMenu = useCallback(() => setMultiCtxMenu(null), []);
  const openMultiCtxMenu = useCallback((kind: 'raster' | 'vector', e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 240;
    const MENU_H = 200;
    const MARGIN = 8;
    let left = e.clientX;
    let top = e.clientY;
    if (left + MENU_W > window.innerWidth - MARGIN) left = window.innerWidth - MENU_W - MARGIN;
    if (left < MARGIN) left = MARGIN;
    if (top + MENU_H > window.innerHeight - MARGIN) top = window.innerHeight - MENU_H - MARGIN;
    if (top < MARGIN) top = MARGIN;
    setMultiCtxMenu({ kind, left, top });
  }, []);

  // Dismiss multi-select context menu on outside click/Escape/scroll/resize.
  useEffect(() => {
    if (!multiCtxMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (multiCtxMenuRef.current?.contains(e.target as Node)) return;
      closeMultiCtxMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMultiCtxMenu(); };
    const onScroll = (e: Event) => {
      if (multiCtxMenuRef.current?.contains(e.target as Node)) return;
      closeMultiCtxMenu();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeMultiCtxMenu);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeMultiCtxMenu);
    };
  }, [multiCtxMenu, closeMultiCtxMenu]);

  // Multi-select context menu action handlers.
  const handleMultiToggleVisibility = useCallback((visible: boolean) => {
    if (!multiCtxMenu) return;
    const kind = multiCtxMenu.kind;
    const ids = selectedIdsOf(kind);
    if (kind === 'raster') {
      ids.forEach(id => {
        const layer = rasterLayers.find(l => l.id === id);
        if (layer && (layer.visible !== false) !== visible) onToggleRasterLayer(id);
      });
    } else {
      ids.forEach(id => {
        const layer = vectorLayers.find(l => l.id === id);
        if (layer && layer.visible !== visible) onToggleVectorLayer(id);
      });
    }
    closeMultiCtxMenu();
  }, [multiCtxMenu, selectedRasterIds, selectedVectorIds, rasterLayers, vectorLayers, onToggleRasterLayer, onToggleVectorLayer, closeMultiCtxMenu]);

  const handleMultiClearSelection = useCallback(() => {
    if (!multiCtxMenu) return;
    setSelectedIdsOf(multiCtxMenu.kind, new Set());
    selectionAnchorRef.current = { ...selectionAnchorRef.current, [multiCtxMenu.kind]: null };
    closeMultiCtxMenu();
  }, [multiCtxMenu, closeMultiCtxMenu]);

  const handleMultiGroupSelected = useCallback((name: string) => {
    if (!multiCtxMenu) return;
    const kind = multiCtxMenu.kind;
    const ids = selectedIdsOf(kind);
    const groupId = makeGroupId();
    const newGroup: LayerGroup = { id: groupId, name, expanded: true };
    if (kind === 'raster') {
      onUpdateRasterGroups([...rasterGroups, newGroup]);
      // Move each selected layer into the new group.
      let layers = rasterLayers;
      ids.forEach(id => {
        layers = layers.map(l => l.id === id ? { ...l, groupId } : l);
      });
      onReorderRasterLayers(layers);
    } else {
      onUpdateVectorGroups([...vectorGroups, newGroup]);
      let layers = vectorLayers;
      ids.forEach(id => {
        layers = layers.map(l => l.id === id ? { ...l, groupId } : l);
      });
      onReorderVectorLayers(layers);
    }
    setSelectedIdsOf(kind, new Set());
    closeMultiCtxMenu();
  }, [multiCtxMenu, selectedRasterIds, selectedVectorIds, rasterLayers, vectorLayers, rasterGroups, vectorGroups, onUpdateRasterGroups, onUpdateVectorGroups, onReorderRasterLayers, onReorderVectorLayers, closeMultiCtxMenu]);

  const handleMultiMoveToTop = useCallback(() => {
    if (!multiCtxMenu) return;
    const kind = multiCtxMenu.kind;
    const ids = selectedIdsOf(kind);
    if (kind === 'raster') {
      const selected = rasterLayers.filter((l: RasterLayer) => ids.has(l.id));
      const rest = rasterLayers.filter((l: RasterLayer) => !ids.has(l.id));
      onReorderRasterLayers([...selected, ...rest]);
    } else {
      const selected = vectorLayers.filter((l: VectorLayerConfig) => ids.has(l.id));
      const rest = vectorLayers.filter((l: VectorLayerConfig) => !ids.has(l.id));
      onReorderVectorLayers([...selected, ...rest]);
    }
    closeMultiCtxMenu();
  }, [multiCtxMenu, selectedRasterIds, selectedVectorIds, rasterLayers, vectorLayers, onReorderRasterLayers, onReorderVectorLayers, closeMultiCtxMenu]);

  const handleMultiMoveToBottom = useCallback(() => {
    if (!multiCtxMenu) return;
    const kind = multiCtxMenu.kind;
    const ids = selectedIdsOf(kind);
    if (kind === 'raster') {
      const selected = rasterLayers.filter((l: RasterLayer) => ids.has(l.id));
      const rest = rasterLayers.filter((l: RasterLayer) => !ids.has(l.id));
      onReorderRasterLayers([...rest, ...selected]);
    } else {
      const selected = vectorLayers.filter((l: VectorLayerConfig) => ids.has(l.id));
      const rest = vectorLayers.filter((l: VectorLayerConfig) => !ids.has(l.id));
      onReorderVectorLayers([...rest, ...selected]);
    }
    closeMultiCtxMenu();
  }, [multiCtxMenu, selectedRasterIds, selectedVectorIds, rasterLayers, vectorLayers, onReorderRasterLayers, onReorderVectorLayers, closeMultiCtxMenu]);

  const openLayerCtxMenu = useCallback((kind: 'raster' | 'vector', layerId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Position the menu at the cursor; clamp to viewport edges.
    const MENU_W = 224;
    const MENU_H = 200; // approximate max height
    const MARGIN = 8;
    let left = e.clientX;
    let top = e.clientY;
    if (left + MENU_W > window.innerWidth - MARGIN) left = window.innerWidth - MENU_W - MARGIN;
    if (left < MARGIN) left = MARGIN;
    if (top + MENU_H > window.innerHeight - MARGIN) top = window.innerHeight - MENU_H - MARGIN;
    if (top < MARGIN) top = MARGIN;
    // If this layer is part of a multi-selection (>1 selected in this kind),
    // show the multi-select context menu instead of the single-layer one.
    const sel = kind === 'raster' ? selectedRasterIds : selectedVectorIds;
    if (sel.size > 1 && sel.has(layerId)) {
      openMultiCtxMenu(kind, e);
      return;
    }
    setLayerCtxMenu({ kind, layerId, left, top });
  }, [selectedRasterIds, selectedVectorIds, openMultiCtxMenu]);

  // Dismiss on outside click, Escape, scroll, or resize.
  useEffect(() => {
    if (!layerCtxMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (layerCtxMenuRef.current?.contains(e.target as Node)) return;
      closeLayerCtxMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLayerCtxMenu(); };
    const onScroll = (e: Event) => {
      if (layerCtxMenuRef.current?.contains(e.target as Node)) return;
      closeLayerCtxMenu();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeLayerCtxMenu);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeLayerCtxMenu);
    };
  }, [layerCtxMenu, closeLayerCtxMenu]);

  // Context-menu action handlers
  const handleCtxZoomToExtent = useCallback(() => {
    if (!layerCtxMenu) return;
    if (layerCtxMenu.kind === 'raster') onGoToRasterLayerExtent(layerCtxMenu.layerId);
    else onGoToVectorLayerExtent(layerCtxMenu.layerId);
    closeLayerCtxMenu();
  }, [layerCtxMenu, onGoToRasterLayerExtent, onGoToVectorLayerExtent, closeLayerCtxMenu]);

  const handleCtxDuplicate = useCallback(() => {
    if (!layerCtxMenu) return;
    if (layerCtxMenu.kind === 'raster') onDuplicateRasterLayer(layerCtxMenu.layerId);
    else onDuplicateVectorLayer(layerCtxMenu.layerId);
    closeLayerCtxMenu();
  }, [layerCtxMenu, onDuplicateRasterLayer, onDuplicateVectorLayer, closeLayerCtxMenu]);

  const handleCtxOpenAttributeTable = useCallback(() => {
    if (!layerCtxMenu) return;
    if (onShowAttributeTable) onShowAttributeTable(layerCtxMenu.layerId);
    closeLayerCtxMenu();
  }, [layerCtxMenu, onShowAttributeTable, closeLayerCtxMenu]);

  const handleCtxElevationProfile = useCallback(() => {
    if (!layerCtxMenu) return;
    if (onShowElevationProfile) onShowElevationProfile(layerCtxMenu.layerId);
    closeLayerCtxMenu();
  }, [layerCtxMenu, onShowElevationProfile, closeLayerCtxMenu]);

  const handleCtxDownload = useCallback(() => {
    if (!layerCtxMenu) return;
    setCtxExportPopup({
      layerId: layerCtxMenu.layerId,
    });
    closeLayerCtxMenu();
  }, [layerCtxMenu, closeLayerCtxMenu]);

  const handleCtxExportConfirm = useCallback((format: VectorExportFormat, targetCrs: string, options?: ExportOptions) => {
    if (!ctxExportPopup) return;
    if (onExportVectorLayer) onExportVectorLayer(ctxExportPopup.layerId, format, targetCrs, options);
    setCtxExportPopup(null);
  }, [ctxExportPopup, onExportVectorLayer]);

  const handleCtxEditGeometry = useCallback(() => {
    if (!layerCtxMenu) return;
    onReeditVectorLayer(layerCtxMenu.layerId);
    closeLayerCtxMenu();
  }, [layerCtxMenu, onReeditVectorLayer, closeLayerCtxMenu]);

  // All layer/group drag-reorder state + handlers (row drags, group-header
  // drags, group/section/end-of-list drop targets, hover-expand) live in the
  // useLayerDragReorder hook, which manages both kinds with shared internals.
  const dnd = useLayerDragReorder({
    raster: {
      layers: rasterLayers,
      groups: rasterGroups,
      onReorderLayers: onReorderRasterLayers,
      onUpdateGroups: onUpdateRasterGroups,
      onMoveLayerToGroup: onMoveRasterLayerToGroup,
    },
    vector: {
      layers: vectorLayers,
      groups: vectorGroups,
      onReorderLayers: onReorderVectorLayers,
      onUpdateGroups: onUpdateVectorGroups,
      onMoveLayerToGroup: onMoveVectorLayerToGroup,
    },
  });

  // Layer-group (folder) UI state: which group is being renamed inline.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');


  // "Add from known source" state





  /**
   * Fetch the WFS GetCapabilities document for the given URL and extract the
   * advertised feature types (Name + Title) to populate the type selector.
   * Results are cached per URL; opening the selector again for the same URL
   * re-uses them, while editing the URL invalidates the cache.
   */


  /**
   * Fetch the list of collections from a STAC API endpoint.
   * Caches results per URL so re-opening the dropdown re-uses them,
   * while editing the URL invalidates the cache.


  /**
   * Fetch the WFS GetCapabilities document for the given URL and extract the
   * advertised feature types (Name + Title) to populate the type selector.
   * Results are cached per URL; opening the selector again for the same URL
   * re-uses them, while editing the URL invalidates the cache.
   */



  // ----- Layer groups (folders) -------------------------------------------

  const groupsOf = (kind: 'raster' | 'vector') => (kind === 'raster' ? rasterGroups : vectorGroups);
  const updateGroups = (kind: 'raster' | 'vector', groups: LayerGroup[]) =>
    kind === 'raster' ? onUpdateRasterGroups(groups) : onUpdateVectorGroups(groups);
  const updateGroup = (kind: 'raster' | 'vector', groupId: string, patch: Partial<LayerGroup>) =>
    updateGroups(kind, groupsOf(kind).map(g => (g.id === groupId ? { ...g, ...patch } : g)));

  const startGroupRename = (group: LayerGroup) => {
    setRenamingGroupId(group.id);
    setRenameValue(group.name);
  };

  const commitGroupRename = (kind: 'raster' | 'vector', group: LayerGroup) => {
    const name = renameValue.trim();
    if (name && name !== group.name) updateGroup(kind, group.id, { name });
    setRenamingGroupId(null);
  };

  /** Create a group and immediately open its inline rename field. */
  const addGroup = (kind: 'raster' | 'vector') => {
    const id = makeGroupId();
    updateGroups(kind, [...groupsOf(kind), { id, name: 'New group', expanded: true }]);
    setRenamingGroupId(id);
    setRenameValue('New group');
  };

  /** Remove a group but keep its layers - they become ungrouped. */
  const removeGroup = (kind: 'raster' | 'vector', groupId: string) => {
    const remainingGroups = groupsOf(kind).filter(g => g.id !== groupId);
    updateGroups(kind, remainingGroups);
    if (kind === 'raster') {
      if (rasterLayers.some(l => l.groupId === groupId)) {
        onReorderRasterLayers(rasterLayers.map(l => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
      }
    } else if (vectorLayers.some(l => l.groupId === groupId)) {
      onReorderVectorLayers(vectorLayers.map(l => (l.groupId === groupId ? { ...l, groupId: undefined } : l)));
    }
  };

  /** Create a new group from a layer's assign-menu and move the layer into it. */
  const createGroupWithLayer = (kind: 'raster' | 'vector', layerId: string, name: string) => {
    const id = makeGroupId();
    updateGroups(kind, [...groupsOf(kind), { id, name, expanded: true }]);
    if (kind === 'raster') onMoveRasterLayerToGroup(layerId, id);
    else onMoveVectorLayerToGroup(layerId, id);
  };

  // While a geometry re-edit session is live, keep its layer's editor
  // section open: reveal the form when the session starts, and again
  // whenever the panel reopens (hiding only toggles this dialog's visibility —
  // it stays mounted, so the initial state above never re-runs).
  useEffect(() => {
    const wasHidden = prevPanelHiddenRef.current;
    prevPanelHiddenRef.current = panelHidden;
    if (!editingVectorLayerId) return;
    setVectorEditingId(editingVectorLayerId);
    // The form renders inside its group's child list — a collapsed group
    // would hide it, so force the edited layer's group open.
    const editedLayer = vectorLayers.find(l => l.id === editingVectorLayerId);
    if (editedLayer?.groupId) {
      const group = vectorGroups.find(g => g.id === editedLayer.groupId);
      if (group && !group.expanded) updateGroup('vector', group.id, { expanded: true });
    }
    if (wasHidden && !panelHidden) setReeditRevealTick(t => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingVectorLayerId, panelHidden]);

  // Group header row: expand chevron, folder icon, inline-renameable name,
  // member count, a tri-state eye that toggles the whole cluster at once,
  // and a remove button that dissolves the group but keeps its layers.
  const renderGroupHeader = (kind: 'raster' | 'vector', group: LayerGroup, members: Array<{ id: string; visible?: boolean }>) => {
    const isVisible = (l: { visible?: boolean }) => (kind === 'raster' ? l.visible !== false : l.visible === true);
    const visibleCount = members.filter(isVisible).length;
    const eyeState: 'all' | 'some' | 'none' =
      members.length > 0 && visibleCount === members.length ? 'all' : visibleCount > 0 ? 'some' : 'none';
    const isRenaming = renamingGroupId === group.id;
    const isDragTarget = dnd.dragOverGroupId === group.id;
    // While a layer is dragged over this header the drop lands ABOVE the group,
    // unless this group was just auto-expanded by the hover (then it joins the
    // folder's end) - show the matching drop-target cue.
    const willJoinEnd = isDragTarget && dnd.isHoverExpandedGroup(group.id);
    const eyeTitle =
      members.length === 0 ? 'Empty group'
      : eyeState === 'none' ? 'Restore the layers\u2019 previous visibility'
      : 'Hide every layer in this group';
    return (
      <div
        className={'settings-group-header' + (isDragTarget ? ' drag-over' : '') + (isDragTarget && !willJoinEnd ? ' drag-over-before' : '')}
        draggable
        onDragStart={(e) => dnd.handleGroupHeaderDragStart(kind, e, group.id)}
        onDragEnd={dnd.handleGroupHeaderDragEnd}
        onDragOver={(e) => dnd[kind].handleDragOverGroup(e, group.id)}
        onDragLeave={dnd.handleGroupDragLeave}
        onDrop={(e) => {
          // Multi-select drop: move ALL selected layers of this kind into the group
          const sel = kind === 'raster' ? selectedRasterIds : selectedVectorIds;
          if (sel.size > 1) {
            e.preventDefault();
            e.stopPropagation();
            const moveFn = kind === 'raster' ? onMoveRasterLayerToGroup : onMoveVectorLayerToGroup;
            sel.forEach(id => moveFn(id, group.id));
            setSelectedIdsOf(kind, new Set());
            dnd.handleGroupHeaderDragEnd();
            return;
          }
          dnd.handleGroupHeaderDrop(kind, e, group.id);
        }}
        title="Drag to reorder the whole group"
      >
        {/*
          The whole header is the drag surface. The action controls below are
          deliberately <span role="button"> instead of real <button>s: Chrome
          refuses to start a drag from a form control, so real buttons would
          leave dead zones in the header (which is why dragging used to fail
          from the right-hand side - e.g. right after clicking the chevron
          to collapse the group).
        */}
        <span className="settings-drag-handle">{'\u22ee\u22ee'}</span>
        <span className="settings-group-folder"><FolderIcon /></span>
          {isRenaming ? (
            <input
              autoFocus
              type="text"
              className="settings-group-rename"
              value={renameValue}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGroupRename(kind, group);
                if (e.key === 'Escape') setRenamingGroupId(null);
              }}
              onBlur={() => commitGroupRename(kind, group)}
            />
          ) : (
            <span
              className="settings-group-name"
              onDoubleClick={() => startGroupRename(group)}
              title={group.name + ' \u2014 double-click to rename'}
            >
              {group.name}
            </span>
          )}
        <span className="settings-group-count" title={members.length === 1 ? '1 layer' : members.length + ' layers'}>
          {members.length}
        </span>
        <div className="settings-group-header-actions">
          <span
            role="button"
            tabIndex={0}
            className="settings-group-chevron"
            onClick={() => updateGroup(kind, group.id, { expanded: !group.expanded })}
            onKeyDown={spanActivate(() => updateGroup(kind, group.id, { expanded: !group.expanded }))}
            title={group.expanded ? 'Collapse group' : 'Expand group'}
            aria-expanded={group.expanded}
          >
            <span className={'settings-group-chevron-icon' + (group.expanded ? ' expanded' : '')}>{'\u25b8'}</span>
          </span>
          <span
            role="button"
            tabIndex={0}
            className="settings-layer-edit"
            onClick={() => startGroupRename(group)}
            onKeyDown={spanActivate(() => startGroupRename(group))}
            title="Rename group"
          >
            <PencilIcon />
          </span>
          <span
            role="button"
            tabIndex={members.length === 0 ? -1 : 0}
            aria-disabled={members.length === 0}
            className="settings-layer-visibility"
            onClick={() => { if (members.length > 0) (kind === 'raster' ? onToggleRasterGroup(group.id) : onToggleVectorGroup(group.id)); }}
            onKeyDown={spanActivate(() => { if (members.length > 0) (kind === 'raster' ? onToggleRasterGroup(group.id) : onToggleVectorGroup(group.id)); })}
            title={eyeTitle}
          >
            <GroupEyeIcon state={eyeState} />
          </span>
          <span
            role="button"
            tabIndex={0}
            className="settings-layer-remove"
            onClick={() => removeGroup(kind, group.id)}
            onKeyDown={spanActivate(() => removeGroup(kind, group.id))}
            title="Remove group (its layers are kept)"
          >
            &times;
          </span>
        </div>
      </div>
    );
  };

  const renderRasterLayerRow = (layer: RasterLayer, inGroup: boolean) => (
    editingId === layer.id ? (
              <RasterLayerEditForm
                key={layer.id}
                layer={layer}
                onApplyColorAdjustments={onApplyColorAdjustments}
                onApplyTileZoomRange={onApplyTileZoomRange}
                onApplyCogRender={onApplyCogRender}
                onApplyTileRender={onApplyTileRender}
                onEdit={onEditRasterLayer}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div 
                key={layer.id} 
                className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible === false ? ' layer-off' : '') + (dnd.rowDropTarget && dnd.rowDropTarget.id === layer.id ? (dnd.rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '') + (selectedRasterIds.has(layer.id) ? ' selected' : '')}
                draggable
                onDragStart={(e) => {
                  // When multi-selected, drag all selected layers (store IDs in dataTransfer)
                  if (selectedRasterIds.size > 1 && selectedRasterIds.has(layer.id)) {
                    e.dataTransfer?.setData('application/multi-select', JSON.stringify(Array.from(selectedRasterIds)));
                  }
                  dnd.raster.handleRowDragStart(e, layer.id);
                }}
                onDragOver={(e) => {
                  // When multi-selected, only allow dropping on group headers (not on other rows)
                  if (selectedRasterIds.size > 1 && selectedRasterIds.has(layer.id)) {
                    e.preventDefault();
                    return;
                  }
                  dnd.raster.handleRowDragOver(e, layer.id);
                }}
                onDrop={(e) => {
                  // When multi-selected, ignore row drops (only group header drops work)
                  if (selectedRasterIds.size > 1 && selectedRasterIds.has(layer.id)) {
                    e.preventDefault();
                    return;
                  }
                  dnd.raster.handleRowDrop(e, layer.id);
                }}
                onDragEnd={dnd.raster.handleRowDragEnd}
                style={{ cursor: 'grab', opacity: (dnd.raster.draggedId === layer.id || (dnd.raster.draggedId && selectedRasterIds.has(layer.id) && selectedRasterIds.size > 1)) ? 0.5 : 1 }}
                onContextMenu={(e) => openLayerCtxMenu('raster', layer.id, e)}
                onClick={(e) => handleLayerRowClick('raster', layer.id, e)}
              >
                <input
                  type="checkbox"
                  className="settings-layer-checkbox"
                  checked={selectedRasterIds.has(layer.id)}
                  onChange={(e) => handleCheckboxChange('raster', layer.id, e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                  title="Select layer"
                />
                <span className="settings-layer-name">{layer.name}</span>
                <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                {(layer.type === 'xyz' || layer.type === 'wmts') && (layer.minZoom !== undefined || layer.maxZoom !== undefined) && (
                  <span className="settings-layer-zoom-chip" title="Tile zoom range">
                    z{layer.minZoom ?? TILE_ZOOM_MIN}{'\u2013'}{layer.maxZoom ?? TILE_ZOOM_MAX}
                  </span>
                )}
                <GroupAssignMenu
                  groups={rasterGroups}
                  currentGroupId={layer.groupId}
                  onAssign={(gid) => onMoveRasterLayerToGroup(layer.id, gid)}
                  onCreateGroup={(name) => createGroupWithLayer('raster', layer.id, name)}
                />
                <button
                  className="settings-layer-edit"
                  onClick={() => setEditingId(layer.id)}
                  title="Edit layer"
                >
                  <PencilIcon />
                </button>
                <button
                  className="settings-layer-visibility"
                  onClick={() => onToggleRasterLayer(layer.id)}
                  title={layer.visible !== false ? 'Hide layer' : 'Show layer'}
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
  );

  const renderRasterGroupBlock = (group: LayerGroup, members: RasterLayer[]) => (
    <div
      key={'raster-group-' + group.id}
      className={'settings-group-block' + (dnd.raster.draggedGroupId === group.id ? ' dragging' : '')}
    >
      {renderGroupHeader('raster', group, members)}
      {/*
        Collapsed groups unmount their member rows entirely. (The previous
        always-mounted, CSS-grid 0fr collapse kept a zero-height grid track
        under the header, which stopped Chrome from starting header drags
        on collapsed groups - and its overflow:hidden clipped the per-layer
        group-assignment popovers.)
      */}
      {group.expanded && (
        <div
          className="settings-group-children"
          onDragOver={(e) => dnd.handleGroupChildrenDragOver(e, 'raster', group.id)}
          onDrop={(e) => {
            if (selectedRasterIds.size > 1) {
              e.preventDefault();
              e.stopPropagation();
              selectedRasterIds.forEach(id => onMoveRasterLayerToGroup(id, group.id));
              setSelectedRasterIds(new Set());
              dnd.handleGroupHeaderDragEnd();
              return;
            }
            dnd.handleGroupChildrenDrop(e, 'raster', group.id);
          }}
          onDragLeave={dnd.handleGroupDragLeave}
        >
          <div className="settings-group-children-inner">
            {members.length === 0 ? (
              <div className="settings-group-empty">Empty group {'\u2014'} drag a layer onto this header, or use a layer{'\u2019'}s folder button.</div>
            ) : (
              members.map((layer) => renderRasterLayerRow(layer, true))
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderRasterPanelItems = () => {
    const searching = rasterSearchActive && rasterSearchQuery.trim().length > 0;
    const q = searching ? rasterSearchQuery.trim().toLowerCase() : '';
    const filteredLayers = searching ? rasterLayers.filter(l => l.name.toLowerCase().includes(q)) : rasterLayers;
    // When searching, force all groups expanded so matching members are visible
    const effectiveGroups = searching ? rasterGroups.map(g => ({ ...g, expanded: true })) : rasterGroups;
    const items = buildLayerPanelItems(filteredLayers, effectiveGroups)
      .filter(item => item.kind === 'layer' || (item.kind === 'group' && (searching ? item.members.length > 0 : true)))
      .map((item) =>
      item.kind === 'group'
        ? renderRasterGroupBlock(item.group, item.members)
        : renderRasterLayerRow(item.layer, false)
    );
    // While a group is being dragged, offer an explicit drop strip at the
    // bottom of the list: dropping there moves the whole group to the end.
    if (dnd.raster.draggedGroupId || dnd.raster.draggedId) {
      items.push(
        <div
          key="raster-dropzone"
          className="settings-group-dropzone"
          onDragOver={(e) => {
            // Multi-select cannot drop at end-of-list (only into folders)
            if (selectedRasterIds.size > 1) return;
            dnd.raster.handleListDragOver(e);
          }}
          onDrop={(e) => {
            if (selectedRasterIds.size > 1) return;
            e.preventDefault();
          }}
        >
          {dnd.raster.draggedGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

  const renderVectorLayerRow = (layer: VectorLayerConfig, inGroup: boolean) => (
    vectorEditingId === layer.id ? (
              <VectorLayerEditForm
                key={layer.id}
                layer={layer}
                editingVectorLayerId={editingVectorLayerId}
                revealReeditSignal={reeditRevealTick}
                units={units}
                onApplyStyle={onApplyVectorStyle}
                onApplyZoomRange={onApplyVectorZoomRange}
                onApplyCluster={onApplyVectorCluster}
                onApplyFilter={onApplyVectorFilter}
                onApplyAttrRender={onApplyVectorAttrRender}
                onApplyFeatureStyle={onApplyVectorFeatureStyle}
                onToggleFeatureMeasurements={onToggleVectorFeatureMeasurements}
                onToggleFeatureNameLabel={onToggleVectorFeatureNameLabel}
                onEdit={onEditVectorLayer}
                onReedit={onReeditVectorLayer}
                onExport={onExportVectorLayer}
                onCancel={() => setVectorEditingId(null)}
              />
                ) : (
                  <div 
                    key={layer.id} 
                    className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible !== true ? ' layer-off' : '') + (dnd.rowDropTarget && dnd.rowDropTarget.id === layer.id ? (dnd.rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '') + (selectedVectorIds.has(layer.id) ? ' selected' : '')}
                    draggable
                    onDragStart={(e) => {
                      // When multi-selected, drag all selected layers
                      if (selectedVectorIds.size > 1 && selectedVectorIds.has(layer.id)) {
                        e.dataTransfer?.setData('application/multi-select', JSON.stringify(Array.from(selectedVectorIds)));
                      }
                      dnd.vector.handleRowDragStart(e, layer.id);
                    }}
                    onDragOver={(e) => {
                      // When multi-selected, only allow dropping on group headers
                      if (selectedVectorIds.size > 1 && selectedVectorIds.has(layer.id)) {
                        e.preventDefault();
                        return;
                      }
                      dnd.vector.handleRowDragOver(e, layer.id);
                    }}
                    onDrop={(e) => {
                      // When multi-selected, ignore row drops
                      if (selectedVectorIds.size > 1 && selectedVectorIds.has(layer.id)) {
                        e.preventDefault();
                        return;
                      }
                      dnd.vector.handleRowDrop(e, layer.id);
                    }}
                    onDragEnd={dnd.vector.handleRowDragEnd}
                    style={{ cursor: 'grab', opacity: (dnd.vector.draggedId === layer.id || (dnd.vector.draggedId && selectedVectorIds.has(layer.id) && selectedVectorIds.size > 1)) ? 0.5 : 1 }}
                    onContextMenu={(e) => openLayerCtxMenu('vector', layer.id, e)}
                    onClick={(e) => handleLayerRowClick('vector', layer.id, e)}
                  >
                    <input
                      type="checkbox"
                      className="settings-layer-checkbox"
                      checked={selectedVectorIds.has(layer.id)}
                      onChange={(e) => handleCheckboxChange('vector', layer.id, e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                      title="Select layer"
                    />
                    <span className="settings-layer-name">{layer.name}</span>
                    {loadingVectorIds.has(layer.id) && (
                      <span className="settings-layer-loading" title="Loading data…">
                        <span className="settings-layer-loading-spinner" />
                      </span>
                    )}
                    <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
                    {layer.type === 'postgis' && layer.postgisDisconnected && (
                      <span className="settings-layer-disconnected" title="Workbench Companion unavailable">
                        Disconnected
                        {onReconnectPostgisLayer && (
                          <button
                            className="settings-layer-reconnect-btn"
                            onClick={(e) => { e.stopPropagation(); onReconnectPostgisLayer(layer.id); }}
                            title="Reconnect to Workbench Companion"
                          >
                            ↻
                          </button>
                        )}
                      </span>
                    )}
                    {(layer.minZoom !== undefined || layer.maxZoom !== undefined) && (
                      <span className="settings-layer-zoom-chip" title={layer.type === 'mvt' ? 'Tile zoom range' : 'Visible zoom range'}>
                        z{layer.minZoom ?? TILE_ZOOM_MIN}{'\u2013'}{layer.maxZoom ?? TILE_ZOOM_MAX}
                      </span>
                    )}
                    {layer.filterEnabled && !!layer.filterExpression && (
                      <span className="settings-layer-filter-chip" title={'Filtering features: ' + layer.filterExpression}>
                        <FunnelIcon size={9} />
                        Filtered
                      </span>
                    )}
                    {layer.attrRender?.enabled && !!layer.attrRender.field && (
                      <span className="settings-layer-attr-chip" title={`Attribute-driven rendering by "${layer.attrRender.field}"`}>
                        Attribute
                      </span>
                    )}
                    <GroupAssignMenu
                      groups={vectorGroups}
                      currentGroupId={layer.groupId}
                      onAssign={(gid) => onMoveVectorLayerToGroup(layer.id, gid)}
                      onCreateGroup={(name) => createGroupWithLayer('vector', layer.id, name)}
                    />
                    <button
                      className="settings-layer-edit"
                      onClick={() => setVectorEditingId(layer.id)}
                      title="Edit layer"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      className="settings-layer-visibility"
                      onClick={() => onToggleVectorLayer(layer.id)}
                      title={layer.visible ? 'Hide layer' : 'Show layer'}
                    >
                      <EyeIcon visible={layer.visible} />
                    </button>
                    {layer.type !== 'mvt' && (
                      <button
                        className="settings-layer-table"
                        onClick={() => onShowAttributeTable && onShowAttributeTable(layer.id)}
                        title="Show attribute table"
                      >
                        <TableIcon size={14} />
                      </button>
                    )}
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
  );

  const renderVectorGroupBlock = (group: LayerGroup, members: VectorLayerConfig[]) => (
    <div
      key={'vector-group-' + group.id}
      className={'settings-group-block' + (dnd.vector.draggedGroupId === group.id ? ' dragging' : '')}
    >
      {renderGroupHeader('vector', group, members)}
      {/* Collapsed groups unmount their member rows - see the raster block. */}
      {group.expanded && (
        <div
          className="settings-group-children"
          onDragOver={(e) => dnd.handleGroupChildrenDragOver(e, 'vector', group.id)}
          onDrop={(e) => {
            if (selectedVectorIds.size > 1) {
              e.preventDefault();
              e.stopPropagation();
              selectedVectorIds.forEach(id => onMoveVectorLayerToGroup(id, group.id));
              setSelectedVectorIds(new Set());
              dnd.handleGroupHeaderDragEnd();
              return;
            }
            dnd.handleGroupChildrenDrop(e, 'vector', group.id);
          }}
          onDragLeave={dnd.handleGroupDragLeave}
        >
          <div className="settings-group-children-inner">
            {members.length === 0 ? (
              <div className="settings-group-empty">Empty group {'\u2014'} drag a layer onto this header, or use a layer{'\u2019'}s folder button.</div>
            ) : (
              members.map((layer) => renderVectorLayerRow(layer, true))
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderVectorPanelItems = () => {
    const searching = vectorSearchActive && vectorSearchQuery.trim().length > 0;
    const q = searching ? vectorSearchQuery.trim().toLowerCase() : '';
    const filteredLayers = searching ? vectorLayers.filter(l => l.name.toLowerCase().includes(q)) : vectorLayers;
    const effectiveGroups = searching ? vectorGroups.map(g => ({ ...g, expanded: true })) : vectorGroups;
    const items = buildLayerPanelItems(filteredLayers, effectiveGroups)
      .filter(item => item.kind === 'layer' || (item.kind === 'group' && (searching ? item.members.length > 0 : true)))
      .map((item) =>
      item.kind === 'group'
        ? renderVectorGroupBlock(item.group, item.members)
        : renderVectorLayerRow(item.layer, false)
    );
    // While a group is being dragged, offer an explicit drop strip at the
    // bottom of the list: dropping there moves the whole group to the end.
    if (dnd.vector.draggedGroupId || dnd.vector.draggedId) {
      items.push(
        <div
          key="vector-dropzone"
          className="settings-group-dropzone"
          onDragOver={(e) => {
            // Multi-select cannot drop at end-of-list (only into folders)
            if (selectedVectorIds.size > 1) return;
            dnd.vector.handleListDragOver(e);
          }}
          onDrop={(e) => {
            if (selectedVectorIds.size > 1) return;
            e.preventDefault();
          }}
        >
          {dnd.vector.draggedGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

  // The raster layer under the right-click menu, when it renders terrain:
  // only then does its menu offer "Elevation Profile" (a profile needs the
  // elevations the Hillshade / Contours renderers already read).
  const ctxTerrainRenderer = layerCtxMenu && layerCtxMenu.kind === 'raster'
    ? terrainRendererOf(rasterLayers.find(l => l.id === layerCtxMenu.layerId))
    : null;

  return (
    <div className={`settings-dialog${splitPaneMode ? ' settings-dialog--split' : ''}${panelHidden ? ' settings-dialog--hidden' : ''}${noRevealAnimation ? ' settings-dialog--no-reveal' : ''}`} onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <div className="settings-dialog-header">
        <div className="settings-dialog-title-row">
          <span className="settings-dialog-title">Settings</span>
          <button
            type="button"
            className={`settings-dialog-pin${pinned ? ' pinned' : ''}`}
            onClick={() => onPinToggle(!pinned)}
            title={pinned ? 'Unpin — clicking outside closes Settings' : 'Pin — keep Settings open while using the map'}
            aria-pressed={pinned}
          >
            <PinIcon pinned={pinned} />
          </button>
        </div>
        <div className="settings-dialog-header-right">
          {!splitPaneMode && (
          <WorkspaceSelector
            workspaceId={workspaceId}
            workspaces={workspaces}
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onRename={onRenameWorkspace}
            onDuplicate={onDuplicateWorkspace}
            onDelete={onDeleteWorkspace}
          />
          )}
          <button className="settings-dialog-close" onClick={onClose}>&times;</button>
        </div>
      </div>
      {splitPaneMode && splitTabs && splitTabs.length > 0 && (
        <div className="settings-split-tabs" role="tablist" aria-label="Side shown in the split settings">
          {splitTabs.map(tab => {
            const otherTab = splitTabs.find(t => t.id !== tab.id);
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={tab.id === activeSplitTabId}
                className={`settings-split-tab${tab.id === activeSplitTabId ? ' settings-split-tab--active' : ''}`}
                onClick={() => { if (onSplitTabChange) onSplitTabChange(tab.id); }}
                onKeyDown={(e) => {
                  // Only activate when the tab itself is focused — Enter/Space
                  // on the dropdown trigger must not switch tabs as well.
                  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                    e.preventDefault();
                    if (onSplitTabChange) onSplitTabChange(tab.id);
                  }
                }}
              >
                <span className="settings-split-tab-label">{tab.label}</span>
                <SplitTabWorkspaceDropdown
                  workspaces={workspaces}
                  selectedId={tab.workspaceId}
                  disabledId={otherTab?.workspaceId}
                  ariaLabel={`Choose the workspace shown on the ${tab.id} side`}
                  onChange={(wsId) => { if (onSplitTabWorkspaceChange) onSplitTabWorkspaceChange(tab.id, wsId); }}
                />
              </div>
            );
          })}
        </div>
      )}
      <div className="settings-dialog-body">
        <div className="settings-section">
          <div className="settings-section-title">Basic Settings</div>
          <div className="settings-basic-grid">
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="basemap-toggle"
                checked={showBasemap}
                onChange={(e) => onBasemapToggle(e.target.checked)}
              />
              <label htmlFor="basemap-toggle">Basemap</label>
            </div>
            <div className="settings-checkbox-row">
              <input
                type="checkbox"
                id="grid-toggle"
                checked={showGrid}
                onChange={(e) => onGridToggle(e.target.checked)}
              />
              <label htmlFor="grid-toggle">Show Grid</label>
            </div>
            <div
              className={`settings-checkbox-row${splitPaneMode ? ' settings-checkbox-row--disabled' : ''}`}
              title={splitPaneMode ? 'Drawing is unavailable while comparing workspaces side by side' : undefined}
            >
              <input
                type="checkbox"
                id="draw-toolbar-toggle"
                checked={splitPaneMode ? false : showDrawToolbar}
                disabled={splitPaneMode}
                onChange={(e) => { if (!splitPaneMode) onDrawToolbarToggle(e.target.checked); }}
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
        <div className={'settings-section' + (rasterSearchActive ? ' settings-section--searching' : '')}>
          <div
            className="settings-section-title-row"
            onDragOver={(e) => {
              if (selectedRasterIds.size > 1) return;
              dnd.handleSectionDragOver(e, 'raster');
            }}
            onDragLeave={dnd.handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); dnd.markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dnd.dragOverSection === 'raster' ? ' drag-over' : '')}>Raster Layers</div>
            <div className="settings-section-title-actions">
              <button
                type="button"
                className={'settings-search-toggle-btn' + (rasterSearchActive ? ' active' : '')}
                onClick={() => {
                  const next = !rasterSearchActive;
                  setRasterSearchActive(next);
                  if (!next) setRasterSearchQuery('');
                  if (next) setTimeout(() => rasterSearchInputRef.current?.focus(), 0);
                }}
                title={rasterSearchActive ? 'Close search' : 'Search layers'}
              >
                <SearchIcon size={13} />
              </button>
              <button
                type="button"
                className="settings-new-group-btn"
                onClick={() => addGroup('raster')}
                title="Create a folder to organise raster layers"
              >
                <FolderPlusIcon /> New group
              </button>
            </div>
          </div>
          {rasterSearchActive && (
            <div className="settings-search-bar">
              <input
                ref={rasterSearchInputRef}
                type="text"
                className="settings-search-input"
                placeholder="Filter raster layers…"
                value={rasterSearchQuery}
                onChange={(e) => setRasterSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setRasterSearchActive(false); setRasterSearchQuery(''); } }}
              />
              {rasterSearchQuery && (
                <span className="settings-search-count">
                  {rasterLayers.filter(l => l.name.toLowerCase().includes(rasterSearchQuery.trim().toLowerCase())).length} / {rasterLayers.length}
                </span>
              )}
            </div>
          )}
          {isRestoringLayers && (
            <LoadingIndicator message="Restoring raster layers..." />
          )}
          <div className="settings-layers-list">
            {renderRasterPanelItems()}
          </div>
          <AddRasterLayerForm
            knownSources={knownSources}
            existingRasterLayers={rasterLayers}
            onAddRasterLayer={onAddRasterLayer}
            onClose={() => {}}
          />

        </div>
        <div className={'settings-section' + (vectorSearchActive ? ' settings-section--searching' : '')}>
          <div
            className="settings-section-title-row"
            onDragOver={(e) => {
              if (selectedVectorIds.size > 1) return;
              dnd.handleSectionDragOver(e, 'vector');
            }}
            onDragLeave={dnd.handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); dnd.markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dnd.dragOverSection === 'vector' ? ' drag-over' : '')}>Vector Layers</div>
            <div className="settings-section-title-actions">
              <button
                type="button"
                className={'settings-search-toggle-btn' + (vectorSearchActive ? ' active' : '')}
                onClick={() => {
                  const next = !vectorSearchActive;
                  setVectorSearchActive(next);
                  if (!next) setVectorSearchQuery('');
                  if (next) setTimeout(() => vectorSearchInputRef.current?.focus(), 0);
                }}
                title={vectorSearchActive ? 'Close search' : 'Search layers'}
              >
                <SearchIcon size={13} />
              </button>
              <button
                type="button"
                className="settings-new-group-btn"
                onClick={() => addGroup('vector')}
                title="Create a folder to organise vector layers"
              >
                <FolderPlusIcon /> New group
              </button>
            </div>
          </div>
          {vectorSearchActive && (
            <div className="settings-search-bar">
              <input
                ref={vectorSearchInputRef}
                type="text"
                className="settings-search-input"
                placeholder="Filter vector layers…"
                value={vectorSearchQuery}
                onChange={(e) => setVectorSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setVectorSearchActive(false); setVectorSearchQuery(''); } }}
              />
              {vectorSearchQuery && (
                <span className="settings-search-count">
                  {vectorLayers.filter(l => l.name.toLowerCase().includes(vectorSearchQuery.trim().toLowerCase())).length} / {vectorLayers.length}
                </span>
              )}
            </div>
          )}
          {isRestoringLayers && (
            <LoadingIndicator message="Restoring vector layers..." />
          )}
          {vectorLayers.length === 0 && vectorGroups.length === 0 ? (
            <p className="settings-placeholder">No vector layers added yet. Drag and drop GeoJSON, KML, or KMZ files onto the map.</p>
          ) : (
            <div className="settings-layers-list">
              {renderVectorPanelItems()}
            </div>
          )}
          <AddVectorLayerForm
            knownSources={knownSources}
            onAddVectorLayer={onAddVectorLayer}
            onAddMVTLayer={onAddMVTLayer}
            onAddWFSLayer={onAddWFSLayer}
            onAddSTACLayer={onAddSTACLayer}
            onAddPostgisLayer={onAddPostgisLayer}
            connectorUrl={connectorUrl}
            getLockPassword={getLockPassword}
            onClose={() => {}}
          />
        </div>
      </div>
      <div className="settings-dialog-footer">
        <div className="settings-footer-left">
          <button
            ref={lockButtonRef}
            className="settings-lock-button"
            onClick={() => { closeLockMenu(); onLockApp(); }}
            onContextMenu={openLockMenu}
            title="Lock app — encrypts your saved data behind a password. Right-click for password options."
            aria-label="Lock app"
          >
            <LockIcon />
          </button>
          {lockMenuPos && createPortal(
            <div
              ref={lockMenuRef}
              className="lock-context-menu"
              role="menu"
              aria-label="Lock password options"
              style={{ position: 'fixed', left: lockMenuPos.left, bottom: lockMenuPos.bottom }}
            >
              {hasLockPassword ? (
                <button
                  type="button"
                  className="lock-context-menu-item"
                  role="menuitem"
                  onClick={handleLockMenuReset}
                >
                  <span className="lock-context-menu-item-icon"><ResetKeyIcon /></span>
                  <span className="lock-context-menu-item-label">Reset Password</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="lock-context-menu-item"
                  role="menuitem"
                  onClick={handleLockMenuSet}
                >
                  <span className="lock-context-menu-item-icon"><KeyIcon /></span>
                  <span className="lock-context-menu-item-label">Set Password</span>
                </button>
              )}
            </div>,
            document.body
          )}
          {onToggleTheme && (
            <button
              type="button"
              className="settings-theme-button"
              onClick={onToggleTheme}
              title={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-pressed={dark}
            >
              {/* The glyph names the theme one click away, like the title. */}
              {dark ? <SunIcon /> : <MoonIcon />}
            </button>
          )}
          {!splitPaneMode && onEnterSplitScreen && (
            <button
              ref={splitButtonRef}
              type="button"
              className="settings-split-mode-button"
              onClick={() => onEnterSplitScreen()}
              onContextMenu={openSplitMenu}
              title="Compare two workspaces side by side — right-click to pick the two workspaces"
              aria-label="Split screen"
            >
              <SplitScreenIcon />
            </button>
          )}
          {onOpenGeoProcessing && (
            <button
              type="button"
              className="settings-geoprocessing-button"
              onClick={onOpenGeoProcessing}
              title="Vector geoprocessing tools — buffer, clip, intersect, union, dissolve…"
              aria-label="Geoprocessing"
            >
              <GeoProcessingIcon />
            </button>
          )}
          {splitMenuPos && createPortal(
            <div
              ref={splitMenuRef}
              className="split-menu"
              role="dialog"
              aria-label="Choose split view workspaces"
              style={{ position: 'fixed', left: splitMenuPos.left, bottom: splitMenuPos.bottom }}
            >
              <div className="split-menu-header">
                <span className="split-menu-title">Split view — pick 2 workspaces</span>
                <button
                  type="button"
                  className="split-menu-close"
                  aria-label="Close split view menu"
                  title="Close"
                  onClick={closeSplitMenu}
                >
                  <CloseIcon />
                </button>
              </div>
              <div className="split-menu-list" role="listbox" aria-label="Workspaces" aria-multiselectable="true">
                {workspaces.map(ws => {
                  const pickIndex = splitMenuPicks.indexOf(ws.id);
                  const picked = pickIndex !== -1;
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      role="option"
                      aria-selected={picked}
                      className={`split-menu-item${picked ? ' split-menu-item--selected' : ''}`}
                      title={picked ? `Shown on the ${pickIndex === 0 ? 'left' : 'right'} side` : 'Click to pick'}
                      onClick={() => toggleSplitMenuPick(ws.id)}
                    >
                      <span className={`split-menu-check${picked ? ' split-menu-check--on' : ''}`} aria-hidden="true">
                        {picked && <CheckIcon />}
                      </span>
                      <span className="split-menu-item-name">{ws.name}</span>
                      {picked && <span className="split-menu-side">{pickIndex === 0 ? 'Left' : 'Right'}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="split-menu-footer">
                <button
                  type="button"
                  className="settings-button-primary split-menu-apply"
                  disabled={splitMenuPicks.length !== 2}
                  title={splitMenuPicks.length !== 2 ? 'Pick two workspaces first' : 'Enter split view with the selected workspaces'}
                  onClick={applySplitMenu}
                >
                  Apply
                </button>
              </div>
            </div>,
            document.body
          )}
        </div>
        {splitPaneMode ? (
          <span
            className="settings-advanced-link settings-exit-split-link"
            role="button"
            aria-label="Exit Split Mode"
            onClick={() => { if (onExitSplitMode) onExitSplitMode(); }}
          >
            Exit Split Mode
          </span>
        ) : (
          <span className="settings-advanced-link" onClick={onAdvancedSettings}>Advanced Settings</span>
        )}
      </div>
      {layerCtxMenu && createPortal(
        <div
          ref={layerCtxMenuRef}
          className="layer-context-menu"
          role="menu"
          aria-label="Layer options"
          style={{ position: 'fixed', left: layerCtxMenu.left, top: layerCtxMenu.top }}
        >
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={handleCtxZoomToExtent}
          >
            <span className="layer-context-menu-item-icon"><ZoomToExtentIcon /></span>
            <span className="layer-context-menu-item-label">Zoom to Extent</span>
          </button>
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={handleCtxDuplicate}
          >
            <span className="layer-context-menu-item-icon"><CopyIcon /></span>
            <span className="layer-context-menu-item-label">Duplicate Layer</span>
          </button>
          {layerCtxMenu.kind === 'raster' && ctxTerrainRenderer && (
            <>
              <div className="layer-context-menu-separator" role="separator" />
              <button
                type="button"
                className="layer-context-menu-item"
                role="menuitem"
                onClick={handleCtxElevationProfile}
                disabled={!onShowElevationProfile}
                title={`Read the terrain under a line you draw, from this layer's ${ctxTerrainRenderer.label} data`}
              >
                <span className="layer-context-menu-item-icon"><ElevationProfileIcon /></span>
                <span className="layer-context-menu-item-label">Elevation Profile</span>
              </button>
            </>
          )}
          {layerCtxMenu.kind === 'vector' && (
            <>
              <div className="layer-context-menu-separator" role="separator" />
              <button
                type="button"
                className="layer-context-menu-item"
                role="menuitem"
                onClick={handleCtxOpenAttributeTable}
                disabled={!onShowAttributeTable}
              >
                <span className="layer-context-menu-item-icon"><TableIcon size={14} /></span>
                <span className="layer-context-menu-item-label">Open Attribute Table</span>
              </button>
              <button
                type="button"
                className="layer-context-menu-item"
                role="menuitem"
                onClick={handleCtxDownload}
              >
                <span className="layer-context-menu-item-icon"><DownloadIcon /></span>
                <span className="layer-context-menu-item-label">Download</span>
              </button>
              <button
                type="button"
                className="layer-context-menu-item"
                role="menuitem"
                onClick={handleCtxEditGeometry}
              >
                <span className="layer-context-menu-item-icon"><PencilIcon /></span>
                <span className="layer-context-menu-item-label">Edit Geometry</span>
              </button>
            </>
          )}
        </div>,
        document.body
      )}
      {ctxExportPopup && (() => {
        const layer = vectorLayers.find(l => l.id === ctxExportPopup.layerId);
        const layerName = layer?.name || 'Layer';
        return (
          <ExportPopup
            layerName={layerName}
            onExport={handleCtxExportConfirm}
            onClose={() => setCtxExportPopup(null)}
          />
        );
      })()}
      {multiCtxMenu && createPortal(
        <div
          ref={multiCtxMenuRef}
          className="layer-context-menu multi-select-context-menu"
          role="menu"
          aria-label="Multi-select layer options"
          style={{ position: 'fixed', left: multiCtxMenu.left, top: multiCtxMenu.top }}
        >
          <div className="layer-context-menu-header">
            {multiCtxMenu.kind === 'raster' ? selectedRasterIds.size : selectedVectorIds.size} layers selected
          </div>
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={handleMultiClearSelection}
          >
            <span className="layer-context-menu-item-icon"><CloseIcon /></span>
            <span className="layer-context-menu-item-label">Clear selected</span>
          </button>
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={() => handleMultiToggleVisibility(false)}
          >
            <span className="layer-context-menu-item-icon"><EyeIcon visible={false} /></span>
            <span className="layer-context-menu-item-label">Hide all selected</span>
          </button>
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={() => handleMultiToggleVisibility(true)}
          >
            <span className="layer-context-menu-item-icon"><EyeIcon visible={true} /></span>
            <span className="layer-context-menu-item-label">Show all selected</span>
          </button>
          <div className="layer-context-menu-separator" role="separator" />
          {multiGroupRename?.kind === multiCtxMenu.kind ? (
            <div className="multi-select-group-create">
              <input
                autoFocus
                type="text"
                className="settings-input"
                placeholder="Group name"
                value={multiGroupNewName}
                onChange={(e) => setMultiGroupNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && multiGroupNewName.trim()) {
                    handleMultiGroupSelected(multiGroupNewName.trim());
                    setMultiGroupRename(null);
                    setMultiGroupNewName('');
                  }
                  if (e.key === 'Escape') {
                    setMultiGroupRename(null);
                    setMultiGroupNewName('');
                  }
                }}
              />
              <div className="multi-select-group-create-actions">
                <button
                  type="button"
                  className="settings-button-primary"
                  disabled={!multiGroupNewName.trim()}
                  onClick={() => {
                    handleMultiGroupSelected(multiGroupNewName.trim());
                    setMultiGroupRename(null);
                    setMultiGroupNewName('');
                  }}
                >Create</button>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => { setMultiGroupRename(null); setMultiGroupNewName(''); }}
                >Cancel</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="layer-context-menu-item"
              role="menuitem"
              onClick={() => { setMultiGroupRename({ kind: multiCtxMenu.kind }); setMultiGroupNewName('New group'); }}
            >
              <span className="layer-context-menu-item-icon"><FolderPlusIcon /></span>
              <span className="layer-context-menu-item-label">Group selected into new folder</span>
            </button>
          )}
          <div className="layer-context-menu-separator" role="separator" />
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={handleMultiMoveToTop}
          >
            <span className="layer-context-menu-item-icon">{'↑'}</span>
            <span className="layer-context-menu-item-label">Move selected to top</span>
          </button>
          <button
            type="button"
            className="layer-context-menu-item"
            role="menuitem"
            onClick={handleMultiMoveToBottom}
          >
            <span className="layer-context-menu-item-icon">{'↓'}</span>
            <span className="layer-context-menu-item-label">Move selected to bottom</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
