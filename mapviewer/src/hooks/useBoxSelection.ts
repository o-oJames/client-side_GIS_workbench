/**
 * useBoxSelection — the box-selection tool. While active, dragging on the map
 * draws a dashed selection box; the finished box can be moved (drag its
 * body), resized (drag one of its eight handles) and right-clicked to open
 * the selection context menu (features / copy image / save image).
 *
 * The box is kept in map coordinates (EPSG:3857) and rendered as a plain DOM
 * element positioned inside the map viewport, re-synced on every rendered
 * frame so it tracks panning/zooming. Creation is handled by a
 * PointerInteraction that takes precedence over DragPan while the tool is
 * active; move/resize gestures are plain DOM pointer events on the box
 * element (stopped before they reach the map's interactions).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import PointerInteraction from 'ol/interaction/Pointer.js';
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
  /** Whether the box-selection tool is active. */
  active: boolean;
  /** Open the selection-box context menu at a position (px) relative to the map container. */
  onBoxContextMenu: (x: number, y: number) => void;
}

/** A drag smaller than this (in pixels) is a click, not a box. */
const MIN_BOX_PIXELS = 4;

interface BoxDragState {
  kind: 'draw' | 'move' | 'resize';
  handle?: BoxHandleId;
  /** Pointer start position — viewport pixels for draw, client pixels for move/resize. */
  startPixel: [number, number];
  /** Map coordinate of the pointer down (draw drags only). */
  startCoordinate?: [number, number];
  /** The box before this gesture began (restored on click/Escape). */
  previousExtent: BoxExtent | null;
}

export function useBoxSelection({ mapRef, active, onBoxContextMenu }: BoxSelectionDeps) {
  const [boxExtent, setBoxExtentState] = useState<BoxExtent | null>(null);
  const boxExtentRef = useRef<BoxExtent | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const dragRef = useRef<BoxDragState | null>(null);

  // Callbacks/state read from DOM event handlers registered once.
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
    (window as any).__boxExtent = extent; // TEMP DEBUG
    syncOverlay();
  }, [syncOverlay]);

  const clearBox = useCallback(() => setBoxExtent(null), [setBoxExtent]);

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

    // Move / resize gestures start on the box itself. Stopping propagation
    // keeps the map's interactions (DragPan & co.) from seeing them.
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      const map = mapRef.current;
      if (!map || !activeRef.current || e.button !== 0) return;
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
      if (!drag || drag.kind === 'draw' || !map) return;
      e.stopPropagation();
      e.preventDefault();
      const startCoord = map.getCoordinateFromPixel(clientToViewportPixel(map, drag.startPixel[0], drag.startPixel[1]));
      const curCoord = map.getCoordinateFromPixel(clientToViewportPixel(map, e.clientX, e.clientY));
      if (!startCoord || !curCoord || !drag.previousExtent) return;
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

    // Right-clicking the box opens the selection context menu instead of the
    // map's one (or the browser's native menu).
    el.addEventListener('contextmenu', (e: MouseEvent) => {
      if (!activeRef.current || !boxExtentRef.current) return;
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

    // Box creation: left-button drag on the map. Added last, so it gets the
    // first chance at events and DragPan stands aside while the tool is on.
    const interaction = new PointerInteraction({
      handleDownEvent: (evt: any) => {
        if (!activeRef.current) return false;
        const original = evt.originalEvent as PointerEvent | undefined;
        if (original && original.button !== 0) return false;
        dragRef.current = {
          kind: 'draw',
          startPixel: [...evt.pixel] as [number, number],
          startCoordinate: [...evt.coordinate] as [number, number],
          previousExtent: boxExtentRef.current ? [...boxExtentRef.current] as BoxExtent : null,
        };
        setBoxExtent(null); // hide any previous box while drawing a new one
        return true;
      },
      handleDragEvent: (evt: any) => {
        const drag = dragRef.current;
        if (!drag || drag.kind !== 'draw' || !drag.startCoordinate) return;
        setBoxExtent(normalizeExtent(drag.startCoordinate, evt.coordinate as [number, number]));
      },
      handleUpEvent: (evt: any) => {
        const drag = dragRef.current;
        if (!drag || drag.kind !== 'draw') return false;
        dragRef.current = null;
        const dxPix = Math.abs(evt.pixel[0] - drag.startPixel[0]);
        const dyPix = Math.abs(evt.pixel[1] - drag.startPixel[1]);
        if (dxPix < MIN_BOX_PIXELS && dyPix < MIN_BOX_PIXELS) {
          // Just a click — restore whatever box existed before.
          setBoxExtent(drag.previousExtent);
          return false;
        }
        if (drag.startCoordinate) {
          setBoxExtent(normalizeExtent(drag.startCoordinate, evt.coordinate as [number, number]));
        }
        return false;
      },
    });
    map.addInteraction(interaction);
    interactionRef.current = interaction;

    // Escape cancels an in-progress drag or clears the finished box.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !activeRef.current) return;
      const drag = dragRef.current;
      if (drag) {
        dragRef.current = null;
        setBoxExtent(drag.previousExtent);
      } else {
        setBoxExtent(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      map.removeInteraction(interaction);
      interactionRef.current = null;
      dragRef.current = null;
      removeOverlay();
      (map.getTargetElement() as HTMLElement).style.cursor = '';
    };
  }, [active, mapRef, ensureOverlay, removeOverlay, setBoxExtent]);

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
  };
}
