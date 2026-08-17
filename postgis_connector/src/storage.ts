// ---------------------------------------------------------------------------
// storage.ts — Persist saved connections to ~/.mapviewer/connections.json
// Credentials are encrypted at rest using a machine-derived key (AES-256-GCM).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.mapviewer');
const CONNECTIONS_FILE = path.join(CONFIG_DIR, 'connections.json');

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  createdAt: string;
}

/**
 * Derive a 256-bit encryption key from machine-specific identifiers.
 * Uses a fixed salt so the same machine always produces the same key.
 * This is not intended to resist a determined attacker with root access —
 * it prevents casual reading of the connections file by other users/apps.
 */
function deriveMachineKey(): Buffer {
  const machineId = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model ?? 'unknown-cpu',
  ].join('|');
  // PBKDF2 with a fixed salt — deterministic per machine
  return crypto.pbkdf2Sync(machineId, 'mapviewer-connector-v1', 100_000, 32, 'sha256');
}

function encrypt(plaintext: string): string {
  const key = deriveMachineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(payload: string): string {
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

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConnections(): SavedConnection[] {
  ensureConfigDir();
  if (!fs.existsSync(CONNECTIONS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Support both encrypted (string) and legacy plain-text formats
    if (typeof parsed === 'string') {
      const decrypted = decrypt(parsed);
      return JSON.parse(decrypted);
    }
    // Legacy plain-text format — return as-is (will be encrypted on next save)
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch (err) {
    console.error('[storage] Failed to load connections:', err);
    return [];
  }
}

export function saveConnections(connections: SavedConnection[]): void {
  ensureConfigDir();
  const plaintext = JSON.stringify(connections, null, 2);
  const encrypted = encrypt(plaintext);
  fs.writeFileSync(CONNECTIONS_FILE, encrypted, { mode: 0o600 });
}


// For testing: reset in-memory state
export function __reset(): void {
  // No-op for file-based storage; tests mock this module entirely
}
