# Offline Face Recognition — Technical Specification

Status: **Final draft v1.0** — ready for implementation
Audience: Claude Code / implementing engineer
Project name: `facial-recognition`

---

## 1. Purpose and Scope

A browser-based, **fully offline**, local-only face enrollment and recognition component system built with React + TypeScript. The system:

- Detects faces in a live camera feed or static image.
- Aligns and crops detected faces.
- Produces a fixed-length embedding vector per face using an on-device neural network.
- Stores embeddings (never raw images) in an encrypted local IndexedDB store.
- Matches a live face embedding against enrolled embeddings using cosine similarity.
- Performs a lightweight liveness/anti-spoof check before accepting a match or enrollment.
- Runs entirely in the browser with **no network calls** after initial model assets are cached — no telemetry, no cloud inference, no external APIs.

This is a **component system / SDK-style library + demo app**, not a finished product. It is meant to be embedded into a larger application (e.g., a kiosk, an access-control panel, an internal admin tool). The demo `App.tsx` exists to exercise and visually verify the pipeline.

### 1.1 Explicit non-goals

- No server-side component. No backend API. No persistence outside the browser.
- No cloud-based face recognition, no third-party SaaS face APIs.
- Not a security-critical biometric authentication system (e.g., not for unlocking financial transactions or replacing a legal ID check). Treat as **assistive identification**, not as a sole-factor authentication system. See [privacy-and-testing.md](privacy-and-testing.md) for explicit limitations.
- No video recording or persistent storage of raw frames/images by default.
- No mass surveillance use case (continuous scanning of crowds/public spaces against a watchlist). This system is designed for **consensual, single-subject enrollment and verification** (e.g., a person opting in to be recognized by a kiosk they are deliberately interacting with).

### 1.2 Guiding constraints (do not violate)

1. **Offline-first.** After first model download/cache, the app must function with the network disabled (airplane mode test is part of acceptance criteria).
2. **No raw biometric image leaves the device.** Only embeddings (float vectors) and minimal metadata are persisted, and only inside the browser's own storage.
3. **Local-only inference.** All model execution happens in-browser via ONNX Runtime Web (primary) or TensorFlow.js (fallback). No calls to any inference endpoint.
4. **Encrypted at rest.** Anything written to IndexedDB that could re-identify a person (embeddings, labels) is encrypted with a key derived via Web Crypto, not stored in plaintext.
5. **Explicit consent gating.** No enrollment or matching runs without an explicit, logged consent action from the UI.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                              Browser Tab                            │
│                                                                       │
│  ┌───────────────┐    frames     ┌────────────────────────────────┐ │
│  │ CameraCapture │ ───────────▶  │         App (orchestrator)      │ │
│  └───────────────┘                │  - state machine                │ │
│         ▲                         │  - consent gating                │ │
│         │ getUserMedia            │  - routes frames to pipeline    │ │
│         │ (no upload)             └──────────────┬──────────────────┘ │
│                                                   │                   │
│                          postMessage / WorkerBridge RPC               │
│                                                   ▼                   │
│   ┌───────────────────────────────────────────────────────────────┐  │
│   │   Three Web Workers — one ONNX model each (see §4.5 note)      │  │
│   │  ┌────────────────────┐ ┌──────────────────┐ ┌───────────────┐│  │
│   │  │ detector.worker.ts │ │embedder.worker.ts│ │antispoof.work-││  │
│   │  │ FaceDetector(SCRFD)│ │Embedder(MobileFa-│ │er.ts          ││  │
│   │  │ + Aligner (5-pt    │ │ceNet) ONNX RT Web │ │LivenessModel  ││  │
│   │  │ warp + margin crop)│ │                   │ │(MiniFASNetV2) ││  │
│   │  │ ONNX Runtime Web   │ │                   │ │ONNX RT Web    ││  │
│   │  └────────────────────┘ └──────────────────┘ └───────────────┘│  │
│   │              ▲                    ▲                   ▲        │  │
│   │              └────────────────────┴───────────────────┘        │  │
│   │                  each owns its own ModelManager instance        │  │
│   │              (load/cache/select backend, one session each)      │  │
│   └───────────────────────────────────────────────────────────────┘  │
│                                                   │                   │
│                                                   ▼                   │
│                                          ┌──────────────────┐         │
│                                          │   VectorStore     │         │
│                                          │ (IndexedDB + idb) │         │
│                                          │ AES-GCM encrypted │         │
│                                          └──────────────────┘         │
│                                                                       │
│   ┌───────────────────────┐        ┌──────────────────────────────┐ │
│   │   Service Worker        │        │     EnrollmentFlow (UI)       │ │
│   │ caches model bytes,      │        │  consent → capture → quality  │ │
│   │ static assets, app shell │        │  check → embed → store        │ │
│   └───────────────────────┘        └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Data flow summary

