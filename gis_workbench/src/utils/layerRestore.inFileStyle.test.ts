/**
 * Restoring a file layer must agree with what the editor and the map believe
 * about its style source - the invariant behind the "use in-file style" switch.
 *
 * Two ways the persisted-config restore used to break it:
 *
 *  A. A KML with NO styles of its own is imported with `useCustomStyle: false`
 *     (the importer sets that whenever it has KML text) and `hasInFileStyle:
 *     false`. The restore decided between "re-parse the KML for its styles" and
 *     "use the config's uniform style" on `!useCustomStyle` alone, so it
 *     re-parsed and let OpenLayers' own KML defaults rule - throwing away the
 *     colours the user had picked, which the editor still showed.
 *
 *  B. With IndexedDB available the KML text is stored under a `kml:` key and
 *     stripped from the config. The restore fetched it into a local variable
 *     but never put it back on the config it returned, so a layer restored in
 *     custom-style mode had nothing left to rebuild its file styles from:
 *     switching "use in-file style" back on could only clear the layer style,
 *     leaving the features on OpenLayers' defaults.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { restoreFileLayers } from './layerRestore';

vi.mock('./idb', () => ({
  idbGetWithRetry: vi.fn(async () => undefined),
  idbGet: vi.fn(async () => undefined),
  idbPut: vi.fn(async () => undefined),
}));
import { idbGetWithRetry } from './idb';

const KML_WITH_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Red Line</name>
    <Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>
    <LineString><coordinates>0,0,0 1,1,0</coordinates></LineString>
  </Placemark>
  <Placemark><name>Green Line</name>
    <Style><LineStyle><color>ff00ff00</color><width>2</width></LineStyle></Style>
    <LineString><coordinates>1,0,0 0,1,0</coordinates></LineString>
  </Placemark>
</Document></kml>`;

// A KML with no <Style> element anywhere - the "AOI.kml" case.
const KML_NO_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Plain Road</name>
    <LineString><coordinates>0,0,0 1,1,0</coordinates></LineString>
  </Placemark>
</Document></kml>`;

const geojsonOf = (name: string) => JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ],
});

const cb = {
  markVectorLoading: () => {},
  wireVectorTileLoading: () => {},
  getUnits: () => 'metric' as const,
};

const fakeMap = () => ({ addLayer: vi.fn(), removeLayer: vi.fn() });

/** The stroke colour the restored layer actually draws `name` with. */
function strokeColorOf(restored: any[], name: string): string {
  const cfg = restored.find((c) => c.olLayer);
  const layer = cfg.olLayer;
  const feats = layer.getSource().getFeatures();
  const feat = feats.find((f: any) => f.get('name') === name) ?? feats[0];
  // A per-feature style (what a re-parsed KML gives) wins over the layer's.
  const own = feat.getStyle?.();
  const styleFn = own ?? layer.getStyle();
  const style = typeof styleFn === 'function' ? styleFn(feat, 1) : styleFn;
  const resolved = Array.isArray(style) ? style[0] : style;
  return String(resolved?.getStroke?.()?.getColor?.() ?? '');
}

beforeEach(() => {
  vi.mocked(idbGetWithRetry).mockReset();
  vi.mocked(idbGetWithRetry).mockResolvedValue(undefined);
});

