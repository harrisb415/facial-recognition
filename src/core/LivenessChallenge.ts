// Active head-motion liveness challenge. Pure, stateful, deterministic — no
// React, no DOM, no ML model. Consumes per-frame 5-point landmarks (from
// SCRFD, via the detector worker) plus a timestamp, and tracks whether the
// subject has performed the required head motion. See
// offline-face-recognition-spec.md §4.4.
//
// Why this exists / why it replaced the passive CNN as the gate: the sourced
// MiniFASNetV2 anti-spoof model produced near-identical output for a real
// face and a static photo (it did not discriminate at all). An active
// challenge-response sidesteps that entirely: a static held-up photo cannot
// produce a strong head yaw in BOTH directions while remaining a single
// tracked face.
//
// MIRROR-AGNOSTIC BY DESIGN: we do NOT assume "left = negative yaw". The webcam
// may or may not be mirrored, and SCRFD's eye-point labeling order is not
// guaranteed, so the sign of estimateYawDeg() for a given physical turn is
// unknown without per-device calibration. Instead of guessing (the exact bug
// class that repeatedly bit the passive model), we require the yaw to reach a
// strong turn in BOTH signs after a centered baseline. The user simply turns
// their head both ways; we never need to know which sign is "left".

import type { Point2D } from '../types';
import { estimateYawDeg } from './Aligner';

export interface ChallengeConfig {
  /** |yaw°| at or below this counts as frontal/centered (baseline). */
  centerYawDeg: number;
  /** |yaw°| at or beyond this counts as a strong, deliberate turn. */
  turnYawDeg: number;
  /** Budget, in ms, from the moment a centered baseline is achieved until both turns must be observed. */
  totalTimeoutMs: number;
}

export type ChallengePhase = 'centering' | 'turning' | 'passed' | 'failed';

export interface ChallengeStatus {
  phase: ChallengePhase;
  /** A strong turn toward the negative-yaw side has been observed (after centering). */
  sawNegativeTurn: boolean;
  /** A strong turn toward the positive-yaw side has been observed (after centering). */
  sawPositiveTurn: boolean;
  /** ms remaining in the budget; equals totalTimeoutMs until the centered baseline starts the clock. */
  remainingMs: number;
  /** Whether a usable face was present in the most recent update. */
  faceVisible: boolean;
  /** Populated only when phase === 'failed'. */
  reason?: string;
}

export class LivenessChallenge {
  private centeredAtMs: number | null = null;
  private sawNegativeTurn = false;
  private sawPositiveTurn = false;
  private phase: ChallengePhase = 'centering';
  private faceVisible = false;

  constructor(private config: ChallengeConfig) {}

  reset(): void {
    this.centeredAtMs = null;
    this.sawNegativeTurn = false;
    this.sawPositiveTurn = false;
    this.phase = 'centering';
    this.faceVisible = false;
  }

  get status(): ChallengeStatus {
    return {
      phase: this.phase,
      sawNegativeTurn: this.sawNegativeTurn,
      sawPositiveTurn: this.sawPositiveTurn,
      remainingMs: this.computeRemainingMs(Number.NaN),
      faceVisible: this.faceVisible,
      reason: this.phase === 'failed' ? 'timeout' : undefined,
    };
  }

  /**
   * Feed one frame's landmarks (or null if no face was detected this frame)
   * and the current timestamp (ms, monotonic — e.g. performance.now()).
   * Returns the updated, immutable status snapshot.
   */
  update(landmarks: Point2D[] | null, nowMs: number): ChallengeStatus {
    // Terminal states are sticky — caller resets to retry.
    if (this.phase === 'passed' || this.phase === 'failed') {
      return this.snapshot(nowMs);
    }

    this.faceVisible = landmarks != null && landmarks.length >= 3;
    const yawDeg = this.faceVisible ? estimateYawDeg(landmarks as Point2D[]) : null;

    if (this.phase === 'centering') {
      // Wait for a frontal face to establish a baseline and start the clock.
      // No pre-centering timeout: the user may take as long as they like to
      // face the camera; the budget only governs the active turning.
      if (yawDeg != null && Math.abs(yawDeg) <= this.config.centerYawDeg) {
        this.centeredAtMs = nowMs;
        this.phase = 'turning';
      }
      return this.snapshot(nowMs);
    }

    // phase === 'turning'
    if (this.computeRemainingMs(nowMs) <= 0) {
      this.phase = 'failed';
      return this.snapshot(nowMs);
    }

    if (yawDeg != null) {
      if (yawDeg <= -this.config.turnYawDeg) this.sawNegativeTurn = true;
      if (yawDeg >= this.config.turnYawDeg) this.sawPositiveTurn = true;
    }

    if (this.sawNegativeTurn && this.sawPositiveTurn) {
      this.phase = 'passed';
    }

    return this.snapshot(nowMs);
  }

  private computeRemainingMs(nowMs: number): number {
    if (this.centeredAtMs == null || Number.isNaN(nowMs)) {
      return this.config.totalTimeoutMs;
    }
    return Math.max(0, this.config.totalTimeoutMs - (nowMs - this.centeredAtMs));
  }

  private snapshot(nowMs: number): ChallengeStatus {
    return {
      phase: this.phase,
      sawNegativeTurn: this.sawNegativeTurn,
      sawPositiveTurn: this.sawPositiveTurn,
      remainingMs: this.computeRemainingMs(nowMs),
      faceVisible: this.faceVisible,
      reason: this.phase === 'failed' ? 'timeout' : undefined,
    };
  }
}
