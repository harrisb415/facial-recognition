# facial-recognition

Offline, local-only face enrollment and recognition components for React + TypeScript. No cloud inference, no telemetry, no network calls once model files are cached. All inference runs in-browser via ONNX Runtime Web (WebGPU → WebGL → WASM), with an optional TensorFlow.js fallback.

Full design docs:

- [offline-face-recognition-spec.md](offline-face-recognition-spec.md) — full technical spec (read this first).
- [offline-model-loading-plan.md](offline-model-loading-plan.md) — caching, runtime selection, fallback behavior.
- [privacy-and-testing.md](privacy-and-testing.md) — privacy checklist, consent copy, test plan.
- [FILE_MAP_AND_TODO.md](FILE_MAP_AND_TODO.md) — implementation checklist.
- [public/models/README.md](public/models/README.md) — how to obtain and convert model weights.

---

## 0. Before you start

Model weight files **are** committed to this repo (`public/models/detector/scrfd_tiny.onnx`, `public/models/embedder/mobilefacenet.onnx`, `public/models/antispoof/antispoof_tiny.onnx` — ~17.9 MB total, sourced from InsightFace and minivision-ai, see [public/models/README.md](public/models/README.md) for provenance). `npm install && npm run dev` is enough to get a fully working app — no model-sourcing step required. **Read the license fields in [public/models/manifest.json](public/models/manifest.json) before any commercial use** — the detector and embedder weights are InsightFace's stated non-commercial-research-use-only models; the anti-spoof model is Apache-2.0.

If you swap in different weights later, [public/models/README.md](public/models/README.md) still has the sourcing/conversion/quantization instructions.

Models live under `public/` rather than a project-root `models/` specifically so `vite build` actually includes them in the production bundle — Vite only ships `public/` contents and JS-bundled assets, not arbitrary root-level directories fetched at runtime. If you ever see `Unexpected token '<' ... is not valid JSON` after `npm run build && npm run preview`, it means a model file isn't reachable in the build output — check it's under `public/models/`, not `models/`.

## 1. Requirements

- Node.js 20+ and npm 10+ (or pnpm/yarn — scripts below use npm).
- A Chromium-based browser (Chrome/Edge 113+) recommended for first development pass — best WebGPU/WebGL support. Firefox/Safari supported via fallback paths, see spec §10.
- No internet connection required at runtime, but you do need one **once** to `npm install` dependencies (model weights are already committed, no separate download step).

## 2. Quickstart

```bash
# 1. Install dependencies (one-time, requires network)
npm install

# 2. Start the dev server
npm run dev

# 3. Open the printed local URL (typically http://localhost:5173) in Chrome/Edge.
#    Grant camera permission when prompted.
```

To verify the app is truly offline-capable: after the first successful load (models cached by the service worker, see §4), disable your network connection (or use devtools "Offline" throttling) and reload. The app must continue to function — this is part of the acceptance criteria in the spec.

## 3. Building for production

```bash
npm run build      # outputs static assets to dist/
npm run preview    # serves dist/ locally to sanity-check the production build
```

Deploy `dist/` as static files to any host. There is no server-side component. See §5 below for required HTTP headers if you want WASM threading (multi-threaded WASM execution provider) to work.

## 4. Offline / caching setup

The app registers a service worker (see [offline-model-loading-plan.md](offline-model-loading-plan.md)) that:

1. Precaches the app shell (HTML/CSS/JS bundle) using a standard cache-first strategy.
2. Cache-first fetches each model file listed in `public/models/manifest.json` on first run, verifies byte size (and checksum if provided in the manifest), and stores it in the Cache Storage API under a versioned cache name (e.g., `models-v1`).
3. On subsequent loads, serves models directly from cache — zero network requests for inference.
4. Detects manifest version bumps and re-fetches only the models whose `version` field changed (not the whole bundle).

No action is required from you beyond running the app once while online (or with model files served from your own local dev server, which still counts as "the app's origin" for caching purposes — no external network call to a third party is ever made; the manifest is configured to resolve model URLs relative to your own deployment, not a remote CDN).

If you want a fully airtight offline-from-first-boot experience (no network step at all, ever — e.g., for an air-gapped kiosk), skip service-worker caching entirely and rely on the model files already being static assets bundled into your build (they are, by virtue of living under `public/models/`); the `ModelManager` checks local static paths before falling back to a network fetch + cache flow. See [offline-model-loading-plan.md](offline-model-loading-plan.md) §2 for both modes.

## 5. Cross-origin isolation (required for multi-threaded WASM)

To enable `SharedArrayBuffer` (used by ONNX Runtime Web's multi-threaded WASM execution provider), your dev/prod server must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`vite.config.ts` in this scaffold already sets these headers for `npm run dev` and `npm run preview`. If you deploy to a static host (Netlify, Vercel, S3+CloudFront, nginx, etc.), you must configure the equivalent response headers yourself — see comments in `vite.config.ts` for the exact header block to replicate at your host's config layer. Without these headers, the app still works, just falls back to single-threaded WASM (slower, see runtime selection logic in the model loading plan).

## 6. Project structure

```
facial-recognition/
├── offline-face-recognition-spec.md   # full technical spec — read first
├── offline-model-loading-plan.md      # caching / runtime selection plan
├── privacy-and-testing.md             # privacy checklist + test plan
├── FILE_MAP_AND_TODO.md               # implementation checklist
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── scripts/
│   └── create-project.sh              # bootstrap script (re-runnable, idempotent)
├── public/                            # vite ships this verbatim — models MUST live here, not at repo root
│   ├── sw.js                          # service worker (model + asset caching)
│   └── models/
│       ├── manifest.json              # model registry (filenames, sizes, dims, quantization)
│       ├── README.md                  # how to source/convert/quantize models
│       ├── detector/scrfd_tiny.onnx       # committed — InsightFace SCRFD-500MF
│       ├── embedder/mobilefacenet.onnx    # committed — InsightFace MobileFaceNet
│       └── antispoof/antispoof_tiny.onnx  # committed — minivision-ai MiniFASNetV2
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── components/                    # CameraCapture, EnrollmentFlow, ConsentDialog, etc.
    ├── core/                          # FaceDetector, Aligner, Embedder, VectorStore, ModelManager, CryptoService
    ├── workers/                       # detector.worker.ts, embedder.worker.ts, antispoof.worker.ts (one ONNX model each — see FILE_MAP_AND_TODO.md §3)
    ├── styles/
    └── types/
```

## 7. Key npm scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start Vite dev server with COOP/COEP headers |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint over `src/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run unit tests (Vitest) |

## 8. Privacy and consent — read before integrating

This system handles biometric data. Before wiring it into any real product, read [privacy-and-testing.md](privacy-and-testing.md) in full — it contains the required consent UX copy, the privacy checklist (data minimization, encryption, deletion, retention), and the bias/fairness testing plan. Do not ship enrollment or matching flows without working consent gating; the spec (§6 "Guiding constraints") treats this as a hard requirement, not a nice-to-have.

## 9. License / model licensing note

The committed SCRFD/MobileFaceNet weights (InsightFace) are **non-commercial research use only** per InsightFace's stated policy; the anti-spoof weight (minivision-ai, via an ONNX conversion) is Apache-2.0. See [public/models/manifest.json](public/models/manifest.json)'s `license` field on each entry for the verification link. If you swap in different weights, the same rule applies — check the specific pre-trained weight distribution you use, since training-data provenance and license terms vary by source. Verify license compatibility with your use case before distributing a build that bundles model weights.
