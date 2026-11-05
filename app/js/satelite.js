// Capas satelitales:
// - Sentinel-2 cloudless 2025 (EOX, 10 m/píxel): se descarga por zonas y funciona sin conexión.
// - Esri World Imagery (submétrica): solo con internet y con la clave gratuita de ArcGIS del usuario.
import { db, nuevoId } from './db.js';

export const ZOOM_MAX = 14; // Sentinel-2 tiene 10 m/píxel: más allá solo se amplía
export const BYTES_POR_TESELA = 15000; // promedio medido en Magallanes (tierra ~18 KB, mar ~3 KB)
export const LIMITE_TESELAS = 90000;
const URL_EOX = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${y}/${x}.jpg`;
export const URL_ESRI = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ATRIBUCION_S2 = '<a href="https://s2maps.eu">Sentinel-2 cloudless 2025</a> © EOX (CC BY-NC-SA 4.0), datos Copernicus modificados';
export const ATRIBUCION_ESRI = 'Imágenes © Esri, Maxar, Earthstar Geographics';

// PNG transparente de 1×1 para zonas sin imagen.
const TRANSPARENTE = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

// bbox = [oeste, sur, este, norte]
export function rangos(bbox, zMin, zMax) {
  const out = [];
  for (let z = zMin; z <= zMax; z++) {
    const max = 2 ** z - 1;
    out.push({
      z,
      x0: Math.max(0, lon2x(bbox[0], z)), x1: Math.min(max, lon2x(bbox[2], z)),
      y0: Math.max(0, lat2y(bbox[3], z)), y1: Math.min(max, lat2y(bbox[1], z)),
    });
  }
  return out;
}

export const contarTeselas = (bbox, zMin, zMax) =>
  rangos(bbox, zMin, zMax).reduce((n, r) => n + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0);

function* teselas(bbox, zMin, zMax) {
  for (const r of rangos(bbox, zMin, zMax)) {
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield `${r.z}/${x}/${y}`;
  }
}

const cubre = (zona, z, x, y) => z >= zona.zMin && z <= zona.zMax && (() => {
  const [r] = rangos(zona.bbox, z, z);
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
})();

export async function listarZonas() {
  return (await db.todos('zonas')).sort((a, b) => b.creado - a.creado);
}

// Descarga una zona. señal: AbortSignal para cancelar. Devuelve la zona guardada.
export async function descargarZona({ nombre, bbox, zMin, zMax }, alProgreso, senal) {
  const total = contarTeselas(bbox, zMin, zMax);
  if (total > LIMITE_TESELAS) throw new Error('La zona es demasiado grande. Acerca el mapa o elige menos detalle.');
  const zona = { id: nuevoId(), nombre, bbox, zMin, zMax, teselas: total, bytes: 0, creado: Date.now(), completa: false };
  await db.guardar('zonas', zona);

  const gen = teselas(bbox, zMin, zMax);
  let hechas = 0;
  let fallidas = 0;
  let pendientes = [];
  const guardarPendientes = async () => {
    if (!pendientes.length) return;
    const lote = pendientes;
    pendientes = [];
    await db.guardarVarios('sat', lote);
  };

  const trabajador = async () => {
    for (;;) {
      if (senal?.aborted) return;
      const lote = [];
      for (let i = 0; i < 24; i++) { const n = gen.next(); if (n.done) break; lote.push(n.value); }
      if (!lote.length) return;
      const ya = await db.existentes('sat', lote);
      for (const id of lote) {
        if (senal?.aborted) return;
        if (!ya.has(id)) {
          const [z, x, y] = id.split('/').map(Number);
          let ok = false;
          for (let intento = 0; intento < 3 && !ok; intento++) {
            try {
              const r = await fetch(URL_EOX(z, x, y), { signal: senal });
              if (r.ok) {
                const blob = await r.blob();
                zona.bytes += blob.size;
                pendientes.push({ id, blob });
                ok = true;
              }
            } catch (e) {
              if (senal?.aborted) return;
            }
          }
          if (!ok) fallidas++;
          if (pendientes.length >= 40) await guardarPendientes();
        }
        hechas++;
        alProgreso?.(hechas, total, zona.bytes);
      }
    }
  };

  await Promise.all(Array.from({ length: 6 }, trabajador));
  await guardarPendientes();
  zona.completa = !senal?.aborted && fallidas === 0;
  zona.fallidas = fallidas;
  await db.guardar('zonas', zona);
  if (fallidas === total && total > 0) throw new Error('No se pudo descargar ninguna imagen. Revisa tu conexión a internet.');
  return zona;
}

// Borra la zona y las teselas que ninguna otra zona usa.
export async function borrarZona(zona) {
  const otras = (await listarZonas()).filter((z) => z.id !== zona.id);
  let lote = [];
  for (const id of teselas(zona.bbox, zona.zMin, zona.zMax)) {
    const [z, x, y] = id.split('/').map(Number);
    if (!otras.some((o) => cubre(o, z, x, y))) lote.push(id);
    if (lote.length >= 500) { await db.borrarVarios('sat', lote); lote = []; }
  }
  if (lote.length) await db.borrarVarios('sat', lote);
  await db.borrar('zonas', zona.id);
}

async function local(z, x, y) {
  const r = await db.obtener('sat', `${z}/${x}/${y}`);
  return r ? r.blob : null;
}

// Si falta una tesela, amplía la parte correspondiente de una tesela de menor zoom.
async function ampliar(blob, dz, ox, oy) {
  const bmp = await createImageBitmap(blob);
  const lado = bmp.width / 2 ** dz;
  const lienzo = new OffscreenCanvas(256, 256);
  const g = lienzo.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, ox * lado, oy * lado, lado, lado, 0, 0, 256, 256);
  bmp.close?.();
  return (await lienzo.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
}

maplibregl.addProtocol('satelite', async (params) => {
  const [z, x, y] = params.url.replace('satelite://', '').split('/').map(Number);
  const exacta = await local(z, x, y);
  if (exacta) return { data: await exacta.arrayBuffer() };
  if (navigator.onLine) {
    try {
      const r = await fetch(URL_EOX(z, x, y));
      if (r.ok) return { data: await r.arrayBuffer() };
    } catch (_) { /* sin conexión real */ }
  }
  for (let dz = 1; dz <= 6 && z - dz >= 0; dz++) {
    const px = x >> dz;
    const py = y >> dz;
    const padre = await local(z - dz, px, py);
    if (padre) {
      try { return { data: await ampliar(padre, dz, x - (px << dz), y - (py << dz)) }; } catch (_) { break; }
    }
  }
  return { data: TRANSPARENTE.slice().buffer };
});
