import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from './VectorStore';

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = Float32Array.from([0.6, 0.8]); // already unit length
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = Float32Array.from([0.6, 0.8]);
    const b = Float32Array.from([-0.6, -0.8]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('throws on dimension mismatch', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow();
  });
});
