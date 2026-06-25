// Loads models/manifest.json, picks the best available execution backend,
// creates ONNX Runtime Web inference sessions (with TF.js fallback hook),
// and performs a warm-up inference. See offline-model-loading-plan.md for
// the full caching/fallback algorithm this implements a slice of.

import type { RuntimeBackend } from '../types';

export interface ModelManifestEntry {
  name: string;
  task: 'detector' | 'embedder' | 'antispoof';
  format: 'onnx' | 'tfjs';
  version: string;
  file: string;
  tfjsFile?: string;
  inputSize: number;
  outputDim?: number;
  quantization: string;
  approxSizeBytes: number;
  sha256?: string;
  preprocessing: {
    mean: number[];
    std: number[];
    colorOrder: 'RGB' | 'BGR';
  };
}

export interface ModelManifest {
  manifestVersion: string;
  generatedAt: string;
  models: ModelManifestEntry[];
}

async function detectBackend(preferred: RuntimeBackend): Promise<RuntimeBackend> {
  if (preferred === 'webgpu' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
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

export class ModelManager {
  private manifest: ModelManifest | null = null;
  private backend: RuntimeBackend | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessions = new Map<string, any>();

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
   * given task. TODO(impl): once onnxruntime-web is installed, wire up
   * `ort.InferenceSession.create(modelUrl, { executionProviders: [...] })`
   * with the backend chosen by selectBackend(). Fall back to TF.js
   * (`loadTfjsModel`) only if session creation throws AND
   * config.runtime.allowTfjsFallback is true — see
   * offline-model-loading-plan.md §3 for the exact decision tree.
   */
  async getSession(task: ModelManifestEntry['task']): Promise<unknown> {
    const cached = this.sessions.get(task);
    if (cached) return cached;

    const entry = this.getManifestEntry(task);
    if (!this.backend) throw new Error('Backend not selected — call selectBackend() first');

    const modelUrl = `/models/${task}/${entry.file}`;

    // TODO(impl): replace with real onnxruntime-web session creation, e.g.:
    //
    //   import * as ort from 'onnxruntime-web';
    //   const executionProviders = backendToExecutionProviders(this.backend);
    //   const session = await ort.InferenceSession.create(modelUrl, { executionProviders });
    //
    // backendToExecutionProviders should map:
    //   'webgpu' -> ['webgpu']
    //   'webgl'  -> ['webgl']
    //   'wasm'   -> ['wasm']
    // with TF.js fallback handled by the caller per config.runtime.allowTfjsFallback.
    throw new Error(
      `ModelManager.getSession("${task}") not yet implemented — see TODO above. ` +
        `Manifest entry resolved to ${modelUrl} on backend "${this.backend}".`,
    );
  }

  /** Runs one dummy inference per loaded session to pay JIT/shader-compile cost up front. */
  async warmUp(_tasks: ModelManifestEntry['task'][]): Promise<void> {
    // TODO(impl): for each task, build a zero-filled input tensor matching
    // entry.inputSize, run session.run(), and discard the result. See
    // offline-model-loading-plan.md §4 ("Warm-up").
  }

  getBackend(): RuntimeBackend | null {
    return this.backend;
  }
}
