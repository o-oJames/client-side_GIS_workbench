/**
 * CogRenderControl — the band/renderer section of the raster layer edit form
 * for COG (GeoTIFF) layers.
 *
 * OpenLayers renders a GeoTIFF's first bands as RGB/RGBA and offers no way to
 * choose, which leaves multispectral files showing the wrong bands and paletted
 * files showing raw class indices as grayscale. This panel reads the band
 * layout out of the loaded source and lets the user pick:
 *
 *   Default      OpenLayers' own mapping (no style override at all)
 *   RGB          any three bands as red / green / blue
 *   Single band  one band as grayscale, with an optional min/max stretch
 *   Colour map   a paletted band through the file's embedded colour table
 *
 * Band *mapping* is applied live by the parent (`onChange` → a pure
 * `layer.setStyle()`), so switching bands is instant and costs no requests.
 * A *stretch* changes how the source normalises pixel values and is baked in
 * when the layer is rebuilt, so the min/max fields commit on Enter/blur rather
 * than on every keystroke.
 *
 * Extracted per AGENTS.md §3: RasterLayerEditForm stays a thin orchestrator,
 * and the markup mirrors the existing collapsible zoom-range / colors panels.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CogRenderConfig, CogRenderMode, CustomSelectOption, RasterLayer } from '../types';
import { CustomSelect } from './CustomSelect';
import { LoadingIndicator } from './LoadingIndicator';
import {
  DEFAULT_COG_RENDER,
  cogRenderSummary,
  describeCogBands,
  describeCogFile,
  formatRangeValue,
  isDefaultCogRender,
  normalizeCogRender,
  paletteGradientStops,
  suggestedCogRender,
  type CogBandInfo,
} from '../utils/cogBands';

interface CogRenderControlProps {
  /** The COG layer being edited; its live OL source supplies the band layout. */
  layer: RasterLayer;
  /** Current (possibly edited, not yet applied) renderer configuration. */
  value: CogRenderConfig;
  /** Stage a change and apply it live to the map. */
  onChange: (next: CogRenderConfig) => void;
}