1. `CameraCapture` requests `getUserMedia`, renders to a hidden/visible `<video>`, and grabs frames onto an `OffscreenCanvas` (or regular canvas fallback) on a fixed cadence (default 10 FPS for detection, configurable).
2. Frames (as `ImageBitmap`, never as JPEG re-encoded blobs unless explicitly exporting) are transferred (via `postMessage` with transferable objects) to `detector.worker.ts`.
3. Inside `detector.worker.ts`: `FaceDetector` runs SCRFD to get bounding boxes + 5-point landmarks → `Aligner` produces **two** crops per detection from the same source frame — a 112×112 ArcFace-aligned crop (`align()`) for the embedder, and an 80×80 bbox-margin crop (`cropWithMargin()`) for the anti-spoof model, which expects a different, looser crop convention (see §4.4). Both crops are sent back to the main thread together.
4. The main thread (`App`/`EnrollmentFlow`) forwards the 112×112 crop to `embedder.worker.ts` (`Embedder` runs MobileFaceNet → 512-d float embedding, L2-normalized) and the 80×80 crop **plus** the 112×112 crop to `antispoof.worker.ts` (`LivenessModel` runs the anti-spoof CNN on the 80×80 crop and the texture heuristic on the 112×112 crop, combining both into a liveness score) — these two calls run in parallel across the two separate workers.
5. `App` routes results to either `EnrollmentFlow` (store new embedding under a label, after consent + liveness pass) or to a `Matcher` (compare against `VectorStore` contents via cosine similarity, return best match above threshold).
6. `VectorStore` persists encrypted embeddings + metadata (label, enrollment timestamp, model version used) in IndexedDB via `idb`. Raw images/crops are **not** persisted unless the user explicitly enables a debug/export mode (off by default, clearly labeled, separate consent).

**Why three workers, not one pipeline-shaped worker:** onnxruntime-web's multi-threaded WASM backend can only host one live `InferenceSession` per worker — see §4.5 and [offline-model-loading-plan.md](offline-model-loading-plan.md) §3.5 for the discovered constraint and why each model needs its own worker.

---

## 3. Component Inventory

| Component | Responsibility | Location |
|---|---|---|
| `App` | Top-level orchestrator, routing, global state, consent gate | `src/App.tsx` |
| `CameraCapture` | getUserMedia lifecycle, frame grabbing, device selection, permission UX | `src/components/CameraCapture.tsx` |
| `EnrollmentFlow` | Guided multi-step UI: consent → capture → quality gate → confirm → store | `src/components/EnrollmentFlow.tsx` |
| `LivenessChecker` (UI) | Presents liveness prompts (blink/turn) and surfaces pass/fail from worker score | `src/components/LivenessPrompt.tsx` |
| `MatchResultPanel` | Displays match result, confidence, matched label | `src/components/MatchResultPanel.tsx` |
| `ConsentDialog` | Explicit consent UI, see [privacy-and-testing.md](privacy-and-testing.md) for copy | `src/components/ConsentDialog.tsx` |
| `FaceDetector` (core) | Wraps SCRFD ONNX session: preprocess, run, decode boxes/landmarks, NMS | `src/core/FaceDetector.ts` |
| `Aligner` (core) | 5-point similarity transform, canonical crop generation | `src/core/Aligner.ts` |
| `Embedder` (core) | Wraps MobileFaceNet ONNX session: preprocess, run, normalize output | `src/core/Embedder.ts` |
| `LivenessChecker` (core) | Wraps anti-spoof ONNX session + heuristic checks | `src/core/LivenessModel.ts` |
| `VectorStore` (core) | IndexedDB CRUD for embeddings, encryption/decryption, similarity search | `src/core/VectorStore.ts` |
| `ModelManager` (core) | Manifest loading, cache-first fetch, backend selection, warm-up, fallback | `src/core/ModelManager.ts` |
| `CryptoService` (core) | Web Crypto key derivation (PBKDF2/HKDF), AES-GCM encrypt/decrypt helpers | `src/core/CryptoService.ts` |
| `detector.worker.ts` | Worker entry: hosts FaceDetector + Aligner | `src/workers/detector.worker.ts` |
| `embedder.worker.ts` | Worker entry: hosts Embedder only | `src/workers/embedder.worker.ts` |
| `antispoof.worker.ts` | Worker entry: hosts LivenessModel only (split from embedder.worker.ts — see §4.5) | `src/workers/antispoof.worker.ts` |
| `WorkerBridge` | Typed RPC wrapper over postMessage (request/response + transferables) | `src/core/WorkerBridge.ts` |

