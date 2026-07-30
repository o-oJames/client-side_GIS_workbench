import { Style, Fill, Stroke, Text, Circle as CircleStyle } from 'ol/style.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { getArea, getLength } from 'ol/sphere.js';
import { UnitsSystem, DrawStyle } from '../types';
import { MEASURE_FONT, MEASURE_FONT_AREA, MEASURE_TEXT_COLOR, MEASURE_CHIP_BG } from '../constants';
import { parseColor, rgbaToString } from './colorHelpers';

// Imperial conversion constants (exact international definitions).
const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;
const SQ_METERS_PER_SQ_FOOT = METERS_PER_FOOT * METERS_PER_FOOT;
const SQ_METERS_PER_SQ_MILE = METERS_PER_MILE * METERS_PER_MILE;

const MEASURE_NUMBER_OPTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

export function measureGeodesicLength(geom: any): number {
  return getLength(geom, { projection: 'EPSG:3857' });
}

export function measureGeodesicArea(geom: any): number {
  return Math.abs(getArea(geom, { projection: 'EPSG:3857' }));
}

// Format a length in meters with 2 decimals — metric: m, switching to km from
// 1,000 m; imperial: ft, switching to mi from 5,280 ft (one mile).
export function formatLength(meters: number, units: UnitsSystem): string {
  if (units === 'imperial') {
    if (meters >= METERS_PER_MILE) {
      return (meters / METERS_PER_MILE).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' mi';
    }
    return (meters / METERS_PER_FOOT).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' ft';
  }
  if (meters >= 1000) {
    return (meters / 1000).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' km';
  }
  return meters.toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' m';
}

// Format an area in square meters with 2 decimals — metric: m^2, switching to
// km^2 from 1,000,000 m^2; imperial: ft^2, switching to mi^2 from one square mile.
export function formatArea(sqMeters: number, units: UnitsSystem): string {
  if (units === 'imperial') {
    if (sqMeters >= SQ_METERS_PER_SQ_MILE) {
      return (sqMeters / SQ_METERS_PER_SQ_MILE).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' mi\u00b2';
    }
    return (sqMeters / SQ_METERS_PER_SQ_FOOT).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' ft\u00b2';
  }
  if (sqMeters >= 1000000) {
    return (sqMeters / 1000000).toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' km\u00b2';
  }
  return sqMeters.toLocaleString('en-AU', MEASURE_NUMBER_OPTS) + ' m\u00b2';
}

// One measurement "chip" label anchored at a point geometry. The chip border
// picks up the feature's line colour so it reads as part of the feature.
export function buildMeasurementChipStyle(text: string, anchor: Point, borderColor: string, offsetY = 0): Style {
  return new Style({
    geometry: anchor,
    text: new Text({
      text: text,
      font: MEASURE_FONT,
      fill: new Fill({ color: MEASURE_TEXT_COLOR }),
      backgroundFill: new Fill({ color: MEASURE_CHIP_BG }),
      backgroundStroke: new Stroke({ color: borderColor, width: 1 }),
      padding: [3, 6, 3, 6],
      offsetY: offsetY,
      overflow: true,
    }),
  });
}

// One distance chip per consecutive coordinate pair. Closed rings (first
// coordinate repeated at the end) yield exactly one chip per edge.
export function buildSegmentLabelStyles(coords: any[], borderColor: string, units: UnitsSystem): Style[] {
  const styles: Style[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segmentLength = measureGeodesicLength(new LineString([a, b]));
    const midpoint = new Point([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    styles.push(buildMeasurementChipStyle(formatLength(segmentLength, units), midpoint, borderColor, -14));
  }
  return styles;
}

// Area summary chip for polygons/rectangles. Filled with the feature's line
// colour — with an auto-picked text colour for contrast — so it stands out
// from the white per-edge distance chips.
export function buildAreaChipStyle(geom: any, ds: DrawStyle, units: UnitsSystem): Style {
  const bg = parseColor(ds.lineColor, 1);
  const luminance = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
  const textColor = luminance > 0.6 ? MEASURE_TEXT_COLOR : '#ffffff';
  return new Style({
    geometry: geom.getInteriorPoint(),
    text: new Text({
      text: formatArea(measureGeodesicArea(geom), units),
      font: MEASURE_FONT_AREA,
      fill: new Fill({ color: textColor }),
      backgroundFill: new Fill({ color: rgbaToString(bg) }),
      backgroundStroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 1 }),
      padding: [3, 7, 3, 7],
      overflow: true,
    }),
  });
}

// Measurement label styles for a drawn geometry:
//  - LineString: one chip per segment showing the vertex-to-vertex distance
//  - Polygon (incl. rectangles): one chip per edge plus a filled chip with
//    the geodesic area at the interior point
export function buildMeasurementStyles(geom: any, ds: DrawStyle, units: UnitsSystem): Style[] {
  if (!geom || !geom.getType) return [];
  const border = rgbaToString(parseColor(ds.lineColor, 1));
  const type = geom.getType();
  const styles: Style[] = [];

  if (type === 'LineString') {
    styles.push(...buildSegmentLabelStyles(geom.getCoordinates(), border, units));
  } else if (type === 'Polygon') {
    // Outer ring only; the ring is closed, so iterating consecutive pairs
    // covers every edge exactly once.
    const ring = geom.getCoordinates()[0] || [];
    styles.push(...buildSegmentLabelStyles(ring, border, units));
    styles.push(buildAreaChipStyle(geom, ds, units));
  }
  return styles;
}

// Short measurement summary for a drawn feature, shown next to its name in
// feature lists (total length for lines, area for polygons/rectangles).
export function getFeatureMeasurementText(feature: any, units: UnitsSystem): string | null {
  const geom = feature && feature.getGeometry ? feature.getGeometry() : null;
  if (!geom || !geom.getType) return null;
  const type = geom.getType();
  if (type === 'LineString') return formatLength(measureGeodesicLength(geom), units);
  if (type === 'Polygon') return formatArea(measureGeodesicArea(geom), units);
  return null;
}
