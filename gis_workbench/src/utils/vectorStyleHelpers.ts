/**
 * Vector layer styling utilities.
 *
 * Pure OpenLayers style construction and layer-level style application.
 * No React imports — framework-agnostic per AGENTS.md §3.
 */
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from 'ol/style.js';
import Cluster from 'ol/source/Cluster.js';
import { parseColor, rgbaToString } from './colorHelpers';
import { DRAW_STYLE_KEYS, DrawStyle, UnitsSystem, AttributeRenderConfig } from '../types';
import { applyDrawFeatureStyle } from './drawHelpers';
import { buildAttributeStyle } from './attributeStyle';

// --- Style construction ---------------------------------------------------

export interface VectorStyleConfig {
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
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({ color: line }),
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

/**
 * Apply a style to a vector layer. KML/KMZ features carry their own styles
 * which take precedence over the layer style in OpenLayers, so we clear those
 * per-feature styles (once) to let the chosen layer style take effect.
 *
 * @param getUnits - callback returning the current units system (avoids
 *   closing over React state so this module stays framework-agnostic).
 */
export function applyVectorStyleToLayer(
  olLayer: any,
  styleConfig: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number; attrRender?: AttributeRenderConfig | null },
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
          f.setStyle(undefined); // fall back to the layer style
        }
      }
    }
  }
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
  styleConfig: { opacity?: number; lineColor?: string; lineWidth?: number; fillColor?: string; fontColor?: string; fontSize?: number; attrRender?: AttributeRenderConfig | null },
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
  applyVectorStyleToLayer(olLayer, styleConfig, getUnits);
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
