import React, { useState, useRef, useEffect } from 'react';
import { LayerGroup } from '../types';

// ---------------------------------------------------------------------------
// Layer groups (folders) - panel-side helpers
// ---------------------------------------------------------------------------

export function makeGroupId(): string {
  return 'group-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Stable key of a layer list's order + group membership. Dragover events fire
 * continuously while dragging; comparing this key skips no-op reorder updates.
 */
export function layerOrderKey(layers: Array<{ id: string; groupId?: string }>): string {
  return layers.map(l => l.id + ':' + (l.groupId || '')).join('|');
}

export type LayerPanelItem<L> =
  | { kind: 'group'; group: LayerGroup; members: L[] }
  | { kind: 'layer'; layer: L };

/**
 * Panel order: the flat layer list, with each group rendered as one block at
 * the position of its FIRST member - so groups and ungrouped layers
 * interleave freely and reordering layers moves blocks around with them.
 * Empty groups have no members to anchor them, so they are placed at their
 * persisted `afterId` slot (null = top, layer/group id = after that item,
 * undefined/unknown = end).
 */
export function buildLayerPanelItems<L extends { id: string; groupId?: string }>(
  layers: L[],
  groups: LayerGroup[]
): Array<LayerPanelItem<L>> {
  const items: Array<LayerPanelItem<L>> = [];
  const placed = new Set<string>();
  for (const layer of layers) {
    const group = layer.groupId ? groups.find(g => g.id === layer.groupId) : undefined;
    if (group) {
      if (!placed.has(group.id)) {
        placed.add(group.id);
        items.push({ kind: 'group', group, members: layers.filter(l => l.groupId === group.id) });
      }
      // Grouped layers render inside their group block, not at the top level.
    } else {
      items.push({ kind: 'layer', layer });
    }
  }
  // Empty groups, at their anchored slots. Anchors may reference other empty
  // groups, so resolve in passes until nothing new can be placed.
  let pending = groups.filter(g => !placed.has(g.id));
  let guard = pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const deferred: LayerGroup[] = [];
    for (const group of pending) {
      const item: LayerPanelItem<L> = { kind: 'group', group, members: [] };
      const anchor = group.afterId;
      if (anchor === null) {
        items.unshift(item);
        placed.add(group.id);
      } else if (!anchor) {
        items.push(item);
        placed.add(group.id);
      } else {
        const idx = items.findIndex(it => (it.kind === 'layer' ? it.layer.id === anchor : it.group.id === anchor));
        if (idx === -1) {
          deferred.push(group); // anchor not placed yet - retry next pass
        } else {
          items.splice(idx + 1, 0, item);
          placed.add(group.id);
        }
      }
    }
    if (deferred.length === pending.length) {
      // Unresolvable anchors (stale ids/cycles): fall back to the end.
      deferred.forEach(g => items.push({ kind: 'group', group: g, members: [] }));
      break;
    }
    pending = deferred;
  }
  return items;
}

/** Index of the panel item that contains the given layer (its row or block). */
export function itemIdxOfLayer<L extends { id: string; groupId?: string }>(items: Array<LayerPanelItem<L>>, layerId: string): number {
  return items.findIndex(it => (it.kind === 'layer' ? it.layer.id === layerId : it.members.some(m => m.id === layerId)));
}

/**
 * The `afterId` value for an empty group dropped at panel position `slot`
 * (null = top, undefined = end of list, otherwise the id of the item that
 * will sit just above it).
 */
export function slotAfterId<L extends { id: string; groupId?: string }>(items: Array<LayerPanelItem<L>>, slot: number): string | null | undefined {
  if (slot < 0) return undefined;
  if (slot === 0) return null;
  const prev = items[slot - 1];
  if (!prev) return undefined;
  if (prev.kind === 'layer') return prev.layer.id;
  if (prev.members.length > 0) return prev.members[prev.members.length - 1].id;
  return prev.group.id; // anchoring to an empty group is fine - it resolves recursively
}

/**
 * Move a group's member layers so the whole block occupies panel slot `slot`
 * (0 = top, -1 = end). The block stays contiguous; other layers keep their
 * relative order. Returns the original reference when nothing changes.
 */
