// ---------------------------------------------------------------------------
// samEngine — SAM inference for the browser via ONNX Runtime Web.
//
// Two ONNX export contracts are supported (see samModels.ts):
//   * 'sam2'    — SAM 2.1 Tiny, samexporter encoder/decoder split.
//   * 'slimsam' — SlimSAM-77, transformers.js vision-encoder +
//                 prompt-encoder/mask-decoder split (deploy-safe size).
//
// Pipeline:
//   1. encode():  viewport snapshot → 1024×1024 normalised RGB tensor →
//                 image encoder → embedding (run once per map view).
//   2. predict(): embedding + point prompts → mask decoder → 3 candidate
//                 masks → best-by-IoU logits upscaled to 1024×1024.
//
// Model sourcing: candidates are tried in SAM_MODEL_PRIORITY order, each via
// its IndexedDB cache first, then its bundled static copy. Every payload is
// validated by actually creating the inference sessions before it is
// accepted (and cached in IDB), so a broken payload falls through. There is
// no remote download — see samModels.ts for why.
// ---------------------------------------------------------------------------

import { bilinearResize } from './contourExtract';
import { idbGetBinary, idbPutBinary, idbDelete } from './idb';
import {
  SAM_INPUT_SIZE,
  SAM_MASK_SIZE,
  SAM_MASK_THRESHOLD,
  SAM_MODEL_PRIORITY,
  SAM_ORT_CDN,
  SamBackend,
  SamModelDef,
  SamModelKind,
  SamPromptPoint,
  getStaticModelUrl,
} from './samModels';

// The ONNX Runtime module is loaded from a CDN ESM bundle, so it has no
// compile-time type — treat it as an untyped external (see AGENTS.md §14).
type OrtModule = any;
type OrtTensor = any;

/** Status callback so the UI can surface load/compile progress. */
export type SamStatusCallback = (update: {
  state: 'loading-runtime' | 'loading-local' | 'compiling';
  progress?: number;
  message?: string;
}) => void;

/** Cached encoder outputs for one snapshot, plus the snapshot dimensions. */
export interface SamEmbedding {
  imageEmbed: OrtTensor;
  /** SAM 2.1 only: high-resolution features consumed by its mask decoder. */
  hiRes0?: OrtTensor;
  hiRes1?: OrtTensor;
  /** SlimSAM only: positional embeddings consumed by its mask decoder. */
  posEmbed?: OrtTensor;
  viewWidth: number;
  viewHeight: number;
}

/** A decoded mask: logits resampled to encoder resolution. */
export interface SamMaskResult {
  logits: Float32Array;
  width: number;
  height: number;
  iou: number;
}

