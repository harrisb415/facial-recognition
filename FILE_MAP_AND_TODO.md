# File Map and Implementation TODO Checklist

Status as of 2026-06-25: the full pipeline is implemented, model weights are sourced and committed, and the app verified booting end-to-end in a browser (all three workers initialize, all three ONNX sessions create successfully, consent-gated camera flow works). What's left is real-camera/real-face testing and threshold tuning — see §2 and §4.

---

## 1. File map

| File | Status | Responsibility |
|---|---|---|
| [src/App.tsx](src/App.tsx) | Done | Top-level orchestrator: initializes crypto/storage/3 workers, routes between enroll/match modes |
| [src/main.tsx](src/main.tsx) | Done | React root + service worker registration |
| [src/styles/index.css](src/styles/index.css) | Done (minimal) | Functional but unstyled-beyond-basics; visual design is out of scope for this scaffold |
| [src/types/index.ts](src/types/index.ts) | Done | All shared data model + pipeline types, incl. `MarginCrop` for the anti-spoof model's separate crop |
| [src/core/config.ts](src/core/config.ts) | Done, **values unvalidated** | Central tunable config; `matchThreshold`/`liveness.minScore` are still placeholders — see [privacy-and-testing.md](privacy-and-testing.md) §3.1 |
| [src/core/CryptoService.ts](src/core/CryptoService.ts) | Done | AES-GCM encrypt/decrypt, PBKDF2 + random-key derivation |
| [src/core/VectorStore.ts](src/core/VectorStore.ts) | Done | IndexedDB CRUD, encryption wiring, cosine-similarity search, consent cascade-delete |
| [src/core/WorkerBridge.ts](src/core/WorkerBridge.ts) | Done | Typed postMessage RPC, both main-thread and worker-side halves |
| [src/core/Aligner.ts](src/core/Aligner.ts) | Done | 5-point similarity transform + canvas warp to 112x112 (embedder), plus `cropWithMargin()` for the anti-spoof model's looser bbox-centered crop |
| [src/core/tensorUtils.ts](src/core/tensorUtils.ts) | Done | Shared RGBA→RGB extraction, NCHW tensor packing (with BGR swap support), letterbox resize |
| [src/core/ModelManager.ts](src/core/ModelManager.ts) | Done | Manifest loading, backend feature-detection, real `ort.InferenceSession.create()` (via `onnxruntime-web/all`), checksum verification, warm-up, and a same-instance session-creation queue (see §4 — required, not optional) |
| [src/core/FaceDetector.ts](src/core/FaceDetector.ts) | Done | Letterbox preprocessing, SCRFD multi-stride anchor decode (validated against real model output in Python before porting), NMS, min-size filter |
| [src/core/Embedder.ts](src/core/Embedder.ts) | Done | Preprocessing + inference + `l2Normalize` |
| [src/core/LivenessModel.ts](src/core/LivenessModel.ts) | Done | `textureHeuristic` + real MiniFASNetV2 inference (BGR, softmax) on the bbox-margin crop |
| [src/workers/detector.worker.ts](src/workers/detector.worker.ts) | Done | Worker hosting FaceDetector + Aligner only |
| [src/workers/embedder.worker.ts](src/workers/embedder.worker.ts) | Done | Worker hosting Embedder **only** — see §4, this used to also host LivenessModel and that didn't work |
| [src/workers/antispoof.worker.ts](src/workers/antispoof.worker.ts) | Done | Worker hosting LivenessModel only — split out from embedder.worker.ts, see §4 |
| [src/components/CameraCapture.tsx](src/components/CameraCapture.tsx) | Done | getUserMedia lifecycle, fixed-cadence frame grabbing as ImageBitmap |
| [src/components/ConsentDialog.tsx](src/components/ConsentDialog.tsx) | Done | Consent gate UI; copy mirrors [privacy-and-testing.md](privacy-and-testing.md) §2 |
| [src/components/EnrollmentFlow.tsx](src/components/EnrollmentFlow.tsx) | Done | Consent → capture → quality/liveness gate → review → store state machine; consent record id correctly threaded through to `EnrollmentRecord.consentRecordId` |
| [src/components/LivenessPrompt.tsx](src/components/LivenessPrompt.tsx) | Done | Challenge countdown UI + failure messaging |
| [src/components/MatchResultPanel.tsx](src/components/MatchResultPanel.tsx) | Done | Presentational match-outcome panel |
| [public/sw.js](public/sw.js) | Done | Cache-first model caching, stale-while-revalidate app shell, manual invalidation hook |
| [public/models/manifest.json](public/models/manifest.json) | Done | Real sha256/sizes/dims for all 3 models, confirmed against actual ONNX graphs and a real validation run |
| [public/models/detector/scrfd_tiny.onnx](public/models/detector/scrfd_tiny.onnx), [public/models/embedder/mobilefacenet.onnx](public/models/embedder/mobilefacenet.onnx), [public/models/antispoof/antispoof_tiny.onnx](public/models/antispoof/antispoof_tiny.onnx) | Done, committed | Real sourced weights, under `public/` so `vite build` ships them (see §3) — see manifest.json `license` fields before any commercial use |