See [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md) for the full implementation checklist per file.

---

## 4. Model Pipeline Detail

### 4.1 Face Detection — SCRFD (tiny variant)

- **Why SCRFD-tiny:** strong accuracy/speed tradeoff, native multi-scale anchor-free detector, widely available pre-converted ONNX weights, designed for edge/mobile, outputs both boxes and 5-point landmarks in a single pass (no separate landmark model needed).
- **Input:** RGB image, resized + letterboxed to model's expected input (commonly `640×640` or `320×320` for the tiniest variant — confirm exact size against the chosen weight file and record it in `public/models/manifest.json`).
- **Output:** Per detected face — bounding box `[x1, y1, x2, y2]`, confidence score, 5 landmark points (eyes ×2, nose, mouth corners ×2).
- **Post-processing:** confidence threshold (default `0.5`), NMS (IoU threshold default `0.4`), optional minimum face size filter (reject boxes smaller than ~60px at capture resolution to avoid low-quality embeddings).

### 4.2 Alignment

- Use the 5 landmark points to compute a similarity transform (rotation + uniform scale + translation) mapping detected landmarks to a fixed canonical template (standard ArcFace-style 112×112 template coordinates).
- Apply the transform via canvas `drawImage` with a computed affine matrix (or a small warp utility) to produce a **112×112 RGB aligned crop**. This crop is the only "image-like" artifact and lives in memory only — it must not be persisted to IndexedDB or disk by default.
- Reject and request re-capture if landmarks suggest extreme pose (yaw/pitch beyond configurable threshold, derived from landmark geometry) or if eyes are closer together than a minimum pixel threshold (face too small/far).

### 4.3 Embedding — MobileFaceNet

- **Why MobileFaceNet:** purpose-built compact face embedding network (~1–4MB depending on quantization), strong accuracy for its size, standard 112×112 input matching the alignment template, widely available ONNX conversions.
- **Input:** 112×112×3, normalized per the model's training preprocessing (typically `(pixel/255 - 0.5) / 0.5`, i.e. mapped to `[-1, 1]`; confirm exact normalization against chosen weights and document in manifest `preprocessing` field).
- **Output:** 192-d or 128-d float embedding (exact dimension recorded in `public/models/manifest.json` `outputDim`). L2-normalize the output vector before storage/comparison.
- **Distance metric:** cosine similarity (equivalently, dot product of L2-normalized vectors). Default match threshold `0.62` cosine similarity — **must be tuned and documented** against the actual deployed weights per [privacy-and-testing.md](privacy-and-testing.md) accuracy testing plan; ship as a configurable constant, not a magic number buried in code.

### 4.4 Liveness / Anti-Spoof

