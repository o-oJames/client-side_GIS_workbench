// ---------------------------------------------------------------------------
// Project import/export: serialises the full app state (all workspaces,
// layers, styles, view settings and IndexedDB geometry blobs) into a single
// shareable binary file (.mapviewer). When the app has a lock password set,
// the export is encrypted with AES-256-GCM (same scheme as the app-lock
// vault) so re-importing requires the password.
//
// Binary format
// -------------
//   [4 bytes]  Magic: "MVPX"
//   [1 byte]   Format version (0x01)
//   [1 byte]   Flags: bit 0 = encrypted
//   --- if encrypted ---
//   [16 bytes] PBKDF2 salt
//   [12 bytes] AES-GCM IV
//   [rest]     AES-256-GCM ciphertext (includes 16-byte auth tag)
//   --- if not encrypted ---
//   [rest]     UTF-8 JSON payload
//
// JSON payload schema (version 1):
// {
//   "version": 1,
//   "exportedAt": "<ISO-8601>",
//   "localStorage": { "<key>": "<value>", ... },
//   "indexedDB": { "<key>": "<value>", ... }
// }
// ---------------------------------------------------------------------------

import { idbGetAll, idbPutMany } from './idb';
import { APP_STORAGE_PREFIX, LOCKED_VAULT_KEY } from './appLock';

/* ---------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

const MAGIC = new Uint8Array([0x4d, 0x56, 0x50, 0x58]); // "MVPX"
const FORMAT_VERSION = 0x01;
const FLAG_ENCRYPTED = 0x01;
const PBKDF2_ITERATIONS = 310_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export const PROJECT_FILE_EXTENSION = '.mapviewer';
export const PROJECT_MIME_TYPE = 'application/octet-stream';

/* ---------------------------------------------------------------------------
 * Errors
 * --------------------------------------------------------------------------- */

export class ProjectImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectImportError';
  }
}

export class ProjectPasswordError extends ProjectImportError {
  constructor() {
    super('Incorrect password — could not decrypt the project file.');
    this.name = 'ProjectPasswordError';
  }
}

/* ---------------------------------------------------------------------------
 * Byte helpers
 * --------------------------------------------------------------------------- */

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------------------------------------------------------------------
 * Crypto helpers (AES-256-GCM via Web Crypto)
 * --------------------------------------------------------------------------- */

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = crypto.subtle;
  const baseKey = await subtle.importKey(
    'raw',
    utf8Encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptPayload(plaintext: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return concatBytes(salt, iv, new Uint8Array(ciphertext));
}

async function decryptPayload(data: Uint8Array, password: string): Promise<Uint8Array> {
  if (data.length < SALT_LENGTH + IV_LENGTH + 16) {
    throw new ProjectPasswordError();
  }
  const salt = data.slice(0, SALT_LENGTH);
  const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = data.slice(SALT_LENGTH + IV_LENGTH);
  try {
    const key = await deriveKey(password, salt);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plainBuf);
  } catch {
    throw new ProjectPasswordError();
  }
}

/* ---------------------------------------------------------------------------
 * Payload collection
 * --------------------------------------------------------------------------- */

export interface ProjectPayload {
  version: number;
  exportedAt: string;
  localStorage: Record<string, string>;
  indexedDB: Record<string, string>;
}

/** True for localStorage keys owned by this app (same logic as appLock). */
function isAppStorageKey(key: string): boolean {
  return (
    key === APP_STORAGE_PREFIX ||
    key.indexOf(APP_STORAGE_PREFIX + '-') === 0 ||
    key.indexOf(APP_STORAGE_PREFIX + ':') === 0
  );
}

/** Collect all app localStorage entries (excluding the locked vault itself). */
function collectLocalStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === LOCKED_VAULT_KEY || !isAppStorageKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  return entries;
}

/* ---------------------------------------------------------------------------
 * Export
 * --------------------------------------------------------------------------- */

/**
 * Export the full project as a binary Uint8Array.
 * @param password - When provided (i.e. the app has a lock password), the
 *   payload is AES-256-GCM encrypted so importing requires the same password.
 */
export async function exportProject(password?: string | null): Promise<Uint8Array> {
  const payload: ProjectPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    localStorage: collectLocalStorage(),
    indexedDB: await idbGetAll(),
  };

  const jsonBytes = utf8Encode(JSON.stringify(payload));

  let body: Uint8Array;
  let flags = 0;

  if (password) {
    flags |= FLAG_ENCRYPTED;
    body = await encryptPayload(jsonBytes, password);
  } else {
    body = jsonBytes;
  }

  const header = new Uint8Array([MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], FORMAT_VERSION, flags]);
  return concatBytes(header, body);
}

/**
 * Trigger a browser download of the exported project file.
 */
export async function downloadProjectFile(password?: string | null): Promise<void> {
  const bytes = await exportProject(password);
  const blob = new Blob([bytes as BufferSource], { type: PROJECT_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `mapviewer-project-${date}${PROJECT_FILE_EXTENSION}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------------
 * Import
 * --------------------------------------------------------------------------- */

export interface ParsedProjectHeader {
  version: number;
  encrypted: boolean;
}

/**
 * Parse just the header of a .mapviewer file to determine whether a password
 * is needed before attempting full decryption.
 */
export function parseProjectHeader(bytes: Uint8Array): ParsedProjectHeader {
  if (bytes.length < 6) {
    throw new ProjectImportError('File is too small to be a valid project file.');
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new ProjectImportError('Not a valid MapViewer project file (bad magic bytes).');
    }
  }
  const version = bytes[4];
  if (version !== FORMAT_VERSION) {
    throw new ProjectImportError(`Unsupported project file version (${version}). This app supports version ${FORMAT_VERSION}.`);
  }
  const flags = bytes[5];
  return { version, encrypted: (flags & FLAG_ENCRYPTED) !== 0 };
}

/**
 * Fully parse and decrypt (if needed) a .mapviewer binary into its payload.
 * @param bytes - The raw file bytes.
 * @param password - Required when the file is encrypted.
 */
export async function parseProjectFile(bytes: Uint8Array, password?: string): Promise<ProjectPayload> {
  const header = parseProjectHeader(bytes);
  const body = bytes.slice(6);

  let jsonBytes: Uint8Array;
  if (header.encrypted) {
    if (!password) {
      throw new ProjectPasswordError();
    }
    jsonBytes = await decryptPayload(body, password);
  } else {
    jsonBytes = body;
  }

  let payload: ProjectPayload;
  try {
    payload = JSON.parse(utf8Decode(jsonBytes));
  } catch {
    throw new ProjectImportError('Failed to parse the project payload (corrupted file?).');
  }

  if (!payload || payload.version !== 1 || typeof payload.localStorage !== 'object') {
    throw new ProjectImportError('Unrecognised project payload structure.');
  }

  return payload;
}

/**
 * Restore a parsed project payload into the running app:
 * - Overwrites all app localStorage keys
 * - Restores IndexedDB geometry blobs
 *
 * The caller is responsible for reloading the app afterwards (window.location.reload()).
 */
export async function restoreProject(payload: ProjectPayload): Promise<void> {
  // Clear existing app keys from localStorage
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === LOCKED_VAULT_KEY || !isAppStorageKey(key)) continue;
    doomed.push(key);
  }
  doomed.forEach((key) => localStorage.removeItem(key));

  // Write the imported keys
  for (const [key, value] of Object.entries(payload.localStorage)) {
    localStorage.setItem(key, value);
  }

  // Restore IndexedDB entries
  if (payload.indexedDB && Object.keys(payload.indexedDB).length > 0) {
    await idbPutMany(payload.indexedDB);
  }
}
