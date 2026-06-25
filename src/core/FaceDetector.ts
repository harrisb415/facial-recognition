// Wraps the SCRFD-tiny ONNX session: preprocess -> run -> decode boxes +
// 5-point landmarks -> NMS. See offline-face-recognition-spec.md §4.1.
//
// TODO(impl): exact anchor decoding depends on which SCRFD export is sourced
// (see models/README.md). This file intentionally stops short of guessing
// anchor strides/scales — confirm against the chosen weights before
// implementing decodeOutputs().

import type { FaceDetection } from '../types';
import type { FaceRecognitionConfig } from './config';
import type { ModelManager } from './ModelManager';

export class FaceDetector {
  private session: unknown = null;

  constructor(
    private modelManager: ModelManager,
    private config: FaceRecognitionConfig['detection'],
  ) {}

  async initialize(): Promise<void> {
    this.session = await this.modelManager.getSession('detector');
  }

  /**
   * Runs detection on a single frame and returns faces passing the score
   * threshold, after NMS, sorted by score descending.
   */
  async detect(_frame: ImageBitmap | ImageData): Promise<FaceDetection[]> {
    if (!this.session) throw new Error('FaceDetector not initialized — call initialize() first');

    // TODO(impl):
    // 1. Resize/letterbox `frame` to the manifest detector entry's inputSize,
    //    preserving aspect ratio; record the scale/offset to map boxes back
    //    to original frame coordinates.
    // 2. Normalize per manifest.models[detector].preprocessing (mean/std/colorOrder).
    // 3. Run the ONNX session, decode raw outputs into FaceDetection[]
    //    (see SCRFD reference decoder for the exact box/landmark head layout
    //    of the sourced weights).
    // 4. Filter by this.config.scoreThreshold, apply NMS at
    //    this.config.nmsIouThreshold, drop boxes smaller than
    //    this.config.minFaceSizePx.
    throw new Error('FaceDetector.detect() not yet implemented — see TODO above');
  }
}

/** Standard greedy NMS, reusable once decodeOutputs() produces raw boxes. */
export function nonMaxSuppression(
  detections: FaceDetection[],
  iouThreshold: number,
): FaceDetection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: FaceDetection[] = [];

  for (const candidate of sorted) {
    const overlaps = kept.some((k) => iou(k.box, candidate.box) > iouThreshold);
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

function iou(a: FaceDetection['box'], b: FaceDetection['box']): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union <= 0 ? 0 : intersection / union;
}
