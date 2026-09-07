// ---------------------------------------------------------------------------
// routes/cogCredentials.ts — Encrypted COG credential storage per client.
//
//   GET    /cog/credentials?clientId=xxx   — load encrypted COG credentials
//   POST   /cog/credentials                — save encrypted COG credentials
//   DELETE /cog/credentials?clientId=xxx   — delete encrypted COG credentials
//
// The browser encrypts S3 credentials with its client key (same two-tier
// model as PostGIS connections) and stores the opaque blob here. The
// companion never sees plaintext credentials — it only stores and returns
// the encrypted blob.
//
// Storage layout: ~/.mapviewer/clients/{clientId}/cog-credentials.json
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.mapviewer');
const CLIENTS_DIR = path.join(CONFIG_DIR, 'clients');

function ensureClientDir(clientId: string): string {
  const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(CLIENTS_DIR, safe);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function credentialsFile(clientId: string): string {
  return path.join(ensureClientDir(clientId), 'cog-credentials.json');
}

export function cogCredentialsRouter(): Router {
  const router = Router();

  // Load encrypted COG credentials for a client
  router.get('/cog/credentials', (req: Request, res: Response) => {
    const clientId = String(req.query.clientId || '');
    if (!clientId) {
      res.status(400).json({ error: 'Missing clientId parameter' });
      return;
    }
    const file = credentialsFile(clientId);
    if (!fs.existsSync(file)) {
      res.json({ clientId, credentials: null });
      return;
    }
    try {
      const data = fs.readFileSync(file, 'utf8');
      res.json({ clientId, credentials: JSON.parse(data) });
    } catch (err) {
      console.error('[cogCredentials] Failed to read:', err);
      res.json({ clientId, credentials: null });
    }
  });

  // Save encrypted COG credentials for a client
  // Body: { clientId, credentials: { [layerId]: encryptedBlob } }
  router.post('/cog/credentials', (req: Request, res: Response) => {
    const { clientId, credentials } = req.body;
    if (!clientId || !credentials) {
      res.status(400).json({ error: 'Missing required fields: clientId, credentials' });
      return;
    }
    try {
      const file = credentialsFile(String(clientId));
      fs.writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
      res.json({ ok: true });
    } catch (err) {
      console.error('[cogCredentials] Failed to save:', err);
      res.status(500).json({ error: 'Failed to save credentials' });
    }
  });

  // Delete encrypted COG credentials for a client
  router.delete('/cog/credentials', (req: Request, res: Response) => {
    const clientId = String(req.query.clientId || '');
    if (!clientId) {
      res.status(400).json({ error: 'Missing clientId parameter' });
      return;
    }
    const file = credentialsFile(clientId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    res.json({ ok: true });
  });

  return router;
}
