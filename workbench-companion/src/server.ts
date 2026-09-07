// ---------------------------------------------------------------------------
// server.ts — Express HTTP server for the MapViewer Workbench Companion.
// Listens on 127.0.0.1 only (localhost). Default port 40000, auto-increments
// up to 40019 if the port is already taken.
// ---------------------------------------------------------------------------

import express from 'express';
import * as net from 'net';
import { healthRouter } from './routes/health';
import { connectionsRouter } from './routes/connections';
import { tablesRouter } from './routes/tables';
import { queryRouter } from './routes/query';
import { tilesRouter } from './routes/tiles';
import { cogRouter } from './routes/cog';
import { cogCredentialsRouter } from './routes/cogCredentials';
import { shutdownAll } from './db';

const DEFAULT_PORT = 40000;
const MAX_ATTEMPTS = 20; // try ports 40000..40019

/** Check if a TCP port is free on 127.0.0.1. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Find the first available port in the range [DEFAULT_PORT, DEFAULT_PORT + MAX_ATTEMPTS). */
async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = DEFAULT_PORT + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_ATTEMPTS - 1}`);
}

export async function startServer(): Promise<number> {
  const app = express();

  // --- Middleware ----------------------------------------------------------
  app.use(express.json());

  // CORS — allow all origins (localhost only in practice since we bind 127.0.0.1)
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // --- Routes --------------------------------------------------------------
  app.use(healthRouter());
  app.use(connectionsRouter());
  app.use(tablesRouter());
  app.use(queryRouter());
  app.use(tilesRouter());
  app.use(cogRouter());
  app.use(cogCredentialsRouter());

  // --- Start ---------------------------------------------------------------
  const port = await findAvailablePort();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`✓ MapViewer Workbench Companion running on http://localhost:${port}`);
      console.log(`  Press Ctrl+C to stop`);
      resolve(port);
    });
    server.on('error', reject);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      await shutdownAll();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// Run when executed directly
if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
