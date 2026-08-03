import React, { useState } from 'react';
import { CustomSelect } from './CustomSelect';

export type GoToMethod = 'zxy' | 'latlng' | 'address';

export function GoToBar({ onGoTo }: { onGoTo: (center: [number, number], zoom: number) => void }) {
  const [method, setMethod] = useState<GoToMethod>('zxy');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAddressSearch = async (query: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!response.ok) {
        throw new Error('Search request failed');
      }
      const results = await response.json();
      if (!results || results.length === 0) {
        setError('No results found');
        return;
      }
      const result = results[0];
      const lat = parseFloat(result.lat);
      const lon = parseFloat(result.lon);

      // Compute zoom from bounding box if available
      let zoom = 15;
      if (result.boundingbox) {
        const south = parseFloat(result.boundingbox[0]);
        const north = parseFloat(result.boundingbox[1]);
        const west = parseFloat(result.boundingbox[2]);
        const east = parseFloat(result.boundingbox[3]);
        const latDiff = north - south;
        const lonDiff = east - west;
        const maxDiff = Math.max(latDiff, lonDiff);
        if (maxDiff > 0) {
          zoom = Math.max(1, Math.min(18, Math.floor(Math.log2(360 / maxDiff)) - 1));
        }
      }

      onGoTo([lon, lat], zoom);
    } catch (err: any) {
      setError(err?.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = input.trim();
    if (!trimmed) return;

    if (method === 'zxy') {
      const match = trimmed.match(/^(\d+)\/(\d+)\/(\d+)$/);
      if (!match) {
        setError('Format: z/x/y');
        return;
      }
      const z = parseInt(match[1], 10);
      const x = parseInt(match[2], 10);
      const y = parseInt(match[3], 10);

      if (z < 0 || z > 25) {
        setError('Zoom must be 0-25');
        return;
      }
      const maxTile = Math.pow(2, z);
      if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) {
        setError('Tile out of range');
        return;
      }

      const n = Math.pow(2, z);
      const lon = (x + 0.5) / n * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
      const lat = latRad * 180 / Math.PI;

      onGoTo([lon, lat], z);
    } else if (method === 'latlng') {
      const match = trimmed.match(/^(-?[\d.]+)[,\s]+(-?[\d.]+)$/);
      if (!match) {
        setError('Format: lat,lng');
        return;
      }
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);

      if (lat < -90 || lat > 90) {
        setError('Lat must be -90 to 90');
        return;
      }
      if (lng < -180 || lng > 180) {
        setError('Lng must be -180 to 180');
        return;
      }

      onGoTo([lng, lat], 15);
    } else {
      // address search
      handleAddressSearch(trimmed);
    }
  };

  const placeholders: Record<GoToMethod, string> = {
    zxy: 'z/x/y e.g. 11/1811/1236',
    latlng: 'lat,lng e.g. -34.111,138.222',
    address: 'Search address...',
  };

  return (
    <form className={`goto-bar${method === 'address' ? ' goto-bar-address' : ''}`} onSubmit={handleSubmit} onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <CustomSelect
        className="goto-select"
        value={method}
        onChange={val => { setMethod(val as GoToMethod); setError(''); setInput(''); }}
        options={[
          { value: 'zxy', label: 'ZXY' },
          { value: 'latlng', label: 'LatLng' },
          { value: 'address', label: 'Address' },
        ]}
      />
      <div className={`goto-input-wrapper${method === 'address' ? ' goto-input-wide' : ''}`}>
        <input
          className={`goto-input${error ? ' goto-input-error' : ''}`}
          type="text"
          placeholder={placeholders[method]}
          value={input}
          onChange={e => { setInput(e.target.value); setError(''); }}
          disabled={loading}
        />
        {input && !loading && (
          <button
            type="button"
            className="goto-clear"
            onClick={() => { setInput(''); setError(''); }}
            title="Clear"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
        {loading && (
          <span className="goto-spinner" />
        )}
      </div>
      <button className="goto-button" type="submit" title="Go" disabled={loading}>
        {loading ? (
          <span className="goto-button-spinner" />
        ) : (
          method === 'address' ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          )
        )}
      </button>
      {error && <span className="goto-error">{error}</span>}
    </form>
  );
}
