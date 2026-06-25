/// <reference lib="webworker" />
// Worker entry hosting Embedder + LivenessModel. Receives aligned face crops
// via WorkerBridge RPC, returns an embedding vector and a liveness score.
// See offline-face-recognition-spec.md §2.1 and FILE_MAP_AND_TODO.md.

import { defaultConfig } from '../core/config';
import { Embedder } from '../core/Embedder';
import { LivenessModel } from '../core/LivenessModel';
import { ModelManager } from '../core/ModelManager';
import { registerWorkerHandlers } from '../core/WorkerBridge';
import type { AlignedFace, EmbeddingResult, LivenessResult } from '../types';

const modelManager = new ModelManager();
let embedder: Embedder | null = null;
let liveness: LivenessModel | null = null;

interface InitParams {
  manifestUrl?: string;
}

interface EmbedAndCheckParams {
  face: AlignedFace;
}

interface EmbedAndCheckResult {
  embedding: EmbeddingResult;
  liveness: LivenessResult;
}

registerWorkerHandlers({
  async init(params: unknown) {
    const { manifestUrl } = params as InitParams;
    await modelManager.loadManifest(manifestUrl);
    await modelManager.selectBackend(defaultConfig.runtime.preferred);
    embedder = new Embedder(modelManager);
    liveness = new LivenessModel(modelManager, defaultConfig.liveness);
    await Promise.all([embedder.initialize(), liveness.initialize()]);
    return { backend: modelManager.getBackend() };
  },

  async embedAndCheck(params: unknown): Promise<EmbedAndCheckResult> {
    if (!embedder || !liveness) throw new Error('Worker not initialized — call "init" first');
    const { face } = params as EmbedAndCheckParams;

    const [embedding, livenessResult] = await Promise.all([
      embedder.embed(face),
      liveness.check(face),
    ]);

    return { embedding, liveness: livenessResult };
  },
});
