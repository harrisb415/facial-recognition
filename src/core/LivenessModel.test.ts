import { describe, expect, it } from 'vitest';
import { textureHeuristic } from './LivenessModel';
import type { AlignedFace, FaceDetection } from '../types';

const DUMMY_DETECTION: FaceDetection = {
  box: { x1: 0, y1: 0, x2: 1, y2: 1 },
  score: 1,
  landmarks: [],
};

/** Builds a grayscale crop where every pixel in column x has value `base + (x % 2 === 1 ? colStep : 0)`, identical across all rows. */
function buildStripedFace(size: number, base: number, colStep: number): AlignedFace {
  const pixels = new Uint8ClampedArray(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = base + (x % 2 === 1 ? colStep : 0);
      const idx = (y * size + x) * 3;
      pixels[idx] = value;
      pixels[idx + 1] = value;
      pixels[idx + 2] = value;
    }
  }
  return { pixels, size, sourceDetection: DUMMY_DETECTION, qualityScore: 1 };
}

describe('textureHeuristic', () => {
  it('scores a perfectly flat crop (no texture, like a printed photo) at 0', () => {
    const flat = buildStripedFace(8, 128, 0);
    expect(textureHeuristic(flat)).toBeCloseTo(0, 5);
  });

  it('scores ~1 when local variance lands exactly at the calibrated midpoint (12)', () => {
    const moderate = buildStripedFace(8, 100, 12);
    expect(textureHeuristic(moderate)).toBeCloseTo(1, 5);
  });

  it('scores low again for extreme variance (moiré-like high-frequency noise)', () => {
    const extreme = buildStripedFace(8, 50, 200);
    expect(textureHeuristic(extreme)).toBe(0);
  });

  it('never returns a negative score', () => {
    const extreme = buildStripedFace(20, 0, 255);
    expect(textureHeuristic(extreme)).toBeGreaterThanOrEqual(0);
  });
});
