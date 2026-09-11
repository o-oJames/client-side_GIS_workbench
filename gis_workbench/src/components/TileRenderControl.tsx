/**
 * TileRenderControl — the renderer section of the raster layer edit form
 * for XYZ/WMTS/WMS tile layers that encode terrain in their RGB channels.
 *
 * Offers two renderer modes on top of the default tile display:
 *   - Hillshade: terrain relief shading (Horn's gradient, QGIS-style sun)
 *   - Contours: elevation isolines traced from the decoded terrain
 *
 * The user picks the tile encoding (terrarium, mapbox, or grayscale) which
 * determines how RGB pixels map to elevation values.
 */
import { useMemo, useState } from 'react';
import type {
  CogContourConfig,
  CogHillshadeConfig,
  CogLineStyle,
  CustomSelectOption,
  TileElevationEncoding,
  TileRenderConfig,
} from '../types';
import { CustomSelect } from './CustomSelect';
import { ColorAlphaEditor } from './ColorAlphaEditor';
import {
  COG_LINE_STYLES,
  DEFAULT_CONTOUR,
  DEFAULT_HILLSHADE,
  MAX_CONTOUR_DOWNSCALE,
  MAX_CONTOUR_LINE_WIDTH,
  MAX_CONTOUR_OVERSAMPLING,
  MIN_CONTOUR_LINE_WIDTH,
} from '../utils/cogBands';

interface TileRenderControlProps {
  value: TileRenderConfig;
  onChange: (next: TileRenderConfig) => void;
}

/** Commit a numeric field; blank / invalid input falls back to the default. */
function numberOr(text: string, fallback: number, clamp?: (n: number) => number): number {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) return fallback;
  return clamp ? clamp(n) : n;
}

const LINE_STYLE_LABELS: Record<CogLineStyle, string> = {
  solid: 'Solid line',
  dash: 'Dash line',
  dot: 'Dot line',
  'dash-dot': 'Dash dot line',
  'dash-dot-dot': 'Dash dot dot line',
};

const ENCODING_LABELS: Record<TileElevationEncoding, string> = {
  terrarium: 'Terrarium (AWS terrain)',
  mapbox: 'Mapbox Terrain-RGB',
  grayscale: 'Grayscale (single band)',
};

/** Default tile render config. */
export const DEFAULT_TILE_RENDER: TileRenderConfig = {
  mode: 'default',
  encoding: 'terrarium',
};

/** Short badge text for the collapsed header. */
export function tileRenderSummary(render: TileRenderConfig): string {
  switch (render.mode) {
    case 'hillshade': return 'Hillshade';
    case 'contour': return `Contours ${render.contour?.interval ?? DEFAULT_CONTOUR.interval}`;
    default: return 'default';
  }
}

/** True when the render config is at its defaults. */
export function isDefaultTileRender(render: TileRenderConfig): boolean {
  return render.mode === 'default';
}

