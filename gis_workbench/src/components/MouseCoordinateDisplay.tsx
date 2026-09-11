import React, { useState } from 'react';
import { toLonLat, transform } from 'ol/proj.js';
import { get as getProjection } from 'ol/proj.js';
import { CustomSelect } from './CustomSelect';
import { CrsSelectorDialog } from './CrsSelectorDialog';

const OTHER_VALUE = '__other__';

/**
 * Detect UTM zone info from a proj4 definition string.
 * Returns a zone label like "UTM Zone 55N" or null if not a UTM projection.
 */
function detectUtmZone(epsgCode: string): string | null {
  const code = epsgCode.replace('EPSG:', '');
  const num = parseInt(code, 10);
  if (isNaN(num)) return null;

  // WGS 84 / UTM north: 32601-32660
  if (num >= 32601 && num <= 32660) return `UTM Zone ${num - 32600}N`;
  // WGS 84 / UTM south: 32701-32760
  if (num >= 32701 && num <= 32760) return `UTM Zone ${num - 32700}S`;
  // GDA2020 / MGA zones: 7846-7859 (zones 46-59 south)
  if (num >= 7846 && num <= 7859) return `MGA Zone ${num - 7800}S`;
  // GDA94 / MGA zones: 28348-28358 (zones 48-58 south)
  if (num >= 28348 && num <= 28358) return `MGA Zone ${num - 28300}S`;

  return null;
}

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
  const [showCrsDialog, setShowCrsDialog] = useState(false);

  // Determine if this is a "custom" projection (not 4326 or 3857)
  const isCustomProjection = projection !== 'EPSG:4326' && projection !== 'EPSG:3857';
  const zoneInfo = isCustomProjection ? detectUtmZone(projection) : null;

  // Build the display label for the selector
  const selectorOptions = [
    { value: 'EPSG:4326', label: 'EPSG:4326' },
    { value: 'EPSG:3857', label: 'EPSG:3857' },
    ...(isCustomProjection
      ? [{ value: projection, label: projection }]
      : []),
    { value: OTHER_VALUE, label: 'Other…' },
  ];

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
    } else if (projection === 'EPSG:3857') {
      coordContent = (
        <>
          <span className="coord-label">X: </span>
          <span className="coord-value">{coordinate[0].toFixed(decimals)}</span>
          <span className="coord-value">{', '}</span>
          <span className="coord-label">Y: </span>
          <span className="coord-value">{coordinate[1].toFixed(decimals)}</span>
        </>
      );
    } else {
      // Custom projection — transform from map CRS (EPSG:3857) to target
      const targetProj = getProjection(projection);
      if (targetProj) {
        const [x, y] = transform(coordinate, 'EPSG:3857', projection);
        coordContent = (
          <>
            <span className="coord-label">E: </span>
            <span className="coord-value">{x.toFixed(decimals)}</span>
            <span className="coord-value">{', '}</span>
            <span className="coord-label">N: </span>
            <span className="coord-value">{y.toFixed(decimals)}</span>
          </>
        );
      } else {
        // Projection not registered yet — fall back to raw 3857
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
    }
  } else {
    coordContent = <span className="coord-label">Move mouse over map</span>;
  }

  const handleProjectionSelect = (val: string) => {
    if (val === OTHER_VALUE) {
      setShowCrsDialog(true);
      return;
    }
    onProjectionChange(val);
    onDecimalsChange(val === 'EPSG:4326' ? 6 : 3);
  };

  const handleCrsSelect = (epsgCode: string) => {
    setShowCrsDialog(false);
    onProjectionChange(epsgCode);
    onDecimalsChange(2);
  };

  return (
    <div className="mouse-coordinate-display" onContextMenu={(e) => { const target = e.target as HTMLElement; if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") { e.preventDefault(); } }}>
      {zoneInfo && <span className="coord-zone-badge" title={zoneInfo}>{zoneInfo}</span>}
      <span className="mouse-coordinate-text">{coordContent}</span>
      <CustomSelect
        className="mouse-coordinate-select"
        value={isCustomProjection ? projection : projection}
        onChange={handleProjectionSelect}
        options={selectorOptions}
      />
      <label className="mouse-coordinate-label">Decimal:</label>
      <input
        type="number"
        className="mouse-coordinate-spinbox"
        min="0"
        max="15"
        value={decimals}
        onChange={(e) => onDecimalsChange(parseInt(e.target.value, 10))}
      />
      {showCrsDialog && (
        <CrsSelectorDialog
          onSelect={handleCrsSelect}
          onClose={() => setShowCrsDialog(false)}
        />
      )}
    </div>
  );
}
