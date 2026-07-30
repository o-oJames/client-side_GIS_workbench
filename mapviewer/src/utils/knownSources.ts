// ---------------------------------------------------------------------------
// Known-sources persistence (localStorage)
// ---------------------------------------------------------------------------

import type { KnownSource } from '../types';
import { KNOWN_SOURCES_KEY } from '../constants';

export function loadKnownSources(): KnownSource[] {
  try {
    const raw = localStorage.getItem(KNOWN_SOURCES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((s: any) => s.id && s.name && s.type && s.url);
      }
    }
  } catch (e) {
    console.error('Failed to load known sources:', e);
  }
  return [];
}

export function saveKnownSources(sources: KnownSource[]) {
  try {
    localStorage.setItem(KNOWN_SOURCES_KEY, JSON.stringify(sources));
  } catch (e) {
    console.error('Failed to save known sources:', e);
  }
}
