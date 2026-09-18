import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Stacking order ("z-order") of the floating desktop-OS surfaces — the
 * attribute table, the Vector Tools window, the Elevation Profile window and
 * the Settings panel — which all live side by side over the map.
 *
 * Each window is rendered with an inline z-index of FLOATING_WINDOW_BASE_Z +
 * its position in the stack, so clicking anywhere inside a window (the
 * component fires `bringToFront` from an onMouseDownCapture on its root)
 * raises it above its siblings, exactly like an OS window manager. A window
 * that opens joins the stack at the top; a window that closes leaves it, and
 * reopening it later counts as new — it comes back on top rather than
 * slotting into its old position.
 *
 * The stack deliberately starts at 1100: above the settings dialog, below the
 * Advanced Settings overlay (1200), the modal dialogs and the context menus.
 * Adding a new floating window = extend FloatingWindowId, push the id from
 * MapPage while the window is open, and pass zIndexFor()/bringToFront() to it.
 */

/** Bottom of the floating-window z-range. Kept clear of the Advanced
 *  Settings overlay (1200) so that dialog always covers every window. */
export const FLOATING_WINDOW_BASE_Z = 1100;

/** The floating desktop-OS surfaces managed by MapPage's stack: the three
 *  movable/resizable windows plus the Settings panel (which joins the stack
 *  only while it is open, via the z-index of its .map-settings-wrapper). */
export type FloatingWindowId = 'attrTable' | 'elevationProfile' | 'geoProcessing' | 'settings';

export interface WindowStack {
  /** Effective stacking order, bottom → top. */
  stack: FloatingWindowId[];
  /** The front-most open window (null when none is open). */
  topId: FloatingWindowId | null;
  /** The inline z-index a window should render with. */
  zIndexFor: (id: FloatingWindowId) => number;
  /** Raise a window to the top (no-op when it already is). */
  bringToFront: (id: FloatingWindowId) => void;
}

/**
 * @param activeIds The ids of the windows currently open (rendered). The
 *   array's order only decides the initial stacking of windows that appear in
 *   the same render; user interaction takes over from there.
 */
export function useWindowStack(activeIds: readonly FloatingWindowId[]): WindowStack {
  /** The remembered stacking order, bottom → top. Kept in sync with the
   *  derived stack by the effect below, so it is always the full history:
   *  closed windows drop out of it (and reopen on top), and a raise reorders
   *  the complete list rather than a partial one. */
  const [order, setOrder] = useState<FloatingWindowId[]>([]);

  // Memo key so an inline array literal from the caller does not defeat the
  // memos below (the ids, not the array identity, are what matters).
  const key = activeIds.join('|');

  // Effective order: remembered windows that are still open, in their
  // remembered order, then any window that appeared since (a freshly opened
  // one lands on top).
  const stack = useMemo(() => {
    const active = (key ? key.split('|') : []) as FloatingWindowId[];
    const kept = order.filter(id => active.includes(id));
    const fresh = active.filter(id => !kept.includes(id));
    return [...kept, ...fresh];
  }, [order, key]);

  // Fold the derived stack back into `order`. This is what forgets closed
  // windows and records new ones, keeping `order` the single complete list
  // the next bringToFront reorders. The identity check keeps it a no-op
  // (React bails out) once the two agree, so this settles after one pass.
  useEffect(() => {
    setOrder(prev =>
      prev.length === stack.length && prev.every((id, i) => id === stack[i]) ? prev : stack,
    );
  }, [stack]);

  const bringToFront = useCallback((id: FloatingWindowId) => {
    setOrder(prev =>
      prev.length > 0 && prev[prev.length - 1] === id
        ? prev // already on top — keep the state (and render) a no-op
        : [...prev.filter(x => x !== id), id],
    );
  }, []);

  const zIndexFor = useCallback(
    (id: FloatingWindowId) => {
      const i = stack.indexOf(id);
      return FLOATING_WINDOW_BASE_Z + (i < 0 ? 0 : i);
    },
    [stack],
  );

  return { stack, topId: stack.length ? stack[stack.length - 1] : null, zIndexFor, bringToFront };
}
