// Shared pixel <-> tensor conversion helpers used by FaceDetector, Embedder,
// and LivenessModel. Each model has its own mean/std/colorOrder (see
// models/manifest.json preprocessing fields per model) but the same HWC
// uint8 -> NCHW float32 conversion shape, hence factored out here rather
// than duplicated three times.

export function imageDataToRGBPixels(imageData: ImageData): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray((imageData.data.length / 4) * 3);
  for (let i = 0, j = 0; i < imageData.data.length; i += 4, j += 3) {
    pixels[j] = imageData.data[i];
    pixels[j + 1] = imageData.data[i + 1];
    pixels[j + 2] = imageData.data[i + 2];
    // alpha dropped intentionally — RGB only downstream
  }
  return pixels;
}

/** RGB Uint8ClampedArray (HWC) -> normalized NCHW Float32Array, with optional BGR swap. */
export function pixelsToNCHWTensor(
  pixels: Uint8ClampedArray,
  size: number,
  mean: number[],
  std: number[],
  colorOrder: 'RGB' | 'BGR',
): Float32Array {
  const channelSize = size * size;
  const out = new Float32Array(3 * channelSize);
  for (let p = 0; p < channelSize; p++) {
    const r = pixels[p * 3];
    const g = pixels[p * 3 + 1];
    const b = pixels[p * 3 + 2];
    const channels = colorOrder === 'RGB' ? [r, g, b] : [b, g, r];
    out[p] = (channels[0] - mean[0]) / std[0];
    out[channelSize + p] = (channels[1] - mean[1]) / std[1];
    out[2 * channelSize + p] = (channels[2] - mean[2]) / std[2];
  }
  return out;
}

/** Draws a CanvasImageSource into a letterboxed (aspect-preserving, padded) square canvas. Returns the scale factor applied. */
export function letterboxToSquare(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetSize: number,
): { imageData: ImageData; scale: number } {
  const scale = targetSize / Math.max(sourceWidth, sourceHeight);
  const scaledWidth = Math.round(sourceWidth * scale);
  const scaledHeight = Math.round(sourceHeight * scale);

  const canvas = new OffscreenCanvas(targetSize, targetSize);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, targetSize, targetSize); // padding for the non-square remainder
  ctx.drawImage(source, 0, 0, scaledWidth, scaledHeight);

  return { imageData: ctx.getImageData(0, 0, targetSize, targetSize), scale };
}
