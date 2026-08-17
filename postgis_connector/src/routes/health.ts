// ---------------------------------------------------------------------------
// routes/health.ts — GET /health
// ---------------------------------------------------------------------------

import { Router } from 'express';

const VERSION = '1.0.0';

export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  return router;
}
