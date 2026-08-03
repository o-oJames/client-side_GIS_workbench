import React, { useState, useRef, useCallback } from 'react';
import type { LayerGroup } from '../types';
import {
  buildLayerPanelItems,
  moveLayerToSlot,
  moveGroupToSlot,
  moveLayerToJoinAt,
  syncGroupAnchors,
  anchorEmptiedGroups,
  layerOrderKey,
  dropPlace,
  itemIdxOfLayer,
  slotAfterId } from '../components/LayerPanel';

// ---------------------------------------------------------------------------
// Layer/group drag-reorder engine for the settings panel.
//
// Extracted from SettingsDialog: raster and vector each had mirrored copies
// of every row/group/section/list drag handler; they are now ONE
// kind-parameterised implementation driven by a per-kind descriptor
// (layers, groups, dragged-id state, commit callbacks).
//
// Parity notes preserved from the original (see SettingsDialog.drag.test.tsx):
//  - dragSessionRef is a SINGLE ref shared by raster AND vector row drags
//    AND group-header drags. Interleaving two drags of different kinds
//    within one tick would veto the deferred dragstart state update -
//    latent coupling only, the UI allows one drag at a time.
//  - Row drops where dragged.groupId === target.groupId early-return
//    WITHOUT clearing drag state; cleanup relies on the native dragend.
// ---------------------------------------------------------------------------

export type LayerDragKind = 'raster' | 'vector';

/** Minimal layer shape the reorder logic operates on (both RasterLayer and
 * VectorLayerConfig satisfy it). */
export interface DragReorderLayer {
  id: string;
  groupId?: string;
}

/** Per-kind inputs: the layer/group data and the callbacks that commit. */
export interface LayerDragKindConfig<L extends DragReorderLayer> {
  layers: L[];
  groups: LayerGroup[];
  /** Commit a new flat layer order (reorder and/or reparent). */
  onReorderLayers: (next: L[]) => void;
  /** Commit a new groups array (anchor/expand updates). */
  onUpdateGroups: (next: LayerGroup[]) => void;
  /** Move a layer into an EMPTY group (App slots it at the group's anchor). */
  onMoveLayerToGroup: (layerId: string, groupId: string) => void;
}

/** Per-kind drag handlers + drag state, consumed by the dialog JSX. */
export interface LayerKindDragHandlers {
  /** Id of the layer currently dragged by its row (null = no drag). */
  draggedId: string | null;
  /** Id of the group currently dragged by its header (null = no drag). */
  draggedGroupId: string | null;
  handleRowDragStart: (e: React.DragEvent, id: string) => void;
  handleRowDragOver: (e: React.DragEvent, targetId: string) => void;
  handleRowDrop: (e: React.DragEvent, targetId: string) => void;
  handleRowDragEnd: () => void;
  handleDragOverGroup: (e: React.DragEvent, groupId: string) => void;
  handleListDragOver: (e: React.DragEvent) => void;
}

export interface UseLayerDragReorderResult {
  raster: LayerKindDragHandlers;
  vector: LayerKindDragHandlers;
  /** Group header a dragged layer/group hovers (drop-target cue). */
  dragOverGroupId: string | null;
  /** Section title a dragged layer/group hovers (drop-target cue). */
  dragOverSection: LayerDragKind | null;
  /** The row a dragged layer would join/leave if dropped right now.
   * Cross-parent moves commit on DROP (not live) so the drag survives
   * crossing a group's members - drives the before/after insertion cue. */
  rowDropTarget: { id: string; place: 'before' | 'after' } | null;
  markSectionDragOver: (kind: LayerDragKind | null) => void;
  /** Whether the hover auto-expanded this group (a header drop then joins
   * the folder's end instead of landing above the group). */
  isHoverExpandedGroup: (groupId: string) => boolean;
  handleGroupHeaderDragStart: (kind: LayerDragKind, e: React.DragEvent, groupId: string) => void;
  handleGroupHeaderDragEnd: () => void;
  handleGroupHeaderDrop: (kind: LayerDragKind, e: React.DragEvent, groupId: string) => void;
  handleGroupDragLeave: (e: React.DragEvent) => void;
  handleGroupChildrenDragOver: (e: React.DragEvent, kind: LayerDragKind, groupId: string) => void;
  handleGroupChildrenDrop: (e: React.DragEvent, kind: LayerDragKind, groupId: string) => void;
  handleSectionDragOver: (e: React.DragEvent, kind: LayerDragKind) => void;
  handleSectionDragLeave: (e: React.DragEvent) => void;
}

