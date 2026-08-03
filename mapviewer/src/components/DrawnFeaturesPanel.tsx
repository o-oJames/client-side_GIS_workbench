import { useState } from 'react';
import { DrawStyle, UnitsSystem } from '../types';
import { getFeatureMeasurementText } from '../utils/measurement';
import { DrawStyleEditor } from './DrawToolbar';
import { PencilIcon } from './Icons';
import { VectorExportFormat } from '../utils/vectorExport';

export function DrawnFeaturesPanel({
  drawnFeatures,
  expanded,
  onToggle,
  onRemove,
  onSaveToLayers,
  onExport,
  drawStyle,
  onDrawStyleChange,
  onFeatureStyleChange,
  onEditLabelText,
  units,
}: {
  drawnFeatures: Array<{ id: string; type: string; name: string; feature: any; style: DrawStyle; customized: boolean }>;
  expanded: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  onSaveToLayers: (layerName: string) => void;
  onExport: (format: VectorExportFormat) => void;
  drawStyle: DrawStyle;
  onDrawStyleChange: (style: DrawStyle) => void;
  onFeatureStyleChange: (id: string, style: DrawStyle) => void;
  onEditLabelText: (feature: any) => void;
  units: UnitsSystem;
  // Bumped after vertex edits; a fresh value re-renders the panel so the
  // per-feature length/area readouts reflect the edited geometry.
  measureVersion: number;
}) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [layerName, setLayerName] = useState('');
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  const [expandedFeatureId, setExpandedFeatureId] = useState<string | null>(null);

  return (
    <div className={`drawn-features-panel ${expanded ? 'expanded' : ''}`}>
      <div className="drawn-features-header" onClick={onToggle}>
        <span className="drawn-features-title">
          Drawn Features
          {drawnFeatures.length > 0 && (
            <span className="drawn-features-count">{drawnFeatures.length}</span>
          )}
        </span>
        <span className={`drawn-features-chevron ${expanded ? 'expanded' : ''}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </div>
      {expanded && (
        <div className="drawn-features-body">
          {drawnFeatures.length === 0 ? (
            <div className="drawn-features-empty">No features drawn yet</div>
          ) : (
            <div className="drawn-features-list">
              {drawnFeatures.map((item) => (
                <div key={item.id} className="drawn-features-item-block">
                  <div
                    className={`drawn-features-item ${expandedFeatureId === item.id ? 'active' : ''}`}
                    onClick={() => setExpandedFeatureId(expandedFeatureId === item.id ? null : item.id)}
                  >
                    <span className={`drawn-features-item-chevron ${expandedFeatureId === item.id ? 'expanded' : ''}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                    </span>
                    <span
                      className="drawn-features-item-swatch"
                      style={{ background: item.style.fillColor, borderColor: item.style.lineColor }}
                    />
                    <span className="drawn-features-item-name">{item.name}</span>
                    {(() => {
                      const measure = getFeatureMeasurementText(item.feature, units);
                      return measure ? (
                        <span className="drawn-features-item-measure" title={item.type === 'LineString' ? 'Total length' : 'Area'}>
                          {measure}
                        </span>
                      ) : null;
                    })()}
                    {item.customized && (
                      <span className="drawn-features-customized-dot" title="Custom style" />
                    )}
                    {item.type === 'Point' && (
                      <button
                        className="drawn-features-item-edit-text"
                        onClick={(e) => { e.stopPropagation(); onEditLabelText(item.feature); }}
                        title="Edit label text"
                      >
                        <PencilIcon />
                      </button>
                    )}
                    <button
                      className="drawn-features-item-remove"
                      onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                      title="Remove feature"
                    >
                      &times;
                    </button>
                  </div>
                  {expandedFeatureId === item.id && (
                    <div className="drawn-features-feature-editor">
                      <DrawStyleEditor
                        style={item.style}
                        onChange={(s) => onFeatureStyleChange(item.id, s)}
                        showOpacity={false}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="drawn-features-style">
            <div className="drawn-features-style-header" onClick={() => setShowStyleEditor(!showStyleEditor)}>
              <span className="drawn-features-style-title">New feature style</span>
              <span className="drawn-features-style-swatches">
                <span className="drawn-features-style-swatch" style={{ background: drawStyle.lineColor }} title="Line color" />
                <span className="drawn-features-style-swatch" style={{ background: drawStyle.fillColor }} title="Fill color" />
              </span>
              <span className={`drawn-features-chevron ${showStyleEditor ? 'expanded' : ''}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </div>
            {showStyleEditor && (
              <div className="drawn-features-style-body">
                <DrawStyleEditor style={drawStyle} onChange={onDrawStyleChange} showOpacity={true} />
              </div>
            )}
          </div>

          {drawnFeatures.length > 0 && (
            <>
              <div className="drawn-features-layer-name">
                <input
                  type="text"
                  className="drawn-features-name-input"
                  placeholder="Layer name (optional)"
                  value={layerName}
                  onChange={(e) => setLayerName(e.target.value)}
                />
              </div>
              <div className="drawn-features-actions">
                <button
                  className="drawn-features-btn drawn-features-btn-save"
                  onClick={() => onSaveToLayers(layerName.trim())}
                  disabled={drawnFeatures.length === 0}
                  title="Add to vector layers"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                  Save to Layers
                </button>
                <div className="drawn-features-export-wrapper">
                  <button
                    className="drawn-features-btn drawn-features-btn-export"
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    disabled={drawnFeatures.length === 0}
                    title="Export features"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Export
                  </button>
                  {showExportMenu && (
                    <div className="drawn-features-export-menu">
                      <button onClick={() => { onExport('geojson'); setShowExportMenu(false); }}>
                        Export as GeoJSON
                      </button>
                      <button onClick={() => { onExport('kml'); setShowExportMenu(false); }}>
                        Export as KML
                      </button>
                      <button onClick={() => { onExport('shapefile'); setShowExportMenu(false); }}>
                        Export as Shapefile (.zip)
                      </button>
                      <button onClick={() => { onExport('kmz'); setShowExportMenu(false); }}>
                        Export as KMZ
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
