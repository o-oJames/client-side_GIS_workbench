// ---------------------------------------------------------------------------
// utils/postgisConnector.ts — HTTP client for the PostGIS Connector server.
//
// Security model (two-tier):
//   Tier 1: Random 256-bit key stored in localStorage("db_encrypt")
//   Tier 2: Key derived from app-lock password via PBKDF2 (stronger)
//
// The browser encrypts/decrypts credentials locally. The connector stores
// opaque encrypted blobs and holds decrypted credentials in memory only.
//
// Registration payloads are encrypted with the connector's session key
// (fetched from /health) before sending, so credentials don't travel in
// plaintext over localhost HTTP.
//
// Flow:
//   1. On app start: load/generate clientId + key
//   2. Load encrypted blob from connector → decrypt locally → get connections
//   3. Encrypt connections with session key → register with connector
//   4. On connector restart: re-register (session key changes)
//   5. Migration: old connections (machine-key encrypted) → re-encrypt with
//      client key → save to connector
// ---------------------------------------------------------------------------

import { PostgisConnection, PostgisTableInfo } from '../types';

const BASE_PORT = 40000;
const PORT_RANGE = 20;
const PROBE_TIMEOUT_MS = 500;
const CACHE_KEY = 'mapviewer-postgis-connector-url';
const CLIENT_ID_KEY = 'mapviewer-db-client-id';
const DB_ENCRYPT_KEY = 'mapviewer-db-encrypt';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full connection with password (decrypted locally, never sent to connector at rest). */
export interface FullConnection extends PostgisConnection {
  password: string;
}

/** Encrypted payload format: iv:authTag:ciphertext (all hex). */
interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

// ---------------------------------------------------------------------------
// Client ID management
// ---------------------------------------------------------------------------

/** Get or generate the client ID (UUID). Stored in localStorage. */
function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Key management (two-tier)
// ---------------------------------------------------------------------------

/**
 * Get the encryption key.
 * Tier 2: If app-lock password is provided, derive via PBKDF2.
 * Tier 1: Otherwise, use random key from localStorage.
 */
