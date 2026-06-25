/// <reference lib="webworker" />
// Worker entry hosting Embedder only. Receives an aligned face crop via
// WorkerBridge RPC, returns an embedding vector.
//
// One model per worker, deliberately: onnxruntime-web's multi-threaded WASM
// backend (enabled by the COOP/COEP headers in vite.config.ts) can only
// host a single live InferenceSession per worker/realm — creating a second
// session in the same worker, even sequentially after the first completes,
// throws "Session already started". This was originally one combined
// embedder+antispoof worker; split into two single-model workers
// (embedder.worker.ts, antispoof.worker.ts) after hitting that limit. See
// offline-model-loading-plan.md §3 and FILE_MAP_AND_TODO.md.

import { defaultConfig } from '../core/config';
import { Embedder } from '../core/Embedder';
import { ModelManager } from '../core/ModelManager';
import { registerWorkerHandlers } from '../core/WorkerBridge';
import type { AlignedFace, EmbeddingResult } from '../types';

const modelManager = new ModelManager();
let embedder: Embedder | null = null;

interface InitParams {
  manifestUrl?: string;
}

interface EmbedParams {
  face: AlignedFace;
}

registerWorkerHandlers({
  async init(params: unknown) {
    const { manifestUrl } = params as InitParams;
    await modelManager.loadManifest(manifestUrl);
    await modelManager.selectBackend(defaultConfig.runtime.preferred);
    embedder = new Embedder(modelManager);
    await embedder.initialize();
    await modelManager.warmUp(['embedder']);
    return { backend: modelManager.getBackend() };
  },

  async embed(params: unknown): Promise<EmbeddingResult> {
    if (!embedder) throw new Error('Worker not initialized — call "init" first');
    const { face } = params as EmbedParams;
    return embedder.embed(face);
  },
});
