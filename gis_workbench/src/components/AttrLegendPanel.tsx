import { AttributeLegendRow } from '../utils/attributeStyle';

/** One attribute-driven layer's entry in the on-map legend panel. */
export interface AttrLegendLayerEntry {
  id: string;
  name: string;
  field: string;
  rows: AttributeLegendRow[];
}

/**
 * Floating on-map legend for vector layers with attribute-driven rendering
 * ("smart mapping") enabled — answers "what does each feature look like,
 * given its data?" without opening the settings panel, the way ArcGIS
 * Online's map viewer shows the active layer's legend. Rendered by MapPage
 * whenever at least one visible layer carries an active attribute style;
 * rows are derived purely from the persisted config (no live features), so
 * the panel is correct even before lazy sources finish loading.
 */
export function AttrLegendPanel({ layers }: { layers: AttrLegendLayerEntry[] }) {
  if (!layers.length) return null;
  return (
    <div className="attr-legend-panel" role="complementary" aria-label="Attribute legend">
      <div className="attr-legend-title">Legend</div>
      {layers.map((layer) => (
        <div key={layer.id} className="attr-legend-layer">
          <div className="attr-legend-layer-name" title={`${layer.name} \u2014 styled by "${layer.field}"`}>
            {layer.name}
          </div>
          <div className="attr-legend-layer-field">by {layer.field}</div>
          {layer.rows.map((row, i) => (
            <div key={i} className="attr-legend-row">
              <span className="attr-legend-swatch-box" aria-hidden="true">
                {row.sizePx !== undefined ? (
                  <span
                    className="attr-legend-swatch attr-legend-swatch--circle"
                    style={{
                      width: Math.max(4, Math.min(18, row.sizePx)),
                      height: Math.max(4, Math.min(18, row.sizePx)),
                      background: row.color,
                    }}
                  />
                ) : (
                  <span className="attr-legend-swatch" style={{ background: row.color }} />
                )}
              </span>
              <span className="attr-legend-label" title={row.label}>{row.label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