async function getEncryptionKey(appLockPassword?: string): Promise<CryptoKey> {
  const clientId = getClientId();

  if (appLockPassword) {
    // Tier 2: derive from password
    const salt = `mapviewer-db-v1:${clientId}`;
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(appLockPassword),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Tier 1: random key in localStorage
  let keyHex = localStorage.getItem(DB_ENCRYPT_KEY);
  if (!keyHex) {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    keyHex = Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DB_ENCRYPT_KEY, keyHex);
  }
  const keyBytes = new Uint8Array(keyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Migrate from tier 1 to tier 2: re-encrypt existing blob with password-derived key.
 * Called when user sets app-lock password after having connections.
 */
export async function migrateToPasswordKey(
  baseUrl: string,
  appLockPassword: string,
  connections: FullConnection[]
): Promise<void> {
  const clientId = getClientId();
  const newKey = await getEncryptionKey(appLockPassword);
  const encrypted = await encryptConnections(connections, newKey);
  await saveEncryptedBlob(baseUrl, clientId, encrypted);
  // Remove the tier-1 random key since we're now using password-derived key
  localStorage.removeItem(DB_ENCRYPT_KEY);
}

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

async function encryptConnections(connections: FullConnection[], key: CryptoKey): Promise<string> {
  const plaintext = JSON.stringify(connections);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const ctArray = new Uint8Array(ciphertext);
  // AES-GCM appends the 16-byte auth tag to the ciphertext
  const authTag = ctArray.slice(ctArray.length - 16);
  const actualCiphertext = ctArray.slice(0, ctArray.length - 16);

  const payload: EncryptedPayload = {
    iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
    authTag: Array.from(authTag).map(b => b.toString(16).padStart(2, '0')).join(''),
    ciphertext: Array.from(actualCiphertext).map(b => b.toString(16).padStart(2, '0')).join(''),
  };
  return JSON.stringify(payload);
}

async function decryptConnections(encryptedBlob: string, key: CryptoKey): Promise<FullConnection[]> {
  const payload: EncryptedPayload = JSON.parse(encryptedBlob);
  const iv = new Uint8Array(payload.iv.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const authTag = new Uint8Array(payload.authTag.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const ciphertext = new Uint8Array(payload.ciphertext.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

  // Web Crypto expects ciphertext + authTag concatenated
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

/**
 * Encrypt registration payload with the connector's session key.
 * Uses Node.js crypto format (iv:authTag:ciphertext) for compatibility with
 * the connector's decryption.
 */
async function encryptRegistrationPayload(
  connections: FullConnection[],
  sessionKey: string
): Promise<string> {
  const plaintext = JSON.stringify(connections);
  const keyBytes = new Uint8Array(sessionKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  // Import the session key
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const ctArray = new Uint8Array(ciphertext);
  const authTag = ctArray.slice(ctArray.length - 16);
  const actualCiphertext = ctArray.slice(0, ctArray.length - 16);

  // Format: iv:authTag:ciphertext (all hex)
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  const authTagHex = Array.from(authTag).map(b => b.toString(16).padStart(2, '0')).join('');
  const ciphertextHex = Array.from(actualCiphertext).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${ivHex}:${authTagHex}:${ciphertextHex}`;
}

// ---------------------------------------------------------------------------
// Connector discovery
// ---------------------------------------------------------------------------

export async function findConnector(): Promise<string | null> {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(`${cached}/health`, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.ok) return cached;
      localStorage.removeItem(CACHE_KEY);
    } catch {
      localStorage.removeItem(CACHE_KEY);
    }
  }

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

export function clearConnectorCache(): void {
  localStorage.removeItem(CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Boot time tracking (for restart detection)
// ---------------------------------------------------------------------------

let lastBootTime: string | null = null;
let currentSessionKey: string | null = null;

async function getHealthInfo(baseUrl: string): Promise<{ bootTime: string | null; sessionKey: string | null }> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) return { bootTime: null, sessionKey: null };
    const data = await res.json();
    return { bootTime: data.bootTime || null, sessionKey: data.sessionKey || null };
  } catch {
    return { bootTime: null, sessionKey: null };
  }
}

/** Check if the connector has restarted since last check. */
export async function hasConnectorRestarted(baseUrl: string): Promise<boolean> {
  const { bootTime, sessionKey } = await getHealthInfo(baseUrl);
  if (!bootTime) return false;
  if (lastBootTime && lastBootTime !== bootTime) {
    lastBootTime = bootTime;
    currentSessionKey = sessionKey;
    return true;
  }
  lastBootTime = bootTime;
  currentSessionKey = sessionKey;
  return false;
}

/** Get the current session key (fetches if not cached). */
async function getSessionKey(baseUrl: string): Promise<string | null> {
  if (currentSessionKey) return currentSessionKey;
  const { sessionKey } = await getHealthInfo(baseUrl);
  currentSessionKey = sessionKey;
  return sessionKey;
}

// ---------------------------------------------------------------------------
// Storage API (encrypted blobs)
// ---------------------------------------------------------------------------

async function loadEncryptedBlob(baseUrl: string, clientId: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/storage?clientId=${encodeURIComponent(clientId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.encryptedBlob || null;
}

async function saveEncryptedBlob(baseUrl: string, clientId: string, encryptedBlob: string): Promise<void> {
  const res = await fetch(`${baseUrl}/storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, encryptedBlob }),
  });
  if (!res.ok) throw new Error('Failed to save encrypted blob');
}

// ---------------------------------------------------------------------------
// Registration API (encrypted payload)
// ---------------------------------------------------------------------------

async function registerWithConnector(baseUrl: string, connections: FullConnection[]): Promise<void> {
  const sessionKey = await getSessionKey(baseUrl);
  if (!sessionKey) {
    throw new Error('Failed to get session key from connector');
  }

  const encryptedPayload = await encryptRegistrationPayload(connections, sessionKey);

  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedPayload }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || 'Failed to register connections with connector');
  }
}

// ---------------------------------------------------------------------------
// Migration API
// ---------------------------------------------------------------------------

async function migrateLegacy(baseUrl: string): Promise<FullConnection[]> {
  const res = await fetch(`${baseUrl}/migrate`);
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.migrated || !data.connections) return [];
  return data.connections;
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/**
 * Initialize the PostGIS connector client.
 * - Loads/generates client ID and encryption key
 * - Loads encrypted connections from connector
 * - Decrypts locally
 * - Registers with connector (encrypted with session key)
 * - Handles legacy migration if needed
 *
 * @param baseUrl - Connector base URL
 * @param appLockPassword - Optional app-lock password for tier-2 key derivation
 * @returns List of connections (without passwords masked — browser has them)
 */