/** Parse a stretch field; undefined for blank input. */
function parseStretch(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** A renderer config with no stretch at all. */
function withoutStretch(render: CogRenderConfig): CogRenderConfig {
  const next: CogRenderConfig = { ...render };
  delete next.stretchMin;
  delete next.stretchMax;
  return next;
}

export function CogRenderControl({ layer, value, onChange }: CogRenderControlProps) {
  const [expanded, setExpanded] = useState(!isDefaultCogRender(value));
  const [info, setInfo] = useState<CogBandInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [minText, setMinText] = useState(value.stretchMin !== undefined ? String(value.stretchMin) : '');
  const [maxText, setMaxText] = useState(value.stretchMax !== undefined ? String(value.stretchMax) : '');
  const [stretchHint, setStretchHint] = useState('');

  const source = layer.olLayer?.getSource?.() ?? null;
  const bandCount = info?.bandCount ?? 0;
  const summary = cogRenderSummary(value, info);
  const effective = useMemo(() => normalizeCogRender(value, info), [value, info]);

  // Band details come from the already-loaded source: no extra request in the
  // common case, and reads are memoised per source in utils/cogBands.ts.
  useEffect(() => {
    if (!expanded || info || !source) return;
    let cancelled = false;
    setLoading(true);
    describeCogBands(source).then((result) => {
      if (cancelled) return;
      setInfo(result);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [expanded, info, source]);

  // Keep the stretch fields in sync with externally-set values (e.g. Cancel
  // reverting the whole edit form, or a committed rebuild).
  useEffect(() => {
    setMinText(value.stretchMin !== undefined ? String(value.stretchMin) : '');
    setMaxText(value.stretchMax !== undefined ? String(value.stretchMax) : '');
    setStretchHint('');
  }, [value.stretchMin, value.stretchMax]);

  const bandOptions: CustomSelectOption[] = useMemo(
    () => (info?.bands ?? []).map((b) => ({ value: String(b.band), label: b.label })),
    [info],
  );
  const modeOptions: CustomSelectOption[] = useMemo(() => [
    { value: 'auto', label: 'Default (first bands as RGB)' },
    { value: 'rgb', label: 'RGB — choose 3 bands', disabled: bandCount > 0 && bandCount < 3 },
    { value: 'single', label: 'Single band (grayscale)', disabled: bandCount === 0 },
    { value: 'colormap', label: 'Colour map (paletted)', disabled: !info?.colorMap },
  ], [bandCount, info]);

  const selectedBand = (info?.bands ?? []).find((b) => b.band === (effective.band ?? 1));
  const hasStats = selectedBand?.statsMin !== undefined && selectedBand?.statsMax !== undefined;
  const stretched = effective.stretchMin !== undefined && effective.stretchMax !== undefined;

  /** Switch the displayed band, re-seeding the stretch from that band's own range. */
  const selectSingleBand = (band: number) => {
    const descriptor = (info?.bands ?? []).find((b) => b.band === band);
    const next: CogRenderConfig = { mode: 'single', band };
    if (descriptor?.statsMin !== undefined && descriptor?.statsMax !== undefined) {
      next.stretchMin = descriptor.statsMin;
      next.stretchMax = descriptor.statsMax;
    }
    onChange(next);
  };

  const commitStretch = () => {
    const min = parseStretch(minText);
    const max = parseStretch(maxText);
    if (min === undefined && max === undefined) {
      onChange(withoutStretch({ ...effective, mode: 'single' }));
      return;
    }
    if (min === undefined || max === undefined || !(min < max)) {
      setStretchHint('Enter a minimum below the maximum, or clear both fields.');
      return;
    }
    setStretchHint('');
    onChange({ ...effective, mode: 'single', band: effective.band ?? 1, stretchMin: min, stretchMax: max });
  };

  const switchMode = (mode: CogRenderMode) => {
    if (mode === 'auto') { onChange({ ...DEFAULT_COG_RENDER }); return; }
    if (mode === 'rgb') {
      onChange({ mode: 'rgb', rgb: effective.rgb?.length === 3 ? effective.rgb : [1, 2, 3] });
      return;
    }
    if (mode === 'colormap') { onChange({ mode: 'colormap', band: effective.band ?? 1 }); return; }
    selectSingleBand(effective.band ?? effective.rgb?.[0] ?? 1);
  };

  const ramp = useMemo(
    () => (info?.colorMap ? `linear-gradient(to right, ${paletteGradientStops(info.colorMap).join(', ')})` : null),
    [info],
  );

  // A file with more bands than OpenLayers can show, or with a colour table it
  // ignores, is exactly the case this panel exists for — offer the fix inline.
  const suggestion = info?.available && isDefaultCogRender(value) && (info.colorMap || info.bandCount > 4)
    ? suggestedCogRender(info)
    : null;

  return (
    <div className="settings-color-adjustments color-adjust-collapsible cog-render" data-testid="cog-render-control">
      <button
        type="button"
        className="color-adjust-toggle"
        onClick={() => setExpanded((c) => !c)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse' : 'Expand'}
      >
        <span className="color-adjust-toggle-left">
          <span className={'color-adjust-chevron' + (expanded ? ' expanded' : '')}>{'\u25b8'}</span>
          <span className="color-adjust-title">Bands</span>
        </span>
        <span className={'color-adjust-badge' + (isDefaultCogRender(value) ? '' : ' custom')}>{summary}</span>
      </button>

      {expanded && (
        <div className="color-adjust-body">
          {loading && <LoadingIndicator message="Reading band details…" />}

          {!loading && !source && (
            <div className="settings-wmts-info">
              Band details are read from the loaded GeoTIFF, so they appear once the layer is on the map.
            </div>
          )}

          {!loading && source && info && (
            <>
              <div className="settings-wmts-info cog-render-file" data-testid="cog-render-file">
                {describeCogFile(info)}
              </div>

              {info.warning && <div className="cog-render-warning">{info.warning}</div>}

              <div className="cog-render-field">
                <span className="cog-render-field-label">Renderer</span>
                <CustomSelect
                  value={effective.mode}
                  onChange={(v) => switchMode(v as CogRenderMode)}
                  options={modeOptions}
                  className="settings-select"
                />
              </div>

              {suggestion && (
                <div className="cog-render-suggest">
                  <span>
                    {info.colorMap
                      ? 'This file has a colour table that the default renderer ignores.'
                      : `Only the first bands are shown — this file has ${info.bandCount}.`}
                  </span>
                  <button
                    type="button"
                    className="settings-button-secondary cog-render-suggest-btn"
                    onClick={() => onChange(suggestion)}
                  >
                    Use suggested
                  </button>
                </div>
              )}

              {effective.mode === 'rgb' && (
                <div className="cog-render-row">
                  {(['Red', 'Green', 'Blue'] as const).map((channel, i) => (
                    <div className="cog-render-field" key={channel}>
                      <span className="cog-render-field-label">{channel}</span>
                      <CustomSelect
                        value={String(effective.rgb?.[i] ?? i + 1)}
                        onChange={(v) => {
                          const rgb = [...(effective.rgb ?? [1, 2, 3])];
                          rgb[i] = Number(v);
                          onChange({ ...effective, mode: 'rgb', rgb });
                        }}
                        options={bandOptions}
                        className="settings-select"
                        disabled={bandOptions.length === 0}
                        placeholder="Band"
                      />
                    </div>
                  ))}
                </div>
              )}

              {(effective.mode === 'single' || effective.mode === 'colormap') && (
                <div className="cog-render-field">
                  <span className="cog-render-field-label">Band</span>
                  <CustomSelect
                    value={String(effective.band ?? 1)}
                    onChange={(v) => (effective.mode === 'colormap'
                      ? onChange({ ...effective, mode: 'colormap', band: Number(v) })
                      : selectSingleBand(Number(v)))}
                    options={bandOptions}
                    className="settings-select"
                    disabled={bandOptions.length === 0}
                    placeholder="Band"
                  />
                </div>
              )}

              {effective.mode === 'single' && (
                <div className="cog-render-stretch">
                  <div className="cog-render-row">
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-min">Min</label>
                      <input
                        id="cog-render-min"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        placeholder={selectedBand ? formatRangeValue(selectedBand.dtypeMin) : 'min'}
                        value={minText}
                        onChange={(e) => { setMinText(e.target.value); setStretchHint(''); }}
                        onBlur={commitStretch}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitStretch(); } }}
                      />
                    </div>
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-max">Max</label>
                      <input
                        id="cog-render-max"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        placeholder={selectedBand ? formatRangeValue(selectedBand.dtypeMax) : 'max'}
                        value={maxText}
                        onChange={(e) => { setMaxText(e.target.value); setStretchHint(''); }}
                        onBlur={commitStretch}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitStretch(); } }}
                      />
                    </div>
                  </div>

                  <div className="cog-render-actions">
                    <button
                      type="button"
                      className="settings-button-secondary cog-render-action"
                      onClick={() => selectedBand?.statsMin !== undefined && selectedBand?.statsMax !== undefined &&
                        onChange({ ...effective, mode: 'single', stretchMin: selectedBand.statsMin, stretchMax: selectedBand.statsMax })}
                      disabled={!hasStats}
                      title={hasStats ? 'Use the minimum/maximum stored in the file' : 'This band has no stored statistics'}
                    >From statistics</button>
                    <button
                      type="button"
                      className="settings-button-secondary cog-render-action"
                      onClick={() => selectedBand &&
                        onChange({ ...effective, mode: 'single', stretchMin: selectedBand.dtypeMin, stretchMax: selectedBand.dtypeMax })}
                      disabled={!selectedBand}
                      title="Stretch across everything this data type can hold"
                    >Full range</button>
                    <button
                      type="button"
                      className="settings-button-secondary cog-render-action"
                      onClick={() => { setMinText(''); setMaxText(''); onChange(withoutStretch({ ...effective, mode: 'single' })); }}
                      disabled={!stretched}
                      title="Let the file's own range decide"
                    >Auto</button>
                  </div>

                  {hasStats && (
                    <div className="settings-wmts-info">
                      Stored statistics: {formatRangeValue(selectedBand!.statsMin!)} to {formatRangeValue(selectedBand!.statsMax!)}
                      {selectedBand?.statsMean !== undefined ? ` · mean ${formatRangeValue(selectedBand.statsMean)}` : ''}
                    </div>
                  )}
                  {stretchHint && <div className="cog-render-warning">{stretchHint}</div>}
                  <p className="cog-render-hint">
                    A stretch is applied when you leave the field or press Apply — the band is then
                    re-loaded at full 8-bit precision across that window.
                  </p>
                </div>
              )}

              {effective.mode === 'colormap' && info?.colorMap && (
                <div className="cog-render-colormap">
                  <div
                    className="cog-render-ramp"
                    style={{ background: ramp || undefined }}
                    data-testid="cog-render-ramp"
                  />
                  <div className="settings-wmts-info">
                    {info.colorMap.length} classes · index 0–{info.colorMap.length - 1}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