---

## 2. What's NOT yet verified (be honest about this boundary)

Browser verification covered: app boots, all 3 ONNX sessions create successfully, service worker caches correctly, consent dialogs render and gate correctly, `getUserMedia` is correctly invoked post-consent and its denial/error path is handled gracefully. This was done in a sandboxed preview browser with **no real camera device** — so the following is genuinely untested:

- [x] **Real live camera capture** — tested 2026-06-25, found and fixed a real frame-concurrency bug (§3). Detection/alignment/embedding/liveness were previously only validated against a single static test photo via a one-off Python script (see `public/models/manifest.json` `validationNotes`); now also exercised against a live `getUserMedia` stream, though a full successful enroll/match round trip still hasn't been explicitly confirmed.
- [ ] **Real enrollment → match round trip** with an actual human face, in a real browser, with a real camera.
- [ ] **`config.ts` threshold tuning** (`matchThreshold: 0.62`, `liveness.minScore: 0.5`) against real accuracy data — see [privacy-and-testing.md](privacy-and-testing.md) §3.1. These are still unvalidated placeholders.
- [ ] **Bias/fairness testing** ([privacy-and-testing.md](privacy-and-testing.md) §3.3) — not started; requires a diverse real-face test set.
- [ ] Cross-browser testing (only exercised on the Chromium-based preview browser so far) and the WASM-only fallback path (only WebGPU/WebGL-capable path has been exercised).

