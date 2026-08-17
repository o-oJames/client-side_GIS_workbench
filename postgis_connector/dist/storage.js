"use strict";
// ---------------------------------------------------------------------------
// storage.ts — Persist saved connections to ~/.mapviewer/connections.json
// Credentials are encrypted at rest using a machine-derived key (AES-256-GCM).
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
exports.loadConnections = loadConnections;
exports.saveConnections = saveConnections;
exports.__reset = __reset;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const CONFIG_DIR = path.join(os.homedir(), '.mapviewer');
const CONNECTIONS_FILE = path.join(CONFIG_DIR, 'connections.json');
/**
 * Derive a 256-bit encryption key from machine-specific identifiers.
 * Uses a fixed salt so the same machine always produces the same key.
 * This is not intended to resist a determined attacker with root access —
 * it prevents casual reading of the connections file by other users/apps.
 */
function deriveMachineKey() {
    const machineId = [
        os.hostname(),
        os.userInfo().username,
        os.platform(),
        os.arch(),
        os.cpus()[0]?.model ?? 'unknown-cpu',
    ].join('|');
    // PBKDF2 with a fixed salt — deterministic per machine
    return crypto.pbkdf2Sync(machineId, 'mapviewer-connector-v1', 100000, 32, 'sha256');
}
function encrypt(plaintext) {
    const key = deriveMachineKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    // Format: iv:authTag:ciphertext (all hex)
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}
function decrypt(payload) {
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
function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}
function loadConnections() {
    ensureConfigDir();
    if (!fs.existsSync(CONNECTIONS_FILE)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(CONNECTIONS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        // Support both encrypted (string) and legacy plain-text formats
        if (typeof parsed === 'string') {
            const decrypted = decrypt(parsed);
            return JSON.parse(decrypted);
        }
        // Legacy plain-text format — return as-is (will be encrypted on next save)
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [];
    }
    catch (err) {
        console.error('[storage] Failed to load connections:', err);
        return [];
    }
}
function saveConnections(connections) {
    ensureConfigDir();
    const plaintext = JSON.stringify(connections, null, 2);
    const encrypted = encrypt(plaintext);
    fs.writeFileSync(CONNECTIONS_FILE, encrypted, { mode: 0o600 });
}
// For testing: reset in-memory state
function __reset() {
    // No-op for file-based storage; tests mock this module entirely
}
//# sourceMappingURL=storage.js.map