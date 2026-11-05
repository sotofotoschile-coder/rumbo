// Worker: copia un paquete de mapa (archivo elegido o descarga) al almacenamiento
// privado de la app (OPFS) por trozos, para no cargar cientos de MB en memoria.
self.onmessage = async (e) => {
  const { origen, destino } = e.data;
  let dir = null;
  let acceso = null;
  try {
    const raiz = await navigator.storage.getDirectory();
    dir = await raiz.getDirectoryHandle('mapas', { create: true });
    const handle = await dir.getFileHandle(destino, { create: true });
    acceso = await handle.createSyncAccessHandle();
    acceso.truncate(0);
    let pos = 0;
    const escribir = (datos) => {
      const u = datos instanceof Uint8Array ? datos : new Uint8Array(datos);
      let n = 0;
      while (n < u.length) n += acceso.write(u.subarray(n), { at: pos + n });
      pos += u.length;
    };

    if (origen instanceof Blob) {
      const total = origen.size;
      const TROZO = 8 * 1024 * 1024;
      for (let i = 0; i < total; i += TROZO) {
        escribir(await origen.slice(i, i + TROZO).arrayBuffer());
        self.postMessage({ tipo: 'progreso', hecho: pos, total });
      }
    } else {
      const r = await fetch(origen.url);
      if (!r.ok) throw new Error(`La descarga falló (HTTP ${r.status}).`);
      const total = Number(r.headers.get('content-length')) || 0;
      const lector = r.body.getReader();
      let ultimo = 0;
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        escribir(value);
        if (pos - ultimo > 1 << 20) {
          ultimo = pos;
          self.postMessage({ tipo: 'progreso', hecho: pos, total });
        }
      }
    }
    acceso.flush();
    acceso.close();
    acceso = null;
    self.postMessage({ tipo: 'listo', bytes: pos });
  } catch (err) {
    try { if (acceso) acceso.close(); } catch (_) { /* ya cerrado */ }
    try { if (dir) await dir.removeEntry(destino); } catch (_) { /* no existía */ }
    self.postMessage({ tipo: 'error', mensaje: err && err.message ? err.message : String(err) });
  }
};
