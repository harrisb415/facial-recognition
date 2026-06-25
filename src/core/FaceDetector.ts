// Wraps the SCRFD-500MF ONNX session: preprocess -> run -> decode boxes +
// 5-point landmarks -> NMS. See offline-face-recognition-spec.md §4.1 and
// models/manifest.json detector.decode for the validated parameters this
// implements (strides [8,16,32], 2 anchors/location, kps enabled, scores
// already sigmoided in-graph). Validated against a real test image in
// Python before this port — see models/manifest.json validationNotes.

// Same '/all' subpath as ModelManager.ts — see that file for why (must be a
// single consistent module instance for Tensor/InferenceSession identity).
import * as ort from 'onnxruntime-web/all';
import type { FaceDetection, Point2D } from '../types';
import type { FaceRecognitionConfig } from './config';
import type { ModelManager } from './ModelManager';
import { imageDataToRGBPixels, letterboxToSquare, pixelsToNCHWTensor } from './tensorUtils';

const STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;

export class FaceDetector {
  private session: ort.InferenceSession | null = null;
  private inputSize = 320;
  private preprocessing = { mean: [127.5, 127.5, 127.5], std: [128.0, 128.0, 128.0] };

  constructor(
    private modelManager: ModelManager,
    private config: FaceRecognitionConfig['detection'],
  ) {}

  async initialize(): Promise<void> {
    this.session = await this.modelManager.getSession('detector');
    const entry = this.modelManager.getManifestEntry('detector');
    this.inputSize = entry.inputSize;
    this.preprocessing = entry.preprocessing;
  }

  /**
   * Runs detection on a single frame and returns faces passing the score
   * threshold, after NMS and min-size filtering, sorted by score descending.
   * Returned boxes/landmarks are in the ORIGINAL frame's pixel coordinates
   * (not the internal letterboxed/resized detector input space).
   */
  async detect(frame: ImageBitmap): Promise<FaceDetection[]> {
    if (!this.session) throw new Error('FaceDetector not initialized — call initialize() first');

    const sourceWidth = frame.width;
    const sourceHeight = frame.height;
    const { imageData, scale } = letterboxToSquare(frame, sourceWidth, sourceHeight, this.inputSize);
    const pixels = imageDataToRGBPixels(imageData);
    const tensorData = pixelsToNCHWTensor(
      pixels,
      this.inputSize,
      this.preprocessing.mean,
      this.preprocessing.std,
      'RGB',
    );
    const tensor = new ort.Tensor('float32', tensorData, [1, 3, this.inputSize, this.inputSize]);

    const inputName = this.session.inputNames[0];
    const results = await this.session.run({ [inputName]: tensor });
    const outputs = this.session.outputNames.map((name) => results[name].data as Float32Array);

    // Validated output order for this export: scores x3, bboxes x3, kps x3
    // (grouped by stride index 0..2 within each group) — see
    // models/manifest.json detector.decode.outputOrder.
    const scoresByStride = outputs.slice(0, 3);
    const bboxByStride = outputs.slice(3, 6);
    const kpsByStride = outputs.slice(6, 9);

    const candidates: Array<{ box: [number, number, number, number]; score: number; landmarks: Point2D[] }> = [];

    for (let s = 0; s < STRIDES.length; s++) {
      const stride = STRIDES[s];
      const featH = Math.floor(this.inputSize / stride);
      const featW = Math.floor(this.inputSize / stride);
      const scores = scoresByStride[s];
      const bboxPreds = bboxByStride[s];
      const kpsPreds = kpsByStride[s];

      const numLocations = featH * featW * NUM_ANCHORS;
      for (let i = 0; i < numLocations; i++) {
        const score = scores[i];
        if (score < this.config.scoreThreshold) continue;

        const locIdx = Math.floor(i / NUM_ANCHORS);
        const gridY = Math.floor(locIdx / featW);
        const gridX = locIdx % featW;
        const cx = gridX * stride;
        const cy = gridY * stride;

        const dLeft = bboxPreds[i * 4] * stride;
        const dTop = bboxPreds[i * 4 + 1] * stride;
        const dRight = bboxPreds[i * 4 + 2] * stride;
        const dBottom = bboxPreds[i * 4 + 3] * stride;
        const box: [number, number, number, number] = [cx - dLeft, cy - dTop, cx + dRight, cy + dBottom];

        const landmarks: Point2D[] = [];
        for (let k = 0; k < 5; k++) {
          const dx = kpsPreds[i * 10 + k * 2] * stride;
          const dy = kpsPreds[i * 10 + k * 2 + 1] * stride;
          landmarks.push({ x: cx + dx, y: cy + dy });
        }

        candidates.push({ box, score, landmarks });
      }
    }

    const detections: FaceDetection[] = candidates.map((c) => ({
      box: { x1: c.box[0], y1: c.box[1], x2: c.box[2], y2: c.box[3] },
      score: c.score,
      landmarks: c.landmarks,
    }));

    const kept = nonMaxSuppression(detections, this.config.nmsIouThreshold);

    // Map back to original frame coordinates and apply min-size filter there
    // (minFaceSizePx is meant relative to the captured frame, not our
    // internal detector resolution).
    return kept
      .map((d) => ({
        box: {
          x1: d.box.x1 / scale,
          y1: d.box.y1 / scale,
          x2: d.box.x2 / scale,
          y2: d.box.y2 / scale,
        },
        score: d.score,
        landmarks: d.landmarks.map((p) => ({ x: p.x / scale, y: p.y / scale })),
      }))
      .filter((d) => d.box.x2 - d.box.x1 >= this.config.minFaceSizePx)
      .sort((a, b) => b.score - a.score);
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
