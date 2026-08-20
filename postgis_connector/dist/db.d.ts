import { Pool } from 'pg';
import { ConnectionCredentials } from './storage';
/** Get (or create) the pool for a given connection. */
export declare function getPool(conn: ConnectionCredentials): Pool;
/** Get pool by connection ID (looks up credentials from registry). */
export declare function getPoolById(connectionId: string): Pool | null;
/** Remove and end the pool for a connection. */
export declare function removePool(connId: string): Promise<void>;
/** Test a connection by issuing a simple query. */
export declare function testConnection(conn: ConnectionCredentials): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
}>;
/** End all pools (for graceful shutdown). */
export declare function shutdownAll(): Promise<void>;
//# sourceMappingURL=db.d.ts.map