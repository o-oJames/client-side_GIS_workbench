/**
 * Export popup component for vector layer download.
 * Contains a CRS selector (with sticky filter, 2-column list) and a format selector.
 * Rendered as a portal to document.body for proper overlay positioning.
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { VECTOR_EXPORT_FORMATS } from '../utils/vectorExport';
import { CRS_LIST, CrsEntry, extractNumericCode } from '../utils/crsList';
import type { VectorExportFormat } from '../types';

export interface ExportPopupProps {
  /** Position of the popup (left, bottom/top) */
  left: number;
  bottom?: number;
  top?: number;
  /** Called when the user confirms the export with the selected CRS and format */
  onExport: (format: VectorExportFormat, targetCrs: string) => void;
  /** Called when the popup should close */
  onClose: () => void;
}

export function ExportPopup({ left, bottom, top, onExport, onClose }: ExportPopupProps) {
  const [selectedCrs, setSelectedCrs] = useState<string>('EPSG:4326');
  const [selectedFormat, setSelectedFormat] = useState<VectorExportFormat>('geojson');
  const [filterText, setFilterText] = useState('');
  const popupRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Filter CRS list based on filter text
  const filteredCrsList = useMemo(() => {
    if (!filterText.trim()) return CRS_LIST;
    const lower = filterText.toLowerCase().trim();
    return CRS_LIST.filter((entry) => {
      return entry.name.toLowerCase().includes(lower) ||
             entry.code.toLowerCase().includes(lower) ||
             extractNumericCode(entry.code).includes(lower);
    });
  }, [filterText]);

  // Close on outside click, Escape key, scroll, or resize
  useEffect(() => {
    const close = () => onClose();
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popupRef.current?.contains(t)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onScroll = (e: Event) => {
      if (popupRef.current && popupRef.current.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  // Focus the filter input on mount
  useEffect(() => {
    filterInputRef.current?.focus();
  }, []);

  const handleExport = useCallback(() => {
    onExport(selectedFormat, selectedCrs);
    onClose();
  }, [selectedFormat, selectedCrs, onExport, onClose]);

  const handleCrsSelect = useCallback((code: string) => {
    setSelectedCrs(code);
  }, []);

  const handleFormatSelect = useCallback((format: VectorExportFormat) => {
    setSelectedFormat(format);
  }, []);

  const popupStyle: React.CSSProperties = bottom !== undefined
    ? { left, bottom }
    : { left, top };

  return createPortal(
    <div
      ref={popupRef}
      className={'export-popup' + (top !== undefined ? ' below' : '')}
      style={popupStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* CRS Selector Section */}
      <div className="export-popup-section">
        <div className="export-popup-label">Coordinate System</div>
        <div className="export-popup-crs-filter-wrapper">
          <input
            ref={filterInputRef}
            type="text"
            className="export-popup-crs-filter"
            placeholder="Filter by name or code..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        <div className="export-popup-crs-list">
          <div className="export-popup-crs-header">
            <span className="export-popup-crs-col-name">Name</span>
            <span className="export-popup-crs-col-code">Authority</span>
          </div>
          <div className="export-popup-crs-scroll">
            {filteredCrsList.length === 0 ? (
              <div className="export-popup-crs-empty">No matching CRS found</div>
            ) : (
              filteredCrsList.map((entry) => (
                <div
                  key={entry.code}
                  className={'export-popup-crs-row' + (selectedCrs === entry.code ? ' selected' : '')}
                  onClick={() => handleCrsSelect(entry.code)}
                >
                  <span className="export-popup-crs-col-name" title={entry.name}>{entry.name}</span>
                  <span className="export-popup-crs-col-code">{extractNumericCode(entry.code)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Format Selector Section */}
      <div className="export-popup-section">
        <div className="export-popup-label">Format</div>
        <div className="export-popup-format-list">
          {VECTOR_EXPORT_FORMATS.map((fmt) => (
            <div
              key={fmt.id}
              className={'export-popup-format-row' + (selectedFormat === fmt.id ? ' selected' : '')}
              onClick={() => handleFormatSelect(fmt.id)}
            >
              <span className="export-popup-format-label">{fmt.label}</span>
              <span className="export-popup-format-ext">{fmt.extension}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Export Button */}
      <button className="export-popup-export-btn" onClick={handleExport}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Export
      </button>
    </div>,
    document.body
  );
}
