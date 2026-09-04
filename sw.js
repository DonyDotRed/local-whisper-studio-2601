const CACHE = 'local-whisper-studio-v2-3-0';
const APP_SHELL = [
  './', './index.html', './styles.css?v=2.3.0', './app.js?v=2.3.0',
  './ffmpeg-client.js', './ffmpeg-worker.js', './stt-worker.js?v=2.3.0',
  './manifest.webmanifest', './icons/icon.svg', './samples/whisper-test.wav'
];

function isolated(response) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('local-whisper-studio-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const networkAndCache = async () => {
    const response = await fetch(event.request);
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return isolated(response);
  };

  // Network-first for app code: avoids old GitHub Pages/PWA code sticking around.
  if (event.request.mode === 'navigate' || /\.(?:js|css|html)$/.test(url.pathname)) {
    event.respondWith(
      networkAndCache().catch(async () => isolated((await caches.match(event.request)) || (await caches.match('./index.html'))))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached ? isolated(cached) : networkAndCache())
  );
});
