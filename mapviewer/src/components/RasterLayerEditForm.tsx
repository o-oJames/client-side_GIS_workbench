import { useState } from 'react';
import { RasterLayer } from '../types';
import { SliderRow } from './SliderRow';
import { TileZoomRangeControl, parseZoomInput } from './TileZoomRangeControl';

interface RasterLayerEditFormProps {
  layer: RasterLayer;
  onApplyColorAdjustments: (layerId: string, adj: { brightness?: number; saturation?: number; contrast?: number; opacity?: number }) => void;
  onApplyTileZoomRange: (layerId: string, minZoom?: number, maxZoom?: number) => void;
  onEdit: (layer: RasterLayer) => void;  // Apply button — saves name/url/wmsFeatureInfo changes
  onCancel: () => void;  // Cancel button — exits edit mode
}

/**
 * Inline edit form for a raster layer (name, URL, WMS/WMTS info, tile zoom
 * range, color adjustments). Manages its own edit state, initialized from
 * the `layer` prop on mount. Extracted from SettingsDialog.renderRasterLayerRow.
 */
export function RasterLayerEditForm({
  layer,
  onApplyColorAdjustments,
  onApplyTileZoomRange,
  onEdit,
  onCancel }: RasterLayerEditFormProps) {
  // --- Edit state (initialized from the layer prop on mount) ---------------
  const [editName, setEditName] = useState(layer.name);
  const [editUrl, setEditUrl] = useState(
    layer.type === 'wmts' ? (layer.wmtsCapabilitiesUrl || layer.url) :
    layer.type === 'wms' ? (layer.wmsCapabilitiesUrl || layer.url) :
    layer.url
  );
  // WMS GetFeatureInfo toggle, initialized from the layer value
  const [editWmsFeatureInfo, setEditWmsFeatureInfo] = useState(!!layer.wmsFeatureInfoEnabled);
  // Color adjustment state, initialized from layer values
  const [editBrightness, setEditBrightness] = useState(layer.brightness ?? 100);
  const [editSaturation, setEditSaturation] = useState(layer.saturation ?? 100);
  const [editContrast, setEditContrast] = useState(layer.contrast ?? 100);
  const [editOpacity, setEditOpacity] = useState(layer.opacity ?? 100);
  // Snapshots captured on mount so Cancel can revert live-applied changes
  const [originalAdjustments] = useState({
    brightness: layer.brightness ?? 100,
    saturation: layer.saturation ?? 100,
    contrast: layer.contrast ?? 100,
    opacity: layer.opacity ?? 100,
  });
  // Tile zoom range state (XYZ/WMTS layers)
  const [editMinZoom, setEditMinZoom] = useState(layer.minZoom !== undefined ? String(layer.minZoom) : '');
  const [editMaxZoom, setEditMaxZoom] = useState(layer.maxZoom !== undefined ? String(layer.maxZoom) : '');
  const [originalZoomRange] = useState({ min: layer.minZoom, max: layer.maxZoom });
  // Open the colors panel only when the layer already has custom adjustments
  const [colorsExpanded, setColorsExpanded] = useState(
    (layer.brightness ?? 100) !== 100 || (layer.saturation ?? 100) !== 100 ||
    (layer.contrast ?? 100) !== 100 || (layer.opacity ?? 100) !== 100
  );

  /** Live-apply a (valid) tile zoom range while editing. */
  const applyZoomRange = (layerId: string, minStr: string, maxStr: string) => {
    const min = parseZoomInput(minStr);
    const max = parseZoomInput(maxStr);
    if (min !== undefined && max !== undefined && min > max) return; // invalid pair — wait for a valid one
    onApplyTileZoomRange(layerId, min, max);
  };

  // Compact summary of non-default color adjustments (shown in the collapsed header)
  const colorSummary = [
    editBrightness !== 100 ? `B${editBrightness}` : '',
    editSaturation !== 100 ? `S${editSaturation}` : '',
    editContrast !== 100 ? `C${editContrast}` : '',
    editOpacity !== 100 ? `O${editOpacity}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div key={layer.id} className="settings-add-form">
      <input
        type="text"
        placeholder="Layer name"
        value={editName}
        onChange={(e) => setEditName(e.target.value)}
        className="settings-input"
      />
      <input
        type="text"
        placeholder={layer.type === 'wmts' || layer.type === 'wms' ? 'GetCapabilities URL' : 'XYZ URL'}
        value={editUrl}
        onChange={(e) => setEditUrl(e.target.value)}
        className="settings-input"
      />
      {layer.type === 'wmts' && (
        <div className="settings-wmts-info">
          Layer: {layer.wmtsLayer}
        </div>
      )}
      {layer.type === 'wms' && (
        <div className="settings-wmts-info">
          Layer: {layer.wmsLayer}
        </div>
      )}
      {layer.type === 'wms' && (
        <div className="settings-checkbox-row" title="When enabled, clicking the map queries the WMS server for the raster attributes at that position.">
          <input
            type="checkbox"
            id={'wms-featureinfo-' + layer.id}
            checked={editWmsFeatureInfo}
            onChange={(e) => setEditWmsFeatureInfo(e.target.checked)}
          />
          <label htmlFor={'wms-featureinfo-' + layer.id}>GetFeatureInfo (click to inspect)</label>
        </div>
      )}
      {(layer.type === 'xyz' || layer.type === 'wmts') && (() => {
        // For WMTS, constrain the control to the matrix range of the live source
        const wmtsGrid = layer.type === 'wmts' ? layer.olLayer?.getSource?.()?.getTileGrid?.() : null;
        const native = (layer.olLayer as any)?._nativeTileZoomRange
          ?? (wmtsGrid ? { min: wmtsGrid.getMinZoom(), max: wmtsGrid.getMaxZoom() } : null);
        return (
          <TileZoomRangeControl
            minValue={editMinZoom}
            maxValue={editMaxZoom}
            onMinChange={(v) => { setEditMinZoom(v); applyZoomRange(layer.id, v, editMaxZoom); }}
            onMaxChange={(v) => { setEditMaxZoom(v); applyZoomRange(layer.id, editMinZoom, v); }}
            collapsible
            defaultOpen={layer.minZoom !== undefined || layer.maxZoom !== undefined}
            nativeMin={native?.min}
            nativeMax={native?.max}
          />
        );
      })()}
      <div className="settings-color-adjustments color-adjust-collapsible">
        <button
          type="button"
          className="color-adjust-toggle"
          onClick={() => setColorsExpanded(c => !c)}
          aria-expanded={colorsExpanded}
          title={colorsExpanded ? 'Collapse' : 'Expand'}
        >
          <span className="color-adjust-toggle-left">
            <span className={'color-adjust-chevron' + (colorsExpanded ? ' expanded' : '')}>{'\u25b8'}</span>
            <span className="color-adjust-title">Colors</span>
          </span>
          <span className={'color-adjust-badge' + (colorSummary !== '' ? ' custom' : '')}>
            {colorSummary !== '' ? colorSummary : 'default'}
          </span>
        </button>
        {colorsExpanded && (
        <div className="color-adjust-body">
                          <SliderRow
          label="Brightness"
          min={0}
          max={200}
          value={editBrightness}
          defaultValue={100}
          unit="%"
          onChange={(val) => {
            setEditBrightness(val);
            onApplyColorAdjustments(layer.id, { brightness: val, saturation: editSaturation, contrast: editContrast, opacity: editOpacity });
          }}
          onReset={() => {
            setEditBrightness(100);
            onApplyColorAdjustments(layer.id, { brightness: 100, saturation: editSaturation, contrast: editContrast, opacity: editOpacity });
          }}
          resetTitle="Reset brightness"
        />
                          <SliderRow
          label="Saturation"
          min={0}
          max={200}
          value={editSaturation}
          defaultValue={100}
          unit="%"
          onChange={(val) => {
            setEditSaturation(val);
            onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: val, contrast: editContrast, opacity: editOpacity });
          }}
          onReset={() => {
            setEditSaturation(100);
            onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: 100, contrast: editContrast, opacity: editOpacity });
          }}
          resetTitle="Reset saturation"
        />
                          <SliderRow
          label="Contrast"
          min={0}
          max={200}
          value={editContrast}
          defaultValue={100}
          unit="%"
          onChange={(val) => {
            setEditContrast(val);
            onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: val, opacity: editOpacity });
          }}
          onReset={() => {
            setEditContrast(100);
            onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: 100, opacity: editOpacity });
          }}
          resetTitle="Reset contrast"
        />
                          <SliderRow
          label="Opacity"
          min={0}
          max={100}
          value={editOpacity}
          defaultValue={100}
          unit="%"
          onChange={(val) => {
            setEditOpacity(val);
            onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: val });
          }}
          onReset={() => {
            setEditOpacity(100);
            onApplyColorAdjustments(layer.id, { brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: 100 });
          }}
          resetTitle="Reset opacity"
        />
        </div>
        )}
      </div>
      <div className="settings-form-buttons">
        <button className="settings-button-primary" onClick={() => {
          if (editName.trim() && editUrl.trim()) {
            let updated: RasterLayer;
            if (layer.type === 'wmts') {
              updated = { ...layer, name: editName.trim(), wmtsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, minZoom: parseZoomInput(editMinZoom), maxZoom: parseZoomInput(editMaxZoom) };
            } else if (layer.type === 'wms') {
              updated = { ...layer, name: editName.trim(), wmsCapabilitiesUrl: editUrl.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, wmsFeatureInfoEnabled: editWmsFeatureInfo };
            } else {
              updated = { ...layer, name: editName.trim(), url: editUrl.trim(), brightness: editBrightness, saturation: editSaturation, contrast: editContrast, opacity: editOpacity, minZoom: parseZoomInput(editMinZoom), maxZoom: parseZoomInput(editMaxZoom) };
            }
            onEdit(updated);
          }
        }}>Apply</button>
        <button className="settings-button-secondary" onClick={() => {
          // Revert to original color adjustments on cancel
          onApplyColorAdjustments(layer.id, originalAdjustments);
          // Revert tile zoom range for XYZ layers
          if (layer.type === 'xyz') {
            onApplyTileZoomRange(layer.id, originalZoomRange.min, originalZoomRange.max);
          }
          onCancel();
        }}>Cancel</button>
      </div>
    </div>
  );
}
