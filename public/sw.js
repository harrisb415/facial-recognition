// Service worker: cache-first for model files (under /models/), stale-while-
// revalidate for the app shell. No request ever leaves this origin — there
// is no cross-origin fetch anywhere in this file by design. See
// offline-model-loading-plan.md §1-2 for the full strategy this implements.

const SHELL_CACHE = 'app-shell-v1';
const MODELS_CACHE = 'models-v1';
const CURRENT_CACHES = new Set([SHELL_CACHE, MODELS_CACHE]);

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => !CURRENT_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isModelRequest(url) {
  return url.pathname.startsWith('/models/');
}

async function cacheFirstModels(request) {
  const cache = await caches.open(MODELS_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidateShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  return cached ?? (await networkFetch) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept cross-origin requests — this app makes none in its own
  // code, but a defensive check here ensures the SW itself never becomes the
  // mechanism by which a future regression starts leaking requests offsite.
  if (url.origin !== self.location.origin) return;

  if (event.request.method !== 'GET') return;

  if (isModelRequest(url)) {
    event.respondWith(cacheFirstModels(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidateShell(event.request));
});

// Allows ModelManager (main thread) to force-refresh a specific model file
// when models/manifest.json reports a new version for it, without bumping
// MODELS_CACHE wholesale. See offline-model-loading-plan.md §2.3.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'INVALIDATE_MODEL') return;
  const { url } = event.data;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(MODELS_CACHE);
      await cache.delete(url);
    })(),
  );
});
