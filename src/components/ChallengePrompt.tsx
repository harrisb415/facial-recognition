// Presentational UI for the active head-motion liveness challenge. Renders the
// current instruction + progress from a ChallengeStatus; owns no logic. The
// challenge state machine lives in core/LivenessChallenge.ts and is driven by
// ChallengeGate. See offline-face-recognition-spec.md §4.4.

import type { ChallengeStatus } from '../core/LivenessChallenge';

export interface ChallengePromptProps {
  status: ChallengeStatus | null;
  /** True during the brief post-pass "hold still, look at the camera" capture. */
  capturing: boolean;
  totalTimeoutMs: number;
  onRetry: () => void;
}

export function ChallengePrompt({ status, capturing, totalTimeoutMs, onRetry }: ChallengePromptProps) {
  if (capturing) {
    return (
      <div className="challenge-prompt" role="status">
        <p>Great — hold still and look at the camera.</p>
      </div>
    );
  }

  const phase = status?.phase ?? 'centering';

  if (phase === 'failed') {
    return (
      <div className="challenge-prompt challenge-prompt--failed" role="alert">
        <p>Couldn&apos;t verify a live face in time. Make sure your face stays in view, then try again.</p>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (phase === 'passed') {
    return (
      <div className="challenge-prompt" role="status">
        <p>Verified ✓</p>
      </div>
    );
  }

  if (phase === 'centering') {
    return (
      <div className="challenge-prompt" role="status">
        <p>Center your face in the camera and look straight ahead.</p>
        {status && !status.faceVisible && (
          <p className="challenge-prompt__hint">No face detected yet — move into the frame.</p>
        )}
      </div>
    );
  }

  // phase === 'turning'
  const sideA = status?.sawNegativeTurn ?? false;
  const sideB = status?.sawPositiveTurn ?? false;
  const secondsLeft = Math.ceil((status?.remainingMs ?? totalTimeoutMs) / 1000);

  return (
    <div className="challenge-prompt" role="status">
      <p>Slowly turn your head to one side, then the other.</p>
      <ul className="challenge-prompt__ticks">
        <li data-done={sideA}>{sideA ? '✓' : '○'} one side</li>
        <li data-done={sideB}>{sideB ? '✓' : '○'} the other side</li>
      </ul>
      <progress value={totalTimeoutMs - (status?.remainingMs ?? totalTimeoutMs)} max={totalTimeoutMs} />
      <p className="challenge-prompt__hint">{secondsLeft}s left</p>
    </div>
  );
}
