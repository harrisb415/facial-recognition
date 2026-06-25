// Wraps the tiny anti-spoof ONNX session plus the always-on texture/moiré
// heuristic. See offline-face-recognition-spec.md §4.4. Explicit limitation:
// this is a deterrent against trivial photo/screen replay, not a guarantee
// against sophisticated spoofing — never present it as such in UI copy.

import type { AlignedFace, LivenessResult } from '../types';
import type { FaceRecognitionConfig } from './config';
import type { ModelManager } from './ModelManager';

export class LivenessModel {
  private session: unknown = null;

  constructor(
    private modelManager: ModelManager,
    private config: FaceRecognitionConfig['liveness'],
  ) {}

  async initialize(): Promise<void> {
    this.session = await this.modelManager.getSession('antispoof');
  }

  async check(face: AlignedFace): Promise<LivenessResult> {
    if (!this.session) throw new Error('LivenessModel not initialized — call initialize() first');

    // TODO(impl): preprocess face.pixels per manifest.models[antispoof]
    // preprocessing, run the ONNX session, take the real/spoof logit and
    // convert to a [0,1] probability (sigmoid if the export is a raw logit).
    const modelScore = await this.runModel(face);
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

  private async runModel(_face: AlignedFace): Promise<number> {
    throw new Error('LivenessModel.runModel() not yet implemented — see TODO in check()');
  }
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
