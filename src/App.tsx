// Demo app shell: wires CryptoService -> VectorStore, spawns the detector and
// embedder workers, and lets the user either enroll a new face or attempt a
// match. This is the reference integration — see
// offline-face-recognition-spec.md §8 for the full state machine and
// FILE_MAP_AND_TODO.md for what's still a TODO stub underneath this UI.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraCapture } from './components/CameraCapture';
import { ConsentDialog } from './components/ConsentDialog';
import { EnrollmentFlow } from './components/EnrollmentFlow';
import { MatchResultPanel } from './components/MatchResultPanel';
import { CryptoService } from './core/CryptoService';
import { VectorStore } from './core/VectorStore';
import { WorkerBridge } from './core/WorkerBridge';
import { defaultConfig } from './core/config';
import type { AlignedFace, EmbeddingResult, LivenessResult } from './types';

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

  useEffect(() => {
    let cancelled = false;

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
        const detectorBridge = new WorkerBridge(detectorWorker);
        const embedderBridge = new WorkerBridge(embedderWorker);

        await Promise.all([
          detectorBridge.call('init', {}),
          embedderBridge.call('init', {}),
        ]);

        if (cancelled) return;
        vectorStoreRef.current = vectorStore;
        detectorBridgeRef.current = detectorBridge;
        embedderBridgeRef.current = embedderBridge;
        setReady(true);
      } catch (err) {
        if (!cancelled) setInitError(err instanceof Error ? err.message : String(err));
      }
    }

    init();
    return () => {
      cancelled = true;
      detectorBridgeRef.current?.terminate();
      embedderBridgeRef.current?.terminate();
    };
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
      const vectorStore = vectorStoreRef.current;
      if (!detectorBridge || !embedderBridge || !vectorStore) return;

      const { alignedFaces } = await detectorBridge.call<
        { frame: ImageBitmap },
        { alignedFaces: AlignedFace[] }
      >('detectAndAlign', { frame }, [frame]);
      const face = alignedFaces[0];
      if (!face) return;

      const { embedding, liveness } = await embedderBridge.call<
        { face: AlignedFace },
        { embedding: EmbeddingResult; liveness: LivenessResult }
      >('embedAndCheck', { face });

      if (liveness.score < defaultConfig.liveness.minScore) {
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

      {mode === 'enroll' && vectorStoreRef.current && detectorBridgeRef.current && embedderBridgeRef.current && (
        <EnrollmentFlow
          label={enrollLabel}
          vectorStore={vectorStoreRef.current}
          detectorBridge={detectorBridgeRef.current}
          embedderBridge={embedderBridgeRef.current}
          matchThreshold={defaultConfig.embedding.matchThreshold}
          livenessMinScore={defaultConfig.liveness.minScore}
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
