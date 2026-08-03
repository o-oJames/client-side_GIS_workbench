import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LockIcon, ResetKeyIcon, CheckboxIcon } from './Icons';

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export interface SettingsContextMenuProps {
  /** Anchor (px) relative to the map container: the gear button's top-right
   * corner. The menu flips toward the top-left to stay inside the map. */
  x: number;
  y: number;
  /** Password set (this session or persisted hash): enables lock shortcuts. */
  hasLockPassword: boolean;
  onLockApp: () => void;
  onResetPassword: () => void;
  showBasemap: boolean;
  showGrid: boolean;
  showDrawToolbar: boolean;
  showCoordinates: boolean;
  onToggleBasemap: () => void;
  onToggleGrid: () => void;
  onToggleDrawToolbar: () => void;
  onToggleCoordinates: () => void;
  onClose: () => void;
}

type Row =
  | { type: 'action'; id: string; label: string; icon: React.ReactNode; handler: () => void }
  | { type: 'toggle'; id: string; label: string; checked: boolean; handler: () => void };

/**
 * In-app right-click menu for the settings (gear) button. Offers app-lock
 * shortcuts — "Lock app" always, "Reset password" only when a password
 * exists — plus quick toggles for the four basic display settings, mirroring
 * the switches at the top of the settings dialog.
 *
 * Same interaction model as the map context menu: keyboard navigable,
 * dismisses on any outside interaction.
 */
export function SettingsContextMenu({
  x,
  y,
  hasLockPassword,
  onLockApp,
  onResetPassword,
  showBasemap,
  showGrid,
  showDrawToolbar,
  showCoordinates,
  onToggleBasemap,
  onToggleGrid,
  onToggleDrawToolbar,
  onToggleCoordinates,
  onClose,
}: SettingsContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [placement, setPlacement] = useState({ left: x, top: y, origin: 'top left' });

  const rows: Row[] = [
    ...(hasLockPassword
      ? ([
          {
            type: 'action',
            id: 'lock-app',
            label: 'Lock app',
            icon: <LockIcon />,
            handler: () => {
              onClose();
              onLockApp();
            },
          },
          {
            type: 'action',
            id: 'reset-password',
            label: 'Reset password\u2026',
            icon: <ResetKeyIcon />,
            handler: () => {
              onClose();
              onResetPassword();
            },
          },
        ] as Row[])
      : []),
    { type: 'toggle', id: 'basemap', label: 'Basemap', checked: showBasemap, handler: onToggleBasemap },
    { type: 'toggle', id: 'grid', label: 'Show grid', checked: showGrid, handler: onToggleGrid },
    { type: 'toggle', id: 'draw-toolbar', label: 'Drawing tool', checked: showDrawToolbar, handler: onToggleDrawToolbar },
    { type: 'toggle', id: 'coordinates', label: 'Show coordinates', checked: showCoordinates, handler: onToggleCoordinates },
  ];
  const firstToggleIndex = rows.findIndex((row) => row.type === 'toggle');

  // Keep the menu fully inside the map, flipping the anchor corner it grows
  // from (the gear sits at the bottom-right, so it normally opens toward the
  // top-left). Runs before paint so the menu never flashes unadjusted.
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

  // Dismiss on any interaction that isn't on the menu itself.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleResize = () => onClose();
    const handleBlur = () => onClose();

    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
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
      case ' ':
        e.preventDefault();
        rows[focusedIndex].handler();
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
      aria-label="Settings actions"
      tabIndex={-1}
      style={{ left: placement.left, top: placement.top, transformOrigin: placement.origin }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((row, index) => (
        <React.Fragment key={row.id}>
          {index === firstToggleIndex && (
            <>
              {index > 0 && <div className="map-context-menu-separator" role="separator" />}
              <div className="map-context-menu-header">Display</div>
            </>
          )}
          <button
            type="button"
            role={row.type === 'toggle' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={row.type === 'toggle' ? row.checked : undefined}
            className={`map-context-menu-item${index === focusedIndex ? ' focused' : ''}`}
            onMouseEnter={() => setFocusedIndex(index)}
            onClick={row.handler}
          >
            <span className="map-context-menu-item-icon">
              {row.type === 'toggle' ? <CheckboxIcon checked={row.checked} /> : row.icon}
            </span>
            <span className="map-context-menu-item-text">
              <span className="map-context-menu-item-label">{row.label}</span>
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