export function moveGroupToSlot<L extends { id: string; groupId?: string }>(
  layers: L[],
  groupId: string,
  items: Array<LayerPanelItem<L>>,
  slot: number
): L[] {
  const members = layers.filter(l => l.groupId === groupId);
  if (members.length === 0) return layers;
  // Flat index of the first real layer at/after the slot (empty-group items
  // have no layers of their own - look through to the next item).
  let flatAt = layers.length;
  if (slot >= 0) {
    for (let j = slot; j < items.length; j++) {
      const it = items[j];
      const firstId = it.kind === 'layer' ? it.layer.id : it.members[0]?.id;
      if (firstId) {
        const fi = layers.findIndex(l => l.id === firstId);
        if (fi !== -1) { flatAt = fi; break; }
      }
    }
  }
  const rest = layers.filter(l => l.groupId !== groupId);
  const insertAt = layers.slice(0, flatAt).filter(l => l.groupId !== groupId).length;
  const next = [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)];
  return layerOrderKey(next) === layerOrderKey(layers) ? layers : next;
}

/**
 * Move a layer INTO a group at the position of a member row: 'before' or
 * 'after' the target row within the group's member list. Returns the
 * original reference when nothing changes.
 */
export function moveLayerToJoinAt<L extends { id: string; groupId?: string }>(
  layers: L[],
  layerId: string,
  groupId: string,
  targetId: string,
  place: 'before' | 'after'
): L[] {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return layers;
  const rest = layers.filter(l => l.id !== layerId);
  const targetIdx = rest.findIndex(l => l.id === targetId);
  if (targetIdx === -1) return layers;
  const insertAt = place === 'before' ? targetIdx : targetIdx + 1;
  const next = [...rest.slice(0, insertAt), { ...layer, groupId }, ...rest.slice(insertAt)];
  return layerOrderKey(next) === layerOrderKey(layers) ? layers : next;
}

/**
 * Move a single layer so it occupies panel slot `slot` (0 = top, -1 = end),
 * leaving any group it belonged to - dragging reorders, the folder button
 * manages membership. Returns the original reference when nothing changes.
 */
export function moveLayerToSlot<L extends { id: string; groupId?: string }>(
  layers: L[],
  layerId: string,
  items: Array<LayerPanelItem<L>>,
  slot: number
): L[] {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return layers;
  // Flat index of the first real layer at/after the slot (empty-group items
  // have no layers - look through to the next item).
  let flatAt = layers.length;
  if (slot >= 0) {
    for (let j = slot; j < items.length; j++) {
      const it = items[j];
      const firstId = it.kind === 'layer' ? it.layer.id : it.members[0]?.id;
      if (firstId) {
        const fi = layers.findIndex(l => l.id === firstId);
        if (fi !== -1) { flatAt = fi; break; }
      }
    }
  }
  const rest = layers.filter(l => l.id !== layerId);
  const insertAt = layers.slice(0, flatAt).filter(l => l.id !== layerId).length;
  const moved = layer.groupId ? { ...layer, groupId: undefined } : layer;
  const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  return layerOrderKey(next) === layerOrderKey(layers) ? layers : next;
}

/**
 * Flat-array position where a layer joining the (currently empty) group
 * should land so the group materialises at its anchored panel slot.
 */
export function flatIndexForGroupSlot<L extends { id: string; groupId?: string }>(layers: L[], groups: LayerGroup[], groupId: string): number {
  const group = groups.find(g => g.id === groupId);
  const after = group ? group.afterId : undefined;
  if (after === null) return 0;
  if (!after) return layers.length;
  const idx = layers.findIndex(l => l.id === after);
  if (idx !== -1) {
    const anchorGroup = layers[idx].groupId;
    if (anchorGroup) {
      let last = idx;
      layers.forEach((l, i) => { if (l.groupId === anchorGroup) last = i; });
      return last + 1;
    }
    return idx + 1;
  }
  // Anchor references a group: sit after that group's last member.
  let last = -1;
  layers.forEach((l, i) => { if (l.groupId === after) last = i; });
  return last === -1 ? layers.length : last + 1;
}

/**
 * After a layer move, anchor any group that lost its last member so the
 * now-empty folder stays at its current panel position instead of jumping
 * to the end of the list. The anchor is computed from the NEW panel layout
 * (with the moved layer in its new position) so the folder sits where the
 * user sees it.
 */
