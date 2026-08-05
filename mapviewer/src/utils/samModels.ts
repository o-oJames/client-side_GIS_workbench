// ---------------------------------------------------------------------------
// SAM model constants and shared types.
//
// The app runs a Segment-Anything-style model completely client-side through
// ONNX Runtime Web (WebGPU, WASM fallback). Two ONNX exports are supported
// (see utils/samEngine.ts for the runtime wiring):
//
//   * SAM 2.1 Tiny — Meta's SAM 2.1 (Hiera-Tiny) in the samexporter
//     encoder/decoder split. Highest quality. The copy bundled under
//     public/models/sam2.1 is a *repaired* export (the upstream encoder is
//     rejected by ORT >= 1.2x — see that folder's README). Its ~104 MiB
//     encoder exceeds the 25 MiB per-file limit of Cloudflare static
//     hosting, so the deploy config excludes it and hosted visitors fall
//     through to SlimSAM below.
//
//   * SlimSAM-77 — a distilled SAM (AAAI 2025) in the transformers.js
//     vision-encoder + prompt/mask-decoder split. Both fp32 files fit the
//     25 MiB limit, so every deployment ships a working SAM.
//
// There is deliberately no remote download source: Hugging Face no longer
// serves resolve/main with a permissive CORS header, and its SAM 2.1 zip
// contains the upstream encoder that ORT >= 1.2x rejects anyway. Both
// models are resolved locally — IndexedDB cache first, then the bundled
// static copy — and every payload is validated by actually creating the
// inference sessions before it is accepted.
// ---------------------------------------------------------------------------

/** Encoder input edge length — SAM models only accept 1024×1024 images. */
export const SAM_INPUT_SIZE = 1024;

/** Decoder mask output edge length (logits, before upscaling). */
export const SAM_MASK_SIZE = 256;

/** Mask decision threshold on decoder logits (SAM convention). */
export const SAM_MASK_THRESHOLD = 0;

/** onnxruntime-web version pinned on the CDN. */
export const SAM_ORT_VERSION = '1.27.0';

/** CDN base for the onnxruntime-web ESM bundles. */
export const SAM_ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${SAM_ORT_VERSION}/dist/`;

/** Which ONNX export contract a model follows (tensor names/shapes). */
export type SamModelKind = 'sam2' | 'slimsam';

/** Static-asset + IndexedDB locations for one SAM model. */
export interface SamModelDef {
  id: string;
  label: string;
  kind: SamModelKind;
  /** Directory under the app's static assets holding the ONNX files. */
  staticDir: string;
  encoderFileName: string;
  decoderFileName: string;
  /** IndexedDB keys (mapviewer/layerdata store) caching the ONNX payloads. */
  idbEncoderKey: string;
  idbDecoderKey: string;
}

/** SAM 2.1 Tiny — best quality; too large for hosted static assets. */
export const SAM21_TINY: SamModelDef = {
  id: 'sam2.1_hiera_tiny',
  label: 'SAM 2.1 Tiny',
  kind: 'sam2',
  staticDir: 'models/sam2.1',
  encoderFileName: 'sam2.1_hiera_tiny.encoder.onnx',
  decoderFileName: 'sam2.1_hiera_tiny.decoder.onnx',
  idbEncoderKey: 'sam21:encoder:repaired:v1',
  idbDecoderKey: 'sam21:decoder:v1',
};

/** SlimSAM-77 — compact deploy-safe fallback (fp32 files fit 25 MiB each). */
export const SLIMSAM_77: SamModelDef = {
  id: 'slimsam77',
  label: 'SlimSAM-77',
  kind: 'slimsam',
  staticDir: 'models/slimsam',
  encoderFileName: 'slimsam77.encoder.onnx',
  decoderFileName: 'slimsam77.decoder.onnx',
  idbEncoderKey: 'slimsam77:encoder:v1',
  idbDecoderKey: 'slimsam77:decoder:v1',
};

/**
 * Candidate order for engine initialisation: the first model whose payloads
 * load *and* create valid inference sessions wins. SAM 2.1 is preferred for
 * quality; SlimSAM is the compact fallback that always exists on hosted
 * deployments.
 */
export const SAM_MODEL_PRIORITY: SamModelDef[] = [SAM21_TINY, SLIMSAM_77];

/** URL of a model file shipped inside the app's static assets. */
export function getStaticModelUrl(def: SamModelDef, fileName: string): string {
  const base = typeof process !== 'undefined' && process.env && process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL
    : '';
  return `${base}/${def.staticDir}/${fileName}`;
}

/** Which ONNX Runtime execution provider the engine settled on. */
export type SamBackend = 'webgpu' | 'wasm';

/** Lifecycle states surfaced to the UI (toolbar spinner + hint bar). */
export type SamStatusState =
  | 'idle'          // never initialised
  | 'loading-runtime'
  | 'loading-local' // reading a bundled copy from the app's static assets
  | 'compiling'     // creating the inference sessions
  | 'ready'
  | 'encoding'      // image encoder running on a snapshot
  | 'error';

export interface SamStatus {
  state: SamStatusState;
  /** 0..1 where meaningful. */
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
