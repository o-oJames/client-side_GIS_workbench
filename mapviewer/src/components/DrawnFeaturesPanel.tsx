import { useRef, useState } from 'react';
import { DrawStyle, UnitsSystem } from '../types';
import { getFeatureMeasurementText, shouldShowFeatureMeasurements } from '../utils/measurement';
import { shouldShowFeatureNameLabel } from '../utils/drawHelpers';
import { DrawStyleEditor } from './DrawToolbar';
import { PencilIcon } from './Icons';
import { WandCleanupEditor } from './WandCleanupEditor';
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
  onToggleFeatureMeasurements,
  onRenameFeature,
  onToggleFeatureNameLabel,
  units,
  workspaceId,
  onSnapCleanLive,
  onSnapCleanCommit,
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
  /** Toggle a feature's on-map measurement labels. */
  onToggleFeatureMeasurements: (id: string, visible: boolean) => void;
  /** Rename a feature (double-click on its name in the list). */
  onRenameFeature: (id: string, name: string) => void;
  /** Toggle a feature's on-map name label. */
  onToggleFeatureNameLabel: (id: string, visible: boolean) => void;
  units: UnitsSystem;
  // Bumped after vertex edits; a fresh value re-renders the panel so the
  // per-feature length/area readouts reflect the edited geometry.
  measureVersion: number;
  /** Workspace id — keys the IndexedDB stash of as-traced snap outlines. */
  workspaceId: string;
  /** Live clean-up: swap a snap polygon's rings (no history step). */
  onSnapCleanLive: (featureId: string, rings: number[][][]) => void;
  /** Finish a clean-up gesture: one history step + panel refresh. */
  onSnapCleanCommit: (featureId: string) => void;
}) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [layerName, setLayerName] = useState('');
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  const [expandedFeatureId, setExpandedFeatureId] = useState<string | null>(null);
  // Inline rename: clicking a feature's name swaps it for an input.
  const [renamingFeatureId, setRenamingFeatureId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Escape cancels the rename without committing; the flag keeps the
  // follow-up blur (if any) from saving the stale draft.
  const renameCancelledRef = useRef(false);
  // Set to the feature id when a rename commits on blur; the row click that
  // usually follows (user clicked elsewhere on the row) then expands that
  // feature's editor instead of toggling it. The timestamp window keeps a
  // later, unrelated click from acting on a stale commit (e.g. an Enter
  // commit followed by a click seconds afterwards).
  const renameCommittedIdRef = useRef<string | null>(null);
  const renameCommitTimeRef = useRef(0);

  const commitRename = (item: { id: string; name: string }) => {
    setRenamingFeatureId(null);
    const trimmed = renameDraft.trim();
    if (trimmed && trimmed !== item.name) {
      renameCommittedIdRef.current = item.id;
      renameCommitTimeRef.current = Date.now();
      onRenameFeature(item.id, trimmed);
    }
  };

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
                    onClick={() => {
                      const committedId = renameCommittedIdRef.current;
                      renameCommittedIdRef.current = null;
                      if (committedId === item.id && Date.now() - renameCommitTimeRef.current < 500) {
                        // The click that ended the rename opens the editor.
                        setExpandedFeatureId(item.id);
                        return;
                      }
                      setExpandedFeatureId(expandedFeatureId === item.id ? null : item.id);
                    }}
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
                    {renamingFeatureId === item.id ? (
                      <input
                        className="drawn-features-item-name-input"
                        value={renameDraft}
                        autoFocus
                        maxLength={120}
                        aria-label="Feature name"
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            e.stopPropagation();
                            renameCancelledRef.current = true;
                            setRenamingFeatureId(null);
                          }
                        }}
                        onBlur={() => {
                          if (renameCancelledRef.current) {
                            renameCancelledRef.current = false;
                            setRenamingFeatureId(null);
                            return;
                          }
                          commitRename(item);
                        }}
                      />
                    ) : (
                      <span
                        className="drawn-features-item-name drawn-features-item-name--editable"
                        title="Click to rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          renameCancelledRef.current = false;
                          renameCommittedIdRef.current = null;
                          setRenameDraft(item.name);
                          setRenamingFeatureId(item.id);
                        }}
                      >
                        {item.name}
                      </span>
                    )}
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
                      {item.type === 'Polygon' && item.feature && item.feature._snapClass && (
                        <WandCleanupEditor
                          featureId={item.id}
                          workspaceId={workspaceId}
                          onLiveUpdate={onSnapCleanLive}
                          onCommit={onSnapCleanCommit}
                        />
                      )}
                      <DrawStyleEditor
                        style={item.style}
                        onChange={(s) => onFeatureStyleChange(item.id, s)}
                        showOpacity={false}
                        measurements={item.type !== 'Point' ? {
                          visible: shouldShowFeatureMeasurements(item.feature),
                          onToggle: (v) => onToggleFeatureMeasurements(item.id, v),
                        } : undefined}
                        nameLabel={item.type !== 'Point' ? {
                          visible: shouldShowFeatureNameLabel(item.feature),
                          onToggle: (v) => onToggleFeatureNameLabel(item.id, v),
                        } : undefined}
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
