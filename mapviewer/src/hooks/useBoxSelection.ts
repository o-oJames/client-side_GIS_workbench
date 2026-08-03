/**
 * useBoxSelection — the box-selection tool. While active, two clicks on the
 * map span a dashed selection box: the first click anchors a corner (a live
 * preview follows the pointer) and the second click finishes the box.
 * Click-drag still pans the map, so navigation stays available in selection
 * mode. The finished box can be moved (drag its body), resized (drag one of
 * its eight handles) and right-clicked to open the selection context menu
 * (features / copy image / save image / delete). Deleting the box (menu or
 * Escape) lets a new one be drawn.
 *
 * The box is kept in map coordinates (EPSG:3857) and rendered as a plain DOM
 * element positioned inside the map viewport, re-synced on every rendered
 * frame so it tracks panning/zooming. Move/resize gestures are plain DOM
 * pointer events on the box element (stopped before they reach the map's
 * interactions); everything else — pan, zoom, the two placement clicks —
 * flows through the map untouched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import {
  BoxExtent,
  BoxHandleId,
  BOX_HANDLES,
  normalizeExtent,
  moveExtent,
  resizeExtent,
  extentToPixelRect,
} from '../utils/boxSelection';

export interface BoxSelectionDeps {
  mapRef: React.MutableRefObject<OLMap | null>;
  /** The map's DoubleClickZoom interaction (assigned by the map init). */
  doubleClickZoomRef: React.MutableRefObject<any>;
  /** Whether the box-selection tool is active. */
  active: boolean;
  /** Open the selection-box context menu at a position (px) relative to the map container. */
  onBoxContextMenu: (x: number, y: number) => void;
}

/** A box smaller than this (in pixels) is treated as a mis-click. */
const MIN_BOX_PIXELS = 4;

interface BoxDragState {
  kind: 'move' | 'resize';
  handle?: BoxHandleId;
  /** Pointer start position in client (page) pixels. */
  startPixel: [number, number];
  /** The box before this gesture began. */
  previousExtent: BoxExtent;
}

