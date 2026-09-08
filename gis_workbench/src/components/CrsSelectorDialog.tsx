import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { registerProjectionFromEPSGCode } from '../utils/projectionHelper';
import { CRS_LIST, CrsEntry, extractNumericCode } from '../utils/crsList';

/**
 * Popup dialog for selecting a CRS from the curated list.
 * Two-column list (CRS name | Authority ID) with a sticky filter input.
 * On selection, registers the projection via proj4 and returns the EPSG code.
 * Rendered via portal at document body level to appear centered in viewport.
 */
export function CrsSelectorDialog({
  onSelect,
  onClose,
}: {
  onSelect: (epsgCode: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus filter on mount
  useEffect(() => {
    filterInputRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Filter the CRS list based on search query
  const filteredEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return CRS_LIST;
    
    return CRS_LIST.filter(entry => {
      const name = entry.name.toLowerCase();
      const code = entry.code.toLowerCase();
      const numericCode = extractNumericCode(entry.code);
      return name.includes(query) || code.includes(query) || numericCode.includes(query);
    });
  }, [filter]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleSelect = async (entry: CrsEntry) => {
    const numericCode = extractNumericCode(entry.code);
    // Register the projection so it's available for coordinate transforms
    await registerProjectionFromEPSGCode(numericCode);
    onSelect(entry.code);
  };

  // Keyboard navigation in the list
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filteredEntries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredEntries[selectedIndex]) {
        handleSelect(filteredEntries[selectedIndex]);
      }
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.crs-selector-row');
    const item = items[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const dialogContent = (
    <div className="crs-selector-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="crs-selector-dialog" onKeyDown={handleListKeyDown}>
        <div className="crs-selector-header">
          <span className="crs-selector-title">Select Coordinate Reference System</span>
          <button className="crs-selector-close" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="crs-selector-filter-sticky">
          <input
            ref={filterInputRef}
            type="text"
            className="crs-selector-filter-input"
            placeholder="Search by name or EPSG code…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div ref={listRef} className="crs-selector-list">
          {filteredEntries.length === 0 && (
            <div className="crs-selector-empty">No CRS found</div>
          )}
          {filteredEntries.map((entry, idx) => (
            <div
              key={entry.code}
              className={`crs-selector-row${idx === selectedIndex ? ' crs-selector-row-selected' : ''}`}
              onClick={() => handleSelect(entry)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="crs-selector-name" title={entry.name}>{entry.name}</span>
              <span className="crs-selector-code">{entry.code}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // Render via portal at document body level
  return createPortal(dialogContent, document.body);
}
