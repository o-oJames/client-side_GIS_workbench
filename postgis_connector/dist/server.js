"use strict";
// ---------------------------------------------------------------------------
// server.ts — Express HTTP server for the MapViewer PostGIS Connector.
// Listens on 127.0.0.1 only (localhost). Default port 40000, auto-increments
// up to 40019 if the port is already taken.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const express_1 = __importDefault(require("express"));
const net = __importStar(require("net"));
const health_1 = require("./routes/health");
const connections_1 = require("./routes/connections");
const tables_1 = require("./routes/tables");
const query_1 = require("./routes/query");
const tiles_1 = require("./routes/tiles");
const db_1 = require("./db");
const DEFAULT_PORT = 40000;
const MAX_ATTEMPTS = 20; // try ports 40000..40019
/** Check if a TCP port is free on 127.0.0.1. */
function isPortFree(port) {
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
async function findAvailablePort() {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const port = DEFAULT_PORT + i;
        if (await isPortFree(port))
            return port;
    }
    throw new Error(`No free port in range ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_ATTEMPTS - 1}`);
}
async function startServer() {
    const app = (0, express_1.default)();
    // --- Middleware ----------------------------------------------------------
    app.use(express_1.default.json());
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
    app.use((0, health_1.healthRouter)());
    app.use((0, connections_1.connectionsRouter)());
    app.use((0, tables_1.tablesRouter)());
    app.use((0, query_1.queryRouter)());
    app.use((0, tiles_1.tilesRouter)());
    // --- Start ---------------------------------------------------------------
    const port = await findAvailablePort();
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => {
            console.log(`✓ MapViewer PostGIS Connector running on http://localhost:${port}`);
            console.log(`  Press Ctrl+C to stop`);
            resolve(port);
        });
        server.on('error', reject);
        // Graceful shutdown
        const shutdown = async () => {
            console.log('\nShutting down...');
            server.close();
            await (0, db_1.shutdownAll)();
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
//# sourceMappingURL=server.js.map