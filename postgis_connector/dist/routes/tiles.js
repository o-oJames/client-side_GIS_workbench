"use strict";
// ---------------------------------------------------------------------------
// routes/tiles.ts — GET /connections/:id/tiles/:z/:x/:y
// Returns MVT (Mapbox Vector Tile) via ST_AsMVT for a given table.
//
// Uses in-memory credentials (registered by the browser).
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.tilesRouter = tilesRouter;
const express_1 = require("express");
const storage_1 = require("../storage");
const db_1 = require("../db");
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
function tilesRouter() {
    const router = (0, express_1.Router)();
    router.get('/connections/:id/tiles/:z/:x/:y', async (req, res) => {
        const conn = (0, storage_1.getCredentials)(req.params.id);
        if (!conn) {
            res.status(404).json({ error: 'Connection not found (not registered). The connector may have restarted — please reload the app.' });
            return;
        }
        const z = parseInt(req.params.z, 10);
        const x = parseInt(req.params.x, 10);
        const y = parseInt(req.params.y, 10);
        const table = String(req.query.table || '');
        const geomColumn = String(req.query.geomColumn || 'geom');
        if (!table || !IDENT_RE.test(table)) {
            res.status(400).json({ error: 'Invalid or missing table parameter' });
            return;
        }
        if (!IDENT_RE.test(geomColumn)) {
            res.status(400).json({ error: 'Invalid geometry column name' });
            return;
        }
        if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || x < 0 || y < 0) {
            res.status(400).json({ error: 'Invalid tile coordinates' });
            return;
        }
        try {
            const pool = (0, db_1.getPool)(conn);
            const sql = `
        SELECT ST_AsMVT(q, $1, 4096, 'geom') AS mvt
        FROM (
          SELECT *,
            ST_AsMVTGeom(
              ST_Transform(${quoteIdent(geomColumn)}, 3857),
              ST_TileEnvelope($2, $3, $4),
              4096, 256, true
            ) AS geom
          FROM ${quoteIdent(table)}
          WHERE ST_Intersects(
            ST_Transform(${quoteIdent(geomColumn)}, 3857),
            ST_TileEnvelope($2, $3, $4)
          )
        ) AS q
      `;
            const result = await pool.query(sql, [table, z, x, y]);
            const mvtBuffer = result.rows[0]?.mvt;
            if (!mvtBuffer || mvtBuffer.length === 0) {
                res.status(204).end();
                return;
            }
            res.set('Content-Type', 'application/vnd.mapbox-vector-tile');
            res.set('Access-Control-Allow-Origin', '*');
            res.send(Buffer.from(mvtBuffer));
        }
        catch (err) {
            console.error('[tiles] Error generating tile:', err);
            res.status(500).json({ error: err.message ?? String(err) });
        }
    });
    return router;
}
function quoteIdent(name) {
    if (name.includes('.')) {
        return name.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
    }
    return `"${name.replace(/"/g, '""')}"`;
}
//# sourceMappingURL=tiles.js.map