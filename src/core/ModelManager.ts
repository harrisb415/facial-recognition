// Loads models/manifest.json, picks the best available execution backend,
// creates ONNX Runtime Web inference sessions, and performs a warm-up
// inference. See offline-model-loading-plan.md for the full caching/fallback
// algorithm this implements a slice of.

// 'onnxruntime-web/all' (not the bare package) — bundles wasm+webgl+webgpu
// execution providers from a single JSEP-enabled wasm binary. The bare
// package only includes the wasm/cpu EP, which would silently make
// 'webgpu'/'webgl' execution providers no-ops. See
// offline-model-loading-plan.md §3.
//
// Deliberately NOT setting ort.env.wasm.wasmPaths: both Vite dev (serving
// the .wasm/.mjs pair straight from node_modules) and `vite build` (Rollup
// statically detects the internal new URL(...) reference and emits a
// correctly-hashed asset, verified in dist/assets/) resolve onnxruntime-web's
// own asset path correctly without help. An earlier attempt to force this
// via a public/ copy + explicit wasmPaths broke dev mode — Vite refuses to
// import JS modules (the .jsep.mjs glue file) from public/, only serve them
// as opaque static files — so don't reintroduce that without re-checking
// both dev and build still work.
import * as ort from 'onnxruntime-web/all';
import type { RuntimeBackend } from '../types';

export interface ModelManifestEntry {
  name: string;
  task: 'detector' | 'embedder' | 'antispoof';
  format: 'onnx' | 'tfjs';
  version: string;
  file: string;
  tfjsFile?: string | null;
  inputSize: number;
  outputDim?: number | null;
  quantization: string;
  approxSizeBytes: number;
  sha256?: string;
  preprocessing: {
    mean: number[];
    std: number[];
    colorOrder: 'RGB' | 'BGR';
  };
  /** SCRFD-specific decode parameters. Only present on the detector entry. */
  decode?: {
    architecture: string;
    featStrideFpn: number[];
    numAnchors: number;
    useKps: boolean;
    scoreActivation: string;
    outputOrder: string;
    bboxFormat: string;
    kpsFormat: string;
  };
  /** Non-standard crop convention (e.g. anti-spoof's bbox-margin crop). Absent = use the default 112 ArcFace alignment. */
  crop?: {
    strategy: 'arcface-112' | 'bbox-margin';
    marginScale: number;
    note: string;
  };
  outputs?: Record<string, string>;
  license: string;
  notes?: string;
}

export interface ModelManifest {
  manifestVersion: string;
  generatedAt: string;
  models: ModelManifestEntry[];
}

async function detectBackend(preferred: RuntimeBackend): Promise<RuntimeBackend> {
  if (preferred === 'webgpu' && 'gpu' in navigator) {
    try {
      const adapter = await (
        navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }
      ).gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // fall through to webgl/wasm
    }
  }

  const canvas = document.createElement('canvas');
  const webgl2 = canvas.getContext('webgl2');
  if (webgl2) return 'webgl';

  return 'wasm';
}

