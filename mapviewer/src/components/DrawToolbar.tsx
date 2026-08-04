import React, { useState, useRef, useEffect } from 'react';
import { DrawToolId, DrawStyle, UnitsSystem, DEFAULT_DRAW_STYLE } from '../types';
import { getFeatureMeasurementText } from '../utils/measurement';
import { ColorAlphaEditor } from './ColorAlphaEditor';

// DrawToolbar component
export function DrawToolbar({ 
  activeTool, 
  onToolSelect,
  boxSelectActive,
  onBoxSelectToggle,
  undoDepth,
  redoDepth,
  onUndo,
  onRedo,
  showHistory,
  magneticArmed,
  onMagneticToggle,
  samBusy,
}: { 
  activeTool: DrawToolId;
  onToolSelect: (tool: DrawToolId) => void;
  boxSelectActive: boolean;
  onBoxSelectToggle: () => void;
  undoDepth: number;
  redoDepth: number;
  onUndo: () => void;
  onRedo: () => void;
  showHistory: boolean;
  /** Magnetic edge snapping (livewire) armed per line/polygon tool. */
  magneticArmed?: { line: boolean; polygon: boolean };
  /** Right-click on the line/polygon tool toggles magnetic edges for it. */
  onMagneticToggle?: (tool: 'line' | 'polygon') => void;
  /** SAM 2.1 model is downloading/compiling — spinner on the wand button. */
  samBusy?: boolean;
}) {
  const tools = [
    {
      id: 'line' as const,
      title: 'Draw Line',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="19" x2="19" y2="5" />
        </svg>
      ),
    },
    {
      id: 'polygon' as const,
      title: 'Draw Polygon',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8.5 18 21 6 21 2 8.5" />
        </svg>
      ),
    },
    {
      id: 'rectangle' as const,
      title: 'Draw Rectangle',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="1" />
        </svg>
      ),
    },
    {
      id: 'wand' as const,
      title: 'Snap to object (AI) \u2014 click a building/road and SAM 2.1 traces its polygon; click again to refine, Shift+click to exclude, Enter/double-click to keep',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z" />
          <path d="m14 7 3 3" />
          <path d="M5 6v4" />
          <path d="M19 14v4" />
          <path d="M10 2v2" />
          <path d="M7 8H3" />
          <path d="M21 16h-4" />
          <path d="M11 3H9" />
        </svg>
      ),
    },
    {
      id: 'label' as const,
      title: 'Add Label',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </svg>
      ),
    },
  ];

  return (
    <div className="draw-toolbar" onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <button
        className={`draw-toolbar-button ${boxSelectActive ? 'active' : ''}`}
        onClick={onBoxSelectToggle}
        title="Box selection \u2014 click two corners to select an area, right-click the box for actions"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="15" rx="1.5" strokeDasharray="3 2.6" />
          <path d="M10.5 8.5l7 2.6-3 1.2 1.8 3.2-1.9 1.1-1.8-3.2-2.1 2.2z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <div className="draw-toolbar-divider" aria-hidden="true" />
      {tools.map((tool) => {
        const isMagneticTool = tool.id === 'line' || tool.id === 'polygon';
        const magneticOn = isMagneticTool && Boolean(magneticArmed && magneticArmed[tool.id as 'line' | 'polygon']);
        const busy = tool.id === 'wand' && Boolean(samBusy);
        return (
          <button
            key={tool.id}
            className={`draw-toolbar-button ${activeTool === tool.id ? 'active' : ''} ${busy ? 'busy' : ''}`}
            onClick={() => onToolSelect(activeTool === tool.id ? null : tool.id)}
            onContextMenu={isMagneticTool ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onMagneticToggle) onMagneticToggle(tool.id as 'line' | 'polygon');
            } : undefined}
            title={tool.title + (isMagneticTool ? ' \u2014 right-click to toggle magnetic edges (hold Shift while drawing to snap vertices to the map image)' : '')}
          >
            {tool.icon}
            {magneticOn && <span className="draw-toolbar-snap-badge" aria-hidden="true" />}
            {busy && <span className="draw-toolbar-busy-ring" aria-hidden="true" />}
          </button>
        );
      })}
      <div className="draw-toolbar-divider" aria-hidden="true" />
      <button
        className={`draw-toolbar-button ${activeTool === 'modify' ? 'active' : ''}`}
        onClick={() => onToolSelect(activeTool === 'modify' ? null : 'modify')}
        title="Edit vertices — drag to reshape drawn features"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19l5-11 5 5 6-8" />
          <rect x="6.9" y="5.9" width="4.2" height="4.2" fill="#fff" />
        </svg>
      </button>
      {showHistory && (
        <div className="draw-toolbar-history">
          <div className="draw-toolbar-divider" aria-hidden="true" />
          <button
            className="draw-toolbar-button"
            onClick={onUndo}
            disabled={undoDepth === 0}
            title="Undo (Ctrl+Z)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v1" />
            </svg>
          </button>
          <button
            className="draw-toolbar-button"
            onClick={onRedo}
            disabled={redoDepth === 0}
            title="Redo (Ctrl+Shift+Z)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v1" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// Label Input Dialog component - appears at map position for label text entry
export function LabelInputDialog({
  pixel,
  initialText,
  onApply,
  onCancel,
}: {
  pixel: [number, number];
  initialText?: string;
  onApply: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const initialTextRef = useRef(initialText);

  useEffect(() => {
    // Auto-focus the input when the dialog appears; pre-existing text is
    // selected so typing immediately replaces it.
    if (inputRef.current) {
      inputRef.current.focus();
      if (initialTextRef.current) {
        inputRef.current.select();
      }
    }
  }, []);

  const handleApply = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onApply(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  // Calculate position, keeping dialog within viewport bounds
  const dialogWidth = 260;
  const dialogHeight = 90;
  const mapEl = document.getElementById('map');
  const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;

  let left = pixel[0] + 12;
  let top = pixel[1] - 20;

  if (mapRect) {
    // Ensure dialog stays within map bounds
    if (left + dialogWidth > mapRect.width) {
      left = pixel[0] - dialogWidth - 12;
    }
    if (top + dialogHeight > mapRect.height) {
      top = mapRect.height - dialogHeight - 10;
    }
    if (top < 10) {
      top = 10;
    }
    if (left < 10) {
      left = 10;
    }
  }

  return (
    <div
      className="label-input-dialog"
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        zIndex: 10,
      }}
    >
      <div className="label-input-dialog-title">{initialText !== undefined ? 'Edit Label' : 'Enter Label'}</div>
      <input
        ref={inputRef}
        type="text"
        className="label-input-dialog-input"
        placeholder="Label text..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={100}
      />
      <div className="label-input-dialog-buttons">
        <button className="label-input-dialog-btn label-input-dialog-btn-apply" onClick={handleApply} disabled={!text.trim()}>
          Apply
        </button>
        <button className="label-input-dialog-btn label-input-dialog-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Reusable style controls for drawn features (opacity is layer-level, so it is
// only shown for the global style, not per-feature overrides).
export function DrawStyleEditor({
  style,
  onChange,
  showOpacity,
}: {
  style: DrawStyle;
  onChange: (style: DrawStyle) => void;
  showOpacity: boolean;
}) {
  return (
    <>
      {showOpacity && (
        <div className="settings-slider-row">
          <label className="settings-slider-label">Opacity</label>
          <input
            type="range"
            min="0"
            max="100"
            value={style.opacity}
            className="settings-slider"
            onChange={(e) => onChange({ ...style, opacity: parseInt(e.target.value, 10) })}
          />
          <span className="settings-slider-value">{style.opacity}%</span>
        </div>
      )}
      <div className="settings-slider-row">
        <label className="settings-slider-label">Line width</label>
        <input
          type="range"
          min="1"
          max="10"
          value={style.lineWidth}
          className="settings-slider"
          onChange={(e) => onChange({ ...style, lineWidth: parseInt(e.target.value, 10) })}
        />
        <span className="settings-slider-value">{style.lineWidth}px</span>
      </div>
      <ColorAlphaEditor
        label="Line color"
        value={style.lineColor}
        defaultAlpha={1}
        onChange={(val) => onChange({ ...style, lineColor: val })}
      />
      <ColorAlphaEditor
        label="Fill color"
        value={style.fillColor}
        defaultAlpha={0.2}
        onChange={(val) => onChange({ ...style, fillColor: val })}
      />
      <div className="settings-slider-row">
        <label className="settings-slider-label">Font size</label>
        <input
          type="range"
          min="8"
          max="32"
          value={style.fontSize}
          className="settings-slider"
          onChange={(e) => onChange({ ...style, fontSize: parseInt(e.target.value, 10) })}
        />
        <span className="settings-slider-value">{style.fontSize}px</span>
      </div>
      <ColorAlphaEditor
        label="Font color"
        value={style.fontColor}
        defaultAlpha={1}
        onChange={(val) => onChange({ ...style, fontColor: val })}
      />
    </>
  );
}

// Expandable per-feature style row used for drawn-in-app vector layers.
export function VectorFeatureStyleItem({
  feature,
  index,
  onApply,
  units,
}: {
  feature: any;
  index: number;
  onApply: (feature: any, style: DrawStyle) => void;
  units: UnitsSystem;
}) {
  const [expanded, setExpanded] = useState(false);
  const [style, setStyle] = useState<DrawStyle>(() =>
    feature._drawStyle ? { ...feature._drawStyle } : { ...DEFAULT_DRAW_STYLE }
  );

  const labelText = feature.get ? feature.get('labelText') : undefined;
  const geom = feature.getGeometry ? feature.getGeometry() : null;
  const geomType = geom ? geom.getType() : 'Feature';
  const featName = feature._drawName || (labelText ? 'Label: ' + labelText : geomType + ' ' + (index + 1));

  return (
    <div className="drawn-features-item-block">
      <div
        className={`drawn-features-item ${expanded ? 'active' : ''}`}
        onClick={() => {
          if (!expanded) {
            setStyle(feature._drawStyle ? { ...feature._drawStyle } : { ...DEFAULT_DRAW_STYLE });
          }
          setExpanded(!expanded);
        }}
      >
        <span className={`drawn-features-item-chevron ${expanded ? 'expanded' : ''}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </span>
        <span className="drawn-features-item-swatch" style={{ background: style.fillColor, borderColor: style.lineColor }} />
        <span className="drawn-features-item-name">{featName}</span>
        {(() => {
          const measure = getFeatureMeasurementText(feature, units);
          return measure ? (
            <span className="drawn-features-item-measure" title={geomType === 'LineString' ? 'Total length' : 'Area'}>
              {measure}
            </span>
          ) : null;
        })()}
      </div>
      {expanded && (
        <div className="drawn-features-feature-editor">
          <DrawStyleEditor
            style={style}
            onChange={(s) => { setStyle(s); onApply(feature, s); }}
            showOpacity={false}
          />
        </div>
      )}
    </div>
  );
}
