// Wraps the MiniFASNetV2 anti-spoof ONNX session plus the always-on
// texture/moiré heuristic. See offline-face-recognition-spec.md §4.4 and
// public/models/manifest.json antispoof entry for the validated
// preprocessing (80x80 BGR, pixel/255, raw 3-class logits — softmax applied
// here, not baked into the graph).
//
// CLASS INDEX 1 = REAL/LIVE, not index 0. Confirmed directly from the
// upstream minivision-ai Silent-Face-Anti-Spoofing repo's own test.py
// (`label = np.argmax(prediction); if label == 1: ... "Real Face"`).
// Indices 0 and 2 are both "fake" classes (their exact attack-type meaning
// — print vs replay — is not confirmed, only that 1 is real). An earlier
// version of this file read probs[0] as p(live), based on a third-party
// summary rather than the source code — that's a "fake" index, so it was
// always low for both real AND fake faces, causing every live-camera
// liveness check to fail regardless of input. Caught via real-camera
// testing (instant, 100%-reproducible liveness failure) — a static-photo
// validation test cannot catch this particular bug, since a non-live photo
// correctly scores low on BOTH index 0 and index 1, so confusing the two
// still "looks right" against photo-only test data.
//
// Explicit limitation: this is a deterrent against trivial photo/screen
// replay, not a guarantee against sophisticated spoofing — never present it
// as such in UI copy.

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

    const probs = await this.runModel(marginCrop);
    const modelScore = probs[1] ?? 0; // p(live) — see module docblock (index 1, per source repo)
    const texture = textureHeuristic(face);

    // Simple weighted combination; tune weights empirically per
    // privacy-and-testing.md before relying on this in production.
    const score = 0.8 * modelScore + 0.2 * texture.score;

    // TEMPORARY DIAGNOSTIC (2026-06-25): real-camera liveness checks keep
    // failing despite the class-index + crop-bounds fixes, and the HF model
    // card (index 0 = live) contradicts the upstream source repo (index 1 =
    // real), so we can't resolve which index is correct without seeing real
    // output. Log the full distribution + sub-scores. Remove once liveness
    // is confirmed working on a real face. Appears in the browser console.
    // eslint-disable-next-line no-console
    console.log(
      `[liveness] rawProbs=[${Array.from(probs)
        .map((p) => p.toFixed(3))
        .join(', ')}] modelScore(idx1)=${modelScore.toFixed(3)} ` +
        `textureScore=${texture.score.toFixed(3)} (avgVar=${texture.avgVariance.toFixed(1)}) ` +
        `combined=${score.toFixed(3)} minScore=${this.config.minScore} passed=${score >= this.config.minScore}`,
    );

    return {
      score,
      passed: score >= this.config.minScore,
      signals: {
        modelScore,
        textureHeuristicScore: texture.score,
        rawProbs: Array.from(probs),
        textureAvgVariance: texture.avgVariance,
      },
    };
  }

  private async runModel(crop: MarginCrop): Promise<Float32Array> {
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
    const logits = results[outputName].data as Float32Array;

    return softmax(logits);
  }
}

function softmax(logits: Float32Array): Float32Array {
  const max = Math.max(...logits);
  const exp = Float32Array.from(logits, (v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return Float32Array.from(exp, (v) => v / sum);
}

export interface TextureHeuristicResult {
  /** [0,1], higher = more "real-looking" texture. */
  score: number;
  /** Mean local-gradient magnitude actually measured — exposed for tuning idealMidpoint. */
  avgVariance: number;
}

/**
 * Cheap, model-free defense-in-depth signal: screen replays commonly exhibit
 * higher local pixel-to-pixel variance (moiré/aliasing) than real skin under
 * normal webcam compression. Returns a score in [0,1] where higher = more
 * "real-looking" texture, plus the raw avgVariance for tuning. This is a
 * heuristic, not a guarantee — see module docblock above.
 */
export function textureHeuristic(face: AlignedFace): TextureHeuristicResult {
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
  // see privacy-and-testing.md §3 (bias/performance testing). NOTE: this
  // window is narrow (returns 0 for avgVariance >= 24), and a detailed real
  // webcam face can easily exceed that — which is exactly why the combined
  // score weights the model at 0.8 and this at only 0.2.
  const idealMidpoint = 12;
  const distance = Math.abs(avgVariance - idealMidpoint);
  return { score: Math.max(0, 1 - distance / idealMidpoint), avgVariance };
}
