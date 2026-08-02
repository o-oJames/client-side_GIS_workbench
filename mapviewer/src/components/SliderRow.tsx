/**
 * SliderRow — a reusable labelled range-slider row with a value readout and
 * a reset-to-default button. Used by the raster colour adjustments and the
 * vector style/zoom/clustering controls in SettingsDialog.
 * Extracted per AGENTS.md §3 to deduplicate repeated slider markup.
 */
import React from 'react';

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  value: number;
  defaultValue: number;
  /** Unit suffix shown after the value, e.g. '%' or 'px'. */
  unit?: string;
  onChange: (val: number) => void;
  onReset: () => void;
  resetTitle?: string;
}

export function SliderRow({
  label,
  min,
  max,
  value,
  defaultValue,
  unit = '',
  onChange,
  onReset,
  resetTitle,
}: SliderRowProps) {
  const isDefault = value === defaultValue;
  return (
    <div className="settings-slider-row">
      <label className="settings-slider-label">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        className="settings-slider"
        onChange={(e) => onChange(parseInt(e.target.value))}
      />
      <span className="settings-slider-value">{value}{unit}</span>
      <button
        className={'settings-slider-reset' + (isDefault ? ' settings-slider-reset-hidden' : '')}
        onClick={onReset}
        title={resetTitle || `Reset ${label.toLowerCase()}`}
        disabled={isDefault}
      >↺</button>
    </div>
  );
}
