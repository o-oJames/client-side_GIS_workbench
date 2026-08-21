# SlimSAM-77 — bundled ONNX models (deploy-safe SAM)

SlimSAM (AAAI 2025, distilled from SAM ViT-H), "77-uniform" variant,
Apache-2.0. Source: https://huggingface.co/Xenova/slimsam-77-uniform —
the transformers.js export (vision encoder + prompt-encoder/mask-decoder
split), downloaded 2026-08-06, unmodified.

Why this model exists in the app: the SAM 2.1 Tiny encoder under
`../sam2.1/` is ~104 MiB — far over the 25 MiB per-file limit of
Cloudflare static hosting — so it cannot ship with deployed builds (the
deploy config excludes it). SlimSAM's fp32 files both fit the limit, so
every deployment carries a working SAM. The engine (`utils/samEngine.ts`)
prefers SAM 2.1 when it is available (local dev, or an existing IndexedDB
cache) and falls back to SlimSAM otherwise.

- `slimsam77.encoder.onnx` (22.2 MiB, fp32) — vision encoder.
  Input `pixel_values` [1,3,1024,1024]; outputs `image_embeddings` and
  `image_positional_embeddings`, both [1,256,64,64].
- `slimsam77.decoder.onnx` (15.8 MiB, fp32) — prompt encoder + mask decoder.
  Inputs `input_points` [1,1,N,2] float32, `input_labels` [1,1,N] **int64**,
  plus both encoder outputs; returns `iou_scores` [1,1,3] and `pred_masks`
  [1,1,3,256,256]. Point prompts only — all the magic wand needs.

Quality is below SAM 2.1 Tiny (distilled ViT-tiny-class encoder). The image
preprocessing is identical to SAM 2.1 (rescale 1/255 + ImageNet mean/std),
so both models share the engine's normalisation path.
