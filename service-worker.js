const CACHE_NAME = 'anonostr-cache-v1.3.6';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/images/anonostr-icon.png',
  '/images/anonostr-hero.png',
  '/styles.css',
  '/app.js'
];

// Install the service worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// Fetch event
self.addEventListener('fetch', event => {
  // Only handle requests for local resources
  if (event.request.url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(event.request).then(response => {
        return response || fetch(event.request);
      }).catch(() => {
        // Handle fetch failure when offline or resource is not in cache
        return new Response('You are offline, and the resource is not cached.', {
          status: 404,
          statusText: 'Resource not found in cache',
        });
      })
    );
  }
});

// Activate event
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});