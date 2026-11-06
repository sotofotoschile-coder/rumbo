// Service worker: guarda la app completa en el iPhone para que abra sin conexión.
// VERSION la reescribe herramientas/preparar_app.py en cada cambio.
const VERSION = 'rumbo-61e080c637';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const lista = await (await fetch('./precache.json', { cache: 'no-store' })).json();
    const cache = await caches.open(VERSION);
    await cache.addAll(lista.map((r) => new Request(r, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const guardado = await cache.match(req, { ignoreSearch: true });
    if (guardado) return guardado;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return new Response('', { status: 404, statusText: 'Sin conexión' });
    }
  })());
});
