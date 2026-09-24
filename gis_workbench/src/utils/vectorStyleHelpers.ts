/**
 * Vector layer styling utilities.
 *
 * Pure OpenLayers style construction and layer-level style application.
 * No React imports — framework-agnostic per AGENTS.md §3.
 */
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from 'ol/style.js';
import Cluster from 'ol/source/Cluster.js';
import { parseColor, rgbaToString } from './colorHelpers';
import { DRAW_STYLE_KEYS, DrawStyle, UnitsSystem, AttributeRenderConfig, VectorLayerConfig } from '../types';
import { applyDrawFeatureStyle } from './drawHelpers';
import { buildAttributeStyle } from './attributeStyle';

// --- Style source ---------------------------------------------------------

/**
 * Whether a vector layer currently renders with the styles that came from
 * inside its own file (a KML/KMZ `<Style>`, or per-feature styles a parser
 * attached) rather than with the uniform style built from its config.
 *
 * `useCustomStyle` is only ever written for file layers that have in-file
 * styles, so an absent flag means "the file's styles are still in charge" -
 * exactly how the editor's "Use in-file style" switch reads it. One predicate
 * shared by the switch, the live previews and persistence keeps all of them
 * agreeing about which style source is on the map.
 */
export function usesInFileStyle(layer: Pick<VectorLayerConfig, 'hasInFileStyle' | 'useCustomStyle'> | null | undefined): boolean {
  return !!layer?.hasInFileStyle && layer?.useCustomStyle !== true;
}

// --- Style construction ---------------------------------------------------

export interface VectorStyleConfig {
  pointColor?: string;
  pointSize?: number;
  showPoints?: boolean;
  lineColor?: string;
  lineWidth?: number;
  fillColor?: string;
  fontColor?: string;
  fontSize?: number;
  clusterPoints?: boolean;
  /** Attribute-driven rendering ("smart mapping"); overrides the fixed
   * colours/sizes for features that carry the configured attribute. */
  attrRender?: AttributeRenderConfig | null;
}

/**
 * Build an OL per-feature style function from a vector layer's colour/size
 * config. Handles cluster bubbles (when `clusterPoints` is true and the
 * feature carries a `features` array from an ol/source/Cluster) and optional
 * label text stored on the feature as `labelText`.
 */
export function buildVectorStyle(styleConfig: VectorStyleConfig) {
  const lineWidth = styleConfig.lineWidth ?? 2;
  // Colors are stored as rgba strings; parseColor also accepts legacy hex.
  const line = rgbaToString(parseColor(styleConfig.lineColor, 1));
  const fill = rgbaToString(parseColor(styleConfig.fillColor, 0.3));
  const fontColor = rgbaToString(parseColor(styleConfig.fontColor, 1));
  const fontSize = styleConfig.fontSize ?? 14;
  // Point marker: separate colour (defaults to line colour) and radius
  // (defaults to 6px). Only affects point features — lines/polygons ignore
  // the image symbol.
  const pointRadius = styleConfig.pointSize ?? 6;
  const pointColor = styleConfig.pointColor
    ? rgbaToString(parseColor(styleConfig.pointColor, 1))
    : line;
  const clustered = styleConfig.clusterPoints === true;
  // Attribute-driven rendering: when configured, feature colour/size is
  // derived from the chosen attribute instead of the fixed layer colours.
  // Returns null while the config is incomplete (no field yet), in which
  // case the plain layer style below applies.
  const attrStyleFn = styleConfig.attrRender
    ? buildAttributeStyle(styleConfig, styleConfig.attrRender)
    : null;

  // Return a per-feature style function so features carrying a label
  // (e.g. drawn features saved to a layer) render their text too.
  return (feature: any) => {
    // Clustered layers render aggregate bubbles for groups of points. The
    // Cluster source tags each generated feature with a `features` array of
    // the original points it swallowed.
    if (clustered && feature && feature.get) {
      const members = feature.get('features');
      if (Array.isArray(members) && members.length > 1) {
        const count = members.length;
        // Bubble grows with the cluster size, capped so huge clusters stay readable.
        const radius = 9 + Math.min(14, Math.round(Math.sqrt(count) * 1.6));
        return new Style({
          image: new CircleStyle({
            radius,
            fill: new Fill({ color: line }),
            stroke: new Stroke({ color: '#fff', width: 2.5 }),
          }),
          text: new Text({
            text: count > 999 ? (count / 1000).toFixed(1) + 'k' : String(count),
            font: 'bold ' + Math.max(11, Math.min(14, radius - 2)) + 'px Arial',
            fill: new Fill({ color: '#fff' }),
          }),
        });
      }
    }
    const labelText = feature && feature.get ? feature.get('labelText') : undefined;
    if (!labelText && attrStyleFn) {
      return attrStyleFn(feature);
    }
    const base = {
      fill: new Fill({ color: fill }),
      stroke: new Stroke({ color: line, width: lineWidth }),
      image: styleConfig.showPoints === false ? undefined : new CircleStyle({
        radius: pointRadius,
        fill: new Fill({ color: pointColor }),
        stroke: new Stroke({ color: '#fff', width: 2 }),
      }),
    };
    if (labelText) {
      return new Style({
        ...base,
        text: new Text({
          text: labelText,
          font: fontSize + 'px Arial',
          fill: new Fill({ color: fontColor }),
          stroke: new Stroke({ color: '#fff', width: 3 }),
          offsetY: -15,
        }),
      });
    }
    return new Style(base);
  };
}

