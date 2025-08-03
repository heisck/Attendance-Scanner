const CACHE_NAME = 'attendance-scanner-v8'; // Updated paths to use root directory for icons
const urlsToCache = [
  './', // Cache the current directory (scanner/)
  'index.html',
  'style.css',
  'main-fixed.js',
  'html5-qrcode.min.js', // Cache the local library
  'scan-sound.mp3',
  'icon-192.png', // Path updated to root
  'icon-512.png'  // Path updated to root
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      }).then(() => self.skipWaiting()) // Force the waiting service worker to become the active one.
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Don't cache Google Apps Script requests - always fetch from network
  if (event.request.url.includes('script.google.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return response from cache, or fetch from network if not in cache
        return response || fetch(event.request);
      })
  );
});
