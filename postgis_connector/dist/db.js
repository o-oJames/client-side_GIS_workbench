"use strict";
// ---------------------------------------------------------------------------
// db.ts — Connection pool manager. One pg.Pool per registered connection,
// created lazily on first use and cleaned up when unregistered.
//
// Credentials come from the in-memory registry (populated by the browser
// on startup/reconnect). The connector never reads plaintext credentials
// from disk.
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = getPool;
exports.getPoolById = getPoolById;
exports.removePool = removePool;
exports.testConnection = testConnection;
exports.shutdownAll = shutdownAll;
const pg_1 = require("pg");
const storage_1 = require("./storage");
const pools = new Map();
function poolConfig(conn) {
    return {
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.username,
        password: conn.password,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    };
}
/** Get (or create) the pool for a given connection. */
function getPool(conn) {
    let pool = pools.get(conn.id);
    if (!pool) {
        pool = new pg_1.Pool(poolConfig(conn));
        pools.set(conn.id, pool);
    }
    return pool;
}
/** Get pool by connection ID (looks up credentials from registry). */
function getPoolById(connectionId) {
    const conn = (0, storage_1.getCredentials)(connectionId);
    if (!conn)
        return null;
    return getPool(conn);
}
/** Remove and end the pool for a connection. */
async function removePool(connId) {
    const pool = pools.get(connId);
    if (pool) {
        await pool.end();
        pools.delete(connId);
    }
}
/** Test a connection by issuing a simple query. */
async function testConnection(conn) {
    const pool = new pg_1.Pool(poolConfig(conn));
    try {
        const result = await pool.query('SELECT version() AS version');
        const version = result.rows[0]?.version ?? 'unknown';
        return { ok: true, version };
    }
    catch (err) {
        return { ok: false, error: err.message ?? String(err) };
    }
    finally {
        await pool.end();
    }
}
/** End all pools (for graceful shutdown). */
async function shutdownAll() {
    const promises = Array.from(pools.values()).map(p => p.end());
    pools.clear();
    await Promise.all(promises);
}
//# sourceMappingURL=db.js.map