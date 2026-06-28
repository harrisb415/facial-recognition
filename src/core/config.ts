// Single source of truth for tunable pipeline parameters.
// See offline-face-recognition-spec.md §11. Do not scatter magic numbers
// elsewhere — import from here.

export interface FaceRecognitionConfig {
  detection: {
    scoreThreshold: number;
    nmsIouThreshold: number;
    minFaceSizePx: number;
  };
  alignment: {
    templateSize: 112;
    maxYawDeg: number;
  };
  embedding: {
    matchThreshold: number;
  };
  liveness: {
    // --- Active head-motion challenge (the CURRENT liveness gate) ---
    challenge: {
      /** Gate enroll/match on the head-motion challenge. */
      enabled: boolean;
      /** |yaw°| at or below this counts as frontal/centered (baseline + capture). */
      centerYawDeg: number;
      /** |yaw°| at or beyond this counts as a strong, deliberate turn. */
      turnYawDeg: number;
      /** ms budget from centered baseline until both turns must be observed. */
      totalTimeoutMs: number;
    };
    // --- Passive anti-spoof CNN (DORMANT — not wired into the gate) ---
    // Retained for a possible future advisory layer; the model did not
    // discriminate live from spoof (see note below + LivenessModel.ts).
    enforce: boolean;
    minScore: number;
    requireChallengeOnEnroll: boolean;
    requireChallengeOnMatch: boolean;
  };
  runtime: {
    preferred: 'webgpu' | 'webgl' | 'wasm';
    allowTfjsFallback: boolean;
  };
  storage: {
    auditLogEnabled: boolean;
    auditLogMaxEntries: number;
  };
}

// NOTE: matchThreshold and liveness.minScore are placeholders pending
// empirical tuning against real model weights — see privacy-and-testing.md
// §1 (accuracy testing plan) before relying on these in any real deployment.
//
// LIVENESS (2026-06-27): the gate is now an ACTIVE head-motion challenge
// (liveness.challenge, see LivenessChallenge.ts), not the passive CNN. Real-
// camera testing showed the sourced MiniFASNetV2 model produced near-identical
// output (~0.994 on logit index 2) for both a real face AND a static photo —
// it did not discriminate at all. Rather than keep chasing that model, we
// pivoted to a deterministic challenge: the user turns their head, and we
// verify a strong yaw in both directions from the 5 SCRFD landmarks. A static
// held-up photo cannot do that. The passive fields below (enforce/minScore)
// are kept but DORMANT — the antispoof worker is no longer spawned. challenge
// thresholds are starting points; tune turnYawDeg/centerYawDeg against a real
// camera (the on-screen challenge progress makes this easy to eyeball).
export const defaultConfig: FaceRecognitionConfig = {
  detection: {
    scoreThreshold: 0.5,
    nmsIouThreshold: 0.4,
    minFaceSizePx: 60,
  },
  alignment: {
    templateSize: 112,
    maxYawDeg: 35,
  },
  embedding: {
    matchThreshold: 0.62,
  },
  liveness: {
    challenge: {
      enabled: true,
      centerYawDeg: 10,
      turnYawDeg: 16,
      totalTimeoutMs: 12000,
    },
    enforce: false, // dormant passive model — not used by the gate
    minScore: 0.5,
    requireChallengeOnEnroll: true,
    requireChallengeOnMatch: false,
  },
  runtime: {
    preferred: 'webgpu',
    allowTfjsFallback: true,
  },
  storage: {
    auditLogEnabled: false,
    auditLogMaxEntries: 0,
  },
};
