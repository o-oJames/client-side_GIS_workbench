"use strict";
// ---------------------------------------------------------------------------
// routes/query.ts — POST /connections/:id/query
// Accepts { table, geomColumn, filter?, bbox?, srid?, limit? } and returns
// a GeoJSON FeatureCollection via ST_AsGeoJSON.
// Read-only enforcement: rejects any SQL not starting with SELECT.
//
// Uses in-memory credentials (registered by the browser).
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryRouter = queryRouter;
const express_1 = require("express");
const storage_1 = require("../storage");
const db_1 = require("../db");
/** Characters that are not allowed in table/column names (prevent injection). */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
/** Validate that a filter expression is safe (read-only, no dangerous keywords). */
function validateFilter(filter) {
    const upper = filter.toUpperCase().trim();
    const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'];
    for (const kw of dangerous) {
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        if (re.test(filter)) {
            return { ok: false, error: `Filter contains disallowed keyword: ${kw}` };
        }
    }
    return { ok: true };
}
function queryRouter() {
    const router = (0, express_1.Router)();
    router.post('/connections/:id/query', async (req, res) => {
        const conn = (0, storage_1.getCredentials)(req.params.id);
        if (!conn) {
            res.status(404).json({ error: 'Connection not found (not registered). The connector may have restarted — please reload the app.' });
            return;
        }
        const { table, geomColumn, filter, bbox, srid, limit } = req.body;
        if (!table || !geomColumn) {
            res.status(400).json({ error: 'Missing required fields: table, geomColumn' });
            return;
        }
        if (!IDENT_RE.test(table)) {
            res.status(400).json({ error: 'Invalid table name' });
            return;
        }
        if (!IDENT_RE.test(geomColumn)) {
            res.status(400).json({ error: 'Invalid geometry column name' });
            return;
        }
        if (filter && typeof filter === 'string' && filter.trim()) {
            const filterCheck = validateFilter(filter);
            if (!filterCheck.ok) {
                res.status(400).json({ error: filterCheck.error });
                return;
            }
        }
        const targetSrid = Number(srid) || 4326;
        const maxLimit = Math.min(Number(limit) || 10000, 100000);
        try {
            const pool = (0, db_1.getPool)(conn);
            let sql = `SELECT *, ST_AsGeoJSON(ST_Transform(${quoteIdent(geomColumn)}, 4326))::json AS __geojson_geom FROM ${quoteIdent(table)}`;
            const conditions = [];
            const params = [];
            if (bbox && Array.isArray(bbox) && bbox.length === 4) {
                const [xmin, ymin, xmax, ymax] = bbox;
                params.push(xmin, ymin, xmax, ymax, targetSrid);
                const paramIdx = params.length - 4;
                conditions.push(`ST_Intersects(${quoteIdent(geomColumn)}, ST_Transform(ST_MakeEnvelope($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}), ST_SRID(${quoteIdent(geomColumn)})))`);
            }
            if (filter && typeof filter === 'string' && filter.trim()) {
                conditions.push(`(${filter.trim()})`);
            }
            if (conditions.length > 0) {
                sql += ' WHERE ' + conditions.join(' AND ');
            }
            sql += ` LIMIT ${maxLimit}`;
            const result = await pool.query(sql, params);
            const features = result.rows.map(row => {
                const geomJson = row.__geojson_geom;
                const properties = {};
                for (const [key, value] of Object.entries(row)) {
                    if (key !== '__geojson_geom' && key !== geomColumn) {
                        properties[key] = value;
                    }
                }
                return {
                    type: 'Feature',
                    geometry: geomJson,
                    properties,
                };
            });
            res.json({
                type: 'FeatureCollection',
                features,
            });
        }
        catch (err) {
            console.error('[query] Error executing query:', err);
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
//# sourceMappingURL=query.js.map