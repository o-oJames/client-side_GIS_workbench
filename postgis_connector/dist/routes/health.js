"use strict";
// ---------------------------------------------------------------------------
// routes/health.ts — GET /health
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = healthRouter;
const express_1 = require("express");
const VERSION = '1.0.0';
function healthRouter() {
    const router = (0, express_1.Router)();
    router.get('/health', (_req, res) => {
        res.json({ status: 'ok', version: VERSION });
    });
    return router;
}
//# sourceMappingURL=health.js.map