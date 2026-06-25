/// <reference lib="webworker" />
// Worker entry hosting FaceDetector + Aligner. Receives frames via
// WorkerBridge RPC from the main thread, returns detections + aligned crops.
// See offline-face-recognition-spec.md §2.1 and FILE_MAP_AND_TODO.md.

import { Aligner } from '../core/Aligner';
import { defaultConfig } from '../core/config';
import { FaceDetector } from '../core/FaceDetector';
import { ModelManager } from '../core/ModelManager';
import { registerWorkerHandlers } from '../core/WorkerBridge';
import type { AlignedFace, FaceDetection } from '../types';

const modelManager = new ModelManager();
const aligner = new Aligner(defaultConfig.alignment.templateSize);
let detector: FaceDetector | null = null;

interface InitParams {
  manifestUrl?: string;
}

interface DetectAndAlignParams {
  frame: ImageBitmap;
}

interface DetectAndAlignResult {
  detections: FaceDetection[];
  alignedFaces: AlignedFace[];
}

registerWorkerHandlers({
  async init(params: unknown) {
    const { manifestUrl } = params as InitParams;
    await modelManager.loadManifest(manifestUrl);
    await modelManager.selectBackend(defaultConfig.runtime.preferred);
    detector = new FaceDetector(modelManager, defaultConfig.detection);
    await detector.initialize();
    return { backend: modelManager.getBackend() };
  },

  async detectAndAlign(params: unknown): Promise<DetectAndAlignResult> {
    if (!detector) throw new Error('Worker not initialized — call "init" first');
    const { frame } = params as DetectAndAlignParams;

    const detections = await detector.detect(frame);
    const alignedFaces = detections.map((detection) => aligner.align(frame, detection));
    frame.close();

    return { detections, alignedFaces };
  },
});
