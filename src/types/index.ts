// Shared data model types. See offline-face-recognition-spec.md §5 for full field docs.

export interface EnrollmentRecord {
  id: string;
  label: string;
  embedding: Float32Array;
  embeddingModelVersion: string;
  createdAt: string;
  updatedAt: string;
  consentRecordId: string;
  qualityScore: number;
  metadata?: Record<string, string | number | boolean>;
}

export type ConsentScope = 'enrollment' | 'matching' | 'enrollment+matching';

export interface ConsentRecord {
  id: string;
  subjectLabel: string;
  consentTextVersion: string;
  consentedAt: string;
  scope: ConsentScope;
  revoked: boolean;
  revokedAt?: string;
}

export type MatchOutcome = 'match' | 'no-match' | 'liveness-failed' | 'low-quality';

export interface MatchEvent {
  id: string;
  timestamp: string;
  matchedEnrollmentId: string | null;
  similarity: number;
  livenessScore: number;
  outcome: MatchOutcome;
}

// --- Pipeline intermediate types ---

export interface Point2D {
  x: number;
  y: number;
}

export interface FaceDetection {
  box: { x1: number; y1: number; x2: number; y2: number };
  score: number;
  landmarks: Point2D[]; // 5 points: left eye, right eye, nose, mouth-left, mouth-right
}

export interface AlignedFace {
  /** RGB pixel data, length = size * size * 3, values in [0, 255]. Never persisted. */
  pixels: Uint8ClampedArray;
  size: number; // canonical crop size, see manifest detector/embedder inputSize
  sourceDetection: FaceDetection;
  qualityScore: number; // 0-1, derived from pose/size/landmark confidence
}

/**
 * Bbox-centered margin crop for the anti-spoof model — deliberately NOT the
 * same crop as AlignedFace. MiniFASNetV2 was trained on a looser
 * context-including crop (see models/manifest.json antispoof.crop), not the
 * tight ArcFace 5-point alignment used for embedding. Produced by
 * Aligner.cropWithMargin(). RGB pixel data; LivenessModel converts to BGR
 * internally when building the model's input tensor.
 */
export interface MarginCrop {
  pixels: Uint8ClampedArray;
  size: number;
}

export interface EmbeddingResult {
  vector: Float32Array; // L2-normalized
  modelVersion: string;
}

export interface LivenessResult {
  score: number; // 0-1, probability of "real"
  passed: boolean;
  signals: {
    modelScore: number;
    textureHeuristicScore?: number;
    challengeScore?: number;
  };
}

export type RuntimeBackend = 'webgpu' | 'webgl' | 'wasm' | 'tfjs-webgl' | 'tfjs-wasm';

// --- App-level state machine ---

export type AppState =
  | 'IDLE'
  | 'CONSENT_PENDING'
  | 'CAPTURING'
  | 'REVIEW'
  | 'STORING'
  | 'ENROLLED'
  | 'FAILED'
  | 'MATCH_CONSENT_PENDING'
  | 'MATCHING'
  | 'COMPARING'
  | 'MATCHED'
  | 'NO_MATCH'
  | 'LIVENESS_BLOCKED'
  | 'MATCH_CANCELLED';
