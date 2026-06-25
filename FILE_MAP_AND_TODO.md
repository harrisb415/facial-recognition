# File Map and Implementation TODO Checklist

This scaffold ships with real, working implementations for everything that doesn't depend on the exact shape of sourced ONNX weights, and clearly-marked `TODO(impl)` stubs for everything that does. This document is the single place that tracks which is which — keep it updated as stubs get filled in; don't let it drift from reality.

---

## 1. File map

| File | Status | Responsibility |
|---|---|---|
| [src/App.tsx](src/App.tsx) | **Wired, depends on stubs below** | Top-level orchestrator: initializes crypto/storage/workers, routes between enroll/match modes |
| [src/main.tsx](src/main.tsx) | Done | React root + service worker registration |
| [src/styles/index.css](src/styles/index.css) | Done (minimal) | Functional but unstyled-beyond-basics; visual design is out of scope for this scaffold |
| [src/types/index.ts](src/types/index.ts) | Done | All shared data model + pipeline types |
| [src/core/config.ts](src/core/config.ts) | Done, **values unvalidated** | Central tunable config; `matchThreshold`/`liveness.minScore` are placeholders — see [privacy-and-testing.md](privacy-and-testing.md) §3.1 |
| [src/core/CryptoService.ts](src/core/CryptoService.ts) | Done | AES-GCM encrypt/decrypt, PBKDF2 + random-key derivation |
| [src/core/VectorStore.ts](src/core/VectorStore.ts) | Done | IndexedDB CRUD, encryption wiring, cosine-similarity search, consent cascade-delete |
| [src/core/WorkerBridge.ts](src/core/WorkerBridge.ts) | Done | Typed postMessage RPC, both main-thread and worker-side halves |
| [src/core/Aligner.ts](src/core/Aligner.ts) | Done | 5-point similarity transform + canvas warp to canonical crop (pure geometry, no model dependency) |
| [src/core/ModelManager.ts](src/core/ModelManager.ts) | **Partial — see TODOs** | Manifest loading (done), backend feature-detection (done), ONNX session creation (TODO), warm-up (TODO) |
| [src/core/FaceDetector.ts](src/core/FaceDetector.ts) | **Stub — see TODOs** | NMS helper (done); preprocessing + SCRFD output decoding (TODO, blocked on sourced weights) |
| [src/core/Embedder.ts](src/core/Embedder.ts) | **Stub — see TODOs** | `l2Normalize` (done); preprocessing + inference call (TODO, blocked on sourced weights) |
| [src/core/LivenessModel.ts](src/core/LivenessModel.ts) | **Partial — see TODOs** | `textureHeuristic` (done, usable standalone); model inference call (TODO, blocked on sourced weights) |
| [src/workers/detector.worker.ts](src/workers/detector.worker.ts) | Wired, depends on FaceDetector/ModelManager TODOs | Worker entry hosting FaceDetector + Aligner |
| [src/workers/embedder.worker.ts](src/workers/embedder.worker.ts) | Wired, depends on Embedder/LivenessModel TODOs | Worker entry hosting Embedder + LivenessModel |
| [src/components/CameraCapture.tsx](src/components/CameraCapture.tsx) | Done | getUserMedia lifecycle, fixed-cadence frame grabbing as ImageBitmap |
| [src/components/ConsentDialog.tsx](src/components/ConsentDialog.tsx) | Done | Consent gate UI; copy mirrors [privacy-and-testing.md](privacy-and-testing.md) §2 |
| [src/components/EnrollmentFlow.tsx](src/components/EnrollmentFlow.tsx) | **Wired, one TODO** | Consent → capture → quality/liveness gate → review → store state machine |
| [src/components/LivenessPrompt.tsx](src/components/LivenessPrompt.tsx) | Done | Challenge countdown UI + failure messaging |
| [src/components/MatchResultPanel.tsx](src/components/MatchResultPanel.tsx) | Done | Presentational match-outcome panel |
| [public/sw.js](public/sw.js) | Done | Cache-first model caching, stale-while-revalidate app shell, manual invalidation hook |
| [models/manifest.json](models/manifest.json) | Done, **placeholder dims/hashes** | Model registry — `sha256` fields and possibly `inputSize`/`outputDim` need confirming against actual sourced files |

---

## 2. Recommended implementation order

The stubs are not independent — implement in this order to avoid building against assumptions that later turn out wrong:

1. **Source/convert/quantize the three model files** per [models/README.md](models/README.md). Do this first — every downstream TODO is "confirm against actual weights," and you can't confirm against weights you don't have yet.
2. **Inspect each ONNX graph's real input/output shapes** (models/README.md §5) and update [models/manifest.json](models/manifest.json) (`inputSize`, `outputDim`, `preprocessing`) to match reality.
3. **`ModelManager.getSession()`** — wire up real `ort.InferenceSession.create()` calls using the now-confirmed manifest data and the backend selected by `selectBackend()`. This unblocks everything else, since `FaceDetector`/`Embedder`/`LivenessModel` all call through it.
4. **`ModelManager.warmUp()`** — dummy inference per loaded session; needed before the "ready" state in `App.tsx` is actually trustworthy.
5. **`FaceDetector.detect()`** — preprocessing + SCRFD output decoding. This is the most architecture-specific piece; budget the most time here. Reference the source repo's own postprocessing code for the exact anchor/stride layout of whichever SCRFD export you sourced.
6. **`Embedder.embed()`** — straightforward once `getSession()` works: preprocess per manifest, run, `l2Normalize` (already implemented) the output.
7. **`LivenessModel.runModel()`** — same pattern as Embedder; simplest of the three model-dependent stubs (single scalar output).
8. **Tune `config.ts` defaults** against real data per [privacy-and-testing.md](privacy-and-testing.md) §3.1 (`matchThreshold`, `liveness.minScore`) — don't ship the placeholders.
9. **Fill the `EnrollmentFlow.tsx` consent-id TODO** (see §3 below) — small, but easy to forget since the flow works "well enough" without it during dev testing.
10. **End-to-end test** the full enroll → match cycle in a real browser per the acceptance criteria in [offline-face-recognition-spec.md](offline-face-recognition-spec.md) §12.

