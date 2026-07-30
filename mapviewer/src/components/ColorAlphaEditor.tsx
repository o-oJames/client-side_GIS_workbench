import React from 'react';
import { parseColor, rgbaToString, rgbaToHex } from '../utils/colorHelpers';
import { CHECKERBOARD } from '../constants';

export function ColorAlphaEditor({
  label,
  value,
  defaultAlpha,
  onChange,
}: {
  label: string;
  value: string;
  defaultAlpha: number;
  onChange: (rgba: string) => void;
}) {
  const { r, g, b, a } = parseColor(value, defaultAlpha);
  const hex = rgbaToHex({ r, g, b });
  const alphaPct = Math.round(a * 100);

  // RGB from the native picker; keep the current alpha.
  const handleColor = (newHex: string) => {
    const c = parseColor(newHex, 1);
    onChange(rgbaToString({ r: c.r, g: c.g, b: c.b, a }));
  };

  // Alpha from the slider; keep the current RGB.
  const handleAlpha = (pct: number) => {
    onChange(rgbaToString({ r, g, b, a: pct / 100 }));
  };

  return (
    <div className="ca-editor">
      <div className="ca-editor-header">
        <span className="ca-editor-label">{label}</span>
        <span className="ca-hex">{hex}</span>
        <span className="ca-alpha-pct">{alphaPct}%</span>
      </div>
      <div className="ca-editor-body">
        <label
          className="ca-swatch"
          title="Click to pick a color"
          style={{
            backgroundColor: '#fff',
            backgroundImage: `linear-gradient(rgba(${r}, ${g}, ${b}, ${a}), rgba(${r}, ${g}, ${b}, ${a})), ${CHECKERBOARD}`,
            backgroundSize: '100% 100%, 8px 8px, 8px 8px',
            backgroundPosition: '0 0, 0 0, 4px 4px',
          }}
        >
          <input type="color" value={hex} onChange={(e) => handleColor(e.target.value)} />
        </label>
        <input
          type="range"
          min="0"
          max="100"
          value={alphaPct}
          className="settings-slider ca-opacity-slider"
          title="Opacity"
          style={{
            backgroundColor: '#fff',
            backgroundImage: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0), rgba(${r}, ${g}, ${b}, 1)), ${CHECKERBOARD}`,
            backgroundSize: '100% 100%, 10px 10px, 10px 10px',
            backgroundPosition: '0 0, 0 0, 5px 5px',
          }}
          onChange={(e) => handleAlpha(parseInt(e.target.value, 10))}
        />
      </div>
    </div>
  );
}
