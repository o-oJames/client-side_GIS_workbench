// ---------------------------------------------------------------------------
// utils/postgisConnector.ts — HTTP client for the PostGIS Connector server.
// Handles port discovery (probing 40000–40019), connection CRUD, table
// discovery, GeoJSON queries, and MVT tile URL construction.
// ---------------------------------------------------------------------------

import { PostgisConnection, PostgisTableInfo } from '../types';

const BASE_PORT = 40000;
const PORT_RANGE = 20;
const PROBE_TIMEOUT_MS = 500;
const CACHE_KEY = 'mapviewer-postgis-connector-url';

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

/**
 * Probe ports 40000–40019 in parallel with a short timeout. Returns the base
 * URL of the first connector that responds to /health, or null if none found.
 */
export async function findConnector(): Promise<string | null> {
  // Check cache first
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(`${cached}/health`, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.ok) return cached;
      // Cached URL is stale — remove it
      localStorage.removeItem(CACHE_KEY);
    } catch {
      localStorage.removeItem(CACHE_KEY);
    }
  }

  // Probe all ports in parallel
  const candidates = Array.from({ length: PORT_RANGE }, (_, i) => BASE_PORT + i);

  const results = await Promise.all(
    candidates.map(async (port) => {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        const res = await fetch(`http://localhost:${port}/health`, { signal: ctrl.signal });
        clearTimeout(timeout);
        return res.ok ? port : null;
      } catch {
        return null;
      }
    })
  );

  const found = results.find((p) => p !== null);
  if (found !== undefined && found !== null) {
    const url = `http://localhost:${found}`;
    localStorage.setItem(CACHE_KEY, url);
    return url;
  }
  return null;
}

/** Clear the cached connector URL (e.g. after the connector is stopped). */
export function clearConnectorCache(): void {
  localStorage.removeItem(CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

export async function listConnections(baseUrl: string): Promise<PostgisConnection[]> {
  const res = await fetch(`${baseUrl}/connections`);
  if (!res.ok) throw new Error(`Failed to list connections: HTTP ${res.status}`);
  return res.json();
}

export interface NewConnectionInput {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export async function saveConnection(baseUrl: string, input: NewConnectionInput): Promise<PostgisConnection> {
  const res = await fetch(`${baseUrl}/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Failed to save connection: HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteConnection(baseUrl: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/connections/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete connection: HTTP ${res.status}`);
}

export async function testConnection(baseUrl: string, id: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const res = await fetch(`${baseUrl}/connections/${id}/test`, { method: 'POST' });
  return res.json();
}

// ---------------------------------------------------------------------------
// Table discovery
// ---------------------------------------------------------------------------

export async function listTables(baseUrl: string, connectionId: string): Promise<PostgisTableInfo[]> {
  const res = await fetch(`${baseUrl}/connections/${connectionId}/tables`);
  if (!res.ok) throw new Error(`Failed to list tables: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// GeoJSON query
// ---------------------------------------------------------------------------

export async function queryGeoJSON(
  baseUrl: string,
  connectionId: string,
  table: string,
  geomColumn: string,
  options?: {
    filter?: string;
    bbox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] in EPSG:4326
    srid?: number;
    limit?: number;
  }
): Promise<any> {
  const res = await fetch(`${baseUrl}/connections/${connectionId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table,
      geomColumn,
      filter: options?.filter || undefined,
      bbox: options?.bbox || undefined,
      srid: options?.srid || 4326,
      limit: options?.limit || 10000,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Query failed: HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// MVT tile URL builder
// ---------------------------------------------------------------------------

/** Build the MVT tile URL template for a given table. */
export function getTileUrl(baseUrl: string, connectionId: string, table: string, geomColumn: string): string {
  return `${baseUrl}/connections/${connectionId}/tiles/{z}/{x}/{y}?table=${encodeURIComponent(table)}&geomColumn=${encodeURIComponent(geomColumn)}`;
}
