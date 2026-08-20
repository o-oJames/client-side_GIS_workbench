"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionsRouter = connectionsRouter;
const express_1 = require("express");
const crypto = __importStar(require("crypto"));
const storage_1 = require("../storage");
const db_1 = require("../db");
/**
 * Decrypt registration payload using the session key.
 * Format: iv:authTag:ciphertext (all hex), same as the connector's legacy format.
 */
function decryptRegistrationPayload(encryptedPayload) {
    const [ivHex, authTagHex, ciphertext] = encryptedPayload.split(':');
    if (!ivHex || !authTagHex || !ciphertext) {
        throw new Error('Invalid encrypted payload format');
    }
    const key = Buffer.from(storage_1.SESSION_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}
function connectionsRouter() {
    const router = (0, express_1.Router)();
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
        const blob = (0, storage_1.loadEncryptedBlob)(clientId);
        res.json({ clientId, encryptedBlob: blob });
    });
    // Save encrypted blob for a client
    router.post('/storage', (req, res) => {
        const { clientId, encryptedBlob } = req.body;
        if (!clientId || !encryptedBlob) {
            res.status(400).json({ error: 'Missing required fields: clientId, encryptedBlob' });
            return;
        }
        (0, storage_1.saveEncryptedBlob)(String(clientId), String(encryptedBlob));
        res.json({ ok: true });
    });
    // Delete encrypted blob for a client
    router.delete('/storage', (req, res) => {
        const clientId = String(req.query.clientId || '');
        if (!clientId) {
            res.status(400).json({ error: 'Missing clientId parameter' });
            return;
        }
        (0, storage_1.deleteEncryptedBlob)(clientId);
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
        let connections;
        try {
            connections = decryptRegistrationPayload(String(encryptedPayload));
        }
        catch (err) {
            console.error('[connections] Failed to decrypt registration payload:', err);
            res.status(400).json({ error: 'Failed to decrypt registration payload. The connector may have restarted — please reload the app.' });
            return;
        }
        const valid = [];
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
        (0, storage_1.registerCredentials)(valid);
        res.json({ ok: true, registered: valid.length });
    });
    // List registered connection IDs (metadata only, no credentials)
    router.get('/registered', (_req, res) => {
        const ids = (0, storage_1.getRegisteredIds)();
        res.json({ connectionIds: ids });
    });
    // -------------------------------------------------------------------------
    // Legacy migration
    // -------------------------------------------------------------------------
    // One-time migration: returns legacy connections in plaintext, then deletes
    // the legacy file. The browser re-encrypts with its own key and saves via
    // POST /storage.
    router.get('/migrate', (_req, res) => {
        if (!(0, storage_1.hasLegacyConnections)()) {
            res.json({ connections: [], migrated: false });
            return;
        }
        const connections = (0, storage_1.migrateLegacyConnections)();
        // Return without passwords masked — browser needs them for re-encryption
        res.json({ connections, migrated: true });
    });
    // -------------------------------------------------------------------------
    // Connection test & delete (uses in-memory credentials)
    // -------------------------------------------------------------------------
    // Test a connection
    router.post('/connections/:id/test', async (req, res) => {
        const conn = (0, storage_1.getCredentials)(req.params.id);
        if (!conn) {
            res.status(404).json({ error: 'Connection not found (not registered). The connector may have restarted — please reload the app.' });
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
    // Delete/unregister a connection
    router.delete('/connections/:id', async (req, res) => {
        (0, storage_1.unregisterCredentials)(req.params.id);
        await (0, db_1.removePool)(req.params.id);
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=connections.js.map