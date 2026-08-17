// ---------------------------------------------------------------------------
// routes/tiles.ts — GET /connections/:id/tiles/:z/:x/:y
// Returns MVT (Mapbox Vector Tile) via ST_AsMVT for a given table.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { loadConnections } from '../storage';
import { getPool } from '../db';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export function tilesRouter(): Router {
  const router = Router();

  router.get('/connections/:id/tiles/:z/:x/:y', async (req, res) => {
    const conns = loadConnections();
    const conn = conns.find(c => c.id === req.params.id);
    if (!conn) {
      res.status(404).json({ error: 'Connection not found' });
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
      const pool = getPool(conn);

      // Use ST_AsMVT to generate the tile
      // ST_TileEnvelope generates the tile bounds in EPSG:3857
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
        // Empty tile — return 204 No Content
        res.status(204).end();
        return;
      }

      res.set('Content-Type', 'application/vnd.mapbox-vector-tile');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(Buffer.from(mvtBuffer));
    } catch (err: any) {
      console.error('[tiles] Error generating tile:', err);
      res.status(500).json({ error: err.message ?? String(err) });
    }
  });

  return router;
}

function quoteIdent(name: string): string {
  // Handle schema-qualified names (e.g., "public.layertime" -> "public"."layertime")
  if (name.includes('.')) {
    return name.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
  }
  return `"${name.replace(/"/g, '""')}"`;
}
