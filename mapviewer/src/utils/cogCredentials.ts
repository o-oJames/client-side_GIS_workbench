// ---------------------------------------------------------------------------
// utils/cogCredentials.ts — Encrypt/decrypt S3 COG credentials at rest.
//
// COG layer credentials (accessKeyId, secretAccessKey, sessionToken) are
// sensitive and must never be stored in plain text in localStorage. This
// module encrypts them with the same client key used by the PostGIS
// credential store (tier-1 random key or tier-2 PBKDF2 from app-lock
// password) and stores only the opaque ciphertext on the layer config.
//
// The encrypted blob format matches the PostGIS connector's format:
//   iv:authTag:ciphertext  (all hex)
//
// Lifecycle:
//   saveSettings()  → encryptCogCredentials() → strips plain-text fields
//   loadSettings()  → decryptCogCredentials() → restores plain-text fields
// ---------------------------------------------------------------------------

/** The three credential fields that must be encrypted at rest. */
const CREDENTIAL_FIELDS = ['cogAccessKeyId', 'cogSecretAccessKey', 'cogSessionToken'] as const;

/** Shape of the encrypted blob stored on a RasterLayer config. */
export interface EncryptedCogCredentials {
  /** iv:authTag:ciphertext (all hex) — same format as PostGIS blobs. */
  blob: string;
}

/** Extract the plain-text credential fields from a layer config. */
export function extractCogCredentials(layer: Record<string, any>): Record<string, string> | null {
  const creds: Record<string, string> = {};
  let hasAny = false;
  for (const field of CREDENTIAL_FIELDS) {
    const val = layer[field];
    if (typeof val === 'string' && val.trim()) {
      creds[field] = val;
      hasAny = true;
    }
  }
  return hasAny ? creds : null;
}

/** Strip plain-text credential fields from a layer config (returns a copy). */
export function stripCogCredentials(layer: Record<string, any>): Record<string, any> {
  const { cogAccessKeyId, cogSecretAccessKey, cogSessionToken, ...rest } = layer;
  return rest;
}

/**
 * Encrypt COG credentials with the given AES-GCM key.
 * Returns the iv:authTag:ciphertext hex string.
 */
export async function encryptCogCredentials(
  credentials: Record<string, string>,
  key: CryptoKey
): Promise<string> {
  const plaintext = JSON.stringify(credentials);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const ctArray = new Uint8Array(ciphertext);
  const authTag = ctArray.slice(ctArray.length - 16);
  const actualCiphertext = ctArray.slice(0, ctArray.length - 16);

  const toHex = (bytes: Uint8Array) =>
    Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${toHex(iv)}:${toHex(authTag)}:${toHex(actualCiphertext)}`;
}

/**
 * Decrypt COG credentials from the iv:authTag:ciphertext hex string.
 * Returns the plain-text credential fields, or null on failure.
 */
export async function decryptCogCredentials(
  blob: string,
  key: CryptoKey
): Promise<Record<string, string> | null> {
  try {
    const parts = blob.split(':');
    if (parts.length !== 3) return null;

    const fromHex = (hex: string) =>
      new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));

    const iv = fromHex(parts[0]);
    const authTag = fromHex(parts[1]);
    const ciphertext = fromHex(parts[2]);

    // Web Crypto expects ciphertext + authTag concatenated
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (err) {
    console.warn('[cogCredentials] Failed to decrypt COG credentials:', err);
    return null;
  }
}

/**
 * Check whether a layer config has an encrypted credential blob.
 */
export function hasEncryptedCogCredentials(layer: Record<string, any>): boolean {
  return typeof layer.cogCredentialsEncrypted === 'string' && layer.cogCredentialsEncrypted.length > 0;
}

/**
 * Check whether a layer config has plain-text credentials that need encrypting.
 */
export function hasPlainCogCredentials(layer: Record<string, any>): boolean {
  return CREDENTIAL_FIELDS.some(f => typeof layer[f] === 'string' && layer[f].trim());
}
