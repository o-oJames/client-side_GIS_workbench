"use strict";
// ---------------------------------------------------------------------------
// storage.ts — Encrypted blob store per client + in-memory credential registry.
//
// Security model:
// - Encrypted blobs stored on disk (browser encrypts with db_encrypt key)
// - Session key generated on startup for encrypting registration payloads
// - Credentials held in memory only (lost on restart)
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
exports.BOOT_TIME = exports.SESSION_KEY = void 0;
exports.registerCredentials = registerCredentials;
exports.getCredentials = getCredentials;
exports.unregisterCredentials = unregisterCredentials;
exports.getRegisteredIds = getRegisteredIds;
exports.clearRegistry = clearRegistry;
exports.loadEncryptedBlob = loadEncryptedBlob;
exports.saveEncryptedBlob = saveEncryptedBlob;
exports.deleteEncryptedBlob = deleteEncryptedBlob;
exports.hasLegacyConnections = hasLegacyConnections;
exports.migrateLegacyConnections = migrateLegacyConnections;
exports.__reset = __reset;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const CONFIG_DIR = path.join(os.homedir(), '.mapviewer');
const CLIENTS_DIR = path.join(CONFIG_DIR, 'clients');
const LEGACY_CONNECTIONS_FILE = path.join(CONFIG_DIR, 'connections.json');
// ---------------------------------------------------------------------------
// Session key (for encrypting registration payloads)
// ---------------------------------------------------------------------------
/** Random 256-bit key generated on startup. Used to encrypt /register payloads. */
exports.SESSION_KEY = crypto.randomBytes(32).toString('hex');
/** In-memory map of connectionId → credentials. Lost on restart. */
const credentialRegistry = new Map();
/** Register credentials in memory (called by browser on startup/reconnect). */
function registerCredentials(creds) {
    for (const c of creds) {
        credentialRegistry.set(c.id, c);
    }
}
/** Get credentials from memory by connectionId. */
function getCredentials(connectionId) {
    return credentialRegistry.get(connectionId);
}
/** Remove credentials from memory. */
function unregisterCredentials(connectionId) {
    credentialRegistry.delete(connectionId);
}
/** Get all registered connection IDs. */
function getRegisteredIds() {
    return Array.from(credentialRegistry.keys());
}
/** Clear all in-memory credentials. */
function clearRegistry() {
    credentialRegistry.clear();
}
// ---------------------------------------------------------------------------
// Encrypted blob storage (per client)
// ---------------------------------------------------------------------------
function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(CLIENTS_DIR)) {
        fs.mkdirSync(CLIENTS_DIR, { recursive: true, mode: 0o700 });
    }
}
function clientFile(clientId) {
    // Sanitize clientId to prevent path traversal
    const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(CLIENTS_DIR, `${safe}.json`);
}
/** Load encrypted blob for a client. Returns null if not found. */
function loadEncryptedBlob(clientId) {
    ensureConfigDir();
    const file = clientFile(clientId);
    if (!fs.existsSync(file)) {
        return null;
    }
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        console.error('[storage] Failed to read client blob:', err);
        return null;
    }
}
/** Save encrypted blob for a client. */
function saveEncryptedBlob(clientId, encryptedBlob) {
    ensureConfigDir();
    const file = clientFile(clientId);
    fs.writeFileSync(file, encryptedBlob, { mode: 0o600 });
}
/** Delete encrypted blob for a client. */
function deleteEncryptedBlob(clientId) {
    const file = clientFile(clientId);
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
    }
}
// ---------------------------------------------------------------------------
// Legacy migration support
// ---------------------------------------------------------------------------
/** Check if legacy connections file exists. */
function hasLegacyConnections() {
    return fs.existsSync(LEGACY_CONNECTIONS_FILE);
}
/**
 * Load and decrypt legacy connections using the machine-derived key.
 * Returns plaintext connections for migration, then deletes the legacy file.
 */
function migrateLegacyConnections() {
    if (!fs.existsSync(LEGACY_CONNECTIONS_FILE)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(LEGACY_CONNECTIONS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        let connections;
        if (typeof parsed === 'string') {
            // Encrypted with machine key — decrypt
            const decrypted = decryptWithMachineKey(parsed);
            connections = JSON.parse(decrypted);
        }
        else if (Array.isArray(parsed)) {
            // Legacy plain-text format
            connections = parsed;
        }
        else {
            connections = [];
        }
        // Delete legacy file after successful migration
        fs.unlinkSync(LEGACY_CONNECTIONS_FILE);
        console.log(`[storage] Migrated ${connections.length} legacy connections`);
        return connections;
    }
    catch (err) {
        console.error('[storage] Failed to migrate legacy connections:', err);
        // Delete corrupted legacy file
        try {
            fs.unlinkSync(LEGACY_CONNECTIONS_FILE);
        }
        catch { }
        return [];
    }
}
// ---------------------------------------------------------------------------
// Machine key (for legacy decryption only)
// ---------------------------------------------------------------------------
/**
 * Derive a 256-bit encryption key from machine-specific identifiers.
 * Used ONLY for decrypting legacy connections during migration.
 */
function deriveMachineKey() {
    const machineId = [
        os.hostname(),
        os.userInfo().username,
        os.platform(),
        os.arch(),
        os.cpus()[0]?.model ?? 'unknown-cpu',
    ].join('|');
    return crypto.pbkdf2Sync(machineId, 'mapviewer-connector-v1', 100000, 32, 'sha256');
}
function decryptWithMachineKey(payload) {
    const key = deriveMachineKey();
    const [ivHex, authTagHex, ciphertext] = payload.split(':');
    if (!ivHex || !authTagHex || !ciphertext) {
        throw new Error('Invalid encrypted payload format');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
// ---------------------------------------------------------------------------
// Boot timestamp (for restart detection)
// ---------------------------------------------------------------------------
exports.BOOT_TIME = new Date().toISOString();
// ---------------------------------------------------------------------------
// For testing
// ---------------------------------------------------------------------------
function __reset() {
    clearRegistry();
}
//# sourceMappingURL=storage.js.map