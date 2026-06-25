// Shows a "checking" indicator while the real liveness check (anti-spoof
// model + texture heuristic, see core/LivenessModel.ts) runs in the
// background, and surfaces a failure message if it doesn't pass. See
// offline-face-recognition-spec.md §4.4.
//
// IMPORTANT: this component does NOT track blinks or any other user action
// — it is a presentation + timeout-fallback only. The default label used to
// say "Please blink twice", which wrongly implied blinking was required or
// even observed; nothing in this codebase tracks eye state across frames.
// The liveness result depends only on the single aligned crop already
// captured. If you want a real motion/blink challenge (spec §4.4 mentions
// this as the strongest practical defense for enrollment), it needs to be
// built — landmark positions across a short frame sequence, compared for
// motion — it does not exist yet.

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
  challengeLabel = 'Checking…',
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
