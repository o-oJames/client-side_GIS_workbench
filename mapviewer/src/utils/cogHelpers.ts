// ---------------------------------------------------------------------------
// Cloud Optimized GeoTIFF (COG) helpers: validation, S3 URL construction,
// and AWS Signature V4 pre-signing for private object storage access.
// ---------------------------------------------------------------------------

/** Maximum file size (bytes) for a non-COG TIFF before we refuse to load it. */
export const MAX_NON_COG_TIFF_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Number of leading bytes needed to validate a GeoTIFF as a COG (magic bytes
 * + first IFD). COGs place their IFDs at the start of the file, so a small
 * header slice is sufficient — the whole file never needs to be read.
 */
export const COG_HEADER_VALIDATION_BYTES = 2 * 1024 * 1024; // 2 MB

/** TIFF tag IDs used for COG detection. */
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_ROWS_PER_STRIP = 278;

export interface CogValidationResult {
  isTiff: boolean;
  isBigTiff: boolean;
  isCog: boolean;
  error?: string;
  fileSize: number;
}

/**
 * Validate whether an ArrayBuffer contains a Cloud Optimized GeoTIFF.
 *
 * Supports both classic TIFF (magic 42) and BigTIFF (magic 43).
 *
 * Checks performed:
 * 1. TIFF magic bytes (little-endian II or big-endian MM, magic 42 or 43)
 * 2. Internal tiling (TileWidth + TileLength tags present in the first IFD)
 * 3. IFD offset near the start of the file (a COG places metadata first)
 *
 * A regular (non-COG) TIFF that exceeds MAX_NON_COG_TIFF_SIZE is rejected
 * with an error to prevent freezing the browser.
 *
 * The buffer may be a truncated header slice of a much larger file (see
 * COG_HEADER_VALIDATION_BYTES). Pass the real file size as `totalSize` so
 * size-based decisions are correct; all byte reads are bounded by the slice
 * length. If the first IFD lies beyond the slice, the file cannot be a COG
 * (COGs keep their IFDs at the start) and is treated as non-COG.
 */