export function anchorEmptiedGroups<L extends { id: string; groupId?: string }>(
  oldLayers: L[],
  newLayers: L[],
  groups: LayerGroup[]
): LayerGroup[] | null {
  const oldGroupIds = new Set(oldLayers.filter(l => l.groupId).map(l => l.groupId!));
  const newGroupIds = new Set(newLayers.filter(l => l.groupId).map(l => l.groupId!));
  const emptiedIds = Array.from(oldGroupIds).filter(id => !newGroupIds.has(id) && groups.some(g => g.id === id));
  if (emptiedIds.length === 0) return null;

  // Old panel position of each emptied group (to preserve its slot).
  const oldItems = buildLayerPanelItems(oldLayers, groups);

  // New panel WITHOUT the emptied groups - used to compute their anchors.
  const survivingGroups = groups.filter(g => !emptiedIds.includes(g.id));
  const newItems = buildLayerPanelItems(newLayers, survivingGroups);

  let changed = false;
  const result = groups.map(g => {
    if (!emptiedIds.includes(g.id)) return g;
    const oldIdx = oldItems.findIndex(it => it.kind === 'group' && it.group.id === g.id);
    if (oldIdx === -1) return g;

    // Anchor the group relative to the item that was BELOW it in the old
    // panel.  Using the raw old index fails when the group's former member
    // is now a standalone item occupying the same slot - the folder would
    // land before its former member instead of after it.
    let newAfterId: string | null | undefined;
    if (oldIdx >= oldItems.length - 1) {
      // Group was at the very end - keep it there.
      newAfterId = slotAfterId(newItems, newItems.length);
    } else {
      const belowItem = oldItems[oldIdx + 1];
      let belowNewIdx = -1;
      if (belowItem.kind === 'layer') {
        const bid = belowItem.layer.id;
        belowNewIdx = newItems.findIndex(it =>
          it.kind === 'layer' ? it.layer.id === bid : it.members.some(m => m.id === bid)
        );
      } else {
        belowNewIdx = newItems.findIndex(it => it.kind === 'group' && it.group.id === belowItem.group.id);
      }
      if (belowNewIdx === -1) {
        // The item below no longer exists; fall back to clamped old index.
        newAfterId = slotAfterId(newItems, Math.min(oldIdx, newItems.length));
      } else {
        // Place the group just before the item-below's new position.
        newAfterId = slotAfterId(newItems, belowNewIdx);
      }
    }

    if (newAfterId === g.afterId) return g;
    changed = true;
    return { ...g, afterId: newAfterId };
  });
  return changed ? result : null;
}

/**
 * After moving a layer to a panel slot, re-anchor any empty groups that the
 * layer crossed so they stay on the correct side. Without this, dragging the
 * only ungrouped layer past an empty folder is a no-op (the flat array does
 * not change) and the folder never moves.
 */
export function reanchorCrossedEmptyGroups<L extends { id: string; groupId?: string }>(
  layers: L[],
  groups: LayerGroup[],
  layerId: string,
  targetSlot: number,
  skipIds?: Set<string>
): LayerGroup[] | null {
  const items = buildLayerPanelItems(layers, groups);
  const layerIdx = items.findIndex(it => it.kind === 'layer' && it.layer.id === layerId);
  if (layerIdx === -1) return null;

  const effectiveTarget = targetSlot < 0 ? items.length - 1 : targetSlot;
  if (layerIdx === effectiveTarget) return null;

  const emptyGroupIds = new Set(
    groups.filter(g => !layers.some(l => l.groupId === g.id) && !(skipIds && skipIds.has(g.id))).map(g => g.id)
  );
  const crossed = Array.from(emptyGroupIds).filter(gid => {
    const groupIdx = items.findIndex(it => it.kind === 'group' && it.group.id === gid);
    if (groupIdx === -1) return false;
    return layerIdx < effectiveTarget
      ? groupIdx > layerIdx && groupIdx <= effectiveTarget
      : groupIdx < layerIdx && groupIdx >= effectiveTarget;
  });
  if (crossed.length === 0) return null;

  // Build the panel with the layer at its new slot to derive correct anchors.
  const layerItem = items[layerIdx];
  const itemsWithout = items.filter((_, i) => i !== layerIdx);
  const insertAt = targetSlot < 0 ? itemsWithout.length : Math.min(targetSlot, itemsWithout.length);
  const newItems = [...itemsWithout.slice(0, insertAt), layerItem, ...itemsWithout.slice(insertAt)];

  let changed = false;
  const result = groups.map(g => {
    if (!crossed.includes(g.id)) return g;
    const newIdx = newItems.findIndex(it => it.kind === 'group' && it.group.id === g.id);
    if (newIdx === -1) return g;
    const newAfterId = slotAfterId(newItems, newIdx);
    if (newAfterId === g.afterId) return g;
    changed = true;
    return { ...g, afterId: newAfterId };
  });
  return changed ? result : null;
}


