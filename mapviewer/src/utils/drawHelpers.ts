import OLMap from 'ol/Map.js';
import Point from 'ol/geom/Point.js';
import { Style, Fill, Stroke, Circle as CircleStyle, RegularShape, Text } from 'ol/style.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { DrawStyle, VertexHit, SegmentHit, SessionSnapshot, UnitsSystem } from '../types';
import { DEFAULT_DRAW_STYLE } from '../types';
import { parseColor, rgbaToString } from './colorHelpers';
import { buildMeasurementStyles, shouldShowFeatureMeasurements } from './measurement';

const DRAW_STORAGE_KEY = 'mapviewer-draw';
const DEFAULT_WORKSPACE_ID = 'default';

function drawKeyFor(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? DRAW_STORAGE_KEY : `${DRAW_STORAGE_KEY}:${workspaceId}`;
}

export function buildDrawFeatureStyle(ds: DrawStyle, labelText?: string): Style {
  const line = rgbaToString(parseColor(ds.lineColor, 1));
  const fill = rgbaToString(parseColor(ds.fillColor, 0.2));
  const fontColor = rgbaToString(parseColor(ds.fontColor, 1));
  const base = {
    fill: new Fill({ color: fill }),
    stroke: new Stroke({ color: line, width: ds.lineWidth }),
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
        font: ds.fontSize + 'px Arial',
        fill: new Fill({ color: fontColor }),
        stroke: new Stroke({ color: '#fff', width: 3 }),
        offsetY: -15,
      }),
    });
  }
  return new Style(base);
}

/**
 * Anchor for a drawn feature's name label: the interior point for polygons
 * (always inside the ring, even for concave shapes), the midpoint for lines.
 * Points get no name label — a label feature's own text is already its
 * on-map caption.
 */
export function getFeatureNameLabelAnchor(geom: any): { anchor: Point; offsetY: number } | null {
  if (!geom || !geom.getType) return null;
  const type = geom.getType();
  if (type === 'Polygon') {
    // Above the area chip, which sits on the interior point itself.
    return { anchor: geom.getInteriorPoint(), offsetY: -18 };
  }
  if (type === 'LineString') {
    // Below the line so it clears the per-segment distance chips (offsetY -14).
    return { anchor: new Point(geom.getCoordinateAt(0.5)), offsetY: 14 };
  }
  return null;
}

/**
 * On-map name label for a drawn feature: the panel name rendered as a
 * haloed text at the feature's anchor, in the feature's own font settings.
 * Returns null when the geometry has no sensible anchor (e.g. points).
 */
export function buildFeatureNameLabelStyle(geom: any, name: string, ds: DrawStyle): Style | null {
  const spot = getFeatureNameLabelAnchor(geom);
  if (!spot || !name) return null;
  const fontColor = rgbaToString(parseColor(ds.fontColor, 1));
  return new Style({
    geometry: spot.anchor,
    text: new Text({
      text: name,
      font: 'bold ' + ds.fontSize + 'px Arial',
      fill: new Fill({ color: fontColor }),
      stroke: new Stroke({ color: '#fff', width: 3 }),
      offsetY: spot.offsetY,
      overflow: true,
    }),
  });
}

/**
 * Effective visibility of a drawn feature's on-map name label. An explicit
 * user choice (`_showNameLabel`) always wins; otherwise the label is on for
 * magic-wand ("snap") polygons — which have always shown their auto-name on
 * the map via the labelText slot — and off for ordinary drawn features.
 */
export function shouldShowFeatureNameLabel(feature: any): boolean {
  if (feature && typeof feature._showNameLabel === 'boolean') return feature._showNameLabel;
  return Boolean(feature && feature._snapClass);
}

/**
 * Turn a drawn feature's on-map name label on or off and restyle it so the
 * change lands immediately. The choice is stored on the feature and rides
 * along with every persistence path (draw session, undo/redo history,
 * saved-layer feature meta).
 */
