/**
 * App-lock vault: encrypts every persisted piece of app state (all
 * `mapviewer-*` localStorage keys: workspace registry, per-workspace
 * settings, saved views and known sources) behind a user-chosen password.
 *
 * While the app is locked the plaintext keys are removed from localStorage
 * and replaced by a single opaque vault blob under `mapviewer-locked-vault`.
 * Unlocking decrypts the vault and writes the original keys back verbatim.
 *
 * Cipher strategy
 * ---------------
 * - Primary: Web Crypto AES-256-GCM with a key derived via PBKDF2-SHA256
 *   (310,000 iterations). The GCM auth tag doubles as the password check:
 *   a wrong password fails decryption, so the password itself is never
 *   stored anywhere.
 * - Fallback: `crypto.subtle` only exists in secure contexts (https or
 *   localhost). If it is missing we fall back to a pure-JS SHA-256
 *   counter-mode stream cipher with a magic-header check. This is
 *   obfuscation rather than hardened crypto - it keeps casual inspection
 *   of localStorage useless, but its real purpose is to keep the lock
 *   feature functional (and testable) in environments without Web Crypto.
 */

export const APP_STORAGE_PREFIX = 'mapviewer';
export const LOCKED_VAULT_KEY = 'mapviewer-locked-vault';

/** Thrown when the supplied password cannot decrypt the vault. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

/* ---------------------------------------------------------------------------
 * Small byte helpers
 * --------------------------------------------------------------------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // stay well under the argument-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice: number[] = [];
    const end = Math.min(i + CHUNK, bytes.length);
    for (let j = i; j < end; j++) slice.push(bytes[j]);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const c: any = typeof crypto !== 'undefined' ? crypto : null;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
  } else {
    // Last resort for very old/test environments: salt quality only.
    for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function subtleCrypto(): SubtleCrypto | null {
  try {
    const c: any = typeof crypto !== 'undefined' ? crypto : null;
    return c && c.subtle ? (c.subtle as SubtleCrypto) : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Pure-JS SHA-256 (fallback cipher + known-answer tested)
 * --------------------------------------------------------------------------- */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  const u = x >>> 0;
  return ((u >>> n) | (u << (32 - n))) >>> 0;
}