/**
 * After a layer moves, re-anchor any empty group whose `afterId` references
 * the moved layer directly.  Without this the group "follows" the layer to
 * its new position instead of staying at its old panel slot.
 */
export function reanchorGroupsChainedToMovedLayer<L extends { id: string; groupId?: string }>(
  oldLayers: L[],
  newLayers: L[],
  groups: LayerGroup[],
  movedLayerId: string,
  skipIds?: Set<string>
): LayerGroup[] | null {
  // Empty groups anchored directly to the moved layer.
  const affected = groups.filter(g =>
    g.afterId === movedLayerId && !newLayers.some(l => l.groupId === g.id)
      && !(skipIds && skipIds.has(g.id))
  );
  if (affected.length === 0) return null;

  const affectedIds = new Set(affected.map(g => g.id));

  // Old panel position of each affected group.
  const oldItems = buildLayerPanelItems(oldLayers, groups);

  // New panel WITHOUT the affected groups - used to compute their new anchors.
  const survivingGroups = groups.filter(g => !affectedIds.has(g.id));
  const newItems = buildLayerPanelItems(newLayers, survivingGroups);

  let changed = false;
  const result = groups.map(g => {
    if (!affectedIds.has(g.id)) return g;
    const oldIdx = oldItems.findIndex(it => it.kind === 'group' && it.group.id === g.id);
    if (oldIdx === -1) return g;
    const clampedIdx = Math.min(oldIdx, newItems.length);
    const newAfterId = slotAfterId(newItems, clampedIdx);
    if (newAfterId === g.afterId) return g;
    changed = true;
    return { ...g, afterId: newAfterId };
  });
  return changed ? result : null;
}

/**
 * Combined anchor sync: call after any layer move (reorder, reparent,
 * extreme-slot drop). Returns updated groups or null when nothing changed.
 */
export function syncGroupAnchors<L extends { id: string; groupId?: string }>(
  oldLayers: L[],
  newLayers: L[],
  groups: LayerGroup[],
  movedLayerId: string,
  targetSlot: number
): LayerGroup[] | null {
  let current = groups;
  const anchored = anchorEmptiedGroups(oldLayers, newLayers, current);
  if (anchored) current = anchored;
  // Groups that just lost their last member are already anchored by step 1;
  // skip them in subsequent steps so their anchors are not overridden.
  const justEmptied = new Set(
    Array.from(new Set(oldLayers.filter(l => l.groupId).map(l => l.groupId!)))
      .filter(id => !newLayers.some(l => l.groupId === id) && groups.some(g => g.id === id))
  );
  // Re-anchor empty groups that were chained to the moved layer so they
  // stay at their old panel position instead of following the layer.
  const chained = reanchorGroupsChainedToMovedLayer(oldLayers, newLayers, current, movedLayerId, justEmptied);
  if (chained) current = chained;
  const crossed = reanchorCrossedEmptyGroups(newLayers, current, movedLayerId, targetSlot, justEmptied);
  if (crossed) current = crossed;
  return current === groups ? null : current;
}

/**
 * Group visibility toggle with per-layer memory. While any member is
 * visible, toggling hides every member and records each layer's own
 * visibility in `groupHiddenVisible`; when every member is hidden, toggling
 * restores those recorded states (defaulting to visible) and clears them.
 * Individual on/off choices therefore survive a group off -> on cycle.
 */
export function toggleGroupLayerVisibility<L extends { id: string; groupId?: string; visible?: boolean; groupHiddenVisible?: boolean }>(
  layers: L[],
  groupId: string
): L[] {
  const members = layers.filter(l => l.groupId === groupId);
  if (members.length === 0) return layers;
  const noneVisible = members.every(l => l.visible === false);
  if (noneVisible) {
    return layers.map(l => {
      if (l.groupId !== groupId) return l;
      const restore = l.groupHiddenVisible !== undefined ? l.groupHiddenVisible : true;
      const { groupHiddenVisible, ...rest } = l;
      return { ...rest, visible: restore } as L;
    });
  }
  return layers.map(l => {
    if (l.groupId !== groupId) return l;
    return { ...l, groupHiddenVisible: l.visible !== false, visible: false };
  });
}

