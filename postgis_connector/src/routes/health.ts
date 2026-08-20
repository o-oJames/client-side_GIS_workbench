// ---------------------------------------------------------------------------
// routes/health.ts — GET /health
// Returns status, version, bootTime, and sessionKey for encrypted registration.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { BOOT_TIME, SESSION_KEY } from '../storage';

const VERSION = '2.0.0';

export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ 
      status: 'ok', 
      version: VERSION, 
      bootTime: BOOT_TIME,
      sessionKey: SESSION_KEY
    });
  });

  return router;
}