export function setFeatureNameLabelVisible(feature: any, visible: boolean, getUnits: () => UnitsSystem) {
  if (!feature) return;
  feature._showNameLabel = visible;
  const ds = feature._drawStyle ? { ...feature._drawStyle } : { ...DEFAULT_DRAW_STYLE };
  applyDrawFeatureStyle(feature, ds, getUnits);
}

// Vertex handles for the Modify interactions (draw-toolbar edit tool and
// saved-layer re-edit): hollow squares in an accent colour — the inverse of
// the drawn-point style — so they read clearly as editing handles.
export function buildModifyVertexStyle(accentColor: string): Style {
  const line = rgbaToString(parseColor(accentColor, 1));
  return new Style({
    image: new RegularShape({
      points: 4,
      radius: 6,
      angle: Math.PI / 4,
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color: line, width: 2 }),
    }),
  });
}

export function forEachGeometryVertex(geom: any, cb: (indexPath: number[], coord: number[]) => void) {
  const type = geom.getType();
  if (type === 'Point') {
    cb([], geom.getCoordinates());
  } else if (type === 'LineString') {
    geom.getCoordinates().forEach((c: number[], i: number) => cb([i], c));
  } else if (type === 'Polygon') {
    geom.getCoordinates().forEach((ring: number[][], r: number) =>
      ring.forEach((c: number[], i: number) => cb([r, i], c))
    );
  }
}

// Nearest vertex within tolerance (screen pixels), or null. Ring-closing
// duplicates are skipped — they are vertex 0 in disguise.
export function findNearestVertex(map: OLMap, source: any, pixel: number[], tolerancePx: number): VertexHit | null {
  let best: VertexHit | null = null;
  let bestDist = tolerancePx;
  (source.getFeatures() as any[]).forEach((feature) => {
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom || !geom.getType) return;
    const type = geom.getType();
    if (type !== 'Point' && type !== 'LineString' && type !== 'Polygon') return;
    forEachGeometryVertex(geom, (indexPath, coord) => {
      if (type === 'Polygon') {
        const ring = geom.getCoordinates()[indexPath[0]];
        if (indexPath[1] === ring.length - 1) return;
      }
      const vp = map.getPixelFromCoordinate(coord);
      const d = Math.hypot(vp[0] - pixel[0], vp[1] - pixel[1]);
      if (d <= bestDist) {
        bestDist = d;
        best = { feature, geom, indexPath, coord: coord.slice() };
      }
    });
  });
  return best;
}

export function nearestPointOnSegmentPixel(p: number[], a: number[], b: number[]): { dist: number; px: number[] } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = [a[0] + t * dx, a[1] + t * dy];
  return { dist: Math.hypot(px[0] - p[0], px[1] - p[1]), px };
}

// Nearest segment within tolerance (screen pixels), with the insertion point
// already projected onto it.
export function findNearestSegment(map: OLMap, source: any, pixel: number[], tolerancePx: number): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestDist = tolerancePx;
  (source.getFeatures() as any[]).forEach((feature) => {
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom || !geom.getType) return;
    const type = geom.getType();
    let rings: number[][][] = [];
    if (type === 'LineString') rings = [geom.getCoordinates()];
    else if (type === 'Polygon') rings = geom.getCoordinates();
    else return;
    rings.forEach((coords, ringIndex) => {
      for (let i = 0; i < coords.length - 1; i++) {
        const a = map.getPixelFromCoordinate(coords[i]);
        const b = map.getPixelFromCoordinate(coords[i + 1]);
        const hit = nearestPointOnSegmentPixel(pixel as number[], a, b);
        if (hit.dist <= bestDist) {
          bestDist = hit.dist;
          best = {
            feature,
            geom,
            index: i,
            ringIndex: type === 'Polygon' ? ringIndex : -1,
            coord: map.getCoordinateFromPixel(hit.px),
          };
        }
      }
    });
  });
  return best;
}

