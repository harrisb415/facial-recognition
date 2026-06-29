// Demo app shell: wires CryptoService -> VectorStore, spawns the detector and
// embedder workers, and lets the user either enroll a new face or attempt a
// match. This is the reference integration — see
// offline-face-recognition-spec.md §8 for the full flow.
//
// Liveness is an ACTIVE head-motion challenge (ChallengeGate), not the passive
// anti-spoof CNN — see offline-face-recognition-spec.md §4.4 and config.ts.
// The antispoof worker is no longer spawned (the model didn't discriminate
// live from spoof); only detector + embedder run. Each hosts one ONNX model —
// see embedder.worker.ts's docblock for why one model per worker.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChallengeGate } from './components/ChallengeGate';
import { ConsentDialog } from './components/ConsentDialog';
import { EnrollmentFlow } from './components/EnrollmentFlow';
import { MatchResultPanel } from './components/MatchResultPanel';
import { CryptoService } from './core/CryptoService';
import { VectorStore } from './core/VectorStore';
import { WorkerBridge } from './core/WorkerBridge';
import { defaultConfig } from './core/config';
import { getOrCreatePersistentKey } from './core/keyStore';
import type { AlignedFace, EmbeddingResult } from './types';

type Mode = 'idle' | 'enroll' | 'match-consent' | 'match';
type MatchOutcome = 'match' | 'no-match' | null;

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
  // Guards against React 18 StrictMode's dev-mode double-invoke (mount ->
  // cleanup -> mount on the SAME component instance, synchronously, before
  // the first invocation's async init has progressed far enough for cleanup
  // to find anything to cancel). App is the page root and only ever needs to
  // acquire these resources once per page lifetime — a real unmount only
  // happens via navigation/reload, which tears down all workers/wasm state
  // regardless of whether cleanup ran, so skipping teardown here is safe.
  const initStartedRef = useRef(false);

  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    async function init() {
      try {
        const crypto = new CryptoService();
        // Persistent local key (stored once in IndexedDB, reused every load) so
        // enrollments stay decryptable across reloads. A real product should
        // derive the key from a host-supplied passphrase/PIN via
        // initializeFromPassphrase instead — see offline-face-recognition-spec.md
        // §6.2 and keyStore.ts.
        crypto.initializeWithKey(await getOrCreatePersistentKey());
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

        await Promise.all([detectorBridge.call('init', {}), embedderBridge.call('init', {})]);

        vectorStoreRef.current = vectorStore;
        detectorBridgeRef.current = detectorBridge;
        embedderBridgeRef.current = embedderBridge;
        setReady(true);
      } catch (err) {
        console.error('App initialization failed:', err); // eslint-disable-line no-console
        setInitError(err instanceof Error ? err.message : String(err));
      }
    }

    init();
  }, []);

  const handleMatchConsent = useCallback((decision: { granted: boolean }) => {
    setMode(decision.granted ? 'match' : 'idle');
  }, []);

  // ChallengeGate emits a frontal aligned face once the head-motion challenge
  // passes; embed it and compare against the store.
  const handleMatchCaptured = useCallback(async (face: AlignedFace) => {
    const embedderBridge = embedderBridgeRef.current;
    const vectorStore = vectorStoreRef.current;
    if (!embedderBridge || !vectorStore) return;

    try {
      const embedding = await embedderBridge.call<{ face: AlignedFace }, EmbeddingResult>('embed', {
        face,
      });
      const best = await vectorStore.findBestMatch(embedding.vector);
      if (best && best.similarity >= defaultConfig.embedding.matchThreshold) {
        setMatchOutcome('match');
        setMatchedLabel(best.enrollment.label);
        setMatchSimilarity(best.similarity);
      } else {
        setMatchOutcome('no-match');
      }
    } catch (err) {
      console.error('Match processing failed:', err); // eslint-disable-line no-console
    } finally {
      setMode('idle');
    }
  }, []);

  if (initError) {
    return (
      <main className="app app--error">
        <p role="alert">Failed to initialize: {initError}</p>
        <p>
          Check that the model files exist under <code>public/models/</code> and that the dev
          server is serving them — see <code>FILE_MAP_AND_TODO.md</code>.
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
        embedderBridgeRef.current && (
          <EnrollmentFlow
            label={enrollLabel}
            vectorStore={vectorStoreRef.current}
            detectorBridge={detectorBridgeRef.current}
            embedderBridge={embedderBridgeRef.current}
            challengeConfig={defaultConfig.liveness.challenge}
            onComplete={() => setMode('idle')}
          />
        )}

      {mode === 'match-consent' && (
        <ConsentDialog scope="matching" onDecision={handleMatchConsent} />
      )}

      {mode === 'match' && detectorBridgeRef.current && (
        <ChallengeGate
          detectorBridge={detectorBridgeRef.current}
          config={defaultConfig.liveness.challenge}
          onComplete={handleMatchCaptured}
        />
      )}

      <MatchResultPanel
        outcome={matchOutcome}
        matchedLabel={matchedLabel}
        similarity={matchSimilarity}
        onDismiss={() => setMatchOutcome(null)}
      />
    </main>
  );
}
