/// <reference lib="webworker" />
// Worker entry hosting FaceDetector + Aligner. Receives frames via
// WorkerBridge RPC from the main thread, returns detections + aligned crops
// (both the 112x112 ArcFace crop for embedding and the bbox-margin crop for
// the anti-spoof model — see models/manifest.json antispoof.crop). See
// offline-face-recognition-spec.md §2.1 and FILE_MAP_AND_TODO.md.

import { Aligner } from '../core/Aligner';
import { defaultConfig } from '../core/config';
import { FaceDetector } from '../core/FaceDetector';
import { ModelManager } from '../core/ModelManager';
import { registerWorkerHandlers } from '../core/WorkerBridge';
import type { AlignedFace, FaceDetection, MarginCrop } from '../types';

const modelManager = new ModelManager();
const aligner = new Aligner(defaultConfig.alignment.templateSize);
let detector: FaceDetector | null = null;
let antispoofCropSize = 80;
let antispoofMarginScale = 2.7;

interface InitParams {
  manifestUrl?: string;
}

interface DetectAndAlignParams {
  frame: ImageBitmap;
}

interface DetectAndAlignResult {
  detections: FaceDetection[];
  alignedFaces: AlignedFace[];
  marginCrops: MarginCrop[];
}

registerWorkerHandlers({
  async init(params: unknown) {
    const { manifestUrl } = params as InitParams;
    await modelManager.loadManifest(manifestUrl);
    await modelManager.selectBackend(defaultConfig.runtime.preferred);
    detector = new FaceDetector(modelManager, defaultConfig.detection);
    await detector.initialize();

    const antispoofEntry = modelManager.getManifestEntry('antispoof');
    antispoofCropSize = antispoofEntry.inputSize;
    antispoofMarginScale = antispoofEntry.crop?.marginScale ?? 2.7;

    await modelManager.warmUp(['detector']);
    return { backend: modelManager.getBackend() };
  },

  async detectAndAlign(params: unknown): Promise<DetectAndAlignResult> {
    if (!detector) throw new Error('Worker not initialized — call "init" first');
    const { frame } = params as DetectAndAlignParams;

    const detections = await detector.detect(frame);
    const alignedFaces = detections.map((detection) => aligner.align(frame, detection));
    const marginCrops = detections.map((detection) =>
      aligner.cropWithMargin(frame, detection.box, antispoofMarginScale, antispoofCropSize),
    );
    frame.close();

    return { detections, alignedFaces, marginCrops };
  },
});