export function setVertexCoordinate(geom: any, indexPath: number[], coord: number[]) {
  const type = geom.getType();
  if (type === 'Point') {
    geom.setCoordinates(coord);
  } else if (type === 'LineString') {
    const coords = geom.getCoordinates();
    coords[indexPath[0]] = coord;
    geom.setCoordinates(coords);
  } else if (type === 'Polygon') {
    const rings = geom.getCoordinates();
    const ring = rings[indexPath[0]];
    ring[indexPath[1]] = coord;
    // Keep closed rings closed — vertex 0 is duplicated at the end.
    if (indexPath[1] === 0) ring[ring.length - 1] = coord;
    geom.setCoordinates(rings);
  }
}

// Remove a vertex, refusing to degenerate the geometry (a line keeps at
// least two vertices, a ring at least three unique ones). True on success.
export function removeVertexFromGeom(geom: any, indexPath: number[]): boolean {
  const type = geom.getType();
  if (type === 'LineString') {
    const coords = geom.getCoordinates();
    if (coords.length <= 2) return false;
    coords.splice(indexPath[0], 1);
    geom.setCoordinates(coords);
    return true;
  }
  if (type === 'Polygon') {
    const rings = geom.getCoordinates();
    const ring = rings[indexPath[0]];
    if (ring.length <= 4) return false; // 3 unique vertices + closing duplicate
    ring.splice(indexPath[1], 1);
    if (indexPath[1] === 0) ring[ring.length - 1] = ring[0];
    geom.setCoordinates(rings);
    return true;
  }
  return false;
}

export function insertVertexInGeom(hit: SegmentHit) {
  const { geom, index, ringIndex, coord } = hit;
  if (ringIndex === -1) {
    const coords = geom.getCoordinates();
    coords.splice(index + 1, 0, coord);
    geom.setCoordinates(coords);
  } else {
    const rings = geom.getCoordinates();
    // Splicing before the closing duplicate keeps the ring closed even when
    // the click landed on the closing segment.
    rings[ringIndex].splice(index + 1, 0, coord);
    geom.setCoordinates(rings);
  }
}

// Marker for a "picked up" vertex: a filled diamond in the session accent
// colour inside a larger hollow one, so the floating vertex is unmistakable.
export function buildEditMarkerStyles(accentColor: string): Style[] {
  const line = rgbaToString(parseColor(accentColor, 1));
  return [
    new Style({
      image: new RegularShape({
        points: 4,
        radius: 13,
        angle: Math.PI / 4,
        stroke: new Stroke({ color: line, width: 1.5 }),
      }),
    }),
    new Style({
      image: new RegularShape({
        points: 4,
        radius: 6.5,
        angle: Math.PI / 4,
        fill: new Fill({ color: line }),
        stroke: new Stroke({ color: '#ffffff', width: 2 }),
      }),
    }),
  ];
}

/**
 * A feature's data attributes for snapshot purposes. File-imported layers
 * (GeoJSON/KML/Shapefile…) carry real attributes that must survive undo/
 * redo; drawn-in-app features typically have none. Internal keys are
 * excluded: `geometry` (captured separately) and `labelText` (has its own
 * snapshot field). Returns undefined when the feature has no attributes so
 * snapshots of drawn batches stay exactly as before.
 */
export function captureFeatureProperties(feature: any): Record<string, any> | undefined {
  if (!feature || typeof feature.getProperties !== 'function') return undefined;
  const props = feature.getProperties();
  const out: Record<string, any> = {};
  let hasAny = false;
  Object.keys(props).forEach((key) => {
    if (key === 'geometry' || key === 'labelText') return;
    const value = props[key];
    if (value === undefined) return;
    out[key] = value;
    hasAny = true;
  });
  return hasAny ? out : undefined;
}

