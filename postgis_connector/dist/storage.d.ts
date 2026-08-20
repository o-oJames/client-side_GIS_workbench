/** Random 256-bit key generated on startup. Used to encrypt /register payloads. */
export declare const SESSION_KEY: string;
export interface ConnectionCredentials {
    id: string;
    name: string;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    createdAt: string;
}
/** Register credentials in memory (called by browser on startup/reconnect). */
export declare function registerCredentials(creds: ConnectionCredentials[]): void;
/** Get credentials from memory by connectionId. */
export declare function getCredentials(connectionId: string): ConnectionCredentials | undefined;
/** Remove credentials from memory. */
export declare function unregisterCredentials(connectionId: string): void;
/** Get all registered connection IDs. */
export declare function getRegisteredIds(): string[];
/** Clear all in-memory credentials. */
export declare function clearRegistry(): void;
/** Load encrypted blob for a client. Returns null if not found. */
export declare function loadEncryptedBlob(clientId: string): string | null;
/** Save encrypted blob for a client. */
export declare function saveEncryptedBlob(clientId: string, encryptedBlob: string): void;
/** Delete encrypted blob for a client. */
export declare function deleteEncryptedBlob(clientId: string): void;
/** Check if legacy connections file exists. */
export declare function hasLegacyConnections(): boolean;
/**
 * Load and decrypt legacy connections using the machine-derived key.
 * Returns plaintext connections for migration, then deletes the legacy file.
 */
export declare function migrateLegacyConnections(): ConnectionCredentials[];
export declare const BOOT_TIME: string;
export declare function __reset(): void;
//# sourceMappingURL=storage.d.ts.map