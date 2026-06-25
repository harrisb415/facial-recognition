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