function backendToExecutionProviders(backend: RuntimeBackend): string[] {
  switch (backend) {
    case 'webgpu':
      return ['webgpu', 'wasm'];
    case 'webgl':
      return ['webgl', 'wasm'];
    case 'wasm':
      return ['wasm'];
    default:
      return ['wasm'];
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const PLACEHOLDER_HASH_PREFIX = 'REPLACE_WITH';

export class ModelManager {
  private manifest: ModelManifest | null = null;
  private backend: RuntimeBackend | null = null;
  private sessions = new Map<string, ort.InferenceSession>();
  private pendingSessions = new Map<string, Promise<ort.InferenceSession>>();
  // onnxruntime-web's WASM backend does a one-time runtime bootstrap on the
  // first InferenceSession.create() call in a given worker/realm. Calling
  // create() for two different models concurrently before that bootstrap
  // finishes throws "Session already started" — observed in practice when
  // embedder.worker.ts initializes the embedder and antispoof models via
  // Promise.all. This queue serializes the actual create() calls (fetch +
  // checksum verification above it are still fully parallel-safe).
  private sessionCreationQueue: Promise<unknown> = Promise.resolve();

  /** Loads models/manifest.json from the app's own origin (never a remote CDN). */
  async loadManifest(manifestUrl = '/models/manifest.json'): Promise<ModelManifest> {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new Error(`Failed to load model manifest: ${response.status} ${response.statusText}`);
    }
    this.manifest = (await response.json()) as ModelManifest;
    return this.manifest;
  }

  async selectBackend(preferred: RuntimeBackend): Promise<RuntimeBackend> {
    this.backend = await detectBackend(preferred);
    return this.backend;
  }

  getManifestEntry(task: ModelManifestEntry['task']): ModelManifestEntry {
    if (!this.manifest) throw new Error('Manifest not loaded — call loadManifest() first');
    const entry = this.manifest.models.find((m) => m.task === task);
    if (!entry) throw new Error(`No manifest entry for task "${task}"`);
    return entry;
  }

  /**
   * Creates (or returns a cached) ONNX Runtime Web inference session for the
   * given task, verifying the fetched bytes against the manifest's sha256
   * (when populated — skipped for placeholder hash values) before trusting
   * them. See offline-model-loading-plan.md §2.2.
   */
  async getSession(task: ModelManifestEntry['task']): Promise<ort.InferenceSession> {
    const cached = this.sessions.get(task);
    if (cached) return cached;

    const pending = this.pendingSessions.get(task);
    if (pending) return pending;

    const promise = this.createSession(task);
    this.pendingSessions.set(task, promise);
    try {
      const session = await promise;
      this.sessions.set(task, session);
      return session;
    } finally {
      this.pendingSessions.delete(task);
    }
  }

  private async createSession(task: ModelManifestEntry['task']): Promise<ort.InferenceSession> {
    const entry = this.getManifestEntry(task);
    if (!this.backend) throw new Error('Backend not selected — call selectBackend() first');

    const modelUrl = `/models/${task}/${entry.file}`;
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch model "${task}" from ${modelUrl}: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();

    if (entry.sha256 && !entry.sha256.startsWith(PLACEHOLDER_HASH_PREFIX)) {
      const actualHash = await sha256Hex(bytes);
      if (actualHash !== entry.sha256) {
        throw new Error(
          `Checksum mismatch for model "${task}" (${modelUrl}): expected ${entry.sha256}, got ${actualHash}. ` +
            'The cached/fetched file may be corrupt — see offline-model-loading-plan.md §2.2.',
        );
      }
    }

    const executionProviders = backendToExecutionProviders(this.backend);

    // Serialize the actual create() call against any other in-flight
    // creation in this ModelManager — see sessionCreationQueue docblock.
    const previousInQueue = this.sessionCreationQueue;
    let releaseQueue = () => {};
    this.sessionCreationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousInQueue;

    try {
      return await ort.InferenceSession.create(bytes, { executionProviders });
    } catch (err) {
      throw new Error(
        `Failed to create inference session for "${task}" with execution providers ` +
          `[${executionProviders.join(', ')}]: ${err instanceof Error ? err.message : String(err)}. ` +
          'TF.js fallback is not yet implemented — see offline-model-loading-plan.md §3.3.',
      );
    } finally {
      releaseQueue();
    }
  }

  /** Runs one dummy inference per requested task to pay JIT/shader-compile cost up front. */
  async warmUp(tasks: ModelManifestEntry['task'][]): Promise<void> {
    await Promise.all(
      tasks.map(async (task) => {
        const session = await this.getSession(task);
        const entry = this.getManifestEntry(task);
        const inputName = session.inputNames[0];
        const dummy = new ort.Tensor(
          'float32',
          new Float32Array(1 * 3 * entry.inputSize * entry.inputSize),
          [1, 3, entry.inputSize, entry.inputSize],
        );
        await session.run({ [inputName]: dummy });
      }),
    );
  }

  getBackend(): RuntimeBackend | null {
    return this.backend;
  }
}
