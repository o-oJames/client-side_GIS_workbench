/**
 * File-based COG layers must survive a workspace switch.
 *
 * The layer CONFIG is persisted (so the panel and layer order are restored),
 * but the blob URL is stripped on save — after a reload it would point at a
 * dead URL. Within the live session the URL is re-resolved from the
 * cogFileRegistry (covered in rasterLayerFactory.test.ts).
 */
import { saveSettings, loadSettings, settingsKeyFor } from './workspaceStorage';
import type { StoredSettings, RasterLayer } from '../types';

beforeEach(() => localStorage.clear());

function baseSettings(rasterLayers: RasterLayer[]): StoredSettings {
  return {
    settingsPinned: false,
    showBasemap: true,
    basemapUrl: 'https://tile.example.com/{z}/{x}/{y}.png',
    units: 'metric',
    showGrid: false,
    showDrawToolbar: true,
    showCoordinates: true,
    rasterLayers,
    rasterGroups: [],
    vectorLayers: [],
    vectorGroups: [],
  };
}

const FILE_COG: RasterLayer = {
  id: 'cog-1',
  name: 'aerial',
  type: 'cog',
  url: 'blob:http://localhost/abc-123',
  cogSource: 'file',
  cogFileName: 'aerial.tif',
};

const HTTP_LAYER: RasterLayer = {
  id: 'xyz-1',
  name: 'basemap',
  type: 'xyz',
  url: 'https://tile.example.com/{z}/{x}/{y}.png',
};

test('file COG layer config persists across a save/load round trip', () => {
  saveSettings(baseSettings([FILE_COG, HTTP_LAYER]), 'ws-cog');

  const restored = loadSettings('ws-cog');
  expect(restored.rasterLayers.map(l => l.id)).toEqual(['cog-1', 'xyz-1']);

  const cog = restored.rasterLayers.find(l => l.id === 'cog-1')!;
  expect(cog.type).toBe('cog');
  expect(cog.cogSource).toBe('file');
  expect(cog.cogFileName).toBe('aerial.tif');
  // The blob URL is session-only and must not be persisted.
  expect(cog.url).toBe('');
});

test('the persisted JSON strips the blob URL but keeps the config', () => {
  saveSettings(baseSettings([FILE_COG]), 'ws-cog');
  const raw = JSON.parse(localStorage.getItem(settingsKeyFor('ws-cog')) || '{}');
  const stored = raw.rasterLayers.find((l: any) => l.id === 'cog-1');
  expect(stored).toBeTruthy();
  expect(stored.url).toBe('');
  expect(stored.cogFileName).toBe('aerial.tif');
});

test('non-file COG layers keep their URL on save', () => {
  const httpCog: RasterLayer = {
    id: 'cog-2', name: 'remote', type: 'cog',
    url: 'https://example.com/scene.tif', cogSource: 'http',
  };
  saveSettings(baseSettings([httpCog]), 'ws-cog');
  const restored = loadSettings('ws-cog');
  expect(restored.rasterLayers[0].url).toBe('https://example.com/scene.tif');
});
