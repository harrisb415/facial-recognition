# File Map and Implementation TODO Checklist

Status as of 2026-06-27: full pipeline implemented; detector/aligner/embedder confirmed working on a real camera. **Liveness was pivoted from the passive anti-spoof CNN (which didn't discriminate live from spoof) to an ACTIVE head-motion challenge** ([src/core/LivenessChallenge.ts](src/core/LivenessChallenge.ts) + [src/components/ChallengeGate.tsx](src/components/ChallengeGate.tsx)) — deterministic, unit-tested, mirror-agnostic. The passive model/worker are retained but dormant (not spawned). What's left: confirm the head-motion challenge feels right on a real camera + tune its yaw thresholds; embedding match-threshold tuning; bias testing. See §2 and §4.

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
| [src/components/EnrollmentFlow.tsx](src/components/EnrollmentFlow.tsx) | Done | Consent → head-motion challenge (ChallengeGate) → embed → review → store; consent record id threaded through to `EnrollmentRecord.consentRecordId` |
| [src/core/LivenessChallenge.ts](src/core/LivenessChallenge.ts) | **Done — the liveness gate** | Pure `(landmarks, timestamp) → status` head-yaw challenge: centered baseline, then strong turn in both signs within budget. Mirror-agnostic. Unit-tested ([LivenessChallenge.test.ts](src/core/LivenessChallenge.test.ts), 8 tests) |
| [src/components/ChallengeGate.tsx](src/components/ChallengeGate.tsx) | Done | Camera + per-frame detector calls + drives LivenessChallenge; on pass captures one frontal aligned face and emits it. Shared by enroll + match |
| [src/components/ChallengePrompt.tsx](src/components/ChallengePrompt.tsx) | Done | Presentational challenge UI (instruction, both-sides progress ticks, countdown, fail/retry) |
| [src/core/LivenessModel.ts](src/core/LivenessModel.ts) | **DORMANT** | Passive anti-spoof CNN + texture heuristic. Not wired into the gate (model didn't discriminate — see §2). Retained for a possible future advisory layer |
| [src/workers/antispoof.worker.ts](src/workers/antispoof.worker.ts) | **DORMANT** | Hosts LivenessModel. No longer spawned by App.tsx; not bundled while unreferenced |
| [src/components/MatchResultPanel.tsx](src/components/MatchResultPanel.tsx) | Done | Presentational match-outcome panel |
| [public/sw.js](public/sw.js) | Done | Cache-first model caching, stale-while-revalidate app shell, manual invalidation hook |
| [public/models/manifest.json](public/models/manifest.json) | Done | Real sha256/sizes/dims for all 3 models, confirmed against actual ONNX graphs and a real validation run |
| [public/models/detector/scrfd_tiny.onnx](public/models/detector/scrfd_tiny.onnx), [public/models/embedder/mobilefacenet.onnx](public/models/embedder/mobilefacenet.onnx), [public/models/antispoof/antispoof_tiny.onnx](public/models/antispoof/antispoof_tiny.onnx) | Done, committed | Real sourced weights, under `public/` so `vite build` ships them (see §3) — see manifest.json `license` fields before any commercial use |

---

## 2. What's NOT yet verified (be honest about this boundary)

Browser verification covered: app boots, all 3 ONNX sessions create successfully, service worker caches correctly, consent dialogs render and gate correctly, `getUserMedia` is correctly invoked post-consent and its denial/error path is handled gracefully. This was done in a sandboxed preview browser with **no real camera device** — so the following is genuinely untested:

- [x] **Real live camera capture** — tested 2026-06-25, found and fixed several real bugs (frame concurrency §3; anti-spoof crop out of bounds; anti-spoof class index). Detection/alignment/embedding all confirmed working against a live stream.
- [ ] **Head-motion liveness challenge — confirm on a real camera + tune.** The active challenge is implemented, unit-tested, and verified rendering in-browser (both enroll and match reach the challenge gate), but a real human actually completing the turn-both-ways challenge has NOT been observed yet (the sandbox has no camera). On a real camera, check: does a normal head turn reliably cross `turnYawDeg` (16°) in both signs? Is `centerYawDeg` (10°) easy to satisfy for the baseline + frontal capture? Is `totalTimeoutMs` (12s) comfortable? Tune in `config.ts` `liveness.challenge`. The on-screen both-sides progress ticks make this easy to eyeball.
- [ ] **Real enrollment → match round trip** with an actual human face — reachable now (challenge no longer blocks on a broken model); confirm end-to-end.
- [ ] **(Optional / dormant) revive the passive anti-spoof model as an advisory layer.** Not on the critical path anymore — the active challenge is the gate. If you want a passive signal too: the MiniFASNetV2 model outputs ~`[0.000, 0.006, 0.994]` (idx 2) for both a real face AND a static photo (doesn't discriminate). Untested hypotheses: color order (BGR vs RGB — both TS and the Python test fed BGR, so "wrong together" would explain it), crop geometry (`box_w*2.7 × box_h*2.7` rectangle, not `max(w,h)*2.7` square), missing ensemble partner, or conversion output-reorder. **Validating ANY fix requires testing against both a real face and a real spoof.** Files are dormant, not deleted: `LivenessModel.ts`, `antispoof.worker.ts`, the model under `public/models/antispoof/`.
- [ ] **`config.ts` match-threshold tuning** (`matchThreshold: 0.62`) against real accuracy data — see [privacy-and-testing.md](privacy-and-testing.md) §3.1. Still an unvalidated placeholder.
- [ ] **Bias/fairness testing** ([privacy-and-testing.md](privacy-and-testing.md) §3.3) — not started; requires a diverse real-face test set.
- [ ] Cross-browser testing (only exercised on the Chromium-based preview browser so far) and the WASM-only fallback path (only WebGPU/WebGL-capable path has been exercised).

Do this testing with your own (or consenting volunteers') camera before trusting this for anything beyond local development.

---

## 3. Architecture notes worth knowing before you modify this

- **One ONNX model per Web Worker, strictly.** onnxruntime-web's multi-threaded WASM backend (active because `vite.config.ts` sets the COOP/COEP headers needed for `SharedArrayBuffer`) can only host **one** live `InferenceSession` per worker/realm — creating a second session in the same worker, even sequentially after the first finishes, throws `Session already started`. Currently TWO workers are spawned (detector, embedder); a third (`antispoof.worker.ts`) exists but is **dormant** (not spawned). If you revive it or add a model, give it its own worker; don't combine.
- **`ModelManager` also serializes session creation internally** (`sessionCreationQueue` in `ModelManager.ts`) as defense-in-depth against the same class of race if a future change ever calls `getSession()` concurrently for two tasks within one worker — this doesn't replace the one-model-per-worker rule above, it's a second layer.
- **`App.tsx`'s init effect guards against React StrictMode's dev-mode double-invoke** via `initStartedRef`. This matters because `App` acquires expensive resources (workers + wasm-backed ONNX sessions) once for the page's lifetime; don't remove the guard without re-testing under StrictMode.
- **Liveness is an ACTIVE head-motion challenge, not a model.** The gate is `LivenessChallenge` (pure logic) + `ChallengeGate` (driver), fed by the per-frame SCRFD landmarks the detector already returns. Mirror-agnostic (requires a strong yaw in *both* signs, never assumes which is "left"). This replaced the passive CNN, which didn't discriminate live from spoof. The two notes below about the anti-spoof model's crop and class index are now **history about the dormant passive model** — kept because they're the kind of subtle bug that wasted real time, and would matter again if anyone revives it.
- **(Dormant model) `cropWithMargin()`'s source rectangle must be clamped to the frame bounds.** A 2.7x margin around a normal close-up webcam face in a 640x480 capture requests a crop side of ~550-700px, taller than the 480px frame. `drawImage`'s 9-arg form silently clips an out-of-bounds source rect and shrinks the destination, leaving the rest transparent (reads back as black) — fed a malformed crop to the anti-spoof model on every real capture, caught only by live-camera testing. `Aligner.cropWithMargin()` now clamps to `source.width`/`source.height` (param type `ImageBitmap`, not `CanvasImageSource`, so `.width`/`.height` are available). Still used if the passive model is revived.
- **(Dormant model) the anti-spoof model's class index is 1 = real/live, not 0.** Confirmed from minivision-ai's own `test.py`. Relevant only if the passive model is revived.
- **Service worker caches `/models/*` cache-first, forever, until explicitly invalidated.** During development, if you change a model file or `manifest.json` and don't see the change take effect, the service worker's Cache Storage (not the HTTP cache, not the dev server) is almost certainly why — unregister it and clear `caches` via devtools/console, not just a normal reload. This is the single most likely "my fix isn't taking effect" trap when working in this codebase.
- **`CameraCapture` fires frames on a fixed interval regardless of whether the previous frame finished processing.** `ChallengeGate.handleFrame` guards against this with an `isProcessingRef` (drop the new frame, don't queue it) — without that guard, overlapping async calls pile up, race, and previously caused a UI that looked permanently stuck plus a suspected `Cannot read properties of null` crash from concurrent `.run()` on the same onnxruntime-web session. Any new frame-consuming flow needs the same guard.
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
