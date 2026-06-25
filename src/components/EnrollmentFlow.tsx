// Guided enrollment: consent -> capture -> quality/liveness gate -> review ->
// store. Implements the enrollment half of the state machine in
// offline-face-recognition-spec.md §8. Depends on a WorkerBridge pair and a
// VectorStore being passed in — wiring those up end-to-end requires the
// ModelManager/FaceDetector/Embedder TODOs to be filled in first (see
// FILE_MAP_AND_TODO.md).

import { useCallback, useReducer, useRef } from 'react';
import type {
  AlignedFace,
  ConsentRecord,
  EmbeddingResult,
  EnrollmentRecord,
  LivenessResult,
  MarginCrop,
} from '../types';
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
  antispoofBridge: WorkerBridge;
  matchThreshold: number;
  livenessMinScore: number;
  onComplete: (recordId: string) => void;
}

export function EnrollmentFlow({
  label,
  vectorStore,
  detectorBridge,
  embedderBridge,
  antispoofBridge,
  livenessMinScore,
  onComplete,
}: EnrollmentFlowProps) {
  const [state, dispatch] = useReducer(reducer, { phase: 'consent-pending' });
  const consentRecordIdRef = useRef('');
  // CameraCapture fires a new frame every ~100ms regardless of whether the
  // previous handleFrame call has resolved. A single cycle (detectAndAlign
  // -> embed + checkLiveness, two worker round-trips with real ONNX
  // inference) can easily take longer than that. Without this guard,
  // overlapping calls pile up, each independently dispatching FACE_CAPTURED
  // and racing to finish — a newer frame's dispatch overwrites
  // state.phase back to 'checking' before an older one can ever resolve to
  // 'review'/'failed', so the UI appears permanently stuck. It also risks
  // calling .run() concurrently on the same onnxruntime-web session from
  // two overlapping requests, which is not guaranteed safe. Drop frames
  // while busy instead of queuing them.
  const isProcessingRef = useRef(false);

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

  const handleFrame = useCallback(
    async (frame: ImageBitmap) => {
      if (isProcessingRef.current) {
        frame.close(); // never transferred to a worker, so we must close it ourselves
        return;
      }
      isProcessingRef.current = true;

      try {
        const { alignedFaces, marginCrops } = await detectorBridge.call<
          { frame: ImageBitmap },
          { alignedFaces: AlignedFace[]; marginCrops: MarginCrop[] }
        >('detectAndAlign', { frame }, [frame]);
        const best = alignedFaces[0];
        const bestMarginCrop = marginCrops[0];
        if (!best || !bestMarginCrop) return; // no face yet, keep capturing
        dispatch({ type: 'FACE_CAPTURED', face: best });

        const [embedding, liveness] = await Promise.all([
          embedderBridge.call<{ face: AlignedFace }, EmbeddingResult>('embed', { face: best }),
          antispoofBridge.call<{ face: AlignedFace; marginCrop: MarginCrop }, LivenessResult>(
            'checkLiveness',
            { face: best, marginCrop: bestMarginCrop },
          ),
        ]);

        if (liveness.score < livenessMinScore) {
          dispatch({ type: 'CHECK_FAILED', reason: 'Liveness check did not pass.' });
          return;
        }
        dispatch({ type: 'CHECK_COMPLETE', embedding, liveness });
      } catch (err) {
        dispatch({ type: 'CHECK_FAILED', reason: err instanceof Error ? err.message : String(err) });
      } finally {
        isProcessingRef.current = false;
      }
    },
    [detectorBridge, embedderBridge, antispoofBridge, livenessMinScore],
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
