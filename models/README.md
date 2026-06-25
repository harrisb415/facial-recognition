# models/ — obtaining, converting, and quantizing model weights

This directory ships **without** model weight binaries. `manifest.json` describes what's expected; this document describes how to produce those files yourself. None of the steps below are executed automatically by the app or by Claude Code — they require you to run conversion tooling once, offline, on your own machine, with your own sourced weights.

```
models/
├── manifest.json          # registry: filenames, versions, dims, quantization, sizes
├── README.md               # this file
├── detector/.gitkeep       # place scrfd_tiny.onnx (+ optional tfjs/ dir) here
├── embedder/.gitkeep       # place mobilefacenet.onnx (+ optional tfjs/ dir) here
└── antispoof/.gitkeep      # place antispoof_tiny.onnx (+ optional tfjs/ dir) here
```

## 0. License due diligence first

Before downloading any pre-trained weight file, check its license and training-data provenance. The network architectures referenced below (SCRFD, MobileFaceNet, MobileNetV2-style classifiers) are commonly published under permissive licenses, but **specific pre-converted weight files redistributed by third parties may carry different or additional terms** (and some are trained on datasets with usage restrictions, e.g. non-commercial-only). Fill in the `"license"` field in `manifest.json` with the actual verified license of the file you use — the placeholder `"REPLACE — verify license..."` is a deliberate prompt, not a default to ignore.

## 1. Face detector — SCRFD (tiny variant)

**What to look for:** an SCRFD export (sometimes labeled `scrfd_500m`, `scrfd_1g`, or `scrfd_2.5g` depending on FLOPs budget — "tiny" here means the smallest published variant, typically the 500M-FLOPs one) already converted to ONNX. SCRFD's reference implementation is commonly distributed via the InsightFace project; ONNX exports of the smaller variants are widely mirrored.

**If you only find a PyTorch/MXNet checkpoint, convert it yourself:**

```bash
# Example shape — adapt to whichever SCRFD repo/checkpoint you actually use.
# This is illustrative; run only after reading the source repo's own export script.
python export_onnx.py \
  --weights scrfd_500m.pth \
  --input-size 320 320 \
  --output scrfd_tiny.onnx \
  --opset 12
```

**Quantize to INT8 (dynamic quantization, no calibration dataset needed):**

```bash
python -m pip install onnxruntime onnx
python -c "
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic('scrfd_tiny_fp32.onnx', 'scrfd_tiny.onnx', weight_type=QuantType.QInt8)
"
```

Place the result at `models/detector/scrfd_tiny.onnx`. Update `manifest.json`'s `detector` entry: confirm `inputSize` matches the `--input-size` you exported with, and recompute `sha256`/`approxSizeBytes` (see §4 below).

**Optional TF.js fallback export** (only needed if you want the TF.js fallback path to actually work end-to-end, not just exist in code):

```bash
pip install tensorflow onnx-tf tensorflowjs
onnx-tf convert -i scrfd_tiny_fp32.onnx -o scrfd_tiny_tf_saved_model
tensorflowjs_converter --input_format=tf_saved_model \
  --quantize_uint8 \
  scrfd_tiny_tf_saved_model models/detector/scrfd_tiny_tfjs
```

## 2. Face embedder — MobileFaceNet

**What to look for:** a MobileFaceNet ONNX export trained for face verification (ArcFace-style loss), 112×112 input. Public conversions commonly originate from InsightFace-trained checkpoints. Output dimension varies by source (128-d, 192-d, and 512-d are all common) — **whichever you pick, update `manifest.json`'s `embedder.outputDim` and `src/core/Embedder.ts`'s expectations to match.** Do not assume 192-d; that value in the shipped manifest is a placeholder.

**Convert from PyTorch (illustrative):**

```bash
python -c "
import torch
model = torch.load('mobilefacenet.pth', map_location='cpu')
model.eval()
dummy = torch.randn(1, 3, 112, 112)
torch.onnx.export(model, dummy, 'mobilefacenet_fp32.onnx', opset_version=12,
                   input_names=['input'], output_names=['embedding'])
"
```

**Quantize:**

