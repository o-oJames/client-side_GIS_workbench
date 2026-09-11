import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleDrawMode } from '../types';
import { CIRCLE_MODES } from '../utils/circleDraw';
import { CheckIcon, CircleGeometryIcon, GeodesicCircleIcon } from './Icons';

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

/** Viewport rect of the toolbar button the menu hangs off. */
export interface CircleToolMenuAnchor {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CircleToolMenuProps {
  /** The Circle tool button's viewport rect (the menu is `position: fixed`). */
  anchor: CircleToolMenuAnchor;
  /** Currently chosen flavour — ticked in the menu. */
  mode: CircleDrawMode;
  onSelect: (mode: CircleDrawMode) => void;
  onClose: () => void;
}

const MODE_ICONS: Record<CircleDrawMode, React.ReactNode> = {
  geometric: <CircleGeometryIcon />,
  geodesic: <GeodesicCircleIcon />,
};

/**
 * Right-click submenu of the draw toolbar's Circle tool: pick which circle the
 * tool draws — **Circle geometry** (a perfect circle in the map projection) or
 * **Geodesic circle** (a constant ground radius, following the earth's
 * curvature). See utils/circleDraw.ts for the geometry behind each.
 *
 * Follows the app's context-menu pattern (`.map-context-menu-*`: floating
 * white card, icon + label rows, keyboard navigation, dismiss on any outside
 * interaction). It is portalled to `document.body` because the toolbar itself
 * is transformed and scrollable, which would both clip and mis-position a
 * fixed child. Opens to the left of the button — the toolbar sits on the
 * map's right edge — and flips to the right when there is no room.
 */
export function CircleToolMenu({ anchor, mode, onSelect, onClose }: CircleToolMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(() => {
    const current = CIRCLE_MODES.findIndex((m) => m.id === mode);
    return current >= 0 ? current : 0;
  });
  const [placement, setPlacement] = useState({ left: anchor.left, top: anchor.top, origin: 'center right' });

  // Place the menu beside its button, fully inside the viewport. Runs before
  // paint so it never flashes in its unadjusted position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const margin = 8;
    const gap = 6;

    // Prefer the left of the button (the toolbar hugs the right edge).
    let left = anchor.left - w - gap;
    let originX = 'right';
    if (left < margin) {
      left = anchor.right + gap;
      originX = 'left';
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));

    // Vertically centred on the button, clamped into view.
    let top = anchor.top + (anchor.bottom - anchor.top) / 2 - h / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));

    setPlacement({ left, top, origin: `center ${originX}` });
  }, [anchor.top, anchor.right, anchor.bottom, anchor.left]);

  // Grab focus so keyboard navigation works from the moment it opens.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Dismiss on any interaction that isn't on the menu: an outside pointer
  // press, a scroll-wheel (map zoom / toolbar scroll), resize or lost focus.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleWheel = () => onClose();
    const handleResize = () => onClose();
    const handleBlur = () => onClose();

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    window.addEventListener('resize', handleResize);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('blur', handleBlur);
    };
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        // preventDefault keeps the draw session's Escape handler (which exits
        // the active tool when the event is unconsumed) from firing too.
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((i) => (i + 1) % CIRCLE_MODES.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + CIRCLE_MODES.length) % CIRCLE_MODES.length);
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIndex(CIRCLE_MODES.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(CIRCLE_MODES[focusedIndex].id);
        break;
      default:
        break;
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="map-context-menu circle-tool-menu"
      role="menu"
      aria-label="Circle tool mode"
      tabIndex={-1}
      style={{ left: placement.left, top: placement.top, transformOrigin: placement.origin }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="map-context-menu-header">Draw circle as</div>
      {CIRCLE_MODES.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          role="menuitemradio"
          aria-checked={entry.id === mode}
          className={`map-context-menu-item${index === focusedIndex ? ' focused' : ''}`}
          onMouseEnter={() => setFocusedIndex(index)}
          onClick={() => onSelect(entry.id)}
        >
          <span className="map-context-menu-item-icon">{MODE_ICONS[entry.id]}</span>
          <span className="map-context-menu-item-text">
            <span className="map-context-menu-item-label">{entry.label}</span>
            <span className="circle-tool-menu-item-desc">{entry.description}</span>
          </span>
          {entry.id === mode && (
            <span className="circle-tool-menu-check" aria-hidden="true"><CheckIcon /></span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}
