// ---------------------------------------------------------------------------
// tileContoursWorkerApi — shared types for the tile contours web worker.
//
// The main thread builds a JobRequest with pre-computed tile URLs and contour
// levels, posts it to the worker, and receives JobResult messages progressively
// as each tile is processed. The main thread then creates OL Features from
// those arrays — keeping the heavy PNG decode + marching-squares work off the
// UI thread while giving immediate visual feedback.
// ---------------------------------------------------------------------------

/** How the tile's RGB channels encode elevation (mirrors tileElevation.ts). */
export type TileElevationEncoding =
  | 'terrarium'
  | 'mapbox'
  | 'grayscale';

/** One tile to fetch: pre-built URL + tile indices for grid compositing. */
export interface TileJob {
  url: string;
  tx: number;
  ty: number;
}

/** Tile grid parameters the worker needs to composite tiles into a grid. */
export interface TileGridParams {
  /** Origin (top-left) in the view projection: [x, y]. */
  origin: [number, number];
  /** Ground resolution at the chosen zoom level (metres per pixel). */
  resolution: number;
  /** Tile size in pixels (usually 256 or 512). */
  tileSize: number;
  /** Zoom level the tiles were fetched at. */
  zoom: number;
}

/** Contour level to trace. */
export interface ContourLevel {
  /** Elevation value (metres). */
  level: number;
  /** True if this is an index (major) contour. */
  index: boolean;
}

/** Message from main thread → worker. */
export interface JobRequest {
  type: 'job';
  jobId: string;
  tiles: TileJob[];
  tileGrid: TileGridParams;
  /** Buffered view extent: [minx, miny, maxx, maxy]. */
  viewExtent: [number, number, number, number];
  /** Target output grid size (width × height in cells). */
  outputGrid: { width: number; height: number };
  encoding: TileElevationEncoding;
  grayscaleRange?: { min: number; max: number };
  /** Contour levels to trace (pre-computed by planContourLevels). */
  levels: ContourLevel[];
  /** Douglas-Peucker simplification tolerance (pixels). */
  simplify: number;
}

/** Cancel message from main thread → worker. */
export interface CancelRequest {
  type: 'cancel';
  jobId: string;
}

export type WorkerRequest = JobRequest | CancelRequest;

/** One traced contour path in map coordinates. */
export interface ContourPath {
  level: number;
  index: boolean;
  closed: boolean;
  /** Coordinate pairs: [[x, y], [x, y], ...]. */
  coords: number[][];
}

/** Progress information for partial results. */
export interface JobProgress {
  processed: number;
  total: number;
}

/** Message from worker → main thread. */
export interface JobResult {
  type: 'result';
  jobId: string;
  paths: ContourPath[];
  /** Elevation range of the grid (for diagnostics). */
  range: { min: number; max: number } | null;
  /** Progress info for partial results (omitted on final result). */
  progress?: JobProgress;
  /** True when this is the final result (all tiles processed). */
  complete?: boolean;
  error?: string;
}

export type WorkerResponse = JobResult;