- **Goal:** reduce trivial spoofing via printed photo or phone-screen replay. This is a **deterrent, not a guarantee** — document this limitation explicitly in UI copy and in [privacy-and-testing.md](privacy-and-testing.md).
- **Model component:** a tiny binary-classification CNN (real vs. spoof) run on the same aligned 112×112 crop (or a slightly larger context crop, e.g., 128×128, if the chosen weights expect it — record in manifest).
- **Heuristic component (no ML, free, always-on as defense in depth):**
  - **Moiré/texture heuristic:** screen replays often show high-frequency moiré patterns; compute a simple frequency-domain or local-variance signal on the crop.
  - **Motion/blink challenge:** for enrollment and high-confidence matches, optionally require a short challenge (e.g., "blink twice" or "turn head slightly") evaluated by tracking landmark movement across a short frame sequence (~1–2 seconds). This is the strongest practical defense available without specialized hardware (depth/IR) and should be the default for **enrollment**; it can be optional/skippable for low-stakes **matching** depending on integrator configuration.
- **Output:** a liveness score `[0,1]`. Default acceptance threshold `0.5`, configurable. Below threshold → block enrollment/match and show a clear, non-accusatory UI message (see consent/UX copy in [privacy-and-testing.md](privacy-and-testing.md)).
- **Explicit limitation to document everywhere:** software-only liveness on commodity RGB webcams cannot reliably defeat sophisticated spoofing (e.g., high-quality masks, deepfake video injection). Do not market or rely on this as strong security; it is a basic-assurance layer appropriate for low/medium-stakes use cases.

### 4.5 Runtime / Inference Engine

- **Primary:** ONNX Runtime Web (`onnxruntime-web`), using the WebGPU execution provider when available, falling back to WebGL, falling back to WASM (with SIMD + multithreading via `wasm` EP flags when supported).
- **Fallback:** TensorFlow.js (`@tensorflow/tfjs`) with WebGL/WASM backend, used only if ONNX Runtime Web fails to initialize on the user's browser (rare; mainly very old browsers or restrictive CSP/COOP-COEP environments that block WASM threads). See [offline-model-loading-plan.md](offline-model-loading-plan.md) §3 for the full selection algorithm.
- All three detector/embedder/liveness models should be exported/converted such that **both** an ONNX (`.onnx`, primary) and, optionally, a TF.js `model.json` + shard set (fallback) exist for each model that needs fallback support. See [public/models/README.md](public/models/README.md) for conversion instructions.
- **One `InferenceSession` per worker, no exceptions.** Confirmed empirically: onnxruntime-web's multi-threaded WASM backend (active here, since `vite.config.ts` sets the COOP/COEP headers `SharedArrayBuffer` requires) throws `Session already started` if a second session is created in a worker that already has one — even sequentially, well after the first session finished. This is why detector/embedder/antispoof each get their own worker (§2 diagram) rather than sharing — an earlier combined embedder+antispoof worker hit this directly. See [offline-model-loading-plan.md](offline-model-loading-plan.md) §3.5.

---

## 5. Data Model

### 5.1 Enrollment record (stored in IndexedDB, encrypted)

```ts
interface EnrollmentRecord {
  id: string;                 // UUID v4, generated client-side
  label: string;              // human-readable name/identifier supplied by integrator/user
  embedding: Float32Array;    // L2-normalized vector; length = manifest.embedder.outputDim
  embeddingModelVersion: string; // must match public/models/manifest.json embedder.version at enroll time
  createdAt: string;          // ISO 8601 timestamp
  updatedAt: string;          // ISO 8601 timestamp
  consentRecordId: string;    // FK to ConsentRecord
  qualityScore: number;       // detector+alignment quality score at capture time, 0-1
  metadata?: Record<string, string | number | boolean>; // integrator-defined, no free-text PII beyond label by convention
}
```

The record above, when persisted, is encrypted as a whole (JSON-serialized, then AES-GCM encrypted) — see §6. Only the `id` and `consentRecordId` are kept as plaintext indexes for lookups; everything else is inside the ciphertext blob.

### 5.2 Consent record

```ts
interface ConsentRecord {
  id: string;                 // UUID v4
  subjectLabel: string;       // matches EnrollmentRecord.label, for traceability
  consentTextVersion: string; // version of the consent copy shown, see privacy-and-testing.md
  consentedAt: string;        // ISO 8601
  scope: 'enrollment' | 'matching' | 'enrollment+matching';
  revoked: boolean;
  revokedAt?: string;
}
```

