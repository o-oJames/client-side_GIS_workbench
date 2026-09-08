import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckboxIcon } from './Icons';
import { ImageDetailOptions } from '../utils/mapImageOverlays';

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

function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
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
  /** Which optional details get composited onto captured selection images. */
  imageDetails: ImageDetailOptions;
  onShowFeatures: () => void;
  onCopyImage: () => void;
  onSaveImage: () => void;
  onDelete: () => void;
  onToggleImageDetail: (key: keyof ImageDetailOptions) => void;
  onClose: () => void;
}

/**
 * Right-click menu for the selection box. Offers feature inspection for the
 * selected area plus image capture of just the boxed region (clipboard or
 * file). The two image actions expose a hover submenu with checkboxes for
 * optional overlays (scale bar, legend, north arrow) — mirroring the "Include
 * details" section in MapContextMenu but scoped to a flyout so the main menu
 * stays compact.
 *
 * Mirrors MapContextMenu's placement and keyboard behaviour and reuses its
 * styles.
 */
export function BoxContextMenu({
  x,
  y,
  imageDetails,
  onShowFeatures,
  onCopyImage,
  onSaveImage,
  onDelete,
  onToggleImageDetail,
  onClose,
}: BoxContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [placement, setPlacement] = useState({ left: x, top: y, origin: 'top left' });
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  type ActionRow = {
    type: 'action';
    id: string;
    label: string;
    icon: React.ReactNode;
    handler: () => void;
    hasSubmenu?: boolean;
    sep?: boolean;
  };
  type ToggleRow = { type: 'toggle'; id: keyof ImageDetailOptions; label: string; checked: boolean };
  type Row = ActionRow | ToggleRow;

  const overlayRows: ToggleRow[] = [
    { type: 'toggle', id: 'scaleBar', label: 'Scale bar', checked: imageDetails.scaleBar },
    { type: 'toggle', id: 'legend', label: 'Legend', checked: imageDetails.legend },
    { type: 'toggle', id: 'northArrow', label: 'North arrow', checked: imageDetails.northArrow },
  ];

  const rows: ActionRow[] = [
    { type: 'action', id: 'box-features', label: 'Features', icon: <FeaturesIcon />, handler: onShowFeatures },
    { type: 'action', id: 'box-copy-image', label: 'Copy selection as image', icon: <CopyImageIcon />, handler: onCopyImage, hasSubmenu: true },
    { type: 'action', id: 'box-save-image', label: 'Save selection image as\u2026', icon: <DownloadIcon />, handler: onSaveImage, hasSubmenu: true },
    { type: 'action', id: 'box-delete', label: 'Delete selection', icon: <TrashIcon />, handler: onDelete, sep: true },
  ];

  const openSubmenu = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setSubmenuOpen(true), 120);
  };

  const closeSubmenu = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setSubmenuOpen(false);
    setSubmenuPos(null);
  };

  /** Compute submenu position based on the parent menu's bounding rect. */
  const computeSubmenuPos = () => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const submenuWidth = 180;
    const margin = 8;
    const gap = 4;

    let left: number;
    // Flip to the left side if not enough room on the right
    if (rect.right + submenuWidth + gap > window.innerWidth - margin) {
      left = rect.left - submenuWidth - gap;
    } else {
      left = rect.right + gap;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - submenuWidth - margin));

    // Vertically align the submenu top with the parent menu top, but clamp
    // so it stays inside the viewport.
    let top = rect.top;
    const estimatedH = 30 + overlayRows.length * 36; // header + rows
    if (top + estimatedH > window.innerHeight - margin) {
      top = window.innerHeight - margin - estimatedH;
    }
    top = Math.max(margin, top);

    setSubmenuPos({ left, top });
  };

  // Recompute submenu position when it opens or when the parent menu moves.
  useLayoutEffect(() => {
    if (submenuOpen) computeSubmenuPos();
  }, [submenuOpen, placement.left, placement.top]);

  // Keep the menu fully inside the map, flipping the anchor corner it grows
  // from when the cursor is near the right/bottom edge. Runs before paint so
  // the menu never flashes in its unadjusted position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const boundsW = window.innerWidth;
    const boundsH = window.innerHeight;
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

  // Clean up hover timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // Dismiss on any interaction that isn't on the menu or submenu: an outside
  // pointer press, a scroll-wheel (map zoom/pan), resize, or lost window focus.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        submenuRef.current && !submenuRef.current.contains(target)
      ) {
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
        if (submenuOpen) {
          closeSubmenu();
        } else {
          onClose();
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (submenuOpen) {
          setFocusedIndex((i) => {
            const overlayStart = rows.length;
            const overlayEnd = rows.length + overlayRows.length - 1;
            if (i < overlayStart || i >= overlayEnd + 1) return overlayStart;
            return i + 1 > overlayEnd ? overlayStart : i + 1;
          });
        } else {
          setFocusedIndex((i) => (i + 1) % rows.length);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (submenuOpen) {
          setFocusedIndex((i) => {
            const overlayStart = rows.length;
            const overlayEnd = rows.length + overlayRows.length - 1;
            if (i <= overlayStart || i > overlayEnd) return overlayEnd;
            return i - 1 < overlayStart ? overlayEnd : i - 1;
          });
        } else {
          setFocusedIndex((i) => (i - 1 + rows.length) % rows.length);
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!submenuOpen) {
          const row = rows[focusedIndex];
          if (row.hasSubmenu) {
            openSubmenu();
            setFocusedIndex(rows.length); // focus first overlay row
          }
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (submenuOpen) {
          closeSubmenu();
          // Return focus to the first image action that has a submenu
          const parentIdx = rows.findIndex(r => r.hasSubmenu);
          if (parentIdx >= 0) setFocusedIndex(parentIdx);
        }
        break;
      case 'Home':
        e.preventDefault();
        if (submenuOpen) {
          setFocusedIndex(rows.length);
        } else {
          setFocusedIndex(0);
        }
        break;
      case 'End':
        e.preventDefault();
        if (submenuOpen) {
          setFocusedIndex(rows.length + overlayRows.length - 1);
        } else {
          setFocusedIndex(rows.length - 1);
        }
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (submenuOpen && focusedIndex >= rows.length) {
          const overlayRow = overlayRows[focusedIndex - rows.length];
          if (overlayRow) {
            onToggleImageDetail(overlayRow.id);
          }
        } else {
          const row = rows[focusedIndex];
          if (row.hasSubmenu && !submenuOpen) {
            openSubmenu();
            setFocusedIndex(rows.length);
          } else {
            row.handler();
          }
        }
        break;
      }
      default:
        break;
    }
  };

  return (
    <>
      <div
        ref={menuRef}
        className="map-context-menu"
        role="menu"
        aria-label="Selection box actions"
        tabIndex={-1}
        style={{ left: placement.left, top: placement.top, transformOrigin: placement.origin }}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        onMouseLeave={() => {
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = setTimeout(() => {
            if (!submenuRef.current?.matches(':hover')) {
              closeSubmenu();
            }
          }, 200);
        }}
      >
        {rows.map((row, index) => (
          <React.Fragment key={row.id}>
            {row.sep && <div className="map-context-menu-separator" role="separator" />}
            <button
              type="button"
              role="menuitem"
              aria-haspopup={row.hasSubmenu ? 'true' : undefined}
              aria-expanded={row.hasSubmenu ? submenuOpen : undefined}
              className={`map-context-menu-item${index === focusedIndex && !submenuOpen ? ' focused' : ''}`}
              onMouseEnter={() => {
                setFocusedIndex(index);
                if (row.hasSubmenu) {
                  openSubmenu();
                } else {
                  closeSubmenu();
                }
              }}
              onClick={() => {
                if (row.hasSubmenu && !submenuOpen) {
                  openSubmenu();
                  setFocusedIndex(rows.length);
                } else {
                  row.handler();
                }
              }}
            >
              <span className="map-context-menu-item-icon">{row.icon}</span>
              <span className="map-context-menu-item-text">
                <span className="map-context-menu-item-label">{row.label}</span>
              </span>
              {row.hasSubmenu && (
                <span className="box-context-menu-chevron">
                  <ChevronRightIcon />
                </span>
              )}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Flyout submenu for overlay checkboxes */}
      {submenuOpen && submenuPos && (
        <div
          ref={submenuRef}
          className="map-context-menu box-context-submenu"
          role="menu"
          aria-label="Include details"
          style={{ left: submenuPos.left, top: submenuPos.top }}
          onMouseEnter={() => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          }}
          onMouseLeave={() => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = setTimeout(() => {
              if (!menuRef.current?.matches(':hover')) {
                closeSubmenu();
              }
            }, 200);
          }}
        >
          <div className="map-context-menu-header">Include details</div>
          {overlayRows.map((row, i) => {
            const globalIndex = rows.length + i;
            return (
              <button
                key={`toggle-${row.id}`}
                type="button"
                role="menuitemcheckbox"
                aria-checked={row.checked}
                className={`map-context-menu-item${globalIndex === focusedIndex ? ' focused' : ''}`}
                onMouseEnter={() => setFocusedIndex(globalIndex)}
                onClick={() => onToggleImageDetail(row.id)}
              >
                <span className="map-context-menu-item-icon">
                  <CheckboxIcon checked={row.checked} />
                </span>
                <span className="map-context-menu-item-text">
                  <span className="map-context-menu-item-label">{row.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
