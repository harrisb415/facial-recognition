import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation headers are required for SharedArrayBuffer, which
// onnxruntime-web's multi-threaded WASM execution provider depends on.
// Without these headers the app still runs, just falls back to single-threaded
// WASM (see offline-model-loading-plan.md). When deploying to a static host,
// replicate this header pair at that host's config layer (netlify.toml,
// vercel.json headers, nginx add_header, S3+CloudFront response headers policy).
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
});
