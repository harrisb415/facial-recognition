import { describe, expect, it } from 'vitest';
import { l2Normalize } from './Embedder';

function magnitude(v: Float32Array): number {
  return Math.sqrt(Array.from(v).reduce((sum, x) => sum + x * x, 0));
}

describe('l2Normalize', () => {
  it('produces a unit-length vector', () => {
    const v = Float32Array.from([3, 4]); // magnitude 5
    const normalized = l2Normalize(v);
    expect(magnitude(normalized)).toBeCloseTo(1, 5);
    expect(normalized[0]).toBeCloseTo(0.6, 5);
    expect(normalized[1]).toBeCloseTo(0.8, 5);
  });

  it('matches the magnitude observed on a real MobileFaceNet output during validation', () => {
    // The real w600k_mbf.onnx output validated in Python had raw L2 norm
    // ~12.84 — sanity-check normalization on a vector of that rough scale.
    const v = new Float32Array(512).fill(12.844225 / Math.sqrt(512));
    const normalized = l2Normalize(v);
    expect(magnitude(normalized)).toBeCloseTo(1, 4);
  });

  it('leaves an all-zero vector unchanged rather than dividing by zero', () => {
    const v = new Float32Array(4);
    const normalized = l2Normalize(v);
    expect(Array.from(normalized)).toEqual([0, 0, 0, 0]);
  });
});
