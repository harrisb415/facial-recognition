// Wraps the MobileFaceNet ONNX session: preprocess aligned crop -> run ->
// L2-normalize output embedding. See offline-face-recognition-spec.md §4.3.

import type { AlignedFace, EmbeddingResult } from '../types';
import type { ModelManager, ModelManifestEntry } from './ModelManager';

export class Embedder {
  private session: unknown = null;
  private manifestEntry: ModelManifestEntry | null = null;

  constructor(private modelManager: ModelManager) {}

  async initialize(): Promise<void> {
    this.session = await this.modelManager.getSession('embedder');
    this.manifestEntry = this.modelManager.getManifestEntry('embedder');
  }

  async embed(_face: AlignedFace): Promise<EmbeddingResult> {
    if (!this.session || !this.manifestEntry) {
      throw new Error('Embedder not initialized — call initialize() first');
    }

    // TODO(impl):
    // 1. Convert face.pixels (Uint8ClampedArray RGB, face.size x face.size)
    //    into a Float32Array tensor in NCHW or NHWC order — confirm against
    //    the sourced ONNX export's expected input layout.
    // 2. Normalize using manifestEntry.preprocessing (mean/std/colorOrder),
    //    e.g. for the common (pixel/255 - 0.5) / 0.5 scheme: mean=[127.5]*3,
    //    std=[127.5]*3 — but verify this against the actual chosen weights,
    //    do not assume.
    // 3. Run the ONNX session, take the single output tensor.
    // 4. L2-normalize before returning (required — VectorStore.cosineSimilarity
    //    assumes unit-length vectors and skips re-normalizing for performance).
    throw new Error('Embedder.embed() not yet implemented — see TODO above');
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
