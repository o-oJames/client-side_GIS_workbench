// ---------------------------------------------------------------------------
// routes/connections.ts — CRUD for saved database connections
//   GET    /connections          — list saved connections (passwords masked)
//   POST   /connections          — save a new connection
//   DELETE /connections/:id      — remove a connection
//   POST   /connections/:id/test — test connectivity
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SavedConnection, loadConnections, saveConnections } from '../storage';
import { testConnection, removePool } from '../db';

/** Return connection objects with the password field masked. */
function maskConnections(conns: SavedConnection[]) {
  return conns.map(c => ({
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    database: c.database,
    username: c.username,
    createdAt: c.createdAt,
    // password intentionally omitted
  }));
}

export function connectionsRouter(): Router {
  const router = Router();

  // List all saved connections (passwords masked)
  router.get('/connections', (_req, res) => {
    const conns = loadConnections();
    res.json(maskConnections(conns));
  });

  // Save a new connection
  router.post('/connections', (req, res) => {
    const { name, host, port, database, username, password } = req.body;

    if (!name || !host || !database || !username || !password) {
      res.status(400).json({ error: 'Missing required fields: name, host, database, username, password' });
      return;
    }

    const conns = loadConnections();
    const newConn: SavedConnection = {
      id: uuidv4(),
      name: String(name),
      host: String(host),
      port: Number(port) || 5432,
      database: String(database),
      username: String(username),
      password: String(password),
      createdAt: new Date().toISOString(),
    };
    conns.push(newConn);
    saveConnections(conns);

    // Return without password
    const { password: _pw, ...safe } = newConn;
    res.status(201).json(safe);
  });

  // Delete a connection
  router.delete('/connections/:id', async (req, res) => {
    const conns = loadConnections();
    const idx = conns.findIndex(c => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    conns.splice(idx, 1);
    saveConnections(conns);
    await removePool(req.params.id);
    res.json({ ok: true });
  });

  // Test a connection
  router.post('/connections/:id/test', async (req, res) => {
    const conns = loadConnections();
    const conn = conns.find(c => c.id === req.params.id);
    if (!conn) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    const result = await testConnection(conn);
    if (result.ok) {
      res.json({ ok: true, version: result.version });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  });

  return router;
}
