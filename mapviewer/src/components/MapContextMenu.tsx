import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckboxIcon } from './Icons';
import { ImageDetailOptions } from '../utils/mapImageOverlays';

/* ------------------------------------------------------------------ */
/* Icons (inline, stroke = currentColor to match the app's icon set)  */
/* ------------------------------------------------------------------ */

function CrosshairIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CopyImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 3H5a2 2 0 0 0-2 2v11" />
      <circle cx="13" cy="13" r="1.4" />
      <path d="M21 18l-4-4-7 7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export interface MapContextMenuProps {
  /** Position (px) relative to the map container, i.e. where the cursor was. */
  x: number;
  y: number;
  /** Pre-formatted coordinate string shown under, and copied by, the first item. */
  coordinateText: string;
  /** Which optional details get composited onto captured images. */
  imageDetails: ImageDetailOptions;
  onCopyCoordinates: () => void;
  onSaveImage: () => void;
  onCopyImage: () => void;
  onToggleImageDetail: (key: keyof ImageDetailOptions) => void;
  onClose: () => void;
}

type Row =
  | { type: 'action'; id: string; label: string; icon: React.ReactNode; sub?: string; handler: () => void }
  | { type: 'toggle'; id: keyof ImageDetailOptions; label: string; checked: boolean };

/**
 * In-app right-click menu for the map surface. Replaces the browser's native
 * context menu with map-aware actions: copy the clicked coordinate, save the
 * current view as a PNG, or copy that PNG to the clipboard. An "Include
 * details" subsection toggles which chrome — scale bar, legend, north arrow —
 * is composited onto the captured image.
 *
 * Behaviour: opens at the cursor, flips its anchor corner to stay inside the
 * map, supports full keyboard navigation (arrows / Home / End / Enter / Esc),
 * and dismisses on any outside interaction, scroll-wheel zoom or resize.
 */
export function MapContextMenu({
  x,
  y,
  coordinateText,
  imageDetails,
  onCopyCoordinates,
  onSaveImage,
  onCopyImage,
  onToggleImageDetail,
  onClose,
}: MapContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [placement, setPlacement] = useState({ left: x, top: y, origin: 'top left' });

  const rows: Row[] = [
    {
      type: 'action',
      id: 'copy-coordinates',
      label: 'Copy coordinates',
      sub: coordinateText,
      icon: <CrosshairIcon />,
      handler: onCopyCoordinates,
    },
    { type: 'action', id: 'save-image', label: 'Save image as\u2026', icon: <DownloadIcon />, handler: onSaveImage },
    { type: 'action', id: 'copy-image', label: 'Copy image', icon: <CopyImageIcon />, handler: onCopyImage },
    { type: 'toggle', id: 'scaleBar', label: 'Scale bar', checked: imageDetails.scaleBar },
    { type: 'toggle', id: 'legend', label: 'Legend', checked: imageDetails.legend },
    { type: 'toggle', id: 'northArrow', label: 'North arrow', checked: imageDetails.northArrow },
  ];
  const firstToggleIndex = rows.findIndex((row) => row.type === 'toggle');

  // Keep the menu fully inside the map, flipping the anchor corner it grows
  // from when the cursor is near the right/bottom edge. Runs before paint so
  // the menu never flashes in its unadjusted position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const container = el.offsetParent as HTMLElement | null;
    const boundsW = container ? container.clientWidth : window.innerWidth;
    const boundsH = container ? container.clientHeight : window.innerHeight;
    const { width: w, height: h } = el.getBoundingClientRect();
    const margin = 8;

    let originX = 'left';
    let originY = 'top';
    let left = x;
    let top = y;
    if (left + w > boundsW - margin) {
      left = x - w;
      originX = 'right';
    }
    if (top + h > boundsH - margin) {
      top = y - h;
      originY = 'bottom';
    }
    left = Math.max(margin, Math.min(left, boundsW - w - margin));
    top = Math.max(margin, Math.min(top, boundsH - h - margin));
    setPlacement({ left, top, origin: `${originY} ${originX}` });
  }, [x, y]);

  // Grab focus so keyboard navigation works from the moment it opens.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Dismiss on any interaction that isn't on the menu itself: an outside
  // pointer press, a scroll-wheel (map zoom/pan), resize, or lost window focus.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
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
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((i) => (i + 1) % rows.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + rows.length) % rows.length);
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIndex(rows.length - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const row = rows[focusedIndex];
        if (row.type === 'action') {
          row.handler();
        } else {
          onToggleImageDetail(row.id); // menu stays open while toggling
        }
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      className="map-context-menu"
      role="menu"
      aria-label="Map actions"
      tabIndex={-1}
      style={{ left: placement.left, top: placement.top, transformOrigin: placement.origin }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((row, index) => (
        <React.Fragment key={row.type === 'action' ? row.id : `toggle-${row.id}`}>
          {index === 1 && <div className="map-context-menu-separator" role="separator" />}
          {index === firstToggleIndex && (
            <>
              <div className="map-context-menu-separator" role="separator" />
              <div className="map-context-menu-header">Include details</div>
            </>
          )}
          {row.type === 'action' ? (
            <button
              type="button"
              role="menuitem"
              className={`map-context-menu-item${index === focusedIndex ? ' focused' : ''}`}
              onMouseEnter={() => setFocusedIndex(index)}
              onClick={row.handler}
            >
              <span className="map-context-menu-item-icon">{row.icon}</span>
              <span className="map-context-menu-item-text">
                <span className="map-context-menu-item-label">{row.label}</span>
                {row.sub && <span className="map-context-menu-item-sub">{row.sub}</span>}
              </span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={row.checked}
              className={`map-context-menu-item${index === focusedIndex ? ' focused' : ''}`}
              onMouseEnter={() => setFocusedIndex(index)}
              onClick={() => onToggleImageDetail(row.id)}
            >
              <span className="map-context-menu-item-icon">
                <CheckboxIcon checked={row.checked} />
              </span>
              <span className="map-context-menu-item-text">
                <span className="map-context-menu-item-label">{row.label}</span>
              </span>
            </button>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