/**
 * Move a layer into (or out of) a group, keeping it adjacent to its new group
 * members so the panel order and map stacking order stay consistent. Returns
 * the original array reference when nothing changes.
 */
export function moveLayerToGroup<L extends { id: string; groupId?: string }>(
  layers: L[],
  layerId: string,
  groupId: string | undefined
): L[] {
  const layer = layers.find(l => l.id === layerId);
  if (!layer || layer.groupId === groupId) return layers;
  const next = layers.filter(l => l.id !== layerId);
  const moved = { ...layer, groupId };
  if (groupId) {
    let lastMemberIdx = -1;
    next.forEach((l, i) => { if (l.groupId === groupId) lastMemberIdx = i; });
    if (lastMemberIdx === -1) next.push(moved);
    else next.splice(lastMemberIdx + 1, 0, moved);
    return next;
  }
  // Leaving a group: keep the layer where it was, now ungrouped.
  const origIdx = layers.findIndex(l => l.id === layerId);
  next.splice(Math.min(origIdx, next.length), 0, moved);
  return next;
}

export function FolderIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

export function FolderPlusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/>
      <line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  );
}

/**
 * Tri-state eye for a group header: all members visible, some visible, or
 * none visible. Clicking toggles every member at once (handled by the parent
 * dialog - this component is display-only).
 */
export function GroupEyeIcon({ state }: { state: 'all' | 'some' | 'none' }) {
  if (state === 'none') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
    );
  }
  return (
    <span className={'group-eye' + (state === 'some' ? ' partial' : '')}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      {state === 'some' && <span className="group-eye-dash" />}
    </span>
  );
}

/**
 * Per-layer "move to group" popover: pick an existing group, leave the
 * current group, or create a new group on the spot.
 */
export function GroupAssignMenu({
  groups,
  currentGroupId,
  onAssign,
  onCreateGroup,
}: {
  groups: LayerGroup[];
  currentGroupId?: string;
  onAssign: (groupId: string | undefined) => void;
  onCreateGroup: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false); setCreating(false); setNewName('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); setCreating(false); setNewName(''); };

  return (
    <div className="group-assign" ref={rootRef}>
      <button
        type="button"
        className={'settings-layer-group-btn' + (currentGroupId ? ' assigned' : '')}
        title={currentGroupId ? 'Move to another group' : 'Add to a group'}
        onClick={() => setOpen(o => !o)}
      >
        <FolderIcon />
      </button>
      {open && (
        <div className="group-assign-menu">
          <div className="group-assign-title">Move to group</div>
          {currentGroupId && (
            <button type="button" className="group-assign-item" onClick={() => { onAssign(undefined); close(); }}>
              <span className="group-assign-check" />No group
            </button>
          )}
          {groups.map(g => (
            <button
              key={g.id}
              type="button"
              className={'group-assign-item' + (g.id === currentGroupId ? ' current' : '')}
              onClick={() => { if (g.id !== currentGroupId) onAssign(g.id); close(); }}
            >
              <span className="group-assign-check">{g.id === currentGroupId ? '\u2713' : ''}</span>
              <FolderIcon />
              <span className="group-assign-name">{g.name}</span>
            </button>
          ))}
          {groups.length === 0 && !currentGroupId && (
            <div className="group-assign-empty">No groups yet</div>
          )}
          <div className="group-assign-divider" />
          {creating ? (
            <div className="group-assign-create">
              <input
                autoFocus
                type="text"
                className="settings-input"
                placeholder="Group name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) { onCreateGroup(newName.trim()); close(); }
                  if (e.key === 'Escape') close();
                }}
              />
              <button
                type="button"
                className="settings-button-primary group-assign-create-btn"
                disabled={!newName.trim()}
                onClick={() => { onCreateGroup(newName.trim()); close(); }}
              >Create</button>
            </div>
          ) : (
            <button type="button" className="group-assign-item" onClick={() => setCreating(true)}>
              <span className="group-assign-check" />+ New group…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which side of the hovered row/header the pointer is on: a dragged group
 * lands BEFORE the target when the pointer is in its top half, AFTER it when
 * in the bottom half. Anchoring placement to the pointer - not to the array
 * order - is what keeps live reordering stable: after a swap the pointer is
 * in the half that matches the new order, so repeated dragover events (they
 * fire continuously) are no-ops instead of flipping the order back and forth.
 */
export function dropPlace(e: React.DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
}

/** Enter/Space activation for the span-based group-header actions (a11y). */
export function spanActivate(fn: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}
