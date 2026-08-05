// ---------------------------------------------------------------------------
// samEngine — SAM 2.1 Tiny inference for the browser via ONNX Runtime Web.
//
// Pipeline (samexporter/AnyLabeling ONNX split):
//   1. encode():  viewport snapshot → 1024×1024 normalised RGB tensor →
//                 image encoder → embedding (run once per map view).
//   2. predict(): embedding + point prompts → mask decoder → 3 candidate
//                 masks → best-by-IoU logits upscaled to 1024×1024.
//
// Model sourcing (in order):
//   1. IndexedDB cache — persists across refreshes, so the ~126 MB payload
//      is fetched at most once per browser profile.
//   2. The repaired copy bundled with the app (public/models/sam2.1) —
//      same-origin, works offline, and immune to CDN outages.
//   3. The remote zip on Hugging Face (kept for deployments that strip the
//      bundled weights; note the upstream encoder is currently rejected by
//      ORT >= 1.2x, so this path mainly future-proofs the app).
// Every source is validated by actually creating the inference sessions
// before it is accepted (and cached), so a broken payload falls through.
// ---------------------------------------------------------------------------

import JSZip from 'jszip';
import { bilinearResize } from './contourExtract';
import { idbGetBinary, idbPutBinary, idbDelete } from './idb';
import {
  SAM_INPUT_SIZE,
  SAM_MASK_SIZE,
  SAM_MASK_THRESHOLD,
  SAM_MODEL,
  SAM_ORT_CDN,
  SamBackend,
  SamPromptPoint,
  getStaticModelUrl,
} from './samModels';

// The ONNX Runtime module is loaded from a CDN ESM bundle, so it has no
// compile-time type — treat it as an untyped external (see AGENTS.md §14).
type OrtModule = any;
type OrtTensor = any;

/** Status callback so the UI can surface load/compile progress. */
export type SamStatusCallback = (update: {
  state: 'loading-runtime' | 'loading-local' | 'downloading' | 'extracting' | 'compiling';
  progress?: number;
  message?: string;
}) => void;

