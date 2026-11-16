const CACHE_NAME = 'animevault-shell-v147-poster-transfer';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
const CDN_ASSETS = [
  'https://unpkg.com/dexie@4.0.11/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await Promise.all(CDN_ASSETS.map(async url => {
      try { const response = await fetch(url, {mode:'no-cors'}); await cache.put(url, response); } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('animevault-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell: serve cached files first, update cache in the background.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, {ignoreSearch:true});
      const network = fetch(req).then(response => {
        if (response && (response.ok || response.type === 'opaque')) cache.put(req, response.clone()).catch(()=>{});
        return response;
      }).catch(()=>null);
      if (cached) { network.catch(()=>{}); return cached; }
      return (await network) || new Response('Offline', {status:503,headers:{'Content-Type':'text/plain'}});
    })());
    return;
  }

  // Cache-first for the pinned Dexie dependency; other image/API requests are network-first.
  if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const response = await fetch(req);
        if (response.ok || response.type === 'opaque') cache.put(req,response.clone()).catch(()=>{});
        return response;
      } catch (_) {
        return new Response('', {status:503});
      }
    })());
  }
});
