/// <reference lib="webworker" />
// Worker entry hosting LivenessModel only. Receives the 112x112 ArcFace crop
// (for the texture heuristic) and the 80x80 bbox-margin crop (for the actual
// anti-spoof model) via WorkerBridge RPC, returns a liveness result.
//
// One model per worker, deliberately — see embedder.worker.ts's docblock for
// why (onnxruntime-web's multi-threaded WASM backend only tolerates one
// InferenceSession per worker/realm). This worker used to be combined with
// embedder.worker.ts.

import { defaultConfig } from '../core/config';
import { LivenessModel } from '../core/LivenessModel';
import { ModelManager } from '../core/ModelManager';
import { registerWorkerHandlers } from '../core/WorkerBridge';
import type { AlignedFace, LivenessResult, MarginCrop } from '../types';

const modelManager = new ModelManager();
let liveness: LivenessModel | null = null;

interface InitParams {
  manifestUrl?: string;
}

interface CheckLivenessParams {
  face: AlignedFace;
  marginCrop: MarginCrop;
}

registerWorkerHandlers({
  async init(params: unknown) {
    const { manifestUrl } = params as InitParams;
    await modelManager.loadManifest(manifestUrl);
    await modelManager.selectBackend(defaultConfig.runtime.preferred);
    liveness = new LivenessModel(modelManager, defaultConfig.liveness);
    await liveness.initialize();
    await modelManager.warmUp(['antispoof']);
    return { backend: modelManager.getBackend() };
  },

  async checkLiveness(params: unknown): Promise<LivenessResult> {
    if (!liveness) throw new Error('Worker not initialized — call "init" first');
    const { face, marginCrop } = params as CheckLivenessParams;
    return liveness.check(face, marginCrop);
  },
});