export function useBoxSelection({ mapRef, doubleClickZoomRef, active, onBoxContextMenu }: BoxSelectionDeps) {
  const [boxExtent, setBoxExtentState] = useState<BoxExtent | null>(null);
  const boxExtentRef = useRef<BoxExtent | null>(null);
  /** Anchored first corner while the second click is pending. */
  const anchorRef = useRef<[number, number] | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<BoxDragState | null>(null);

  // Callbacks/state read from DOM + OL handlers registered once.
  const activeRef = useRef(active);
  activeRef.current = active;
  const onBoxContextMenuRef = useRef(onBoxContextMenu);
  onBoxContextMenuRef.current = onBoxContextMenu;

  // --- Extent state ----------------------------------------------------------

  const clientToViewportPixel = useCallback((map: OLMap, clientX: number, clientY: number): [number, number] => {
    const rect = map.getViewport().getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }, []);

  /** Position the overlay element over the current extent (viewport pixels). */
  const syncOverlay = useCallback(() => {
    const map = mapRef.current;
    const el = overlayRef.current;
    if (!map || !el) return;
    const extent = boxExtentRef.current;
    if (!extent) {
      el.style.display = 'none';
      return;
    }
    const rect = extentToPixelRect(extent, (c) => map.getPixelFromCoordinate(c) as [number, number]);
    el.style.display = '';
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }, [mapRef]);

  const setBoxExtent = useCallback((extent: BoxExtent | null) => {
    boxExtentRef.current = extent;
    setBoxExtentState(extent);
    syncOverlay();
  }, [syncOverlay]);

  /** Toggle the "waiting for the second corner" look (no handles, click-through). */
  const setPending = useCallback((pending: boolean) => {
    overlayRef.current?.classList.toggle('box-select-overlay--pending', pending);
  }, []);

  /** Cancel an in-progress (anchored) box and hide the preview. */
  const cancelPending = useCallback(() => {
    anchorRef.current = null;
    setPending(false);
    setBoxExtent(null);
  }, [setPending, setBoxExtent]);

  /** Remove the box (and any pending corner) entirely. */
  const clearBox = useCallback(() => {
    anchorRef.current = null;
    setPending(false);
    setBoxExtent(null);
  }, [setPending, setBoxExtent]);

  // --- Overlay element (plain DOM, positioned inside the map viewport) --------

  const removeOverlay = useCallback(() => {
    overlayRef.current?.remove();
    overlayRef.current = null;
  }, []);

  const ensureOverlay = useCallback((): HTMLDivElement | null => {
    const map = mapRef.current;
    if (!map) return null;
    if (overlayRef.current) return overlayRef.current;

    const el = document.createElement('div');
    el.className = 'box-select-overlay';
    BOX_HANDLES.forEach((h) => {
      const handle = document.createElement('div');
      handle.className = `box-select-handle box-select-handle--${h}`;
      handle.dataset.handle = h;
      el.appendChild(handle);
    });

    // Move / resize gestures start on the finished box itself. Stopping
    // propagation keeps the map's interactions (DragPan & co.) from seeing
    // them. While a corner is pending the overlay is click-through (CSS).
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      const map = mapRef.current;
      if (!map || !activeRef.current || e.button !== 0 || anchorRef.current) return;
      const extent = boxExtentRef.current;
      if (!extent) return;
      const target = e.target as HTMLElement;
      const handleId = (target.dataset && target.dataset.handle) as BoxHandleId | undefined;
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = {
        kind: handleId ? 'resize' : 'move',
        handle: handleId,
        startPixel: [e.clientX, e.clientY],
        previousExtent: [...extent] as BoxExtent,
      };
      if (typeof el.setPointerCapture === 'function') {
        try { el.setPointerCapture(e.pointerId); } catch { /* older jsdom */ }
      }
    });

    el.addEventListener('pointermove', (e: PointerEvent) => {
      const drag = dragRef.current;
      const map = mapRef.current;
      if (!drag || !map) return;
      e.stopPropagation();
      e.preventDefault();
      const startCoord = map.getCoordinateFromPixel(clientToViewportPixel(map, drag.startPixel[0], drag.startPixel[1]));
      const curCoord = map.getCoordinateFromPixel(clientToViewportPixel(map, e.clientX, e.clientY));
      if (!startCoord || !curCoord) return;
      const dx = curCoord[0] - startCoord[0];
      const dy = curCoord[1] - startCoord[1];
      const minSize = MIN_BOX_PIXELS * (map.getView().getResolution() || 0);
      const next = drag.kind === 'move'
        ? moveExtent(drag.previousExtent, dx, dy)
        : resizeExtent(drag.previousExtent, drag.handle as BoxHandleId, dx, dy, minSize);
      setBoxExtent(next);
    });

    const endDrag = (e: PointerEvent) => {
      if (!dragRef.current) return;
      e.stopPropagation();
      dragRef.current = null;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    // Right-clicking the finished box opens the selection context menu
    // instead of the map's one (or the browser's native menu).
    el.addEventListener('contextmenu', (e: MouseEvent) => {
      if (!activeRef.current || !boxExtentRef.current || anchorRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const map = mapRef.current;
      if (!map) return;
      const container = map.getTargetElement() || map.getViewport();
      const containerRect = container.getBoundingClientRect();
      onBoxContextMenuRef.current(e.clientX - containerRect.left, e.clientY - containerRect.top);
    });

    // Insert before the overlay containers so popups stay above the box,
    // while the box stays above the layer canvases.
    const viewport = map.getViewport();
    const overlayContainer = viewport.querySelector('.ol-overlaycontainer-stopevent');
    if (overlayContainer) viewport.insertBefore(el, overlayContainer);
    else viewport.appendChild(el);
    overlayRef.current = el;
    syncOverlay();
    return el;
  }, [mapRef, clientToViewportPixel, setBoxExtent, syncOverlay]);

  // --- Activation lifecycle ----------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !active) return;

    (map.getTargetElement() as HTMLElement).style.cursor = 'crosshair';
    ensureOverlay();

    // Two-click creation. OL only dispatches 'click' when the pointer didn't
    // drag, so pans and box gestures never land here.
    const onClick = (evt: any) => {
      if (!activeRef.current) return;
      const coord = evt.coordinate as [number, number];
      const anchor = anchorRef.current;
      if (!anchor) {
        // First corner — anchor it and seed the preview at zero size.
        anchorRef.current = [...coord] as [number, number];
        setPending(true);
        setBoxExtent([...coord, ...coord] as BoxExtent);
        return;
      }
      // Second corner — a near-zero box is a mis-click: restart from here.
      const p1 = map.getPixelFromCoordinate(anchor);
      const p2 = map.getPixelFromCoordinate(coord);
      if (p1 && p2 &&
          Math.abs(p1[0] - p2[0]) < MIN_BOX_PIXELS &&
          Math.abs(p1[1] - p2[1]) < MIN_BOX_PIXELS) {
        anchorRef.current = [...coord] as [number, number];
        return;
      }
      anchorRef.current = null;
      setPending(false);
      setBoxExtent(normalizeExtent(anchor, coord));
    };
    map.on('click', onClick);

    // Live preview: the pending box tracks the pointer (also while panning).
    const onPointerMove = (evt: any) => {
      if (!activeRef.current || !anchorRef.current) return;
      setBoxExtent(normalizeExtent(anchorRef.current, evt.coordinate as [number, number]));
    };
    map.on('pointermove', onPointerMove);

    // Right-clicking while a corner is pending drops the pending box and
    // lets the map's own context menu take over.
    const onViewportContextMenu = () => {
      if (anchorRef.current) cancelPending();
    };
    map.getViewport().addEventListener('contextmenu', onViewportContextMenu);

    // Two quick corner clicks must not zoom the map.
    doubleClickZoomRef.current?.setActive(false);

    // Escape cancels a pending corner or clears the finished box.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !activeRef.current) return;
      if (anchorRef.current) {
        cancelPending();
      } else {
        setBoxExtent(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      map.un('click', onClick);
      map.un('pointermove', onPointerMove);
      map.getViewport().removeEventListener('contextmenu', onViewportContextMenu);
      doubleClickZoomRef.current?.setActive(true);
      dragRef.current = null;
      anchorRef.current = null;
      removeOverlay();
      (map.getTargetElement() as HTMLElement).style.cursor = '';
    };
  }, [active, mapRef, doubleClickZoomRef, ensureOverlay, removeOverlay, setBoxExtent, cancelPending, setPending]);

  // Re-sync the box whenever the view renders (pan/zoom/resize animations).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !active) return;
    map.on('postrender', syncOverlay);
    syncOverlay();
    return () => {
      map.un('postrender', syncOverlay);
    };
  }, [active, mapRef, syncOverlay]);

  // Leaving the tool drops any box so a stale selection never survives.
  useEffect(() => {
    if (!active && boxExtentRef.current) {
      boxExtentRef.current = null;
      setBoxExtentState(null);
    }
  }, [active]);

  return {
    /** Current selection extent (map coordinates), for UI/readouts. */
    boxExtent,
    /** Latest extent for use inside event handlers. */
    getBoxExtent: () => boxExtentRef.current,
    /** Programmatically clear the selection box. */
    clearBox,
    /** Live mirror of `active` for OL callbacks registered once. */
    activeRef,
  };
}
