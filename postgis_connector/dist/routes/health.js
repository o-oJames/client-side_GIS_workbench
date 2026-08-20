"use strict";
// ---------------------------------------------------------------------------
// routes/health.ts — GET /health
// Returns status, version, bootTime, and sessionKey for encrypted registration.
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = healthRouter;
const express_1 = require("express");
const storage_1 = require("../storage");
const VERSION = '2.0.0';
function healthRouter() {
    const router = (0, express_1.Router)();
    router.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            version: VERSION,
            bootTime: storage_1.BOOT_TIME,
            sessionKey: storage_1.SESSION_KEY
        });
    });
    return router;
}
//# sourceMappingURL=health.js.map