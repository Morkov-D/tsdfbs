/* StockFlow TSD service worker 5.2.0 — old IndexedDB data is NEVER cleared. */
'use strict';
const CACHE = 'stockflow-tsd-v5.2.0';
const PREFIX = 'stockflow-tsd-';
const ASSETS = [
  './', './index.html',
  './styles.css?v=5.2.0', './db.js?v=5.2.0',
  './api.js?v=5.2.0', './app.js?v=5.2.0', './receipt.js?v=5.2.0',
  './manifest.webmanifest?v=5.2.0', './icons/stockflow.svg?v=5.2.0'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  // Navigation checks the network first so a new deployment is discovered.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put('./index.html', copy)));
      }
      return response;
    }).catch(async () => (await caches.match('./index.html')) || Response.error()));
    return;
  }
  // Versioned JavaScript/CSS stays usable offline.
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
    }
    return response;
  })));
});
