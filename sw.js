/* Service worker: aplikasi bisa dibuka offline setelah pernah dimuat sekali (butuh internet saat pertama kali). */
const VERSION = 'v3';
const CORE = 'faktur-core-' + VERSION, LIBS = 'faktur-libs-' + VERSION;
const CORE_FILES = ['./', './index.html', './manifest.json', './tagihan.html', './theme.js', './backup.js', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-32.png', './icons/apple-touch-icon.png'];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE).then(c => Promise.all(CORE_FILES.map(f => c.add(f).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CORE && k !== LIBS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* Library CDN (xlsx, exceljs, dexie): cache-first, disimpan saat pertama diambil. */
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(LIBS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  /* File aplikasi: utamakan versi terbaru dari jaringan, cadangan dari cache (offline). */
  e.respondWith(fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CORE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(h => h || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))));
});
