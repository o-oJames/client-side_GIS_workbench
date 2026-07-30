import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App, { saveDrawSession, loadDrawSession, DEFAULT_WORKSPACE_ID } from './App';
import VectorSource from 'ol/source/Vector.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';

// jsdom (Node 14) lacks Blob.prototype.text, which the app's file-import path
// relies on. Polyfill it via FileReader so the simulated upload runs the real
// handleAddVectorLayer code path under test.
if (typeof (Blob.prototype as any).text !== 'function') {
  (Blob.prototype as any).text = function () {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

/** Let pending promises + the async layer-restore effect settle inside act(). */
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise<void>(r => setTimeout(r, 0));
    });
  }
};

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'L1' }, geometry: { type: 'LineString', coordinates: [[138.55, -34.95], [138.65, -34.9]] } },
    { type: 'Feature', properties: { name: 'P1' }, geometry: { type: 'Point', coordinates: [138.6, -34.92] } },
  ],
});

beforeEach(() => localStorage.clear());

test('uploaded file vector layer survives a workspace round trip', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();

  // Open Settings -> "+ Add Vector Layer" -> upload a GeoJSON file.
  fireEvent.click(screen.getByTitle('Settings'));
  fireEvent.click(screen.getByRole('button', { name: /add vector layer/i }));
  const fileInput = document.querySelector('input[type="file"][accept=".geojson,.json,.kml,.kmz"]') as HTMLInputElement;
  expect(fileInput).toBeTruthy();
  const file = new File([GEOJSON], 'testlayer.geojson', { type: 'application/geo+json' });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [file] } });
    await new Promise<void>(r => setTimeout(r, 30));
  });
  await tick(3);

  // The layer is in the panel and serialized to localStorage with inline GeoJSON.
  expect(screen.getAllByText('testlayer').length).toBeGreaterThan(0);
  const saved = JSON.parse(localStorage.getItem('mapviewer-settings') || '{}');
  const fileLayer = (saved.vectorLayers || []).find((l: any) => l.name === 'testlayer');
  expect(fileLayer).toBeTruthy();
  expect(typeof fileLayer.drawnGeoJson).toBe('string');
  expect(fileLayer.drawnGeoJson.length).toBeGreaterThan(0);

  // Create + switch to a second workspace (MapPage remounts).
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  fireEvent.click(screen.getByRole('button', { name: /new workspace/i }));
  fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Survey' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await tick(3);

  // In Survey the file layer is absent (per-workspace isolation).
  fireEvent.click(screen.getByTitle('Settings'));
  expect(screen.queryByText('testlayer')).toBeNull();

  // Switch back to Default.
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Default' }));
  await tick(3);

  // The file layer is restored into the original workspace.
  fireEvent.click(screen.getByTitle('Settings'));
  await waitFor(() => expect(screen.getAllByText('testlayer').length).toBeGreaterThan(0), { timeout: 3000 });
});

test('active draw session serializes and restores per workspace', () => {
  // A drawn line in EPSG:3857 (web mercator metres).
  const src = new VectorSource();
  const feat = new Feature(new LineString([[15420000, -4160000], [15430000, -4150000]]));
  (feat as any)._drawFeatureId = 'f1';
  (feat as any)._drawName = 'My Line';
  src.addFeature(feat);

  saveDrawSession(src, DEFAULT_WORKSPACE_ID);
  const raw = localStorage.getItem('mapviewer-draw');
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw as string);
  expect(parsed.geojson).toContain('LineString');
  expect(parsed.meta[0].name).toBe('My Line');

  // Restore into a fresh source (as a remounting workspace would).
  const dst = new VectorSource();
  const items = loadDrawSession(dst, DEFAULT_WORKSPACE_ID, () => 'metric');
  expect(dst.getFeatures().length).toBe(1);
  expect(items.length).toBe(1);
  expect(items[0].name).toBe('My Line');
  expect(items[0].type).toBe('LineString');

  // A different workspace has no draw session.
  const other = new VectorSource();
  expect(loadDrawSession(other, 'ws-other', () => 'metric').length).toBe(0);
  expect(other.getFeatures().length).toBe(0);
});
