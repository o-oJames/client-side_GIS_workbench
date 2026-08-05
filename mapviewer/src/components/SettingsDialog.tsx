import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  RasterLayer,
  LayerGroup,
  VectorLayerConfig,
  SettingsDialogProps } from '../types';
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
  SplitScreenIcon,
  CheckIcon,
  CloseIcon,
  TableIcon,
  FunnelIcon } from './Icons';
import { LoadingIndicator } from './LoadingIndicator';
import { AddRasterLayerForm } from './AddRasterLayerForm';
import { AddVectorLayerForm } from './AddVectorLayerForm';
import { RasterLayerEditForm } from './RasterLayerEditForm';
import { VectorLayerEditForm } from './VectorLayerEditForm';
import { WorkspaceSelector } from './WorkspaceSelector';
import { SplitTabWorkspaceDropdown } from './SplitTabWorkspaceDropdown';
import {
  buildLayerPanelItems,
  makeGroupId,
  GroupAssignMenu,
  spanActivate } from './LayerPanel';
import { useLayerDragReorder } from '../hooks/useLayerDragReorder';

export function SettingsDialog({ 
  onClose, 
  onEnterSplitScreen,
  splitPaneMode = false,
  splitTabs,
  activeSplitTabId,
  onSplitTabChange,
  splitHidden = false,
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
  onReorderRasterLayers,
  onReorderVectorLayers,
  onAddVectorLayer,
  onAddMVTLayer,
  onAddWFSLayer,
  onAddSTACLayer,  onExportVectorLayer,
  onShowAttributeTable,
  onReeditVectorLayer,
  editingVectorLayerId,
  onGoToVectorLayerExtent,
  onGoToRasterLayerExtent,
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
  onResetPassword }: SettingsDialogProps) {
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
  const [vectorEditingId, setVectorEditingId] = useState<string | null>(null);
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
        onDrop={(e) => dnd.handleGroupHeaderDrop(kind, e, group.id)}
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
                onEdit={onEditRasterLayer}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div 
                key={layer.id} 
                className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible === false ? ' layer-off' : '') + (dnd.rowDropTarget && dnd.rowDropTarget.id === layer.id ? (dnd.rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '')}
                draggable
                onDragStart={(e) => dnd.raster.handleRowDragStart(e, layer.id)}
                onDragOver={(e) => dnd.raster.handleRowDragOver(e, layer.id)}
                onDrop={(e) => dnd.raster.handleRowDrop(e, layer.id)}
                onDragEnd={dnd.raster.handleRowDragEnd}
                style={{ cursor: 'grab', opacity: dnd.raster.draggedId === layer.id ? 0.5 : 1 }}
              >
                <span className="settings-drag-handle">⋮⋮</span>
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
          onDrop={(e) => dnd.handleGroupChildrenDrop(e, 'raster', group.id)}
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
    const items = buildLayerPanelItems(rasterLayers, rasterGroups).map((item) =>
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
          onDragOver={(e) => dnd.raster.handleListDragOver(e)}
          onDrop={(e) => e.preventDefault()}
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
                units={units}
                onApplyStyle={onApplyVectorStyle}
                onApplyZoomRange={onApplyVectorZoomRange}
                onApplyCluster={onApplyVectorCluster}
                onApplyFilter={onApplyVectorFilter}
                onApplyAttrRender={onApplyVectorAttrRender}
                onApplyFeatureStyle={onApplyVectorFeatureStyle}
                onToggleFeatureMeasurements={onToggleVectorFeatureMeasurements}
                onEdit={onEditVectorLayer}
                onReedit={onReeditVectorLayer}
                onExport={onExportVectorLayer}
                onCancel={() => setVectorEditingId(null)}
              />
                ) : (
                  <div 
                    key={layer.id} 
                    className={'settings-layer-item' + (inGroup ? ' in-group' : '') + (layer.visible !== true ? ' layer-off' : '') + (dnd.rowDropTarget && dnd.rowDropTarget.id === layer.id ? (dnd.rowDropTarget.place === 'before' ? ' drop-before' : ' drop-after') : '')}
                    draggable
                    onDragStart={(e) => dnd.vector.handleRowDragStart(e, layer.id)}
                    onDragOver={(e) => dnd.vector.handleRowDragOver(e, layer.id)}
                    onDrop={(e) => dnd.vector.handleRowDrop(e, layer.id)}
                    onDragEnd={dnd.vector.handleRowDragEnd}
                    style={{ cursor: 'grab', opacity: dnd.vector.draggedId === layer.id ? 0.5 : 1 }}
                  >
                    <span className="settings-drag-handle">⋮⋮</span>
                    <span className="settings-layer-name">{layer.name}</span>
                    {loadingVectorIds.has(layer.id) && (
                      <span className="settings-layer-loading" title="Loading data…">
                        <span className="settings-layer-loading-spinner" />
                      </span>
                    )}
                    <span className="settings-layer-type">{layer.type.toUpperCase()}</span>
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
          onDrop={(e) => dnd.handleGroupChildrenDrop(e, 'vector', group.id)}
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
    const items = buildLayerPanelItems(vectorLayers, vectorGroups).map((item) =>
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
          onDragOver={(e) => dnd.vector.handleListDragOver(e)}
          onDrop={(e) => e.preventDefault()}
        >
          {dnd.vector.draggedGroupId ? 'Drop group at the end of the list' : 'Drop layer at the end of the list'}
        </div>
      );
    }
    return items;
  };

  return (
    <div className={`settings-dialog${splitPaneMode ? ' settings-dialog--split' : ''}${splitHidden ? ' settings-dialog--hidden' : ''}`} onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
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
        <button className="settings-dialog-close" onClick={onClose}>&times;</button>
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
        <div className="settings-section">
          <div
            className="settings-section-title-row"
            onDragOver={(e) => dnd.handleSectionDragOver(e, 'raster')}
            onDragLeave={dnd.handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); dnd.markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dnd.dragOverSection === 'raster' ? ' drag-over' : '')}>Raster Layers</div>
            <button
              type="button"
              className="settings-new-group-btn"
              onClick={() => addGroup('raster')}
              title="Create a folder to organise raster layers"
            >
              <FolderPlusIcon /> New group
            </button>
          </div>
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
        <div className="settings-section">
          <div
            className="settings-section-title-row"
            onDragOver={(e) => dnd.handleSectionDragOver(e, 'vector')}
            onDragLeave={dnd.handleSectionDragLeave}
            onDrop={(e) => { e.preventDefault(); dnd.markSectionDragOver(null); }}
          >
            <div className={'settings-section-title' + (dnd.dragOverSection === 'vector' ? ' drag-over' : '')}>Vector Layers</div>
            <button
              type="button"
              className="settings-new-group-btn"
              onClick={() => addGroup('vector')}
              title="Create a folder to organise vector layers"
            >
              <FolderPlusIcon /> New group
            </button>
          </div>
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
    </div>
  );
}

