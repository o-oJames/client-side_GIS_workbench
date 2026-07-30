import React, { useState } from 'react';
import { TILE_ZOOM_MIN, TILE_ZOOM_MAX } from '../constants';

/** Parse a zoom input string into a clamped integer, or undefined when empty (= unlimited). */
export function parseZoomInput(value: string, lo: number = TILE_ZOOM_MIN, hi: number = TILE_ZOOM_MAX): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const n = parseInt(trimmed, 10);
  if (isNaN(n)) return undefined;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compact min/max tile-zoom editor with stepper buttons. Values are kept as
 * strings by the parent so a field can be emptied to mean "unlimited".
 */
export function TileZoomRangeControl({
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  collapsible = false,
  defaultOpen = true,
  nativeMin,
  nativeMax,
  title = 'Tile zoom range',
  hint,
}: {
  minValue: string;
  maxValue: string;
  onMinChange: (value: string) => void;
  onMaxChange: (value: string) => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  nativeMin?: number;
  nativeMax?: number;
  title?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Services with a fixed matrix set (WMTS) constrain the usable range
  const lo = nativeMin ?? TILE_ZOOM_MIN;
  const hi = nativeMax ?? TILE_ZOOM_MAX;
  const min = parseZoomInput(minValue, lo, hi);
  const max = parseZoomInput(maxValue, lo, hi);
  const invalid = min !== undefined && max !== undefined && min > max;
  const hasCustomRange = min !== undefined || max !== undefined;

  const step = (current: string, delta: number, fallback: number, onChange: (v: string) => void) => {
    const parsed = parseZoomInput(current, lo, hi) ?? fallback;
    onChange(String(Math.max(lo, Math.min(hi, parsed + delta))));
  };

  const renderField = (
    label: string,
    value: string,
    parsed: number | undefined,
    fallback: number,
    onChange: (v: string) => void,
  ) => {
    const effective = parsed ?? fallback;
    return (
      <div className="zoom-range-field">
        <span className="zoom-range-field-label">{label}</span>
        <div className="zoom-range-stepper">
          <button
            type="button"
            className="zoom-range-step-btn"
            onClick={() => step(value, -1, fallback, onChange)}
            disabled={effective <= lo}
            title="Decrease"
          >−</button>
          <input
            type="number"
            min={lo}
            max={hi}
            value={value}
            placeholder="auto"
            onChange={(e) => onChange(e.target.value)}
            className="zoom-range-input"
          />
          <button
            type="button"
            className="zoom-range-step-btn"
            onClick={() => step(value, 1, fallback, onChange)}
            disabled={effective >= hi}
            title="Increase"
          >+</button>
        </div>
      </div>
    );
  };

  const nativeNote = (nativeMin !== undefined && nativeMax !== undefined) ? (
    <span className="zoom-range-native" title="Zoom range advertised by the tile service">
      service z{nativeMin}{'\u2013'}z{nativeMax}
    </span>
  ) : null;

  const badge = (
    <span className={'zoom-range-badge' + (invalid ? ' error' : hasCustomRange ? ' custom' : '')}>
      {invalid
        ? 'min \u003e max'
        : `z${min ?? lo}\u2013z${max ?? hi}`}
    </span>
  );

  return (
    <div className={'zoom-range' + (invalid ? ' invalid' : '') + (collapsible ? ' collapsible' : '')}>
      {collapsible ? (
        <button
          type="button"
          className="zoom-range-header zoom-range-toggle"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          <span className="zoom-range-header-left">
            <span className={'zoom-range-chevron' + (open ? ' expanded' : '')}>{'\u25b8'}</span>
            <span className="zoom-range-title">{title}</span>
          </span>
          {nativeNote}
          {badge}
        </button>
      ) : (
        <div className="zoom-range-header">
          <span className="zoom-range-title">{title}</span>
          {nativeNote}
          {badge}
        </div>
      )}
      {(!collapsible || open) && (
        <div className="zoom-range-body">
          <div className="zoom-range-row">
            {renderField('Min', minValue, min, TILE_ZOOM_MIN, onMinChange)}
            <span className="zoom-range-dash">{'\u2013'}</span>
            {renderField('Max', maxValue, max, TILE_ZOOM_MAX, onMaxChange)}
          </div>
          <p className="zoom-range-hint">
            {invalid
              ? 'Min zoom must be less than or equal to max zoom.'
              : (hint ?? 'Outside this range the nearest allowed tiles are magnified instead of requesting new ones.')}
          </p>
        </div>
      )}
    </div>
  );
}
