// Guided enrollment: consent -> active liveness challenge -> embed -> review
// -> store. The liveness gate is now the head-motion challenge (ChallengeGate),
// not the passive anti-spoof model — see offline-face-recognition-spec.md §4.4
// and config.ts. ChallengeGate handles the camera + challenge + frontal-face
// capture and hands back a single AlignedFace on success; this component then
// embeds it and runs the review/store steps.

import { useCallback, useReducer, useRef } from 'react';
import type { ChallengeConfig } from '../core/LivenessChallenge';
import type { VectorStore } from '../core/VectorStore';
import type { WorkerBridge } from '../core/WorkerBridge';
import type { AlignedFace, ConsentRecord, EmbeddingResult, EnrollmentRecord } from '../types';
import { ChallengeGate } from './ChallengeGate';
import { ConsentDialog } from './ConsentDialog';

type EnrollmentState =
  | { phase: 'consent-pending' }
  | { phase: 'challenge' }
  | { phase: 'embedding'; face: AlignedFace }
  | { phase: 'review'; face: AlignedFace; embedding: EmbeddingResult }
  | { phase: 'storing' }
  | { phase: 'enrolled'; recordId: string }
  | { phase: 'failed'; reason: string };

type EnrollmentAction =
  | { type: 'CONSENT_GRANTED' }
  | { type: 'CONSENT_DENIED' }
  | { type: 'FACE_CAPTURED'; face: AlignedFace }
  | { type: 'EMBEDDED'; embedding: EmbeddingResult }
  | { type: 'EMBED_FAILED'; reason: string }
  | { type: 'CONFIRM' }
  | { type: 'STORED'; recordId: string }
  | { type: 'RETRY' };

function reducer(state: EnrollmentState, action: EnrollmentAction): EnrollmentState {
  switch (action.type) {
    case 'CONSENT_GRANTED':
      return { phase: 'challenge' };
    case 'CONSENT_DENIED':
      return { phase: 'failed', reason: 'Consent was not granted.' };
    case 'FACE_CAPTURED':
      return { phase: 'embedding', face: action.face };
    case 'EMBEDDED':
      if (state.phase !== 'embedding') return state;
      return { phase: 'review', face: state.face, embedding: action.embedding };
    case 'EMBED_FAILED':
      return { phase: 'failed', reason: action.reason };
    case 'CONFIRM':
      return { phase: 'storing' };
    case 'STORED':
      return { phase: 'enrolled', recordId: action.recordId };
    case 'RETRY':
      return { phase: 'challenge' };
    default:
      return state;
  }
}

export interface EnrollmentFlowProps {
  label: string;
  vectorStore: VectorStore;
  detectorBridge: WorkerBridge;
  embedderBridge: WorkerBridge;
  challengeConfig: ChallengeConfig;
  onComplete: (recordId: string) => void;
}

export function EnrollmentFlow({
  label,
  vectorStore,
  detectorBridge,
  embedderBridge,
  challengeConfig,
  onComplete,
}: EnrollmentFlowProps) {
  const [state, dispatch] = useReducer(reducer, { phase: 'consent-pending' });
  const consentRecordIdRef = useRef('');

  const handleConsentDecision = useCallback(
    async (decision: { granted: boolean; scope: string; textVersion: string }) => {
      if (!decision.granted) {
        dispatch({ type: 'CONSENT_DENIED' });
        return;
      }
      const consent: ConsentRecord = {
        id: crypto.randomUUID(),
        subjectLabel: label,
        consentTextVersion: decision.textVersion,
        consentedAt: new Date().toISOString(),
        scope: 'enrollment',
        revoked: false,
      };
      await vectorStore.putConsent(consent);
      consentRecordIdRef.current = consent.id;
      dispatch({ type: 'CONSENT_GRANTED' });
    },
    [label, vectorStore],
  );

  // ChallengeGate emits a frontal aligned face once the head-motion challenge
  // passes; embed it for review.
  const handleChallengePassed = useCallback(
    async (face: AlignedFace) => {
      dispatch({ type: 'FACE_CAPTURED', face });
      try {
        const embedding = await embedderBridge.call<{ face: AlignedFace }, EmbeddingResult>('embed', {
          face,
        });
        dispatch({ type: 'EMBEDDED', embedding });
      } catch (err) {
        dispatch({ type: 'EMBED_FAILED', reason: err instanceof Error ? err.message : String(err) });
      }
    },
    [embedderBridge],
  );

  const handleConfirm = useCallback(async () => {
    if (state.phase !== 'review') return;
    dispatch({ type: 'CONFIRM' });

    const record: EnrollmentRecord = {
      id: crypto.randomUUID(),
      label,
      embedding: state.embedding.vector,
      embeddingModelVersion: state.embedding.modelVersion,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      consentRecordId: consentRecordIdRef.current,
      qualityScore: state.face.qualityScore,
    };
    await vectorStore.putEnrollment(record);
    dispatch({ type: 'STORED', recordId: record.id });
    onComplete(record.id);
  }, [state, label, vectorStore, onComplete]);

  return (
    <div className="enrollment-flow" data-phase={state.phase}>
      {state.phase === 'consent-pending' && (
        <ConsentDialog scope="enrollment" onDecision={handleConsentDecision} />
      )}

      {state.phase === 'challenge' && (
        <ChallengeGate
          detectorBridge={detectorBridge}
          config={challengeConfig}
          onComplete={handleChallengePassed}
        />
      )}

      {state.phase === 'embedding' && <p>Capturing…</p>}

      {state.phase === 'review' && (
        <div className="enrollment-flow__review">
          <p>Liveness: passed ✓</p>
          <p>Quality score: {(state.face.qualityScore * 100).toFixed(0)}%</p>
          <button type="button" onClick={handleConfirm}>
            Confirm enrollment
          </button>
          <button type="button" onClick={() => dispatch({ type: 'RETRY' })}>
            Retry
          </button>
        </div>
      )}

      {state.phase === 'storing' && <p>Saving…</p>}
      {state.phase === 'enrolled' && <p>Enrollment complete.</p>}
      {state.phase === 'failed' && (
        <div>
          <p role="alert">{state.reason}</p>
          <button type="button" onClick={() => dispatch({ type: 'RETRY' })}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
