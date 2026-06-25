// Guided enrollment: consent -> capture -> quality/liveness gate -> review ->
// store. Implements the enrollment half of the state machine in
// offline-face-recognition-spec.md §8. Depends on a WorkerBridge pair and a
// VectorStore being passed in — wiring those up end-to-end requires the
// ModelManager/FaceDetector/Embedder TODOs to be filled in first (see
// FILE_MAP_AND_TODO.md).

import { useCallback, useReducer } from 'react';
import type { AlignedFace, ConsentRecord, EmbeddingResult, EnrollmentRecord, LivenessResult } from '../types';
import type { VectorStore } from '../core/VectorStore';
import type { WorkerBridge } from '../core/WorkerBridge';
import { CameraCapture } from './CameraCapture';
import { ConsentDialog } from './ConsentDialog';
import { LivenessPrompt } from './LivenessPrompt';

type EnrollmentState =
  | { phase: 'consent-pending' }
  | { phase: 'capturing' }
  | { phase: 'checking'; face: AlignedFace }
  | { phase: 'review'; face: AlignedFace; embedding: EmbeddingResult; liveness: LivenessResult }
  | { phase: 'storing' }
  | { phase: 'enrolled'; recordId: string }
  | { phase: 'failed'; reason: string };

type EnrollmentAction =
  | { type: 'CONSENT_GRANTED' }
  | { type: 'CONSENT_DENIED' }
  | { type: 'FACE_CAPTURED'; face: AlignedFace }
  | { type: 'CHECK_COMPLETE'; embedding: EmbeddingResult; liveness: LivenessResult }
  | { type: 'CHECK_FAILED'; reason: string }
  | { type: 'CONFIRM' }
  | { type: 'STORED'; recordId: string }
  | { type: 'RETRY' };

function reducer(state: EnrollmentState, action: EnrollmentAction): EnrollmentState {
  switch (action.type) {
    case 'CONSENT_GRANTED':
      return { phase: 'capturing' };
    case 'CONSENT_DENIED':
      return { phase: 'failed', reason: 'Consent was not granted.' };
    case 'FACE_CAPTURED':
      return { phase: 'checking', face: action.face };
    case 'CHECK_COMPLETE':
      if (state.phase !== 'checking') return state;
      return { phase: 'review', face: state.face, embedding: action.embedding, liveness: action.liveness };
    case 'CHECK_FAILED':
      return { phase: 'failed', reason: action.reason };
    case 'CONFIRM':
      return { phase: 'storing' };
    case 'STORED':
      return { phase: 'enrolled', recordId: action.recordId };
    case 'RETRY':
      return { phase: 'capturing' };
    default:
      return state;
  }
}

export interface EnrollmentFlowProps {
  label: string;
  vectorStore: VectorStore;
  detectorBridge: WorkerBridge;
  embedderBridge: WorkerBridge;
  matchThreshold: number;
  livenessMinScore: number;
  onComplete: (recordId: string) => void;
}

export function EnrollmentFlow({
  label,
  vectorStore,
  detectorBridge,
  embedderBridge,
  livenessMinScore,
  onComplete,
}: EnrollmentFlowProps) {
  const [state, dispatch] = useReducer(reducer, { phase: 'consent-pending' });

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
      dispatch({ type: 'CONSENT_GRANTED' });
    },
    [label, vectorStore],
  );

  const handleFrame = useCallback(
    async (frame: ImageBitmap) => {
      try {
        const { alignedFaces } = await detectorBridge.call<{ frame: ImageBitmap }, { alignedFaces: AlignedFace[] }>(
          'detectAndAlign',
          { frame },
          [frame],
        );
        const best = alignedFaces[0];
        if (!best) return; // no face yet, keep capturing
        dispatch({ type: 'FACE_CAPTURED', face: best });

        const { embedding, liveness } = await embedderBridge.call<
          { face: AlignedFace },
          { embedding: EmbeddingResult; liveness: LivenessResult }
        >('embedAndCheck', { face: best });

        if (liveness.score < livenessMinScore) {
          dispatch({ type: 'CHECK_FAILED', reason: 'Liveness check did not pass.' });
          return;
        }
        dispatch({ type: 'CHECK_COMPLETE', embedding, liveness });
      } catch (err) {
        dispatch({ type: 'CHECK_FAILED', reason: err instanceof Error ? err.message : String(err) });
      }
    },
    [detectorBridge, embedderBridge, livenessMinScore],
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
      consentRecordId: '', // TODO(impl): thread the consent record id created in handleConsentDecision through state
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

      {(state.phase === 'capturing' || state.phase === 'checking') && (
        <>
          <CameraCapture enabled onFrame={handleFrame} />
          <LivenessPrompt
            active={state.phase === 'checking'}
            result={null}
            onTimeout={() => dispatch({ type: 'RETRY' })}
          />
        </>
      )}

      {state.phase === 'review' && (
        <div className="enrollment-flow__review">
          <p>Quality score: {(state.face.qualityScore * 100).toFixed(0)}%</p>
          <p>Liveness score: {(state.liveness.score * 100).toFixed(0)}%</p>
          <button type="button" onClick={handleConfirm}>
            Confirm enrollment
          </button>
          <button type="button" onClick={() => dispatch({ type: 'RETRY' })}>
            Retry capture
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
