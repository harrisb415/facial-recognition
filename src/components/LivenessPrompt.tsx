// Presents a liveness challenge (e.g. "blink twice") and surfaces the
// pass/fail outcome computed in the worker. See
// offline-face-recognition-spec.md §4.4. The actual challenge-tracking logic
// (landmark movement across frames) lives in core/LivenessModel.ts /
// FaceDetector.ts — this component is presentation + countdown only.

import { useEffect, useState } from 'react';
import type { LivenessResult } from '../types';

export interface LivenessPromptProps {
  active: boolean;
  result: LivenessResult | null;
  challengeLabel?: string;
  timeoutMs?: number;
  onTimeout: () => void;
}

export function LivenessPrompt({
  active,
  result,
  challengeLabel = 'Please blink twice',
  timeoutMs = 4000,
  onTimeout,
}: LivenessPromptProps) {
  const [remainingMs, setRemainingMs] = useState(timeoutMs);

  useEffect(() => {
    if (!active) {
      setRemainingMs(timeoutMs);
      return;
    }
    const start = Date.now();
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, timeoutMs - elapsed);
      setRemainingMs(remaining);
      if (remaining === 0) {
        window.clearInterval(interval);
        onTimeout();
      }
    }, 100);
    return () => window.clearInterval(interval);
  }, [active, timeoutMs, onTimeout]);

  if (!active && !result) return null;

  return (
    <div className="liveness-prompt" role="status">
      {active && (
        <>
          <p>{challengeLabel}</p>
          <progress value={timeoutMs - remainingMs} max={timeoutMs} />
        </>
      )}
      {result && !result.passed && (
        <p className="liveness-prompt__message">
          We couldn&apos;t confirm a live face. Make sure you&apos;re in good lighting and try
          again.
        </p>
      )}
    </div>
  );
}
