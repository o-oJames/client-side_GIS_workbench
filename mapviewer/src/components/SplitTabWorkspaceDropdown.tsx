import { useEffect, useRef, useState } from 'react';
import { WorkspaceMeta } from '../types';
import { ChevronDownIcon, CheckIcon } from './Icons';

interface SplitTabWorkspaceDropdownProps {
  workspaces: WorkspaceMeta[];
  /** Workspace currently shown on this side — flagged with a check mark. */
  selectedId: string;
  /** Workspace shown on the other side — disabled (both panes cannot show
   * the same workspace at once). */
  disabledId?: string;
  /** Accessible label for the caret trigger, e.g. per-side wording. */
  ariaLabel: string;
  onChange: (workspaceId: string) => void;
}

/**
 * Workspace picker integrated into a split-settings tab: a small caret
 * button on the right edge of the tab opens a menu listing every workspace.
 * Choosing one swaps the workspace shown on the tab's side without leaving
 * split mode. The menu lives inside the tab (the tab strip has no overflow
 * clipping) and closes on outside pointer-down or Escape.
 */
export function SplitTabWorkspaceDropdown({
  workspaces,
  selectedId,
  disabledId,
  ariaLabel,
  onChange,
}: SplitTabWorkspaceDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the menu on any pointer-down outside of it, or on Escape.
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className="split-tab-dropdown" ref={rootRef}>
      <button
        type="button"
        className={`split-tab-dropdown-trigger${open ? ' split-tab-dropdown-trigger--open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose the workspace shown on this side"
        // The tab itself activates on click; the dropdown only opens its menu.
        onClick={(e) => {
          e.stopPropagation();
          setOpen(o => !o);
        }}
      >
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="split-tab-dropdown-menu" role="listbox" aria-label="Workspaces">
          {workspaces.map(ws => {
            const isCurrent = ws.id === selectedId;
            const isOtherSide = ws.id === disabledId;
            return (
              <button
                key={ws.id}
                type="button"
                role="option"
                aria-selected={isCurrent}
                disabled={isOtherSide}
                className={`split-tab-dropdown-item${isCurrent ? ' split-tab-dropdown-item--current' : ''}`}
                title={isOtherSide ? 'Already shown on the other side' : `Show ${ws.name} on this side`}
                onClick={(e) => {
                  e.stopPropagation(); // don't activate the tab as a side effect
                  if (!isCurrent && !isOtherSide) onChange(ws.id);
                  setOpen(false);
                }}
              >
                <span className="split-tab-dropdown-item-name">{ws.name}</span>
                {isCurrent && <span className="split-tab-dropdown-item-check"><CheckIcon /></span>}
                {isOtherSide && <span className="split-tab-dropdown-item-note">other side</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