/** Descriptor + drag state for one kind, threaded through the shared
 * kind-parameterised implementations below. */
interface KindRuntime<L extends DragReorderLayer> extends LayerDragKindConfig<L> {
  kind: LayerDragKind;
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  draggedGroupId: string | null;
  setDraggedGroupId: (id: string | null) => void;
}

export function useLayerDragReorder<LR extends DragReorderLayer, LV extends DragReorderLayer>(config: {
  raster: LayerDragKindConfig<LR>;
  vector: LayerDragKindConfig<LV>;
}): UseLayerDragReorderResult {
  // Id of the layer/group whose drag session is currently alive. Set/cleared
  // synchronously in dragstart/dragend so the DEFERRED dragstart state
  // update can bail out when the drag already ended before its tick ran
  // (otherwise a quick/cancelled drag leaves the row/group stuck greyed
  // out). One ref shared by both kinds and by group-header drags.
  const dragSessionRef = useRef<string | null>(null);

  // Hover-expand: while a layer drag hovers a collapsed group header,
  // expand the group after 300ms so its member rows become drop targets for
  // precise insertion. Releasing on the header itself drops at the group's
  // end (joinLayerAtGroupEnd in the header's onDrop).
  const hoverExpandRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; key: string | null }>({ timer: null, key: null });
  // The group auto-expanded by the hover during the current drag. A layer
  // dropped on a group header lands ABOVE the group ("take its place") unless
  // it was this very group that the hover just expanded - then the drop joins
  // the folder's end, per the drag spec.
  const hoverExpandedGroupRef = useRef<string | null>(null);

  // Which drop target (group header / section title) a dragged layer hovers.
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<LayerDragKind | null>(null);
  // The row a dragged layer would join/leave if dropped right now. Cross-parent
  // moves commit on DROP (not live) so the drag survives crossing a group's
  // members - this state drives the before/after insertion cue on that row.
  const [rowDropTarget, setRowDropTarget] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  // Id of the layer whose row is currently being dragged, per kind.
  const [draggedRasterId, setDraggedRasterId] = useState<string | null>(null);
  const [draggedVectorId, setDraggedVectorId] = useState<string | null>(null);
  // Id of the group whose header is currently being dragged (whole-block
  // move), per kind.
  const [draggedRasterGroupId, setDraggedRasterGroupId] = useState<string | null>(null);
  const [draggedVectorGroupId, setDraggedVectorGroupId] = useState<string | null>(null);

  // --- state markers -------------------------------------------------------
  // Functional updates with identity checks: dragover fires continuously,
  // unchanged cues must not trigger re-renders.
  const markRowDropTarget = useCallback((id: string | null, place: 'before' | 'after' | null) => setRowDropTarget(prev => {
    if (id === null) return prev === null ? prev : null;
    return prev && prev.id === id && prev.place === place ? prev : { id, place: place! };
  }), []);
  const markGroupDragOver = useCallback((id: string | null) => {
    setDragOverGroupId(prev => (prev === id ? prev : id));
    // Hovering a group header (or leaving a row for one) clears the row cue.
    setRowDropTarget(prev => (prev === null ? prev : null));
  }, []);
  const markSectionDragOver = useCallback((kind: LayerDragKind | null) => setDragOverSection(prev => (prev === kind ? prev : kind)), []);
  const clearHoverExpand = useCallback(() => {
    if (hoverExpandRef.current.timer !== null) clearTimeout(hoverExpandRef.current.timer);
    hoverExpandRef.current = { timer: null, key: null };
    hoverExpandedGroupRef.current = null;
  }, []);
  const isHoverExpandedGroup = useCallback((groupId: string) => hoverExpandedGroupRef.current === groupId, []);

  // --- per-kind runtime descriptors -----------------------------------------
  const rasterRt: KindRuntime<LR> = {
    kind: 'raster',
    ...config.raster,
    draggedId: draggedRasterId,
    setDraggedId: setDraggedRasterId,
    draggedGroupId: draggedRasterGroupId,
    setDraggedGroupId: setDraggedRasterGroupId,
  };
  const vectorRt: KindRuntime<LV> = {
    kind: 'vector',
    ...config.vector,
    draggedId: draggedVectorId,
    setDraggedId: setDraggedVectorId,
    draggedGroupId: draggedVectorGroupId,
    setDraggedGroupId: setDraggedVectorGroupId,
  };

  // --- shared kind-parameterised internals ----------------------------------

  // Reset every drag cue after a row drag ends. Also called explicitly when
  // a drop/dragover reparents the drag source row: the row's DOM node is
  // recreated under a new parent, so the browser's dragend is lost.
  const endRowDragFor = <L extends DragReorderLayer>(rt: KindRuntime<L>) => {
    dragSessionRef.current = null;
    rt.setDraggedId(null);
    markGroupDragOver(null);
    markSectionDragOver(null);
    markRowDropTarget(null, null);
    clearHoverExpand();
  };

  const armHoverExpand = <L extends DragReorderLayer>(rt: KindRuntime<L>, groupId: string) => {
    const group = rt.groups.find(g => g.id === groupId);
    if (!group || group.expanded) return;
    const key = rt.kind + ':' + groupId;
    if (hoverExpandRef.current.key === key) return; // already armed
    clearHoverExpand();
    hoverExpandRef.current = {
      key,
      timer: setTimeout(() => {
        hoverExpandRef.current = { timer: null, key: null };
        // Remember that THIS group was hover-expanded: a header drop now joins
        // the folder's end instead of landing above the group.
        hoverExpandedGroupRef.current = groupId;
        rt.onUpdateGroups(rt.groups.map(g => (g.id === groupId ? { ...g, expanded: true } : g)));
      }, 300) };
  };

  // Add a layer to a group at the END of the group's member list (used when
  // a drag is released on the group header). Empty groups go through the App
  // handler, which slots the layer at the group's anchored position and
  // expands it.
  const joinLayerAtGroupEnd = <L extends DragReorderLayer>(rt: KindRuntime<L>, layerId: string, groupId: string) => {
    const layer = rt.layers.find(l => l.id === layerId);
    if (!layer) return;
    if (!rt.layers.some(l => l.groupId === groupId)) {
      rt.onMoveLayerToGroup(layerId, groupId);
      return;
    }
    const rest = rt.layers.filter(l => l.id !== layerId);
    let lastIdx = -1;
    rest.forEach((l, i) => { if (l.groupId === groupId) lastIdx = i; });
    const next = [...rest.slice(0, lastIdx + 1), { ...layer, groupId }, ...rest.slice(lastIdx + 1)];
    if (layerOrderKey(next) !== layerOrderKey(rt.layers)) rt.onReorderLayers(next);
  };

  // Move the group being dragged so its block occupies the given panel slot
  // (0 = top, -1 = end). Non-empty groups move their member layers in the
  // flat array (map stacking follows); empty groups just get a new afterId
  // anchor. When dropping BEFORE an empty target group, that group is
  // re-anchored below the moved block so the two don't share the same slot.
  const moveDraggedGroupToSlot = <L extends DragReorderLayer>(rt: KindRuntime<L>, slot: number, emptyTargetGroupId?: string, place?: 'before' | 'after') => {
    const draggedId = rt.draggedGroupId;
    if (!draggedId) return;
    const items = buildLayerPanelItems(rt.layers, rt.groups);
    if (rt.layers.some(l => l.groupId === draggedId)) {
      const next = moveGroupToSlot(rt.layers, draggedId, items, slot);
      if (next !== rt.layers) {
        rt.onReorderLayers(next);
        if (emptyTargetGroupId && place === 'before') {
          const lastMemberId = next.filter(l => l.groupId === draggedId).pop()?.id;
          if (lastMemberId) {
            rt.onUpdateGroups(rt.groups.map(g => (g.id === emptyTargetGroupId ? { ...g, afterId: lastMemberId } : g)));
          }
        }
      }
    } else {
      // Empty group: compute the anchor from items WITHOUT the dragged
      // group so slotAfterId never returns a self-reference (which is
      // unresolvable and sends the folder to the end of the list).
      const draggedIdx = items.findIndex(it => it.kind === 'group' && it.group.id === draggedId);
      const itemsWithout = items.filter(it => !(it.kind === 'group' && it.group.id === draggedId));
      const adjustedSlot = draggedIdx !== -1 && draggedIdx < slot ? slot - 1 : slot;
      const afterId = slotAfterId(itemsWithout, adjustedSlot);
      const nextGroups = rt.groups.map(g => {
        if (g.id !== draggedId) return g;
        const updated = { ...g };
        if (afterId === undefined) delete updated.afterId;
        else updated.afterId = afterId;
        return updated;
      });
      if (nextGroups.some((g, i) => g.afterId !== rt.groups[i].afterId)) rt.onUpdateGroups(nextGroups);
    }
  };

  // Releasing a LAYER on a group header is decided by the pointer's half: the
  // TOP half slots the layer in immediately BEFORE the group (ungrouped) - the
  // way to stack a free layer above a folder; the BOTTOM half joins the group
  // at its end (the "drop onto a folder = file into it" gesture, and the
  // outcome of the hover-to-expand flow). Group drags reorder live on dragover
  // and never reach the drop handler.
  const dropLayerOnGroupHeader = <L extends DragReorderLayer>(rt: KindRuntime<L>, groupId: string, place: 'before' | 'after') => {
    if (place === 'before') {
      if (!rt.draggedId) return;
      const items = buildLayerPanelItems(rt.layers, rt.groups);
      const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
      if (idx === -1) return;
      const next = moveLayerToSlot(rt.layers, rt.draggedId, items, idx);
      if (next !== rt.layers) rt.onReorderLayers(next);
      const ga = syncGroupAnchors(rt.layers, next, rt.groups, rt.draggedId, idx);
      if (ga) rt.onUpdateGroups(ga);
      return;
    }
    // Bottom half -> join the group at its end.
    if (rt.draggedId) joinLayerAtGroupEnd(rt, rt.draggedId, groupId);
  };

  // --- per-kind row/header/list handlers ------------------------------------
  // Raster and vector used to have mirrored copies of each of these; the
  // unified versions are instantiated once per kind from the descriptor.

  const createKindHandlers = <L extends DragReorderLayer>(rt: KindRuntime<L>): LayerKindDragHandlers => {
    // setData must happen synchronously (Safari refuses to start a drag
    // without it), but the STATE update is deferred one tick: React would
    // otherwise flush the resulting DOM mutations (the row's drag opacity
    // and the end-of-list drop strip) inside the dragstart event, and
    // Chrome cancels a drag session when the source subtree mutates at
    // that moment - the same fix the group header dragstart already uses.
    const handleRowDragStart = (e: React.DragEvent, id: string) => {
      if (e.dataTransfer) e.dataTransfer.setData('text/plain', id);
      dragSessionRef.current = id;
      window.setTimeout(() => {
        // The drag may already be over (dragend beat this tick) - don't
        // re-apply the dragging state in that case.
        if (dragSessionRef.current !== id) return;
        rt.setDraggedId(id);
      }, 0);
    };

    const handleRowDragOver = (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      markGroupDragOver(null);
      markSectionDragOver(null);
      // A dragged group moves as a whole block: it lands before the hovered
      // row - or before that row's group, since groups are never split.
      if (rt.draggedGroupId) {
        e.stopPropagation();
        const target = rt.layers.find(l => l.id === targetId);
        if (!target || target.groupId === rt.draggedGroupId) return;
        // Slot the dragged block before/after the hovered row (or its whole
        // group block, when the row is grouped) - groups and individual layers
        // interleave freely.
        const items = buildLayerPanelItems(rt.layers, rt.groups);
        const idx = itemIdxOfLayer(items, targetId);
        if (idx !== -1) {
          const place = dropPlace(e);
          moveDraggedGroupToSlot(rt, place === 'before' ? idx : idx + 1);
        }
        return;
      }
      if (!rt.draggedId || rt.draggedId === targetId) return;
      const dragged = rt.layers.find(l => l.id === rt.draggedId);
      const target = rt.layers.find(l => l.id === targetId);
      if (!dragged || !target) return;
      // Cleared here; the cross-parent branch below re-sets it when relevant.
      markRowDropTarget(null, null);

      if (dragged.groupId && dragged.groupId === target.groupId) {
        // Reordering within the same group: plain splice, membership unchanged.
        const draggedIndex = rt.layers.findIndex(l => l.id === rt.draggedId);
        const targetIndex = rt.layers.findIndex(l => l.id === targetId);
        const newLayers = [...rt.layers];
        const [draggedLayer] = newLayers.splice(draggedIndex, 1);
        newLayers.splice(targetIndex, 0, draggedLayer);
        if (layerOrderKey(newLayers) !== layerOrderKey(rt.layers)) rt.onReorderLayers(newLayers);
        return;
      }

      const place = dropPlace(e);
      if (dragged.groupId !== target.groupId) {
        // Cross-parent move (the layer would join or leave a group). Committing
        // it LIVE would reparent the drag source row under a different React
        // parent (a brand-new DOM node), which loses the browser dragend and
        // kills the drag mid-gesture - you could never drag a free layer PAST a
        // group's members to drop it below the group or on the end-of-list strip.
        // So only highlight the target row; the move commits on DROP.
        markRowDropTarget(targetId, place);
        return;
      }
      // Both ungrouped (same parent list): safe to reorder live - the row stays
      // under the same React parent, so the drag source node survives.
      const items = buildLayerPanelItems(rt.layers, rt.groups);
      const idx = itemIdxOfLayer(items, targetId);
      if (idx === -1) return;
      const slot = place === 'before' ? idx : idx + 1;
      const next = moveLayerToSlot(rt.layers, rt.draggedId, items, slot);
      if (next !== rt.layers) {
        rt.onReorderLayers(next);
        const ga = syncGroupAnchors(rt.layers, next, rt.groups, rt.draggedId, slot);
        if (ga) rt.onUpdateGroups(ga);
      }
    };

    const handleRowDragEnd = () => endRowDragFor(rt);

    // Commit a cross-parent layer move on DROP (live dragover only highlights the
    // target row). Joining a group adopts its groupId at the pointer position;
    // dropping on an ungrouped row places the layer beside it and leaves any
    // group. The source row is reparented only now (after the gesture), so the
    // browser drag source node survived the drag and we clear state explicitly.
    const handleRowDrop = (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      e.stopPropagation();
      markRowDropTarget(null, null);
      if (!rt.draggedId || rt.draggedId === targetId) return;
      const dragged = rt.layers.find(l => l.id === rt.draggedId);
      const target = rt.layers.find(l => l.id === targetId);
      if (!dragged || !target || dragged.groupId === target.groupId) return;
      const place = dropPlace(e);
      if (target.groupId) {
        const next = moveLayerToJoinAt(rt.layers, rt.draggedId, target.groupId, targetId, place);
        if (next !== rt.layers) {
          rt.onReorderLayers(next);
          const ga = anchorEmptiedGroups(rt.layers, next, rt.groups);
          if (ga) rt.onUpdateGroups(ga);
        }
      } else {
        const items = buildLayerPanelItems(rt.layers, rt.groups);
        const idx = itemIdxOfLayer(items, targetId);
        if (idx !== -1) {
          const slot = place === 'before' ? idx : idx + 1;
          const next = moveLayerToSlot(rt.layers, rt.draggedId, items, slot);
          if (next !== rt.layers) rt.onReorderLayers(next);
          const ga = syncGroupAnchors(rt.layers, next, rt.groups, rt.draggedId, slot);
          if (ga) rt.onUpdateGroups(ga);
        }
      }
      handleRowDragEnd();
    };

    // Drag a layer onto a group header: it joins the group (which auto-expands
    // so the user sees where it lands), placed after the group's last member.
    const handleDragOverGroup = (e: React.DragEvent, groupId: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      markGroupDragOver(groupId);
      markSectionDragOver(null);
      // Group-on-group: the dragged group lands, as a block, before the target.
      if (rt.draggedGroupId) {
        if (rt.draggedGroupId !== groupId) {
          const items = buildLayerPanelItems(rt.layers, rt.groups);
          const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
          if (idx !== -1) {
            const place = dropPlace(e);
            const targetEmpty = !rt.layers.some(l => l.groupId === groupId);
            moveDraggedGroupToSlot(rt, place === 'before' ? idx : idx + 1, targetEmpty ? groupId : undefined, place);
          }
        }
        return;
      }
      if (!rt.draggedId) return;
      // Hovering the header while dragging a layer targets the group itself.
      // The drop decides: it lands ABOVE the group ("take its place") unless
      // the hover just expanded this group, in which case it joins the folder's
      // end. Holding the hover ~300ms expands a collapsed group so the user can
      // drag on into a precise member position. No live reorder here.
      armHoverExpand(rt, groupId);
    };

    // Dragging onto the end-of-list strip: a group moves its whole block to
    // the end; a layer moves (ungrouped) to the very bottom of the list - the
    // way to place a layer below a group that is itself last in the list.
    const handleListDragOver = (e: React.DragEvent) => {
      if (rt.draggedGroupId) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        moveDraggedGroupToSlot(rt, -1);
        return;
      }
      if (!rt.draggedId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const dragged = rt.layers.find(l => l.id === rt.draggedId);
      if (!dragged) return;
      const items = buildLayerPanelItems(rt.layers, rt.groups);
      const next = moveLayerToSlot(rt.layers, rt.draggedId, items, -1);
      if (next !== rt.layers) {
        rt.onReorderLayers(next);
        if (dragged.groupId) handleRowDragEnd(); // reparented out of its group
      }
      const ga = syncGroupAnchors(rt.layers, next, rt.groups, rt.draggedId, -1);
      if (ga) rt.onUpdateGroups(ga);
    };

    return {
      draggedId: rt.draggedId,
      draggedGroupId: rt.draggedGroupId,
      handleRowDragStart,
      handleRowDragOver,
      handleRowDrop,
      handleRowDragEnd,
      handleDragOverGroup,
      handleListDragOver,
    };
  };

  const raster = createKindHandlers(rasterRt);
  const vector = createKindHandlers(vectorRt);

  // --- section title handlers (strip a grouped layer's membership / top) ----

  // Drag a grouped layer onto the section title to strip its group membership.
  const sectionDragOverFor = <L extends DragReorderLayer>(e: React.DragEvent, rt: KindRuntime<L>) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markSectionDragOver(rt.kind);
    markGroupDragOver(null);
    // A dragged group dropped on the section title moves to the very top.
    if (rt.draggedGroupId) {
      moveDraggedGroupToSlot(rt, 0);
      return;
    }
    if (!rt.draggedId) return;
    const dragged = rt.layers.find(l => l.id === rt.draggedId);
    if (!dragged) return;
    // Dropping a layer on the section title moves it to the very top of
    // the list (and out of any group) - the counterpart of the
    // end-of-list strip, and the way to place a layer above a group that
    // is itself first in the list.
    const items = buildLayerPanelItems(rt.layers, rt.groups);
    const next = moveLayerToSlot(rt.layers, rt.draggedId, items, 0);
    if (next !== rt.layers) {
      rt.onReorderLayers(next);
      if (dragged.groupId) endRowDragFor(rt); // reparented out of its group
    }
    const ga = syncGroupAnchors(rt.layers, next, rt.groups, rt.draggedId, 0);
    if (ga) rt.onUpdateGroups(ga);
  };

  const handleSectionDragOver = (e: React.DragEvent, kind: LayerDragKind) => {
    if (kind === 'raster') sectionDragOverFor(e, rasterRt);
    else sectionDragOverFor(e, vectorRt);
  };

  const handleSectionDragLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      markSectionDragOver(null);
    }
  }, [markSectionDragOver]);

  // --- group children-area handlers (dead zone below the header) ------------

  // Drag over the expanded children area of a group (below the header).
  // The header has its own handlers; this covers the dead zone that appears
  // after a hover-expand (or between member rows) so the browser allows the
  // drop and the layer joins the group at its end.
  const groupChildrenDragOverFor = <L extends DragReorderLayer>(e: React.DragEvent, rt: KindRuntime<L>, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markGroupDragOver(groupId);
    markSectionDragOver(null);
    // A dragged group dropped inside another group's children area lands
    // AFTER that group (the whole block moves below).
    if (rt.draggedGroupId) {
      if (rt.draggedGroupId !== groupId) {
        const items = buildLayerPanelItems(rt.layers, rt.groups);
        const idx = items.findIndex(it => it.kind === 'group' && it.group.id === groupId);
        if (idx !== -1) moveDraggedGroupToSlot(rt, idx + 1);
      }
      return;
    }
  };

  const handleGroupChildrenDragOver = (e: React.DragEvent, kind: LayerDragKind, groupId: string) => {
    if (kind === 'raster') groupChildrenDragOverFor(e, rasterRt, groupId);
    else groupChildrenDragOverFor(e, vectorRt, groupId);
  };

  const groupChildrenDropFor = <L extends DragReorderLayer>(e: React.DragEvent, rt: KindRuntime<L>, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markGroupDragOver(null);
    clearHoverExpand();
    if (rt.draggedGroupId) { endRowDragFor(rt); return; }
    if (!rt.draggedId) return;
    joinLayerAtGroupEnd(rt, rt.draggedId, groupId);
    endRowDragFor(rt);
  };

  const handleGroupChildrenDrop = (e: React.DragEvent, kind: LayerDragKind, groupId: string) => {
    if (kind === 'raster') groupChildrenDropFor(e, rasterRt, groupId);
    else groupChildrenDropFor(e, vectorRt, groupId);
  };

  const handleGroupDragLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      markGroupDragOver(null);
      clearHoverExpand();
    }
  }, [markGroupDragOver, clearHoverExpand]);

  // --- group header drag (whole-block move) ---------------------------------

  // Same deferred-dragstart pattern as the rows: synchronous setData, state
  // update one tick later (Chrome cancels drags whose source subtree mutates
  // during dragstart).
  const handleGroupHeaderDragStart = (kind: LayerDragKind, e: React.DragEvent, groupId: string) => {
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', groupId);
    dragSessionRef.current = groupId;
    window.setTimeout(() => {
      // The drag may already be over (dragend beat this tick) - don't
      // re-apply the dragging state in that case.
      if (dragSessionRef.current !== groupId) return;
      if (kind === 'raster') setDraggedRasterGroupId(groupId);
      else setDraggedVectorGroupId(groupId);
    }, 0);
  };

  const handleGroupHeaderDragEnd = useCallback(() => {
    dragSessionRef.current = null;
    setDraggedRasterGroupId(null);
    setDraggedVectorGroupId(null);
    markGroupDragOver(null);
    markSectionDragOver(null);
  }, [markGroupDragOver, markSectionDragOver]);

  const groupHeaderDropFor = <L extends DragReorderLayer>(e: React.DragEvent, rt: KindRuntime<L>, groupId: string) => {
    e.preventDefault();
    // A layer dropped on the header lands ABOVE the group ("take its
    // place") - unless this group was just auto-expanded by the hover,
    // in which case the drop joins the folder's end. Read the flag
    // before clearHoverExpand() resets it.
    const joinAtEnd = hoverExpandedGroupRef.current === groupId;
    markGroupDragOver(null);
    clearHoverExpand();
    dropLayerOnGroupHeader(rt, groupId, joinAtEnd ? 'after' : 'before');
    if (rt.draggedId) endRowDragFor(rt);
  };

  const handleGroupHeaderDrop = (kind: LayerDragKind, e: React.DragEvent, groupId: string) => {
    if (kind === 'raster') groupHeaderDropFor(e, rasterRt, groupId);
    else groupHeaderDropFor(e, vectorRt, groupId);
  };

  return {
    raster,
    vector,
    dragOverGroupId,
    dragOverSection,
    rowDropTarget,
    markSectionDragOver,
    isHoverExpandedGroup,
    handleGroupHeaderDragStart,
    handleGroupHeaderDragEnd,
    handleGroupHeaderDrop,
    handleGroupDragLeave,
    handleGroupChildrenDragOver,
    handleGroupChildrenDrop,
    handleSectionDragOver,
    handleSectionDragLeave,
  };
}
