/// <reference lib="webworker" />
// ⚠️ DORMANT as of 2026-06-27 — this worker is NOT spawned by App.tsx anymore.
// The passive MiniFASNetV2 anti-spoof model it hosts did not discriminate live
// faces from spoofs (see LivenessModel.ts / config.ts), so liveness was
// pivoted to an ACTIVE head-motion challenge (see core/LivenessChallenge.ts +
// components/ChallengeGate.tsx). This file + LivenessModel.ts + the model file
// are retained intact for a possible future advisory passive layer, or in case
// the model's preprocessing/ensemble issues get resolved. Re-spawn it from
// App.tsx init to bring it back. It is not bundled while unreferenced.
//
// Worker entry hosting LivenessModel only. Receives the 112x112 ArcFace crop
// (for the texture heuristic) and the 80x80 bbox-margin crop (for the anti-
// spoof model) via WorkerBridge RPC, returns a liveness result. One model per
// worker — see embedder.worker.ts's docblock for why.

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
