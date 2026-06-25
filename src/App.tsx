// Demo app shell: wires CryptoService -> VectorStore, spawns the detector,
// embedder, and antispoof workers, and lets the user either enroll a new
// face or attempt a match. This is the reference integration — see
// offline-face-recognition-spec.md §8 for the full state machine and
// FILE_MAP_AND_TODO.md for what's still a TODO stub underneath this UI.
//
// Three workers, one model each — see embedder.worker.ts's docblock for why
// (onnxruntime-web's multi-threaded WASM backend only tolerates one
// InferenceSession per worker/realm).

import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraCapture } from './components/CameraCapture';
import { ConsentDialog } from './components/ConsentDialog';
import { EnrollmentFlow } from './components/EnrollmentFlow';
import { MatchResultPanel } from './components/MatchResultPanel';
import { CryptoService } from './core/CryptoService';
import { VectorStore } from './core/VectorStore';
import { WorkerBridge } from './core/WorkerBridge';
import { defaultConfig } from './core/config';
import type { AlignedFace, EmbeddingResult, LivenessResult, MarginCrop } from './types';

type Mode = 'idle' | 'enroll' | 'match-consent' | 'match';
type MatchOutcome = 'match' | 'no-match' | 'liveness-blocked' | null;

export default function App() {
  const [mode, setMode] = useState<Mode>('idle');
  const [enrollLabel, setEnrollLabel] = useState('');
  const [matchOutcome, setMatchOutcome] = useState<MatchOutcome>(null);
  const [matchedLabel, setMatchedLabel] = useState<string>();
  const [matchSimilarity, setMatchSimilarity] = useState<number>();
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const vectorStoreRef = useRef<VectorStore | null>(null);
  const detectorBridgeRef = useRef<WorkerBridge | null>(null);
  const embedderBridgeRef = useRef<WorkerBridge | null>(null);
  const antispoofBridgeRef = useRef<WorkerBridge | null>(null);
  // See EnrollmentFlow.tsx's identical guard for why this is needed:
  // CameraCapture fires a new frame every ~100ms regardless of whether the
  // previous handleMatchFrame call (two worker round-trips with real ONNX
  // inference) has resolved yet. Without this, overlapping calls pile up.
  const isProcessingRef = useRef(false);
  // Guards against React 18 StrictMode's dev-mode double-invoke (mount ->
  // cleanup -> mount on the SAME component instance, synchronously, before
  // the first invocation's async init has progressed far enough for
  // cleanup to find anything to cancel). App is the page root and only ever
  // needs to acquire these resources once per page lifetime — a real
  // unmount only happens via navigation/reload, which tears down all
  // workers/wasm state regardless of whether cleanup ran, so skipping
  // teardown on the StrictMode-induced fake cleanup is safe here.
  const initStartedRef = useRef(false);

  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    async function init() {
      try {
        const crypto = new CryptoService();
        // Demo-only key derivation. Replace with initializeFromPassphrase()
        // wired to your host app's own passphrase/PIN UX before shipping —
        // see offline-face-recognition-spec.md §6.2.
        await crypto.initializeRandomKey();
        const vectorStore = new VectorStore(crypto);

        const detectorWorker = new Worker(
          new URL('./workers/detector.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const embedderWorker = new Worker(
          new URL('./workers/embedder.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const antispoofWorker = new Worker(
          new URL('./workers/antispoof.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const detectorBridge = new WorkerBridge(detectorWorker);
        const embedderBridge = new WorkerBridge(embedderWorker);
        const antispoofBridge = new WorkerBridge(antispoofWorker);

        await Promise.all([
          detectorBridge.call('init', {}),
          embedderBridge.call('init', {}),
          antispoofBridge.call('init', {}),
        ]);

        vectorStoreRef.current = vectorStore;
        detectorBridgeRef.current = detectorBridge;
        embedderBridgeRef.current = embedderBridge;
        antispoofBridgeRef.current = antispoofBridge;
        setReady(true);
      } catch (err) {
        console.error('App initialization failed:', err); // eslint-disable-line no-console
        setInitError(err instanceof Error ? err.message : String(err));
      }
    }

    init();
  }, []);

  const handleMatchConsent = useCallback(
    (decision: { granted: boolean }) => {
      setMode(decision.granted ? 'match' : 'idle');
    },
    [],
  );

  const handleMatchFrame = useCallback(
    async (frame: ImageBitmap) => {
      const detectorBridge = detectorBridgeRef.current;
      const embedderBridge = embedderBridgeRef.current;
      const antispoofBridge = antispoofBridgeRef.current;
      const vectorStore = vectorStoreRef.current;
      if (!detectorBridge || !embedderBridge || !antispoofBridge || !vectorStore) {
        frame.close();
        return;
      }
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
        const face = alignedFaces[0];
        const marginCrop = marginCrops[0];
        if (!face || !marginCrop) return;

        const [embedding, liveness] = await Promise.all([
          embedderBridge.call<{ face: AlignedFace }, EmbeddingResult>('embed', { face }),
          antispoofBridge.call<{ face: AlignedFace; marginCrop: MarginCrop }, LivenessResult>(
            'checkLiveness',
            { face, marginCrop },
          ),
        ]);

        // Advisory unless config.liveness.enforce is true — see that flag's
        // note. Currently false because the anti-spoof model doesn't yet
        // discriminate live from spoof; blocking on it would just prevent
        // matching from working without providing real security.
        if (defaultConfig.liveness.enforce && liveness.score < defaultConfig.liveness.minScore) {
          setMatchOutcome('liveness-blocked');
          setMode('idle');
          return;
        }

        const best = await vectorStore.findBestMatch(embedding.vector);
        if (best && best.similarity >= defaultConfig.embedding.matchThreshold) {
          setMatchOutcome('match');
          setMatchedLabel(best.enrollment.label);
          setMatchSimilarity(best.similarity);
        } else {
          setMatchOutcome('no-match');
        }
        setMode('idle');
      } catch (err) {
        console.error('Match frame processing failed:', err); // eslint-disable-line no-console
      } finally {
        isProcessingRef.current = false;
      }
    },
    [],
  );

  if (initError) {
    return (
      <main className="app app--error">
        <p role="alert">Failed to initialize: {initError}</p>
        <p>
          This is expected until real model files are placed under <code>models/</code> and the
          TODO stubs in <code>src/core/</code> are implemented — see{' '}
          <code>FILE_MAP_AND_TODO.md</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="app">
      <h1>facial-recognition — offline demo</h1>

      {!ready && <p>Initializing models…</p>}

      {ready && mode === 'idle' && (
        <div className="app__menu">
          <label>
            Name for enrollment:{' '}
            <input value={enrollLabel} onChange={(e) => setEnrollLabel(e.target.value)} />
          </label>
          <button type="button" disabled={!enrollLabel} onClick={() => setMode('enroll')}>
            Enroll face
          </button>
          <button type="button" onClick={() => setMode('match-consent')}>
            Match face
          </button>
        </div>
      )}

      {mode === 'enroll' &&
        vectorStoreRef.current &&
        detectorBridgeRef.current &&
        embedderBridgeRef.current &&
        antispoofBridgeRef.current && (
          <EnrollmentFlow
            label={enrollLabel}
            vectorStore={vectorStoreRef.current}
            detectorBridge={detectorBridgeRef.current}
            embedderBridge={embedderBridgeRef.current}
            antispoofBridge={antispoofBridgeRef.current}
            matchThreshold={defaultConfig.embedding.matchThreshold}
            livenessMinScore={defaultConfig.liveness.minScore}
            enforceLiveness={defaultConfig.liveness.enforce}
            onComplete={() => setMode('idle')}
          />
        )}

      {mode === 'match-consent' && (
        <ConsentDialog scope="matching" onDecision={handleMatchConsent} />
      )}

      {mode === 'match' && <CameraCapture enabled onFrame={handleMatchFrame} />}

      <MatchResultPanel
        outcome={matchOutcome}
        matchedLabel={matchedLabel}
        similarity={matchSimilarity}
        onDismiss={() => setMatchOutcome(null)}
      />
    </main>
  );
}
