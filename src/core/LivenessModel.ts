// Wraps the MiniFASNetV2 anti-spoof ONNX session plus the always-on
// texture/moiré heuristic. See offline-face-recognition-spec.md §4.4 and
// models/manifest.json antispoof entry for the validated preprocessing
// (80x80 BGR, pixel/255, raw 3-class logits [live,print,replay] — softmax
// applied here, not baked into the graph). Explicit limitation: this is a
// deterrent against trivial photo/screen replay, not a guarantee against
// sophisticated spoofing — never present it as such in UI copy.

// Same '/all' subpath as ModelManager.ts — see that file for why (must be a
// single consistent module instance for Tensor/InferenceSession identity).
import * as ort from 'onnxruntime-web/all';
import type { AlignedFace, LivenessResult, MarginCrop } from '../types';
import type { FaceRecognitionConfig } from './config';
import type { ModelManager, ModelManifestEntry } from './ModelManager';
import { pixelsToNCHWTensor } from './tensorUtils';

export class LivenessModel {
  private session: ort.InferenceSession | null = null;
  private manifestEntry: ModelManifestEntry | null = null;

  constructor(
    private modelManager: ModelManager,
    private config: FaceRecognitionConfig['liveness'],
  ) {}

  async initialize(): Promise<void> {
    this.session = await this.modelManager.getSession('antispoof');
    this.manifestEntry = this.modelManager.getManifestEntry('antispoof');
  }

  /**
   * `face` (112x112 ArcFace-aligned, RGB) feeds the texture heuristic;
   * `marginCrop` (80x80 bbox-margin crop, see Aligner.cropWithMargin) feeds
   * the actual anti-spoof model — they are intentionally different crops,
   * see models/manifest.json antispoof.crop.
   */
  async check(face: AlignedFace, marginCrop: MarginCrop): Promise<LivenessResult> {
    if (!this.session || !this.manifestEntry) {
      throw new Error('LivenessModel not initialized — call initialize() first');
    }

    const modelScore = await this.runModel(marginCrop);
    const textureHeuristicScore = textureHeuristic(face);

    // Simple weighted combination; tune weights empirically per
    // privacy-and-testing.md before relying on this in production.
    const score = 0.8 * modelScore + 0.2 * textureHeuristicScore;

    return {
      score,
      passed: score >= this.config.minScore,
      signals: { modelScore, textureHeuristicScore },
    };
  }

  private async runModel(crop: MarginCrop): Promise<number> {
    if (!this.session || !this.manifestEntry) throw new Error('LivenessModel not initialized');

    const tensorData = pixelsToNCHWTensor(
      crop.pixels,
      crop.size,
      this.manifestEntry.preprocessing.mean,
      this.manifestEntry.preprocessing.std,
      this.manifestEntry.preprocessing.colorOrder,
    );
    const tensor = new ort.Tensor('float32', tensorData, [1, 3, crop.size, crop.size]);

    const inputName = this.session.inputNames[0];
    const results = await this.session.run({ [inputName]: tensor });
    const outputName = this.session.outputNames[0];
    const logits = results[outputName].data as Float32Array; // [live, print-attack, replay-attack]

    const probs = softmax(logits);
    return probs[0]; // p(live)
  }
}

function softmax(logits: Float32Array): Float32Array {
  const max = Math.max(...logits);
  const exp = Float32Array.from(logits, (v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return Float32Array.from(exp, (v) => v / sum);
}

/**
 * Cheap, model-free defense-in-depth signal: screen replays commonly exhibit
 * higher local pixel-to-pixel variance (moiré/aliasing) than real skin under
 * normal webcam compression. Returns a score in [0,1] where higher = more
 * "real-looking" texture. This is a heuristic, not a guarantee — see module
 * docblock above.
 */
export function textureHeuristic(face: AlignedFace): number {
  const { pixels, size } = face;
  let totalVariance = 0;
  let samples = 0;

  for (let y = 1; y < size - 1; y += 2) {
    for (let x = 1; x < size - 1; x += 2) {
      const idx = (y * size + x) * 3;
      const center = pixels[idx];
      const right = pixels[idx + 3];
      const down = pixels[(y + 1) * size * 3 + x * 3];
      totalVariance += Math.abs(center - right) + Math.abs(center - down);
      samples++;
    }
  }

  const avgVariance = samples > 0 ? totalVariance / samples : 0;
  // Empirical-ish mapping: very low variance (flat/printed photo) or very
  // high variance (moiré) both score low; moderate natural texture scores
  // high. Midpoint and slope must be re-tuned against real captured data —
  // see privacy-and-testing.md §3 (bias/performance testing).
  const idealMidpoint = 12;
  const distance = Math.abs(avgVariance - idealMidpoint);
  return Math.max(0, 1 - distance / idealMidpoint);
}
