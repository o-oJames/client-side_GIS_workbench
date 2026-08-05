# SAM 2.1 Tiny — bundled ONNX models

Local copies of Meta's SAM 2.1 Tiny (Apache 2.0) in the samexporter
encoder/decoder split, used as a fallback when the remote download
(Hugging Face) is unavailable.

- `sam2.1_hiera_tiny.encoder.onnx` — **repaired export**: the upstream
  samexporter encoder wraps Hiera's static window-padding logic in two ONNX
  `If` nodes. ORT >= 1.2x rejects the export on a shape-declaration conflict
  ("Can't merge shape info"), and ORT-Web's WASM backend additionally
  mis-executes the `If` op. Because the conditions depend only on the fixed
  1024x1024 input size, both Ifs were constant-folded (the always-selected
  branch was inlined) and the result verified bit-identical (max diff 0.0)
  to the original on CPU.
- `sam2.1_hiera_tiny.decoder.onnx` — unmodified upstream decoder.

The app stores whichever copy loads successfully in IndexedDB, so these files
are only fetched once per browser profile.