/** FIPS 180-4 SHA-256 over an arbitrary byte array. */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const bitLenHigh = Math.floor((input.length * 8) / 0x100000000);
  const bitLenLow = (input.length * 8) >>> 0;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLenHigh, false);
  view.setUint32(padded.length - 4, bitLenLow, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array<number>(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ ((w[i - 15] >>> 0) >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ ((w[i - 2] >>> 0) >>> 10);
      w[i] = (((w[i - 16] >>> 0) + s0 + (w[i - 7] >>> 0) + s1) | 0) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = ((h >>> 0) + S1 + ch + SHA256_K[i] + (w[i] >>> 0)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = ((d >>> 0) + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) outView.setInt32(i * 4, hs[i], false);
  return out;
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes as any);
}

/* ---------------------------------------------------------------------------
 * Fallback stream cipher (used only when Web Crypto is unavailable)
 * --------------------------------------------------------------------------- */

// 16-byte magic header encrypted with the payload: a wrong password
// corrupts it, which is how we detect bad passwords without a stored hash.
const FALLBACK_MAGIC = utf8Encode('MAPVIEWERLOCKv1\u0000');

function fallbackPasswordHash(password: string): Uint8Array {
  return sha256Bytes(utf8Encode('mapviewer-lock:' + password));
}

function fallbackKeystream(passwordHash: Uint8Array, salt: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const blockInput = new Uint8Array(32 + salt.length + 4);
  blockInput.set(passwordHash, 0);
  blockInput.set(salt, 32);
  let counter = 0;
  let pos = 0;
  while (pos < length) {
    blockInput[32 + salt.length] = (counter >>> 24) & 0xff;
    blockInput[32 + salt.length + 1] = (counter >>> 16) & 0xff;
    blockInput[32 + salt.length + 2] = (counter >>> 8) & 0xff;
    blockInput[32 + salt.length + 3] = counter & 0xff;
    const block = sha256Bytes(blockInput);
    const take = Math.min(block.length, length - pos);
    for (let i = 0; i < take; i++) out[pos + i] = block[i];
    pos += take;
    counter++;
  }
  return out;
}

function xorBytes(data: Uint8Array, keystream: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ keystream[i];
  return out;
}

/* ---------------------------------------------------------------------------
 * Vault encrypt / decrypt
 * --------------------------------------------------------------------------- */

interface AesVault {
  v: 1;
  cipher: 'aes-256-gcm';
  salt: string; // base64, 16 bytes
  iv: string;   // base64, 12 bytes
  data: string; // base64 ciphertext (includes the GCM tag)
}

interface FallbackVault {
  v: 1;
  cipher: 'sha256-stream';
  salt: string; // base64, 16 bytes
  data: string; // base64 keystream-XORed (magic header + payload)
}

export type LockVault = AesVault | FallbackVault;

const PBKDF2_ITERATIONS = 310000;

async function deriveAesKey(subtle: SubtleCrypto, password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await subtle.importKey('raw', utf8Encode(password) as any, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as any, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a map of `localStorage` key/value pairs into a vault JSON string.
 * Uses AES-256-GCM when Web Crypto is available, the SHA-256 stream
 * fallback otherwise (see file header).
 */
export async function encryptAppData(entries: Record<string, string>, password: string): Promise<string> {
  const payload = utf8Encode(JSON.stringify(entries));
  const salt = randomBytes(16);
  const subtle = subtleCrypto();

  if (subtle) {
    const iv = randomBytes(12);
    const key = await deriveAesKey(subtle, password, salt);
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv as any }, key, payload as any);
    const vault: AesVault = {
      v: 1,
      cipher: 'aes-256-gcm',
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(ciphertext)),
    };
    return JSON.stringify(vault);
  }

  const keystream = fallbackKeystream(fallbackPasswordHash(password), salt, FALLBACK_MAGIC.length + payload.length);
  const plain = new Uint8Array(FALLBACK_MAGIC.length + payload.length);
  plain.set(FALLBACK_MAGIC, 0);
  plain.set(payload, FALLBACK_MAGIC.length);
  const vault: FallbackVault = {
    v: 1,
    cipher: 'sha256-stream',
    salt: bytesToBase64(salt),
    data: bytesToBase64(xorBytes(plain, keystream)),
  };
  return JSON.stringify(vault);
}

/**
 * Decrypt a vault JSON string back into the original key/value map.
 * Throws `WrongPasswordError` when the password does not match.
 */
export async function decryptAppData(vaultJson: string, password: string): Promise<Record<string, string>> {
  let vault: LockVault;
  try {
    vault = JSON.parse(vaultJson) as LockVault;
  } catch {
    throw new WrongPasswordError(); // unparseable vault = nothing to unlock
  }
  if (!vault || vault.v !== 1 || typeof vault.data !== 'string' || typeof vault.salt !== 'string') {
    throw new WrongPasswordError();
  }

  const salt = base64ToBytes(vault.salt);
  const data = base64ToBytes(vault.data);

  if (vault.cipher === 'aes-256-gcm') {
    const subtle = subtleCrypto();
    if (!subtle) {
      // Locked in a secure context, opened in a non-secure one: the
      // Web Crypto key material simply cannot be derived here.
      throw new Error('This vault needs a secure context (https or localhost) to unlock');
    }
    try {
      const key = await deriveAesKey(subtle, password, salt);
      const plainBuf = await subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes((vault as AesVault).iv) as any },
        key,
        data as any,
      );
      return JSON.parse(utf8Decode(new Uint8Array(plainBuf)));
    } catch (e) {
      if (e instanceof WrongPasswordError) throw e;
      throw new WrongPasswordError(); // GCM tag mismatch, bad base64, etc.
    }
  }

  if (vault.cipher === 'sha256-stream') {
    const keystream = fallbackKeystream(fallbackPasswordHash(password), salt, data.length);
    const plain = xorBytes(data, keystream);
    for (let i = 0; i < FALLBACK_MAGIC.length; i++) {
      if (plain[i] !== FALLBACK_MAGIC[i]) throw new WrongPasswordError();
    }
    try {
      return JSON.parse(utf8Decode(plain.subarray(FALLBACK_MAGIC.length)));
    } catch {
      throw new WrongPasswordError();
    }
  }

  throw new WrongPasswordError(); // unknown cipher
}