---

## 3. Per-file TODO checklist

### `src/core/ModelManager.ts`
- [ ] Replace the `throw` in `getSession()` with a real `ort.InferenceSession.create(modelUrl, { executionProviders })` call (import `onnxruntime-web` as `ort`).
- [ ] Add a `backendToExecutionProviders()` mapping function per [offline-model-loading-plan.md](offline-model-loading-plan.md) §3.2.
- [ ] Add the TF.js fallback branch (load `tfjsFile` via `tf.loadGraphModel()`) per §3.3 of the same doc, gated on `config.runtime.allowTfjsFallback`.
- [ ] Add checksum verification against `manifest` entry's `sha256` (when not the placeholder string) before trusting a fetched/cached model — see [offline-model-loading-plan.md](offline-model-loading-plan.md) §2.2.
- [ ] Implement `warmUp()` — zero/random-filled input tensor per task, one `session.run()`, discard result.
- [ ] Add one-tier-down fallback on runtime session failure (e.g. WebGPU device-lost) — currently not handled.

### `src/core/FaceDetector.ts`
- [ ] Implement letterbox resize to `manifest.detector.inputSize`, tracking scale/offset for mapping boxes back to original frame coordinates.
- [ ] Implement normalization per `manifest.detector.preprocessing`.
- [ ] Implement SCRFD output decoding (anchor boxes + scores + landmarks) — **confirm exact head layout against your sourced weights' own reference decoder before writing this**, do not guess anchor strides.
- [ ] Wire `nonMaxSuppression()` (already implemented) and `config.minFaceSizePx` filtering into `detect()`'s return path.

### `src/core/Embedder.ts`
- [ ] Implement pixel→tensor conversion (confirm NCHW vs NHWC against sourced weights).
- [ ] Implement normalization per `manifest.embedder.preprocessing`.
- [ ] Call `l2Normalize()` (already implemented) on the raw model output before returning.

### `src/core/LivenessModel.ts`
- [ ] Implement `runModel()`: preprocess per `manifest.antispoof.preprocessing`, run session, sigmoid if output is a raw logit.
- [ ] Re-tune the `0.8 / 0.2` model/heuristic weighting in `check()` once you have real model + heuristic score distributions (see [privacy-and-testing.md](privacy-and-testing.md) §3.1, applied to liveness rather than just matching).
- [ ] Re-tune `textureHeuristic()`'s `idealMidpoint = 12` constant against real captured data — it's a placeholder guess, not measured.

### `src/components/EnrollmentFlow.tsx`
- [ ] Thread the `ConsentRecord.id` created in `handleConsentDecision()` through component state so `EnrollmentRecord.consentRecordId` (currently hardcoded to `''`) is populated correctly. Small fix, but blocks the consent-revocation cascade-delete (`VectorStore.revokeConsent`) from finding the right rows if left as-is.

### `models/manifest.json`
- [ ] Replace all three `sha256: "REPLACE_WITH_SHA256_OF_ACTUAL_FILE"` placeholders once real files are in place.
- [ ] Replace all three `license: "REPLACE — verify..."` placeholders with the actual verified license of each sourced weight file.
- [ ] Confirm/correct `inputSize` and `outputDim` against real ONNX graph inspection (models/README.md §5) — especially `embedder.outputDim`, which varies meaningfully across public MobileFaceNet conversions (128 vs 192 vs 512).

### Cross-cutting / before any production use
- [ ] Run the full [privacy-and-testing.md](privacy-and-testing.md) checklist (§1) and testing plan (§3) — accuracy, performance, and bias testing are not optional polish, they're required before trusting any threshold value in `config.ts`.
- [ ] Walk every item in [offline-face-recognition-spec.md](offline-face-recognition-spec.md) §12 ("Acceptance Criteria") and verify each one directly (devtools inspection, airplane-mode test, etc.) rather than assuming the architecture guarantees them by construction.

---

## 4. Things deliberately left undone (not bugs, not oversights)

- **No visual design system.** [src/styles/index.css](src/styles/index.css) is functional, not polished. Styling is out of scope for this scaffold.
- **No multi-face enrollment averaging.** `EnrollmentFlow` stores a single capture's embedding. Averaging multiple captures (common in production face-recognition systems to improve robustness) is a reasonable enhancement but adds state-machine complexity not included here — add it deliberately if you need it, don't bolt it on ad hoc.
- **No model sharding for ONNX files.** Not needed at current model sizes — see [offline-model-loading-plan.md](offline-model-loading-plan.md) §4 for when/how to add it if a future model swap needs it.
- **No diagnostics/debug panel.** Recommended in [offline-model-loading-plan.md](offline-model-loading-plan.md) §7 but not built — add only if you find yourself needing it during real-device QA.
- **No automated test files yet** (`*.test.ts`). `vitest` is wired into `package.json` but no test files are included — write them as you fill in the TODOs above, per the regression-testing guidance in [privacy-and-testing.md](privacy-and-testing.md) §3.4.
