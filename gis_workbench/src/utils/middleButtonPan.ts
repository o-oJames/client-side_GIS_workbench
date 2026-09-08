/**
 * Middle-button drag panning for the map viewport.
 *
 * OpenLayers' event pipeline only accepts primary-button presses
 * (`MapBrowserEventHandler` gates pointerdown on `button === 0`), so no
 * interaction — neither DragPan nor the geometry-editing Modify/Translate
 * pair — ever sees a middle-button press. This helper installs
 * capture-phase listeners on the map viewport that turn a middle-button
 * drag into a pan, letting the user move around the map in any mode —
 * most importantly while a geometry-edit session would otherwise grab
 * vertices or feature bodies under the pointer.
 *
 * React-free by design (utils/ contract): it operates on a structural
 * subset of `ol/Map` so it can be unit-tested without a real map.
 */

export interface MiddleButtonPanView {
  getCenter(): number[] | undefined;
  setCenter(center: number[]): void;
}

/** The subset of `ol/Map` the pan handler needs. */
export interface MiddleButtonPanMap {
  getViewport(): HTMLElement;
  getView(): MiddleButtonPanView;
  getEventPixel(event: { clientX: number; clientY: number }): number[];
  getCoordinateFromPixel(pixel: number[]): number[];
}

export interface MiddleButtonPanHandle {
  /** Remove all listeners and restore the viewport. */
  detach(): void;
}

/** Class toggled on the viewport while a middle-button pan is in progress. */
export const MIDDLE_PAN_CLASS = 'map-middle-button-panning';

const MIDDLE_BUTTON = 1;
/** `buttons` bitmask for "middle button currently held". */
const MIDDLE_BUTTONS_MASK = 4;

export function attachMiddleButtonPan(map: MiddleButtonPanMap): MiddleButtonPanHandle {
  const viewport = map.getViewport();
  let panning = false;
  let lastPixel: number[] | null = null;
  let activePointerId: number | null = null;

  // A drag starts only when the press lands on the map surface itself —
  // never on popups/controls rendered inside the viewport overlays.
  const isMapSurface = (target: EventTarget | null): boolean =>
    target === viewport || target instanceof HTMLCanvasElement;

  // Incremental pan: shift the centre by the map-space distance between the
  // previous and current pointer pixels. Going through getCoordinateFromPixel
  // keeps the math correct for any view rotation and resolution.
  const onPointerMove = (event: PointerEvent) => {
    if (!panning || !lastPixel) return;
    // Safety net: the middle button is no longer held (e.g. released
    // outside the window without a pointerup reaching us).
    if (typeof event.buttons === 'number' && (event.buttons & MIDDLE_BUTTONS_MASK) === 0) {
      endPan(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pixel = map.getEventPixel(event);
    const view = map.getView();
    const center = view.getCenter();
    if (!center) return;
    const prevCoord = map.getCoordinateFromPixel(lastPixel);
    const curCoord = map.getCoordinateFromPixel(pixel);
    lastPixel = pixel;
    if (!prevCoord || !curCoord) return;
    view.setCenter([
      center[0] + prevCoord[0] - curCoord[0],
      center[1] + prevCoord[1] - curCoord[1],
    ]);
  };

  const endPan = (event: PointerEvent) => {
    if (!panning) return;
    panning = false;
    lastPixel = null;
    event.preventDefault();
    event.stopPropagation();
    viewport.classList.remove(MIDDLE_PAN_CLASS);
    if (activePointerId !== null && typeof viewport.releasePointerCapture === 'function') {
      try {
        viewport.releasePointerCapture(activePointerId);
      } catch {
        /* capture already released */
      }
    }
    activePointerId = null;
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!panning) return;
    // Releasing some other button (e.g. the left one pressed mid-drag)
    // does not end the middle-button pan; only middle-up or a cancel does.
    if (event.type !== 'pointercancel' && event.button !== MIDDLE_BUTTON) return;
    endPan(event);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (panning || event.button !== MIDDLE_BUTTON) return;
    if (event.pointerType === 'touch') return;
    if (!isMapSurface(event.target)) return;
    // preventDefault suppresses the browser's middle-click autoscroll (the
    // compatibility mousedown never fires); stopPropagation keeps the press
    // out of any other viewport-level bookkeeping.
    event.preventDefault();
    event.stopPropagation();
    panning = true;
    activePointerId = event.pointerId ?? null;
    lastPixel = map.getEventPixel(event);
    viewport.classList.add(MIDDLE_PAN_CLASS);
    if (activePointerId !== null && typeof viewport.setPointerCapture === 'function') {
      try {
        viewport.setPointerCapture(activePointerId);
      } catch {
        /* capture unsupported — document listeners still cover the drag */
      }
    }
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
  };

  // Backstop for environments that still deliver a compatibility mousedown:
  // never let the browser start its middle-click autoscroll.
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === MIDDLE_BUTTON) event.preventDefault();
  };

  viewport.addEventListener('pointerdown', onPointerDown, true);
  viewport.addEventListener('mousedown', onMouseDown, true);

  return {
    detach() {
      if (panning) {
        panning = false;
        lastPixel = null;
        viewport.classList.remove(MIDDLE_PAN_CLASS);
        if (activePointerId !== null && typeof viewport.releasePointerCapture === 'function') {
          try {
            viewport.releasePointerCapture(activePointerId);
          } catch {
            /* ignore */
          }
        }
        activePointerId = null;
      }
      viewport.removeEventListener('pointerdown', onPointerDown, true);
      viewport.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
    },
  };
}
