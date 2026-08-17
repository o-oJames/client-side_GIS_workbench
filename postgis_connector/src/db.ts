// ---------------------------------------------------------------------------
// db.ts — Connection pool manager. One pg.Pool per saved connection, created
// lazily on first use and cleaned up when the connection is deleted.
// ---------------------------------------------------------------------------

import { Pool, PoolConfig } from 'pg';
import { SavedConnection } from './storage';

const pools = new Map<string, Pool>();

function poolConfig(conn: SavedConnection): PoolConfig {
  return {
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/** Get (or create) the pool for a given connection. */
export function getPool(conn: SavedConnection): Pool {
  let pool = pools.get(conn.id);
  if (!pool) {
    pool = new Pool(poolConfig(conn));
    pools.set(conn.id, pool);
  }
  return pool;
}

/** Remove and end the pool for a connection. */
export async function removePool(connId: string): Promise<void> {
  const pool = pools.get(connId);
  if (pool) {
    await pool.end();
    pools.delete(connId);
  }
}

/** Test a connection by issuing a simple query. */
export async function testConnection(conn: SavedConnection): Promise<{ ok: boolean; error?: string; version?: string }> {
  const pool = new Pool(poolConfig(conn));
  try {
    const result = await pool.query('SELECT version() AS version');
    const version = result.rows[0]?.version ?? 'unknown';
    return { ok: true, version };
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) };
  } finally {
    await pool.end();
  }
}

/** End all pools (for graceful shutdown). */
export async function shutdownAll(): Promise<void> {
  const promises = Array.from(pools.values()).map(p => p.end());
  pools.clear();
  await Promise.all(promises);
}
