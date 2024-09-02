const CACHE_NAME = 'anonostr-cache-v1.4.8';
const CACHE_EXPIRATION_HOURS = 4;
const LAST_CACHE_CLEAR_TIME_KEY = 'anonostr-last-cache-clear-time';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/images/anonostr-icon.png',
  '/images/anonostr-hero.png',
  '/styles.css',
  '/app.js',
  // External Resources
  'https://unpkg.com/nostr-tools/lib/nostr.bundle.js',
  'https://buttons.github.io/buttons.js',
  'https://cdn.jsdelivr.net/npm/nostr-zap@1.1.0'
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
  const requestUrl = new URL(event.request.url);

  // Check if the request is for a local resource or an explicitly cached external resource
  if (urlsToCache.includes(requestUrl.href) || requestUrl.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(response => {
        // Return the cached version if available, otherwise fetch from the network
        return response || fetch(event.request).then(networkResponse => {
          // Optionally, cache the newly fetched response for future use
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        });
      }).catch(() => {
        // Handle fetch failure when offline or resource is not in cache
        return new Response('You are offline, and the resource is not cached.', {
          status: 404,
          statusText: 'Resource not found in cache',
        });
      })
    );
  } else {
    // For any other requests (especially external), fetch from the network
    event.respondWith(fetch(event.request));
  }
});

// Activate event
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const cacheWhitelist = [CACHE_NAME];

      // Check if cache needs to be cleared
      const lastCacheClearTime = localStorage.getItem(LAST_CACHE_CLEAR_TIME_KEY);
      const now = Date.now();
      const hoursSinceLastClear = (now - lastCacheClearTime) / (1000 * 60 * 60);

      if (hoursSinceLastClear > CACHE_EXPIRATION_HOURS) {
        // Clear old caches
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames.map(cacheName => {
            if (!cacheWhitelist.includes(cacheName)) {
              return caches.delete(cacheName);
            }
          })
        );

        // Clear the current cache
        await caches.delete(CACHE_NAME);

        // Re-cache necessary files
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(urlsToCache);

        // Update the last cache clear time
        localStorage.setItem(LAST_CACHE_CLEAR_TIME_KEY, now);
      }

      // Delete any caches that aren't in the whitelist
      await Promise.all(
        cacheNames.map(cacheName => {
          if (!cacheWhitelist.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })()
  );
});