import { describe, expect, it } from 'vitest';
import { nonMaxSuppression } from './FaceDetector';
import type { FaceDetection } from '../types';

function det(x1: number, y1: number, x2: number, y2: number, score: number): FaceDetection {
  return { box: { x1, y1, x2, y2 }, score, landmarks: [] };
}

describe('nonMaxSuppression', () => {
  it('keeps a single detection unchanged', () => {
    const result = nonMaxSuppression([det(0, 0, 10, 10, 0.9)], 0.4);
    expect(result).toHaveLength(1);
  });

  it('suppresses a heavily-overlapping lower-score box', () => {
    const high = det(0, 0, 100, 100, 0.95);
    const overlapping = det(5, 5, 105, 105, 0.6); // near-identical box, lower score
    const result = nonMaxSuppression([overlapping, high], 0.4);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.95);
  });

  it('keeps two genuinely separate faces', () => {
    const left = det(0, 0, 50, 50, 0.9);
    const right = det(200, 200, 250, 250, 0.8);
    const result = nonMaxSuppression([left, right], 0.4);
    expect(result).toHaveLength(2);
  });

  it('keeps both boxes when overlap is well below the IoU threshold', () => {
    // Corner-touching boxes: intersection area 1 vs union area 199 => IoU ~0.005, well under 0.4.
    const a = det(0, 0, 10, 10, 0.9);
    const b = det(9, 9, 19, 19, 0.85);
    const result = nonMaxSuppression([a, b], 0.4);
    expect(result).toHaveLength(2);
  });
});