describe('restoreFileLayers: style source agrees with the config', () => {
  test('A. a KML with no styles of its own keeps the user colours', async () => {
    // Exactly what the importer writes for a styleless KML: it has KML text, so
    // `useCustomStyle` starts false, but there are no in-file styles to use.
    const config: any = {
      id: 'plain1', name: 'Plain File', type: 'kml', visible: true, opacity: 100,
      lineColor: 'rgba(66, 133, 244, 1)', lineWidth: 4, fillColor: 'rgba(66, 133, 244, 0.3)',
      drawnGeoJson: geojsonOf('Plain Road'),
      kmlText: KML_NO_STYLES,
      hasInFileStyle: false, useCustomStyle: false,
    };

    const restored = await restoreFileLayers(fakeMap(), [config], new Map(), cb as any);

    expect(restored).toHaveLength(1);
    // The uniform style from the config, not OpenLayers' KML default.
    expect(strokeColorOf(restored, 'Plain Road')).toContain('66, 133, 244');
    expect(restored[0].olLayer.getStyle()).not.toBeUndefined();
  });

  test('A2. a styled KML still comes back with its own per-feature styles', async () => {
    const config: any = {
      id: 'kml1', name: 'Styled KML', type: 'kml', visible: true, opacity: 100,
      lineColor: 'rgba(255, 0, 0, 1)', lineWidth: 3, fillColor: 'rgba(255, 0, 0, 0.3)',
      drawnGeoJson: geojsonOf('Red Line'),
      kmlText: KML_WITH_STYLES,
      hasInFileStyle: true, useCustomStyle: false,
    };

    const restored = await restoreFileLayers(fakeMap(), [config], new Map(), cb as any);

    // Re-parsing the KML recovers BOTH placemarks, each carrying its own style
    // - which is what rules in OpenLayers, ahead of any layer style. (`style:
    // undefined` at construction is not "no style": OL substitutes its own
    // default, which only ever shows for a feature that has none.)
    const feats = restored[0].olLayer.getSource().getFeatures();
    expect(feats).toHaveLength(2);
    expect(feats.filter((f: any) => f.getStyle() != null)).toHaveLength(2);
    // The file's red/green lines, not the config's uniform colour.
    expect(strokeColorOf(restored, 'Red Line')).not.toBe(strokeColorOf(restored, 'Green Line'));
  });

  test('A3. a styled KML the user overrode comes back in custom-style mode', async () => {
    const config: any = {
      id: 'kml1', name: 'Styled KML', type: 'kml', visible: true, opacity: 70,
      lineColor: 'rgba(12, 34, 56, 1)', lineWidth: 5, fillColor: 'rgba(12, 34, 56, 0.3)',
      drawnGeoJson: geojsonOf('Red Line'),
      kmlText: KML_WITH_STYLES,
      hasInFileStyle: true, useCustomStyle: true,
    };

    const restored = await restoreFileLayers(fakeMap(), [config], new Map(), cb as any);

    const feats = restored[0].olLayer.getSource().getFeatures();
    expect(feats.filter((f: any) => f.getStyle() != null)).toHaveLength(0);
    expect(strokeColorOf(restored, 'Red Line')).toContain('12, 34, 56');
    expect(restored[0].olLayer.getOpacity()).toBeCloseTo(0.7, 5);
  });

  test('A4. a config saved before hasInFileStyle existed still recovers its styles', async () => {
    // Migration compatibility: with no persisted flag, fall back to the same
    // <Style>/<StyleMap test the importer runs on the KML text, and fill the
    // flag in so the editor's switch is enabled for the layer afterwards.
    const config: any = {
      id: 'old1', name: 'Legacy KML', type: 'kml', visible: true, opacity: 100,
      lineColor: 'rgba(255, 0, 0, 1)', lineWidth: 3, fillColor: 'rgba(255, 0, 0, 0.3)',
      drawnGeoJson: geojsonOf('Red Line'),
      kmlText: KML_WITH_STYLES,
      useCustomStyle: false, // hasInFileStyle: undefined
    };

    const restored = await restoreFileLayers(fakeMap(), [config], new Map(), cb as any);

    const feats = restored[0].olLayer.getSource().getFeatures();
    expect(feats).toHaveLength(2);
    expect(feats.filter((f: any) => f.getStyle() != null)).toHaveLength(2);
    expect(restored[0].hasInFileStyle).toBe(true);
  });

  test('A5. a styleless legacy config is not given OpenLayers KML defaults', async () => {
    const config: any = {
      id: 'old2', name: 'Legacy Plain', type: 'kml', visible: true, opacity: 100,
      lineColor: 'rgba(66, 133, 244, 1)', lineWidth: 4, fillColor: 'rgba(66, 133, 244, 0.3)',
      drawnGeoJson: geojsonOf('Plain Road'),
      kmlText: KML_NO_STYLES,
      useCustomStyle: false, // hasInFileStyle: undefined
    };

    const restored = await restoreFileLayers(fakeMap(), [config], new Map(), cb as any);

    expect(strokeColorOf(restored, 'Plain Road')).toContain('66, 133, 244');
    expect(restored[0].hasInFileStyle).toBe(false);
  });

  test('B. KML text recovered from IndexedDB is put back on the config', async () => {
    // The IDB-backed shape: no inline text, only marker keys.
    vi.mocked(idbGetWithRetry).mockImplementation(async (key: string) => {
      if (key === 'kml:ws1:kml1') return KML_WITH_STYLES;
      if (key === 'file:ws1:kml1') return geojsonOf('Red Line');
      return undefined;
    });
    const config: any = {
      id: 'kml1', name: 'Styled KML', type: 'kml', visible: true, opacity: 40,
      lineColor: 'rgba(255, 0, 0, 1)', lineWidth: 3, fillColor: 'rgba(255, 0, 0, 0.3)',
      geometryIdbKey: 'file:ws1:kml1',
      hasInFileStyle: true, useCustomStyle: true,
    };

    const restored = await restoreFileLayers(fakeMap(), [config], new Map(), cb as any);

    expect(restored).toHaveLength(1);
    // Without this, `enterInFileStyleMode` has no text to rebuild the file's
    // styles from and the switch can only clear the layer style.
    expect(restored[0].kmlText).toBe(KML_WITH_STYLES);
  });
});