### 5.3 Match event (optional, off by default — opt-in audit log)

```ts
interface MatchEvent {
  id: string;
  timestamp: string;
  matchedEnrollmentId: string | null; // null if no match above threshold
  similarity: number;
  livenessScore: number;
  outcome: 'match' | 'no-match' | 'liveness-failed' | 'low-quality';
}
```

Match events are **not retained by default** (privacy-by-default). An integrator may explicitly enable a bounded, time-limited local audit log (e.g., last N events or last N days, auto-pruned) for operational debugging — this must be a deliberate opt-in surfaced in configuration, not the default behavior, and documented to the end user per [privacy-and-testing.md](privacy-and-testing.md).

---

## 6. Storage and Security

### 6.1 IndexedDB schema (via `idb`)

- Database name: `face-recognition-db`
- Object stores:
  - `enrollments` — keyPath `id`, indexes on `label` (non-unique) for lookup convenience (label itself is **not** encrypted at the index level in the default design — if label is sensitive, integrators should pass an opaque ID as label and store the human-readable name only in their own system; document this tradeoff explicitly in README).
  - `consents` — keyPath `id`, index on `subjectLabel`.
  - `matchEvents` — keyPath `id`, index on `timestamp` (only created if audit log opt-in is enabled).
  - `meta` — keyPath `key`; stores schema version, crypto salt, model-version pins, etc.

### 6.2 Encryption

- **Key derivation:** Web Crypto `PBKDF2` (or `HKDF` if a high-entropy device-bound secret is available) deriving an AES-GCM 256-bit key from a passphrase/passkey provided by the integrator's host application, combined with a random salt stored in the `meta` store. **The library does not invent its own passphrase UX** — it exposes `CryptoService.initialize(passphrase: string)` and the host app decides how to obtain that passphrase (e.g., device PIN, OS keychain via WebAuthn-backed wrapping key, or an admin-set facility passphrase). Default fallback if no passphrase is supplied: derive from a per-browser-profile random key generated once via `crypto.getRandomValues` and stored non-extractably where possible (`CryptoKey` with `extractable: false`, persisted via the Web Crypto `wrapKey`/IndexedDB pattern) — this protects against casual inspection of IndexedDB contents but **does not** protect against a local attacker with full device access; document this honestly.
- **Algorithm:** AES-GCM, 256-bit key, random 96-bit IV per encryption operation (never reused), IV stored alongside ciphertext (it is not secret).
- **What is encrypted:** the serialized `EnrollmentRecord` payload (embedding + metadata), and the serialized `ConsentRecord` payload. The `id` keys used for IndexedDB lookups are plaintext UUIDs (no information leakage beyond random identifiers).
- **What is never written anywhere:** raw camera frames, aligned face crops, JPEG/PNG exports — unless an explicit "debug export" feature is enabled by the integrator, which must show its own dedicated consent text distinct from normal enrollment consent.

### 6.3 Deletion / right-to-erasure

- `VectorStore.deleteEnrollment(id)` must hard-delete (not soft-delete/tombstone) the record and, if it was the last enrollment, allow full DB teardown via `VectorStore.wipeAll()`. Provide a UI affordance for this (see [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md)).
- Revoking a `ConsentRecord` must cascade-delete the associated `EnrollmentRecord`(s) — consent withdrawal removes the biometric data, it does not just flag it.

---

## 7. Performance Targets

| Stage | Target (mid-range laptop, WebGPU/WebGL) | Target (low-end / WASM-only) |
|---|---|---|
| Detection (per frame) | < 30ms | < 120ms |
| Alignment | < 5ms | < 15ms |
| Embedding | < 20ms | < 80ms |
| Liveness model | < 15ms | < 60ms |
| End-to-end (detect→match) | < 80ms (12+ FPS feel) | < 300ms (still usable, not real-time) |
| Cold model load (all 3 models, cache hit) | < 1.5s | < 4s |
| Cold model load (cache miss, first run, local network) | depends on file size, see §9 sizes; show progress UI | — |

