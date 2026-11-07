// Service worker: guarda la app completa en el iPhone para que abra sin conexión.
// VERSION la reescribe herramientas/preparar_app.py en cada cambio.
const VERSION = 'rumbo-ad85d6fae2';

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
    // El motor y el modelo del dictado se guardan aparte: no se borran al actualizar la app.
    const CONSERVAR = new Set([VERSION, 'rumbo-dictado', 'transformers-cache']);
    for (const k of await caches.keys()) if (!CONSERVAR.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Motor del dictado sin conexión (27 MB): se guarda la primera vez que se usa y después sale del iPhone.
  if (url.pathname.includes('/vendor/transformers/')) {
    e.respondWith((async () => {
      const cache = await caches.open('rumbo-dictado');
      const guardado = await cache.match(req, { ignoreSearch: true });
      if (guardado) return guardado;
      const r = await fetch(req);
      if (r.ok) await cache.put(req, r.clone());
      return r;
    })());
    return;
  }
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
