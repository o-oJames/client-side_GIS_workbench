// ---------------------------------------------------------------------------
// routes/health.ts — GET /health
// Returns status, version, bootTime, sessionKey, and capabilities.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { BOOT_TIME, SESSION_KEY } from '../storage';

const VERSION = '2.1.0';

/** Capabilities this build of the companion supports. */
const CAPABILITIES = ['postgis', 'cog-proxy'];

export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ 
      status: 'ok', 
      version: VERSION, 
      bootTime: BOOT_TIME,
      sessionKey: SESSION_KEY,
      capabilities: CAPABILITIES,
    });
  });

  return router;
}
