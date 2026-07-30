import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { CustomSelectOption } from '../types';

export function CustomSelect({ 
  value, 
  onChange, 
  options, 
  className, 
  disabled, 
  placeholder,
  onOpen,
  filterable,
}: { 
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  onOpen?: () => void;
  filterable?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [menuPosition, setMenuPosition] = useState<{ top?: number; bottom?: number; left: number; minWidth: number; maxHeight: number; openUp: boolean } | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalMenuRef = useRef<HTMLDivElement>(null);

  // Close on click outside (checks both wrapper and portal menu)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrapper = wrapperRef.current?.contains(target);
      const inPortalMenu = portalMenuRef.current?.contains(target);
      if (!inWrapper && !inPortalMenu) {
        setIsOpen(false);
        setFilterText('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Calculate menu position when opened, and follow trigger on scroll/resize
  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      // Keep the menu fully inside the viewport: prefer opening downward,
      // flip upward when there is not enough room below, and clamp the
      // height to the available space so long lists scroll instead of
      // overflowing the window.
      const MENU_MAX_HEIGHT = 240;
      const VIEWPORT_MARGIN = 8;
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - VIEWPORT_MARGIN;
      const openUp = spaceBelow < MENU_MAX_HEIGHT && spaceAbove > spaceBelow;
      const available = openUp ? spaceAbove : spaceBelow;
      const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, available));
      setMenuPosition({
        top: openUp ? undefined : rect.bottom + 2,
        bottom: openUp ? window.innerHeight - rect.top + 2 : undefined,
        left: rect.left,
        minWidth: rect.width,
        maxHeight,
        openUp,
      });
    };

    updatePosition();

    // Reposition menu to follow trigger on scroll/resize instead of closing
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen]);

  // Focus the filter input when the menu opens
  useEffect(() => {
    if (isOpen && filterable && filterInputRef.current) {
      filterInputRef.current.focus();
    }
  }, [isOpen, filterable]);

  const selectedOption = options.find(o => o.value === value);
  const displayLabel = selectedOption?.label || placeholder || '';

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && onOpen) {
      onOpen();
    }
    if (isOpen) {
      setFilterText('');
    }
    setIsOpen(!isOpen);
  };

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setFilterText('');
    setIsOpen(false);
  };

  const lowerFilter = filterText.toLowerCase();
  const filteredOptions = filterable && filterText
    ? options.filter(o => o.disabled || o.label.toLowerCase().includes(lowerFilter) || (o.value && o.value.toLowerCase().includes(lowerFilter)))
    : options;

  const menuElement = isOpen && menuPosition ? (
    <div
      ref={portalMenuRef}
      className={`custom-select-menu custom-select-menu-portal${menuPosition.openUp ? ' custom-select-menu-up' : ''} ${className || ''}`}
      style={{
        position: 'fixed',
        top: menuPosition.top !== undefined ? menuPosition.top : 'auto',
        bottom: menuPosition.bottom !== undefined ? menuPosition.bottom : 'auto',
        left: menuPosition.left,
        width: menuPosition.minWidth,
        maxHeight: menuPosition.maxHeight,
      }}
    >
      {filterable && (
        <div className="custom-select-filter" onClick={(e) => e.stopPropagation()}>
          <input
            ref={filterInputRef}
            type="text"
            className="custom-select-filter-input"
            placeholder="Filter layers…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
      )}
      <div className="custom-select-options">
        {filteredOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`custom-select-option${option.value === value ? ' custom-select-option-selected' : ''}${option.disabled ? ' custom-select-option-disabled' : ''}`}
            onClick={() => !option.disabled && handleSelect(option.value)}
            disabled={option.disabled}
          >
            {option.label}
          </button>
        ))}
        {filterable && filteredOptions.length === 0 && (
          <div className="custom-select-no-results">No matching layers</div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={wrapperRef} className={`custom-select-wrapper ${className || ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`custom-select-trigger${disabled ? ' custom-select-disabled' : ''}`}
        onClick={handleToggle}
        disabled={disabled}
      >
        <span className="custom-select-value">{displayLabel}</span>
        <span className={`custom-select-chevron${isOpen ? ' custom-select-chevron-open' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {menuElement && createPortal(menuElement, document.body)}
    </div>
  );
}

export type { CustomSelectOption };
