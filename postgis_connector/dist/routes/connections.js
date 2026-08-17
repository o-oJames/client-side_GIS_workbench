"use strict";
// ---------------------------------------------------------------------------
// routes/connections.ts — CRUD for saved database connections
//   GET    /connections          — list saved connections (passwords masked)
//   POST   /connections          — save a new connection
//   DELETE /connections/:id      — remove a connection
//   POST   /connections/:id/test — test connectivity
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionsRouter = connectionsRouter;
const express_1 = require("express");
const uuid_1 = require("uuid");
const storage_1 = require("../storage");
const db_1 = require("../db");
/** Return connection objects with the password field masked. */
function maskConnections(conns) {
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
function connectionsRouter() {
    const router = (0, express_1.Router)();
    // List all saved connections (passwords masked)
    router.get('/connections', (_req, res) => {
        const conns = (0, storage_1.loadConnections)();
        res.json(maskConnections(conns));
    });
    // Save a new connection
    router.post('/connections', (req, res) => {
        const { name, host, port, database, username, password } = req.body;
        if (!name || !host || !database || !username || !password) {
            res.status(400).json({ error: 'Missing required fields: name, host, database, username, password' });
            return;
        }
        const conns = (0, storage_1.loadConnections)();
        const newConn = {
            id: (0, uuid_1.v4)(),
            name: String(name),
            host: String(host),
            port: Number(port) || 5432,
            database: String(database),
            username: String(username),
            password: String(password),
            createdAt: new Date().toISOString(),
        };
        conns.push(newConn);
        (0, storage_1.saveConnections)(conns);
        // Return without password
        const { password: _pw, ...safe } = newConn;
        res.status(201).json(safe);
    });
    // Delete a connection
    router.delete('/connections/:id', async (req, res) => {
        const conns = (0, storage_1.loadConnections)();
        const idx = conns.findIndex(c => c.id === req.params.id);
        if (idx === -1) {
            res.status(404).json({ error: 'Connection not found' });
            return;
        }
        conns.splice(idx, 1);
        (0, storage_1.saveConnections)(conns);
        await (0, db_1.removePool)(req.params.id);
        res.json({ ok: true });
    });
    // Test a connection
    router.post('/connections/:id/test', async (req, res) => {
        const conns = (0, storage_1.loadConnections)();
        const conn = conns.find(c => c.id === req.params.id);
        if (!conn) {
            res.status(404).json({ error: 'Connection not found' });
            return;
        }
        const result = await (0, db_1.testConnection)(conn);
        if (result.ok) {
            res.json({ ok: true, version: result.version });
        }
        else {
            res.status(400).json({ ok: false, error: result.error });
        }
    });
    return router;
}
//# sourceMappingURL=connections.js.map