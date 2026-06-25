// Similarity-transform face alignment. Pure geometry — no model dependency,
// safe to use as-is. See offline-face-recognition-spec.md §4.2.
//
// Maps 5 detected landmarks onto a fixed canonical template via least-squares
// similarity transform (rotation + uniform scale + translation), then warps
// the source image into a templateSize x templateSize aligned crop.

import type { AlignedFace, FaceDetection, Point2D } from '../types';

// Standard ArcFace-style 112x112 reference landmark template
// (left eye, right eye, nose, mouth-left, mouth-right).
export const REFERENCE_TEMPLATE_112: Point2D[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

interface SimilarityTransform {
  scale: number;
  rotationRad: number;
  tx: number;
  ty: number;
}

/**
 * Computes a least-squares similarity transform mapping `from` points onto
 * `to` points (Umeyama's method, scale + rotation + translation only).
 */
export function estimateSimilarityTransform(from: Point2D[], to: Point2D[]): SimilarityTransform {
  if (from.length !== to.length || from.length < 2) {
    throw new Error('estimateSimilarityTransform requires >=2 matching point pairs');
  }
  const n = from.length;
  const meanFrom = mean(from);
  const meanTo = mean(to);

  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  let varFrom = 0;

  for (let i = 0; i < n; i++) {
    const fx = from[i].x - meanFrom.x;
    const fy = from[i].y - meanFrom.y;
    const tx = to[i].x - meanTo.x;
    const ty = to[i].y - meanTo.y;
    sxx += fx * tx;
    sxy += fx * ty;
    syx += fy * tx;
    syy += fy * ty;
    varFrom += fx * fx + fy * fy;
  }

  const rotationRad = Math.atan2(sxy - syx, sxx + syy);
  const scale = Math.sqrt((sxx + syy) ** 2 + (sxy - syx) ** 2) / varFrom;

  const cos = Math.cos(rotationRad) * scale;
  const sin = Math.sin(rotationRad) * scale;
  const tx = meanTo.x - (cos * meanFrom.x - sin * meanFrom.y);
  const ty = meanTo.y - (sin * meanFrom.x + cos * meanFrom.y);

  return { scale, rotationRad, tx, ty };
}

function mean(points: Point2D[]): Point2D {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Pose-rejection heuristic from landmark geometry. Cheap stand-in for full yaw estimation. */
export function estimateYawDeg(landmarks: Point2D[]): number {
  const [leftEye, rightEye, nose] = landmarks;
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeSpan = Math.abs(rightEye.x - leftEye.x);
  if (eyeSpan === 0) return 90; // degenerate, treat as extreme pose
  const offsetRatio = (nose.x - eyeMidX) / eyeSpan;
  return offsetRatio * 90; // rough linear approximation, tune empirically
}

export class Aligner {
  constructor(private templateSize: 112 = 112) {}

  /**
   * Warps the detected face region from `source` into a canonical aligned
   * crop using the 5-point similarity transform. Caller is responsible for
   * discarding `source`/intermediate canvases after use — aligned pixel
   * buffers must never be persisted (spec §6.2).
   */
  align(source: CanvasImageSource, detection: FaceDetection): AlignedFace {
    const transform = estimateSimilarityTransform(detection.landmarks, REFERENCE_TEMPLATE_112);

    const canvas = new OffscreenCanvas(this.templateSize, this.templateSize);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');

    // setTransform expects the forward (dest <- src) affine matrix.
    ctx.setTransform(
      Math.cos(transform.rotationRad) * transform.scale,
      Math.sin(transform.rotationRad) * transform.scale,
      -Math.sin(transform.rotationRad) * transform.scale,
      Math.cos(transform.rotationRad) * transform.scale,
      transform.tx,
      transform.ty,
    );
    ctx.drawImage(source, 0, 0);

    const imageData = ctx.getImageData(0, 0, this.templateSize, this.templateSize);
    const pixels = new Uint8ClampedArray(this.templateSize * this.templateSize * 3);
    for (let i = 0, j = 0; i < imageData.data.length; i += 4, j += 3) {
      pixels[j] = imageData.data[i];
      pixels[j + 1] = imageData.data[i + 1];
      pixels[j + 2] = imageData.data[i + 2];
      // alpha channel dropped intentionally — RGB only downstream
    }

    const yawDeg = Math.abs(estimateYawDeg(detection.landmarks));
    const eyeSpan = Math.hypot(
      detection.landmarks[1].x - detection.landmarks[0].x,
      detection.landmarks[1].y - detection.landmarks[0].y,
    );
    const qualityScore = Math.max(0, Math.min(1, 1 - yawDeg / 90)) * Math.min(1, eyeSpan / 40);

    return {
      pixels,
      size: this.templateSize,
      sourceDetection: detection,
      qualityScore,
    };
  }
}
