// Service worker (v0.3): network-first with a 3 s timeout → falls back to the cache, so a bad mobile connection
// never blocks the start. Audio: the page tells the worker which format this browser actually uses (ogg / m4a / mp3)
// and the worker precaches exactly those files, so the game works offline.
const CACHE = 'barrel-ninja-v4';
const NET_TIMEOUT_MS = 3000;
const ASSETS = ['./', './index.html', './vfx/vfx.js', './vfx/ninja-anim.js', './vfx/enemy-anim.js', './balance.json', './manifest.json', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './fonts/bungee-latin.woff2', './fonts/russo-one-latin.woff2', './fonts/rubik-latin.woff2', './audio/manifest.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    // einzeln cachen: ein fehlendes Asset bricht nicht alles ab, wird aber gemeldet
    const res = await Promise.allSettled(ASSETS.map(u => c.add(u)));
    res.forEach((r, i) => { if (r.status === 'rejected') console.warn('[sw] Asset nicht gecacht:', ASSETS[i], r.reason && r.reason.message); });
  }));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'precache' || !Array.isArray(d.urls)) return;
  const urls = d.urls.filter(u => typeof u === 'string' && /^audio\/[\w.-]+$/.test(u));
  e.waitUntil(caches.open(CACHE).then(async c => {
    for (const u of urls) { try { if (!(await c.match(u))) await c.add(u); } catch (err) { console.warn('[sw] Audio nicht gecacht:', u); } }
  }));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()).catch(() => {}); return r; });
    const cached = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    if (!cached) return net.catch(() => cache.match('./index.html').then(r => r || Response.error()));
    // Netz zuerst, aber höchstens NET_TIMEOUT_MS warten – dann sofort der Cache (Netz aktualisiert im Hintergrund)
    const timeout = new Promise(res => setTimeout(() => res(null), NET_TIMEOUT_MS));
    const r = await Promise.race([net.catch(() => null), timeout]);
    if (!r) e.waitUntil(net.catch(() => {}));
    return (r && r.ok) ? r : cached;
  })());
});
