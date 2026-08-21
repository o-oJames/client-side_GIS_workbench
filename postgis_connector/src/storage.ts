// ---------------------------------------------------------------------------
// storage.ts — Encrypted blob store per client + in-memory credential registry.
//
// Security model:
// - Encrypted blobs stored on disk (browser encrypts with db_encrypt key)
// - Session key generated on startup for encrypting registration payloads
// - Credentials held in memory only (lost on restart)
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.mapviewer');
const CLIENTS_DIR = path.join(CONFIG_DIR, 'clients');
const LEGACY_CONNECTIONS_FILE = path.join(CONFIG_DIR, 'connections.json');

// ---------------------------------------------------------------------------
// Session key (for encrypting registration payloads)
// ---------------------------------------------------------------------------

/** Random 256-bit key generated on startup. Used to encrypt /register payloads. */
export const SESSION_KEY = crypto.randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// In-memory credential registry
// ---------------------------------------------------------------------------

export interface ConnectionCredentials {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  createdAt: string;
}

/** In-memory map of connectionId → credentials. Lost on restart. */
const credentialRegistry = new Map<string, ConnectionCredentials>();

/** Register credentials in memory (called by browser on startup/reconnect). */
export function registerCredentials(creds: ConnectionCredentials[]): void {
  for (const c of creds) {
    credentialRegistry.set(c.id, c);
  }
}

/** Get credentials from memory by connectionId. */
export function getCredentials(connectionId: string): ConnectionCredentials | undefined {
  return credentialRegistry.get(connectionId);
}

/** Remove credentials from memory. */
export function unregisterCredentials(connectionId: string): void {
  credentialRegistry.delete(connectionId);
}

/** Get all registered connection IDs. */
export function getRegisteredIds(): string[] {
  return Array.from(credentialRegistry.keys());
}

/** Clear all in-memory credentials. */
export function clearRegistry(): void {
  credentialRegistry.clear();
}

// ---------------------------------------------------------------------------
// Encrypted blob storage (per client)
// ---------------------------------------------------------------------------

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(CLIENTS_DIR)) {
    fs.mkdirSync(CLIENTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function clientFile(clientId: string): string {
  // Sanitize clientId to prevent path traversal
  const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CLIENTS_DIR, `${safe}.json`);
}

/** Load encrypted blob for a client. Returns null if not found. */
export function loadEncryptedBlob(clientId: string): string | null {
  ensureConfigDir();
  const file = clientFile(clientId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('[storage] Failed to read client blob:', err);
    return null;
  }
}

/** Save encrypted blob for a client. */
export function saveEncryptedBlob(clientId: string, encryptedBlob: string): void {
  ensureConfigDir();
  const file = clientFile(clientId);
  fs.writeFileSync(file, encryptedBlob, { mode: 0o600 });
}

/** Delete encrypted blob for a client. */
export function deleteEncryptedBlob(clientId: string): void {
  const file = clientFile(clientId);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

// ---------------------------------------------------------------------------
// Legacy migration support
// ---------------------------------------------------------------------------

/** Check if legacy connections file exists. */
export function hasLegacyConnections(): boolean {
  return fs.existsSync(LEGACY_CONNECTIONS_FILE);
}

/**
 * Load and decrypt legacy connections using the machine-derived key.
 * Returns plaintext connections for migration, then deletes the legacy file.
 */
export function migrateLegacyConnections(): ConnectionCredentials[] {
  if (!fs.existsSync(LEGACY_CONNECTIONS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(LEGACY_CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    let connections: ConnectionCredentials[];

    if (typeof parsed === 'string') {
      // Encrypted with machine key — decrypt
      const decrypted = decryptWithMachineKey(parsed);
      connections = JSON.parse(decrypted);
    } else if (Array.isArray(parsed)) {
      // Legacy plain-text format
      connections = parsed;
    } else {
      connections = [];
    }

    // Delete legacy file after successful migration
    fs.unlinkSync(LEGACY_CONNECTIONS_FILE);
    console.log(`[storage] Migrated ${connections.length} legacy connections`);
    return connections;
  } catch (err) {
    console.error('[storage] Failed to migrate legacy connections:', err);
    // Delete corrupted legacy file
    try {
      fs.unlinkSync(LEGACY_CONNECTIONS_FILE);
    } catch {}
    return [];
  }
}

// ---------------------------------------------------------------------------
// Machine key (for legacy decryption only)
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit encryption key from machine-specific identifiers.
 * Used ONLY for decrypting legacy connections during migration.
 */
function deriveMachineKey(): Buffer {
  const machineId = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model ?? 'unknown-cpu',
  ].join('|');
  return crypto.pbkdf2Sync(machineId, 'mapviewer-connector-v1', 100_000, 32, 'sha256');
}

function decryptWithMachineKey(payload: string): string {
  const key = deriveMachineKey();
  const [ivHex, authTagHex, ciphertext] = payload.split(':');
  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted payload format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// Boot timestamp (for restart detection)
// ---------------------------------------------------------------------------

export const BOOT_TIME = new Date().toISOString();

// ---------------------------------------------------------------------------
// For testing
// ---------------------------------------------------------------------------

export function __reset(): void {
  clearRegistry();
}