Do this testing with your own (or consenting volunteers') camera before trusting this for anything beyond local development.

---

## 3. Architecture notes worth knowing before you modify this

- **One ONNX model per Web Worker, strictly.** onnxruntime-web's multi-threaded WASM backend (active because `vite.config.ts` sets the COOP/COEP headers needed for `SharedArrayBuffer`) can only host **one** live `InferenceSession` per worker/realm — creating a second session in the same worker, even sequentially after the first finishes, throws `Session already started`. This is why there are three workers (detector/embedder/antispoof) instead of two — an earlier combined embedder+antispoof worker hit this wall. If you add a fourth model, give it its own worker too; don't combine.
- **`ModelManager` also serializes session creation internally** (`sessionCreationQueue` in `ModelManager.ts`) as defense-in-depth against the same class of race if a future change ever calls `getSession()` concurrently for two tasks within one worker — this doesn't replace the one-model-per-worker rule above, it's a second layer.
- **`App.tsx`'s init effect guards against React StrictMode's dev-mode double-invoke** via `initStartedRef`. This matters because `App` acquires expensive resources (3 workers, 3 wasm-backed ONNX sessions) once for the page's lifetime; don't remove the guard without re-testing under StrictMode.
- **The anti-spoof model uses a different crop than the embedder.** `Aligner.align()` (112x112, ArcFace 5-point warp) feeds the embedder; `Aligner.cropWithMargin()` (80x80, bbox-centered, 2.7x margin, BGR) feeds the anti-spoof model. They are computed from the same detection in `detector.worker.ts` and shipped to the main thread together (`alignedFaces` + `marginCrops`).
- **`cropWithMargin()`'s source rectangle must be clamped to the frame bounds — this is not optional.** A 2.7x margin around a normal close-up webcam face in a 640x480 capture requests a crop side of ~550-700px, taller than the 480px frame itself. `drawImage`'s 9-arg form silently clips an out-of-bounds source rect and proportionally shrinks the destination, leaving the rest of the output transparent (reads back as solid black) — that fed a partially-black, malformed 80x80 crop to the anti-spoof model on every real capture, and was caught only by live-camera testing (the original Python validation used a huge photo where the face was tiny relative to the frame, so it never hit this boundary). `Aligner.cropWithMargin()` now clamps `side` and position to stay within `source.width`/`source.height` (the parameter type is `ImageBitmap`, not the wider `CanvasImageSource`, specifically so `.width`/`.height` are available for this).
- **The anti-spoof model's class index is 1 = real/live, not 0.** Confirmed from minivision-ai's own `test.py`, not a third-party summary. See `src/core/LivenessModel.ts` docblock for the full story — this and the crop-bounds issue above were two independent bugs that both had to be fixed before real-camera liveness checks would pass; fixing only one was not enough.
- **Service worker caches `/models/*` cache-first, forever, until explicitly invalidated.** During development, if you change a model file or `manifest.json` and don't see the change take effect, the service worker's Cache Storage (not the HTTP cache, not the dev server) is almost certainly why — unregister it and clear `caches` via devtools/console, not just a normal reload. This is the single most likely "my fix isn't taking effect" trap when working in this codebase.
- **`CameraCapture` fires frames on a fixed interval regardless of whether the previous frame finished processing.** `EnrollmentFlow.handleFrame` and `App.handleMatchFrame` both guard against this with an `isProcessingRef` (drop the new frame, don't queue it) — without that guard, overlapping calls pile up, each independently dispatching state transitions and racing to finish, which manifests as the UI looking permanently stuck ("nothing happens no matter what I do") and risks calling `.run()` concurrently on the same onnxruntime-web session from two overlapping requests (not guaranteed safe — this is suspected to be the cause of an observed `Cannot read properties of null` crash from inside the minified onnxruntime-web bundle before the guard was added). If you add a third frame-consuming flow, it needs the same guard.
- **`LivenessPrompt` does not track blinks, head turns, or any other real signal — it never did.** The original default copy ("Please blink twice") implied otherwise and confused real-camera testing; it's now "Checking…". The actual liveness result comes entirely from the single captured crop (anti-spoof model + texture heuristic) — see [offline-face-recognition-spec.md](offline-face-recognition-spec.md) §4.4's "Motion/blink challenge" for what a *real* implementation of this would require (tracking landmark movement across a frame sequence) — that's an unbuilt feature, not a bug, but don't reintroduce copy that implies it exists.
- **Model files MUST live under `public/models/`, never a project-root `models/`.** `vite build` only ships `public/` contents verbatim plus whatever the JS module graph statically references — it does not know about `models/manifest.json` being fetched at runtime via a plain string URL, so a project-root `models/` directory silently vanishes from `dist/`. `npm run dev` masks this completely (Vite's dev server serves the whole project root), so the bug only surfaces after `npm run build && npm run preview` — discovered exactly that way 2026-06-25 (`Unexpected token '<' ... is not valid JSON`, because the missing-file fetch fell through to the SPA's `index.html` fallback). No code needed to change to fix this — `ModelManager` already requests `/models/...` as a URL path, which is correct; only the physical file location needed to move into `public/`.

---

## 4. Remaining TODOs (smaller, lower-priority than §2's testing gaps)

- [ ] **TF.js fallback** is still not implemented (`ModelManager.createSession()` throws a clear error if `ort.InferenceSession.create()` fails rather than falling back) — see [offline-model-loading-plan.md](offline-model-loading-plan.md) §3.3.
- [ ] **One-tier-down runtime fallback** (e.g. WebGPU device-lost mid-session) is not handled — sessions are created once per worker lifetime with whatever backend was selected at startup.
- [ ] **Quantization** — all three model files are fp32 as sourced, not yet INT8-quantized. See `public/models/README.md` §1-3 for the quantization step; re-validate accuracy after quantizing.
- [ ] **Multi-face enrollment averaging** — `EnrollmentFlow` stores a single capture's embedding, not an average of several. Reasonable future enhancement, deliberately not built.
- [ ] **No diagnostics/debug panel** (backend-in-use, cache hit/miss, warm-up timing) — recommended in [offline-model-loading-plan.md](offline-model-loading-plan.md) §7, not built.

---

## 5. Things deliberately left undone (not bugs, not oversights)

- **No visual design system.** [src/styles/index.css](src/styles/index.css) is functional, not polished. Styling is out of scope for this scaffold.
- **No model sharding for ONNX files.** Not needed at current model sizes — see [offline-model-loading-plan.md](offline-model-loading-plan.md) §4 for when/how to add it if a future model swap needs it.
