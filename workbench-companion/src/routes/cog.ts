// ---------------------------------------------------------------------------
// routes/cog.ts — S3 COG proxy, pre-sign, validate, and region detection.
//
//   GET  /cog/proxy        — Stream COG data through localhost (bypasses CORS)
//   POST /cog/presign      — Generate pre-signed S3 URLs server-side
//   POST /cog/validate     — Validate COG header (fetch first 2MB server-side)
//   POST /cog/detect-region — Detect S3 bucket region via HEAD request
//
// All routes accept S3 configuration in the request body or query params.
// The proxy route streams range requests so COG tile loading performance
// is preserved.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from 'express';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface S3Config {
  bucket: string;
  objectKey: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

// ---------------------------------------------------------------------------
// AWS Signature V4 helpers (Node.js native crypto)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Build the HTTPS URL for an S3 object.
 * - AWS S3:          https://{bucket}.s3.{region}.amazonaws.com/{key}
 * - Custom endpoint: {endpoint}/{bucket}/{key}
 */
function buildS3Url(config: S3Config): string {
  const key = config.objectKey.replace(/^\//, '');
  if (config.endpoint && config.endpoint.trim()) {
    const base = config.endpoint.replace(/\/+$/, '');
    return `${base}/${config.bucket}/${key}`;
  }
  const region = config.region || 'us-east-1';
  return `https://${config.bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Generate a pre-signed GET URL for an S3 object using AWS Signature V4.
 */
function presignS3Url(config: S3Config, expiresIn: number = 3600, method: string = 'GET'): string {
  const accessKey = (config.accessKeyId || '').trim();
  const secretKey = (config.secretAccessKey || '').trim();
  const sessionToken = config.sessionToken?.trim();
  const region = config.region || 'us-east-1';
  const service = 's3';

  let host: string;
  let path: string;
  const objectKey = config.objectKey.replace(/^\//, '');

  if (config.endpoint && config.endpoint.trim()) {
    const ep = new URL(config.endpoint.trim());
    host = ep.host;
    path = `/${config.bucket}/${objectKey}`;
  } else {
    host = `${config.bucket}.s3.${region}.amazonaws.com`;
    path = `/${objectKey}`;
  }

  const encodedPath = path.split('/').map(seg => encodeURIComponent(seg)).join('/');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (sessionToken) {
    queryParams['X-Amz-Security-Token'] = sessionToken;
  }

  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    method,
    encodedPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const canonicalRequestHash = sha256Hex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');

  const signature = toHex(hmacSha256(kSigning, stringToSign));

  const protocol = config.endpoint?.startsWith('http://') ? 'http' : 'https';
  return `${protocol}://${host}${encodedPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP(S) request and return the response.
 * Supports range requests for COG streaming.
 */
function makeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
    };

    const req = lib.request(parsedUrl, reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Stream an HTTP(S) response to the Express response.
 * Used for the proxy route to pass through range requests.
 */
function streamRequest(
  url: string,
  req: Request,
  res: Response,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
  } = {}
): void {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  // Forward range headers from the client request
  const forwardHeaders: Record<string, string> = { ...options.headers };
  if (req.headers.range) {
    forwardHeaders['Range'] = req.headers.range;
  }
  if (req.headers['accept-ranges']) {
    forwardHeaders['Accept-Ranges'] = req.headers['accept-ranges'];
  }

  const reqOptions: https.RequestOptions = {
    method: 'GET',
    headers: forwardHeaders,
    timeout: options.timeout || 60000,
  };

  const proxyReq = lib.request(parsedUrl, reqOptions, (proxyRes) => {
    // Forward response headers
    const responseHeaders: Record<string, string | string[]> = {};
    const headersToForward = [
      'content-type', 'content-length', 'content-range', 'accept-ranges',
      'etag', 'last-modified', 'cache-control', 'expires',
    ];
    for (const h of headersToForward) {
      if (proxyRes.headers[h]) {
        responseHeaders[h] = proxyRes.headers[h]!;
      }
    }
    // Allow CORS for the proxied response
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['Access-Control-Expose-Headers'] = 'Content-Range, Content-Length, Accept-Ranges';

    res.status(proxyRes.statusCode || 200);
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value);
    }

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[cog] Proxy request error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy request failed', detail: err.message });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Proxy request timeout' });
    }
  });

  // If the client disconnects, abort the upstream request
  req.on('close', () => {
    if (!proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  proxyReq.end();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function cogRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /cog/proxy?url=... — Stream COG data through localhost
  // -------------------------------------------------------------------------
  router.get('/cog/proxy', (req: Request, res: Response) => {
    const url = String(req.query.url || '');
    if (!url) {
      res.status(400).json({ error: 'Missing required query parameter: url' });
      return;
    }

    // Validate URL is HTTPS (or HTTP for custom endpoints)
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        res.status(400).json({ error: 'URL must be http(s)://' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    console.log(`[cog] Proxying: ${url.slice(0, 100)}...`);
    streamRequest(url, req, res);
  });

  // -------------------------------------------------------------------------
  // POST /cog/presign — Generate pre-signed S3 URL server-side
  // -------------------------------------------------------------------------
  router.post('/cog/presign', (req: Request, res: Response) => {
    const config: S3Config = req.body;
    if (!config.bucket || !config.objectKey) {
      res.status(400).json({ error: 'Missing required fields: bucket, objectKey' });
      return;
    }

    const expiresIn = Number(req.body.expiresIn) || 3600;
    const method = String(req.body.method || 'GET').toUpperCase();

    try {
      const signedUrl = presignS3Url(config, expiresIn, method);
      res.json({ url: signedUrl, expiresIn });
    } catch (err: any) {
      console.error('[cog] Presign error:', err.message);
      res.status(500).json({ error: 'Failed to presign URL', detail: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /cog/validate — Validate COG header (fetch first 2MB server-side)
  // -------------------------------------------------------------------------
  router.post('/cog/validate', async (req: Request, res: Response) => {
    const config: S3Config = req.body;
    if (!config.bucket || !config.objectKey) {
      res.status(400).json({ error: 'Missing required fields: bucket, objectKey' });
      return;
    }

    try {
      // Build the URL (pre-sign if credentials provided)
      let url: string;
      if (config.accessKeyId && config.secretAccessKey) {
        url = presignS3Url(config, 3600);
      } else {
        url = buildS3Url(config);
      }

      // Fetch first 2MB with range request
      const response = await makeRequest(url, {
        headers: { Range: 'bytes=0-2097151' },
        timeout: 15000,
      });

      if (response.statusCode >= 400) {
        res.status(response.statusCode).json({
          error: `S3 returned HTTP ${response.statusCode}`,
          fileSize: null,
        });
        return;
      }

      // Get total file size from Content-Range header
      const contentRange = response.headers['content-range'];
      let fileSize: number | null = null;
      if (contentRange) {
        const match = String(contentRange).match(/\/(\d+)$/);
        if (match) fileSize = parseInt(match[1], 10);
      }

      // Validate TIFF magic bytes
      const buffer = response.body;
      const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
      );

      if (buffer.byteLength < 8) {
        res.json({ isTiff: false, isCog: false, fileSize, error: 'File too small' });
        return;
      }

      const bom = view.getUint16(0, false);
      let littleEndian: boolean;
      if (bom === 0x4949) littleEndian = true;
      else if (bom === 0x4d4d) littleEndian = false;
      else {
        res.json({ isTiff: false, isCog: false, fileSize, error: 'Not a TIFF file' });
        return;
      }

      const magic = view.getUint16(2, littleEndian);
      if (magic !== 42 && magic !== 43) {
        res.json({ isTiff: false, isCog: false, fileSize, error: 'Invalid TIFF magic' });
        return;
      }

      // Check for tiling tags in first IFD
      let ifdOffset: number;
      const isBigTiff = magic === 43;
      if (isBigTiff) {
        ifdOffset = view.getUint32(8, littleEndian) + view.getUint32(12, littleEndian) * 0x100000000;
      } else {
        ifdOffset = view.getUint32(4, littleEndian);
      }

      let hasTileWidth = false;
      let hasTileLength = false;

      if (ifdOffset < buffer.byteLength) {
        try {
          if (isBigTiff) {
            const entryCount = view.getUint32(ifdOffset, littleEndian) +
              view.getUint32(ifdOffset + 4, littleEndian) * 0x100000000;
            for (let i = 0; i < entryCount; i++) {
              const off = ifdOffset + 8 + i * 20;
              if (off + 20 > buffer.byteLength) break;
              const tag = view.getUint16(off, littleEndian);
              if (tag === 322) hasTileWidth = true;
              if (tag === 323) hasTileLength = true;
            }
          } else {
            const entryCount = view.getUint16(ifdOffset, littleEndian);
            for (let i = 0; i < entryCount; i++) {
              const off = ifdOffset + 2 + i * 12;
              if (off + 12 > buffer.byteLength) break;
              const tag = view.getUint16(off, littleEndian);
              if (tag === 322) hasTileWidth = true;
              if (tag === 323) hasTileLength = true;
            }
          }
        } catch { /* IFD parse error */ }
      }

      const isCog = hasTileWidth && hasTileLength && ifdOffset < 1024 * 1024;

      res.json({
        isTiff: true,
        isBigTiff,
        isCog,
        fileSize,
        hasTiling: hasTileWidth && hasTileLength,
      });
    } catch (err: any) {
      console.error('[cog] Validate error:', err.message);
      res.status(500).json({ error: 'Validation failed', detail: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /cog/detect-region — Detect S3 bucket region via HEAD request
  // -------------------------------------------------------------------------
  router.post('/cog/detect-region', async (req: Request, res: Response) => {
    const { bucket, endpoint } = req.body;
    if (!bucket) {
      res.status(400).json({ error: 'Missing required field: bucket' });
      return;
    }

    // Only works for AWS S3, not custom endpoints
    if (endpoint && String(endpoint).trim()) {
      res.json({ region: null, error: 'Region detection not supported for custom endpoints' });
      return;
    }

    try {
      const globalUrl = `https://${bucket}.s3.amazonaws.com/`;
      const response = await makeRequest(globalUrl, { method: 'HEAD', timeout: 10000 });

      // S3 returns the bucket region in this header
      const region = response.headers['x-amz-bucket-region'];
      if (region) {
        res.json({ region: String(region) });
        return;
      }

      // Try to extract from redirect location
      if (response.statusCode === 301 && response.headers.location) {
        const match = String(response.headers.location).match(/\.s3\.([a-z0-9-]+)\.amazonaws\.com/i);
        if (match) {
          res.json({ region: match[1] });
          return;
        }
      }

      res.json({ region: null });
    } catch (err: any) {
      console.error('[cog] Region detection error:', err.message);
      res.json({ region: null, error: err.message });
    }
  });

  return router;
}
