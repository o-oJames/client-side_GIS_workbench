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

// --- Paginated popup assembly (box-selection features) ----------------------

/** Flat entry with layer info for pagination. */
export interface FlatHitEntry extends VectorHitEntry {
  layer: any;
  layerName: string;
}

/** Flatten hitsByLayer into a single ordered list of entries. */
export function flattenHits(
  hitsByLayer: Map<any, VectorHitEntry[]>,
  layerNames: Map<any, string>,
): FlatHitEntry[] {
  const flat: FlatHitEntry[] = [];
  hitsByLayer.forEach((entries, layer) => {
    const layerName =
      layerNames.get(layer) ||
      (layer.get && layer.get('_isDrawLayer') ? 'Drawing' : 'Layer');
    for (const entry of entries) {
      flat.push({ ...entry, layer, layerName });
    }
  });
  return flat;
}

/** Group flat entries back by layer name, preserving order. */
function groupByLayer(entries: FlatHitEntry[]): Map<string, FlatHitEntry[]> {
  const groups = new Map<string, FlatHitEntry[]>();
  for (const entry of entries) {
    if (!groups.has(entry.layerName)) groups.set(entry.layerName, []);
    groups.get(entry.layerName)!.push(entry);
  }
  return groups;
}

export const BOX_FEATURES_PAGE_SIZE = 50;

/**
 * Build paginated popup HTML for box-selection features.
 * Shows `pageSize` features per page with prev/next controls.
 */
export function buildPaginatedPopup(
  allFlatHits: FlatHitEntry[],
  page: number,
  pageSize: number,
  totalCount: number,
  truncated: boolean,
  wmsSections: string[],
): string {
  const totalPages = Math.max(1, Math.ceil(allFlatHits.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, allFlatHits.length);
  const pageHits = allFlatHits.slice(start, end);

  const grouped = groupByLayer(pageHits);
  const vectorSections: string[] = [];
  grouped.forEach((entries, layerName) => {
    const blocks = entries.map(({ feature, metadata }, index) =>
      renderFeatureBlock(popupFeatureLabel(feature, start + index), metadata)
    );
    vectorSections.push(
      '<div class="popup-section">' +
        '<div class="popup-section-title">' + escapeHtml(layerName) + '</div>' +
        blocks.join('') +
      '</div>'
    );
  });

  // Notice bar
  let notice = '';
  if (truncated) {
    notice = '<div class="popup-row popup-row-muted">Collected ' + totalCount + ' matching features (capped)</div>';
  }
  if (allFlatHits.length > 1) {
    notice += '<div class="popup-row popup-row-muted">Showing ' + (start + 1) + '–' + end + ' of ' + allFlatHits.length + '</div>';
  }

  // Pagination controls
  let pagination = '';
  if (totalPages > 1) {
    const prevDisabled = safePage === 0 ? ' popup-page-btn-disabled' : '';
    const nextDisabled = safePage === totalPages - 1 ? ' popup-page-btn-disabled' : '';
    const chevronLeft = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    const chevronRight = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    pagination =
      '<div class="popup-pagination">' +
        '<button type="button" class="popup-page-btn' + prevDisabled + '" data-popup-action="page-prev"' + (safePage === 0 ? ' disabled' : '') + ' aria-label="Previous page">' + chevronLeft + '</button>' +
        '<span class="popup-page-info">Page ' + (safePage + 1) + ' / ' + totalPages + '</span>' +
        '<button type="button" class="popup-page-btn' + nextDisabled + '" data-popup-action="page-next"' + (safePage === totalPages - 1 ? ' disabled' : '') + ' aria-label="Next page">' + chevronRight + '</button>' +
      '</div>';
  }

  const topPagination = totalPages > 1
    ? pagination.replace('class="popup-pagination"', 'class="popup-pagination popup-pagination--top"')
    : '';
  return notice + topPagination + vectorSections.join('') + wmsSections.join('') + (totalPages > 1 ? pagination : '');
}