/** Cached encoder outputs for one snapshot, plus the snapshot dimensions. */
export interface SamEmbedding {
  imageEmbed: OrtTensor;
  hiRes0: OrtTensor;
  hiRes1: OrtTensor;
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
 * RGBA bytes → planar CHW float tensor normalised with ImageNet mean/std,
 * the SAM 2 preprocessing convention. Alpha is ignored.
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

/** Index of the highest IoU prediction (SAM decoder emits 3 candidates). */
export function pickBestMaskIndex(ious: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < ious.length; i++) {
    if (ious[i] > ious[best]) best = i;
  }
  return best;
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

/** Streaming fetch with byte progress (falls back to a plain fetch). */
async function fetchWithProgress(
  url: string,
  approxBytes: number,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Model download failed (HTTP ${response.status})`);
  }
  const headerTotal = Number(response.headers.get('Content-Length') || 0);
  const total = headerTotal > 0 ? headerTotal : approxBytes;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onProgress?.(buffer.length, buffer.length);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.length;
  });
  return bytes;
}

/** Read both payloads from the persistent IndexedDB cache. */
export async function loadBuffersFromIdb(): Promise<ModelBuffers | null> {
  const [encoder, decoder] = await Promise.all([
    idbGetBinary(SAM_MODEL.idbEncoderKey),
    idbGetBinary(SAM_MODEL.idbDecoderKey),
  ]);
  if (encoder && decoder) return { encoder, decoder };
  return null;
}

/** Read the repaired payloads bundled with the app (public/models/sam2.1). */
export async function loadBuffersFromStatic(onStatus?: SamStatusCallback): Promise<ModelBuffers> {
  onStatus?.({ state: 'loading-local', message: 'Loading AI model from the app…' });
  const [encResp, decResp] = await Promise.all([
    fetch(getStaticModelUrl(SAM_MODEL.encoderFileName)),
    fetch(getStaticModelUrl(SAM_MODEL.decoderFileName)),
  ]);
  if (!encResp.ok || !decResp.ok) {
    throw new Error(`Bundled model missing (HTTP ${encResp.status}/${decResp.status})`);
  }
  const [encoder, decoder] = await Promise.all([encResp.arrayBuffer(), decResp.arrayBuffer()]);
  return { encoder, decoder };
}

/** Download + unzip the remote payload from Hugging Face. */
export async function loadBuffersFromRemote(onStatus?: SamStatusCallback): Promise<ModelBuffers> {
  onStatus?.({ state: 'downloading', progress: 0, message: 'Downloading SAM 2.1 Tiny…' });
  const zipBytes = await fetchWithProgress(SAM_MODEL.zipUrl, SAM_MODEL.approxZipBytes, (received, total) => {
    const pct = total > 0 ? Math.min(1, received / total) : 0;
    onStatus?.({
      state: 'downloading',
      progress: pct,
      message: `Downloading SAM 2.1 Tiny… ${Math.round(pct * 100)}%`,
    });
  });
  onStatus?.({ state: 'extracting', message: 'Preparing model files…' });
  const zip = await JSZip.loadAsync(zipBytes);
  const onnxNames = Object.keys(zip.files).filter((name) => name.toLowerCase().endsWith('.onnx'));
  const encoderName = onnxNames.find((name) => name.toLowerCase().includes('encoder'));
  const decoderName = onnxNames.find((name) => name.toLowerCase().includes('decoder'));
  if (!encoderName || !decoderName) {
    throw new Error('The SAM model archive is missing its encoder/decoder ONNX files');
  }
  const encoderFile = zip.file(encoderName);
  const decoderFile = zip.file(decoderName);
  if (!encoderFile || !decoderFile) {
    throw new Error('Could not read the SAM ONNX files from the archive');
  }
  const [encoder, decoder] = await Promise.all([
    encoderFile.async('arraybuffer'),
    decoderFile.async('arraybuffer'),
  ]);
  return { encoder, decoder };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A lazy, single-use SAM 2.1 Tiny engine. `init()` resolves the model
 * payload (IDB cache → bundled static copy → remote zip), validates it by
 * creating both inference sessions, and caches a working copy in IndexedDB;
 * `encode()`/`predict()` then run against map snapshots.
 */
export class SamEngine {
  private ort: OrtModule = null;
  private encoderSession: any = null;
  private decoderSession: any = null;
  /** Provider actually used after fallbacks. */
  backend: SamBackend | null = null;

  get isReady(): boolean {
    return Boolean(this.encoderSession && this.decoderSession);
  }

  /** Resolve the model and create both sessions. Resolves once ready. */
  async init(onStatus?: SamStatusCallback): Promise<void> {
    if (this.isReady) return;

    onStatus?.({ state: 'loading-runtime', message: 'Loading ONNX runtime…' });
    this.ort = await loadOrtRuntime();

    // Source chain: persistent cache, then the repaired bundled copy, then
    // the remote zip. Each candidate must actually create valid sessions —
    // a payload that fails (e.g. the upstream encoder on ORT >= 1.2x) falls
    // through to the next source.
    const sources: Array<{ label: string; load: () => Promise<ModelBuffers | null> }> = [
      { label: 'idb', load: () => loadBuffersFromIdb() },
      { label: 'static', load: () => loadBuffersFromStatic(onStatus) },
      { label: 'remote', load: () => loadBuffersFromRemote(onStatus) },
    ];

    let lastError: unknown = new Error('No SAM model source is available');
    for (const source of sources) {
      let buffers: ModelBuffers | null;
      try {
        buffers = await source.load();
      } catch (err) {
        console.warn(`[SamEngine] ${source.label} source failed to load:`, err);
        lastError = err;
        continue;
      }
      if (!buffers) continue;

      try {
        await this.createSessions(buffers, onStatus);
        // Cache a validated copy so the next start is instant.
        if (source.label !== 'idb') {
          await Promise.all([
            idbPutBinary(SAM_MODEL.idbEncoderKey, buffers.encoder),
            idbPutBinary(SAM_MODEL.idbDecoderKey, buffers.decoder),
          ]);
        }
        return;
      } catch (err) {
        console.warn(`[SamEngine] sessions rejected the ${source.label} payload:`, err);
        lastError = err;
        if (source.label === 'idb') {
          // Stale/corrupt cache entry — drop it and retry from fresh sources.
          await Promise.all([idbDelete(SAM_MODEL.idbEncoderKey), idbDelete(SAM_MODEL.idbDecoderKey)]);
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
    if (!this.isReady) throw new Error('SAM engine is not initialised');
    const size = SAM_INPUT_SIZE;

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = imageData.width;
    sourceCanvas.height = imageData.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    if (!sourceCtx) throw new Error('Could not create a canvas context for SAM preprocessing');
    sourceCtx.putImageData(imageData, 0, 0);

    const targetCanvas = document.createElement('canvas');
    targetCanvas.width = size;
    targetCanvas.height = size;
    const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
    if (!targetCtx) throw new Error('Could not create a canvas context for SAM preprocessing');
    targetCtx.drawImage(sourceCanvas, 0, 0, size, size);
    const scaled = targetCtx.getImageData(0, 0, size, size);

    const tensorData = normalizeRgbToChw(scaled.data, size, size);
    const tensor = new this.ort.Tensor('float32', tensorData, [1, 3, size, size]);
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
    if (!this.isReady) throw new Error('SAM engine is not initialised');
    if (points.length === 0) throw new Error('At least one prompt point is required');

    const scaleX = SAM_INPUT_SIZE / embedding.viewWidth;
    const scaleY = SAM_INPUT_SIZE / embedding.viewHeight;
    const coords = new Float32Array(points.length * 2);
    const labels = new Float32Array(points.length);
    points.forEach((p, i) => {
      coords[i * 2] = p.x * scaleX;
      coords[i * 2 + 1] = p.y * scaleY;
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

    const ious = outputs.iou_predictions.data as Float32Array;
    const best = pickBestMaskIndex(ious);
    const maskPlane = SAM_MASK_SIZE * SAM_MASK_SIZE;
    const allMasks = outputs.masks.data as Float32Array;
    const bestMask = Float32Array.from(allMasks.subarray(best * maskPlane, (best + 1) * maskPlane));

    // 256×256 logits → 1024×1024 so contours trace at full resolution.
    const logits = bilinearResize(bestMask, SAM_MASK_SIZE, SAM_MASK_SIZE, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
    return { logits, width: SAM_INPUT_SIZE, height: SAM_INPUT_SIZE, iou: ious[best] };
  }

  /** Release the inference sessions (best effort). */
  async dispose(): Promise<void> {
    try {
      if (this.encoderSession?.release) await this.encoderSession.release();
      if (this.decoderSession?.release) await this.decoderSession.release();
    } catch (err) {
      console.warn('[SamEngine] dispose failed:', err);
    }
    this.encoderSession = null;
    this.decoderSession = null;
  }
}

/** Re-exported for consumers that threshold masks themselves. */
export { SAM_MASK_THRESHOLD };
