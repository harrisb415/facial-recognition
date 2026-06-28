import { describe, expect, it } from 'vitest';
import { LivenessChallenge, type ChallengeConfig } from './LivenessChallenge';
import type { Point2D } from '../types';

const CONFIG: ChallengeConfig = {
  centerYawDeg: 10,
  turnYawDeg: 16,
  totalTimeoutMs: 12000,
};

/**
 * Builds a 5-point landmark set whose estimateYawDeg() equals (approximately)
 * `yawDeg`. estimateYawDeg = (nose.x - eyeMidX)/eyeSpan * 90, using
 * landmarks[0..2] = leftEye, rightEye, nose. With leftEye.x=0, rightEye.x=100
 * → eyeSpan=100, eyeMidX=50, so nose.x = 50 + (yawDeg/90)*100.
 */
function makeLandmarks(yawDeg: number): Point2D[] {
  const noseX = 50 + (yawDeg / 90) * 100;
  return [
    { x: 0, y: 0 }, // left eye
    { x: 100, y: 0 }, // right eye
    { x: noseX, y: 40 }, // nose
    { x: 20, y: 80 }, // mouth-left
    { x: 80, y: 80 }, // mouth-right
  ];
}

describe('LivenessChallenge', () => {
  it('passes when a centered baseline is followed by strong turns both ways within budget', () => {
    const c = new LivenessChallenge(CONFIG);

    // Not centered yet — a turned face should NOT start the clock or count.
    let s = c.update(makeLandmarks(30), 0);
    expect(s.phase).toBe('centering');

    // Center → starts the clock, moves to 'turning'.
    s = c.update(makeLandmarks(0), 1000);
    expect(s.phase).toBe('turning');

    // Strong turn one way.
    s = c.update(makeLandmarks(-25), 2000);
    expect(s.phase).toBe('turning');
    expect(s.sawNegativeTurn).toBe(true);
    expect(s.sawPositiveTurn).toBe(false);

    // Strong turn the other way → pass.
    s = c.update(makeLandmarks(25), 3000);
    expect(s.phase).toBe('passed');
    expect(s.sawNegativeTurn).toBe(true);
    expect(s.sawPositiveTurn).toBe(true);
  });

  it('fails by timeout if only one direction is turned', () => {
    const c = new LivenessChallenge(CONFIG);
    c.update(makeLandmarks(0), 0); // center, clock starts at t=0
    c.update(makeLandmarks(-30), 1000); // one way only
    const s = c.update(makeLandmarks(-30), CONFIG.totalTimeoutMs + 1);
    expect(s.phase).toBe('failed');
    expect(s.reason).toBe('timeout');
  });

  it('ignores turns that happen before a centered baseline', () => {
    const c = new LivenessChallenge(CONFIG);
    // Strong turns both ways but never centered first → stays centering, no credit.
    let s = c.update(makeLandmarks(-40), 0);
    s = c.update(makeLandmarks(40), 500);
    expect(s.phase).toBe('centering');
    expect(s.sawNegativeTurn).toBe(false);
    expect(s.sawPositiveTurn).toBe(false);
  });

  it('does not count a mild turn below the turn threshold', () => {
    const c = new LivenessChallenge(CONFIG);
    c.update(makeLandmarks(0), 0);
    const s = c.update(makeLandmarks(-10), 1000); // below turnYawDeg=16
    expect(s.sawNegativeTurn).toBe(false);
    expect(s.phase).toBe('turning');
  });

  it('handles frames with no detected face without crashing or progressing', () => {
    const c = new LivenessChallenge(CONFIG);
    c.update(makeLandmarks(0), 0); // centered
    const s = c.update(null, 1000);
    expect(s.faceVisible).toBe(false);
    expect(s.phase).toBe('turning');
  });

  it('keeps the budget full until a centered baseline starts the clock', () => {
    const c = new LivenessChallenge(CONFIG);
    const s = c.update(makeLandmarks(30), 5000); // never centered
    expect(s.remainingMs).toBe(CONFIG.totalTimeoutMs);
  });

  it('is sticky once passed (further updates do not change the result)', () => {
    const c = new LivenessChallenge(CONFIG);
    c.update(makeLandmarks(0), 0);
    c.update(makeLandmarks(-25), 1000);
    c.update(makeLandmarks(25), 2000);
    const passed = c.update(makeLandmarks(0), 3000);
    expect(passed.phase).toBe('passed');
  });

  it('resets cleanly for a retry', () => {
    const c = new LivenessChallenge(CONFIG);
    c.update(makeLandmarks(0), 0);
    c.update(makeLandmarks(-25), 1000);
    c.reset();
    const s = c.status;
    expect(s.phase).toBe('centering');
    expect(s.sawNegativeTurn).toBe(false);
    expect(s.sawPositiveTurn).toBe(false);
  });
});