export interface ModelBuffers {
  encoder: ArrayBuffer;
  decoder: ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Pure preprocessing / postprocessing helpers (unit-tested)
// ---------------------------------------------------------------------------

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * RGBA bytes → planar CHW float tensor normalised with ImageNet mean/std.
 * Both supported exports use this convention (rescale 1/255 then
 * mean/std-normalise — the SAM preprocessing). Alpha is ignored.
 */
export function normalizeRgbToChw(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (rgba[i * 4] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    out[plane + i] = (rgba[i * 4 + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    out[2 * plane + i] = (rgba[i * 4 + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return out;
}

/** Index of the highest IoU prediction (SAM decoders emit 3 candidates). */
export function pickBestMaskIndex(ious: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < ious.length; i++) {
    if (ious[i] > ious[best]) best = i;
  }
  return best;
}

/**
 * SlimSAM's decoder wants int64 prompt labels (1 = foreground, 0 =
 * background). Pure for unit tests; BigInt calls (not literals) keep this
 * compatible with the ES5 compile target.
 */
export function promptLabelsToInt64(points: SamPromptPoint[]): BigInt64Array {
  const out = new BigInt64Array(points.length);
  points.forEach((p, i) => {
    out[i] = p.label > 0 ? BigInt(1) : BigInt(0);
  });
  return out;
}

/** Smallest plausible ONNX payload — anything smaller is not a model. */
export const MIN_MODEL_BYTES = 1_000_000;

/**
 * Validate bytes fetched for a bundled model. Hosts that fall back to
 * index.html for unknown paths answer 200 + text/html (Cloudflare's SPA
 * fallback does exactly this), so neither `resp.ok` nor a 200 status is
 * proof the file exists. Returns an error message, or null when the payload
 * looks like a real model part. Pure for unit tests.
 */
export function validateStaticPayload(
  part: 'encoder' | 'decoder',
  contentType: string,
  byteLength: number,
): string | null {
  if (contentType.toLowerCase().includes('text/html')) {
    return `Bundled ${part} is missing — the host served an HTML fallback page instead`;
  }
  if (byteLength < MIN_MODEL_BYTES) {
    return `Bundled ${part} is implausibly small (${byteLength} bytes)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runtime + model fetching
// ---------------------------------------------------------------------------

let ortPromise: Promise<OrtModule> | null = null;

/**
 * Load onnxruntime-web from the jsDelivr CDN as a native ESM import. The
 * WebGPU bundle is used in all cases — it embeds the WASM backend too, so a
 * CPU fallback stays available without a second download.
 */
export function loadOrtRuntime(): Promise<OrtModule> {
  if (!ortPromise) {
    const url = `${SAM_ORT_CDN}ort.webgpu.bundle.min.mjs`;
    // webpackIgnore keeps webpack from processing this — it stays a native
    // dynamic import of an absolute URL, resolved by the browser at runtime.
    ortPromise = import(/* webpackIgnore: true */ url).then((mod: any) => {
      const ort = mod && mod.default ? mod.default : mod;
      try {
        ort.env.wasm.wasmPaths = SAM_ORT_CDN;
      } catch {
        // Bundled builds inline the WASM binaries — nothing to configure.
      }
      return ort;
    });
    ortPromise.catch(() => {
      ortPromise = null; // allow a retry after a failed load
    });
  }
  return ortPromise;
}

/** Read both payloads of one model from the persistent IndexedDB cache. */
export async function loadBuffersFromIdb(def: SamModelDef): Promise<ModelBuffers | null> {
  const [encoder, decoder] = await Promise.all([
    idbGetBinary(def.idbEncoderKey),
    idbGetBinary(def.idbDecoderKey),
  ]);
  if (encoder && decoder) return { encoder, decoder };
  return null;
}

/** Read the payloads bundled with the app (public/models/...). */
export async function loadBuffersFromStatic(def: SamModelDef, onStatus?: SamStatusCallback): Promise<ModelBuffers> {
  onStatus?.({ state: 'loading-local', message: `Loading ${def.label} from the app…` });
  const [encResp, decResp] = await Promise.all([
    fetch(getStaticModelUrl(def, def.encoderFileName)),
    fetch(getStaticModelUrl(def, def.decoderFileName)),
  ]);
  if (!encResp.ok || !decResp.ok) {
    throw new Error(`Bundled model missing (HTTP ${encResp.status}/${decResp.status})`);
  }
  const [encoder, decoder] = await Promise.all([encResp.arrayBuffer(), decResp.arrayBuffer()]);
  const encProblem = validateStaticPayload('encoder', encResp.headers.get('content-type') || '', encoder.byteLength);
  if (encProblem) throw new Error(encProblem);
  const decProblem = validateStaticPayload('decoder', decResp.headers.get('content-type') || '', decoder.byteLength);
  if (decProblem) throw new Error(decProblem);
  return { encoder, decoder };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A lazy, single-use SAM engine. `init()` walks SAM_MODEL_PRIORITY (each
 * model via IDB cache, then its bundled static copy), validates every
 * candidate by creating both inference sessions, caches the first working
 * payload in IndexedDB, and records which export contract won (`kind`);
 * `encode()`/`predict()` then run against map snapshots.
 */
export class SamEngine {
  private ort: OrtModule = null;
  private encoderSession: any = null;
  private decoderSession: any = null;
  /** Provider actually used after fallbacks. */
  backend: SamBackend | null = null;
  /** Export contract of the model that loaded (null until ready). */
  kind: SamModelKind | null = null;
  /** Display label of the model that loaded (e.g. 'SAM 2.1 Tiny'). */
  modelLabel = '';

  get isReady(): boolean {
    return Boolean(this.encoderSession && this.decoderSession);
  }

  /** Resolve a model and create both sessions. Resolves once ready. */
  async init(onStatus?: SamStatusCallback): Promise<void> {
    if (this.isReady) return;

    onStatus?.({ state: 'loading-runtime', message: 'Loading ONNX runtime…' });
    this.ort = await loadOrtRuntime();

    // Candidate chain: best model first; per model, the IDB cache beats the
    // bundled copy. A payload that fails session creation (broken export,
    // stale cache, HTML impostor…) falls through to the next candidate.
    interface Candidate {
      def: SamModelDef;
      source: 'idb' | 'static';
      load: () => Promise<ModelBuffers | null>;
    }
    const candidates: Candidate[] = [];
    for (const def of SAM_MODEL_PRIORITY) {
      candidates.push({ def, source: 'idb', load: () => loadBuffersFromIdb(def) });
      candidates.push({ def, source: 'static', load: () => loadBuffersFromStatic(def, onStatus) });
    }

    let lastError: unknown = new Error('No SAM model source is available');
    for (const candidate of candidates) {
      let buffers: ModelBuffers | null;
      try {
        buffers = await candidate.load();
      } catch (err) {
        console.warn(`[SamEngine] ${candidate.def.id} ${candidate.source} source failed to load:`, err);
        lastError = err;
        continue;
      }
      if (!buffers) continue;

      try {
        await this.createSessions(buffers, onStatus);
        this.kind = candidate.def.kind;
        this.modelLabel = candidate.def.label;
        // Cache a validated copy so the next start is instant.
        if (candidate.source !== 'idb') {
          await Promise.all([
            idbPutBinary(candidate.def.idbEncoderKey, buffers.encoder),
            idbPutBinary(candidate.def.idbDecoderKey, buffers.decoder),
          ]);
        }
        return;
      } catch (err) {
        console.warn(`[SamEngine] sessions rejected the ${candidate.def.id} ${candidate.source} payload:`, err);
        lastError = err;
        if (candidate.source === 'idb') {
          // Stale/corrupt cache entry — drop it and retry from fresh sources.
          await Promise.all([idbDelete(candidate.def.idbEncoderKey), idbDelete(candidate.def.idbDecoderKey)]);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Create encoder + decoder sessions, preferring WebGPU over WASM. */
  private async createSessions(buffers: ModelBuffers, onStatus?: SamStatusCallback): Promise<void> {
    const hasWebGPU = typeof navigator !== 'undefined' && Boolean((navigator as any).gpu);
    const preferred: SamBackend = hasWebGPU ? 'webgpu' : 'wasm';

    const attempt = async (backend: SamBackend) => {
      const providers = backend === 'webgpu' ? ['webgpu'] : ['wasm'];
      // Note: enableGraphCapture is deliberately NOT set — it requires every
      // input/output tensor to be backed by pre-bound WebGPU buffers, while
      // the encoder runs only once per map snapshot anyway.
      const sessionOptions: any = { executionProviders: providers };
      const encoder = await this.ort.InferenceSession.create(buffers.encoder, sessionOptions);
      const decoder = await this.ort.InferenceSession.create(buffers.decoder, sessionOptions);
      return { encoder, decoder };
    };

    onStatus?.({
      state: 'compiling',
      message: preferred === 'webgpu' ? 'Compiling for WebGPU…' : 'Compiling for CPU (slower)…',
    });
    try {
      const sessions = await attempt(preferred);
      this.encoderSession = sessions.encoder;
      this.decoderSession = sessions.decoder;
      this.backend = preferred;
    } catch (err) {
      if (preferred === 'webgpu') {
        console.warn('[SamEngine] WebGPU session failed — retrying on WASM:', err);
        onStatus?.({ state: 'compiling', message: 'GPU unavailable — compiling for CPU…' });
        const sessions = await attempt('wasm');
        this.encoderSession = sessions.encoder;
        this.decoderSession = sessions.decoder;
        this.backend = 'wasm';
      } else {
        throw err;
      }
    }
  }

  /**
   * Run the image encoder on a viewport snapshot. The snapshot is stretched
   * to 1024×1024 (SAM's fixed input) — all later coordinate math uses the
   * same transform, so the distortion cancels out.
   */
  async encode(imageData: ImageData): Promise<SamEmbedding> {
    if (!this.isReady || !this.kind) throw new Error('SAM engine is not initialised');
    const size = SAM_INPUT_SIZE;

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = imageData.width;
    sourceCanvas.height = imageData.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) throw new Error('Cannot create a canvas context for SAM preprocessing');

    const targetCanvas = document.createElement('canvas');
    targetCanvas.width = size;
    targetCanvas.height = size;
    const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
    if (!targetCtx) throw new Error('Cannot create a canvas context for SAM preprocessing');

    sourceCtx.putImageData(imageData, 0, 0);
    targetCtx.drawImage(sourceCanvas, 0, 0, size, size);
    const scaled = targetCtx.getImageData(0, 0, size, size);

    const tensorData = normalizeRgbToChw(scaled.data, size, size);
    const tensor = new this.ort.Tensor('float32', tensorData, [1, 3, size, size]);

    if (this.kind === 'slimsam') {
      const outputs = await this.encoderSession.run({ pixel_values: tensor });
      return {
        imageEmbed: outputs.image_embeddings,
        posEmbed: outputs.image_positional_embeddings,
        viewWidth: imageData.width,
        viewHeight: imageData.height,
      };
    }
    const outputs = await this.encoderSession.run({ image: tensor });
    return {
      imageEmbed: outputs.image_embed,
      hiRes0: outputs.high_res_feats_0,
      hiRes1: outputs.high_res_feats_1,
      viewWidth: imageData.width,
      viewHeight: imageData.height,
    };
  }

  /**
   * Run the mask decoder for a set of prompt points (viewport pixels of the
   * encoded snapshot). Returns the best-of-3 mask logits upscaled to
   * encoder resolution (1024×1024).
   */
  async predict(embedding: SamEmbedding, points: SamPromptPoint[]): Promise<SamMaskResult> {
    if (!this.isReady || !this.kind) throw new Error('SAM engine is not initialised');
    if (points.length === 0) throw new Error('At least one prompt point is required');

    const scaleX = SAM_INPUT_SIZE / embedding.viewWidth;
    const scaleY = SAM_INPUT_SIZE / embedding.viewHeight;
    const coords = new Float32Array(points.length * 2);
    points.forEach((p, i) => {
      coords[i * 2] = p.x * scaleX;
      coords[i * 2 + 1] = p.y * scaleY;
    });

    let ious: ArrayLike<number>;
    let allMasks: Float32Array;

    if (this.kind === 'slimsam') {
      if (!embedding.posEmbed) throw new Error('SlimSAM embedding is missing its positional tensor');
      const inputs = {
        image_embeddings: embedding.imageEmbed,
        image_positional_embeddings: embedding.posEmbed,
        input_points: new this.ort.Tensor('float32', coords, [1, 1, points.length, 2]),
        input_labels: new this.ort.Tensor('int64', promptLabelsToInt64(points), [1, 1, points.length]),
      };
      const outputs = await this.decoderSession.run(inputs);
      // iou_scores [1,1,3] and pred_masks [1,1,3,256,256] arrive flat — the
      // leading singleton dims don't affect the indexing below.
      ious = outputs.iou_scores.data as Float32Array;
      allMasks = outputs.pred_masks.data as Float32Array;
    } else {
      if (!embedding.hiRes0 || !embedding.hiRes1) {
        throw new Error('SAM 2.1 embedding is missing its high-resolution features');
      }
      const labels = new Float32Array(points.length);
      points.forEach((p, i) => {
        labels[i] = p.label;
      });
      const inputs = {
        image_embed: embedding.imageEmbed,
        high_res_feats_0: embedding.hiRes0,
        high_res_feats_1: embedding.hiRes1,
        point_coords: new this.ort.Tensor('float32', coords, [1, points.length, 2]),
        point_labels: new this.ort.Tensor('float32', labels, [1, points.length]),
        mask_input: new this.ort.Tensor('float32', new Float32Array(SAM_MASK_SIZE * SAM_MASK_SIZE), [1, 1, SAM_MASK_SIZE, SAM_MASK_SIZE]),
        has_mask_input: new this.ort.Tensor('float32', new Float32Array([0]), [1]),
      };
      const outputs = await this.decoderSession.run(inputs);
      ious = outputs.iou_predictions.data as Float32Array;
      allMasks = outputs.masks.data as Float32Array;
    }

    const best = pickBestMaskIndex(ious);
    const maskPlane = SAM_MASK_SIZE * SAM_MASK_SIZE;
    const bestMask = Float32Array.from(allMasks.subarray(best * maskPlane, (best + 1) * maskPlane));

    // 256×256 logits → 1024×1024 so contours trace at full resolution.
    const logits = bilinearResize(bestMask, SAM_MASK_SIZE, SAM_MASK_SIZE, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
    return { logits, width: SAM_INPUT_SIZE, height: SAM_INPUT_SIZE, iou: Number(ious[best]) };
  }

  /** Release the inference sessions (best effort). */
  async dispose(): Promise<void> {
    try {
      await this.encoderSession?.release();
      await this.decoderSession?.release();
    } catch (err) {
      console.warn('[SamEngine] dispose failed:', err);
    }
    this.encoderSession = null;
    this.decoderSession = null;
    this.kind = null;
    this.modelLabel = '';
  }
}

// Re-exported for consumers that threshold masks themselves.
export { SAM_MASK_THRESHOLD };