```bash
python -c "
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic('mobilefacenet_fp32.onnx', 'mobilefacenet.onnx', weight_type=QuantType.QInt8)
"
```

INT8 dynamic quantization typically costs a small amount of verification accuracy (often well under 1% on standard benchmarks, but **measure it yourself** — see [privacy-and-testing.md](../privacy-and-testing.md) §1). If your use case is higher-stakes, ship the FP32 or FP16 weights instead and accept the larger download.

Place the result at `models/embedder/mobilefacenet.onnx`.

## 3. Anti-spoof / liveness model

**What to look for:** a small binary real-vs-spoof classifier. There is less standardization here than for detection/embedding — common starting points are a MobileNetV2 (width multiplier 0.25 or 0.35) fine-tuned on a face anti-spoofing dataset (e.g. CelebA-Spoof, NUAAA, CASIA-FASD derivatives — check dataset licenses too, several are research-only). If you train your own, a 112×112 input, single sigmoid output is the simplest target shape and matches `manifest.json`'s placeholder.

**Convert + quantize:** same pattern as §1/§2 — export to ONNX via `torch.onnx.export` (or equivalent for your training framework), then `quantize_dynamic`.

Place the result at `models/antispoof/antispoof_tiny.onnx`.

**If you cannot source or train an anti-spoof model right away:** the app's `textureHeuristic()` function (`src/core/LivenessModel.ts`) provides a model-free fallback signal on its own. It is weaker than a trained classifier but lets you ship the rest of the pipeline while you source/train the anti-spoof model — see the TODO comments in that file for how the two signals combine, and reduce the model-score weight to 0 temporarily if no model is loaded.

## 4. After placing each file: compute checksums and sizes

```bash
# from the models/ directory
sha256sum detector/scrfd_tiny.onnx
sha256sum embedder/mobilefacenet.onnx
sha256sum antispoof/antispoof_tiny.onnx
ls -la detector/scrfd_tiny.onnx embedder/mobilefacenet.onnx antispoof/antispoof_tiny.onnx
```

Copy the resulting hashes into each entry's `sha256` field and the byte sizes into `approxSizeBytes` in [manifest.json](manifest.json). `ModelManager`/the service worker use `sha256` (when present and non-placeholder) to verify a cached/downloaded file hasn't been corrupted or truncated — see [offline-model-loading-plan.md](../offline-model-loading-plan.md) §2.2.

## 5. Verifying input/output shapes before wiring up code

Before implementing the TODO stubs in `src/core/FaceDetector.ts`, `Embedder.ts`, and `LivenessModel.ts`, inspect the actual ONNX graph I/O of whatever files you sourced:

```bash
python -c "
import onnx
m = onnx.load('embedder/mobilefacenet.onnx')
for inp in m.graph.input:
    print('input', inp.name, [d.dim_value for d in inp.type.tensor_type.shape.dim])
for out in m.graph.output:
    print('output', out.name, [d.dim_value for d in out.type.tensor_type.shape.dim])
"
```

Do this for all three models. Update `manifest.json` (`inputSize`, `outputDim`, `preprocessing`) to match reality, not the placeholders shipped in this scaffold — the placeholders are best-guess defaults for the most common public conversions, not a guarantee for whatever specific file you end up with.

## 6. Directory layout once populated

```
models/
├── manifest.json
├── README.md
├── detector/
│   ├── .gitkeep
│   ├── scrfd_tiny.onnx
│   └── scrfd_tiny_tfjs/        # optional, only if TF.js fallback is needed
│       ├── model.json
│       └── group1-shard1of1.bin
├── embedder/
│   ├── .gitkeep
│   ├── mobilefacenet.onnx
│   └── mobilefacenet_tfjs/
│       ├── model.json
│       └── group1-shard1of1.bin
└── antispoof/
    ├── .gitkeep
    ├── antispoof_tiny.onnx
    └── antispoof_tiny_tfjs/
        ├── model.json
        └── group1-shard1of1.bin
```

Real model files (everything except `.gitkeep`) are git-ignored by default (see repo root `.gitignore`) — they are large binaries with their own license/provenance and shouldn't be assumed safe to commit without a deliberate decision. If you want them version-controlled, use Git LFS rather than removing the `.gitignore` rule wholesale.
