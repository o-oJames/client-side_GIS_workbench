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
import { ColorAlphaEditor } from './ColorAlphaEditor';
import {
  DEFAULT_COG_RENDER,
  DEFAULT_CONTOUR,
  DEFAULT_HILLSHADE,
  SAMPLE_FORMAT_FLOAT,
  cogRenderSummary,
  computeCogBandRange,
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

/** Commit a numeric field; blank / invalid input falls back to the default. */
function numberOr(text: string, fallback: number, clamp?: (n: number) => number): number {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) return fallback;
  return clamp ? clamp(n) : n;
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
  const [computing, setComputing] = useState(false);

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
    { value: 'hillshade', label: 'Hillshade (terrain relief)', disabled: bandCount === 0 },
    { value: 'contour', label: 'Contours (elevation lines)', disabled: bandCount === 0 },
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
      onChange(withoutStretch({ ...effective }));
      return;
    }
    if (min === undefined || max === undefined || !(min < max)) {
      setStretchHint('Enter a minimum below the maximum, or clear both fields.');
      return;
    }
    setStretchHint('');
    onChange({ ...effective, band: effective.band ?? 1, stretchMin: min, stretchMax: max });
  };

  /** QGIS-style "min/max from the raster": measure the actual pixel values. */
  const computeFromLayerData = () => {
    if (!source || computing) return;
    const band = effective.band ?? 1;
    setComputing(true);
    setStretchHint('');
    // computeCogBandRange never rejects: a failed read reports via the hint.
    computeCogBandRange(source, band).then((range) => {
      setComputing(false);
      if (!range) {
        setStretchHint('Could not read pixel values for this band.');
        return;
      }
      onChange({ ...effective, band, stretchMin: range.min, stretchMax: range.max });
    });
  };

  const switchMode = (mode: CogRenderMode) => {
    if (mode === 'auto') { onChange({ ...DEFAULT_COG_RENDER }); return; }
    if (mode === 'rgb') {
      onChange({ mode: 'rgb', rgb: effective.rgb?.length === 3 ? effective.rgb : [1, 2, 3] });
      return;
    }
    if (mode === 'colormap') { onChange({ mode: 'colormap', band: effective.band ?? 1 }); return; }
    if (mode === 'hillshade') {
      onChange({ mode: 'hillshade', band: effective.band ?? 1, hillshade: effective.hillshade });
      return;
    }
    if (mode === 'contour') {
      onChange({ mode: 'contour', band: effective.band ?? 1, contour: effective.contour });
      return;
    }
    selectSingleBand(effective.band ?? effective.rgb?.[0] ?? 1);
  };

  const ramp = useMemo(
    () => (info?.colorMap ? `linear-gradient(to right, ${paletteGradientStops(info.colorMap).join(', ')})` : null),
    [info],
  );

  // A file with more bands than OpenLayers can show, or with a colour table it
  // ignores, is exactly the case this panel exists for — offer the fix inline.
  const floatBands = (info?.bands ?? []).some((b) => b.sampleFormat === SAMPLE_FORMAT_FLOAT);
  const firstBandStats = (info?.bands ?? []).find((b) => b.band === 1)?.statsMin !== undefined;
  const suggestion = info?.available && isDefaultCogRender(value)
    && (info.colorMap || info.bandCount > 4 || (floatBands && firstBandStats))
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
                      : info.bandCount > 4
                        ? `Only the first bands are shown — this file has ${info.bandCount}.`
                        : 'Floating-point bands render all-black under the default renderer — stretch them to the stored statistics.'}
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

              {(effective.mode === 'single' || effective.mode === 'colormap'
                || effective.mode === 'hillshade' || effective.mode === 'contour') && (
                <div className="cog-render-field">
                  <span className="cog-render-field-label">Band</span>
                  <CustomSelect
                    value={String(effective.band ?? 1)}
                    onChange={(v) => {
                      const band = Number(v);
                      if (effective.mode === 'colormap') onChange({ ...effective, mode: 'colormap', band });
                      else if (effective.mode === 'single') selectSingleBand(band);
                      else onChange({ ...effective, band });
                    }}
                    options={bandOptions}
                    className="settings-select"
                    disabled={bandOptions.length === 0}
                    placeholder="Band"
                  />
                </div>
              )}

              {(effective.mode === 'single' || effective.mode === 'hillshade' || effective.mode === 'contour') && (
                <div className="cog-render-stretch">
                  {computing && <LoadingIndicator message="Reading pixel values…" />}
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
                      onClick={computeFromLayerData}
                      disabled={!selectedBand || computing}
                      title="Measure the actual minimum/maximum from the raster pixels (coarsest overview)"
                    >From layer data</button>
                    <button
                      type="button"
                      className="settings-button-secondary cog-render-action"
                      onClick={() => selectedBand?.statsMin !== undefined && selectedBand?.statsMax !== undefined &&
                        onChange({ ...effective, stretchMin: selectedBand.statsMin, stretchMax: selectedBand.statsMax })}
                      disabled={!hasStats || computing}
                      title={hasStats ? 'Use the minimum/maximum stored in the file' : 'This band has no stored statistics'}
                    >From statistics</button>
                    <button
                      type="button"
                      className="settings-button-secondary cog-render-action"
                      onClick={() => selectedBand &&
                        onChange({ ...effective, stretchMin: selectedBand.dtypeMin, stretchMax: selectedBand.dtypeMax })}
                      disabled={!selectedBand || computing}
                      title="Stretch across everything this data type can hold"
                    >Full range</button>
                    <button
                      type="button"
                      className="settings-button-secondary cog-render-action"
                      onClick={() => { setMinText(''); setMaxText(''); onChange(withoutStretch({ ...effective })); }}
                      disabled={!stretched || computing}
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
                  {effective.mode !== 'single' && selectedBand?.sampleFormat === SAMPLE_FORMAT_FLOAT
                    && !stretched && !hasStats && (
                    <div className="cog-render-warning">
                      This floating-point band has no statistics and no stretch, so elevations fall back
                      to the full float range — read them with From layer data first.
                    </div>
                  )}
                  <p className="cog-render-hint">
                    A stretch is applied when you leave the field or press Apply — the band is then
                    re-loaded at full 8-bit precision across that window.
                    {effective.mode !== 'single'
                      && ' Hillshade and contours also read elevations through this window.'}
                  </p>
                </div>
              )}

              {effective.mode === 'hillshade' && (
                <div className="cog-render-stretch">
                  <div className="cog-render-row">
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-altitude">Altitude°</label>
                      <input
                        id="cog-render-altitude"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={90}
                        step={0.5}
                        value={String(effective.hillshade?.altitude ?? DEFAULT_HILLSHADE.altitude)}
                        onChange={(e) => onChange({ ...effective, mode: 'hillshade', hillshade: {
                          ...effective.hillshade,
                          altitude: numberOr(e.target.value, DEFAULT_HILLSHADE.altitude, (n) => Math.min(90, Math.max(0, n))),
                        } })}
                      />
                    </div>
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-azimuth">Azimuth°</label>
                      <input
                        id="cog-render-azimuth"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={360}
                        step={1}
                        value={String(effective.hillshade?.azimuth ?? DEFAULT_HILLSHADE.azimuth)}
                        onChange={(e) => onChange({ ...effective, mode: 'hillshade', hillshade: {
                          ...effective.hillshade,
                          azimuth: numberOr(e.target.value, DEFAULT_HILLSHADE.azimuth, (n) => ((n % 360) + 360) % 360),
                        } })}
                      />
                    </div>
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-zfactor">Z factor</label>
                      <input
                        id="cog-render-zfactor"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={0.1}
                        value={String(effective.hillshade?.zFactor ?? DEFAULT_HILLSHADE.zFactor)}
                        onChange={(e) => onChange({ ...effective, mode: 'hillshade', hillshade: {
                          ...effective.hillshade,
                          zFactor: numberOr(e.target.value, DEFAULT_HILLSHADE.zFactor, (n) => (n > 0 ? Math.min(1000, n) : DEFAULT_HILLSHADE.zFactor)),
                        } })}
                      />
                    </div>
                  </div>
                  <div className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      id="cog-render-multidirectional"
                      checked={!!effective.hillshade?.multidirectional}
                      onChange={(e) => onChange({ ...effective, mode: 'hillshade', hillshade: {
                        ...effective.hillshade,
                        multidirectional: e.target.checked,
                      } })}
                    />
                    <label htmlFor="cog-render-multidirectional">Multidirectional (blend four light directions)</label>
                  </div>
                  <p className="cog-render-hint">
                    Sun position for the relief shading — 45° altitude / 315° azimuth matches QGIS.
                  </p>
                </div>
              )}

              {effective.mode === 'contour' && (
                <div className="cog-render-stretch">
                  <div className="cog-render-row">
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-interval">Interval</label>
                      <input
                        id="cog-render-interval"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={String(effective.contour?.interval ?? DEFAULT_CONTOUR.interval)}
                        onChange={(e) => onChange({ ...effective, mode: 'contour', contour: {
                          ...effective.contour,
                          interval: numberOr(e.target.value, DEFAULT_CONTOUR.interval, (n) => (n > 0 ? n : DEFAULT_CONTOUR.interval)),
                        } })}
                      />
                    </div>
                    <div className="cog-render-field">
                      <label className="cog-render-field-label" htmlFor="cog-render-index-interval">Index interval</label>
                      <input
                        id="cog-render-index-interval"
                        className="settings-input cog-render-number"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={String(effective.contour?.indexInterval ?? DEFAULT_CONTOUR.indexInterval)}
                        onChange={(e) => onChange({ ...effective, mode: 'contour', contour: {
                          ...effective.contour,
                          indexInterval: numberOr(e.target.value, DEFAULT_CONTOUR.indexInterval, (n) => (n > 0 ? n : DEFAULT_CONTOUR.indexInterval)),
                        } })}
                      />
                    </div>
                  </div>
                  <ColorAlphaEditor
                    label="Contour colour"
                    value={effective.contour?.color ?? DEFAULT_CONTOUR.color}
                    defaultAlpha={1}
                    onChange={(color) => onChange({ ...effective, mode: 'contour', contour: { ...effective.contour, color } })}
                  />
                  <ColorAlphaEditor
                    label="Index contour colour"
                    value={effective.contour?.indexColor ?? DEFAULT_CONTOUR.indexColor}
                    defaultAlpha={1}
                    onChange={(indexColor) => onChange({ ...effective, mode: 'contour', contour: { ...effective.contour, indexColor } })}
                  />
                  <p className="cog-render-hint">
                    A line is drawn where the elevation crosses a multiple of the interval; index
                    contours repeat every index interval in the accent colour.
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