// --- Layer-level style application ------------------------------------------

/** The layer-level properties every vector style payload may carry. */
export interface VectorStylePayload {
  opacity?: number;
  lineColor?: string;
  lineWidth?: number;
  fillColor?: string;
  fontColor?: string;
  fontSize?: number;
  pointColor?: string;
  pointSize?: number;
  showPoints?: boolean;
  attrRender?: AttributeRenderConfig | null;
}

/**
 * Set a vector layer's opacity on its own.
 *
 * Opacity is a layer property in OpenLayers, not part of the style: it applies
 * on top of whatever draws the features, including the styles that came from
 * inside a KML/KMZ file. Keeping it separate means an opacity edit never
 * restyles a layer (and never flips it out of "use in-file style" mode).
 */
export function applyVectorLayerOpacity(olLayer: any, opacity: number) {
  if (!olLayer || typeof olLayer.setOpacity !== 'function') return;
  olLayer.setOpacity(Math.min(100, Math.max(0, opacity)) / 100);
}

/**
 * Apply a style to a vector layer. KML/KMZ features carry their own styles
 * which take precedence over the layer style in OpenLayers, so we clear those
 * per-feature styles (once) to let the chosen layer style take effect. Each
 * one is stashed on the feature first, so {@link restoreInFileFeatureStyles}
 * can hand it back without re-reading the file.
 *
 * @param getUnits - callback returning the current units system (avoids
 *   closing over React state so this module stays framework-agnostic).
 */
export function applyVectorStyleToLayer(
  olLayer: any,
  styleConfig: VectorStylePayload,
  getUnits: () => UnitsSystem,
) {
  if (styleConfig.opacity !== undefined) {
    olLayer.setOpacity(styleConfig.opacity / 100);
  }
  // If the layer is currently clustered, the style must render cluster
  // bubbles - detect it from the live source so the style always matches.
  const currentSource = olLayer.getSource && olLayer.getSource();
  const isClustered = currentSource instanceof Cluster;
  olLayer.setStyle(buildVectorStyle({ ...styleConfig, clusterPoints: isClustered }));

  // Per-feature style overrides live on the *raw* source, not the cluster
  // wrapper, so look through the Cluster source when present.
  const source = isClustered && currentSource.getSource ? currentSource.getSource() : currentSource;
  if (source && typeof source.getFeatures === 'function') {
    // Only defined DrawStyle fields override the stored per-feature style.
    const defined: Partial<DrawStyle> = {};
    DRAW_STYLE_KEYS.forEach(k => {
      if (styleConfig[k] !== undefined) defined[k] = styleConfig[k] as any;
    });
    for (const f of source.getFeatures()) {
      if (f._drawStyle) {
        // Drawn-in-app feature: keep its own style function — it renders
        // the measurement chips — and fold the new values into it.
        f._drawStyle = { ...f._drawStyle, ...defined };
        applyDrawFeatureStyle(f, f._drawStyle, getUnits);
      } else {
        const fs = f.getStyle && f.getStyle();
        if (fs !== undefined && fs !== null) {
          // Remember the style that came from inside the file, so switching
          // back to "use in-file style" can hand it back without re-reading
          // the file (GeoJSON persistence strips OL style objects).
          if (f._inFileStyle === undefined) f._inFileStyle = fs;
          f.setStyle(undefined); // fall back to the layer style
        }
      }
    }
  }
}

/**
 * Hand every feature of a layer the style that came from inside its file back.
 *
 * `applyVectorStyleToLayer` stashes a feature's own style before clearing it,
 * so switching a layer back to "use in-file style" needs no re-read of the
 * file. Drawn-in-app features are left alone: their style function renders
 * their measurement labels and is folded into, never replaced.
 *
 * @returns how many features now render with a style of their own. Zero means
 *   the file's styles are not on the features any more and were not stashed
 *   either (the layer was restored from persistence in custom-style mode,
 *   where GeoJSON carries no OL style objects), so the caller has to recover
 *   them from the file's own text instead.
 */
