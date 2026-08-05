// ---------------------------------------------------------------------------
// SAM 2.1 Tiny — model constants and shared types.
//
// The app runs Meta's Segment Anything Model 2.1 (Hiera-Tiny) completely
// client-side through ONNX Runtime Web (WebGPU, WASM fallback). The ONNX
// export is the samexporter split used by AnyLabeling: one image encoder
// (runs once per map snapshot) plus one promptable mask decoder (runs per
// click). See utils/samEngine.ts for the runtime wiring.
// ---------------------------------------------------------------------------

/** Encoder input edge length — SAM 2 only accepts 1024×1024 images. */
export const SAM_INPUT_SIZE = 1024;

/** Decoder mask output edge length (logits, before upscaling). */
export const SAM_MASK_SIZE = 256;

/** Mask decision threshold on decoder logits (SAM convention). */
export const SAM_MASK_THRESHOLD = 0;

/** onnxruntime-web version pinned on the CDN. */
export const SAM_ORT_VERSION = '1.27.0';

/** CDN base for the onnxruntime-web ESM bundles. */
export const SAM_ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${SAM_ORT_VERSION}/dist/`;

/**
 * SAM 2.1 Tiny asset locations and persistence keys.
 *
 * Loading order (see samEngine.fetchModelBuffers):
 *  1. IndexedDB — persists across refreshes; nothing re-downloads.
 *  2. The app's own static copy under `public/models/sam2.1/` — a
 *     **repaired** export that also serves as the offline / CDN-failure
 *     fallback.
 *  3. The remote zip on Hugging Face (~111 MB packed / ~145 MB extracted).
 *     Note: the upstream encoder is currently rejected by ORT >= 1.2x
 *     (shape-declaration conflict in its `If` control-flow nodes), so in
 *     practice the static copy wins whenever the IDB cache is cold.
 */
export const SAM_MODEL = {
  id: 'sam2.1_hiera_tiny',
  label: 'SAM 2.1 Tiny',
  zipUrl:
    'https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models/resolve/main/sam2.1_hiera_tiny_20260221.zip',
  approxZipBytes: 116507723,
  /** IndexedDB keys (mapviewer/layerdata store) caching the ONNX payloads. */
  idbEncoderKey: 'sam21:encoder:repaired:v1',
  idbDecoderKey: 'sam21:decoder:v1',
  /** Files bundled with the app (public/models/sam2.1). */
  staticDir: 'models/sam2.1',
  encoderFileName: 'sam2.1_hiera_tiny.encoder.onnx',
  decoderFileName: 'sam2.1_hiera_tiny.decoder.onnx',
};

/** URL of a model file shipped inside the app's static assets. */
export function getStaticModelUrl(fileName: string): string {
  const base = typeof process !== 'undefined' && process.env && process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL
    : '';
  return `${base}/${SAM_MODEL.staticDir}/${fileName}`;
}

/** Which ONNX Runtime execution provider the engine settled on. */
export type SamBackend = 'webgpu' | 'wasm';

/** Lifecycle states surfaced to the UI (toolbar spinner + hint bar). */
export type SamStatusState =
  | 'idle'        // never initialised
  | 'loading-runtime'
  | 'loading-local' // reading the bundled copy from the app's static assets
  | 'downloading' // model zip streaming in
  | 'extracting'  // unzipping + caching the ONNX files
  | 'compiling'   // creating the inference sessions
  | 'ready'
  | 'encoding'    // image encoder running on a snapshot
  | 'error';

export interface SamStatus {
  state: SamStatusState;
  /** 0..1 where meaningful (download/extract progress). */
  progress: number;
  message: string;
  backend?: SamBackend;
}

export const SAM_STATUS_IDLE: SamStatus = { state: 'idle', progress: 0, message: '' };

/**
 * A prompt point for the mask decoder. `x`/`y` are pixels in the encoded
 * snapshot's viewport space; `label` 1 = foreground (include), 0 =
 * background (exclude — "intelligent scissors" refinement).
 */
export interface SamPromptPoint {
  x: number;
  y: number;
  label: 0 | 1;
}