These are targets to validate against in [privacy-and-testing.md](privacy-and-testing.md) §3 performance testing, not hard guarantees — actual numbers depend on chosen quantized weights and must be re-measured once real model files are placed in `public/models/`.

---

## 8. State Machine (App-level)

```
IDLE
  → (user opens enrollment) CONSENT_PENDING
      → (consent granted) CAPTURING
          → (quality+liveness pass) REVIEW
              → (user confirms) STORING → ENROLLED → IDLE
          → (quality/liveness fail, retry budget left) CAPTURING
          → (retry budget exhausted) FAILED → IDLE
      → (consent denied) IDLE

  → (user opens matching) MATCH_CONSENT_PENDING   [if matching scope requires separate consent]
      → (consent granted / already on file) MATCHING
          → (face found, liveness pass) COMPARING
              → (similarity ≥ threshold) MATCHED → IDLE
              → (similarity < threshold) NO_MATCH → IDLE
          → (liveness fail) LIVENESS_BLOCKED → IDLE
      → MATCH_CANCELLED → IDLE
```

Each transition must be a discrete, testable function; the state machine should be implemented as a small reducer (`useReducer`) in `App.tsx` or extracted to `src/core/AppStateMachine.ts` if it grows complex. No hidden/implicit state in component-local `useState` for anything that affects the consent/security flow.

---

## 9. Model Manifest Summary

Full machine-readable detail lives in [public/models/manifest.json](public/models/manifest.json). Real, sourced, validated as of 2026-06-24 (see §13 — this table previously listed pre-sourcing placeholders; values below are confirmed against the actual committed weight files):

| Model | Architecture | Input | Output | Quantization | Actual size |
|---|---|---|---|---|---|
| Detector | SCRFD-500MF (InsightFace buffalo_sc) | 320×320×3 (dynamic-shape graph, see notes) | 9 tensors: boxes+scores+5pt landmarks × 3 strides | fp32 (not yet quantized) | 2.52 MB |
| Embedder | MobileFaceNet (InsightFace w600k_mbf) | 112×112×3 | 512-d float vector (not pre-normalized) | fp32 (not yet quantized) | 13.6 MB |
| Anti-spoof | MiniFASNetV2 (minivision-ai Silent-Face-Anti-Spoofing) | 80×80×3, BGR, bbox-margin crop (not the 112 ArcFace crop) | 3-class raw logits, **index 1 = real/live** (confirmed from upstream source, not 0 — see public/models/manifest.json antispoof.outputs) | fp32 (not yet quantized) | 1.74 MB |

Total committed model payload: **~17.9 MB** combined — larger than the original ~5 MB target because the embedder turned out to be 13.6 MB unquantized (512-d MobileFaceNet, not the smaller variant originally guessed) and none of the three are quantized yet. Quantizing per [public/models/README.md](public/models/README.md) would shrink this meaningfully; not yet done, re-validate accuracy if you do it. See [offline-model-loading-plan.md](offline-model-loading-plan.md) for caching strategy.

---

## 10. Browser / Environment Support Matrix

| Browser | WebGPU | WebGL2 | WASM SIMD+threads | Notes |
|---|---|---|---|---|
| Chrome/Edge 113+ | Yes | Yes | Yes | Primary target, full feature set |
| Firefox 121+ | Behind flag (varies) | Yes | Yes | WebGL/WASM path expected primary |
| Safari 17+ | Partial/experimental | Yes | Yes (no threads pre-17) | Test WASM single-thread fallback |
| Mobile Chrome (Android) | Varies by device | Yes | Yes | Validate thermal throttling behavior |
| Mobile Safari (iOS) | No (as of spec writing) | Yes | Limited threading | WASM single-thread path required |

Cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`) is required for WASM threads (`SharedArrayBuffer`). The dev server and any deployment target must set these headers; see [offline-model-loading-plan.md](offline-model-loading-plan.md) §3.4 and [README.md](README.md) deployment notes.

---

## 11. Configuration Surface

All tunables should live in a single typed config object (`src/core/config.ts`), not scattered magic numbers:

```ts
export interface FaceRecognitionConfig {
  detection: {
    scoreThreshold: number;       // default 0.5
    nmsIouThreshold: number;      // default 0.4
    minFaceSizePx: number;        // default 60
  };
  alignment: {
    templateSize: 112;
    maxYawDeg: number;            // default 35
  };
  embedding: {
    matchThreshold: number;       // default 0.62 (cosine similarity)
  };
  liveness: {
    minScore: number;             // default 0.5
    requireChallengeOnEnroll: boolean; // default true
    requireChallengeOnMatch: boolean;  // default false
  };
  runtime: {
    preferred: 'webgpu' | 'webgl' | 'wasm';
    allowTfjsFallback: boolean;   // default true
  };
  storage: {
    auditLogEnabled: boolean;     // default false
    auditLogMaxEntries: number;   // default 0 (disabled)
  };
}
```

Defaults above are starting points for implementation; all must be re-validated against [privacy-and-testing.md](privacy-and-testing.md) accuracy/bias testing before any production use.

---

## 12. Acceptance Criteria

- [ ] App functions with network fully disabled after first model cache (manual airplane-mode test).
- [ ] No `fetch`/`XHR` calls observed in browser devtools Network tab during enrollment or matching flows, except the initial model fetch (cache-first, only on first load or explicit re-check).
- [ ] No raw images/crops present in IndexedDB inspection (Application tab) after a full enroll+match cycle, unless debug export explicitly enabled.
- [ ] Deleting an enrollment removes all associated encrypted data; verified via direct IndexedDB inspection.
- [ ] Consent must be granted before any frame is sent to the detection worker; verified via code path trace and a UI test that blocks camera start until consent dialog is accepted.
- [ ] Liveness check blocks low-liveness-score attempts from enrolling or matching, with a clear non-accusatory message.
- [ ] Detection + embedding pipeline runs end-to-end on at least Chrome (WebGPU or WebGL path) and one WASM-only forced path (manually disable WebGPU/WebGL to test fallback).
- [ ] All file contents in this repository match the [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md) checklist; nothing referenced here is left unimplemented without a tracked TODO.

---

## 13. Resolved Decisions (were "Open Questions," now settled with real weights in hand)

These were originally deferred pending real model files; resolved 2026-06-24 by sourcing, inspecting, and validating the actual weights (see `public/models/manifest.json` `validationNotes`):

1. **SCRFD input resolution: 320×320**, chosen and validated working (the graph itself is dynamic-shape; 320 was picked for speed over the more common 640 default — re-detection accuracy on small/far faces not yet measured against the 640 alternative).
2. **MobileFaceNet output dimension: 512**, not 128 or 192 as originally guessed. `public/models/manifest.json` and code (which reads the dimension from the manifest rather than hardcoding it) already reflect this.
3. **Anti-spoof input: 80×80, NOT 112×112**, and critically uses a **different crop** than the embedder (bbox-centered, 2.7x margin, BGR) rather than the ArcFace-aligned crop — see §4.4 and §2's data flow. This was the biggest surprise relative to the original placeholder assumptions.
4. **`matchThreshold` and `liveness.minScore` are still NOT empirically tuned** — this one item remains genuinely open. The values in `config.ts` (0.62, 0.5) are still untested defaults; do the work in [privacy-and-testing.md](privacy-and-testing.md) §3.1 before trusting them.

New open item discovered during implementation, not on the original list: **one `InferenceSession` per worker is a hard onnxruntime-web constraint** (§4.5, §2) — budget for N workers for N models, not fewer.

---

## 14. Document Index

- [README.md](README.md) — quickstart, setup, model download/offline instructions.
- [offline-model-loading-plan.md](offline-model-loading-plan.md) — service worker caching, runtime selection, sharding, warm-up, fallback.
- [privacy-and-testing.md](privacy-and-testing.md) — privacy checklist, consent copy, accuracy/performance/bias test plan.
- [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md) — file-by-file implementation checklist.
- [public/models/manifest.json](public/models/manifest.json) — machine-readable model registry.
- [public/models/README.md](public/models/README.md) — how to source, convert, and quantize models.
- [scripts/create-project.sh](scripts/create-project.sh) — project bootstrap script.
