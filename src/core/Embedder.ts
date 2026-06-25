// Wraps the MobileFaceNet (w600k_mbf) ONNX session: preprocess aligned crop
// -> run -> L2-normalize output embedding. See
// offline-face-recognition-spec.md §4.3 and models/manifest.json embedder
// entry for the validated preprocessing (112x112 RGB, mean/std 127.5, raw
// output is a 512-d vector, NOT pre-normalized by the graph).

// Same '/all' subpath as ModelManager.ts — see that file for why (must be a
// single consistent module instance for Tensor/InferenceSession identity).
import * as ort from 'onnxruntime-web/all';
import type { AlignedFace, EmbeddingResult } from '../types';
import type { ModelManager, ModelManifestEntry } from './ModelManager';
import { pixelsToNCHWTensor } from './tensorUtils';

export class Embedder {
  private session: ort.InferenceSession | null = null;
  private manifestEntry: ModelManifestEntry | null = null;

  constructor(private modelManager: ModelManager) {}

  async initialize(): Promise<void> {
    this.session = await this.modelManager.getSession('embedder');
    this.manifestEntry = this.modelManager.getManifestEntry('embedder');
  }

  async embed(face: AlignedFace): Promise<EmbeddingResult> {
    if (!this.session || !this.manifestEntry) {
      throw new Error('Embedder not initialized — call initialize() first');
    }

    const tensorData = pixelsToNCHWTensor(
      face.pixels,
      face.size,
      this.manifestEntry.preprocessing.mean,
      this.manifestEntry.preprocessing.std,
      this.manifestEntry.preprocessing.colorOrder,
    );
    const tensor = new ort.Tensor('float32', tensorData, [1, 3, face.size, face.size]);

    const inputName = this.session.inputNames[0];
    const results = await this.session.run({ [inputName]: tensor });
    const outputName = this.session.outputNames[0];
    const raw = results[outputName].data as Float32Array;

    return {
      vector: l2Normalize(raw),
      modelVersion: this.manifestEntry.version,
    };
  }
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i];
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}