// `extraFeatures` folds in features OpenLayers has finished drawing but not
// yet inserted into the source — drawend is dispatched before the insert.
export function captureDrawSnapshot(source: any, extraFeatures?: any[]): SessionSnapshot {
  const feats = (source.getFeatures() as any[]).concat(extraFeatures || []);
  return {
    items: feats.map((f) => {
      const geom = f.getGeometry();
      return {
        id: f._drawFeatureId || '',
        type: (geom && geom.getType ? geom.getType() : 'Point') as any,
        name: f._drawName || '',
        customized: !!f._drawCustomized,
        style: f._drawStyle ? { ...f._drawStyle } : undefined,
        // Features without a draw style (file imports) keep their own
        // styling: KML/KMZ features carry file-extracted styles at feature
        // level, and styled GeoJSON features may carry per-feature styles.
        // `|| undefined` normalises OL's null ("no style set") — restoring
        // a literal null would hide the feature (null overrides the layer
        // style), so only real styles are carried.
        featureStyle: f._drawStyle ? undefined : (typeof f.getStyle === 'function' ? (f.getStyle() || undefined) : undefined),
        labelText: f.get ? f.get('labelText') : undefined,
        snapClass: f._snapClass,
        snapIndex: f._snapIndex,
        snapPrimary: f._snapPrimary,
        showMeasurements: f._showMeasurements,
        showNameLabel: f._showNameLabel,
        nameCustomized: f._drawNameCustomized,
        featureId: (typeof f.getId === 'function' ? f.getId() : undefined),
        properties: captureFeatureProperties(f),
        geometry: geom.clone(),
      };
    }),
  };
}

// Cheap canonical form so consecutive identical states (a zero-distance
// vertex drag, a cancelled pick-up…) don't grow the stack.
export function snapshotKey(snap: SessionSnapshot): string {
  return JSON.stringify(snap.items.map(it => ({
    id: it.id,
    name: it.name,
    customized: it.customized,
    style: it.style,
    labelText: it.labelText,
    showMeasurements: it.showMeasurements,
    showNameLabel: it.showNameLabel,
    // Attributes participate in identity: an attribute-table edit must
    // register as a distinct history step (file-imported layers).
    properties: it.properties || null,
    coords: it.geometry.getCoordinates(),
  })));
}

// Apply a DrawStyle to a drawn feature via a style function so its
// measurement labels always stay in sync with the feature's geometry, style
// and unit system (works for both finished features and the in-progress
// sketch). Units are read lazily so a metric/imperial switch re-formats
// every label on the next render without re-styling each feature.
export function applyDrawFeatureStyle(feature: any, ds: DrawStyle, getUnits: () => UnitsSystem) {
  feature._drawStyle = ds;
  feature.setStyle(() => {
    const labelText = feature.get ? feature.get('labelText') : undefined;
    const nameVisible = shouldShowFeatureNameLabel(feature);
    // Snap polygons render their auto-name through the labelText slot; when
    // the name label is toggled off that text is suppressed as well.
    const effectiveLabelText = (feature._snapClass && !nameVisible) ? undefined : labelText;
    const styles: Style[] = [buildDrawFeatureStyle(ds, effectiveLabelText)];
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    // The feature's name as an on-map label. Features that already carry a
    // labelText (snap polygons, label points) render their text there
    // instead, so no second caption is added.
    if (nameVisible && !labelText && feature._drawName) {
      const nameStyle = buildFeatureNameLabelStyle(geom, feature._drawName, ds);
      if (nameStyle) styles.push(nameStyle);
    }
    // Measurement labels respect the feature's visibility flag (explicit
    // user choice in `_showMeasurements`, otherwise the vertex-count
    // default) — re-evaluated on every render so vertex edits keep it live.
    if (geom && shouldShowFeatureMeasurements(feature)) styles.push(...buildMeasurementStyles(geom, ds, getUnits()));
    return styles;
  });
}

/**
 * Turn a drawn feature's on-map measurement labels on or off and restyle it
 * so the change lands immediately. The choice is stored on the feature and
 * rides along with every persistence path (draw session, undo/redo history,
 * saved-layer feature meta).
 */
export function setDrawFeatureMeasurementsVisible(feature: any, visible: boolean, getUnits: () => UnitsSystem) {
  if (!feature) return;
  feature._showMeasurements = visible;
  const ds = feature._drawStyle ? { ...feature._drawStyle } : { ...DEFAULT_DRAW_STYLE };
  applyDrawFeatureStyle(feature, ds, getUnits);
}

