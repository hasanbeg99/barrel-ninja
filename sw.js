// Network-first service worker: always tries the fresh version, falls back to cache offline.
// Audio: the page tells the worker which format this browser uses (ogg / m4a / mp3) and the worker
// precaches exactly those files (SFX, ambience, all three music tiers), so the game works offline.
const CACHE = 'barrel-ninja-v2-nodiag';
const ASSETS = ['./', './index.html', './manifest.json', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './fonts/bungee-latin.woff2', './fonts/russo-one-latin.woff2', './fonts/rubik-latin.woff2', './audio/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{})); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'precache' || !Array.isArray(d.urls)) return;
  const urls = d.urls.filter(u => typeof u === 'string' && /^audio\/[\w.-]+$/.test(u));
  e.waitUntil(caches.open(CACHE).then(async c => {
    for (const u of urls) { try { if (!(await c.match(u))) await c.add(u); } catch(err) {} }
  }));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{}); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