export function validateCogBuffer(buffer: ArrayBuffer, fileName?: string, totalSize?: number): CogValidationResult {
  const fileSize = totalSize ?? buffer.byteLength;
  const headerSize = buffer.byteLength;
  const view = new DataView(buffer);

  if (fileSize < 8) {
    return { isTiff: false, isBigTiff: false, isCog: false, fileSize, error: 'File is too small to be a valid TIFF.' };
  }

  // --- 1. Check TIFF magic bytes ---
  const byteOrderMark = view.getUint16(0, false); // read as big-endian first
  let littleEndian: boolean;
  if (byteOrderMark === 0x4949) {
    littleEndian = true; // 'II'
  } else if (byteOrderMark === 0x4d4d) {
    littleEndian = false; // 'MM'
  } else {
    return {
      isTiff: false, isBigTiff: false, isCog: false, fileSize,
      error: `"${fileName || 'File'}" is not a TIFF file. Please provide a GeoTIFF (.tif / .tiff) file.`,
    };
  }

  const magic = view.getUint16(2, littleEndian);
  let isBigTiff: boolean;
  if (magic === 42) {
    isBigTiff = false;
  } else if (magic === 43) {
    isBigTiff = true;
  } else {
    return { isTiff: false, isBigTiff: false, isCog: false, fileSize, error: 'Not a valid TIFF file (bad magic number).' };
  }

  // --- 2. Read the first IFD offset ---
  let ifdOffset: number;
  if (isBigTiff) {
    // BigTIFF: bytes 4-5 = offset bytesize (always 8), bytes 6-7 = reserved,
    // bytes 8-15 = first IFD offset (8 bytes)
    if (fileSize < 16) {
      return { isTiff: true, isBigTiff, isCog: false, fileSize, error: 'File too small for BigTIFF header.' };
    }
    const lo = view.getUint32(8, littleEndian);
    const hi = view.getUint32(12, littleEndian);
    ifdOffset = lo + hi * 0x100000000;
  } else {
    // Classic TIFF: bytes 4-7 = first IFD offset (4 bytes)
    ifdOffset = view.getUint32(4, littleEndian);
  }

  if (ifdOffset >= fileSize) {
    return { isTiff: true, isBigTiff, isCog: false, fileSize, error: 'Corrupt TIFF: IFD offset exceeds file size.' };
  }

  // --- 3. Parse the first IFD to check for tiling tags ---
  let hasTileWidth = false;
  let hasTileLength = false;
  let hasRowsPerStrip = false;

  // With a truncated header slice the IFD may lie beyond the available
  // bytes. A real COG keeps its first IFD near the start of the file, so a
  // far-away IFD simply means "not a COG" — leave the tags false and let the
  // size-based verdict below handle it.
  const ifdWithinSlice = ifdOffset < headerSize;

  if (ifdWithinSlice) {
    try {
      if (isBigTiff) {
        // BigTIFF IFD: 8-byte entry count, then 20-byte entries
        if (ifdOffset + 8 > headerSize) {
          return { isTiff: true, isBigTiff, isCog: false, fileSize, error: 'Corrupt BigTIFF: cannot read IFD entry count.' };
        }
        const countLo = view.getUint32(ifdOffset, littleEndian);
        const countHi = view.getUint32(ifdOffset + 4, littleEndian);
        const entryCount = countLo + countHi * 0x100000000;
        for (let i = 0; i < entryCount; i++) {
          const entryOffset = ifdOffset + 8 + i * 20;
          if (entryOffset + 20 > headerSize) break;
          const tag = view.getUint16(entryOffset, littleEndian);
          if (tag === TAG_TILE_WIDTH) hasTileWidth = true;
          if (tag === TAG_TILE_LENGTH) hasTileLength = true;
          if (tag === TAG_ROWS_PER_STRIP) hasRowsPerStrip = true;
        }
      } else {
        // Classic TIFF IFD: 2-byte entry count, then 12-byte entries
        if (ifdOffset + 2 > headerSize) {
          return { isTiff: true, isBigTiff, isCog: false, fileSize, error: 'Corrupt TIFF: cannot read IFD entry count.' };
        }
        const entryCount = view.getUint16(ifdOffset, littleEndian);
        for (let i = 0; i < entryCount; i++) {
          const entryOffset = ifdOffset + 2 + i * 12;
          if (entryOffset + 12 > headerSize) break;
          const tag = view.getUint16(entryOffset, littleEndian);
          if (tag === TAG_TILE_WIDTH) hasTileWidth = true;
          if (tag === TAG_TILE_LENGTH) hasTileLength = true;
          if (tag === TAG_ROWS_PER_STRIP) hasRowsPerStrip = true;
        }
      }
    } catch {
      return { isTiff: true, isBigTiff, isCog: false, fileSize, error: 'Corrupt TIFF: failed to parse IFD entries.' };
    }
  }

  const isTiled = hasTileWidth && hasTileLength;

  // A COG must use internal tiling and should have its first IFD near the
  // start of the file (before the image data). We use a generous 1 MB
  // threshold for the IFD offset to accommodate files with large headers.
  const ifdNearStart = ifdOffset < 1024 * 1024;
  const isCog = isTiled && ifdNearStart;

  if (!isCog) {
    if (fileSize > MAX_NON_COG_TIFF_SIZE) {
      const sizeMb = (fileSize / (1024 * 1024)).toFixed(1);
      const limitMb = (MAX_NON_COG_TIFF_SIZE / (1024 * 1024)).toFixed(0);
      return {
        isTiff: true, isBigTiff, isCog: false, fileSize,
        error:
          `"${fileName || 'File'}" (${sizeMb} MB) is a standard (non-cloud-optimised) GeoTIFF and is too large to render in the browser (limit: ${limitMb} MB). ` +
          'Please convert it to a Cloud Optimized GeoTIFF (COG) first, e.g.:\n\n' +
          '  gdal_translate -of COGT input.tif output_cog.tif\n\n' +
          'A COG uses internal tiling and overviews so only the visible portion is streamed.',
      };
    }
    if (!isTiled) {
      return {
        isTiff: true, isBigTiff, isCog: false, fileSize,
        error: hasRowsPerStrip
          ? `"${fileName || 'File'}" is a strip-based TIFF (not cloud-optimised). It is small enough to render, but performance may be suboptimal. Consider converting to COG for best results.`
          : undefined,
      };
    }
  }

  return { isTiff: true, isBigTiff, isCog, fileSize };
}

