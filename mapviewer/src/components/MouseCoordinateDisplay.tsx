import React from 'react';
import { toLonLat } from 'ol/proj.js';
import { CustomSelect } from './CustomSelect';

export function MouseCoordinateDisplay({ 
  coordinate, 
  projection, 
  onProjectionChange,
  decimals,
  onDecimalsChange
}: { 
  coordinate: [number, number] | null; 
  projection: string;
  onProjectionChange: (proj: string) => void;
  decimals: number;
  onDecimalsChange: (decimals: number) => void;
}) {
  let coordContent: React.ReactNode;
  
  if (coordinate) {
    if (projection === 'EPSG:4326') {
      const [lon, lat] = toLonLat(coordinate);
      coordContent = (
        <>
          <span className="coord-label">Lat: </span>
          <span className="coord-value">{lat.toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Lng: </span>
          <span className="coord-value">{lon.toFixed(decimals)}</span>
        </>
      );
    } else {
      coordContent = (
        <>
          <span className="coord-label">X: </span>
          <span className="coord-value">{coordinate[0].toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Y: </span>
          <span className="coord-value">{coordinate[1].toFixed(decimals)}</span>
        </>
      );
    }
  } else {
    coordContent = <span className="coord-label">Move mouse over map</span>;
  }

  return (
    <div className="mouse-coordinate-display" onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      <span className="mouse-coordinate-text">{coordContent}</span>
      <CustomSelect
        className="mouse-coordinate-select"
        value={projection}
        onChange={(val) => {
          onProjectionChange(val);
          onDecimalsChange(val === 'EPSG:4326' ? 6 : 3);
        }}
        options={[
          { value: 'EPSG:4326', label: 'EPSG:4326' },
          { value: 'EPSG:3857', label: 'EPSG:3857' },
        ]}
      />
      <label className="mouse-coordinate-label">Decimal:</label>
      <input
        type="number"
        className="mouse-coordinate-spinbox"
        min="3"
        max="10"
        value={decimals}
        onChange={(e) => onDecimalsChange(parseInt(e.target.value, 10))}
      />
    </div>
  );
}