export function TileRenderControl({ value, onChange }: TileRenderControlProps) {
  const [expanded, setExpanded] = useState(!isDefaultTileRender(value));

  const modeOptions: CustomSelectOption[] = useMemo(() => [
    { value: 'default', label: 'Default (tile colours)' },
    { value: 'hillshade', label: 'Hillshade (terrain relief)' },
    { value: 'contour', label: 'Contours (elevation lines)' },
  ], []);

  const encodingOptions: CustomSelectOption[] = useMemo(() => [
    { value: 'terrarium', label: ENCODING_LABELS.terrarium },
    { value: 'mapbox', label: ENCODING_LABELS.mapbox },
    { value: 'grayscale', label: ENCODING_LABELS.grayscale },
  ], []);

  const lineStyleOptions: CustomSelectOption[] = useMemo(
    () => COG_LINE_STYLES.map((style) => ({ value: style, label: LINE_STYLE_LABELS[style] })),
    [],
  );

  const patchContour = (patch: Partial<CogContourConfig>) =>
    onChange({ ...value, mode: 'contour', contour: { ...value.contour, ...patch } });

  const patchHillshade = (patch: Partial<CogHillshadeConfig>) =>
    onChange({ ...value, mode: 'hillshade', hillshade: { ...value.hillshade, ...patch } });

  const switchMode = (mode: TileRenderConfig['mode']) => {
    if (mode === 'default') {
      onChange({ ...DEFAULT_TILE_RENDER, encoding: value.encoding });
      return;
    }
    if (mode === 'hillshade') {
      onChange({ ...value, mode: 'hillshade', hillshade: value.hillshade });
      return;
    }
    if (mode === 'contour') {
      onChange({ ...value, mode: 'contour', contour: value.contour });
      return;
    }
  };

  return (
    <div className="settings-color-adjustments color-adjust-collapsible cog-render" data-testid="tile-render-control">
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
        <span className={'color-adjust-badge' + (isDefaultTileRender(value) ? '' : ' custom')}>
          {tileRenderSummary(value)}
        </span>
      </button>

      {expanded && (
        <div className="color-adjust-body">
          <div className="cog-render-field">
            <span className="cog-render-field-label">Renderer</span>
            <CustomSelect
              value={value.mode}
              onChange={(v) => switchMode(v as TileRenderConfig['mode'])}
              options={modeOptions}
              className="settings-select"
            />
          </div>

          {(value.mode === 'contour' || value.mode === 'hillshade') && (
            <div className="cog-render-field">
              <span className="cog-render-field-label">Tile encoding</span>
              <CustomSelect
                value={value.encoding}
                onChange={(v) => onChange({ ...value, encoding: v as TileElevationEncoding })}
                options={encodingOptions}
                className="settings-select"
              />
            </div>
          )}

          {value.encoding === 'grayscale' && (
            <div className="cog-render-stretch">
              <div className="cog-render-row">
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-gmin">Min elevation</label>
                  <input
                    id="tile-render-gmin"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    value={String(value.grayscaleRange?.min ?? 0)}
                    onChange={(e) => onChange({
                      ...value,
                      grayscaleRange: { min: Number(e.target.value) || 0, max: value.grayscaleRange?.max ?? 255 },
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-gmax">Max elevation</label>
                  <input
                    id="tile-render-gmax"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    value={String(value.grayscaleRange?.max ?? 255)}
                    onChange={(e) => onChange({
                      ...value,
                      grayscaleRange: { min: value.grayscaleRange?.min ?? 0, max: Number(e.target.value) || 255 },
                    })}
                  />
                </div>
              </div>
              <p className="cog-render-hint">
                Grayscale encoding maps pixel brightness (0–255) to this elevation range.
              </p>
            </div>
          )}

          {value.mode === 'hillshade' && (
            <div className="cog-render-stretch">
              <div className="cog-render-row">
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-altitude">Altitude°</label>
                  <input
                    id="tile-render-altitude"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={90}
                    step={0.5}
                    value={String(value.hillshade?.altitude ?? DEFAULT_HILLSHADE.altitude)}
                    onChange={(e) => patchHillshade({
                      altitude: numberOr(e.target.value, DEFAULT_HILLSHADE.altitude, (n) => Math.min(90, Math.max(0, n))),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-azimuth">Azimuth°</label>
                  <input
                    id="tile-render-azimuth"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={360}
                    step={1}
                    value={String(value.hillshade?.azimuth ?? DEFAULT_HILLSHADE.azimuth)}
                    onChange={(e) => patchHillshade({
                      azimuth: numberOr(e.target.value, DEFAULT_HILLSHADE.azimuth, (n) => ((n % 360) + 360) % 360),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-zfactor">Z factor</label>
                  <input
                    id="tile-render-zfactor"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.1}
                    value={String(value.hillshade?.zFactor ?? DEFAULT_HILLSHADE.zFactor)}
                    onChange={(e) => patchHillshade({
                      zFactor: numberOr(e.target.value, DEFAULT_HILLSHADE.zFactor, (n) => (n > 0 ? Math.min(1000, n) : DEFAULT_HILLSHADE.zFactor)),
                    })}
                  />
                </div>
              </div>
              <div className="settings-checkbox-row">
                <input
                  type="checkbox"
                  id="tile-render-multidirectional"
                  checked={!!value.hillshade?.multidirectional}
                  onChange={(e) => patchHillshade({ multidirectional: e.target.checked })}
                />
                <label htmlFor="tile-render-multidirectional">Multidirectional (blend four light directions)</label>
              </div>
              <p className="cog-render-hint">
                Sun position for the relief shading — 45° altitude / 315° azimuth matches QGIS.
              </p>
            </div>
          )}

          {value.mode === 'contour' && (
            <div className="cog-render-stretch">
              <div className="cog-render-row">
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-interval">Interval</label>
                  <input
                    id="tile-render-interval"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={String(value.contour?.interval ?? DEFAULT_CONTOUR.interval)}
                    onChange={(e) => patchContour({
                      interval: numberOr(e.target.value, DEFAULT_CONTOUR.interval, (n) => (n > 0 ? n : DEFAULT_CONTOUR.interval)),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-index-interval">Index interval</label>
                  <input
                    id="tile-render-index-interval"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={String(value.contour?.indexInterval ?? DEFAULT_CONTOUR.indexInterval)}
                    onChange={(e) => patchContour({
                      indexInterval: numberOr(e.target.value, DEFAULT_CONTOUR.indexInterval, (n) => (n > 0 ? n : DEFAULT_CONTOUR.indexInterval)),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <label
                    className="cog-render-field-label"
                    htmlFor="tile-render-downscale"
                    title="How many times coarser than the screen the terrain is sampled before the lines are traced"
                  >Downscaling</label>
                  <input
                    id="tile-render-downscale"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={1}
                    max={MAX_CONTOUR_DOWNSCALE}
                    step={1}
                    value={String(value.contour?.inputDownscale ?? DEFAULT_CONTOUR.inputDownscale)}
                    onChange={(e) => patchContour({
                      inputDownscale: numberOr(e.target.value, DEFAULT_CONTOUR.inputDownscale,
                        (n) => (n >= 1 ? Math.min(MAX_CONTOUR_DOWNSCALE, n) : DEFAULT_CONTOUR.inputDownscale)),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <label
                    className="cog-render-field-label"
                    htmlFor="tile-render-oversampling"
                    title="How many times finer than the screen the terrain is sampled before downscaling is applied"
                  >Oversampling</label>
                  <input
                    id="tile-render-oversampling"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={1}
                    max={MAX_CONTOUR_OVERSAMPLING}
                    step={1}
                    value={String(value.contour?.inputOversampling ?? DEFAULT_CONTOUR.inputOversampling)}
                    onChange={(e) => patchContour({
                      inputOversampling: numberOr(e.target.value, DEFAULT_CONTOUR.inputOversampling,
                        (n) => (n >= 1 ? Math.min(MAX_CONTOUR_OVERSAMPLING, n) : DEFAULT_CONTOUR.inputOversampling)),
                    })}
                  />
                </div>
              </div>

              <div className="cog-render-row">
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-line-width">Line width</label>
                  <input
                    id="tile-render-line-width"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={MIN_CONTOUR_LINE_WIDTH}
                    max={MAX_CONTOUR_LINE_WIDTH}
                    step={0.5}
                    value={String(value.contour?.lineWidth ?? DEFAULT_CONTOUR.lineWidth)}
                    onChange={(e) => patchContour({
                      lineWidth: numberOr(e.target.value, DEFAULT_CONTOUR.lineWidth,
                        (n) => (n > 0 ? Math.min(MAX_CONTOUR_LINE_WIDTH, Math.max(MIN_CONTOUR_LINE_WIDTH, n)) : DEFAULT_CONTOUR.lineWidth)),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <span className="cog-render-field-label">Line style</span>
                  <CustomSelect
                    value={value.contour?.lineStyle ?? DEFAULT_CONTOUR.lineStyle}
                    onChange={(v) => patchContour({ lineStyle: v as CogLineStyle })}
                    options={lineStyleOptions}
                    className="settings-select"
                  />
                </div>
              </div>

              <div className="cog-render-row">
                <div className="cog-render-field">
                  <label className="cog-render-field-label" htmlFor="tile-render-index-line-width">Index width</label>
                  <input
                    id="tile-render-index-line-width"
                    className="settings-input cog-render-number"
                    type="number"
                    inputMode="decimal"
                    min={MIN_CONTOUR_LINE_WIDTH}
                    max={MAX_CONTOUR_LINE_WIDTH}
                    step={0.5}
                    value={String(value.contour?.indexLineWidth ?? DEFAULT_CONTOUR.indexLineWidth)}
                    onChange={(e) => patchContour({
                      indexLineWidth: numberOr(e.target.value, DEFAULT_CONTOUR.indexLineWidth,
                        (n) => (n > 0 ? Math.min(MAX_CONTOUR_LINE_WIDTH, Math.max(MIN_CONTOUR_LINE_WIDTH, n)) : DEFAULT_CONTOUR.indexLineWidth)),
                    })}
                  />
                </div>
                <div className="cog-render-field">
                  <span className="cog-render-field-label">Index style</span>
                  <CustomSelect
                    value={value.contour?.indexLineStyle ?? DEFAULT_CONTOUR.indexLineStyle}
                    onChange={(v) => patchContour({ indexLineStyle: v as CogLineStyle })}
                    options={lineStyleOptions}
                    className="settings-select"
                  />
                </div>
              </div>

              <ColorAlphaEditor
                label="Contour colour"
                value={value.contour?.color ?? DEFAULT_CONTOUR.color}
                defaultAlpha={1}
                onChange={(color) => patchContour({ color })}
              />
              <ColorAlphaEditor
                label="Index contour colour"
                value={value.contour?.indexColor ?? DEFAULT_CONTOUR.indexColor}
                defaultAlpha={1}
                onChange={(indexColor) => patchContour({ indexColor })}
              />

              <div
                className="settings-checkbox-row"
                title="Print each line's elevation along it; colliding labels are dropped"
              >
                <input
                  type="checkbox"
                  id="tile-render-show-label"
                  checked={(value.contour?.showLabel ?? DEFAULT_CONTOUR.showLabel) !== false}
                  onChange={(e) => patchContour({ showLabel: e.target.checked })}
                />
                <label htmlFor="tile-render-show-label">Show labels (elevation along each line)</label>
              </div>

              <div
                className="settings-checkbox-row"
                title="At zoom < 14, use coarser intervals (100m/500m) for better performance. At zoom >= 14, use the configured intervals."
              >
                <input
                  type="checkbox"
                  id="tile-render-dynamic-intervals"
                  checked={(value.contour?.dynamicIntervals ?? DEFAULT_CONTOUR.dynamicIntervals) !== false}
                  onChange={(e) => patchContour({ dynamicIntervals: e.target.checked })}
                />
                <label htmlFor="tile-render-dynamic-intervals">Dynamic intervals (coarser at low zoom)</label>
              </div>

              <p className="cog-render-hint">
                Intervals are in metres. Lines are traced from the terrain decoded out of the
                tile RGB and drawn as vectors, so widths, dash patterns and labels survive
                every zoom. The tile layer is hidden underneath while contours are on screen.
              </p>
            </div>
          )}

          {(value.mode === 'hillshade' || value.mode === 'contour') && (
            <p className="cog-render-hint" style={{ marginTop: '0.5em' }}>
              <strong>Note:</strong> The tile server must allow cross-origin requests (CORS)
              for the elevation data to be readable. If contours or hillshade show no data,
              check that the tile server sends appropriate CORS headers.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