export async function initConnector(
  baseUrl: string,
  appLockPassword?: string
): Promise<PostgisConnection[]> {
  const clientId = getClientId();
  const key = await getEncryptionKey(appLockPassword);

  // Fetch session key early
  await getSessionKey(baseUrl);

  // Check for legacy connections
  const legacyConnections = await migrateLegacy(baseUrl);
  if (legacyConnections.length > 0) {
    // Re-encrypt with client key and save
    const encrypted = await encryptConnections(legacyConnections, key);
    await saveEncryptedBlob(baseUrl, clientId, encrypted);
    // Register with connector (encrypted with session key)
    await registerWithConnector(baseUrl, legacyConnections);
    // Return without passwords
    return legacyConnections.map(({ password, ...rest }) => rest);
  }

  // Load encrypted blob
  const encryptedBlob = await loadEncryptedBlob(baseUrl, clientId);
  if (!encryptedBlob) {
    return []; // No connections yet
  }

  // Decrypt
  let connections: FullConnection[];
  try {
    connections = await decryptConnections(encryptedBlob, key);
  } catch (err) {
    console.error('[postgisConnector] Failed to decrypt connections:', err);
    // If decryption fails (wrong key?), return empty
    return [];
  }

  // Register with connector (encrypted with session key)
  await registerWithConnector(baseUrl, connections);

  // Return without passwords
  return connections.map(({ password, ...rest }) => rest);
}

/**
 * Re-register connections with the connector (e.g., after restart).
 * Decrypts from localStorage and sends to connector.
 */
export async function reregisterConnections(
  baseUrl: string,
  appLockPassword?: string
): Promise<void> {
  const clientId = getClientId();
  const key = await getEncryptionKey(appLockPassword);
  const encryptedBlob = await loadEncryptedBlob(baseUrl, clientId);
  if (!encryptedBlob) return;

  const connections = await decryptConnections(encryptedBlob, key);
  await registerWithConnector(baseUrl, connections);
}

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

export interface NewConnectionInput {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

/**
 * Save a new connection.
 * Encrypts locally, saves to connector, registers with connector.
 */
export async function saveConnection(
  baseUrl: string,
  input: NewConnectionInput,
  appLockPassword?: string
): Promise<PostgisConnection> {
  const clientId = getClientId();
  const key = await getEncryptionKey(appLockPassword);

  // Load existing connections
  const encryptedBlob = await loadEncryptedBlob(baseUrl, clientId);
  let connections: FullConnection[] = [];
  if (encryptedBlob) {
    try {
      connections = await decryptConnections(encryptedBlob, key);
    } catch {
      connections = [];
    }
  }

  // Add new connection
  const newConn: FullConnection = {
    id: crypto.randomUUID(),
    name: input.name,
    host: input.host,
    port: input.port || 5432,
    database: input.database,
    username: input.username,
    password: input.password,
    createdAt: new Date().toISOString(),
  };
  connections.push(newConn);

  // Encrypt and save
  const encrypted = await encryptConnections(connections, key);
  await saveEncryptedBlob(baseUrl, clientId, encrypted);

  // Register with connector (encrypted with session key)
  await registerWithConnector(baseUrl, connections);

  // Return without password
  const { password, ...safe } = newConn;
  return safe;
}

/**
 * Delete a connection.
 * Updates encrypted blob and unregisters from connector.
 */
export async function deleteConnection(
  baseUrl: string,
  connectionId: string,
  appLockPassword?: string
): Promise<void> {
  const clientId = getClientId();
  const key = await getEncryptionKey(appLockPassword);

  // Load existing connections
  const encryptedBlob = await loadEncryptedBlob(baseUrl, clientId);
  if (!encryptedBlob) return;

  let connections: FullConnection[] = [];
  try {
    connections = await decryptConnections(encryptedBlob, key);
  } catch {
    return;
  }

  // Remove connection
  connections = connections.filter(c => c.id !== connectionId);

  // Encrypt and save
  const encrypted = await encryptConnections(connections, key);
  await saveEncryptedBlob(baseUrl, clientId, encrypted);

  // Unregister from connector
  const res = await fetch(`${baseUrl}/connections/${connectionId}`, { method: 'DELETE' });
  if (!res.ok) {
    console.warn('[postgisConnector] Failed to unregister connection from connector');
  }
}

/**
 * Test a connection.
 */
export async function testConnection(
  baseUrl: string,
  connectionId: string
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const res = await fetch(`${baseUrl}/connections/${connectionId}/test`, { method: 'POST' });
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
    bbox?: [number, number, number, number];
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

export function getTileUrl(baseUrl: string, connectionId: string, table: string, geomColumn: string): string {
  return `${baseUrl}/connections/${connectionId}/tiles/{z}/{x}/{y}?table=${encodeURIComponent(table)}&geomColumn=${encodeURIComponent(geomColumn)}`;
}

// ---------------------------------------------------------------------------
// Legacy API (for backward compatibility during transition)
// ---------------------------------------------------------------------------

/**
 * List connections (legacy API — calls initConnector internally).
 * @deprecated Use initConnector() instead.
 */
export async function listConnections(baseUrl: string, appLockPassword?: string): Promise<PostgisConnection[]> {
  return initConnector(baseUrl, appLockPassword);
}