export function restoreInFileFeatureStyles(olLayer: any): number {
  const source = vectorFeatureSourceOf(olLayer);
  if (!source) return 0;
  let styled = 0;
  for (const f of source.getFeatures()) {
    // A feature drawn into the layer in-app has its own style function (it
    // renders the measurement labels); it never came from a file.
    if (f._drawStyle) continue;
    const current = f.getStyle && f.getStyle();
    if ((current === undefined || current === null) && f._inFileStyle !== undefined) {
      f.setStyle(f._inFileStyle);
    }
    const st = f.getStyle && f.getStyle();
    if (st !== undefined && st !== null) styled++;
  }
  return styled;
}

/**
 * The layer style a layer rendering with its file's own styles needs: none -
 * OpenLayers then draws each feature with the style the file gave it - unless
 * clustering is on, where the bubbles its Cluster source generates are
 * features of their own with no style to fall back on.
 */
export function applyInFileLayerStyle(olLayer: any, bubbleStyle?: VectorStyleConfig): void {
  if (!olLayer) return;
  const currentSource = olLayer.getSource && olLayer.getSource();
  olLayer.setStyle(currentSource instanceof Cluster
    ? buildVectorStyle({ ...(bubbleStyle ?? {}), clusterPoints: true })
    : undefined);
  if (olLayer.changed) olLayer.changed();
}

/** The feature-bearing source of a layer, looking through a Cluster wrapper. */
function vectorFeatureSourceOf(olLayer: any): any {
  if (!olLayer) return null;
  const currentSource = olLayer._rawSource || (olLayer.getSource && olLayer.getSource());
  const source = currentSource instanceof Cluster && currentSource.getSource
    ? currentSource.getSource()
    : currentSource;
  return source && typeof source.getFeatures === 'function' ? source : null;
}

// --- Clustering -------------------------------------------------------------

/**
 * Turn point clustering on or off for a vector layer.
 *
 * Enabling wraps the layer's real (raw) source in an ol/source/Cluster so
 * nearby points collapse into count bubbles; disabling swaps the raw source
 * back in. The raw source is stashed on the layer the first time clustering
 * is enabled so it can always be recovered - this also keeps feature
 * serialisation, extent calculation and vertex editing pointed at the real
 * features rather than the generated clusters.
 */
export function applyVectorClusteringToLayer(
  olLayer: any,
  clusterPoints: boolean,
  clusterDistance: number | undefined,
  // null = swap the source only and leave the layer's style alone (a layer
  // rendering with its file's own styles has no uniform style to re-apply).
  styleConfig: VectorStylePayload | null,
  getUnits: () => UnitsSystem,
) {
  if (!olLayer) return;
  const currentSource = olLayer.getSource && olLayer.getSource();

  if (clusterPoints) {
    // Stash the underlying source once; if we're already clustered keep the
    // existing raw source rather than wrapping the cluster wrapper.
    const rawSource = olLayer._rawSource || currentSource;
    olLayer._rawSource = rawSource;
    const clusterSource = new Cluster({
      source: rawSource,
      distance: clusterDistance ?? 40,
      // Only Point geometries take part in clustering. Returning null for
      // anything else (instead of the default's hard assertion) keeps mixed
      // datasets from throwing - non-point features simply sit out clustering.
      geometryFunction: (feature: any) => {
        const geometry = feature.getGeometry && feature.getGeometry();
        return geometry && geometry.getType() === 'Point' ? geometry : null;
      },
    });
    olLayer.setSource(clusterSource);
  } else if (olLayer._rawSource) {
    olLayer.setSource(olLayer._rawSource);
    olLayer._rawSource = undefined;
  }

  // Re-apply the style - it reads the live source to decide whether to draw
  // cluster bubbles, so it always matches the new (un)clustered state.
  if (styleConfig) applyVectorStyleToLayer(olLayer, styleConfig, getUnits);
  if (olLayer.changed) olLayer.changed();
}

// --- Raw source accessor ----------------------------------------------------

/**
 * The editable/serialisable source of a vector layer: the raw feature source
 * when clustering is active (the Cluster wrapper only holds generated
 * bubbles), otherwise the layer's own source.
 */
export function getLayerRawSource(layersMap: Map<string, any>, layerId: string) {
  const l = layersMap.get(layerId);
  if (!l) return null;
  return l._rawSource || (l.getSource && l.getSource());
}
