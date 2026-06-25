import { describe, expect, it } from 'vitest';
import { estimateSimilarityTransform, estimateYawDeg, REFERENCE_TEMPLATE_112 } from './Aligner';
import type { Point2D } from '../types';

describe('estimateSimilarityTransform', () => {
  it('recovers identity for already-aligned points', () => {
    const t = estimateSimilarityTransform(REFERENCE_TEMPLATE_112, REFERENCE_TEMPLATE_112);
    expect(t.scale).toBeCloseTo(1, 5);
    expect(t.rotationRad).toBeCloseTo(0, 5);
    expect(t.tx).toBeCloseTo(0, 3);
    expect(t.ty).toBeCloseTo(0, 3);
  });

  it('recovers a known scale + translation with no rotation', () => {
    const scaleFactor = 2;
    const offset = { x: 100, y: 50 };
    const scaled: Point2D[] = REFERENCE_TEMPLATE_112.map((p) => ({
      x: p.x * scaleFactor + offset.x,
      y: p.y * scaleFactor + offset.y,
    }));
    const t = estimateSimilarityTransform(REFERENCE_TEMPLATE_112, scaled);
    expect(t.scale).toBeCloseTo(scaleFactor, 4);
    expect(t.rotationRad).toBeCloseTo(0, 4);
    expect(t.tx).toBeCloseTo(offset.x, 2);
    expect(t.ty).toBeCloseTo(offset.y, 2);
  });

  it('matches the real detection validated against det_500m.onnx + a test photo', () => {
    // Landmarks as actually decoded from the SCRFD output during manual
    // Python validation (see models/manifest.json validationNotes) — a
    // regression fixture grounded in a real model run, not synthetic data.
    const detectedLandmarks: Point2D[] = [
      { x: 2438.7, y: 1940.5 }, // left eye
      { x: 3078.5, y: 1903.7 }, // right eye
      { x: 2743.6, y: 2343.6 }, // nose
      { x: 2457.9, y: 2530.8 }, // mouth-left
      { x: 3148.8, y: 2496.8 }, // mouth-right
    ];

    const t = estimateSimilarityTransform(detectedLandmarks, REFERENCE_TEMPLATE_112);

    // Eye-to-eye distance in source ~= 640.9px; template eye distance ~=
    // 35.24px, so scale should land close to 35.24/640.9 ~= 0.055.
    expect(t.scale).toBeGreaterThan(0.05);
    expect(t.scale).toBeLessThan(0.06);

    // The detected eyes tilt slightly more (~-3.3deg, right eye higher) than
    // the reference template's own small built-in tilt (~-0.3deg), so the
    // correcting rotation is a small positive few degrees, not zero.
    const rotationDeg = (t.rotationRad * 180) / Math.PI;
    expect(rotationDeg).toBeGreaterThan(0);
    expect(rotationDeg).toBeLessThan(6);
  });

  it('throws on mismatched point counts', () => {
    expect(() => estimateSimilarityTransform([{ x: 0, y: 0 }], REFERENCE_TEMPLATE_112)).toThrow();
  });
});

describe('estimateYawDeg', () => {
  it('returns ~0 for a perfectly frontal face (nose centered between eyes)', () => {
    const landmarks: Point2D[] = [
      { x: 40, y: 50 },
      { x: 80, y: 50 },
      { x: 60, y: 70 }, // nose exactly centered
      { x: 45, y: 90 },
      { x: 75, y: 90 },
    ];
    expect(Math.abs(estimateYawDeg(landmarks))).toBeLessThan(1);
  });

  it('returns a large magnitude when the nose is far off-center (profile-ish pose)', () => {
    const landmarks: Point2D[] = [
      { x: 40, y: 50 },
      { x: 80, y: 50 },
      { x: 95, y: 70 }, // nose well outside the eye span, toward/past the right eye
      { x: 45, y: 90 },
      { x: 75, y: 90 },
    ];
    expect(Math.abs(estimateYawDeg(landmarks))).toBeGreaterThan(45);
  });
});