// Persist the active draw-toolbar session (unsaved drawn features) for a
// workspace. Geometry is stored as GeoJSON (EPSG:4326) with a parallel meta
// array carrying each feature's id, name and DrawStyle. An empty session clears
// the key so a workspace never resurrects stale drawing.
export function saveDrawSession(source: any, workspaceId: string) {
  try {
    const feats = source && source.getFeatures ? source.getFeatures() : [];
    if (!feats || feats.length === 0) {
      localStorage.removeItem(drawKeyFor(workspaceId));
      return;
    }
    const geojsonFormat = new GeoJSON();
    const geojson = geojsonFormat.writeFeatures(feats, {
      dataProjection: 'EPSG:4326',
      featureProjection: 'EPSG:3857',
    });
    const meta = feats.map((f: any) => ({
      id: f._drawFeatureId || '',
      name: f._drawName || '',
      customized: !!f._drawCustomized,
      style: f._drawStyle ? { ...f._drawStyle } : { ...DEFAULT_DRAW_STYLE },
      labelText: f.get ? f.get('labelText') : undefined,
      snapClass: f._snapClass,
      snapIndex: f._snapIndex,
      snapPrimary: f._snapPrimary,
      showMeasurements: f._showMeasurements,
      showNameLabel: f._showNameLabel,
      nameCustomized: f._drawNameCustomized,
    }));
    localStorage.setItem(drawKeyFor(workspaceId), JSON.stringify({ geojson, meta }));
  } catch (e) {
    console.error('[DrawHelpers] Failed to save draw session:', e);
  }
}

// Restore a persisted draw session into the given source, returning the
// drawn-features panel items (same shape restoreSnapshot produces).
export function loadDrawSession(source: any, workspaceId: string, getUnits: () => UnitsSystem): Array<{ id: string; type: 'Point' | 'LineString' | 'Polygon'; name: string; feature: any; style: DrawStyle; customized: boolean }> {
  try {
    const raw = localStorage.getItem(drawKeyFor(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.geojson !== 'string') return [];
    const feats = new GeoJSON().readFeatures(parsed.geojson, {
      dataProjection: 'EPSG:4326',
      featureProjection: 'EPSG:3857',
    });
    const meta: any[] = Array.isArray(parsed.meta) ? parsed.meta : [];
    return feats.map((f: any, i: number) => {
      const m = meta[i] || {};
      const geom = f.getGeometry();
      const rawType = geom && geom.getType ? geom.getType() : 'Point';
      const type: 'Point' | 'LineString' | 'Polygon' = rawType === 'LineString' || rawType === 'Polygon' ? rawType : 'Point';
      const id = m.id || (Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9) + '_' + i);
      f._drawFeatureId = id;
      f._drawName = m.name || '';
      f._drawCustomized = !!m.customized;
      if (m.labelText !== undefined) f.set('labelText', m.labelText);
      if (m.snapClass !== undefined) f._snapClass = m.snapClass;
      if (m.snapIndex !== undefined) f._snapIndex = m.snapIndex;
      if (m.snapPrimary !== undefined) f._snapPrimary = m.snapPrimary;
      if (typeof m.showMeasurements === 'boolean') f._showMeasurements = m.showMeasurements;
      if (typeof m.showNameLabel === 'boolean') f._showNameLabel = m.showNameLabel;
      if (typeof m.nameCustomized === 'boolean') f._drawNameCustomized = m.nameCustomized;
      const style: DrawStyle = m.style ? { ...DEFAULT_DRAW_STYLE, ...m.style } : { ...DEFAULT_DRAW_STYLE };
      applyDrawFeatureStyle(f, style, getUnits);
      source.addFeature(f);
      return { id, type, name: f._drawName, feature: f, style, customized: !!m.customized };
    });
  } catch (e) {
    console.error('[DrawHelpers] Failed to load draw session:', e);
    return [];
  }
}
