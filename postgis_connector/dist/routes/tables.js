"use strict";
// ---------------------------------------------------------------------------
// routes/tables.ts — GET /connections/:id/tables
// Queries PostGIS geometry_columns + geography_columns to discover spatial
// tables, returning table name, geometry column, geometry type, SRID, and
// estimated extent.
//
// Uses in-memory credentials (registered by the browser).
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.tablesRouter = tablesRouter;
const express_1 = require("express");
const storage_1 = require("../storage");
const db_1 = require("../db");
function tablesRouter() {
    const router = (0, express_1.Router)();
    router.get('/connections/:id/tables', async (req, res) => {
        const conn = (0, storage_1.getCredentials)(req.params.id);
        if (!conn) {
            res.status(404).json({ error: 'Connection not found (not registered). The connector may have restarted — please reload the app.' });
            return;
        }
        try {
            const pool = (0, db_1.getPool)(conn);
            // Query both geometry_columns and geography_columns
            const sql = `
        SELECT
          f_table_schema AS schema,
          f_table_name AS table_name,
          f_geometry_column AS geom_column,
          type AS geom_type,
          srid,
          false AS is_geography
        FROM geometry_columns
        UNION ALL
        SELECT
          f_table_schema AS schema,
          f_table_name AS table_name,
          f_geography_column AS geom_column,
          type AS geom_type,
          srid,
          true AS is_geography
        FROM geography_columns
        ORDER BY schema, table_name
      `;
            const result = await pool.query(sql);
            const tables = [];
            for (const row of result.rows) {
                let estimatedExtent = null;
                try {
                    const extentQuery = `SELECT ST_EstimatedExtent($1, $2, $3)::text AS extent`;
                    const extResult = await pool.query(extentQuery, [row.schema, row.table_name, row.geom_column]);
                    estimatedExtent = extResult.rows[0]?.extent ?? null;
                }
                catch {
                    // Estimated extent may fail if ANALYZE hasn't been run — that's OK
                }
                tables.push({
                    schema: row.schema,
                    table: row.table_name,
                    geomColumn: row.geom_column,
                    geomType: row.geom_type,
                    srid: Number(row.srid),
                    isGeography: row.is_geography,
                    estimatedExtent,
                });
            }
            res.json(tables);
        }
        catch (err) {
            console.error('[tables] Error listing tables:', err);
            res.status(500).json({ error: err.message ?? String(err) });
        }
    });
    return router;
}
//# sourceMappingURL=tables.js.map