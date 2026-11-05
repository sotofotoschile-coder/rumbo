// Paquetes de mapa offline (.pmtiles) guardados en el almacenamiento privado de la app.
import { db, nuevoId } from './db.js';
import * as SAT from './satelite.js';

const protocolo = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocolo.tile);

async function carpeta() {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle('mapas', { create: true });
}

async function archivo(nombre) {
  const h = await (await carpeta()).getFileHandle(nombre);
  return h.getFile();
}

export async function listar() {
  const mapas = await db.todos('mapas');
  return mapas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// Devuelve la URL pmtiles:// que entiende MapLibre.
export async function abrirFuente(mapa) {
  const f = await archivo(mapa.archivo);
  const fuente = new pmtiles.FileSource(f);
  protocolo.add(new pmtiles.PMTiles(fuente));
  return `pmtiles://${fuente.getKey()}`;
}

function copiar(origen, destino, alProgreso) {
  return new Promise((resolver, rechazar) => {
    const w = new Worker(new URL('./copiador.js', import.meta.url));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.tipo === 'progreso') alProgreso?.(m.hecho, m.total);
      else if (m.tipo === 'listo') { w.terminate(); resolver(m.bytes); }
      else if (m.tipo === 'error') { w.terminate(); rechazar(new Error(m.mensaje)); }
    };
    w.onerror = (e) => { w.terminate(); rechazar(new Error(e.message || 'No se pudo copiar el archivo.')); };
    w.postMessage({ origen, destino });
  });
}

// origen: File (importado desde Archivos) o { url } (descarga).
export async function instalar(origen, nombre, alProgreso) {
  const id = nuevoId();
  const nombreArchivo = `${id}.pmtiles`;
  const bytes = await copiar(origen, nombreArchivo, alProgreso);
  try {
    const p = new pmtiles.PMTiles(new pmtiles.FileSource(await archivo(nombreArchivo)));
    const h = await p.getHeader();
    if (h.tileType !== 1) throw new Error('no contiene teselas vectoriales');
    let meta = {};
    try { meta = (await p.getMetadata()) || {}; } catch (_) { /* metadatos opcionales */ }
    const mapa = {
      id,
      archivo: nombreArchivo,
      nombre,
      bytes,
      instalado: Date.now(),
      limites: [h.minLon, h.minLat, h.maxLon, h.maxLat],
      centro: [h.centerLon, h.centerLat, h.centerZoom],
      minZoom: h.minZoom,
      maxZoom: h.maxZoom,
      esquema: meta.version || null,
    };
    await db.guardar('mapas', mapa);
    return mapa;
  } catch (e) {
    await (await carpeta()).removeEntry(nombreArchivo).catch(() => {});
    throw new Error(`El archivo no es un paquete de mapa válido (.pmtiles): ${e.message}.`);
  }
}

export async function borrar(mapa) {
  await (await carpeta()).removeEntry(mapa.archivo).catch(() => {});
  await db.borrar('mapas', mapa.id);
}

// Elimina copias a medio terminar (por ejemplo, si se cerró la app durante una importación).
export async function limpiarHuerfanos() {
  try {
    const conocidos = new Set((await db.todos('mapas')).map((m) => m.archivo));
    const dir = await carpeta();
    for await (const [nombre] of dir.entries()) {
      if (!conocidos.has(nombre)) await dir.removeEntry(nombre).catch(() => {});
    }
  } catch (_) { /* el navegador no permite listar: no es grave */ }
}

export async function espacio() {
  try {
    const e = await navigator.storage.estimate();
    const persistente = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usado: e.usage, cuota: e.quota, persistente };
  } catch (_) {
    return null;
  }
}

export async function pedirPersistencia() {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (_) {
    return false;
  }
}

// capa: 'mapa' | 'satelite' (Sentinel-2 offline) | 'hd' (Esri con internet, sobre Sentinel-2)
export function estilo(urlFuente, tema, { capa = 'mapa', etiquetas = true, claveEsri = '' } = {}) {
  const base = new URL('.', document.baseURI).href;
  const fondo = tema === 'dark' ? '#1c1c1e' : '#eef0e6';
  const satelital = capa === 'satelite' || capa === 'hd';
  const sources = {};
  const layers = [];
  if (urlFuente) {
    sources.protomaps = {
      type: 'vector',
      url: urlFuente,
      attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    };
  }
  if (satelital) {
    sources.satelite = { type: 'raster', tiles: ['satelite://{z}/{x}/{y}'], tileSize: 256, maxzoom: SAT.ZOOM_MAX, attribution: SAT.ATRIBUCION_S2 };
    if (urlFuente) {
      // Debajo va el mapa normal (sin textos): donde no hay imagen satelital
      // (sin internet fuera de las zonas descargadas, o mientras carga) se ve el mapa y no un fondo negro.
      layers.push(...basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' })
        .filter((c) => c.type !== 'symbol')
        .map((c) => ({ ...c, id: `base-${c.id}` })));
    } else {
      layers.push({ id: 'fondo', type: 'background', paint: { 'background-color': '#0b1a24' } });
    }
    layers.push({ id: 'satelite', type: 'raster', source: 'satelite' });
    if (capa === 'hd' && claveEsri) {
      sources.hd = { type: 'raster', tiles: [`${SAT.URL_ESRI}?token=${encodeURIComponent(claveEsri)}`], tileSize: 256, maxzoom: 19, attribution: SAT.ATRIBUCION_ESRI };
      layers.push({ id: 'hd', type: 'raster', source: 'hd' });
    }
    if (urlFuente && etiquetas) {
      // Modo híbrido: caminos, senderos, límites y nombres del mapa sobre la imagen.
      const capas = basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' })
        .filter((c) => c.type === 'symbol' || c.id.startsWith('roads') || c.id.startsWith('boundaries'));
      layers.push(...resaltarSenderos(capas, 'satelite'));
    }
  } else if (urlFuente) {
    layers.push(...resaltarSenderos(basemaps.layers('protomaps', basemaps.namedFlavor(tema), { lang: 'es' }), tema));
  } else {
    layers.push({ id: 'fondo', type: 'background', paint: { 'background-color': fondo } });
  }
  const conVector = !!urlFuente;
  return {
    version: 8,
    ...(conVector ? { glyphs: `${base}assets/fonts/{fontstack}/{range}.pbf`, sprite: `${base}assets/sprites/v4/${satelital ? 'light' : tema}` } : {}),
    sources,
    layers,
  };
}

// El estilo base dibuja senderos y huellas muy tenues; para trekking los queremos bien visibles.
function resaltarSenderos(capas, tema) {
  const color = { dark: '#d9a877', satelite: '#ffd25a' }[tema] || '#9a5b2e';
  return capas.map((c) => (c.id !== 'roads_other' ? c : {
    ...c,
    minzoom: Math.min(c.minzoom ?? 12, 12),
    paint: {
      'line-color': color,
      'line-dasharray': [2, 1.2],
      'line-opacity': 0.9,
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 1, 15, 2.2, 18, 4.5],
    },
  }));
}
