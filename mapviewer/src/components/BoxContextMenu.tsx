import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Icons (inline, stroke = currentColor to match the app's icon set)  */
/* ------------------------------------------------------------------ */

function FeaturesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="3 2.5" />
      <line x1="8" y1="10" x2="16" y2="10" />
      <line x1="8" y1="14" x2="14" y2="14" />
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

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export interface BoxContextMenuProps {
  /** Position (px) relative to the map container, i.e. where the cursor was. */
  x: number;
  y: number;
  onShowFeatures: () => void;
  onCopyImage: () => void;
  onSaveImage: () => void;
  onDelete: () => void;
  onClose: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  handler: () => void;
  /** Draw a separator above this item. */
  sep?: boolean;
}

/**
 * Right-click menu for the selection box. Offers feature inspection for the
 * selected area plus image capture of just the boxed region (clipboard or
 * file). Mirrors MapContextMenu's placement and keyboard behaviour and
 * reuses its styles.
 */
export function BoxContextMenu({
  x,
  y,
  onShowFeatures,
  onCopyImage,
  onSaveImage,
  onDelete,
  onClose,
}: BoxContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [placement, setPlacement] = useState({ left: x, top: y, origin: 'top left' });

  const items: MenuItem[] = [
    { id: 'box-features', label: 'Features', icon: <FeaturesIcon />, handler: onShowFeatures },
    { id: 'box-copy-image', label: 'Copy selection as image', icon: <CopyImageIcon />, handler: onCopyImage },
    { id: 'box-save-image', label: 'Save selection image as\u2026', icon: <DownloadIcon />, handler: onSaveImage },
    { id: 'box-delete', label: 'Delete selection', icon: <TrashIcon />, handler: onDelete, sep: true },
  ];

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
        setFocusedIndex((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIndex(items.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        items[focusedIndex].handler();
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      className="map-context-menu"
      role="menu"
      aria-label="Selection box actions"
      tabIndex={-1}
      style={{ left: placement.left, top: placement.top, transformOrigin: placement.origin }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {item.sep && <div className="map-context-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`map-context-menu-item${index === focusedIndex ? ' focused' : ''}`}
            onMouseEnter={() => setFocusedIndex(index)}
            onClick={item.handler}
          >
            <span className="map-context-menu-item-icon">{item.icon}</span>
            <span className="map-context-menu-item-text">
              <span className="map-context-menu-item-label">{item.label}</span>
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
