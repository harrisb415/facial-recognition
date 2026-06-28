// Drives the active head-motion liveness challenge end to end: shows the
// camera, feeds each frame's landmarks to a LivenessChallenge, and once the
// challenge passes, captures a single FRONTAL aligned face and hands it back
// via onComplete. Shared by enrollment and matching. See
// offline-face-recognition-spec.md §4.4.
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

interface DetectAndAlignResult {
  detections: FaceDetection[];
  alignedFaces: AlignedFace[];
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

  const [status, setStatus] = useState<ChallengeStatus | null>(null);
  // 'challenge' = running the head-motion check; 'capturing' = passed, waiting
  // for one frontal frame to grab for the embedding.
  const [gatePhase, setGatePhase] = useState<'challenge' | 'capturing'>('challenge');

  useEffect(() => {
    // Fresh challenge whenever config identity changes (effectively once).
    challengeRef.current = new LivenessChallenge(config);
    completedRef.current = false;
    setGatePhase('challenge');
    setStatus(null);
  }, [config]);

  const handleRetry = useCallback(() => {
    challengeRef.current.reset();
    completedRef.current = false;
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

        const landmarks = detections[0]?.landmarks ?? null;

        if (gatePhase === 'challenge') {
          const next = challengeRef.current.update(landmarks, performance.now());
          setStatus(next);
          if (next.phase === 'passed') setGatePhase('capturing');
          return;
        }

        // gatePhase === 'capturing': wait for a frontal face, then emit it once.
        const face = alignedFaces[0];
        if (landmarks && face && Math.abs(estimateYawDeg(landmarks)) <= config.centerYawDeg) {
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
      <CameraCapture enabled onFrame={handleFrame} />
      <ChallengePrompt
        status={status}
        capturing={gatePhase === 'capturing'}
        totalTimeoutMs={config.totalTimeoutMs}
        onRetry={handleRetry}
      />
    </div>
  );
}
