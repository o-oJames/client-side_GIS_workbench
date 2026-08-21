// ---------------------------------------------------------------------------
// routes/connections.ts — Storage, registration, migration, and CRUD
//
//   GET    /storage?clientId=xxx    — load encrypted blob for this client
//   POST   /storage                 — save encrypted blob { clientId, encryptedBlob }
//   DELETE /storage?clientId=xxx    — delete encrypted blob for this client
//   POST   /register                — register credentials (encrypted with session key)
//   GET    /registered              — list registered connection IDs (metadata only)
//   GET    /migrate                 — one-time legacy migration (returns plaintext)
//   POST   /connections/:id/test    — test connectivity (uses in-memory creds)
//   DELETE /connections/:id         — unregister a connection
// ---------------------------------------------------------------------------

import { Router } from 'express';
import * as crypto from 'crypto';
import {
  ConnectionCredentials,
  loadEncryptedBlob,
  saveEncryptedBlob,
  deleteEncryptedBlob,
  registerCredentials,
  getCredentials,
  unregisterCredentials,
  getRegisteredIds,
  hasLegacyConnections,
  migrateLegacyConnections,
  SESSION_KEY,
} from '../storage';
import { testConnection, removePool } from '../db';

/**
 * Decrypt registration payload using the session key.
 * Format: iv:authTag:ciphertext (all hex), same as the connector's legacy format.
 */
function decryptRegistrationPayload(encryptedPayload: string): ConnectionCredentials[] {
  const [ivHex, authTagHex, ciphertext] = encryptedPayload.split(':');
  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted payload format');
  }
  const key = Buffer.from(SESSION_KEY, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

export function connectionsRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Encrypted blob storage (per client)
  // -------------------------------------------------------------------------

  // Load encrypted blob for a client
  router.get('/storage', (req, res) => {
    const clientId = String(req.query.clientId || '');
    if (!clientId) {
      res.status(400).json({ error: 'Missing clientId parameter' });
      return;
    }
    const blob = loadEncryptedBlob(clientId);
    res.json({ clientId, encryptedBlob: blob });
  });

  // Save encrypted blob for a client
  router.post('/storage', (req, res) => {
    const { clientId, encryptedBlob } = req.body;
    if (!clientId || !encryptedBlob) {
      res.status(400).json({ error: 'Missing required fields: clientId, encryptedBlob' });
      return;
    }
    saveEncryptedBlob(String(clientId), String(encryptedBlob));
    res.json({ ok: true });
  });

  // Delete encrypted blob for a client
  router.delete('/storage', (req, res) => {
    const clientId = String(req.query.clientId || '');
    if (!clientId) {
      res.status(400).json({ error: 'Missing clientId parameter' });
      return;
    }
    deleteEncryptedBlob(clientId);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // In-memory credential registration (encrypted payload)
  // -------------------------------------------------------------------------

  // Register credentials in memory (browser sends encrypted payload)
  router.post('/register', (req, res) => {
    const { encryptedPayload } = req.body;
    if (!encryptedPayload) {
      res.status(400).json({ error: 'Missing required field: encryptedPayload' });
      return;
    }

    let connections: ConnectionCredentials[];
    try {
      connections = decryptRegistrationPayload(String(encryptedPayload));
    } catch (err) {
      console.error('[connections] Failed to decrypt registration payload:', err);
      res.status(400).json({ error: 'Failed to decrypt registration payload. The connector may have restarted — please reload the app.' });
      return;
    }

    const valid: ConnectionCredentials[] = [];
    for (const c of connections) {
      if (!c.id || !c.host || !c.database || !c.username || !c.password) {
        continue; // skip invalid entries
      }
      valid.push({
        id: String(c.id),
        name: String(c.name || ''),
        host: String(c.host),
        port: Number(c.port) || 5432,
        database: String(c.database),
        username: String(c.username),
        password: String(c.password),
        createdAt: String(c.createdAt || new Date().toISOString()),
      });
    }

    registerCredentials(valid);
    res.json({ ok: true, registered: valid.length });
  });

  // List registered connection IDs (metadata only, no credentials)
  router.get('/registered', (_req, res) => {
    const ids = getRegisteredIds();
    res.json({ connectionIds: ids });
  });

  // -------------------------------------------------------------------------
  // Legacy migration
  // -------------------------------------------------------------------------

  // One-time migration: returns legacy connections in plaintext, then deletes
  // the legacy file. The browser re-encrypts with its own key and saves via
  // POST /storage.
  router.get('/migrate', (_req, res) => {
    if (!hasLegacyConnections()) {
      res.json({ connections: [], migrated: false });
      return;
    }
    const connections = migrateLegacyConnections();
    // Return without passwords masked — browser needs them for re-encryption
    res.json({ connections, migrated: true });
  });

  // -------------------------------------------------------------------------
  // Connection test & delete (uses in-memory credentials)
  // -------------------------------------------------------------------------

  // Test a connection
  router.post('/connections/:id/test', async (req, res) => {
    const conn = getCredentials(req.params.id);
    if (!conn) {
      res.status(404).json({ error: 'Connection not found (not registered). The connector may have restarted — please reload the app.' });
      return;
    }
    const result = await testConnection(conn);
    if (result.ok) {
      res.json({ ok: true, version: result.version });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  });

  // Delete/unregister a connection
  router.delete('/connections/:id', async (req, res) => {
    unregisterCredentials(req.params.id);
    await removePool(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
