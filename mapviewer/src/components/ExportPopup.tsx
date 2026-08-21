/**
 * Export popup component for vector layer download.
 * Centered modal dialog with a title showing the layer name.
 * Contains a CRS selector (with sticky filter, 2-column list), a format
 * selector, and two optional expandable sections:
 *   • Geometry — coerce output geometry type, Z-dimension, force multi-type
 *   • Layer Options (GeoJSON only) — coordinate precision, RFC 7946, bbox
 * Rendered as a portal to document.body for proper overlay positioning.
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { VECTOR_EXPORT_FORMATS } from '../utils/vectorExport';
import { CRS_LIST, extractNumericCode } from '../utils/crsList';
import type { VectorExportFormat, ExportOptions } from '../types';

export interface ExportPopupProps {
  /** Name of the layer being exported (shown in title) */
  layerName: string;
  /** Called when the user confirms the export with the selected CRS, format, and options */
  onExport: (format: VectorExportFormat, targetCrs: string, options: ExportOptions) => void;
  /** Called when the popup should close */
  onClose: () => void;
}

/** Geometry type options shown in the Geometry section dropdown. */
const GEOMETRY_TYPE_OPTIONS: Array<{ value: ExportOptions['geometryType']; label: string; icon?: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'Point', label: 'Point', icon: '⠿' },
  { value: 'LineString', label: 'LineString', icon: '' },
  { value: 'Polygon', label: 'Polygon', icon: '⬡' },
  { value: 'GeometryCollection', label: 'GeometryCollection' },
  { value: 'None', label: 'No Geometry', icon: '' },
];

/** Default export options. */
const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  geometryType: 'auto',
  includeZ: false,
  forceMulti: false,
  coordinatePrecision: 15,
  rfc7946: false,
  writeBbox: false,
};

export function ExportPopup({ layerName, onExport, onClose }: ExportPopupProps) {
  const [selectedCrs, setSelectedCrs] = useState<string>('EPSG:4326');
  const [selectedFormat, setSelectedFormat] = useState<VectorExportFormat>('geojson');
  const [filterText, setFilterText] = useState('');
  const popupRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Expandable section state
  const [geometryExpanded, setGeometryExpanded] = useState(false);
  const [layerOptionsExpanded, setLayerOptionsExpanded] = useState(false);

  // Export options state
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);

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
    onExport(selectedFormat, selectedCrs, options);
    onClose();
  }, [selectedFormat, selectedCrs, options, onExport, onClose]);

  const handleCrsSelect = useCallback((code: string) => {
    setSelectedCrs(code);
  }, []);

  const handleFormatSelect = useCallback((format: VectorExportFormat) => {
    setSelectedFormat(format);
  }, []);

  // Layer Options section is only shown for GeoJSON format
  const showLayerOptions = selectedFormat === 'geojson';

  return createPortal(
    <div className="export-popup-overlay" onClick={onClose}>
      <div
        ref={popupRef}
        className="export-popup export-popup-centered"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div className="export-popup-title">
          <span className="export-popup-title-text">Download {layerName}</span>
          <button className="export-popup-close-btn" onClick={onClose} type="button" aria-label="Close">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

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

        {/* Geometry Section (expandable) */}
        <div className="export-popup-section export-popup-geometry-section">
          <button
            className="export-popup-expand-header"
            onClick={() => setGeometryExpanded(!geometryExpanded)}
            type="button"
          >
            <span className={'export-popup-chevron' + (geometryExpanded ? ' expanded' : '')}>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
            <span className="export-popup-expand-title">Geometry</span>
          </button>
          {geometryExpanded && (
            <div className="export-popup-expand-body">
              {/* Geometry type dropdown */}
              <div className="export-popup-option-row">
                <label className="export-popup-option-label">Geometry type</label>
                <div className="export-popup-geom-type-select">
                  <select
                    value={options.geometryType}
                    onChange={(e) => setOptions(prev => ({ ...prev, geometryType: e.target.value as ExportOptions['geometryType'] }))}
                    className="export-popup-select"
                  >
                    {GEOMETRY_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Include z-dimension checkbox */}
              <label className="export-popup-checkbox-row">
                <input
                  type="checkbox"
                  checked={options.includeZ}
                  onChange={(e) => setOptions(prev => ({ ...prev, includeZ: e.target.checked }))}
                />
                <span>Include z-dimension</span>
              </label>
              {/* Force multi-type checkbox */}
              <label className="export-popup-checkbox-row">
                <input
                  type="checkbox"
                  checked={options.forceMulti}
                  onChange={(e) => setOptions(prev => ({ ...prev, forceMulti: e.target.checked }))}
                />
                <span>Force multi-type</span>
              </label>
            </div>
          )}
        </div>

        {/* Layer Options Section (expandable, GeoJSON only) */}
        {showLayerOptions && (
          <div className="export-popup-section export-popup-layer-options-section">
            <button
              className="export-popup-expand-header"
              onClick={() => setLayerOptionsExpanded(!layerOptionsExpanded)}
              type="button"
            >
              <span className={'export-popup-chevron' + (layerOptionsExpanded ? ' expanded' : '')}>
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
              <span className="export-popup-expand-title">Layer Options</span>
            </button>
            {layerOptionsExpanded && (
              <div className="export-popup-expand-body">
                {/* COORDINATE_PRECISION */}
                <div className="export-popup-option-row">
                  <label className="export-popup-option-label">COORDINATE_PRECISION</label>
                  <input
                    type="number"
                    className="export-popup-number-input"
                    min={0}
                    max={20}
                    value={options.coordinatePrecision}
                    onChange={(e) => setOptions(prev => ({ ...prev, coordinatePrecision: Math.max(0, Math.min(20, parseInt(e.target.value) || 0)) }))}
                  />
                </div>
                {/* RFC7946 */}
                <div className="export-popup-option-row">
                  <label className="export-popup-option-label">RFC7946</label>
                  <select
                    value={options.rfc7946 ? 'YES' : 'NO'}
                    onChange={(e) => setOptions(prev => ({ ...prev, rfc7946: e.target.value === 'YES' }))}
                    className="export-popup-select"
                  >
                    <option value="NO">NO</option>
                    <option value="YES">YES</option>
                  </select>
                </div>
                {/* WRITE_BBOX */}
                <div className="export-popup-option-row">
                  <label className="export-popup-option-label">WRITE_BBOX</label>
                  <select
                    value={options.writeBbox ? 'YES' : 'NO'}
                    onChange={(e) => setOptions(prev => ({ ...prev, writeBbox: e.target.value === 'YES' }))}
                    className="export-popup-select"
                  >
                    <option value="NO">NO</option>
                    <option value="YES">YES</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Export Button */}
        <button className="export-popup-export-btn" onClick={handleExport}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export
        </button>
      </div>
    </div>,
    document.body
  );
}