// ---------------------------------------------------------------------------
// S3 / object-storage URL helpers
// ---------------------------------------------------------------------------

export interface S3Config {
  bucket: string;
  objectKey: string;
  region?: string;
  endpoint?: string;         // custom endpoint for S3-compatible storage (MinIO, R2, etc.)
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/**
 * Build the public HTTPS URL for an S3 object.
 *
 * - AWS S3:          https://{bucket}.s3.{region}.amazonaws.com/{key}
 * - Custom endpoint: {endpoint}/{bucket}/{key}  (path-style, used by MinIO etc.)
 */
export function buildS3HttpsUrl(config: S3Config): string {
  const key = config.objectKey.replace(/^\//, '');
  if (config.endpoint && config.endpoint.trim()) {
    const base = config.endpoint.replace(/\/+$/, '');
    return `${base}/${config.bucket}/${key}`;
  }
  const region = config.region || 'us-east-1';
  return `https://${config.bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Determine whether credentials are required (i.e. any credential field is
 * filled in).
 */
export function hasS3Credentials(config: S3Config): boolean {
  return !!(config.accessKeyId?.trim() && config.secretAccessKey?.trim());
}

// ---------------------------------------------------------------------------
// AWS Signature V4 pre-signing (browser-native, no SDK required)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return toHex(new Uint8Array(digest));
}

/**
 * Generate a pre-signed GET URL for an S3 object using AWS Signature V4
 * (query-string authentication). The URL is valid for `expiresIn` seconds
 * (default 3600 = 1 hour, max 604800 = 7 days).
 *
 * Works with AWS S3 and S3-compatible object stores (MinIO, Cloudflare R2,
 * Wasabi, Backblaze B2, etc.) by specifying a custom `endpoint`.
 */
export async function presignS3Url(config: S3Config, expiresIn: number = 3600): Promise<string> {
  const accessKey = config.accessKeyId!.trim();
  const secretKey = config.secretAccessKey!.trim();
  const sessionToken = config.sessionToken?.trim();
  const region = config.region || 'us-east-1';
  const service = 's3';

  // Determine host and path
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

  // URI-encode each path segment (S3 requires RFC 3986 encoding)
  const encodedPath = path.split('/').map(seg => encodeURIComponent(seg)).join('/');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20260731T120000Z
  const dateStamp = amzDate.slice(0, 8); // 20260731
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Canonical query string (parameters must be sorted)
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

  // Canonical request
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    'GET',
    encodedPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  // Signing key
  const kDate = await hmacSha256(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');

  // Signature
  const signatureBytes = await hmacSha256(kSigning, stringToSign);
  const signature = toHex(signatureBytes);

  // Assemble the pre-signed URL
  const protocol = config.endpoint?.startsWith('http://') ? 'http' : 'https';
  return `${protocol}://${host}${encodedPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Resolve the final URL for a COG layer based on its S3 configuration.
 * Returns a pre-signed URL when credentials are provided, otherwise the
 * plain public HTTPS URL.
 */
export async function resolveS3CogUrl(config: S3Config): Promise<string> {
  if (hasS3Credentials(config)) {
    return presignS3Url(config, 3600);
  }
  return buildS3HttpsUrl(config);
}


/**
 * Parse a full S3 URI (s3://bucket/object/key) or an https bucket URL into
 * its bucket and object key parts. Returns null when the string matches
 * neither shape.
 *
 * Accepted forms:
 *   s3://my-bucket/path/to/file.tif
 *   https://my-bucket.s3.ap-southeast-2.amazonaws.com/path/to/file.tif
 *   https://my-bucket.s3.amazonaws.com/path/to/file.tif
 */
export function parseS3Url(input: string): { bucket: string; objectKey: string; region?: string } | null {
  const trimmed = input.trim();

  // s3://bucket/key
  const s3Match = trimmed.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (s3Match) {
    return { bucket: s3Match[1], objectKey: s3Match[2].replace(/^\/+/, '') };
  }

  // https://bucket.s3[.region].amazonaws.com/key
  const httpsMatch = trimmed.match(/^https?:\/\/([^.]+)\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com\/(.+)$/i);
  if (httpsMatch) {
    return { bucket: httpsMatch[1], region: httpsMatch[2], objectKey: httpsMatch[3].replace(/^\/+/, '') };
  }

  return null;
}
