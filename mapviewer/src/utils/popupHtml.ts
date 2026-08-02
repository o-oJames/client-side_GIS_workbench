/**
 * Popup HTML builders for the map feature-info popup.
 *
 * Pure string-building functions — no React, no OL runtime objects.
 * Uses `escapeHtml` and `popupFeatureLabel` from layerHelpers.
 */
import { escapeHtml, popupFeatureLabel } from './layerHelpers';
import type { WmsFeatureInfoResult } from '../types';

// --- Row / block primitives -------------------------------------------------

/** Render a flat key→value metadata object as HTML rows. */
export function renderRows(metadata: Record<string, any>): string {
  return Object.entries(metadata)
    .map(([key, value]) =>
      '<div class="popup-row"><strong>' + escapeHtml(key) + ':</strong> ' + escapeHtml(String(value)) + '</div>')
    .join('');
}

/** Render a collapsible feature block with a title header. */
export function renderFeatureBlock(title: string, metadata: Record<string, any>): string {
  return '<div class="popup-feature">' +
    '<button type="button" class="popup-feature-header">' +
      '<span class="popup-feature-title-text">' + escapeHtml(title) + '</span>' +
    '</button>' +
    '<div class="popup-feature-body">' + renderRows(metadata) + '</div>' +
  '</div>';
}

// --- Section builders -------------------------------------------------------

export interface VectorHitEntry {
  feature: any;
  metadata: Record<string, any>;
}

/**
 * Build the popup sections for the vector features under the pointer.
 * `collapsible` switches between a flat layout (single hit overall) and
 * per-feature collapsible blocks (multiple hits).
 *
 * @param hitsByLayer - Map of OL layer → hit entries
 * @param layerNames  - Map of OL layer → display name
 */
export function buildVectorSections(
  hitsByLayer: Map<any, VectorHitEntry[]>,
  layerNames: Map<any, string>,
  collapsible: boolean,
): string[] {
  const sections: string[] = [];
  hitsByLayer.forEach((entries, layer) => {
    const layerName =
      layerNames.get(layer) ||
      (layer.get && layer.get('_isDrawLayer') ? 'Drawing' : 'Layer');

    if (!collapsible) {
      // Single feature overall — plain, non-collapsible section.
      sections.push(
        '<div class="popup-section">' +
          '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
          renderRows(entries[0].metadata) +
        '</div>'
      );
      return;
    }

    if (entries.length === 1) {
      // One feature from this layer — the layer name heads its block.
      sections.push(
        '<div class="popup-section">' + renderFeatureBlock(layerName, entries[0].metadata) + '</div>'
      );
      return;
    }

    // Several features from the same layer — static group title plus one
    // collapsible block per feature.
    const blocks = entries.map(({ feature, metadata }, index) =>
      renderFeatureBlock(popupFeatureLabel(feature, index), metadata)
    );
    sections.push(
      '<div class="popup-section">' +
        '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
        blocks.join('') +
      '</div>'
    );
  });
  return sections;
}

/**
 * Build the popup sections for resolved GetFeatureInfo results.
 */
export function buildWmsSections(
  results: Array<{ name: string; result: WmsFeatureInfoResult | null }>,
  collapsible: boolean,
): string[] {
  const sections: string[] = [];
  results.forEach(({ name, result }) => {
    if (!result) {
      sections.push(
        '<div class="popup-section">' +
          '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
          '<div class="popup-row popup-row-muted">No feature info available</div>' +
        '</div>'
      );
      return;
    }

    if ('features' in result) {
      if (result.features.length === 0) {
        sections.push(
          '<div class="popup-section">' +
            '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
            '<div class="popup-row popup-row-muted">No attributes at this location</div>' +
          '</div>'
        );
        return;
      }

      if (result.features.length === 1) {
        if (!collapsible) {
          sections.push(
            '<div class="popup-section">' +
              '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
              renderRows(result.features[0]) +
            '</div>'
          );
        } else {
          sections.push(
            '<div class="popup-section">' + renderFeatureBlock(name, result.features[0]) + '</div>'
          );
        }
        return;
      }

      // Several attributes sets from the same layer — one collapsible
      // block per feature.
      const blocks = result.features.map((props, index) =>
        renderFeatureBlock(name + ' \u2014 ' + (index + 1), props)
      );
      sections.push(
        '<div class="popup-section">' +
          '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
          blocks.join('') +
        '</div>'
      );
      return;
    }

    // Raw (non-JSON) payload — show it verbatim.
    sections.push(
      '<div class="popup-section">' +
        '<div class="popup-section-title">' + escapeHtml(name) + '</div>' +
        '<pre class="popup-pre">' + escapeHtml(result.text) + '</pre>' +
      '</div>'
    );
  });
  return sections;
}

// --- Full popup assembly ----------------------------------------------------

/**
 * Assemble the full popup HTML from vector hits + resolved WMS results,
 * choosing the collapsible layout based on the combined hit count.
 */
export function buildPopup(
  hitsByLayer: Map<any, VectorHitEntry[]>,
  layerNames: Map<any, string>,
  vectorFeatureCount: number,
  wmsResults: Array<{ name: string; result: WmsFeatureInfoResult | null }>,
): string {
  const wmsFeatureCount = wmsResults.reduce((count, r) => {
    const res = r.result;
    return res && 'features' in res ? count + res.features.length : count;
  }, 0);
  const collapsible = vectorFeatureCount + wmsFeatureCount > 1;
  return [
    ...buildVectorSections(hitsByLayer, layerNames, collapsible),
    ...buildWmsSections(wmsResults, collapsible),
  ].join('');
}
