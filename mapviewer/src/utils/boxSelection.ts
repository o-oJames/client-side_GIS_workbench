/**
 * Box-selection helpers — pure geometry/DOM logic for the selection box
 * drawn by the box-selection tool (see hooks/useBoxSelection.ts).
 *
 * Extents are axis-aligned [minX, minY, maxX, maxY] in map coordinates
 * (EPSG:3857). Pixel rects are {left, top, width, height} in viewport
 * CSS pixels.
 */

/** Axis-aligned box in map coordinates: [minX, minY, maxX, maxY]. */
export type BoxExtent = [number, number, number, number];

/** The eight resize handles around the selection box. */
export type BoxHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const BOX_HANDLES: BoxHandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Normalize two arbitrary corner coordinates into [minX, minY, maxX, maxY]. */
export function normalizeExtent(
  a: [number, number],
  b: [number, number],
): BoxExtent {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
}

/** Translate an extent by a map-unit delta. */
export function moveExtent(extent: BoxExtent, dx: number, dy: number): BoxExtent {
  return [extent[0] + dx, extent[1] + dy, extent[2] + dx, extent[3] + dy];
}

/**
 * Resize an extent by dragging one of its eight handles by a map-unit delta.
 * Opposite edges act as limits: an edge can approach its opposite until the
 * box reaches `minSize` but never crosses it.
 */
export function resizeExtent(
  extent: BoxExtent,
  handle: BoxHandleId,
  dx: number,
  dy: number,
  minSize = 0,
): BoxExtent {
  let [minX, minY, maxX, maxY] = extent;
  if (handle.includes('w')) minX = Math.min(minX + dx, maxX - minSize);
  if (handle.includes('e')) maxX = Math.max(maxX + dx, minX + minSize);
  if (handle.includes('s')) minY = Math.min(minY + dy, maxY - minSize);
  if (handle.includes('n')) maxY = Math.max(maxY + dy, minY + minSize);
  return [minX, minY, maxX, maxY];
}

/**
 * Project a map-coordinate extent into a viewport pixel rect using the given
 * coordinate→pixel projection function (e.g. `map.getPixelFromCoordinate`).
 */
export function extentToPixelRect(
  extent: BoxExtent,
  project: (coord: [number, number]) => [number, number],
): PixelRect {
  const topLeft = project([extent[0], extent[3]]);
  const bottomRight = project([extent[2], extent[1]]);
  const left = Math.min(topLeft[0], bottomRight[0]);
  const top = Math.min(topLeft[1], bottomRight[1]);
  return {
    left,
    top,
    width: Math.abs(bottomRight[0] - topLeft[0]),
    height: Math.abs(bottomRight[1] - topLeft[1]),
  };
}

/**
 * Clamp a pixel rect to a canvas/viewport size. Returns the visible portion,
 * or null when the rect lies entirely outside.
 */
export function clampRectToSize(
  rect: PixelRect,
  width: number,
  height: number,
): PixelRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(width, rect.left + rect.width);
  const bottom = Math.min(height, rect.top + rect.height);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  return { left, top, width: w, height: h };
}

/** Crop a source canvas to a pixel rect, returning a new canvas. */
export function cropCanvasToRect(source: HTMLCanvasElement, rect: PixelRect): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(
      source,
      rect.left, rect.top, rect.width, rect.height,
      0, 0, rect.width, rect.height,
    );
  }
  return canvas;
}

/**
 * Extract a feature's displayable metadata: all properties except the
 * geometry and OL-object values (same rules as the map click popup).
 */
export function extractFeatureMetadata(feature: any): Record<string, any> {
  const properties = feature && feature.getProperties ? feature.getProperties() : {};
  const metadata: Record<string, any> = {};
  Object.keys(properties).forEach(key => {
    const value = properties[key];
    if (key === 'geometry') return;
    if (typeof value === 'object' && value !== null && value.getType) return;
    metadata[key] = value;
  });
  return metadata;
}

export interface VectorHitEntry {
  feature: any;
  metadata: Record<string, any>;
}

export interface BoxFeatureHits {
  /** Hits grouped by OL layer, topmost layer first. */
  hitsByLayer: Map<any, VectorHitEntry[]>;
  /** Number of collected hits (capped at `maxFeatures`). */
  totalCount: number;
  /** True when more features matched than were collected. */
  truncated: boolean;
}

/**
 * Collect vector features intersecting an extent across every visible vector
 * layer of the map, topmost layer first. Cluster bubbles are expanded to
 * their member features; features are deduplicated by identity and features
 * without displayable attributes are skipped (matching the click popup).
 * Vector-tile (MVT) layers report features from currently loaded tiles.
 */
export function collectVectorHitsInExtent(
  map: any,
  extent: BoxExtent,
  maxFeatures = 200,
): BoxFeatureHits {
  const hitsByLayer = new Map<any, VectorHitEntry[]>();
  const seenFeatures = new Set<any>();
  let totalCount = 0;
  let truncated = false;

  const layers: any[] = (map && map.getLayers && map.getLayers().getArray()) || [];
  console.log('[boxsel-debug] layers:', layers.length, 'extent:', extent); // TEMP DEBUG
  // OL renders layers in collection order (last = topmost) — walk backwards
  // so popup sections read topmost-first like the click popup does.
  for (let i = layers.length - 1; i >= 0 && !truncated; i--) {
    const layer = layers[i];
    if (!layer || layer.getVisible?.() === false) { console.log('[boxsel-debug] skip layer', i, 'visible:', layer && layer.getVisible?.()); continue; }
    const source = layer.getSource?.();
    if (!source) { console.log('[boxsel-debug] skip layer', i, 'no source'); continue; }
    console.log('[boxsel-debug] layer', i, layer.constructor?.name, 'source', source.constructor?.name, 'hasFEIE:', typeof source.forEachFeatureIntersectingExtent, 'hasGFIE:', typeof source.getFeaturesInExtent);

    let candidates: any[] = [];
    if (typeof source.forEachFeatureIntersectingExtent === 'function') {
      source.forEachFeatureIntersectingExtent(extent, (feature: any) => {
        candidates.push(feature);
      });
    } else if (typeof source.getFeaturesInExtent === 'function') {
      candidates = source.getFeaturesInExtent(extent) || [];
    } else {
      continue;
    }
    console.log('[boxsel-debug] layer', i, 'candidates:', candidates.length);

    for (const raw of candidates) {
      if (truncated) break;
      // Cluster bubbles wrap their members — report the real features.
      const members = raw && raw.get ? raw.get('features') : undefined;
      const targets: any[] = Array.isArray(members) ? members : [raw];
      for (const target of targets) {
        if (!target || seenFeatures.has(target)) continue;
        seenFeatures.add(target);
        const metadata = extractFeatureMetadata(target);
        if (Object.keys(metadata).length === 0) continue;
        if (totalCount >= maxFeatures) {
          truncated = true;
          break;
        }
        totalCount += 1;
        if (!hitsByLayer.has(layer)) hitsByLayer.set(layer, []);
        hitsByLayer.get(layer)!.push({ feature: target, metadata });
      }
    }
  }

  return { hitsByLayer, totalCount, truncated };
}