/* ---------------------------------------------------------------------------
 * localStorage plumbing
 * --------------------------------------------------------------------------- */

function isAppStorageKey(key: string): boolean {
  return (
    key === APP_STORAGE_PREFIX ||
    key.indexOf(APP_STORAGE_PREFIX + '-') === 0 ||
    key.indexOf(APP_STORAGE_PREFIX + ':') === 0
  );
}

/** True when a locked vault is present, i.e. the app should boot locked. */
export function hasLockedVault(): boolean {
  try {
    return localStorage.getItem(LOCKED_VAULT_KEY) !== null;
  } catch {
    return false;
  }
}

export function readVault(): string | null {
  try {
    return localStorage.getItem(LOCKED_VAULT_KEY);
  } catch {
    return null;
  }
}

export function writeVault(vaultJson: string): void {
  try {
    localStorage.setItem(LOCKED_VAULT_KEY, vaultJson);
  } catch (e) {
    console.error('[AppLock] Failed to write the locked vault:', e);
  }
}

export function removeVault(): void {
  try {
    localStorage.removeItem(LOCKED_VAULT_KEY);
  } catch (e) {
    console.error('[AppLock] Failed to remove the locked vault:', e);
  }
}

/** Snapshot every app-owned localStorage entry (the vault itself excluded). */
export function collectAppStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key === LOCKED_VAULT_KEY || !isAppStorageKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
  } catch (e) {
    console.error('[AppLock] Failed to collect app storage:', e);
  }
  return entries;
}

/** Write a previously collected snapshot back into localStorage. */
export function restoreAppStorage(entries: Record<string, string>): void {
  try {
    Object.keys(entries).forEach((key) => localStorage.setItem(key, entries[key]));
  } catch (e) {
    console.error('[AppLock] Failed to restore app storage:', e);
  }
}

/** Remove every app-owned localStorage entry. Pass `keepVault` to preserve
 * the encrypted vault itself (used when locking: the vault is written first,
 * then the plaintext keys are stripped around it). */
export function clearAppStorage(keepVault: boolean = false): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !isAppStorageKey(key)) continue;
      if (keepVault && key === LOCKED_VAULT_KEY) continue;
      doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch (e) {
    console.error('[AppLock] Failed to clear app storage:', e);
  }
}

/* ---------------------------------------------------------------------------
 * Password hash persistence
 *
 * A SHA-256 hash of the lock password is stored in localStorage so the app
 * remembers that a password was set across page refreshes. The hash is used
 * only to verify the password when re-locking after a refresh (the in-memory
 * password is lost on reload). It is NOT used to encrypt data — the vault
 * encryption always uses the full PBKDF2-derived key.
 * --------------------------------------------------------------------------- */

export const PASSWORD_HASH_KEY = 'mapviewer-lock-hash';

/** True when a password hash is stored, i.e. a password was previously set. */
export function hasPasswordHash(): boolean {
  try {
    return localStorage.getItem(PASSWORD_HASH_KEY) !== null;
  } catch {
    return false;
  }
}

/** Read the stored password hash (hex string) or null. */
export function readPasswordHash(): string | null {
  try {
    return localStorage.getItem(PASSWORD_HASH_KEY);
  } catch {
    return null;
  }
}

/** Compute and store the SHA-256 hash of the given password. */
export function writePasswordHash(password: string): void {
  const hash = sha256Bytes(utf8Encode('mapviewer-pw-verify:' + password));
  let hex = '';
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  try {
    localStorage.setItem(PASSWORD_HASH_KEY, hex);
  } catch (e) {
    console.error('[AppLock] Failed to write password hash:', e);
  }
}

/** Verify a password against the stored hash. Returns true if it matches. */
export function verifyPasswordHash(password: string): boolean {
  const stored = readPasswordHash();
  if (stored === null) return false;
  const hash = sha256Bytes(utf8Encode('mapviewer-pw-verify:' + password));
  let hex = '';
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return hex === stored;
}

/** Remove the stored password hash (used by "Start fresh"). */
export function removePasswordHash(): void {
  try {
    localStorage.removeItem(PASSWORD_HASH_KEY);
  } catch (e) {
    console.error('[AppLock] Failed to remove password hash:', e);
  }
}
