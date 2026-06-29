// Drives the active head-motion liveness challenge end to end: shows the
// camera with a face-positioning guide overlay, feeds each frame's landmarks
// to a LivenessChallenge, and once the challenge passes, captures a single
// FRONTAL aligned face and hands it back via onComplete. Shared by enrollment
// and matching. See offline-face-recognition-spec.md §4.4.
//
// Only the detector worker is used here (landmarks + aligned crop). The
// embedder runs afterward, in the parent, on the face this emits.

import { useCallback, useEffect, useRef, useState } from 'react';
import { estimateYawDeg } from '../core/Aligner';
import { LivenessChallenge, type ChallengeConfig, type ChallengeStatus } from '../core/LivenessChallenge';
import type { WorkerBridge } from '../core/WorkerBridge';
import type { AlignedFace, FaceDetection } from '../types';
import { CameraCapture } from './CameraCapture';
import { ChallengePrompt } from './ChallengePrompt';
import { FaceGuideOverlay, type BoxPct, type Positioning } from './FaceGuideOverlay';

// CameraCapture always draws frames into a 640x480 canvas, so detection boxes
// are in this coordinate space regardless of the actual camera resolution.
const FRAME_W = 640;
const FRAME_H = 480;

// If a perfectly frontal frame never arrives after the challenge passes (the
// crude 5-point yaw estimate can sit a little high even head-on), capture the
// best available face after this long rather than hang on "hold still".
const CAPTURE_FALLBACK_MS = 2500;

interface DetectAndAlignResult {
  detections: FaceDetection[];
  alignedFaces: AlignedFace[];
}

function computePositioning(box: FaceDetection['box'] | undefined): {
  positioning: Positioning;
  boxPct: BoxPct | null;
} {
  if (!box) return { positioning: 'none', boxPct: null };
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const boxPct: BoxPct = {
    left: (box.x1 / FRAME_W) * 100,
    top: (box.y1 / FRAME_H) * 100,
    width: (w / FRAME_W) * 100,
    height: (h / FRAME_H) * 100,
  };
  const centeredX = Math.abs(cx / FRAME_W - 0.5) < 0.18;
  const centeredY = Math.abs(cy / FRAME_H - 0.5) < 0.2;
  const widthFrac = w / FRAME_W;
  const goodSize = widthFrac > 0.2 && widthFrac < 0.62;
  const positioning: Positioning = centeredX && centeredY && goodSize ? 'good' : 'adjust';
  return { positioning, boxPct };
}

export interface ChallengeGateProps {
  detectorBridge: WorkerBridge;
  config: ChallengeConfig;
  /** Called once, with a frontal aligned face, after the challenge passes. */
  onComplete: (face: AlignedFace) => void;
}

export function ChallengeGate({ detectorBridge, config, onComplete }: ChallengeGateProps) {
  const challengeRef = useRef(new LivenessChallenge(config));
  const isProcessingRef = useRef(false);
  // Set once we emit a captured face, so a late in-flight frame can't emit twice.
  const completedRef = useRef(false);
  // performance.now() when we entered the post-pass capture phase (for fallback).
  const captureStartRef = useRef<number | null>(null);

  const [status, setStatus] = useState<ChallengeStatus | null>(null);
  const [guide, setGuide] = useState<{ positioning: Positioning; boxPct: BoxPct | null }>({
    positioning: 'none',
    boxPct: null,
  });
  // 'challenge' = running the head-motion check; 'capturing' = passed, waiting
  // for a frontal frame to grab for the embedding.
  const [gatePhase, setGatePhase] = useState<'challenge' | 'capturing'>('challenge');

  useEffect(() => {
    challengeRef.current = new LivenessChallenge(config);
    completedRef.current = false;
    captureStartRef.current = null;
    setGatePhase('challenge');
    setStatus(null);
  }, [config]);

  const handleRetry = useCallback(() => {
    challengeRef.current.reset();
    completedRef.current = false;
    captureStartRef.current = null;
    setGatePhase('challenge');
    setStatus(challengeRef.current.status);
  }, []);

  const handleFrame = useCallback(
    async (frame: ImageBitmap) => {
      if (isProcessingRef.current || completedRef.current) {
        frame.close();
        return;
      }
      isProcessingRef.current = true;
      try {
        const { detections, alignedFaces } = await detectorBridge.call<
          { frame: ImageBitmap },
          DetectAndAlignResult
        >('detectAndAlign', { frame }, [frame]);

        const detection = detections[0];
        const landmarks = detection?.landmarks ?? null;
        setGuide(computePositioning(detection?.box));

        if (gatePhase === 'challenge') {
          const next = challengeRef.current.update(landmarks, performance.now());
          setStatus(next);
          if (next.phase === 'passed') {
            captureStartRef.current = performance.now();
            setGatePhase('capturing');
          }
          return;
        }

        // gatePhase === 'capturing': emit a frontal face (or the best
        // available after a short fallback) exactly once.
        const face = alignedFaces[0];
        if (!face || !landmarks) return;
        const frontal = Math.abs(estimateYawDeg(landmarks)) <= config.centerYawDeg;
        const fallbackElapsed =
          captureStartRef.current != null && performance.now() - captureStartRef.current > CAPTURE_FALLBACK_MS;
        if (frontal || fallbackElapsed) {
          completedRef.current = true;
          onComplete(face);
        }
      } finally {
        isProcessingRef.current = false;
      }
    },
    [detectorBridge, gatePhase, config.centerYawDeg, onComplete],
  );

  return (
    <div className="challenge-gate">
      <div className="challenge-gate__stage">
        <CameraCapture enabled onFrame={handleFrame} />
        <FaceGuideOverlay positioning={guide.positioning} boxPct={guide.boxPct} />
      </div>
      <ChallengePrompt
        status={status}
        capturing={gatePhase === 'capturing'}
        totalTimeoutMs={config.totalTimeoutMs}
        onRetry={handleRetry}
      />
    </div>
  );
}
