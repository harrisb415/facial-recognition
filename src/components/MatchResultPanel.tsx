// Presentational result panel for a completed match attempt.

export interface MatchResultPanelProps {
  outcome: 'match' | 'no-match' | 'liveness-blocked' | null;
  matchedLabel?: string;
  similarity?: number;
  onDismiss: () => void;
}

export function MatchResultPanel({
  outcome,
  matchedLabel,
  similarity,
  onDismiss,
}: MatchResultPanelProps) {
  if (!outcome) return null;

  return (
    <div className="match-result-panel" role="status" data-outcome={outcome}>
      {outcome === 'match' && (
        <p>
          Match found: <strong>{matchedLabel}</strong>
          {typeof similarity === 'number' && (
            <span className="match-result-panel__score"> ({(similarity * 100).toFixed(1)}%)</span>
          )}
        </p>
      )}
      {outcome === 'no-match' && <p>No match found in enrolled records.</p>}
      {outcome === 'liveness-blocked' && (
        <p>Liveness check did not pass. Please try again in good lighting.</p>
      )}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
