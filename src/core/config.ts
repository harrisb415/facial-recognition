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
    /** When false, the liveness score is computed and shown but NEVER blocks
     *  enrollment or matching (advisory mode). See defaultConfig note. */
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
// liveness.enforce is FALSE as of 2026-06-25: real-camera testing showed the
// sourced MiniFASNetV2 anti-spoof model produces a near-identical output
// (~0.994 on logit index 2) for both a real live face AND a static photo —
// i.e. it does not currently discriminate live from spoof at all, so hard-
// blocking on it is meaningless and only prevents the core enroll/match
// feature from working. Advisory mode computes + displays the score but never
// blocks. Re-enabling enforcement requires actually fixing/validating the
// anti-spoof model (preprocessing? ensemble? output order?) against real
// spoof samples — tracked as a deliberate follow-up. Do NOT flip this back to
// true without that validation; a check that can't tell live from fake is
// worse than no check (it just blocks legitimate users while stopping nothing).
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
    enforce: false, // advisory only — see the long note above before changing
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
