# Offline Model Loading Plan

Companion to [offline-face-recognition-spec.md](offline-face-recognition-spec.md) §4.5 and §9. Describes exactly how model bytes get from "somewhere on disk/network, once" to "running inference fully offline, every subsequent load." Implemented across [public/sw.js](public/sw.js) and [src/core/ModelManager.ts](src/core/ModelManager.ts).

---

## 1. Two supported deployment modes

This system supports two distinct ways of getting model bytes onto the device, and the implementation must not assume only one of them:

### Mode A — Service-worker cached (default, documented in README.md)

Model files are fetched once (normal HTTP GET to the app's own origin — never a third-party CDN) and cached by the service worker. Every subsequent load is served from Cache Storage with zero network requests. This is the right mode for a normal web deployment where users visit a URL.

### Mode B — Bundled static assets / air-gapped

Model files are placed directly under `public/models/` before the app is ever served, e.g. for a kiosk or air-gapped install where you don't want to depend on a successful first-run fetch at all. In this mode the service worker's model-caching logic is a no-op (cache-first already finds nothing to fetch because the files are same-origin static assets served directly), but you may also disable service worker registration entirely if you want a guarantee of zero network code paths.

**This project actually runs in Mode B today** (the committed weights live in `public/models/`), not Mode A as the original draft of this doc implied — and the directory **must** be under `public/`, not a project-root `models/`. Vite's dev server serves the entire project root, so a project-root `models/` works fine under `npm run dev` and silently masks the problem; `vite build` only copies `public/`'s contents verbatim into `dist/` plus whatever the JS module graph statically references, and `fetch('/models/manifest.json')` is a runtime string Vite's bundler can't see, so a project-root `models/` directory simply vanishes from the production build. Discovered exactly this way (`npm run build && npm run preview` → `Unexpected token '<' ... is not valid JSON`, because the 404 fell through to the SPA's `index.html` fallback) — fixed by moving the directory, no application code changed.

`ModelManager.loadManifest()` and the per-model fetch in `getSession()` use a same-origin relative URL (`/models/manifest.json`, `/models/<task>/<file>`) in both modes — the only difference is whether that URL is answered by the service worker's cache, the static file server, or a one-time network fetch that the service worker then captures. No code branches on which mode is active; the modes differ only in *deployment/ops*, not in application logic.

---

## 2. Service worker caching strategy

Implemented in [public/sw.js](public/sw.js).

### 2.1 Cache partitioning

Two named caches, intentionally separate:

- `app-shell-v1` — HTML/JS/CSS bundle, stale-while-revalidate (serve cached immediately, refresh in background for next load). App code changes more often than model weights; this keeps reloads instant while still picking up new builds promptly.
- `models-v1` — model binaries, cache-first with no automatic revalidation (serve cached forever until explicitly invalidated — see §2.3). Model weights are large and effectively immutable per version; there's no reason to ever race a network request against the cache for these.

### 2.2 First fetch + integrity check

When `ModelManager.getSession(task)` triggers the first fetch of a model file (cache miss):

1. Browser issues `fetch('/models/<task>/<file>')`.
2. `sw.js`'s `cacheFirstModels()` handler lets the request through to the network (cache was empty), receives the response, and — **before** trusting it — the caller (`ModelManager`, not the service worker itself) should verify byte size and, if `manifest.json`'s `sha256` field is populated (not the placeholder), verify the checksum via `crypto.subtle.digest('SHA-256', bytes)`. Only after verification does the response get treated as valid; the service worker has already opportunistically cached it at this point, so on a checksum failure the implementation must explicitly evict that cache entry (`caches.open('models-v1').then(c => c.delete(request))`) rather than leaving a corrupt file cached.
3. This integrity step is a TODO in `ModelManager.getSession()` (see the TODO block in [src/core/ModelManager.ts](src/core/ModelManager.ts)) — wire it in alongside the real `ort.InferenceSession.create()` call, not as an afterthought, since a silently-corrupt cached model is worse than a failed fetch (it may load and run but produce wrong embeddings).

### 2.3 Versioning and invalidation

`manifest.json`'s top-level `manifestVersion` and each model entry's own `version` field are the source of truth for "is this a different model than what's cached":

- On app load, fetch `manifest.json` itself (small, always network-checked subject to the shell's stale-while-revalidate — i.e. you may run one load behind on the manifest itself, which is acceptable since model files are large and you don't want every load blocked on a manifest round-trip).
- Compare each model entry's `version` against a value stashed in IndexedDB's `meta` store (`modelVersions.<task>`) from the last successful load.
- If unchanged: trust the cache, skip any network involvement entirely (true offline path).
- If changed: post a `{ type: 'INVALIDATE_MODEL', url: '/models/<task>/<file>' }` message to the service worker (see the `message` handler in `sw.js`) to evict just that one cache entry, then let the next `getSession()` call re-fetch it. This avoids a full cache wipe (and re-download of all three models) when only one changed.
- Update the stashed `meta` version only after the new file is fetched **and** integrity-verified — never optimistically.

### 2.4 What is deliberately NOT cached

Raw camera frames, aligned face crops, and embeddings are never passed through `fetch`/Cache Storage — they never touch the service worker at all. The service worker's `fetch` handler only ever sees GET requests for static assets and `/models/*` files; there is no code path by which biometric data could end up in Cache Storage. This is a structural guarantee, not just a convention — re-verify it holds if you ever add new fetch traffic to the app.

---

## 3. Runtime / execution-provider selection

Implemented in `detectBackend()` and `ModelManager.selectBackend()` in [src/core/ModelManager.ts](src/core/ModelManager.ts).

### 3.1 Decision tree

```
preferred = config.runtime.preferred  (default: 'webgpu')

1. If preferred is 'webgpu' AND navigator.gpu exists:
     try navigator.gpu.requestAdapter()
     if adapter resolves -> use WebGPU execution provider
     else -> fall through to step 2
2. If a WebGL2 context can be created on a throwaway canvas:
     -> use WebGL execution provider
3. Otherwise:
     -> use WASM execution provider (always available as the universal fallback)
```

This selection happens **once per worker, at `init`**, not per-frame — re-selecting backends per inference call would be wasteful and could cause mid-session model-session churn. If a session creation later fails unexpectedly on the selected backend (e.g. a WebGPU device-lost event), the implementation should fall back one tier down (WebGPU→WebGL→WASM) and recreate sessions rather than crash the pipeline — this is a TODO in `ModelManager.getSession()`, not yet wired up; track it in [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md).

### 3.2 ONNX Runtime Web execution provider mapping

| Backend (internal) | onnxruntime-web `executionProviders` value |
|---|---|
| `webgpu` | `['webgpu']` |
| `webgl` | `['webgl']` |
| `wasm` | `['wasm']` (with `ort.env.wasm.numThreads` set per §3.4) |

### 3.3 TF.js fallback trigger

TF.js (`@tensorflow/tfjs`) is only invoked if **ONNX Runtime Web session creation itself throws** (not merely "WebGPU unavailable" — that's handled by stepping down execution providers within ORT itself per §3.1). Realistic triggers for this deeper fallback:

- A CSP that blocks WASM compilation entirely (`unsafe-eval`-adjacent restrictions).
- A very old browser lacking even WASM support.
- A corrupted/incompatible ONNX file for the runtime version in use.

When this happens and `config.runtime.allowTfjsFallback` is true, `ModelManager` should load the corresponding `tfjsFile` path from the manifest entry (`mobilefacenet_tfjs/model.json` etc.) via `tf.loadGraphModel()`, and the calling code (`FaceDetector`/`Embedder`/`LivenessModel`) must treat the TF.js model's `.predict()`/`.execute()` call as a drop-in replacement behind the same method signature — this is why those classes hold `private session: unknown` rather than a concretely-typed ORT session, so the underlying engine can be swapped without changing the public interface. If `allowTfjsFallback` is false (or the TF.js shards are also missing), surface a clear "this browser cannot run the model" error to the UI rather than silently failing.

### 3.4 WASM threading and cross-origin isolation

The WASM execution provider's multi-threaded path requires `SharedArrayBuffer`, which requires cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) — already set in [vite.config.ts](vite.config.ts) for dev/preview; must be replicated at your production host. When these headers are absent (e.g. a host that can't set them), `onnxruntime-web` falls back to single-threaded WASM automatically — slower but correct. `ModelManager` does not need special-case code for this; it's handled inside the `onnxruntime-web` package itself based on `crossOriginIsolated` at runtime. Do surface the detected thread count somewhere in a debug/diagnostics view so performance regressions on misconfigured hosts are easy to spot — see [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md) for a suggested diagnostics panel.

### 3.5 One InferenceSession per worker — a hard constraint, discovered the hard way

With multi-threading enabled (§3.4), onnxruntime-web's WASM backend can only have **one live `InferenceSession` per worker/realm**. Calling `ort.InferenceSession.create()` a second time in the same worker — even sequentially, well after the first session finished initializing — throws `Session already started`. This is a constraint of the underlying Emscripten pthread-pool bootstrap, not a bug in application code, and it is **not** about concurrency: serializing the two `create()` calls with `await` back-to-back does not avoid it.

The practical consequence: **give every model its own worker.** This project originally combined the embedder and anti-spoof models into one worker (mirroring the spec's original 2-worker diagram); that combination reliably failed with this error, and the fix was to split it into `embedder.worker.ts` (embedder only) and `antispoof.worker.ts` (liveness only) — three workers total, matching the three models. `ModelManager.getSession()` additionally serializes its own internal session-creation calls via a queue (`sessionCreationQueue`) as defense-in-depth, but that alone does **not** fix the one-worker/one-model constraint — the queue only prevents two *concurrent* calls from racing within a single worker; it can't make a second *sequential* session creation succeed where the backend itself refuses it.

If you ever consider reducing the worker count again (e.g. to cut per-worker memory overhead), re-test this specific failure mode before doing so — it reproduces reliably and is easy to forget about once the three-worker split is working.

---

## 4. Model sharding

At the sizes in [public/models/manifest.json](public/models/manifest.json) (each model well under 3 MB even unquantized, see §9 of the spec), **sharding is not necessary for the ONNX files** — a single `fetch` per model is simpler and has less overhead than splitting into chunks. Do not introduce manual sharding for the primary ONNX artifacts unless a future model swap pushes a single file past roughly 15–20 MB (at which point chunked fetch + cache lets you show incremental progress and resume partial downloads more gracefully).

**TF.js fallback exports are the one place sharding already happens by default** — `tensorflowjs_converter` automatically splits weights into ~4 MB shard files (`group1-shard1of2.bin`, etc.) referenced from `model.json`. No custom logic is needed for this: `tf.loadGraphModel()` reads `model.json` and fetches each shard itself, and the service worker's cache-first-for-`/models/`-paths rule applies uniformly to every shard URL since they all live under the same `/models/<task>/..._tfjs/` path prefix.

If you later add a higher-capacity embedder (e.g. swapping MobileFaceNet for a larger architecture) and it crosses the size threshold above, the pattern to follow is: split the `.onnx` file into N byte-range chunks at build/release time, list each chunk's URL + byte range in a new manifest field (e.g. `shards: [{url, byteOffset, byteLength}]`), fetch+cache each independently (parallelizable, resumable), and reassemble into a single `ArrayBuffer` before handing it to `ort.InferenceSession.create()`. This is **not implemented** in the current scaffold — it's a deliberate non-goal until a real model size requires it, to avoid premature complexity (see project-level guidance against speculative abstraction).

---

## 5. Warm-up

Cold-starting an inference session pays a real cost beyond the file fetch: shader compilation (WebGPU/WebGL) and JIT/AOT compilation (WASM) happen lazily on the *first* `session.run()` call, not at session creation. Left unaddressed, this means the user's first real face capture eats an extra 200ms-1s+ latency spike compared to subsequent frames.

`ModelManager.warmUp(tasks)` (currently a TODO stub, see [src/core/ModelManager.ts](src/core/ModelManager.ts)) should, immediately after each session is created and before the UI signals "ready":

1. Build a zero-filled (or random-filled — zero can sometimes hit fast-path shortcuts in some backends that skew timing, random is more representative) input tensor matching the model's `inputSize` from the manifest.
2. Call `session.run()` once and discard the result.
3. Only resolve `warmUp()` after all requested tasks complete their dummy run.

Both worker entry files ([src/workers/detector.worker.ts](src/workers/detector.worker.ts), [src/workers/embedder.worker.ts](src/workers/embedder.worker.ts)) should call `modelManager.warmUp([...])` as the last step of their `init` RPC handler, so the main thread's `await detectorBridge.call('init', {})` doesn't resolve until warm-up is actually done — this makes "ready" in the UI mean what it says, rather than "ready" being followed by a janky first frame.

---

## 6. Fallback behavior summary table

| Failure point | Fallback |
|---|---|
| WebGPU adapter request fails/unavailable | Step down to WebGL execution provider |
| WebGL2 context creation fails | Step down to WASM execution provider |
| `ort.InferenceSession.create()` throws on any EP | If `allowTfjsFallback`: load TF.js graph model from manifest `tfjsFile`. Else: surface error to UI. |
| Model file fetch fails (offline + not yet cached) | Surface a clear "models not available offline yet — connect once to download" message; do not silently degrade to a non-functional state. |
| Checksum mismatch on a fetched/cached model | Evict the cache entry, retry fetch once, then surface an error if it mismatches again (likely a corrupt source file, not a transient network issue). |
| Camera permission denied | `CameraCapture` surfaces an explicit denied state (see component); no pipeline code runs without frames. |
| Liveness score below threshold | Block enroll/match, show non-accusatory retry message — never silently accept a low-liveness capture. |

---

## 7. Diagnostics surface (recommended, not yet implemented)

For debugging which backend/fallback path is actually active on a given device, expose (e.g. behind a debug flag or a hidden settings panel, never in normal end-user UI):

- `ModelManager.getBackend()` result.
- Whether `crossOriginIsolated` is true (predicts WASM threading availability).
- Per-model: cache hit/miss on last load, and warm-up duration.

This is listed as a TODO in [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md) rather than implemented here, since it's an operational nice-to-have, not a correctness requirement.
